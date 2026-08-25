# Task 7 Implementation Report

## Scope

- Base: `d47c967ab80f5867a0ff8897f9a67ab4eaaf2cc7`
- Commit: `db87461` (`feat: bind protocols to adaptive flow`)
- Kept the closed protocol catalog and exactly four Host Skills; no protocol ID, capability, Skill, schema, or runtime command was added.

## TDD and skill-document TDD evidence

### RED

Before changing protocols, Skills, or `prepareStage`, `test/flow-protocols.test.ts` was added and run with the established explicit `/dev/shm` sandbox environment:

```text
npm run build
node --test dist/test/flow-protocols.test.js
```

Result: `0/7` passed. The seven failures independently exposed the intended old behavior:

- Grill/Brainstorm and repository protocols still had their old versions and artifact-authoring contracts;
- prepared runs omitted FlowPlan and DecisionRecord context;
- legacy Decisions were omitted when `flow.yaml` was absent;
- malformed Flow and Decision files did not fail before Run/progress/readiness side effects;
- the four Host Skills did not carry the exact fresh route tuple or revalidate it before mutation.

The prior no-guidance pressure run supplied by the controller also showed the concrete Skill failures used to shape the new positive recipes: stale routes were reused, Grill/Brainstorm wrote selections to capability artifacts instead of `omnai decision resolve`, and Reconcile manually selected `repository.reconcile` without a fresh route.

### GREEN / focused regression

Final focused command built the repository and ran Task 7 plus the complete protocol, Skill, inventory, module-boundary, CLI, Scenario, and Workset protocol contract surface under a fresh `/dev/shm` environment.

Result: `54/54` passed; zero failures, skips, or cancellations.

### Full regression

Final `npm test` used a separately pre-created `/dev/shm` `TMPDIR`, HOME, USERPROFILE, and npm cache and exited `0`. A compact reporter count over the same 72 compiled test files confirmed `455/455` passed.

The only output noise was the pre-existing npm warning for the sandbox-provided `http-proxy` setting.

## Delivered behavior

- `interaction.grill@2` consumes the first routed blocking HUMAN DecisionRecord, researches recoverable facts, asks one bounded question, and resolves the exact record through Core.
- `interaction.brainstorm@2` consumes one routed SOLUTION/ARCHITECTURE DecisionRecord with at least two VIABLE options, compares common criteria, and resolves that exact record through Core without creating another Spec.
- `repository.map@2`, `repository.model@2`, `repository.design@3`, `repository.plan@3`, and `repository.reconcile@3` use stable `DEC-*` authority while preserving existing module-boundary, project-local DAG, contract-only cross-project, L0-L5, and lineage contracts.
- `prepareStage` validates the active FlowPlan and all sorted DecisionRecords before creating a Run, progress event, or readiness mutation. It appends them after ordinary context under the required Core-owned read-only notice. A missing legacy Flow remains valid; malformed Flow or Decision state fails before side effects. FlowPlan and DecisionRecord remain absent from capability outputs.
- All four thin Host Skills take a fresh route, load only ordered `protocolIds`, retain repository `decisionIds`/Revision/Baseline/`flowHash`, exact-compare route identity before a Core mutation, execute one bounded action, and route again. Pure Workset routes retain their own action/project/Re-entry identity contract; Show-me, Workset, and Reconcile safety rules remain intact.

## Plan-driven expectation updates

Version bumps required exact updates to existing audit/packaging expectations without weakening their assertions:

- `test/protocol-stage-integration.test.ts`: rendered Design protocol `@2` to `@3`;
- `test/module-boundary-protocol.test.ts`: Design manifest version `2` to `3`;
- `test/protocol-cli.test.ts`: CLI-rendered Design protocol `@2` to `@3`;
- `test/workset-protocol-routing.test.ts`: Grill/Brainstorm versions `1` to `2`, with every Workset protocol still exactly `1`.

The existing `return control to Core routing` output-contract wording was retained and extended with fresh Flow/Decision adaptive selection.

## Files

- Modified seven canonical protocol resources listed in the Task brief.
- Modified `src/core/stages.ts`.
- Modified the four canonical Host `SKILL.md` files.
- Added `test/flow-protocols.test.ts`.
- Updated the four exact version expectation tests listed above.

## Risks and open items

- Prepared prompts are larger because each capability Run now carries the complete validated FlowPlan and Decision inventory; this is intentional authority context and scales with the number of Decisions.
- Pure Workset routes do not expose repository Revision/Baseline/Flow fields; their Skills therefore compare the exact Workset action identifiers and enter repository route semantics only for a Workset-project route.
- No unresolved Task 7 implementation item or blocker remains.

---

## Fix review round 1 (2026-08-20)

### Review base and commit

- Review base: `db874613165825066a5898ed20ce485ec366c41e`
- Fix commit: `acec6931c977e2bae2d3dcb2e8557778b2b6e98f`

### Root-cause verification and RED

The Critical was reproduced end to end before implementation: resolving a routed blocking Decision against
`READY` authority moved the route from `repository.reconcile` directly to the next capability while leaving
Revision `REV-0001`, Baseline `BL-0001`, and the settled readiness unchanged.

Focused RED regressions then isolated each review finding:

- settled-authority resolution failed because `REV-0002.yaml` did not exist (`11/12` Decision tests passed);
- Flow/Decision inventory mismatch and stale live Decision state were accepted, and `prepareStage` did not wait
  for the exact Change lock (`7/10` Flow protocol tests passed);
- ordinary Reconcile did not create `REV-0001.flow.yaml` (`5/6` Reconcile tests passed);
- a real Grill WRE loaded an interaction protocol that unconditionally required a Project DecisionRecord
  (`6/7` Workset router tests passed);
- the first closure implementation invalidated only `domain`; the downstream `spec`/`design`/`plan` and Task
  dependency closure regression remained RED;
- after the first of two settled-authority Decisions resolved, the second still referenced `REV-0001`, proving
  the initial transaction could deadlock the fresh route.

### Delivered fixes

