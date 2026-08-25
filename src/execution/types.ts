import { z } from 'zod';
import { hashObject } from './hashing.js';

export const RUN_KINDS = ['CONTRACT_PLANNER', 'PROJECT_CRITIC', 'CONTRACT_RESOLVER', 'PROJECT_TEST_PLANNER', 'PROJECT_WRITER', 'PROJECT_REVIEWER', 'RECOVERY_WRITER'] as const;
export const RUN_STATUSES = ['PREPARED', 'CLAIMED', 'STARTING', 'RUNNING', 'FINISHED', 'ACCEPTED', 'INTEGRATED', 'BLOCKED', 'SIGNALED', 'FAILED', 'STALE', 'CANCELLED', 'RECOVERING'] as const;
export const CONTRACT_STATUSES = ['GENERATING', 'VALIDATING', 'READY', 'SUPERSEDED', 'INVALID'] as const;
export const WAVE_STATUSES = ['PLANNED', 'RUNNING', 'COMPLETE', 'PARTIAL', 'SUPERSEDED'] as const;
export const CLAIM_PHASES = ['WRITING', 'REVIEWING', 'INTEGRATING', 'RECOVERING'] as const;
export const COMMITSET_STATUSES = ['OPEN', 'PARTIAL', 'VERIFYING', 'COMPLETE', 'NEEDS_REVALIDATION'] as const;
export const VERIFICATION_PLAN_STATUSES = ['DRAFT', 'READY', 'INVALID', 'SUPERSEDED'] as const;
export const ENVIRONMENT_RUN_STATUSES = [
  'PLANNED', 'SETTING_UP', 'BUILDING', 'STARTING', 'HEALTHCHECKING', 'SEEDING',
  'TESTING', 'COLLECTING', 'TEARING_DOWN', 'PASSED', 'TEST_FAILED', 'INFRA_FAILED',
  'BLOCKED', 'CANCELLED', 'CLEANUP_REQUIRED', 'SAFETY_UNPROVEN',
] as const;

export type RunKind = (typeof RUN_KINDS)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];
export type WaveStatus = (typeof WAVE_STATUSES)[number];
export type ClaimPhase = (typeof CLAIM_PHASES)[number];
export type CommitSetStatus = (typeof COMMITSET_STATUSES)[number];
export type VerificationPlanStatus = (typeof VERIFICATION_PLAN_STATUSES)[number];
export type EnvironmentRunStatus = (typeof ENVIRONMENT_RUN_STATUSES)[number];

const worksetIdSchema = z.string().regex(/^WKS-\d{4}$/);
const contractIdSchema = z.string().regex(/^CTR-\d{4}$/);
const waveIdSchema = z.string().regex(/^WAVE-\d{4}$/);
const runIdSchema = z.string().regex(/^RUN-\d{4}$/);
const commitsetIdSchema = z.string().regex(/^CST-\d{4}$/);
const evidenceIdSchema = z.string().regex(/^EVD-\d{4}$/);
const attentionIdSchema = z.string().regex(/^ATTN-\d{4}$/);
const verificationPlanIdSchema = z.string().regex(/^VPL-\d{4}$/);
const environmentRunIdSchema = z.string().regex(/^IER-\d{4}$/);
const testCaseIdSchema = z.string().regex(/^TC-\d{4}$/);
const changeIdSchema = z.string().regex(/^CHG-\d{4}$/);
const revisionIdSchema = z.string().regex(/^REV-\d{4}$/);
const baselineIdSchema = z.string().regex(/^BL-\d{4}$/);
const taskIdSchema = z.string().regex(/^TASK-\d{3}$/);
const gitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const timestampSchema = z.string().datetime();
const readonlyStringArraySchema = z.array(z.string().min(1)).readonly();

export const contentHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export type ContentHash = z.infer<typeof contentHashSchema>;

export const scopedTaskRefSchema = z.strictObject({
  project: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  changeId: changeIdSchema,
  revision: revisionIdSchema,
  baseline: baselineIdSchema,
  taskId: taskIdSchema,
});
export type ScopedTaskRef = z.infer<typeof scopedTaskRefSchema>;

export const contractRefSchema = z.strictObject({
  id: contractIdSchema,
  contentHash: contentHashSchema,
});
export type ContractRef = z.infer<typeof contractRefSchema>;

export const contentAddressedSourceRefSchema = z.strictObject({
  ref: z.string().min(1),
  contentHash: contentHashSchema,
});
export type ContentAddressedSourceRef = z.infer<typeof contentAddressedSourceRefSchema>;

const projectTestCaseScopeSchema = z.strictObject({
  kind: z.literal('PROJECT'),
  project: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  changeId: changeIdSchema,
  revision: revisionIdSchema,
});

const contractTestCaseScopeSchema = z.strictObject({
  kind: z.literal('CONTRACT'),
  worksetId: worksetIdSchema,
  contractKey: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  scopeHash: contentHashSchema,
  contractSnapshot: contractRefSchema,
  scenarioId: z.string().regex(/^SC-[a-zA-Z0-9._-]+$/),
});

export const testCaseRefSchema = z.strictObject({
  id: testCaseIdSchema,
  scope: z.discriminatedUnion('kind', [projectTestCaseScopeSchema, contractTestCaseScopeSchema]),
  contentHash: contentHashSchema,
});
export type TestCaseRef = z.infer<typeof testCaseRefSchema>;

export const verificationPlanRefSchema = z.strictObject({
  id: verificationPlanIdSchema,
  contentHash: contentHashSchema,
});
export type VerificationPlanRef = z.infer<typeof verificationPlanRefSchema>;

export const integrationEnvironmentProfileRefSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  contentHash: contentHashSchema,
});
export type IntegrationEnvironmentProfileRef = z.infer<typeof integrationEnvironmentProfileRefSchema>;

export const contractSnapshotBindingSchema = z.strictObject({
  contractKey: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  scopeHash: contentHashSchema,
  snapshot: contractRefSchema,
});
export type ContractSnapshotBinding = z.infer<typeof contractSnapshotBindingSchema>;

export const TEST_CASE_LEVELS = [
  'UNIT', 'COMPONENT', 'CONTRACT_PROVIDER', 'CONTRACT_CONSUMER', 'INTEGRATION', 'E2E',
] as const;
export type TestCaseLevel = (typeof TEST_CASE_LEVELS)[number];
const testCaseLevelSchema = z.enum(TEST_CASE_LEVELS);

export const CONTRACT_SCENARIO_CLASSES = ['NORMAL', 'BOUNDARY', 'FAILURE', 'RETRY', 'COMPATIBILITY'] as const;
export type ContractScenarioClass = (typeof CONTRACT_SCENARIO_CLASSES)[number];
const contractScenarioClassSchema = z.enum(CONTRACT_SCENARIO_CLASSES);

export const contractScenarioRefSchema = z.strictObject({
  contractKey: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  scopeHash: contentHashSchema,
  snapshot: contractRefSchema,
  scenarioId: z.string().regex(/^SC-[a-zA-Z0-9._-]+$/),
  scenarioClass: contractScenarioClassSchema,
  contentHash: contentHashSchema,
});
export type ContractScenarioRef = z.infer<typeof contractScenarioRefSchema>;

export const testCaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: testCaseIdSchema,
  level: testCaseLevelSchema,
  title: z.string().min(1),
  required: z.boolean(),
  sourceRefs: z.array(contentAddressedSourceRefSchema).min(1).readonly(),
  scopedTasks: z.array(scopedTaskRefSchema).min(1).readonly(),
  acceptanceCriteriaRefs: z.array(contentAddressedSourceRefSchema).readonly(),
  contractRefs: z.array(contractRefSchema).readonly(),
  scenarioRefs: z.array(contractScenarioRefSchema).readonly(),
  commandRefs: z.array(z.string().min(1)).min(1).readonly(),
  ownerProjects: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/)).min(1).readonly(),
  testPaths: z.array(z.string().min(1)).readonly(),
  evidenceRequired: z.array(z.string().min(1)).min(1).readonly(),
  expectedOutcome: z.string().min(1),
  contentHash: contentHashSchema,
}).superRefine((testCase, context) => {
  requireSortedUnique(testCase.sourceRefs, sourceRefSortKey, 'sourceRefs', context);
  requireSortedUnique(testCase.scopedTasks, scopedTaskSortKey, 'scopedTasks', context);
  requireSortedUnique(testCase.acceptanceCriteriaRefs, sourceRefSortKey, 'acceptanceCriteriaRefs', context);
  requireSortedUnique(testCase.contractRefs, contractRefSortKey, 'contractRefs', context);
  requireSortedUnique(testCase.scenarioRefs, contractScenarioRefSortKey, 'scenarioRefs', context);
  requireSortedUnique(testCase.commandRefs, (item) => item, 'commandRefs', context);
  requireSortedUnique(testCase.ownerProjects, (item) => item, 'ownerProjects', context);
  requireSortedUnique(testCase.testPaths, (item) => item, 'testPaths', context);
  requireSortedUnique(testCase.evidenceRequired, (item) => item, 'evidenceRequired', context);
  if (testCase.contractRefs.length === 0 && testCase.acceptanceCriteriaRefs.length === 0) {
    context.addIssue({
      code: 'custom', path: ['acceptanceCriteriaRefs'],
      message: 'PROJECT_TEST_CASE_ACCEPTANCE_CRITERION_REQUIRED',
    });
  }
  if (testCase.contractRefs.length > 0 && testCase.scenarioRefs.length === 0) {
    context.addIssue({ code: 'custom', path: ['scenarioRefs'], message: 'CONTRACT_TEST_CASE_SCENARIO_REQUIRED' });
  }
  const contractKeys = new Set(testCase.contractRefs.map(contractRefSortKey));
  for (let index = 0; index < testCase.scenarioRefs.length; index += 1) {
    if (!contractKeys.has(contractRefSortKey(testCase.scenarioRefs[index]!.snapshot))) {
      context.addIssue({
        code: 'custom', path: ['scenarioRefs', index, 'snapshot'],
        message: 'TEST_CASE_SCENARIO_CONTRACT_UNBOUND',
      });
    }
  }
  if (testCase.contentHash !== hashTestCase(testCase)) {
    context.addIssue({ code: 'custom', path: ['contentHash'], message: 'TEST_CASE_CONTENT_HASH_MISMATCH' });
  }
});
export type TestCase = z.infer<typeof testCaseSchema>;

/**
 * 对抗性测试使用的安全性质集合。
 *
 * 背景：全流程融合分支增加了 TestCase v2，但其旧实现基于精简版
 * TestCase v1。这里保留 Task 9A 的完整 v1 契约，并把 v2 作为显式的
 * 版本化扩展，避免覆盖既有持久化格式。
 */
export const ADVERSARIAL_SAFETY_PROPERTIES = [
  'INVARIANT_PRESERVED',
  'NO_CROSS_SCOPE_EFFECT',
  'NO_UNAUTHORIZED_EFFECT',
  'REJECTED',
  'SAFE_FAILURE',
] as const;
export type AdversarialSafetyProperty = (typeof ADVERSARIAL_SAFETY_PROPERTIES)[number];

