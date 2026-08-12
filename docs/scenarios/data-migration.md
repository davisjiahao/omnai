# Data Migration

Use for schema evolution, backfills, dual writes, data moves, and transformations that can affect durable business state.

## Route

```text
research → data/domain semantics → expand → dual-read/write window → migrate in checkpoints → reconcile → contract old form → verify retirement
```

## Gates

- Source and target semantics are defined, not merely column mappings.
- Compatibility windows and checkpoints are explicit.
- Irreversible steps require approval.
- Rollback, forward-fix, or compensation behavior is stated for every phase.
- Reconciliation checks business invariants, not only row counts.

## Evidence

Record dry runs, checkpoint results, row and domain reconciliation, failure recovery tests, post-migration health, and proof that the old path is no longer used.
