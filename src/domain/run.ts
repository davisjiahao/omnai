import { z } from 'zod';
import {
  CAPABILITIES,
  READINESS_KEYS,
  SCENARIO_IDS,
  TASK_STATUSES,
  changeArtifactDirectorySchema,
  changeArtifactPathSchema,
  finiteNumberSchema,
  guardStrictPersistentInput,
  hObject,
  nonemptySingleLineSchema,
  nonnegativeSafeIntegerSchema,
  positiveSafeIntegerSchema,
  persistedChangeIdSchema as changeIdSchema,
  persistedDecisionIdSchema as decisionIdSchema,
  persistedEvidenceIdSchema as evidenceIdSchema,
  persistedRevisionIdSchema as revisionIdSchema,
  persistedRunIdSchema as runIdSchema,
  persistedSha256Schema as sha256Schema,
  persistedTaskIdSchema as taskIdSchema,
  persistedTimestampSchema as timestampSchema,
  repositoryCodePathSchema,
  requireCodeUnitSortedUnique,
  requireTimestampOrder,
  runLifecycleOwnerRefSchema,
  strictJsonValueSchema,
  type Capability,
} from './public.js';
import {
  EVIDENCE_RECORD_TYPES,
  EVIDENCE_STATUSES,
  repositoryWorkBasisSchema,
  taskFileSchema,
} from './change.js';

const prepareOwnerSchema = runLifecycleOwnerRefSchema.refine((owner) => owner.owner.kind === 'STAGE_PREPARE');
const completeOwnerSchema = runLifecycleOwnerRefSchema.refine((owner) => owner.owner.kind === 'STAGE_COMPLETE');
const failureOwnerSchema = runLifecycleOwnerRefSchema.refine((owner) => [
  'EVIDENCE_GENERIC', 'EVIDENCE_REVIEW_IMPORT', 'EVIDENCE_QA_IMPORT', 'EVIDENCE_CANARY_IMPORT', 'VERIFICATION_COMMAND',
].includes(owner.owner.kind));

const sortedStringArray = z.array(nonemptySingleLineSchema).superRefine((values, context) => requireCodeUnitSortedUnique(values, (value) => value, context, []));
const sortedTaskIdArray = z.array(taskIdSchema).superRefine((values, context) => requireCodeUnitSortedUnique(values, (value) => value, context, []));
const sortedEvidenceIdArray = z.array(evidenceIdSchema).superRefine((values, context) => requireCodeUnitSortedUnique(values, (value) => value, context, []));
const ordinalHashArray = z.array(sha256Schema).superRefine((values, context) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: 'custom', message: 'NATIVE_SCHEMA_MISMATCH: ordinal hash collection must be globally unique' });
  }
});

const repositoryWorkResultRawSchema = z.strictObject({
  prepared: repositoryWorkBasisSchema,
  completed: repositoryWorkBasisSchema,
  changedPaths: z.array(repositoryCodePathSchema).superRefine((values, context) => requireCodeUnitSortedUnique(values, (value) => value, context, [])),
  resultHash: sha256Schema,
}).superRefine((result, context) => {
  if (result.resultHash !== hObject({
    prepared: result.prepared,
    completed: result.completed,
    changedPaths: result.changedPaths,
  })) invalidAdjacentHash(context, 'resultHash');
});
export const repositoryWorkResultSchema = guardStrictPersistentInput(repositoryWorkResultRawSchema);

const repositoryRunLineageRawSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ROOT'), rootRunId: runIdSchema, abandonedFailureRunId: runIdSchema.nullable() }),
  z.strictObject({
    kind: z.literal('RETRY'),
    rootRunId: runIdSchema,
    retryOfRunId: runIdSchema,
    rootPreparedBasis: repositoryWorkBasisSchema,
    rootPreparedBasisHash: sha256Schema,
    retryStartBasis: repositoryWorkBasisSchema,
    retryStartBasisHash: sha256Schema,
    retryStartResult: repositoryWorkResultRawSchema,
  }).superRefine((lineage, context) => {
    if (lineage.rootPreparedBasisHash !== hObject(lineage.rootPreparedBasis)
      || lineage.retryStartBasisHash !== hObject(lineage.retryStartBasis)
      || hObject(lineage.retryStartResult.prepared) !== hObject(lineage.rootPreparedBasis)
      || hObject(lineage.retryStartResult.completed) !== hObject(lineage.retryStartBasis)) {
      invalidAdjacentHash(context, 'repositoryLineage');
    }
  }),
]);
export const repositoryRunLineageSchema = guardStrictPersistentInput(repositoryRunLineageRawSchema);

const repositoryFailureSnapshotRawSchema = z.strictObject({
  kind: z.literal('REPOSITORY_STAGE_FAILURE'),
  capability: z.enum(['work', 'simplify']),
  taskId: taskIdSchema.nullable(),
  rootRunId: runIdSchema,
  retryOfRunId: runIdSchema.nullable(),
  rootPreparedBasis: repositoryWorkBasisSchema,
  rootPreparedBasisHash: sha256Schema,
  failedBasis: repositoryWorkBasisSchema,
  failedBasisHash: sha256Schema,
  failedResult: repositoryWorkResultRawSchema,
  policyViolatingPaths: z.array(repositoryCodePathSchema).superRefine((values, context) => requireCodeUnitSortedUnique(values, (value) => value, context, [])),
}).superRefine((snapshot, context) => {
  if (snapshot.rootPreparedBasisHash !== hObject(snapshot.rootPreparedBasis)
    || snapshot.failedBasisHash !== hObject(snapshot.failedBasis)
    || hObject(snapshot.failedResult.prepared) !== hObject(snapshot.rootPreparedBasis)
    || hObject(snapshot.failedResult.completed) !== hObject(snapshot.failedBasis)) {
    invalidAdjacentHash(context, 'repositoryFailure');
  }
});
export const repositoryFailureSnapshotSchema = guardStrictPersistentInput(repositoryFailureSnapshotRawSchema);

const releaseArtifactIdentitySchema = z.strictObject({
  schemaVersion: z.literal(1),
  workflowVersion: z.literal('0.3.0'),
  authorityCatalogHash: sha256Schema,
  changeId: changeIdSchema,
  revision: revisionIdSchema,
  repositoryBasis: repositoryWorkBasisSchema,
  repositoryBasisHash: sha256Schema,
  delivery: z.strictObject({
    artifactAuthorityEntryId: z.literal('ship:DELIVERY'),
    role: z.literal('DELIVERY'),
    path: z.literal('delivery.md'),
    rawBytesHash: sha256Schema,
  }),
}).superRefine((identity, context) => {
  if (identity.repositoryBasisHash !== hObject(identity.repositoryBasis)) invalidAdjacentHash(context, 'repositoryBasisHash');
});

const releaseSubjectBindingSchema = z.strictObject({
  subject: z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal('DELIVERY_STAGE_COMPLETION'),
    changeId: changeIdSchema,
    revision: revisionIdSchema,
    shipRunId: runIdSchema,
    shipCompletion: z.strictObject({
      sequence: positiveSafeIntegerSchema,
      ownerKind: z.literal('STAGE_COMPLETE'),
      ownerId: runIdSchema,
      entryHash: sha256Schema,
      completedAt: timestampSchema,
    }),
    artifactIdentity: releaseArtifactIdentitySchema,
    artifactIdentityHash: sha256Schema,
  }),
  subjectHash: sha256Schema,
}).superRefine((binding, context) => {
  if (binding.subjectHash !== hObject(binding.subject)
    || binding.subject.artifactIdentityHash !== hObject(binding.subject.artifactIdentity)
    || binding.subject.shipCompletion.ownerId !== binding.subject.shipRunId
    || binding.subject.artifactIdentity.changeId !== binding.subject.changeId
    || binding.subject.artifactIdentity.revision !== binding.subject.revision) {
    invalidAdjacentHash(context, 'releaseSubjectBinding');
  }
});

const evidenceRequirementBaseShape = {
  requirementId: nonemptySingleLineSchema,
  producer: z.enum([
    'GENERIC_IMPORT', 'VERIFICATION_COMMAND', 'REVIEW_RESULT_IMPORT', 'QA_RESULT_IMPORT',
    'CANARY_MEASUREMENT_IMPORT', 'CANARY_RESULT_IMPORT',
  ]),
  allowedTypes: z.array(z.enum(EVIDENCE_RECORD_TYPES)).superRefine((values, context) => requireCodeUnitSortedUnique(values, (value) => value, context, [])),
  allowedStatuses: z.array(z.enum(EVIDENCE_STATUSES)).superRefine((values, context) => requireCodeUnitSortedUnique(values, (value) => value, context, [])),
  satisfyingStatus: z.literal('PASS'),
  outputPolicy: z.enum(['OPTIONAL', 'OWNED_OUTPUT_REQUIRED']),
  sourceScope: z.literal('RUN_BOUND'),
  subjectPolicy: z.literal('EXACT_RUN_SUBJECT'),
} satisfies z.ZodRawShape;
const evidenceRequirementRawSchema = z.union([
  z.strictObject({ ...evidenceRequirementBaseShape, taskScope: z.strictObject({ kind: z.literal('NONE') }), minimumRecords: positiveSafeIntegerSchema }),
  z.strictObject({ ...evidenceRequirementBaseShape, taskScope: z.strictObject({ kind: z.literal('SELECTED_TASK') }), minimumRecordsPerTask: positiveSafeIntegerSchema }),
  z.strictObject({ ...evidenceRequirementBaseShape, taskScope: z.strictObject({ kind: z.literal('TASK_DECLARED') }), minimumRecordsPerTask: positiveSafeIntegerSchema }),
  z.strictObject({ ...evidenceRequirementBaseShape, taskScope: z.strictObject({ kind: z.literal('EACH_VERIFICATION_TASK') }), minimumRecordsPerTask: positiveSafeIntegerSchema }),
]);
export const evidenceRequirementSchema = guardStrictPersistentInput(evidenceRequirementRawSchema);
export type EvidenceRequirementContract = z.output<typeof evidenceRequirementSchema>;

const verificationTaskRequirementSchema = z.strictObject({ taskId: taskIdSchema, requirementIds: sortedStringArray });
export const humanGateContractSchema = z.strictObject({
  gateId: nonemptySingleLineSchema,
  sourceScope: z.literal('RUN_BOUND'),
  approvedArtifactRole: nonemptySingleLineSchema.nullable(),
});
export const reviewPolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  specification: z.array(z.enum(['requirements', 'non-goals', 'observable-behavior'])),
  standards: z.array(z.enum(['business', 'domain', 'architecture', 'contract', 'engineering', 'data', 'security', 'performance', 'ux'])),
  riskProduction: z.array(z.enum(['migration', 'operability', 'rollback-forward-fix', 'runtime-health', 'delivery-risk'])),
});
export const reviewScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('TASK'), taskId: taskIdSchema, sourceTasksHash: sha256Schema, sourceTaskHash: sha256Schema, repositoryWorkHash: sha256Schema }),
  z.strictObject({ kind: z.literal('CHANGE'), sourceAuthorityHead: sha256Schema, repositoryWorkHash: sha256Schema }),
]);

