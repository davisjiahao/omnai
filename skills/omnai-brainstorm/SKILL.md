---
name: omnai-brainstorm
description: Use when the desired outcome is clear but two or more materially distinct viable approaches remain and a consequential solution choice is required.
---

# OmnAI Brainstorm Entry

This Skill is a thin entry. The canonical Brainstorm method lives in `interaction.brainstorm`; the active capability method lives in its Core-selected repository capability protocol. Do not recreate either method from memory.

## Route and load

1. Run `omnai context --json`.
2. In Workset scope, run a fresh `omnai workset next --json`. Continue only when the returned action calls for Brainstorm, then load only its ordered `protocolIds` with `omnai protocol show <protocolIds...> --json`.
3. In repository scope, run a fresh `omnai next --json`. Retain its `decisionIds`, ordered `protocolIds`, Revision, Baseline, and `flowHash` as one exact route snapshot; load that bundle, which includes `interaction.brainstorm` and the active repository capability protocol.
4. Execute the canonical method only for the first returned decision ID and inside the active capability.

## Repository resolution slot

1. Before the mutating resolve response for a repository DecisionRecord, obtain a fresh route with `omnai next --json`. Workset Re-entry actions instead follow their loaded Workset protocol bundle and return to `omnai workset next --json`.
2. Exactly compare Revision, Baseline, `flowHash`, `decisionIds`, and ordered `protocolIds` with the retained snapshot. If any field differs, discard the pending resolution and load the new route.
3. Resolve the same routed record through Core with `omnai decision resolve <decision> <resolution-file> --json` and the authority flag required by Core.
4. After one bounded action, return to deterministic routing by running the applicable `next --json` command again.

## Safety

- Do not use Brainstorm to bypass unresolved product, domain, ownership, lifecycle, acceptance, or scope decisions.
- Do not guess when the decision requires measured evidence; let the loaded protocol route to Experiment.
- Do not create a separate workflow stage, implementation task, or readiness transition merely because Brainstorm was invoked.
- Do not begin implementation from this entry.
