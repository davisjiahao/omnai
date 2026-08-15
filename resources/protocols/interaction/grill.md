---
schemaVersion: 1
id: interaction.grill
version: 1
kind: interaction
interaction: grill
---

# Grill

Use Grill when product outcome, domain meaning, scope, ownership, lifecycle, invariants, acceptance rules, or non-goals are still blocking the current capability.

## Decision Frontier

Identify the smallest Decision Frontier: the minimum unresolved decision set that prevents safe progress. Ground every question in current research, code facts, and the active Revision. Preserve decisions already settled by the active Revision; do not reopen settled decisions merely to explore more possibilities.

## Method

1. Separate facts that can be recovered through read-only research from decisions that require the user or domain owner.
2. Ask one high-leverage question at a time.
3. Explain why the answer matters and make the important choices and consequences concrete.
4. Prefer bounded options when the real alternatives are known, while leaving room for the user to correct the framing.
5. Follow dependencies between decisions. Do not ask a downstream question whose prerequisites are unresolved.
6. Record accepted decisions, rejected alternatives, constraints, and remaining unknowns in the artifact owned by the active capability.
7. Stop when the current capability has enough coherent decisions to continue; do not keep questioning for completeness alone.

## Routing boundaries

Grill resolves meaning and intent. It does not compare technical implementations merely because several implementations exist. Once the desired outcome is clear and two or more materially different solutions remain viable, return control to OmnAI routing and use Brainstorm.

When a verified fact conflicts with the active baseline, route the contradiction through Reconcile rather than silently rewriting intent. When measured evidence is required, route to Experiment.

## Stop conditions

Stop and return control to OmnAI routing when the Decision Frontier is resolved, when read-only research is required before another question, when the user must make an external decision, or when a contradiction requires Reconcile.