- Added a private, strict, durable Decision-Reconcile journal. Existing
  `omnai decision resolve <decision> <resolution-file> ... --json` detects settled authority and becomes the
  guarded transaction entry: it freezes Flow/Decision/Task inputs, archives the old FlowPlan, advances exactly
  one Revision and Baseline, applies the canonical L-level readiness closure and frozen dependent Task closure,
  rebinds Flow and remaining live Decisions, then records the resolution.
- Interrupted transactions remain fail-closed. A real subprocess crash after metadata save and before Flow
  rebind leaves routing and public Flow mutation fenced; an exact retry recovers the correlated signal,
  Revision, archive, rebind, Decision audit, Reconcile audit, and terminal journal without duplicate history.
- Split lower Decision persistence into `src/core/decision-store.ts`; Reconcile depends on that lower store and
  `flow-store`, while the upper Decision orchestration depends on Reconcile. The former
  `decisions.ts`/`reconcile-internal.ts` ESM cycle is absent and guarded by a module-direction regression.
- `prepareStage` now holds the exact Change mutation lock and both transaction fences across active-metadata
  CAS, semantic Flow/Decision validation, inventory/live-revision checks, immutable YAML rendering, Run and
  progress creation, and readiness mutation. Prompt bytes come from the validated objects, not later raw reads.
- Every ordinary Reconcile atomically and idempotently writes or verifies the exact prior
  `revisions/<REV>.flow.yaml` before mutation; Flow assessment transactions validate the same archive rather
  than overwriting it.
- Grill and Brainstorm retain their canonical repository Decision mode and add an explicit Workset Re-entry
  mode keyed by the current `WRE-*` and ordered bundle. WRE mode neither requires nor fabricates a Project
  DecisionRecord and returns to Workset routing.
- The `omnai` and `omnai-reconcile` Skills now name the executable guarded entry command while distinguishing
  it from an unsafe standalone same-Revision resolve on a `repository.reconcile` route.

### Verification

All verification used explicit, pre-created `/dev/shm` HOME, USERPROFILE, TMPDIR, and npm cache paths.

- Decision/Core/Flow/Reconcile focused batch: `62/62` passed.
- Expanded protocol, Skill, router, Flow transaction, module-boundary, inventory, and Workset batch:
  `133/133` passed.
- `npm run typecheck`: exit `0`.
- `git diff --check`: exit `0`.
- Full `npm test`: exit `0`; `464/464` passed, zero failures, skips, or cancellations in `48.6s`.

### Files and scope expansion

In addition to the original Task 7 files, the controller-approved repair changed the smallest Core and behavior
surface needed for an actual transaction and WRE contract: Decision persistence/orchestration, Flow mutation
fences, Reconcile internals, router fencing, and focused Decision/Reconcile/Workset behavior tests. No Host Skill,
protocol ID, capability, CLI command, package dependency, or `src/execution/**` file was added.

### Remaining risks and open items

- The journal and audit make live Decision rebinding recoverable and verifiable, but this adds two internal
  structured files/modules whose compatibility is protected by tests rather than a public schema version promise.
- Prepared prompts still grow with the full Decision inventory, as recorded in the original Task 7 risk.
- No known review finding remains open.

---

## Fix review round 2 (2026-08-20)

### Review base and commit

- Review base: `acec6931c977e2bae2d3dcb2e8557778b2b6e98f`
- Fix commit: `60c5a6a59e72f916a1e5e70bd05071bb74739708` (`fix: close adaptive flow transaction races`)

### Root-cause verification and RED

The five findings were traced through the real Core and CLI mutation paths before implementation. The first
compiled focused run covered `decisions`, `stages`, `flow-cli`, and `flow-store`: `75` tests ran, `66` passed,
and `9` failed for the intended old behavior. The failures proved that early Flow journals admitted Decision
mutation, terminal recovery accepted unproven audits, task-save crash injection did not exist, semantic level
could mask an earlier affected readiness, `stage --complete` and `work` mutated through pending Decision
journals, stale stage handles overwrote active metadata, and Flow reassessment overwrote a conflicting archive.

The final contract set also covers both journal directions, exact terminal audit cardinality and bindings for
`RECONCILE_APPLIED` and `FLOW_REASSESSED`, terminal ordinary open/resolve compatibility, strict rejection before
a Decision-Reconcile journal, frozen readiness/task conflict recovery, and repeated task-save recovery.

### Finding to regression to fix

1. **Dual PENDING journals and terminal compatibility**
   - Regressions: `an early pending Flow transaction fences every Decision mutation...`, `a pending Decision
     transaction fences Flow journal creation...`, `only an exact audited Flow terminal-recovery phase...`, and
     `an exact terminal Flow recovery permits ordinary Decision writes but cannot start Decision Reconcile`.
   - Fix: every Decision mutation checks Flow state inside the exact Change lock. Early PENDING Flow phases are
     exclusive. Only a read-only, exact accepted Revision/Baseline/input binding plus one correlated signal,
     Revision, Reconcile audit, and Flow audit permits newer ordinary Decision state. Any resolution requiring
     Reconcile performs a strict Flow fence immediately before Decision journal creation. Flow assessment keeps
     the symmetric Decision fence, so two PENDING journals cannot be created.

2. **Public stage/task/readiness mutation bypass and stale metadata**
   - Regressions: real `spec --complete` and `work TASK-001` subprocess tests, pending-Decision `completeStage`,
     stale Revision/Baseline `completeStage`, and frozen readiness/task inventory conflict recovery.
   - Fix: `withGuardedChangeMutation` owns Change lock acquisition, dual journal fences, and active
     Revision/Baseline CAS. `completeStage` and public readiness mutation use it. All Work task status, readiness,
     and audit writes are now performed by one minimal Core task-mutation entry instead of CLI-local writes.
     Decision recovery exact-compares the frozen readiness and TaskFile targets before finalization.

