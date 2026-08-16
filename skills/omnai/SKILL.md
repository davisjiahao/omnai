---
name: omnai
description: Use when starting, resuming, inspecting, changing, explaining, comparing, or visualizing non-trivial engineering work in an OmnAI Workset or repository, including “show me” and unclear-explanation requests.
---

# OmnAI Router

OmnAI Core is the authoritative workflow source. Conversation history is supporting context only. Do not invent parallel workflow state in chat.

## Start from machine context

Run `omnai context --json` and follow the returned scope.

### Workset and Workset-project

1. Run `omnai workset next --json`.
2. Read the returned action and ordered `protocolIds`.
3. When the list is non-empty, run `omnai protocol show <protocolIds...> --json` and execute only that loaded bundle.
4. Return to the deterministic router after the bounded action. Candidate and research-only repositories remain read-only, and a retained inactive Worktree is not writable merely because it is visible.

### Repository

- When the repository is not initialized, explain the explicit `omnai init` choice; never initialize silently.
- When initialized, run `omnai next --json`, read its `protocolIds`, load them through `omnai protocol show <protocolIds...> --json`, and execute only the current capability.
- Create or select a Project Change only when the user explicitly authorizes implementation state.

### None

Do not invent a repository, Workset, registration, Project Change, or path. Explain the missing context and obtain the required explicit choice.

## Explain and Show-me

For an explanation, comparison, visualization, “show me,” or unclear-explanation request, first obtain a fresh Core route with `omnai workset next --json` or `omnai next --json`. A route remembered from chat is not authoritative.

Load `interaction.show-me` before the fresh action protocols:

```text
omnai protocol show interaction.show-me <protocolIds...> --json
```

When there is no current action, load only `interaction.show-me`. Show-me is read-only presentation: it must not create or advance workflow state, and presentation feedback is not approval to mutate engineering artifacts.

## Boundaries

- Facts come from code, configuration, Git, approved artifacts, and fresh evidence.
- Core-selected protocols guide judgment; Core owns transitions, guards, closures, and persistence.
- Do not bypass an older Workset action or a repository readiness gate.
- Completion claims require fresh verification evidence for the active Revision.
- Never simulate execution primitives that Core has not exposed.
