---
name: omnai-fix
description: Turn confirmed root-cause evidence into the smallest focused, regression-guarded fix strategy.
---

# OmnAI Fix

1. Read `issue.md`, `issue.yaml`, current research, and any experiment results.
2. Refuse to proceed when root cause is not confirmed. Use `omnai guard edit` as the hard check before implementation.
3. Run `omnai fix "<fix intent>"` and update `fix.md` with the root cause addressed, chosen fix, rejected alternatives, scope, compatibility impact, regression guard, and rollback/recovery.
4. Keep the fix surgical. Do not mix unrelated cleanup or opportunistic refactoring into a defect fix.
5. If the fix changes a public contract, persistent data, domain semantics, or architecture, emit a reconcile signal and return to the appropriate upstream capability.
6. Convert the approved fix into tasks, then execute through `omnai work` and fresh verification evidence.
