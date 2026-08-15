---
schemaVersion: 1
id: workset.reentry-replan
version: 1
kind: workset-action
actions:
  - replan-reentry
---

# Replan a stale failed application

Use this path only for an application in `FAILED + STALE_PRECONDITION` after the project changed between DECIDED freeze and apply.

## Preview

Run the project-scoped replan preview first. The preview is read-only: it reloads current Project Change truth, recalculates the approved semantic roots against the current Scenario and Task DAG, and shows the replacement Revision/Baseline preconditions. It must not mutate the WRE or repository.

## Confirmation

Explain why the old precondition is stale and compare the old and proposed frozen application. Obtain explicit user approval before confirmation. Confirm must recalculate again from current repository truth rather than trusting an earlier preview.

On confirmation, Core archives the old failed frozen attempt in `attemptHistory`, preserves APPLIED and NOT_REQUIRED siblings exactly, and resets only the selected project application to PENDING with the new frozen scope and preconditions.

## Safety boundary

Do not replan ordinary APPLY_ERROR or other failure kinds. Do not overwrite failure history. Do not hide repository writes that already have the `<WRE>/<project>` correlation lineage; such lineage is a hard conflict requiring investigation.

## Stop conditions

Return to `omnai workset next --json` after preview or confirmed replan. The normal apply route performs the eventual Revision advancement.