const adversarialVectorSchema = z.strictObject({
  id: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  safetyProperties: z.array(z.enum(ADVERSARIAL_SAFETY_PROPERTIES)).min(1).readonly(),
});

export const adversarialCoveragePolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  vectors: z.array(adversarialVectorSchema).min(1).readonly(),
  requirements: z.array(z.strictObject({
    scope: z.enum(['AUTHORITY_BOUNDARY', 'BEHAVIOR_TASK', 'BOUNDED_EXECUTION', 'CONCURRENT_STATE']),
    vectorIds: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).min(1).readonly(),
  })).min(1).readonly(),
  contentHash: contentHashSchema,
}).superRefine(validateAdversarialCoveragePolicy);
export type AdversarialCoveragePolicy = z.infer<typeof adversarialCoveragePolicySchema>;
export type AdversarialPolicyRef = Readonly<{ ref: string; contentHash: ContentHash }>;

export function hashAdversarialCoveragePolicy(
  policy: Omit<AdversarialCoveragePolicy, 'contentHash'> | AdversarialCoveragePolicy,
): ContentHash {
  return hashObject({
    schemaVersion: policy.schemaVersion,
    id: policy.id,
    vectors: policy.vectors,
    requirements: policy.requirements,
  });
}

export const adversarialTestFactsSchema = z.strictObject({
  threatRefs: z.array(contentAddressedSourceRefSchema).min(1).readonly(),
  vectorIds: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).min(1).readonly(),
  safetyProperties: z.array(z.enum(ADVERSARIAL_SAFETY_PROPERTIES)).min(1).readonly(),
  hypothesis: z.string().min(1),
}).superRefine((facts, context) => {
  requireSortedUnique(facts.threatRefs, sourceRefSortKey, 'threatRefs', context);
  requireSortedUnique(facts.vectorIds, (value) => value, 'vectorIds', context);
  requireSortedUnique(facts.safetyProperties, (value) => value, 'safetyProperties', context);
});

export const testCaseV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  id: testCaseIdSchema,
  level: testCaseLevelSchema,
  title: z.string().min(1),
  sourceRefs: z.array(contentAddressedSourceRefSchema).min(1).readonly(),
  scopedTasks: z.array(scopedTaskRefSchema).min(1).readonly(),
  commandRefs: z.array(z.string().min(1)).min(1).readonly(),
  expectedOutcome: z.string().min(1),
  adversarial: adversarialTestFactsSchema.optional(),
  contentHash: contentHashSchema,
}).superRefine(validateTestCaseV2);
export type TestCaseV2 = z.infer<typeof testCaseV2Schema>;
export type AnyTestCase = TestCase | TestCaseV2;
export const anyTestCaseSchema = z.union([testCaseSchema, testCaseV2Schema]);

const taskAdversarialRequirementScopeSchema = z.strictObject({
  kind: z.literal('TASK'),
  scopedTask: scopedTaskRefSchema,
});

const contractScenarioAdversarialRequirementScopeSchema = z.strictObject({
  kind: z.literal('CONTRACT_SCENARIO'),
  worksetId: worksetIdSchema,
  contractKey: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  scopeHash: contentHashSchema,
  contractSnapshot: contractRefSchema,
  scenarioId: z.string().regex(/^SC-[a-zA-Z0-9._-]+$/),
});

export const adversarialRequirementScopeSchema = z.discriminatedUnion('kind', [
  taskAdversarialRequirementScopeSchema,
  contractScenarioAdversarialRequirementScopeSchema,
]);
export type AdversarialRequirementScope = z.infer<typeof adversarialRequirementScopeSchema>;

export const adversarialRequirementSchema = z.strictObject({
  policy: contentAddressedSourceRefSchema,
  scope: adversarialRequirementScopeSchema,
  vectorIds: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).min(1).readonly(),
}).superRefine((requirement, context) => {
  requireSortedUnique(requirement.vectorIds, (value) => value, 'vectorIds', context);
});
export type AdversarialRequirement = z.infer<typeof adversarialRequirementSchema>;

export const adversarialExemptionSchema = z.strictObject({
  policy: contentAddressedSourceRefSchema,
  scope: adversarialRequirementScopeSchema,
  vectorIds: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).min(1).readonly(),
  reasonCode: z.enum(['DOCUMENTATION_ONLY', 'GENERATED_VIEW_ONLY', 'MECHANICALLY_TESTLESS', 'NOT_APPLICABLE']),
  sourceRefs: z.array(contentAddressedSourceRefSchema).min(1).readonly(),
  explanationHash: contentHashSchema,
}).superRefine((exemption, context) => {
  requireSortedUnique(exemption.vectorIds, (value) => value, 'vectorIds', context);
  requireSortedUnique(exemption.sourceRefs, sourceRefSortKey, 'sourceRefs', context);
  requireOneHashPerLogicalRef(exemption.sourceRefs, 'sourceRefs', context);
});
export type AdversarialExemption = z.infer<typeof adversarialExemptionSchema>;

const adversarialCheckVectorSchema = z.strictObject({
  vectorId: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  caseRefs: z.array(testCaseRefSchema).min(1).readonly(),
}).superRefine((vector, context) => {
  requireSortedUnique(vector.caseRefs, testCaseRefKey, 'caseRefs', context);
});

export const adversarialCheckSchema = z.strictObject({
  policy: contentAddressedSourceRefSchema,
  scope: adversarialRequirementScopeSchema,
  vectors: z.array(adversarialCheckVectorSchema).min(1).readonly(),
  commandRefs: z.array(z.string().min(1)).min(1).readonly(),
}).superRefine((check, context) => {
  requireSortedUnique(check.vectors, (vector) => vector.vectorId, 'vectors', context);
  requireSortedUnique(check.commandRefs, (value) => value, 'commandRefs', context);
});
export type AdversarialCheck = z.infer<typeof adversarialCheckSchema>;

export type TestCaseHashInput =
  | Omit<TestCase, 'contentHash'>
  | TestCase
  | Omit<TestCaseV2, 'contentHash'>
  | TestCaseV2;

export function hashTestCase(testCase: TestCaseHashInput): ContentHash {
  if (testCase.schemaVersion === 2) {
    const common = {
      schemaVersion: testCase.schemaVersion,
      id: testCase.id,
      level: testCase.level,
      title: testCase.title,
      sourceRefs: testCase.sourceRefs,
      scopedTasks: testCase.scopedTasks,
      commandRefs: testCase.commandRefs,
      expectedOutcome: testCase.expectedOutcome,
    };
    return hashObject(testCase.adversarial === undefined
      ? common
      : { ...common, adversarial: testCase.adversarial });
  }
  return hashObject({
    schemaVersion: testCase.schemaVersion,
    id: testCase.id,
    level: testCase.level,
    title: testCase.title,
    required: testCase.required,
    sourceRefs: testCase.sourceRefs,
    scopedTasks: testCase.scopedTasks,
    acceptanceCriteriaRefs: testCase.acceptanceCriteriaRefs,
    contractRefs: testCase.contractRefs,
    scenarioRefs: testCase.scenarioRefs,
    commandRefs: testCase.commandRefs,
    ownerProjects: testCase.ownerProjects,
    testPaths: testCase.testPaths,
    evidenceRequired: testCase.evidenceRequired,
    expectedOutcome: testCase.expectedOutcome,
  });
}

export function projectTestCaseRef(
  scope: Omit<z.infer<typeof projectTestCaseScopeSchema>, 'kind'>,
  id: string,
  contentHash: ContentHash,
): TestCaseRef {
  return testCaseRefSchema.parse({ id, scope: { kind: 'PROJECT', ...scope }, contentHash });
}

export function contractTestCaseRef(
  worksetId: string,
  contractKey: string,
  scopeHash: ContentHash,
  contractSnapshot: ContractRef,
  scenarioId: string,
  id: string,
  contentHash: ContentHash,
): TestCaseRef {
  return testCaseRefSchema.parse({
    id,
    scope: { kind: 'CONTRACT', worksetId, contractKey, scopeHash, contractSnapshot, scenarioId },
    contentHash,
  });
}

export function testCaseRefKey(ref: TestCaseRef): string {
  return JSON.stringify([
    ref.scope.kind,
    ref.scope.kind === 'PROJECT'
      ? [ref.scope.project, ref.scope.changeId, ref.scope.revision]
      : [ref.scope.worksetId, ref.scope.contractKey, ref.scope.scopeHash, ref.scope.contractSnapshot.id,
        ref.scope.contractSnapshot.contentHash, ref.scope.scenarioId],
    ref.id,
    ref.contentHash,
  ]);
}

const lifecycleShape = {
  schemaVersion: z.literal(1),
  machineVersion: z.literal(1),
  lastEventSequence: z.number().int().nonnegative(),
  lastEventHash: contentHashSchema.nullable(),
};

const contractParticipantSchema = z.strictObject({
  project: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  changeId: changeIdSchema,
  revision: revisionIdSchema,
  // Snapshots written before baseline-aware coordination omitted this field.
  // They remain readable so Core can return a precise re-coordination blocker,
  // but new discovery always writes it and READY verification requires it.
  baseline: baselineIdSchema.optional(),
  taskId: taskIdSchema,
  role: z.enum(['PROVIDER', 'CONSUMER']),
});

const contractSourceSchema = z.strictObject({
  kind: z.enum(['intent', 'spec', 'design', 'contract', 'schema', 'test']),
  project: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  ref: z.string().min(1),
  contentHash: contentHashSchema,
});

