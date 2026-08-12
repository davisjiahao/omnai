# Bug Fix

Use this profile for incorrect behavior, failing tests, regressions, and non-emergency defects.

## Route

```text
reproduce → diagnose → regression guard → focused fix → verify → learn?
```

## Gates

- No fix is proposed before a deterministic reproduction or an instrumentation plan exists.
- Root cause is traced to its source rather than inferred from the visible symptom.
- One hypothesis is tested at a time.
- A behavior-changing fix includes a regression guard.
- Repeated failed fixes trigger architectural review instead of another guess.

## Evidence

Record reproduction, the red/green regression cycle, relevant module tests, and the full repository verification required by project policy.