3. **Task invalidation drift after task save and before metadata save**
   - Regression: `task invalidation is exact across a crash after task save and repeated Decision recovery` uses
     the `FLOW_RECONCILE_TASKS_SAVED` crash seam and retries more than once.
   - Fix: the Decision journal freezes the complete pre-transaction readiness and TaskFile. Reconcile derives one
     immutable task target from that snapshot; recovery accepts only the frozen source or exact target and never
     re-invalidates a previously invalidated status. Contradictory task state fails closed.

4. **Semantic Decision kind masking an earlier affected capability**
   - Regression: parameterized DOMAIN-to-research plus SOLUTION/ARCHITECTURE-to-spec/model cases verify the
     resulting level, affected readiness, invalidation, and fresh route.
   - Fix: Core selects the earliest level across both Decision-kind semantics and every affected readiness. Before
     journal creation and on recovery, the canonical level/closure and frozen task closure are recomputed and
     exact-compared; every settled route trigger must be inside the legal closure.

5. **Mutable Flow reassessment archive**
   - Regression: `reassessment rejects a conflicting immutable Flow archive before journal or lineage side
     effects` compares metadata, current Flow bytes/hash, progress bytes, archive bytes/hash, and the complete
     revision-directory inventory before and after rejection.
   - Fix: ordinary Reconcile and Flow assessment share one lock-owned immutable archive helper. An existing
     archive is schema-validated and hash-compared; identical bytes are idempotent and conflicting lineage fails
     before journal, signal, Revision, Flow, metadata, or audit mutation.

### Verification

All commands used fresh, explicitly created `/dev/shm` HOME, USERPROFILE, TMPDIR, and npm cache directories.

- Final Task 7 focused build and behavior batch: `78/78` passed in `18.2s`.
- Expanded Core/router/Reconcile/Task batch: `76/76` passed.
- Expanded protocol/Skill/package-contract batch: `66/66` passed.
- `npm run typecheck`: exit `0`.
- `git diff --check`: exit `0`.
- Final full `npm test`: exit `0`; `476/476` passed, zero failures, skips, or cancellations in `60.5s`.
- Output noise remained limited to the pre-existing npm warning for the sandbox-provided `http-proxy` setting.

### Files and scope

- Added internal Core helpers: `src/core/flow-archive.ts`, `src/core/guarded-change-mutation.ts`, and
  `src/core/task-mutations.ts`.
- Updated Decision/Flow journals and orchestration, Reconcile internals, stage/readiness mutation, and the Work
  CLI adapter in `src/core/decision-reconcile-transaction.ts`, `src/core/decisions.ts`,
  `src/core/flow-assessment.ts`, `src/core/flow-transaction.ts`, `src/core/reconcile-internal.ts`,
  `src/core/stages.ts`, `src/core/store.ts`, and `src/cli.ts`.
- Added behavior regressions in `test/decisions.test.ts`, `test/stages.test.ts`, `test/flow-cli.test.ts`, and
  `test/flow-store.test.ts`.
- No CLI command, Host Skill, protocol ID, capability, package dependency, or `src/execution/**` file was added.

### Remaining risks and open items

- Decision-Reconcile journals now retain complete readiness and TaskFile snapshots. This intentionally increases
  an internal journal in proportion to one Change's task graph so recovery can be exact and self-contained.
- The terminal Flow predicate deliberately allows ordinary same-Revision Decision history only after exact
  correlated success authority exists; stage, task, readiness, Flow, and Reconcile mutations remain strictly
  fenced until the Flow journal is terminally recovered.
- No round-2 Critical or Important finding remains open.

---

## Fix review round 3 (2026-08-20)

### Review base and commit

- Review base: `60c5a6a59e72f916a1e5e70bd05071bb74739708`
- Fix commit: `5ee0197c9d646dc5ef2f297b3c0d70db6200445f`
  (`fix: make reconcile lineage durably recoverable`)

### Root-cause verification and RED

Each review finding was reproduced through a real revision-advancing path before its implementation changed:

- normal ordinary and Flow Reconcile left live `OPEN`/`BLOCKED` Decisions on the source Revision, so fresh
  route, resolve, supersede, and prepare operations failed as stale after a successful Reconcile;
- ordinary Reconcile had no durable recovery intent, and Flow/Decision archive ordering admitted crash windows
  in which an archive could exist without the journal that fenced later mutation;
- terminal Flow recovery accepted insufficient authority: correlated Revision cardinality, current Flow
  existence, accepted Decision inventory, canonical input hash, and exact accepted-plan identity were not all
  proven before a late Decision write;
- the lock-owned readiness primitive remained reachable from the public package barrel and generated
  declarations;
- crash recovery after metadata save and a partial Decision rebind could not distinguish frozen source,
  deterministic target, and contradictory third state.

The first round-3 behavior groups failed for the intended causes: three normal/public lineage tests failed,
six shared transaction/terminal tests failed, and the first nine ordinary-transaction tests passed seven and
failed two. Additional one-at-a-time RED regressions proved that deleting an accepted Decision from otherwise
canonical terminal Flow state was accepted, historical external-correlation reuse wrote durable state before
failing, and an active caller with the same correlation-free request was incorrectly treated as a permanent
retry. The first fresh full run made the remaining integration impact explicit: `487/493` passed. Its six
failures were the three obsolete pre-round-3 stale-Decision expectations plus real reclassification snapshot
aliasing and two Workset replan regressions.

### Finding to regression to fix

1. **Live Decision lineage across every Revision-advancing Reconcile**
   - Regressions cover ordinary normal/recovery, Flow normal/recovery, Decision-Reconcile with only its target
     excluded, metadata-saved partial Decision-rebind recovery, exact audit cardinality, and fresh
     route/resolve/supersede/prepare behavior.
   - `rebindLiveDecisionsWithinChangeLock` accepts each frozen live Decision only at its exact source or
     deterministic target Revision. A third state fails closed. Every rebound has exactly one
     `DECISION_REBOUND` audit bound to the source/target Revision, target Baseline, transaction correlation,
     Revision timestamp, detail, and data. Flow compilation consumes the rebound inventory, never the stale
     source inventory.
   - The controller-approved adaptive-router expectation update now verifies normal ordinary Reconcile rebind
     and routing for blocking `OPEN`, non-blocking `OPEN`, and non-blocking `BLOCKED` Decisions. Existing tests
     that manually create or tamper a truly stale Decision continue to require `DECISION_STALE_REVISION`.

