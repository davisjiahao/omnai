import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  changeMetadataSchema,
  decisionRecordSchema,
  flowAssessmentProposalSchema,
  flowPlanSchema,
  reconcileSignalSchema,
  revisionSchema,
  type DecisionRecord,
  type FlowAssessmentProposal,
  type FlowPlan,
} from '../domain/types.js';
import { readJsonLines, readYaml, writeYaml } from './files.js';
import { compileFlowPlan, hashFlowPlan } from './flow.js';
import { assertTerminalFlowAuthority } from './flow-terminal-authority.js';
import { changedFlowAssessmentFields, flowAssessmentReconcileReason } from './reconcile-semantics.js';
import { changeArtifactPath, changeMetadataPath, changeRevisionsRoot } from './paths.js';
import { getScenario } from './scenarios.js';
import type { ChangeRef } from './store.js';

const HASH = /^sha256:[0-9a-f]{64}$/;

export const flowAssessmentTransactionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.enum(['PENDING', 'COMPLETED']),
  proposal: flowAssessmentProposalSchema,
  oldPlanHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  decisions: z.array(decisionRecordSchema),
  correlationId: z.string().min(1),
  createdAt: z.string().datetime(),
  acceptedRevision: z.string().regex(/^REV-\d{4}$/).nullable(),
  acceptedBaseline: z.string().regex(/^BL-\d{4}$/).nullable(),
  acceptedInputHash: z.string().regex(HASH).nullable(),
  acceptedPlanHash: z.string().regex(HASH).nullable(),
  acceptedPlan: flowPlanSchema.nullable(),
  completedRevision: z.string().regex(/^REV-\d{4}$/).nullable(),
  completedBaseline: z.string().regex(/^BL-\d{4}$/).nullable(),
  newPlanHash: z.string().regex(HASH).nullable(),
}).superRefine((transaction, context) => {
  const acceptance = [
    transaction.acceptedRevision,
    transaction.acceptedBaseline,
    transaction.acceptedInputHash,
    transaction.acceptedPlanHash,
    transaction.acceptedPlan,
  ];
  const completion = [transaction.completedRevision, transaction.completedBaseline, transaction.newPlanHash];
  if (acceptance.some((value) => value === null) && acceptance.some((value) => value !== null)) {
    context.addIssue({ code: 'custom', path: ['acceptedRevision'], message: 'accepted state must be recorded atomically' });
  }
  if (transaction.status === 'PENDING' && completion.some((value) => value !== null)) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'PENDING transaction cannot carry completion state' });
  }
  if (transaction.status === 'COMPLETED') {
    if (acceptance.some((value) => value === null) || completion.some((value) => value === null)) {
      context.addIssue({ code: 'custom', path: ['status'], message: 'COMPLETED transaction requires accepted and terminal state' });
    }
  }
});

export type FlowAssessmentTransaction = z.infer<typeof flowAssessmentTransactionSchema>;

export function createFlowAssessmentTransaction(
  proposal: FlowAssessmentProposal,
  oldPlan: FlowPlan,
  decisions: readonly DecisionRecord[],
  correlationId: string,
  createdAt: string,
): FlowAssessmentTransaction {
  return flowAssessmentTransactionSchema.parse({
    schemaVersion: 1,
    status: 'PENDING',
    proposal,
    oldPlanHash: hashFlowPlan(oldPlan),
    decisions,
    correlationId,
    createdAt,
    acceptedRevision: null,
    acceptedBaseline: null,
    acceptedInputHash: null,
    acceptedPlanHash: null,
    acceptedPlan: null,
    completedRevision: null,
    completedBaseline: null,
    newPlanHash: null,
  });
}

export async function loadFlowAssessmentTransaction(
  repoRoot: string,
  change: ChangeRef,
  revision: string,
): Promise<FlowAssessmentTransaction> {
  return readYaml(flowAssessmentTransactionPath(repoRoot, change, revision), flowAssessmentTransactionSchema);
}

