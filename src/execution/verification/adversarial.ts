import { z } from 'zod';
import {
  adversarialCheckSchema,
  adversarialCoveragePolicySchema,
  adversarialExemptionSchema,
  adversarialRequirementSchema,
  adversarialRequirementScopeSchema,
  anyTestCaseSchema,
  contentAddressedSourceRefSchema,
  scopedTaskRefSchema,
  testCaseRefKey,
  testCaseRefSchema,
  type AdversarialCheck,
  type AdversarialCoveragePolicy,
  type AdversarialExemption,
  type AdversarialPolicyRef,
  type AdversarialRequirement,
  type AdversarialRequirementScope,
  type ContentAddressedSourceRef,
  type ScopedTaskRef,
} from '../types.js';
import {
  compileTestCase,
  scopedTaskKey,
  testCaseScopedIdentityKey,
  VerificationFlowError,
  type VerificationFlowIssueCode,
  type CompiledTestCase,
} from './test-cases.js';

export interface CompileAdversarialAssuranceInput {
  readonly policy: AdversarialCoveragePolicy;
  readonly policyRef: AdversarialPolicyRef;
  readonly requirements: readonly AdversarialRequirement[];
  readonly exemptions: readonly AdversarialExemption[];
  readonly authoritativeSourceRefs: readonly ContentAddressedSourceRef[];
  readonly requiredTasks: readonly ScopedTaskRef[];
  readonly cases: readonly CompiledTestCase[];
}

export interface CompiledAdversarialAssurance {
  readonly policyRef: AdversarialPolicyRef;
  readonly requirements: readonly AdversarialRequirement[];
  readonly checks: readonly AdversarialCheck[];
  readonly exemptions: readonly AdversarialExemption[];
}

const PROJECT_GATE_LEVELS = new Set([
  'UNIT',
  'COMPONENT',
  'CONTRACT_PROVIDER',
  'CONTRACT_CONSUMER',
]);

const assuranceInputSchema = z.strictObject({
  policy: z.unknown(),
  policyRef: z.unknown(),
  requirements: z.array(z.unknown()).readonly(),
  exemptions: z.array(z.unknown()).readonly(),
  authoritativeSourceRefs: z.array(z.unknown()).readonly(),
  requiredTasks: z.array(z.unknown()).readonly(),
  cases: z.array(z.unknown()).readonly(),
});

const compiledCaseInputSchema = z.strictObject({
  testCase: z.unknown(),
  ref: z.unknown(),
});

const requirementInputSchema = z.strictObject({
  policy: contentAddressedSourceRefSchema,
  scope: adversarialRequirementScopeSchema,
  vectorIds: z.array(z.string()).readonly(),
});

const exemptionInputSchema = z.strictObject({
  policy: contentAddressedSourceRefSchema,
  scope: adversarialRequirementScopeSchema,
  vectorIds: z.array(z.string()).readonly(),
  reasonCode: z.unknown(),
  sourceRefs: z.array(contentAddressedSourceRefSchema).readonly(),
  explanationHash: z.unknown(),
});

const ASSURANCE_INPUT_DETAIL = 'adversarial assurance input failed strict validation';

const assuranceErrorDetails: Partial<Record<VerificationFlowIssueCode, string>> = {
  ADVERSARIAL_POLICY_MISSING: 'an exact policy snapshot is required',
  ADVERSARIAL_POLICY_STALE: 'adversarial policy does not bind exact assurance inputs',
  ADVERSARIAL_POLICY_VECTOR_UNKNOWN: 'adversarial assurance references an unknown policy vector',
  ADVERSARIAL_CASE_INVALID: 'compiled adversarial case failed strict validation',
  ADVERSARIAL_CASE_TASK_OUTSIDE_SCOPE: 'adversarial case or requirement is outside the required scope',
  ADVERSARIAL_WRITER_COVERAGE_MISSING: 'task assurance is covered only outside the project gate',
  ADVERSARIAL_COVERAGE_MISSING: 'required adversarial coverage is missing',
  ADVERSARIAL_SAFETY_ORACLE_MISSING: 'required adversarial safety oracle is missing',
  ADVERSARIAL_EXEMPTION_INVALID: 'adversarial exemption failed exact validation',
  TEST_CASE_SOURCE_IDENTITY_CONFLICT: 'source ref binds more than one content hash',
  VERIFICATION_CASE_IDENTITY_CONFLICT: 'test case identity binds more than one body in the same scope',
};

