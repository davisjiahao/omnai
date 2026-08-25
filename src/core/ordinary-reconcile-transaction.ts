import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  baselineIdSchema,
  changeMetadataSchema,
  decisionRecordSchema,
  flowPlanSchema,
  readinessKeySchema,
  readinessSchema,
  revisionIdSchema,
  taskFileSchema,
} from '../domain/types.js';
import type { TaskFile } from '../domain/types.js';
import { readYaml, writeYaml } from './files.js';
import { changeRevisionsRoot } from './paths.js';
import { incrementBaseline, incrementRevision } from './revision-ids.js';
import type { ChangeRef } from './store.js';
import { ordinaryTerminalHashes } from './ordinary-terminal-target-internal.js';

const HASH = /^sha256:[0-9a-f]{64}$/;

const terminalHashesSchema = z.strictObject({
  metadata: z.string().regex(HASH),
  tasks: z.string().regex(HASH),
  flow: z.string().regex(HASH).nullable(),
  decisions: z.array(z.strictObject({
    id: z.string().regex(/^DEC-\d{4}$/),
    hash: z.string().regex(HASH),
  })),
});

export const ordinaryReconcileRequestSchema = z.strictObject({
  level: z.enum(['L0', 'L1', 'L2', 'L3', 'L4', 'L5']),
  type: z.string().min(1),
  reason: z.string().min(1),
  affectedTasks: z.array(z.string()),
  affectedTaskClosure: z.array(z.string()).nullable(),
  affectedReadiness: z.array(readinessKeySchema).nullable(),
  evidence: z.array(z.string()),
  externalCorrelationId: z.string().min(1).nullable(),
});

export const ordinaryReconcileTransactionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.enum(['PENDING', 'COMPLETED']),
  changeId: z.string().regex(/^CHG-\d{4}$/),
  request: ordinaryReconcileRequestSchema,
  sourceMetadata: changeMetadataSchema,
  flow: flowPlanSchema.nullable(),
  decisions: z.array(decisionRecordSchema),
  tasks: taskFileSchema,
  affectedReadiness: z.array(readinessKeySchema),
  taskRoots: z.array(z.string()),
  affectedTasks: z.array(z.string()),
  correlationId: z.string().min(1),
  createdAt: z.string().datetime(),
  completedRevision: z.string().regex(/^REV-\d{4}$/).nullable(),
  completedBaseline: z.string().regex(/^BL-\d{4}$/).nullable(),
  terminalHashes: terminalHashesSchema.nullable(),
}).superRefine((transaction, context) => {
  if (transaction.changeId !== transaction.sourceMetadata.id) {
    context.addIssue({ code: 'custom', path: ['changeId'], message: 'transaction Change must match source metadata' });
  }
  if (new Set(transaction.affectedReadiness).size !== transaction.affectedReadiness.length) {
    context.addIssue({ code: 'custom', path: ['affectedReadiness'], message: 'readiness closure must be unique' });
  }
  if (new Set(transaction.taskRoots).size !== transaction.taskRoots.length) {
    context.addIssue({ code: 'custom', path: ['taskRoots'], message: 'task roots must be unique' });
  }
  if (new Set(transaction.affectedTasks).size !== transaction.affectedTasks.length) {
    context.addIssue({ code: 'custom', path: ['affectedTasks'], message: 'task closure must be unique' });
  }
  if (transaction.taskRoots.some((taskId) => !transaction.affectedTasks.includes(taskId))) {
    context.addIssue({ code: 'custom', path: ['affectedTasks'], message: 'task closure must include every root' });
  }
  if (transaction.flow && (
    transaction.flow.changeId !== transaction.changeId
    || transaction.flow.revision !== transaction.sourceMetadata.activeRevision
    || transaction.flow.baseline !== transaction.sourceMetadata.baseline
  )) {
    context.addIssue({ code: 'custom', path: ['flow'], message: 'FlowPlan must bind the frozen source metadata' });
  }
  const decisionIds = transaction.decisions.map(({ id }) => id);
  if (
    new Set(decisionIds).size !== decisionIds.length
    || decisionIds.some((id, index) => index > 0 && id.localeCompare(decisionIds[index - 1]!) <= 0)
  ) {
    context.addIssue({ code: 'custom', path: ['decisions'], message: 'Decision inventory must be unique and ordered' });
  }
  if (transaction.decisions.some(({ changeId }) => changeId !== transaction.changeId)) {
    context.addIssue({ code: 'custom', path: ['decisions'], message: 'Decisions must belong to the transaction Change' });
  }
  if (transaction.status === 'PENDING' && (
    transaction.completedRevision !== null
    || transaction.completedBaseline !== null
    || transaction.terminalHashes !== null
  )) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'PENDING transaction cannot carry terminal binding' });
  }
  if (transaction.status === 'COMPLETED' && (
    transaction.completedRevision === null
    || transaction.completedBaseline === null
    || transaction.terminalHashes === null
  )) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'COMPLETED transaction requires terminal binding' });
  }
  if (transaction.status === 'COMPLETED' && (
    transaction.completedRevision !== incrementRevision(transaction.sourceMetadata.activeRevision)
    || transaction.completedBaseline !== incrementBaseline(transaction.sourceMetadata.baseline)
  )) {
    context.addIssue({
      code: 'custom',
      path: ['completedRevision'],
      message: 'ORDINARY_RECONCILE_TRANSACTION_COMPLETION_MISMATCH',
    });
  }
});

