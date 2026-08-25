import { readdir } from 'node:fs/promises';
import { channel } from 'node:diagnostics_channel';
import { join } from 'node:path';
import {
  changeMetadataSchema,
  decisionRecordSchema,
  flowPlanSchema,
  reconcileSignalSchema,
  revisionSchema,
  type ReconcileSignal,
  type Revision,
  type ProgressEvent,
} from '../domain/types.js';
import {
  decisionReconcileTransactionSchema,
  resolvedDecisionRecordForTransaction,
  type DecisionReconcileTransaction,
} from './decision-reconcile-transaction.js';
import { pathExists, readJsonLines, readYaml } from './files.js';
import { compileFlowPlan, flowInputHash, hashFlowPlan } from './flow.js';
import { flowAssessmentTransactionSchema, type FlowAssessmentTransaction } from './flow-transaction.js';
import { ordinaryReconcileTransactionSchema, type OrdinaryReconcileTransaction } from './ordinary-reconcile-transaction.js';
import { changeArtifactPath, changeFlowPath, changeMetadataPath, changeRevisionsRoot } from './paths.js';
import {
  changedFlowAssessmentFields,
  flowAssessmentReconcileReason,
  readinessClosureForReconcileLevel,
  reconcileLevelForFlowAssessmentChanges,
} from './reconcile-semantics.js';
import { incrementBaseline, incrementRevision } from './revision-ids.js';
import type { ChangeRef } from './store.js';
import { validateCanonicalTaskClosure } from './task-closure-internal.js';
import { assertCanonicalDecisionTransition, hashDecisionRecord } from './decision-transition.js';
import { assertTerminalFlowAuthority } from './flow-terminal-authority.js';
import { ordinaryTerminalHashes } from './ordinary-terminal-target-internal.js';
import { listDecisions } from './decision-inventory.js';
import { hashCanonicalArtifact } from './canonical-hash-internal.js';
import { assertLateDecisionTransitionHistory, type DecisionTransitionAudit } from './decision-transition.js';
import {
  assertCompletedSemanticMutationLineage,
  semanticMutationTransactionSchema,
  type SemanticMutationAudit,
  type SemanticMutationTransaction,
} from './semantic-mutation-journal.js';
import {
  compileInitialFlowPlanForMutation,
  metadataForPreparedFlowMutation,
} from './flow-store-internal.js';
import { getScenario } from './scenarios.js';
import {
  scenarioArtifactSpecifications,
  scenarioReclassificationMetadata,
} from './scenario-reclassification-target.js';

interface AuditEvent {
  timestamp?: string;
  event?: string;
  changeId?: string;
  revision?: string;
  detail?: string;
  data?: Record<string, unknown>;
}

interface LineageInventory {
  root: string;
  revisions: Array<{ file: string; record: Revision }>;
  signals: Array<{ file: string; record: ReconcileSignal }>;
  events: AuditEvent[];
  revisionsByCorrelation: Map<string, Revision[]>;
  signalsByCorrelation: Map<string, ReconcileSignal[]>;
  eventsByKey: Map<string, AuditEvent[]>;
  eventsBySemanticMutationId: Map<string, ProgressEvent[]>;
  eventIndexByKey: Map<string, number[]>;
  flowTransactions: FlowAssessmentTransaction[];
  decisionTransactions: DecisionReconcileTransaction[];
  ordinaryTransactions: OrdinaryReconcileTransaction[];
  ordinaryTransactionsByCorrelation: Map<string, OrdinaryReconcileTransaction[]>;
  semanticTransactions: SemanticMutationTransaction[];
  pendingSemanticTransactions: SemanticMutationTransaction[];
  archiveCache: Map<string, { plan: import('../domain/types.js').FlowPlan; hash: string }>;
  archiveReads: number;
}

const lineageChannel = channel('omnai:core:transaction-lineage');

