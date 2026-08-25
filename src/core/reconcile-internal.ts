import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  changeMetadataSchema, readinessKeySchema, reconcileSignalSchema, revisionSchema,
  type ChangeMetadata, type DecisionRecord, type FlowPlan, type Readiness, type ReconcileSignal, type Revision,
  type TaskFile,
} from '../domain/types.js';
import { listDecisions, rebindLiveDecisionsWithinChangeLock } from './decision-store.js';
import { assertDecisionReconcileTransactionFence } from './decision-reconcile-transaction.js';
import { appendJsonLine, pathExists, readJsonLines, readYaml, writeYaml } from './files.js';
import { ensureFlowArchiveWithinChangeLock } from './flow-archive.js';
import { assertFlowTransactionFence } from './flow-transaction.js';
import { loadFlowPlan } from './flow-store.js';
import { rebindPreflightedFlowPlanForRevisionWithinChangeLock } from './flow-store-internal.js';
import { assertOrdinaryReconcileTransactionFence } from './ordinary-reconcile-transaction.js';
import { changeArtifactPath, changeMetadataPath, changeRevisionsRoot } from './paths.js';
import type { ReconcileInput, ReconcileResult } from './reconcile.js';
import { incrementBaseline, incrementRevision } from './revision-ids.js';
import type { ChangeRef } from './store.js';
import { persistChangeMetadataWithinChangeLock } from './change-metadata-internal.js';
import { dependentTaskIds, invalidateExactTasks, invalidateTasks, loadTasks, saveTasks } from './tasks.js';

import { readinessClosureForReconcileLevel } from './reconcile-semantics.js';

const mutationChannel = channel('omnai:core:change-mutation');

export { readinessClosureForReconcileLevel } from './reconcile-semantics.js';

export interface ReconcileWithinChangeLockOptions {
  expectedFlow?: FlowPlan | null;
  expectedDecisions?: readonly DecisionRecord[];
  flowTransactionCorrelationId?: string;
  reconcileTransactionCorrelationId?: string;
  ordinaryReconcileTransactionCorrelationId?: string;
  expectedReadiness?: Readiness;
  expectedTasks?: TaskFile;
  excludedDecisionId?: string;
  transactionCreatedAt?: string;
  finalize?: (result: ReconcileResult) => Promise<void>;
}

