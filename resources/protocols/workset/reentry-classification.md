---
schemaVersion: 1
id: workset.reentry-classification
version: 1
kind: workset-action
actions:
  - record-reentry
---

# Workset Re-entry classification

When a new fact may invalidate the active Workset baseline, classify one coherent reason into exactly one structured WRE kind before recording it.

## Kinds

- `REALITY_CHANGED`: current-system facts changed or are no longer trustworthy.
- `PRODUCT_CHANGED`: the product goal or user outcome changed.
- `DOMAIN_CHANGED`: meaning, ownership, lifecycle, rule, or invariant changed.
- `SCOPE_CHANGED`: scope, acceptance criteria, or non-goals changed.
- `TECHNICAL_CONSTRAINT_CHANGED`: a technical constraint invalidated the chosen approach.
- `NEEDS_EXPERIMENT`: the remaining decision requires measured evidence.
- `PLAN_CHANGED`: task structure, dependency order, or delivery sequence changed.
- `IMPLEMENTATION_DETAIL_CHANGED`: the change remains inside implementation detail.

## Method

1. State the new fact and the old assumption it challenges.
2. Identify current affected Workset projects and newly suspected registered candidate projects.
3. Separate independent reasons into independent WRE records.
4. Record the WRE through OmnAI Core and immediately return to `omnai workset next --json`.

## Safety boundary

Do not calculate a Readiness or Task closure during classification. Do not advance Revision/Baseline, create a candidate Worktree, or silently apply project changes. Core enforces minimum Reconcile levels and later calculates closure from semantic roots.

## Stop conditions

Stop after the WRE is durably recorded, or report the missing evidence that prevents a defensible classification.
