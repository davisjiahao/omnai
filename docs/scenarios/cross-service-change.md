# Cross-service Change

Use when a change crosses service ownership, API contracts, events, shared data, or deployment boundaries.

## Route

```text
dependency research → domain ownership → contract spec → rollout design → dependency-ordered tasks → compatibility verification → progressive release
```

## Gates

- All known producers, consumers, owners, and environments are mapped.
- Contract evolution and backward compatibility are explicit.
- Rollout and rollback order is part of the design, not an afterthought.
- Each service can be verified independently before end-to-end integration.

## Evidence

Require consumer-impact analysis, contract tests, integration tests, rollout evidence, and post-release runtime health.
