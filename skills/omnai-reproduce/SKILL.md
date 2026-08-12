---
name: omnai-reproduce
description: Establish deterministic bug reproduction or a concrete instrumentation plan before diagnosis or fixing.
---

# OmnAI Reproduce

1. Run `omnai reproduce "<symptom>"` for the active bug-oriented change.
2. Capture exact preconditions, inputs, environment, expected behavior, actual behavior, and evidence.
3. Prefer the smallest deterministic reproducer; if impossible, define instrumentation that can falsify hypotheses.
4. Update `issue.md` and `issue.yaml`; do not edit production code.
5. Complete only when reproduction is confirmed or an explicit instrumentation route is recorded.
