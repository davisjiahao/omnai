import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  decisionRecordSchema,
  decisionResolutionInputSchema,
  openDecisionInputSchema,
  flowPlanSchema,
  readinessSchema,
  reconcileSignalSchema,
  revisionSchema,
  type ChangeMetadata,
  sourceRefCollectionSchema,
  type DecisionRecord,
  type DecisionResolutionInputConstructionInput,
  type DecisionResolutionInput,
  type OpenDecisionInputConstructionInput,
  type OpenDecisionInput,
  type ReconcileLevel,
  type SourceRef,
  type SourceRefCollectionConstructionInput,
} from '../domain/types.js';
import { withChangeMutationLock } from './change-mutation-lock.js';
import {
  assertDecisionReconcileTransactionFence,
  completeDecisionReconcileTransaction,
  createDecisionReconcileTransaction,
  loadDecisionReconcileTransaction,
  writeDecisionReconcileTransaction,
  type DecisionReconcileTransaction,
} from './decision-reconcile-transaction.js';
import {
  assertDecisionCurrent,
  listDecisions,
  listPersistedDecisions,
  rebindLiveDecisionsWithinChangeLock,
  requireActiveDecisionChange,
  requireDecision,
  writeDecisionWithinChangeLock,
} from './decision-store.js';
import { appendJsonLine, ensureDir, readJsonLines, readYaml } from './files.js';
import { hashFlowPlan } from './flow.js';
import { preflightFlowArchiveCompatibilityWithinChangeLock } from './flow-archive.js';
import {
  assertFlowTransactionAllowsDecisionMutation,
  assertFlowTransactionFence,
} from './flow-transaction.js';
import { loadFlowPlan } from './flow-store.js';
import {
  loadFlowPlanForTransactionRecoveryWithinChangeLock,
  rebindPreflightedFlowPlanForRevisionWithinChangeLock,
  synchronizeFlowDecisionsWithinChangeLock,
} from './flow-store-internal.js';
import {
  changeArtifactPath,
  changeDecisionsRoot,
  changeRevisionsRoot,
} from './paths.js';
import { readinessKeyForCapability } from './readiness.js';
import { assertOrdinaryReconcileTransactionFence } from './ordinary-reconcile-transaction.js';
import {
  completeReconcileAuditWithinChangeLock,
  reconciledReadinessSnapshot,
  reconciledTaskSnapshot,
  readinessClosureForReconcileLevel,
  reconcileChangeWithinChangeLock,
} from './reconcile-internal.js';
import type { ReconcileResult } from './reconcile.js';
import { incrementBaseline, incrementRevision } from './revision-ids.js';
import type { ChangeRef } from './store.js';
import { dependentTaskIds, loadTasks } from './tasks.js';
import { assertTransactionLineageIntegrity } from './transaction-lineage-integrity.js';
import { hashDecisionRecord } from './decision-transition.js';
import {
  beginDecisionSemanticMutationWithinChangeLock,
  openSemanticRequest,
  resolveSemanticRequest,
  resumeDecisionSemanticMutationWithinChangeLock,
  supersedeSemanticRequest,
} from './decision-semantic-mutation.js';
import { assertSemanticMutationRequestPreflight } from './semantic-mutation-journal.js';

export { listDecisions, requireDecision } from './decision-store.js';

const mutationChannel = channel('omnai:core:change-mutation');

export async function openDecision(repoRoot: string, change: ChangeRef, input: OpenDecisionInputConstructionInput): Promise<DecisionRecord> {
  const parsed = openDecisionInputSchema.parse(input);
  await assertSemanticMutationRequestPreflight(repoRoot, change, 'DECISION', openSemanticRequest(parsed));
  return withChangeMutationLock(repoRoot, change, () => openDecisionWithinChangeLock(repoRoot, change, parsed));
}