2. **Durable archive ordering and ordinary recovery**
   - Archive handling is split into a read-only compatibility preflight and an idempotent ensure-write. A
     conflicting archive fails before journal, signal, Revision, metadata, Flow, audit, or directory inventory
     mutation.
   - Ordinary Reconcile now freezes request, source metadata, Flow, ordered Decisions, readiness, TaskFile,
     task roots/closure, correlation, and timestamp in
     `revisions/<source>.reconcile-transaction.yaml`. The PENDING intent is durable before archive creation.
     All public route, prepare, stage, work, readiness, Decision, Flow, migration, and Reconcile mutation paths
     recognize the ordinary fence; only recovery under its exact correlation may proceed.
   - A correlation-free completed retry is identified by the caller still carrying the frozen source
     Revision/Baseline. The same request from a fresh active caller is a new command and advances another
     Revision. Explicit external correlations remain exact idempotency keys. All frozen transaction inputs are
     explicitly deep-cloned, preventing completed-state validation from overwriting an in-flight scenario
     reclassification profile.

3. **Exact terminal Flow authority**
   - The terminal validator scans all Revision and signal files and requires exactly one correctly named and
     bound correlated Revision and one canonical signal. It derives changed assessment fields, level,
     readiness closure, reason, and accepted plan semantics rather than trusting journal claims.
   - Active `flow.yaml` must exist and bind the active Change Revision/Baseline, current Decision inventory,
     accepted assessment, and recomputed input hash. Before any legal late ordinary Decision state, its complete
     plan hash must equal the accepted plan. Later ordinary Decision state is allowed only when its exact audit
     lineage explains the current canonical inventory; deletion of accepted Decision lineage fails closed.
   - Regressions cover duplicate correlated Revisions, missing active Flow, assessment/inventory/input/hash
     conflicts, accepted Decision deletion, positive terminal ordinary open/resolve, and strict rejection of a
     settled-authority resolve before a second journal.

4. **Internal-only lock-owned readiness mutation**
   - `markReadinessWithinChangeLock` moved to `readiness-mutation-internal.ts`. `store.ts` exposes only guarded
     `markReadiness`; stage and task internals import the lower primitive directly.
   - The regression imports `dist/src/index.js` and checks both `dist/src/index.d.ts` and
     `dist/src/core/store.d.ts`, proving the lower primitive is absent from runtime and generated declaration
     surfaces without introducing a reverse runtime dependency.

### Persisted phases and recovery entries

```text
ordinary Reconcile
  exact Change lock + Flow/Decision/ordinary fences
  -> immutable archive compatibility preflight
  -> PENDING ordinary intent (fence is now durable)
  -> ensure old Flow archive
  -> signal -> Revision -> task/readiness + metadata
  -> exact live Decision rebind -> Flow rebind -> audits
  -> COMPLETED ordinary intent
  recovery entry: the same reconcile request; source/target/third-state checks at every durable phase

Flow reassessment
  exact Change lock + Decision/ordinary fences
  -> immutable archive compatibility preflight
  -> PENDING Flow journal -> ensure old Flow archive
  -> signal -> Revision -> metadata -> exact live Decision rebind
  -> accepted Flow -> Reconcile/Flow audits -> terminal journal
  recovery entry: the same flow assessment; terminal late-Decision allowance requires full read-only proof

Decision-Reconcile
  exact Change lock + Flow/ordinary fences
  -> immutable archive compatibility preflight
  -> PENDING Decision journal -> ensure old Flow archive
  -> signal -> Revision -> task/readiness + metadata
  -> exact non-target live Decision rebind -> Flow rebind
  -> resolve target -> audits -> terminal journal
  recovery entry: the same `omnai decision resolve` request
```

The dependency direction remains public Reconcile entry -> ordinary orchestration -> recovery/terminal helpers;
the recovery module imports the orchestration result as a type only. Decision storage does not import Reconcile.

### Verification

Fresh, explicitly pre-created `/dev/shm` temporary and cache directories were used for the final behavior runs.

- Six full-suite regressions plus their surrounding adaptive/router/reclassify/Workset surface: `47/47`
  passed after the caller-identity and snapshot fix.
- Expanded Decision/Flow/Reconcile/router/reclassify/Workset batch: `120/120` passed in `16.42s`.
- Final full `npm test`: exit `0`; `495/495` passed, with zero failures, skips, or cancellations in `39.06s`.
- `npm run typecheck`: exit `0`.
- Runtime and declaration export checks: lock-owned readiness mutation absent from all three public surfaces.
- `git diff --check`: exit `0`.

The environment rejected direct startup of `npm pack --dry-run` before npm executed: normal, offline, and
ignore-scripts invocations were classified as requiring an unavailable sandbox approval. This is an environment
verification blocker, not a package failure. The full suite's actual npm-package inventory test passed and
verified all canonical protocols and exactly four Host Skill files. A direct dry run remains a handoff check for
an environment that permits the command.

### Files and scope

- Added internal transaction/validation modules: `src/core/flow-terminal-authority.ts`,
  `src/core/ordinary-reconcile-transaction.ts`, `src/core/ordinary-reconcile-orchestration.ts`,
  `src/core/ordinary-reconcile-recovery.ts`, `src/core/reconcile-semantics.ts`, and
  `src/core/readiness-mutation-internal.ts`.
- Updated Decision storage/orchestration, Flow archive/store/assessment/transaction/migration, Reconcile entry
  and internals, guarded mutation, routing, stage/task/readiness mutation in `src/core/**`.
- Added or expanded behavior regressions in `test/decisions.test.ts`, `test/flow-store.test.ts`,
  `test/reconcile.test.ts`, and `test/adaptive-router.test.ts`.
- No CLI command, Host Skill, protocol ID, capability, package dependency, public low-level mutation API, or
  `src/execution/**` file was added.

### Remaining risks and open items

