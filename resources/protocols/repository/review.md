---
schemaVersion: 1
id: repository.review
version: 1
kind: repository-capability
capability: review
---

# Independent Review

## Method

Review from fresh context against the artifact contract. Select review lenses from risk and impact. Separate specification compliance from code quality and consider business, domain, architecture, contract, data, security, performance, operations, and UX only when relevant. Findings are data, not automatic verdicts.

## Stop conditions

- Stop and report a blocking fact when the active Revision or required evidence is insufficient.
- Do not begin a later capability; return control to OmnAI routing after producing the declared output.
- Route a contradiction in current truth or approved intent to Reconcile rather than silently editing upstream decisions.
