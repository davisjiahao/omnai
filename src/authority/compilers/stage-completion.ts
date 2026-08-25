import { z } from 'zod';
import YAML from 'yaml';
import {
  canonicalStrictJson,
  hashStrictObject,
  stageAuthorityCatalogV1Schema,
  type StageAuthorityCatalogV1,
} from '../catalog-schema.js';
import {
  changeMetadataSchema,
  evidenceRecordSchema,
  evidenceSubjectBindingSchema,
  progressEventSchema,
  releaseArtifactIdentitySchema,
  repositoryWorkBasisSchema,
  taskFileSchema,
} from '../../domain/change.js';
import {
  archiveGateSnapshotSchema,
  repositoryWorkResultSchema,
  reviewDraftV2Schema,
  stageRunManifestSchema,
  stageTerminalResultSchema,
  type RunAuthorityContract,
  type StageTerminalResultV1,
} from '../../domain/run.js';
export { reviewDraftV2Schema } from '../../domain/run.js';
import {
  changeArtifactPathSchema,
  frozenByteBlobSchema,
  nonemptySingleLineSchema,
  nonnegativeSafeIntegerSchema,
  persistedChangeIdSchema,
  persistedDecisionIdSchema,
  persistedEvidenceIdSchema,
  persistedRevisionIdSchema,
  persistedRunIdSchema,
  persistedSha256Schema,
  persistedTaskIdSchema,
  persistedTimestampSchema,
  positiveSafeIntegerSchema,
} from '../../domain/public.js';
import {
  assertNever,
  cloneStrictJson,
  parseCompilerInput,
  requireCodeUnitOrder,
  requireLinearMembershipWorkBudget,
  validateAndIndexVerifyTaskRequirementClosure,
} from '../compiler-runtime.js';
import type { Sha256 } from '../../domain/scalars.js';
import { decodeStrictJson } from '../../domain/strict-json-decoder.js';

const issueStateSchema = z.strictObject({
  triageState: z.enum(['needs-info', 'ready-for-debug', 'ready-for-fix', 'needs-experiment', 'ready-for-human', 'wontfix']),
  reproduction: z.enum(['unknown', 'confirmed', 'not-reproducible', 'instrumentation-required']),
  rootCause: z.enum(['unknown', 'suspected', 'confirmed']),
  fixStrategy: z.enum(['unknown', 'ready', 'needs-experiment']),
});
const issuePredicateInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('TRIAGE_STATE_IN'), values: z.array(z.string()) }),
  z.strictObject({ kind: z.literal('REPRODUCTION_IN'), values: z.array(z.string()) }),
  z.strictObject({ kind: z.literal('ROOT_CAUSE_IS'), value: z.string() }),
  z.strictObject({ kind: z.literal('FIX_STRATEGY_IN'), values: z.array(z.string()) }),
]);

const projectWorkflowResourceMemberSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('COMPILER_RUNTIME'),
    runtimeId: z.literal('compiler-runtime-v1'),
    relativePath: z.literal('resources/authority/compilers/compiler-runtime-v1.mjs'),
    rawBytesHash: persistedSha256Schema,
  }),
  z.strictObject({
    kind: z.literal('COMPILER_FUNCTION'),
    compilerId: z.enum([
      'stage-terminal-v1', 'stage-completion-v1', 'run-descendants-v1', 'review-policy-v1',
      'qa-policy-by-scenario-v1', 'canary-policy-by-scenario-v1',
      'verify-scenario-task-evidence-v1', 'delivery-policy-v1', 'scenario-detection-v1',
      'prompt-render-v1',
    ]),
    relativePath: z.string().regex(/^resources\/authority\/compilers\/[a-z0-9-]+-v1\.fn\.js$/u),
    rawBytesHash: persistedSha256Schema,
  }),
  z.strictObject({
    kind: z.literal('PROTOCOL'),
    protocolId: nonemptySingleLineSchema,
    relativePath: z.string().regex(/^resources\/protocols\/.+\.md$/u),
    rawBytesHash: persistedSha256Schema,
  }),
  z.strictObject({
    kind: z.literal('SCAFFOLD'),
    templateId: nonemptySingleLineSchema,
    relativePath: z.string().regex(/^resources\/scaffolds\/.+$/u),
    rawBytesHash: persistedSha256Schema,
  }),
]);

const projectWorkflowBindingSchema = z.strictObject({
  schemaVersion: z.literal(1),
  workflowLockPath: z.literal('.omnai/workflow.lock.yaml'),
  workflowLockRawBytesHash: persistedSha256Schema,
  workflowVersion: z.literal('0.3.0'),
  authorityCatalogResourcePath: z.literal('resources/authority/stage-authority-catalog.v1.yaml'),
  authorityCatalogRawBytesHash: persistedSha256Schema,
  authorityCatalogHash: persistedSha256Schema,
  resourceMembers: z.array(projectWorkflowResourceMemberSchema),
  resourceBundleHash: persistedSha256Schema,
  bindingHash: persistedSha256Schema,
}).superRefine((binding, context) => {
  requireCodeUnitOrder(binding.resourceMembers.map(resourceMemberKey), 'workflow resource members');
  const { bindingHash: _bindingHash, ...unhashed } = binding;
  if (binding.bindingHash !== hashStrictObject(unhashed)) {
    context.addIssue({ code: 'custom', path: ['bindingHash'], message: 'STATIC_INPUT_INVALID: workflow binding hash mismatch' });
  }
});

const progressSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  path: z.literal('progress.jsonl'),
  bytes: frozenByteBlobSchema,
  events: z.array(progressEventSchema),
  auditCursor: z.strictObject({ eventCount: nonnegativeSafeIntegerSchema, prefixHash: persistedSha256Schema }),
}).superRefine((progress, context) => {
  if (progress.auditCursor.eventCount !== progress.events.length) {
    context.addIssue({ code: 'custom', path: ['auditCursor', 'eventCount'], message: 'STATIC_INPUT_INVALID: progress event count mismatch' });
  }
});

const descendantBindingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('RUN_ONLY') }),
  z.strictObject({ kind: z.literal('TASK_ID'), taskId: persistedTaskIdSchema }),
  z.strictObject({
    kind: z.literal('EVIDENCE_REQUIREMENT'),
    requirementId: nonemptySingleLineSchema,
    taskId: persistedTaskIdSchema.nullable(),
  }),
  z.strictObject({ kind: z.literal('HUMAN_GATE'), gateId: nonemptySingleLineSchema }),
]);
const descendantBaseShape = {
  ordinal: positiveSafeIntegerSchema,
  predecessorEntryHash: persistedSha256Schema,
  entryHash: persistedSha256Schema,
} satisfies z.ZodRawShape;
const taskWorkActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('START'), taskId: persistedTaskIdSchema }),
  z.strictObject({ kind: z.literal('BLOCK'), taskId: persistedTaskIdSchema, reason: nonemptySingleLineSchema }),
  z.strictObject({ kind: z.literal('IMPLEMENTED'), taskId: persistedTaskIdSchema }),
]);
const issueActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('TRIAGE_RESULT'), triageState: z.enum(['ready-for-debug', 'needs-experiment', 'ready-for-fix', 'ready-for-human', 'wontfix']) }),
  z.strictObject({ kind: z.literal('REPRODUCTION_RESULT'), reproduction: z.enum(['confirmed', 'instrumentation-required']) }),
  z.strictObject({ kind: z.literal('DEBUG_RESULT'), fixStrategy: z.enum(['ready', 'needs-experiment']) }),
]);
const evidenceDescendantSchema = z.strictObject({
  ...descendantBaseShape,
  kind: z.literal('EVIDENCE'),
  ownerKind: z.enum([
    'EVIDENCE_GENERIC', 'EVIDENCE_REVIEW_IMPORT', 'EVIDENCE_QA_IMPORT',
    'EVIDENCE_CANARY_MEASUREMENT', 'EVIDENCE_CANARY_IMPORT', 'VERIFICATION_COMMAND',
  ]),
  binding: descendantBindingSchema,
  evidence: evidenceRecordSchema,
  evidenceRecordHash: persistedSha256Schema,
  subjectBinding: evidenceSubjectBindingSchema,
  ownedOutputHash: persistedSha256Schema.nullable(),
  importedSourceHash: persistedSha256Schema.nullable(),
  windowClosedAt: persistedTimestampSchema.nullable(),
});
const humanApprovalDescendantSchema = z.strictObject({
  ...descendantBaseShape,
  kind: z.literal('HUMAN_APPROVAL'),
  binding: descendantBindingSchema,
  evidence: evidenceRecordSchema,
  evidenceRecordHash: persistedSha256Schema,
  approvedArtifact: z.strictObject({
    role: nonemptySingleLineSchema,
    path: changeArtifactPathSchema,
    rawBytesHash: persistedSha256Schema,
  }).nullable(),
});
const taskWorkDescendantSchema = z.strictObject({
  ...descendantBaseShape,
  kind: z.literal('TASK_WORK'),
  binding: descendantBindingSchema,
  action: taskWorkActionSchema,
  sourceTasksHash: persistedSha256Schema,
  targetTaskFile: taskFileSchema,
  targetTasksHash: persistedSha256Schema,
});
const issueUpdateDescendantSchema = z.strictObject({
  ...descendantBaseShape,
  kind: z.literal('ISSUE_UPDATE'),
  binding: z.strictObject({ kind: z.literal('RUN_ONLY') }),
  action: issueActionSchema,
  sourceIssueHash: persistedSha256Schema,
  targetIssueState: issueStateSchema,
  targetIssueHash: persistedSha256Schema,
});
function reconcileDescendantSchema<Kind extends 'FLOW_ASSESSMENT' | 'DECISION_RECONCILE' | 'ORDINARY_RECONCILE' | 'SCENARIO_RECLASSIFICATION'>(kind: Kind) {
  return z.strictObject({
    ...descendantBaseShape,
    kind: z.literal(kind),
    binding: z.strictObject({ kind: z.literal('RUN_ONLY') }),
    sourceRevision: persistedRevisionIdSchema,
    targetRevision: persistedRevisionIdSchema,
  });
}
const authenticatedDescendantSchema = z.union([
  evidenceDescendantSchema,
  humanApprovalDescendantSchema,
  taskWorkDescendantSchema,
  issueUpdateDescendantSchema,
  reconcileDescendantSchema('FLOW_ASSESSMENT'),
  reconcileDescendantSchema('DECISION_RECONCILE'),
  reconcileDescendantSchema('ORDINARY_RECONCILE'),
  reconcileDescendantSchema('SCENARIO_RECLASSIFICATION'),
]);