// 背景：Review v1 曾把 lenses、两个汇总状态与带 default 的 findings 当成可持久模型，导致缺失
// 检查被默认吞掉，也无法把 finding 绑定到冻结的 axis/check/Evidence/waiver。目的：把规范 7.2.3
// 的 ReviewDraftV2 建成 domain 唯一 strict schema，Core importer 与 stage-completion 必须复用同一实例。
// 上下文：策略是否 exhaustive、Evidence 是否当前以及 waiver 是否为 RESOLVED human Decision 属于
// 已认证上下文验证，不能在只看到单一持久对象的 schema 层伪造。
export const reviewResultStatusSchema = z.enum(['PASS', 'CONCERNS', 'FAIL']);
const reviewEvidenceIdsSchema = z.array(evidenceIdSchema).superRefine((values, context) => {
  requireCodeUnitSortedUnique(values, (value) => value, context, []);
});
const reviewFindingBaseShape = {
  id: nonemptySingleLineSchema,
  severity: z.enum(['CRITICAL', 'IMPORTANT', 'MINOR']),
  status: z.enum(['OPEN', 'RESOLVED', 'ACCEPTED']),
  summary: nonemptySingleLineSchema,
  evidenceIds: reviewEvidenceIdsSchema,
  waiverDecisionId: decisionIdSchema.nullable(),
} satisfies z.ZodRawShape;
const specificationReviewCheckSchema = z.enum(['requirements', 'non-goals', 'observable-behavior']);
const standardsReviewCheckSchema = z.enum([
  'business', 'domain', 'architecture', 'contract', 'engineering', 'data', 'security', 'performance', 'ux',
]);
const riskProductionReviewCheckSchema = z.enum([
  'migration', 'operability', 'rollback-forward-fix', 'runtime-health', 'delivery-risk',
]);
function reviewCheckResultSchema<Schema extends z.ZodType>(check: Schema) {
  return z.strictObject({
    check,
    status: reviewResultStatusSchema,
    evidenceIds: reviewEvidenceIdsSchema,
    summary: nonemptySingleLineSchema,
  });
}
function reviewAxisSchema<Schema extends z.ZodType>(check: Schema) {
  return z.strictObject({
    status: reviewResultStatusSchema,
    checks: z.array(reviewCheckResultSchema(check)),
  });
}
const reviewDraftV2RawSchema = z.strictObject({
  schemaVersion: z.literal(2),
  changeId: changeIdSchema,
  revision: revisionIdSchema,
  runId: runIdSchema,
  scope: reviewScopeSchema,
  axes: z.strictObject({
    specification: reviewAxisSchema(specificationReviewCheckSchema),
    standards: reviewAxisSchema(standardsReviewCheckSchema),
    riskProduction: reviewAxisSchema(riskProductionReviewCheckSchema),
  }),
  findings: z.array(z.discriminatedUnion('axis', [
    z.strictObject({ ...reviewFindingBaseShape, axis: z.literal('SPECIFICATION'), check: specificationReviewCheckSchema }),
    z.strictObject({ ...reviewFindingBaseShape, axis: z.literal('STANDARDS'), check: standardsReviewCheckSchema }),
    z.strictObject({ ...reviewFindingBaseShape, axis: z.literal('RISK_PRODUCTION'), check: riskProductionReviewCheckSchema }),
  ])).superRefine((findings, context) => {
    requireCodeUnitSortedUnique(findings, (finding) => finding.id, context, []);
  }),
  conclusion: reviewResultStatusSchema,
}).superRefine((draft, context) => {
  requireCodeUnitSortedUnique(draft.axes.specification.checks, (row) => row.check, context, ['axes', 'specification', 'checks']);
  requireCodeUnitSortedUnique(draft.axes.standards.checks, (row) => row.check, context, ['axes', 'standards', 'checks']);
  requireCodeUnitSortedUnique(draft.axes.riskProduction.checks, (row) => row.check, context, ['axes', 'riskProduction', 'checks']);
});
export const reviewDraftV2Schema = guardStrictPersistentInput(reviewDraftV2RawSchema);
export type ReviewDraftV2ConstructionInput = z.input<typeof reviewDraftV2Schema>;
export type ReviewDraftV2 = z.output<typeof reviewDraftV2Schema>;

export const qaPolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  checks: z.tuple([z.strictObject({ checkId: nonemptySingleLineSchema, evidenceRequirementIds: sortedStringArray })]).rest(
    z.strictObject({ checkId: nonemptySingleLineSchema, evidenceRequirementIds: sortedStringArray }),
  ),
  findingVerdicts: z.strictObject({ CRITICAL: z.literal('FAIL'), IMPORTANT: z.literal('CONCERNS'), MINOR: z.literal('PASS') }),
});
const canaryThresholdSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('LTE'), limit: finiteNumberSchema }),
  z.strictObject({ kind: z.literal('GTE'), limit: finiteNumberSchema }),
  z.strictObject({ kind: z.literal('BETWEEN'), minimum: finiteNumberSchema, maximum: finiteNumberSchema })
    .refine((threshold) => threshold.minimum <= threshold.maximum, 'NATIVE_SCHEMA_MISMATCH: Canary BETWEEN threshold is invalid'),
]);
const canarySignalPolicySchema = z.strictObject({
  signalId: nonemptySingleLineSchema,
  unit: nonemptySingleLineSchema,
  threshold: canaryThresholdSchema,
  failureAction: z.enum(['PAUSE', 'ROLLBACK']),
  measurementRequirementId: nonemptySingleLineSchema,
  sourceEvidenceRequirementIds: z.tuple([nonemptySingleLineSchema]).rest(nonemptySingleLineSchema),
  aggregation: z.literal('EXACT_ONE'),
});
export const canaryPolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  minimumWindowSeconds: positiveSafeIntegerSchema,
  signals: z.tuple([canarySignalPolicySchema]).rest(canarySignalPolicySchema),
});
export const activeRouteSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scenarioId: z.enum(SCENARIO_IDS),
  requiredCapabilities: z.tuple([z.enum(CAPABILITIES)]).rest(z.enum(CAPABILITIES)),
  selectedOptionalCapabilities: z.array(z.enum(CAPABILITIES)),
  activeCapabilities: z.tuple([z.enum(CAPABILITIES)]).rest(z.enum(CAPABILITIES)),
  implementationRequired: z.boolean(),
}).superRefine((route, context) => {
  for (const [field, values] of [
    ['requiredCapabilities', route.requiredCapabilities],
    ['selectedOptionalCapabilities', route.selectedOptionalCapabilities],
    ['activeCapabilities', route.activeCapabilities],
  ] as const) {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', path: [field], message: 'NATIVE_SCHEMA_MISMATCH: active route capability collection must be unique' });
    }
  }
});
export const archiveGateSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scenarioId: z.enum(SCENARIO_IDS),
  activeRoute: activeRouteSchema,
  activeRouteHash: sha256Schema,
  requiredReadiness: z.array(z.strictObject({ capability: z.enum(CAPABILITIES), readinessKey: z.enum(READINESS_KEYS), status: z.literal('READY') })),
  tasksHash: sha256Schema,
  unfinishedTaskIds: sortedTaskIdArray,
  blockingDecisionIds: z.array(z.string().regex(/^DEC-(?!0000$)\d{4}$/)).superRefine((values, context) => requireCodeUnitSortedUnique(values, (value) => value, context, [])),
  nonterminalRunIds: z.array(runIdSchema).superRefine((values, context) => requireCodeUnitSortedUnique(values, (value) => value, context, [])),
}).superRefine((snapshot, context) => {
  if (snapshot.unfinishedTaskIds.length !== 0 || snapshot.blockingDecisionIds.length !== 0 || snapshot.nonterminalRunIds.length !== 0) {
    context.addIssue({ code: 'custom', message: 'NATIVE_SCHEMA_MISMATCH: archive gate must have no unfinished authority' });
  }
  if (snapshot.activeRouteHash !== hObject(snapshot.activeRoute)) invalidAdjacentHash(context, 'activeRouteHash');
});

const runOutputBindingRawSchema = z.union([
  z.strictObject({
    kind: z.literal('AUTHORED_FILE'),
    role: nonemptySingleLineSchema,
    path: changeArtifactPathSchema,
    scaffoldBinding: z.strictObject({
      templateId: nonemptySingleLineSchema,
      templateHash: sha256Schema,
      renderInputs: strictJsonValueSchema,
      renderedScaffoldHash: sha256Schema,
    }).nullable(),
  }),
  z.strictObject({ kind: z.literal('AUTHORED_DIRECTORY'), role: nonemptySingleLineSchema, path: changeArtifactDirectorySchema, minimumRegularFiles: nonnegativeSafeIntegerSchema }),
  z.strictObject({ kind: z.literal('TASKFILE_DRAFT'), role: z.literal('TASKFILE_DRAFT'), path: z.string().regex(/^stage-outputs\/RUN-(?!000000$)\d{6}\/tasks\.draft\.yaml$/) }),
  z.strictObject({ kind: z.literal('REVIEW_DRAFT'), role: z.literal('REVIEW_DRAFT'), path: z.string().regex(/^stage-outputs\/RUN-(?!000000$)\d{6}\/review\.draft\.json$/), schemaIdentity: z.literal('omnai.review-draft.v2') }),
  z.strictObject({ kind: z.literal('QA_DRAFT'), role: z.literal('QA_DRAFT'), path: z.string().regex(/^stage-outputs\/RUN-(?!000000$)\d{6}\/qa\.draft\.json$/), schemaIdentity: z.literal('omnai.qa-result-draft.v1') }),
  z.strictObject({ kind: z.literal('CANARY_DRAFT'), role: z.literal('CANARY_DRAFT'), path: z.string().regex(/^stage-outputs\/RUN-(?!000000$)\d{6}\/canary\.draft\.json$/), schemaIdentity: z.literal('omnai.canary-result-draft.v1') }),
  z.strictObject({ kind: z.literal('REPOSITORY_DIFF'), role: z.literal('IMPLEMENTATION_DIFF'), taskId: taskIdSchema, basis: repositoryWorkBasisSchema }),
  z.strictObject({ kind: z.literal('REPOSITORY_DIFF'), role: z.literal('SIMPLIFICATION_DIFF'), taskId: z.null(), basis: repositoryWorkBasisSchema }),
]);
export const runOutputBindingSchema = guardStrictPersistentInput(runOutputBindingRawSchema);
export type RunOutputBinding = z.output<typeof runOutputBindingSchema>;
export type VerificationTaskRequirementBinding = z.output<typeof verificationTaskRequirementSchema>;
export type HumanGateContract = z.output<typeof humanGateContractSchema>;
export type ReviewPolicySnapshot = z.output<typeof reviewPolicySchema>;
export type ReviewScope = z.output<typeof reviewScopeSchema>;
export type QaPolicySnapshot = z.output<typeof qaPolicySchema>;
export type CanaryPolicySnapshot = z.output<typeof canaryPolicySchema>;
export type ActiveCapabilityRouteV1 = z.output<typeof activeRouteSchema>;

const issuePredicateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('TRIAGE_STATE_IN'), values: z.array(z.enum(['needs-experiment', 'ready-for-debug', 'ready-for-fix', 'ready-for-human', 'wontfix'])) }),
  z.strictObject({ kind: z.literal('REPRODUCTION_IN'), values: z.array(z.enum(['confirmed', 'instrumentation-required'])) }),
  z.strictObject({ kind: z.literal('ROOT_CAUSE_IS'), value: z.literal('confirmed') }),
  z.strictObject({ kind: z.literal('FIX_STRATEGY_IN'), values: z.array(z.enum(['needs-experiment', 'ready'])) }),
]);

const runTerminalContractRawSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ARTIFACT_STAGE'), readinessKey: z.enum(READINESS_KEYS).nullable(), requiredOutputRoles: sortedStringArray }),
  z.strictObject({ kind: z.literal('PLAN_STAGE'), draftRole: z.literal('TASKFILE_DRAFT'), sourceTasksHash: sha256Schema, requireNonemptyWorkPlan: z.boolean() }),
  z.strictObject({ kind: z.literal('ISSUE_STAGE'), sourceIssueHash: sha256Schema, observedBasis: repositoryWorkBasisSchema, requiredIssuePredicates: z.array(issuePredicateSchema), evidenceRequirements: z.array(evidenceRequirementRawSchema), evidenceRequirementsHash: sha256Schema }),
  z.strictObject({
    kind: z.literal('WORK_STAGE'), taskId: taskIdSchema, sourceTasksHash: sha256Schema, sourceTaskHash: sha256Schema,
    basis: repositoryWorkBasisSchema, repositoryLineage: repositoryRunLineageRawSchema, repositoryLineageHash: sha256Schema,
    allowedRepositoryPaths: z.array(repositoryCodePathSchema).superRefine((values, context) => requireCodeUnitSortedUnique(values, (value) => value, context, [])),
    allowedRepositoryPathsHash: sha256Schema, requiredTaskStatus: z.literal('IMPLEMENTED'), requiredRepositoryDelta: z.literal('NON_EMPTY'),
    negativeEvidenceRecovery: z.strictObject({
      kind: z.literal('RESET_SELECTED_TASK_TO_READY'),
      allowedSourceStatuses: z.tuple([z.literal('READY'), z.literal('RUNNING'), z.literal('BLOCKED'), z.literal('IMPLEMENTED')]),
      targetStatus: z.literal('READY'),
      preserveAllOtherTaskFileFields: z.literal(true),
    }),
    evidenceRequirements: z.array(evidenceRequirementRawSchema), evidenceRequirementsHash: sha256Schema,
  }),
  z.strictObject({ kind: z.literal('SIMPLIFY_STAGE'), basis: repositoryWorkBasisSchema, repositoryLineage: repositoryRunLineageRawSchema, repositoryLineageHash: sha256Schema, requiredRepositoryDelta: z.literal('NON_EMPTY'), evidenceRequirements: z.array(evidenceRequirementRawSchema), evidenceRequirementsHash: sha256Schema }),
  z.strictObject({ kind: z.literal('REVIEW_STAGE'), evidenceRequirements: z.array(evidenceRequirementRawSchema), evidenceRequirementsHash: sha256Schema, reviewedBasis: repositoryWorkBasisSchema, reviewScope: reviewScopeSchema, reviewScopeHash: sha256Schema, reviewPolicy: reviewPolicySchema, reviewPolicyHash: sha256Schema, requiredHumanGates: z.array(humanGateContractSchema) }),
  z.strictObject({ kind: z.literal('VERIFY_STAGE'), evidenceRequirements: z.array(evidenceRequirementRawSchema), evidenceRequirementsHash: sha256Schema, verifiedBasis: repositoryWorkBasisSchema, sourceTasksHash: sha256Schema, verificationTaskIds: sortedTaskIdArray, verificationTaskRequirements: z.array(verificationTaskRequirementSchema), verificationTaskRequirementsHash: sha256Schema, targetTaskFile: taskFileSchema, targetTasksHash: sha256Schema, requiredHumanGates: z.array(humanGateContractSchema) }),
  z.strictObject({ kind: z.literal('QA_STAGE'), evidenceRequirements: z.array(evidenceRequirementRawSchema), evidenceRequirementsHash: sha256Schema, testedBasis: repositoryWorkBasisSchema, qaPolicy: qaPolicySchema, qaPolicyHash: sha256Schema, qaResultRequirementId: z.literal('qa-result'), requiredHumanGates: z.array(humanGateContractSchema) }),
  z.strictObject({ kind: z.literal('CANARY_STAGE'), evidenceRequirements: z.array(evidenceRequirementRawSchema), evidenceRequirementsHash: sha256Schema, releaseSubjectBinding: releaseSubjectBindingSchema, windowOpenedAt: timestampSchema, canaryPolicy: canaryPolicySchema, canaryPolicyHash: sha256Schema, canaryResultRequirementId: z.literal('canary-result'), requiredHumanGates: z.array(humanGateContractSchema) }),
  z.strictObject({ kind: z.literal('DELIVERY_STAGE'), deliveryRole: z.literal('DELIVERY'), deliveryBasis: repositoryWorkBasisSchema, evidenceRequirements: z.array(evidenceRequirementRawSchema), evidenceRequirementsHash: sha256Schema, requiredHumanGates: z.array(humanGateContractSchema) }),
  z.strictObject({ kind: z.literal('ARCHIVE_STAGE'), sourceMetadataHash: sha256Schema, requiredGateSnapshot: archiveGateSnapshotSchema, requiredGateSnapshotHash: sha256Schema }),
  z.strictObject({ kind: z.literal('RECONCILE_STAGE'), sourceRevision: revisionIdSchema, allowedTopLevelOwners: z.array(z.enum(['FLOW_ASSESSMENT', 'DECISION_RECONCILE', 'ORDINARY_RECONCILE', 'SCENARIO_RECLASSIFICATION'])), requireExactlyOne: z.literal(true) }),
]);
export const runTerminalContractSchema = guardStrictPersistentInput(runTerminalContractRawSchema);
export type RunTerminalContract = z.output<typeof runTerminalContractSchema>;

const runDescendantBindingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('RUN_ONLY') }),
  z.strictObject({ kind: z.literal('TASK_ID'), taskId: taskIdSchema }),
  z.strictObject({ kind: z.literal('EVIDENCE_REQUIREMENT'), requirementId: nonemptySingleLineSchema, taskId: taskIdSchema.nullable() }),
  z.strictObject({ kind: z.literal('HUMAN_GATE'), gateId: nonemptySingleLineSchema }),
]);
const runDescendantContractRawSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('COUNTED'),
    ownerKind: z.enum(['EVIDENCE_GENERIC', 'EVIDENCE_REVIEW_IMPORT', 'EVIDENCE_QA_IMPORT', 'EVIDENCE_CANARY_MEASUREMENT', 'EVIDENCE_CANARY_IMPORT', 'HUMAN_APPROVAL', 'VERIFICATION_COMMAND', 'FLOW_ASSESSMENT', 'DECISION_RECONCILE', 'ORDINARY_RECONCILE', 'SCENARIO_RECLASSIFICATION']),
    binding: runDescendantBindingSchema,
    minimum: nonnegativeSafeIntegerSchema,
    maximum: nonnegativeSafeIntegerSchema,
  }).superRefine((row, context) => {
    if (row.minimum > row.maximum) context.addIssue({ code: 'custom', path: ['maximum'], message: 'NATIVE_SCHEMA_MISMATCH: descendant count range is invalid' });
  }),
  z.strictObject({ kind: z.literal('TASK_WORK_SEQUENCE'), ownerKind: z.literal('TASK_WORK'), binding: z.strictObject({ kind: z.literal('TASK_ID'), taskId: taskIdSchema }), grammar: z.literal('START (BLOCK START)* IMPLEMENTED'), sourceStatus: z.literal('READY'), terminalStatus: z.literal('IMPLEMENTED') }),
  z.strictObject({ kind: z.literal('ISSUE_FINALIZATION_SEQUENCE'), ownerKind: z.literal('ISSUE_UPDATE'), binding: z.strictObject({ kind: z.literal('RUN_ONLY') }), grammar: z.literal('ALL_REQUIRED_EVIDENCE_PASS THEN ISSUE_UPDATE_LAST'), actionKind: z.enum(['TRIAGE_RESULT', 'REPRODUCTION_RESULT', 'DEBUG_RESULT']) }),
]);
export const runDescendantContractSchema = guardStrictPersistentInput(runDescendantContractRawSchema);
export type RunDescendantContract = z.output<typeof runDescendantContractSchema>;

