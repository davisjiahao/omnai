---
schemaVersion: 1
id: interaction.grill
version: 2
kind: interaction
interaction: grill
---

# Grill

Use Grill when product outcome, domain meaning, scope, ownership, lifecycle, invariants, acceptance rules, or non-goals are still blocking the current capability.

## Route modes

### Repository Decision mode

Operate on only the first Core-routed blocking `HUMAN` DecisionRecord in `decisionIds`. That ID and the current repository capability protocol are the complete work boundary for this mode. If the routed record is missing, no longer blocking, or no longer human-owned, return to the fresh Core route instead of choosing another record.

### Workset Re-entry mode

When the ordered bundle begins with `workset.reentry-interaction`, operate on the current `WRE-*` Re-entry ID and its affected projects. A Workset Re-entry route has no repository `decisionIds`, does not require or create a Project DecisionRecord, and never runs `omnai decision resolve`. Preserve the WRE identity and hand the clarified premise to the remaining ordered Workset bundle.

## Decision Frontier

Identify the smallest Decision Frontier: the minimum unresolved decision set that prevents safe progress. Ground every question in current research, code facts, and the active Revision. Preserve decisions already settled by the active Revision; do not reopen settled decisions merely to explore more possibilities.

## Method

1. Separate facts that can be recovered through read-only research from decisions that require the user or domain owner. Recover the facts before asking.
2. Ask one high-leverage question at a time about the one routed target: the DecisionRecord in Repository Decision mode or the current WRE in Workset Re-entry mode.
3. Explain why the answer matters and make the important choices and consequences concrete.
4. Prefer bounded options when the real alternatives are known, while leaving room for the user to correct the framing.
5. Follow dependencies between decisions. Do not ask a downstream question whose prerequisites are unresolved.
6. Finish through the active mode. In Repository Decision mode, create the strict resolution input for the same decision ID and run `omnai decision resolve <decision> <resolution-file> --human-confirmed --json`. In Workset Re-entry mode, keep the result under the current WRE and continue only through its ordered bundle; do not synthesize a `DEC-*` record.
7. Return to the matching fresh router after that one bounded action: `omnai next --json` for a repository or `omnai workset next --json` for a Workset.

## Repository Decision resolution input

Copy this strict file shape for a human-confirmed Repository Decision resolution; replace the example values with facts for the routed decision.

<!-- grill-decision-resolution-input -->
```yaml
optionId: OPT-01
summary: The domain owner confirmed consent records are owned by the consent service.
authority: HUMAN_CONFIRMED
sourceRefs:
  - kind: artifact
    ref: domain.md#consent-ownership
    contentHash: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

## Routing boundaries

Grill resolves meaning and intent. It does not compare technical implementations merely because several implementations exist. Once the desired outcome is clear and two or more materially different solutions remain viable, return control to OmnAI routing and use Brainstorm.

When a verified fact conflicts with the active baseline, route the contradiction through Reconcile rather than silently rewriting intent. When measured evidence is required, route to Experiment.

The FlowPlan and DecisionRecord are Core-owned routing state. Never edit the FlowPlan or DecisionRecord directly, and never advance implementation from Grill. The active repository capability may later explain the resolved `DEC-*` reference in its own output.

## Stop conditions

Stop and return control to OmnAI routing when the Decision Frontier is resolved, when read-only research is required before another question, when the user must make an external decision, or when a contradiction requires Reconcile.
