---
schemaVersion: 1
id: repository.simplify
version: 1
kind: repository-capability
capability: simplify
---

# Simplification

## Method

Simplify the recent change without altering behavior. Remove unearned abstractions, duplication, and needless indirection. Do not expand the task into unrelated cleanup. Re-run relevant evidence after edits.

## Stop conditions

- Stop and report a blocking fact when the active Revision or required evidence is insufficient.
- Do not begin a later capability; return control to OmnAI routing after producing the declared output.
- Route a contradiction in current truth or approved intent to Reconcile rather than silently editing upstream decisions.
