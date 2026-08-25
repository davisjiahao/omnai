---
name: omnai-reconcile
description: Use when a new fact, changed requirement, changed constraint, or failed assumption may invalidate an active Workset or Project Change baseline.
---

# OmnAI Reconcile Entry

OmnAI Core is the authoritative Reconcile state machine. This Skill detects the need to reconcile, loads the canonical protocols, and preserves non-bypassable safety boundaries; it does not restate the full lifecycle in chat.

## Route and load

1. Run `omnai context --json`.
2. In Workset scope, run a fresh `omnai workset next --json`. When it returns an existing `reentryId`, load exactly and only that route's ordered `protocolIds`. When a new signal needs a new WRE and no current routed `reentryId` represents it, load `workset.reentry-classification` immediately before the Core `omnai workset change` record action, then return to fresh Workset routing.
3. In repository scope, run a fresh `omnai next --json`. Retain its `decisionIds`, ordered `protocolIds`, Revision, Baseline, and `flowHash` as one exact route snapshot. Continue only when the loaded bundle contains `repository.reconcile`.
4. Load only the current ordered bundle with `omnai protocol show <protocolIds...> --json`, then prepare the one Core mutation authorized by it.

## Mutation slot

1. Before the mutating response, obtain a fresh route with the same applicable `next --json` command.
2. For a repository route, exactly compare Revision, Baseline, `flowHash`, `decisionIds`, and ordered `protocolIds` with the retained snapshot. For a Workset route, exactly compare its action identity, project or Re-entry ID, and ordered `protocolIds`. If any field differs, discard the pending mutation and load the new route.
3. Apply one Core mutation selected by the loaded bundle. For a repository `repository.reconcile` route carrying `decisionIds`, run `omnai decision resolve <decision> <resolution-file> ... --json` as the entry to Core's guarded Decision-Reconcile transaction; Core must create the new Revision/Baseline and legal invalidation closure before it records the resolution, never as a standalone same-Revision resolve. Use `omnai flow assess` for an assessment change, or the deterministic repository/Workset Reconcile command selected by the bundle.
4. After one bounded action, return to the applicable `next --json` command and consume only its current ordered protocols.

## Safety

- Preserve unaffected work and all previous Revision, Baseline, attempt, and Evidence history.
- Never silently bind or rebind a Workset project to a Project Change, and never activate a candidate before read-only impact research and explicit confirmation.
- Do not manually expand any Readiness or Task closure. Propose only semantic roots; Core calculates the closure.
- Obtain explicit user approval before any decide transition freezes a project plan.
- Never use direct resolve for a schema-v2 WRE.
- Use the explicit replan route for a stale precondition; never refresh a frozen application silently.
- Chat is not durable Reconcile state, and a presentation or discussion is not approval to mutate it.
