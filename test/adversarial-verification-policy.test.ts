import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  adversarialCheckSchema,
  adversarialCoveragePolicySchema,
  adversarialExemptionSchema,
  adversarialRequirementSchema,
  anyVerificationPlanSchema,
  hashAdversarialCoveragePolicy,
  hashVerificationPlan,
  verificationPlanV2Schema,
} from '../src/execution/types.js';
import { compileAdversarialAssurance } from '../src/execution/verification/adversarial.js';
import { compileTestCase, VerificationFlowError } from '../src/execution/verification/test-cases.js';

const NOW = '2026-08-20T00:00:00.000Z';
const HASH_A = 'sha256:ac8d8342bbb2362d13f0a559a3621bb407011368895164b628a54f7fc33fc43c' as const;
const HASH_B = 'sha256:c100f95c1913f9c72fc1f4ef0847e1e723ffe0bde0b36e5f36c13f81fe8c26ed' as const;
const HASH_C = 'sha256:879923da020d1533f4d8e921ea7bac61e8ba41d3c89d17a4d14e3a89c6780d5d' as const;
const HASH_D = 'sha256:3fa5834dc920d385ca9b099c9fe55dcca163a6b256a261f8f147291b0e7cf633' as const;
const POLICY_HASH = 'sha256:31ac1c604f29646a6f4151b2f5e0baa0e66c094089304240ea39f1c1e4debcf5' as const;
const V1_PLAN_HASH = 'sha256:e378e18ba987bc96af3e6ffc0eb41cbf6ea947e8c9e9d4d5996bf44d15e1d880' as const;
const V2_PLAN_HASH = 'sha256:c6f1cb5a5431ba0e38e789599ad0c88382169bc7c168f6a12f773cb6c4499701' as const;

const SCOPED_TASK = {
  project: 'quote-center',
  changeId: 'CHG-0001',
  revision: 'REV-0001',
  baseline: 'BL-0001',
  taskId: 'TASK-001',
} as const;

const PROJECT_CASE_REF = {
  id: 'TC-0100',
  scope: {
    kind: 'PROJECT',
    project: 'quote-center',
    changeId: 'CHG-0001',
    revision: 'REV-0001',
  },
  contentHash: HASH_A,
} as const;

const CONTRACT_CASE_REF = {
  id: 'TC-0200',
  scope: {
    kind: 'CONTRACT',
    worksetId: 'WKS-0001',
    contractKey: 'authorization-v2',
    scopeHash: HASH_C,
    contractSnapshot: { id: 'CTR-0001', contentHash: HASH_B },
    scenarioId: 'SC-001',
  },
  contentHash: HASH_D,
} as const;

const OTHER_SCENARIO_CASE_REF = {
  id: 'TC-0201',
  scope: {
    kind: 'CONTRACT',
    worksetId: 'WKS-0001',
    contractKey: 'authorization-v2',
    scopeHash: HASH_C,
    contractSnapshot: { id: 'CTR-0001', contentHash: HASH_B },
    scenarioId: 'SC-002',
  },
  contentHash: HASH_A,
} as const;

const ZETA_PROJECT_CASE_REF = {
  id: 'TC-0300',
  scope: {
    kind: 'PROJECT',
    project: 'zeta-center',
    changeId: 'CHG-0001',
    revision: 'REV-0001',
  },
  contentHash: HASH_D,
} as const;

const POLICY_REF = {
  ref: 'policies/omnai-default-adversarial.yaml',
  contentHash: POLICY_HASH,
} as const;