- Ordinary journals intentionally freeze the complete Decision and Task inventory. Their internal size grows
  with one Change's decision/task graph in exchange for deterministic recovery.
- Terminal validation scans the revision directory to prove correlation cardinality. This is fail-closed and
  bounded by one Change's lineage, but its cost grows linearly with that history.
- No round-3 product finding remains open. Direct `npm pack --dry-run` remains blocked only by this execution
  environment as described above.

---

## Fix review round 4 (2026-08-20)

### Review base and change set

- Review base: `5ee0197c9d646dc5ef2f297b3c0d70db6200445f`.
- Fix commit: this round-4 commit (`fix: guard task 7 mutation lineage`).
- The round is limited to Task 7 Core/CLI behavior, its focused regressions, expectation updates required by the
  stricter fail-closed contracts, and this report. No merge, push, publish, new command, protocol, capability,
  dependency, Host Skill, or `src/execution/**` change is part of the fix.

### Root causes and RED evidence

Every implementation change followed a public API, real CLI, crash, or durable-corruption regression that
failed for the intended old behavior:

- public `saveChange` wrote metadata without the Change lock or transaction fences, and real `archive --force`
  split status and audit into separate unguarded writes;
- explicit ordinary task scope normalized away duplicates and trusted caller closure membership/order instead
  of validating the frozen TaskFile's canonical dependent closure before the archive and intent;
- package Flow synchronization/rebind exports delegated directly to lock-owned helpers and trusted caller
  Decision arrays;
- ordinary Reconcile refreshed callers made stale by a completed Flow or Decision Reconcile and could silently
  advance a second time;
- completed journals were used only by their owning recovery path, so unrelated mutations did not detect
  filename/content, target, hash, audit, and cardinality corruption;
- late Decision validation explained only Flow-relevant inventory identity, not a canonical record transition,
  allowing immutable fields such as question, options, owner, affects, and sourceRefs to escape;
- ordinary recovery generated fresh timestamps after the durable intent.

The initial round-4 focused groups were RED on the old code for all seven causes. Additional one-at-a-time RED
tests proved a non-canonical root order was accepted, forged Decision `afterHash` data could hide a question
edit, an ordinary terminal target lacked frozen hashes, a completed ordinary terminal allowed an unexplained
late Decision edit, and a malformed `*.reconcile-transaction.yaml` filename was ignored. The last filename RED
failed with `Missing expected rejection`; the suffix-wide fail-closed scan made it GREEN without changing valid
recovery.

### Finding to RED to fix

1. **Guarded metadata persistence and atomic archive semantics**
   - `persistChangeMetadataWithinChangeLock` moved to `change-metadata-internal.ts`, which is not exported by the
     package barrel. Internal lock owners use that primitive and no longer re-enter a public lock-taking API.
   - Public `saveChange` takes the exact Change lock, performs completed-lineage plus Flow, Decision, and ordinary
     fences, proves Change/Revision/Baseline and `updatedAt` CAS, and only then persists.
   - Public Core `archiveChange` performs status transition and the single deterministic `CHANGE_ARCHIVED` audit
     in one guarded lock. It recovers a metadata-before-audit crash idempotently and rejects duplicate or
     conflicting audit state before another write. The existing real `archive --force` command delegates to it;
     no CLI command was added.

2. **Canonical ordinary explicit task closure before durable state**
   - `validateCanonicalTaskClosure` operates on the frozen `TaskFile` before archive preflight and journal write.
     It requires known and unique roots/members, inclusion of every root, canonical TaskFile ordering for roots
     and closure, and exact equality with the roots' canonical dependent closure.
   - The target `TaskFile` mutation is precomputed while the request is still read-only. Real WRE-shaped missing,
     unknown, extra, duplicate, and non-canonical closures now fail with a byte-for-byte/directory snapshot
     unchanged. Valid inferred and explicit closure recovery remains deterministic.

3. **Guarded public Flow wrappers and current Decision inventory**
   - `synchronizeFlowDecisions` and `rebindFlowPlanForRevision`, together with create/migrate, now take the exact
     Change lock, run completed-lineage and all three transaction fences, read the real current Decision inventory
     inside that lock, and reject a caller-stale snapshot.
   - Lock-owned Flow helpers moved to `flow-store-internal.ts`; `flow-store.ts`, the runtime barrel, and generated
     declarations expose only guarded public functions. `decision-inventory.ts` is the read-only lower module that
     keeps the dependency graph acyclic.
   - Focused snapshots prove zero directory/byte changes for Flow, Decision-Reconcile, and ordinary PENDING intent
     fences and for both stale-inventory wrappers.

4. **Ordinary stale-caller CAS**
   - Ordinary source resolution now requires the caller's Change/Revision/Baseline to equal persisted authority.
     The only revision mismatch admitted is an exact completed ordinary source retry; Flow/Decision advancement
     cannot turn a REV-0001 caller into an implicit REV-0002 request that creates REV-0003.
   - Same-Revision/Baseline timestamp refresh and established pending profile/scenario/workMode/risk/impact
     semantics remain intact. Explicit-correlation exact retry, correlation-free stale-source retry, and a fresh
     active same-request new revision remain covered positive cases.

5. **Completed transaction lineage integrity**
   - `transaction-lineage-integrity.ts` is a read-only coordinator used before public durable Change mutations.
     It scans every Revision, signal, and all three transaction-file suffixes; proves filename/content Change
     binding; and validates COMPLETED target Revision/signal/audit uniqueness, immutable archive/plan/Decision
     hashes, terminal bindings, and ordinary deterministic target hashes.
   - Historical completed journals remain immutable lineage authority, but the validator does not require the
     currently evolving readiness, Flow, or Decision inventory to equal a historical target. Only the transaction
     whose terminal Revision/Baseline is current invokes current-state authority, including canonical replay of
     legal late Decision transitions.
   - A PENDING owning recovery remains authorized only through its unique correlation in the owning coordinator;
     unrelated pending intents fence mutation, while every non-owning completed history is still validated.
   - Single-file corruption regressions cover Flow `newPlanHash`, Decision completion/audit target binding,
     ordinary completion/terminal hashes/filename, correlated Revision/signal cardinality, and unrelated
     open/stage/work/archive/Flow entry points with zero side effects.

