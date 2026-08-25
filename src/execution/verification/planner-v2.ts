import { z } from 'zod';
import {
  contentHashSchema,
  contractSnapshotBindingSchema,
  integrationEnvironmentProfileRefSchema,
  scopedTaskRefSchema,
  hashVerificationPlan,
  testCaseRefKey,
  testCaseRefSchema,
  anyTestCaseSchema,
  verificationPlanV2Schema,
  type AdversarialCoveragePolicy,
  type AdversarialExemption,
  type AdversarialPolicyRef,
  type AdversarialRequirement,
  type AnyTestCase,
  type ContentAddressedSourceRef,
  type ContentHash,
  type ContractSnapshotBinding,
  type IntegrationEnvironmentProfileRef,
  type ScopedTaskRef,
  type TestCaseRef,
  type VerificationPlanV2,
} from '../types.js';
import {
  compileAdversarialAssurance,
  type CompiledAdversarialAssurance,
} from './adversarial.js';
import {
  compileTestCase,
  scopedTaskKey,
  testCaseScopedIdentityKey,
  VerificationFlowError,
  type CompiledTestCase,
  type VerificationFlowIssueCode,
} from './test-cases.js';

/**
 * 对抗性 VerificationPlan v2 的纯编译输入。
 *
 * 背景：合并分支曾与持久化 Task 9A 编译器复用同名入口，导致权威职责冲突。
 * 目的：该模块只生成可复现的准入证明；磁盘持久化仍由 planner.ts 负责。
 */
export interface CompileVerificationPlanInput {
  readonly id: string;
  readonly worksetId: string;
  readonly scopeHash: ContentHash;
  readonly contractSnapshots: readonly ContractSnapshotBinding[];
  readonly profile: IntegrationEnvironmentProfileRef;
  readonly requiredTasks: readonly ScopedTaskRef[];
  readonly cases: readonly CompiledTestCase[];
  readonly adversarialPolicy: AdversarialCoveragePolicy;
  readonly adversarialPolicyRef: AdversarialPolicyRef;
  readonly adversarialRequirements: readonly AdversarialRequirement[];
  readonly adversarialExemptions: readonly AdversarialExemption[];
  readonly authoritativeSourceRefs: readonly ContentAddressedSourceRef[];
  readonly createdAt: string;
}

const ordinaryPlanInputShape = {
  id: z.string().min(1),
  worksetId: z.string().min(1),
  scopeHash: contentHashSchema,
  contractSnapshots: z.array(contractSnapshotBindingSchema).readonly(),
  profile: integrationEnvironmentProfileRefSchema,
  requiredTasks: z.array(scopedTaskRefSchema).readonly(),
  cases: z.array(z.unknown()).readonly(),
  createdAt: z.string().datetime(),
};

const verificationPlanV2InputSchema = z.strictObject({
  ...ordinaryPlanInputShape,
  adversarialPolicy: z.unknown(),
  adversarialPolicyRef: z.unknown(),
  adversarialRequirements: z.array(z.unknown()).readonly(),
  adversarialExemptions: z.array(z.unknown()).readonly(),
  authoritativeSourceRefs: z.array(z.unknown()).readonly(),
});

const compiledCaseInputSchema = z.strictObject({
  testCase: z.unknown(),
  ref: z.unknown(),
});

const PLAN_INPUT_DETAIL = 'verification plan input failed strict validation';

const planErrorDetails: Partial<Record<VerificationFlowIssueCode, string>> = {
  VERIFICATION_REQUIRED_TASKS_EMPTY: 'at least one required task is required',
  VERIFICATION_TASK_DUPLICATE: 'required tasks must be unique',
  VERIFICATION_TASK_UNCOVERED: 'every required task needs project-gate coverage',
  VERIFICATION_CASE_TASK_OUTSIDE_SCOPE: 'test case references a task outside the required scope',
  VERIFICATION_CONTRACT_MISMATCH: 'contract case must bind one current contract snapshot',
  VERIFICATION_CASE_SCHEMA_INVALID: 'compiled test case failed strict validation',
  VERIFICATION_CASE_REF_MISMATCH: 'compiled test case body and ref do not match',
  VERIFICATION_CASE_IDENTITY_CONFLICT: 'test case identity binds more than one body in the same scope',
  VERIFICATION_PLAN_INPUT_INVALID: PLAN_INPUT_DETAIL,
  ADVERSARIAL_POLICY_MISSING: 'current VerificationPlan compilation requires an exact adversarial policy',
  ADVERSARIAL_POLICY_STALE: 'adversarial policy does not bind exact assurance inputs',
  ADVERSARIAL_POLICY_VECTOR_UNKNOWN: 'adversarial assurance references an unknown policy vector',
  ADVERSARIAL_CASE_INVALID: 'compiled adversarial case failed strict validation',
  ADVERSARIAL_CASE_TASK_OUTSIDE_SCOPE: 'adversarial case or requirement is outside the required scope',
  ADVERSARIAL_WRITER_COVERAGE_MISSING: 'task assurance is covered only outside the project gate',
  ADVERSARIAL_COVERAGE_MISSING: 'required adversarial coverage is missing',
  ADVERSARIAL_SAFETY_ORACLE_MISSING: 'required adversarial safety oracle is missing',
  ADVERSARIAL_EXEMPTION_INVALID: 'adversarial exemption failed exact validation',
  TEST_CASE_SOURCE_IDENTITY_CONFLICT: 'source ref binds more than one content hash',
};

