# OmnAI Adversarial Test Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make adversarial TestCases and their exact policy-derived coverage mandatory for every newly compiled VerificationPlan, while hardening the existing pure verification kernel against deterministic tampering and replay mutations.

**Architecture:** Add explicit TestCase v2 and pure VerificationPlan v2 schemas alongside the readable v1 records, then compile adversarial policy requirements into the same project/integration case refs already frozen by Wave and RunPacket. The isolated verification layer remains pure; Milestone C Tasks 5-17 later resolve authoritative refs, persist records, acquire Claims, enforce real filesystem/process isolation, and invoke these canonical functions rather than duplicating them.

**Tech Stack:** TypeScript 5.9, Node.js 20+ built-in test runner, Zod 4, XState 5 aggregate registry compatibility, existing canonical SHA-256 helpers.

**Spec:** `docs/superpowers/specs/2026-08-20-omnai-adversarial-test-coverage-design.md`

## Global Constraints

- `TestCase.level` remains exactly `UNIT | COMPONENT | CONTRACT_PROVIDER | CONTRACT_CONSUMER | INTEGRATION | E2E`; adversarial intent is orthogonal.
- TestCase v1 and VerificationPlan v1 remain readable and keep their original hash semantics. They never acquire synthetic adversarial proof.
- New compilation returns TestCase v2/VerificationPlan v2 assurance; legacy READY plans fail new admission with a stable recompile-required issue.
- Vector IDs come from one exact content-addressed policy; only safety-property oracles are a closed code enum.
- Every behavior-changing scoped task has policy-derived adversarial coverage or an exact policy/source-backed exemption.
- Task-level mandatory coverage uses Writer-gate levels; Integration/E2E may add assurance but cannot be the only task coverage.
- Planner proposes; the one Writer implements tests and code; the separate Reviewer attacks the result; Core validates and accepts evidence.
- Do not add a second Writer, Agent kind, test ledger, aggregate, scheduler, event log, or execution engine.
- Do not modify `src/core/**`, `src/cli.ts`, or expose `omnai run` in this plan.
- Pure hashes prove identity, not provenance. Authoritative loading, atomic Claim acquisition, realpath containment, command-definition resolution, and one-time dispatch remain explicit Milestone C Task 5-17 acceptance work.
- Every behavior change follows RED -> GREEN -> REFACTOR. Every new adversarial test title starts with `[adversarial]` and names the production mutation it catches.
- Tests use real schemas/compilers/gates. Fake components remain confined to external Agent/process boundaries; do not assert on mocks.
- No new npm dependency is required.

---

### Task 0: Close the existing v1 verification-policy handoff

**Files:**
- Add: `src/execution/verification/test-cases.ts`
- Add: `src/execution/verification/planner.ts`
- Add: `src/execution/verification/gates.ts`
- Add: `src/execution/verification/impact.ts`
- Add: `test/verification-plan.test.ts`
- Add: `test/verification-entry-gates.test.ts`
- Add: `test/execution-impact-closure.test.ts`
- Add: `docs/superpowers/plans/2026-08-20-omnai-test-flow-optimization.md`

**Interfaces:**
- Consumes: committed Task 4A execution schemas and hashing.
- Produces: one isolated, reviewed baseline commit containing the already-completed v1 compiler/gate/closure kernel and its tests.

- [ ] **Step 1: Confirm the linked-worktree and exact uncommitted scope**

Run:

```bash
git rev-parse --git-dir
git rev-parse --git-common-dir
git branch --show-current
git status --short
git diff --check
```

Expected: branch `feat/omnai-v0.3-full-pipeline-fusion`; only the four verification files, three focused tests, and the completed test-flow plan are untracked. Do not discard or rewrite them.

- [ ] **Step 2: Re-run the accepted v1 policy gate**

Run:

```bash
npm run typecheck
npm run build
node --test \
  dist/test/execution-types.test.js \
  dist/test/execution-verification-amendment.test.js \
  dist/test/execution-machines.test.js \
  dist/test/execution-impact-closure.test.js \
  dist/test/verification-plan.test.js \
  dist/test/verification-entry-gates.test.js
```

Expected: 71 tests pass, zero fail. If the exact count changes because committed upstream tests were added, require zero fail and record the new count.

- [ ] **Step 3: Commit only the completed handoff**

```bash
git add \
  docs/superpowers/plans/2026-08-20-omnai-test-flow-optimization.md \
  src/execution/verification/test-cases.ts \
  src/execution/verification/planner.ts \
  src/execution/verification/gates.ts \
  src/execution/verification/impact.ts \
  test/verification-plan.test.ts \
  test/verification-entry-gates.test.ts \
  test/execution-impact-closure.test.ts
git diff --cached --check
git commit -m "feat: add verification policy kernel"
```

Expected: the adversarial design/plan commit remains separate and `git status --short` is clean before Task 1.

---

### Task 1: Add TestCase v2 adversarial facts without reinterpreting v1

**Files:**
- Modify: `src/execution/types.ts`
- Modify: `test/execution-verification-amendment.test.ts`

**Interfaces:**
- Consumes: `contentHashSchema`, the existing content-addressed source shape, `testCaseSchema`, and `hashTestCase`.
- Produces: `ADVERSARIAL_SAFETY_PROPERTIES`, `AdversarialSafetyProperty`, `adversarialTestFactsSchema`, `testCaseV2Schema`, `TestCaseV2`, `AnyTestCase`, `anyTestCaseSchema`, and version-aware `hashTestCase`.

- [ ] **Step 1: Write failing v1/v2 schema and hash tests**

Add these tests to `test/execution-verification-amendment.test.ts` using the file's existing hashes and scoped-task fixture:

```ts
test('[adversarial] TestCase v2 hashes exact threat vectors and safety oracles', () => {
  const withoutHash: Omit<TestCaseV2, 'contentHash'> = {
    schemaVersion: 2,
    id: 'TC-0042',
    level: 'CONTRACT_CONSUMER',
    title: 'Reject a stale authorization response',
    sourceRefs: [
      { ref: 'policies/authorization-threat-model.yaml#stale-response', contentHash: HASH_A },
      { ref: 'spec.md#AC-07', contentHash: HASH_B },
    ],
    scopedTasks: [{
      project: 'quote-center', changeId: 'CHG-0001', revision: 'REV-0001',
      baseline: 'BL-0001', taskId: 'TASK-001',
    }],
    commandRefs: ['quote:contract-consumer'],
    expectedOutcome: 'the response is rejected before any quote side effect',
    adversarial: {
      threatRefs: [{ ref: 'policies/authorization-threat-model.yaml#stale-response', contentHash: HASH_A }],
      vectorIds: ['IDENTITY_TAMPERING', 'STALE_REPLAY'],
      safetyProperties: ['NO_UNAUTHORIZED_EFFECT', 'REJECTED'],
      hypothesis: 'a response bound to an obsolete snapshot may be accepted',
    },
  };
  const value = testCaseV2Schema.parse({ ...withoutHash, contentHash: hashTestCase(withoutHash) });
  assert.equal(value.schemaVersion, 2);
  assert.deepEqual(value.adversarial?.vectorIds, ['IDENTITY_TAMPERING', 'STALE_REPLAY']);
  assert.throws(() => testCaseV2Schema.parse({
    ...value,
    adversarial: { ...value.adversarial!, vectorIds: ['STALE_REPLAY', 'IDENTITY_TAMPERING'] },
  }), /SORTED_UNIQUE|CONTENT_HASH_MISMATCH/);
});

test('[adversarial] a threat ref must be an exact source and one ref cannot bind two hashes', () => {
  const base = adversarialTestCaseV2Fixture();
  assert.throws(() => testCaseV2Schema.parse(rehashTestCase({
    ...base,
    adversarial: { ...base.adversarial!, threatRefs: [{ ref: 'missing-threat', contentHash: HASH_A }] },
  })), /ADVERSARIAL_THREAT_SOURCE_MISSING/);
  assert.throws(() => anyTestCaseSchema.parse(rehashTestCase({
    ...base,
    sourceRefs: [
      { ref: 'spec.md', contentHash: HASH_A },
      { ref: 'spec.md', contentHash: HASH_B },
    ],
  })), /TEST_CASE_SOURCE_IDENTITY_CONFLICT/);
});

test('TestCase v1 keeps its original identity and remains explicitly readable', () => {
  const legacy = testCaseFixture();
  assert.equal(anyTestCaseSchema.parse(legacy).schemaVersion, 1);
  assert.equal(hashTestCase(legacy), legacy.contentHash);
});
```

Keep `adversarialTestCaseV2Fixture()` and `rehashTestCase()` in the test file; they return complete real records. Expected vector/oracle arrays remain literal.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
npm run build && node --test dist/test/execution-verification-amendment.test.js
```

Expected: TypeScript fails because `TestCaseV2`, `testCaseV2Schema`, and `anyTestCaseSchema` do not exist.

- [ ] **Step 3: Add the v2 types and strict conditional facts**

In `src/execution/types.ts`, export the existing source-ref schema/type and add:

```ts
export const contentAddressedSourceRefSchema = z.strictObject({
  ref: z.string().min(1),
  contentHash: contentHashSchema,
});
export type ContentAddressedSourceRef = z.infer<typeof contentAddressedSourceRefSchema>;

export const ADVERSARIAL_SAFETY_PROPERTIES = [
  'INVARIANT_PRESERVED',
  'NO_CROSS_SCOPE_EFFECT',
  'NO_UNAUTHORIZED_EFFECT',
  'REJECTED',
  'SAFE_FAILURE',
] as const;
export type AdversarialSafetyProperty = (typeof ADVERSARIAL_SAFETY_PROPERTIES)[number];

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
  level: z.enum(['UNIT', 'COMPONENT', 'CONTRACT_PROVIDER', 'CONTRACT_CONSUMER', 'INTEGRATION', 'E2E']),
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
```

`validateTestCaseV2` applies the existing sorted/unique and hash checks, requires every exact `(ref, contentHash)` threat identity to exist in `sourceRefs`, and calls a shared `requireOneHashPerLogicalRef()` for both v1 and v2 source arrays. Emit exact custom messages `ADVERSARIAL_THREAT_SOURCE_MISSING` and `TEST_CASE_SOURCE_IDENTITY_CONFLICT`.

- [ ] **Step 4: Make TestCase hashing version-aware**

Replace the hash helper with this semantic branch:

```ts
export function hashTestCase(
  testCase: Omit<TestCase, 'contentHash'> | TestCase | Omit<TestCaseV2, 'contentHash'> | TestCaseV2,
): ContentHash {
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
  return hashObject(testCase.schemaVersion === 2
    ? { ...common, adversarial: testCase.adversarial }
    : common);
}
```

Do not change v1 field order or add `adversarial: undefined` to its identity.

- [ ] **Step 5: Run GREEN and the v1 regression**

```bash
npm run build
node --test dist/test/execution-verification-amendment.test.js dist/test/execution-types.test.js
```

Expected: both files pass; v1 fixture hashes remain unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/execution/types.ts test/execution-verification-amendment.test.ts
git commit -m "feat: version adversarial test cases"
```

---

### Task 2: Define immutable policy, requirement, assurance, and VerificationPlan v2 records

**Files:**
- Modify: `src/execution/types.ts`
- Create: `test/adversarial-verification-policy.test.ts`
- Modify: `test/execution-verification-amendment.test.ts`

**Interfaces:**
- Consumes: Task 1 `AnyTestCase`, source refs, scoped task refs, contract scope facts, and existing VerificationPlan v1.
- Produces: `adversarialCoveragePolicySchema`, `hashAdversarialCoveragePolicy`, `AdversarialCoveragePolicy`, `AdversarialPolicyRef`, `adversarialRequirementSchema`, `AdversarialRequirement`, `adversarialExemptionSchema`, `AdversarialExemption`, `adversarialCheckSchema`, `AdversarialCheck`, `verificationPlanV2Schema`, `VerificationPlanV2`, `AnyVerificationPlan`, `anyVerificationPlanSchema`, and version-aware plan hashing.

- [ ] **Step 1: Write failing policy and plan-v2 schema tests**

Create `test/adversarial-verification-policy.test.ts` with complete literal fixtures and these behaviors:

```ts
test('[adversarial] policy rejects an unknown requirement vector and a forged content hash', () => {
  const policy = adversarialPolicyFixture();
  assert.throws(() => adversarialCoveragePolicySchema.parse(rehashPolicy({
    ...policy,
    requirements: [{ scope: 'BEHAVIOR_TASK', vectorIds: ['NOT_DEFINED'] }],
  })), /ADVERSARIAL_POLICY_VECTOR_UNKNOWN/);
  assert.throws(() => adversarialCoveragePolicySchema.parse({ ...policy, contentHash: HASH_D }), /CONTENT_HASH_MISMATCH/);
});

test('[adversarial] VerificationPlan v1 remains readable but v2 freezes exact assurance', () => {
  const legacy = verificationPlanV1Fixture();
  const current = verificationPlanV2Fixture();
  assert.equal(anyVerificationPlanSchema.parse(legacy).schemaVersion, 1);
  assert.equal(anyVerificationPlanSchema.parse(current).schemaVersion, 2);
  assert.equal(current.machineVersion, 2);
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
```

The policy fixture declares all eight default vectors and uses literal sorted safety properties. `verificationPlanV2Fixture()` contains one task requirement and one exact check whose vector coverage names exact scoped TestCase refs.

- [ ] **Step 2: Run the new test and verify RED**

```bash
npm run build && node --test dist/test/adversarial-verification-policy.test.js
```

Expected: compile failure because the policy and v2 plan exports are absent.

- [ ] **Step 3: Add immutable policy and exact requirement schemas**

