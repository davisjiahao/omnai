---
schemaVersion: 1
id: repository.spec
version: 1
kind: repository-capability
capability: spec
---

# Change Specification

## Method

Express the change as intent, not implementation. Use added, modified, removed, and preserved requirements with stable acceptance-criterion IDs, compatibility expectations, non-goals, and open questions. The specification must be observable and testable.

## Stop conditions

- Stop and report a blocking fact when the active Revision or required evidence is insufficient.
- Do not begin a later capability; return control to OmnAI routing after producing the declared output.
- Route a contradiction in current truth or approved intent to Reconcile rather than silently editing upstream decisions.