function adversarialPolicyFixture() {
  return {
    schemaVersion: 1,
    id: 'omnai-default-adversarial',
    vectors: [
      { id: 'AUTHORITY_BYPASS', safetyProperties: ['NO_UNAUTHORIZED_EFFECT', 'REJECTED'] },
      { id: 'CONCURRENCY_RACE', safetyProperties: ['INVARIANT_PRESERVED', 'NO_CROSS_SCOPE_EFFECT'] },
      { id: 'FAULT_INJECTION', safetyProperties: ['INVARIANT_PRESERVED', 'SAFE_FAILURE'] },
      { id: 'IDENTITY_TAMPERING', safetyProperties: ['NO_UNAUTHORIZED_EFFECT', 'REJECTED'] },
      { id: 'ISOLATION_ESCAPE', safetyProperties: ['NO_CROSS_SCOPE_EFFECT', 'NO_UNAUTHORIZED_EFFECT'] },
      { id: 'MALFORMED_INPUT', safetyProperties: ['REJECTED', 'SAFE_FAILURE'] },
      { id: 'RESOURCE_EXHAUSTION', safetyProperties: ['INVARIANT_PRESERVED', 'SAFE_FAILURE'] },
      { id: 'STALE_REPLAY', safetyProperties: ['INVARIANT_PRESERVED', 'REJECTED'] },
    ],
    requirements: [
      { scope: 'AUTHORITY_BOUNDARY', vectorIds: ['AUTHORITY_BYPASS', 'ISOLATION_ESCAPE'] },
      { scope: 'BEHAVIOR_TASK', vectorIds: ['IDENTITY_TAMPERING', 'MALFORMED_INPUT', 'STALE_REPLAY'] },
      { scope: 'BOUNDED_EXECUTION', vectorIds: ['RESOURCE_EXHAUSTION'] },
      { scope: 'CONCURRENT_STATE', vectorIds: ['CONCURRENCY_RACE', 'FAULT_INJECTION'] },
    ],
    contentHash: POLICY_HASH,
  } as const;
}

function rehashPolicy(policy: Parameters<typeof hashAdversarialCoveragePolicy>[0]) {
  return { ...policy, contentHash: hashAdversarialCoveragePolicy(policy) };
}

function adversarialRequirementFixture() {
  return {
    policy: POLICY_REF,
    scope: { kind: 'TASK', scopedTask: SCOPED_TASK },
    vectorIds: ['IDENTITY_TAMPERING', 'MALFORMED_INPUT', 'STALE_REPLAY'],
  } as const;
}

function adversarialCheckFixture() {
  return {
    policy: POLICY_REF,
    scope: { kind: 'TASK', scopedTask: SCOPED_TASK },
    vectors: [
      { vectorId: 'IDENTITY_TAMPERING', caseRefs: [PROJECT_CASE_REF] },
      { vectorId: 'MALFORMED_INPUT', caseRefs: [PROJECT_CASE_REF] },
      { vectorId: 'STALE_REPLAY', caseRefs: [PROJECT_CASE_REF] },
    ],
    commandRefs: ['quote:unit'],
  } as const;
}

function adversarialExemptionFixture() {
  return {
    policy: POLICY_REF,
    scope: { kind: 'TASK', scopedTask: SCOPED_TASK },
    vectorIds: ['MALFORMED_INPUT', 'STALE_REPLAY'],
    reasonCode: 'NOT_APPLICABLE',
    sourceRefs: [
      { ref: 'design.md#generated-query', contentHash: HASH_A },
      { ref: 'spec.md#query-boundary', contentHash: HASH_B },
    ],
    explanationHash: HASH_D,
  } as const;
}

function compiledAdversarialCase(
  id: string,
  vectorIds: readonly string[],
  safetyProperties: readonly ('INVARIANT_PRESERVED' | 'NO_UNAUTHORIZED_EFFECT' | 'REJECTED' | 'SAFE_FAILURE')[],
) {
  return compileTestCase({
    scope: {
      kind: 'PROJECT',
      project: SCOPED_TASK.project,
      changeId: SCOPED_TASK.changeId,
      revision: SCOPED_TASK.revision,
    },
    testCase: {
      schemaVersion: 2,
      id,
      level: 'COMPONENT',
      title: `[adversarial] ${id} falsifies unsafe behavior`,
      sourceRefs: [{ ref: 'threats/behavior.yaml', contentHash: HASH_A }],
      scopedTasks: [SCOPED_TASK],
      commandRefs: [`quote:${id.toLowerCase()}`],
      expectedOutcome: 'the unsafe behavior is rejected without changing current state',
      adversarial: {
        threatRefs: [{ ref: 'threats/behavior.yaml', contentHash: HASH_A }],
        vectorIds,
        safetyProperties,
        hypothesis: 'an invalid request may cross the current behavior boundary',
      },
    },
  });
}

