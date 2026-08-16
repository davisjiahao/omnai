# Scenario: quality-hardening

## Purpose

Increase confidence in existing code without inventing new product scope: strengthen tests, review risky areas, exercise QA, and close evidence gaps.

## When to use

Use before a risky release, after a fast implementation, when coverage/operability confidence is weak, or when a component needs stabilization rather than new features.

## Route

`research(scope/contract) → review → qa? → verify → fix bounded findings? → learn`

`plan`, `work`, and `reconcile` are optional when findings require code changes.

## Artifacts

`research.md` establishes what behavior is supposed to remain stable and which surfaces are in scope. Review/evidence files capture findings and proof. A separate Change intent is not expanded with unrelated improvements.

## Risk and impact

Default P2; actual impact/risk derives from the hardened component. Security/data/public-contract areas automatically gain stronger lenses/evidence.

## Human gates

Ask for a product/behavior decision only when the expected contract is genuinely ambiguous. Do not “improve” behavior under a quality label.

## Evidence

Independent review, tests, QA where user-facing, build/type/lint, security/contract/data/runtime checks according to impact. Findings are prioritized by contract/risk, not cosmetic preference.

## Reconciliation

A finding that proves the existing spec/design is wrong becomes a reconcile signal; it is not silently fixed as hardening. Pure implementation defects can stay local.

## Example

Before releasing a heavily AI-generated quote feature, hardening maps acceptance criteria to tests, runs contract/data review, browser QA, and adds missing regression cases. A discovered domain contradiction is escalated to reconciliation instead of patched in validation code.

## Exit condition

The stated behavior has sufficient fresh evidence and no unresolved high-severity review finding.