export function compileAdversarialAssurance(
  input: CompileAdversarialAssuranceInput,
): CompiledAdversarialAssurance {
  const parsedInput = parseAssuranceInput(input);
  try {
    return compileAssurance(parsedInput);
  } catch (error) {
    throw normalizeAssuranceError(error);
  }
}

function parseAssuranceInput(input: unknown): CompileAdversarialAssuranceInput {
  const parsed = safeParse(assuranceInputSchema, input);
  if (parsed === undefined) {
    throw new VerificationFlowError('ADVERSARIAL_COVERAGE_MISSING', ASSURANCE_INPUT_DETAIL);
  }
  return parsed as unknown as CompileAdversarialAssuranceInput;
}

function normalizeAssuranceError(error: unknown): VerificationFlowError {
  if (error instanceof VerificationFlowError) {
    const detail = assuranceErrorDetails[error.code];
    if (detail !== undefined) return new VerificationFlowError(error.code, detail);
  }
  return new VerificationFlowError('ADVERSARIAL_COVERAGE_MISSING', ASSURANCE_INPUT_DETAIL);
}

function compileAssurance(input: CompileAdversarialAssuranceInput): CompiledAdversarialAssurance {
  if (input === undefined || input.policy === undefined || input.policy === null) {
    throw new VerificationFlowError('ADVERSARIAL_POLICY_MISSING', 'an exact policy snapshot is required');
  }
  const parsedPolicyResult = safeParseResult(adversarialCoveragePolicySchema, input.policy);
  if (parsedPolicyResult === undefined || !parsedPolicyResult.success) {
    const unknownVector = parsedPolicyResult?.success === false &&
      parsedPolicyResult.error.issues.some((item) => item.message === 'ADVERSARIAL_POLICY_VECTOR_UNKNOWN');
    throw new VerificationFlowError(
      unknownVector
        ? 'ADVERSARIAL_POLICY_VECTOR_UNKNOWN'
        : 'ADVERSARIAL_POLICY_STALE',
      'policy failed strict validation',
    );
  }
  const policy = parsedPolicyResult.data;
  const parsedPolicyRef = safeParse(contentAddressedSourceRefSchema, input.policyRef);
  if (parsedPolicyRef === undefined || parsedPolicyRef.contentHash !== policy.contentHash) {
    throw new VerificationFlowError(
      'ADVERSARIAL_POLICY_STALE',
      'policy ref does not bind the supplied policy content hash',
    );
  }
  const policyRef = parsedPolicyRef;
  const policyVectors = new Map(policy.vectors.map((vector) => [vector.id, vector]));
  const behaviorVectors = canonicalStrings(
    policy.requirements
      .filter((requirement) => requirement.scope === 'BEHAVIOR_TASK')
      .flatMap((requirement) => requirement.vectorIds),
  );
  if (behaviorVectors.length === 0) {
    throw new VerificationFlowError(
      'ADVERSARIAL_POLICY_MISSING',
      'policy does not declare BEHAVIOR_TASK assurance',
    );
  }

  const requiredTasks = canonicalRequiredTasks(input.requiredTasks);
  const requiredTaskKeys = new Set(requiredTasks.map(scopedTaskKey));
  const cases = validateCases(input.cases, requiredTaskKeys, policyVectors);
  const authoritativeSourceRefs = canonicalAuthoritativeRefs(input.authoritativeSourceRefs);
  const authoritativeKeys = new Set(authoritativeSourceRefs.map(sourceKey));
  const requirements = canonicalRequirements(input.requirements, policyRef, policyVectors, requiredTaskKeys, cases);

  const requirementsByScope = new Map(requirements.map((requirement) => [scopeKey(requirement.scope), requirement]));
  for (const task of requiredTasks) {
    const scope: AdversarialRequirementScope = { kind: 'TASK', scopedTask: task };
    const requirement = requirementsByScope.get(scopeKey(scope));
    if (requirement === undefined ||
        behaviorVectors.some((vectorId) => !requirement.vectorIds.includes(vectorId))) {
      throw new VerificationFlowError(
        'ADVERSARIAL_COVERAGE_MISSING',
        `${scopedTaskKey(task)} does not require every BEHAVIOR_TASK vector`,
      );
    }
  }

  const exemptions = canonicalExemptions(
    input.exemptions,
    policyRef,
    policyVectors,
    requirementsByScope,
    authoritativeKeys,
  );
  const exemptedPairs = new Map<string, AdversarialExemption>();
  for (const exemption of exemptions) {
    for (const vectorId of exemption.vectorIds) {
      const key = assurancePairKey(exemption.scope, vectorId);
      if (exemptedPairs.has(key)) {
        throw new VerificationFlowError('ADVERSARIAL_EXEMPTION_INVALID', `duplicate exemption ${key}`);
      }
      exemptedPairs.set(key, exemption);
    }
  }

  const checks: AdversarialCheck[] = [];
  for (const requirement of requirements) {
    const vectors: AdversarialCheck['vectors'][number][] = [];
    const selectedCases = new Map<string, CompiledTestCase>();
    for (const vectorId of requirement.vectorIds) {
      const matching = cases.filter((compiled) =>
        compiled.testCase.schemaVersion === 2 &&
        compiled.testCase.adversarial?.vectorIds.includes(vectorId) === true &&
        caseCoversScope(compiled, requirement.scope));
      const eligible = requirement.scope.kind === 'TASK'
        ? matching.filter((compiled) => PROJECT_GATE_LEVELS.has(compiled.testCase.level))
        : matching;
      const exemption = exemptedPairs.get(assurancePairKey(requirement.scope, vectorId));
      if (exemption !== undefined && matching.length > 0) {
        throw new VerificationFlowError(
          'ADVERSARIAL_EXEMPTION_INVALID',
          `${vectorId} has both exact case coverage and an exemption`,
        );
      }
      if (eligible.length === 0) {
        if (exemption !== undefined) continue;
        if (requirement.scope.kind === 'TASK' && matching.length > 0) {
          throw new VerificationFlowError(
            'ADVERSARIAL_WRITER_COVERAGE_MISSING',
            `${vectorId} is covered only outside the project gate`,
          );
        }
        throw new VerificationFlowError(
          'ADVERSARIAL_COVERAGE_MISSING',
          `${vectorId} has no exact v2 adversarial case`,
        );
      }
      const coveredProperties = new Set(eligible.flatMap((compiled) =>
        compiled.testCase.schemaVersion === 2
          ? compiled.testCase.adversarial?.safetyProperties ?? []
          : []));
      const policyVector = policyVectors.get(vectorId)!;
      const missingProperties = policyVector.safetyProperties.filter((property) => !coveredProperties.has(property));
      if (missingProperties.length > 0) {
        throw new VerificationFlowError(
          'ADVERSARIAL_SAFETY_ORACLE_MISSING',
          `${vectorId} lacks ${missingProperties.join(',')}`,
        );
      }
      const caseRefs = canonicalBy(eligible.map((compiled) => compiled.ref), testCaseRefKey);
      vectors.push({ vectorId, caseRefs });
      for (const compiled of eligible) selectedCases.set(testCaseRefKey(compiled.ref), compiled);
    }
    if (vectors.length > 0) {
      const commandRefs = canonicalStrings(
        [...selectedCases.values()].flatMap((compiled) => compiled.testCase.commandRefs),
      );
      checks.push(adversarialCheckSchema.parse({
        policy: policyRef,
        scope: requirement.scope,
        vectors,
        commandRefs,
      }));
    }
  }

  return {
    policyRef,
    requirements,
    checks: canonicalBy(checks, (check) => scopeKey(check.scope)),
    exemptions,
  };
}

