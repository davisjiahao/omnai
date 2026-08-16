# Reconcile: Development Changes Without Restarting Everything

Real development is not linear. Implementation, tests, review, or production can reveal that an earlier assumption was wrong. OmnAI treats that discovery as a signal, not as workflow failure.

## Levels

| Level | Meaning | Typical response |
| --- | --- | --- |
| L0 | Implementation detail | Adjust or revalidate a task |
| L1 | Task plan | Rebuild the affected task subtree |
| L2 | Technical design | Revise design and regenerate downstream tasks |
| L3 | Domain or requirement | Revisit model/spec, then design and plan |
| L4 | Product goal or scope | Reframe the change or create a new change |
| L5 | Delivery or production constraint | Revise release, rollback, or environment plan |

## Selective invalidation

A new revision does not mark everything obsolete. Tasks can become:

- `UNAFFECTED` — still valid under the new revision.
- `STALE` — created from older input and requires inspection.
- `NEEDS_REVALIDATION` — completed work may still be correct but its evidence no longer proves the active revision.
- `INVALIDATED` — the active revision explicitly contradicts the task or its output.
- `SUPERSEDED` — another task or artifact replaces it.

OmnAI starts from explicitly affected tasks and follows dependency edges to downstream tasks. Completed tasks become `NEEDS_REVALIDATION`; uncompleted tasks may become `STALE` or `INVALIDATED` depending on severity.

## Example

```text
Domain v1: AuthorizationRecord represents authorization
Task A: logging infrastructure       DONE
Task B: authorization table          DONE
Task C: repository                   RUNNING

New fact: AuthorizationRecord mixes durable consent and quote usage
```

A level-L3 reconcile can preserve Task A, mark Task B `NEEDS_REVALIDATION`, invalidate Task C, create `REV-0002`, and mark model/spec/design/plan readiness for revision. The previous revision remains available for audit.

## Command

```bash
omnai reconcile \
  --level L3 \
  --type DOMAIN_ASSUMPTION_INVALIDATED \
  --reason "AuthorizationRecord mixes durable consent and quote usage" \
  --task TASK-002
```

After reconciliation, `omnai next` points to the earliest invalid or stale capability. Only after downstream artifacts are coherent does implementation resume.
