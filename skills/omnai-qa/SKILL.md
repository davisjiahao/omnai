---
name: omnai-qa
description: Exercise a real application experience, capture reproducible findings, verify fixes, and produce ship-readiness evidence.
---

# OmnAI QA

1. Run `omnai qa "tier:quick|standard|exhaustive mode:report-only|fix"` and read the generated prompt.
2. Test critical user journeys first, then medium and cosmetic issues according to tier.
3. Use the real browser or runtime where available. Record exact steps, screenshots or traces, console/network errors, expected behavior, and actual behavior.
4. In fix mode, make one atomic fix at a time and re-run the failing flow plus relevant regression tests.
5. In report-only mode, never modify source code.
6. Record QA evidence with `omnai verify --record qa --status PASS|FAIL|INCONCLUSIVE --summary "..."`.
