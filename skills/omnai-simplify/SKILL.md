---
name: omnai-simplify
description: Simplify an implemented diff without changing behavior before independent review.
---

# OmnAI Simplify

1. Work only on the active task's diff and preserve observable behavior.
2. Remove accidental complexity, duplication, dead branches, and unnecessary abstractions only when safe.
3. Do not expand scope or redesign unrelated code.
4. Re-run relevant verification and record fresh evidence.
