---
schemaVersion: 1
id: workset.reentry-decision
version: 1
kind: workset-action
actions:
  - decide-reentry
---

# Re-entry decision

Convert a reviewed PENDING proposal into a frozen DECIDED plan only after explicit user approval.

## Review checklist

- Every affected/candidate project has a `REQUIRED` or `NOT_REQUIRED` outcome.
- Required projects are bound to the intended Project Change.
- The Reconcile level satisfies the WRE minimum.
- `reopenFrom`, root Tasks, and Core-calculated closures match the accepted decision.
- The displayed `fromRevision` and `fromBaseline` are current.
- The consequences for implementation and fresh verification are understood.

## Method

Ask for explicit user approval of the complete project plan. After approval, run the deterministic decide command. Core must freeze the exact Readiness/Task closures and each project's current Revision and Baseline as preconditions.

## Safety boundary

Do not apply any project Reconcile while the WRE remains PENDING. Do not infer approval from earlier Grill/Brainstorm answers, silence, or a request to “continue.” Do not silently alter the proposal during decision.

## Stop conditions

Return to `omnai workset next --json` after the WRE is DECIDED, or keep it PENDING and report the specific project/decision that still needs correction or approval.