const runAuthorityContractRawSchema = z.strictObject({
  schemaVersion: z.literal(3),
  changeId: changeIdSchema,
  runId: runIdSchema,
  capability: z.enum(CAPABILITIES),
  revision: revisionIdSchema,
  preparedFromAuthorityHead: sha256Schema,
  prepareOwner: prepareOwnerSchema,
  authoredOutputBindings: z.array(runOutputBindingRawSchema),
  allowedDescendants: z.array(runDescendantContractRawSchema),
  terminal: runTerminalContractRawSchema,
  terminalHash: sha256Schema,
}).superRefine((contract, context) => {
  requireCodeUnitSortedUnique(contract.authoredOutputBindings, (binding) => `${binding.kind}\u0000${'path' in binding ? binding.path : binding.role}`, context, ['authoredOutputBindings']);
  for (const binding of contract.authoredOutputBindings) {
    if ('path' in binding && binding.path.startsWith('stage-outputs/') && !binding.path.startsWith(`stage-outputs/${contract.runId}/`)) {
      context.addIssue({ code: 'custom', path: ['authoredOutputBindings'], message: 'NATIVE_SCHEMA_MISMATCH: Run output path does not match owning Run' });
    }
  }
  requireCodeUnitSortedUnique(contract.allowedDescendants, descendantKey, context, ['allowedDescendants']);
  if (contract.prepareOwner.owner.id !== contract.runId) {
    context.addIssue({ code: 'custom', path: ['prepareOwner', 'owner', 'id'], message: 'NATIVE_SCHEMA_MISMATCH: prepare owner must name its Run' });
  }
  if (contract.terminal.kind !== TERMINAL_BY_CAPABILITY[contract.capability]) {
    context.addIssue({ code: 'custom', path: ['terminal', 'kind'], message: 'NATIVE_SCHEMA_MISMATCH: capability and terminal kind disagree' });
  }
  if (contract.terminalHash !== hObject(contract.terminal)) {
    context.addIssue({ code: 'custom', path: ['terminalHash'], message: 'NATIVE_SCHEMA_MISMATCH: terminalHash is invalid' });
  }
  if ((contract.terminal.kind === 'WORK_STAGE' || contract.terminal.kind === 'SIMPLIFY_STAGE')
    && contract.terminal.repositoryLineage.kind === 'ROOT'
    && contract.terminal.repositoryLineage.rootRunId !== contract.runId) {
    context.addIssue({ code: 'custom', path: ['terminal', 'repositoryLineage', 'rootRunId'], message: 'NATIVE_SCHEMA_MISMATCH: root repository lineage must name the owning Run' });
  }
  if (contract.terminal.kind === 'REVIEW_STAGE'
    && contract.terminal.reviewScope.kind === 'CHANGE'
    && contract.terminal.reviewScope.sourceAuthorityHead !== contract.preparedFromAuthorityHead) {
    context.addIssue({ code: 'custom', path: ['terminal', 'reviewScope', 'sourceAuthorityHead'], message: 'NATIVE_SCHEMA_MISMATCH: Change review scope must bind the prepared authority head' });
  }
  validateTerminalContract(contract.terminal, contract.capability, context);
  validateOutputContract(contract, context);
  const expectedDescendants = expectedDescendantContracts(contract.terminal, contract.capability, context);
  if (expectedDescendants !== null && hObject(contract.allowedDescendants) !== hObject(expectedDescendants)) {
    context.addIssue({ code: 'custom', path: ['allowedDescendants'], message: 'NATIVE_SCHEMA_MISMATCH: Run descendant contract is not the closed terminal projection' });
  }
});
export const runAuthorityContractSchema = guardStrictPersistentInput(runAuthorityContractRawSchema);
export type RunAuthorityContractConstructionInput = z.input<typeof runAuthorityContractSchema>;
export type RunAuthorityContract = z.output<typeof runAuthorityContractSchema>;

const promptProtocolBindingRawSchema = z.strictObject({
  id: nonemptySingleLineSchema,
  version: positiveSafeIntegerSchema,
  relativePath: z.string().regex(/^resources\/protocols\/.+\.md$/),
  rawBytesHash: sha256Schema,
});
export const promptProtocolBindingSchema = guardStrictPersistentInput(promptProtocolBindingRawSchema);
const runPromptBindingRawSchema = z.strictObject({
  path: z.string().regex(/^runs\/RUN-(?!000000$)\d{6}\/prompt\.md$/),
  rendererId: z.literal('prompt-render-v1'),
  rendererHash: sha256Schema,
  rawBytesHash: sha256Schema,
  instructionHash: sha256Schema,
  contextBindingsHash: sha256Schema,
  protocolBindings: z.tuple([promptProtocolBindingRawSchema, promptProtocolBindingRawSchema]),
  protocolBindingsHash: sha256Schema,
  renderInputHash: sha256Schema,
}).superRefine((prompt, context) => {
  requireCodeUnitSortedUnique(prompt.protocolBindings, (binding) => binding.id, context, ['protocolBindings']);
  if (prompt.protocolBindingsHash !== hObject(prompt.protocolBindings)) invalidAdjacentHash(context, 'protocolBindingsHash');
});
export const runPromptBindingSchema = guardStrictPersistentInput(runPromptBindingRawSchema);

const terminalSatisfactionSchema = z.strictObject({
  evidence: z.array(z.strictObject({ requirementId: nonemptySingleLineSchema, taskId: taskIdSchema.nullable(), evidenceIds: z.tuple([evidenceIdSchema]).rest(evidenceIdSchema) })),
  gates: z.array(z.strictObject({ gateId: nonemptySingleLineSchema, evidenceId: evidenceIdSchema })),
});
const runOutputObservationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('FILE'), role: nonemptySingleLineSchema, path: changeArtifactPathSchema, rawBytesHash: sha256Schema }),
  z.strictObject({ kind: z.literal('DIRECTORY'), role: nonemptySingleLineSchema, path: changeArtifactPathSchema, regularFileCount: nonnegativeSafeIntegerSchema, regularFiles: z.array(z.strictObject({ path: changeArtifactPathSchema, rawBytesHash: sha256Schema })), regularFilesTreeHash: sha256Schema }),
]);
const terminalProofShape = {
  terminalHash: sha256Schema,
  descendantEntryHashes: ordinalHashArray,
  descendantEntryHashesHash: sha256Schema,
  satisfaction: terminalSatisfactionSchema,
  satisfactionHash: sha256Schema,
  outputObservations: z.array(runOutputObservationSchema),
  outputObservationsHash: sha256Schema,
} satisfies z.ZodRawShape;

const stageTerminalResultRawSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...terminalProofShape, kind: z.literal('ARTIFACT_STAGE') }),
  z.strictObject({ ...terminalProofShape, kind: z.literal('PLAN_STAGE'), draftRawBytesHash: sha256Schema, sourceTasksHash: sha256Schema, targetTasksHash: sha256Schema }),
  z.strictObject({ ...terminalProofShape, kind: z.literal('ISSUE_STAGE'), sourceIssueHash: sha256Schema, targetIssueHash: sha256Schema, observedBasisHash: sha256Schema }),
  z.strictObject({ ...terminalProofShape, kind: z.literal('WORK_STAGE'), taskId: taskIdSchema, sourceTasksHash: sha256Schema, targetTasksHash: sha256Schema, repositoryWorkResult: repositoryWorkResultRawSchema }),
  z.strictObject({ ...terminalProofShape, kind: z.literal('SIMPLIFY_STAGE'), repositoryWorkResult: repositoryWorkResultRawSchema }),
  z.strictObject({ ...terminalProofShape, kind: z.literal('REVIEW_STAGE'), reviewedBasisHash: sha256Schema, aggregateEvidenceId: evidenceIdSchema, aggregateEvidenceRecordHash: sha256Schema }),
  z.strictObject({ ...terminalProofShape, kind: z.literal('VERIFY_STAGE'), verifiedBasisHash: sha256Schema, sourceTasksHash: sha256Schema, targetTasksHash: sha256Schema }),
  z.strictObject({ ...terminalProofShape, kind: z.literal('QA_STAGE'), testedBasisHash: sha256Schema, aggregateEvidenceId: evidenceIdSchema, aggregateEvidenceRecordHash: sha256Schema }),
  z.strictObject({ ...terminalProofShape, kind: z.literal('CANARY_STAGE'), releaseSubjectHash: sha256Schema, measurementEvidenceIds: sortedEvidenceIdArray, aggregateEvidenceId: evidenceIdSchema, aggregateEvidenceRecordHash: sha256Schema, windowClosedAt: timestampSchema, decision: z.literal('CONTINUE') }),
  z.strictObject({ ...terminalProofShape, kind: z.literal('DELIVERY_STAGE'), deliveryBasisHash: sha256Schema, releaseArtifactIdentity: releaseArtifactIdentitySchema, releaseArtifactIdentityHash: sha256Schema, approvalEvidenceId: evidenceIdSchema }),
  z.strictObject({ ...terminalProofShape, kind: z.literal('ARCHIVE_STAGE'), sourceMetadataHash: sha256Schema, targetMetadataHash: sha256Schema, requiredGateSnapshotHash: sha256Schema }),
  z.strictObject({ ...terminalProofShape, kind: z.literal('RECONCILE_STAGE'), sourceRevision: revisionIdSchema, targetRevision: revisionIdSchema, selectedOwner: z.strictObject({ kind: z.enum(['FLOW_ASSESSMENT', 'DECISION_RECONCILE', 'ORDINARY_RECONCILE', 'SCENARIO_RECLASSIFICATION']), entryHash: sha256Schema }) }),
]).superRefine((result, context) => {
  if (result.descendantEntryHashesHash !== hObject(result.descendantEntryHashes)) invalidAdjacentHash(context, 'descendantEntryHashesHash');
  if (result.satisfactionHash !== hObject(result.satisfaction)) invalidAdjacentHash(context, 'satisfactionHash');
  if (result.outputObservationsHash !== hObject(result.outputObservations)) invalidAdjacentHash(context, 'outputObservationsHash');
  requireCodeUnitSortedUnique(result.satisfaction.evidence, satisfactionEvidenceKey, context, ['satisfaction', 'evidence']);
  const evidenceIds: string[] = [];
  for (const row of result.satisfaction.evidence) {
    requireCodeUnitSortedUnique(row.evidenceIds, (value) => value, context, ['satisfaction', 'evidence']);
    evidenceIds.push(...row.evidenceIds);
  }
  evidenceIds.push(...result.satisfaction.gates.map((gate) => gate.evidenceId));
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    context.addIssue({ code: 'custom', path: ['satisfaction'], message: 'NATIVE_SCHEMA_MISMATCH: one Evidence receipt cannot satisfy multiple requirements or gates' });
  }
  requireCodeUnitSortedUnique(result.satisfaction.gates, (gate) => gate.gateId, context, ['satisfaction', 'gates']);
});
export const stageTerminalResultSchema = guardStrictPersistentInput(stageTerminalResultRawSchema);
export type StageTerminalResultV1 = z.output<typeof stageTerminalResultSchema>;

const stageRunManifestBaseShape = {
  schemaVersion: z.literal(3),
  workflowVersion: z.literal('0.3.0'),
  authorityCatalogHash: sha256Schema,
  runId: runIdSchema,
  changeId: changeIdSchema,
  revision: revisionIdSchema,
  capability: z.enum(CAPABILITIES),
  preparedAt: timestampSchema,
  prepareOwner: prepareOwnerSchema,
  prompt: runPromptBindingRawSchema,
  authorityContract: runAuthorityContractRawSchema,
  authorityContractHash: sha256Schema,
} satisfies z.ZodRawShape;