async function openDecisionWithinChangeLock(
  repoRoot: string,
  change: ChangeRef,
  input: OpenDecisionInput,
): Promise<DecisionRecord> {
  const active = await requireActiveDecisionChange(repoRoot, change);
  await assertTransactionLineageIntegrity(repoRoot, change);
  change.metadata = active;
  const parsedInput = openDecisionInputSchema.parse(input);
  const request = openSemanticRequest(parsedInput);
  const recovered = await resumeDecisionSemanticMutationWithinChangeLock(repoRoot, change, request);
  if (recovered) return recovered;
  await assertDecisionReconcileTransactionFence(repoRoot, change);
  await assertOrdinaryReconcileTransactionFence(repoRoot, change);
  await assertFlowTransactionAllowsDecisionMutation(repoRoot, change);
  const root = changeDecisionsRoot(repoRoot, change.directoryName);
  await ensureDir(root);
  const records = await listPersistedDecisions(repoRoot, change);
  const id = nextDecisionId(records.map(({ file }) => file));
  const now = new Date().toISOString();
  const record = decisionRecordSchema.parse({
    id,
    changeId: active.id,
    openedRevision: active.activeRevision,
    resolvedRevision: null,
    ...parsedInput,
    resolution: null,
    supersededBy: null,
    createdAt: now,
    updatedAt: now,
  });
  return beginDecisionSemanticMutationWithinChangeLock(
    repoRoot,
    change,
    request,
    record.id,
    record,
  );
}

export async function resolveDecision(
  repoRoot: string,
  change: ChangeRef,
  decisionId: string,
  input: DecisionResolutionInputConstructionInput,
): Promise<DecisionRecord> {
  const parsed = decisionResolutionInputSchema.parse(input);
  await assertSemanticMutationRequestPreflight(
    repoRoot,
    change,
    'DECISION',
    resolveSemanticRequest(decisionId, parsed),
  );
  return withChangeMutationLock(
    repoRoot,
    change,
    () => resolveDecisionWithinChangeLock(repoRoot, change, decisionId, parsed),
  );
}

async function resolveDecisionWithinChangeLock(
  repoRoot: string,
  change: ChangeRef,
  decisionId: string,
  input: DecisionResolutionInput,
): Promise<DecisionRecord> {
  const active = await requireActiveDecisionChange(repoRoot, change);
  await assertTransactionLineageIntegrity(repoRoot, change);
  change.metadata = active;
  const resolution = decisionResolutionInputSchema.parse(input);
  const request = resolveSemanticRequest(decisionId, resolution);
  const recovered = await resumeDecisionSemanticMutationWithinChangeLock(repoRoot, change, request);
  if (recovered) return recovered;
  await assertOrdinaryReconcileTransactionFence(repoRoot, change);
  const current = await requireDecision(repoRoot, change, decisionId);
  const expectedAuthority = authorityFor(current.owner);
  if (resolution.authority !== expectedAuthority) throw new Error(`DECISION_AUTHORITY_MISMATCH: ${current.owner} requires ${expectedAuthority}`);
  const pending = await loadDecisionReconcileTransaction(repoRoot, change, current);
  if (pending) {
    await assertFlowTransactionFence(repoRoot, change);
    assertDecisionReconcileRequest(pending, current, resolution, active.id);
    return continueDecisionReconcileTransaction(repoRoot, change, pending, active);
  }
  await assertDecisionReconcileTransactionFence(repoRoot, change);
  await assertFlowTransactionAllowsDecisionMutation(repoRoot, change);
  assertDecisionCurrent(current, active.id, active.activeRevision);
  if (!isNonTerminal(current)) throw new Error(`DECISION_NOT_OPEN: ${decisionId}`);
  if (requiresDecisionReconcile(current, active)) {
    return beginDecisionReconcileTransaction(repoRoot, change, current, resolution);
  }
  const updatedAt = new Date().toISOString();
  const record = resolvedDecisionRecord(current, resolution, active, updatedAt);
  return beginDecisionSemanticMutationWithinChangeLock(
    repoRoot,
    change,
    request,
    record.id,
    record,
  );
}

async function persistResolvedDecision(
  repoRoot: string,
  change: ChangeRef,
  current: DecisionRecord,
  resolution: DecisionResolutionInput,
  active: ChangeMetadata,
  updatedAt = new Date().toISOString(),
): Promise<DecisionRecord> {
  const record = resolvedDecisionRecord(current, resolution, active, updatedAt);
  await writeDecisionWithinChangeLock(repoRoot, change, record, 'DECISION_RESOLVED', `Resolved decision ${record.id}: ${resolution.summary}`, {
    decisionId: record.id,
    baseline: active.baseline,
    authority: resolution.authority,
  });
  return record;
}

function resolvedDecisionRecord(
  current: DecisionRecord,
  resolution: DecisionResolutionInput,
  active: ChangeMetadata,
  updatedAt: string,
): DecisionRecord {
  return decisionRecordSchema.parse({
    ...current,
    status: 'RESOLVED',
    resolvedRevision: active.activeRevision,
    resolution,
    updatedAt,
  });
}

