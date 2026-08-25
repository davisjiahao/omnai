import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  changeMetadataSchema,
  flowPlanSchema,
  reconcileSignalSchema,
  revisionSchema,
  type ChangeMetadata,
  type DecisionRecord,
  type ReconcileSignal,
  type Revision,
} from '../domain/types.js';
import { listDecisions, rebindLiveDecisionsWithinChangeLock } from './decision-store.js';
import { pathExists, readJsonLines, readYaml } from './files.js';
import { compileFlowPlan, hashFlowPlan } from './flow.js';
import {
  ensureFlowArchiveWithinChangeLock,
  preflightFlowArchiveCompatibilityWithinChangeLock,
} from './flow-archive.js';
import { loadFlowPlan } from './flow-store.js';
import { rebindPreflightedFlowPlanForRevisionWithinChangeLock } from './flow-store-internal.js';
import {
  completeOrdinaryReconcileTransaction,
  type OrdinaryReconcileTransaction,
} from './ordinary-reconcile-transaction.js';
import {
  changeArtifactPath,
  changeFlowPath,
  changeMetadataPath,
  changeRevisionsRoot,
} from './paths.js';
import {
  completeReconcileAuditWithinChangeLock,
  reconciledReadinessSnapshot,
  reconciledTaskSnapshot,
} from './reconcile-internal.js';
import { changedFlowAssessmentFields } from './reconcile-semantics.js';
import { incrementBaseline, incrementRevision } from './revision-ids.js';
import { getScenario } from './scenarios.js';
import type { ReconcileResult } from './ordinary-reconcile-orchestration.js';
import type { ChangeRef } from './store.js';
import { loadTasks } from './tasks.js';

/** @internal Caller must hold the exact Change mutation lock. */
export async function recoverPendingOrdinaryTarget(
  repoRoot: string,
  change: ChangeRef,
  transaction: OrdinaryReconcileTransaction,
  active: ChangeMetadata,
): Promise<ReconcileResult> {
  if (transaction.flow === null) throw new Error('FLOW_PLAN_REQUIRED');
  const result = await loadOrdinaryReconcileResult(repoRoot, change, transaction, active);
  await assertOrdinaryTargetMetadataAndTasks(repoRoot, change, transaction, active);
  await ensureFlowArchiveWithinChangeLock(repoRoot, change, transaction.flow);
  const reboundDecisions = await rebindLiveDecisionsWithinChangeLock(repoRoot, change, {
    fromRevision: transaction.sourceMetadata.activeRevision,
    decisions: transaction.decisions,
    reboundAt: result.revision.createdAt,
    correlationId: transaction.correlationId,
  });
  await recoverOrdinaryFlow(repoRoot, change, transaction, active, reboundDecisions);
  await completeReconcileAuditWithinChangeLock(repoRoot, change, result);
  await completeOrdinaryReconcileTransaction(
    repoRoot,
    change,
    transaction,
    active.activeRevision,
    active.baseline,
  );
  return result;
}

export async function validateCompletedOrdinaryReconcile(
  repoRoot: string,
  change: ChangeRef,
  transaction: OrdinaryReconcileTransaction,
): Promise<void> {
  if (transaction.flow === null) throw new Error('FLOW_PLAN_REQUIRED');
  const active = await readYaml(
    changeMetadataPath(repoRoot, change.directoryName),
    changeMetadataSchema,
  );
  if (
    transaction.status !== 'COMPLETED'
    || transaction.completedRevision !== active.activeRevision
    || transaction.completedBaseline !== active.baseline
  ) throw new Error('ORDINARY_RECONCILE_TRANSACTION_COMPLETION_MISMATCH');
  change.metadata = active;
  const result = await loadOrdinaryReconcileResult(repoRoot, change, transaction, active);
  if (!await preflightFlowArchiveCompatibilityWithinChangeLock(repoRoot, change, transaction.flow)) {
    throw new Error('ORDINARY_RECONCILE_TRANSACTION_COMPLETION_MISMATCH');
  }
  const decisions = await listDecisions(repoRoot, change);
  await assertCompletedDecisionRebinds(repoRoot, change, transaction, result.revision, decisions);
  await assertCompletedOrdinaryFlow(repoRoot, change, transaction, active, decisions);
  await assertCompletedReconcileAudit(repoRoot, change, transaction, result);
}

export async function resultForCompletedTransaction(
  repoRoot: string,
  change: ChangeRef,
  transaction: OrdinaryReconcileTransaction,
): Promise<ReconcileResult> {
  return loadOrdinaryReconcileResult(repoRoot, change, transaction, change.metadata);
}