export const contractSnapshotManifestSchema = z.strictObject({
  ...lifecycleShape,
  id: contractIdSchema,
  worksetId: worksetIdSchema,
  status: z.enum(CONTRACT_STATUSES),
  contractKey: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  scopeHash: contentHashSchema,
  contentHash: contentHashSchema,
  previousSnapshot: contractIdSchema.nullable(),
  participants: z.array(contractParticipantSchema).min(2).readonly(),
  sources: z.array(contractSourceSchema).min(1).readonly(),
  businessScenarios: readonlyStringArraySchema,
  validationEvidence: z.array(evidenceIdSchema).readonly(),
  createdByRun: runIdSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).superRefine((manifest, context) => {
  requireLifecycleLinkage(manifest, context);
  requireSorted(manifest.participants, participantSortKey, 'participants', context);
  requireSorted(manifest.sources, sourceSortKey, 'sources', context);
  if (!manifest.participants.some((item) => item.role === 'PROVIDER')) {
    context.addIssue({ code: 'custom', path: ['participants'], message: 'participants require a PROVIDER' });
  }
  if (!manifest.participants.some((item) => item.role === 'CONSUMER')) {
    context.addIssue({ code: 'custom', path: ['participants'], message: 'participants require a CONSUMER' });
  }
  if (manifest.status === 'READY' && manifest.validationEvidence.length === 0) {
    context.addIssue({ code: 'custom', path: ['validationEvidence'], message: 'READY requires validation evidence' });
  }
});
export type ContractSnapshotManifest = z.infer<typeof contractSnapshotManifestSchema>;

const verificationProjectCheckSchema = z.strictObject({
  project: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  scopedTasks: z.array(scopedTaskRefSchema).min(1).readonly(),
  caseRefs: z.array(testCaseRefSchema).readonly(),
  commandRefs: z.array(z.string().min(1)).readonly(),
}).superRefine((check, context) => {
  requireSortedUnique(check.scopedTasks, scopedTaskSortKey, 'scopedTasks', context);
  requireSortedUnique(check.caseRefs, testCaseRefKey, 'caseRefs', context);
  requireSortedUnique(check.commandRefs, (item) => item, 'commandRefs', context);
  for (let index = 0; index < check.caseRefs.length; index += 1) {
    const ref = check.caseRefs[index]!;
    if (ref.scope.kind === 'PROJECT' && ref.scope.project !== check.project) {
      context.addIssue({
        code: 'custom',
        path: ['caseRefs', index],
        message: 'TEST_CASE_REF_SCOPE_REQUIRED: project case ref does not match project check',
      });
    }
  }
});

export const verificationProjectInputSchema = z.strictObject({
  project: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  changeId: changeIdSchema,
  revision: revisionIdSchema,
  baseline: baselineIdSchema,
  taskId: taskIdSchema,
  taskContentHash: contentHashSchema,
  risk: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  sourceRefs: z.array(contentAddressedSourceRefSchema).min(1).readonly(),
}).superRefine((input, context) => {
  requireSortedUnique(input.sourceRefs, sourceRefSortKey, 'sourceRefs', context);
});
export type VerificationProjectInput = z.infer<typeof verificationProjectInputSchema>;

export const verificationTaskRiskRuleSchema = z.strictObject({
  risk: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  requiredLevelGroups: z.array(z.array(testCaseLevelSchema).min(1).readonly()).min(1).readonly(),
}).superRefine((rule, context) => {
  requireSortedUnique(rule.requiredLevelGroups, (group) => JSON.stringify(group), 'requiredLevelGroups', context);
  for (let index = 0; index < rule.requiredLevelGroups.length; index += 1) {
    requireSortedUnique(rule.requiredLevelGroups[index]!, (level) => level, `requiredLevelGroups.${index}`, context);
  }
});
export type VerificationTaskRiskRule = z.infer<typeof verificationTaskRiskRuleSchema>;

export const verificationScenarioClassRuleSchema = z.strictObject({
  scenarioClass: contractScenarioClassSchema,
  allowedLevels: z.array(testCaseLevelSchema).min(1).readonly(),
}).superRefine((rule, context) => {
  requireSortedUnique(rule.allowedLevels, (level) => level, 'allowedLevels', context);
});
export type VerificationScenarioClassRule = z.infer<typeof verificationScenarioClassRuleSchema>;

export const verificationNotApplicableRuleSchema = z.strictObject({
  subjectKind: z.enum(['TASK', 'ACCEPTANCE_CRITERION', 'CONTRACT_SCENARIO']),
  allowedTaskRisks: z.array(z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])).readonly(),
  allowedScenarioClasses: z.array(contractScenarioClassSchema).readonly(),
}).superRefine((rule, context) => {
  requireSortedUnique(rule.allowedTaskRisks, (risk) => risk, 'allowedTaskRisks', context);
  requireSortedUnique(rule.allowedScenarioClasses, (scenarioClass) => scenarioClass, 'allowedScenarioClasses', context);
  if (rule.subjectKind === 'CONTRACT_SCENARIO') {
    if (rule.allowedScenarioClasses.length === 0 || rule.allowedTaskRisks.length > 0) {
      context.addIssue({
        code: 'custom', path: [], message: 'NOT_APPLICABLE_SCENARIO_RULE_INVALID',
      });
    }
  } else if (rule.allowedTaskRisks.length === 0 || rule.allowedScenarioClasses.length > 0) {
    context.addIssue({
      code: 'custom', path: [], message: 'NOT_APPLICABLE_TASK_RULE_INVALID',
    });
  }
});
export type VerificationNotApplicableRule = z.infer<typeof verificationNotApplicableRuleSchema>;

export function hashVerificationPolicyDefinition(policy: {
  id: string;
  version: number;
  taskRiskRules: readonly unknown[];
  scenarioClassRules: readonly unknown[];
  notApplicableRules: readonly unknown[];
}): ContentHash {
  return hashObject({
    id: policy.id,
    version: policy.version,
    taskRiskRules: policy.taskRiskRules,
    scenarioClassRules: policy.scenarioClassRules,
    notApplicableRules: policy.notApplicableRules,
  });
}

export const verificationCommandDefinitionSchema = z.strictObject({
  commandRef: z.string().min(1),
  project: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  executable: z.string().min(1),
  argv: z.array(z.string()).readonly(),
  cwd: z.string().min(1),
  network: z.enum(['ALLOW', 'DENY']),
  timeoutMs: z.number().int().positive(),
  outputLimit: z.number().int().positive(),
  caseRefs: z.array(testCaseRefSchema).min(1).readonly(),
}).superRefine((definition, context) => {
  requireSortedUnique(definition.caseRefs, testCaseRefKey, 'caseRefs', context);
});
export type VerificationCommandDefinition = z.infer<typeof verificationCommandDefinitionSchema>;

export function verificationCommandDefinitionKey(
  definition: Pick<VerificationCommandDefinition, 'project' | 'commandRef'>,
): string {
  return JSON.stringify([definition.project, definition.commandRef]);
}

export const verificationIntegrationGateSchema = z.strictObject({
  id: z.string().regex(/^IG-\d{4}$/),
  required: z.boolean(),
  profile: integrationEnvironmentProfileRefSchema,
  caseRefs: z.array(testCaseRefSchema).min(1).readonly(),
}).superRefine((gate, context) => {
  requireSortedUnique(gate.caseRefs, testCaseRefKey, 'caseRefs', context);
});
export type VerificationIntegrationGate = z.infer<typeof verificationIntegrationGateSchema>;

export const notApplicableDecisionSchema = z.strictObject({
  subjectKind: z.enum(['TASK', 'ACCEPTANCE_CRITERION', 'CONTRACT_SCENARIO']),
  subjectRef: z.string().min(1),
  subjectHash: contentHashSchema,
  policyId: z.string().min(1),
  policyHash: contentHashSchema,
  reasonHash: contentHashSchema,
});
export type NotApplicableDecision = z.infer<typeof notApplicableDecisionSchema>;

export const verificationDiagnosticSchema = z.strictObject({
  code: z.string().min(1),
  subjectRef: z.string().min(1),
  message: z.string().min(1),
});
export type VerificationDiagnostic = z.infer<typeof verificationDiagnosticSchema>;

export const verificationPlanSchema = z.strictObject({
  ...lifecycleShape,
  id: verificationPlanIdSchema,
  worksetId: worksetIdSchema,
  status: z.enum(VERIFICATION_PLAN_STATUSES),
  scopeHash: contentHashSchema,
  contentHash: contentHashSchema,
  contractSnapshots: z.array(contractSnapshotBindingSchema).readonly(),
  applicableContractKeys: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]*$/)).readonly(),
  testCases: z.array(testCaseRefSchema).readonly(),
  projectInputs: z.array(verificationProjectInputSchema).readonly(),
  profileRefs: z.array(integrationEnvironmentProfileRefSchema).readonly(),
  projectChecks: z.array(verificationProjectCheckSchema).readonly(),
  commandDefinitions: z.array(verificationCommandDefinitionSchema).readonly(),
  integrationGates: z.array(verificationIntegrationGateSchema).readonly(),
  policyId: z.string().min(1),
  policyVersion: z.number().int().positive(),
  policyHash: contentHashSchema,
  taskRiskRules: z.array(verificationTaskRiskRuleSchema).min(1).readonly(),
  scenarioClassRules: z.array(verificationScenarioClassRuleSchema).min(1).readonly(),
  notApplicableRules: z.array(verificationNotApplicableRuleSchema).readonly(),
  notApplicableDecisions: z.array(notApplicableDecisionSchema).readonly(),
  validation: z.array(verificationDiagnosticSchema).readonly(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).superRefine((plan, context) => {
  requireLifecycleLinkage(plan, context);
  requireSortedUnique(plan.contractSnapshots, contractBindingSortKey, 'contractSnapshots', context);
  requireSortedUnique(plan.applicableContractKeys, (item) => item, 'applicableContractKeys', context);
  requireSortedUnique(plan.testCases, testCaseRefKey, 'testCases', context);
  requireSortedUnique(plan.projectInputs, verificationProjectInputSortKey, 'projectInputs', context);
  requireSortedUnique(plan.profileRefs, integrationProfileRefSortKey, 'profileRefs', context);
  requireSortedUnique(plan.projectChecks, (item) => item.project, 'projectChecks', context);
  requireSortedUnique(plan.commandDefinitions, verificationCommandDefinitionKey, 'commandDefinitions', context);
  requireSortedUnique(plan.integrationGates, (item) => item.id, 'integrationGates', context);
  requireSortedUnique(plan.taskRiskRules, (item) => item.risk, 'taskRiskRules', context);
  requireSortedUnique(plan.scenarioClassRules, (item) => item.scenarioClass, 'scenarioClassRules', context);
  requireSortedUnique(plan.notApplicableRules, (item) => item.subjectKind, 'notApplicableRules', context);
  requireSortedUnique(plan.notApplicableDecisions, notApplicableDecisionSortKey, 'notApplicableDecisions', context);
  requireSortedUnique(plan.validation, verificationDiagnosticSortKey, 'validation', context);
  const authoritativeRefs = new Set(plan.testCases.map(testCaseRefKey));
  for (const [field, refs] of [
    ...plan.projectChecks.map((check) => [`projectChecks.${check.project}`, check.caseRefs] as const),
    ...plan.commandDefinitions.map((definition) => [
      `commandDefinitions.${verificationCommandDefinitionKey(definition)}`,
      definition.caseRefs,
    ] as const),
    ...plan.integrationGates.map((gate) => [`integrationGates.${gate.id}`, gate.caseRefs] as const),
  ]) {
    if (refs.some((ref) => !authoritativeRefs.has(testCaseRefKey(ref)))) {
      context.addIssue({ code: 'custom', path: [field], message: 'VERIFICATION_PLAN_CASE_REF_NOT_IN_INVENTORY' });
    }
  }
  if (plan.status === 'READY' && plan.validation.length > 0) {
    context.addIssue({ code: 'custom', path: ['validation'], message: 'READY_VERIFICATION_PLAN_HAS_ERRORS' });
  }
  if (plan.status === 'READY' && (plan.projectInputs.length === 0 || plan.projectChecks.length === 0)) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'READY_VERIFICATION_PLAN_INCOMPLETE' });
  }
  if (plan.status === 'INVALID' && plan.validation.length === 0) {
    context.addIssue({ code: 'custom', path: ['validation'], message: 'INVALID_VERIFICATION_PLAN_REQUIRES_DIAGNOSTIC' });
  }
  if (plan.policyHash !== hashVerificationPolicyDefinition({
    id: plan.policyId,
    version: plan.policyVersion,
    taskRiskRules: plan.taskRiskRules,
    scenarioClassRules: plan.scenarioClassRules,
    notApplicableRules: plan.notApplicableRules,
  })) {
    context.addIssue({ code: 'custom', path: ['policyHash'], message: 'VERIFICATION_POLICY_HASH_MISMATCH' });
  }
  if (plan.contentHash !== hashVerificationPlan(plan)) {
    context.addIssue({ code: 'custom', path: ['contentHash'], message: 'VERIFICATION_PLAN_CONTENT_HASH_MISMATCH' });
  }
});
export type VerificationPlan = z.infer<typeof verificationPlanSchema>;