/** @internal Caller must hold the exact Change mutation lock. */
export async function reconcileChangeWithinChangeLock(
  repoRoot: string,
  change: ChangeRef,
  input: ReconcileInput,
  options: ReconcileWithinChangeLockOptions = {},
): Promise<ReconcileResult> {
  await assertFlowTransactionFence(repoRoot, change, options.flowTransactionCorrelationId);
  await assertDecisionReconcileTransactionFence(
    repoRoot,
    change,
    options.reconcileTransactionCorrelationId,
  );
  await assertOrdinaryReconcileTransactionFence(
    repoRoot,
    change,
    options.ordinaryReconcileTransactionCorrelationId,
  );
  const transactionCorrelationId = options.reconcileTransactionCorrelationId
    ?? options.flowTransactionCorrelationId
    ?? options.ordinaryReconcileTransactionCorrelationId;
  const preflightFlow = await loadFlowPlan(repoRoot, change);
  const preflightDecisions = await listDecisions(repoRoot, change);
  assertExpectedInputs(preflightFlow, preflightDecisions, options);
  await refreshPersistedMetadata(repoRoot, change);
  const affectedReadiness = normalizeAffectedReadiness(
    input.affectedReadiness ?? readinessClosureForReconcileLevel(input.level),
  );
  const tasksPath = changeArtifactPath(repoRoot, change.directoryName, 'tasks.yaml');
  const taskFile = await loadTasks(tasksPath);
  const requestedTasks = input.affectedTasks ?? [];
  const severeTaskInvalidation = ['L2', 'L3', 'L4'].includes(input.level);
  let affectedTasks: string[] = [];
  let expectedTaskTarget: TaskFile | null = null;

  if (
    options.expectedReadiness
    && JSON.stringify(change.metadata.readiness) !== JSON.stringify(options.expectedReadiness)
  ) throw new Error('DECISION_RECONCILE_TRANSACTION_STATE_CONFLICT');
  if (input.affectedTaskClosure !== undefined && options.expectedTasks) {
    expectedTaskTarget = reconciledTaskSnapshot(
      options.expectedTasks,
      unique(input.affectedTaskClosure),
      severeTaskInvalidation,
    );
    if (
      JSON.stringify(taskFile) !== JSON.stringify(options.expectedTasks)
      && JSON.stringify(taskFile) !== JSON.stringify(expectedTaskTarget)
    ) throw new Error('DECISION_RECONCILE_TRANSACTION_STATE_CONFLICT');
  }

  await ensureFlowArchiveWithinChangeLock(repoRoot, change, preflightFlow);
  publishStage('FLOW_RECONCILE_ARCHIVE_ENSURED', change, transactionCorrelationId);

  if (hasExpectedInputs(options)) {
    assertExpectedInputs(await loadFlowPlan(repoRoot, change), await listDecisions(repoRoot, change), options);
  }

  if (input.affectedTaskClosure !== undefined) {
    affectedTasks = unique(input.affectedTaskClosure);
    if (options.expectedTasks) {
      const target = expectedTaskTarget!;
      if (JSON.stringify(taskFile) === JSON.stringify(options.expectedTasks)) {
        if (affectedTasks.length > 0) {
          await saveTasks(tasksPath, target);
          publishStage('FLOW_RECONCILE_TASKS_SAVED', change, transactionCorrelationId);
        }
      } else if (JSON.stringify(taskFile) !== JSON.stringify(target)) {
        throw new Error('DECISION_RECONCILE_TRANSACTION_STATE_CONFLICT');
      }
    } else {
      invalidateExactTasks(taskFile, affectedTasks, severeTaskInvalidation);
      if (affectedTasks.length > 0) await saveTasks(tasksPath, taskFile);
    }
  } else if (requestedTasks.length > 0) {
    const knownTaskIds = new Set(taskFile.tasks.map((task) => task.id));
    affectedTasks = dependentTaskIds(taskFile, requestedTasks).filter((taskId) => knownTaskIds.has(taskId));
    invalidateTasks(taskFile, requestedTasks, severeTaskInvalidation);
    await saveTasks(tasksPath, taskFile);
  }

  const previousRevision = change.metadata.activeRevision;
  const previousBaseline = change.metadata.baseline;
  const nextRevision = incrementRevision(previousRevision);
  const nextBaseline = incrementBaseline(previousBaseline);
  const artifacts = await prepareReconcileArtifacts(repoRoot, change, input, {
    previousRevision,
    previousBaseline,
    nextRevision,
    nextBaseline,
    affectedReadiness,
    affectedTasks,
    requestedTasks,
    transactionCorrelationId,
    transactionCreatedAt: options.transactionCreatedAt,
  });
  const { signal, revision } = artifacts;

  if (!artifacts.signalDurable) {
    await writeYaml(join(changeRevisionsRoot(repoRoot, change.directoryName), `${signal.id}.signal.yaml`), signal);
    publishStage('FLOW_RECONCILE_SIGNAL_WRITTEN', change, transactionCorrelationId);
  }
  if (!artifacts.revisionDurable) {
    await writeYaml(join(changeRevisionsRoot(repoRoot, change.directoryName), `${nextRevision}.yaml`), revision);
    publishStage('FLOW_RECONCILE_REVISION_WRITTEN', change, transactionCorrelationId);
  }

  change.metadata.readiness = reconciledReadinessSnapshot(
    options.expectedReadiness ?? change.metadata.readiness,
    affectedReadiness,
    input.level,
  );
  change.metadata.activeRevision = nextRevision;
  change.metadata.baseline = nextBaseline;
  change.metadata.status = 'IN_PROGRESS';
  await persistChangeMetadataWithinChangeLock(
    repoRoot,
    change,
    change.metadata,
    revision.createdAt,
  );
  publishStage('FLOW_RECONCILE_METADATA_SAVED', change, transactionCorrelationId);
  const reboundDecisions = await rebindLiveDecisionsWithinChangeLock(
    repoRoot,
    change,
    {
      fromRevision: previousRevision,
      decisions: preflightDecisions,
      reboundAt: revision.createdAt,
      correlationId: signal.operationRequestId,
      ...(options.excludedDecisionId ? { exceptDecisionId: options.excludedDecisionId } : {}),
      afterDecisionPersisted: () => publishStage(
        'FLOW_RECONCILE_DECISION_REBOUND',
        change,
        transactionCorrelationId,
      ),
    },
  );
  await rebindPreflightedFlowPlanForRevisionWithinChangeLock(
    repoRoot,
    change,
    reboundDecisions,
    preflightFlow,
    options.transactionCreatedAt ?? revision.createdAt,
  );
  publishStage('FLOW_RECONCILE_REBOUND', change, transactionCorrelationId);
  const result = { signal, revision, affectedReadiness, affectedTasks };
  if (options.finalize) await options.finalize(result);
  await completeReconcileAuditWithinChangeLock(repoRoot, change, result);
  return result;
}

