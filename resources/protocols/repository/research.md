---
schemaVersion: 1
id: repository.research
version: 2
kind: repository-capability
capability: research
---

# Codebase Research

## Method

Document the codebase as it exists today. Read explicitly referenced inputs first. Decompose the question into focused searches. Locate entry points, trace behavior and dependencies, find similar patterns, and cite exact paths and lines. For migration, replacement, removal, or architecture work, recover historical lineage and distinguish constraints that still apply from constraints that no longer apply. Do not propose refactors unless the instruction explicitly asks for recommendations.

When architecture is relevant, record current modules, callers, module/code ownership, and dependency direction. Map current interfaces, seams, adapters, and each dependency category as `in-process`, `local-substitutable`, `remote-but-owned`, or `true-external`. Identify leaked knowledge, change fan-out, locality problems, historical lineage, and the constraints that still apply. Cite exact repository evidence for every load-bearing claim. This is current-state evidence only: do not recommend or imply a target module, interface, seam, adapter, or dependency direction.

## Stop conditions

- Stop and report a blocking fact when the active Revision or required evidence is insufficient.
- Do not begin a later capability; return control to OmnAI routing after producing the declared output.
- Route a contradiction in current truth or approved intent to Reconcile rather than silently editing upstream decisions.
