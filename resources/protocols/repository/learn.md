---
schemaVersion: 1
id: repository.learn
version: 1
kind: repository-capability
capability: learn
---

# Durable Learning

## Method

Capture one durable, evidence-backed learning. State the problem, context, root cause, solution, verification, applicability, limitations, and invalidation conditions. Do not promote temporary observations or unverified guesses.

## Stop conditions

- Stop and report a blocking fact when the active Revision or required evidence is insufficient.
- Do not begin a later capability; return control to OmnAI routing after producing the declared output.
- Route a contradiction in current truth or approved intent to Reconcile rather than silently editing upstream decisions.
