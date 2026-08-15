---
name: omnai-brainstorm
description: Use when the desired outcome is clear but two or more materially distinct viable approaches remain and a consequential solution choice is required.
---

# OmnAI Brainstorm Entry

This Skill is a thin entry. The canonical Brainstorm method lives in `interaction.brainstorm`; the active capability method lives in its Core-selected repository capability protocol. Do not recreate either method from memory.

## Route and load

1. Run `omnai context --json`.
2. In Workset scope, run `omnai workset next --json`. Continue only when the returned action calls for Brainstorm, then load its ordered `protocolIds` with `omnai protocol show <protocolIds...> --json`.
3. In repository scope, run `omnai next --json`, keep the returned active repository capability protocol, and load it together with `interaction.brainstorm` using `omnai protocol show interaction.brainstorm <protocolIds...> --json`.
4. Execute the loaded bundle only inside the active capability and its owning artifact.
5. Record the selected approach and consequences in authoritative artifacts, then return control to deterministic routing by running the applicable next --json command again.

## Safety

- Do not use Brainstorm to bypass unresolved product, domain, ownership, lifecycle, acceptance, or scope decisions.
- Do not guess when the decision requires measured evidence; let the loaded protocol route to Experiment.
- Do not create a separate workflow stage, implementation task, or readiness transition merely because Brainstorm was invoked.
- Do not begin implementation from this entry.
