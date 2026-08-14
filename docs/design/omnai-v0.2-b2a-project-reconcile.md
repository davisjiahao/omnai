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

### 3.1 Binding flow

After read-only project research concludes that a repository must be modified:

```text
RESEARCH_ONLY
    ↓
OmnAI lists repository-local existing Changes
    ↓
Agent may recommend:
  A. bind an existing relevant Change
  B. create a new Project Change
    ↓
user confirms
    ↓
WorksetMember.changeId is persisted
    ↓
project may become ACTIVE / receive its Worktree
```

`activeChange` may be shown as a suggestion but cannot be used as an automatic binding rule.

### 3.2 Binding guards

- binding an unknown Change: reject;
- binding an archived Change: reject;
- rebinding a member that already has `changeId`: reject unless a future explicit rebind workflow is introduced;
- creating a Change before user confirmation: reject;
- applying a WRE to an ACTIVE project with no bound Project Change: reject.

## 4. WRE lifecycle

B1 `RESOLVED` coordination semantics are replaced by the B2a end-to-end lifecycle:

```text
PENDING
  ↓
research / grill / brainstorm / experiment finishes
  ↓
Project Reconcile Plan is generated and approved
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

A WRE cannot move to DECIDED while newly introduced Candidate/Research-only projects still need an impact decision.

A WRE cannot move to RESOLVED while any required application is PENDING, APPLYING, or FAILED.

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

`L5` remains a special validation/external-drift level and is not automatically proposed by ordinary Workset WRE kinds.

Per-project impact may be `NOT_REQUIRED`, but a required application may not choose a level weaker than the WRE minimum.

## 6. Semantic proposal versus deterministic closure

The Agent host owns semantic interpretation. OmnAI Core owns graph propagation.

Agent proposal example:

```yaml
project: user-center
changeId: CHG-0027
level: L3
reopenFrom: domain
taskRoots:
  - TASK-003
```

The Agent does **not** author the final invalidate closure.

OmnAI Core calculates:

```text
Scenario stages
  + capability normalization
  + reopenFrom
        ↓
effective capability graph
        ↓
transitive downstream closure
```

It separately calculates task closure using the repository-local Task DAG.

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

`archive`, `reconcile`, and `simplify` are not invalidation roots.

`contract.md` remains an artifact owned by `spec`; B2a does not introduce a separate contract-readiness node.

### 7.2 Effective graph

The effective graph is derived from the current Scenario's ordered stages after normalization and duplicate collapse. Optional stages do not become mandatory invalidation nodes merely because they exist in `optionalStages`.

Example `complex-domain-feature`:

```text
research -> domain -> spec -> design -> plan -> implementation -> review -> verification -> learning
```

If the Agent proposes `reopenFrom: spec`, OmnAI calculates all downstream nodes in that effective graph.

### 7.3 State transitions

Closure answers **which readiness nodes are affected**. The repository-local reconcile engine answers **how affected nodes transition** (`STALE`, `INVALIDATED`, `NEEDS_REVALIDATION`, etc.).

B2a extends `reconcileChange()` with an optional explicit readiness scope. Existing v0.1 callers that omit the scope keep the current level-default behavior.

## 8. Task closure

Task impact is independent from capability closure.

The Agent may provide a small set of semantic task roots. OmnAI Core uses the existing Task DAG dependency traversal to calculate downstream affected tasks. The frozen DECIDED plan stores both roots and calculated closure.

No LLM is used to enumerate downstream task dependencies.

## 9. Frozen Project Reconcile Plan

When the user approves the plan and the WRE becomes DECIDED, OmnAI freezes the exact execution contract.

Example:

```yaml
schemaVersion: 1
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

Applying one project application:

1. resolve the Workset member and bound Change;
2. verify the bound Change still has the frozen `fromRevision` / `fromBaseline`;
3. mark application APPLYING;
4. call repository-local `reconcileChange()` with the frozen level, readiness closure, task roots, and WRE reason;
5. persist `toRevision` / `toBaseline` from the result;
6. mark application APPLIED.