export async function writeFlowAssessmentTransaction(
  repoRoot: string,
  change: ChangeRef,
  transaction: FlowAssessmentTransaction,
): Promise<void> {
  await writeYaml(
    flowAssessmentTransactionPath(repoRoot, change, transaction.proposal.revision),
    flowAssessmentTransactionSchema.parse(transaction),
  );
}

export async function recordAcceptedFlowAssessmentTransaction(
  repoRoot: string,
  change: ChangeRef,
  transaction: FlowAssessmentTransaction,
  flow: FlowPlan,
): Promise<FlowAssessmentTransaction> {
  if (transaction.status !== 'PENDING') throw new Error('FLOW_TRANSACTION_ALREADY_COMPLETED');
  const accepted = {
    revision: flow.revision,
    baseline: flow.baseline,
    inputHash: flow.inputHash,
    planHash: hashFlowPlan(flow),
  };
  if (transaction.acceptedRevision !== null) {
    if (
      transaction.acceptedRevision !== accepted.revision ||
      transaction.acceptedBaseline !== accepted.baseline ||
      transaction.acceptedInputHash !== accepted.inputHash ||
      transaction.acceptedPlanHash !== accepted.planHash ||
      JSON.stringify(transaction.acceptedPlan) !== JSON.stringify(flow)
    ) throw new Error('FLOW_TRANSACTION_ACCEPTED_MISMATCH');
    return transaction;
  }
  const recorded = flowAssessmentTransactionSchema.parse({
    ...transaction,
    acceptedRevision: accepted.revision,
    acceptedBaseline: accepted.baseline,
    acceptedInputHash: accepted.inputHash,
    acceptedPlanHash: accepted.planHash,
    acceptedPlan: flow,
  });
  await writeFlowAssessmentTransaction(repoRoot, change, recorded);
  return recorded;
}

export async function completeFlowAssessmentTransaction(
  repoRoot: string,
  change: ChangeRef,
  transaction: FlowAssessmentTransaction,
): Promise<void> {
  if (transaction.status !== 'PENDING') throw new Error('FLOW_TRANSACTION_ALREADY_COMPLETED');
  if (
    transaction.acceptedRevision === null ||
    transaction.acceptedBaseline === null ||
    transaction.acceptedInputHash === null ||
    transaction.acceptedPlanHash === null ||
    transaction.acceptedPlan === null
  ) throw new Error('FLOW_TRANSACTION_ACCEPTED_INCOMPLETE');
  await writeFlowAssessmentTransaction(repoRoot, change, flowAssessmentTransactionSchema.parse({
    ...transaction,
    status: 'COMPLETED',
    completedRevision: transaction.acceptedRevision,
    completedBaseline: transaction.acceptedBaseline,
    newPlanHash: transaction.acceptedPlanHash,
  }));
}

export async function assertFlowTransactionFence(
  repoRoot: string,
  change: ChangeRef,
  allowedCorrelationId?: string,
): Promise<void> {
  const pending = await listPendingFlowAssessmentTransactions(repoRoot, change);
  if (allowedCorrelationId !== undefined) {
    if (pending.length === 1 && pending[0]!.correlationId === allowedCorrelationId) return;
    throw new Error(`FLOW_TRANSACTION_PENDING: expected ${allowedCorrelationId}`);
  }
  if (pending.length > 0) throw new Error(`FLOW_TRANSACTION_PENDING: ${pending[0]!.correlationId}`);
}

/**
 * Decision records may continue to evolve after a Flow assessment has durably
 * committed its accepted state and both correlated audits. The PENDING marker
 * remains recoverable bookkeeping at that point; every earlier phase is an
 * exclusive Flow mutation fence.
 */
export async function assertFlowTransactionAllowsDecisionMutation(
  repoRoot: string,
  change: ChangeRef,
): Promise<void> {
  const pending = await loadPendingFlowAssessmentTransaction(repoRoot, change);
  if (!pending) return;
  if (!hasAcceptedBinding(pending)) {
    throw new Error(`FLOW_TRANSACTION_PENDING: ${pending.correlationId}`);
  }
  await assertAuditedTerminalRecovery(repoRoot, change, pending);
}

