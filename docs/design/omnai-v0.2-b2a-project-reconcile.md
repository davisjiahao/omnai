# OmnAI v0.2 B2a Project Reconcile Design

## 1. Scope

B2a connects Workset-level Re-entry (`WRE-xxxx`) to repository-local Project Changes without introducing a server, database, daemon, Web UI, or built-in LLM API.

B2a owns:

- one Workset member ↔ one Project Change binding;
- explicit Change binding proposals and confirmation;
- `PENDING -> DECIDED -> RESOLVED` WRE lifecycle;
- per-project Reconcile Applications;
- deterministic capability-closure and task-closure calculation;
- project-local Revision/Baseline advancement through the existing reconcile engine;
- partial failure, retry, idempotency, and truthful Workset routing.

B2a does not own user-level Codex/Claude/OpenCode skill installation. That is B2b.

## 2. Core invariants

1. One Workset member may bind to at most one Project Change.
2. A Project Change binding is never inferred solely from `activeChange` and is never silently replaced.
3. PENDING WREs are analysis-only: no Project Change, Revision, Baseline, task, or evidence state is mutated.
4. DECIDED is an explicit human-approved frozen project reconcile plan.
5. RESOLVED means every required project application is `APPLIED` or `NOT_REQUIRED`.
6. LLM/Agent hosts may propose semantic impact roots, but OmnAI Core calculates downstream closure deterministically.
7. Evidence is never deleted; active-revision freshness determines whether evidence still proves completion.
8. Existing repository-local `reconcileChange()` remains the single engine that advances Revision/Baseline and writes reconcile lineage.
9. Original registered repositories remain read-only during Workset preparation. OmnAI never creates an uncommitted Project Change in an original repository and then assumes a HEAD-based Worktree contains it.
10. A newer WRE may be analyzed and planned while an older WRE is DECIDED, but it cannot itself become DECIDED until the older outstanding Reconcile Applications are completed. This prevents freezing stale Revision/Baseline preconditions.

## 3. Project Change binding

A Workset coordinates one engineering objective across repositories. Each writable Workset member binds to one repository-local Project Change.

Example:

```text
WKS-0001 Authorization Migration
├── user-center  -> CHG-0027 Build Authorization ownership
├── quote-center -> CHG-0018 Migrate Authorization consumer
└── order-center -> CHG-0011 Preserve authorization snapshot
```

The user-facing term is **Project Change**. `CHG-xxxx` remains the machine identifier.

### 3.1 Bind an existing Project Change

```text
RESEARCH_ONLY
    ↓
list existing repository-local Changes
    ↓
Agent recommends one
    ↓
user confirms binding
    ↓
verify the Change is represented by committed HEAD
    ↓
WorksetMember.changeId is persisted
    ↓
activate -> create HEAD-based Worktree
    ↓
ACTIVE
```

`activeChange` may be shown as a suggestion but cannot be used as an automatic binding rule. An existing but uncommitted Change may be shown to explain repository state, but it cannot be bound for a Worktree that is created from committed HEAD.

### 3.2 Create a new Project Change

A new Change cannot first be written into the original repository because Worktrees are intentionally created from committed HEAD. Doing so would bind the Workset to metadata absent from the execution Worktree.

Therefore explicit user confirmation executes one Worktree-scoped operation:

```text
RESEARCH_ONLY
    ↓
user confirms "create new Project Change"
    ↓
create dedicated Workset Git Worktree from committed HEAD
    ↓
create CHG-xxxx inside that Worktree
    ↓
persist changeId + worktree + branch + ACTIVE
```

If Change creation fails, the member is not marked ACTIVE or bound. The safely created Worktree may remain for explicit recovery, following the existing Worktree recovery policy.

### 3.3 Binding guards

- binding an unknown Change: reject;
- binding an archived Change: reject;
- binding an existing Change that is not represented in committed HEAD: reject before activation;
- rebinding a member that already has `changeId`: reject unless a future explicit rebind workflow is introduced;
- creating a Change before explicit user confirmation: reject;
- new Change creation writes only inside the dedicated Worktree, never the original registered repository;
- applying a WRE to an ACTIVE project with no bound Project Change: reject.

## 4. WRE lifecycle

B1's coordination-only resolution semantics are superseded for new schema-v2 WRE records by the B2a end-to-end lifecycle:

```text
PENDING
  ↓
research / grill / brainstorm / experiment finishes
  ↓
Project Reconcile proposal + deterministic preview
  ↓
explicit human approval
  ↓
DECIDED
  ↓
Project Applications run independently
  ├── PENDING
  ├── APPLYING
  ├── APPLIED
  ├── FAILED
  └── NOT_REQUIRED
  ↓
all required applications APPLIED / NOT_REQUIRED
  ↓
RESOLVED
```

A schema-v2 WRE cannot bypass this lifecycle through direct `reentry resolve`. The legacy command is retained only for historical schema-v1 coordination records.

