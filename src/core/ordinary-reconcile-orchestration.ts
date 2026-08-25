import {
  recoverPendingOrdinaryTarget,
  resultForCompletedTransaction,
  validateCompletedOrdinaryReconcile,
} from './ordinary-reconcile-recovery.js';
import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  changeMetadataSchema,
  readinessKeySchema,
  reconcileSignalSchema,
  revisionSchema,
  type ChangeMetadata,
  type ReconcileLevel,
  type ReconcileSignal,
  type Revision,
} from '../domain/types.js';
import { assertDecisionReconcileTransactionFence } from './decision-reconcile-transaction.js';
import { listDecisions } from './decision-store.js';
import { readYaml } from './files.js';
import { preflightFlowArchiveCompatibilityWithinChangeLock } from './flow-archive.js';
import { assertFlowTransactionFence } from './flow-transaction.js';
import { loadFlowPlan } from './flow-store.js';
import {
  assertOrdinaryReconcileTransactionFence,
  completeOrdinaryReconcileTransaction,
  createOrdinaryReconcileTransaction,
  loadCompletedOrdinaryReconcileTransactionForActiveRevision,
  loadPendingOrdinaryReconcileTransaction,
  ordinaryReconcileRequestSchema,
  writeOrdinaryReconcileTransaction,
  type OrdinaryReconcileRequest,
  type OrdinaryReconcileTransaction,
} from './ordinary-reconcile-transaction.js';
import {
  changeArtifactPath,
  changeMetadataPath,
  changeRevisionsRoot,
} from './paths.js';
import { reconcileChangeWithinChangeLock } from './reconcile-internal.js';
import { reconciledTaskSnapshot } from './reconcile-internal.js';
import { readinessClosureForReconcileLevel } from './reconcile-semantics.js';
import { incrementBaseline, incrementRevision } from './revision-ids.js';
import type { ChangeRef } from './store.js';
import { loadTasks } from './tasks.js';
import { validateCanonicalTaskClosure } from './task-closure-internal.js';
import { assertTransactionLineageIntegrity } from './transaction-lineage-integrity.js';
import { assertSemanticMutationFence } from './semantic-mutation-journal.js';

const mutationChannel = channel('omnai:core:change-mutation');

export interface ReconcileInput {
  level: ReconcileLevel;
  type: string;
  reason: string;
  affectedTasks?: string[];
  affectedTaskClosure?: string[];
  affectedReadiness?: Array<keyof ChangeRef['metadata']['readiness']>;
  evidence?: string[];
  correlationId?: string;
}

export interface ReconcileResult {
  signal: ReconcileSignal;
  revision: Revision;
  affectedReadiness: Array<keyof ChangeRef['metadata']['readiness']>;
  affectedTasks: string[];
}

/** @internal Caller must hold the exact Change mutation lock. */
export async function reconcileOrdinaryWithinChangeLock(
  repoRoot: string,
  change: ChangeRef,
  input: ReconcileInput,
  owner: { semanticMutationId?: string; createdAt?: string } = {},
): Promise<ReconcileResult> {
  await assertTransactionLineageIntegrity(repoRoot, change);
  await assertSemanticMutationFence(repoRoot, change, owner.semanticMutationId);
  await assertFlowTransactionFence(repoRoot, change);
  await assertDecisionReconcileTransactionFence(repoRoot, change);
  const request = normalizeRequest(input);
  const pending = await loadPendingOrdinaryReconcileTransaction(repoRoot, change);
  if (pending) {
    assertExactRequest(pending, request);
    return continueOrdinaryReconcile(repoRoot, change, pending);
  }
  await assertOrdinaryReconcileTransactionFence(repoRoot, change);

  const callerBinding = {
    revision: change.metadata.activeRevision,
    baseline: change.metadata.baseline,
  };
  const sourceMetadata = await resolveSourceMetadata(repoRoot, change);
  change.metadata = structuredClone(sourceMetadata);
  const completed = await loadCompletedOrdinaryReconcileTransactionForActiveRevision(
    repoRoot,
    change,
    change.metadata.activeRevision,
  );
  if (completed) {
    await validateCompletedOrdinaryReconcile(repoRoot, change, completed);
    const requestMatches = JSON.stringify(completed.request) === JSON.stringify(request);
    const callerIsSource = (
      callerBinding.revision === completed.sourceMetadata.activeRevision
      && callerBinding.baseline === completed.sourceMetadata.baseline
    );
    const callerIsActive = (
      callerBinding.revision === completed.completedRevision
      && callerBinding.baseline === completed.completedBaseline
    );
    const sameExternalCorrelation = (
      request.externalCorrelationId !== null
      && request.externalCorrelationId === completed.request.externalCorrelationId
    );
    if (requestMatches && (sameExternalCorrelation || callerIsSource)) {
      return resultForCompletedTransaction(repoRoot, change, completed);
    }
    if (sameExternalCorrelation) throw new Error('ORDINARY_RECONCILE_CORRELATION_CONFLICT');
    if (callerIsSource) {
      throw new Error('ORDINARY_RECONCILE_TRANSACTION_REQUEST_MISMATCH');
    }
    if (!callerIsActive) throw new Error('RECONCILE_STALE_CHANGE_STATE');
    change.metadata = structuredClone(sourceMetadata);
  }

  const flow = await loadFlowPlan(repoRoot, change);
  const decisions = await listDecisions(repoRoot, change);
  const tasks = await loadTasks(changeArtifactPath(repoRoot, change.directoryName, 'tasks.yaml'));
  const affectedReadiness = request.affectedReadiness
    ?? readinessClosureForReconcileLevel(input.level);
  const taskSelection = validateCanonicalTaskClosure(
    tasks,
    request.affectedTasks,
    request.affectedTaskClosure,
  );
  const taskRoots = taskSelection.roots;
  const affectedTasks = taskSelection.closure;
  reconciledTaskSnapshot(
    tasks,
    affectedTasks,
    ['L2', 'L3', 'L4'].includes(request.level),
  );

  const correlationId = request.externalCorrelationId ?? `ORDINARY-${randomUUID()}`;
  await assertUnusedCorrelation(repoRoot, change, correlationId);
  await preflightFlowArchiveCompatibilityWithinChangeLock(repoRoot, change, flow);
  const transaction = createOrdinaryReconcileTransaction(
    change,
    request,
    {
      flow,
      decisions,
      tasks,
      affectedReadiness,
      taskRoots,
      affectedTasks,
    },
    correlationId,
    owner.createdAt ?? new Date().toISOString(),
  );
  assertOrdinaryTransactionInventory(transaction);
  await assertFlowTransactionFence(repoRoot, change);
  await assertDecisionReconcileTransactionFence(repoRoot, change);
  await assertOrdinaryReconcileTransactionFence(repoRoot, change);
  await writeOrdinaryReconcileTransaction(repoRoot, change, transaction);
  publishStage('ORDINARY_RECONCILE_INTENT_WRITTEN', change, transaction.correlationId);
  return continueOrdinaryReconcile(repoRoot, change, transaction);
}