const fileObservationSchema = z.strictObject({
  kind: z.literal('FILE'),
  role: nonemptySingleLineSchema,
  path: changeArtifactPathSchema,
  rawBytesHash: persistedSha256Schema,
});
const directoryObservationSchema = z.strictObject({
  kind: z.literal('DIRECTORY'),
  role: nonemptySingleLineSchema,
  path: changeArtifactPathSchema,
  regularFileCount: nonnegativeSafeIntegerSchema,
  regularFiles: z.array(z.strictObject({ path: changeArtifactPathSchema, rawBytesHash: persistedSha256Schema })),
  regularFilesTreeHash: persistedSha256Schema,
});
const outputCaptureSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('FILE'), observation: fileObservationSchema, bytes: frozenByteBlobSchema }),
  z.strictObject({
    kind: z.literal('DIRECTORY'),
    observation: directoryObservationSchema,
    files: z.array(z.strictObject({ path: changeArtifactPathSchema, bytes: frozenByteBlobSchema })),
  }),
]);

const evidenceIdsSchema = z.array(persistedEvidenceIdSchema).superRefine((values, context) => {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) {
      context.addIssue({ code: 'custom', path: [index], message: 'STATIC_INPUT_INVALID: Evidence IDs must be sorted and unique' });
    }
  }
});
const resultStatusSchema = z.enum(['PASS', 'CONCERNS', 'FAIL']);
const findingShape = {
  id: nonemptySingleLineSchema,
  severity: z.enum(['CRITICAL', 'IMPORTANT', 'MINOR']),
  status: z.enum(['OPEN', 'RESOLVED', 'ACCEPTED']),
  summary: nonemptySingleLineSchema,
  evidenceIds: evidenceIdsSchema,
  waiverDecisionId: persistedDecisionIdSchema.nullable(),
} satisfies z.ZodRawShape;
const qaResultDraftSchema = z.strictObject({
  schemaVersion: z.literal(1), changeId: persistedChangeIdSchema,
  revision: persistedRevisionIdSchema, runId: persistedRunIdSchema,
  testedBasisHash: persistedSha256Schema,
  checks: z.array(z.strictObject({
    checkId: nonemptySingleLineSchema, status: resultStatusSchema,
    evidenceIds: evidenceIdsSchema, summary: nonemptySingleLineSchema,
  })),
  findings: z.array(z.strictObject({ ...findingShape, checkId: nonemptySingleLineSchema })),
  conclusion: resultStatusSchema,
});
const canaryResultDraftSchema = z.strictObject({
  schemaVersion: z.literal(1), changeId: persistedChangeIdSchema,
  revision: persistedRevisionIdSchema, runId: persistedRunIdSchema,
  releaseSubjectHash: persistedSha256Schema, windowOpenedAt: persistedTimestampSchema,
  observations: z.array(z.strictObject({
    signalId: nonemptySingleLineSchema,
    measurementEvidenceId: persistedEvidenceIdSchema,
    summary: nonemptySingleLineSchema,
  })),
  decision: z.enum(['CONTINUE', 'PAUSE', 'ROLLBACK']),
  summary: nonemptySingleLineSchema,
});

const completeRequestSchema = z.strictObject({
  runId: persistedRunIdSchema,
  expectedAuthorityHead: persistedSha256Schema,
  expectedTasksHash: persistedSha256Schema.nullable(),
});
const completionContextSchema = z.strictObject({
  projectWorkflowBinding: projectWorkflowBindingSchema,
  manifest: stageRunManifestSchema.refine((manifest) => manifest.disposition === 'PREPARED'),
  prepareReceiptEntryHash: persistedSha256Schema,
  currentAuthorityHead: persistedSha256Schema,
  descendants: z.array(authenticatedDescendantSchema),
  currentMetadata: changeMetadataSchema,
  currentMetadataHash: persistedSha256Schema,
  progress: progressSnapshotSchema,
  currentTaskFile: taskFileSchema,
  currentTasksHash: persistedSha256Schema,
  currentIssueState: issueStateSchema.nullable(),
  currentIssueHash: persistedSha256Schema.nullable(),
  currentRepositoryBasis: repositoryWorkBasisSchema.nullable(),
  repositoryWorkResult: repositoryWorkResultSchema.nullable(),
  currentArchiveGateSnapshot: archiveGateSnapshotSchema.nullable(),
  outputCaptures: z.array(outputCaptureSchema),
  planDraft: z.strictObject({
    path: z.string().regex(/^stage-outputs\/RUN-(?!000000$)\d{6}\/tasks\.draft\.yaml$/u),
    bytes: frozenByteBlobSchema,
    parsedTaskFile: taskFileSchema,
    targetTasksHash: persistedSha256Schema,
  }).nullable(),
});

const completionValidationTicketSchema = z.strictObject({
  schemaVersion: z.literal(1),
  authorityCatalogHash: persistedSha256Schema,
  resourceBundleHash: persistedSha256Schema,
  requestHash: persistedSha256Schema,
  manifestHash: persistedSha256Schema,
  contextHash: persistedSha256Schema,
  normalizedResultHash: persistedSha256Schema,
  requiredAllocations: z.tuple([z.literal('CORE_TIME')]),
});
const inputSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('VALIDATE'), authorityCatalog: stageAuthorityCatalogV1Schema, request: completeRequestSchema, context: completionContextSchema }),
  z.strictObject({ mode: z.literal('INSTANTIATE'), authorityCatalog: stageAuthorityCatalogV1Schema, request: completeRequestSchema, context: completionContextSchema, validation: completionValidationTicketSchema }),
]);

export interface StageCompletionValidationV1 {
  readonly mode: 'VALIDATE';
  readonly normalizedResultHash: Sha256;
}
export type CompletionValidationTicketV1 = z.output<typeof completionValidationTicketSchema>;
export type StageCompletionCompileResultV1 = StageCompletionValidationV1 | {
  readonly mode: 'INSTANTIATE';
  readonly terminalResult: StageTerminalResultV1;
  readonly terminalResultHash: Sha256;
};

// 背景：旧实现让 caller 直接传入 authorityContract 与 terminalResult，等价于让请求者
// 自己声称证明已成立。目的：这里只接受 catalog、公开完成请求和认证 context，
// 再从 manifest/descendant/capture 纯派生唯一 terminal result。上下文：writer、clock 与
// context builder 仍属后续计划；本函数不读取它们，INSTANTIATE 只重算并校验票据。
export function compileStageCompletion(value: unknown): StageCompletionCompileResultV1 {
  // 背景：1500 条 allowed contract 与 1500 条认证 descendant 会超过 catalog/hash 的
  // 100000 默认节点门。目的：仅在共享 descriptor/字节预检之后把 clone 上限提升到硬顶
  // 500000；后续普通 HObject 仍保留默认门，不形成全局放宽。
  const input = parseCompilerInput(inputSchema, value, 500_000);
  validateCompletionIdentity(input.authorityCatalog, input.request, input.context);
  validateDescendantChain(input.context);
  validateStructuredDescendants(input.context);
  validateCaptureSet(input.context);
  const terminalResult = normalizeTerminalResult(input.context);
  const normalizedResultHash = hashStrictObject(terminalResult);
  if (input.mode === 'VALIDATE') return cloneStrictJson({ mode: 'VALIDATE', normalizedResultHash });
  const expectedTicket = completionTicket(input.authorityCatalog, input.request, input.context, normalizedResultHash);
  if (hashStrictObject(input.validation) !== hashStrictObject(expectedTicket)) {
    throw new TypeError('DYNAMIC_INPUT_INVALID: completion validation ticket mismatch');
  }
  return cloneStrictJson({ mode: 'INSTANTIATE', terminalResult, terminalResultHash: normalizedResultHash });
}

function completionTicket(
  authorityCatalog: StageAuthorityCatalogV1,
  requestValue: unknown,
  contextValue: unknown,
  normalizedResultHash: Sha256,
): CompletionValidationTicketV1 {
  // 背景：票据只能由 INSTANTIATE 内部重算，测试必须用独立 literal preimage oracle；但内部调用
  // 也不能让 TypeScript 结构类型代替运行时认证。目的：重走 exact request/context schema 后再哈希。
  const request = parseCompilerInput(completeRequestSchema, requestValue);
  const context = parseCompilerInput(completionContextSchema, contextValue);
  return cloneStrictJson({
    schemaVersion: 1,
    authorityCatalogHash: hashStrictObject(authorityCatalog),
    resourceBundleHash: context.projectWorkflowBinding.resourceBundleHash,
    requestHash: hashStrictObject(request),
    manifestHash: hashStrictObject(context.manifest),
    contextHash: hashStrictObject(context),
    normalizedResultHash,
    requiredAllocations: ['CORE_TIME'],
  });
}