function adversarialAssuranceInput() {
  return {
    policy: adversarialPolicyFixture(),
    policyRef: POLICY_REF,
    requirements: [adversarialRequirementFixture()],
    exemptions: [],
    authoritativeSourceRefs: [{ ref: 'threats/behavior.yaml', contentHash: HASH_A }],
    requiredTasks: [SCOPED_TASK],
    cases: [
      compiledAdversarialCase(
        'TC-0400',
        ['IDENTITY_TAMPERING'],
        ['NO_UNAUTHORIZED_EFFECT', 'REJECTED'],
      ),
      compiledAdversarialCase('TC-0401', ['MALFORMED_INPUT'], ['REJECTED']),
      compiledAdversarialCase('TC-0402', ['MALFORMED_INPUT'], ['SAFE_FAILURE']),
      compiledAdversarialCase(
        'TC-0403',
        ['STALE_REPLAY'],
        ['INVARIANT_PRESERVED', 'REJECTED'],
      ),
    ],
  } as const;
}

function verificationPlanV1Fixture() {
  return {
    schemaVersion: 1,
    machineVersion: 1,
    lastEventSequence: 0,
    lastEventHash: null,
    id: 'VPL-0001',
    worksetId: 'WKS-0001',
    status: 'READY',
    scopeHash: HASH_C,
    contentHash: V1_PLAN_HASH,
    contractSnapshots: [],
    profile: { id: 'quote-local', contentHash: HASH_B },
    projectChecks: [{
      project: 'quote-center',
      scopedTasks: [SCOPED_TASK],
      caseRefs: [PROJECT_CASE_REF],
      commandRefs: ['quote:unit'],
    }],
    integrationCaseRefs: [],
    createdAt: NOW,
    updatedAt: NOW,
  } as const;
}

function verificationPlanV2Fixture() {
  return {
    schemaVersion: 2,
    machineVersion: 2,
    lastEventSequence: 0,
    lastEventHash: null,
    id: 'VPL-0001',
    worksetId: 'WKS-0001',
    status: 'READY',
    scopeHash: HASH_C,
    contentHash: V2_PLAN_HASH,
    contractSnapshots: [],
    profile: { id: 'quote-local', contentHash: HASH_B },
    projectChecks: [{
      project: 'quote-center',
      scopedTasks: [SCOPED_TASK],
      caseRefs: [PROJECT_CASE_REF],
      commandRefs: ['quote:unit'],
    }],
    integrationCaseRefs: [],
    adversarialPolicy: POLICY_REF,
    adversarialRequirements: [adversarialRequirementFixture()],
    adversarialChecks: [adversarialCheckFixture()],
    adversarialExemptions: [],
    createdAt: NOW,
    updatedAt: NOW,
  } as const;
}

function rehashVerificationPlan<T extends Parameters<typeof hashVerificationPlan>[0]>(plan: T) {
  return { ...plan, contentHash: hashVerificationPlan(plan) };
}