export function compileVerificationPlanV2(
  input: CompileVerificationPlanInput,
): VerificationPlanV2 {
  const parsedInput = parseVerificationPlanInput(input);
  try {
    return compileParsedVerificationPlan(parsedInput);
  } catch (error) {
    throw normalizePlanError(error);
  }
}

function compileParsedVerificationPlan(input: CompileVerificationPlanInput): VerificationPlanV2 {
  const requiredTasks = canonicalRequiredTasks(input.requiredTasks);
  if (requiredTasks.length === 0) {
    throw new VerificationFlowError('VERIFICATION_REQUIRED_TASKS_EMPTY', 'at least one required task is required');
  }
  const requiredTaskKeys = new Set(requiredTasks.map(scopedTaskKey));
  const contractSnapshots = canonicalUnique(
    input.contractSnapshots,
    contractBindingKey,
    'VERIFICATION_CONTRACT_MISMATCH',
  );
  const snapshotsByScope = new Map<string, ContractSnapshotBinding>();
  for (const binding of contractSnapshots) {
    const scopeKey = contractScopeKey(binding);
    const current = snapshotsByScope.get(scopeKey);
    if (current !== undefined) {
      throw new VerificationFlowError(
        'VERIFICATION_CONTRACT_MISMATCH',
        `${binding.contractKey}/${binding.scopeHash} binds both ${current.snapshot.id} and ${binding.snapshot.id}`,
      );
    }
    snapshotsByScope.set(scopeKey, binding);
  }
  const cases = validateAndCanonicalizeCases(input.cases);

  for (const compiled of cases) {
    for (const task of compiled.testCase.scopedTasks) {
      if (!requiredTaskKeys.has(scopedTaskKey(task))) {
        throw new VerificationFlowError(
          compiled.testCase.schemaVersion === 2 && compiled.testCase.adversarial !== undefined
            ? 'ADVERSARIAL_CASE_TASK_OUTSIDE_SCOPE'
            : 'VERIFICATION_CASE_TASK_OUTSIDE_SCOPE',
          `${compiled.ref.id} references ${scopedTaskKey(task)}`,
        );
      }
    }
    if (compiled.ref.scope.kind === 'CONTRACT') {
      const scope = compiled.ref.scope;
      const expectedBindingKey = contractBindingKey({
        contractKey: scope.contractKey,
        scopeHash: scope.scopeHash,
        snapshot: scope.contractSnapshot,
      });
      if (scope.worksetId !== input.worksetId || !contractSnapshots.some((item) => contractBindingKey(item) === expectedBindingKey)) {
        throw new VerificationFlowError(
          'VERIFICATION_CONTRACT_MISMATCH',
          `${compiled.ref.id} does not bind a current ContractSnapshot`,
        );
      }
    }
  }

  const projectGateCases = cases.filter(isProjectGateCase);
  const assurance = compileAdversarialAssurance({
    policy: input.adversarialPolicy,
    policyRef: input.adversarialPolicyRef,
    requirements: input.adversarialRequirements,
    exemptions: input.adversarialExemptions,
    authoritativeSourceRefs: input.authoritativeSourceRefs,
    requiredTasks,
    cases,
  });
  for (const task of requiredTasks) {
    if (!projectGateCases.some((compiled) =>
      compiled.testCase.scopedTasks.some((candidate) => scopedTaskKey(candidate) === scopedTaskKey(task))) &&
        !isFullyExemptTask(task, assurance)) {
      throw new VerificationFlowError(
        'VERIFICATION_TASK_UNCOVERED',
        `${task.project}/${task.changeId}/${task.revision}/${task.baseline}/${task.taskId}`,
      );
    }
  }

  const projects = [...new Set(requiredTasks.map((task) => task.project))].sort(compare);
  const projectChecks = projects.map((project) => {
    const scopedTasks = requiredTasks.filter((task) => task.project === project);
    const scopedTaskKeys = new Set(scopedTasks.map(scopedTaskKey));
    const projectCases = projectGateCases.filter((compiled) =>
      compiled.testCase.scopedTasks.some((task) => scopedTaskKeys.has(scopedTaskKey(task))));
    const caseRefs = canonicalUnique(projectCases.map((compiled) => compiled.ref), testCaseRefKey, 'VERIFICATION_CASE_IDENTITY_CONFLICT');
    const commandRefs = [...new Set(projectCases.flatMap((compiled) => compiled.testCase.commandRefs))].sort(compare);
    return { project, scopedTasks, caseRefs, commandRefs };
  });
  const integrationCaseRefs = canonicalUnique(
    cases.filter(isIntegrationCase).map((compiled) => compiled.ref),
    testCaseRefKey,
    'VERIFICATION_CASE_IDENTITY_CONFLICT',
  );

  const commonIdentity = {
    id: input.id,
    worksetId: input.worksetId,
    scopeHash: input.scopeHash,
    contractSnapshots,
    profile: input.profile,
    projectChecks,
    integrationCaseRefs,
  } as const;

  const identity = {
    schemaVersion: 2,
    ...commonIdentity,
    adversarialPolicy: assurance.policyRef,
    adversarialRequirements: assurance.requirements,
    adversarialChecks: assurance.checks,
    adversarialExemptions: assurance.exemptions,
  } as const;

  try {
    return verificationPlanV2Schema.parse({
      ...identity,
      machineVersion: 2,
      lastEventSequence: 0,
      lastEventHash: null,
      status: 'READY',
      contentHash: hashVerificationPlan(identity),
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    });
  } catch {
    throw new VerificationFlowError('ADVERSARIAL_COVERAGE_MISSING', 'compiled plan failed strict validation');
  }
}