const SETTLED_AUTHORITY = new Set<ChangeMetadata['readiness'][keyof ChangeMetadata['readiness']]>([
  'READY',
  'CONCERNS',
  'STALE',
  'NEEDS_REVALIDATION',
  'INVALIDATED',
]);

function requiresDecisionReconcile(decision: DecisionRecord, active: ChangeMetadata): boolean {
  return decision.blocking && settledAffectedReadiness(decision, active).length > 0;
}

async function beginDecisionReconcileTransaction(
  repoRoot: string,
  change: ChangeRef,
  decision: DecisionRecord,
  resolution: DecisionResolutionInput,
): Promise<DecisionRecord> {
  const flow = await loadFlowPlan(repoRoot, change);
  const decisions = await listDecisions(repoRoot, change);
  assertFlowDecisionInventory(flow, decisions);
  const level = reconcileLevelForDecision(decision);
  const affectedReadiness = readinessClosureForReconcileLevel(level);
  const uncovered = settledAffectedReadiness(decision, change.metadata)
    .find((readiness) => !affectedReadiness.includes(readiness));
  if (uncovered) throw new Error(`DECISION_RECONCILE_CLOSURE_INCOMPLETE: ${uncovered}`);
  const taskRoots = [...new Set(decision.affects.tasks)];
  const taskFile = await loadTasks(changeArtifactPath(repoRoot, change.directoryName, 'tasks.yaml'));
  const knownTasks = new Set(taskFile.tasks.map(({ id }) => id));
  const unknownRoot = taskRoots.find((taskId) => !knownTasks.has(taskId));
  if (unknownRoot) throw new Error(`DECISION_TASK_NOT_FOUND: ${unknownRoot}`);
  const affectedTasks = dependentTaskIds(taskFile, taskRoots).filter((taskId) => knownTasks.has(taskId));
  const transaction = createDecisionReconcileTransaction(
    change,
    decision,
    resolution,
    flow,
    decisions,
    structuredClone(change.metadata.readiness),
    structuredClone(taskFile),
    affectedReadiness,
    taskRoots,
    affectedTasks,
    level,
    `DECISION-${decision.id}-${randomUUID()}`,
    new Date().toISOString(),
  );
  await preflightFlowArchiveCompatibilityWithinChangeLock(repoRoot, change, flow);
  await assertFlowTransactionFence(repoRoot, change);
  await writeDecisionReconcileTransaction(repoRoot, change, transaction);
  mutationChannel.publish({
    stage: 'DECISION_RECONCILE_INTENT_WRITTEN',
    changeId: change.metadata.id,
    correlationId: transaction.correlationId,
  });
  return continueDecisionReconcileTransaction(repoRoot, change, transaction, change.metadata);
}