function verificationPlanWithContractScenario() {
  const current = verificationPlanV2Fixture();
  const contractScope = {
    kind: 'CONTRACT_SCENARIO',
    worksetId: 'WKS-0001',
    contractKey: 'authorization-v2',
    scopeHash: HASH_C,
    contractSnapshot: { id: 'CTR-0001', contentHash: HASH_B },
    scenarioId: 'SC-001',
  } as const;
  return rehashVerificationPlan({
    ...current,
    integrationCaseRefs: [CONTRACT_CASE_REF],
    adversarialRequirements: [{
      policy: POLICY_REF,
      scope: contractScope,
      vectorIds: ['STALE_REPLAY'],
    }, ...current.adversarialRequirements],
    adversarialChecks: [{
      policy: POLICY_REF,
      scope: contractScope,
      vectors: [{ vectorId: 'STALE_REPLAY', caseRefs: [CONTRACT_CASE_REF] }],
      commandRefs: ['quote:integration'],
    }, ...current.adversarialChecks],
  });
}

function verificationPlanWithMisplacedTask() {
  const current = verificationPlanV2Fixture();
  return rehashVerificationPlan({
    ...current,
    projectChecks: [{
      project: 'zeta-center',
      scopedTasks: [SCOPED_TASK],
      caseRefs: [ZETA_PROJECT_CASE_REF],
      commandRefs: ['zeta:unit'],
    }],
    adversarialChecks: [{
      ...current.adversarialChecks[0]!,
      vectors: current.adversarialChecks[0]!.vectors.map((vector) => ({
        ...vector,
        caseRefs: [ZETA_PROJECT_CASE_REF],
      })),
      commandRefs: ['zeta:unit'],
    }],
  });
}

test('[adversarial] AdversarialCoveragePolicy schema rejects canonical taxonomy drift', () => {
  const policy = adversarialCoveragePolicySchema.parse(adversarialPolicyFixture());
  assert.equal(hashAdversarialCoveragePolicy(policy), POLICY_HASH);
  assert.deepEqual(policy.vectors.map((vector: { id: string }) => vector.id), [
    'AUTHORITY_BYPASS',
    'CONCURRENCY_RACE',
    'FAULT_INJECTION',
    'IDENTITY_TAMPERING',
    'ISOLATION_ESCAPE',
    'MALFORMED_INPUT',
    'RESOURCE_EXHAUSTION',
    'STALE_REPLAY',
  ]);
  assert.throws(() => adversarialCoveragePolicySchema.parse(rehashPolicy({
    ...policy,
    vectors: [...policy.vectors].reverse(),
  })), /SORTED_UNIQUE/);
  assert.throws(() => adversarialCoveragePolicySchema.parse(rehashPolicy({
    ...policy,
    vectors: [{ ...policy.vectors[0]!, safetyProperties: ['REJECTED', 'NO_UNAUTHORIZED_EFFECT'] }, ...policy.vectors.slice(1)],
  })), /SORTED_UNIQUE/);
  assert.throws(() => adversarialCoveragePolicySchema.parse(rehashPolicy({
    ...policy,
    requirements: [...policy.requirements].reverse(),
  })), /SORTED_UNIQUE/);
  assert.throws(() => adversarialCoveragePolicySchema.parse(rehashPolicy({
    ...policy,
    requirements: [
      { ...policy.requirements[0]!, vectorIds: [...policy.requirements[0]!.vectorIds].reverse() },
      ...policy.requirements.slice(1),
    ],
  })), /SORTED_UNIQUE/);
});

test('[adversarial] policy rejects an unknown requirement vector and a forged content hash', () => {
  const policy = adversarialPolicyFixture();
  assert.throws(() => adversarialCoveragePolicySchema.parse(rehashPolicy({
    ...policy,
    requirements: [{ scope: 'BEHAVIOR_TASK', vectorIds: ['NOT_DEFINED'] }],
  })), /ADVERSARIAL_POLICY_VECTOR_UNKNOWN/);
  assert.throws(() => adversarialCoveragePolicySchema.parse({ ...policy, contentHash: HASH_D }), /CONTENT_HASH_MISMATCH/);
});

