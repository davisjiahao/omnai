---
name: omnai-reconcile
description: Use when a new fact, changed requirement, changed constraint, or failed assumption may invalidate an active Workset or Project Change baseline.
---

# OmnAI Reconcile Entry

OmnAI Core is the authoritative Reconcile state machine. This Skill detects the need to reconcile, loads the canonical protocols, and preserves non-bypassable safety boundaries; it does not restate the full lifecycle in chat.

## Route and load

1. Run `omnai context --json`.
2. Before recording a new Workset Re-entry, load the classification guidance with `omnai protocol show workset.reentry-classification --json`.
3. After the event is recorded, repeatedly run `omnai workset next --json`, read its ordered `protocolIds`, and load them with `omnai protocol show <protocolIds...> --json`. The Core-selected route is authoritative.
4. In ordinary repository scope, load `repository.reconcile` with `omnai protocol show repository.reconcile --json`, then use the deterministic repository Reconcile command and inspect its resulting Revision, Baseline, affected readiness, tasks, and evidence needs.
5. Return to the applicable Core router after every bounded action.

## Safety

- Preserve unaffected work and all previous Revision, Baseline, attempt, and Evidence history.
- Never silently bind or rebind a Workset project to a Project Change, and never activate a candidate before read-only impact research and explicit confirmation.
- Do not manually expand any Readiness or Task closure. Propose only semantic roots; Core calculates the closure.
- Obtain explicit user approval before any decide transition freezes a project plan.
- Never use direct resolve for a schema-v2 WRE.
- Use the explicit replan route for a stale precondition; never refresh a frozen application silently.
- Chat is not durable Reconcile state, and a presentation or discussion is not approval to mutate it.
