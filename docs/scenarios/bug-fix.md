# Scenario: bug-fix

## Purpose

Fix a defect by proving the symptom and root cause before touching production code, then make the smallest regression-guarded correction.

## When to use

Use for incorrect behavior, exceptions, regressions, failing tests, unexpected state, or integration defects. Do not use a feature workflow simply because the eventual fix adds code.

## Route

`triage → reproduce → debug → experiment? → fix → plan → work → verify → review → learn?`

Machine triage states are `needs-info`, `ready-for-debug`, `ready-for-fix`, `needs-experiment`, `ready-for-human`, and `wontfix`. `omnai guard edit` blocks implementation until reproduction, root cause, and fix strategy are ready.

## Artifacts

`issue.md` is the human investigation narrative; `issue.yaml` is machine state. `fix.md` holds the confirmed root cause, chosen correction, rejected alternatives, regression guard, scope, compatibility impact, and recovery. `experiments/` is used only when the solution is uncertain.

## Risk and impact

Default P2; actual risk can be raised. API/data/security/operational impact expands evidence and review requirements automatically.

## Human gates

A human is needed when reproduction or semantics cannot be resolved from available evidence, when the confirmed root cause invalidates the intended behavior, or when a high-risk fix changes architecture/contracts/data.

## Evidence

Required evidence begins with reproduction and root-cause evidence, then a regression test/guard and the relevant full test/build/integration evidence. “Agent says fixed” is never evidence.

## Reconciliation

If debugging proves the specification, domain model, or design assumption wrong, emit L2/L3 reconciliation instead of patching around the contradiction. Reconciliation creates a new revision/baseline and selectively invalidates downstream tasks.

## Example

Bug: duplicate quote results after callback retry. Triage confirms affected requests; reproduction produces two callbacks; debug traces idempotency key generation and proves it changes between retry attempts. If the fix choice is unclear, compare storage-level uniqueness vs stable request key in `experiment`. Select the minimal fix, add a regression test that fails before the fix, verify the suite, then independently review concurrency and compatibility.

## Exit condition

Original symptom is reproducibly gone, the regression guard proves the root cause path, required evidence passes, and review has no load-bearing unresolved finding.