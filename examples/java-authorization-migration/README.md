# Example: Move Authorization from a Legacy Mall to User Center

This walkthrough demonstrates Reality, Meaning, Change, Delivery, and Reconcile on a brownfield Java migration.

```bash
omnai init --host claude
omnai new "Move authorization from mall to user center" --scenario migration-program
omnai frame "Destination: user center owns authorization lifecycle and mall can be retired"
omnai map "Find the safe path to retire mall authorization"
omnai research "Map authorization code, tables, callers, data, jobs, tests, and runtime dependencies"
omnai model "Distinguish durable authorization, quote authorization usage, and order authorization snapshots"
omnai spec
omnai design
omnai plan
```

A reasonable domain result might be:

```text
User context
  Authorization         durable relationship and lifecycle

Quote context
  AuthorizationUsage    fact that one quote consumed authorization

Order context
  AuthorizationSnapshot immutable evidence retained with an order
```

During implementation, suppose `TASK-004` discovers that legacy rows cannot reliably distinguish durable authorization from quote usage:

```bash
omnai reconcile \
  --level L3 \
  --type DOMAIN_ASSUMPTION_INVALIDATED \
  --reason "Legacy AuthorizationRecord mixes durable consent and quote usage" \
  --task TASK-004
```

OmnAI creates a new revision, preserves unrelated completed tasks such as tracing infrastructure, marks completed affected data work `NEEDS_REVALIDATION`, invalidates downstream repository and API tasks, and routes back to the earliest stale domain/spec artifact.

The migration is complete only after compatibility, dual-write comparison, data reconciliation, consumer migration, runtime health, and old-path retirement evidence have been recorded.
