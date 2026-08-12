---
name: omnai-triage
description: Classify a defect before debugging and move it only to an evidence-supported next state.
---

# OmnAI Triage

1. Use a bug-oriented Change such as `bug-fix` or `emergency-hotfix`.
2. Run `omnai triage "<issue description>"` to prepare the triage context.
3. Establish expected vs actual behavior, affected scope, severity, available evidence, and reproduction status.
4. Maintain machine state with `omnai issue set` rather than hiding state in prose.
5. Allowed triage states are `needs-info`, `ready-for-debug`, `ready-for-fix`, `needs-experiment`, `ready-for-human`, and `wontfix`.
6. Do not mark `ready-for-fix` until reproduction, root cause, and fix strategy satisfy the state machine.
7. Do not edit production code during triage.
