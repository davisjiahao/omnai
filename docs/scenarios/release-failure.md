# Scenario: release-failure

## Purpose

Diagnose and recover from a failed deployment, rollout, activation, or CI/CD promotion without confusing delivery failure with product-code failure.

## When to use

Use for failed deployments, broken canaries, migrations that fail during release, environment-only failures, or rollback/forward-fix decisions after promotion begins.

## Route

`mitigate(pause promotion) → research delivery evidence → debug → reconcile if needed → fix → work → verify environment → review → ship readiness → learn`

## Artifacts

`research.md` captures deployment logs, environment/config differences, artifact identity, rollout state and boundary evidence. `fix.md` records the delivery/root-cause correction. `delivery.md` records recovery/next promotion plan.

## Risk and impact

Default P0 with critical operational and high reversibility risk. Observability impact is on by default.

## Human gates

Production rollback/roll-forward, destructive migration handling, traffic promotion, and final P0 approval are human-controlled or delegated to existing enterprise systems.

## Evidence

Deployment logs, exact artifact/version, rollback or forward-fix result, environment health, smoke/integration checks, and runtime metrics. A green source test suite is insufficient when the failure is environment-specific.

## Reconciliation

If the release exposed a wrong design/migration assumption, reconcile the Change instead of repeatedly editing pipeline scripts. Delivery-only config failures remain local to delivery readiness.

## Example

A canary fails startup because a schema migration was not backward-compatible. Pause promotion, prove old pods still require the old column, reconcile design to expand-before-contract, add compatibility evidence, redeploy the new baseline, then resume canary only after health gates pass.

## Exit condition

Environment is stable, the failure mechanism is understood, recovery/promotion evidence is complete, and no unsafe partial rollout remains.