/**
 * 全流程融合分支在对抗性保证进入 v2 之前写出的精简准入计划。
 *
 * 它与 Task 9A 的持久化 VerificationPlan 同为 schemaVersion 1，却不是
 * 同一种磁盘权威记录。保留这个独立名称仅用于读取旧准入输入并给出明确的
 * “需要 v2”结论；新编译和持久化不得再生成该格式。
 */
const legacyVerificationProjectCheckSchema = z.strictObject({
  project: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  scopedTasks: z.array(scopedTaskRefSchema).min(1).readonly(),
  caseRefs: z.array(testCaseRefSchema).min(1).readonly(),
  commandRefs: z.array(z.string().min(1)).min(1).readonly(),
}).superRefine((check, context) => {
  requireSortedUnique(check.scopedTasks, scopedTaskSortKey, 'scopedTasks', context);
  requireSortedUnique(check.caseRefs, testCaseRefKey, 'caseRefs', context);
  requireSortedUnique(check.commandRefs, (item) => item, 'commandRefs', context);
  for (let index = 0; index < check.caseRefs.length; index += 1) {
    const ref = check.caseRefs[index]!;
    if (ref.scope.kind === 'PROJECT' && ref.scope.project !== check.project) {
      context.addIssue({
        code: 'custom',
        path: ['caseRefs', index],
        message: 'TEST_CASE_REF_SCOPE_REQUIRED: project case ref does not match project check',
      });
    }
  }
});

export const legacyVerificationPlanSchema = z.strictObject({
  ...lifecycleShape,
  id: verificationPlanIdSchema,
  worksetId: worksetIdSchema,
  status: z.enum(VERIFICATION_PLAN_STATUSES),
  scopeHash: contentHashSchema,
  contentHash: contentHashSchema,
  contractSnapshots: z.array(contractSnapshotBindingSchema).readonly(),
  profile: integrationEnvironmentProfileRefSchema,
  projectChecks: z.array(legacyVerificationProjectCheckSchema).min(1).readonly(),
  integrationCaseRefs: z.array(testCaseRefSchema).readonly(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).superRefine((plan, context) => {
  requireLifecycleLinkage(plan, context);
  requireSortedUnique(plan.contractSnapshots, contractBindingSortKey, 'contractSnapshots', context);
  requireSortedUnique(plan.projectChecks, (item) => item.project, 'projectChecks', context);
  requireSortedUnique(plan.integrationCaseRefs, testCaseRefKey, 'integrationCaseRefs', context);
  if (plan.contentHash !== hashVerificationPlan(plan)) {
    context.addIssue({ code: 'custom', path: ['contentHash'], message: 'VERIFICATION_PLAN_CONTENT_HASH_MISMATCH' });
  }
});
export type LegacyVerificationPlan = z.infer<typeof legacyVerificationPlanSchema>;

const verificationProjectCheckV2Schema = z.strictObject({
  project: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  scopedTasks: z.array(scopedTaskRefSchema).min(1).readonly(),
  caseRefs: z.array(testCaseRefSchema).readonly(),
  commandRefs: z.array(z.string().min(1)).readonly(),
}).superRefine((check, context) => {
  requireSortedUnique(check.scopedTasks, scopedTaskSortKey, 'scopedTasks', context);
  requireSortedUnique(check.caseRefs, testCaseRefKey, 'caseRefs', context);
  requireSortedUnique(check.commandRefs, (item) => item, 'commandRefs', context);
  if ((check.caseRefs.length === 0) !== (check.commandRefs.length === 0)) {
    context.addIssue({
      code: 'custom',
      path: check.caseRefs.length === 0 ? ['commandRefs'] : ['caseRefs'],
      message: 'VERIFICATION_TASK_UNCOVERED',
    });
  }
});

/**
 * 纯准入层使用的 VerificationPlan v2。
 *
 * v1 仍是 Task 9A 的磁盘权威记录；v2 绑定同一批不可变引用以及对抗性
 * 证明，供后续 Wave/Writer 准入门复算。两者通过 schemaVersion 明确区分，
 * 不允许把 v1 静默当成已经具备对抗性证明的 v2。
 */
export const verificationPlanV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  machineVersion: z.literal(2),
  lastEventSequence: z.number().int().nonnegative(),
  lastEventHash: contentHashSchema.nullable(),
  id: verificationPlanIdSchema,
  worksetId: worksetIdSchema,
  status: z.enum(VERIFICATION_PLAN_STATUSES),
  scopeHash: contentHashSchema,
  contentHash: contentHashSchema,
  contractSnapshots: z.array(contractSnapshotBindingSchema).readonly(),
  profile: integrationEnvironmentProfileRefSchema,
  projectChecks: z.array(verificationProjectCheckV2Schema).min(1).readonly(),
  integrationCaseRefs: z.array(testCaseRefSchema).readonly(),
  adversarialPolicy: contentAddressedSourceRefSchema,
  adversarialRequirements: z.array(adversarialRequirementSchema).readonly(),
  adversarialChecks: z.array(adversarialCheckSchema).readonly(),
  adversarialExemptions: z.array(adversarialExemptionSchema).readonly(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).superRefine(validateVerificationPlanV2);
export type VerificationPlanV2 = z.infer<typeof verificationPlanV2Schema>;
export type AnyVerificationPlan = VerificationPlan | LegacyVerificationPlan | VerificationPlanV2;
export const anyVerificationPlanSchema = z.union([
  verificationPlanSchema,
  legacyVerificationPlanSchema,
  verificationPlanV2Schema,
]);

type VerificationPlanV1HashInput = {
  schemaVersion: number;
  worksetId: string;
  scopeHash: ContentHash;
  contractSnapshots: readonly unknown[];
  applicableContractKeys: readonly string[];
  testCases: readonly unknown[];
  projectInputs: readonly unknown[];
  profileRefs: readonly unknown[];
  projectChecks: readonly unknown[];
  commandDefinitions: readonly unknown[];
  integrationGates: readonly unknown[];
  policyId: string;
  policyVersion: number;
  policyHash: ContentHash;
  taskRiskRules: readonly unknown[];
  scenarioClassRules: readonly unknown[];
  notApplicableRules: readonly unknown[];
  notApplicableDecisions: readonly unknown[];
};

type VerificationPlanV2HashInput = Pick<VerificationPlanV2,
  'schemaVersion' | 'id' | 'worksetId' | 'scopeHash' | 'contractSnapshots' |
  'profile' | 'projectChecks' | 'integrationCaseRefs' | 'adversarialPolicy' |
  'adversarialRequirements' | 'adversarialChecks' | 'adversarialExemptions'>;

type LegacyVerificationPlanHashInput = Pick<LegacyVerificationPlan,
  'schemaVersion' | 'id' | 'worksetId' | 'scopeHash' | 'contractSnapshots' |
  'profile' | 'projectChecks' | 'integrationCaseRefs'>;

export function hashVerificationPlan(
  plan: VerificationPlanV1HashInput | LegacyVerificationPlanHashInput | VerificationPlanV2HashInput,
): ContentHash {
  if (plan.schemaVersion === 2 && 'adversarialPolicy' in plan) {
    return hashObject({
      schemaVersion: plan.schemaVersion,
      id: plan.id,
      worksetId: plan.worksetId,
      scopeHash: plan.scopeHash,
      contractSnapshots: plan.contractSnapshots,
      profile: plan.profile,
      projectChecks: plan.projectChecks,
      integrationCaseRefs: plan.integrationCaseRefs,
      adversarialPolicy: plan.adversarialPolicy,
      adversarialRequirements: plan.adversarialRequirements,
      adversarialChecks: plan.adversarialChecks,
      adversarialExemptions: plan.adversarialExemptions,
    });
  }
  if (!('applicableContractKeys' in plan)) {
    return hashObject({
      schemaVersion: plan.schemaVersion,
      id: plan.id,
      worksetId: plan.worksetId,
      scopeHash: plan.scopeHash,
      contractSnapshots: plan.contractSnapshots,
      profile: plan.profile,
      projectChecks: plan.projectChecks,
      integrationCaseRefs: plan.integrationCaseRefs,
    });
  }
  return hashObject({
    schemaVersion: plan.schemaVersion,
    worksetId: plan.worksetId,
    scopeHash: plan.scopeHash,
    contractSnapshots: plan.contractSnapshots,
    applicableContractKeys: plan.applicableContractKeys,
    testCases: plan.testCases,
    projectInputs: plan.projectInputs,
    profileRefs: plan.profileRefs,
    projectChecks: plan.projectChecks,
    commandDefinitions: plan.commandDefinitions,
    integrationGates: plan.integrationGates,
    policyId: plan.policyId,
    policyVersion: plan.policyVersion,
    policyHash: plan.policyHash,
    taskRiskRules: plan.taskRiskRules,
    scenarioClassRules: plan.scenarioClassRules,
    notApplicableRules: plan.notApplicableRules,
    notApplicableDecisions: plan.notApplicableDecisions,
  });
}

export const ENVIRONMENT_STEP_NAMES = [
  'setup',
  'build',
  'start',
  'health',
  'seed',
  'test',
  'collect',
  'teardown',
] as const;
export type EnvironmentStepName = (typeof ENVIRONMENT_STEP_NAMES)[number];

const commandReferenceSchema = z.strictObject({
  commandRef: z.string().min(1),
  timeoutMs: z.number().int().positive(),
});

const commandInvocationSchema = z.strictObject({
  executable: z.string().min(1).refine((value) => !/\s/.test(value), 'executable must not contain shell syntax'),
  argv: z.array(z.string()).readonly(),
  cwd: z.string().min(1),
  timeoutMs: z.number().int().positive(),
  outputLimit: z.number().int().positive(),
  network: z.enum(['ALLOW', 'DENY']),
  requiredArtifacts: z.array(z.string().min(1)).readonly(),
}).superRefine((command, context) => {
  requireSortedUnique(command.requiredArtifacts, (item) => item, 'requiredArtifacts', context);
});

export const environmentStepDefinitionSchema = z.union([
  commandReferenceSchema,
  commandInvocationSchema,
]);
export type EnvironmentStepDefinition = z.infer<typeof environmentStepDefinitionSchema>;

const environmentStepsSchema = z.strictObject({
  setup: environmentStepDefinitionSchema,
  build: environmentStepDefinitionSchema,
  start: environmentStepDefinitionSchema,
  health: environmentStepDefinitionSchema,
  seed: environmentStepDefinitionSchema,
  test: environmentStepDefinitionSchema,
  collect: environmentStepDefinitionSchema,
  teardown: environmentStepDefinitionSchema,
});

const integrationEnvironmentProfileContentShape = {
  schemaVersion: z.literal(2),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  driver: z.enum(['compose', 'commands', 'external']),
  requiredProjects: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/)).min(1).readonly(),
  definitionRef: z.string().min(1),
  definitionContentHash: contentHashSchema,
  isolation: z.strictObject({
    mode: z.enum(['per-run', 'shared']),
    maxParallel: z.number().int().positive(),
    requireExclusiveLease: z.boolean(),
  }),
  ports: z.strictObject({
    mode: z.enum(['dynamic', 'inherited', 'external']),
    range: z.tuple([
      z.number().int().min(1).max(65_535),
      z.number().int().min(1).max(65_535),
    ]).readonly(),
  }),
  sourceRefs: z.array(contentAddressedSourceRefSchema).min(1).readonly(),
  envRefs: z.record(
    z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'SECRET_REFERENCE_NAME'),
  ),
  sandbox: z.strictObject({
    driver: z.enum(['platform', 'container', 'external']),
    requiredProofs: z.array(z.enum([
      'CREDENTIALS',
      'FILESYSTEM',
      'NETWORK',
      'PROCESS_TREE',
      'RESOURCE_LIMITS',
    ])).min(1).readonly(),
  }),
  steps: environmentStepsSchema,
} as const;

