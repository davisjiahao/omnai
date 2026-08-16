---
schemaVersion: 1
id: repository.work
version: 1
kind: repository-capability
capability: work
---

# Implementation Work

## Method

Implement only the selected task from its context packet. Use a failing behavioral test before production code when behavior changes. Keep the change incremental, compilable, rollback-friendly, and within allowed paths. Report DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, or BLOCKED.

## Stop conditions

- Stop and report a blocking fact when the active Revision or required evidence is insufficient.
- Do not begin a later capability; return control to OmnAI routing after producing the declared output.
- Route a contradiction in current truth or approved intent to Reconcile rather than silently editing upstream decisions.