const stageRunManifestRawSchema = z.discriminatedUnion('disposition', [
  z.strictObject({ ...stageRunManifestBaseShape, disposition: z.literal('PREPARED') }),
  z.strictObject({
    ...stageRunManifestBaseShape,
    disposition: z.literal('EVIDENCE_FAILED'),
    failedAt: timestampSchema,
    failureOwner: failureOwnerSchema,
    failure: z.strictObject({ ordinal: positiveSafeIntegerSchema, evidenceId: evidenceIdSchema, evidenceRecordHash: sha256Schema, requirementId: nonemptySingleLineSchema, taskId: taskIdSchema.nullable(), status: z.enum(['FAIL', 'INCONCLUSIVE']), subjectHash: sha256Schema }),
    failureHash: sha256Schema,
    repositoryFailure: repositoryFailureSnapshotRawSchema.nullable(),
    repositoryFailureHash: sha256Schema,
    failureRecovery: z.strictObject({ kind: z.literal('WORK_TASK_RESET_TO_READY'), taskId: taskIdSchema, sourceTasksHash: sha256Schema, targetTasksHash: sha256Schema }).nullable(),
    failureRecoveryHash: sha256Schema,
  }),
  z.strictObject({
    ...stageRunManifestBaseShape,
    disposition: z.literal('COMPLETED'),
    completedAt: timestampSchema,
    completionOwner: completeOwnerSchema,
    terminalResult: stageTerminalResultRawSchema,
    terminalResultHash: sha256Schema,
  }),
]).superRefine((manifest, context) => {
  if (manifest.runId !== manifest.authorityContract.runId || manifest.changeId !== manifest.authorityContract.changeId || manifest.revision !== manifest.authorityContract.revision || manifest.capability !== manifest.authorityContract.capability) {
    context.addIssue({ code: 'custom', path: ['authorityContract'], message: 'NATIVE_SCHEMA_MISMATCH: manifest identity must match authority contract' });
  }
  if (!manifest.prompt.path.startsWith(`runs/${manifest.runId}/`)) {
    context.addIssue({ code: 'custom', path: ['prompt', 'path'], message: 'NATIVE_SCHEMA_MISMATCH: prompt path must match Run ID' });
  }
  if (manifest.prepareOwner.owner.id !== manifest.runId
    || hObject(manifest.prepareOwner) !== hObject(manifest.authorityContract.prepareOwner)) {
    context.addIssue({ code: 'custom', path: ['prepareOwner'], message: 'NATIVE_SCHEMA_MISMATCH: manifest and contract prepare owners disagree' });
  }
  if (manifest.authorityContractHash !== hObject(manifest.authorityContract)) {
    context.addIssue({ code: 'custom', path: ['authorityContractHash'], message: 'NATIVE_SCHEMA_MISMATCH: authorityContractHash is invalid' });
  }
  if (manifest.prompt.protocolBindingsHash !== hObject(manifest.prompt.protocolBindings)) {
    context.addIssue({ code: 'custom', path: ['prompt', 'protocolBindingsHash'], message: 'NATIVE_SCHEMA_MISMATCH: protocolBindingsHash is invalid' });
  }
  if (manifest.disposition === 'EVIDENCE_FAILED') validateFailedManifest(manifest, context);
  if (manifest.disposition === 'COMPLETED') validateCompletedManifest(manifest, context);
});
export const stageRunManifestSchema = guardStrictPersistentInput(stageRunManifestRawSchema);
export type StageRunManifestConstructionInput = z.input<typeof stageRunManifestSchema>;
export type StageRunManifestV3 = z.output<typeof stageRunManifestSchema>;
export type StageRunManifest = StageRunManifestV3;

const TERMINAL_BY_CAPABILITY: Readonly<Record<Capability, RunTerminalContract['kind']>> = {
  frame: 'ARTIFACT_STAGE', research: 'ARTIFACT_STAGE', map: 'ARTIFACT_STAGE', model: 'ARTIFACT_STAGE',
  spec: 'ARTIFACT_STAGE', design: 'ARTIFACT_STAGE', plan: 'PLAN_STAGE', triage: 'ISSUE_STAGE',
  reproduce: 'ISSUE_STAGE', debug: 'ISSUE_STAGE', diagnose: 'ARTIFACT_STAGE', experiment: 'ARTIFACT_STAGE',
  fix: 'ARTIFACT_STAGE', mitigate: 'ARTIFACT_STAGE', work: 'WORK_STAGE', simplify: 'SIMPLIFY_STAGE',
  review: 'REVIEW_STAGE', verify: 'VERIFY_STAGE', qa: 'QA_STAGE', ship: 'DELIVERY_STAGE',
  canary: 'CANARY_STAGE', learn: 'ARTIFACT_STAGE', archive: 'ARCHIVE_STAGE', reconcile: 'RECONCILE_STAGE',
};

const READINESS_BY_ARTIFACT_CAPABILITY: Readonly<Partial<Record<Capability, (typeof READINESS_KEYS)[number]>>> = {
  frame: 'frame', research: 'research', map: 'map', model: 'domain', spec: 'spec', design: 'design',
  diagnose: 'diagnosis', experiment: 'experiment', fix: 'fix', mitigate: 'mitigation', learn: 'learning',
};

const OWNER_BY_EVIDENCE_PRODUCER = {
  GENERIC_IMPORT: 'EVIDENCE_GENERIC',
  VERIFICATION_COMMAND: 'VERIFICATION_COMMAND',
  REVIEW_RESULT_IMPORT: 'EVIDENCE_REVIEW_IMPORT',
  QA_RESULT_IMPORT: 'EVIDENCE_QA_IMPORT',
  CANARY_MEASUREMENT_IMPORT: 'EVIDENCE_CANARY_MEASUREMENT',
  CANARY_RESULT_IMPORT: 'EVIDENCE_CANARY_IMPORT',
} as const;

type EvidenceRequirement = z.output<typeof evidenceRequirementSchema>;
type HumanGate = z.output<typeof humanGateContractSchema>;
type TerminalContract = z.output<typeof runTerminalContractSchema>;
type AuthorityContract = z.output<typeof runAuthorityContractSchema>;
type Manifest = z.output<typeof stageRunManifestSchema>;
type CompletedManifest = Extract<Manifest, { disposition: 'COMPLETED' }>;
type FailedManifest = Extract<Manifest, { disposition: 'EVIDENCE_FAILED' }>;

function validateTerminalContract(terminal: TerminalContract, capability: Capability, context: z.RefinementCtx): void {
  if (terminal.kind === 'ARTIFACT_STAGE') {
    requireCodeUnitSortedUnique(terminal.requiredOutputRoles, (value) => value, context, ['terminal', 'requiredOutputRoles']);
    if (terminal.readinessKey !== READINESS_BY_ARTIFACT_CAPABILITY[capability]) {
      context.addIssue({ code: 'custom', path: ['terminal', 'readinessKey'], message: 'NATIVE_SCHEMA_MISMATCH: artifact readiness does not match capability' });
    }
  }

  const requirements = terminalEvidenceRequirements(terminal);
  requireCodeUnitSortedUnique(requirements, (requirement) => requirement.requirementId, context, ['terminal', 'evidenceRequirements']);
  for (const [index, requirement] of requirements.entries()) validateEvidenceRequirement(requirement, context, index);
  if ('evidenceRequirementsHash' in terminal && terminal.evidenceRequirementsHash !== hObject(requirements)) {
    context.addIssue({ code: 'custom', path: ['terminal', 'evidenceRequirementsHash'], message: 'NATIVE_SCHEMA_MISMATCH: evidenceRequirementsHash is invalid' });
  }

  const gates = terminalHumanGates(terminal);
  requireCodeUnitSortedUnique(gates, (gate) => gate.gateId, context, ['terminal', 'requiredHumanGates']);

  if (terminal.kind === 'ISSUE_STAGE') {
    if (terminal.evidenceRequirementsHash !== hObject(terminal.evidenceRequirements)) invalidAdjacentHash(context, 'evidenceRequirementsHash');
  }
  if (terminal.kind === 'WORK_STAGE') {
    if (terminal.repositoryLineageHash !== hObject(terminal.repositoryLineage)
      || terminal.allowedRepositoryPathsHash !== hObject(terminal.allowedRepositoryPaths)) {
      invalidAdjacentHash(context, 'repositoryLineageHash');
    }
    const lineage = terminal.repositoryLineage;
    if (lineage.kind === 'RETRY' && hObject(lineage.rootPreparedBasis) !== hObject(terminal.basis)) {
      context.addIssue({ code: 'custom', path: ['terminal', 'repositoryLineage'], message: 'NATIVE_SCHEMA_MISMATCH: retry root basis must equal terminal basis' });
    }
  }
  if (terminal.kind === 'SIMPLIFY_STAGE' && terminal.repositoryLineageHash !== hObject(terminal.repositoryLineage)) {
    invalidAdjacentHash(context, 'repositoryLineageHash');
  }

  if (terminal.kind === 'REVIEW_STAGE') {
    if (terminal.reviewScopeHash !== hObject(terminal.reviewScope) || terminal.reviewPolicyHash !== hObject(terminal.reviewPolicy)) invalidAdjacentHash(context, 'reviewPolicyHash');
    if (terminal.reviewScope.repositoryWorkHash !== hObject(terminal.reviewedBasis)) invalidAdjacentHash(context, 'reviewScope');
    requireCodeUnitSortedUnique(terminal.reviewPolicy.specification, (value) => value, context, ['terminal', 'reviewPolicy', 'specification']);
    requireCodeUnitSortedUnique(terminal.reviewPolicy.standards, (value) => value, context, ['terminal', 'reviewPolicy', 'standards']);
    requireCodeUnitSortedUnique(terminal.reviewPolicy.riskProduction, (value) => value, context, ['terminal', 'reviewPolicy', 'riskProduction']);
  }
  if (terminal.kind === 'VERIFY_STAGE') {
    requireCodeUnitSortedUnique(terminal.verificationTaskRequirements, (binding) => binding.taskId, context, ['terminal', 'verificationTaskRequirements']);
    for (const binding of terminal.verificationTaskRequirements) {
      requireCodeUnitSortedUnique(binding.requirementIds, (value) => value, context, ['terminal', 'verificationTaskRequirements']);
    }
    if (hObject(terminal.verificationTaskIds) !== hObject(terminal.verificationTaskRequirements.map((binding) => binding.taskId))) {
      context.addIssue({ code: 'custom', path: ['terminal', 'verificationTaskRequirements'], message: 'NATIVE_SCHEMA_MISMATCH: verification Task bindings must cover every verification Task' });
    }
    if (terminal.verificationTaskRequirementsHash !== hObject(terminal.verificationTaskRequirements)
      || terminal.targetTasksHash !== hObject(terminal.targetTaskFile)) invalidAdjacentHash(context, 'verificationTaskRequirementsHash');
  }
  if (terminal.kind === 'QA_STAGE') {
    requireCodeUnitSortedUnique(terminal.qaPolicy.checks, (check) => check.checkId, context, ['terminal', 'qaPolicy', 'checks']);
    for (const check of terminal.qaPolicy.checks) {
      if (check.evidenceRequirementIds.length === 0) context.addIssue({ code: 'custom', path: ['terminal', 'qaPolicy', 'checks'], message: 'NATIVE_SCHEMA_MISMATCH: QA check support cannot be empty' });
    }
    if (terminal.qaPolicyHash !== hObject(terminal.qaPolicy)) invalidAdjacentHash(context, 'qaPolicyHash');
  }
  if (terminal.kind === 'CANARY_STAGE') {
    requireCodeUnitSortedUnique(terminal.canaryPolicy.signals, (signal) => signal.signalId, context, ['terminal', 'canaryPolicy', 'signals']);
    requireCodeUnitSortedUnique(terminal.canaryPolicy.signals, (signal) => signal.measurementRequirementId, context, ['terminal', 'canaryPolicy', 'signals']);
    for (const [index, signal] of terminal.canaryPolicy.signals.entries()) {
      requireCodeUnitSortedUnique(signal.sourceEvidenceRequirementIds, (value) => value, context, ['terminal', 'canaryPolicy', 'signals', index, 'sourceEvidenceRequirementIds']);
    }
    if (terminal.canaryPolicyHash !== hObject(terminal.canaryPolicy)) invalidAdjacentHash(context, 'canaryPolicyHash');
    validateReleaseSubjectBinding(terminal.releaseSubjectBinding, context);
  }
  if (terminal.kind === 'ARCHIVE_STAGE' && terminal.requiredGateSnapshotHash !== hObject(terminal.requiredGateSnapshot)) {
    invalidAdjacentHash(context, 'requiredGateSnapshotHash');
  }
  if (terminal.kind === 'RECONCILE_STAGE') {
    requireCodeUnitSortedUnique(terminal.allowedTopLevelOwners, (owner) => owner, context, ['terminal', 'allowedTopLevelOwners']);
  }

  validateStageRequirementMatrix(terminal, context);
}