/** @internal Read-only validation of every durable transaction file for one Change. */
export async function assertTransactionLineageIntegrity(
  repoRoot: string,
  change: ChangeRef,
  options: {
    allowStaleFlowRepair?: boolean;
  } = {},
): Promise<void> {
  try {
    const root = changeRevisionsRoot(repoRoot, change.directoryName);
    const files = (await readdir(root)).sort();
    const inventory = await loadLineageInventory(repoRoot, change, root, files);
    const active = await readYaml(changeMetadataPath(repoRoot, change.directoryName), changeMetadataSchema);
    for (const transaction of inventory.flowTransactions) {
      if (transaction.status === 'COMPLETED') {
          await validateCompletedFlow(transaction, inventory);
          if (
            active.activeRevision === transaction.acceptedRevision
            && active.baseline === transaction.acceptedBaseline
          ) {
            await assertTerminalFlowAuthority(repoRoot, { ...change, metadata: active }, {
              proposal: transaction.proposal,
              oldPlanHash: transaction.oldPlanHash,
              decisions: transaction.decisions,
              correlationId: transaction.correlationId,
              acceptedRevision: transaction.acceptedRevision,
              acceptedBaseline: transaction.acceptedBaseline,
              acceptedInputHash: transaction.acceptedInputHash!,
              acceptedPlanHash: transaction.acceptedPlanHash!,
              acceptedPlan: transaction.acceptedPlan!,
            });
          }
        }
    }
    for (const transaction of inventory.decisionTransactions) {
      if (transaction.status === 'COMPLETED') {
          await validateCompletedDecision(transaction, inventory);
          if (
            active.activeRevision === transaction.resolvedRevision
            && active.baseline === transaction.resolvedBaseline
          ) {
            await validateCurrentDecisionTerminal(
              repoRoot,
              { ...change, metadata: active },
              transaction,
              inventory,
            );
          }
        }
    }
    for (const transaction of inventory.ordinaryTransactions) {
      if (transaction.status === 'COMPLETED') {
          await validateCompletedOrdinary(transaction, inventory);
          if (
            active.activeRevision === transaction.completedRevision
            && active.baseline === transaction.completedBaseline
          ) {
            await validateCurrentOrdinaryTerminal(
              repoRoot,
              { ...change, metadata: active },
              transaction,
              inventory,
            );
          }
        }
    }
    const terminalPendingFlow = inventory.flowTransactions.some((transaction) => (
      transaction.status === 'PENDING'
      && transaction.acceptedRevision === active.activeRevision
      && transaction.acceptedBaseline === active.baseline
    ));
    try {
      await assertCompletedSemanticMutationLineage(repoRoot, change, {
        transactions: inventory.semanticTransactions,
        events: inventory.events as ProgressEvent[],
        eventsByMutationId: inventory.eventsBySemanticMutationId,
      });
      for (const transaction of inventory.semanticTransactions) {
        validateSemanticTarget(transaction, inventory);
      }
      await assertCurrentDecisionFlowAuthority(
        repoRoot,
        { ...change, metadata: active },
        inventory,
        options,
      );
    } catch (error) {
      if (terminalPendingFlow) fail(`FLOW_TRANSACTION_COMPLETION_MISMATCH: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    lineageChannel.publish({
      stage: 'LINEAGE_VALIDATED',
      metrics: {
        inventoryPasses: 1,
        correlationIndexBuilds: 1,
        fullArrayScans: 0,
        transactionCount: inventory.flowTransactions.length
          + inventory.decisionTransactions.length
          + inventory.ordinaryTransactions.length
          + inventory.semanticTransactions.length,
        archiveReads: inventory.archiveReads,
        uniqueArchives: inventory.archiveCache.size,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') throw error;
    if (error instanceof Error && error.message.startsWith('TRANSACTION_LINEAGE_INTEGRITY:')) throw error;
    throw new Error(`TRANSACTION_LINEAGE_INTEGRITY: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function validateSemanticTarget(
  transaction: SemanticMutationTransaction,
  inventory: LineageInventory,
): void {
  if (transaction.kind === 'DECISION') validateCompletedDecisionSemanticTarget(transaction);
  else if (transaction.kind === 'FLOW') validateCompletedFlowSemanticTarget(transaction);
  else validateScenarioSemanticTarget(transaction, inventory);
}

function validateCompletedDecisionSemanticTarget(
  transaction: Extract<SemanticMutationTransaction, { kind: 'DECISION' }>,
): void {
  const request = transaction.request;
  const source = transaction.sourceDecisions.find(({ id }) => id === transaction.selectedDecisionId) ?? null;
  const target = transaction.targetDecisions.find(({ id }) => id === transaction.selectedDecisionId);
  if (!target) fail('SEMANTIC_DECISION_TARGET_MISSING');
  let expected: import('../domain/types.js').DecisionRecord;
  let event: 'DECISION_OPENED' | 'DECISION_RESOLVED' | 'DECISION_SUPERSEDED';
  if (request.operation === 'DECISION_OPEN') {
    const highest = transaction.sourceDecisions.reduce(
      (maximum, decision) => Math.max(maximum, Number(decision.id.slice(4))),
      0,
    );
    if (transaction.selectedDecisionId !== `DEC-${String(highest + 1).padStart(4, '0')}`) {
      fail('SEMANTIC_DECISION_ID_MISMATCH');
    }
    expected = decisionRecordSchema.parse({
      id: transaction.selectedDecisionId,
      changeId: transaction.changeId,
      openedRevision: transaction.revision,
      resolvedRevision: null,
      ...request.input,
      resolution: null,
      supersededBy: null,
      createdAt: transaction.createdAt,
      updatedAt: transaction.createdAt,
    });
    event = 'DECISION_OPENED';
  } else if (request.operation === 'DECISION_RESOLVE') {
    if (!source || request.decisionId !== source.id) fail('SEMANTIC_DECISION_SOURCE_MISMATCH');
    const authority = source.owner === 'HUMAN'
      ? 'HUMAN_CONFIRMED'
      : source.owner === 'AGENT' ? 'AGENT_EVIDENCE' : 'EXTERNAL_CONFIRMED';
    if (request.input.authority !== authority) fail('SEMANTIC_DECISION_AUTHORITY_MISMATCH');
    expected = decisionRecordSchema.parse({
      ...source,
      status: 'RESOLVED',
      resolvedRevision: transaction.revision,
      resolution: request.input,
      updatedAt: transaction.createdAt,
    });
    event = 'DECISION_RESOLVED';
  } else {
    if (!source || request.decisionId !== source.id) fail('SEMANTIC_DECISION_SOURCE_MISMATCH');
    const replacementId = request.replacementId;
    const replacement = transaction.sourceDecisions.find(({ id }) => id === replacementId);
    if (!replacement || (replacement.status !== 'OPEN' && replacement.status !== 'BLOCKED')) {
      fail('SEMANTIC_DECISION_REPLACEMENT_MISMATCH');
    }
    expected = decisionRecordSchema.parse({
      ...source,
      status: 'SUPERSEDED',
      supersededBy: replacement.id,
      updatedAt: transaction.createdAt,
    });
    event = 'DECISION_SUPERSEDED';
  }
  if (JSON.stringify(target) !== JSON.stringify(expected)) fail('SEMANTIC_DECISION_TARGET_MISMATCH');
  assertCanonicalDecisionTransition(event, source, target);
  const expectedInventory = request.operation === 'DECISION_OPEN'
    ? [...transaction.sourceDecisions, expected]
    : transaction.sourceDecisions.map((decision) => decision.id === expected.id ? expected : decision);
  if (JSON.stringify(transaction.targetDecisions) !== JSON.stringify(expectedInventory)) {
    fail('SEMANTIC_DECISION_INVENTORY_MISMATCH');
  }
  const expectedAudits = expectedDecisionSemanticAudits(transaction, source, expected, event);
  if (JSON.stringify(transaction.audits) !== JSON.stringify(expectedAudits)) {
    fail('SEMANTIC_DECISION_AUDIT_TARGET_MISMATCH');
  }

  const expectedMetadata = metadataForPreparedFlowMutation(
    transaction.sourceMetadata,
    transaction.sourceFlow,
    transaction.targetFlow,
    'NEWLY_ACTIVE',
    transaction.createdAt,
  );
  if (JSON.stringify(transaction.targetMetadata) !== JSON.stringify(expectedMetadata)) {
    fail('SEMANTIC_DECISION_METADATA_TARGET_MISMATCH');
  }
  if (transaction.sourceFlow === null || transaction.targetFlow === null) {
    if (transaction.sourceFlow !== transaction.targetFlow) fail('SEMANTIC_DECISION_FLOW_TARGET_MISMATCH');
    return;
  }
  const expectedSourceFlow = compileFlowPlan(
    transaction.sourceMetadata,
    getScenario(transaction.sourceMetadata.scenario),
    transaction.sourceFlow.assessment,
    transaction.sourceDecisions,
    transaction.sourceFlow.compiledAt,
  );
  if (JSON.stringify(transaction.sourceFlow) !== JSON.stringify(expectedSourceFlow)) {
    fail('SEMANTIC_DECISION_FLOW_SOURCE_MISMATCH');
  }
  const targetCompiledAt = transaction.targetFlow.inputHash === transaction.sourceFlow.inputHash
    ? transaction.sourceFlow.compiledAt
    : transaction.createdAt;
  const expectedTargetFlow = compileFlowPlan(
    transaction.targetMetadata,
    getScenario(transaction.targetMetadata.scenario),
    transaction.sourceFlow.assessment,
    transaction.targetDecisions,
    targetCompiledAt,
  );
  if (JSON.stringify(transaction.targetFlow) !== JSON.stringify(expectedTargetFlow)) {
    fail('SEMANTIC_DECISION_FLOW_TARGET_MISMATCH');
  }
}

function expectedDecisionSemanticAudits(
  transaction: Extract<SemanticMutationTransaction, { kind: 'DECISION' }>,
  before: import('../domain/types.js').DecisionRecord | null,
  after: import('../domain/types.js').DecisionRecord,
  event: 'DECISION_OPENED' | 'DECISION_RESOLVED' | 'DECISION_SUPERSEDED',
): SemanticMutationAudit[] {
  const audits: SemanticMutationAudit[] = [];
  if (
    transaction.sourceFlow
    && transaction.targetFlow
    && transaction.sourceFlow.inputHash !== transaction.targetFlow.inputHash
  ) {
    audits.push({
      timestamp: transaction.createdAt,
      event: 'FLOW_DECISIONS_SYNCHRONIZED',
      changeId: transaction.changeId,
      revision: transaction.revision,
      detail: 'Synchronized FlowPlan decision inputs',
      data: {
        baseline: transaction.baseline,
        previousInputHash: transaction.sourceFlow.inputHash,
        inputHash: transaction.targetFlow.inputHash,
        decisionIds: transaction.targetFlow.decisionIds,
        semanticMutationId: transaction.id,
      },
    });
  }
  const baseData: Record<string, unknown> = {
    decisionId: after.id,
    baseline: transaction.baseline,
    semanticMutationId: transaction.id,
    ...(before ? { beforeHash: hashDecisionRecord(before), beforeDecision: before } : {}),
    afterHash: hashDecisionRecord(after),
    afterDecision: after,
  };
  if (event === 'DECISION_OPENED' && transaction.request.operation === 'DECISION_OPEN') {
    audits.push({
      timestamp: transaction.createdAt,
      event,
      changeId: transaction.changeId,
      revision: transaction.revision,
      detail: `Opened ${after.kind} decision: ${after.question}`,
      data: baseData,
    });
  } else if (event === 'DECISION_RESOLVED' && transaction.request.operation === 'DECISION_RESOLVE') {
    audits.push({
      timestamp: transaction.createdAt,
      event,
      changeId: transaction.changeId,
      revision: transaction.revision,
      detail: `Resolved decision ${after.id}: ${transaction.request.input.summary}`,
      data: { ...baseData, authority: transaction.request.input.authority },
    });
  } else if (event === 'DECISION_SUPERSEDED' && transaction.request.operation === 'DECISION_SUPERSEDE') {
    audits.push({
      timestamp: transaction.createdAt,
      event,
      changeId: transaction.changeId,
      revision: transaction.revision,
      detail: `Superseded decision ${after.id}: ${transaction.request.reason}`,
      data: {
        ...baseData,
        replacementId: transaction.request.replacementId,
        sourceRefs: transaction.request.sourceRefs,
      },
    });
  } else fail('SEMANTIC_DECISION_AUDIT_TARGET_MISMATCH');
  return audits;
}

function validateCompletedFlowSemanticTarget(
  transaction: Extract<SemanticMutationTransaction, { kind: 'FLOW' }>,
): void {
  if (transaction.sourceFlow) {
    const sourceIsExact = transaction.request.operation === 'FLOW_SYNCHRONIZE'
      ? transaction.sourceFlow.changeId === transaction.sourceMetadata.id
        && transaction.sourceFlow.revision === transaction.sourceMetadata.activeRevision
        && transaction.sourceFlow.baseline === transaction.sourceMetadata.baseline
        && flowInputHash(transaction.sourceFlow) === transaction.sourceFlow.inputHash
      : JSON.stringify(transaction.sourceFlow) === JSON.stringify(compileFlowPlan(
          transaction.sourceMetadata,
          getScenario(transaction.sourceMetadata.scenario),
          transaction.sourceFlow.assessment,
          transaction.decisions,
          transaction.sourceFlow.compiledAt,
        ));
    if (!sourceIsExact) {
      fail('SEMANTIC_FLOW_SOURCE_MISMATCH');
    }
  }
  let expectedTarget: import('../domain/types.js').FlowPlan | null;
  let metadataMode: 'ACTIVE' | 'NEWLY_ACTIVE' | 'NONE' = 'NONE';
  if (
    transaction.request.operation === 'FLOW_INITIALIZE'
  ) {
    if (transaction.sourceFlow !== null) fail('SEMANTIC_FLOW_SOURCE_MISMATCH');
    expectedTarget = compileInitialFlowPlanForMutation(
      transaction.sourceMetadata,
      transaction.decisions,
      transaction.createdAt,
    );
    metadataMode = 'ACTIVE';
  } else {
    if (!transaction.sourceFlow) {
      if (transaction.targetFlow !== null) fail('SEMANTIC_FLOW_TARGET_MISMATCH');
      expectedTarget = null;
    } else {
      const assessment = transaction.request.operation === 'FLOW_SOURCE_REBOUND'
        ? transaction.request.proposal.assessment
        : transaction.sourceFlow.assessment;
      const targetBinding = transaction.request.operation === 'FLOW_REBIND'
        ? transaction.targetMetadata
        : transaction.sourceMetadata;
      expectedTarget = compileFlowPlan(
        targetBinding,
        getScenario(targetBinding.scenario),
        assessment,
        transaction.decisions,
        transaction.createdAt,
      );
      if (transaction.request.operation === 'FLOW_SYNCHRONIZE') metadataMode = 'NEWLY_ACTIVE';
    }
  }
  if (JSON.stringify(transaction.targetFlow) !== JSON.stringify(expectedTarget)) {
    fail('SEMANTIC_FLOW_TARGET_MISMATCH');
  }
  const expectedMetadata = metadataForPreparedFlowMutation(
    transaction.sourceMetadata,
    transaction.sourceFlow,
    expectedTarget,
    metadataMode,
    transaction.createdAt,
  );
  if (JSON.stringify(transaction.targetMetadata) !== JSON.stringify(expectedMetadata)) {
    fail('SEMANTIC_FLOW_METADATA_TARGET_MISMATCH');
  }
  const expectedAudits = expectedFlowSemanticAudits(transaction);
  if (JSON.stringify(transaction.audits) !== JSON.stringify(expectedAudits)) {
    fail('SEMANTIC_FLOW_AUDIT_TARGET_MISMATCH');
  }
}

function expectedFlowSemanticAudits(
  transaction: Extract<SemanticMutationTransaction, { kind: 'FLOW' }>,
): SemanticMutationAudit[] {
  const audit = (
    event: string,
    detail: string,
    data: Record<string, unknown>,
  ): SemanticMutationAudit => ({
    timestamp: transaction.createdAt,
    event,
    changeId: transaction.changeId,
    revision: transaction.revision,
    detail,
    data: { ...data, semanticMutationId: transaction.id },
  });
  if (transaction.request.operation === 'FLOW_SYNCHRONIZE') {
    if (!transaction.sourceFlow || !transaction.targetFlow) return [];
    return [audit(
      'FLOW_DECISIONS_SYNCHRONIZED',
      'Synchronized FlowPlan decision inputs',
      {
        baseline: transaction.baseline,
        previousInputHash: transaction.sourceFlow.inputHash,
        inputHash: transaction.targetFlow.inputHash,
        decisionIds: transaction.targetFlow.decisionIds,
      },
    )];
  }
  if (transaction.request.operation === 'FLOW_SOURCE_REBOUND') {
    if (!transaction.sourceFlow || !transaction.targetFlow) fail('SEMANTIC_FLOW_TARGET_MISMATCH');
    return [audit(
      'FLOW_SOURCE_REBOUND',
      'Rebound FlowPlan sources without changing assessment classifications or decisions',
      {
        baseline: transaction.baseline,
        previousInputHash: transaction.sourceFlow.inputHash,
        inputHash: transaction.targetFlow.inputHash,
      },
    )];
  }
  return [];
}

function validateScenarioSemanticTarget(
  transaction: Extract<SemanticMutationTransaction, { kind: 'SCENARIO_RECLASSIFY' }>,
  inventory: LineageInventory,
): void {
  const expectedMetadata = scenarioReclassificationMetadata(
    transaction.sourceMetadata,
    transaction.request.scenarioId,
  );
  if (JSON.stringify(transaction.proposedMetadata) !== JSON.stringify(expectedMetadata)) {
    fail('SEMANTIC_SCENARIO_METADATA_TARGET_MISMATCH');
  }
  if (
    transaction.completedRevision !== incrementRevision(transaction.revision)
    || transaction.completedBaseline !== incrementBaseline(transaction.baseline)
    || transaction.ordinaryCorrelationId !== `SCENARIO-${transaction.id}`
  ) fail('SEMANTIC_SCENARIO_REVISION_BINDING_MISMATCH');

  const expectedSpecifications = scenarioArtifactSpecifications(expectedMetadata).map(({ path, kind }) => ({
    path,
    kind,
  }));
  const actualSpecifications = transaction.artifacts.map(({ path, kind }) => ({ path, kind }));
  if (JSON.stringify(actualSpecifications) !== JSON.stringify(expectedSpecifications)) {
    fail('SEMANTIC_SCENARIO_ARTIFACT_TARGET_MISMATCH');
  }

  const expectedAudit = {
    timestamp: transaction.createdAt,
    event: 'SCENARIO_RECLASSIFIED',
    changeId: transaction.changeId,
    revision: transaction.completedRevision,
    detail: `${transaction.sourceMetadata.scenario} -> ${transaction.request.scenarioId}`,
    data: {
      previousScenario: transaction.sourceMetadata.scenario,
      scenario: transaction.request.scenarioId,
      risk: expectedMetadata.risk,
      impact: expectedMetadata.impact,
      proposedMetadataHash: hashCanonicalArtifact(expectedMetadata),
      tasksHash: hashCanonicalArtifact(transaction.tasks),
      artifactTargetsHash: hashCanonicalArtifact(transaction.artifacts),
      ordinaryCorrelationId: transaction.ordinaryCorrelationId,
      completedBaseline: transaction.completedBaseline,
      semanticMutationId: transaction.id,
    },
  };
  if (JSON.stringify(transaction.audit) !== JSON.stringify(expectedAudit)) {
    fail('SEMANTIC_SCENARIO_AUDIT_TARGET_MISMATCH');
  }

  const ordinaryMatches = inventory.ordinaryTransactionsByCorrelation.get(
    transaction.ordinaryCorrelationId,
  ) ?? [];
  if (ordinaryMatches.length > 1) fail('SEMANTIC_SCENARIO_RECONCILE_CARDINALITY');
  const ordinary = ordinaryMatches[0];
  if (!ordinary) {
    if (transaction.status === 'COMPLETED') fail('SEMANTIC_SCENARIO_RECONCILE_MISSING');
    return;
  }
  const affectedTasks = transaction.tasks.tasks.map(({ id }) => id);
  const expectedRequest = {
    level: 'L4',
    type: 'SCENARIO_RECLASSIFIED',
    reason: `${transaction.request.reason}. ${transaction.sourceMetadata.scenario} -> ${transaction.request.scenarioId}`,
    affectedTasks,
    affectedTaskClosure: null,
    affectedReadiness: null,
    evidence: [],
    externalCorrelationId: transaction.ordinaryCorrelationId,
  };
  if (
    JSON.stringify(ordinary.request) !== JSON.stringify(expectedRequest)
    || JSON.stringify(ordinary.sourceMetadata) !== JSON.stringify(expectedMetadata)
    || JSON.stringify(ordinary.tasks) !== JSON.stringify(transaction.tasks)
    || ordinary.createdAt !== transaction.createdAt
    || ordinary.correlationId !== transaction.ordinaryCorrelationId
    || (transaction.status === 'COMPLETED' && (
      ordinary.status !== 'COMPLETED'
      || ordinary.completedRevision !== transaction.completedRevision
      || ordinary.completedBaseline !== transaction.completedBaseline
    ))
  ) fail('SEMANTIC_SCENARIO_RECONCILE_MISMATCH');
}

async function assertCurrentDecisionFlowAuthority(
  repoRoot: string,
  change: ChangeRef,
  inventory: LineageInventory,
  options: {
    allowStaleFlowRepair?: boolean;
  },
): Promise<void> {
  const path = changeFlowPath(repoRoot, change.directoryName);
  const flow = await pathExists(path) ? await readYaml(path, flowPlanSchema) : null;
  const decisions = await listDecisions(repoRoot, change);
  const pending = inventory.pendingSemanticTransactions;
  if (pending.length > 1) fail('SEMANTIC_MUTATION_PENDING_CARDINALITY');
  const owner = pending[0];
  if (owner?.kind === 'DECISION') {
    const sourceDecisions = JSON.stringify(owner.sourceDecisions);
    const targetDecisions = JSON.stringify(owner.targetDecisions);
    const currentDecisions = JSON.stringify(decisions);
    const sourceFlow = JSON.stringify(owner.sourceFlow);
    const targetFlow = JSON.stringify(owner.targetFlow);
    const currentFlow = JSON.stringify(flow);
    const authorized = (
      currentDecisions === sourceDecisions && currentFlow === sourceFlow
    ) || (
      currentDecisions === targetDecisions
      && (currentFlow === sourceFlow || currentFlow === targetFlow)
    );
    if (!authorized) fail('DECISION_TRANSITION_UNAUTHORIZED_TARGET');
    return;
  }
  if (owner?.kind === 'FLOW') {
    if (
      JSON.stringify(decisions) !== JSON.stringify(owner.decisions)
      || (
        JSON.stringify(flow) !== JSON.stringify(owner.sourceFlow)
        && JSON.stringify(flow) !== JSON.stringify(owner.targetFlow)
      )
    ) fail('SEMANTIC_FLOW_UNAUTHORIZED_TARGET');
    return;
  }

  const pendingReconcile = inventory.flowTransactions.some(({ status }) => status === 'PENDING')
    || inventory.decisionTransactions.some(({ status }) => status === 'PENDING')
    || inventory.ordinaryTransactions.some(({ status }) => status === 'PENDING');
  if (pendingReconcile) return;

  const currentTerminal = inventory.flowTransactions.some((transaction) => (
    transaction.status === 'COMPLETED'
    && transaction.acceptedRevision === change.metadata.activeRevision
    && transaction.acceptedBaseline === change.metadata.baseline
  )) || inventory.decisionTransactions.some((transaction) => (
    transaction.status === 'COMPLETED'
    && transaction.resolvedRevision === change.metadata.activeRevision
    && transaction.resolvedBaseline === change.metadata.baseline
  )) || inventory.ordinaryTransactions.some((transaction) => (
    transaction.status === 'COMPLETED'
    && transaction.completedRevision === change.metadata.activeRevision
    && transaction.completedBaseline === change.metadata.baseline
  ));
  if (
    !currentTerminal
    && change.metadata.activeRevision === 'REV-0001'
  ) {
    assertLateDecisionTransitionHistory(
      [],
      decisions,
      inventory.events as DecisionTransitionAudit[],
      change.metadata.id,
      change.metadata.activeRevision,
      change.metadata.baseline,
    );
  }

  if (!flow) return;
  if (flowInputHash(flow) !== flow.inputHash) {
    throw new Error('FLOW_INTEGRITY_MISMATCH: inputHash');
  }
  if (options.allowStaleFlowRepair) return;
  const latestFlowAuthority = [...inventory.semanticTransactions]
    .reverse()
    .find((transaction) => (
      transaction.status === 'COMPLETED'
      && transaction.revision === change.metadata.activeRevision
      && transaction.baseline === change.metadata.baseline
      && (transaction.kind === 'DECISION' || transaction.kind === 'FLOW')
    ));
  const authoritativeFlow = latestFlowAuthority?.kind === 'DECISION'
    ? latestFlowAuthority.targetFlow
    : latestFlowAuthority?.kind === 'FLOW' ? latestFlowAuthority.targetFlow : undefined;
  if (authoritativeFlow && flow.inputHash === authoritativeFlow.inputHash) {
    if (JSON.stringify(flow) !== JSON.stringify(authoritativeFlow)) {
      fail('SEMANTIC_FLOW_UNAUTHORIZED_TARGET');
    }
    return;
  }
  const assessment = authoritativeFlow?.assessment ?? flow.assessment;
  const canonical = compileFlowPlan(
    change.metadata,
    getScenario(change.metadata.scenario),
    assessment,
    decisions,
    flow.compiledAt,
  );
  if (JSON.stringify(flow) !== JSON.stringify(canonical)) {
    fail('SEMANTIC_FLOW_UNAUTHORIZED_TARGET');
  }
}

async function loadLineageInventory(
  repoRoot: string,
  change: ChangeRef,
  root: string,
  files: readonly string[],
): Promise<LineageInventory> {
  const revisions: Array<{ file: string; record: Revision }> = [];
  const signals: Array<{ file: string; record: ReconcileSignal }> = [];
  const flowTransactions: FlowAssessmentTransaction[] = [];
  const decisionTransactions: DecisionReconcileTransaction[] = [];
  const ordinaryTransactions: OrdinaryReconcileTransaction[] = [];
  const semanticTransactions: SemanticMutationTransaction[] = [];
  const pendingSemanticTransactions: SemanticMutationTransaction[] = [];
  const semanticIds = new Set<string>();
  const semanticSequences = new Set<number>();
  for (const file of files) {
    if (/^REV-\d{4}\.yaml$/.test(file)) {
      const record = await readYaml(join(root, file), revisionSchema);
      if (file !== `${record.id}.yaml`) fail('REVISION_FILENAME_MISMATCH');
      if (record.changeId !== change.metadata.id) fail('REVISION_CHANGE_MISMATCH');
      revisions.push({ file, record });
    } else if (file.endsWith('.signal.yaml')) {
      const record = await readYaml(join(root, file), reconcileSignalSchema);
      if (file !== `${record.id}.signal.yaml`) fail('RECONCILE_SIGNAL_FILENAME_MISMATCH');
      if (record.changeId !== change.metadata.id) fail('RECONCILE_SIGNAL_CHANGE_MISMATCH');
      signals.push({ file, record });
    } else if (file.endsWith('.flow-transaction.yaml')) {
      if (!/^REV-\d{4}\.flow-transaction\.yaml$/.test(file)) fail('FLOW_TRANSACTION_FILENAME_MISMATCH');
      const transaction = await readYaml(join(root, file), flowAssessmentTransactionSchema);
      if (file !== `${transaction.proposal.revision}.flow-transaction.yaml`) fail('FLOW_TRANSACTION_FILENAME_MISMATCH');
      if (transaction.proposal.changeId !== change.metadata.id) fail('FLOW_TRANSACTION_CHANGE_MISMATCH');
      flowTransactions.push(transaction);
    } else if (file.endsWith('.decision-transaction.yaml')) {
      if (!/^REV-\d{4}\.DEC-\d{4}\.decision-transaction\.yaml$/.test(file)) {
        fail('DECISION_RECONCILE_TRANSACTION_FILENAME_MISMATCH');
      }
      const transaction = await readYaml(join(root, file), decisionReconcileTransactionSchema);
      if (file !== `${transaction.fromRevision}.${transaction.decision.id}.decision-transaction.yaml`) {
        fail('DECISION_RECONCILE_TRANSACTION_FILENAME_MISMATCH');
      }
      if (transaction.changeId !== change.metadata.id) fail('DECISION_RECONCILE_TRANSACTION_CHANGE_MISMATCH');
      decisionTransactions.push(transaction);
    } else if (file.endsWith('.reconcile-transaction.yaml')) {
      if (!/^REV-\d{4}\.reconcile-transaction\.yaml$/.test(file)) {
        fail('ORDINARY_RECONCILE_TRANSACTION_FILENAME_MISMATCH');
      }
      const transaction = await readYaml(join(root, file), ordinaryReconcileTransactionSchema);
      if (file !== `${transaction.sourceMetadata.activeRevision}.reconcile-transaction.yaml`) {
        fail('ORDINARY_RECONCILE_TRANSACTION_FILENAME_MISMATCH');
      }
      if (transaction.changeId !== change.metadata.id) fail('ORDINARY_RECONCILE_TRANSACTION_CHANGE_MISMATCH');
      ordinaryTransactions.push(transaction);
    } else if (file.endsWith('.semantic-mutation.yaml')) {
      if (!/^REV-\d{4}\.MUT-\d{6}\.semantic-mutation\.yaml$/.test(file)) {
        fail('SEMANTIC_MUTATION_FILENAME_MISMATCH');
      }
      const transaction = await readYaml(join(root, file), semanticMutationTransactionSchema);
      if (file !== `${transaction.revision}.${transaction.id}.semantic-mutation.yaml`) {
        fail('SEMANTIC_MUTATION_FILENAME_MISMATCH');
      }
      if (transaction.changeId !== change.metadata.id) fail('SEMANTIC_MUTATION_CHANGE_MISMATCH');
      if (semanticIds.has(transaction.id)) fail('SEMANTIC_MUTATION_ID_DUPLICATE');
      if (semanticSequences.has(transaction.sequence)) fail('SEMANTIC_MUTATION_SEQUENCE_DUPLICATE');
      semanticIds.add(transaction.id);
      semanticSequences.add(transaction.sequence);
      semanticTransactions.push(transaction);
      if (transaction.status === 'PENDING') pendingSemanticTransactions.push(transaction);
    }
  }
  const revisionsByCorrelation = new Map<string, Revision[]>();
  const signalsByCorrelation = new Map<string, ReconcileSignal[]>();
  const ordinaryTransactionsByCorrelation = new Map<string, OrdinaryReconcileTransaction[]>();
  for (const { record } of revisions) {
    addIndex(revisionsByCorrelation, record.operationRequestId, record);
  }
  for (const { record } of signals) {
    addIndex(signalsByCorrelation, record.operationRequestId, record);
  }
  for (const transaction of ordinaryTransactions) {
    addIndex(ordinaryTransactionsByCorrelation, transaction.correlationId, transaction);
  }
  const events = await readJsonLines<AuditEvent>(
    changeArtifactPath(repoRoot, change.directoryName, 'progress.jsonl'),
  );
  const eventsByKey = new Map<string, AuditEvent[]>();
  const eventsBySemanticMutationId = new Map<string, ProgressEvent[]>();
  const eventIndexByKey = new Map<string, number[]>();
  events.forEach((event, index) => {
    const correlationId = typeof event.data?.correlationId === 'string'
      ? event.data.correlationId
      : undefined;
    if (event.event && correlationId) {
      addIndex(eventsByKey, eventCorrelationKey(event.event, correlationId), event);
      addIndex(eventIndexByKey, eventCorrelationKey(event.event, correlationId), index);
    }
    const decisionId = typeof event.data?.decisionId === 'string' ? event.data.decisionId : undefined;
    if (event.event === 'DECISION_RESOLVED' && decisionId && event.revision) {
      addIndex(eventsByKey, decisionResolvedKey(decisionId, event.revision), event);
    }
    if (
      event.event === 'DECISION_REBOUND' && decisionId && correlationId
      && typeof event.data?.fromRevision === 'string'
      && typeof event.data?.toRevision === 'string'
    ) {
      addIndex(
        eventsByKey,
        decisionReboundKey(
          decisionId,
          correlationId,
          event.data.fromRevision,
          event.data.toRevision,
        ),
        event,
      );
    }
    const mutationId = typeof event.data?.semanticMutationId === 'string'
      ? event.data.semanticMutationId
      : undefined;
    if (mutationId) addIndex(eventsBySemanticMutationId, mutationId, event as ProgressEvent);
  });
  return {
    root,
    revisions,
    signals,
    events,
    revisionsByCorrelation,
    signalsByCorrelation,
    eventsByKey,
    eventsBySemanticMutationId,
    eventIndexByKey,
    flowTransactions,
    decisionTransactions,
    ordinaryTransactions,
    ordinaryTransactionsByCorrelation,
    semanticTransactions,
    pendingSemanticTransactions,
    archiveCache: new Map(),
    archiveReads: 0,
  };
}

function addIndex<T>(index: Map<string, T[]>, key: string, value: T): void {
  const values = index.get(key);
  if (values) values.push(value);
  else index.set(key, [value]);
}

function eventCorrelationKey(event: string, correlationId: string): string {
  return `${event}\u0000${correlationId}`;
}

function decisionResolvedKey(decisionId: string, revision: string): string {
  return `DECISION_RESOLVED\u0000${decisionId}\u0000${revision}`;
}

function decisionReboundKey(
  decisionId: string,
  correlationId: string,
  fromRevision: string,
  toRevision: string,
): string {
  return `DECISION_REBOUND\u0000${decisionId}\u0000${correlationId}\u0000${fromRevision}\u0000${toRevision}`;
}

async function validateCompletedFlow(
  transaction: FlowAssessmentTransaction,
  inventory: LineageInventory,
): Promise<void> {
  if (
    transaction.acceptedRevision === null || transaction.acceptedBaseline === null
    || transaction.acceptedInputHash === null || transaction.acceptedPlanHash === null
    || transaction.acceptedPlan === null
    || transaction.completedRevision !== transaction.acceptedRevision
    || transaction.completedBaseline !== transaction.acceptedBaseline
    || transaction.newPlanHash !== transaction.acceptedPlanHash
    || transaction.acceptedPlan.revision !== transaction.acceptedRevision
    || transaction.acceptedPlan.baseline !== transaction.acceptedBaseline
    || transaction.acceptedPlan.inputHash !== transaction.acceptedInputHash
    || hashFlowPlan(transaction.acceptedPlan) !== transaction.acceptedPlanHash
    || transaction.acceptedRevision !== incrementRevision(transaction.proposal.revision)
    || transaction.acceptedBaseline !== incrementBaseline(transaction.proposal.baseline)
  ) fail('FLOW_TRANSACTION_COMPLETION_MISMATCH');
  const oldArchive = await loadFlowArchive(inventory, transaction.proposal.revision);
  const oldPlan = oldArchive.plan;
  if (
    oldPlan.changeId !== transaction.proposal.changeId
    || oldPlan.revision !== transaction.proposal.revision
    || oldPlan.baseline !== transaction.proposal.baseline
    || oldArchive.hash !== transaction.oldPlanHash
  ) fail('FLOW_TRANSACTION_ARCHIVE_MISMATCH');
  const changed = changedFlowAssessmentFields(oldPlan.assessment, transaction.proposal.assessment);
  const level = reconcileLevelForFlowAssessmentChanges(changed);
  const reason = flowAssessmentReconcileReason(changed);
  const revision = uniqueRevision(transaction.correlationId, inventory);
  if (
    revision.id !== transaction.acceptedRevision
    || revision.previousRevision !== transaction.proposal.revision
    || revision.previousBaseline !== transaction.proposal.baseline
    || revision.baseline !== transaction.acceptedBaseline
    || revision.level !== level
    || revision.reason !== reason
    || JSON.stringify(revision.affectedReadiness) !== JSON.stringify(readinessClosureForReconcileLevel(level))
    || JSON.stringify(revision.affectedTasks) !== JSON.stringify([])
  ) fail('FLOW_TRANSACTION_REVISION_MISMATCH');
  const signal = uniqueSignal(transaction.correlationId, inventory);
  assertSignal(signal, transaction.proposal.revision, revision, 'FLOW_ASSESSMENT_CHANGED', reason, [], []);
  assertDecisionReboundAudits(
    transaction.decisions,
    undefined,
    transaction.proposal.revision,
    revision,
    transaction.acceptedBaseline,
    transaction.correlationId,
    inventory,
  );
  assertReconcileAudit(transaction.correlationId, transaction.proposal.revision, transaction.proposal.baseline, revision, inventory);
  const flowEvents = inventory.eventsByKey.get(
    eventCorrelationKey('FLOW_REASSESSED', transaction.correlationId),
  ) ?? [];
  if (flowEvents.length !== 1) fail('FLOW_TRANSACTION_AUDIT_CARDINALITY');
  const flow = flowEvents[0]!;
  if (
    flow.changeId !== transaction.proposal.changeId
    || flow.revision !== transaction.acceptedRevision
    || flow.detail !== `Accepted FlowPlan assessment changes: ${changed.join(', ')}`
    || flow.data?.previousRevision !== transaction.proposal.revision
    || flow.data?.previousBaseline !== transaction.proposal.baseline
    || flow.data?.baseline !== transaction.acceptedBaseline
    || flow.data?.oldPlanHash !== transaction.oldPlanHash
    || flow.data?.newPlanHash !== transaction.acceptedPlanHash
  ) fail('FLOW_TRANSACTION_AUDIT_MISMATCH');
}

async function validateCompletedDecision(
  transaction: DecisionReconcileTransaction,
  inventory: LineageInventory,
): Promise<void> {
  if (
    transaction.resolvedRevision !== incrementRevision(transaction.fromRevision)
    || transaction.resolvedBaseline !== incrementBaseline(transaction.fromBaseline)
  ) fail('DECISION_RECONCILE_TRANSACTION_COMPLETION_MISMATCH');
  const selection = validateCanonicalTaskClosure(transaction.tasks, transaction.taskRoots, transaction.affectedTasks);
  if (JSON.stringify(selection.closure) !== JSON.stringify(transaction.affectedTasks)) {
    fail('DECISION_RECONCILE_TRANSACTION_TASK_MISMATCH');
  }
  if (transaction.oldFlowHash !== null) {
    const oldPlan = await loadFlowArchive(inventory, transaction.fromRevision);
    if (oldPlan.hash !== transaction.oldFlowHash) fail('DECISION_RECONCILE_TRANSACTION_FLOW_MISMATCH');
  }
  const revision = uniqueRevision(transaction.correlationId, inventory);
  const reason = `Resolved ${transaction.decision.id} against settled authority: ${transaction.resolution.summary}`;
  if (
    revision.id !== transaction.resolvedRevision
    || revision.previousRevision !== transaction.fromRevision
    || revision.previousBaseline !== transaction.fromBaseline
    || revision.baseline !== transaction.resolvedBaseline
    || revision.level !== transaction.level
    || revision.reason !== reason
    || JSON.stringify(revision.affectedReadiness) !== JSON.stringify(transaction.affectedReadiness)
    || JSON.stringify(revision.affectedTasks) !== JSON.stringify(transaction.affectedTasks)
  ) fail('DECISION_RECONCILE_TRANSACTION_REVISION_MISMATCH');
  const signal = uniqueSignal(transaction.correlationId, inventory);
  assertSignal(signal, transaction.fromRevision, revision, 'DECISION_AUTHORITY_RESOLVED', reason, transaction.taskRoots, []);
  assertDecisionReboundAudits(
    transaction.decisions,
    transaction.decision.id,
    transaction.fromRevision,
    revision,
    transaction.resolvedBaseline,
    transaction.correlationId,
    inventory,
  );
  assertReconcileAudit(transaction.correlationId, transaction.fromRevision, transaction.fromBaseline, revision, inventory);
  const decisions = inventory.eventsByKey.get(
    decisionResolvedKey(transaction.decision.id, transaction.resolvedRevision!),
  ) ?? [];
  const beforeHash = hashDecisionRecord(transaction.decision);
  const afterHash = hashDecisionRecord(resolvedDecisionRecordForTransaction(transaction, transaction.resolvedRevision));
  if (
    transaction.resolvedDecisionHash !== afterHash
    ||
    decisions.length !== 1
    || decisions[0]?.timestamp !== transaction.createdAt
    || decisions[0]?.changeId !== transaction.changeId
    || decisions[0]?.detail !== `Resolved decision ${transaction.decision.id}: ${transaction.resolution.summary}`
    || decisions[0]?.data?.baseline !== transaction.resolvedBaseline
    || decisions[0]?.data?.authority !== transaction.resolution.authority
    || decisions[0]?.data?.beforeHash !== beforeHash
    || decisions[0]?.data?.afterHash !== afterHash
    || JSON.stringify(decisions[0]?.data?.beforeDecision) !== JSON.stringify(transaction.decision)
    || JSON.stringify(decisions[0]?.data?.afterDecision) !== JSON.stringify(
      resolvedDecisionRecordForTransaction(transaction, transaction.resolvedRevision),
    )
  ) fail('DECISION_RECONCILE_TRANSACTION_AUDIT_MISMATCH');
}

async function validateCompletedOrdinary(
  transaction: OrdinaryReconcileTransaction,
  inventory: LineageInventory,
): Promise<void> {
  if (
    transaction.completedRevision !== incrementRevision(transaction.sourceMetadata.activeRevision)
    || transaction.completedBaseline !== incrementBaseline(transaction.sourceMetadata.baseline)
    || JSON.stringify(transaction.terminalHashes) !== JSON.stringify(ordinaryTerminalHashes(transaction))
  ) fail('ORDINARY_RECONCILE_TRANSACTION_COMPLETION_MISMATCH');
  const readiness = transaction.request.affectedReadiness
    ?? readinessClosureForReconcileLevel(transaction.request.level);
  const selection = validateCanonicalTaskClosure(
    transaction.tasks,
    transaction.request.affectedTasks,
    transaction.request.affectedTaskClosure,
  );
  if (
    JSON.stringify(readiness) !== JSON.stringify(transaction.affectedReadiness)
    || JSON.stringify(selection.roots) !== JSON.stringify(transaction.taskRoots)
    || JSON.stringify(selection.closure) !== JSON.stringify(transaction.affectedTasks)
  ) fail('ORDINARY_RECONCILE_TRANSACTION_STATE_CONFLICT');
  if (transaction.flow) {
    const oldPlan = await loadFlowArchive(inventory, transaction.sourceMetadata.activeRevision);
    if (oldPlan.hash !== hashFlowPlan(transaction.flow)) fail('ORDINARY_RECONCILE_TRANSACTION_FLOW_MISMATCH');
  }
  const revision = uniqueRevision(transaction.correlationId, inventory);
  if (
    revision.id !== transaction.completedRevision
    || revision.previousRevision !== transaction.sourceMetadata.activeRevision
    || revision.previousBaseline !== transaction.sourceMetadata.baseline
    || revision.baseline !== transaction.completedBaseline
    || revision.level !== transaction.request.level
    || revision.reason !== transaction.request.reason
    || JSON.stringify(revision.affectedReadiness) !== JSON.stringify(transaction.affectedReadiness)
    || JSON.stringify(revision.affectedTasks) !== JSON.stringify(transaction.affectedTasks)
  ) fail('ORDINARY_RECONCILE_TRANSACTION_REVISION_MISMATCH');
  const signal = uniqueSignal(transaction.correlationId, inventory);
  assertSignal(
    signal,
    transaction.sourceMetadata.activeRevision,
    revision,
    transaction.request.type,
    transaction.request.reason,
    transaction.taskRoots,
    transaction.request.evidence,
  );
  assertDecisionReboundAudits(
    transaction.decisions,
    undefined,
    transaction.sourceMetadata.activeRevision,
    revision,
    transaction.completedBaseline,
    transaction.correlationId,
    inventory,
  );
  if (
    signal.createdAt !== transaction.createdAt
    || revision.createdAt !== transaction.createdAt
  ) fail('ORDINARY_RECONCILE_TRANSACTION_TIMESTAMP_MISMATCH');
  assertReconcileAudit(
    transaction.correlationId,
    transaction.sourceMetadata.activeRevision,
    transaction.sourceMetadata.baseline,
    revision,
    inventory,
  );
}

async function loadFlowArchive(
  inventory: LineageInventory,
  revision: string,
): Promise<{ plan: import('../domain/types.js').FlowPlan; hash: string }> {
  const cached = inventory.archiveCache.get(revision);
  if (cached) return cached;
  const plan = await readYaml(join(inventory.root, `${revision}.flow.yaml`), flowPlanSchema);
  const archived = { plan, hash: hashFlowPlan(plan) };
  inventory.archiveCache.set(revision, archived);
  inventory.archiveReads += 1;
  return archived;
}

async function validateCurrentOrdinaryTerminal(
  repoRoot: string,
  change: ChangeRef,
  transaction: OrdinaryReconcileTransaction,
  inventory: LineageInventory,
): Promise<void> {
  const revision = transaction.completedRevision!;
  const baseline = transaction.completedBaseline!;
  const accepted = transaction.decisions.map((source) => decisionRecordSchema.parse(
    source.status === 'OPEN' || source.status === 'BLOCKED'
      ? { ...source, openedRevision: revision, updatedAt: transaction.createdAt }
      : source
  ));
  const terminalIndexes = inventory.eventIndexByKey.get(
    eventCorrelationKey('RECONCILE_APPLIED', transaction.correlationId),
  ) ?? [];
  const terminalIndex = terminalIndexes.length === 1 ? terminalIndexes[0]! : -1;
  if (terminalIndex < 0) fail('ORDINARY_RECONCILE_TRANSACTION_AUDIT_MISMATCH');
  const current = await listDecisions(repoRoot, change);
  assertLateDecisionTransitionHistory(
    accepted,
    current,
    inventory.events.slice(terminalIndex + 1) as DecisionTransitionAudit[],
    transaction.changeId,
    revision,
    baseline,
  );
}

async function validateCurrentDecisionTerminal(
  repoRoot: string,
  change: ChangeRef,
  transaction: DecisionReconcileTransaction,
  inventory: LineageInventory,
): Promise<void> {
  const revision = uniqueRevision(transaction.correlationId, inventory);
  const accepted = transaction.decisions.map((source) => {
    if (source.id === transaction.decision.id) {
      return resolvedDecisionRecordForTransaction(transaction, transaction.resolvedRevision!);
    }
    if (source.status === 'OPEN' || source.status === 'BLOCKED') {
      return decisionRecordSchema.parse({ ...source, openedRevision: transaction.resolvedRevision!, updatedAt: revision.createdAt });
    }
    return source;
  });
  const terminalIndexes = inventory.eventIndexByKey.get(
    eventCorrelationKey('RECONCILE_APPLIED', transaction.correlationId),
  ) ?? [];
  const terminalIndex = terminalIndexes.length === 1 ? terminalIndexes[0]! : -1;
  if (terminalIndex < 0) fail('DECISION_RECONCILE_TRANSACTION_AUDIT_MISMATCH');
  const current = await listDecisions(repoRoot, change);
  assertLateDecisionTransitionHistory(
    accepted,
    current,
    inventory.events.slice(terminalIndex + 1) as DecisionTransitionAudit[],
    transaction.changeId,
    transaction.resolvedRevision!,
    transaction.resolvedBaseline!,
  );
}

function uniqueRevision(correlationId: string, inventory: LineageInventory): Revision {
  const matching = inventory.revisionsByCorrelation.get(correlationId) ?? [];
  if (matching.length !== 1) fail('TRANSACTION_REVISION_CARDINALITY');
  return matching[0]!;
}

function uniqueSignal(correlationId: string, inventory: LineageInventory): ReconcileSignal {
  const matching = inventory.signalsByCorrelation.get(correlationId) ?? [];
  if (matching.length !== 1) fail('TRANSACTION_SIGNAL_CARDINALITY');
  return matching[0]!;
}

function assertSignal(
  signal: ReconcileSignal,
  sourceRevision: string,
  revision: Revision,
  type: string,
  reason: string,
  taskRoots: readonly string[],
  evidence: readonly string[],
): void {
  if (
    signal.changeId !== revision.changeId
    || signal.revision !== sourceRevision
    || signal.level !== revision.level
    || signal.signalType !== type
    || signal.reason !== reason
    || JSON.stringify(signal.affectedTasks) !== JSON.stringify(taskRoots)
    || JSON.stringify(signal.evidenceIds) !== JSON.stringify(evidence)
    || signal.createdAt !== revision.createdAt
  ) fail('TRANSACTION_SIGNAL_MISMATCH');
}

function assertReconcileAudit(
  correlationId: string,
  sourceRevision: string,
  sourceBaseline: string,
  revision: Revision,
  inventory: LineageInventory,
): void {
  const matching = inventory.eventsByKey.get(
    eventCorrelationKey('RECONCILE_APPLIED', correlationId),
  ) ?? [];
  if (matching.length !== 1) fail('TRANSACTION_RECONCILE_AUDIT_CARDINALITY');
  const event = matching[0]!;
  if (
    event.timestamp !== revision.createdAt
    || event.changeId !== revision.changeId
    || event.revision !== revision.id
    || event.detail !== `${revision.level} ${uniqueSignal(correlationId, inventory).signalType}: ${revision.reason}`
    || event.data?.previousRevision !== sourceRevision
    || event.data?.previousBaseline !== sourceBaseline
    || event.data?.baseline !== revision.baseline
    || JSON.stringify(event.data?.affectedReadiness) !== JSON.stringify(revision.affectedReadiness)
    || JSON.stringify(event.data?.affectedTasks) !== JSON.stringify(revision.affectedTasks)
  ) fail('TRANSACTION_RECONCILE_AUDIT_MISMATCH');
}

function assertDecisionReboundAudits(
  decisions: readonly import('../domain/types.js').DecisionRecord[],
  excludedDecisionId: string | undefined,
  sourceRevision: string,
  revision: Revision,
  baseline: string | null,
  correlationId: string,
  inventory: LineageInventory,
): void {
  if (baseline === null) fail('TRANSACTION_DECISION_REBOUND_MISMATCH');
  for (const source of decisions) {
    if (
      source.id === excludedDecisionId
      || (source.status !== 'OPEN' && source.status !== 'BLOCKED')
    ) continue;
    const matching = inventory.eventsByKey.get(
      decisionReboundKey(source.id, correlationId, sourceRevision, revision.id),
    ) ?? [];
    const expected = {
      timestamp: revision.createdAt,
      event: 'DECISION_REBOUND',
      changeId: source.changeId,
      revision: revision.id,
      detail: `Rebound live decision ${source.id} from ${sourceRevision} to ${revision.id}`,
      data: {
        decisionId: source.id,
        fromRevision: sourceRevision,
        toRevision: revision.id,
        baseline,
        correlationId,
      },
    };
    if (matching.length !== 1 || JSON.stringify(matching[0]) !== JSON.stringify(expected)) {
      fail('TRANSACTION_DECISION_REBOUND_MISMATCH');
    }
  }
}

function fail(detail: string): never {
  throw new Error(`TRANSACTION_LINEAGE_INTEGRITY: ${detail}`);
}
