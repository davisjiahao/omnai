---
schemaVersion: 1
id: repository.mitigate
version: 1
kind: repository-capability
capability: mitigate
---

# Incident Mitigation

## Method

Reduce active harm while preserving evidence. Separate containment from root-cause correction. Prefer reversible actions, document side effects, and identify what still requires investigation.

## Stop conditions

- Stop and report a blocking fact when the active Revision or required evidence is insufficient.
- Do not begin a later capability; return control to OmnAI routing after producing the declared output.
- Route a contradiction in current truth or approved intent to Reconcile rather than silently editing upstream decisions.