export const integrationEnvironmentProfileContentSchema = z.strictObject(
  integrationEnvironmentProfileContentShape,
).superRefine(validateIntegrationEnvironmentProfileContent);
export type IntegrationEnvironmentProfileContent = z.infer<typeof integrationEnvironmentProfileContentSchema>;

export const integrationEnvironmentProfileSchema = z.strictObject({
  ...integrationEnvironmentProfileContentShape,
  contentHash: contentHashSchema,
}).superRefine((profile, context) => {
  validateIntegrationEnvironmentProfileContent(profile, context);
  if (profile.contentHash !== hashIntegrationEnvironmentProfile(profile)) {
    context.addIssue({ code: 'custom', path: ['contentHash'], message: 'INTEGRATION_ENVIRONMENT_PROFILE_CONTENT_HASH_MISMATCH' });
  }
});
export type IntegrationEnvironmentProfile = z.infer<typeof integrationEnvironmentProfileSchema>;

export function hashIntegrationEnvironmentProfile(
  profile: Omit<IntegrationEnvironmentProfile, 'contentHash'> | IntegrationEnvironmentProfile,
): ContentHash {
  return hashObject({
    schemaVersion: profile.schemaVersion,
    id: profile.id,
    driver: profile.driver,
    requiredProjects: profile.requiredProjects,
    definitionRef: profile.definitionRef,
    definitionContentHash: profile.definitionContentHash,
    isolation: profile.isolation,
    ports: profile.ports,
    sourceRefs: profile.sourceRefs,
    envRefs: profile.envRefs,
    sandbox: profile.sandbox,
    steps: profile.steps,
  });
}

function validateIntegrationEnvironmentProfileContent(
  profile: IntegrationEnvironmentProfileContent,
  context: z.RefinementCtx,
): void {
  requireSortedUnique(profile.requiredProjects, (item) => item, 'requiredProjects', context);
  requireSortedUnique(profile.sourceRefs, sourceRefSortKey, 'sourceRefs', context);
  requireSortedUnique(profile.sandbox.requiredProofs, (item) => item, 'sandbox.requiredProofs', context);
  if (profile.ports.range[0] > profile.ports.range[1]) {
    context.addIssue({ code: 'custom', path: ['ports', 'range'], message: 'ENVIRONMENT_PORT_RANGE_INVALID' });
  }
  const definition = profile.sourceRefs.find((source) => source.ref === profile.definitionRef);
  if (definition === undefined || definition.contentHash !== profile.definitionContentHash) {
    context.addIssue({
      code: 'custom',
      path: ['definitionContentHash'],
      message: 'ENVIRONMENT_DEFINITION_SOURCE_MISMATCH',
    });
  }
}

const integrationProjectInputSchema = z.strictObject({
  project: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  commit: gitObjectIdSchema,
  commitTree: gitObjectIdSchema,
  verifiedTree: gitObjectIdSchema,
  metadataDeltaHash: contentHashSchema,
});
export type IntegrationProjectInput = z.infer<typeof integrationProjectInputSchema>;

const namedDigestSchema = z.strictObject({
  ref: z.string().min(1),
  digest: contentHashSchema,
});

export const integrationEnvironmentInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  verificationPlan: verificationPlanRefSchema,
  contractSnapshots: z.array(contractSnapshotBindingSchema).readonly(),
  commitSet: z.strictObject({ id: commitsetIdSchema, scopeHash: contentHashSchema }),
  projects: z.array(integrationProjectInputSchema).min(1).readonly(),
  profile: integrationEnvironmentProfileRefSchema,
  testCaseRefs: z.array(testCaseRefSchema).min(1).readonly(),
  commandDefinitionsHash: contentHashSchema,
  definitionDigest: contentHashSchema,
  executorDigests: z.array(namedDigestSchema).readonly(),
  supportingArtifactDigests: z.array(namedDigestSchema).readonly(),
  externalDeploymentDigests: z.array(namedDigestSchema).readonly(),
  environmentReferenceNames: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'SECRET_REFERENCE_NAME')).readonly(),
  policyVersion: z.number().int().positive(),
  inputHash: contentHashSchema,
}).superRefine((input, context) => {
  requireSortedUnique(input.contractSnapshots, contractBindingSortKey, 'contractSnapshots', context);
  requireSortedUnique(input.projects, (item) => item.project, 'projects', context);
  requireSortedUnique(input.testCaseRefs, testCaseRefKey, 'testCaseRefs', context);
  requireSortedUnique(input.executorDigests, namedDigestSortKey, 'executorDigests', context);
  requireSortedUnique(input.supportingArtifactDigests, namedDigestSortKey, 'supportingArtifactDigests', context);
  requireSortedUnique(input.externalDeploymentDigests, namedDigestSortKey, 'externalDeploymentDigests', context);
  requireSortedUnique(input.environmentReferenceNames, (item) => item, 'environmentReferenceNames', context);
  if (input.inputHash !== hashIntegrationEnvironmentInput(input)) {
    context.addIssue({ code: 'custom', path: ['inputHash'], message: 'INTEGRATION_ENVIRONMENT_INPUT_HASH_MISMATCH' });
  }
});
export type IntegrationEnvironmentInput = z.infer<typeof integrationEnvironmentInputSchema>;

export function hashIntegrationEnvironmentInput(input: {
  schemaVersion: number;
  verificationPlan: unknown;
  contractSnapshots: readonly unknown[];
  commitSet: unknown;
  projects: readonly unknown[];
  profile: unknown;
  testCaseRefs: readonly unknown[];
  commandDefinitionsHash: ContentHash;
  definitionDigest: ContentHash;
  executorDigests: readonly unknown[];
  supportingArtifactDigests: readonly unknown[];
  externalDeploymentDigests: readonly unknown[];
  environmentReferenceNames: readonly string[];
  policyVersion: number;
}): ContentHash {
  return hashObject({
    schemaVersion: input.schemaVersion,
    verificationPlan: input.verificationPlan,
    contractSnapshots: input.contractSnapshots,
    commitSet: input.commitSet,
    projects: input.projects,
    profile: input.profile,
    testCaseRefs: input.testCaseRefs,
    commandDefinitionsHash: input.commandDefinitionsHash,
    definitionDigest: input.definitionDigest,
    executorDigests: input.executorDigests,
    supportingArtifactDigests: input.supportingArtifactDigests,
    externalDeploymentDigests: input.externalDeploymentDigests,
    environmentReferenceNames: input.environmentReferenceNames,
    policyVersion: input.policyVersion,
  });
}

export const testCaseResultSchema = z.strictObject({
  caseRef: testCaseRefSchema,
  status: z.enum(['PASS', 'FAIL', 'INCONCLUSIVE', 'SKIPPED']),
  evidenceRefs: z.array(evidenceIdSchema).readonly(),
});
export type TestCaseResult = z.infer<typeof testCaseResultSchema>;

export const integrationEnvironmentRunSchema = z.strictObject({
  ...lifecycleShape,
  id: environmentRunIdSchema,
  worksetId: worksetIdSchema,
  status: z.enum(ENVIRONMENT_RUN_STATUSES),
  inputHash: contentHashSchema,
  attempt: z.number().int().positive(),
  ownedResourceRefs: z.array(z.string().min(1)).readonly(),
  reservedPorts: z.array(z.number().int().min(1).max(65535)).readonly(),
  caseResults: z.array(testCaseResultSchema).readonly(),
  evidenceRefs: z.array(evidenceIdSchema).readonly(),
  primaryOutcome: z.enum(['PASSED', 'TEST_FAILED', 'INFRA_FAILED', 'BLOCKED', 'CANCELLED', 'SAFETY_UNPROVEN']).optional(),
  cleanupOutcome: z.enum(['NOT_ATTEMPTED', 'SUCCEEDED', 'FAILED', 'SAFETY_UNPROVEN']),
  cleanupAttempts: z.number().int().nonnegative(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).superRefine((run, context) => {
  requireLifecycleLinkage(run, context);
  requireSortedUnique(run.ownedResourceRefs, (item) => item, 'ownedResourceRefs', context);
  requireSortedUnique(run.reservedPorts, (item) => String(item).padStart(5, '0'), 'reservedPorts', context);
  requireSortedUnique(run.caseResults, (item) => testCaseRefKey(item.caseRef), 'caseResults', context);
  requireSortedUnique(run.evidenceRefs, (item) => item, 'evidenceRefs', context);
  if (['PASSED', 'TEST_FAILED', 'INFRA_FAILED', 'BLOCKED', 'CANCELLED', 'CLEANUP_REQUIRED'].includes(run.status) &&
      run.primaryOutcome === undefined) {
    context.addIssue({ code: 'custom', path: ['primaryOutcome'], message: 'primaryOutcome is required after execution settles' });
  }
});
export type IntegrationEnvironmentRun = z.infer<typeof integrationEnvironmentRunSchema>;

export const evidenceSubjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('PROJECT'),
    project: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    commit: gitObjectIdSchema,
    tree: gitObjectIdSchema,
    metadataDeltaHash: contentHashSchema,
  }),
  z.strictObject({
    kind: z.literal('ENVIRONMENT'),
    environmentRunId: environmentRunIdSchema,
    inputHash: contentHashSchema,
  }),
  z.strictObject({
    kind: z.literal('COMPATIBILITY'),
    contractSnapshot: contractRefSchema,
    project: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    commit: gitObjectIdSchema,
  }),
]);
export type EvidenceSubject = z.infer<typeof evidenceSubjectSchema>;