async function continueDecisionReconcileTransaction(
  repoRoot: string,
  change: ChangeRef,
  transaction: DecisionReconcileTransaction,
  active: ChangeMetadata,
): Promise<DecisionRecord> {
  assertDecisionReconcileTransactionInventory(transaction);
  const nextRevision = incrementRevision(transaction.fromRevision);
  const nextBaseline = incrementBaseline(transaction.fromBaseline);
  if (active.activeRevision === transaction.fromRevision && active.baseline === transaction.fromBaseline) {
    if (transaction.status !== 'PENDING') {
      throw new Error('DECISION_RECONCILE_TRANSACTION_COMPLETION_MISMATCH');
    }
    const current = await requireDecision(repoRoot, change, transaction.decision.id);
    if (JSON.stringify(current) !== JSON.stringify(transaction.decision)) {
      throw new Error('DECISION_RECONCILE_TRANSACTION_STATE_CONFLICT');
    }
    const flow = await loadFlowPlan(repoRoot, change);
    assertTransactionOldFlow(transaction, flow);
    const decisions = await listDecisions(repoRoot, change);
    if (JSON.stringify(decisions) !== JSON.stringify(transaction.decisions)) {
      throw new Error('DECISION_RECONCILE_TRANSACTION_STATE_CONFLICT');
    }
    let resolved: DecisionRecord | null = null;
    const reconcile = await reconcileChangeWithinChangeLock(repoRoot, change, {
      level: transaction.level,
      type: 'DECISION_AUTHORITY_RESOLVED',
      reason: decisionReconcileReason(transaction),
      affectedReadiness: transaction.affectedReadiness,
      affectedTasks: transaction.taskRoots,
      affectedTaskClosure: transaction.affectedTasks,
      correlationId: transaction.correlationId,
    }, {
      expectedFlow: flow,
      expectedDecisions: decisions,
      expectedReadiness: transaction.readiness,
      expectedTasks: transaction.tasks,
      reconcileTransactionCorrelationId: transaction.correlationId,
      excludedDecisionId: transaction.decision.id,
      finalize: async () => {
        resolved = await finalizeDecisionReconcileResolution(repoRoot, change, transaction);
      },
    });
    if (!resolved) throw new Error('DECISION_RECONCILE_TRANSACTION_FINALIZATION_INCOMPLETE');
    await completeDecisionReconcileTransaction(
      repoRoot,
      change,
      transaction,
      reconcile.revision.id,
      reconcile.revision.baseline ?? nextBaseline,
    );
    return resolved;
  }

  if (active.activeRevision !== nextRevision || active.baseline !== nextBaseline) {
    throw new Error('DECISION_RECONCILE_TRANSACTION_STALE_REVISION');
  }
  change.metadata = active;
  await assertRecoveredDecisionReconcileState(repoRoot, change, transaction, active);
  const reconcile = await loadDecisionReconcileResult(repoRoot, change, transaction, active);
  const decisions = await listDecisions(repoRoot, change);
  assertRecoverableDecisionInventory(transaction, decisions, active);
  const reboundDecisions = await rebindLiveDecisionsWithinChangeLock(repoRoot, change, {
    fromRevision: transaction.fromRevision,
    decisions: transaction.decisions,
    reboundAt: reconcile.revision.createdAt,
    correlationId: transaction.correlationId,
    exceptDecisionId: transaction.decision.id,
  });
  const oldFlow = await loadArchivedDecisionTransactionFlow(repoRoot, change, transaction);
  if (oldFlow) {
    const stored = await loadFlowPlanForTransactionRecoveryWithinChangeLock(repoRoot, change, active, oldFlow);
    if (stored.revision === oldFlow.revision && stored.baseline === oldFlow.baseline) {
      await rebindPreflightedFlowPlanForRevisionWithinChangeLock(repoRoot, change, reboundDecisions, oldFlow);
    }
  } else if (await loadFlowPlan(repoRoot, change)) {
    throw new Error('DECISION_RECONCILE_TRANSACTION_FLOW_MISMATCH');
  }
  const resolved = await finalizeDecisionReconcileResolution(repoRoot, change, transaction);
  await completeReconcileAuditWithinChangeLock(repoRoot, change, reconcile);
  await completeDecisionReconcileTransaction(
    repoRoot,
    change,
    transaction,
    active.activeRevision,
    active.baseline,
  );
  return resolved;
}

function assertDecisionReconcileTransactionInventory(
  transaction: DecisionReconcileTransaction,
): void {
  const level = reconcileLevelForDecision(transaction.decision);
  const readiness = readinessClosureForReconcileLevel(level);
  const taskRoots = [...new Set(transaction.decision.affects.tasks)];
  const knownTasks = new Set(transaction.tasks.tasks.map(({ id }) => id));
  if (taskRoots.some((taskId) => !knownTasks.has(taskId))) {
    throw new Error('DECISION_RECONCILE_TRANSACTION_STATE_CONFLICT');
  }
  const affectedTasks = dependentTaskIds(transaction.tasks, taskRoots)
    .filter((taskId) => knownTasks.has(taskId));
  if (
    transaction.level !== level
    || JSON.stringify(transaction.affectedReadiness) !== JSON.stringify(readiness)
    || JSON.stringify(transaction.taskRoots) !== JSON.stringify(taskRoots)
    || JSON.stringify(transaction.affectedTasks) !== JSON.stringify(affectedTasks)
  ) throw new Error('DECISION_RECONCILE_TRANSACTION_STATE_CONFLICT');

  const uncovered = affectedReadinessForDecision(transaction.decision)
    .filter((key) => SETTLED_AUTHORITY.has(transaction.readiness[key]))
    .find((key) => !readiness.includes(key));
  if (uncovered) throw new Error(`DECISION_RECONCILE_CLOSURE_INCOMPLETE: ${uncovered}`);
}