async function loadOrdinaryReconcileResult(
  repoRoot: string,
  change: ChangeRef,
  transaction: OrdinaryReconcileTransaction,
  active: ChangeMetadata,
): Promise<ReconcileResult> {
  const revisionsRoot = changeRevisionsRoot(repoRoot, change.directoryName);
  const correlatedRevisions: Revision[] = [];
  const revisionFiles = (await readdir(revisionsRoot)).filter((file) => /^REV-\d{4}\.yaml$/.test(file)).sort();
  for (const file of revisionFiles) {
    const revision = await readYaml(join(revisionsRoot, file), revisionSchema);
    if (`${revision.id}.yaml` !== file) throw ordinaryCompletionMismatch();
    if (revision.operationRequestId === transaction.correlationId) correlatedRevisions.push(revision);
  }
  if (correlatedRevisions.length !== 1) throw ordinaryCompletionMismatch();
  const revision = correlatedRevisions[0]!;
  const expectedRevision = incrementRevision(transaction.sourceMetadata.activeRevision);
  const expectedBaseline = incrementBaseline(transaction.sourceMetadata.baseline);
  if (
    revision.id !== expectedRevision
    || revision.changeId !== transaction.changeId
    || revision.previousRevision !== transaction.sourceMetadata.activeRevision
    || revision.previousBaseline !== transaction.sourceMetadata.baseline
    || revision.baseline !== expectedBaseline
    || revision.level !== transaction.request.level
    || revision.reason !== transaction.request.reason
    || JSON.stringify(revision.affectedReadiness) !== JSON.stringify(transaction.affectedReadiness)
    || JSON.stringify(revision.affectedTasks) !== JSON.stringify(transaction.affectedTasks)
    || active.id !== transaction.changeId
    || active.activeRevision !== expectedRevision
    || active.baseline !== expectedBaseline
  ) throw ordinaryCompletionMismatch();

  const correlatedSignals: ReconcileSignal[] = [];
  const signalFiles = (await readdir(revisionsRoot)).filter((file) => file.endsWith('.signal.yaml')).sort();
  for (const file of signalFiles) {
    const signal = await readYaml(join(revisionsRoot, file), reconcileSignalSchema);
    if (`${signal.id}.signal.yaml` !== file) throw ordinaryCompletionMismatch();
    if (signal.operationRequestId === transaction.correlationId) correlatedSignals.push(signal);
  }
  if (correlatedSignals.length !== 1) throw ordinaryCompletionMismatch();
  const signal = correlatedSignals[0]!;
  if (
    signal.changeId !== transaction.changeId
    || signal.revision !== transaction.sourceMetadata.activeRevision
    || signal.level !== transaction.request.level
    || signal.signalType !== transaction.request.type
    || signal.reason !== transaction.request.reason
    || JSON.stringify(signal.affectedTasks) !== JSON.stringify(transaction.taskRoots)
    || JSON.stringify(signal.evidenceIds) !== JSON.stringify(transaction.request.evidence)
    || signal.createdAt !== revision.createdAt
  ) throw ordinaryCompletionMismatch();
  return {
    signal,
    revision,
    affectedReadiness: transaction.affectedReadiness,
    affectedTasks: transaction.affectedTasks,
  };
}

async function assertOrdinaryTargetMetadataAndTasks(
  repoRoot: string,
  change: ChangeRef,
  transaction: OrdinaryReconcileTransaction,
  active: ChangeMetadata,
): Promise<void> {
  const expectedReadiness = reconciledReadinessSnapshot(
    transaction.sourceMetadata.readiness,
    transaction.affectedReadiness,
    transaction.request.level,
  );
  const expectedMetadata = {
    ...transaction.sourceMetadata,
    activeRevision: incrementRevision(transaction.sourceMetadata.activeRevision),
    baseline: incrementBaseline(transaction.sourceMetadata.baseline),
    status: 'IN_PROGRESS',
    readiness: expectedReadiness,
    updatedAt: active.updatedAt,
  };
  const tasks = await loadTasks(changeArtifactPath(repoRoot, change.directoryName, 'tasks.yaml'));
  const expectedTasks = reconciledTaskSnapshot(
    transaction.tasks,
    transaction.affectedTasks,
    ['L2', 'L3', 'L4'].includes(transaction.request.level),
  );
  if (
    JSON.stringify(active) !== JSON.stringify(expectedMetadata)
    || JSON.stringify(tasks) !== JSON.stringify(expectedTasks)
  ) throw ordinaryCompletionMismatch();
}

