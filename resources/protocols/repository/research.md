---
schemaVersion: 1
id: repository.research
version: 1
kind: repository-capability
capability: research
---

# Codebase Research

## Method

Document the codebase as it exists today. Read explicitly referenced inputs first. Decompose the question into focused searches. Locate entry points, trace behavior and dependencies, find similar patterns, and cite exact paths and lines. For migration, replacement, removal, or architecture work, recover historical lineage and distinguish constraints that still apply from constraints that no longer apply. Do not propose refactors unless the instruction explicitly asks for recommendations.

## Stop conditions

- Stop and report a blocking fact when the active Revision or required evidence is insufficient.
- Do not begin a later capability; return control to OmnAI routing after producing the declared output.
- Route a contradiction in current truth or approved intent to Reconcile rather than silently editing upstream decisions.