async function assertRecoveredDecisionReconcileState(
  repoRoot: string,
  change: ChangeRef,
  transaction: DecisionReconcileTransaction,
  active: ChangeMetadata,
): Promise<void> {
  const expectedReadiness = reconciledReadinessSnapshot(
    transaction.readiness,
    transaction.affectedReadiness,
    transaction.level,
  );
  const severe = ['L2', 'L3', 'L4'].includes(transaction.level);
  const expectedTasks = reconciledTaskSnapshot(
    transaction.tasks,
    transaction.affectedTasks,
    severe,
  );
  const tasks = await loadTasks(changeArtifactPath(repoRoot, change.directoryName, 'tasks.yaml'));
  if (
    JSON.stringify(active.readiness) !== JSON.stringify(expectedReadiness)
    || JSON.stringify(tasks) !== JSON.stringify(expectedTasks)
  ) throw new Error('DECISION_RECONCILE_TRANSACTION_STATE_CONFLICT');
}

async function finalizeDecisionReconcileResolution(
  repoRoot: string,
  change: ChangeRef,
  transaction: DecisionReconcileTransaction,
): Promise<DecisionRecord> {
  const active = await requireActiveDecisionChange(repoRoot, change);
  await assertTransactionLineageIntegrity(repoRoot, change);
  change.metadata = active;
  const current = await requireDecision(repoRoot, change, transaction.decision.id);
  if (current.status === 'RESOLVED') {
    assertRecoveredResolution(current, transaction, active);
    await synchronizeFlowDecisionsWithinChangeLock(repoRoot, change, await listDecisions(repoRoot, change));
    await completeRecoveredDecisionAudit(repoRoot, change, current, active, transaction);
    return current;
  }
  if (JSON.stringify(current) !== JSON.stringify(transaction.decision)) {
    throw new Error('DECISION_RECONCILE_TRANSACTION_STATE_CONFLICT');
  }
  return persistResolvedDecision(
    repoRoot,
    change,
    current,
    transaction.resolution,
    active,
    transaction.createdAt,
  );
}

async function loadArchivedDecisionTransactionFlow(
  repoRoot: string,
  change: ChangeRef,
  transaction: DecisionReconcileTransaction,
) {
  if (transaction.oldFlowHash === null) return null;
  const archived = await readYaml(
    join(changeRevisionsRoot(repoRoot, change.directoryName), `${transaction.fromRevision}.flow.yaml`),
    flowPlanSchema,
  );
  if (hashFlowPlan(archived) !== transaction.oldFlowHash) {
    throw new Error('DECISION_RECONCILE_TRANSACTION_FLOW_MISMATCH');
  }
  return archived;
}

async function loadDecisionReconcileResult(
  repoRoot: string,
  change: ChangeRef,
  transaction: DecisionReconcileTransaction,
  active: ChangeMetadata,
): Promise<ReconcileResult> {
  const revision = await readYaml(
    join(changeRevisionsRoot(repoRoot, change.directoryName), `${active.activeRevision}.yaml`),
    revisionSchema,
  );
  if (
    revision.id !== active.activeRevision ||
    revision.changeId !== transaction.changeId ||
    revision.previousRevision !== transaction.fromRevision ||
    revision.previousBaseline !== transaction.fromBaseline ||
    revision.baseline !== active.baseline ||
    revision.operationRequestId !== transaction.correlationId ||
    revision.level !== transaction.level ||
    revision.reason !== decisionReconcileReason(transaction) ||
    JSON.stringify(revision.affectedReadiness) !== JSON.stringify(transaction.affectedReadiness) ||
    JSON.stringify(revision.affectedTasks) !== JSON.stringify(transaction.affectedTasks)
  ) throw new Error('DECISION_RECONCILE_TRANSACTION_REVISION_MISMATCH');
  const signalFiles = (await readdir(changeRevisionsRoot(repoRoot, change.directoryName)))
    .filter((file) => file.endsWith('.signal.yaml'));
  const signals = [];
  for (const file of signalFiles) {
    const signal = await readYaml(
      join(changeRevisionsRoot(repoRoot, change.directoryName), file),
      reconcileSignalSchema,
    );
    if (signal.operationRequestId === transaction.correlationId) signals.push(signal);
  }
  const signal = signals[0];
  if (
    signals.length !== 1 || !signal ||
    signal.changeId !== transaction.changeId ||
    signal.revision !== transaction.fromRevision ||
    signal.signalType !== 'DECISION_AUTHORITY_RESOLVED' ||
    signal.level !== transaction.level ||
    signal.reason !== decisionReconcileReason(transaction) ||
    JSON.stringify(signal.affectedTasks) !== JSON.stringify(transaction.taskRoots) ||
    signal.createdAt !== revision.createdAt
  ) throw new Error('DECISION_RECONCILE_TRANSACTION_SIGNAL_MISMATCH');
  return {
    signal,
    revision,
    affectedReadiness: revision.affectedReadiness,
    affectedTasks: revision.affectedTasks,
  };
}

