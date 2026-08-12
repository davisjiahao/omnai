---
name: omnai-reconcile
description: Handle new facts or changed intent during implementation through revisioning, impact analysis, selective invalidation, and safe resume.
---

# OmnAI Reconcile

1. Stop only the work plausibly affected by the new fact; preserve unaffected progress.
2. Classify the signal:
   - L0 implementation detail
   - L1 task plan
   - L2 technical design
   - L3 domain or requirement
   - L4 product goal or scope
   - L5 delivery or production constraint
3. Gather evidence and identify root affected tasks.
4. Run `omnai reconcile --level <L0-L5> --type <TYPE> --reason "..." --task <TASK...>`.
5. Review the generated revision and statuses: UNAFFECTED, STALE, NEEDS_REVALIDATION, INVALIDATED, or SUPERSEDED.
6. Revise only the earliest invalid artifact, then regenerate downstream artifacts as `omnai next` requests.
7. Never overwrite or erase the previous revision. Resume unaffected tasks only after the new active revision is coherent.
