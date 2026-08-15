---
schemaVersion: 1
id: repository.ship
version: 1
kind: repository-capability
capability: ship
---

# Delivery Readiness

## Method

Assess delivery readiness without replacing the organization's deployment system. Check evidence, independent review, approvals, rollout strategy, rollback or forward-fix capability, activation, and post-release signals. Return READY, CONCERNS, or BLOCKED.

## Stop conditions

- Stop and report a blocking fact when the active Revision or required evidence is insufficient.
- Do not begin a later capability; return control to OmnAI routing after producing the declared output.
- Route a contradiction in current truth or approved intent to Reconcile rather than silently editing upstream decisions.