test('[adversarial] requirement check and exemption records reject non-canonical nested assurance refs', () => {
  const requirement = adversarialRequirementSchema.parse(adversarialRequirementFixture());
  const check = adversarialCheckSchema.parse(adversarialCheckFixture());
  const exemption = adversarialExemptionSchema.parse(adversarialExemptionFixture());
  assert.deepEqual(requirement.vectorIds, ['IDENTITY_TAMPERING', 'MALFORMED_INPUT', 'STALE_REPLAY']);
  assert.equal(check.vectors[0]?.caseRefs[0]?.contentHash, HASH_A);
  assert.equal(exemption.sourceRefs[1]?.ref, 'spec.md#query-boundary');
  assert.throws(() => adversarialRequirementSchema.parse({
    ...requirement,
    vectorIds: [...requirement.vectorIds].reverse(),
  }), /SORTED_UNIQUE/);
  assert.throws(() => adversarialCheckSchema.parse({
    ...check,
    vectors: [...check.vectors].reverse(),
  }), /SORTED_UNIQUE/);
  assert.throws(() => adversarialCheckSchema.parse({
    ...check,
    vectors: [{ ...check.vectors[0]!, caseRefs: [PROJECT_CASE_REF, PROJECT_CASE_REF] }, ...check.vectors.slice(1)],
  }), /SORTED_UNIQUE/);
  assert.throws(() => adversarialExemptionSchema.parse({
    ...exemption,
    sourceRefs: [...exemption.sourceRefs].reverse(),
  }), /SORTED_UNIQUE/);
});

test('[adversarial] VerificationPlan v1 remains readable but v2 freezes exact assurance', () => {
  const legacy = verificationPlanV1Fixture();
  const current = verificationPlanV2Fixture();
  assert.equal(anyVerificationPlanSchema.parse(legacy).schemaVersion, 1);
  assert.equal(anyVerificationPlanSchema.parse(current).schemaVersion, 2);
  assert.equal(legacy.contentHash, V1_PLAN_HASH);
  assert.equal(hashVerificationPlan(legacy), V1_PLAN_HASH);
  assert.equal(current.machineVersion, 2);
  assert.equal(current.contentHash, V2_PLAN_HASH);
  assert.equal(current.contentHash, hashVerificationPlan(current));
  assert.throws(() => verificationPlanV2Schema.parse({
    ...current,
    adversarialChecks: [],
  }), /CONTENT_HASH_MISMATCH|ADVERSARIAL/);
  assert.throws(() => verificationPlanV2Schema.parse(rehashVerificationPlan({
    ...current,
    adversarialChecks: [],
  })), /ADVERSARIAL_ASSURANCE_PARTITION_INVALID/);
});

test('[adversarial] VerificationPlan v2 requires the exact policy and ordinary task coverage refs', () => {
  const current = verificationPlanV2Fixture();
  assert.throws(() => verificationPlanV2Schema.parse(rehashVerificationPlan({
    ...current,
    adversarialRequirements: [{
      ...current.adversarialRequirements[0],
      policy: { ...POLICY_REF, contentHash: HASH_D },
    }],
  })), /ADVERSARIAL_POLICY_REF_MISMATCH/);
  assert.throws(() => verificationPlanV2Schema.parse(rehashVerificationPlan({
    ...current,
    adversarialChecks: [{
      ...current.adversarialChecks[0],
      policy: { ...POLICY_REF, contentHash: HASH_D },
    }],
  })), /ADVERSARIAL_POLICY_REF_MISMATCH/);
  assert.throws(() => verificationPlanV2Schema.parse(rehashVerificationPlan({
    ...current,
    adversarialChecks: [{
      ...current.adversarialChecks[0],
      vectors: [{
        ...current.adversarialChecks[0]!.vectors[0],
        caseRefs: [{ ...PROJECT_CASE_REF, contentHash: HASH_D }],
      }, ...current.adversarialChecks[0]!.vectors.slice(1)],
    }],
  })), /ADVERSARIAL_CHECK_CASE_REF_UNKNOWN/);
  assert.throws(() => verificationPlanV2Schema.parse(rehashVerificationPlan({
    ...current,
    adversarialChecks: [{ ...current.adversarialChecks[0], commandRefs: ['quote:unknown'] }],
  })), /ADVERSARIAL_CHECK_COMMAND_REF_UNKNOWN/);
  assert.throws(() => verificationPlanV2Schema.parse(rehashVerificationPlan({
    ...current,
    adversarialChecks: [{
      ...current.adversarialChecks[0],
      vectors: current.adversarialChecks[0]!.vectors.slice(0, 2),
    }],
    adversarialExemptions: [{
      ...adversarialExemptionFixture(),
      policy: { ...POLICY_REF, contentHash: HASH_D },
      vectorIds: ['STALE_REPLAY'],
    }],
  })), /ADVERSARIAL_POLICY_REF_MISMATCH/);
});