If step 2 fails, the application becomes FAILED and must not be silently replanned. A human/Agent must inspect why repository state diverged.

If the process dies after project reconciliation succeeds but before the WRE application is persisted, retry must detect the reconcile lineage associated with the WRE and recover idempotently rather than advance another Revision.

## 11. Partial failure and retry

Projects apply independently.

Example:

```text
user-center  APPLIED
quote-center FAILED
order-center NOT_REQUIRED
```

The WRE remains DECIDED. `workset next` routes to the failed/pending project reconcile before normal project workflow resumes.

Successful project applications are never rolled back merely because another repository failed.

## 12. Router precedence in B2a

After B2a:

```text
1. Candidate project read-only research
2. Research-only impact decision
3. Oldest PENDING WRE interaction
4. Oldest DECIDED WRE with FAILED/PENDING application
5. ACTIVE project repository-local workflow
6. none
```

Normal implementation does not resume while an approved project reconcile application is outstanding.

## 13. New project in a WRE

A newly mentioned repository still follows the B1 safety lifecycle:

```text
CANDIDATE -> RESEARCH_ONLY -> impact decision
```

If no modification is required, mark it OBSERVED_ONLY and its WRE application is `NOT_REQUIRED`.

If modification is required, the user confirms an existing or newly created Project Change binding before activation. Only then may the project receive a Worktree and participate in a DECIDED Project Reconcile Plan.

A brand-new Project Change starts at its own initial `REV-0001 / BL-0001`; it is not immediately reconciled just to imitate older project revisions. The WRE plan records whether the newly created Change already represents the decided requirement (`NOT_REQUIRED`) or needs an explicit application because it existed before the decision.

## 14. Evidence semantics

Evidence files are not deleted or rewritten.

A Project Change reconciliation advances `activeRevision`; current evidence gates already accept only PASS evidence for the active revision. Old evidence therefore remains historical proof for its original revision but cannot satisfy the new revision.

## 15. CLI contract

B2a adds explicit commands; Agent hosts may wrap them, but Core remains deterministic.

Suggested surface:

```text
omnai workset change-bindings <WRE> --json
omnai workset bind-change <project> <CHG-xxxx> [--workset <id>] --json
omnai workset create-change <project> <title> --scenario <scenario> [--workset <id>] --json

omnai workset reentry plan <WRE> --file <proposal.yaml> --json
omnai workset reentry decide <WRE> --json
omnai workset reentry apply <WRE> [--project <alias>] --json
omnai workset reentry status <WRE> --json
```

The implementation may refine names if Commander ergonomics require it, but there must be explicit separate operations for binding/creating a Project Change, freezing DECIDED state, and applying the frozen plan.

## 16. Persistence and versioning

B2a upgrades WRE schema version while preserving the ability to read B1 records. B1 `PENDING` records migrate naturally to the richer shape. Existing B1 `RESOLVED` records remain historical coordination records and are not retroactively treated as proof that project revisions were reconciled.

Frozen plans persist `rulesVersion` so future dependency-graph changes cannot alter already approved applications.

## 17. Testing requirements

B2a must have tests proving:

- 1:1 Change binding and no silent rebind;
- existing Change suggestions do not automatically bind;
- new Change creation occurs only through an explicit command;
- WRE minimum level guard;
- scenario-derived capability closure;
- task downstream closure;
- closure is frozen at DECIDED;
- PENDING performs no repository-local mutation;
- per-project apply advances exactly one Revision/Baseline;
- stale frozen `fromRevision` fails safely;
- retry is idempotent after partial persistence failure;
- one project failure does not roll back APPLIED siblings;
- WRE cannot RESOLVE before all required applications are APPLIED/NOT_REQUIRED;
- old Revision evidence does not satisfy the new active Revision;
- Workset router prioritizes pending project reconciliation before normal workflow.
