---
name: omnai
description: Route engineering work through the repository-local OmnAI workflow. Use when starting, resuming, inspecting, or changing any non-trivial engineering task in a repository initialized with OmnAI.
---

# OmnAI Router

OmnAI is the repository's workflow source of truth. Do not invent a parallel plan in chat.

## Start

1. Run `omnai doctor`.
2. Run `omnai status` if an active change exists; otherwise run `omnai new "<concise title>" --scenario <profile>`.
3. Run `omnai next`.
4. Invoke the matching `omnai-*` skill or command.

## Routing rules

- Read-only code or business question: use `omnai-research` and do not modify source.
- Bug or unexpected behavior: use `omnai-debug`; do not propose a fix before root-cause evidence.
- Domain ambiguity: use `omnai-model` before specification or design.
- Clear feature: use `omnai-spec`, then `omnai-design`, `omnai-plan`, and `omnai-work` as readiness requires.
- A new fact contradicts the active revision: stop affected work and use `omnai-reconcile`.
- Before any completion claim: use `omnai-verify` and cite fresh evidence.

## Facts

Treat these as distinct:

- Reality facts: code, configuration, Git, and runtime evidence.
- Semantic facts: reviewed domain decisions.
- Intent facts: the active change specification.
- Completion facts: fresh verification evidence.

Memory and conversation history are supporting context, not authoritative facts.
