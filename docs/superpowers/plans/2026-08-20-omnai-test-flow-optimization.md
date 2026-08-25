# OmnAI Test Flow Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic TestCase/VerificationPlan compilation, fail-closed Wave/Writer entry gates, and machine-readable exact impact closure without modifying the active Core Flow/Reconcile work.

**Architecture:** New pure modules under `src/execution/verification/` build on the existing v1 execution schemas and canonical hashing. Backward-readable schemas stay unchanged; new execution is constrained by explicit policy functions that a later F4 persistence bridge will call.

**Tech Stack:** TypeScript 5.9, Node.js 20+ built-in test runner, Zod 4, existing `src/execution/types.ts` and canonical SHA-256 hashing.

**Spec:** `docs/superpowers/specs/2026-08-20-omnai-test-flow-optimization-design.md`

**Adversarial assurance:**
`docs/superpowers/specs/2026-08-20-omnai-adversarial-test-coverage-design.md`
is the approved design, and
`docs/superpowers/plans/2026-08-20-omnai-adversarial-test-coverage.md` is the
implementation plan that provides the executable gate consumed here.

## Global Constraints

- Do not modify `src/core/**`, `src/cli.ts`, or their tests because this worktree contains concurrent user-owned edits there.
- Do not change persisted v1 execution schemas or lifecycle machine versions in this slice.
- Every public function is pure: no filesystem, Git, Agent, process, clock, or event-store side effects.
- All semantic arrays are canonical sorted and unique before hashing or comparison.
- Entry checks compare full hash-bound identities, never display IDs alone.
- Use RED -> GREEN -> REFACTOR and rebuild before every focused test run.
- Do not commit from this shared dirty worktree; verification and independent review are the handoff record.
- Adversarial assurance is an orthogonal dimension; preserve the six current
  `TestCase.level` values. TestCase/VerificationPlan v1 remain readable and retain
  their original hashes, but cannot satisfy current adversarial assurance.
- Resolve exact logical source and policy identities; unknown, ambiguous, or stale
  refs fail closed. Default behavior-changing coverage includes
  `IDENTITY_TAMPERING`, `MALFORMED_INPUT`, and `STALE_REPLAY`, and the union of case
  safety properties covers every required policy oracle.

---

## Executable adversarial checkpoints

`npm run test:adversarial` auto-discovers every compiled `*.test.js` containing a
`[adversarial]` test and fails closed when none are found. It is mandatory at each
applicable checkpoint:

| Checkpoint | Required action before advancing |
| --- | --- |
| Task | Run the focused positive tests and table-driven mutation group, then `npm run test:adversarial`. |
| Wave | Re-run `npm run test:adversarial` before any Writer entry gate may admit the Wave. |
| CommitSet | Re-run `npm run test:adversarial` before exact case-addressed evidence may move a CommitSet beyond `VERIFYING`. |
| Change/replay | Run the closure-selected affected regression set, `npm run test:adversarial`, and every broader gate required by the active Wave/CommitSet/release checkpoint after recomputing the complete ImpactClosure and before stale consumers resume. |
| Release | Run `npm run test:adversarial` before package, Compose, live-adapter, or public `omnai run` certification. |

A requirement, solution/design/implementation source, or adversarial-policy
identity change follows the complete change workflow below. It never edits a
running packet; active packets are blocked or superseded and any resumed Writer
receives a new packet bound to the new plan hash.

The authority split remains Planner -> Writer -> independent Reviewer -> Core:
the read-only Planner proposes source-traceable tests, the Writer implements them,
the separate Reviewer evaluates the patch, and Core alone loads exact policy/source
authority, invokes the pure compilers/gates, persists current artifacts, accepts
case-addressed evidence, and changes lifecycle state. No orchestration call site
duplicates policy, compiler, hash, closure, or evidence authority.

---

## Requirement and solution identity change workflow

Every requirement identity change is a mandatory `ImpactRoot` trigger; every
solution/design/implementation identity change is also a mandatory `ImpactRoot`
trigger. Requirement identity includes exact
intent, acceptance-criterion, contract, and task-requirement source hashes.
Solution/design/implementation identity includes exact solution and design source
hashes plus the current Revision, commit-tree, command-definition, and environment
input identities represented by the existing closed impact node kinds. Display-ID
equality, compatible-looking prose, or an Agent's affected-file guess cannot
suppress either class of root.

