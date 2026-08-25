# OmnAI Test Flow Optimization Design

**Date:** 2026-08-20

**Status:** Approved implementation slice derived from the v0.3 autonomous-execution and native full-pipeline designs

**Adversarial extension:**
`docs/superpowers/specs/2026-08-20-omnai-adversarial-test-coverage-design.md`
defines the follow-on TestCase/VerificationPlan v2 assurance model. This initial
v1 policy slice remains a compatibility and compiler kernel; it does not by itself
prove mandatory adversarial coverage.

## 1. Goal

Make testing a traceable, fail-closed workflow that starts with requirement and impact inputs, blocks autonomous writes until coverage is frozen, and invalidates only evidence that depends on a changed authoritative input.

This slice adds deterministic policy functions under `src/execution/verification/`. It does not mutate the active Flow/Reconcile implementation, persist new aggregates, run commands, or expose `omnai run`.

## 2. Optimized flow

```text
Requirement / design / contract / task sources
                    |
                    v
          deterministic impact closure
                    |
                    v
    read-only PROJECT_TEST_PLANNER proposals
                    |
                    v
 Core validates TestCases and compiles VerificationPlan
                    |
                    v
        READY plan + exact task/case/command refs
                    |
                    v
       Wave gate -> Writer gate -> RED/GREEN proof
                    |
                    v
          CommitSet VERIFYING -> E2E proof
                    |
                    v
                 COMPLETE

Any authoritative hash change
          -> exact ImpactClosure
          -> plan invalidation / Wave block / Run stale / environment rerun
          -> COMPLETE becomes NEEDS_REVALIDATION before new proof is accepted
```

Tests therefore do not live in one terminal stage:

1. acceptance scenarios originate in requirement and specification work;
2. provider/consumer scenarios originate with ContractSnapshots;
3. test seams, commands, and environment needs are selected during design and planning;
4. one read-only Test Planner Run per affected project proposes cases;
5. Core validates the proposals and compiles one immutable plan;
6. a Writer implements tests and code under the same single-writer claim;
7. a separate Reviewer and Core-owned verifier judge the result;
8. an environment runner executes exact-tuple integration and E2E cases before CommitSet completion.

## 3. Authority boundary

- `PROJECT_TEST_PLANNER` is a read-only child Agent. It may propose cases and command references but cannot write project code, declare coverage complete, or accept evidence.
- `PROJECT_WRITER` or `RECOVERY_WRITER` owns both test implementation and production implementation under the existing one-writer claim. A second write-capable “test Agent” is forbidden.
- The Reviewer is a separate read-only Run and cannot accept its own findings.
- Core alone validates TestCases, compiles and readies VerificationPlans, evaluates entry gates, executes deterministic verification, changes lifecycle state, and accepts evidence.
- Environment execution is a deterministic runner/adapter boundary, not an LLM Agent.

## 4. TestCase compilation

`compileTestCase` accepts a TestCase body without `contentHash` plus an explicit project or contract scope. It canonicalizes sorted arrays, computes the existing `hashTestCase` identity, validates the result with `testCaseSchema`, and returns both the body and exact `TestCaseRef`.

The compiler rejects:

- a project scope that does not match every scoped task's project, Change, and Revision;
- a contract case at a non-contract level or a contract-level case with project scope;
- empty source, task, or command coverage;
- duplicate authoritative refs.

Agent-provided hashes are not accepted as authority.

## 5. VerificationPlan compilation

`compileVerificationPlan` consumes required scoped tasks, compiled cases, exact ContractSnapshot bindings, and one immutable environment profile ref. It deterministically sorts its inputs, derives project checks and integration case refs, computes the existing plan hash, and returns a schema-valid `READY` plan. Project checks contain `UNIT`, `COMPONENT`, `CONTRACT_PROVIDER`, and `CONTRACT_CONSUMER` cases; only `INTEGRATION` and `E2E` cases enter the post-commit integration set. Every required task needs at least one project-check case, so an E2E case alone cannot authorize a Writer.

Compilation fails with a stable error code when:

- a required task has no mapped case;
- a project case refers to a task outside its project/change/revision scope;
- a contract case does not bind one exact current ContractSnapshot;
- one `(contractKey, scopeHash)` names more than one current ContractSnapshot;
- two cases have the same scoped identity but different content;
- a required case has no command reference.

Malformed Agent proposals fail with stable domain issue codes; raw Zod errors do
not form the orchestration contract.

