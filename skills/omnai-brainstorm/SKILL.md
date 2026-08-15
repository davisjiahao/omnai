---
name: omnai-brainstorm
description: Use when the desired outcome is clear but two or more materially distinct viable approaches remain and a consequential solution choice is required.
---

# OmnAI Brainstorm

Start with `omnai context --json`, then read the current Router action, constraints, research, and authoritative intent. Brainstorm compares solutions after the problem meaning is sufficiently clear; it does not replace Grill.

## Entry conditions

Use this protocol only when two or more materially distinct viable approaches remain. State the fixed constraints and evaluation criteria before proposing options.

## Comparison protocol

1. Keep the option set small and genuinely different; do not present cosmetic variants as alternatives.
2. For each option, explain architecture or interaction shape, affected projects/contracts/data, migration and rollback behavior, operational cost, verification burden, and important failure modes.
3. Compare the options against the same constraints and evaluation criteria.
4. Recommend one option and state why its tradeoffs are preferable in this context.
5. Record rejected options and the reason for rejection so a later requirement change can reopen the correct decision.
6. When reasoning cannot choose safely because the answer depends on latency, compatibility, feasibility, UX behavior, or another measurable fact, stop and route to an OmnAI experiment rather than guessing.
7. If comparison exposes a genuine upstream ambiguity in product outcome, domain meaning, ownership, lifecycle, or scope, stop and route to Grill.

## Close the interaction

Record the selected approach in the artifact owned by the active capability, including assumptions and consequences. Then return control to `omnai workset next --json` in Workset scope or `omnai next` in repository scope.