For either trigger, the future integrated workflow must execute in this order:

1. Milestone C Task 10's Core-owned graph builder loads the current authoritative
   records and constructs the complete dependency graph. Core then compiles the
   complete `ImpactClosure`; a submitted closure or its self-hash never proves graph
   completeness.
2. The complete ImpactClosure determines every affected TestCase ref. Core derives
   those affected TestCase refs from the complete `ImpactClosure`: every
   reachable `TEST_CASE` node is selected, followed by its reachable
   `VERIFICATION_PLAN`, `WAVE_MEMBER`, `RUN`, `ENVIRONMENT_INPUT`, and `COMMITSET`
   consumers. Neither changed-file proximity nor a Planner-supplied case list may
   remove a reachable test obligation.
3. Core invalidates stale affected TestCase v2 and VerificationPlan v2 eligibility,
   blocks or supersedes affected Waves, marks old Runs stale, and rejects affected
   case-addressed and environment evidence. Task 9A remains the future authority
   for v2 registration, persistence, exact exemption admission, recompilation, and
   invalidation events; this pure slice does not implement that authority.
4. The read-only Planner re-proposes the affected source-traceable cases. The one
   Writer updates every affected executable test together with the solution under
   its existing Claim. Each meaningful executable behavior change must produce
   meaningful RED then GREEN proof: behavioral RED on the pre-solution/test-only
   tree and GREEN on the exact final verified tree. A genuinely testless task uses only the exact
   policy/source-backed exemption path; Core does not synthesize a case or accept a
   generic command as proof.
5. After independent Reviewer findings are resolved, Core runs the closure-selected
   affected regression set plus `npm run test:adversarial` and every broader project,
   Wave, CommitSet, environment, package, or release gate required by the active
   checkpoint. No affected consumer may resume and no old PASS may be reused until
   all applicable gates are GREEN on the new exact identities.

Task 5 retains future authority for authoritative packet, command, principal,
worktree, and permission inputs at execution entry. Task 9A retains the v2
artifact/exemption lifecycle authority above, and Task 10 retains complete graph
construction authority. This documentation adds no Milestone C persistence,
mutation, or dispatch implementation.

---

### Task 1: Compile immutable TestCases and VerificationPlans

**Files:**
- Create: `src/execution/verification/test-cases.ts`
- Create: `src/execution/verification/planner.ts`
- Create: `test/verification-plan.test.ts`

**Interfaces:**
- Consumes: `TestCase`, `TestCaseRef`, `VerificationPlan`, `ScopedTaskRef`, `ContractSnapshotBinding`, `IntegrationEnvironmentProfileRef`, `hashTestCase`, `hashVerificationPlan`, and their schemas from `src/execution/types.ts`.
- Produces: `compileTestCase(input): CompiledTestCase`, `compileVerificationPlan(input): VerificationPlan`, and `VerificationFlowError` with stable issue codes.

- [x] **Step 1: Write failing compiler tests**

Cover stable hashes under input permutation, exact project/contract scopes, complete required-task coverage, and stable rejection codes `TEST_CASE_SCOPE_MISMATCH`, `TEST_CASE_CONTRACT_LEVEL_REQUIRED`, `VERIFICATION_TASK_UNCOVERED`, `VERIFICATION_CONTRACT_MISMATCH`, and `VERIFICATION_CASE_IDENTITY_CONFLICT`.

- [x] **Step 2: Run tests to verify RED**

Run:

```bash
./node_modules/.bin/tsc -p tsconfig.json && node --test dist/test/verification-plan.test.js
```

Expected: build fails because the new compiler modules do not exist.

- [x] **Step 3: Implement TestCase compilation**

Expose:

```ts
export interface CompileTestCaseInput {
  readonly scope: TestCaseRef['scope'];
  readonly testCase: Omit<TestCase, 'contentHash'>;
}

export interface CompiledTestCase {
  readonly testCase: TestCase;
  readonly ref: TestCaseRef;
}

export function compileTestCase(input: CompileTestCaseInput): CompiledTestCase;
```