`READY` here means semantic compilation passed. The later persistence bridge must still append the lifecycle event before materializing the plan; this pure slice does not bypass the event store.

## 6. Wave and Writer gates

Persisted v1 packet and Wave schemas retain optional verification fields for backward readability. New execution is fail-closed through policy gates:

- a Wave member must bind the exact READY VerificationPlan ID/hash;
- its task must be covered by the plan's exact scoped case subset;
- member contract, case, and command refs must equal the compiled subset;
- the task must not be in the current invalidation closure;
- a Writer packet must exactly equal its Wave member for task, Wave, plan, contracts, cases, commands, and allowed paths;
- a project with an active Writer Claim cannot pass the Writer gate.

Wave planning entry accepts only `PLANNED`. Writer entry accepts `PLANNED` or
`RUNNING`, because claim/packet dispatch may straddle the Wave start event; it
rejects `COMPLETE`, `PARTIAL`, and `SUPERSEDED`. A Writer packet is parsed again
with the complete RunPacket discriminant at the gate boundary, so a matching kind
with a Reviewer role or another malformed runtime object cannot exploit the
TypeScript type alone.

Gates return a sorted, structured issue list. They never mutate input state.

## 7. ImpactClosure

Free-text impact prose is advisory. Core authority is a content-addressed `ImpactClosure` compiled from an explicit dependency graph.

Each graph node has a stable `kind`, `ref`, and `contentHash`. Directed edges mean “a change in `from` invalidates `to`.” Changed roots include the previous and current content hashes. Core performs deterministic transitive traversal and records:

- canonical changed roots;
- all affected nodes, including roots present in the graph;
- the exact traversed edges that justify reachability;
- closure content hash over the semantic fields only.

One current node may appear as a changed root only once. Conflicting previous
hashes for the same `{kind, ref, contentHash}` are rejected as ambiguous input.

The closed node kinds for this slice are `SOURCE`, `TASK`, `CONTRACT_SNAPSHOT`, `TEST_CASE`, `VERIFICATION_PLAN`, `WAVE_MEMBER`, `RUN`, `ENVIRONMENT_INPUT`, and `COMMITSET`.

Downstream lifecycle code maps affected kinds to actions:

| Affected kind | Required action |
| --- | --- |
| `TEST_CASE` / `VERIFICATION_PLAN` | compile a new plan; old plan becomes invalid/superseded |
| `WAVE_MEMBER` | block dispatch or supersede the active Wave |
| `RUN` | old immutable packet becomes `STALE` |
| `ENVIRONMENT_INPUT` | old environment evidence cannot satisfy the gate; run again |
| `COMMITSET` | `COMPLETE -> NEEDS_REVALIDATION`; repair through `PARTIAL` only when code changes are required |

Unreachable nodes remain valid. A display ID match without an exact hash-bound dependency edge is insufficient to invalidate an object.

## 8. Change policy

- Identical semantic input produces the same cases, plan, closure, and hashes; no revalidation is needed.
- A compatible source or contract change may preserve unaffected tasks and cases, but every reachable object is revalidated against the new immutable input.
- An incompatible or unproven change creates a new plan/Wave and targeted Recovery Writer Runs; old packets remain immutable and stale.
- No evidence can cross a Revision, ContractSnapshot, TestCase, VerificationPlan, profile, command-definition, commit-tree, or environment-input hash boundary unless explicit compatibility evidence is itself included in the dependency graph.

## 9. Acceptance criteria for this slice

- TestCase and plan compilation are deterministic under input permutation.
- Every required task is covered by at least one exact case and command.
- Contract cases cannot float across Worksets, contract scopes, or snapshots.
- New Wave and Writer execution is blocked without the exact READY plan subset.
- One changed root yields only its transitive, hash-bound affected closure.
- The module is pure and does not touch `src/core/**`, Git, the filesystem, Agent sessions, or lifecycle persistence.
- Existing execution schema tests remain green.

## 10. Deferred integration

The F4 execution bridge will persist these outputs, invoke the gates before Wave dispatch and Writer claim acquisition, convert closure targets into legal lifecycle events, and expose explanations through status/doctor. Environment command execution, RED-tree reconstruction, Reviewer orchestration, Git integration, and CommitSet completion remain separate Milestone C tasks.

Before Task 5 resumes, the isolated policy handoff must also pass the adversarial
hardening matrix. Production C1-C3 services must load current objects by ref from
Core-owned storage and invoke these pure functions at the authoritative boundary;
self-consistent caller-supplied hashes are not provenance.