export type SettledResult<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: { name: string; message: string; code?: string } };

export const runStateSchema = z.strictObject({
  ...lifecycleShape,
  id: runIdSchema,
  kind: z.enum(RUN_KINDS),
  worksetId: worksetIdSchema,
  status: z.enum(RUN_STATUSES),
  packetHash: contentHashSchema,
  waveId: waveIdSchema.optional(),
  parentRunId: runIdSchema.optional(),
  scopedTask: scopedTaskRefSchema.optional(),
  agentSessionId: z.string().min(1).optional(),
  resultHash: contentHashSchema.optional(),
  evidenceRefs: z.array(evidenceIdSchema).readonly(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).superRefine(requireLifecycleLinkage);
export type RunState = z.infer<typeof runStateSchema>;

export const agentSessionRecordSchema = z.strictObject({
  ...lifecycleShape,
  runId: runIdSchema,
  agentId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  protocol: z.enum(['acp', 'native']),
  sessionId: z.string().min(1),
  processId: z.number().int().positive().optional(),
  promptState: z.enum(['NOT_SENT', 'INTENDED', 'SENT', 'COMPLETED', 'OUTCOME_UNCERTAIN']),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).superRefine(requireLifecycleLinkage);
export type AgentSessionRecord = z.infer<typeof agentSessionRecordSchema>;

const waveMemberSchema = scopedTaskRefSchema.extend({
  contracts: z.array(contractRefSchema).readonly(),
  verificationPlan: verificationPlanRefSchema.optional(),
  testCaseRefs: z.array(testCaseRefSchema).readonly().optional(),
  commandRefs: readonlyStringArraySchema.optional(),
  objective: z.string().min(1),
  allowedPaths: readonlyStringArraySchema,
  agentId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
}).strict().superRefine((member, context) => {
  requireSortedUnique(member.contracts, contractRefSortKey, 'contracts', context);
  if (member.testCaseRefs !== undefined) {
    requireSortedUnique(member.testCaseRefs, testCaseRefKey, 'testCaseRefs', context);
  }
  if (member.commandRefs !== undefined) {
    requireSortedUnique(member.commandRefs, (item) => item, 'commandRefs', context);
  }
});

const deferredWaveMemberSchema = scopedTaskRefSchema.extend({
  reasons: readonlyStringArraySchema,
}).strict();

export const waveSchema = z.strictObject({
  ...lifecycleShape,
  id: waveIdSchema,
  worksetId: worksetIdSchema,
  status: z.enum(WAVE_STATUSES),
  inputHash: contentHashSchema,
  members: z.array(waveMemberSchema).readonly(),
  deferred: z.array(deferredWaveMemberSchema).readonly(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).superRefine((wave, context) => {
  requireLifecycleLinkage(wave, context);
  requireSortedUnique(wave.members, scopedTaskSortKey, 'members', context);
  requireSortedUnique(wave.deferred, scopedTaskSortKey, 'deferred', context);
});
export type Wave = z.infer<typeof waveSchema>;

export const writerClaimSchema = z.strictObject({
  ...lifecycleShape,
  project: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  runId: runIdSchema,
  runKind: z.enum(['PROJECT_WRITER', 'RECOVERY_WRITER']),
  phase: z.enum(CLAIM_PHASES),
  worktree: z.string().min(1),
  branch: z.string().min(1),
  ownerProcess: z.number().int().positive(),
  agentProtocol: z.enum(['acp', 'native']),
  agentId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  agentSessionId: z.string().min(1).optional(),
  acquiredAt: timestampSchema,
  heartbeatAt: timestampSchema,
  updatedAt: timestampSchema.optional(),
}).superRefine(requireLifecycleLinkage);
export type WriterClaim = z.infer<typeof writerClaimSchema>;

const legacyCommitSetMemberBaseShape = {
  ...scopedTaskRefSchema.shape,
  runId: runIdSchema,
  contracts: z.array(contractRefSchema).readonly(),
};

const legacyPendingCommitSetMemberSchema = (status: 'PENDING' | 'RUNNING') => z.strictObject({
  ...legacyCommitSetMemberBaseShape,
  status: z.literal(status),
});

const legacyIntegratedCommitSetMemberSchema = z.strictObject({
  ...legacyCommitSetMemberBaseShape,
  status: z.literal('INTEGRATED'),
  reviewRunId: runIdSchema,
  commit: gitObjectIdSchema,
  evidenceRefs: z.array(evidenceIdSchema).min(1).readonly(),
});

const legacyFailedCommitSetMemberSchema = z.strictObject({
  ...legacyCommitSetMemberBaseShape,
  status: z.literal('FAILED'),
  reviewRunId: runIdSchema.optional(),
  failureHash: contentHashSchema,
  evidenceRefs: z.array(evidenceIdSchema).readonly(),
});

const legacyRevalidationCommitSetMemberSchema = z.strictObject({
  ...legacyCommitSetMemberBaseShape,
  status: z.literal('NEEDS_REVALIDATION'),
  reviewRunId: runIdSchema,
  commit: gitObjectIdSchema,
  evidenceRefs: z.array(evidenceIdSchema).readonly(),
});

export const commitSetMemberV1Schema = z.discriminatedUnion('status', [
  legacyPendingCommitSetMemberSchema('PENDING'),
  legacyPendingCommitSetMemberSchema('RUNNING'),
  legacyIntegratedCommitSetMemberSchema,
  legacyFailedCommitSetMemberSchema,
  legacyRevalidationCommitSetMemberSchema,
]);
export type CommitSetMemberV1 = z.infer<typeof commitSetMemberV1Schema>;

export const commitSetV1Schema = z.strictObject({
  ...lifecycleShape,
  id: commitsetIdSchema,
  worksetId: worksetIdSchema,
  status: z.enum(['OPEN', 'PARTIAL', 'COMPLETE', 'NEEDS_REVALIDATION']),
  scopeHash: contentHashSchema,
  contractSnapshots: z.array(contractRefSchema).readonly(),
  members: z.array(commitSetMemberV1Schema).min(1).readonly(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).superRefine(requireLifecycleLinkage);
export type CommitSetV1 = z.infer<typeof commitSetV1Schema>;

const commitSetMemberBaseShape = {
  ...scopedTaskRefSchema.shape,
  runId: runIdSchema,
  contracts: z.array(contractRefSchema).readonly(),
  verificationPlan: verificationPlanRefSchema.optional(),
  testCaseRefs: z.array(testCaseRefSchema).readonly().optional(),
};

const pendingCommitSetMemberSchema = (status: 'PENDING' | 'RUNNING') => z.strictObject({
  ...commitSetMemberBaseShape,
  status: z.literal(status),
});

const integratedCommitSetMemberSchema = z.strictObject({
  ...commitSetMemberBaseShape,
  status: z.literal('INTEGRATED'),
  reviewRunId: runIdSchema,
  commit: gitObjectIdSchema,
  commitTree: gitObjectIdSchema,
  verifiedTree: gitObjectIdSchema,
  metadataDeltaHash: contentHashSchema,
  evidenceRefs: z.array(evidenceIdSchema).min(1).readonly(),
});

const failedCommitSetMemberSchema = z.strictObject({
  ...commitSetMemberBaseShape,
  status: z.literal('FAILED'),
  reviewRunId: runIdSchema.optional(),
  failureHash: contentHashSchema,
  evidenceRefs: z.array(evidenceIdSchema).readonly(),
});

const revalidationCommitSetMemberSchema = z.strictObject({
  ...commitSetMemberBaseShape,
  status: z.literal('NEEDS_REVALIDATION'),
  reviewRunId: runIdSchema,
  commit: gitObjectIdSchema,
  commitTree: gitObjectIdSchema.optional(),
  verifiedTree: gitObjectIdSchema.optional(),
  metadataDeltaHash: contentHashSchema.optional(),
  evidenceRefs: z.array(evidenceIdSchema).readonly(),
});

export const commitSetMemberSchema = z.discriminatedUnion('status', [
  pendingCommitSetMemberSchema('PENDING'),
  pendingCommitSetMemberSchema('RUNNING'),
  integratedCommitSetMemberSchema,
  failedCommitSetMemberSchema,
  revalidationCommitSetMemberSchema,
]).superRefine((member, context) => {
  requireSortedUnique(member.contracts, contractRefSortKey, 'contracts', context);
  if (member.testCaseRefs !== undefined) {
    requireSortedUnique(member.testCaseRefs, testCaseRefKey, 'testCaseRefs', context);
  }
});
export type CommitSetMember = z.infer<typeof commitSetMemberSchema>;

const integrationGateRefSchema = z.strictObject({
  id: environmentRunIdSchema,
  inputHash: contentHashSchema,
});

export const commitSetSchema = z.strictObject({
  schemaVersion: z.literal(1),
  machineVersion: z.literal(2),
  lastEventSequence: z.number().int().nonnegative(),
  lastEventHash: contentHashSchema.nullable(),
  id: commitsetIdSchema,
  worksetId: worksetIdSchema,
  status: z.enum(COMMITSET_STATUSES),
  scopeHash: contentHashSchema,
  contractSnapshots: z.array(contractSnapshotBindingSchema).readonly(),
  legacyContractSnapshots: z.array(contractRefSchema).readonly().optional(),
  verificationPlan: verificationPlanRefSchema.optional(),
  members: z.array(commitSetMemberSchema).min(1).readonly(),
  integrationGateRefs: z.array(integrationGateRefSchema).readonly(),
  completionProofHash: contentHashSchema.optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).superRefine((commitSet, context) => {
  requireLifecycleLinkage(commitSet, context);
  requireSortedUnique(commitSet.contractSnapshots, contractBindingSortKey, 'contractSnapshots', context);
  requireSortedUnique(commitSet.integrationGateRefs, (item) => `${item.id}\0${item.inputHash}`, 'integrationGateRefs', context);
  if (commitSet.status === 'COMPLETE' && commitSet.completionProofHash === undefined) {
    context.addIssue({ code: 'custom', path: ['completionProofHash'], message: 'COMPLETE requires completionProofHash' });
  }
  if (commitSet.status !== 'COMPLETE' && commitSet.completionProofHash !== undefined) {
    context.addIssue({ code: 'custom', path: ['completionProofHash'], message: 'completionProofHash is valid only for COMPLETE' });
  }
});
export type CommitSet = z.infer<typeof commitSetSchema>;

export const executionEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  eventId: z.string().min(1),
  aggregateType: z.enum(['contract', 'wave', 'run', 'claim', 'commitset', 'attention', 'verification-plan', 'environment-run']),
  aggregateId: z.string().min(1),
  machineVersion: z.number().int().positive(),
  sequence: z.number().int().positive(),
  type: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  payload: z.record(z.string(), z.json()),
  previousHash: contentHashSchema.nullable(),
  timestamp: timestampSchema,
  hash: contentHashSchema,
}).superRefine((event, context) => {
  if ((event.sequence === 1 && event.previousHash !== null) ||
      (event.sequence > 1 && event.previousHash === null)) {
    context.addIssue({ code: 'custom', path: ['previousHash'], message: 'previousHash must link to the preceding event' });
  }
});
export type ExecutionEvent = z.infer<typeof executionEventSchema>;

const attentionOptionSchema = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  evidenceRefs: readonlyStringArraySchema,
});

const attentionItemShape = {
  ...lifecycleShape,
  id: attentionIdSchema,
  kind: z.enum(['NEEDS_DECISION', 'EXTERNAL_ACTION_REQUIRED', 'SAFETY_UNPROVEN']),
  scope: z.strictObject({
    worksetId: worksetIdSchema,
    contractId: contractIdSchema.optional(),
    runId: runIdSchema.optional(),
    project: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  }),
  question: z.string().min(1),
  options: z.array(attentionOptionSchema).readonly(),
  evidenceRefs: readonlyStringArraySchema,
  blockingProjects: readonlyStringArraySchema,
  createdByRuns: z.array(runIdSchema).readonly(),
  fingerprint: contentHashSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema.optional(),
};

export const attentionItemSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...attentionItemShape, status: z.literal('OPEN') }),
  z.strictObject({ ...attentionItemShape, status: z.literal('RESOLVED'), resolvedAt: timestampSchema }),
]).superRefine(requireLifecycleLinkage);
export type AttentionItem = z.infer<typeof attentionItemSchema>;