test('[adversarial] VerificationPlan v2 rejects overlaps and uncovered project tasks', () => {
  const current = verificationPlanV2Fixture();
  assert.throws(() => verificationPlanV2Schema.parse(rehashVerificationPlan({
    ...current,
    adversarialExemptions: [{
      ...adversarialExemptionFixture(),
      vectorIds: ['STALE_REPLAY'],
    }],
  })), /ADVERSARIAL_ASSURANCE_PARTITION_INVALID/);
  assert.throws(() => verificationPlanV2Schema.parse(rehashVerificationPlan({
    ...current,
    adversarialRequirements: [],
    adversarialChecks: [],
  })), /ADVERSARIAL_TASK_REQUIREMENT_MISSING|ADVERSARIAL_ASSURANCE_PARTITION_INVALID/);
  assert.throws(() => verificationPlanV2Schema.parse(rehashVerificationPlan({
    ...current,
    adversarialRequirements: [
      current.adversarialRequirements[0]!,
      current.adversarialRequirements[0]!,
    ],
  })), /SORTED_UNIQUE|ADVERSARIAL_ASSURANCE_PARTITION_INVALID/);
  assert.throws(() => verificationPlanV2Schema.parse(rehashVerificationPlan({
    ...current,
    adversarialChecks: [current.adversarialChecks[0]!, current.adversarialChecks[0]!],
  })), /SORTED_UNIQUE|ADVERSARIAL_ASSURANCE_PARTITION_INVALID/);
});

test('[adversarial] contract-scenario checks use canonical exact ordinary case membership', () => {
  const current = verificationPlanWithContractScenario();
  assert.equal(verificationPlanV2Schema.parse(current).adversarialChecks[0]?.scope.kind, 'CONTRACT_SCENARIO');
  assert.throws(() => verificationPlanV2Schema.parse(rehashVerificationPlan({
    ...current,
    adversarialChecks: [{
      ...current.adversarialChecks[0]!,
      vectors: [{
        vectorId: 'STALE_REPLAY',
        caseRefs: [{ ...CONTRACT_CASE_REF, contentHash: HASH_A }],
      }],
    }, ...current.adversarialChecks.slice(1)],
  })), /ADVERSARIAL_CHECK_CASE_REF_UNKNOWN/);
  assert.throws(() => verificationPlanV2Schema.parse(rehashVerificationPlan({
    ...current,
    adversarialRequirements: [...current.adversarialRequirements].reverse(),
  })), /SORTED_UNIQUE/);
  assert.throws(() => verificationPlanV2Schema.parse(rehashVerificationPlan({
    ...current,
    integrationCaseRefs: [CONTRACT_CASE_REF, OTHER_SCENARIO_CASE_REF],
    adversarialChecks: [{
      ...current.adversarialChecks[0]!,
      vectors: [{ vectorId: 'STALE_REPLAY', caseRefs: [OTHER_SCENARIO_CASE_REF] }],
    }, ...current.adversarialChecks.slice(1)],
  })), /ADVERSARIAL_CHECK_CASE_REF_SCOPE_MISMATCH/);
});

