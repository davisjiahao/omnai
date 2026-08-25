import { channel } from 'node:diagnostics_channel';
import {
  changeMetadataSchema,
  type Capability,
  type ChangeMetadata,
  type DecisionRecord,
  type DecisionResolutionInput,
  type FlowPlan,
  type OpenDecisionInput,
  type SourceRef,
} from '../domain/types.js';
import { persistChangeMetadataWithinChangeLock } from './change-metadata-internal.js';
import { hashDecisionRecord } from './decision-transition.js';
import { listDecisions } from './decision-inventory.js';
import { readYaml, writeYaml } from './files.js';
import { compileFlowPlan } from './flow.js';
import { loadFlowPlan } from './flow-store.js';
import {
  changeDecisionPath,
  changeFlowPath,
  changeMetadataPath,
} from './paths.js';
import { readinessKeyForCapability } from './readiness.js';
import { getScenario } from './scenarios.js';
import {
  assertSemanticMutationFence,
  completeSemanticMutationTransaction,
  ensureSemanticMutationAudits,
  loadCompletedSemanticMutationForSource,
  loadPendingSemanticMutation,
  nextSemanticMutationIdentity,
  semanticMutationTransactionSchema,
  writeSemanticMutationTransaction,
  type DecisionSemanticMutation,
  type SemanticMutationAudit,
} from './semantic-mutation-journal.js';
import type { ChangeRef } from './store.js';

const mutationChannel = channel('omnai:core:change-mutation');

export type DecisionSemanticRequest = DecisionSemanticMutation['request'];

export async function resumeDecisionSemanticMutationWithinChangeLock(
  repoRoot: string,
  change: ChangeRef,
  request: DecisionSemanticRequest,
): Promise<DecisionRecord | null> {
  const pending = await loadPendingSemanticMutation(repoRoot, change);
  if (pending) {
    if (pending.kind !== 'DECISION') throw new Error(`SEMANTIC_MUTATION_PENDING: ${pending.id}`);
    if (JSON.stringify(pending.request) !== JSON.stringify(request)) {
      throw new Error('SEMANTIC_MUTATION_REQUEST_MISMATCH');
    }
    return continueDecisionSemanticMutation(repoRoot, change, pending);
  }
  await assertSemanticMutationFence(repoRoot, change);
  const completed = await loadCompletedSemanticMutationForSource(
    repoRoot,
    change,
    request,
    change.metadata.activeRevision,
    change.metadata.baseline,
  );
  if (completed?.kind === 'DECISION') {
    return completed.targetDecisions.find(({ id }) => id === completed.selectedDecisionId) ?? null;
  }
  return null;
}

export async function beginDecisionSemanticMutationWithinChangeLock(
  repoRoot: string,
  change: ChangeRef,
  request: DecisionSemanticRequest,
  selectedDecisionId: string,
  targetDecision: DecisionRecord,
): Promise<DecisionRecord> {
  const active = await readYaml(changeMetadataPath(repoRoot, change.directoryName), changeMetadataSchema);
  const sourceDecisions = await listDecisions(repoRoot, change);
  const targetDecisions = targetDecisionInventory(sourceDecisions, targetDecision, request.operation);
  const sourceFlow = await loadFlowPlan(repoRoot, { ...change, metadata: active });
  const createdAt = targetDecision.updatedAt;
  const flowCandidate = sourceFlow
    ? compileFlowPlan(
        active,
        getScenario(active.scenario),
        sourceFlow.assessment,
        targetDecisions,
        createdAt,
      )
    : null;
  const targetFlow = sourceFlow && flowCandidate?.inputHash === sourceFlow.inputHash
    ? sourceFlow
    : flowCandidate;
  const targetMetadata = decisionTargetMetadata(active, sourceFlow, targetFlow, createdAt);
  const identity = await nextSemanticMutationIdentity(repoRoot, change);
  const audits = decisionAudits(
    identity.id,
    request,
    active,
    sourceDecisions.find(({ id }) => id === selectedDecisionId) ?? null,
    targetDecision,
    sourceFlow,
    targetFlow,
    createdAt,
  );
  const transaction = semanticMutationTransactionSchema.parse({
    schemaVersion: 1,
    status: 'PENDING',
    ...identity,
    kind: 'DECISION',
    changeId: active.id,
    revision: active.activeRevision,
    baseline: active.baseline,
    createdAt,
    request,
    sourceMetadata: active,
    targetMetadata,
    sourceDecisions,
    targetDecisions,
    sourceFlow,
    targetFlow,
    selectedDecisionId,
    audits,
  });
  if (transaction.kind !== 'DECISION') throw new Error('SEMANTIC_MUTATION_KIND_MISMATCH');
  await writeSemanticMutationTransaction(repoRoot, change, transaction);
  publish('SEMANTIC_MUTATION_INTENT_WRITTEN', change, transaction.id);
  return continueDecisionSemanticMutation(repoRoot, change, transaction);
}