function parseVerificationPlanInput(input: unknown): CompileVerificationPlanInput {
  let isV2: boolean;
  try {
    isV2 = hasAdversarialInput(input);
  } catch {
    throw new VerificationFlowError('VERIFICATION_PLAN_INPUT_INVALID', PLAN_INPUT_DETAIL);
  }
  if (!isV2) {
    throw new VerificationFlowError(
      'ADVERSARIAL_POLICY_MISSING',
      'current VerificationPlan compilation requires an exact adversarial policy',
    );
  }
  let parsed: ReturnType<typeof verificationPlanV2InputSchema.safeParse>;
  try {
    parsed = verificationPlanV2InputSchema.safeParse(input);
  } catch {
    throw new VerificationFlowError('VERIFICATION_PLAN_INPUT_INVALID', PLAN_INPUT_DETAIL);
  }
  if (!parsed.success) {
    throw new VerificationFlowError('VERIFICATION_PLAN_INPUT_INVALID', PLAN_INPUT_DETAIL);
  }
  return parsed.data as unknown as CompileVerificationPlanInput;
}

function normalizePlanError(error: unknown): VerificationFlowError {
  if (error instanceof VerificationFlowError) {
    const detail = planErrorDetails[error.code];
    if (detail !== undefined) return new VerificationFlowError(error.code, detail);
  }
  return new VerificationFlowError('VERIFICATION_PLAN_INPUT_INVALID', PLAN_INPUT_DETAIL);
}

function hasAdversarialInput(
  input: unknown,
): boolean {
  if (input === undefined || input === null || typeof input !== 'object') return false;
  return [
    'adversarialPolicy',
    'adversarialPolicyRef',
    'adversarialRequirements',
    'adversarialExemptions',
    'authoritativeSourceRefs',
  ].some((field) => Object.prototype.hasOwnProperty.call(input, field));
}

function isProjectGateCase(compiled: CompiledTestCase): boolean {
  return ['UNIT', 'COMPONENT', 'CONTRACT_PROVIDER', 'CONTRACT_CONSUMER'].includes(compiled.testCase.level);
}

function isIntegrationCase(compiled: CompiledTestCase): boolean {
  return compiled.testCase.level === 'INTEGRATION' || compiled.testCase.level === 'E2E';
}

