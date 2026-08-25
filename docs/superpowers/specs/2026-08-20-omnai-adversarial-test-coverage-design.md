# OmnAI Adversarial Test Coverage Design

**Date:** 2026-08-20

**Status:** Approved design direction; implementation requires a dedicated plan

**Parent designs:**

- `docs/superpowers/specs/2026-08-16-omnai-v0.3-autonomous-parallel-execution-design.md`
- `docs/superpowers/specs/2026-08-19-omnai-v0.3-native-full-pipeline-fusion-design.md`
- `docs/superpowers/specs/2026-08-20-omnai-test-flow-optimization-design.md`

## 1. Goal

Make adversarial testing a required, source-traceable verification dimension in
OmnAI rather than a collection of optional negative tests. A current
VerificationPlan may become `READY` only when Core proves the exact adversarial
coverage required by the active risk policy, or records an exact policy-backed
exemption for an inapplicable scope.

This design does not add a second Writer, a security-specific execution engine,
or an Agent-owned acceptance decision. It extends the existing Test Planner,
Writer, Reviewer, deterministic verifier, integration runner, and ImpactClosure
chain.

## 2. Scope and sequencing

The current branch has the Milestone C lifecycle/Agent substrate through Task 4A
and the isolated pure verification-policy slice. F4 is not the next executable
step: it depends on stable C1-C3 services that do not yet exist. Work proceeds in
this order:

1. close the isolated verification-policy handoff with the adversarial schema,
   compiler checks, hardening tests, regression evidence, and review;
2. continue Milestone C through Task 5 -> 6 -> 7 and pass C1;
3. continue through Task 8, then Task 9 and Task 9B; both feed Task 9A, followed
   by Task 10 -> 11 and the C2 gate;
4. execute Task 12 -> 13 -> 14 -> 15 -> 15A -> 16 -> 17 and pass C3;
5. bind the verified C1-C3 services into F4, execute C4 Tasks 18-22, and certify
   the unified behavior through F5.

The public `omnai run` command remains unavailable until the existing C4 release
gate passes.

## 3. Test topology and adversarial intent are different dimensions

`TestCase.level` continues to answer **where and when the case executes**:

- `UNIT`
- `COMPONENT`
- `CONTRACT_PROVIDER`
- `CONTRACT_CONSUMER`
- `INTEGRATION`
- `E2E`

Adversarial metadata answers **how the case tries to falsify the proposed
behavior or execution authority**. It must not be added as a seventh test level.
An adversarial case can be a unit test, contract test, integration test, or E2E
test.

Vector IDs live in the immutable adversarial policy rather than in the TypeScript
schema. This lets a project or organization extend its threat model without a
code release while keeping one exact policy hash. The default policy starts with:

| Default vector ID | Required defense being exercised |
| --- | --- |
| `MALFORMED_INPUT` | strict parsing, bounded diagnostics, and no unhandled crash |
| `IDENTITY_TAMPERING` | exact ID/hash/body binding and immutable authority |
| `STALE_REPLAY` | old Revision, contract, plan, packet, evidence, or environment input cannot advance state |
| `AUTHORITY_BYPASS` | an Agent, role, or artifact cannot perform a Core-owned transition |
| `ISOLATION_ESCAPE` | paths, processes, Git state, environment resources, and secrets remain inside policy |
| `CONCURRENCY_RACE` | claims, dispatch, events, retries, and recovery remain single-owner and idempotent |
| `FAULT_INJECTION` | interruption or dependency failure converges to exact resume or safe cleanup |
| `RESOURCE_EXHAUSTION` | time, output, retry, worker, port, and environment budgets remain bounded |

Vector IDs are normalized, sorted, and resolved against the exact policy snapshot;
an ID absent from that policy fails closed. TestCase v2 separately uses a small
closed safety-property vocabulary: `REJECTED`, `SAFE_FAILURE`,
`INVARIANT_PRESERVED`, `NO_UNAUTHORIZED_EFFECT`, and `NO_CROSS_SCOPE_EFFECT`.
These values describe observable oracles rather than a permanently incomplete
threat taxonomy.

## 4. Versioned records

### 4.1 TestCase v2

