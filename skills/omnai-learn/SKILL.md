---
name: omnai-learn
description: Promote one verified engineering learning into durable, discoverable project knowledge with scope and invalidation conditions.
---

# OmnAI Learning

1. Run `omnai learn "<one solved problem>"` and read the generated prompt.
2. Capture exactly one learning per run.
3. Ground it in the originating change, code, review, and verification evidence.
4. State problem, context, root cause, solution, verification, applicability, limitations, and what would make the learning stale.
5. Keep temporary observations in change history; do not promote guesses or one-off implementation details.
6. Update `learning.md` and run `omnai learn --complete`.
7. Promote into `.omnai/project/learnings.md`, glossary, policy, or ADR only after review and explicit approval.
