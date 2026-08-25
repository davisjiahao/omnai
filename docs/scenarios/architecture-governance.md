# Scenario: architecture-governance

## Purpose

Evolve architecture or domain boundaries deliberately, grounded in current code and historical lineage rather than in diagram-first redesign.

## When to use

Use for bounded-context/module boundaries, framework replacement, dependency inversion, platform/security architecture, large refactoring strategy, or governance decisions affecting future work.

## Route

`research(current + lineage) → model → design(alternatives) → adversarial review → plan → incremental work → verify → learn → archive`

`spec`, `map`, and `reconcile` are used when product intent or scope warrants them.

## Artifacts

Research records current topology, callers, ownership, dependency direction, interfaces, seams, adapters, constraints, risks, lineage, and cited evidence without recommending a target. `domain.md` remains authoritative for ownership, lifecycle, invariants, ubiquitous language, and bounded contexts; a code seam is not automatically a bounded context. `spec.md`, when used, records affected callers, observable behavior, preserved constraints, compatibility needs, and decisions deferred to Design.

`design.md` owns the target module-boundary assessment. It declares exactly one applicability level: `not-applicable` for work behind a stable boundary, `focused` for a changed internal interface with stable ownership and wider architecture, or `full` for governance, shared-library, cross-service, migration, new-boundary, ownership/lifecycle, or other P0/P1 boundary decisions. Focused and full assessments use stable `MOD-*`, `IF-*`, `SEAM-*`, and `ADP-*` IDs and cover interface semantics, dependency category and direction, depth, leverage, locality, deletion behavior, enforcement, test surface, migration, and retirement. External HTTP, event, and public-library semantics remain in `contract.md` or their authoritative contract source.

Design compares viable approaches and documents trade-offs. Only hard-to-reverse or surprising trade-offs become ADRs. Plan carries approved module/interface IDs, implementation order, and evidence needs into independently verifiable tasks; it does not create a separate architecture artifact.

## Risk and impact

Default P1 with high reversibility and compatibility concern. Actual data/security/operations impact increases evidence and reviewer lenses.

## Human gates

A human decides difficult-to-reverse architecture and ownership choices. Non-trivial claims should receive a fresh adversarial review rather than a validation-biased “looks good” review.

## Evidence

Historical lineage, the existing `architecture-review` evidence item, characterization tests, operability/compatibility evidence, and project-specific build/performance/security evidence. Refactoring must preserve behavior unless the Change explicitly modifies it. Boundary claims use fresh evidence at the stable interface; static “unused” analysis alone does not prove a safe deletion.

## Reconciliation

If an implementation seam disproves the architecture model, stop and reconcile Design rather than stacking adapters. An L2 signal changes a technical interface, seam, adapter, dependency direction, migration, or interface test-surface assumption; reopen Design and dependent Plan, Work, Review, and Verify artifacts. An L3 signal changes domain ownership, lifecycle, invariant, bounded context, requirement, or acceptance intent; reopen the earliest affected Model or Specification stage and its downstream artifacts. Preserve the previous revision, patch, tests, findings, and evidence as lineage. After repeated failed fix attempts, treat the pattern as architecture evidence.

## Example

Move authorization from a mall aggregate into user-center: inspect why mall ownership arose, identify current quote/order coupling, model proper ownership, compare direct migration vs compatibility facade vs event projection, select one with rollback, and migrate through small reversible slices.

## Exit condition

The chosen architecture is justified by facts/trade-offs, increments remain verifiable, and obsolete architecture debt has an explicit retirement path.