Add these public shapes in `src/execution/types.ts`:

```ts
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
```

`validateAdversarialCoveragePolicy` requires vectors, each vector's safety properties, requirements, and each requirement's vector IDs to be sorted/unique; requires every requirement vector to exist; and verifies exact `hashAdversarialCoveragePolicy`. The hash excludes only `contentHash`.

Define `adversarialRequirementScopeSchema` as a discriminated union of:

```ts
{ kind: 'TASK'; scopedTask: ScopedTaskRef }
{ kind: 'CONTRACT_SCENARIO'; worksetId: string; contractKey: string; scopeHash: ContentHash;
  contractSnapshot: ContractRef; scenarioId: string }
```

Then define requirements, exemptions, and checks:

```ts
export const adversarialRequirementSchema = z.strictObject({
  policy: contentAddressedSourceRefSchema,
  scope: adversarialRequirementScopeSchema,
  vectorIds: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).min(1).readonly(),
});

export const adversarialExemptionSchema = z.strictObject({
  policy: contentAddressedSourceRefSchema,
  scope: adversarialRequirementScopeSchema,
  vectorIds: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).min(1).readonly(),
  reasonCode: z.enum(['DOCUMENTATION_ONLY', 'GENERATED_VIEW_ONLY', 'MECHANICALLY_TESTLESS', 'NOT_APPLICABLE']),
  sourceRefs: z.array(contentAddressedSourceRefSchema).min(1).readonly(),
  explanationHash: contentHashSchema,
});

export const adversarialCheckSchema = z.strictObject({
  policy: contentAddressedSourceRefSchema,
  scope: adversarialRequirementScopeSchema,
  vectors: z.array(z.strictObject({
    vectorId: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    caseRefs: z.array(testCaseRefSchema).min(1).readonly(),
  })).min(1).readonly(),
  commandRefs: z.array(z.string().min(1)).min(1).readonly(),
});
```

Apply sorted/unique checks using canonical policy/scope/ref keys and export all inferred types. The `policy` field is the exact `AdversarialPolicyRef` copied into each durable requirement, exemption, and check; VerificationPlan v2 validation requires it to equal the enclosing `adversarialPolicy`. Do not add an Agent-set `validated: true` flag: successful canonical compilation plus Core admission is the validation result, and Milestone C Task 9A persists it through the existing aggregate/event authority.

- [ ] **Step 4: Add VerificationPlan v2 beside the registered v1 schema**

Keep `verificationPlanSchema` and the aggregate registry bound to v1 in this isolated handoff. Add:

```ts
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
  projectChecks: z.array(verificationProjectCheckSchema).min(1).readonly(),
  integrationCaseRefs: z.array(testCaseRefSchema).readonly(),
  adversarialPolicy: contentAddressedSourceRefSchema,
  adversarialRequirements: z.array(adversarialRequirementSchema).readonly(),
  adversarialChecks: z.array(adversarialCheckSchema).readonly(),
  adversarialExemptions: z.array(adversarialExemptionSchema).readonly(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).superRefine(validateVerificationPlanV2);

export type VerificationPlanV2 = z.infer<typeof verificationPlanV2Schema>;
export type AnyVerificationPlan = VerificationPlan | VerificationPlanV2;
export const anyVerificationPlanSchema = z.union([verificationPlanSchema, verificationPlanV2Schema]);
```

`validateVerificationPlanV2` repeats the v1 lifecycle/sorted/unique rules, requires every task in `projectChecks` to have an adversarial requirement, and requires each requirement/vector pair to occur in exactly one of `adversarialChecks` or `adversarialExemptions`; a missing, duplicate, or overlapping pair emits `ADVERSARIAL_ASSURANCE_PARTITION_INVALID`. Every check case ref must also occur in the ordinary project/integration case sets. For `TASK` scopes, case and command refs must be subsets of that task's ordinary project check; for `CONTRACT_SCENARIO`, the schema checks case membership while `compileAdversarialAssurance` and admission-time recompilation in Tasks 3/4 prove the exact case-to-vector and case-to-command derivation from bodies.

Move the hash helper below both schemas and make the identity branch explicit:

```ts
type VerificationPlanHashInput =
  | Pick<VerificationPlan,
    'schemaVersion' | 'id' | 'worksetId' | 'scopeHash' | 'contractSnapshots' |
    'profile' | 'projectChecks' | 'integrationCaseRefs'>
  | Pick<VerificationPlanV2,
    'schemaVersion' | 'id' | 'worksetId' | 'scopeHash' | 'contractSnapshots' |
    'profile' | 'projectChecks' | 'integrationCaseRefs' | 'adversarialPolicy' |
    'adversarialRequirements' | 'adversarialChecks' | 'adversarialExemptions'>;

export function hashVerificationPlan(plan: VerificationPlanHashInput): ContentHash {
  const common = {
    schemaVersion: plan.schemaVersion,
    id: plan.id,
    worksetId: plan.worksetId,
    scopeHash: plan.scopeHash,
    contractSnapshots: plan.contractSnapshots,
    profile: plan.profile,
    projectChecks: plan.projectChecks,
    integrationCaseRefs: plan.integrationCaseRefs,
  };
  return hashObject(plan.schemaVersion === 2
    ? {
        ...common,
        adversarialPolicy: plan.adversarialPolicy,
        adversarialRequirements: plan.adversarialRequirements,
        adversarialChecks: plan.adversarialChecks,
        adversarialExemptions: plan.adversarialExemptions,
      }
    : common);
}
```

Do not register machine version 2 or a synthetic v1 migration here; Milestone C Task 9A owns persistence and recompilation from authoritative sources.

- [ ] **Step 5: Run GREEN and prove the aggregate registry remains explicit**

```bash
npm run build
node --test \
  dist/test/adversarial-verification-policy.test.js \
  dist/test/execution-verification-amendment.test.js
```

Expected: v1 and v2 schemas pass; the existing registry test still reports verification-plan current version 1, documenting that this plan creates a pure v2 handoff rather than silently changing persistence.

- [ ] **Step 6: Commit**

```bash
git add src/execution/types.ts test/adversarial-verification-policy.test.ts test/execution-verification-amendment.test.ts
git commit -m "feat: define adversarial verification assurance"
```

---

### Task 3: Compile policy-derived adversarial coverage into VerificationPlan v2

**Files:**
- Create: `src/execution/verification/adversarial.ts`
- Modify: `src/execution/verification/test-cases.ts`
- Modify: `src/execution/verification/planner.ts`
- Modify: `test/adversarial-verification-policy.test.ts`
- Modify: `test/verification-plan.test.ts`

**Interfaces:**
- Consumes: Task 1/2 v2 schemas, exact policy, required tasks, contract scenario scopes, compiled cases, and exemptions.
- Produces: `compileAdversarialAssurance(input): CompiledAdversarialAssurance`, v1/v2-capable `compileTestCase`, and `compileVerificationPlan(input): VerificationPlanV2`.