function validateEvidenceRequirement(requirement: EvidenceRequirement, context: z.RefinementCtx, index: number): void {
  requireCodeUnitSortedUnique(requirement.allowedTypes, (value) => value, context, ['terminal', 'evidenceRequirements', index, 'allowedTypes']);
  requireCodeUnitSortedUnique(requirement.allowedStatuses, (value) => value, context, ['terminal', 'evidenceRequirements', index, 'allowedStatuses']);
  if (hObject(requirement.allowedStatuses) !== hObject(['FAIL', 'INCONCLUSIVE', 'PASS'])
    || requirement.allowedTypes.length === 0
    || !requirement.allowedStatuses.includes(requirement.satisfyingStatus)) {
    context.addIssue({ code: 'custom', path: ['terminal', 'evidenceRequirements', index, 'allowedStatuses'], message: 'NATIVE_SCHEMA_MISMATCH: Evidence status contract is invalid' });
  }
  const fixed = requirement.producer === 'REVIEW_RESULT_IMPORT'
    ? { id: 'repository-review', types: ['review'] }
    : requirement.producer === 'QA_RESULT_IMPORT'
      ? { id: 'qa-result', types: ['qa'] }
      : requirement.producer === 'CANARY_RESULT_IMPORT'
        ? { id: 'canary-result', types: ['runtime'] }
        : null;
  if (fixed !== null && (requirement.requirementId !== fixed.id
    || hObject(requirement.allowedTypes) !== hObject(fixed.types)
    || requirement.outputPolicy !== 'OWNED_OUTPUT_REQUIRED')) {
    context.addIssue({ code: 'custom', path: ['terminal', 'evidenceRequirements', index], message: 'NATIVE_SCHEMA_MISMATCH: reserved aggregate Evidence contract is invalid' });
  }
  if (requirement.producer === 'CANARY_MEASUREMENT_IMPORT'
    && (hObject(requirement.allowedTypes) !== hObject(['runtime']) || requirement.outputPolicy !== 'OWNED_OUTPUT_REQUIRED')) {
    context.addIssue({ code: 'custom', path: ['terminal', 'evidenceRequirements', index], message: 'NATIVE_SCHEMA_MISMATCH: Canary measurement contract is invalid' });
  }
}

function validateStageRequirementMatrix(terminal: TerminalContract, context: z.RefinementCtx): void {
  const requirements = terminalEvidenceRequirements(terminal);
  const byId = new Map(requirements.map((requirement) => [requirement.requirementId, requirement]));
  const resultProducers = new Set(['REVIEW_RESULT_IMPORT', 'QA_RESULT_IMPORT', 'CANARY_RESULT_IMPORT']);
  const expectedResultProducer = terminal.kind === 'REVIEW_STAGE' ? 'REVIEW_RESULT_IMPORT'
    : terminal.kind === 'QA_STAGE' ? 'QA_RESULT_IMPORT'
      : terminal.kind === 'CANARY_STAGE' ? 'CANARY_RESULT_IMPORT'
        : null;
  const resultRequirements = requirements.filter((requirement) => resultProducers.has(requirement.producer));
  if ((expectedResultProducer === null && resultRequirements.length !== 0)
    || (expectedResultProducer !== null && (resultRequirements.length !== 1 || resultRequirements[0]?.producer !== expectedResultProducer))) {
    context.addIssue({ code: 'custom', path: ['terminal', 'evidenceRequirements'], message: 'NATIVE_SCHEMA_MISMATCH: stage aggregate Evidence producer set is invalid' });
  }

  if (terminal.kind === 'REVIEW_STAGE') {
    const aggregate = byId.get('repository-review');
    const expectedTaskKind = terminal.reviewScope.kind === 'TASK' ? 'SELECTED_TASK' : 'NONE';
    if (aggregate === undefined || aggregate.producer !== 'REVIEW_RESULT_IMPORT'
      || aggregate.taskScope.kind !== expectedTaskKind || requirementCount(aggregate) !== 1) invalidRequirementMatrix(context);
  }
  if (terminal.kind === 'QA_STAGE') {
    const aggregate = byId.get(terminal.qaResultRequirementId);
    if (aggregate === undefined || aggregate.producer !== 'QA_RESULT_IMPORT'
      || aggregate.taskScope.kind !== 'NONE' || requirementCount(aggregate) !== 1) invalidRequirementMatrix(context);
    for (const check of terminal.qaPolicy.checks) {
      for (const requirementId of check.evidenceRequirementIds) {
        const support = byId.get(requirementId);
        if (support === undefined || (support.producer !== 'GENERIC_IMPORT' && support.producer !== 'VERIFICATION_COMMAND')) invalidRequirementMatrix(context);
      }
    }
  }
  if (terminal.kind === 'CANARY_STAGE') {
    const aggregate = byId.get(terminal.canaryResultRequirementId);
    if (aggregate === undefined || aggregate.producer !== 'CANARY_RESULT_IMPORT'
      || aggregate.taskScope.kind !== 'NONE' || requirementCount(aggregate) !== 1) invalidRequirementMatrix(context);
    const namedMeasurements = new Set<string>();
    for (const signal of terminal.canaryPolicy.signals) {
      namedMeasurements.add(signal.measurementRequirementId);
      const measurement = byId.get(signal.measurementRequirementId);
      if (measurement === undefined || measurement.producer !== 'CANARY_MEASUREMENT_IMPORT'
        || measurement.taskScope.kind !== 'NONE' || requirementCount(measurement) !== 1) invalidRequirementMatrix(context);
      for (const requirementId of signal.sourceEvidenceRequirementIds) {
        const support = byId.get(requirementId);
        if (support === undefined || (support.producer !== 'GENERIC_IMPORT' && support.producer !== 'VERIFICATION_COMMAND')) invalidRequirementMatrix(context);
      }
    }
    if (requirements.some((requirement) => requirement.producer === 'CANARY_MEASUREMENT_IMPORT'
      && !namedMeasurements.has(requirement.requirementId))) invalidRequirementMatrix(context);
    requireTimestampOrder(
      terminal.releaseSubjectBinding.subject.shipCompletion.completedAt,
      terminal.windowOpenedAt,
      context,
      ['terminal', 'windowOpenedAt'],
    );
  }
}

function requirementCount(requirement: EvidenceRequirement): number {
  return 'minimumRecords' in requirement ? requirement.minimumRecords : requirement.minimumRecordsPerTask;
}

function invalidRequirementMatrix(context: z.RefinementCtx): void {
  context.addIssue({ code: 'custom', path: ['terminal', 'evidenceRequirements'], message: 'NATIVE_SCHEMA_MISMATCH: stage Evidence requirement matrix is invalid' });
}

function validateOutputContract(contract: AuthorityContract, context: z.RefinementCtx): void {
  requireCodeUnitSortedUnique(contract.authoredOutputBindings, (binding) => binding.role, context, ['authoredOutputBindings']);
  const roles = contract.authoredOutputBindings.map((binding) => binding.role);
  const terminal = contract.terminal;
  if (terminal.kind === 'ARTIFACT_STAGE' && hObject(roles) !== hObject(terminal.requiredOutputRoles)) {
    context.addIssue({ code: 'custom', path: ['authoredOutputBindings'], message: 'NATIVE_SCHEMA_MISMATCH: artifact output roles do not match terminal' });
  }
  if (terminal.kind === 'PLAN_STAGE' && !hasOnlyOutputKind(contract, 'TASKFILE_DRAFT')) invalidOutput(context);
  if (terminal.kind === 'WORK_STAGE' && !(contract.authoredOutputBindings.length === 1
    && contract.authoredOutputBindings[0]?.kind === 'REPOSITORY_DIFF'
    && contract.authoredOutputBindings[0].role === 'IMPLEMENTATION_DIFF'
    && contract.authoredOutputBindings[0].taskId === terminal.taskId
    && hObject(contract.authoredOutputBindings[0].basis) === hObject(terminal.basis))) invalidOutput(context);
  if (terminal.kind === 'SIMPLIFY_STAGE' && !(contract.authoredOutputBindings.length === 1
    && contract.authoredOutputBindings[0]?.kind === 'REPOSITORY_DIFF'
    && contract.authoredOutputBindings[0].role === 'SIMPLIFICATION_DIFF'
    && hObject(contract.authoredOutputBindings[0].basis) === hObject(terminal.basis))) invalidOutput(context);
  if (terminal.kind === 'REVIEW_STAGE' && !hasOnlyOutputKind(contract, 'REVIEW_DRAFT')) invalidOutput(context);
  if (terminal.kind === 'QA_STAGE' && !hasOnlyOutputKind(contract, 'QA_DRAFT')) invalidOutput(context);
  if (terminal.kind === 'CANARY_STAGE' && !hasOnlyOutputKind(contract, 'CANARY_DRAFT')) invalidOutput(context);
  if (terminal.kind === 'DELIVERY_STAGE' && hObject(roles) !== hObject([terminal.deliveryRole])) invalidOutput(context);
  if ((terminal.kind === 'VERIFY_STAGE' || terminal.kind === 'ARCHIVE_STAGE' || terminal.kind === 'RECONCILE_STAGE')
    && contract.authoredOutputBindings.length !== 0) invalidOutput(context);
  for (const gate of terminalHumanGates(terminal)) {
    if (gate.approvedArtifactRole !== null && !roles.includes(gate.approvedArtifactRole)) {
      context.addIssue({ code: 'custom', path: ['terminal', 'requiredHumanGates'], message: 'NATIVE_SCHEMA_MISMATCH: Human gate artifact role is not an authored output' });
    }
  }
}

