# Scenario: emergency-hotfix

## Purpose

Restore production safely under time pressure using a reduced but explicit process—not a process-free shortcut.

## When to use

Use when active production impact requires a code/config correction faster than the normal workflow, but the situation is not primarily incident coordination (otherwise start `incident-response`).

## Route

`triage → reproduce → debug → fix → work(minimal) → verify(focused + smoke) → review/waiver → ship → learn/postmortem`

`experiment` is available only if uncertainty cannot be resolved otherwise.

## Artifacts

`issue.md`/`issue.yaml` capture evidence and RCA; `fix.md` limits scope; tasks are minimal; `delivery.md` records approval/recovery/post-release signals. Waived normal gates must be explicitly recorded rather than silently omitted.

## Risk and impact

Default P0 with critical business/operational risk. P0 requires recovery, human approval, and rehearsal/dry-run when feasible.

## Human gates

A human controls emergency scope, waivers, production delivery, and rollback/forward-fix decisions. The agent may not equate urgency with authorization.

## Evidence

Reproduction, focused regression, smoke test, relevant build/tests, runtime/production health, approval, and later postmortem/learning. Evidence can be narrower than normal but not imaginary.

## Reconciliation

If root cause requires a domain/architecture change larger than an emergency correction, stabilize with the minimum safe measure, then open/reconcile into follow-up normal work.

## Example

A production NPE blocks quote submission. Reproduce with the problematic insurer payload, prove a previously non-null field is omitted, add the smallest tolerant parsing/regression fix, run focused + smoke tests, record approval/recovery, ship through company release tooling, then create follow-up contract hardening.

## Exit condition

Production is healthy, the emergency correction is evidenced, waivers/follow-ups are visible, and no untracked temporary workaround remains.