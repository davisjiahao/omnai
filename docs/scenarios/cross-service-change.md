# Scenario: cross-service-change

## Purpose

Coordinate one behavior change across multiple services while keeping ownership, producer/consumer contracts, rollout ordering, compatibility, and operations explicit.

## When to use

Use when two or more deployable services, shared events/APIs, or team-owned boundaries must change together. For a months-long retirement/migration, use `migration-program`.

## Route

`research → model → spec → contract → design → plan → work → review → verify → ship → learn → archive`

`map`, `reconcile`, and `canary` are optional. `contract.md` is a required conditional artifact.

## Artifacts

Research maps producers/consumers and existing failure paths. `contract.md` records current/target API or event shape, field/error semantics, producers, consumers, compatibility and migration. Design establishes rollout/rollback and task ordering.

## Risk and impact

Default P1. Defaults include backend, API-contract, and remote-service impact; actual change may add DB/MQ/security/observability. Evidence is recalculated accordingly.

## Human gates

Human approval is required for contract-breaking choices, ownership changes, irreversible rollout decisions, and P1 ship readiness. Teams remain owners of their service-specific delivery systems.

## Evidence

Contract tests, consumer-impact analysis, integration tests, runtime health, build/tests, rollback plan, and human approval are typical matrix entries. Event changes also require event-contract evidence.

## Reconciliation

Discovery of an unregistered consumer or incompatible historical producer is normally L2/L3. Reconcile the contract/design and invalidate only tasks/evidence that depended on the old assumption.

## Example

Move authorization lookup from mall to user-center. Research enumerates quote/order consumers; contract defines a compatible user-center API; rollout keeps an adapter during migration; tasks migrate consumers in dependency order; verification proves old/new behavior parity; ship checks approval/rollback/runtime health but leaves actual deployment to company CI/CD.

## Exit condition

All known consumers are compatible, rollout/recovery is explicit, evidence gaps are zero, and delivery gates are satisfied.