async function continueDecisionSemanticMutation(
  repoRoot: string,
  change: ChangeRef,
  transaction: DecisionSemanticMutation,
): Promise<DecisionRecord> {
  await assertSemanticMutationFence(repoRoot, change, transaction.id);
  const active = await readYaml(changeMetadataPath(repoRoot, change.directoryName), changeMetadataSchema);
  if (
    JSON.stringify(active) !== JSON.stringify(transaction.sourceMetadata)
    && JSON.stringify(active) !== JSON.stringify(transaction.targetMetadata)
  ) throw new Error('SEMANTIC_MUTATION_METADATA_CONFLICT');

  const currentDecisions = await listDecisions(repoRoot, change);
  const source = transaction.sourceDecisions.find(({ id }) => id === transaction.selectedDecisionId) ?? null;
  const target = transaction.targetDecisions.find(({ id }) => id === transaction.selectedDecisionId);
  if (!target) throw new Error('SEMANTIC_MUTATION_DECISION_TARGET_MISSING');
  const current = currentDecisions.find(({ id }) => id === transaction.selectedDecisionId) ?? null;
  if (JSON.stringify(current) === JSON.stringify(source)) {
    await writeYaml(changeDecisionPath(repoRoot, change.directoryName, target.id), target);
  } else if (JSON.stringify(current) !== JSON.stringify(target)) {
    throw new Error('SEMANTIC_MUTATION_DECISION_CONFLICT');
  }
  publish('DECISION_MUTATION_RECORD_WRITTEN', change, transaction.id);

  if (JSON.stringify(active) === JSON.stringify(transaction.sourceMetadata)
      && JSON.stringify(active) !== JSON.stringify(transaction.targetMetadata)) {
    await persistChangeMetadataWithinChangeLock(
      repoRoot,
      change,
      transaction.targetMetadata,
      transaction.targetMetadata.updatedAt,
    );
  } else {
    change.metadata = transaction.targetMetadata;
  }
  await ensureFlowTarget(repoRoot, change, transaction.sourceFlow, transaction.targetFlow);
  publish('DECISION_MUTATION_FLOW_WRITTEN', change, transaction.id);

  await ensureSemanticMutationAudits(repoRoot, change, transaction.id, transaction.audits);
  publish('DECISION_MUTATION_AUDITS_WRITTEN', change, transaction.id);
  if (transaction.status === 'PENDING') {
    await completeSemanticMutationTransaction(repoRoot, change, transaction);
  }
  return target;
}

async function ensureFlowTarget(
  repoRoot: string,
  change: ChangeRef,
  source: FlowPlan | null,
  target: FlowPlan | null,
): Promise<void> {
  const current = await loadFlowPlan(repoRoot, change);
  if (JSON.stringify(current) === JSON.stringify(target)) return;
  if (JSON.stringify(current) !== JSON.stringify(source)) {
    throw new Error('SEMANTIC_MUTATION_FLOW_CONFLICT');
  }
  if (!target) {
    if (current) throw new Error('SEMANTIC_MUTATION_FLOW_CONFLICT');
    return;
  }
  await writeYaml(changeFlowPath(repoRoot, change.directoryName), target);
}

function targetDecisionInventory(
  source: readonly DecisionRecord[],
  target: DecisionRecord,
  operation: DecisionSemanticRequest['operation'],
): DecisionRecord[] {
  if (operation === 'DECISION_OPEN') return [...source, target];
  return source.map((decision) => decision.id === target.id ? target : decision);
}