async function completeRecoveredDecisionAudit(
  repoRoot: string,
  change: ChangeRef,
  record: DecisionRecord,
  active: ChangeMetadata,
  transaction: DecisionReconcileTransaction,
): Promise<void> {
  const progressPath = changeArtifactPath(repoRoot, change.directoryName, 'progress.jsonl');
  const events = await readJsonLines<{
    event?: string;
    changeId?: string;
    revision?: string;
    detail?: string;
    data?: {
      decisionId?: string;
      baseline?: string;
      authority?: string;
      beforeHash?: string;
      afterHash?: string;
      beforeDecision?: DecisionRecord;
      afterDecision?: DecisionRecord;
    };
  }>(progressPath);
  const beforeHash = hashDecisionRecord(transaction.decision);
  const afterHash = hashDecisionRecord(record);
  const matching = events.filter((event) => (
    event.event === 'DECISION_RESOLVED' && event.data?.decisionId === record.id
  ));
  if (matching.length > 1) throw new Error('DECISION_RECONCILE_TRANSACTION_AUDIT_CONFLICT');
  if (matching.length === 1) {
    const event = matching[0]!;
    if (
      event.changeId !== active.id ||
      event.revision !== active.activeRevision ||
      event.detail !== `Resolved decision ${record.id}: ${record.resolution?.summary}` ||
      event.data?.baseline !== active.baseline ||
      event.data?.authority !== record.resolution?.authority ||
      event.data?.beforeHash !== beforeHash ||
      event.data?.afterHash !== afterHash ||
      JSON.stringify(event.data?.beforeDecision) !== JSON.stringify(transaction.decision) ||
      JSON.stringify(event.data?.afterDecision) !== JSON.stringify(record)
    ) throw new Error('DECISION_RECONCILE_TRANSACTION_AUDIT_CONFLICT');
    return;
  }
  await appendJsonLine(progressPath, {
    timestamp: record.updatedAt,
    event: 'DECISION_RESOLVED',
    changeId: active.id,
    revision: active.activeRevision,
    detail: `Resolved decision ${record.id}: ${record.resolution?.summary}`,
    data: {
      decisionId: record.id,
      baseline: active.baseline,
      authority: record.resolution?.authority,
      beforeHash,
      afterHash,
      beforeDecision: transaction.decision,
      afterDecision: record,
    },
  });
}

function assertDecisionReconcileRequest(
  transaction: DecisionReconcileTransaction,
  current: DecisionRecord,
  resolution: DecisionResolutionInput,
  changeId: string,
): void {
  if (
    transaction.changeId !== changeId ||
    transaction.decision.id !== current.id ||
    JSON.stringify(transaction.resolution) !== JSON.stringify(resolution)
  ) throw new Error('DECISION_RECONCILE_TRANSACTION_REQUEST_MISMATCH');
}

function assertTransactionOldFlow(
  transaction: DecisionReconcileTransaction,
  flow: Awaited<ReturnType<typeof loadFlowPlan>>,
): void {
  if ((flow === null) !== (transaction.oldFlowHash === null)) {
    throw new Error('DECISION_RECONCILE_TRANSACTION_FLOW_MISMATCH');
  }
  if (flow && hashFlowPlan(flow) !== transaction.oldFlowHash) {
    throw new Error('DECISION_RECONCILE_TRANSACTION_FLOW_MISMATCH');
  }
}

function assertFlowDecisionInventory(
  flow: Awaited<ReturnType<typeof loadFlowPlan>>,
  decisions: readonly DecisionRecord[],
): void {
  if (!flow) return;
  const actual = decisions.map(({ id }) => id);
  if (
    flow.decisionIds.length !== actual.length ||
    flow.decisionIds.some((id, index) => id !== actual[index])
  ) throw new Error('FLOW_DECISION_INVENTORY_MISMATCH');
}

