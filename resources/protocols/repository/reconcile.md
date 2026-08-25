---
schemaVersion: 1
id: repository.reconcile
version: 3
kind: repository-capability
capability: reconcile
---

# Reconcile

## Method

Classify the new signal by change level, identify affected artifacts and tasks, preserve the previous revision and baseline, apply selective invalidation, create the smallest required revision, and resume unaffected work.

Classify DecisionRecord changes and FlowAssessment changes as explicit inputs to that closure. Preserve the accepted old FlowPlan and its source hashes as Revision lineage, let Core compile the replacement plan for the new Revision, and return to that new Revision's fresh Core route. Flow and Decision mutations use `omnai flow` and `omnai decision` commands rather than direct artifact edits.

When the fresh Reconcile route carries `decisionIds`, treat those IDs as causes rather than permission for a same-Revision resolve. Run `omnai decision resolve <decision> <resolution-file> ... --json` as the entry to Core's guarded Decision-Reconcile transaction: archive the exact prior FlowPlan, create the new Revision and Baseline, invalidate the legal readiness and dependent-task closure, rebind Flow lineage, then resolve that same record on the new Revision. A partial transaction remains fail-closed and resumes from its durable correlation state; it never releases the route by resolving the old Revision first.

Preserve the existing L0-L5 meanings while classifying module-boundary signals:

- `L0`: task-local implementation detail; the approved task, behavior, and boundary still hold. Rework or revalidate the affected task and evidence.
- `L1`: task decomposition, ordering, scope, or evidence plan. Rebuild the affected Plan/task subtree.
- `L2`: technical interface, seam, adapter, dependency direction, migration, or interface test-surface assumption. Reopen Design and dependent Plan, Work, Review, and Verify artifacts.
- `L3`: domain ownership, lifecycle, invariant, bounded context, requirement, or acceptance intent. Reopen the earliest affected Model or Specification stage and its downstream artifacts.
- `L4`: product goal, product-level scope, or reality premise. Reframe the Change or create a new Change, then reopen affected downstream artifacts.
- `L5`: existing delivery, validation, environment, or external-drift semantics. Use the existing L5 path; this protocol does not redefine it.

Choose `reopenFrom` as the earliest affected stage that exists in the selected scenario; do not invent a stage or reopen both Model and Specification when only one is affected. Preserve the previous Revision, Baseline, patch, code, tests, findings, and evidence as lineage. Mark content based on an invalidated decision non-authoritative until revalidated; do not silently delete or certify it. Unaffected tasks continue.

## Stop conditions

- Stop and report a blocking fact when the active Revision or required evidence is insufficient.
- Do not begin a later capability; return control to OmnAI routing after producing the declared output.
- Route a contradiction in current truth or approved intent to Reconcile rather than silently editing upstream decisions.
