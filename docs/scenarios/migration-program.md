# Scenario: migration-program

## Purpose

Manage a long-running, high-risk migration where the full path cannot be known up front and multiple Changes must converge on a destination while old paths are retired safely.

## When to use

Use for service retirement, ownership transfer, monolith decomposition, platform replacement, multi-quarter API migration, or broad compatibility-debt removal.

## Route

`frame(destination) → map(frontier/fog) → research + model decision work → spec/design/plan per bounded Change → work/review/verify/ship → retirement → learn/archive`

The Wayfinder-style map is intentionally incomplete: precise known questions become frontier/blocked decisions; unknowable future decisions remain fog.

## Artifacts

`intent.md` fixes destination and out-of-scope. `map.yaml` tracks decisions/frontier/fog. Research includes historical lineage. Domain/spec/design/task artifacts are produced per bounded Change. Retirement criteria and delivery evidence prove old paths can disappear.

## Risk and impact

Default P0 with critical business/compatibility/operational dimensions. Typical impact includes backend, contracts, DB, remotes, and observability. Rehearsal/dry-run and explicit approval become evidence requirements where applicable.

## Human gates

Destination, major domain ownership, irreversible migrations, scope reductions, retirement, and P0 delivery require human decisions. Agents should not force a detailed six-month plan through today’s fog.

## Evidence

Dependency/consumer maps, historical lineage, compatibility checks, migration reconciliation, rollback/forward-fix capability, runtime metrics, and retirement proof. Each child Change still carries its own evidence matrix.

## Reconciliation

Reconciliation is expected, not exceptional. Newly surfaced facts update the map, promote fog into decisions, create/revise child Changes, and preserve completed work that remains valid. Never reset the whole program because one assumption changed.

## Example

Retire `mall-service`: destination is zero production traffic and no authoritative mall data. Frontier includes authorization ownership and MOT query consumers; unknown offline jobs stay fog. Child Changes build user-center auth, dual-read/write, migrate quote/order consumers, reconcile data, then contract/delete old paths. Each phase proves its own safety before the retirement gate.

## Exit condition

Destination is achieved, compatibility bridges/flags/old stores are retired, and evidence shows no remaining required consumer.