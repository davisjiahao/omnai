---
schemaVersion: 1
id: interaction.brainstorm
version: 1
kind: interaction
interaction: brainstorm
---

# Brainstorm

Use Brainstorm only after the desired outcome and upstream meaning are sufficiently clear and two or more materially distinct viable approaches remain.

## Method

1. State the fixed constraints, decision criteria, and evidence already available.
2. Present a small set of genuinely distinct approaches. Do not disguise cosmetic variations as alternatives.
3. For each approach, explain its architecture or interaction shape, affected projects and contracts, data or migration implications, rollout and rollback behavior, operational cost, verification burden, and important failure modes.
4. Compare every option against the same criteria.
5. Recommend one option and explain why its trade-offs are preferable in the current context.
6. Record the selected approach, assumptions, consequences, and rejected alternatives in the artifact owned by the active capability.
7. Return control to OmnAI routing after the decision is recorded.

## Escalation

When reasoning alone cannot choose safely because the answer depends on latency, compatibility, feasibility, user behavior, or another measurable fact, route to Experiment rather than guessing.

When the comparison exposes a genuine upstream ambiguity in product outcome, domain meaning, ownership, lifecycle, invariant, acceptance rule, or scope, stop and route the work back to Grill. When new verified facts invalidate the active baseline, route the contradiction through Reconcile.

## Stop conditions

Stop when one approach is explicitly selected, when Experiment is required, when Grill must resolve an upstream ambiguity, or when Reconcile must process a changed baseline. Do not begin implementation from the Brainstorm interaction itself.
