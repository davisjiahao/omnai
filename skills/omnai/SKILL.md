---
name: omnai
description: Use when starting, resuming, inspecting, or changing non-trivial engineering work in an OmnAI Workset or repository.
---

# OmnAI Router

OmnAI Core is the workflow source of truth. Conversation history is supporting context, not authoritative workflow state. Do not invent parallel workflow state in chat.

## Always begin with context

Run:

```bash
omnai context --json
```

Follow the returned scope exactly.

## Workset or Workset-project scope

1. Run `omnai workset next --json`.
2. Follow the returned action instead of choosing a preferred workflow from memory:
   - `inspect-project`: research the registered original repository read-only.
   - `decide-project-impact`: decide whether the project is `OBSERVED_ONLY` or needs an explicitly confirmed Project Change and Worktree.
   - `reenter` with `interaction: grill`: use the OmnAI Grill protocol.
   - `reenter` with `interaction: brainstorm`: use the OmnAI Brainstorm protocol.
   - `reenter` without an interaction: perform the requested capability and then ask the Router again.
   - `decide-reentry`, `apply-reentry`, `replan-reentry`, or `finalize-reentry`: use the OmnAI Reconcile protocol.
   - `project-workflow`: enter the bound project Worktree and follow repository-local `omnai status` / `omnai next`.
   - `none`: report that no deterministic next action is pending.
3. Candidate and research-only projects remain read-only until explicit activation.
4. A visible inactive Worktree is not writable merely because it is present in the aggregate directory.

## Repository scope

- If `initialized` is false, explain that `omnai init` is an explicit project decision; do not initialize silently.
- If initialized, run `omnai status` and `omnai next`, then execute the returned repository-local capability.
- Create or select a Project Change only after the user's request requires implementation state.

## None scope

Do not create a Workset, register a project, initialize a repository, or invent paths automatically. Explain the missing context and obtain the required explicit choice.

## Boundaries

- Reality comes from code, configuration, Git, and runtime evidence.
- Meaning comes from reviewed domain/product decisions.
- Intent comes from the active Project Change Revision.
- Completion requires fresh verification evidence for the active Revision.
- Do not invoke or simulate `omnai-run`; it is unavailable until Milestone C provides Wave, Claim, and Run Packet primitives.