- [ ] **Step 1: Write failing compiler and coverage tests**

Add table-driven tests:

```ts
test('[adversarial] READY rejects missing, unknown, E2E-only, and out-of-scope task assurance', async (t) => {
  const attacks = [
    ['missing vector', { omitVector: 'STALE_REPLAY' }, 'ADVERSARIAL_COVERAGE_MISSING'],
    ['missing policy oracle', { omitSafetyProperty: 'REJECTED' }, 'ADVERSARIAL_SAFETY_ORACLE_MISSING'],
    ['unknown vector', { requirementVector: 'NOT_DEFINED' }, 'ADVERSARIAL_POLICY_VECTOR_UNKNOWN'],
    ['E2E only', { taskCoverageLevel: 'E2E' }, 'ADVERSARIAL_WRITER_COVERAGE_MISSING'],
    ['outside task', { adversarialTaskId: 'TASK-999' }, 'ADVERSARIAL_CASE_TASK_OUTSIDE_SCOPE'],
  ] as const;
  for (const [name, mutation, code] of attacks) {
    await t.test(`[adversarial] ${name}`, () => {
      assert.throws(
        () => compileVerificationPlan(adversarialPlanInput(mutation)),
        (error: unknown) => error instanceof VerificationFlowError && error.code === code,
      );
    });
  }
});

test('[adversarial] VerificationPlan v2 deterministically derives exact case and command sets', () => {
  const first = compileVerificationPlan(adversarialPlanInput());
  const second = compileVerificationPlan(permutedAdversarialPlanInput());
  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, 2);
  assert.deepEqual(first.adversarialChecks[0]?.vectors.map((item) => item.vectorId), [
    'IDENTITY_TAMPERING', 'STALE_REPLAY',
  ]);
  assert.deepEqual(first.adversarialChecks[0]?.commandRefs, ['quote:contract-consumer']);
});

test('[adversarial] an exemption must bind exact policy vectors and authoritative sources', () => {
  assert.throws(() => compileVerificationPlan(adversarialPlanInput({
    exemption: { vectorIds: ['STALE_REPLAY'], sourceRefs: [{ ref: 'invented.md', contentHash: HASH_A }] },
  })), /ADVERSARIAL_EXEMPTION_INVALID/);
});
```

The fixture supplies `authoritativeSourceRefs` separately so an exemption cannot authorize itself.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npm run build && node --test \
  dist/test/adversarial-verification-policy.test.js \
  dist/test/verification-plan.test.js
```

Expected: compile failures because the adversarial compiler and v2 plan input do not exist.

- [ ] **Step 3: Compile TestCase v2 proposals with stable domain errors**

Change the proposal type to the explicit union:

```ts
export type TestCaseProposal =
  | Omit<TestCase, 'contentHash'>
  | Omit<TestCaseV2, 'contentHash'>;

export interface CompileTestCaseInput {
  readonly scope: TestCaseRef['scope'];
  readonly testCase: TestCaseProposal;
}

export interface CompiledTestCase {
  readonly testCase: AnyTestCase;
  readonly ref: TestCaseRef;
}
```

Canonicalize v2 `threatRefs`, `vectorIds`, and `safetyProperties` before hashing. Parse with `anyTestCaseSchema`. Convert malformed or conflicting v2 proposals to stable `VerificationFlowError` codes `ADVERSARIAL_CASE_INVALID` or `TEST_CASE_SOURCE_IDENTITY_CONFLICT`; never leak raw Zod/TypeError.

Extend `VerificationFlowIssueCode` with this exact pure-compiler set:

```ts
| 'ADVERSARIAL_POLICY_MISSING'
| 'ADVERSARIAL_POLICY_STALE'
| 'ADVERSARIAL_POLICY_VECTOR_UNKNOWN'
| 'ADVERSARIAL_CASE_INVALID'
| 'ADVERSARIAL_CASE_TASK_OUTSIDE_SCOPE'
| 'ADVERSARIAL_WRITER_COVERAGE_MISSING'
| 'ADVERSARIAL_COVERAGE_MISSING'
| 'ADVERSARIAL_SAFETY_ORACLE_MISSING'
| 'ADVERSARIAL_EXEMPTION_INVALID'
| 'TEST_CASE_SOURCE_IDENTITY_CONFLICT'
```

- [ ] **Step 4: Implement exact assurance compilation**

Create `src/execution/verification/adversarial.ts` with:

```ts
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

export function compileAdversarialAssurance(
  input: CompileAdversarialAssuranceInput,
): CompiledAdversarialAssurance;
```

First require `policyRef.contentHash === policy.contentHash` and every requirement/exemption `policy` to equal that exact ref. For each `requiredTask`, require exactly one `TASK` requirement whose vectors include the union of the policy's `BEHAVIOR_TASK` vectors; a caller cannot make the task disappear by supplying an empty requirement list. For each requirement vector, choose all exact compiled v2 cases whose `adversarial.vectorIds` contains the vector and whose scope covers the exact task or contract scenario. The union of those cases' `safetyProperties` must contain every safety property declared for that vector by the policy, or compilation fails with `ADVERSARIAL_SAFETY_ORACLE_MISSING`. A task vector accepts only project-gate levels. Canonically derive per-vector refs and the union of commands. Require every vector to be covered by a check or one non-overlapping valid exemption. Reject duplicate scopes, unknown vectors, v1 cases presented as adversarial, orphan tasks/scenarios, invented exemption sources, and ambiguous source hashes with stable domain codes.

- [ ] **Step 5: Compile VerificationPlan v2 from ordinary and adversarial coverage**

Extend the input exactly:

```ts
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
```

Keep the existing ordinary project/integration coverage derivation, call `compileAdversarialAssurance` with `adversarialPolicyRef`, and return `verificationPlanV2Schema.parse` with `schemaVersion: 2`, `machineVersion: 2`, `status: 'READY'`, zero event cursor, and the exact v2 hash.

- [ ] **Step 6: Run GREEN and refactor canonical key helpers**

```bash
npm run build
node --test \
  dist/test/adversarial-verification-policy.test.js \
  dist/test/verification-plan.test.js \
  dist/test/execution-verification-amendment.test.js
```

Expected: all tests pass. Extract shared task/scope/source keys only after GREEN; do not introduce persistence or Task-risk derivation.

- [ ] **Step 7: Commit**

```bash
git add \
  src/execution/verification/adversarial.ts \
  src/execution/verification/test-cases.ts \
  src/execution/verification/planner.ts \
  test/adversarial-verification-policy.test.ts \
  test/verification-plan.test.ts