function expectedDescendantContracts(
  terminal: TerminalContract,
  capability: Capability,
  context: z.RefinementCtx,
): Array<z.input<typeof runDescendantContractSchema>> | null {
  const rows: Array<z.input<typeof runDescendantContractSchema>> = [];
  for (const requirement of terminalEvidenceRequirements(terminal)) {
    const tasks = requirementTasks(requirement, terminal);
    if (tasks === null) {
      context.addIssue({ code: 'custom', path: ['terminal', 'evidenceRequirements'], message: 'NATIVE_SCHEMA_MISMATCH: Evidence task scope has no terminal binding' });
      return null;
    }
    const count = 'minimumRecords' in requirement ? requirement.minimumRecords : requirement.minimumRecordsPerTask;
    for (const taskId of tasks) {
      rows.push({
        kind: 'COUNTED',
        ownerKind: OWNER_BY_EVIDENCE_PRODUCER[requirement.producer],
        binding: { kind: 'EVIDENCE_REQUIREMENT', requirementId: requirement.requirementId, taskId },
        minimum: count,
        maximum: count,
      });
    }
  }
  for (const gate of terminalHumanGates(terminal)) {
    rows.push({ kind: 'COUNTED', ownerKind: 'HUMAN_APPROVAL', binding: { kind: 'HUMAN_GATE', gateId: gate.gateId }, minimum: 1, maximum: 1 });
  }
  if (terminal.kind === 'WORK_STAGE') {
    rows.push({ kind: 'TASK_WORK_SEQUENCE', ownerKind: 'TASK_WORK', binding: { kind: 'TASK_ID', taskId: terminal.taskId }, grammar: 'START (BLOCK START)* IMPLEMENTED', sourceStatus: 'READY', terminalStatus: 'IMPLEMENTED' });
  }
  if (terminal.kind === 'ISSUE_STAGE') {
    const actionKind = capability === 'triage' ? 'TRIAGE_RESULT' : capability === 'reproduce' ? 'REPRODUCTION_RESULT' : 'DEBUG_RESULT';
    rows.push({ kind: 'ISSUE_FINALIZATION_SEQUENCE', ownerKind: 'ISSUE_UPDATE', binding: { kind: 'RUN_ONLY' }, grammar: 'ALL_REQUIRED_EVIDENCE_PASS THEN ISSUE_UPDATE_LAST', actionKind });
  }
  if (terminal.kind === 'RECONCILE_STAGE') {
    for (const ownerKind of terminal.allowedTopLevelOwners) {
      rows.push({ kind: 'COUNTED', ownerKind, binding: { kind: 'RUN_ONLY' }, minimum: 0, maximum: 1 });
    }
  }
  return rows.sort((left, right) => compare(descendantKey(left), descendantKey(right)));
}

function requirementTasks(requirement: EvidenceRequirement, terminal: TerminalContract): Array<z.input<typeof taskIdSchema> | null> | null {
  if (requirement.taskScope.kind === 'NONE') return [null];
  if (requirement.taskScope.kind === 'SELECTED_TASK') {
    if (terminal.kind === 'WORK_STAGE') return [terminal.taskId];
    if (terminal.kind === 'REVIEW_STAGE' && terminal.reviewScope.kind === 'TASK') return [terminal.reviewScope.taskId];
    return null;
  }
  if (terminal.kind !== 'VERIFY_STAGE') return null;
  if (requirement.taskScope.kind === 'EACH_VERIFICATION_TASK') return terminal.verificationTaskIds;
  return terminal.verificationTaskRequirements
    .filter((binding) => binding.requirementIds.includes(requirement.requirementId))
    .map((binding) => binding.taskId);
}

function validateCompletedManifest(manifest: CompletedManifest, context: z.RefinementCtx): void {
  requireTimestampOrder(manifest.preparedAt, manifest.completedAt, context, ['completedAt']);
  if (manifest.completionOwner.owner.id !== manifest.runId || manifest.completionOwner.sequence <= manifest.prepareOwner.sequence) {
    context.addIssue({ code: 'custom', path: ['completionOwner'], message: 'NATIVE_SCHEMA_MISMATCH: completion owner is invalid' });
  }
  if (manifest.terminalResult.kind !== manifest.authorityContract.terminal.kind
    || manifest.terminalResult.terminalHash !== manifest.authorityContract.terminalHash) {
    context.addIssue({ code: 'custom', path: ['terminalResult', 'kind'], message: 'NATIVE_SCHEMA_MISMATCH: completed result and terminal contract disagree' });
  }
  validateTerminalProof(manifest, context);
  if (manifest.terminalResultHash !== hObject(manifest.terminalResult)) invalidAdjacentHash(context, 'terminalResultHash');
}

function validateTerminalProof(manifest: CompletedManifest, context: z.RefinementCtx): void {
  const result = manifest.terminalResult;
  if (result.descendantEntryHashesHash !== hObject(result.descendantEntryHashes)
    || result.satisfactionHash !== hObject(result.satisfaction)
    || result.outputObservationsHash !== hObject(result.outputObservations)) invalidAdjacentHash(context, 'terminalResult');
  requireCodeUnitSortedUnique(result.satisfaction.evidence, satisfactionEvidenceKey, context, ['terminalResult', 'satisfaction', 'evidence']);
  const allEvidenceIds: string[] = [];
  for (const row of result.satisfaction.evidence) {
    requireCodeUnitSortedUnique(row.evidenceIds, (value) => value, context, ['terminalResult', 'satisfaction', 'evidence']);
    allEvidenceIds.push(...row.evidenceIds);
  }
  allEvidenceIds.push(...result.satisfaction.gates.map((gate) => gate.evidenceId));
  if (new Set(allEvidenceIds).size !== allEvidenceIds.length) {
    context.addIssue({ code: 'custom', path: ['terminalResult', 'satisfaction'], message: 'NATIVE_SCHEMA_MISMATCH: one Evidence receipt cannot satisfy multiple requirements or gates' });
  }
  requireCodeUnitSortedUnique(result.satisfaction.gates, (gate) => gate.gateId, context, ['terminalResult', 'satisfaction', 'gates']);
  requireCodeUnitSortedUnique(result.outputObservations, outputObservationKey, context, ['terminalResult', 'outputObservations']);
  for (const [index, observation] of result.outputObservations.entries()) {
    if (observation.kind === 'DIRECTORY') {
      requireCodeUnitSortedUnique(observation.regularFiles, (file) => file.path, context, ['terminalResult', 'outputObservations', index, 'regularFiles']);
      if (observation.regularFileCount !== observation.regularFiles.length
        || observation.regularFilesTreeHash !== hObject(observation.regularFiles)) invalidAdjacentHash(context, 'regularFilesTreeHash');
    }
  }
  const expectedEvidence: Array<{ key: string; count: number }> = [];
  for (const row of expectedDescendantContracts(manifest.authorityContract.terminal, manifest.capability, context) ?? []) {
    if (row.kind === 'COUNTED' && row.binding.kind === 'EVIDENCE_REQUIREMENT') {
      expectedEvidence.push({
        key: `${row.binding.kind}\u0000${row.binding.requirementId}\u0000${row.binding.taskId ?? ''}`,
        count: row.minimum,
      });
    }
  }
  const actualEvidence = result.satisfaction.evidence.map((row) => ({
    key: `EVIDENCE_REQUIREMENT\u0000${row.requirementId}\u0000${row.taskId ?? ''}`,
    count: row.evidenceIds.length,
  }));
  const expectedGates = terminalHumanGates(manifest.authorityContract.terminal).map((gate) => gate.gateId);
  if (hObject(expectedEvidence) !== hObject(actualEvidence)
    || hObject(expectedGates) !== hObject(result.satisfaction.gates.map((gate) => gate.gateId))) {
    context.addIssue({ code: 'custom', path: ['terminalResult', 'satisfaction'], message: 'NATIVE_SCHEMA_MISMATCH: terminal satisfaction is not exhaustive' });
  }
  const expectedObservations = manifest.authorityContract.authoredOutputBindings.filter((binding) => binding.kind !== 'REPOSITORY_DIFF');
  if (expectedObservations.length !== result.outputObservations.length) {
    context.addIssue({ code: 'custom', path: ['terminalResult', 'outputObservations'], message: 'NATIVE_SCHEMA_MISMATCH: output observations are not exhaustive' });
  } else {
    expectedObservations.forEach((binding, index) => {
      const observation = result.outputObservations[index];
      const expectedPath = binding.kind === 'AUTHORED_DIRECTORY' ? binding.path.slice(0, -1) : binding.path;
      if (observation === undefined || observation.role !== binding.role || observation.path !== expectedPath
        || (binding.kind === 'AUTHORED_DIRECTORY' && (observation.kind !== 'DIRECTORY' || observation.regularFileCount < binding.minimumRegularFiles))
        || (binding.kind !== 'AUTHORED_DIRECTORY' && observation.kind !== 'FILE')) {
        context.addIssue({ code: 'custom', path: ['terminalResult', 'outputObservations', index], message: 'NATIVE_SCHEMA_MISMATCH: output observation does not match its frozen binding' });
      }
    });
  }
  validateTerminalResultProjection(manifest, context);
}

function validateFailedManifest(manifest: FailedManifest, context: z.RefinementCtx): void {
  requireTimestampOrder(manifest.preparedAt, manifest.failedAt, context, ['failedAt']);
  if (manifest.failureOwner.owner.id !== manifest.failure.evidenceId || manifest.failureOwner.sequence <= manifest.prepareOwner.sequence) {
    context.addIssue({ code: 'custom', path: ['failureOwner'], message: 'NATIVE_SCHEMA_MISMATCH: failure owner is invalid' });
  }
  const requirement = terminalEvidenceRequirements(manifest.authorityContract.terminal)
    .find((row) => row.requirementId === manifest.failure.requirementId);
  if (requirement === undefined || OWNER_BY_EVIDENCE_PRODUCER[requirement.producer] !== manifest.failureOwner.owner.kind) {
    context.addIssue({ code: 'custom', path: ['failureOwner'], message: 'NATIVE_SCHEMA_MISMATCH: failure producer owner is invalid' });
  }
  if (requirement !== undefined) {
    const tasks = requirementTasks(requirement, manifest.authorityContract.terminal);
    if (tasks === null || !tasks.includes(manifest.failure.taskId) || !requirement.allowedStatuses.includes(manifest.failure.status)) {
      context.addIssue({ code: 'custom', path: ['failure'], message: 'NATIVE_SCHEMA_MISMATCH: failed Evidence does not match its requirement scope' });
    }
  }
  if (manifest.failureHash !== hObject(manifest.failure)
    || manifest.repositoryFailureHash !== hObject(manifest.repositoryFailure)
    || manifest.failureRecoveryHash !== hObject(manifest.failureRecovery)) invalidAdjacentHash(context, 'failureHash');
  if (manifest.failureRecovery !== null && (manifest.authorityContract.terminal.kind !== 'WORK_STAGE'
    || manifest.failureRecovery.taskId !== manifest.authorityContract.terminal.taskId)) {
    context.addIssue({ code: 'custom', path: ['failureRecovery'], message: 'NATIVE_SCHEMA_MISMATCH: only the selected Work Task may be recovered' });
  }
  const terminal = manifest.authorityContract.terminal;
  const repositoryTerminal = terminal.kind === 'WORK_STAGE' || terminal.kind === 'SIMPLIFY_STAGE';
  if (repositoryTerminal !== (manifest.repositoryFailure !== null)
    || (terminal.kind === 'WORK_STAGE') !== (manifest.failureRecovery !== null)) {
    context.addIssue({ code: 'custom', path: ['repositoryFailure'], message: 'NATIVE_SCHEMA_MISMATCH: repository failure and recovery nullability is invalid' });
  }
  if (repositoryTerminal && manifest.repositoryFailure !== null) validateRepositoryFailureProjection(terminal, manifest.repositoryFailure, context);
}

