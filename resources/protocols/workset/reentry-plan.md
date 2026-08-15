---
schemaVersion: 1
id: workset.reentry-plan
version: 1
kind: workset-action
actions:
  - reenter
---

# Project Reconcile proposal

Translate the completed Re-entry decision into a per-project semantic proposal without mutating Project Change state.

## Method

For every affected or candidate project, propose exactly one outcome:

- `REQUIRED`: provide the project, minimum-valid Reconcile level, semantic `reopenFrom` Readiness root, and root affected Task IDs.
- `NOT_REQUIRED`: provide the project and evidence explaining why its active Project Change does not need a new Revision.

OmnAI Core calculates the complete Scenario-derived Readiness closure and Task-DAG closure. Do not manually expand either closure or treat an LLM-generated list as workflow truth.

Run the deterministic `reentry plan` command, then show the calculated plan before any decision. Explain per-project outcome, level, `reopenFrom`, calculated closures, current Revision/Baseline, and any unresolved candidate impact.

## Safety boundary

Planning is analysis-only. It does not advance Revision/Baseline, invalidate readiness or tasks, create Evidence, or change the WRE from PENDING. Never hide a project from the proposal merely to reduce work.

## Stop conditions

Return to `omnai workset next --json` after Core accepts the proposal and the complete calculated plan is ready for explicit user review, or stop with the exact validation error that must be corrected.