/** @internal Computes the immutable target used by Decision transaction recovery. */
export function reconciledReadinessSnapshot(
  snapshot: Readiness,
  affectedReadiness: readonly (keyof Readiness)[],
  level: ReconcileInput['level'],
): Readiness {
  const target = structuredClone(snapshot);
  for (const key of affectedReadiness) {
    const current = snapshot[key];
    if (current === 'NOT_APPLICABLE') continue;
    if (key === 'implementation' && ['READY', 'CONCERNS'].includes(current)) target[key] = 'NEEDS_REVALIDATION';
    else if (['L2', 'L3', 'L4'].includes(level) && ['plan', 'design'].includes(key)) target[key] = 'INVALIDATED';
    else target[key] = current === 'MISSING' ? 'MISSING' : 'STALE';
  }
  return target;
}

/** @internal Computes task invalidation from the frozen pre-transaction state. */
export function reconciledTaskSnapshot(
  snapshot: TaskFile,
  affectedTasks: readonly string[],
  severe: boolean,
): TaskFile {
  const target = structuredClone(snapshot);
  invalidateExactTasks(target, [...affectedTasks], severe);
  return target;
}

/** @internal Caller must hold the exact Change mutation lock. */
export async function completeReconcileAuditWithinChangeLock(
  repoRoot: string,
  change: ChangeRef,
  result: ReconcileResult,
): Promise<void> {
  const progressPath = changeArtifactPath(repoRoot, change.directoryName, 'progress.jsonl');
  const events = await readJsonLines<{
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
  }>(progressPath);
  const correlationId = result.signal.operationRequestId;
  const existing = events.filter((event) => (
    event.event === 'RECONCILE_APPLIED' && (
      correlationId ? event.data?.correlationId === correlationId : event.revision === result.revision.id
    )
  ));
  const conflict = correlationId ? 'FLOW_TRANSACTION_COMPLETION_MISMATCH' : 'RECONCILE_AUDIT_CONFLICT';
  if (existing.length > 1) throw new Error(conflict);
  if (existing.length === 1) {
    const event = existing[0]!;
    if (
      event.timestamp !== result.revision.createdAt ||
      event.changeId !== result.revision.changeId ||
      event.revision !== result.revision.id ||
      event.detail !== `${result.signal.level} ${result.signal.signalType}: ${result.signal.reason}` ||
      event.data?.previousRevision !== result.revision.previousRevision ||
      event.data?.previousBaseline !== result.revision.previousBaseline ||
      event.data?.baseline !== result.revision.baseline ||
      JSON.stringify(event.data?.affectedReadiness) !== JSON.stringify(result.affectedReadiness) ||
      JSON.stringify(event.data?.affectedTasks) !== JSON.stringify(result.affectedTasks) ||
      event.data?.correlationId !== correlationId
    ) throw new Error(conflict);
    return;
  }
  await appendJsonLine(progressPath, {
    timestamp: result.revision.createdAt,
    event: 'RECONCILE_APPLIED',
    changeId: result.revision.changeId,
    revision: result.revision.id,
    detail: `${result.signal.level} ${result.signal.signalType}: ${result.signal.reason}`,
    data: {
      previousRevision: result.revision.previousRevision,
      previousBaseline: result.revision.previousBaseline,
      baseline: result.revision.baseline,
      affectedReadiness: result.affectedReadiness,
      affectedTasks: result.affectedTasks,
      ...(correlationId ? { correlationId } : {}),
    },
  });
}