function validateCompletionIdentity(
  catalog: StageAuthorityCatalogV1,
  request: z.output<typeof completeRequestSchema>,
  context: z.output<typeof completionContextSchema>,
): void {
  const manifest = context.manifest;
  const contract = manifest.authorityContract;
  const catalogHash = hashStrictObject(catalog);
  if (request.runId !== manifest.runId
    || manifest.authorityCatalogHash !== catalogHash
    || context.projectWorkflowBinding.authorityCatalogHash !== catalogHash
    || context.currentMetadata.id !== manifest.changeId
    || (contract.terminal.kind !== 'RECONCILE_STAGE'
      && context.currentMetadata.activeRevision !== manifest.revision)
    || context.currentMetadataHash !== hashStrictObject(context.currentMetadata)
    || context.currentTasksHash !== hashStrictObject(context.currentTaskFile)
    || context.currentTaskFile.revision !== context.currentMetadata.activeRevision
    || contract.changeId !== manifest.changeId
    || contract.runId !== manifest.runId
    || contract.revision !== manifest.revision
    || contract.capability !== manifest.capability) {
    throw new TypeError('DYNAMIC_INPUT_INVALID: completion identity/context adjacency mismatch');
  }
  validateProgressSnapshot(context.progress);
  if ((context.currentIssueState === null) !== (context.currentIssueHash === null)
    || (context.currentIssueState !== null
      && context.currentIssueHash !== hashStrictObject(context.currentIssueState))) {
    throw new TypeError('DYNAMIC_INPUT_INVALID: completion Issue state/hash adjacency mismatch');
  }
  if (request.expectedAuthorityHead !== context.prepareReceiptEntryHash) {
    throw new TypeError('DYNAMIC_INPUT_INVALID: completion request must retain the prepare receipt authority head');
  }
  if (contract.terminal.kind === 'PLAN_STAGE') {
    if (context.planDraft === null || request.expectedTasksHash === null
      || request.expectedTasksHash !== context.planDraft.targetTasksHash) {
      throw new TypeError('DYNAMIC_INPUT_INVALID: PLAN completion requires the captured draft Task CAS');
    }
  } else if (request.expectedTasksHash !== null || context.planDraft !== null) {
    throw new TypeError('DYNAMIC_INPUT_INVALID: non-PLAN completion forbids plan Task CAS/draft');
  }
}

function validateProgressSnapshot(progress: z.output<typeof progressSnapshotSchema>): void {
  const rawUtf8 = decodeBlobText(progress.bytes);
  const expectedUtf8 = progress.events.map((event) => `${canonicalStrictJson(event)}\n`).join('');
  if (rawUtf8 !== expectedUtf8 || progress.auditCursor.prefixHash !== progress.bytes.rawBytesHash) {
    throw new TypeError('DYNAMIC_INPUT_INVALID: progress bytes/events/cursor are not one authenticated prefix');
  }
  const lines = rawUtf8.length === 0 ? [] : rawUtf8.slice(0, -1).split('\n');
  if ((rawUtf8.length > 0 && !rawUtf8.endsWith('\n')) || lines.length !== progress.events.length) {
    throw new TypeError('DYNAMIC_INPUT_INVALID: progress JSONL framing is invalid');
  }
  for (const [index, line] of lines.entries()) {
    const parsed = progressEventSchema.parse(decodeStrictJson(line!));
    if (hashStrictObject(parsed) !== hashStrictObject(progress.events[index])) {
      throw new TypeError('DYNAMIC_INPUT_INVALID: progress JSONL row disagrees with its typed event');
    }
  }
}

function validateDescendantChain(context: z.output<typeof completionContextSchema>): void {
  let predecessor = context.prepareReceiptEntryHash;
  for (const [index, descendant] of context.descendants.entries()) {
    if (descendant.ordinal !== index + 1 || descendant.predecessorEntryHash !== predecessor) {
      throw new TypeError('PRECONDITION_UNSATISFIED: Run descendant ordinal/predecessor chain is broken');
    }
    predecessor = descendant.entryHash;
  }
  if (context.currentAuthorityHead !== predecessor) {
    throw new TypeError('PRECONDITION_UNSATISFIED: current authority head is not the exact Run descendant suffix head');
  }
}

function validateStructuredDescendants(context: z.output<typeof completionContextSchema>): void {
  const contract = context.manifest.authorityContract;
  const allowedByKey = new Map<string, RunAuthorityContract['allowedDescendants'][number]>();
  for (const allowed of contract.allowedDescendants) {
    const key = ownerBindingKey(allowed.ownerKind, allowed.binding);
    if (allowedByKey.has(key)) {
      throw new TypeError('STATIC_INPUT_INVALID: duplicate allowed descendant contract key');
    }
    allowedByKey.set(key, allowed);
  }
  const descendantCountByKey = new Map<string, number>();
  for (const row of context.descendants) {
    const key = ownerBindingKey(descendantOwnerKind(row), row.binding);
    if (!allowedByKey.has(key)) {
      throw new TypeError('PRECONDITION_UNSATISFIED: authenticated descendant is not authorized by the Run contract');
    }
    descendantCountByKey.set(key, (descendantCountByKey.get(key) ?? 0) + 1);
  }
  for (const [key, allowed] of allowedByKey) {
    if (allowed.kind !== 'COUNTED') continue;
    const count = descendantCountByKey.get(key) ?? 0;
    if (count < allowed.minimum || count > allowed.maximum) {
      throw new TypeError('PRECONDITION_UNSATISFIED: authenticated descendant count escaped its Run contract');
    }
  }

  const taskRows = context.descendants.filter((row) => row.kind === 'TASK_WORK');
  const issueRows = context.descendants.filter((row) => row.kind === 'ISSUE_UPDATE');
  const reconcileRows = context.descendants.filter((row) => row.kind === 'FLOW_ASSESSMENT'
    || row.kind === 'DECISION_RECONCILE' || row.kind === 'ORDINARY_RECONCILE'
    || row.kind === 'SCENARIO_RECLASSIFICATION');
  if (contract.terminal.kind === 'WORK_STAGE') {
    validateTaskWorkRows(taskRows, context, contract.terminal);
  } else if (taskRows.length !== 0) {
    throw new TypeError('PRECONDITION_UNSATISFIED: non-WORK completion contains Task-work descendants');
  }
  if (contract.terminal.kind === 'ISSUE_STAGE') {
    validateIssueRows(issueRows, context, contract.capability, contract.terminal.sourceIssueHash);
  } else if (issueRows.length !== 0) {
    throw new TypeError('PRECONDITION_UNSATISFIED: non-ISSUE completion contains Issue descendants');
  }
  if (contract.terminal.kind === 'RECONCILE_STAGE') {
    if (reconcileRows.length !== 1) {
      throw new TypeError('PRECONDITION_UNSATISFIED: Reconcile requires exactly one top-level owner');
    }
    const owner = reconcileRows[0]!;
    if (owner.sourceRevision !== contract.terminal.sourceRevision
      || owner.targetRevision !== context.currentMetadata.activeRevision
      || owner.sourceRevision === owner.targetRevision) {
      throw new TypeError('PRECONDITION_UNSATISFIED: Reconcile owner source/target Revision is stale');
    }
  } else if (reconcileRows.length !== 0) {
    throw new TypeError('PRECONDITION_UNSATISFIED: non-Reconcile completion contains Reconcile descendants');
  }
}

function ownerBindingKey(ownerKind: string, binding: z.output<typeof descendantBindingSchema>): string {
  return `${ownerKind}\u0000${canonicalStrictJson(binding)}`;
}

function descendantOwnerKind(row: z.output<typeof authenticatedDescendantSchema>): string {
  switch (row.kind) {
    case 'EVIDENCE': return row.ownerKind;
    case 'HUMAN_APPROVAL': return 'HUMAN_APPROVAL';
    case 'TASK_WORK': return 'TASK_WORK';
    case 'ISSUE_UPDATE': return 'ISSUE_UPDATE';
    case 'FLOW_ASSESSMENT':
    case 'DECISION_RECONCILE':
    case 'ORDINARY_RECONCILE':
    case 'SCENARIO_RECLASSIFICATION':
      return row.kind;
  }
  return assertNever(row, 'authenticated descendant owner');
}

function validateTaskWorkRows(
  rows: Array<z.output<typeof taskWorkDescendantSchema>>,
  context: z.output<typeof completionContextSchema>,
  terminal: Extract<RunAuthorityContract['terminal'], { kind: 'WORK_STAGE' }>,
): void {
  let expectedSourceHash = terminal.sourceTasksHash;
  let previousTaskFile: z.output<typeof taskFileSchema> | null = null;
  for (const row of rows) {
    const targetTask = row.targetTaskFile.tasks.find((task) => task.id === terminal.taskId);
    const targetStatus = row.action.kind === 'START' ? 'RUNNING'
      : row.action.kind === 'BLOCK' ? 'BLOCKED' : 'IMPLEMENTED';
    if (row.binding.kind !== 'TASK_ID' || row.binding.taskId !== terminal.taskId
      || row.action.taskId !== terminal.taskId
      || row.sourceTasksHash !== expectedSourceHash
      || row.targetTasksHash !== hashStrictObject(row.targetTaskFile)
      || targetTask?.status !== targetStatus) {
      throw new TypeError('PRECONDITION_UNSATISFIED: WORK Task descendant CAS/action mismatch');
    }
    if (previousTaskFile === null) {
      // 背景：terminal.negativeEvidenceRecovery 描述失败终结后的状态复原，不是
      // 正常 START 的 source grammar。目的：首行必须是 READY→RUNNING，并从 target
      // 只反投影 selected Task.status=READY；整个 TaskFile 及 selected Task 的冻结 hash
      // 必须同时命中，因此顶层字段和非 selected Task 也无法漂移。
      const sourceTask = targetTask === undefined ? null : { ...targetTask, status: 'READY' as const };
      const sourceTaskFile = {
        ...row.targetTaskFile,
        tasks: row.targetTaskFile.tasks.map((task) => (
          task.id === terminal.taskId ? { ...task, status: 'READY' as const } : task
        )),
      };
      if (row.action.kind !== 'START'
        || sourceTask === null
        || hashStrictObject(sourceTask) !== terminal.sourceTaskHash
        || hashStrictObject(sourceTaskFile) !== terminal.sourceTasksHash) {
        throw new TypeError('PRECONDITION_UNSATISFIED: WORK first Task transition must reverse-project the frozen READY source TaskFile');
      }
    } else {
      const sourceProjection = {
        ...row.targetTaskFile,
        tasks: row.targetTaskFile.tasks.map((task) => task.id === terminal.taskId
          ? { ...task, status: previousTaskFile!.tasks.find((candidate) => candidate.id === terminal.taskId)!.status }
          : task),
      };
      if (hashStrictObject(sourceProjection) !== hashStrictObject(previousTaskFile)) {
        throw new TypeError('PRECONDITION_UNSATISFIED: WORK transition changed non-status TaskFile authority');
      }
    }
    previousTaskFile = row.targetTaskFile;
    expectedSourceHash = row.targetTasksHash;
  }
  if (previousTaskFile === null
    || expectedSourceHash !== context.currentTasksHash
    || hashStrictObject(previousTaskFile) !== hashStrictObject(context.currentTaskFile)) {
    throw new TypeError('PRECONDITION_UNSATISFIED: WORK Task descendant suffix does not reach current TaskFile');
  }
}

