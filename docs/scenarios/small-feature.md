# Scenario: small-feature

## Purpose

Deliver a focused, well-understood feature without dragging it through heavyweight product/domain ceremonies.

## When to use

Use when the desired behavior is clear, scope is local, domain language is stable, and the work can be completed in a few bounded tasks. If several services/contracts change, use `cross-service-change`; if domain meaning is uncertain, use `complex-domain-feature`.

## Route

`spec-lite → design-lite → plan → work → verify → archive`, with `research`, `review`, and `learn` added when risk or uncertainty warrants them.

## Artifacts

`spec.md` defines observable delta requirements/non-goals. `design.md` records only the technical choices that matter. `tasks.yaml` holds independently verifiable slices and evidence requirements.

## Risk and impact

Default P3. Impact can still require contract/browser/data evidence; “small” describes scope, not permission to skip correctness.

## Human gates

Approve only decisions that cannot be safely inferred from code/project policies. A small feature should not ask the user repeated questions about facts the agent can retrieve.

## Evidence

At minimum, fresh build/test evidence appropriate to the affected stack. UI/API/database impact adds corresponding evidence through the matrix.

## Reconciliation

Unexpected scope growth or new semantic/contract facts can promote the work: L2 returns to design; L3 returns to model/spec; cross-service blast radius should switch profile rather than stretching `small-feature` indefinitely.

## Example

Add an internal endpoint that exposes an already-existing quote status. Spec defines response and authorization; design reuses current service/query pattern; a vertical task adds endpoint + test; verification runs module tests/build. If implementation discovers the status has two conflicting domain meanings, stop and reconcile to `complex-domain-feature`.

## Exit condition

Acceptance criteria are evidenced, task DAG is complete, and no hidden scope remains.