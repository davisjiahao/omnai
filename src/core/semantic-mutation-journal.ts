import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  changeMetadataSchema,
  decisionRecordSchema,
  decisionResolutionInputSchema,
  flowAssessmentProposalSchema,
  flowPlanSchema,
  openDecisionInputSchema,
  nonemptySourceRefCollectionSchema,
  taskFileSchema,
  type ChangeMetadata,
  type DecisionRecord,
  type FlowPlan,
  type ProgressEvent,
  type TaskFile,
} from '../domain/types.js';
import { appendJsonLine, pathExists, readJsonLines, readYaml, writeYaml } from './files.js';
import { changeArtifactPath, changeRevisionsRoot } from './paths.js';
import type { ChangeRef } from './store.js';
import {
  assertCompletedSemanticMutationInventory,
  buildSemanticMutationLineageView,
} from './authority/indexes.js';

const common = {
  schemaVersion: z.literal(1),
  status: z.enum(['PENDING', 'COMPLETED']),
  id: z.string().regex(/^MUT-\d{6}$/),
  sequence: z.number().int().positive(),
  changeId: z.string().regex(/^CHG-\d{4}$/),
  revision: z.string().regex(/^REV-\d{4}$/),
  baseline: z.string().regex(/^BL-\d{4}$/),
  createdAt: z.string().datetime(),
};

const auditSchema = z.strictObject({
  timestamp: z.string().datetime(),
  event: z.string().min(1),
  changeId: z.string().regex(/^CHG-\d{4}$/),
  revision: z.string().regex(/^REV-\d{4}$/),
  detail: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
});

const decisionRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('DECISION_OPEN'), input: openDecisionInputSchema }),
  z.strictObject({
    operation: z.literal('DECISION_RESOLVE'),
    decisionId: z.string().regex(/^DEC-\d{4}$/),
    input: decisionResolutionInputSchema,
  }),
  z.strictObject({
    operation: z.literal('DECISION_SUPERSEDE'),
    decisionId: z.string().regex(/^DEC-\d{4}$/),
    replacementId: z.string().regex(/^DEC-\d{4}$/),
    reason: z.string().min(1),
    sourceRefs: nonemptySourceRefCollectionSchema,
  }),
]);

const flowRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('FLOW_INITIALIZE') }),
  z.strictObject({ operation: z.literal('FLOW_SYNCHRONIZE'), decisions: z.array(decisionRecordSchema) }),
  z.strictObject({ operation: z.literal('FLOW_REBIND'), decisions: z.array(decisionRecordSchema) }),
  z.strictObject({ operation: z.literal('FLOW_SOURCE_REBOUND'), proposal: flowAssessmentProposalSchema }),
]);

const scenarioArtifactSchema = z.strictObject({
  path: z.enum(['contract.md', 'issue.md', 'issue.yaml', 'fix.md', 'delivery.md', 'experiments']),
  kind: z.enum(['FILE', 'DIRECTORY']),
  content: z.string().nullable(),
}).superRefine((artifact, context) => {
  if (
    (artifact.kind === 'FILE' && artifact.content === null)
    || (artifact.kind === 'DIRECTORY' && artifact.content !== null)
    || (artifact.path === 'experiments') !== (artifact.kind === 'DIRECTORY')
  ) context.addIssue({ code: 'custom', path: ['content'], message: 'scenario artifact target mismatch' });
});

const decisionTransactionSchema = z.strictObject({
  ...common,
  kind: z.literal('DECISION'),
  request: decisionRequestSchema,
  sourceMetadata: changeMetadataSchema,
  targetMetadata: changeMetadataSchema,
  sourceDecisions: z.array(decisionRecordSchema),
  targetDecisions: z.array(decisionRecordSchema),
  sourceFlow: flowPlanSchema.nullable(),
  targetFlow: flowPlanSchema.nullable(),
  selectedDecisionId: z.string().regex(/^DEC-\d{4}$/),
  audits: z.array(auditSchema),
});

const flowTransactionSchema = z.strictObject({
  ...common,
  kind: z.literal('FLOW'),
  request: flowRequestSchema,
  sourceMetadata: changeMetadataSchema,
  targetMetadata: changeMetadataSchema,
  decisions: z.array(decisionRecordSchema),
  sourceFlow: flowPlanSchema.nullable(),
  targetFlow: flowPlanSchema.nullable(),
  audits: z.array(auditSchema),
});