function validateCases(
  proposed: readonly CompiledTestCase[],
  requiredTaskKeys: ReadonlySet<string>,
  policyVectors: ReadonlyMap<string, AdversarialCoveragePolicy['vectors'][number]>,
): readonly CompiledTestCase[] {
  const cases = proposed.map((candidate) => {
    const compiled = safeParse(compiledCaseInputSchema, candidate);
    if (compiled === undefined) {
      throw new VerificationFlowError('ADVERSARIAL_CASE_INVALID', 'compiled case identity is malformed');
    }
    const body = safeParse(anyTestCaseSchema, compiled.testCase);
    const ref = safeParse(testCaseRefSchema, compiled.ref);
    if (body === undefined || ref === undefined ||
        body.id !== ref.id || body.contentHash !== ref.contentHash) {
      throw new VerificationFlowError('ADVERSARIAL_CASE_INVALID', 'compiled case identity is malformed');
    }
    const validated = { testCase: body, ref };
    const { contentHash: _contentHash, ...proposal } = validated.testCase;
    const authoritative = compileTestCase({ scope: validated.ref.scope, testCase: proposal });
    if (testCaseRefKey(authoritative.ref) !== testCaseRefKey(validated.ref)) {
      throw new VerificationFlowError(
        'ADVERSARIAL_CASE_INVALID',
        `${validated.testCase.id} body does not bind the supplied exact scope`,
      );
    }
    if (validated.testCase.schemaVersion === 2 && validated.testCase.adversarial !== undefined) {
      for (const task of validated.testCase.scopedTasks) {
        if (!requiredTaskKeys.has(scopedTaskKey(task))) {
          throw new VerificationFlowError(
            'ADVERSARIAL_CASE_TASK_OUTSIDE_SCOPE',
            `${validated.testCase.id} references ${scopedTaskKey(task)}`,
          );
        }
      }
      for (const vectorId of validated.testCase.adversarial.vectorIds) {
        if (!policyVectors.has(vectorId)) {
          throw new VerificationFlowError('ADVERSARIAL_POLICY_VECTOR_UNKNOWN', vectorId);
        }
      }
    }
    return validated;
  });
  const byScopedIdentity = [...cases].sort((left, right) =>
    compare(testCaseScopedIdentityKey(left.ref), testCaseScopedIdentityKey(right.ref)) ||
    compare(left.ref.contentHash, right.ref.contentHash));
  for (let index = 1; index < byScopedIdentity.length; index += 1) {
    if (testCaseScopedIdentityKey(byScopedIdentity[index - 1]!.ref) ===
        testCaseScopedIdentityKey(byScopedIdentity[index]!.ref)) {
      throw new VerificationFlowError(
        'VERIFICATION_CASE_IDENTITY_CONFLICT',
        'test case identity binds more than one body in the same scope',
      );
    }
  }
  return canonicalBy(cases, (compiled) => testCaseRefKey(compiled.ref));
}