async function recoverOrdinaryFlow(
  repoRoot: string,
  change: ChangeRef,
  transaction: OrdinaryReconcileTransaction,
  active: ChangeMetadata,
  decisions: readonly DecisionRecord[],
): Promise<void> {
  const flowPath = changeFlowPath(repoRoot, change.directoryName);
  if (!transaction.flow) {
    if (await pathExists(flowPath)) throw ordinaryCompletionMismatch();
    return;
  }
  if (!await pathExists(flowPath)) throw ordinaryCompletionMismatch();
  const stored = await readYaml(flowPath, flowPlanSchema);
  if (hashFlowPlan(stored) === hashFlowPlan(transaction.flow)) {
    await rebindPreflightedFlowPlanForRevisionWithinChangeLock(
      repoRoot,
      change,
      decisions,
      transaction.flow,
    );
    return;
  }
  await assertCompletedOrdinaryFlow(repoRoot, change, transaction, active, decisions);
}

async function assertCompletedOrdinaryFlow(
  repoRoot: string,
  change: ChangeRef,
  transaction: OrdinaryReconcileTransaction,
  active: ChangeMetadata,
  decisions: readonly DecisionRecord[],
): Promise<void> {
  const flow = await loadFlowPlan(repoRoot, change);
  if (!transaction.flow) {
    if (flow) throw ordinaryCompletionMismatch();
    return;
  }
  if (!flow) throw ordinaryCompletionMismatch();
  if (
    changedFlowAssessmentFields(transaction.flow.assessment, flow.assessment).length > 0
    || JSON.stringify(transaction.flow.assessment.decisionIds) !== JSON.stringify(flow.assessment.decisionIds)
  ) throw ordinaryCompletionMismatch();
  if (
    JSON.stringify(transaction.flow.assessment.sourceRefs) !== JSON.stringify(flow.assessment.sourceRefs)
  ) {
    const events = await readJsonLines<FlowSourceAudit>(
      changeArtifactPath(repoRoot, change.directoryName, 'progress.jsonl'),
    );
    const terminalIndex = events.findIndex((event) => (
      event.event === 'RECONCILE_APPLIED'
      && event.data?.correlationId === transaction.correlationId
    ));
    const sourceRebound = events.slice(terminalIndex + 1).some((event) => (
      event.event === 'FLOW_SOURCE_REBOUND'
      && event.changeId === active.id
      && event.revision === active.activeRevision
      && event.detail === 'Rebound FlowPlan sources without changing assessment classifications or decisions'
      && event.data?.baseline === active.baseline
      && event.data?.inputHash === flow.inputHash
    ));
    if (terminalIndex < 0 || !sourceRebound) throw ordinaryCompletionMismatch();
  }
  const canonical = compileFlowPlan(
    active,
    getScenario(active.scenario),
    flow.assessment,
    decisions,
    flow.compiledAt,
  );
  if (JSON.stringify(flow) !== JSON.stringify(canonical)) throw ordinaryCompletionMismatch();
}

async function assertCompletedDecisionRebinds(
  repoRoot: string,
  change: ChangeRef,
  transaction: OrdinaryReconcileTransaction,
  revision: Revision,
  decisions: readonly DecisionRecord[],
): Promise<void> {
  if (decisions.length < transaction.decisions.length) throw ordinaryCompletionMismatch();
  const events = await readJsonLines<DecisionReboundAudit>(
    changeArtifactPath(repoRoot, change.directoryName, 'progress.jsonl'),
  );
  const terminalIndexes = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => (
      event.event === 'RECONCILE_APPLIED'
      && event.data?.correlationId === transaction.correlationId
    ));
  if (terminalIndexes.length !== 1) throw ordinaryCompletionMismatch();
  const terminalIndex = terminalIndexes[0]!.index;
  const currentById = new Map(decisions.map((decision) => [decision.id, decision]));
  for (const source of transaction.decisions) {
    const current = currentById.get(source.id);
    if (!current) throw ordinaryCompletionMismatch();
    if (source.status !== 'OPEN' && source.status !== 'BLOCKED') {
      if (JSON.stringify(current) !== JSON.stringify(source)) throw ordinaryCompletionMismatch();
      continue;
    }
    const expected = {
      ...source,
      openedRevision: revision.id,
      updatedAt: revision.createdAt,
    };
    const matching = events.filter((event) => (
      event.event === 'DECISION_REBOUND'
      && event.data?.decisionId === current.id
      && event.data?.fromRevision === transaction.sourceMetadata.activeRevision
      && event.data?.toRevision === revision.id
    ));
    const expectedAudit: DecisionReboundAudit = {
      timestamp: revision.createdAt,
      event: 'DECISION_REBOUND',
      changeId: transaction.changeId,
      revision: revision.id,
      detail: `Rebound live decision ${current.id} from ${transaction.sourceMetadata.activeRevision} to ${revision.id}`,
      data: {
        decisionId: current.id,
        fromRevision: transaction.sourceMetadata.activeRevision,
        toRevision: revision.id,
        baseline: revision.baseline!,
        correlationId: transaction.correlationId,
      },
    };
    if (matching.length !== 1 || JSON.stringify(matching[0]) !== JSON.stringify(expectedAudit)) {
      throw ordinaryCompletionMismatch();
    }
    if (
      JSON.stringify(current) !== JSON.stringify(expected)
      && !isAuditedLateDecisionState(current, events.slice(terminalIndex + 1), revision)
    ) throw ordinaryCompletionMismatch();
  }
  const sourceIds = new Set(transaction.decisions.map(({ id }) => id));
  for (const current of decisions) {
    if (sourceIds.has(current.id)) continue;
    const lateEvents = events.slice(terminalIndex + 1);
    const opened = lateEvents.some((event) => (
      event.event === 'DECISION_OPENED'
      && event.changeId === transaction.changeId
      && event.revision === revision.id
      && event.data?.decisionId === current.id
      && event.data?.baseline === revision.baseline
    ));
    if (!opened || !isAuditedLateDecisionState(current, lateEvents, revision, true)) {
      throw ordinaryCompletionMismatch();
    }
  }
}