export type OrdinaryReconcileRequest = z.infer<typeof ordinaryReconcileRequestSchema>;
export type OrdinaryReconcileTransaction = z.infer<typeof ordinaryReconcileTransactionSchema>;

export function createOrdinaryReconcileTransaction(
  change: ChangeRef,
  request: OrdinaryReconcileRequest,
  snapshot: Omit<Pick<
    OrdinaryReconcileTransaction,
    'flow' | 'decisions' | 'tasks' | 'affectedReadiness' | 'taskRoots' | 'affectedTasks'
  >, 'tasks'> & { readonly tasks: TaskFile },
  correlationId: string,
  createdAt: string,
): OrdinaryReconcileTransaction {
  return ordinaryReconcileTransactionSchema.parse({
    schemaVersion: 1,
    status: 'PENDING',
    changeId: change.metadata.id,
    request: structuredClone(request),
    sourceMetadata: structuredClone(change.metadata),
    flow: snapshot.flow === null ? null : structuredClone(snapshot.flow),
    decisions: structuredClone(snapshot.decisions),
    tasks: structuredClone(snapshot.tasks),
    affectedReadiness: [...snapshot.affectedReadiness],
    taskRoots: [...snapshot.taskRoots],
    affectedTasks: [...snapshot.affectedTasks],
    correlationId,
    createdAt,
    completedRevision: null,
    completedBaseline: null,
    terminalHashes: null,
  });
}

export async function writeOrdinaryReconcileTransaction(
  repoRoot: string,
  change: ChangeRef,
  transaction: OrdinaryReconcileTransaction,
): Promise<void> {
  await writeYaml(
    ordinaryReconcileTransactionPath(
      repoRoot,
      change,
      transaction.sourceMetadata.activeRevision,
    ),
    ordinaryReconcileTransactionSchema.parse(transaction),
  );
}

export async function completeOrdinaryReconcileTransaction(
  repoRoot: string,
  change: ChangeRef,
  transaction: OrdinaryReconcileTransaction,
  revision: string,
  baseline: string,
): Promise<OrdinaryReconcileTransaction> {
  const parsedRevision = revisionIdSchema.parse(revision);
  const parsedBaseline = baselineIdSchema.parse(baseline);
  if (transaction.status === 'COMPLETED') {
    if (
      transaction.completedRevision !== parsedRevision
      || transaction.completedBaseline !== parsedBaseline
      || JSON.stringify(transaction.terminalHashes) !== JSON.stringify(
        ordinaryTerminalHashes(transaction, parsedRevision, parsedBaseline),
      )
    ) {
      throw new Error('ORDINARY_RECONCILE_TRANSACTION_COMPLETION_MISMATCH');
    }
    return transaction;
  }
  const completed = ordinaryReconcileTransactionSchema.parse({
    ...transaction,
    status: 'COMPLETED',
    completedRevision: parsedRevision,
    completedBaseline: parsedBaseline,
    terminalHashes: ordinaryTerminalHashes(transaction, parsedRevision, parsedBaseline),
  });
  await writeOrdinaryReconcileTransaction(repoRoot, change, completed);
  return completed;
}

