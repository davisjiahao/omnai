# Scenario: incident-response

## Purpose

Manage a live production incident by separating mitigation, evidence preservation, root-cause correction, recovery verification, and learning.

## When to use

Use for outages, severe degradation, data/security incidents, or broad customer impact requiring active coordination. A single known defect without live operational response can use `emergency-hotfix`.

## Route

`mitigate → preserve timeline/evidence → research/debug → fix → work → verify recovery → independent review → ship/restore → postmortem → learn`

## Artifacts

Research holds incident timeline, affected scope, mitigation and observations. Fix/delivery artifacts separate temporary containment from permanent correction. Evidence captures recovery/runtime health and postmortem.

## Risk and impact

Default P0 with critical business and operational dimensions. Actual security/data impact adds corresponding review and evidence automatically.

## Human gates

Humans control destructive mitigation, production traffic, rollback/forward-fix, customer/compliance communication, and P0 ship approval. OmnAI is the evidence/workflow spine, not incident command authority.

## Evidence

Incident timeline, mitigation result, root-cause evidence, recovery check, production health, relevant regression/smoke tests, approval, and postmortem. Preserve evidence before cleanup where possible.

## Reconciliation

The incident may expose a wrong architecture/domain assumption. Stabilize first; then use L2/L3 reconciliation or a new follow-up Change. Do not rewrite the incident timeline to fit the eventual explanation.

## Example

Quote API error rate spikes after a release. Pause rollout/shift traffic, capture metrics/logs and dependency state, localize failures to a downstream timeout configuration, correct with an approved recovery path, verify business success rate and p95, then document systemic prevention.

## Exit condition

Customer impact is resolved, recovery is evidenced, permanent/follow-up work is tracked, and learning/postmortem is preserved.