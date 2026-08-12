# Technical Design — REV-0002

Use expand → migrate → contract.

1. Expand user-center with durable Authorization table/API.
2. Expand quote-center with AuthorizationUsage keyed by authorization + quote execution.
3. Add temporary compatibility facade and dual telemetry from mall.
4. Backfill durable authorizations; infer usages only when evidence is unambiguous. Quarantine ambiguous history.
5. Migrate quote/order consumers in batches.
6. Cut lifecycle authority to user-center, observe, then contract mall ownership.

REV-0001 planned a simple one-row → one-authorization + one-usage transformation. Historical sampling disproved it. REV-0002 models zero/many usages explicitly.

Old data remains intact until reconciliation passes. During the observation window durable reads can route through the compatibility facade; destructive schema removal happens only in the final contract task.

Observe old/new mismatch, usage idempotency conflicts, quote success/error/p95, legacy calls, and quarantine count.