test('[adversarial] durable task assurance rejects a task absent from ordinary project placement', () => {
  const current = verificationPlanV2Fixture();
  const unknownTaskScope = {
    kind: 'TASK',
    scopedTask: { ...SCOPED_TASK, taskId: 'TASK-999' },
  } as const;
  assert.throws(() => verificationPlanV2Schema.parse(rehashVerificationPlan({
    ...current,
    adversarialRequirements: [...current.adversarialRequirements, {
      policy: POLICY_REF,
      scope: unknownTaskScope,
      vectorIds: ['STALE_REPLAY'],
    }],
    adversarialExemptions: [{
      ...adversarialExemptionFixture(),
      scope: unknownTaskScope,
      vectorIds: ['STALE_REPLAY'],
    }],
  })), /ADVERSARIAL_TASK_SCOPE_INVALID/);
});

test('[adversarial] ordinary task placement rejects project mismatch and duplicate ownership', () => {
  assert.throws(
    () => verificationPlanV2Schema.parse(verificationPlanWithMisplacedTask()),
    /ADVERSARIAL_TASK_SCOPE_INVALID/,
  );

  const current = verificationPlanV2Fixture();
  assert.throws(() => verificationPlanV2Schema.parse(rehashVerificationPlan({
    ...current,
    projectChecks: [...current.projectChecks, {
      project: 'zeta-center',
      scopedTasks: [SCOPED_TASK],
      caseRefs: [ZETA_PROJECT_CASE_REF],
      commandRefs: ['zeta:unit'],
    }],
  })), /ADVERSARIAL_TASK_SCOPE_INVALID/);
});

test('[adversarial] assurance compiler unions independent case oracles for every default task vector', () => {
  const assurance = compileAdversarialAssurance(adversarialAssuranceInput());

  assert.deepEqual(assurance.requirements[0]?.vectorIds, [
    'IDENTITY_TAMPERING',
    'MALFORMED_INPUT',
    'STALE_REPLAY',
  ]);
  assert.deepEqual(assurance.checks[0]?.vectors.map((vector) => vector.vectorId), [
    'IDENTITY_TAMPERING',
    'MALFORMED_INPUT',
    'STALE_REPLAY',
  ]);
  assert.deepEqual(
    assurance.checks[0]?.vectors[1]?.caseRefs.map((caseRef) => caseRef.id),
    ['TC-0401', 'TC-0402'],
  );
  assert.deepEqual(assurance.checks[0]?.commandRefs, [
    'quote:tc-0400',
    'quote:tc-0401',
    'quote:tc-0402',
    'quote:tc-0403',
  ]);
});

test('[adversarial] assurance compiler snapshots hostile input once and returns fixed boundary failures', async (t) => {
  const base = adversarialAssuranceInput();
  const expectedDetail = 'adversarial assurance input failed strict validation';
  const attacks: readonly [string, unknown][] = [
    ['throwing top-level getter', Object.defineProperty({ ...base }, 'requirements', {
      enumerable: true,
      get: () => {
        throw new VerificationFlowError(
          'ADVERSARIAL_POLICY_STALE',
          'attacker-created VerificationFlowError detail must not escape',
        );
      },
    })],
    ['wrong top-level array type', { ...base, requiredTasks: null }],
  ];

  for (const [name, input] of attacks) {
    await t.test(`[adversarial] ${name}`, () => {
      assert.throws(
        () => compileAdversarialAssurance(input as never),
        (error: unknown) => {
          assert.ok(error instanceof VerificationFlowError);
          assert.deepEqual(
            { code: error.code, detail: error.detail, message: error.message },
            {
              code: 'ADVERSARIAL_COVERAGE_MISSING',
              detail: expectedDetail,
              message: `ADVERSARIAL_COVERAGE_MISSING: ${expectedDetail}`,
            },
          );
          return true;
        },
      );
    });
  }

  let policyReads = 0;
  const firstReadOnly = Object.defineProperty({ ...base }, 'policy', {
    enumerable: true,
    get: () => {
      policyReads += 1;
      return policyReads === 1 ? base.policy : null;
    },
  });
  const assurance = compileAdversarialAssurance(firstReadOnly);
  assert.equal(policyReads, 1);
  assert.deepEqual(assurance, compileAdversarialAssurance(base));
});