function validateIssueRows(
  rows: Array<z.output<typeof issueUpdateDescendantSchema>>,
  context: z.output<typeof completionContextSchema>,
  capability: RunAuthorityContract['capability'],
  sourceIssueHash: Sha256,
): void {
  if (rows.length !== 1 || context.descendants.at(-1)?.kind !== 'ISSUE_UPDATE') {
    throw new TypeError('PRECONDITION_UNSATISFIED: ISSUE update must be the unique final descendant');
  }
  const row = rows[0]!;
  const expectedAction = capability === 'triage' ? 'TRIAGE_RESULT'
    : capability === 'reproduce' ? 'REPRODUCTION_RESULT' : 'DEBUG_RESULT';
  const actionMatchesTarget = row.action.kind === 'TRIAGE_RESULT'
    ? row.targetIssueState.triageState === row.action.triageState
    : row.action.kind === 'REPRODUCTION_RESULT'
      ? row.targetIssueState.reproduction === row.action.reproduction
        && row.targetIssueState.triageState === 'ready-for-debug'
      : row.targetIssueState.fixStrategy === row.action.fixStrategy
        && row.targetIssueState.rootCause === 'confirmed'
        && row.targetIssueState.triageState === (row.action.fixStrategy === 'ready' ? 'ready-for-fix' : 'needs-experiment');
  const sourceCandidates = issueSourceCandidates(row);
  if (row.sourceIssueHash !== sourceIssueHash
    || row.action.kind !== expectedAction
    || !actionMatchesTarget
    || sourceCandidates.filter((candidate) => hashStrictObject(candidate) === sourceIssueHash).length !== 1
    || row.targetIssueHash !== hashStrictObject(row.targetIssueState)
    || context.currentIssueHash !== row.targetIssueHash
    || hashStrictObject(context.currentIssueState) !== hashStrictObject(row.targetIssueState)) {
    throw new TypeError('PRECONDITION_UNSATISFIED: ISSUE final descendant target/action/CAS mismatch');
  }
}

// 背景：Issue descendant 只保存 action 与 target，没有复制 source object；但 terminal 已冻结
// sourceIssueHash。目的：在有限枚举内反投影 action 允许变化的字段，只有能唯一复原 source hash
// 的 target 才能完成，从而证明其余字段保持。上下文：这不引入 source snapshot 或兼容 ABI。
function issueSourceCandidates(
  row: z.output<typeof issueUpdateDescendantSchema>,
): Array<z.output<typeof issueStateSchema>> {
  const triageStates = ['needs-info', 'ready-for-debug', 'ready-for-fix', 'needs-experiment', 'ready-for-human', 'wontfix'] as const;
  const reproductions = ['unknown', 'confirmed', 'not-reproducible', 'instrumentation-required'] as const;
  const rootCauses = ['unknown', 'suspected', 'confirmed'] as const;
  const fixStrategies = ['unknown', 'ready', 'needs-experiment'] as const;
  if (row.action.kind === 'TRIAGE_RESULT') {
    return triageStates.map((triageState) => ({ ...row.targetIssueState, triageState }));
  }
  if (row.action.kind === 'REPRODUCTION_RESULT') {
    return triageStates.flatMap((triageState) => reproductions.map((reproduction) => ({
      ...row.targetIssueState, triageState, reproduction,
    })));
  }
  return triageStates.flatMap((triageState) => rootCauses.flatMap((rootCause) => (
    fixStrategies.map((fixStrategy) => ({ ...row.targetIssueState, triageState, rootCause, fixStrategy }))
  )));
}

function validateCaptureSet(context: z.output<typeof completionContextSchema>): void {
  let aggregateBytes = 0;
  const authoredFileByRole = new Map(context.manifest.authorityContract.authoredOutputBindings
    .filter((binding) => binding.kind === 'AUTHORED_FILE')
    .map((binding) => [binding.role, binding]));
  for (const capture of context.outputCaptures) {
    if (capture.kind === 'FILE') {
      aggregateBytes += capture.bytes.byteLength;
      const binding = authoredFileByRole.get(capture.observation.role);
      if (capture.observation.rawBytesHash !== capture.bytes.rawBytesHash
        || (binding?.scaffoldBinding !== null && binding?.scaffoldBinding !== undefined
          && capture.bytes.rawBytesHash === binding.scaffoldBinding.renderedScaffoldHash)) {
        if (binding?.scaffoldBinding !== null && binding?.scaffoldBinding !== undefined
          && capture.bytes.rawBytesHash === binding.scaffoldBinding.renderedScaffoldHash) {
          throw new TypeError('PRECONDITION_UNSATISFIED: authored FILE still equals its frozen scaffold');
        }
        throw new TypeError('PRECONDITION_UNSATISFIED: authored FILE observation bytes mismatch');
      }
      continue;
    }
    requireCodeUnitOrder(capture.observation.regularFiles.map((row) => row.path), 'directory observation files');
    requireCodeUnitOrder(capture.files.map((row) => row.path), 'directory captured files');
    aggregateBytes += capture.files.reduce((total, row) => total + row.bytes.byteLength, 0);
    const capturedRows = capture.files.map((row) => ({ path: row.path, rawBytesHash: row.bytes.rawBytesHash }));
    if (capture.observation.regularFileCount !== capture.files.length
      || capture.files.some((row) => !row.path.startsWith(`${capture.observation.path}/`))
      || hashStrictObject(capturedRows) !== hashStrictObject(capture.observation.regularFiles)
      || capture.observation.regularFilesTreeHash !== hashStrictObject(capture.observation.regularFiles)) {
      throw new TypeError('PRECONDITION_UNSATISFIED: authored DIRECTORY capture is not exhaustive');
    }
  }
  if (context.planDraft !== null) {
    aggregateBytes += context.planDraft.bytes.byteLength;
    const parsed = taskFileSchema.parse(YAML.parse(decodeBlobText(context.planDraft.bytes)));
    if (hashStrictObject(parsed) !== hashStrictObject(context.planDraft.parsedTaskFile)
      || context.planDraft.targetTasksHash !== hashStrictObject(parsed)) {
      throw new TypeError('PRECONDITION_UNSATISFIED: PLAN draft raw bytes/parsed TaskFile/hash mismatch');
    }
  }
  if (aggregateBytes > 128 * 1024 * 1024) {
    throw new TypeError('PRECONDITION_UNSATISFIED: completion capture aggregate exceeds 128 MiB');
  }
}