export async function loadPendingFlowAssessmentTransaction(
  repoRoot: string,
  change: ChangeRef,
): Promise<FlowAssessmentTransaction | null> {
  const pending = await listPendingFlowAssessmentTransactions(repoRoot, change);
  if (pending.length > 1) throw new Error('FLOW_TRANSACTION_PENDING: multiple pending assessments');
  return pending[0] ?? null;
}

export function flowAssessmentTransactionPath(repoRoot: string, change: ChangeRef, revision: string): string {
  return join(changeRevisionsRoot(repoRoot, change.directoryName), `${revision}.flow-transaction.yaml`);
}

async function listPendingFlowAssessmentTransactions(
  repoRoot: string,
  change: ChangeRef,
): Promise<FlowAssessmentTransaction[]> {
  const root = changeRevisionsRoot(repoRoot, change.directoryName);
  let files: string[];
  try {
    files = (await readdir(root)).filter((file) => /^REV-\d{4}\.flow-transaction\.yaml$/.test(file)).sort();
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const transactions = await Promise.all(files.map((file) => readYaml(join(root, file), flowAssessmentTransactionSchema)));
  return transactions.filter(({ status }) => status === 'PENDING');
}

function hasAcceptedBinding(
  transaction: FlowAssessmentTransaction,
): transaction is FlowAssessmentTransaction & {
  acceptedRevision: string;
  acceptedBaseline: string;
  acceptedInputHash: string;
  acceptedPlanHash: string;
  acceptedPlan: FlowPlan;
} {
  return transaction.acceptedRevision !== null
    && transaction.acceptedBaseline !== null
    && transaction.acceptedInputHash !== null
    && transaction.acceptedPlanHash !== null
    && transaction.acceptedPlan !== null;
}

async function assertAuditedTerminalRecovery(
  repoRoot: string,
  change: ChangeRef,
  transaction: FlowAssessmentTransaction & {
    acceptedRevision: string;
    acceptedBaseline: string;
    acceptedInputHash: string;
    acceptedPlanHash: string;
    acceptedPlan: FlowPlan;
  },
): Promise<void> {
  await assertTerminalFlowAuthority(repoRoot, change, transaction);
  const active = await readYaml(changeMetadataPath(repoRoot, change.directoryName), changeMetadataSchema);
  if (
    active.id !== transaction.proposal.changeId
    || active.activeRevision !== transaction.acceptedRevision
    || active.baseline !== transaction.acceptedBaseline
  ) throw new Error('FLOW_TRANSACTION_COMPLETION_MISMATCH');
  const acceptedCandidate = compileFlowPlan(
    active,
    getScenario(active.scenario),
    transaction.proposal.assessment,
    transaction.decisions,
    transaction.createdAt,
  );
  if (acceptedCandidate.inputHash !== transaction.acceptedInputHash) {
    throw new Error('FLOW_TRANSACTION_COMPLETION_MISMATCH');
  }

  const revisionsRoot = changeRevisionsRoot(repoRoot, change.directoryName);
  const oldPlan = await readYaml(
    join(revisionsRoot, `${transaction.proposal.revision}.flow.yaml`),
    flowPlanSchema,
  );
  if (
    oldPlan.changeId !== transaction.proposal.changeId
    || oldPlan.revision !== transaction.proposal.revision
    || oldPlan.baseline !== transaction.proposal.baseline
    || hashFlowPlan(oldPlan) !== transaction.oldPlanHash
  ) throw new Error('FLOW_TRANSACTION_COMPLETION_MISMATCH');

  const revision = await readYaml(
    join(revisionsRoot, `${transaction.acceptedRevision}.yaml`),
    revisionSchema,
  );
  const changedFields = changedFlowAssessmentFields(oldPlan.assessment, transaction.proposal.assessment);
  const reason = flowAssessmentReconcileReason(changedFields);
  if (
    revision.id !== transaction.acceptedRevision
    || revision.changeId !== transaction.proposal.changeId
    || revision.previousRevision !== transaction.proposal.revision
    || revision.previousBaseline !== transaction.proposal.baseline
    || revision.baseline !== transaction.acceptedBaseline
    || revision.correlationId !== transaction.correlationId
    || revision.reason !== reason
  ) throw new Error('FLOW_TRANSACTION_COMPLETION_MISMATCH');

  const signalFiles = (await readdir(revisionsRoot)).filter((file) => file.endsWith('.signal.yaml'));
  const signals = [];
  for (const file of signalFiles) {
    const signal = await readYaml(join(revisionsRoot, file), reconcileSignalSchema);
    if (signal.correlationId === transaction.correlationId) signals.push(signal);
  }
  const signal = signals[0];
  if (
    signals.length !== 1 || !signal
    || signal.changeId !== transaction.proposal.changeId
    || signal.revision !== transaction.proposal.revision
    || signal.type !== 'FLOW_ASSESSMENT_CHANGED'
    || signal.level !== revision.level
    || signal.reason !== revision.reason
    || signal.createdAt !== revision.createdAt
  ) throw new Error('FLOW_TRANSACTION_COMPLETION_MISMATCH');

  const events = await readJsonLines<FlowTerminalAuditEvent>(
    changeArtifactPath(repoRoot, change.directoryName, 'progress.jsonl'),
  );
  const correlated = events.filter(({ data }) => data?.correlationId === transaction.correlationId);
  const reconcileEvents = correlated.filter(({ event }) => event === 'RECONCILE_APPLIED');
  const flowEvents = correlated.filter(({ event }) => event === 'FLOW_REASSESSED');
  const reconcile = reconcileEvents[0];
  const flow = flowEvents[0];
  if (reconcileEvents.length !== 1 || flowEvents.length !== 1 || !reconcile || !flow) {
    throw new Error('FLOW_TRANSACTION_COMPLETION_MISMATCH');
  }
  if (
    reconcile.timestamp !== revision.createdAt
    || reconcile.changeId !== transaction.proposal.changeId
    || reconcile.revision !== transaction.acceptedRevision
    || reconcile.detail !== `${revision.level} FLOW_ASSESSMENT_CHANGED: ${reason}`
    || reconcile.data?.previousRevision !== transaction.proposal.revision
    || reconcile.data?.previousBaseline !== transaction.proposal.baseline
    || reconcile.data?.baseline !== transaction.acceptedBaseline
    || JSON.stringify(reconcile.data?.affectedReadiness) !== JSON.stringify(revision.affectedArtifacts)
    || JSON.stringify(reconcile.data?.affectedTasks) !== JSON.stringify(revision.affectedTasks)
    || flow.changeId !== transaction.proposal.changeId
    || flow.revision !== transaction.acceptedRevision
    || flow.detail !== `Accepted FlowPlan assessment changes: ${changedFields.join(', ')}`
    || flow.data?.previousRevision !== transaction.proposal.revision
    || flow.data?.previousBaseline !== transaction.proposal.baseline
    || flow.data?.baseline !== transaction.acceptedBaseline
    || flow.data?.oldPlanHash !== transaction.oldPlanHash
    || flow.data?.newPlanHash !== transaction.acceptedPlanHash
  ) throw new Error('FLOW_TRANSACTION_COMPLETION_MISMATCH');
}

interface FlowTerminalAuditEvent {
  timestamp?: string;
  event?: string;
  changeId?: string;
  revision?: string;
  detail?: string;
  data?: {
    correlationId?: string;
    previousRevision?: string;
    previousBaseline?: string;
    baseline?: string;
    affectedReadiness?: unknown;
    affectedTasks?: unknown;
    oldPlanHash?: string;
    newPlanHash?: string;
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