6. **Canonical late Decision transitions**
   - `hashDecisionRecord` hashes the complete canonical Decision record. `DECISION_OPENED` binds `afterHash` and
     its exact target snapshot; resolve/supersede bind exact before/after snapshots and hashes plus authority or
     replacement identity. Audit timestamps equal record timestamps and append in unique JSONL order.
   - Terminal validation starts from the accepted deterministic inventory and replays only legal monotonic late
     open/resolve/supersede transitions. Accepted IDs cannot disappear; new IDs must be the next canonical ID;
     duplicated, reordered, forged, immutable-field, status, resolution, and supersession changes fail closed.
   - Legal terminal late open, ordinary resolve, and supersede remain GREEN, and settled-authority resolve is
     still rejected before a second journal.

7. **Deterministic ordinary timestamp**
   - The ordinary intent's `createdAt` now binds its signal, Revision, metadata target, Decision rebound, Flow
     compilation, and transaction-bound audits. A journal-to-signal crash retry consumes that frozen value and
     never reads a fresh clock.

### Public Change mutation matrix

| Public semantic entry | Exact lock/CAS | Completed lineage | Flow fence | Decision fence | Ordinary fence | Lock-owned lower write |
| --- | --- | --- | --- | --- | --- | --- |
| `saveChange`, `archiveChange`, readiness | yes | yes | yes | yes | yes | non-exported metadata/readiness primitive |
| prepare/complete stage and implementation work | yes | yes | yes | yes | yes | stage/task primitive under owning lock |
| Decision open/resolve/supersede | yes | yes | strict or terminal-authorized | yes | yes | Decision/Flow lower helpers |
| Flow create/migrate/synchronize/rebind | yes | yes | yes | yes | yes | `flow-store-internal.ts` only |
| Flow assessment | yes | yes | owning correlation only | yes | yes | transaction-authorized Flow/Reconcile lower helpers |
| ordinary Reconcile | yes | yes | yes | yes | owning correlation only | ordinary orchestration/recovery lower helpers |
| Decision-Reconcile | yes | yes | yes | owning correlation only | yes | Decision/Reconcile/Flow lower helpers |

The exception cells are not public bypasses: the public owner holds the exact Change lock and passes only the
durable transaction's correlation to an unexported within-lock continuation.

### Persisted phases and recovery boundaries

```text
ordinary Reconcile
  lock + lineage + three fences + exact caller CAS
  -> frozen closure/target TaskFile validation
  -> archive compatibility preflight
  -> PENDING intent with one createdAt and frozen target hashes
  -> archive -> signal -> Revision -> tasks/readiness/metadata
  -> Decision rebound -> Flow rebound -> audits -> COMPLETED intent

Flow / Decision Reconcile
  lock + lineage + non-owning fences
  -> frozen inventory and immutable archive preflight
  -> PENDING owning journal
  -> archive -> signal -> Revision -> metadata/tasks/readiness
  -> Decision/Flow terminal writes -> canonical audits -> COMPLETED journal

ordinary semantic mutation
  exact Change lock
  -> validate all historical completed lineage
  -> reject any non-owning PENDING intent
  -> exact Change/Revision/Baseline (and API-specific inventory/timestamp) CAS
  -> one lock-owned durable mutation
```

All frozen-input semantic errors are decided before archive preflight, intent creation, or any other durable
write. Recovery accepts only source, deterministic target, or the owning transaction's documented partial
phase; contradictory third state fails closed.

### Verification

The final commands use a tracked-HEAD archive plus an explicit Task 7 overlay and isolated `OMNAI_HOME`,
`XDG_CONFIG_HOME`, and `TMPDIR` under `/dev/shm`. This excludes unrelated concurrently created verification
files and avoids a pre-existing `/tmp/.git` contaminating host-context discovery.

- Focused round-4 regressions: `41/41` GREEN (including the final filename RED-to-GREEN).
- Expanded Decision/Flow/Reconcile/router/stage batch: `124/124` GREEN.
- Fresh tracked runnable suite: `535/535` GREEN (`533/533` outside protocol doctor plus its two runnable tests),
  with zero failures, skips, cancellations, or todos.
- `npm run typecheck`: exit `0` in the same isolated tracked overlay.
- Runtime plus generated `.d.ts` surface checks: guarded metadata/Flow entries present; within-lock lower helpers
  absent from `dist/src/index`, `dist/src/core/store`, and `dist/src/core/flow-store` public declarations.
- Actual package inventory fallback: 40 protocol documents and exactly four Host Skill directories
  (`omnai`, `omnai-brainstorm`, `omnai-grill`, `omnai-reconcile`); declared package roots remain `dist`,
  `resources`, `skills`, `templates`, `LICENSE`, and `README.md`.
- Task 7 path-limited `git diff --check` and staged diff check: exit `0`.

Direct `npm pack --dry-run` is still rejected by sandbox policy before npm starts, including the actual package
inventory test's pack subprocess. Per controller ruling, no unavailable permission was requested; the real
runtime/declaration and filesystem package inventories above provide the alternate evidence. The foreign
`test/verification-plan.test.ts`, `test/verification-entry-gates.test.ts`,
`test/execution-impact-closure.test.ts`, `src/execution/verification/**`, optimization design/plan documents,
and `.tmp-omnai-test-flow-gates.*` were excluded from the final tracked overlay and test discovery; none was
edited, staged, or committed, and after controller ownership clarification none was read or executed further.
Two concurrently modified tracked design documents were likewise excluded from the Task 7 pathspec.

### Scope and remaining risks

- Internal journals intentionally freeze a Change-local Task/Decision inventory and deterministic terminal
  hashes. Storage and read-only validation cost grow linearly with one Change's history and graph.
- Completed historical state is checked as immutable lineage; legal current Flow/readiness/Decision evolution is
  intentionally proved through its own later lineage rather than frozen to an older snapshot.
