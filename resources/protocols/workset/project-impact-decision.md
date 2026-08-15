---
schemaVersion: 1
id: workset.project-impact-decision
version: 1
kind: workset-action
actions:
  - decide-project-impact
---

# Project impact decision

Decide whether completed read-only research proves that the project needs modification for the Workset objective.

## Outcomes

- `OBSERVED_ONLY`: the project is relevant context but requires no code or configuration change. Record the evidence and create no writable Worktree.
- modification required: explain the concrete required responsibility, then obtain explicit confirmation before binding or creating a Project Change.

## Method

1. Summarize the load-bearing evidence and the smallest project responsibility implied by the Workset objective.
2. Separate confirmed impact from speculative adjacency.
3. Present the two outcomes and their consequences.
4. When modification is required, load the `workset.project-change-binding` protocol and inspect existing Change candidates before any write activation.

## Safety boundary

The impact decision itself does not create a Worktree, Project Change, or binding. Do not infer consent from research activity, an existing `activeChange`, or the presence of a related branch.

## Stop conditions

Return control to OmnAI routing after the member becomes `OBSERVED_ONLY` or after the user gives explicit confirmation to proceed through project-change-binding.
