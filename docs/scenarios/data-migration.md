# Scenario: data-migration

## Purpose

Move or reshape persistent data safely using explicit compatibility windows, checkpoints, reconciliation, and recovery.

## When to use

Use for schema changes with existing data, backfills, database moves, data ownership migration, dual-write transitions, or type/encoding changes with blast radius.

## Route

`research → model → spec → design(expand/migrate/contract) → review → plan → work → verify → ship → learn → archive`

`map`, `reconcile`, and `canary` are available for larger migrations.

## Artifacts

Research documents current schema/read-write paths and historical constraints. Design defines expand, migration batches, validation checkpoints, compatibility period, cutover, contract/removal, and rollback or forward-fix. Tasks use `EXPAND`, `MIGRATE`, and `CONTRACT` slice types.

## Risk and impact

Default P0 with critical data/reversibility risk and high operational risk. Database/observability impact is on by default. Never treat “migration script ran” as proof of correctness.

## Human gates

Approval is required for irreversible writes/deletes, production cutover, compensation trade-offs, and completion of contract/removal. If rollback cannot restore data, forward-fix/compensation must be explicit.

## Evidence

Dry run/sample rehearsal, row/count/hash/business reconciliation, compatibility tests, backup/recovery evidence, runtime health, and post-migration reconciliation. Performance/lock impact may add benchmark evidence.

## Reconciliation

Unexpected historical row shapes are a design/domain signal, not a reason to silently coerce data. Reconcile the assumption, keep unaffected batches/evidence, revise transformation rules, and resume from a safe checkpoint.

## Example

Split mixed authorization rows into durable `authorization` plus per-quote `authorization_usage`: expand new tables, dual-write, backfill in batches, compare semantic counts and sampled records, switch reads, observe, then contract old columns only after every consumer and reconciliation gate passes.

## Exit condition

All required data is reconciled, active reads/writes use the target model, recovery obligations are satisfied, and old compatibility structures can be safely retired.