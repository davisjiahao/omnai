---
name: omnai-investigate
description: Run read-only code/system investigations without creating a Change or modifying application source.
---

# OmnAI Investigate

Use one of three investigation kinds:

- `system-query` — locate or explain current code, rules, or ownership.
- `field-lineage` — trace a field through producers, transforms, API/DTO, persistence, events, remote calls, readers, and consumers.
- `business-flow` — recover an end-to-end business path, branches, persistence, events, remote calls, ownership, and failure paths.

Process:

1. Run `omnai investigate create <kind> "<question>"`.
2. Work read-only. Current code and formal project artifacts are primary evidence; history is supplementary.
3. Cite concrete paths and line ranges for load-bearing conclusions. Mark unknown hops as unknown instead of guessing.
4. Do not create a Change and do not modify application source during the investigation.
5. If the user later asks to change behavior, explicitly run `omnai investigate promote <INV-id> "<change title>" --scenario <scenario>` and continue in the resulting Change.