function assertRecoverableDecisionInventory(
  transaction: DecisionReconcileTransaction,
  decisions: readonly DecisionRecord[],
  active: ChangeMetadata,
): void {
  if (decisions.length !== transaction.decisions.length) {
    throw new Error('DECISION_RECONCILE_TRANSACTION_STATE_CONFLICT');
  }
  for (let index = 0; index < decisions.length; index += 1) {
    const current = decisions[index]!;
    const snapshot = transaction.decisions[index]!;
    if (current.id !== snapshot.id) throw new Error('DECISION_RECONCILE_TRANSACTION_STATE_CONFLICT');
    if (current.id === transaction.decision.id && current.status === 'RESOLVED') {
      assertRecoveredResolution(current, transaction, active);
    } else if (
      JSON.stringify(current) !== JSON.stringify(snapshot) &&
      !isValidLiveDecisionRebind(current, snapshot, active.activeRevision)
    ) {
      throw new Error('DECISION_RECONCILE_TRANSACTION_STATE_CONFLICT');
    }
  }
}

function isValidLiveDecisionRebind(
  current: DecisionRecord,
  snapshot: DecisionRecord,
  activeRevision: string,
): boolean {
  if (
    current.status !== snapshot.status ||
    (current.status !== 'OPEN' && current.status !== 'BLOCKED') ||
    current.openedRevision !== activeRevision
  ) return false;
  return JSON.stringify({
    ...current,
    openedRevision: snapshot.openedRevision,
    updatedAt: snapshot.updatedAt,
  }) === JSON.stringify(snapshot);
}

function assertRecoveredResolution(
  current: DecisionRecord,
  transaction: DecisionReconcileTransaction,
  active: ChangeMetadata,
): void {
  if (
    current.status !== 'RESOLVED' ||
    current.resolvedRevision !== active.activeRevision ||
    current.openedRevision !== transaction.fromRevision ||
    current.changeId !== transaction.changeId ||
    JSON.stringify(current.resolution) !== JSON.stringify(transaction.resolution) ||
    current.updatedAt !== transaction.createdAt ||
    hashDecisionRecord(current) !== hashDecisionRecord(decisionRecordSchema.parse({
      ...transaction.decision,
      status: 'RESOLVED',
      resolvedRevision: active.activeRevision,
      resolution: transaction.resolution,
      updatedAt: transaction.createdAt,
    }))
  ) throw new Error('DECISION_RECONCILE_TRANSACTION_RESOLUTION_MISMATCH');
}

function affectedReadinessForDecision(
  decision: DecisionRecord,
): Array<keyof ChangeMetadata['readiness']> {
  const affected: Array<keyof ChangeMetadata['readiness']> = [];
  for (const capability of decision.affects.capabilities) {
    const readiness = readinessKeyForCapability(capability);
    if (readiness && !affected.includes(readiness)) affected.push(readiness);
  }
  return affected;
}

function settledAffectedReadiness(
  decision: DecisionRecord,
  active: ChangeMetadata,
): Array<keyof ChangeMetadata['readiness']> {
  return affectedReadinessForDecision(decision)
    .filter((readiness) => SETTLED_AUTHORITY.has(active.readiness[readiness]));
}

function reconcileLevelForDecision(decision: DecisionRecord): ReconcileLevel {
  const semantic = semanticReconcileLevel(decision.kind);
  const affected = affectedReadinessForDecision(decision).map(reconcileLevelForReadiness);
  const candidates = semantic ? [semantic, ...affected] : affected;
  const upstream = candidates
    .filter((level): level is Exclude<ReconcileLevel, 'L5'> => level !== 'L5')
    .sort((left, right) => Number(right.slice(1)) - Number(left.slice(1)))[0];
  if (upstream) return upstream;
  return candidates.includes('L5') ? 'L5' : 'L0';
}

function semanticReconcileLevel(kind: DecisionRecord['kind']): ReconcileLevel | null {
  if (kind === 'PROBLEM') return 'L4';
  if (kind === 'DOMAIN') return 'L3';
  if (kind === 'SOLUTION' || kind === 'ARCHITECTURE' || kind === 'CONTRACT') return 'L2';
  if (kind === 'DELIVERY' || kind === 'EXTERNAL') return 'L5';
  return null;
}

function reconcileLevelForReadiness(
  readiness: keyof ChangeMetadata['readiness'],
): ReconcileLevel {
  if (['frame', 'map', 'research', 'mitigation', 'triage', 'reproduction', 'diagnosis'].includes(readiness)) return 'L4';
  if (['domain', 'spec'].includes(readiness)) return 'L3';
  if (['design', 'experiment', 'fix'].includes(readiness)) return 'L2';
  if (readiness === 'plan') return 'L1';
  if (['review', 'verification', 'qa', 'release', 'canary'].includes(readiness)) return 'L5';
  return 'L0';
}