The already-defined TestCase v1 remains readable. It represents ordinary coverage
only and cannot by itself satisfy a new adversarial requirement. TestCase v2 adds
an optional immutable `adversarial` object. Its presence makes the case both an
ordinary behavioral obligation and an adversarial obligation; no second copy of
the case is required:

```yaml
schemaVersion: 2
id: TC-0042
level: CONTRACT_CONSUMER
adversarial:
  threatRefs:
    - ref: policies/authorization-threat-model.yaml#stale-response
      contentHash: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
  vectorIds: [IDENTITY_TAMPERING, STALE_REPLAY]
  safetyProperties: [NO_UNAUTHORIZED_EFFECT, REJECTED]
  hypothesis: A consumer may accept a response bound to an obsolete contract snapshot
sourceRefs:
  - ref: policies/authorization-threat-model.yaml#stale-response
    contentHash: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
  - ref: quote-center/CHG-0002/REV-0003/spec.md#AC-07
    contentHash: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
scopedTasks:
  - project: quote-center
    changeId: CHG-0002
    revision: REV-0003
    baseline: BL-0001
    taskId: TASK-001
commandRefs: [quote-center.contract-consumer]
expectedOutcome: The obsolete response is rejected without a fallback authorization
contentHash: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

Rules:

- `threatRefs`, `vectorIds`, and `safetyProperties` are sorted, unique, and
  non-empty;
- every threat ref also occurs in the case's existing `sourceRefs`;
- one normalized source/threat ref cannot bind two content hashes in one current
  case;
- every vector ID exists in the exact policy snapshot;
- `hypothesis` describes the attempted violation and `safetyProperties` plus
  `expectedOutcome` define independently observable defenses;
- all new fields participate in `contentHash`;
- Agent-provided hashes are never authoritative.

The v1 compatibility adapter preserves the original v1 record and content hash as
an explicit legacy variant. It does not reinterpret or rehash it as v2. Core must
compile a genuinely new v2 case before that obligation can satisfy an adversarial
requirement; it never silently labels a legacy case adversarial.

### 4.2 AdversarialCoveragePolicy

Core resolves one immutable policy snapshot before compiling a plan:

```yaml
schemaVersion: 1
id: omnai-default-adversarial
contentHash: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
vectors:
  - id: AUTHORITY_BYPASS
    safetyProperties: [NO_UNAUTHORIZED_EFFECT, REJECTED]
  - id: CONCURRENCY_RACE
    safetyProperties: [INVARIANT_PRESERVED, NO_CROSS_SCOPE_EFFECT]
  - id: FAULT_INJECTION
    safetyProperties: [INVARIANT_PRESERVED, SAFE_FAILURE]
  - id: IDENTITY_TAMPERING
    safetyProperties: [NO_UNAUTHORIZED_EFFECT, REJECTED]
  - id: ISOLATION_ESCAPE
    safetyProperties: [NO_CROSS_SCOPE_EFFECT, NO_UNAUTHORIZED_EFFECT]
  - id: MALFORMED_INPUT
    safetyProperties: [REJECTED, SAFE_FAILURE]
  - id: RESOURCE_EXHAUSTION
    safetyProperties: [INVARIANT_PRESERVED, SAFE_FAILURE]
  - id: STALE_REPLAY
    safetyProperties: [INVARIANT_PRESERVED, REJECTED]
requirements:
  - scope: BEHAVIOR_TASK
    vectorIds: [IDENTITY_TAMPERING, MALFORMED_INPUT, STALE_REPLAY]
  - scope: AUTHORITY_BOUNDARY
    vectorIds: [AUTHORITY_BYPASS, ISOLATION_ESCAPE]
  - scope: CONCURRENT_STATE
    vectorIds: [CONCURRENCY_RACE, FAULT_INJECTION]
  - scope: BOUNDED_EXECUTION
    vectorIds: [RESOURCE_EXHAUSTION]