function publishStage(stage: string, change: ChangeRef, correlationId?: string): void {
  if (!correlationId) return;
  mutationChannel.publish({ stage, changeId: change.metadata.id, correlationId });
}

function normalizeAffectedReadiness(values: Array<keyof ChangeMetadata['readiness']>): Array<keyof ChangeMetadata['readiness']> {
  const keySchema = readinessKeySchema;
  const normalized: Array<keyof ChangeMetadata['readiness']> = [];
  for (const value of values) {
    const parsed = keySchema.parse(value) as keyof ChangeMetadata['readiness'];
    if (!normalized.includes(parsed)) normalized.push(parsed);
  }
  return normalized;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

async function refreshPersistedMetadata(repoRoot: string, change: ChangeRef): Promise<void> {
  const persisted = await readYaml(changeMetadataPath(repoRoot, change.directoryName), changeMetadataSchema);
  const hasPendingProfileChange = (
    persisted.scenario !== change.metadata.scenario || persisted.workMode !== change.metadata.workMode ||
    JSON.stringify(persisted.risk) !== JSON.stringify(change.metadata.risk) ||
    JSON.stringify(persisted.impact) !== JSON.stringify(change.metadata.impact)
  );
  if (hasPendingProfileChange) {
    if (persisted.updatedAt !== change.metadata.updatedAt) throw new Error('RECONCILE_STALE_CHANGE_STATE');
    return;
  }
  change.metadata = persisted;
}

function assertExpectedInputs(
  flow: FlowPlan | null,
  decisions: readonly DecisionRecord[],
  options: ReconcileWithinChangeLockOptions,
): void {
  if (Object.hasOwn(options, 'expectedFlow') && JSON.stringify(flow) !== JSON.stringify(options.expectedFlow)) {
    throw new Error('FLOW_STALE_PLAN_STATE');
  }
  if (options.expectedDecisions && JSON.stringify(decisions) !== JSON.stringify(options.expectedDecisions)) {
    throw new Error('FLOW_STALE_DECISION_STATE');
  }
}

function hasExpectedInputs(options: ReconcileWithinChangeLockOptions): boolean {
  return Object.hasOwn(options, 'expectedFlow') || options.expectedDecisions !== undefined;
}

interface ReconcileArtifactInputs {
  previousRevision: string;
  previousBaseline: string;
  nextRevision: string;
  nextBaseline: string;
  affectedReadiness: Array<keyof ChangeMetadata['readiness']>;
  affectedTasks: string[];
  requestedTasks: string[];
  transactionCorrelationId: string | undefined;
  transactionCreatedAt: string | undefined;
}

interface PreparedReconcileArtifacts {
  signal: ReconcileSignal;
  revision: Revision;
  signalDurable: boolean;
  revisionDurable: boolean;
}

async function prepareReconcileArtifacts(
  repoRoot: string,
  change: ChangeRef,
  input: ReconcileInput,
  artifacts: ReconcileArtifactInputs,
): Promise<PreparedReconcileArtifacts> {
  const correlationId = artifacts.transactionCorrelationId;
  if (!correlationId) return createFreshReconcileArtifacts(change, input, artifacts);

  const revisionsRoot = changeRevisionsRoot(repoRoot, change.directoryName);
  const correlatedSignals: Array<{ file: string; signal: ReconcileSignal }> = [];
  for (const file of (await readdir(revisionsRoot)).filter((candidate) => candidate.endsWith('.signal.yaml'))) {
    const signal = await readYaml(join(revisionsRoot, file), reconcileSignalSchema);
    if (signal.operationRequestId === correlationId) correlatedSignals.push({ file, signal });
  }
  if (correlatedSignals.length > 1) throw new Error('FLOW_TRANSACTION_SIGNAL_CONFLICT');

  const durableSignal = correlatedSignals[0];
  const signal = durableSignal?.signal ?? createReconcileSignal(
    change,
    input,
    artifacts,
    artifacts.transactionCreatedAt ?? new Date().toISOString(),
  );
  if (durableSignal) {
    if (
      durableSignal.file !== `${signal.id}.signal.yaml` ||
      JSON.stringify(reconcileSignalSemantics(signal)) !== JSON.stringify({
        changeId: change.metadata.id,
        revision: artifacts.previousRevision,
        level: input.level,
        type: input.type,
        reason: input.reason,
        affectedTasks: artifacts.requestedTasks,
        evidence: input.evidence ?? [],
        correlationId,
      })
    ) throw new Error('FLOW_TRANSACTION_SIGNAL_CONFLICT');
  }

  const expectedRevision = createReconcileRevision(change, input, artifacts, signal.createdAt);
  const revisionPath = join(revisionsRoot, `${artifacts.nextRevision}.yaml`);
  const revisionDurable = await pathExists(revisionPath);
  if (revisionDurable) {
    if (!durableSignal) throw new Error('FLOW_TRANSACTION_REVISION_CONFLICT');
    const durableRevision = await readYaml(revisionPath, revisionSchema);
    if (JSON.stringify(durableRevision) !== JSON.stringify(expectedRevision)) {
      throw new Error('FLOW_TRANSACTION_REVISION_CONFLICT');
    }
  }
  return {
    signal,
    revision: expectedRevision,
    signalDurable: durableSignal !== undefined,
    revisionDurable,
  };
}

function createFreshReconcileArtifacts(
  change: ChangeRef,
  input: ReconcileInput,
  artifacts: ReconcileArtifactInputs,
): PreparedReconcileArtifacts {
  const now = artifacts.transactionCreatedAt ?? new Date().toISOString();
  const signal = createReconcileSignal(change, input, artifacts, now);
  return {
    signal,
    revision: createReconcileRevision(change, input, artifacts, now),
    signalDurable: false,
    revisionDurable: false,
  };
}

function createReconcileSignal(
  change: ChangeRef,
  input: ReconcileInput,
  artifacts: ReconcileArtifactInputs,
  createdAt: string,
): ReconcileSignal {
  const correlation = input.correlationId ? { correlationId: input.correlationId } : {};
  return reconcileSignalSchema.parse({
    schemaVersion: 1,
    id: `SIG-${Date.now()}-${randomUUID().slice(0, 8)}`,
    changeId: change.metadata.id,
    revision: artifacts.previousRevision,
    level: input.level,
    type: input.type,
    reason: input.reason,
    affectedTasks: artifacts.requestedTasks,
    evidence: input.evidence ?? [],
    ...correlation,
    createdAt,
  });
}

function createReconcileRevision(
  change: ChangeRef,
  input: ReconcileInput,
  artifacts: ReconcileArtifactInputs,
  createdAt: string,
): Revision {
  const correlation = input.correlationId ? { correlationId: input.correlationId } : {};
  return revisionSchema.parse({
    schemaVersion: 1,
    id: artifacts.nextRevision,
    changeId: change.metadata.id,
    previousRevision: artifacts.previousRevision,
    reason: input.reason,
    level: input.level,
    affectedArtifacts: artifacts.affectedReadiness,
    affectedTasks: artifacts.affectedTasks,
    previousBaseline: artifacts.previousBaseline,
    baseline: artifacts.nextBaseline,
    ...correlation,
    createdAt,
  });
}

function reconcileSignalSemantics(signal: ReconcileSignal): Omit<ReconcileSignal, 'schemaVersion' | 'id' | 'createdAt'> {
  const { schemaVersion: _schemaVersion, id: _id, createdAt: _createdAt, ...semantics } = signal;
  return semantics;
}