function normalizeTerminalResult(context: z.output<typeof completionContextSchema>): StageTerminalResultV1 {
  const contract = context.manifest.authorityContract;
  const terminal = contract.terminal;
  const satisfaction = compileSatisfaction(context, contract);
  const outputObservations = compileOutputObservations(context, contract);
  const descendantEntryHashes = context.descendants.map((row) => row.entryHash);
  const base = {
    terminalHash: contract.terminalHash,
    descendantEntryHashes,
    descendantEntryHashesHash: hashStrictObject(descendantEntryHashes),
    satisfaction,
    satisfactionHash: hashStrictObject(satisfaction),
    outputObservations,
    outputObservationsHash: hashStrictObject(outputObservations),
  };
  switch (terminal.kind) {
    case 'ARTIFACT_STAGE':
      return parseTerminalResult({ ...base, kind: 'ARTIFACT_STAGE' });
    case 'PLAN_STAGE': {
      const draft = context.planDraft!;
      if (context.currentTasksHash !== terminal.sourceTasksHash
        || draft.parsedTaskFile.revision !== context.manifest.revision
        || (terminal.requireNonemptyWorkPlan && draft.parsedTaskFile.tasks.length === 0)) {
        throw new TypeError('PRECONDITION_UNSATISFIED: PLAN source/target Task authority does not satisfy the frozen terminal');
      }
      return parseTerminalResult({
        ...base,
        kind: 'PLAN_STAGE',
        draftRawBytesHash: draft.bytes.rawBytesHash,
        sourceTasksHash: terminal.sourceTasksHash,
        targetTasksHash: draft.targetTasksHash,
      });
    }
    case 'ISSUE_STAGE':
      if (context.currentIssueState === null || context.currentIssueHash === null
        || context.currentRepositoryBasis === null
        || hashStrictObject(context.currentRepositoryBasis) !== hashStrictObject(terminal.observedBasis)
        || !issuePredicatesSatisfied(terminal.requiredIssuePredicates, context.currentIssueState)) {
        throw new TypeError('PRECONDITION_UNSATISFIED: ISSUE terminal predicates are not satisfied');
      }
      return parseTerminalResult({
        ...base,
        kind: 'ISSUE_STAGE',
        sourceIssueHash: terminal.sourceIssueHash,
        targetIssueHash: context.currentIssueHash,
        observedBasisHash: hashStrictObject(terminal.observedBasis),
      });
    case 'WORK_STAGE': {
      const result = requireRepositoryResult(context, terminal.basis);
      const task = context.currentTaskFile.tasks.find((candidate) => candidate.id === terminal.taskId);
      validateTaskWorkSequence(context, terminal.taskId);
      // 背景：Array.includes 会将 changedPaths×allowedRepositoryPaths 扩大为二次扫描。
      // 目的：先对两个已严格排序且去重的 inventory 计线性 work budget，
      // 再建立唯一 Set 做 O(1) membership，同时保留未授权路径 fail-closed。
      requireLinearMembershipWorkBudget(
        [result.changedPaths.length, terminal.allowedRepositoryPaths.length],
        'WORK changedPaths/allowedRepositoryPaths membership join',
      );
      const allowedRepositoryPathSet = new Set(terminal.allowedRepositoryPaths);
      if (task?.status !== terminal.requiredTaskStatus
        || result.changedPaths.some((path) => !allowedRepositoryPathSet.has(path))) {
        throw new TypeError('PRECONDITION_UNSATISFIED: WORK Task/delta does not satisfy the frozen terminal');
      }
      return parseTerminalResult({
        ...base,
        kind: 'WORK_STAGE',
        taskId: terminal.taskId,
        sourceTasksHash: terminal.sourceTasksHash,
        targetTasksHash: context.currentTasksHash,
        repositoryWorkResult: result,
      });
    }
    case 'SIMPLIFY_STAGE':
      if (context.descendants.some((row) => row.kind === 'TASK_WORK')) {
        throw new TypeError('PRECONDITION_UNSATISFIED: SIMPLIFY forbids Task-work descendants');
      }
      return parseTerminalResult({
        ...base,
        kind: 'SIMPLIFY_STAGE',
        repositoryWorkResult: requireRepositoryResult(context, terminal.basis),
      });
    case 'REVIEW_STAGE': {
      requireCurrentRepositoryBasis(context, terminal.reviewedBasis);
      const aggregate = requireAggregateEvidence(context, 'repository-review', 'EVIDENCE_REVIEW_IMPORT');
      return parseTerminalResult({
        ...base,
        kind: 'REVIEW_STAGE',
        reviewedBasisHash: hashStrictObject(terminal.reviewedBasis),
        aggregateEvidenceId: aggregate.evidence.id,
        aggregateEvidenceRecordHash: aggregate.evidenceRecordHash,
      });
    }
    case 'VERIFY_STAGE': {
      requireCurrentRepositoryBasis(context, terminal.verifiedBasis);
      requireLinearMembershipWorkBudget(
        [context.currentTaskFile.tasks.length, terminal.verificationTaskIds.length],
        'VERIFY current Task/verification Task membership join',
      );
      const verificationTaskIdSet = new Set(terminal.verificationTaskIds);
      if (context.currentTasksHash !== terminal.targetTasksHash
        || hashStrictObject(context.currentTaskFile) !== hashStrictObject(terminal.targetTaskFile)
        || context.currentTaskFile.tasks.some((task) => verificationTaskIdSet.has(task.id) && task.status !== 'DONE')) {
        throw new TypeError('PRECONDITION_UNSATISFIED: VERIFY target TaskFile is not the frozen DONE projection');
      }
      return parseTerminalResult({
        ...base,
        kind: 'VERIFY_STAGE',
        verifiedBasisHash: hashStrictObject(terminal.verifiedBasis),
        sourceTasksHash: terminal.sourceTasksHash,
        targetTasksHash: terminal.targetTasksHash,
      });
    }
    case 'QA_STAGE': {
      requireCurrentRepositoryBasis(context, terminal.testedBasis);
      const aggregate = requireAggregateEvidence(context, terminal.qaResultRequirementId, 'EVIDENCE_QA_IMPORT');
      return parseTerminalResult({
        ...base,
        kind: 'QA_STAGE',
        testedBasisHash: hashStrictObject(terminal.testedBasis),
        aggregateEvidenceId: aggregate.evidence.id,
        aggregateEvidenceRecordHash: aggregate.evidenceRecordHash,
      });
    }
    case 'CANARY_STAGE': {
      const aggregate = requireAggregateEvidence(context, terminal.canaryResultRequirementId, 'EVIDENCE_CANARY_IMPORT');
      const measurements = context.descendants.filter((row) => row.kind === 'EVIDENCE'
        && row.ownerKind === 'EVIDENCE_CANARY_MEASUREMENT')
        .map((row) => evidenceDescendantSchema.parse(row));
      const measurementEvidenceIds = measurements.map((row) => row.evidence.id).sort();
      const windowClosedAt = aggregate.windowClosedAt;
      if (windowClosedAt === null
        || timestampMilliseconds(windowClosedAt) < timestampMilliseconds(terminal.windowOpenedAt)
          + terminal.canaryPolicy.minimumWindowSeconds * 1000) {
        throw new TypeError('PRECONDITION_UNSATISFIED: Canary minimum observation window is not closed');
      }
      return parseTerminalResult({
        ...base,
        kind: 'CANARY_STAGE',
        releaseSubjectHash: terminal.releaseSubjectBinding.subjectHash,
        measurementEvidenceIds,
        aggregateEvidenceId: aggregate.evidence.id,
        aggregateEvidenceRecordHash: aggregate.evidenceRecordHash,
        windowClosedAt,
        decision: 'CONTINUE',
      });
    }
    case 'DELIVERY_STAGE': {
      requireCurrentRepositoryBasis(context, terminal.deliveryBasis);
      const capture = context.outputCaptures.find((row) => row.observation.role === terminal.deliveryRole);
      const approval = context.descendants.find((row) => row.kind === 'HUMAN_APPROVAL'
        && row.binding.kind === 'HUMAN_GATE');
      if (capture?.kind !== 'FILE' || approval?.kind !== 'HUMAN_APPROVAL') {
        throw new TypeError('PRECONDITION_UNSATISFIED: Delivery artifact/approval proof is missing');
      }
      const releaseArtifactIdentity = releaseArtifactIdentitySchema.parse({
        schemaVersion: 1,
        workflowVersion: '0.3.0',
        authorityCatalogHash: context.manifest.authorityCatalogHash,
        changeId: context.manifest.changeId,
        revision: context.manifest.revision,
        repositoryBasis: terminal.deliveryBasis,
        repositoryBasisHash: hashStrictObject(terminal.deliveryBasis),
        delivery: {
          artifactAuthorityEntryId: 'ship:DELIVERY',
          role: 'DELIVERY',
          path: 'delivery.md',
          rawBytesHash: capture.observation.rawBytesHash,
        },
      });
      return parseTerminalResult({
        ...base,
        kind: 'DELIVERY_STAGE',
        deliveryBasisHash: hashStrictObject(terminal.deliveryBasis),
        releaseArtifactIdentity,
        releaseArtifactIdentityHash: hashStrictObject(releaseArtifactIdentity),
        approvalEvidenceId: approval.evidence.id,
      });
    }
    case 'ARCHIVE_STAGE':
      if (context.currentArchiveGateSnapshot === null
        || hashStrictObject(context.currentArchiveGateSnapshot) !== terminal.requiredGateSnapshotHash) {
        throw new TypeError('PRECONDITION_UNSATISFIED: Archive gate snapshot drift');
      }
      return parseTerminalResult({
        ...base,
        kind: 'ARCHIVE_STAGE',
        sourceMetadataHash: terminal.sourceMetadataHash,
        targetMetadataHash: context.currentMetadataHash,
        requiredGateSnapshotHash: terminal.requiredGateSnapshotHash,
      });
    case 'RECONCILE_STAGE': {
      const owner = context.descendants.find((row) => row.kind === 'FLOW_ASSESSMENT'
        || row.kind === 'DECISION_RECONCILE' || row.kind === 'ORDINARY_RECONCILE'
        || row.kind === 'SCENARIO_RECLASSIFICATION');
      if (owner === undefined || !terminal.allowedTopLevelOwners.includes(owner.kind)) {
        throw new TypeError('PRECONDITION_UNSATISFIED: Reconcile exact owner is missing');
      }
      return parseTerminalResult({
        ...base,
        kind: 'RECONCILE_STAGE',
        sourceRevision: terminal.sourceRevision,
        targetRevision: owner.targetRevision,
        selectedOwner: { kind: owner.kind, entryHash: owner.entryHash },
      });
    }
  }
  return assertNever(terminal, 'stage completion terminal');
}

function compileSatisfaction(
  context: z.output<typeof completionContextSchema>,
  contract: RunAuthorityContract,
) {
  const evidenceRows = context.descendants.filter((row) => row.kind === 'EVIDENCE');
  const gateRows = context.descendants.filter((row) => row.kind === 'HUMAN_APPROVAL');
  const requirements = 'evidenceRequirements' in contract.terminal ? contract.terminal.evidenceRequirements : [];
  const requirementById = new Map<string, typeof requirements[number]>();
  for (const requirement of requirements) {
    if (requirementById.has(requirement.requirementId)) {
      throw new TypeError('STATIC_INPUT_INVALID: duplicate terminal Evidence requirement');
    }
    requirementById.set(requirement.requirementId, requirement);
  }
  const evidenceByBinding = new Map<string, typeof evidenceRows>();
  const evidenceIds = new Set<string>();
  for (const row of evidenceRows) {
    validateEvidenceDescendant(row, context, contract, requirementById);
    if (evidenceIds.has(row.evidence.id)) {
      throw new TypeError('PRECONDITION_UNSATISFIED: duplicate completion Evidence ID');
    }
    evidenceIds.add(row.evidence.id);
    if (row.binding.kind !== 'EVIDENCE_REQUIREMENT') continue;
    const key = evidenceBindingKey(row.binding.requirementId, row.binding.taskId);
    const rows = evidenceByBinding.get(key);
    if (rows === undefined) evidenceByBinding.set(key, [row]);
    else rows.push(row);
  }
  const requiredGates = 'requiredHumanGates' in contract.terminal ? contract.terminal.requiredHumanGates : [];
  const requiredGateById = new Map<string, typeof requiredGates[number]>();
  for (const gate of requiredGates) {
    if (requiredGateById.has(gate.gateId)) {
      throw new TypeError('STATIC_INPUT_INVALID: duplicate terminal HumanGate contract');
    }
    requiredGateById.set(gate.gateId, gate);
  }
  const captureByRole = new Map<string, z.output<typeof outputCaptureSchema>>();
  for (const capture of context.outputCaptures) {
    if (captureByRole.has(capture.observation.role)) {
      throw new TypeError('PRECONDITION_UNSATISFIED: duplicate completion output capture role');
    }
    captureByRole.set(capture.observation.role, capture);
  }
  const gateById = new Map<string, typeof gateRows>();
  for (const row of gateRows) {
    validateGateDescendant(row, context, contract, requiredGateById, captureByRole);
    if (row.binding.kind !== 'HUMAN_GATE') continue;
    const rows = gateById.get(row.binding.gateId);
    if (rows === undefined) gateById.set(row.binding.gateId, [row]);
    else rows.push(row);
  }
  const taskIdsByRequirement = contract.terminal.kind === 'VERIFY_STAGE'
    ? validateAndIndexVerifyTaskRequirementClosure(contract.terminal, 'Stage completion compiler')
    : new Map<string, readonly string[]>();
  const evidence = requirements.flatMap((requirement) => {
    const taskIds = requirementTaskIds(requirement, contract, taskIdsByRequirement);
    return taskIds.map((taskId) => {
      const ids = (evidenceByBinding.get(evidenceBindingKey(requirement.requirementId, taskId)) ?? [])
        .filter((row) => row.evidence.status === requirement.satisfyingStatus)
        .map((row) => row.evidence.id).sort();
      const minimum = 'minimumRecords' in requirement ? requirement.minimumRecords : requirement.minimumRecordsPerTask;
      if (ids.length !== minimum) {
        throw new TypeError('PRECONDITION_UNSATISFIED: completion Evidence satisfaction is not exact');
      }
      return { requirementId: requirement.requirementId, taskId, evidenceIds: ids };
    });
  });
  const gates = requiredGates.map((gate) => {
    const rows = gateById.get(gate.gateId) ?? [];
    if (rows.length !== 1) throw new TypeError('PRECONDITION_UNSATISFIED: completion HumanGate satisfaction is not exact');
    return { gateId: gate.gateId, evidenceId: rows[0]!.evidence.id };
  });
  if (evidenceRows.length !== evidence.reduce((total, row) => total + row.evidenceIds.length, 0)
    || gateRows.length !== gates.length) {
    throw new TypeError('PRECONDITION_UNSATISFIED: completion contains extra Evidence/HumanGate descendants');
  }
  return { evidence, gates };
}