function isAuditedLateDecisionState(
  decision: DecisionRecord,
  events: readonly DecisionReboundAudit[],
  revision: Revision,
  allowLive = false,
): boolean {
  if (
    decision.changeId !== revision.changeId
    || decision.openedRevision !== revision.id
  ) return false;
  if (decision.status === 'OPEN' || decision.status === 'BLOCKED') return allowLive;
  if (decision.status === 'RESOLVED') {
    return decision.resolvedRevision === revision.id && events.some((event) => (
      event.event === 'DECISION_RESOLVED'
      && event.changeId === revision.changeId
      && event.revision === revision.id
      && event.detail === `Resolved decision ${decision.id}: ${decision.resolution?.summary}`
      && event.data?.decisionId === decision.id
      && event.data?.baseline === revision.baseline
      && event.data?.authority === decision.resolution?.authority
    ));
  }
  if (decision.status === 'SUPERSEDED') {
    return decision.supersededBy !== null && events.some((event) => (
      event.event === 'DECISION_SUPERSEDED'
      && event.changeId === revision.changeId
      && event.revision === revision.id
      && event.data?.decisionId === decision.id
      && event.data?.replacementId === decision.supersededBy
      && event.data?.baseline === revision.baseline
    ));
  }
  return false;
}

async function assertCompletedReconcileAudit(
  repoRoot: string,
  change: ChangeRef,
  transaction: OrdinaryReconcileTransaction,
  result: ReconcileResult,
): Promise<void> {
  const events = await readJsonLines<ReconcileAudit>(
    changeArtifactPath(repoRoot, change.directoryName, 'progress.jsonl'),
  );
  const matching = events.filter((event) => (
    event.event === 'RECONCILE_APPLIED'
    && event.data?.correlationId === transaction.correlationId
  ));
  const expected: ReconcileAudit = {
    timestamp: result.revision.createdAt,
    event: 'RECONCILE_APPLIED',
    changeId: transaction.changeId,
    revision: result.revision.id,
    detail: `${transaction.request.level} ${transaction.request.type}: ${transaction.request.reason}`,
    data: {
      previousRevision: transaction.sourceMetadata.activeRevision,
      previousBaseline: transaction.sourceMetadata.baseline,
      baseline: result.revision.baseline!,
      affectedReadiness: transaction.affectedReadiness,
      affectedTasks: transaction.affectedTasks,
      correlationId: transaction.correlationId,
    },
  };
  if (matching.length !== 1 || JSON.stringify(matching[0]) !== JSON.stringify(expected)) {
    throw ordinaryCompletionMismatch();
  }
}

function ordinaryCompletionMismatch(): Error {
  return new Error('ORDINARY_RECONCILE_TRANSACTION_COMPLETION_MISMATCH');
}

interface DecisionReboundAudit {
  timestamp?: string;
  event?: string;
  changeId?: string;
  revision?: string;
  detail?: string;
  data?: {
    decisionId?: string;
    fromRevision?: string;
    toRevision?: string;
    baseline?: string;
    correlationId?: string;
    authority?: string;
    replacementId?: string;
  };
}

interface ReconcileAudit {
  timestamp?: string;
  event?: string;
  changeId?: string;
  revision?: string;
  detail?: string;
  data?: {
    previousRevision?: string;
    previousBaseline?: string;
    baseline?: string;
    affectedReadiness?: unknown;
    affectedTasks?: unknown;
    correlationId?: string;
  };
}

interface FlowSourceAudit {
  event?: string;
  changeId?: string;
  revision?: string;
  detail?: string;
  data?: {
    correlationId?: string;
    baseline?: string;
    inputHash?: string;
  };
}
