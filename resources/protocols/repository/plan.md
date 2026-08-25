---
schemaVersion: 1
id: repository.plan
version: 3
kind: repository-capability
capability: plan
---

# Implementation Plan

## Method

Create a dependency-ordered task graph. Prefer independently demoable vertical slices; use contract-first or risk-first slices when appropriate. Use expand-migrate-contract for wide refactors. Every task needs exact scope, files, interfaces, steps, and evidence. No placeholders.

Accept only resolved executable decisions. When any unresolved DecisionRecord affects planned work, stop and return its `DEC-*` reference to the adaptive Core route instead of burying the choice in a Task. The resulting Task DAG is project-local. Never create a cross-project task dependency; coordinate projects only through explicit `contract:<key>` references and Workset contract state.

For module-boundary work, use only the existing task fields `files`, `consumes`, `produces`, `steps`, and `evidenceRequired`. `files` contributes to task-local scope; Core combines it with policy to derive final `allowedPaths`. Refer to internal design elements as `module:MOD-*` or `interface:IF-*`. Reserve `contract:<key>` exclusively for cross-project discovery; never use it for an internal reference or cross-project task dependency. Encode implementation and migration order in `steps`, and name behavioral, characterization, contract, integration, operability, or deletion/simplification proof in `evidenceRequired`.

Refuse to bury an unresolved architecture choice inside an implementation task. Any deletion or simplification claim requires task-local evidence proving preservation of observable behavior and contracts.

## Stop conditions

- Stop and report a blocking fact when the active Revision or required evidence is insufficient.
- Do not begin a later capability; return control to OmnAI routing after producing the declared output.
- Route a contradiction in current truth or approved intent to Reconcile rather than silently editing upstream decisions.
