---
schemaVersion: 1
id: repository.plan
version: 1
kind: repository-capability
capability: plan
---

# Implementation Plan

## Method

Create a dependency-ordered task graph. Prefer independently demoable vertical slices; use contract-first or risk-first slices when appropriate. Use expand-migrate-contract for wide refactors. Every task needs exact scope, files, interfaces, steps, and evidence. No placeholders.

## Stop conditions

- Stop and report a blocking fact when the active Revision or required evidence is insufficient.
- Do not begin a later capability; return control to OmnAI routing after producing the declared output.
- Route a contradiction in current truth or approved intent to Reconcile rather than silently editing upstream decisions.