The implementation canonicalizes `sourceRefs`, `scopedTasks`, and `commandRefs`, validates scope/level semantics, computes `hashTestCase`, parses the final body, and parses the exact ref.

- [x] **Step 4: Implement VerificationPlan compilation**

Expose:

```ts
export interface CompileVerificationPlanInput {
  readonly id: string;
  readonly worksetId: string;
  readonly scopeHash: ContentHash;
  readonly contractSnapshots: readonly ContractSnapshotBinding[];
  readonly profile: IntegrationEnvironmentProfileRef;
  readonly requiredTasks: readonly ScopedTaskRef[];
  readonly cases: readonly CompiledTestCase[];
  readonly createdAt: string;
}

export function compileVerificationPlan(input: CompileVerificationPlanInput): VerificationPlan;
```

The compiler canonicalizes all inputs, validates exact TestCase body/ref identity and contract bindings, derives one project check per required project from `UNIT | COMPONENT | CONTRACT_PROVIDER | CONTRACT_CONSUMER`, places only `INTEGRATION | E2E` cases in `integrationCaseRefs`, requires every task to have project-check coverage, computes `hashVerificationPlan`, and returns `verificationPlanSchema.parse(...)` with `status: 'READY'` and zeroed lifecycle cursor.

- [x] **Step 5: Run focused GREEN and refactor**

```bash
./node_modules/.bin/tsc -p tsconfig.json && node --test dist/test/verification-plan.test.js
npm run test:adversarial
```

Expected: all `verification-plan` tests and the executable adversarial gate PASS.

### Task 2: Enforce Wave and Writer entry gates

**Files:**
- Create: `src/execution/verification/gates.ts`
- Create: `test/verification-entry-gates.test.ts`

**Interfaces:**
- Consumes: `VerificationPlan`, `Wave`, `RunPacket`, `CompiledTestCase`, and exact ref-key helpers.
- Produces: `evaluateWaveEntry(input): EntryGateResult` and `evaluateWriterEntry(input): EntryGateResult`.

- [x] **Step 1: Write failing gate tests**

Test a valid READY plan path and failures for DRAFT/INVALID plan, plan hash mismatch, missing/extra case or command refs, contract mismatch, invalidated task, packet/member mismatch, wrong Wave ID, an already claimed project, terminal Wave status, and a malformed writer packet discriminant. Assert stable issue codes and deterministic ordering. Wave planning accepts only `PLANNED`; Writer entry accepts `PLANNED | RUNNING`.

- [x] **Step 2: Run tests to verify RED**

```bash
./node_modules/.bin/tsc -p tsconfig.json && node --test dist/test/verification-entry-gates.test.js
```

Expected: build fails because `gates.ts` does not exist.

- [x] **Step 3: Implement structured, pure gates**

Expose:

```ts
export interface EntryGateIssue {
  readonly code: EntryGateIssueCode;
  readonly detail: string;
}

export type EntryGateResult =
  | { readonly ok: true; readonly verificationPlan: VerificationPlanRef; readonly caseRefs: readonly TestCaseRef[]; readonly commandRefs: readonly string[] }
  | { readonly ok: false; readonly issues: readonly EntryGateIssue[] };
```

`evaluateWaveEntry` evaluates every member against one plan and current invalidated task set. `evaluateWriterEntry` first evaluates the member, then requires exact packet/member task, wave, plan, contract, case, command, and allowed-path identities plus no active claim for the project.

- [x] **Step 4: Run focused GREEN and refactor**

```bash
./node_modules/.bin/tsc -p tsconfig.json && node --test dist/test/verification-entry-gates.test.js
npm run test:adversarial
```

Expected: all entry-gate tests and the executable adversarial gate PASS.

### Task 3: Compile a machine-readable exact ImpactClosure

**Files:**
- Create: `src/execution/verification/impact.ts`
- Create: `test/execution-impact-closure.test.ts`

**Interfaces:**
- Consumes: canonical `hashObject` and `ContentHash`.
- Produces: `impactGraphNodeSchema`, `impactGraphEdgeSchema`, `impactClosureSchema`, `compileImpactClosure(input): ImpactClosure`, and `invalidationActionFor(kind)`.