function evidenceBindingKey(requirementId: string, taskId: string | null): string {
  return `${requirementId}\u0000${taskId ?? ''}`;
}

function requirementTaskIds(
  requirement: Extract<RunAuthorityContract['terminal'], { evidenceRequirements: unknown }>['evidenceRequirements'][number],
  contract: RunAuthorityContract,
  taskIdsByRequirement: ReadonlyMap<string, readonly string[]>,
): Array<string | null> {
  if (requirement.taskScope.kind === 'NONE') return [null];
  if (requirement.taskScope.kind === 'SELECTED_TASK') {
    if (contract.terminal.kind === 'WORK_STAGE') return [contract.terminal.taskId];
    if (contract.terminal.kind === 'REVIEW_STAGE' && contract.terminal.reviewScope.kind === 'TASK') {
      return [contract.terminal.reviewScope.taskId];
    }
    throw new TypeError('STATIC_INPUT_INVALID: SELECTED_TASK requirement lacks a frozen Task');
  }
  if (contract.terminal.kind !== 'VERIFY_STAGE') {
    throw new TypeError('STATIC_INPUT_INVALID: verification Task requirement escaped VERIFY terminal');
  }
  if (requirement.taskScope.kind === 'EACH_VERIFICATION_TASK') return [...contract.terminal.verificationTaskIds];
  return [...(taskIdsByRequirement.get(requirement.requirementId) ?? [])];
}

function validateEvidenceDescendant(
  row: z.output<typeof evidenceDescendantSchema>,
  context: z.output<typeof completionContextSchema>,
  contract: RunAuthorityContract,
  requirementById: ReadonlyMap<string, Extract<RunAuthorityContract['terminal'], { evidenceRequirements: unknown }>['evidenceRequirements'][number]>,
): void {
  if (row.binding.kind !== 'EVIDENCE_REQUIREMENT') {
    throw new TypeError('PRECONDITION_UNSATISFIED: Evidence descendant lacks requirement binding');
  }
  const binding = row.binding;
  const runBinding = row.evidence.runBinding;
  const requirement = requirementById.get(binding.requirementId);
  const ownerByProducer = {
    GENERIC_IMPORT: 'EVIDENCE_GENERIC',
    VERIFICATION_COMMAND: 'VERIFICATION_COMMAND',
    REVIEW_RESULT_IMPORT: 'EVIDENCE_REVIEW_IMPORT',
    QA_RESULT_IMPORT: 'EVIDENCE_QA_IMPORT',
    CANARY_MEASUREMENT_IMPORT: 'EVIDENCE_CANARY_MEASUREMENT',
    CANARY_RESULT_IMPORT: 'EVIDENCE_CANARY_IMPORT',
  } as const;
  const expectedSubjectBinding = expectedEvidenceSubjectBinding(contract, binding.taskId, context);
  if (requirement === undefined
    || row.evidenceRecordHash !== hashStrictObject(row.evidence)
    || hashStrictObject(row.subjectBinding) !== hashStrictObject(row.evidence.subjectBinding)
    || hashStrictObject(row.subjectBinding) !== hashStrictObject(expectedSubjectBinding)
    || row.evidence.changeId !== context.manifest.changeId
    || row.evidence.revision !== context.manifest.revision
    || row.evidence.requirementId !== binding.requirementId
    || row.evidence.taskId !== binding.taskId
    || row.evidence.producer !== requirement.producer
    || row.ownerKind !== ownerByProducer[requirement.producer]
    || !requirement.allowedTypes.includes(row.evidence.type)
    || !requirement.allowedStatuses.includes(row.evidence.status)
    || (row.evidence.outputFile === null) !== (row.ownedOutputHash === null)
    || (requirement.outputPolicy === 'OWNED_OUTPUT_REQUIRED' && row.ownedOutputHash === null)
    || (requirement.producer === 'VERIFICATION_COMMAND') !== (row.importedSourceHash === null)
    || (requirement.producer === 'CANARY_RESULT_IMPORT') !== (row.windowClosedAt !== null)
    || runBinding === null
    || runBinding.runId !== contract.runId
    || runBinding.ordinal !== row.ordinal
    || hashStrictObject(runBinding.prepareOwner) !== hashStrictObject(contract.prepareOwner)) {
    throw new TypeError('PRECONDITION_UNSATISFIED: authenticated Evidence descendant binding mismatch');
  }
}

function validateGateDescendant(
  row: z.output<typeof humanApprovalDescendantSchema>,
  context: z.output<typeof completionContextSchema>,
  contract: RunAuthorityContract,
  requiredGateById: ReadonlyMap<string, Extract<RunAuthorityContract['terminal'], { requiredHumanGates: unknown }>['requiredHumanGates'][number]>,
  captureByRole: ReadonlyMap<string, z.output<typeof outputCaptureSchema>>,
): void {
  if (row.binding.kind !== 'HUMAN_GATE') {
    throw new TypeError('PRECONDITION_UNSATISFIED: Human approval descendant lacks gate binding');
  }
  const binding = row.binding;
  const runBinding = row.evidence.runBinding;
  const gate = requiredGateById.get(binding.gateId);
  const approvedCapture = gate?.approvedArtifactRole === null || gate === undefined ? undefined
    : captureByRole.get(gate.approvedArtifactRole);
  const expectedApprovedArtifact = approvedCapture?.kind === 'FILE' ? {
    role: approvedCapture.observation.role,
    path: approvedCapture.observation.path,
    rawBytesHash: approvedCapture.observation.rawBytesHash,
  } : null;
  if (gate === undefined
    || row.evidenceRecordHash !== hashStrictObject(row.evidence)
    || row.evidence.changeId !== context.manifest.changeId
    || row.evidence.revision !== context.manifest.revision
    || row.evidence.gateId !== binding.gateId
    || hashStrictObject(row.evidence.subjectBinding) !== hashStrictObject(expectedEvidenceSubjectBinding(contract, null, context))
    || hashStrictObject(row.approvedArtifact) !== hashStrictObject(expectedApprovedArtifact)
    || ((gate.approvedArtifactRole === null) !== (row.approvedArtifact === null))
    || runBinding === null
    || runBinding.runId !== contract.runId
    || runBinding.ordinal !== row.ordinal
    || hashStrictObject(runBinding.prepareOwner) !== hashStrictObject(contract.prepareOwner)) {
    throw new TypeError('PRECONDITION_UNSATISFIED: authenticated HumanGate descendant binding mismatch');
  }
}

function expectedEvidenceSubjectBinding(
  contract: RunAuthorityContract,
  taskId: string | null,
  context: z.output<typeof completionContextSchema>,
) {
  const terminal = contract.terminal;
  if (terminal.kind === 'CANARY_STAGE') {
    const subject = { kind: 'RELEASE_SUBJECT', binding: terminal.releaseSubjectBinding } as const;
    return { subject, subjectHash: hashStrictObject(subject) } as const;
  }
  const basis = terminal.kind === 'ISSUE_STAGE' ? terminal.observedBasis
    : terminal.kind === 'WORK_STAGE' || terminal.kind === 'SIMPLIFY_STAGE'
      ? context.repositoryWorkResult?.completed ?? null
      : terminal.kind === 'REVIEW_STAGE' ? terminal.reviewedBasis
        : terminal.kind === 'VERIFY_STAGE' ? terminal.verifiedBasis
          : terminal.kind === 'QA_STAGE' ? terminal.testedBasis
            : terminal.kind === 'DELIVERY_STAGE' ? terminal.deliveryBasis : null;
  if (basis !== null) {
    const subject = taskId === null
      ? { kind: 'REPOSITORY_BASIS', revision: contract.revision, basis } as const
      : { kind: 'TASK_REPOSITORY_BASIS', revision: contract.revision, taskId, basis } as const;
    return { subject, subjectHash: hashStrictObject(subject) } as const;
  }
  const subject = {
    kind: 'CHANGE_AUTHORITY', revision: contract.revision,
    authorityHead: contract.preparedFromAuthorityHead,
  } as const;
  return { subject, subjectHash: hashStrictObject(subject) } as const;
}