export async function loadPendingOrdinaryReconcileTransaction(
  repoRoot: string,
  change: ChangeRef,
): Promise<OrdinaryReconcileTransaction | null> {
  const transactions = await listOrdinaryReconcileTransactions(repoRoot, change);
  const pending = transactions.filter(({ status }) => status === 'PENDING');
  if (pending.length > 1) throw new Error('ORDINARY_RECONCILE_TRANSACTION_PENDING: multiple pending transactions');
  return pending[0] ?? null;
}

export async function loadCompletedOrdinaryReconcileTransactionForActiveRevision(
  repoRoot: string,
  change: ChangeRef,
  activeRevision: string,
): Promise<OrdinaryReconcileTransaction | null> {
  const matching = (await listOrdinaryReconcileTransactions(repoRoot, change)).filter((transaction) => (
    transaction.status === 'COMPLETED' && transaction.completedRevision === activeRevision
  ));
  if (matching.length > 1) throw new Error('ORDINARY_RECONCILE_TRANSACTION_COMPLETION_MISMATCH');
  return matching[0] ?? null;
}

/** @internal Loads the exact source-bound ordinary transaction for an owning continuation. */
export async function loadOrdinaryReconcileTransactionForSourceRevision(
  repoRoot: string,
  change: ChangeRef,
  sourceRevision: string,
): Promise<OrdinaryReconcileTransaction | null> {
  const matching = (await listOrdinaryReconcileTransactions(repoRoot, change)).filter((transaction) => (
    transaction.sourceMetadata.activeRevision === sourceRevision
  ));
  if (matching.length > 1) throw new Error('ORDINARY_RECONCILE_TRANSACTION_COMPLETION_MISMATCH');
  return matching[0] ?? null;
}

export async function assertOrdinaryReconcileTransactionFence(
  repoRoot: string,
  change: ChangeRef,
  allowedCorrelationId?: string,
): Promise<void> {
  const pending = await loadPendingOrdinaryReconcileTransaction(repoRoot, change);
  if (allowedCorrelationId !== undefined) {
    if (pending?.correlationId === allowedCorrelationId) return;
    throw new Error(`ORDINARY_RECONCILE_TRANSACTION_PENDING: expected ${allowedCorrelationId}`);
  }
  if (pending) throw new Error(`ORDINARY_RECONCILE_TRANSACTION_PENDING: ${pending.correlationId}`);
}

export function ordinaryReconcileTransactionPath(
  repoRoot: string,
  change: ChangeRef,
  revision: string,
): string {
  return join(changeRevisionsRoot(repoRoot, change.directoryName), `${revision}.reconcile-transaction.yaml`);
}

async function listOrdinaryReconcileTransactions(
  repoRoot: string,
  change: ChangeRef,
): Promise<OrdinaryReconcileTransaction[]> {
  const root = changeRevisionsRoot(repoRoot, change.directoryName);
  let files: string[];
  try {
    files = (await readdir(root))
      .filter((file) => /^REV-\d{4}\.reconcile-transaction\.yaml$/.test(file))
      .sort();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  const transactions = [];
  for (const file of files) {
    const transaction = await readYaml(join(root, file), ordinaryReconcileTransactionSchema);
    if (`${transaction.sourceMetadata.activeRevision}.reconcile-transaction.yaml` !== file) {
      throw new Error('ORDINARY_RECONCILE_TRANSACTION_FILENAME_MISMATCH');
    }
    transactions.push(transaction);
  }
  return transactions;
}
