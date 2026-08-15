---
schemaVersion: 1
id: repository.archive
version: 1
kind: repository-capability
capability: archive
---

# Archive

## Method

Confirm intent, artifacts, implementation, and evidence agree. Promote only approved durable knowledge, preserve revision history, and mark the change archived without deleting its audit trail.

## Stop conditions

- Stop and report a blocking fact when the active Revision or required evidence is insufficient.
- Do not begin a later capability; return control to OmnAI routing after producing the declared output.
- Route a contradiction in current truth or approved intent to Reconcile rather than silently editing upstream decisions.
