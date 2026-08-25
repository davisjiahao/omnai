import { channel } from 'node:diagnostics_channel';
import {
  changeMetadataSchema,
  flowPlanSchema,
  type ChangeMetadata,
  type DecisionRecord,
  type FlowAssessmentProposal,
  type FlowPlan,
} from '../domain/types.js';
import { persistChangeMetadataWithinChangeLock } from './change-metadata-internal.js';
import { listDecisions } from './decision-inventory.js';
import { pathExists, readYaml, writeYaml } from './files.js';
import { changeFlowPath, changeMetadataPath } from './paths.js';
import {
  assertSemanticMutationFence,
  completeSemanticMutationTransaction,
  ensureSemanticMutationAudits,
  loadCompletedSemanticMutationForSource,
  loadPendingSemanticMutation,
  nextSemanticMutationIdentity,
  semanticMutationTransactionSchema,
  writeSemanticMutationTransaction,
  type FlowSemanticMutation,
  type SemanticMutationAudit,
} from './semantic-mutation-journal.js';
import type { ChangeRef } from './store.js';

const mutationChannel = channel('omnai:core:change-mutation');

export type FlowSemanticRequest = FlowSemanticMutation['request'];

export interface FlowSemanticResume {
  handled: boolean;
  flow: FlowPlan | null;
}

export async function resumeFlowSemanticMutationWithinChangeLock(
  repoRoot: string,
  change: ChangeRef,
  request: FlowSemanticRequest,
): Promise<FlowSemanticResume> {
  const pending = await loadPendingSemanticMutation(repoRoot, change);
  if (pending) {
    if (pending.kind !== 'FLOW') throw new Error(`SEMANTIC_MUTATION_PENDING: ${pending.id}`);
    if (JSON.stringify(pending.request) !== JSON.stringify(request)) {
      throw new Error('SEMANTIC_MUTATION_REQUEST_MISMATCH');
    }
    return { handled: true, flow: await continueFlowSemanticMutation(repoRoot, change, pending) };
  }
  await assertSemanticMutationFence(repoRoot, change);
  const completed = await loadCompletedSemanticMutationForSource(
    repoRoot,
    change,
    request,
    change.metadata.activeRevision,
    change.metadata.baseline,
  );
  if (completed?.kind !== 'FLOW') return { handled: false, flow: null };
  const current = await readStoredFlow(repoRoot, change);
  if (JSON.stringify(current) === JSON.stringify(completed.sourceFlow)) {
    throw new Error('SEMANTIC_MUTATION_COMPLETED_TARGET_MISSING');
  }
  return { handled: true, flow: current };
}

export async function beginFlowSemanticMutationWithinChangeLock(
  repoRoot: string,
  change: ChangeRef,
  request: FlowSemanticRequest,
  sourceMetadata: ChangeMetadata,
  targetMetadata: ChangeMetadata,
  decisions: readonly DecisionRecord[],
  sourceFlow: FlowPlan | null,
  targetFlow: FlowPlan | null,
  createdAt: string,
): Promise<FlowPlan | null> {
  const identity = await nextSemanticMutationIdentity(repoRoot, change);
  const audits = flowAudits(identity.id, request, sourceMetadata, sourceFlow, targetFlow, createdAt);
  const transaction = semanticMutationTransactionSchema.parse({
    schemaVersion: 1,
    status: 'PENDING',
    ...identity,
    kind: 'FLOW',
    changeId: sourceMetadata.id,
    revision: sourceMetadata.activeRevision,
    baseline: sourceMetadata.baseline,
    createdAt,
    request,
    sourceMetadata,
    targetMetadata,
    decisions,
    sourceFlow,
    targetFlow,
    audits,
  });
  if (transaction.kind !== 'FLOW') throw new Error('SEMANTIC_MUTATION_KIND_MISMATCH');
  await writeSemanticMutationTransaction(repoRoot, change, transaction);
  mutationChannel.publish({
    stage: 'SEMANTIC_MUTATION_INTENT_WRITTEN',
    changeId: sourceMetadata.id,
    semanticMutationId: transaction.id,
  });
  return continueFlowSemanticMutation(repoRoot, change, transaction);
}