async function continueOrdinaryReconcile(
  repoRoot: string,
  change: ChangeRef,
  transaction: OrdinaryReconcileTransaction,
): Promise<ReconcileResult> {
  assertOrdinaryTransactionInventory(transaction);
  const active = await readYaml(
    changeMetadataPath(repoRoot, change.directoryName),
    changeMetadataSchema,
  );
  const nextRevision = incrementRevision(transaction.sourceMetadata.activeRevision);
  const nextBaseline = incrementBaseline(transaction.sourceMetadata.baseline);
  if (
    active.activeRevision === transaction.sourceMetadata.activeRevision
    && active.baseline === transaction.sourceMetadata.baseline
  ) {
    if (transaction.status !== 'PENDING') {
      throw new Error('ORDINARY_RECONCILE_TRANSACTION_COMPLETION_MISMATCH');
    }
    change.metadata = structuredClone(transaction.sourceMetadata);
    const result = await reconcileChangeWithinChangeLock(
      repoRoot,
      change,
      transactionInput(transaction),
      {
        expectedFlow: transaction.flow,
        expectedDecisions: transaction.decisions,
        expectedReadiness: transaction.sourceMetadata.readiness,
        expectedTasks: transaction.tasks,
        ordinaryReconcileTransactionCorrelationId: transaction.correlationId,
        transactionCreatedAt: transaction.createdAt,
      },
    );
    await completeOrdinaryReconcileTransaction(
      repoRoot,
      change,
      transaction,
      result.revision.id,
      result.revision.baseline ?? nextBaseline,
    );
    return result;
  }
  if (active.activeRevision !== nextRevision || active.baseline !== nextBaseline) {
    throw new Error('ORDINARY_RECONCILE_TRANSACTION_STALE_REVISION');
  }
  change.metadata = active;
  if (transaction.status === 'COMPLETED') {
    await validateCompletedOrdinaryReconcile(repoRoot, change, transaction);
    return resultForCompletedTransaction(repoRoot, change, transaction);
  }
  return recoverPendingOrdinaryTarget(repoRoot, change, transaction, active);
}

async function resolveSourceMetadata(repoRoot: string, change: ChangeRef): Promise<ChangeMetadata> {
  const persisted = await readYaml(
    changeMetadataPath(repoRoot, change.directoryName),
    changeMetadataSchema,
  );
  if (persisted.id !== change.metadata.id) throw new Error('RECONCILE_STALE_CHANGE_STATE');
  if (
    persisted.activeRevision !== change.metadata.activeRevision
    || persisted.baseline !== change.metadata.baseline
  ) {
    const completed = await loadCompletedOrdinaryReconcileTransactionForActiveRevision(
      repoRoot,
      change,
      persisted.activeRevision,
    );
    const exactCompletedSource = completed !== null
      && completed.sourceMetadata.activeRevision === change.metadata.activeRevision
      && completed.sourceMetadata.baseline === change.metadata.baseline;
    if (!exactCompletedSource) throw new Error('RECONCILE_STALE_CHANGE_STATE');
  }
  const hasPendingProfileChange = (
    persisted.scenario !== change.metadata.scenario
    || persisted.workMode !== change.metadata.workMode
    || JSON.stringify(persisted.risk) !== JSON.stringify(change.metadata.risk)
    || JSON.stringify(persisted.impact) !== JSON.stringify(change.metadata.impact)
  );
  if (hasPendingProfileChange) {
    if (persisted.updatedAt !== change.metadata.updatedAt) throw new Error('RECONCILE_STALE_CHANGE_STATE');
    return changeMetadataSchema.parse(structuredClone(change.metadata));
  }
  return persisted;
}

