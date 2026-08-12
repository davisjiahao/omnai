# Golden Example: Java Authorization Migration

A brownfield Java/Spring migration where `mall-service` historically owns an `AuthorizationRecord` that conflates two business facts:

- `Authorization` — durable permission/consent relationship.
- `AuthorizationUsage` — a per-quote fact that an authorization was consumed.

The destination moves durable ownership to `user-center`, lets `quote-center` own usage, preserves order audit snapshots, and eventually retires the mall path.

This example exercises Reality → Meaning → Intent → Completion plus reconciliation. Historical data disproves REV-0001's one-row/one-usage assumption, so an L3 signal advances `REV-0001/BL-0001` to `REV-0002/BL-0002`, preserves unrelated completed work, supersedes the invalid task, and produces a revised expand/migrate/contract plan.

The evidence is intentionally honest: data reconciliation remains `INCONCLUSIVE`, so `delivery.md` is `BLOCKED` rather than declaring success.