function validateRepositoryFailureProjection(
  terminal: Extract<TerminalContract, { kind: 'WORK_STAGE' | 'SIMPLIFY_STAGE' }>,
  snapshot: z.output<typeof repositoryFailureSnapshotSchema>,
  context: z.RefinementCtx,
): void {
  const lineage = terminal.repositoryLineage;
  const rootRunId = lineage.rootRunId;
  const retryOfRunId = lineage.kind === 'ROOT' ? null : lineage.retryOfRunId;
  const expectedViolations = terminal.kind === 'WORK_STAGE'
    ? snapshot.failedResult.changedPaths.filter((path) => !terminal.allowedRepositoryPaths.includes(path))
    : [];
  if (snapshot.capability !== (terminal.kind === 'WORK_STAGE' ? 'work' : 'simplify')
    || snapshot.taskId !== (terminal.kind === 'WORK_STAGE' ? terminal.taskId : null)
    || snapshot.rootRunId !== rootRunId
    || snapshot.retryOfRunId !== retryOfRunId
    || hObject(snapshot.rootPreparedBasis) !== hObject(terminal.basis)
    || hObject(snapshot.policyViolatingPaths) !== hObject(expectedViolations)) {
    context.addIssue({ code: 'custom', path: ['repositoryFailure'], message: 'NATIVE_SCHEMA_MISMATCH: repository failure does not project the frozen terminal' });
  }
}

function validateTerminalResultProjection(manifest: CompletedManifest, context: z.RefinementCtx): void {
  const terminal = manifest.authorityContract.terminal;
  const result = manifest.terminalResult;
  if (terminal.kind === 'PLAN_STAGE' && result.kind === 'PLAN_STAGE'
    && result.sourceTasksHash !== terminal.sourceTasksHash) invalidTerminalProjection(context);
  if (terminal.kind === 'ISSUE_STAGE' && result.kind === 'ISSUE_STAGE'
    && (result.sourceIssueHash !== terminal.sourceIssueHash || result.observedBasisHash !== hObject(terminal.observedBasis))) invalidTerminalProjection(context);
  if (terminal.kind === 'WORK_STAGE' && result.kind === 'WORK_STAGE') {
    if (result.taskId !== terminal.taskId || result.sourceTasksHash !== terminal.sourceTasksHash
      || hObject(result.repositoryWorkResult.prepared) !== hObject(terminal.basis)
      || !isNonemptyRepositoryDelta(result.repositoryWorkResult)) invalidTerminalProjection(context);
  }
  if (terminal.kind === 'SIMPLIFY_STAGE' && result.kind === 'SIMPLIFY_STAGE'
    && (hObject(result.repositoryWorkResult.prepared) !== hObject(terminal.basis)
      || !isNonemptyRepositoryDelta(result.repositoryWorkResult))) invalidTerminalProjection(context);
  if (terminal.kind === 'REVIEW_STAGE' && result.kind === 'REVIEW_STAGE') {
    if (result.reviewedBasisHash !== hObject(terminal.reviewedBasis)
      || !satisfactionContainsEvidence(result, 'repository-review', result.aggregateEvidenceId)) invalidTerminalProjection(context);
  }
  if (terminal.kind === 'VERIFY_STAGE' && result.kind === 'VERIFY_STAGE'
    && (result.verifiedBasisHash !== hObject(terminal.verifiedBasis)
      || result.sourceTasksHash !== terminal.sourceTasksHash
      || result.targetTasksHash !== terminal.targetTasksHash)) invalidTerminalProjection(context);
  if (terminal.kind === 'QA_STAGE' && result.kind === 'QA_STAGE') {
    if (result.testedBasisHash !== hObject(terminal.testedBasis)
      || !satisfactionContainsEvidence(result, terminal.qaResultRequirementId, result.aggregateEvidenceId)) invalidTerminalProjection(context);
  }
  if (terminal.kind === 'CANARY_STAGE' && result.kind === 'CANARY_STAGE') {
    const measurementIds = result.satisfaction.evidence
      .filter((row) => terminal.canaryPolicy.signals.some((signal) => signal.measurementRequirementId === row.requirementId))
      .flatMap((row) => row.evidenceIds)
      .sort(compare);
    if (result.releaseSubjectHash !== terminal.releaseSubjectBinding.subjectHash
      || hObject(measurementIds) !== hObject(result.measurementEvidenceIds)
      || !satisfactionContainsEvidence(result, terminal.canaryResultRequirementId, result.aggregateEvidenceId)) invalidTerminalProjection(context);
    requireTimestampOrder(terminal.windowOpenedAt, result.windowClosedAt, context, ['terminalResult', 'windowClosedAt']);
    const minimumClosedAt = Date.parse(terminal.windowOpenedAt) + terminal.canaryPolicy.minimumWindowSeconds * 1000;
    if (Date.parse(result.windowClosedAt) < minimumClosedAt) invalidTerminalProjection(context);
  }
  if (terminal.kind === 'DELIVERY_STAGE' && result.kind === 'DELIVERY_STAGE') {
    if (result.deliveryBasisHash !== hObject(terminal.deliveryBasis)
      || result.releaseArtifactIdentityHash !== hObject(result.releaseArtifactIdentity)
      || result.releaseArtifactIdentity.changeId !== manifest.changeId
      || result.releaseArtifactIdentity.revision !== manifest.revision
      || hObject(result.releaseArtifactIdentity.repositoryBasis) !== hObject(terminal.deliveryBasis)
      || !result.satisfaction.gates.some((gate) => gate.evidenceId === result.approvalEvidenceId)) invalidTerminalProjection(context);
  }
  if (terminal.kind === 'ARCHIVE_STAGE' && result.kind === 'ARCHIVE_STAGE'
    && (result.sourceMetadataHash !== terminal.sourceMetadataHash
      || result.requiredGateSnapshotHash !== terminal.requiredGateSnapshotHash)) invalidTerminalProjection(context);
  if (terminal.kind === 'RECONCILE_STAGE' && result.kind === 'RECONCILE_STAGE'
    && (result.sourceRevision !== terminal.sourceRevision
      || !terminal.allowedTopLevelOwners.includes(result.selectedOwner.kind))) invalidTerminalProjection(context);
}

function satisfactionContainsEvidence(
  result: z.output<typeof stageTerminalResultSchema>,
  requirementId: string,
  evidenceId: z.output<typeof evidenceIdSchema>,
): boolean {
  return result.satisfaction.evidence.some((row) => row.requirementId === requirementId && row.evidenceIds.includes(evidenceId));
}

function isNonemptyRepositoryDelta(result: z.output<typeof repositoryWorkResultSchema>): boolean {
  return result.changedPaths.length > 0
    && hObject(result.prepared) !== hObject(result.completed)
    && result.prepared.headCommit === result.completed.headCommit
    && result.prepared.indexTreeHash === result.completed.indexTreeHash;
}

function invalidTerminalProjection(context: z.RefinementCtx): void {
  context.addIssue({ code: 'custom', path: ['terminalResult'], message: 'NATIVE_SCHEMA_MISMATCH: terminal result does not prove its frozen contract' });
}

function validateReleaseSubjectBinding(binding: z.output<typeof releaseSubjectBindingSchema>, context: z.RefinementCtx): void {
  const subject = binding.subject;
  if (binding.subjectHash !== hObject(subject)
    || subject.artifactIdentityHash !== hObject(subject.artifactIdentity)
    || subject.shipCompletion.ownerId !== subject.shipRunId
    || subject.artifactIdentity.changeId !== subject.changeId
    || subject.artifactIdentity.revision !== subject.revision) invalidAdjacentHash(context, 'releaseSubjectBinding');
}

function terminalEvidenceRequirements(terminal: TerminalContract): EvidenceRequirement[] {
  return 'evidenceRequirements' in terminal ? terminal.evidenceRequirements : [];
}

function terminalHumanGates(terminal: TerminalContract): HumanGate[] {
  return 'requiredHumanGates' in terminal ? terminal.requiredHumanGates : [];
}

function descendantKey(row: z.input<typeof runDescendantContractSchema> | RunDescendantContract): string {
  const binding = row.binding.kind === 'RUN_ONLY' ? 'RUN_ONLY'
    : row.binding.kind === 'TASK_ID' ? `TASK_ID\u0000${row.binding.taskId}`
      : row.binding.kind === 'HUMAN_GATE' ? `HUMAN_GATE\u0000${row.binding.gateId}`
        : `EVIDENCE_REQUIREMENT\u0000${row.binding.requirementId}\u0000${row.binding.taskId ?? ''}`;
  return `${row.ownerKind}\u0000${binding}`;
}

function satisfactionEvidenceKey(row: { requirementId: string; taskId: string | null }): string {
  return `${row.requirementId}\u0000${row.taskId ?? ''}`;
}

function outputObservationKey(row: { role: string; path: string }): string {
  return `${row.role}\u0000${row.path}`;
}

function hasOnlyOutputKind(contract: AuthorityContract, kind: RunOutputBinding['kind']): boolean {
  return contract.authoredOutputBindings.length === 1 && contract.authoredOutputBindings[0]?.kind === kind;
}

function invalidOutput(context: z.RefinementCtx): void {
  context.addIssue({ code: 'custom', path: ['authoredOutputBindings'], message: 'NATIVE_SCHEMA_MISMATCH: capability output binding is invalid' });
}

function invalidAdjacentHash(context: z.RefinementCtx, field: string): void {
  context.addIssue({ code: 'custom', path: [field], message: 'NATIVE_SCHEMA_MISMATCH: adjacent object hash is invalid' });
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
