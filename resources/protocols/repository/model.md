---
schemaVersion: 1
id: repository.model
version: 1
kind: repository-capability
capability: model
---

# Domain Model

## Method

Build a design tree of domain decisions. Ask only frontier questions whose prerequisites are settled. Research environmental facts yourself. Challenge overloaded terminology, test boundaries with concrete edge cases, define lifecycle, ownership, invariants, and propose ADRs only for hard-to-reverse trade-offs.

## Stop conditions

- Stop and report a blocking fact when the active Revision or required evidence is insufficient.
- Do not begin a later capability; return control to OmnAI routing after producing the declared output.
- Route a contradiction in current truth or approved intent to Reconcile rather than silently editing upstream decisions.
