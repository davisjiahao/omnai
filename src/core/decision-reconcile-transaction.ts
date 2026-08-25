import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  decisionRecordSchema,
  decisionResolutionInputSchema,
  readinessKeySchema,
  readinessSchema,
  taskFileSchema,
  type DecisionRecord,
  type DecisionResolutionInput,
  type FlowPlan,
  type ReconcileLevel,
  type TaskFile,
} from '../domain/types.js';
import { pathExists, readYaml, writeYaml } from './files.js';
import { hashFlowPlan } from './flow.js';
import { changeRevisionsRoot } from './paths.js';
import type { ChangeRef } from './store.js';
import { hashDecisionRecord } from './decision-transition.js';

const HASH = /^sha256:[0-9a-f]{64}$/;

export const decisionReconcileTransactionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.enum(['PENDING', 'COMPLETED']),
  changeId: z.string().regex(/^CHG-\d{4}$/),
  decision: decisionRecordSchema,
  resolution: decisionResolutionInputSchema,
  fromRevision: z.string().regex(/^REV-\d{4}$/),
  fromBaseline: z.string().regex(/^BL-\d{4}$/),
  oldFlowHash: z.string().regex(HASH).nullable(),
  decisions: z.array(decisionRecordSchema),
  readiness: readinessSchema,
  tasks: taskFileSchema,
  affectedReadiness: z.array(readinessKeySchema),
  taskRoots: z.array(z.string().regex(/^TASK-\d{3}$/)),
  affectedTasks: z.array(z.string().regex(/^TASK-\d{3}$/)),
  level: z.enum(['L0', 'L1', 'L2', 'L3', 'L4', 'L5']),
  correlationId: z.string().min(1),
  createdAt: z.string().datetime(),
  resolvedRevision: z.string().regex(/^REV-\d{4}$/).nullable(),
  resolvedBaseline: z.string().regex(/^BL-\d{4}$/).nullable(),
  resolvedDecisionHash: z.string().regex(HASH).nullable(),
}).superRefine((transaction, context) => {
  if (transaction.decision.changeId !== transaction.changeId) {
    context.addIssue({ code: 'custom', path: ['decision', 'changeId'], message: 'decision must belong to transaction Change' });
  }
  if (transaction.decision.openedRevision !== transaction.fromRevision) {
    context.addIssue({ code: 'custom', path: ['decision', 'openedRevision'], message: 'decision must be bound to fromRevision' });
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
  if (transaction.status === 'PENDING' && (
    transaction.resolvedRevision !== null
    || transaction.resolvedBaseline !== null
    || transaction.resolvedDecisionHash !== null
  )) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'PENDING transaction cannot carry terminal binding' });
  }
  if (transaction.status === 'COMPLETED' && (
    transaction.resolvedRevision === null
    || transaction.resolvedBaseline === null
    || transaction.resolvedDecisionHash === null
  )) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'COMPLETED transaction requires terminal binding' });
  }
});

export type DecisionReconcileTransaction = z.infer<typeof decisionReconcileTransactionSchema>;

export function createDecisionReconcileTransaction(
  change: ChangeRef,
  decision: DecisionRecord,
  resolution: DecisionResolutionInput,
  flow: FlowPlan | null,
  decisions: readonly DecisionRecord[],
  readiness: ChangeRef['metadata']['readiness'],
  tasks: TaskFile,
  affectedReadiness: readonly (keyof ChangeRef['metadata']['readiness'])[],
  taskRoots: readonly string[],
  affectedTasks: readonly string[],
  level: ReconcileLevel,
  correlationId: string,
  createdAt: string,
): DecisionReconcileTransaction {
  return decisionReconcileTransactionSchema.parse({
    schemaVersion: 1,
    status: 'PENDING',
    changeId: change.metadata.id,
    decision,
    resolution,
    fromRevision: change.metadata.activeRevision,
    fromBaseline: change.metadata.baseline,
    oldFlowHash: flow ? hashFlowPlan(flow) : null,
    decisions,
    readiness,
    tasks,
    affectedReadiness,
    taskRoots,
    affectedTasks,
    level,
    correlationId,
    createdAt,
    resolvedRevision: null,
    resolvedBaseline: null,
    resolvedDecisionHash: null,
  });
}