- [x] **Step 1: Write failing closure tests**

Build a graph `SOURCE -> TASK -> TEST_CASE -> VERIFICATION_PLAN -> WAVE_MEMBER -> RUN -> ENVIRONMENT_INPUT -> COMMITSET`. Verify transitive closure, multiple roots, converging paths, input permutation stability, exact-hash isolation, dangling-edge rejection, cycle safety, and action mapping.

- [x] **Step 2: Run tests to verify RED**

```bash
./node_modules/.bin/tsc -p tsconfig.json && node --test dist/test/execution-impact-closure.test.js
```

Expected: build fails because `impact.ts` does not exist.

- [x] **Step 3: Implement schemas and deterministic traversal**

Use the closed kinds from the spec. Node identity is canonical JSON of `{kind, ref, contentHash}`. Validate unique nodes and edges, require both endpoints to exist, breadth-first or depth-first traverse with a visited set, canonicalize roots/nodes/edges, and hash only `{schemaVersion, worksetId, scopeHash, roots, affected, traversedEdges}`.

- [x] **Step 4: Implement lifecycle action projection**

Map test/plan nodes to `RECOMPILE_PLAN`, Wave nodes to `BLOCK_OR_SUPERSEDE`, Run nodes to `MARK_STALE`, environment nodes to `REQUIRE_RERUN`, CommitSet nodes to `REQUIRE_REVALIDATION`, and source/task/contract nodes to `RECOMPUTE_CLOSURE`.

- [x] **Step 5: Run focused GREEN and refactor**

```bash
./node_modules/.bin/tsc -p tsconfig.json && node --test dist/test/execution-impact-closure.test.js
npm run test:adversarial
```

Expected: all impact-closure tests and the executable adversarial gate PASS.

### Task 4: Verify compatibility and document the handoff

**Files:**
- Modify: `docs/superpowers/specs/2026-08-16-omnai-v0.3-autonomous-parallel-execution-design.md`
- Modify: `docs/superpowers/specs/2026-08-19-omnai-v0.3-native-full-pipeline-fusion-design.md`
- Test: `test/execution-types.test.ts`
- Test: `test/execution-verification-amendment.test.ts`
- Test: `test/verification-plan.test.ts`
- Test: `test/verification-entry-gates.test.ts`
- Test: `test/execution-impact-closure.test.ts`

**Interfaces:**
- Consumes: all Task 1-3 public functions and the existing execution schemas.
- Produces: explicit design links to this slice and a verified compatibility report.

- [x] **Step 1: Add design cross-references**

Add a short implementation note to each parent design: the pure policy slice is implemented, persisted lifecycle wiring remains F4, Test Planner stays read-only, and Core remains the only authority for plan readiness and invalidation transitions.

- [x] **Step 2: Run focused execution verification**

```bash
./node_modules/.bin/tsc -p tsconfig.json && node --test \
  dist/test/execution-types.test.js \
  dist/test/execution-verification-amendment.test.js \
  dist/test/verification-plan.test.js \
  dist/test/verification-entry-gates.test.js \
  dist/test/execution-impact-closure.test.js
npm run test:adversarial
```

Expected: all focused tests PASS.

- [ ] **Step 3: Run the complete project verification**

```bash
./node_modules/.bin/tsc -p tsconfig.json --noEmit
./node_modules/.bin/tsc -p tsconfig.json
npm run test:adversarial
node scripts/run-tests.mjs
```

Expected: typecheck and all tests PASS. If a known load-sensitive pre-existing Agent-profile test fails, rerun that exact file once and report both results without changing unrelated code.

Execution note: typecheck/build and the focused execution gate passed. Broad
regression batches passed 280, 121, 70, and 25 tests respectively. The complete
runner could not be certified green in this shared environment: two unrelated
Host-context tests observed a transient `/tmp` Git repository created by parallel
tests, and the tool transport aborted `protocol-doctor.test.js` before returning
an exit code. Neither area was modified by this slice.

- [x] **Step 4: Inspect scope and request independent review**

Confirm `git diff -- src/core src/cli.ts` contains no changes attributable to this plan. Review only the new verification modules, their tests, and documentation for spec compliance, correctness, and regression risk.
