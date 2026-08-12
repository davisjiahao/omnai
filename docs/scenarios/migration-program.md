# Migration Program

Use for multi-change, long-running work such as service extraction, platform replacement, or system retirement.

## Route

```text
destination → decision map → research/model tickets → bounded changes → migration verification → old-path retirement → retrospective
```

## Gates

- The destination, non-goals, and retirement criteria are explicit.
- Unknowns remain in fog until they can be stated as precise questions.
- Program decisions are separated from implementation tickets.
- Each bounded change has its own revision, evidence, and rollback posture.
- Old paths are removed only after consumers and data are proven migrated.

## Evidence

Maintain a dependency map, decision history, compatibility window, reconciliation reports, rollout metrics, and retirement proof.
