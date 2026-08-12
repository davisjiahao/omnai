---
name: omnai-verify
description: Require fresh evidence before any claim that work is complete, fixed, passing, safe, or ready to release.
---

# OmnAI Verification

No completion claim is allowed without fresh evidence from the tree being evaluated.

1. Identify the exact command or observation that proves each claim.
2. Run the full command now; do not rely on an earlier run or an executor report.
3. Read exit status, failures, warnings, and full relevant output.
4. Verify acceptance criteria line by line, not merely that tests are green.
5. Record PASS, FAIL, or INCONCLUSIVE evidence with `omnai verify` or `omnai verify --record ...`.
6. If evidence fails, state the actual status and return to diagnosis, work, or reconcile as appropriate.
7. Only after evidence is recorded may a task be marked verified or a change archived.