function isFullyExemptTask(
  task: ScopedTaskRef,
  assurance: CompiledAdversarialAssurance,
): boolean {
  const taskKey = scopedTaskKey(task);
  const requirement = assurance.requirements.find((candidate) =>
    candidate.scope.kind === 'TASK' && scopedTaskKey(candidate.scope.scopedTask) === taskKey);
  if (requirement === undefined) return false;
  return requirement.vectorIds.every((vectorId) => {
    const checked = assurance.checks.some((check) =>
      check.scope.kind === 'TASK' &&
      scopedTaskKey(check.scope.scopedTask) === taskKey &&
      check.vectors.some((vector) => vector.vectorId === vectorId));
    const exempted = assurance.exemptions.some((exemption) =>
      exemption.scope.kind === 'TASK' &&
      scopedTaskKey(exemption.scope.scopedTask) === taskKey &&
      exemption.vectorIds.includes(vectorId));
    return !checked && exempted;
  });
}

function validateAndCanonicalizeCases(cases: readonly CompiledTestCase[]): readonly CompiledTestCase[] {
  const validated = cases.map((candidate) => {
    let compiled: z.infer<typeof compiledCaseInputSchema>;
    let body: AnyTestCase;
    let ref: TestCaseRef;
    try {
      compiled = compiledCaseInputSchema.parse(candidate);
      body = anyTestCaseSchema.parse(compiled.testCase);
      ref = testCaseRefSchema.parse(compiled.ref);
    } catch {
      throw new VerificationFlowError('VERIFICATION_CASE_SCHEMA_INVALID', 'compiled test case failed strict validation');
    }
    const { contentHash: _contentHash, ...bodyWithoutHash } = body;
    let authoritative: CompiledTestCase;
    try {
      authoritative = compileTestCase({ scope: ref.scope, testCase: bodyWithoutHash });
    } catch {
      throw new VerificationFlowError('VERIFICATION_CASE_REF_MISMATCH', 'compiled test case body and ref do not match');
    }
    if (authoritative.ref.id !== ref.id || authoritative.ref.contentHash !== ref.contentHash) {
      throw new VerificationFlowError(
        'VERIFICATION_CASE_REF_MISMATCH',
        `${ref.id} body hash ${authoritative.ref.contentHash} does not match ${ref.contentHash}`,
      );
    }
    return authoritative;
  });
  const byScopedIdentity = [...validated].sort((left, right) =>
    compare(testCaseScopedIdentityKey(left.ref), testCaseScopedIdentityKey(right.ref)) ||
    compare(left.ref.contentHash, right.ref.contentHash));
  for (let index = 1; index < byScopedIdentity.length; index += 1) {
    if (testCaseScopedIdentityKey(byScopedIdentity[index - 1]!.ref) === testCaseScopedIdentityKey(byScopedIdentity[index]!.ref)) {
      throw new VerificationFlowError(
        'VERIFICATION_CASE_IDENTITY_CONFLICT',
        `${byScopedIdentity[index]!.ref.id} has more than one body in the same scope`,
      );
    }
  }
  return [...validated].sort((left, right) => compare(testCaseRefKey(left.ref), testCaseRefKey(right.ref)));
}

function canonicalRequiredTasks(tasks: readonly ScopedTaskRef[]): readonly ScopedTaskRef[] {
  return canonicalUnique(tasks, scopedTaskKey, 'VERIFICATION_TASK_DUPLICATE');
}

function canonicalUnique<T>(
  items: readonly T[],
  key: (item: T) => string,
  duplicateCode: 'VERIFICATION_TASK_DUPLICATE' | 'VERIFICATION_CONTRACT_MISMATCH' | 'VERIFICATION_CASE_IDENTITY_CONFLICT',
): readonly T[] {
  const result = [...items].sort((left, right) => compare(key(left), key(right)));
  for (let index = 1; index < result.length; index += 1) {
    if (key(result[index - 1]!) === key(result[index]!)) {
      throw new VerificationFlowError(duplicateCode, `duplicate ${key(result[index]!)}`);
    }
  }
  return result;
}

function contractBindingKey(binding: ContractSnapshotBinding): string {
  return JSON.stringify([
    binding.contractKey,
    binding.scopeHash,
    binding.snapshot.id,
    binding.snapshot.contentHash,
  ]);
}

function contractScopeKey(binding: ContractSnapshotBinding): string {
  return JSON.stringify([binding.contractKey, binding.scopeHash]);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