/**
 * 对抗性 schema 的跨记录一致性校验。
 *
 * 这些校验必须位于 Zod 边界内部：调用方即使同时篡改内容与哈希，也不能
 * 绕过策略引用、任务作用域、case/command 绑定和豁免互斥关系。
 */
function validateAdversarialCoveragePolicy(
  policy: AdversarialCoveragePolicy,
  context: z.RefinementCtx,
): void {
  requireSortedUnique(policy.vectors, (vector) => vector.id, 'vectors', context);
  const knownVectors = new Set(policy.vectors.map((vector) => vector.id));
  for (let index = 0; index < policy.vectors.length; index += 1) {
    requireSortedUnique(
      policy.vectors[index]!.safetyProperties,
      (value) => value,
      `vectors.${index}.safetyProperties`,
      context,
    );
  }
  requireSortedUnique(policy.requirements, (requirement) => requirement.scope, 'requirements', context);
  for (let requirementIndex = 0; requirementIndex < policy.requirements.length; requirementIndex += 1) {
    const requirement = policy.requirements[requirementIndex]!;
    requireSortedUnique(
      requirement.vectorIds,
      (value) => value,
      `requirements.${requirementIndex}.vectorIds`,
      context,
    );
    for (let vectorIndex = 0; vectorIndex < requirement.vectorIds.length; vectorIndex += 1) {
      if (!knownVectors.has(requirement.vectorIds[vectorIndex]!)) {
        context.addIssue({
          code: 'custom',
          path: ['requirements', requirementIndex, 'vectorIds', vectorIndex],
          message: 'ADVERSARIAL_POLICY_VECTOR_UNKNOWN',
        });
      }
    }
  }
  if (policy.contentHash !== hashAdversarialCoveragePolicy(policy)) {
    context.addIssue({
      code: 'custom',
      path: ['contentHash'],
      message: 'ADVERSARIAL_POLICY_CONTENT_HASH_MISMATCH',
    });
  }
}

function adversarialScopeSortKey(scope: AdversarialRequirementScope): string {
  return scope.kind === 'TASK'
    ? JSON.stringify([
        scope.kind,
        scope.scopedTask.project,
        scope.scopedTask.changeId,
        scope.scopedTask.revision,
        scope.scopedTask.baseline,
        scope.scopedTask.taskId,
      ])
    : JSON.stringify([
        scope.kind,
        scope.worksetId,
        scope.contractKey,
        scope.scopeHash,
        scope.contractSnapshot.id,
        scope.contractSnapshot.contentHash,
        scope.scenarioId,
      ]);
}

function adversarialRequirementSortKey(requirement: AdversarialRequirement): string {
  return JSON.stringify([
    sourceRefSortKey(requirement.policy),
    adversarialScopeSortKey(requirement.scope),
    requirement.vectorIds,
  ]);
}

function adversarialCheckSortKey(check: AdversarialCheck): string {
  return JSON.stringify([
    sourceRefSortKey(check.policy),
    adversarialScopeSortKey(check.scope),
    check.vectors.map((vector) => [vector.vectorId, vector.caseRefs.map(testCaseRefKey)]),
    check.commandRefs,
  ]);
}

function adversarialExemptionSortKey(exemption: AdversarialExemption): string {
  return JSON.stringify([
    sourceRefSortKey(exemption.policy),
    adversarialScopeSortKey(exemption.scope),
    exemption.vectorIds,
    exemption.reasonCode,
    exemption.sourceRefs.map(sourceRefSortKey),
    exemption.explanationHash,
  ]);
}

function sameSourceRef(left: ContentAddressedSourceRef, right: ContentAddressedSourceRef): boolean {
  return left.ref === right.ref && left.contentHash === right.contentHash;
}

function assurancePairKey(scope: AdversarialRequirementScope, vectorId: string): string {
  return JSON.stringify([adversarialScopeSortKey(scope), vectorId]);
}

function contractCaseMatchesAdversarialScope(
  ref: TestCaseRef,
  scope: Extract<AdversarialRequirementScope, { kind: 'CONTRACT_SCENARIO' }>,
): boolean {
  return ref.scope.kind === 'CONTRACT' &&
    ref.scope.worksetId === scope.worksetId &&
    ref.scope.contractKey === scope.contractKey &&
    ref.scope.scopeHash === scope.scopeHash &&
    ref.scope.contractSnapshot.id === scope.contractSnapshot.id &&
    ref.scope.contractSnapshot.contentHash === scope.contractSnapshot.contentHash &&
    ref.scope.scenarioId === scope.scenarioId;
}