const scenarioTransactionSchema = z.strictObject({
  ...common,
  kind: z.literal('SCENARIO_RECLASSIFY'),
  request: z.strictObject({ scenarioId: z.string().min(1), reason: z.string().min(1) }),
  sourceMetadata: changeMetadataSchema,
  proposedMetadata: changeMetadataSchema,
  tasks: taskFileSchema,
  artifacts: z.array(scenarioArtifactSchema),
  ordinaryCorrelationId: z.string().min(1),
  completedRevision: z.string().regex(/^REV-\d{4}$/),
  completedBaseline: z.string().regex(/^BL-\d{4}$/),
  audit: auditSchema,
});

export const semanticMutationTransactionSchema = z.discriminatedUnion('kind', [
  decisionTransactionSchema,
  flowTransactionSchema,
  scenarioTransactionSchema,
]).superRefine((transaction, context) => {
  if (
    transaction.changeId !== transaction.sourceMetadata.id
    || transaction.revision !== transaction.sourceMetadata.activeRevision
    || transaction.baseline !== transaction.sourceMetadata.baseline
    || transaction.id !== `MUT-${String(transaction.sequence).padStart(6, '0')}`
  ) {
    context.addIssue({ code: 'custom', path: ['id'], message: 'semantic mutation binding mismatch' });
  }
  if (transaction.kind === 'SCENARIO_RECLASSIFY') {
    const paths = transaction.artifacts.map(({ path }) => path);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({ code: 'custom', path: ['artifacts'], message: 'scenario artifact targets must be unique' });
    }
  }
});

export type SemanticMutationTransaction = z.infer<typeof semanticMutationTransactionSchema>;
export type DecisionSemanticMutation = z.infer<typeof decisionTransactionSchema>;
export type FlowSemanticMutation = z.infer<typeof flowTransactionSchema>;
export type ScenarioSemanticMutation = z.infer<typeof scenarioTransactionSchema>;
export type SemanticMutationAudit = z.infer<typeof auditSchema>;

export async function nextSemanticMutationIdentity(
  repoRoot: string,
  change: ChangeRef,
): Promise<{ id: string; sequence: number }> {
  const transactions = await listSemanticMutationTransactions(repoRoot, change);
  const sequence = transactions.reduce((maximum, transaction) => (
    Math.max(maximum, transaction.sequence)
  ), 0) + 1;
  return { id: `MUT-${String(sequence).padStart(6, '0')}`, sequence };
}

export async function writeSemanticMutationTransaction(
  repoRoot: string,
  change: ChangeRef,
  transaction: SemanticMutationTransaction,
): Promise<void> {
  const parsed = semanticMutationTransactionSchema.parse(transaction);
  await writeYaml(semanticMutationPath(repoRoot, change, parsed), parsed);
}

export async function completeSemanticMutationTransaction(
  repoRoot: string,
  change: ChangeRef,
  transaction: SemanticMutationTransaction,
): Promise<SemanticMutationTransaction> {
  const completed = semanticMutationTransactionSchema.parse({ ...transaction, status: 'COMPLETED' });
  await writeSemanticMutationTransaction(repoRoot, change, completed);
  return completed;
}

export async function loadPendingSemanticMutation(
  repoRoot: string,
  change: ChangeRef,
): Promise<SemanticMutationTransaction | null> {
  const pending = (await listSemanticMutationTransactions(repoRoot, change))
    .filter(({ status }) => status === 'PENDING');
  if (pending.length > 1) throw new Error('SEMANTIC_MUTATION_PENDING: multiple owners');
  return pending[0] ?? null;
}

export async function assertSemanticMutationFence(
  repoRoot: string,
  change: ChangeRef,
  allowedId?: string,
): Promise<void> {
  const pending = await loadPendingSemanticMutation(repoRoot, change);
  if (!pending) {
    if (allowedId !== undefined) throw new Error(`SEMANTIC_MUTATION_PENDING: expected ${allowedId}`);
    return;
  }
  if (allowedId === pending.id) return;
  throw new Error(`SEMANTIC_MUTATION_PENDING: ${pending.id}`);
}

/** @internal Read-only fast fence used before lock recovery for a non-owning request. */
export async function assertSemanticMutationRequestPreflight(
  repoRoot: string,
  change: ChangeRef,
  kind: SemanticMutationTransaction['kind'],
  request: unknown,
): Promise<void> {
  const pending = await loadPendingSemanticMutation(repoRoot, change);
  if (!pending) return;
  if (pending.kind !== kind || JSON.stringify(pending.request) !== JSON.stringify(request)) {
    throw new Error(`SEMANTIC_MUTATION_PENDING_REQUEST_MISMATCH: ${pending.id}`);
  }
}

