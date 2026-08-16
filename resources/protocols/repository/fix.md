---
schemaVersion: 1
id: repository.fix
version: 1
kind: repository-capability
capability: fix
---

# Fix Strategy

## Method

Write the smallest fix strategy that addresses the confirmed root cause. State scope, regression guard, compatibility impact, rollback or recovery, and any trade-offs. Do not expand into unrelated refactoring.

## Stop conditions

- Stop and report a blocking fact when the active Revision or required evidence is insufficient.
- Do not begin a later capability; return control to OmnAI routing after producing the declared output.
- Route a contradiction in current truth or approved intent to Reconcile rather than silently editing upstream decisions.
