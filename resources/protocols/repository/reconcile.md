---
schemaVersion: 1
id: repository.reconcile
version: 1
kind: repository-capability
capability: reconcile
---

# Reconcile

## Method

Classify the new signal by change level, identify affected artifacts and tasks, preserve the previous revision and baseline, apply selective invalidation, create the smallest required revision, and resume unaffected work.

## Stop conditions

- Stop and report a blocking fact when the active Revision or required evidence is insufficient.
- Do not begin a later capability; return control to OmnAI routing after producing the declared output.
- Route a contradiction in current truth or approved intent to Reconcile rather than silently editing upstream decisions.