export async function loadDecisionReconcileTransaction(
  repoRoot: string,
  change: ChangeRef,
  decision: DecisionRecord,
): Promise<DecisionReconcileTransaction | null> {
  const path = decisionReconcileTransactionPath(repoRoot, change, decision.openedRevision, decision.id);
  if (!await pathExists(path)) return null;
  return readYaml(path, decisionReconcileTransactionSchema);
}

export async function writeDecisionReconcileTransaction(
  repoRoot: string,
  change: ChangeRef,
  transaction: DecisionReconcileTransaction,
): Promise<void> {
  await writeYaml(
    decisionReconcileTransactionPath(
      repoRoot,
      change,
      transaction.fromRevision,
      transaction.decision.id,
    ),
    decisionReconcileTransactionSchema.parse(transaction),
  );
}

export async function completeDecisionReconcileTransaction(
  repoRoot: string,
  change: ChangeRef,
  transaction: DecisionReconcileTransaction,
  revision: string,
  baseline: string,
): Promise<DecisionReconcileTransaction> {
  const completed = decisionReconcileTransactionSchema.parse({
    ...transaction,
    status: 'COMPLETED',
    resolvedRevision: revision,
    resolvedBaseline: baseline,
    resolvedDecisionHash: hashDecisionRecord(resolvedDecisionRecordForTransaction(transaction, revision)),
  });
  if (transaction.status === 'COMPLETED') {
    if (
      transaction.resolvedRevision !== revision ||
      transaction.resolvedBaseline !== baseline ||
      transaction.resolvedDecisionHash !== completed.resolvedDecisionHash
    ) throw new Error('DECISION_RECONCILE_TRANSACTION_COMPLETION_MISMATCH');
    return transaction;
  }
  await writeDecisionReconcileTransaction(repoRoot, change, completed);
  return completed;
}

export function resolvedDecisionRecordForTransaction(
  transaction: DecisionReconcileTransaction,
  revision: string,
): DecisionRecord {
  return decisionRecordSchema.parse({
    ...transaction.decision,
    status: 'RESOLVED',
    resolvedRevision: revision,
    resolution: transaction.resolution,
    updatedAt: transaction.createdAt,
  });
}

export async function assertDecisionReconcileTransactionFence(
  repoRoot: string,
  change: ChangeRef,
  allowedCorrelationId?: string,
): Promise<void> {
  const pending = await listPendingDecisionReconcileTransactions(repoRoot, change);
  if (allowedCorrelationId !== undefined) {
    if (pending.length === 1 && pending[0]!.correlationId === allowedCorrelationId) return;
    throw new Error(`DECISION_RECONCILE_TRANSACTION_PENDING: expected ${allowedCorrelationId}`);
  }
  if (pending.length > 0) {
    throw new Error(`DECISION_RECONCILE_TRANSACTION_PENDING: ${pending[0]!.correlationId}`);
  }
}

export function decisionReconcileTransactionPath(
  repoRoot: string,
  change: ChangeRef,
  revision: string,
  decisionId: string,
): string {
  return join(
    changeRevisionsRoot(repoRoot, change.directoryName),
    `${revision}.${decisionId}.decision-transaction.yaml`,
  );
}

async function listPendingDecisionReconcileTransactions(
  repoRoot: string,
  change: ChangeRef,
): Promise<DecisionReconcileTransaction[]> {
  const root = changeRevisionsRoot(repoRoot, change.directoryName);
  let files: string[];
  try {
    files = (await readdir(root))
      .filter((file) => /^REV-\d{4}\.DEC-\d{4}\.decision-transaction\.yaml$/.test(file))
      .sort();
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const transactions = await Promise.all(
    files.map((file) => readYaml(join(root, file), decisionReconcileTransactionSchema)),
  );
  return transactions.filter(({ status }) => status === 'PENDING');
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