export async function assertCompletedSemanticMutationLineage(
  _repoRoot: string,
  _change: ChangeRef,
  inventory: {
    transactions: readonly SemanticMutationTransaction[];
    events: readonly ProgressEvent[];
    eventsByMutationId: ReadonlyMap<string, readonly ProgressEvent[]>;
  },
): Promise<void> {
  // 背景：旧 optional inventory 会在漏传时静默重扫 journals/progress。目的：completed
  // consumer 只能委托给纯索引闭包；correlation 必须从同一次 events capture 内部派生，
  // caller 提供的 eventsByMutationId 只保留兼容签名，不进入真实性判断。
  assertCompletedSemanticMutationInventory(buildSemanticMutationLineageView({
    transactions: inventory.transactions,
    events: inventory.events,
  }));
}

/** @internal Idempotently ensures the exact event-specific outbox records. */
export async function ensureSemanticMutationAudits(
  repoRoot: string,
  change: ChangeRef,
  mutationId: string,
  audits: readonly SemanticMutationAudit[],
): Promise<void> {
  const path = changeArtifactPath(repoRoot, change.directoryName, 'progress.jsonl');
  for (const audit of audits) {
    const events = await readJsonLines<ProgressEvent>(path);
    const matching = events.filter((event) => (
      event.data !== null
      && 'semanticMutationId' in event.data
      && event.data.semanticMutationId === mutationId
      && event.event === audit.event
    ));
    if (matching.length > 1) throw new Error('SEMANTIC_MUTATION_AUDIT_CONFLICT');
    if (matching.length === 1) {
      if (JSON.stringify(matching[0]) !== JSON.stringify(audit)) {
        throw new Error('SEMANTIC_MUTATION_AUDIT_CONFLICT');
      }
      continue;
    }
    await appendJsonLine(path, audit);
  }
}

export async function loadCompletedSemanticMutationForSource(
  repoRoot: string,
  change: ChangeRef,
  request: unknown,
  revision: string,
  baseline: string,
): Promise<SemanticMutationTransaction | null> {
  const matches = (await listSemanticMutationTransactions(repoRoot, change)).filter((transaction) => (
    transaction.status === 'COMPLETED'
    && transaction.revision === revision
    && transaction.baseline === baseline
    && JSON.stringify(transaction.request) === JSON.stringify(request)
  ));
  if (matches.length > 1) fail('SEMANTIC_MUTATION_COMPLETION_CARDINALITY');
  return matches[0] ?? null;
}

export function semanticMutationPath(
  repoRoot: string,
  change: ChangeRef,
  transaction: Pick<SemanticMutationTransaction, 'revision' | 'id'>,
): string {
  return join(
    changeRevisionsRoot(repoRoot, change.directoryName),
    `${transaction.revision}.${transaction.id}.semantic-mutation.yaml`,
  );
}

async function listSemanticMutationTransactions(
  repoRoot: string,
  change: ChangeRef,
): Promise<SemanticMutationTransaction[]> {
  const root = changeRevisionsRoot(repoRoot, change.directoryName);
  if (!await pathExists(root)) return [];
  const files = (await readdir(root)).filter((file) => file.endsWith('.semantic-mutation.yaml')).sort();
  const transactions: SemanticMutationTransaction[] = [];
  for (const file of files) {
    if (!/^REV-\d{4}\.MUT-\d{6}\.semantic-mutation\.yaml$/.test(file)) {
      fail('SEMANTIC_MUTATION_FILENAME_MISMATCH');
    }
    const transaction = await readYaml(join(root, file), semanticMutationTransactionSchema);
    if (file !== `${transaction.revision}.${transaction.id}.semantic-mutation.yaml`) {
      fail('SEMANTIC_MUTATION_FILENAME_MISMATCH');
    }
    if (transaction.changeId !== change.metadata.id) fail('SEMANTIC_MUTATION_CHANGE_MISMATCH');
    transactions.push(transaction);
  }
  const ids = new Set<string>();
  for (const transaction of transactions) {
    if (ids.has(transaction.id)) fail('SEMANTIC_MUTATION_ID_DUPLICATE');
    ids.add(transaction.id);
  }
  return transactions;
}

function fail(detail: string): never {
  throw new Error(`SEMANTIC_MUTATION_LINEAGE: ${detail}`);
}

export type SemanticMutationTargetSnapshot = {
  metadata: ChangeMetadata;
  decisions?: readonly DecisionRecord[];
  flow?: FlowPlan | null;
  tasks?: TaskFile;
};