```

The route/risk compiler derives exact requirements for each scoped task and
contract scenario from active intent, design, Task v2 risk, contract sources, and
execution topology. The LLM may identify candidate risks, but Core applies the
exact policy and freezes the result. The policy is Core-owned configuration, not a
new lifecycle aggregate or Agent artifact.

### 4.3 AdversarialRequirement and exemption

Every derived requirement binds exactly one scoped task or contract scenario, one
policy ref/hash, and its required vector IDs. A requirement is satisfied by v2
TestCase refs whose union covers every required vector at an eligible level.

An exemption is legal only for an inapplicable vector, not because a test is hard
to write. It freezes:

- requirement identity and policy ref/hash;
- reason code from a closed policy vocabulary;
- source refs/hashes proving why the vector is inapplicable;
- explanation hash;
- Core validation result.

Agent prose, Reviewer prose, an empty case list, or a passing generic command can
never act as an exemption.

### 4.4 VerificationPlan v2

VerificationPlan v2 uses `schemaVersion: 2` and `machineVersion: 2` and adds:

- exact `adversarialPolicy` ref/hash;
- sorted `adversarialRequirements`;
- sorted `adversarialChecks` mapping each task or contract-scenario requirement
  and vector ID to exact TestCase refs and command refs;
- sorted, validated exemptions.

For a task requirement, every satisfying case must be Writer-gate eligible:
`UNIT`, `COMPONENT`, `CONTRACT_PROVIDER`, or `CONTRACT_CONSUMER`. The derived
case/command sets in `adversarialChecks` must exactly equal the matching subset in
the ordinary `projectChecks`; this prevents hidden cases, dropped commands, and a
second authority. Integration/E2E adversarial cases may add post-commit assurance,
but cannot be the only required task coverage. A contract-scenario requirement may
use an exact integration/E2E case in addition to project-gate cases.

These fields participate in the plan content hash. TestCase and VerificationPlan
use explicit v1+v2 reader unions; v2 fields are never added conditionally to a v1
hash. A persisted v1 `READY` plan remains readable for history but is not
dispatch-eligible under the current policy. Its compatibility transition may only
produce an invalid/recompile-required state and never invent threats or proof.
Recompilation produces a v2 `READY` plan whose existing refs automatically force
fresh Wave, RunPacket, environment-input, and CommitSet hashes; those record shapes
need no duplicate adversarial fields.

## 5. Coverage policy

The default policy is mandatory but risk-scaled:

1. every behavior-changing task receives at least one exact adversarial
   requirement;
2. every authority, trust, isolation, or cross-service boundary receives all
   applicable vector IDs from the current policy;
3. concurrency, recovery, and environment orchestration receive race, fault, and
   resource-budget requirements;
4. documentation-only, generated-view-only, or mechanically testless changes need
   an exact exemption;
5. every applicable ContractSnapshot business scenario has normal, boundary,
   failure, retry, compatibility, and adversarial coverage as selected by policy;
6. one case may cover multiple vectors, but a generic suite command without
   per-case evidence covers none;
7. `SKIPPED` and `INCONCLUSIVE` never satisfy required adversarial coverage.

This guarantees adversarial testing without forcing every low-risk task to run the
same expensive E2E attack suite.

## 6. Authority and Agent responsibilities

### PROJECT_TEST_PLANNER

- runs as a separate read-only child Run per affected project;
- proposes functional and adversarial TestCases from exact sources and policy;
- may identify additional vector candidates for Core policy evaluation;
- cannot write project code, approve an exemption, declare a plan ready, or accept
  evidence.

### PROJECT_WRITER / RECOVERY_WRITER

- remains the only write-capable Agent for one repository;
- implements both test code and production code under one Writer Claim;
- must produce behavioral RED for applicable new functional and adversarial cases,
  then GREEN on the final verified tree;
- cannot modify the frozen policy, requirement, plan, case identity, or evidence
  acceptance rule.

### PROJECT_REVIEWER

- is a separate read-only child Run using a different session;
- attempts to falsify the implementation and tests against the frozen attack
  hypotheses;
- checks for tautological assertions, bypassed code paths, incorrect test-only
  trees, untested permission expansion, and missing observable defenses;
- produces findings only. It cannot edit code or accept its own finding.

### Core and deterministic runners

- Core resolves policy, validates proposals, compiles plans, evaluates gates,
  reconstructs exact trees, accepts evidence, and changes lifecycle state;
- deterministic project and environment runners execute exact command definitions;
- fault injection and resource budgets are runner capabilities, not Agent shell
  freedom;
- no adversarial test may request destructive access outside disposable,
  Core-owned resources.

### Authoritative admission boundary

Content hashes prove identity, not provenance. A caller that can construct a
self-consistent object can also calculate its SHA-256 hash, so production gates
must not accept caller-supplied plan/case/Wave bodies as authority.

The C1-C3 service boundary accepts refs, then under the existing mutation lock:

1. loads and strictly parses the current Workset, exact Task/Revision/Baseline,
   sources, contract snapshots, policy, TestCases, plan, Wave, packet, Run, and
   Claim from Core-owned storage;
2. derives the invalidation generation and ImpactClosure from those current
   records rather than accepting `invalidatedTasks: []` from a caller;
3. recomputes packet content hash over every execution-relevant field and compares
   it with the persisted packet/Run identity;
4. resolves every command ref to a hash-pinned executable/argv definition and
   requires the packet's verification commands to equal that exact set;
5. normalizes worktrees and project-relative allowed paths, rejects traversal and
   symlink escape, and derives least-privilege filesystem/network policy in Core;
6. binds Writer kind, agent ID/protocol, starting Git identity, and recovery
   authority to the persisted Wave member and atomic Claim;
7. invokes the pure case/plan/Wave/Writer policy functions only after those facts
   have been resolved.

Parsing and equality checks remain valuable defense in depth, but they are not a
substitute for authoritative loading or transactional Claim acquisition.

## 7. Automated flow

```text
active intent/design/task/contract/policy hashes
                    |
                    v
       derive exact adversarial requirements
                    |
                    v
 read-only Test Planner proposes v2 TestCases
                    |
                    v
  Core validates sources, hypotheses, oracles,
         vector IDs, commands, and coverage
                    |
                    v
 VerificationPlan v2 READY + exact policy/case refs
                    |
                    v
 Wave gate -> Writer packet -> Writer test/code result
                    |
                    v
 independent adversarial review -> Core testOnlyTree RED
                    |
                    v
           Core final verifiedTree GREEN
                    |
                    v
 exact CommitSet integration/E2E/fault execution
                    |
                    v
 case-addressed evidence -> COMPLETE