function compileOutputObservations(
  context: z.output<typeof completionContextSchema>,
  contract: RunAuthorityContract,
) {
  const observations: Array<z.output<typeof fileObservationSchema> | z.output<typeof directoryObservationSchema>> =
    context.outputCaptures.map((capture) => capture.observation);
  if (context.planDraft !== null) {
    observations.push(fileObservationSchema.parse({
      kind: 'FILE',
      role: 'TASKFILE_DRAFT',
      path: context.planDraft.path,
      rawBytesHash: context.planDraft.bytes.rawBytesHash,
    }));
  }
  const expected = contract.authoredOutputBindings.filter((binding) => binding.kind !== 'REPOSITORY_DIFF');
  if (observations.length !== expected.length) {
    throw new TypeError('PRECONDITION_UNSATISFIED: completion output capture set is not exhaustive');
  }
  for (const [index, binding] of expected.entries()) {
    const observation = observations[index];
    const expectedPath = binding.kind === 'AUTHORED_DIRECTORY' ? binding.path.slice(0, -1) : binding.path;
    if (observation === undefined || observation.role !== binding.role || observation.path !== expectedPath
      || (binding.kind === 'AUTHORED_DIRECTORY'
        && (observation.kind !== 'DIRECTORY' || observation.regularFileCount < binding.minimumRegularFiles))
      || (binding.kind !== 'AUTHORED_DIRECTORY' && observation.kind !== 'FILE')) {
      throw new TypeError('PRECONDITION_UNSATISFIED: output capture does not match its frozen Run binding');
    }
  }
  return observations;
}

function requireRepositoryResult(context: z.output<typeof completionContextSchema>, basis: unknown) {
  const result = context.repositoryWorkResult;
  if (result === null || result.changedPaths.length === 0
    || hashStrictObject(result.prepared) !== hashStrictObject(basis)
    || hashStrictObject(result.completed) === hashStrictObject(result.prepared)
    || result.prepared.headCommit !== result.completed.headCommit
    || result.prepared.indexTreeHash !== result.completed.indexTreeHash
    || context.currentRepositoryBasis === null
    || hashStrictObject(result.completed) !== hashStrictObject(context.currentRepositoryBasis)) {
    throw new TypeError('PRECONDITION_UNSATISFIED: repository completion requires a nonempty authenticated root delta');
  }
  return result;
}

function requireCurrentRepositoryBasis(
  context: z.output<typeof completionContextSchema>,
  expectedBasis: unknown,
): void {
  if (context.currentRepositoryBasis === null
    || hashStrictObject(context.currentRepositoryBasis) !== hashStrictObject(expectedBasis)) {
    throw new TypeError('PRECONDITION_UNSATISFIED: repository observation drifted after stage prepare');
  }
}

function validateTaskWorkSequence(context: z.output<typeof completionContextSchema>, taskId: string): void {
  const actions = context.descendants.filter((row) => row.kind === 'TASK_WORK').map((row) => row.action);
  let state: 'READY' | 'RUNNING' | 'BLOCKED' | 'IMPLEMENTED' = 'READY';
  for (const action of actions) {
    if (action.taskId !== taskId) throw new TypeError('PRECONDITION_UNSATISFIED: WORK descendant names another Task');
    if (action.kind === 'START' && (state === 'READY' || state === 'BLOCKED')) state = 'RUNNING';
    else if (action.kind === 'BLOCK' && state === 'RUNNING') state = 'BLOCKED';
    else if (action.kind === 'IMPLEMENTED' && state === 'RUNNING') state = 'IMPLEMENTED';
    else throw new TypeError('PRECONDITION_UNSATISFIED: WORK TASK_WORK_SEQUENCE grammar mismatch');
  }
  if (state !== 'IMPLEMENTED') throw new TypeError('PRECONDITION_UNSATISFIED: WORK TASK_WORK_SEQUENCE is incomplete');
}

function requireAggregateEvidence(
  context: z.output<typeof completionContextSchema>,
  requirementId: string,
  ownerKind: 'EVIDENCE_REVIEW_IMPORT' | 'EVIDENCE_QA_IMPORT' | 'EVIDENCE_CANARY_IMPORT',
) {
  const rows = context.descendants.filter((row) => row.kind === 'EVIDENCE'
    && row.ownerKind === ownerKind
    && row.binding.kind === 'EVIDENCE_REQUIREMENT'
    && row.binding.requirementId === requirementId);
  if (rows.length !== 1) throw new TypeError('PRECONDITION_UNSATISFIED: aggregate Evidence proof is missing or duplicated');
  // 背景：TypeScript 不会把带多重谓词的 Array.filter 结果收窄到 EVIDENCE
  // 分支。目的：在边界再次用同一 strict schema 认证返回值，避免断言绕过字段闭合。
  const row = evidenceDescendantSchema.parse(rows[0]);
  validateAggregateDraft(context, row, ownerKind);
  return row;
}