async function continueFlowSemanticMutation(
  repoRoot: string,
  change: ChangeRef,
  transaction: FlowSemanticMutation,
): Promise<FlowPlan | null> {
  await assertSemanticMutationFence(repoRoot, change, transaction.id);
  const active = await readYaml(changeMetadataPath(repoRoot, change.directoryName), changeMetadataSchema);
  if (
    JSON.stringify(active) !== JSON.stringify(transaction.sourceMetadata)
    && JSON.stringify(active) !== JSON.stringify(transaction.targetMetadata)
  ) throw new Error('SEMANTIC_MUTATION_METADATA_CONFLICT');
  const decisions = await listDecisions(repoRoot, change);
  if (JSON.stringify(decisions) !== JSON.stringify(transaction.decisions)) {
    throw new Error('SEMANTIC_MUTATION_DECISION_CONFLICT');
  }
  const current = await readStoredFlow(repoRoot, change);
  if (
    JSON.stringify(current) !== JSON.stringify(transaction.sourceFlow)
    && JSON.stringify(current) !== JSON.stringify(transaction.targetFlow)
  ) throw new Error('SEMANTIC_MUTATION_FLOW_CONFLICT');

  if (
    JSON.stringify(active) === JSON.stringify(transaction.sourceMetadata)
    && JSON.stringify(active) !== JSON.stringify(transaction.targetMetadata)
  ) {
    await persistChangeMetadataWithinChangeLock(
      repoRoot,
      change,
      transaction.targetMetadata,
      transaction.targetMetadata.updatedAt,
    );
  } else {
    change.metadata = transaction.targetMetadata;
  }
  if (JSON.stringify(current) === JSON.stringify(transaction.sourceFlow)
      && JSON.stringify(current) !== JSON.stringify(transaction.targetFlow)) {
    if (!transaction.targetFlow) throw new Error('SEMANTIC_MUTATION_FLOW_TARGET_MISSING');
    await writeYaml(
      changeFlowPath(repoRoot, change.directoryName),
      flowPlanSchema.parse(transaction.targetFlow),
    );
  }
  mutationChannel.publish({
    stage: 'FLOW_MUTATION_TARGET_WRITTEN',
    changeId: transaction.changeId,
    semanticMutationId: transaction.id,
  });
  await ensureSemanticMutationAudits(repoRoot, change, transaction.id, transaction.audits);
  if (transaction.status === 'PENDING') {
    await completeSemanticMutationTransaction(repoRoot, change, transaction);
  }
  return transaction.targetFlow;
}

async function readStoredFlow(repoRoot: string, change: ChangeRef): Promise<FlowPlan | null> {
  const path = changeFlowPath(repoRoot, change.directoryName);
  return await pathExists(path) ? readYaml(path, flowPlanSchema) : null;
}

function flowAudits(
  mutationId: string,
  request: FlowSemanticRequest,
  metadata: ChangeMetadata,
  source: FlowPlan | null,
  target: FlowPlan | null,
  createdAt: string,
): SemanticMutationAudit[] {
  if (request.operation === 'FLOW_SYNCHRONIZE') {
    if (!source || !target) return [];
    return [flowAudit(
      mutationId,
      metadata,
      createdAt,
      'FLOW_DECISIONS_SYNCHRONIZED',
      'Synchronized FlowPlan decision inputs',
      {
        baseline: metadata.baseline,
        previousInputHash: source.inputHash,
        inputHash: target.inputHash,
        decisionIds: target.decisionIds,
      },
    )];
  }
  if (request.operation === 'FLOW_SOURCE_REBOUND') {
    if (!source || !target) throw new Error('SEMANTIC_MUTATION_FLOW_TARGET_MISSING');
    return [flowAudit(
      mutationId,
      metadata,
      createdAt,
      'FLOW_SOURCE_REBOUND',
      'Rebound FlowPlan sources without changing assessment classifications or decisions',
      {
        baseline: metadata.baseline,
        previousInputHash: source.inputHash,
        inputHash: target.inputHash,
      },
    )];
  }
  return [];
}

function flowAudit(
  mutationId: string,
  metadata: ChangeMetadata,
  timestamp: string,
  event: string,
  detail: string,
  data: Record<string, unknown>,
): SemanticMutationAudit {
  return {
    timestamp,
    event,
    changeId: metadata.id,
    revision: metadata.activeRevision,
    detail,
    data: { ...data, semanticMutationId: mutationId },
  };
}

export function initializeFlowRequest(): FlowSemanticRequest {
  return { operation: 'FLOW_INITIALIZE' };
}

export function synchronizeFlowRequest(decisions: readonly DecisionRecord[]): FlowSemanticRequest {
  return { operation: 'FLOW_SYNCHRONIZE', decisions: [...decisions] };
}

export function rebindFlowRequest(decisions: readonly DecisionRecord[]): FlowSemanticRequest {
  return { operation: 'FLOW_REBIND', decisions: [...decisions] };
}

export function sourceReboundFlowRequest(proposal: FlowAssessmentProposal): FlowSemanticRequest {
  return { operation: 'FLOW_SOURCE_REBOUND', proposal };
}
