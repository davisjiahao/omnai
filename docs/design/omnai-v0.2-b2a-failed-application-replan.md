# OmnAI v0.2 B2a Failed Application Replan Amendment

## 1. Status

This document is an **authoritative B2a amendment** to `omnai-v0.2-b2a-project-reconcile.md` for recovery after a frozen Project Reconcile Application fails because its repository-local Revision/Baseline precondition has drifted.

It supersedes any interpretation that a stale-precondition `FAILED` application may only be retried forever or that the entire WRE must be discarded.

## 2. Problem

A DECIDED WRE freezes each required project's `fromRevision`, `fromBaseline`, readiness closure, task roots, and task closure. If another legitimate repository-local operation advances the bound Project Change before this application is applied, B2a correctly rejects the stale frozen precondition and marks that project application `FAILED`.

Without an explicit recovery transition, the WRE would remain permanently blocked even though the failure is explainable and recoverable.

## 3. Chosen recovery model

Recovery stays inside the same WRE and only replaces the failed project's current frozen application after explicit confirmation.

```text
WRE-0001 DECIDED
├── user   APPLIED
└── quote  FAILED (STALE_PRECONDITION)
            ↓
reentry replan WRE-0001 --project quote
            ↓
read-only preview against current Project Change
            ↓
reentry replan WRE-0001 --project quote --confirm
            ↓
old failed frozen application -> attemptHistory
quote current application -> new frozen PENDING application
            ↓
apply quote
            ↓
RESOLVED when every application is APPLIED / NOT_REQUIRED
```

Already `APPLIED` and `NOT_REQUIRED` sibling applications are never changed, rolled back, or recalculated by a project replan.

## 4. Failure classification

Project Reconcile Applications add an optional machine-readable `failureKind` with the following B2a values:

```text
STALE_PRECONDITION
MEMBER_NOT_WRITABLE
BOUND_CHANGE_MISMATCH
MISSING_FROZEN_FIELDS
CORRELATION_CONFLICT
APPLY_ERROR
```

`failureKind` is `null` for non-failed applications and after a successful replan reset.

Only `FAILED + STALE_PRECONDITION` is eligible for the replan flow defined here. Other failures remain retry/repair cases and must not be silently converted into a new frozen plan.

## 5. Attempt history

Each Project Reconcile Application stores `attemptHistory`, defaulting to an empty array for backward-compatible schema-v2 reads.

Each history entry is an immutable snapshot of the replaced frozen attempt and contains:

```yaml
status: FAILED
failureKind: STALE_PRECONDITION
level: L3
reopenFrom: domain
readinessClosure: [domain, spec, design, plan, implementation, review, verification, learning]
taskRoots: [TASK-003]
taskClosure: [TASK-003, TASK-005]
fromRevision: REV-0004
fromBaseline: BL-0004
toRevision: null
toBaseline: null
error: Frozen precondition ...
appliedAt: null
replannedAt: 2026-08-14T00:00:00.000Z
```

The current application remains the only executable attempt. `attemptHistory` is audit history and is never applied.

## 6. Read-only preview

`previewFailedWorksetReentryApplicationReplan(home, worksetRef, reentryId, projectAlias)` is read-only.

It requires:

- WRE status is `DECIDED`;
- the target application exists and is `FAILED`;
- `failureKind` is `STALE_PRECONDITION`;
- the Workset member is still `ACTIVE` with the same bound Project Change;
- no repository Revision already carries correlation ID `<WRE>/<project>`.

The preview reuses the failed application's semantic inputs:

- `level`;
- `reopenFrom`;
- `taskRoots`.

Against the **current** bound Project Change, OmnAI deterministically recalculates:

- readiness closure from the current Scenario;
- task closure from the current Task DAG;
- current `fromRevision`;
- current `fromBaseline`.

Preview must not modify WRE YAML, Project Change metadata, tasks, evidence, revisions, or Workset membership.

## 7. Explicit confirmation

`confirmFailedWorksetReentryApplicationReplan(...)` performs the only state mutation in this recovery flow.

Before writing, it recalculates the same preview again from current repository truth so a stale preview cannot be confirmed after another repository change.

On success it:

1. appends the old failed frozen application snapshot to `attemptHistory` with `replannedAt`;
2. preserves `project` and `changeId`;
3. replaces the executable frozen fields with the newly calculated closure and current Revision/Baseline;
4. sets status to `PENDING`;
5. clears `error`, `failureKind`, `toRevision`, `toBaseline`, and `appliedAt`;
6. leaves the WRE status `DECIDED`;
7. leaves every sibling application byte-for-byte semantically unchanged.

There is no automatic confirmation and no background replan.

## 8. Correlation safety

Replan is forbidden when repository reconcile lineage already contains correlation ID `<WRE>/<project>`.

A correlation record means the old frozen attempt may already have mutated repository-local Revision/Baseline state. In that situation the existing idempotent apply recovery path or explicit human repair must resolve the state first. Replan must never hide an already-written repository reconcile behind a new attempt.

The correlation ID remains `<WRE>/<project>` after a stale-precondition replan because an eligible stale-precondition failure has not written a correlated repository Revision.

## 9. Router semantics

For a DECIDED WRE:

```text
FAILED + STALE_PRECONDITION -> replan-reentry
FAILED + other failureKind  -> apply-reentry / repair-and-retry
PENDING / APPLYING          -> apply-reentry
all final                   -> finalize-reentry
```

A stale-precondition failure therefore no longer routes to an apply command that is guaranteed to fail with the same frozen precondition.

## 10. CLI contract

B2a adds:

```text
omnai workset reentry replan <WRE> --project <alias> [--workset <id>] [--confirm] [--json]
```

Without `--confirm`, the command returns a read-only preview.

With `--confirm`, it persists the attempt history and the new frozen `PENDING` application.

Human-readable and JSON output must clearly distinguish `preview` from `confirmed` behavior.

## 11. Invariants

1. Replan is explicit and project-scoped.
2. Only `FAILED + STALE_PRECONDITION` can be replanned.
3. Preview is read-only.
4. Confirm recalculates from current repository truth before writing.
5. The old frozen attempt is never deleted; it moves into `attemptHistory`.
6. APPLIED and NOT_REQUIRED siblings never change during another project's replan.
7. Replan never advances repository Revision/Baseline itself.
8. Replan never deletes or rewrites Evidence.
9. Existing correlation lineage blocks replan.
10. The WRE remains DECIDED until normal apply/finalize semantics make it RESOLVED.

## 12. Required tests

Tests must prove:

- stale frozen Revision/Baseline sets `failureKind: STALE_PRECONDITION`;
- unrelated apply failures are not replan-eligible;
- preview recalculates current Revision/Baseline and current deterministic closures without mutation;
- confirm stores the old failed frozen attempt in `attemptHistory`;
- confirm resets only the selected application to PENDING;
- APPLIED/NOT_REQUIRED siblings remain unchanged;
- repeated preview is idempotent;
- confirm rejects if repository truth changes between preview and confirm by recalculating from current truth rather than trusting client preview data;
- replan rejects when correlated repository Revision lineage already exists;
- router returns `replan-reentry` for stale-precondition failures;
- CLI preview and `--confirm` produce deterministic JSON;
- after confirm, normal apply advances exactly one new Revision/Baseline and the WRE can reach RESOLVED.
