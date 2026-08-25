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
- `NOT_REQUIRED`: provide the project only.

Use a top-level YAML array as the strict proposal file. Evidence and explanation are presented beside the strict file; Core calculates every closure, and Core computes closures from semantic roots. Do not manually expand either closure or treat an LLM-generated list as workflow truth.

For each `REQUIRED` proposal, choose `level` from the Re-entry kind and `reopenFrom` from the current Workset Re-entry route capability using these exact mappings.

<!-- workset-reentry-minimum-levels -->
```yaml
REALITY_CHANGED: L4
PRODUCT_CHANGED: L4
DOMAIN_CHANGED: L3
SCOPE_CHANGED: L3
TECHNICAL_CONSTRAINT_CHANGED: L2
NEEDS_EXPERIMENT: L2
PLAN_CHANGED: L1
IMPLEMENTATION_DETAIL_CHANGED: L0
```

<!-- workset-reentry-readiness-keys -->
```yaml
research: research
frame: frame
model: domain
spec: spec
design: design
experiment: experiment
plan: plan
work: implementation
```

<!-- workset-reconcile-proposals -->
```yaml
- project: consent-service
  outcome: REQUIRED
  level: L2
  reopenFrom: design
  taskRoots:
    - TASK-003
- project: audit-dashboard
  outcome: NOT_REQUIRED
```

Run the deterministic `reentry plan` command, then show the calculated plan before any decision. Explain per-project outcome, level, `reopenFrom`, calculated closures, current Revision/Baseline, and any unresolved candidate impact.

## Safety boundary

Planning is analysis-only. It does not advance Revision/Baseline, invalidate readiness or tasks, create Evidence, or change the WRE from PENDING. Never hide a project from the proposal merely to reduce work.

## Stop conditions

Return to `omnai workset next --json` after Core accepts the proposal and the complete calculated plan is ready for explicit user review, or stop with the exact validation error that must be corrected.
