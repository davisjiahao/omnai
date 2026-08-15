---
schemaVersion: 1
id: repository.diagnose
version: 1
kind: repository-capability
capability: diagnose
---

# Diagnosis

## Method

Legacy diagnosis capability. Find root cause before fixes. Trace data across component boundaries, compare working and broken patterns, state one hypothesis at a time, and run the smallest experiment that can disprove it. After repeated failed hypotheses, question the architecture rather than stacking guesses.

## Stop conditions

- Stop and report a blocking fact when the active Revision or required evidence is insufficient.
- Do not begin a later capability; return control to OmnAI routing after producing the declared output.
- Route a contradiction in current truth or approved intent to Reconcile rather than silently editing upstream decisions.