function normalizeRequest(input: ReconcileInput): OrdinaryReconcileRequest {
  return ordinaryReconcileRequestSchema.parse({
    level: input.level,
    type: input.type,
    reason: input.reason,
    affectedTasks: [...(input.affectedTasks ?? [])],
    affectedTaskClosure: input.affectedTaskClosure ? [...input.affectedTaskClosure] : null,
    affectedReadiness: input.affectedReadiness ? normalizeReadiness(input.affectedReadiness) : null,
    evidence: [...(input.evidence ?? [])],
    externalCorrelationId: input.correlationId ?? null,
  });
}

function transactionInput(transaction: OrdinaryReconcileTransaction): ReconcileInput {
  return {
    level: transaction.request.level,
    type: transaction.request.type,
    reason: transaction.request.reason,
    affectedTasks: transaction.taskRoots,
    affectedTaskClosure: transaction.affectedTasks,
    affectedReadiness: transaction.affectedReadiness,
    evidence: transaction.request.evidence,
    correlationId: transaction.correlationId,
  };
}

function assertExactRequest(
  transaction: OrdinaryReconcileTransaction,
  request: OrdinaryReconcileRequest,
): void {
  if (JSON.stringify(transaction.request) !== JSON.stringify(request)) {
    throw new Error('ORDINARY_RECONCILE_TRANSACTION_REQUEST_MISMATCH');
  }
}

function assertOrdinaryTransactionInventory(transaction: OrdinaryReconcileTransaction): void {
  const expectedReadiness = transaction.request.affectedReadiness
    ?? readinessClosureForReconcileLevel(transaction.request.level);
  const selection = validateCanonicalTaskClosure(
    transaction.tasks,
    transaction.request.affectedTasks,
    transaction.request.affectedTaskClosure,
  );
  const expectedRoots = selection.roots;
  const expectedTasks = selection.closure;
  const decisionIds = transaction.decisions.map(({ id }) => id);
  const staleLiveDecision = transaction.decisions.find((decision) => (
    (decision.status === 'OPEN' || decision.status === 'BLOCKED')
    && decision.openedRevision !== transaction.sourceMetadata.activeRevision
  ));
  if (
    JSON.stringify(transaction.affectedReadiness) !== JSON.stringify(expectedReadiness)
    || JSON.stringify(transaction.taskRoots) !== JSON.stringify(expectedRoots)
    || JSON.stringify(transaction.affectedTasks) !== JSON.stringify(expectedTasks)
    || (transaction.request.externalCorrelationId !== null
      && transaction.correlationId !== transaction.request.externalCorrelationId)
    || (transaction.flow !== null
      && JSON.stringify(transaction.flow.decisionIds) !== JSON.stringify(decisionIds))
    || staleLiveDecision !== undefined
  ) throw new Error('ORDINARY_RECONCILE_TRANSACTION_STATE_CONFLICT');
}

function normalizeReadiness(
  values: readonly (keyof ChangeMetadata['readiness'])[],
): Array<keyof ChangeMetadata['readiness']> {
  const schema = readinessKeySchema;
  const result: Array<keyof ChangeMetadata['readiness']> = [];
  for (const value of values) {
    const parsed = schema.parse(value) as keyof ChangeMetadata['readiness'];
    if (!result.includes(parsed)) result.push(parsed);
  }
  return result;
}

function publishStage(stage: string, change: ChangeRef, correlationId: string): void {
  mutationChannel.publish({ stage, changeId: change.metadata.id, correlationId });
}

async function assertUnusedCorrelation(
  repoRoot: string,
  change: ChangeRef,
  correlationId: string,
): Promise<void> {
  const root = changeRevisionsRoot(repoRoot, change.directoryName);
  const files = await readdir(root);
  for (const file of files.sort()) {
    if (/^REV-\d{4}\.yaml$/.test(file)) {
      const revision = await readYaml(join(root, file), revisionSchema);
      if (revision.correlationId === correlationId) {
        throw new Error('ORDINARY_RECONCILE_CORRELATION_CONFLICT');
      }
    } else if (file.endsWith('.signal.yaml')) {
      const signal = await readYaml(join(root, file), reconcileSignalSchema);
      if (signal.correlationId === correlationId) {
        throw new Error('ORDINARY_RECONCILE_CORRELATION_CONFLICT');
      }
    }
  }
}
