---
schemaVersion: 1
id: repository.design
version: 1
kind: repository-capability
capability: design
---

# Solution Design

## Method

Explore 2-3 viable approaches, recommend one with trade-offs, and describe components, interfaces, data flow, state, errors, security, observability, testing, delivery, migration, and rollback. Scale depth to risk and complexity. If a boundary contract changes, keep contract.md consistent with the design.

## Stop conditions

- Stop and report a blocking fact when the active Revision or required evidence is insufficient.
- Do not begin a later capability; return control to OmnAI routing after producing the declared output.
- Route a contradiction in current truth or approved intent to Reconcile rather than silently editing upstream decisions.
