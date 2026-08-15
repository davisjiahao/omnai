---
name: omnai-grill
description: Use when a blocking product, domain, scope, ownership, lifecycle, invariant, or acceptance decision is unresolved and must be clarified before work can continue.
---

# OmnAI Grill

Start with `omnai context --json`, then read the current Router action, research evidence, and authoritative artifacts. Grill is an interaction protocol inside the blocked capability; it is not a new universal stage.

## Decision Frontier

Identify the smallest Decision Frontier: the minimum unresolved decision set that blocks the current capability. Ground it in concrete evidence and state why downstream work cannot proceed safely without an answer.

## Questioning protocol

1. Preserve decisions already settled by the active Revision. Do not reopen settled decisions merely to explore alternatives.
2. Ask one question at a time.
3. Prefer a concrete choice with consequences over a broad invitation such as “What do you want?”.
4. Distinguish decisions that require the user/domain owner from facts that can be recovered through read-only research.
5. Cover only the relevant dimensions, such as product outcome, domain meaning, scope, ownership, lifecycle, invariant, user role, non-goal, or acceptance rule.
6. When an answer exposes another blocking decision, explain the dependency before asking it.
7. Stop when the blocked capability has enough coherent decisions to continue; do not keep questioning for completeness alone.

## Close the interaction

- Summarize the accepted decision, rejected alternatives, constraints, and unresolved follow-ups.
- Record the result in the artifact owned by the active capability rather than leaving it only in chat.
- Return control to the deterministic Router by running `omnai workset next --json` in Workset scope or `omnai next` in repository scope.
- If the outcome is clear but multiple implementation approaches remain, route to OmnAI Brainstorm instead of extending Grill into solution design.
