# Scenario: complex-domain-feature

## Purpose

Build business behavior where terminology, lifecycle, invariants, ownership, or bounded contexts matter as much as code.

## When to use

Use for authorization, policy, order-state, pricing/business-rule, identity/consent, or other domain-heavy capabilities—especially in legacy systems where current code may conflate concepts.

## Route

`research → model → spec → design → plan → work → review → verify → learn → archive`

`frame` and `reconcile` are optional. Research restores reality; model restores semantic meaning before design.

## Artifacts

`research.md` documents current code. `domain.md` owns change-local vocabulary, lifecycle, ownership, invariants, edge cases, and domain decisions. Sparse ADRs record hard-to-reverse trade-offs. `spec.md`, `design.md`, and `tasks.yaml` then express the selected change.

## Risk and impact

Default P1 with high business criticality. P1 requires explicit recovery planning and human approval before ship when delivery is involved. API/data/security effects add matrix requirements.

## Human gates

Humans own true domain decisions. Agents own fact retrieval. Changes to bounded-context ownership, aggregate lifecycle, externally visible semantics, or irreversible business rules require explicit confirmation.

## Evidence

Domain decisions must be traceable; behavior/integration tests prove rules and boundaries; contracts/data checks are added based on impact. Independent review includes business, domain, architecture, and engineering lenses by default for P1 work.

## Reconciliation

A new code fact that invalidates the domain model is L3: mark domain/spec/design/plan downstream state stale or invalidated, create a new baseline, preserve unaffected tasks, and resume only after semantic correction.

## Example

Current `AuthorizationRecord` contains durable consent plus per-quote usage. Research proves the mixed implementation; modeling separates `Authorization` and `AuthorizationUsage`, defines owners/lifecycles, then spec/design migrate behavior. During repository implementation, historical rows reveal another semantic split; issue L3 reconciliation, preserve unrelated logging work, invalidate schema/repository tasks, revise the domain, then continue.

## Exit condition

Domain language and invariants are coherent, implementation matches them, and evidence proves the acceptance criteria.