function decisionTargetMetadata(
  source: ChangeMetadata,
  sourceFlow: FlowPlan | null,
  targetFlow: FlowPlan | null,
  createdAt: string,
): ChangeMetadata {
  if (!sourceFlow || !targetFlow || sourceFlow.inputHash === targetFlow.inputHash) return source;
  const target = structuredClone(source);
  const previouslyActive = new Set(
    sourceFlow.capabilities.filter(({ active }) => active).map(({ capability }) => capability),
  );
  let changed = false;
  for (const capability of targetFlow.capabilities) {
    if (!capability.active || previouslyActive.has(capability.capability)) continue;
    const readiness = readinessForCapability(capability.capability);
    if (readiness && target.readiness[readiness] === 'NOT_APPLICABLE') {
      target.readiness[readiness] = 'MISSING';
      changed = true;
    }
  }
  return changed ? changeMetadataSchema.parse({ ...target, updatedAt: createdAt }) : source;
}

function readinessForCapability(capability: Capability): keyof ChangeMetadata['readiness'] | undefined {
  return readinessKeyForCapability(capability)
    ?? ({ mitigate: 'mitigation', ship: 'release', release: 'release', learn: 'learning' } as const)[
      capability as 'mitigate' | 'ship' | 'release' | 'learn'
    ];
}

function decisionAudits(
  mutationId: string,
  request: DecisionSemanticRequest,
  active: ChangeMetadata,
  before: DecisionRecord | null,
  after: DecisionRecord,
  sourceFlow: FlowPlan | null,
  targetFlow: FlowPlan | null,
  createdAt: string,
): SemanticMutationAudit[] {
  const audits: SemanticMutationAudit[] = [];
  if (sourceFlow && targetFlow && sourceFlow.inputHash !== targetFlow.inputHash) {
    audits.push({
      timestamp: createdAt,
      event: 'FLOW_DECISIONS_SYNCHRONIZED',
      changeId: active.id,
      revision: active.activeRevision,
      detail: 'Synchronized FlowPlan decision inputs',
      data: {
        baseline: active.baseline,
        previousInputHash: sourceFlow.inputHash,
        inputHash: targetFlow.inputHash,
        decisionIds: targetFlow.decisionIds,
        semanticMutationId: mutationId,
      },
    });
  }
  const baseData: Record<string, unknown> = {
    decisionId: after.id,
    baseline: active.baseline,
    semanticMutationId: mutationId,
    ...(before ? { beforeHash: hashDecisionRecord(before), beforeDecision: before } : {}),
    afterHash: hashDecisionRecord(after),
    afterDecision: after,
  };
  if (request.operation === 'DECISION_OPEN') {
    audits.push({
      timestamp: createdAt,
      event: 'DECISION_OPENED',
      changeId: active.id,
      revision: active.activeRevision,
      detail: `Opened ${after.kind} decision: ${after.question}`,
      data: baseData,
    });
  } else if (request.operation === 'DECISION_RESOLVE') {
    audits.push({
      timestamp: createdAt,
      event: 'DECISION_RESOLVED',
      changeId: active.id,
      revision: active.activeRevision,
      detail: `Resolved decision ${after.id}: ${request.input.summary}`,
      data: { ...baseData, authority: request.input.authority },
    });
  } else {
    audits.push({
      timestamp: createdAt,
      event: 'DECISION_SUPERSEDED',
      changeId: active.id,
      revision: active.activeRevision,
      detail: `Superseded decision ${after.id}: ${request.reason}`,
      data: {
        ...baseData,
        replacementId: request.replacementId,
        sourceRefs: request.sourceRefs,
      },
    });
  }
  return audits;
}

function publish(stage: string, change: ChangeRef, mutationId: string): void {
  mutationChannel.publish({ stage, changeId: change.metadata.id, semanticMutationId: mutationId });
}

export function openSemanticRequest(input: OpenDecisionInput): DecisionSemanticRequest {
  return { operation: 'DECISION_OPEN', input };
}

export function resolveSemanticRequest(
  decisionId: string,
  input: DecisionResolutionInput,
): DecisionSemanticRequest {
  return { operation: 'DECISION_RESOLVE', decisionId, input };
}

export function supersedeSemanticRequest(
  decisionId: string,
  replacementId: string,
  reason: string,
  sourceRefs: SourceRef[],
): DecisionSemanticRequest {
  return { operation: 'DECISION_SUPERSEDE', decisionId, replacementId, reason, sourceRefs };
}