git commit -m "feat: require adversarial plan coverage"
```

---

### Task 4: Harden Wave and Writer admission against coherent packet mutations

**Files:**
- Modify: `src/execution/types.ts`
- Modify: `src/execution/verification/gates.ts`
- Modify: `test/verification-entry-gates.test.ts`

**Interfaces:**
- Consumes: Task 3 `AnyVerificationPlan`, the exact `AdversarialCoveragePolicy`, compiled cases, Wave/member bindings, and RunPacket v1.
- Produces: `RunPacketWithoutHash`, `hashRunPacket`, runtime-safe Wave/plan parsing, v2-only current-policy admission, packet content verification, agent/command/path/permission binding, and stable `EntryGateIssueCode` failures.
- Defers: authoritative ref loading, command-ref-to-argv resolution, Claim acquisition, realpath/symlink checks, and network-policy derivation to the existing Milestone C services. This pure gate checks only facts supplied by those services.

- [ ] **Step 1: Replace placeholder packet hashes in the fixture**

Add a helper that calculates the packet hash after every fixture mutation:

```ts
function rehashPacket(packet: WriterRunPacket): WriterRunPacket {
  const { packetHash: _discarded, ...withoutHash } = packet;
  return { ...withoutHash, packetHash: hashRunPacket(withoutHash) } as WriterRunPacket;
}
```

Change `writerPacketFixture()` to return `rehashPacket({...})`; after this step, no gate test may rely on an arbitrary `HASH_C` packet identity.

- [ ] **Step 2: Write the failing table-driven attack tests**

In `test/verification-entry-gates.test.ts`, add complete fixture mutations:

```ts
test('[adversarial] Writer entry rejects packet identity, command, agent, and path drift', async (t) => {
  const attacks = [
    ['unknown packet kind', mutatePacketKind, 'PACKET_SCHEMA_INVALID'],
    ['body changed without rehash', mutateObjectiveOnly, 'PACKET_CONTENT_HASH_MISMATCH'],
    ['verification command changed and rehashed', mutateVerificationCommandAndRehash,
      'PACKET_VERIFICATION_COMMAND_MISMATCH'],
    ['agent id changed and rehashed', mutateAgentAndRehash, 'PACKET_AGENT_MISMATCH'],
    ['agent protocol changed and rehashed', mutateProtocolAndRehash, 'PACKET_AGENT_MISMATCH'],
    ['allowed path traverses parent and is rehashed', mutateTraversalAndRehash, 'PACKET_ALLOWED_PATH_INVALID'],
    ['filesystem root expands beyond worktree and is rehashed', mutateRootAndRehash,
      'PACKET_PERMISSION_POLICY_MISMATCH'],
    ['worktree and root coherently expand and are rehashed', mutateWorktreeAndRootAndRehash,
      'PACKET_PERMISSION_POLICY_MISMATCH'],
  ] as const;
  for (const [name, mutate, expectedCode] of attacks) {
    await t.test(`[adversarial] ${name}`, () => {
      const input = writerEntryFixture();
      const result = evaluateWriterEntry({ ...input, packet: mutate(input.packet) });
      assert.equal(result.ok, false);
      assert.equal(result.ok ? undefined : result.issues.some((issue) => issue.code === expectedCode), true);
    });
  }
});

test('[adversarial] Wave entry fails closed on duplicate members and malformed plan bodies', async (t) => {
  const input = waveEntryFixture();
  const attacks = [
    ['unknown wave status', { ...input, wave: { ...input.wave, status: 'ENTERED' } },
      'WAVE_SCHEMA_INVALID'],
    ['duplicate wave member', { ...input, wave: { ...input.wave, members: [input.wave.members[0]!, input.wave.members[0]!] } },
      'WAVE_SCHEMA_INVALID'],
    ['legacy READY plan replay', { ...input, verificationPlan: verificationPlanV1Fixture() },
      'ADVERSARIAL_ASSURANCE_UNPROVEN'],
    ['stale policy ref', { ...input, adversarialPolicyRef: { ...input.adversarialPolicyRef, contentHash: HASH_D } },
      'ADVERSARIAL_POLICY_STALE'],
    ['plan body changed without rehash', { ...input, verificationPlan: mutatePlanBody(input.verificationPlan) },
      'VERIFICATION_PLAN_SCHEMA_INVALID'],
  ] as const;
  for (const [name, attack, expectedCode] of attacks) {
    await t.test(`[adversarial] ${name}`, () => assertGateIssue(evaluateWaveEntry(attack), expectedCode));
  }
});
```

Pass exact `expectedAgent: { agentId, protocol }`, `expectedWorktree`, `expectedVerificationCommands`, `adversarialPolicy`, `adversarialPolicyRef`, and `authoritativeSourceRefs` facts in the v2 gate fixture. Include a positive test proving a correctly hashed, lexically contained packet passes.

- [ ] **Step 3: Run the gate test and verify RED**

```bash
npm run build && node --test dist/test/verification-entry-gates.test.js
```

Expected: compile failures for `hashRunPacket`, the new gate inputs, and the new issue codes.

- [ ] **Step 4: Hash every execution-relevant RunPacket field**

In `src/execution/types.ts`, export:

```ts
type WithoutPacketHash<T> = T extends unknown ? Omit<T, 'packetHash'> : never;
export type RunPacketWithoutHash = WithoutPacketHash<RunPacket>;

export function hashRunPacket(
  packet: RunPacketWithoutHash | RunPacket,
): ContentHash {
  const { packetHash: _discarded, ...identity } = packet as RunPacket;
  return hashObject(identity);
}
```

Do not add a hash refinement to `runPacketSchema`: parsing and identity comparison are distinct admission diagnostics. `evaluateWriterEntry()` first parses the runtime value, then compares `hashRunPacket(parsedPacket)` with `parsedPacket.packetHash` and emits `PACKET_CONTENT_HASH_MISMATCH`.

- [ ] **Step 5: Parse Wave and plan runtime values before field access**

Change gate inputs to accept runtime values without trusting TypeScript casts:

```ts
export interface EvaluateWaveEntryInput {
  readonly wave: unknown;
  readonly verificationPlan: unknown;
  readonly adversarialPolicy: AdversarialCoveragePolicy;
  readonly adversarialPolicyRef: AdversarialPolicyRef;
  readonly authoritativeSourceRefs: readonly ContentAddressedSourceRef[];
  readonly cases: readonly CompiledTestCase[];
  readonly invalidatedTasks: readonly ScopedTaskRef[];
}