function validateAggregateDraft(
  context: z.output<typeof completionContextSchema>,
  row: z.output<typeof evidenceDescendantSchema>,
  ownerKind: 'EVIDENCE_REVIEW_IMPORT' | 'EVIDENCE_QA_IMPORT' | 'EVIDENCE_CANARY_IMPORT',
): void {
  const role = ownerKind === 'EVIDENCE_REVIEW_IMPORT' ? 'REVIEW_DRAFT'
    : ownerKind === 'EVIDENCE_QA_IMPORT' ? 'QA_DRAFT' : 'CANARY_DRAFT';
  const capture = context.outputCaptures.find((candidate) => candidate.observation.role === role);
  if (capture?.kind !== 'FILE'
    || row.importedSourceHash !== capture.bytes.rawBytesHash
    || row.ownedOutputHash !== capture.bytes.rawBytesHash) {
    throw new TypeError('PRECONDITION_UNSATISFIED: aggregate Evidence is not bound to the exact authored draft bytes');
  }
  // 背景：aggregate draft 的 hash 只认证 bytes，不会让 JSON duplicate-key 语义自动唯一。
  // 目的：Review/QA/Canary import 与 Core Review 共用同一个 strict decoder，在 schema 与
  // canonical work 前拒绝 root/nested duplicate、BOM 和尾随值。
  const raw = decodeStrictJson(decodeBlobText(capture.bytes));
  const contract = context.manifest.authorityContract;
  if (ownerKind === 'EVIDENCE_REVIEW_IMPORT') {
    if (contract.terminal.kind !== 'REVIEW_STAGE') throw new TypeError('STATIC_INPUT_INVALID: Review aggregate escaped Review terminal');
    const draft = reviewDraftV2Schema.parse(raw);
    const exactChecks = draft.axes.specification.checks.map(({ check }) => check).join('\0')
      === contract.terminal.reviewPolicy.specification.join('\0')
      && draft.axes.standards.checks.map(({ check }) => check).join('\0')
        === contract.terminal.reviewPolicy.standards.join('\0')
      && draft.axes.riskProduction.checks.map(({ check }) => check).join('\0')
        === contract.terminal.reviewPolicy.riskProduction.join('\0');
    const currentEvidenceIds = currentPassEvidenceIds(context, row.evidence.id);
    const axes = [draft.axes.specification, draft.axes.standards, draft.axes.riskProduction];
    // 背景：Review finding 不只声明 Evidence，还声明 frozen axis/check 权限。
    // 目的：把准确的检查行编成 key→current PASS Evidence 索引，finding 必须
    // 命中同一行且只能引用该行已绑定的 Evidence，不得从其他轴或检查借用。
    const findingEvidenceByCheck = new Map<string, ReadonlySet<string>>();
    const indexReviewChecks = (
      axis: 'SPECIFICATION' | 'STANDARDS' | 'RISK_PRODUCTION',
      checks: readonly { readonly check: string; readonly evidenceIds: readonly string[] }[],
    ): void => {
      for (const check of checks) {
        const key = `${axis}\u0000${check.check}`;
        if (findingEvidenceByCheck.has(key)) {
          throw new TypeError('PRECONDITION_UNSATISFIED: duplicate Review axis/check row');
        }
        findingEvidenceByCheck.set(key, new Set(check.evidenceIds));
      }
    };
    indexReviewChecks('SPECIFICATION', draft.axes.specification.checks);
    indexReviewChecks('STANDARDS', draft.axes.standards.checks);
    indexReviewChecks('RISK_PRODUCTION', draft.axes.riskProduction.checks);
    for (const axis of axes) {
      if (axis.status !== foldResultStatuses(axis.checks.map((check) => check.status))) {
        throw new TypeError('PRECONDITION_UNSATISFIED: Review axis status is not the exact check fold');
      }
      for (const check of axis.checks) {
        if (check.evidenceIds.some((evidenceId) => !currentEvidenceIds.has(evidenceId))) {
          throw new TypeError('PRECONDITION_UNSATISFIED: Review check cites stale/fabricated Evidence');
        }
      }
    }
    requireCodeUnitOrder(draft.findings.map((finding) => finding.id), 'Review finding IDs');
    for (const finding of draft.findings) {
      const checkEvidenceIds = findingEvidenceByCheck.get(`${finding.axis}\u0000${finding.check}`);
      if (checkEvidenceIds === undefined
        || finding.evidenceIds.some((evidenceId) => (
          !currentEvidenceIds.has(evidenceId) || !checkEvidenceIds.has(evidenceId)
        ))
        || ((finding.status === 'ACCEPTED') !== (finding.waiverDecisionId !== null))) {
        throw new TypeError('PRECONDITION_UNSATISFIED: Review finding axis/check/Evidence/waiver binding is invalid');
      }
    }
    const axisFold = foldResultStatuses(axes.map((axis) => axis.status));
    const reviewConclusion = draft.findings.some((finding) => finding.status === 'OPEN' && finding.severity === 'CRITICAL')
      ? 'FAIL'
      : axisFold === 'FAIL' ? 'FAIL'
        : draft.findings.some((finding) => finding.status === 'OPEN' && finding.severity === 'IMPORTANT')
          ? 'CONCERNS' : axisFold;
    if (draft.changeId !== contract.changeId || draft.revision !== contract.revision || draft.runId !== contract.runId
      || hashStrictObject(draft.scope) !== contract.terminal.reviewScopeHash
      || !exactChecks || draft.conclusion !== reviewConclusion || draft.conclusion !== 'PASS') {
      throw new TypeError('PRECONDITION_UNSATISFIED: imported Review draft does not prove the frozen policy/scope');
    }
    return;
  }
  if (ownerKind === 'EVIDENCE_QA_IMPORT') {
    if (contract.terminal.kind !== 'QA_STAGE') throw new TypeError('STATIC_INPUT_INVALID: QA aggregate escaped QA terminal');
    const draft = qaResultDraftSchema.parse(raw);
    const exactChecks = draft.checks.map(({ checkId }) => checkId).join('\0')
      === contract.terminal.qaPolicy.checks.map(({ checkId }) => checkId).join('\0');
    const supportRows = context.descendants.filter(isEvidenceDescendant)
      .filter((candidate) => candidate.evidence.id !== row.evidence.id && candidate.evidence.status === 'PASS');
    const supportByRequirement = new Map<string, Set<z.output<typeof persistedEvidenceIdSchema>>>();
    for (const support of supportRows) {
      if (support.binding.kind !== 'EVIDENCE_REQUIREMENT') continue;
      const ids = supportByRequirement.get(support.binding.requirementId);
      if (ids === undefined) supportByRequirement.set(support.binding.requirementId, new Set([support.evidence.id]));
      else ids.add(support.evidence.id);
    }
    // 背景：全局 PASS Evidence 集合，甚至 check 级并集，都会丢失 finding 必须覆盖该 check
    // 每一个 requirement 的冻结权限边界；empty/partial finding 因此能伪装成同-check 结果。
    // 目的：预先建立 EvidenceId→requirementId 的 current、PASS、exact-tested-basis 索引；
    // finding 单次扫描自己的 Evidence 后必须覆盖全部 requirement，既拒绝跨 check/extra，
    // 又不执行 requirement×Evidence 的二次 membership join。
    const findingEvidenceByCheck = new Map<string, {
      readonly requirementIds: readonly string[];
      readonly requirementIdByEvidenceId: ReadonlyMap<string, string>;
    }>();
    for (const [index, policyCheck] of contract.terminal.qaPolicy.checks.entries()) {
      const check = draft.checks[index];
      const requirementIdByEvidenceId = new Map<string, string>();
      for (const requirementId of policyCheck.evidenceRequirementIds) {
        for (const evidenceId of supportByRequirement.get(requirementId) ?? []) {
          if (requirementIdByEvidenceId.has(evidenceId)) {
            throw new TypeError('PRECONDITION_UNSATISFIED: QA Evidence ambiguously satisfies multiple requirements');
          }
          requirementIdByEvidenceId.set(evidenceId, requirementId);
        }
      }
      const checkEvidenceIds = new Set(check?.evidenceIds ?? []);
      const coversEveryRequirement = policyCheck.evidenceRequirementIds.every((requirementId) => (
        [...(supportByRequirement.get(requirementId) ?? new Set<z.output<typeof persistedEvidenceIdSchema>>())]
          .some((evidenceId) => checkEvidenceIds.has(evidenceId))
      ));
      if (check === undefined || !coversEveryRequirement
        || check.evidenceIds.some((evidenceId) => !requirementIdByEvidenceId.has(evidenceId))) {
        throw new TypeError('PRECONDITION_UNSATISFIED: QA draft check Evidence inventory drifted');
      }
      if (findingEvidenceByCheck.has(policyCheck.checkId)) {
        throw new TypeError('PRECONDITION_UNSATISFIED: duplicate QA policy check ID');
      }
      findingEvidenceByCheck.set(policyCheck.checkId, {
        requirementIds: policyCheck.evidenceRequirementIds,
        requirementIdByEvidenceId,
      });
    }
    requireCodeUnitOrder(draft.findings.map((finding) => finding.id), 'QA finding IDs');
    for (const finding of draft.findings) {
      const coverage = findingEvidenceByCheck.get(finding.checkId);
      const coveredRequirementIds = new Set<string>();
      const hasExtraEvidence = coverage === undefined || finding.evidenceIds.some((evidenceId) => {
        const requirementId = coverage.requirementIdByEvidenceId.get(evidenceId);
        if (requirementId === undefined) return true;
        coveredRequirementIds.add(requirementId);
        return false;
      });
      if (coverage === undefined || hasExtraEvidence
        || coveredRequirementIds.size !== coverage.requirementIds.length
        || ((finding.status === 'ACCEPTED') !== (finding.waiverDecisionId !== null))) {
        throw new TypeError('PRECONDITION_UNSATISFIED: QA finding Evidence/check/waiver binding is invalid');
      }
    }
    let qaConclusion = foldResultStatuses(draft.checks.map((check) => check.status));
    for (const finding of draft.findings.filter((candidate) => candidate.status === 'OPEN')) {
      qaConclusion = foldResultStatuses([qaConclusion, contract.terminal.qaPolicy.findingVerdicts[finding.severity]]);
    }
    if (draft.changeId !== contract.changeId || draft.revision !== contract.revision || draft.runId !== contract.runId
      || draft.testedBasisHash !== hashStrictObject(contract.terminal.testedBasis)
      || !exactChecks || draft.conclusion !== qaConclusion || draft.conclusion !== 'PASS') {
      throw new TypeError('PRECONDITION_UNSATISFIED: imported QA draft does not prove the frozen policy/basis');
    }
    return;
  }
  if (contract.terminal.kind !== 'CANARY_STAGE') throw new TypeError('STATIC_INPUT_INVALID: Canary aggregate escaped Canary terminal');
  const draft = canaryResultDraftSchema.parse(raw);
  const measurementByRequirement = new Map<string, z.output<typeof evidenceDescendantSchema>>();
  for (const candidate of context.descendants) {
    if (candidate.kind !== 'EVIDENCE' || candidate.ownerKind !== 'EVIDENCE_CANARY_MEASUREMENT'
      || candidate.binding.kind !== 'EVIDENCE_REQUIREMENT') continue;
    if (measurementByRequirement.has(candidate.binding.requirementId)) {
      throw new TypeError('PRECONDITION_UNSATISFIED: duplicate Canary measurement requirement proof');
    }
    measurementByRequirement.set(candidate.binding.requirementId, candidate);
  }
  const expectedObservations = contract.terminal.canaryPolicy.signals.map((signal) => {
    const measurement = measurementByRequirement.get(signal.measurementRequirementId);
    if (measurement === undefined) {
      throw new TypeError('PRECONDITION_UNSATISFIED: Canary signal lacks its exact measurement Evidence');
    }
    return { signalId: signal.signalId, measurementEvidenceId: measurement.evidence.id };
  });
  if (draft.changeId !== contract.changeId || draft.revision !== contract.revision || draft.runId !== contract.runId
    || draft.releaseSubjectHash !== contract.terminal.releaseSubjectBinding.subjectHash
    || draft.windowOpenedAt !== contract.terminal.windowOpenedAt || draft.decision !== 'CONTINUE'
    || hashStrictObject(draft.observations.map(({ signalId, measurementEvidenceId }) => ({ signalId, measurementEvidenceId })))
      !== hashStrictObject(expectedObservations)) {
    throw new TypeError('PRECONDITION_UNSATISFIED: imported Canary draft does not prove the frozen release/window/signals');
  }
}

function currentPassEvidenceIds(
  context: z.output<typeof completionContextSchema>,
  excludedEvidenceId: string,
): Set<string> {
  return new Set(context.descendants.filter(isEvidenceDescendant)
    .filter((row) => row.evidence.id !== excludedEvidenceId && row.evidence.status === 'PASS')
    .map((row) => row.evidence.id));
}

function isEvidenceDescendant(
  row: z.output<typeof authenticatedDescendantSchema>,
): row is z.output<typeof evidenceDescendantSchema> {
  return row.kind === 'EVIDENCE';
}

function foldResultStatuses(statuses: readonly z.output<typeof resultStatusSchema>[]): z.output<typeof resultStatusSchema> {
  if (statuses.includes('FAIL')) return 'FAIL';
  if (statuses.includes('CONCERNS')) return 'CONCERNS';
  return 'PASS';
}

function issuePredicatesSatisfied(
  predicates: readonly z.output<typeof issuePredicateInputSchema>[],
  issue: z.output<typeof issueStateSchema>,
): boolean {
  return predicates.every((predicate) => {
    switch (predicate.kind) {
      case 'TRIAGE_STATE_IN': return predicate.values.includes(issue.triageState);
      case 'REPRODUCTION_IN': return predicate.values.includes(issue.reproduction);
      case 'ROOT_CAUSE_IS': return predicate.value === issue.rootCause;
      case 'FIX_STRATEGY_IN': return predicate.values.includes(issue.fixStrategy);
    }
    return assertNever(predicate, 'Issue completion predicate');
  });
}

function parseTerminalResult(value: unknown): StageTerminalResultV1 {
  return stageTerminalResultSchema.parse(cloneStrictJson(value));
}

function decodeBlobText(blob: z.output<typeof frozenByteBlobSchema>): string {
  const bytes = Buffer.from(blob.rawBytesBase64, 'base64');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError('PRECONDITION_UNSATISFIED: completion capture is not well-formed UTF-8');
  }
}

function timestampMilliseconds(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/u.exec(value);
  if (match === null) throw new TypeError('STATIC_INPUT_INVALID: timestamp is not canonical UTC');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const adjustedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * adjustedMonth + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  const daysFromEpoch = era * 146097 + dayOfEra - 719468;
  return (((daysFromEpoch * 24 + Number(match[4])) * 60 + Number(match[5])) * 60
    + Number(match[6])) * 1000 + Number(match[7]);
}

function resourceMemberKey(member: z.output<typeof projectWorkflowResourceMemberSchema>): string {
  switch (member.kind) {
    case 'COMPILER_RUNTIME': return `COMPILER_RUNTIME\u0000${member.runtimeId}`;
    case 'COMPILER_FUNCTION': return `COMPILER_FUNCTION\u0000${member.compilerId}`;
    case 'PROTOCOL': return `PROTOCOL\u0000${member.protocolId}`;
    case 'SCAFFOLD': return `SCAFFOLD\u0000${member.templateId}`;
  }
  return assertNever(member, 'workflow resource member');
}
