---
schemaVersion: 1
id: repository.canary
version: 1
kind: repository-capability
capability: canary
---

# Canary Observation

## Method

Observe the released change over a bounded window using technical and business signals. Pause or reverse promotion on threshold violations and record evidence for the decision.

## Stop conditions

- Stop and report a blocking fact when the active Revision or required evidence is insufficient.
- Do not begin a later capability; return control to OmnAI routing after producing the declared output.
- Route a contradiction in current truth or approved intent to Reconcile rather than silently editing upstream decisions.