export interface EvaluateWriterEntryInput extends EvaluateWaveEntryInput {
  readonly member: Wave['members'][number];
  readonly packet: unknown;
  readonly expectedAgent: Readonly<{ agentId: string; protocol: 'acp' | 'native' }>;
  readonly expectedWorktree: string;
  readonly expectedVerificationCommands: readonly string[];
  readonly activeWriterProjects: readonly string[];
}
```

Use `waveSchema.safeParse`, followed by `anyVerificationPlanSchema.safeParse`. Return only structured `WAVE_SCHEMA_INVALID` or `VERIFICATION_PLAN_SCHEMA_INVALID` issues with fixed bounded details such as `wave failed strict schema`; do not access a malformed object's fields, join raw Zod issues, or expose an exception. Apply the same fixed-detail rule to `PACKET_SCHEMA_INVALID`. If the parsed plan is v1, emit `ADVERSARIAL_ASSURANCE_UNPROVEN` and stop before member derivation. For v2, require `adversarialPolicyRef.contentHash === adversarialPolicy.contentHash` and the supplied ref to equal `plan.adversarialPolicy`, then reproduce the plan with the exact ref, policy, requirements, exemptions, sources, and cases. Emit `ADVERSARIAL_POLICY_STALE` or `VERIFICATION_PLAN_CONTENT_MISMATCH` as appropriate.

- [ ] **Step 6: Bind the packet to exact member and least-privilege lexical facts**

Add these issue codes:

```ts
| 'ADVERSARIAL_ASSURANCE_UNPROVEN'
| 'ADVERSARIAL_POLICY_STALE'
| 'PACKET_AGENT_MISMATCH'
| 'PACKET_ALLOWED_PATH_INVALID'
| 'PACKET_CONTENT_HASH_MISMATCH'
| 'PACKET_PERMISSION_POLICY_MISMATCH'
| 'PACKET_VERIFICATION_COMMAND_MISMATCH'
| 'VERIFICATION_PLAN_SCHEMA_INVALID'
| 'WAVE_SCHEMA_INVALID'
```

After parsing and hashing, require:

- `packet.agent.agentId === member.agentId === expectedAgent.agentId` and `packet.agent.protocol === expectedAgent.protocol`;
- `packet.verificationCommands` exactly equals `expectedVerificationCommands`, while `packet.commandRefs` independently equals the member's exact plan-derived command refs;
- each `allowedPaths` entry uses `/`, is relative, non-empty, and has no `.` or `..` segment after lexical normalization;
- normalized `packet.git.worktree` equals normalized `expectedWorktree`, and `permissionPolicy.filesystemRoots` is exactly that one absolute path.

Use an explicit lexical helper rather than platform-dependent prefix checks:

```ts
import { isAbsolute, posix, resolve } from 'node:path';

