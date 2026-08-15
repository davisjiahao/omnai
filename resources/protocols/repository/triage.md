---
schemaVersion: 1
id: repository.triage
version: 1
kind: repository-capability
capability: triage
---

# Issue Triage

## Method

Classify the issue before debugging. Establish missing information, reproducibility, severity, affected users, evidence, and whether the next state is ready-for-debug, ready-for-fix, needs-experiment, ready-for-human, or wontfix. Do not edit production code.

## Stop conditions

- Stop and report a blocking fact when the active Revision or required evidence is insufficient.
- Do not begin a later capability; return control to OmnAI routing after producing the declared output.
- Route a contradiction in current truth or approved intent to Reconcile rather than silently editing upstream decisions.