function canonicalRequirements(
  proposed: readonly AdversarialRequirement[],
  policyRef: AdversarialPolicyRef,
  policyVectors: ReadonlyMap<string, AdversarialCoveragePolicy['vectors'][number]>,
  requiredTaskKeys: ReadonlySet<string>,
  cases: readonly CompiledTestCase[],
): readonly AdversarialRequirement[] {
  const result = proposed.map((value) => {
    const candidate = safeParse(requirementInputSchema, value);
    if (candidate === undefined) {
      throw new VerificationFlowError('ADVERSARIAL_COVERAGE_MISSING', 'requirement failed strict validation');
    }
    const rawVectorIds = candidate.vectorIds;
    for (const vectorId of rawVectorIds) {
      if (!policyVectors.has(vectorId)) {
        throw new VerificationFlowError('ADVERSARIAL_POLICY_VECTOR_UNKNOWN', vectorId);
      }
    }
    if (!sameSource(candidate.policy, policyRef)) {
      throw new VerificationFlowError('ADVERSARIAL_POLICY_STALE', 'requirement policy ref is stale');
    }
    const parsed = adversarialRequirementSchema.safeParse({
      ...candidate,
      vectorIds: canonicalRecordVectorIds(rawVectorIds, 'ADVERSARIAL_COVERAGE_MISSING'),
    });
    if (!parsed.success) {
      throw new VerificationFlowError('ADVERSARIAL_COVERAGE_MISSING', 'requirement failed strict validation');
    }
    if (parsed.data.scope.kind === 'TASK') {
      if (!requiredTaskKeys.has(scopedTaskKey(parsed.data.scope.scopedTask))) {
        throw new VerificationFlowError(
          'ADVERSARIAL_CASE_TASK_OUTSIDE_SCOPE',
          scopedTaskKey(parsed.data.scope.scopedTask),
        );
      }
    } else if (!cases.some((compiled) => caseCoversScope(compiled, parsed.data.scope))) {
      throw new VerificationFlowError(
        'ADVERSARIAL_CASE_TASK_OUTSIDE_SCOPE',
        `orphan contract scenario ${scopeKey(parsed.data.scope)}`,
      );
    }
    return parsed.data;
  });
  const canonical = canonicalBy(result, (requirement) => scopeKey(requirement.scope));
  requireUnique(canonical, (requirement) => scopeKey(requirement.scope), 'ADVERSARIAL_COVERAGE_MISSING');
  return canonical;
}

