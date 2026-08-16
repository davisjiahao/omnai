---
schemaVersion: 1
id: workset.candidate-research
version: 1
kind: workset-action
actions:
  - inspect-project
---

# Candidate project research

Research the registered original repository read-only before deciding whether it belongs in the writable Workset scope.

## Method

- Use the registered project path returned by OmnAI; do not substitute a similarly named checkout.
- Recover current code facts, ownership, contracts, data flow, deployment boundaries, and relevant historical constraints.
- Trace how the Workset objective could affect the project and identify evidence for both impact and non-impact.
- Record facts, assumptions, unknowns, and exact code references in the current research context.
- Do not propose a writable solution before the impact decision.

## Safety boundary

Do not create a Worktree or Project Change, edit the original repository, bind a Change, change member status beyond the authorized research transition, or treat conversation memory as repository truth.

## Stop conditions

Return control to `omnai workset next --json` when enough evidence exists to decide `OBSERVED_ONLY` versus modification required, or when missing access/evidence blocks the decision.
