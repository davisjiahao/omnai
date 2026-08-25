---
schemaVersion: 1
id: interaction.brainstorm
version: 2
kind: interaction
interaction: brainstorm
---

# Brainstorm

Use Brainstorm only after the desired outcome and upstream meaning are sufficiently clear and two or more materially distinct viable approaches remain.

## Route modes

### Repository Decision mode

Operate on exactly one Core-routed DecisionRecord: the first ID in `decisionIds`. It must be an open `SOLUTION` or `ARCHITECTURE` record with at least two options marked `VIABLE`. If that contract no longer holds, return to the fresh Core route rather than creating or selecting another decision.

### Workset Re-entry mode

When the ordered bundle begins with `workset.reentry-interaction`, compare approaches only for the current `WRE-*` Re-entry ID and its affected projects. This route has no repository `decisionIds`, does not require or create a Project DecisionRecord, and never runs `omnai decision resolve`; the WRE and its ordered bundle own the selection and downstream project proposal.

## Method

1. State the fixed constraints, decision criteria, and evidence already available for the routed record.
2. Present a small set of genuinely distinct approaches. Do not disguise cosmetic variations as alternatives.
3. For each approach, explain its architecture or interaction shape, affected projects and contracts, data or migration implications, rollout and rollback behavior, operational cost, verification burden, and important failure modes.
4. Compare every option against the same criteria.
5. Recommend one option and explain why its trade-offs are preferable in the current context.
6. Finish through the active mode. In Repository Decision mode, create the strict resolution input for the same decision ID, present assumptions, consequences, and comparison evidence beside that strict file, then run `omnai decision resolve <decision> <resolution-file> --json`. In Workset Re-entry mode, keep the selection under the current WRE and continue only through its ordered bundle; do not synthesize a `DEC-*` record.
7. Return to the matching fresh router after that one bounded action: `omnai next --json` for a repository or `omnai workset next --json` for a Workset.

## Repository Decision resolution input

Copy this strict file shape for an evidence-backed Repository Decision resolution; replace the example values with facts for the routed decision.

<!-- brainstorm-decision-resolution-input -->
```yaml
optionId: OPT-01
summary: The evidence supports the staged migration approach for the selected option.
authority: AGENT_EVIDENCE
sourceRefs:
  - kind: evidence
    ref: research.md#migration-comparison
    contentHash: sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
```

## Bounded output

### Repository Decision mode

Produce one same-criteria comparison, one recommendation, one strict resolution, one fresh route. Downstream Design artifact production is a separately routed action.

### Workset Re-entry mode

Produce one same-criteria comparison, one recommendation, selection under the current WRE, one fresh Workset route.

## Escalation

When reasoning alone cannot choose safely because the answer depends on latency, compatibility, feasibility, user behavior, or another measurable fact, route to Experiment rather than guessing.

When the comparison exposes a genuine upstream ambiguity in product outcome, domain meaning, ownership, lifecycle, invariant, acceptance rule, or scope, stop and route the work back to Grill. When new verified facts invalidate the active baseline, route the contradiction through Reconcile.

The DecisionRecord remains the durable selection. Never create a second Spec or edit the FlowPlan from Brainstorm; the active repository capability may explain the resolved `DEC-*` reference in its own output.

## Stop conditions

Stop when one approach is explicitly selected, when Experiment is required, when Grill must resolve an upstream ambiguity, or when Reconcile must process a changed baseline. Do not begin implementation from the Brainstorm interaction itself.