function canonicalExemptions(
  proposed: readonly AdversarialExemption[],
  policyRef: AdversarialPolicyRef,
  policyVectors: ReadonlyMap<string, AdversarialCoveragePolicy['vectors'][number]>,
  requirementsByScope: ReadonlyMap<string, AdversarialRequirement>,
  authoritativeKeys: ReadonlySet<string>,
): readonly AdversarialExemption[] {
  const result = proposed.map((value) => {
    const candidate = safeParse(exemptionInputSchema, value);
    if (candidate === undefined) {
      throw new VerificationFlowError('ADVERSARIAL_EXEMPTION_INVALID', 'exemption failed strict validation');
    }
    if (!sameSource(candidate.policy, policyRef)) {
      throw new VerificationFlowError('ADVERSARIAL_POLICY_STALE', 'exemption policy ref is stale');
    }
    const vectorIds = canonicalRecordVectorIds(candidate.vectorIds, 'ADVERSARIAL_EXEMPTION_INVALID');
    if (vectorIds.some((vectorId) => !policyVectors.has(vectorId))) {
      throw new VerificationFlowError('ADVERSARIAL_POLICY_VECTOR_UNKNOWN', 'exemption has an unknown vector');
    }
    const sourceRefs = canonicalBy(candidate.sourceRefs, sourceKey);
    if (sourceRefs.some((source) => !authoritativeKeys.has(sourceKey(source)))) {
      throw new VerificationFlowError(
        'ADVERSARIAL_EXEMPTION_INVALID',
        'exemption source is not an authoritative input',
      );
    }
    const parsed = adversarialExemptionSchema.safeParse({ ...candidate, vectorIds, sourceRefs });
    if (!parsed.success) {
      throw new VerificationFlowError('ADVERSARIAL_EXEMPTION_INVALID', 'exemption failed strict validation');
    }
    const requirement = requirementsByScope.get(scopeKey(parsed.data.scope));
    if (requirement === undefined ||
        parsed.data.vectorIds.some((vectorId) => !requirement.vectorIds.includes(vectorId))) {
      throw new VerificationFlowError(
        'ADVERSARIAL_EXEMPTION_INVALID',
        'exemption does not bind an exact required scope/vector',
      );
    }
    return parsed.data;
  });
  const canonical = canonicalBy(result, (exemption) => scopeKey(exemption.scope));
  requireUnique(canonical, (exemption) => scopeKey(exemption.scope), 'ADVERSARIAL_EXEMPTION_INVALID');
  return canonical;
}

function canonicalAuthoritativeRefs(
  proposed: readonly ContentAddressedSourceRef[],
): readonly ContentAddressedSourceRef[] {
  const refs = proposed.map((candidate) => {
    const parsed = safeParse(contentAddressedSourceRefSchema, candidate);
    if (parsed === undefined) {
      throw new VerificationFlowError('ADVERSARIAL_EXEMPTION_INVALID', 'source ref failed strict validation');
    }
    return parsed;
  });
  const byLogicalRef = new Map<string, string>();
  for (const source of refs) {
    const current = byLogicalRef.get(source.ref);
    if (current !== undefined && current !== source.contentHash) {
      throw new VerificationFlowError(
        'ADVERSARIAL_EXEMPTION_INVALID',
        `authoritative source ${source.ref} has ambiguous hashes`,
      );
    }
    byLogicalRef.set(source.ref, source.contentHash);
  }
  const canonical = canonicalBy(refs, sourceKey);
  requireUnique(canonical, sourceKey, 'ADVERSARIAL_EXEMPTION_INVALID');
  return canonical;
}