function isSafeAllowedPath(value: string): boolean {
  if (value.length === 0 || value.includes('\\') || posix.isAbsolute(value)) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function normalizeAbsolute(value: string): string | undefined {
  return isAbsolute(value) ? resolve(value) : undefined;
}
```

Do not infer whether `network` should be `ALLOW` or `DENY`; Milestone C Task 5 resolves that and `expectedVerificationCommands` from Core-owned command definitions and policy. Lexical containment here is defense in depth only; Milestone C Task 5 must perform `realpath`/symlink containment against the authoritative worktree before execution.

- [ ] **Step 7: Run GREEN plus schema regression**

```bash
npm run build
node --test \
  dist/test/verification-entry-gates.test.js \
  dist/test/execution-types.test.js \
  dist/test/verification-plan.test.js
```

Expected: positive admission passes; every mutation reports its exact code; malformed input returns a result rather than throwing.

- [ ] **Step 8: Commit**

```bash
git add src/execution/types.ts src/execution/verification/gates.ts test/verification-entry-gates.test.ts
git commit -m "fix: harden adversarial execution gates"
```

---

### Task 5: Reject self-consistent but semantically forged ImpactClosures

**Files:**
- Modify: `src/execution/verification/impact.ts`
- Modify: `test/execution-impact-closure.test.ts`

**Interfaces:**
- Consumes: the existing `ImpactClosure` record, `impactNodeKey`, roots, affected nodes, and persisted traversed edges.
- Produces: schema-level semantic reachability validation with stable `IMPACT_CLOSURE_SEMANTIC_MISMATCH` diagnostics.
- Does not claim: that a caller supplied the complete dependency graph. Milestone C Task 10's authoritative graph builder owns that proof.

- [ ] **Step 1: Write three rehashed semantic-forgery tests**

Use the valid closure fixture and deliberately recompute its hash after each mutation:

```ts
test('[adversarial] ImpactClosure rejects a rehashed unreachable affected node', () => {
  const valid = compile();
  const unrelated = node('WAVE_MEMBER', 'WAVE-9999/quote-center/TASK-999', HASH_C);
  const affected = [...valid.affected, unrelated]
    .sort((left, right) => impactNodeKey(left) < impactNodeKey(right) ? -1 : 1);
  const forged = rehashClosure({ ...valid, affected });
  assert.throws(() => impactClosureSchema.parse(forged), /IMPACT_CLOSURE_SEMANTIC_MISMATCH/);
});

test('[adversarial] ImpactClosure rejects a rehashed missing justifying edge', () => {
  const valid = compile();
  const forged = rehashClosure({ ...valid, traversedEdges: valid.traversedEdges.slice(0, -1) });
  assert.throws(() => impactClosureSchema.parse(forged), /IMPACT_CLOSURE_SEMANTIC_MISMATCH/);
});

test('[adversarial] ImpactClosure rejects a rehashed affected set without its root', () => {
  const valid = compile();
  const rootKey = impactNodeKey(valid.roots[0]!.node);
  const forged = rehashClosure({
    ...valid,
    affected: valid.affected.filter((node) => impactNodeKey(node) !== rootKey),
  });
  assert.throws(() => impactClosureSchema.parse(forged), /IMPACT_CLOSURE_SEMANTIC_MISMATCH/);
});

function rehashClosure(
  closure: Omit<ImpactClosure, 'contentHash'> | ImpactClosure,
): ImpactClosure {
  const { contentHash: _discarded, ...identity } = closure as ImpactClosure;
  return { ...identity, contentHash: hashImpactClosure(identity) };
}
```

Import `hashImpactClosure` and `ImpactClosure` from the production module. Also retain the existing duplicate, cycle, dangling-edge, and deterministic traversal tests.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
npm run build && node --test dist/test/execution-impact-closure.test.js
```

Expected: all three new tests fail because a correctly rehashed forged body currently passes schema validation.

- [ ] **Step 3: Validate closure semantics inside the schema refinement**

Add `validateImpactClosureSemantics(closure, context)` after sorted/unique validation and before the hash diagnostic. It must:

1. index `affected` by `impactNodeKey`;
2. require every root node in `affected`;
3. require both endpoints of every `traversedEdge` in `affected`;
4. breadth-first traverse only `traversedEdges`, beginning at all roots;
5. require the reached key set to equal the `affected` key set exactly.

Use this concrete shape; `semanticIssue()` adds `{ code: 'custom', path, message: 'IMPACT_CLOSURE_SEMANTIC_MISMATCH' }`:

```ts
function validateImpactClosureSemantics(
  closure: {
    readonly roots: readonly ImpactRoot[];
    readonly affected: readonly ImpactGraphNode[];
    readonly traversedEdges: readonly ImpactGraphEdge[];
  },
  context: z.RefinementCtx,
): void {
  const affected = new Set(closure.affected.map(impactNodeKey));
  const rootKeys = closure.roots.map((root) => impactNodeKey(root.node));
  if (rootKeys.some((key) => !affected.has(key))) {
    semanticIssue(context, ['affected']);
    return;
  }
  const outgoing = new Map<string, string[]>();
  for (const graphEdge of closure.traversedEdges) {
    const from = impactNodeKey(graphEdge.from);
    const to = impactNodeKey(graphEdge.to);
    if (!affected.has(from) || !affected.has(to)) {
      semanticIssue(context, ['traversedEdges']);
      return;
    }
    outgoing.set(from, [...(outgoing.get(from) ?? []), to]);
  }
  const reached = new Set(rootKeys);
  const queue = [...rootKeys];
  for (let index = 0; index < queue.length; index += 1) {
    for (const target of outgoing.get(queue[index]!) ?? []) {
      if (!reached.has(target)) {
        reached.add(target);
        queue.push(target);
      }
    }
  }
  if (reached.size !== affected.size || [...affected].some((key) => !reached.has(key))) {
    semanticIssue(context, ['affected']);
  }
}

function semanticIssue(context: z.RefinementCtx, path: PropertyKey[]): void {
  context.addIssue({ code: 'custom', path, message: 'IMPACT_CLOSURE_SEMANTIC_MISMATCH' });
}
```

Every semantic violation adds one custom issue with message `IMPACT_CLOSURE_SEMANTIC_MISMATCH` and a stable field path. Cycles are valid when reachable; a self-consistent unreachable island is not. Keep `hashImpactClosure` unchanged.

- [ ] **Step 4: Run GREEN and the complete closure regression**

```bash
npm run build
node --test dist/test/execution-impact-closure.test.js dist/test/execution-verification-amendment.test.js
```

Expected: compiler-produced closures still pass; all rehashed semantic forgeries fail with the stable code.

- [ ] **Step 5: Commit**

```bash
git add src/execution/verification/impact.ts test/execution-impact-closure.test.ts
git commit -m "fix: validate impact closure semantics"
```

---

### Task 6: Make the adversarial corpus an explicit automated Milestone gate

**Files:**
- Modify: `package.json`
- Create: `scripts/run-adversarial-tests.mjs`
- Create: `test/verification-adversarial.test.ts`
- Modify: `test/adversarial-verification-policy.test.ts`
- Modify: `test/verification-plan.test.ts`
- Modify: `test/verification-entry-gates.test.ts`
- Modify: `test/execution-impact-closure.test.ts`
- Modify: `docs/superpowers/plans/2026-08-16-omnai-v0.3-autonomous-parallel-execution.md`
- Modify: `docs/superpowers/plans/2026-08-20-omnai-test-flow-optimization.md`

**Interfaces:**
- Consumes: the focused adversarial tests from Tasks 1-5 and the committed Milestone C task sequence.
- Produces: one auto-discovering `npm run test:adversarial` command, a cross-module mutation corpus, and a mandatory per-task attack-matrix rule for Milestone C Tasks 5-22.

- [ ] **Step 1: Add the cross-module mutation corpus in RED**

Create `test/verification-adversarial.test.ts`. Reuse public production parsers/compilers/gates, but build independent literal fixtures. Cover at least this table:

| Mutation | Production boundary | Required failure |
| --- | --- | --- |
| one logical source ref binds two hashes | TestCase v2 | `TEST_CASE_SOURCE_IDENTITY_CONFLICT` |
| a required policy safety oracle is stripped | assurance compiler | `ADVERSARIAL_SAFETY_ORACLE_MISSING` |
| legacy `READY` plan is replayed | Wave gate | `ADVERSARIAL_ASSURANCE_UNPROVEN` |
| packet verification command drifts and packet is rehashed | Writer gate | `PACKET_VERIFICATION_COMMAND_MISMATCH` |
| packet principal/protocol drifts and packet is rehashed | Writer gate | `PACKET_AGENT_MISMATCH` |
| allowed path contains `..` and packet is rehashed | Writer gate | `PACKET_ALLOWED_PATH_INVALID` |
| unreachable node is appended and closure is rehashed | ImpactClosure schema | `IMPACT_CLOSURE_SEMANTIC_MISMATCH` |

Name every top-level and subtest with the `[adversarial]` prefix. Assert exact domain codes, not broad `throws` alone and not implementation call counts.

- [ ] **Step 2: Add the dedicated auto-discovering test runner**

Create `scripts/run-adversarial-tests.mjs` so future Milestone tasks cannot add a tagged test without the dedicated gate discovering its file:

```js
import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const directory = resolve('dist/test');
const marker = /\b(?:test|it|describe)\s*\(\s*['"`]\[adversarial\]/;
const candidates = (await readdir(directory))
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => resolve(directory, name));
const files = [];
for (const file of candidates) {
  if (marker.test(await readFile(file, 'utf8'))) files.push(file);
}
if (files.length === 0) {
  console.error(`No [adversarial] tests found under ${directory}`);
  process.exit(1);
}
console.error(`Adversarial test files: ${files.length}`);
const result = spawnSync(
  process.execPath,
  ['--test', '--test-name-pattern=\\[adversarial\\]', ...files],
  { cwd: process.cwd(), stdio: 'inherit' },
);
process.exit(result.status ?? 1);
```

Add to `package.json`:

```json
"test:adversarial": "npm run build && node scripts/run-adversarial-tests.mjs"
```

Run:

```bash
npm run test:adversarial
```

Expected: before all Task 1-5 implementations are complete, the command is RED for the named production mutations. Once they are GREEN, the command exits zero and reports every matching test; verify it does not accidentally run zero tests.

- [ ] **Step 3: Thread one adversarial gate through every remaining Milestone C task**

In `docs/superpowers/plans/2026-08-16-omnai-v0.3-autonomous-parallel-execution.md`, add a global **Adversarial test gate** immediately before C1. It must require:

- each behavior-changing Task 5-22 to add at least one positive behavior test and one table-driven `[adversarial]` mutation group;
- every group to name the real production boundary, exact mutation, independently observable safety property, and stable failure/outcome;
- no task or slice gate to pass while `npm run test:adversarial` is red;
- pure policy/compiler functions to remain the sole implementation of coverage rules while orchestration loads authority by ref and invokes them;
- fakes only at Agent, process, filesystem adapter, Git adapter, Compose, network, or external-service boundaries.

Add this exact task matrix so future execution is reviewable rather than aspirational:

| Task(s) | Mandatory adversarial focus |
| --- | --- |
| 5 | packet hash, command definition, permission, secret, path, snapshot drift |
| 6 | malformed ACP events, capability lies, cancellation, replay, unexpected exit |
| 7 | malicious Fake Agent, immutable handoff, restart, duplicate dispatch |
| 8-9 | source/contract forgery, unsafe validator, role confusion, poisoning, stale compatibility |
| 9B | process/Compose escape, secret leak, digest drift, resource ownership |
| 9A | policy/ref authority, v2 persistence, coverage, exemption, invalidation |
| 10-11 | incomplete dependency graph, stale evidence, cross-project implementation dependency |
| 12-17 | Wave/Claim race, member drift, impersonation, Git/path escape, evidence forgery, recovery |
| 18-22 | diagnostics, fault/resource injection, package integrity, adapter and release attacks |

At each existing C1-C4 and final certification command, add `npm run test:adversarial` before declaring the slice green. Do not reorder Tasks 5 -> 6 -> 7, 8 -> 9/9B -> 9A -> 10 -> 11, or 12 -> 13 -> 14 -> 15 -> 15A -> 16 -> 17. Keep F4 blocked until C1-C3 pass and keep `omnai run` blocked until Task 22.

Correct the downstream implementation snippets at their owning tasks: Milestone C Task 5's `createRunPacket()` calls this plan's Task 4 `hashRunPacket()` and passes authoritative expected agent/worktree/command facts into `evaluateWriterEntry()`; Milestone C Task 9A registers/persists VerificationPlan v2 and calls this plan's Task 3 compiler with the Core-loaded policy ref/body; Milestone C Task 10 builds the complete graph from Core-owned records before parsing this plan's Task 5 semantic closure; Milestone C Tasks 15/15A/17 reject required adversarial `SKIPPED`/`INCONCLUSIVE` or non-case-addressed results with `ADVERSARIAL_EVIDENCE_UNSATISFIED`. These are call-site integrations, not duplicate policy/hash/closure/evidence authorities.

- [ ] **Step 4: Link the optimized test-flow plan to the executable gate**

Update `docs/superpowers/plans/2026-08-20-omnai-test-flow-optimization.md` so its verification/checkpoint sections:

- cite the approved adversarial design and this implementation plan;
- run `npm run test:adversarial` at task, Wave, CommitSet, change/replay, and release checkpoints where applicable;
- state that requirement/policy changes invalidate and recompile TestCase v2/VerificationPlan v2 rather than editing a running packet;
- preserve the same Planner -> Writer -> independent Reviewer -> Core authority split.

- [ ] **Step 5: Run the automated and documentation checks**

```bash
npm run test:adversarial
npm run typecheck
git diff --check
rg -n "Adversarial test gate|test:adversarial|Task 9A|F4|omnai run" \
  docs/superpowers/plans/2026-08-16-omnai-v0.3-autonomous-parallel-execution.md \
  docs/superpowers/plans/2026-08-20-omnai-test-flow-optimization.md
