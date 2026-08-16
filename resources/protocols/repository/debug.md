---
schemaVersion: 1
id: repository.debug
version: 1
kind: repository-capability
capability: debug
---

# Systematic Debugging

## Method

Find and confirm root cause before any production fix. Trace data across component boundaries, compare working and broken patterns, state one hypothesis at a time, and gather evidence that localizes the source rather than the symptom.

## Stop conditions

- Stop and report a blocking fact when the active Revision or required evidence is insufficient.
- Do not begin a later capability; return control to OmnAI routing after producing the declared output.
- Route a contradiction in current truth or approved intent to Reconcile rather than silently editing upstream decisions.