A WRE cannot move to DECIDED while newly introduced Candidate/Research-only projects still need an impact decision. A WRE cannot move to RESOLVED while any required application is PENDING, APPLYING, or FAILED.

## 5. Reconcile kind and minimum level

The Re-entry kind constrains the minimum project reconcile level:

| WRE kind | Minimum level |
| --- | --- |
| `REALITY_CHANGED` | `L4` |
| `PRODUCT_CHANGED` | `L4` |
| `DOMAIN_CHANGED` | `L3` |
| `SCOPE_CHANGED` | `L3` |
| `TECHNICAL_CONSTRAINT_CHANGED` | `L2` |
| `NEEDS_EXPERIMENT` | `L2` |
| `PLAN_CHANGED` | `L1` |
| `IMPLEMENTATION_DETAIL_CHANGED` | `L0` |

`L5` remains a special validation/external-drift level and is not automatically proposed by ordinary Workset WRE kinds. Per-project impact may be `NOT_REQUIRED`, but a required application may not choose a level weaker than the WRE minimum.

## 6. Semantic proposal versus deterministic closure

The Agent host owns semantic interpretation. OmnAI Core owns graph propagation.

Agent proposal example:

```yaml
project: user-center
outcome: REQUIRED
level: L3
reopenFrom: domain
taskRoots:
  - TASK-003
```

The Agent does **not** author the final invalidate closure. OmnAI calculates both Readiness closure and Task closure before the decision is frozen.

```text
Scenario stages
  + capability normalization
  + reopenFrom
        ↓
effective readiness path
        ↓
downstream readiness closure

Task DAG
  + taskRoots
        ↓
downstream task closure
```

Neither closure uses an LLM.

## 7. Capability graph

### 7.1 Normalization

Scenario capabilities map to readiness nodes:

| Capability | Readiness node |
| --- | --- |
| `frame` | `frame` |
| `map` | `map` |
| `research` | `research` |
| `mitigate` | `mitigation` |
| `triage` | `triage` |
| `reproduce` | `reproduction` |
| `debug` / `diagnose` | `diagnosis` |
| `model` | `domain` |
| `spec` | `spec` |
| `design` | `design` |
| `experiment` | `experiment` |
| `fix` | `fix` |
| `plan` | `plan` |
| `work` | `implementation` |
| `review` | `review` |
| `verify` | `verification` |
| `qa` | `qa` |
| `ship` / `release` | `release` |
| `canary` | `canary` |
| `learn` | `learning` |

`archive`, `reconcile`, and `simplify` are not invalidation roots. `contract.md` remains an artifact owned by `spec`; B2a does not introduce a separate contract-readiness node.

### 7.2 Effective graph

The effective path is derived from the current Scenario's ordered stages after normalization and duplicate collapse. Optional stages do not become mandatory invalidation nodes merely because they exist in `optionalStages`.

Example `complex-domain-feature`:

```text
research -> domain -> spec -> design -> plan -> implementation -> review -> verification -> learning
```

If the Agent proposes `reopenFrom: spec`, OmnAI calculates the suffix from `spec` through the active Scenario path.

### 7.3 State transitions

Closure answers **which readiness nodes are affected**. The repository-local reconcile engine answers **how affected nodes transition** (`STALE`, `INVALIDATED`, `NEEDS_REVALIDATION`, etc.).

B2a extends `reconcileChange()` with an optional explicit Readiness scope. Existing v0.1 callers that omit the scope keep the current level-default behavior.

## 8. Task closure

Task impact is independent from capability closure. The Agent supplies only semantic task roots. OmnAI Core calculates the downstream closure using the repository-local Task DAG.

The DECIDED plan freezes both `taskRoots` and the calculated `taskClosure`. At apply time OmnAI invalidates the **frozen exact taskClosure** rather than recalculating against a possibly changed Task DAG. This prevents execution from silently expanding the approved scope.

## 9. Frozen Project Reconcile Plan

When the user approves the plan and the WRE becomes DECIDED, OmnAI freezes the exact execution contract.

Example:

```yaml
schemaVersion: 2
id: WRE-0001
status: DECIDED
rulesVersion: 1
applications:
  - project: user-center
    changeId: CHG-0027
    status: PENDING
    level: L3
    reopenFrom: domain
    readinessClosure:
      - domain
      - spec
      - design
      - plan
      - implementation
      - review
      - verification
      - learning
    taskRoots:
      - TASK-003
    taskClosure:
      - TASK-003
      - TASK-005
      - TASK-008
    fromRevision: REV-0004
    fromBaseline: BL-0004
    toRevision: null
    toBaseline: null
    appliedAt: null

  - project: order-center
    changeId: CHG-0011
    status: NOT_REQUIRED
```

The plan is not recalculated at apply time. A future OmnAI upgrade therefore cannot reinterpret an already approved WRE.

## 10. Application semantics

Applying one required project application:

1. resolve the Workset member and bound Change;
2. check for a prior repository Reconcile with correlation ID `<WRE>/<project>`;
3. if correlated lineage exists and matches the frozen plan, recover it idempotently instead of advancing again;
4. otherwise verify the Change still has the frozen `fromRevision` / `fromBaseline`;
5. mark the application APPLYING;
6. call repository-local `reconcileChange()` with the frozen level, Readiness closure, exact Task closure, WRE reason, and correlation ID;
7. persist `toRevision` / `toBaseline` and mark APPLIED.

If the frozen precondition has drifted and no matching correlation exists, the application becomes FAILED. OmnAI does not silently replan.

If project reconciliation succeeds but the process stops before the WRE application is persisted, retry finds the correlated repository Revision and recovers without creating a second Revision.

## 11. Partial failure and retry

Projects apply independently.

```text
user-center   APPLIED
quote-center  FAILED
order-center  NOT_REQUIRED
```

The WRE remains DECIDED. Successful project applications are never rolled back merely because another repository failed.

If the final application becomes APPLIED but the process stops before the WRE itself is persisted as RESOLVED, `workset next` returns a `finalize-reentry` recovery action. Calling `reentry apply` again performs no additional repository Reconcile and finalizes the WRE.

## 12. Router precedence in B2a

```text
1. Candidate project read-only research
2. Research-only impact decision
3. Oldest PENDING WRE interaction
4. Oldest DECIDED WRE with PENDING / APPLYING / FAILED application
5. Interrupted-finalization recovery for a DECIDED WRE whose applications are all final
6. ACTIVE project repository-local workflow
7. none
```

Normal implementation does not resume while a DECIDED WRE remains unresolved.

A newer PENDING WRE may be analyzed while an older WRE is DECIDED, but the newer WRE cannot itself become DECIDED until the older outstanding decision is resolved.

## 13. New project in a WRE

A newly mentioned repository still follows the safe lifecycle:

```text
CANDIDATE -> RESEARCH_ONLY -> impact decision
```

If no modification is required, mark it OBSERVED_ONLY and its WRE application is `NOT_REQUIRED`.

If modification is required, the user confirms an existing committed Project Change binding or explicitly creates a new Project Change in a newly created dedicated Worktree. Only then may the project become ACTIVE and participate in a DECIDED Project Reconcile Plan.

A brand-new Project Change starts at its own initial `REV-0001 / BL-0001`; it is not reconciled merely to imitate older project revisions. The proposal can mark it `NOT_REQUIRED` when the new Change already embodies the approved decision.

## 14. Evidence semantics

Evidence files are not deleted or rewritten. A Project Change reconciliation advances `activeRevision`; evidence gates accept only PASS evidence for the active revision. Old evidence remains historical proof for its original revision but cannot satisfy the new revision.

## 15. CLI contract

```text
omnai workset change-bindings <project> [--workset <id>] [--json]
omnai workset bind-change <project> <CHG-xxxx> [--workset <id>] [--json]
omnai workset create-change <project> <title> --scenario <scenario> [--workset <id>] [--json]

omnai workset reentry plan <WRE> --file <proposal.yaml> [--workset <id>] [--json]
omnai workset reentry decide <WRE> [--workset <id>] [--json]
omnai workset reentry apply <WRE> [--project <alias>] [--workset <id>] [--json]
omnai workset reentry status <WRE> [--workset <id>] [--json]
```

`create-change` is an explicit create+bind+activate operation because the new Change must be created inside the dedicated Worktree. Existing committed Changes keep the separate bind-then-activate flow.

`omnai workset reentry resolve` remains only for historical schema-v1 coordination records. Schema-v2 records reject direct resolution.

## 16. Persistence and versioning

New B2a WRE records use schema version 2. Readers accept both schema v1 and v2. Existing schema-v1 RESOLVED records remain historical coordination records and are not retroactively treated as proof that project revisions were reconciled.

Frozen plans persist `rulesVersion` so future dependency-graph changes cannot alter already approved applications. Repository Reconcile lineage persists `<WRE>/<project>` correlation IDs for idempotent recovery.

## 17. Testing requirements

B2a tests prove:

- 1:1 Change binding and no silent rebind;
- existing Change suggestions do not automatically bind;
- existing binding requires Change state represented by committed HEAD;
- new Change creation writes inside the Worktree, not the original repository;
- WRE minimum-level guard;
- Scenario-derived Readiness closure;
- Task downstream closure and exact frozen application scope;
- PENDING performs no repository-local mutation;
- DECIDED freezes closures and Revision/Baseline preconditions;
- newer WRE decisions cannot freeze behind an older outstanding DECIDED WRE;
- per-project apply advances exactly one Revision/Baseline;
- stale frozen preconditions fail safely;
- correlation recovery is idempotent after partial persistence failure;
- one project failure does not roll back APPLIED siblings;
- WRE cannot RESOLVE before all required applications are APPLIED/NOT_REQUIRED;
- interrupted finalization is routed instead of silently resuming project work;
- old Revision evidence does not satisfy the new active Revision;
- Workset router prioritizes Re-entry coordination before normal project workflow.
