---
schemaVersion: 1
id: workset.reentry-apply
version: 1
kind: workset-action
actions:
  - apply-reentry
---

# Apply a frozen Project Reconcile

Apply the approved DECIDED application to one project using its frozen exact scope and Revision/Baseline preconditions.

## Method

1. Confirm the Workset member is writable, bound to the frozen `changeId`, and still at `fromRevision` / `fromBaseline`.
2. Use the repository-local Reconcile engine with the frozen level, exact Readiness closure, and exact Task closure.
3. Preserve correlation lineage so an interrupted retry is idempotent and cannot advance the project twice.
4. Record `toRevision`, `toBaseline`, result, and failure classification in the application.
5. Return to `omnai workset next --json` after each project; Core chooses the next outstanding application or finalization.

## Failure behavior

Applications are independent. Partial success is retained: a failed project does not roll back an already APPLIED sibling. Repair and retry ordinary failures; a stale frozen precondition must use the explicit replan route.

## Safety boundary

Do not recompute or broaden the approved closure during apply. Do not silently change the bound Project Change, reset sibling applications, or erase prior Revision/Evidence history.

## Stop conditions

Stop after one bounded project application reaches APPLIED/FAILED, or after Core safely recovers an already correlated application without a second Revision advancement.
