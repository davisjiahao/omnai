# Scenario: architecture-governance

## Purpose

Evolve architecture or domain boundaries deliberately, grounded in current code and historical lineage rather than in diagram-first redesign.

## When to use

Use for bounded-context/module boundaries, framework replacement, dependency inversion, platform/security architecture, large refactoring strategy, or governance decisions affecting future work.

## Route

`research(current + lineage) → model → design(alternatives) → adversarial review → plan → incremental work → verify → learn → archive`

`spec`, `map`, and `reconcile` are used when product intent or scope warrants them.

## Artifacts

Research explains present seams and why they exist. `domain.md` clarifies ownership/boundaries. Design compares viable approaches and documents trade-offs. Only hard-to-reverse/surprising trade-offs become ADRs.

## Risk and impact

Default P1 with high reversibility and compatibility concern. Actual data/security/operations impact increases evidence and reviewer lenses.

## Human gates

A human decides difficult-to-reverse architecture and ownership choices. Non-trivial claims should receive a fresh adversarial review rather than a validation-biased “looks good” review.

## Evidence

Historical lineage, architecture review, characterization tests, operability/compatibility evidence, and project-specific build/performance/security evidence. Refactoring must preserve behavior unless the Change explicitly modifies it.

## Reconciliation

If an implementation seam disproves the architecture model, stop and reconcile design rather than stacking adapters. After repeated failed fix attempts, treat the pattern as architecture evidence.

## Example

Move authorization from a mall aggregate into user-center: inspect why mall ownership arose, identify current quote/order coupling, model proper ownership, compare direct migration vs compatibility facade vs event projection, select one with rollback, and migrate through small reversible slices.

## Exit condition

The chosen architecture is justified by facts/trade-offs, increments remain verifiable, and obsolete architecture debt has an explicit retirement path.