function decisionReconcileReason(transaction: DecisionReconcileTransaction): string {
  return `Resolved ${transaction.decision.id} against settled authority: ${transaction.resolution.summary}`;
}

export async function supersedeDecision(
  repoRoot: string,
  change: ChangeRef,
  decisionId: string,
  replacementId: string,
  reason: string,
  sourceRefs: SourceRefCollectionConstructionInput,
): Promise<DecisionRecord> {
  const sources = parseCurrentSourceRefs(sourceRefs);
  if (!reason.trim()) throw new Error('DECISION_SUPERSESSION_REASON_REQUIRED');
  if (decisionId === replacementId) throw new Error('DECISION_REPLACEMENT_SELF_REFERENCE');
  await assertSemanticMutationRequestPreflight(
    repoRoot,
    change,
    'DECISION',
    supersedeSemanticRequest(decisionId, replacementId, reason, sources),
  );
  return withChangeMutationLock(
    repoRoot,
    change,
    () => supersedeDecisionWithinChangeLock(repoRoot, change, decisionId, replacementId, reason, sources),
  );
}

async function supersedeDecisionWithinChangeLock(
  repoRoot: string,
  change: ChangeRef,
  decisionId: string,
  replacementId: string,
  reason: string,
  sourceRefs: SourceRef[],
): Promise<DecisionRecord> {
  const active = await requireActiveDecisionChange(repoRoot, change);
  await assertTransactionLineageIntegrity(repoRoot, change);
  change.metadata = active;
  const sources = parseCurrentSourceRefs(sourceRefs);
  if (!reason.trim()) throw new Error('DECISION_SUPERSESSION_REASON_REQUIRED');
  if (decisionId === replacementId) throw new Error('DECISION_REPLACEMENT_SELF_REFERENCE');
  const request = supersedeSemanticRequest(decisionId, replacementId, reason, sources);
  const recovered = await resumeDecisionSemanticMutationWithinChangeLock(repoRoot, change, request);
  if (recovered) return recovered;
  await assertDecisionReconcileTransactionFence(repoRoot, change);
  await assertOrdinaryReconcileTransactionFence(repoRoot, change);
  await assertFlowTransactionAllowsDecisionMutation(repoRoot, change);
  const current = await requireDecision(repoRoot, change, decisionId);
  const replacement = await requireDecision(repoRoot, change, replacementId);
  assertDecisionCurrent(current, active.id, active.activeRevision);
  assertDecisionCurrent(replacement, active.id, active.activeRevision);
  if (!isNonTerminal(current) && current.status !== 'RESOLVED') throw new Error(`DECISION_NOT_SUPERSEDABLE: ${decisionId}`);
  if (!isNonTerminal(replacement)) throw new Error(`DECISION_REPLACEMENT_NOT_LIVE: ${replacementId}`);
  const record = decisionRecordSchema.parse({
    ...current,
    status: 'SUPERSEDED',
    resolvedRevision: active.activeRevision,
    resolution: null,
    supersededBy: replacement.id,
    updatedAt: new Date().toISOString(),
  });
  return beginDecisionSemanticMutationWithinChangeLock(
    repoRoot,
    change,
    request,
    record.id,
    record,
  );
}

function nextDecisionId(files: string[]): string {
  const suffix = files.reduce((maximum, file) => Math.max(maximum, Number(file.slice(4, -'.yaml'.length))), 0);
  return `DEC-${String(suffix + 1).padStart(4, '0')}`;
}

function isNonTerminal(record: DecisionRecord): boolean {
  return record.status === 'OPEN' || record.status === 'BLOCKED';
}

function authorityFor(owner: DecisionRecord['owner']): DecisionResolutionInput['authority'] {
  if (owner === 'HUMAN') return 'HUMAN_CONFIRMED';
  if (owner === 'AGENT') return 'AGENT_EVIDENCE';
  return 'EXTERNAL_CONFIRMED';
}

function parseCurrentSourceRefs(sourceRefs: SourceRefCollectionConstructionInput): SourceRef[] {
  const parsed = sourceRefCollectionSchema.parse(sourceRefs);
  if (parsed.length === 0) throw new Error('DECISION_SOURCE_REFS_REQUIRED');
  return parsed;
}
