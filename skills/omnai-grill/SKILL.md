---
name: omnai-grill
description: Use when a blocking product, domain, scope, ownership, lifecycle, invariant, or acceptance decision is unresolved and must be clarified before work can continue.
---

# OmnAI Grill Entry

This Skill is a thin entry. The canonical Grill method lives in `interaction.grill`; the active capability method lives in its Core-selected repository capability protocol. Do not recreate either method from memory.

## Route and load

1. Run `omnai context --json`.
2. In Workset scope, run `omnai workset next --json`. Continue only when the returned action calls for Grill, then load its ordered `protocolIds` with `omnai protocol show <protocolIds...> --json`.
3. In repository scope, run `omnai next --json`, keep the returned active repository capability protocol, and load it together with `interaction.grill` using `omnai protocol show interaction.grill <protocolIds...> --json`.
4. Execute the loaded bundle only inside the active capability and its owning artifact.
5. Record durable decisions in authoritative artifacts rather than chat, then return control to deterministic routing by running the applicable next --json command again.

## Safety

- Research recoverable facts instead of asking the user to supply repository truth.
- Do not reopen decisions already settled by the active Revision unless new evidence requires Reconcile.
- Do not create a separate stage, Project Change, Workset event, or readiness transition merely because Grill was invoked.
- Do not continue into solution implementation after the blocking decision is resolved.