```

If Reviewer findings reveal an uncovered vector, Core invalidates the
plan, derives a new requirement, and creates a new immutable plan/Wave. The
Reviewer does not append an untracked test obligation directly to a running
packet.

## 8. Change and replay behavior

The dependency graph includes policy/threat sources, adversarial requirements, v2
TestCases, plan coverage, command definitions, permission policy, packet content,
and evidence input tuples. Policy and threat documents use the existing `SOURCE`
node kind, so this feature adds no aggregate or side ledger. Core constructs graph
edges from authoritative records; Agent-supplied or display-ID-only edges are
advisory and cannot remove a dependency.

The persisted closure validates that every affected node is reachable from a root
through its recorded traversed edges and that every edge endpoint is present. The
authoritative graph builder, not the self-hash of a submitted closure, proves graph
completeness. Lifecycle effects remain existing Run/Wave/CommitSet events carrying
the closure hash and affected refs.

Any reachable hash change triggers exact ImpactClosure actions:

- policy or risk-source change: recompute requirements and recompile the plan;
- hypothesis, safety oracle, vector, case, or command change: recompile
  the plan and block/supersede affected Waves;
- packet, permission, Revision, contract, or plan drift: mark the old Run stale;
- commit tree, environment input, executor, fault profile, or resource-policy
  change: require an exact rerun;
- completed CommitSet reached by the closure: enter `NEEDS_REVALIDATION`.

An old PASS cannot cross any of these hash boundaries. Compatible changes may
preserve unreachable cases and evidence; display-ID equality alone proves
nothing.

## 9. Fail-closed errors

Policy and gate functions return stable domain codes. At minimum:

| Code | Meaning |
| --- | --- |
| `ADVERSARIAL_POLICY_MISSING` | no exact current policy snapshot is available |
| `ADVERSARIAL_POLICY_STALE` | the plan binds an obsolete policy hash |
| `ADVERSARIAL_CASE_INVALID` | adversarial metadata is missing, contradictory, malformed, or unhashed |
| `ADVERSARIAL_COVERAGE_MISSING` | a required vector has no eligible exact case |
| `ADVERSARIAL_EXEMPTION_INVALID` | an exemption lacks exact policy/source authority |
| `ADVERSARIAL_EVIDENCE_UNSATISFIED` | a required case skipped, was inconclusive, or lacks exact evidence |
| `PACKET_CONTENT_HASH_MISMATCH` | RunPacket content no longer matches its frozen identity |
| `PACKET_VERIFICATION_COMMAND_MISMATCH` | executable verification commands drift from the plan/member subset |
| `IMPACT_CLOSURE_SEMANTIC_MISMATCH` | affected nodes cannot be justified by roots and traversed edges |

Malformed runtime values return structured failure and never leak raw TypeError or
Zod diagnostics as orchestration contracts.

## 10. OmnAI's own adversarial regression suite

Every Milestone C implementation task must add at least one positive behavior test
and a table-driven adversarial mutation group. The initial verification hardening
suite covers:

1. malformed objects, unknown discriminants, duplicate refs, and conflicting
   logical identities;
2. body/ref/hash forgery and coherent stale replay;
3. role confusion and attempts to perform Core-only transitions;
4. command, permission, allowed-path, filesystem-root, and network-policy drift;
5. duplicate Wave members, competing Claims, replayed dispatch, and reordered
   events;
6. semantically forged ImpactClosures, cycles, dangling edges, and unreachable
   affected nodes;
7. interruption after every durable boundary and dependency failure at every
   external adapter;
8. timeout, output, retry, worker, port, and resource-ownership exhaustion.

Tests use real parsers, compilers, temporary Git repositories, and disposable
process/resources. Fake Agents simulate only the external Agent boundary; tests do
not assert on mocks. Every adversarial test names the production mutation it would
catch and uses independently derived literal expectations.

Ordinary CI uses deterministic fixtures and a fixed mutation corpus. C4 adds
fault-injection and packaged/live certification; authenticated credentials and
real Compose are release gates, not ordinary unit-test prerequisites.

## 11. Milestone integration

Adversarial requirements are threaded through the existing plan rather than added
as a competing phase:

- **Task 5:** packet hash, permission, command, secret, path, and snapshot attacks;
- **Task 6:** malformed ACP events, capability lies, cancellation, replay, and
  unexpected exits;
- **Task 7:** malicious Fake Agent modes, immutable handoffs, restart and duplicate
  dispatch;
- **Tasks 8-9:** contract/source forgery, unsafe validators, planner/critic role
  confusion, prompt/artifact poisoning, stale compatibility, and cross-project
  dependency injection;
- **Task 9B:** Compose/command/external escape, secret leakage, digest drift, and
  resource ownership;
- **Task 9A:** v2 TestCases, policy resolution, mandatory coverage, persistence,
  invalidation, and Test Planner orchestration after Task 9 and Task 9B inputs
  exist;
- **Tasks 10-11:** exact change closure, stale-evidence rejection, and explicit
  rejection of cross-project implementation dependencies;
- **Tasks 12-17:** Wave/Claim races, packet/member drift, Writer/Reviewer
  impersonation, Git/path escape, evidence forgery, bounded recovery, and restart;
- **F4:** binds only already-verified C1-C3 services into the unified Flow/Reconcile
  source set and event lifecycle;
- **Tasks 18-22 and F5:** diagnostics, full fault injection, golden multi-service
  attacks, package integrity, real adapters, and release certification.

## 12. Acceptance criteria

- Test topology and adversarial purpose remain independent dimensions.
- Every behavior-changing scope has policy-derived adversarial coverage or an exact
  validated exemption.
- A plan missing one required vector cannot become `READY`.
- TestCase v1 and VerificationPlan v1 remain readable but cannot be silently
  upgraded or satisfy new adversarial requirements.
- Planner, Writer, Reviewer, Core, and runner authority remains separated.
- No second Writer, test ledger, scheduler, or execution engine is introduced.
- Required adversarial cases prove RED/GREEN where meaningful and produce
  case-addressed evidence; skipped or inconclusive outcomes fail the gate.
- Policy, case, command, packet, permission, environment, or evidence drift causes
  precise invalidation and cannot reuse an old PASS.
- The initial attack matrix and all affected regression tests pass before Milestone
  C Task 5 resumes.
- F4 begins only after the existing C1-C3 gates pass.
