---
name: omnai-grill
description: Use when a blocking product, domain, scope, ownership, lifecycle, invariant, or acceptance decision is unresolved and must be clarified before work can continue.
---

# OmnAI Grill Entry

This Skill is a thin entry. The canonical Grill method lives in `interaction.grill`; the active capability method lives in its Core-selected repository capability protocol. Do not recreate either method from memory.

## Route and load

1. Run `omnai context --json`.
2. In Workset scope, run a fresh `omnai workset next --json`. Continue only when the returned action calls for Grill, then load only its ordered `protocolIds` with `omnai protocol show <protocolIds...> --json`.
3. In repository scope, run a fresh `omnai next --json`. Retain its `decisionIds`, ordered `protocolIds`, Revision, Baseline, and `flowHash` as one exact route snapshot; load that bundle, which includes `interaction.grill` and the active repository capability protocol.
4. Execute the canonical method only for the first returned decision ID and inside the active capability.

## Repository resolution slot

1. Before the mutating resolve response for a repository DecisionRecord, obtain a fresh route with `omnai next --json`. Workset Re-entry actions instead follow their loaded Workset protocol bundle and return to `omnai workset next --json`.
2. Exactly compare Revision, Baseline, `flowHash`, `decisionIds`, and ordered `protocolIds` with the retained snapshot. If any field differs, discard the pending resolution and load the new route.
3. Resolve the same routed record through Core with `omnai decision resolve <decision> <resolution-file> --human-confirmed --json`.
4. After one bounded action, return to deterministic routing by running the applicable `next --json` command again.

## Safety

- Research recoverable facts instead of asking the user to supply repository truth.
- Do not reopen decisions already settled by the active Revision unless new evidence requires Reconcile.
- Do not create a separate stage, Project Change, Workset event, or readiness transition merely because Grill was invoked.
- Do not continue into solution implementation after the blocking decision is resolved.
