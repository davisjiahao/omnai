---
name: omnai-debug
description: Reproduce and diagnose bugs, test failures, performance problems, and unexpected behavior before proposing a fix.
---

# OmnAI Debugging

1. Select a bug-oriented scenario: `bug-fix`, `production-incident`, `performance-investigation`, or `emergency-hotfix`.
2. Run `omnai reproduce "<symptom>"`; establish deterministic reproduction or an instrumentation plan.
3. Run `omnai diagnose`; read errors completely, inspect recent changes, trace data across boundaries, and compare working patterns.
4. State one root-cause hypothesis and test the smallest variable that could disprove it.
5. Do not stack guesses. After repeated failed hypotheses, question the architecture and escalate.
6. Add a failing regression guard, implement one focused fix through `omnai work`, and use `omnai verify` before claiming success.
7. Capture a durable learning only when the cause and solution are evidenced.