function validateVerificationPlanV2(plan: VerificationPlanV2, context: z.RefinementCtx): void {
  requireLifecycleLinkage(plan, context);
  requireSortedUnique(plan.contractSnapshots, contractBindingSortKey, 'contractSnapshots', context);
  requireSortedUnique(plan.projectChecks, (item) => item.project, 'projectChecks', context);
  requireSortedUnique(plan.integrationCaseRefs, testCaseRefKey, 'integrationCaseRefs', context);
  requireSortedUnique(
    plan.adversarialRequirements,
    adversarialRequirementSortKey,
    'adversarialRequirements',
    context,
  );
  requireSortedUnique(plan.adversarialChecks, adversarialCheckSortKey, 'adversarialChecks', context);
  requireSortedUnique(plan.adversarialExemptions, adversarialExemptionSortKey, 'adversarialExemptions', context);

  const assuranceRecords: ReadonlyArray<{
    readonly policy: ContentAddressedSourceRef;
    readonly scope: AdversarialRequirementScope;
    readonly field: 'adversarialRequirements' | 'adversarialChecks' | 'adversarialExemptions';
    readonly index: number;
  }> = [
    ...plan.adversarialRequirements.map((record, index) => ({
      policy: record.policy,
      scope: record.scope,
      field: 'adversarialRequirements' as const,
      index,
    })),
    ...plan.adversarialChecks.map((record, index) => ({
      policy: record.policy,
      scope: record.scope,
      field: 'adversarialChecks' as const,
      index,
    })),
    ...plan.adversarialExemptions.map((record, index) => ({
      policy: record.policy,
      scope: record.scope,
      field: 'adversarialExemptions' as const,
      index,
    })),
  ];
  for (const record of assuranceRecords) {
    if (!sameSourceRef(record.policy, plan.adversarialPolicy)) {
      context.addIssue({
        code: 'custom',
        path: [record.field, record.index, 'policy'],
        message: 'ADVERSARIAL_POLICY_REF_MISMATCH',
      });
    }
  }

  const taskRequirementKeys = new Set(
    plan.adversarialRequirements
      .filter((requirement) => requirement.scope.kind === 'TASK')
      .map((requirement) => adversarialScopeSortKey(requirement.scope)),
  );
  const taskPlacements = new Map<string, Array<{ projectIndex: number; taskIndex: number }>>();
  for (let projectIndex = 0; projectIndex < plan.projectChecks.length; projectIndex += 1) {
    const projectCheck = plan.projectChecks[projectIndex]!;
    for (let taskIndex = 0; taskIndex < projectCheck.scopedTasks.length; taskIndex += 1) {
      const task = projectCheck.scopedTasks[taskIndex]!;
      const taskKey = scopedTaskSortKey(task);
      const placements = taskPlacements.get(taskKey) ?? [];
      placements.push({ projectIndex, taskIndex });
      taskPlacements.set(taskKey, placements);
      if (task.project !== projectCheck.project) {
        context.addIssue({
          code: 'custom',
          path: ['projectChecks', projectIndex, 'scopedTasks', taskIndex],
          message: 'ADVERSARIAL_TASK_SCOPE_INVALID',
        });
      }
    }
  }
  for (const placements of taskPlacements.values()) {
    const first = placements[0]!;
    if (placements.length !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['projectChecks', first.projectIndex, 'scopedTasks', first.taskIndex],
        message: 'ADVERSARIAL_TASK_SCOPE_INVALID',
      });
    }
    const task = plan.projectChecks[first.projectIndex]!.scopedTasks[first.taskIndex]!;
    const taskScope: AdversarialRequirementScope = { kind: 'TASK', scopedTask: task };
    if (!taskRequirementKeys.has(adversarialScopeSortKey(taskScope))) {
      context.addIssue({
        code: 'custom',
        path: ['projectChecks', first.projectIndex, 'scopedTasks', first.taskIndex],
        message: 'ADVERSARIAL_TASK_REQUIREMENT_MISSING',
      });
    }
  }

  for (const record of assuranceRecords) {
    if (record.scope.kind !== 'TASK') continue;
    const placements = taskPlacements.get(scopedTaskSortKey(record.scope.scopedTask));
    const placement = placements?.length === 1 ? placements[0] : undefined;
    if (placement === undefined ||
        plan.projectChecks[placement.projectIndex]!.project !== record.scope.scopedTask.project) {
      context.addIssue({
        code: 'custom',
        path: [record.field, record.index, 'scope'],
        message: 'ADVERSARIAL_TASK_SCOPE_INVALID',
      });
    }
  }

  const requirementCounts = new Map<string, number>();
  for (const requirement of plan.adversarialRequirements) {
    for (const vectorId of requirement.vectorIds) {
      const key = assurancePairKey(requirement.scope, vectorId);
      requirementCounts.set(key, (requirementCounts.get(key) ?? 0) + 1);
    }
  }
  const checkCoverageCounts = new Map<string, number>();
  for (const check of plan.adversarialChecks) {
    for (const vector of check.vectors) {
      const key = assurancePairKey(check.scope, vector.vectorId);
      checkCoverageCounts.set(key, (checkCoverageCounts.get(key) ?? 0) + 1);
    }
  }
  const exemptionCoverageCounts = new Map<string, number>();
  for (const exemption of plan.adversarialExemptions) {
    for (const vectorId of exemption.vectorIds) {
      const key = assurancePairKey(exemption.scope, vectorId);
      exemptionCoverageCounts.set(key, (exemptionCoverageCounts.get(key) ?? 0) + 1);
    }
  }
  const coverageCounts = new Map<string, number>();
  for (const [key, count] of checkCoverageCounts) coverageCounts.set(key, count);
  for (const [key, count] of exemptionCoverageCounts) {
    coverageCounts.set(key, (coverageCounts.get(key) ?? 0) + count);
  }
  const assuranceKeys = new Set([...requirementCounts.keys(), ...coverageCounts.keys()]);
  if ([...assuranceKeys].some((key) =>
    requirementCounts.get(key) !== 1 || coverageCounts.get(key) !== 1)) {
    context.addIssue({
      code: 'custom',
      path: ['adversarialRequirements'],
      message: 'ADVERSARIAL_ASSURANCE_PARTITION_INVALID',
    });
  }

  for (let projectIndex = 0; projectIndex < plan.projectChecks.length; projectIndex += 1) {
    const projectCheck = plan.projectChecks[projectIndex]!;
    if (projectCheck.caseRefs.length !== 0 || projectCheck.commandRefs.length !== 0) continue;
    for (let taskIndex = 0; taskIndex < projectCheck.scopedTasks.length; taskIndex += 1) {
      const task = projectCheck.scopedTasks[taskIndex]!;
      const scope: AdversarialRequirementScope = { kind: 'TASK', scopedTask: task };
      const requirement = plan.adversarialRequirements.find((candidate) =>
        adversarialScopeSortKey(candidate.scope) === adversarialScopeSortKey(scope));
      const fullyExempt = requirement !== undefined && requirement.vectorIds.every((vectorId) => {
        const key = assurancePairKey(scope, vectorId);
        return (checkCoverageCounts.get(key) ?? 0) === 0 &&
          exemptionCoverageCounts.get(key) === 1;
      });
      if (!fullyExempt) {
        context.addIssue({
          code: 'custom',
          path: ['projectChecks', projectIndex, 'scopedTasks', taskIndex],
          message: 'VERIFICATION_TASK_UNCOVERED',
        });
      }
    }
  }

  const ordinaryCaseKeys = new Set([
    ...plan.projectChecks.flatMap((check) => check.caseRefs),
    ...plan.integrationCaseRefs,
  ].map(testCaseRefKey));
  for (let checkIndex = 0; checkIndex < plan.adversarialChecks.length; checkIndex += 1) {
    const check = plan.adversarialChecks[checkIndex]!;
    const scopedTask = check.scope.kind === 'TASK' ? check.scope.scopedTask : undefined;
    const placements = scopedTask === undefined
      ? undefined
      : taskPlacements.get(scopedTaskSortKey(scopedTask));
    const taskPlacement = placements?.length === 1 ? placements[0] : undefined;
    const taskProjectCheck = taskPlacement === undefined
      ? undefined
      : plan.projectChecks[taskPlacement.projectIndex];
    const taskCaseKeys = taskProjectCheck === undefined
      ? undefined
      : new Set(taskProjectCheck.caseRefs.map(testCaseRefKey));
    const taskCommandRefs = taskProjectCheck === undefined
      ? undefined
      : new Set(taskProjectCheck.commandRefs);
    for (let vectorIndex = 0; vectorIndex < check.vectors.length; vectorIndex += 1) {
      const vector = check.vectors[vectorIndex]!;
      for (let caseIndex = 0; caseIndex < vector.caseRefs.length; caseIndex += 1) {
        const caseRef = vector.caseRefs[caseIndex]!;
        const caseKey = testCaseRefKey(caseRef);
        if (check.scope.kind === 'TASK' && !taskCaseKeys?.has(caseKey)) {
          context.addIssue({
            code: 'custom',
            path: ['adversarialChecks', checkIndex, 'vectors', vectorIndex, 'caseRefs', caseIndex],
            message: 'ADVERSARIAL_CHECK_CASE_REF_UNKNOWN',
          });
        } else if (check.scope.kind === 'CONTRACT_SCENARIO' && !ordinaryCaseKeys.has(caseKey)) {
          context.addIssue({
            code: 'custom',
            path: ['adversarialChecks', checkIndex, 'vectors', vectorIndex, 'caseRefs', caseIndex],
            message: 'ADVERSARIAL_CHECK_CASE_REF_UNKNOWN',
          });
        } else if (check.scope.kind === 'CONTRACT_SCENARIO' &&
            !contractCaseMatchesAdversarialScope(caseRef, check.scope)) {
          context.addIssue({
            code: 'custom',
            path: ['adversarialChecks', checkIndex, 'vectors', vectorIndex, 'caseRefs', caseIndex],
            message: 'ADVERSARIAL_CHECK_CASE_REF_SCOPE_MISMATCH',
          });
        }
      }
    }
    if (check.scope.kind === 'TASK') {
      for (let commandIndex = 0; commandIndex < check.commandRefs.length; commandIndex += 1) {
        if (!taskCommandRefs?.has(check.commandRefs[commandIndex]!)) {
          context.addIssue({
            code: 'custom',
            path: ['adversarialChecks', checkIndex, 'commandRefs', commandIndex],
            message: 'ADVERSARIAL_CHECK_COMMAND_REF_UNKNOWN',
          });
        }
      }
    }
  }

  if (plan.contentHash !== hashVerificationPlan(plan)) {
    context.addIssue({
      code: 'custom',
      path: ['contentHash'],
      message: 'VERIFICATION_PLAN_CONTENT_HASH_MISMATCH',
    });
  }
}

function validateTestCaseV2(testCase: TestCaseV2, context: z.RefinementCtx): void {
  requireSortedUnique(testCase.sourceRefs, sourceRefSortKey, 'sourceRefs', context);
  requireOneHashPerLogicalRef(testCase.sourceRefs, 'sourceRefs', context);
  requireSortedUnique(testCase.scopedTasks, scopedTaskSortKey, 'scopedTasks', context);
  requireSortedUnique(testCase.commandRefs, (item) => item, 'commandRefs', context);
  if (testCase.adversarial !== undefined) {
    for (let index = 0; index < testCase.adversarial.threatRefs.length; index += 1) {
      const threat = testCase.adversarial.threatRefs[index]!;
      if (!testCase.sourceRefs.some((source) =>
        source.ref === threat.ref && source.contentHash === threat.contentHash)) {
        context.addIssue({
          code: 'custom',
          path: ['adversarial', 'threatRefs', index],
          message: 'ADVERSARIAL_THREAT_SOURCE_MISSING',
        });
      }
    }
  }
  if (testCase.contentHash !== hashTestCase(testCase)) {
    context.addIssue({ code: 'custom', path: ['contentHash'], message: 'TEST_CASE_CONTENT_HASH_MISMATCH' });
  }
}

function requireOneHashPerLogicalRef(
  sourceRefs: readonly ContentAddressedSourceRef[],
  field: string,
  context: z.RefinementCtx,
): void {
  const hashesByRef = new Map<string, ContentHash>();
  for (let index = 0; index < sourceRefs.length; index += 1) {
    const source = sourceRefs[index]!;
    const existingHash = hashesByRef.get(source.ref);
    if (existingHash !== undefined && existingHash !== source.contentHash) {
      context.addIssue({
        code: 'custom',
        path: [field, index],
        message: 'TEST_CASE_SOURCE_IDENTITY_CONFLICT',
      });
      return;
    }
    hashesByRef.set(source.ref, source.contentHash);
  }
}

function participantSortKey(participant: z.infer<typeof contractParticipantSchema>): string {
  return [
    participant.project,
    participant.changeId,
    participant.revision,
    participant.baseline ?? '',
    participant.taskId,
    participant.role,
  ].join('\0');
}

function sourceSortKey(source: z.infer<typeof contractSourceSchema>): string {
  return JSON.stringify([source.project, source.ref, source.kind, source.contentHash]);
}

function sourceRefSortKey(source: z.infer<typeof contentAddressedSourceRefSchema>): string {
  return JSON.stringify([source.ref, source.contentHash]);
}

function contractScenarioRefSortKey(ref: ContractScenarioRef): string {
  return JSON.stringify([
    ref.contractKey,
    ref.scopeHash,
    ref.snapshot.id,
    ref.snapshot.contentHash,
    ref.scenarioId,
    ref.contentHash,
  ]);
}

function scopedTaskSortKey(task: ScopedTaskRef): string {
  return JSON.stringify([task.project, task.changeId, task.revision, task.baseline, task.taskId]);
}

function contractBindingSortKey(binding: ContractSnapshotBinding): string {
  return JSON.stringify([
    binding.contractKey,
    binding.scopeHash,
    binding.snapshot.id,
    binding.snapshot.contentHash,
  ]);
}

function contractRefSortKey(ref: ContractRef): string {
  return JSON.stringify([ref.id, ref.contentHash]);
}

function verificationProjectInputSortKey(input: VerificationProjectInput): string {
  return JSON.stringify([input.project, input.changeId, input.revision, input.baseline, input.taskId]);
}

function integrationProfileRefSortKey(ref: IntegrationEnvironmentProfileRef): string {
  return JSON.stringify([ref.id, ref.contentHash]);
}

function notApplicableDecisionSortKey(decision: NotApplicableDecision): string {
  return JSON.stringify([decision.subjectKind, decision.subjectRef, decision.subjectHash, decision.policyId]);
}

function verificationDiagnosticSortKey(diagnostic: VerificationDiagnostic): string {
  return JSON.stringify([diagnostic.code, diagnostic.subjectRef, diagnostic.message]);
}

function namedDigestSortKey(digest: z.infer<typeof namedDigestSchema>): string {
  return JSON.stringify([digest.ref, digest.digest]);
}

function requireLifecycleLinkage(
  value: { lastEventSequence: number; lastEventHash: ContentHash | null },
  context: z.RefinementCtx,
): void {
  if ((value.lastEventSequence === 0 && value.lastEventHash !== null) ||
      (value.lastEventSequence > 0 && value.lastEventHash === null)) {
    context.addIssue({ code: 'custom', path: ['lastEventHash'], message: 'lastEventHash must match lastEventSequence' });
  }
}

function requireSorted<T>(
  items: readonly T[],
  key: (item: T) => string,
  field: string,
  context: z.RefinementCtx,
): void {
  for (let index = 1; index < items.length; index += 1) {
    if (key(items[index - 1]!) > key(items[index]!)) {
      context.addIssue({ code: 'custom', path: [field], message: `${field} must be sorted` });
      return;
    }
  }
}

function requireSortedUnique<T>(
  items: readonly T[],
  key: (item: T) => string,
  field: string,
  context: z.RefinementCtx,
): void {
  for (let index = 1; index < items.length; index += 1) {
    if (key(items[index - 1]!) >= key(items[index]!)) {
      context.addIssue({ code: 'custom', path: [field], message: `SORTED_UNIQUE: ${field}` });
      return;
    }
  }
}
