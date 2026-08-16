---
schemaVersion: 1
id: common.authoritative-work
version: 1
kind: common
---

# Authoritative OmnAI Work

## Facts and state

- Treat code, configuration, approved artifacts, Git history, and fresh evidence as facts.
- Treat conversation memory as supplementary context, never as the source of truth.
- Do not silently change upstream intent. Surface conflicts as an OmnAI Reconcile signal.
- Stay within the declared capability. Do not begin a later capability automatically.
- Preserve evidence references and distinguish confirmed facts from assumptions.

## Communication contract

- State the practical result or meaning before implementation detail.
- Prefer ordinary wording whenever it is equally precise.
- When a specialized term is necessary, define it briefly on first use and retain its canonical name for precision and search.
- Never weaken an exact contract, evidence claim, safety rule, edge case, or unknown merely to simplify the wording.
