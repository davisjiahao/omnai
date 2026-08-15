---
schemaVersion: 1
id: workset.reentry-interaction
version: 1
kind: workset-action
actions:
  - reenter
---

# Workset Re-entry interaction

Perform the capability and interaction selected by the oldest actionable WRE. The `omnai workset next --json` precedence is authoritative; candidate research and impact decisions may outrank the WRE interaction.

## Method

- Load the ordered protocol IDs returned by Core.
- Use the active capability protocol and, when present, the Grill or Brainstorm interaction protocol.
- Recover the changed decision or evidence for every affected project while preserving unaffected work and already settled decisions.
- Update only the authoritative artifacts owned by the reopened capability.
- Identify semantic project-level `reopenFrom` roots and root Task IDs after the interaction reaches a decision.
- Return to Workset routing before planning or applying anything.

## Safety boundary

The interaction does not expand closures, advance Revision/Baseline, apply code changes, or mark the WRE resolved. It does not skip an older PENDING/DECIDED WRE to resume ordinary implementation.

## Stop conditions

Stop when the changed decision/evidence is sufficiently established to propose per-project Reconcile roots, when a candidate decision is still pending, or when the interaction is blocked by an external decision or missing evidence.