- No round-4 Critical, Important, or Minor product finding remains open. The only open verification item is the
  environment-blocked direct `npm pack --dry-run` handoff check.

---

## Fix review round 5 (2026-08-20)

### Review base and scope

- Review base: `125f8d2a8e6e7695ddf5bea794c576a654f341cb` (`fix: guard task 7 mutation lineage`).
- Fix commit: this round-5 commit (`fix: close final task 7 durability gaps`).
- The change remains inside the approved Task 7 Core/package/test/report surface. It adds no Host Skill,
  protocol, capability, command, dependency, execution feature, or `src/execution/**` change.

### Root causes and RED-to-GREEN evidence

The six review findings were reproduced against the round-4 base before their production fixes. The dedicated
`test/task-7-round-5.test.ts` suite grew one independent regression at a time and finishes at `48/48` GREEN.

1. **Installed-package deep-import bypass**
   - RED `0/5`: the root import worked only through an implicit layout and all three generated internal
     subpaths were importable because the package shipped `dist` without an `exports` map.
   - GREEN: `package.json` now exports only `.` with `dist/src/index.js` plus `dist/src/index.d.ts`, and the
     optional `./package.json`; the existing bin remains `dist/src/main.js`. A built installed-layout fixture
     proves root runtime/declaration resolution and `ERR_PACKAGE_PATH_NOT_EXPORTED` for
     `flow-store-internal`, `change-metadata-internal`, and `readiness-mutation-internal`. A committed-source
     search found no documented supported package subpath to preserve.

2. **Completed lineage exactness**
   - Initial RED `0/8` covered forged Flow `acceptedInputHash`, additional correlated signal evidence across
     ordinary/Flow/Decision transactions, immutable current Decision edits, and missing/forged/duplicate
     historical `DECISION_REBOUND` audits. Later REDs independently exposed current/historical Decision and
     Flow target forgery (`0/4`), Scenario target forgery (`0/1`), exact Decision audit fields (`0/2`), a
     coherently forged Flow audit (`0/1`), unaudited current Decision/Flow record edits (`0/2`), and an orphan
     semantic audit (`0/1`).
   - GREEN: validators derive every deterministic terminal target and exact audit from frozen request/source
     state. Historical targets bind through their archived hashes rather than current evolvable state. Current
     Decision-Reconcile replays only legal later transitions; current Flow authority permits a canonical
     decision/source recompile but rejects same-input target edits. Exact PENDING-owner recovery remains legal.

3. **Decision transition semantic legality**
   - REDs accepted an internally consistent HUMAN-to-`AGENT_EVIDENCE` resolve, wrong `resolvedRevision`, and an
     opened record whose `createdAt` differed from its event time. The existing dead-replacement guard was
     already GREEN and was retained as the fourth independent replay case.
   - GREEN: replay now enforces owner-to-authority mapping, exact active Revision/baseline and change identity,
     opened `createdAt == updatedAt == event.at`, resolved Revision equal to the replay Revision, and a live
     same-Change OPEN/BLOCKED replacement at the supersession point. Source refs, reason, replacement,
     authority, snapshots, hashes, and event adjacency are exact.

4. **Real Scenario-select prewrite bypass and recovery**
   - RED `0/8`: the compiled CLI created issue/bug artifacts before discovering an ordinary PENDING owner;
     stale ChangeRef and missing/malformed TaskFile paths also crossed prewrite boundaries, and crashes left
     unowned partial phases.
   - GREEN: Scenario selection is one exact semantic transaction. It validates scenario, caller identity,
     metadata, TaskFile, deterministic artifact paths/bytes/hashes, lineage, and all fences before intent or
     artifact writes. Exact retry owns artifacts, the correlated inner ordinary Reconcile, metadata/readiness,
     and one `SCENARIO_RECLASSIFIED` audit. Subprocess seams after intent, artifacts, and Reconcile completion
     recover once; different requests and non-owner mutations fence with byte/directory equality.

5. **Same-Revision write-before-audit recovery**
   - RED `0/10`: Decision open/ordinary resolve/supersede and public Flow migrate/synchronize/source-rebind
     could persist a target before the required audit, with no durable owner for exact continuation. Additional
     public synchronize replay exposed that the frozen source itself also needed self-integrity validation.
   - GREEN: the private semantic mutation journal freezes request identity, selected Decision ID/time,
     before/after Decision or Flow/metadata snapshots and hashes, readiness target, and exact audit outbox.
     IDs and filenames are monotonic and collision-free (`MUT-000001`,
     `REV-0001.MUT-000001.semantic-mutation.yaml`), filename/content binding is strict, one PENDING owner is
     allowed per Change, exact retry alone continues, and completed authority is immutable. Raw records or
     audits without their owning intent fail closed.

6. **Linear completed-lineage preflight**
   - RED `0/1`: instrumentation showed the old validator repeatedly filtered complete arrays and reread archive
     state per transaction.
   - GREEN: one parsed Change-local inventory builds correlation-to-Revision/signal maps, event/correlation and
     decision/semantic indexes with duplicate cardinality intact, pending-owner lists, and an archive cache.
     Each unique archive is parsed and canonically hashed once. The deterministic diagnostic assertion requires
     `inventoryPasses=1`, `correlationIndexBuilds=1`, `fullArrayScans=0`, and `archiveReads <= uniqueArchives`.
     Work is linear in Change-local record count plus parsed bytes, aside from one unavoidable canonical hash per
     unique archive.

The isolated full matrix found one additional compatibility RED after the lineage validator grew: Stage
preflight reported the new generic lineage errors before the established
`FLOW_DECISION_INVENTORY_MISMATCH` and `DECISION_STALE_REVISION` errors. The root cause was validation order,
not acceptance of corrupt state. Routing snapshot validation now runs first under the same exact Change lock;
completed lineage still runs before the first Stage write. The affected `flow-protocols` file returned to
`10/10`, and the encompassing batch returned to `159/159`.

### Durable phases and exact recovery