```

Expected: adversarial and type checks pass; the documentation search shows the gate at the global rules and all slice/final checkpoints without changing the approved task order.

- [ ] **Step 6: Commit**

```bash
git add \
  package.json \
  scripts/run-adversarial-tests.mjs \
  test/verification-adversarial.test.ts \
  test/adversarial-verification-policy.test.ts \
  test/verification-plan.test.ts \
  test/verification-entry-gates.test.ts \
  test/execution-impact-closure.test.ts \
  docs/superpowers/plans/2026-08-16-omnai-v0.3-autonomous-parallel-execution.md \
  docs/superpowers/plans/2026-08-20-omnai-test-flow-optimization.md
git diff --cached --check
git commit -m "test: enforce adversarial verification gate"
```

---

### Task 7: Verify, independently review, and hand off to Milestone C Task 5

**Files:**
- Verify: all files changed in Tasks 0-6
- Optionally modify only for evidence correction: `docs/superpowers/plans/2026-08-20-omnai-adversarial-test-coverage.md`

**Interfaces:**
- Consumes: all focused changes and the existing v0.2/Milestone C regression suite.
- Produces: reproducible test evidence, two-stage independent review, a clean bounded diff, and an explicit next-task handoff. It does not begin Milestone C Task 5 implementation.

- [ ] **Step 1: Run the type and dedicated adversarial gates**

```bash
npm run typecheck
npm run test:adversarial
```

Expected: both exit zero; the runner reports every marker-bearing compiled file and each contributes one or more matching tests. A zero-file or zero-test success is a failure of this task.

- [ ] **Step 2: Run the complete focused execution-policy suite**

```bash
npm run build
node --test \
  dist/test/execution-types.test.js \
  dist/test/execution-verification-amendment.test.js \
  dist/test/execution-machines.test.js \
  dist/test/adversarial-verification-policy.test.js \
  dist/test/verification-plan.test.js \
  dist/test/verification-entry-gates.test.js \
  dist/test/execution-impact-closure.test.js \
  dist/test/verification-adversarial.test.js
```

Expected: all focused tests pass with zero skipped required adversarial cases and zero failures.

- [ ] **Step 3: Run the full repository regression without weakening failures**

```bash
npm test
```

Expected: zero failures. If an authenticated adapter, real Compose, or external credential remains an already-documented release blocker, record the exact command and output separately; do not mark this plan complete, change an assertion, or convert the failure to a skip merely to obtain green.

- [ ] **Step 4: Inspect scope and mutation protection**

```bash
git status --short
git diff --check
git diff --stat 458797c..HEAD
git diff --name-only 458797c..HEAD
```

Confirm all of the following manually:

- no `src/core/**`, `src/cli.ts`, public `omnai run`, new Agent kind, aggregate, ledger, scheduler, or execution engine was added;
- v1 TestCase and VerificationPlan records still parse and keep original hashes;
- a legacy `READY` plan cannot dispatch under current policy;
- every v2 vector is covered by an exact eligible case or exact validated exemption;
- self-consistent source, policy, plan, packet, command, principal, path, permission, and closure mutations fail closed;
- production authority still has explicit Milestone C Task 5/9A/10 ownership rather than being implied by caller-calculated hashes.

- [ ] **Step 5: Request two independent reviews**

First request a specification-compliance review against Sections 1-12 of the approved design. After every finding is resolved or evidenced as out of scope, request a separate code-quality/adversarial review. The second reviewer must specifically attempt:

- forged same-ID/different-hash refs;
- stale v1/v2 plan replay;
- packet body drift both with and without rehash;
- command, agent, permission-root, and allowed-path drift;
- unreachable/cyclic/dangling ImpactClosure mutations;
- empty or generic assertions that appear to cover a vector but do not observe its safety property.

Do not ask one reviewer to approve its own fixes. Re-run Steps 1-3 after every code change resulting from review.

- [ ] **Step 6: Record evidence-only corrections if necessary**

If observed test counts or command paths differ from this plan solely because the repository evolved, update only the evidence wording and commit separately:

```bash
git add docs/superpowers/plans/2026-08-20-omnai-adversarial-test-coverage.md
git diff --cached --check
git commit -m "docs: record adversarial verification evidence"
```

Do not rewrite unmet acceptance criteria as complete.

- [ ] **Step 7: Hand off the next executable milestone**

Report the exact commits, focused/full test results, review findings and resolutions, remaining production-authority obligations, and clean/known worktree state. The next executable work is the existing Milestone C **Task 5**, followed by Tasks 6 and 7 to close C1; F4 remains blocked until C1-C3 pass.