function canonicalRequiredTasks(proposed: readonly ScopedTaskRef[]): readonly ScopedTaskRef[] {
  const tasks = proposed.map((candidate) => {
    const parsed = safeParse(scopedTaskRefSchema, candidate);
    if (parsed === undefined) {
      throw new VerificationFlowError('ADVERSARIAL_CASE_TASK_OUTSIDE_SCOPE', 'task failed strict validation');
    }
    return parsed;
  });
  return canonicalBy(tasks, scopedTaskKey);
}

function caseCoversScope(compiled: CompiledTestCase, scope: AdversarialRequirementScope): boolean {
  if (scope.kind === 'TASK') {
    if (!compiled.testCase.scopedTasks.some((task) => scopedTaskKey(task) === scopedTaskKey(scope.scopedTask))) {
      return false;
    }
    return compiled.ref.scope.kind !== 'PROJECT' ||
      (compiled.ref.scope.project === scope.scopedTask.project &&
        compiled.ref.scope.changeId === scope.scopedTask.changeId &&
        compiled.ref.scope.revision === scope.scopedTask.revision);
  }
  return compiled.ref.scope.kind === 'CONTRACT' &&
    compiled.ref.scope.worksetId === scope.worksetId &&
    compiled.ref.scope.contractKey === scope.contractKey &&
    compiled.ref.scope.scopeHash === scope.scopeHash &&
    compiled.ref.scope.contractSnapshot.id === scope.contractSnapshot.id &&
    compiled.ref.scope.contractSnapshot.contentHash === scope.contractSnapshot.contentHash &&
    compiled.ref.scope.scenarioId === scope.scenarioId;
}

function scopeKey(scope: AdversarialRequirementScope): string {
  const parsed = adversarialRequirementScopeSchema.parse(scope);
  return parsed.kind === 'TASK'
    ? JSON.stringify(['TASK', scopedTaskKey(parsed.scopedTask)])
    : JSON.stringify([
        'CONTRACT_SCENARIO', parsed.worksetId, parsed.contractKey, parsed.scopeHash,
        parsed.contractSnapshot.id, parsed.contractSnapshot.contentHash, parsed.scenarioId,
      ]);
}

function assurancePairKey(scope: AdversarialRequirementScope, vectorId: string): string {
  return JSON.stringify([scopeKey(scope), vectorId]);
}

function sameSource(left: ContentAddressedSourceRef, right: ContentAddressedSourceRef): boolean {
  return left.ref === right.ref && left.contentHash === right.contentHash;
}

function sourceKey(source: ContentAddressedSourceRef): string {
  return JSON.stringify([source.ref, source.contentHash]);
}

function canonicalStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compare);
}

function canonicalRecordVectorIds(
  values: readonly string[],
  code: 'ADVERSARIAL_COVERAGE_MISSING' | 'ADVERSARIAL_EXEMPTION_INVALID',
): readonly string[] {
  const canonical = [...values].sort(compare);
  for (let index = 1; index < canonical.length; index += 1) {
    if (canonical[index - 1] === canonical[index]) {
      throw new VerificationFlowError(code, `duplicate vector ${canonical[index]!}`);
    }
  }
  return canonical;
}

function canonicalBy<T>(values: readonly T[], key: (value: T) => string): readonly T[] {
  return [...values].sort((left, right) => compare(key(left), key(right)));
}

function requireUnique<T>(
  values: readonly T[],
  key: (value: T) => string,
  code: 'ADVERSARIAL_COVERAGE_MISSING' | 'ADVERSARIAL_EXEMPTION_INVALID',
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (key(values[index - 1]!) === key(values[index]!)) {
      throw new VerificationFlowError(code, `duplicate ${key(values[index]!)}`);
    }
  }
}

function safeParse<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  const parsed = safeParseResult(schema, value);
  return parsed?.success === true ? parsed.data : undefined;
}

function safeParseResult<T>(
  schema: z.ZodType<T>,
  value: unknown,
): z.ZodSafeParseResult<T> | undefined {
  try {
    return schema.safeParse(value);
  } catch {
    return undefined;
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