test('[adversarial] assurance compiler rejects one scoped logical case identity bound to different hashes', () => {
  const base = adversarialAssuranceInput();
  const original = base.cases[0]!;
  const { contentHash: _contentHash, ...proposal } = original.testCase;
  const changed = compileTestCase({
    scope: original.ref.scope,
    testCase: { ...proposal, title: '[adversarial] changed body with the same scoped logical identity' },
  });
  assert.notEqual(original.ref.contentHash, changed.ref.contentHash);

  const expectedDetail = 'test case identity binds more than one body in the same scope';
  assert.throws(
    () => compileAdversarialAssurance({ ...base, cases: [original, changed, ...base.cases.slice(1)] }),
    (error: unknown) => {
      assert.ok(error instanceof VerificationFlowError);
      assert.deepEqual(
        { code: error.code, detail: error.detail, message: error.message },
        {
          code: 'VERIFICATION_CASE_IDENTITY_CONFLICT',
          detail: expectedDetail,
          message: `VERIFICATION_CASE_IDENTITY_CONFLICT: ${expectedDetail}`,
        },
      );
      return true;
    },
  );
});

test('[adversarial] assurance compiler converts policy identity attacks to stable errors', async (t) => {
  const base = adversarialAssuranceInput();
  const attacks = [
    ['missing policy', { ...base, policy: undefined }, 'ADVERSARIAL_POLICY_MISSING'],
    ['stale policy ref', {
      ...base,
      policyRef: { ...base.policyRef, contentHash: HASH_D },
    }, 'ADVERSARIAL_POLICY_STALE'],
    ['stale requirement ref', {
      ...base,
      requirements: [{
        ...base.requirements[0],
        policy: { ...base.policyRef, contentHash: HASH_D },
      }],
    }, 'ADVERSARIAL_POLICY_STALE'],
    ['unknown case vector', {
      ...base,
      cases: [
        ...base.cases,
        compiledAdversarialCase('TC-0404', ['NOT_DEFINED'], ['REJECTED']),
      ],
    }, 'ADVERSARIAL_POLICY_VECTOR_UNKNOWN'],
  ] as const;

  for (const [name, input, code] of attacks) {
    await t.test(`[adversarial] ${name}`, () => {
      assert.throws(
        () => compileAdversarialAssurance(input as never),
        (error: unknown) => error instanceof VerificationFlowError && error.code === code,
      );
    });
  }
});

test('[adversarial] exemptions reject ambiguous authoritative identities', () => {
  const base = adversarialAssuranceInput();
  assert.throws(
    () => compileAdversarialAssurance({
      ...base,
      cases: base.cases.filter((compiled) =>
        compiled.testCase.schemaVersion !== 2 ||
        !compiled.testCase.adversarial?.vectorIds.includes('STALE_REPLAY')),
      exemptions: [{
        ...adversarialExemptionFixture(),
        vectorIds: ['STALE_REPLAY'],
        sourceRefs: [{ ref: 'threats/behavior.yaml', contentHash: HASH_A }],
      }],
      authoritativeSourceRefs: [
        { ref: 'threats/behavior.yaml', contentHash: HASH_A },
        { ref: 'threats/behavior.yaml', contentHash: HASH_B },
      ],
    }),
    (error: unknown) =>
      error instanceof VerificationFlowError && error.code === 'ADVERSARIAL_EXEMPTION_INVALID',
  );
});