```text
Decision open / ordinary resolve / supersede
  exact Change lock + completed lineage + all non-owning fences
  -> PENDING semantic intent (request, selected ID/time, Decision/Flow/metadata/audits)
  -> Decision target -> Flow/readiness target -> exact audit outbox
  -> COMPLETED immutable intent
  crash seams: SEMANTIC_MUTATION_INTENT_WRITTEN
               DECISION_MUTATION_RECORD_WRITTEN
               DECISION_MUTATION_FLOW_WRITTEN
               DECISION_MUTATION_AUDITS_WRITTEN

Flow migrate / public synchronize / source rebound
  exact Change lock + completed lineage + all non-owning fences
  -> PENDING semantic intent (source/target Flow and metadata hashes + exact audit)
  -> Flow/metadata target -> exact audit -> COMPLETED immutable intent
  crash seam: FLOW_MUTATION_TARGET_WRITTEN

Scenario reclassification
  exact Change lock + all deterministic preflight
  -> PENDING semantic intent -> exact artifact set
  -> exact correlated ordinary Reconcile continuation
  -> target metadata/readiness + one audit -> COMPLETED immutable intent
  crash seams: SCENARIO_RECLASSIFY_INTENT_WRITTEN
               SCENARIO_RECLASSIFY_ARTIFACTS_ENSURED
               SCENARIO_RECLASSIFY_RECONCILE_COMPLETED
```

The journal coexists with Flow, Decision-Reconcile, and ordinary Reconcile journals without nested Change
locks. Every public durable mutation fences a non-owning semantic PENDING intent; the owning continuation is
non-exported and correlation-bound. Completed semantic transactions and their exact audit prefix are validated
before later mutations.

### Public mutation and journaling matrix

| Public semantic path | Exact lock + lineage/fences | Round-5 semantic journal boundary |
| --- | --- | --- |
| Decision open | yes | always; freezes the selected ID so retry cannot allocate another |
| ordinary Decision resolve / supersede | yes | always; repairs Decision -> Flow/readiness -> audit exactly once |
| settled-authority Decision resolve | yes | existing Decision-Reconcile owner remains authoritative |
| Flow migrate / public synchronize / source rebound | yes | always when target plus required audit/metadata are multi-write |
| `createInitialFlowPlan` | yes | journaled only for its analogous metadata-plus-Flow multi-write path; ordinary initial creation is one Flow write with no required audit |
| revision rebind | yes | the established one-Flow-write, no-separate-audit continuation remains owned by its Reconcile transaction |
| Scenario select/reclassify | yes | always; owns artifacts, inner ordinary Reconcile, target state, and audit |
| save/archive/readiness/stage/work/router | yes | non-owner fence; existing single-lock or established transaction authority retained |
| Flow / Decision / ordinary Reconcile | yes | their existing correlation journals remain the owners; semantic journal cannot adopt them |

### Verification

The production worktree contains concurrent foreign edits, so final runnable verification used a fresh archive
of the required base plus only the explicit Task 7 overlay. `/dev/shm` was requested by the review, but this
sandbox exposes that mount read-only (`tmpfs ... ro`) and rejected a persistent shell attempt before approval.
The safe fallback was `/tmp/omnai-task7-round5-OlRRiT`, with the tracked archive, explicit overlay, and linked
dependency tree; no foreign design, execution-verification, optimization, or test file entered the build.

- Dedicated round 5: `node --test --test-reporter=tap --test-concurrency=1 dist/test/task-7-round-5.test.js`
  -> `48/48` passed, zero failures.
- Expanded Decision/Flow/Reconcile/Stage/CLI regression after the compatibility fix -> `167/167` passed;
  the additional execution/Flow-protocol batch -> `159/159` passed.
- Isolated tracked test inventory: all 74 compiled test files were covered sequentially. `583/583` runnable
  unique test cases passed, with zero product failures. The sandbox mounts an empty read-only `/tmp/.git`, so
  the two tests that intentionally require an outside-Git `/tmp/outside-*` path were rerun through a lexical
  `/proc/self/cwd` alias; repository-path tests remained on the physical path. This avoids altering or deleting
  the shared mount and proves both contracts.
- The first two `protocol-doctor` tests passed `2/2`. The third existing test launches
  `npm pack --dry-run --json`; the execution policy stopped that subprocess before npm output with
  `Network request disconnected ... before approval could complete`. No unavailable approval was requested and
  no direct pack command was retried. Built installed-layout runtime/declaration/exports tests plus the actual
  filesystem inventory are the required fallback evidence.
- `npm run typecheck` and `npm run build` passed in the isolated tracked overlay.
- Built inventory: exactly 40 protocols and four Skills (`omnai`, `omnai-brainstorm`, `omnai-grill`,
  `omnai-reconcile`). Runtime root, generated declarations, package metadata, deep-import rejection, module
  direction/cycle guards, and workspace/package export guards passed.
- Task 7 path-limited `git diff --check`, staged-name isolation, and the cached-diff check passed.

### Files, isolation, and remaining risks

- Added private `semantic-mutation-journal.ts`, `decision-semantic-mutation.ts`,
  `flow-semantic-mutation.ts`, and `scenario-reclassification-target.ts`; added only the dedicated round-5 test.
  Existing Task 7 Core files and `package.json` carry the minimal integrations.
- The two modified tracked design documents, untracked optimization design/plan,
  `src/execution/verification/**`, `test/execution-impact-closure.test.ts`,
  `test/verification-entry-gates.test.ts`, and `test/verification-plan.test.ts` were neither edited nor staged.
- Journal and inventory storage grow linearly with one Change's local history and frozen graph size. This is the
  deliberate durability cost; archive bytes are read/hashed once per unique archive per preflight.
- One-write initial Flow creation and transaction-owned Revision rebind intentionally have no extra semantic
  journal because they have no target-before-required-audit multi-write window. Explicit legacy migration is
  the only upgrade entry that admits an old no-Flow Decision inventory before freezing it into a new semantic
  intent.
- No round-5 product finding remains open. The honest environment-only handoff items are the policy-blocked
  direct `npm pack --dry-run` and unavailable writable `/dev/shm`; both have concrete alternate evidence above.
