---
name: omnai
description: Use when starting, resuming, inspecting, or changing non-trivial engineering work in an OmnAI Workset or repository.
---

# OmnAI Router

OmnAI Core is the workflow source of truth. Conversation history is supporting context, not authoritative workflow state. Do not invent parallel workflow state in chat.

## Always begin with context

Run `omnai context --json`:

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

## Explain / Show-me protocol

Use this read-only presentation mode when the user asks for an explanation, comparison, visualization, “show me”, or says they do not understand.

- Lead with the conclusion and explain the idea in plain language before formal terminology.
- On first use, define a specialized term or acronym briefly and retain its canonical term for precision and search.
- Match depth to the user's demonstrated familiarity in the current domain; expertise in another domain does not transfer automatically.
- Use short sentences, concrete nouns, observable outcomes, trade-offs, and user impact.
- Choose the smallest useful representation: prose for a simple answer, a table for an exact comparison or mapping, and Mermaid for a flow, hierarchy, state transition, dependency, or multi-project relationship.
- Use a richer host-native visual only when it is available, materially clearer, and technically accurate. Keep a textual takeaway and skip decorative visuals.
- Preserve canonical names, evidence references, assumptions, and edge cases. State unknowns instead of guessing.
- Do not create a Project Change, advance readiness, or modify canonical artifacts merely to explain existing information. Missing facts still require the read-only capability selected by OmnAI Core; verified intent conflicts still require Reconcile.

## Boundaries

- Reality comes from code, configuration, Git, and runtime evidence.
- Meaning comes from reviewed domain/product decisions.
- Intent comes from the active Project Change Revision.
- Completion requires fresh verification evidence for the active Revision.
- Do not invoke or simulate `omnai-run`; it is unavailable until Milestone C provides Wave, Claim, and Run Packet primitives.
