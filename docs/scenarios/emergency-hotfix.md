# Emergency Hotfix

Use when a production defect requires immediate correction but a full feature workflow would delay recovery.

## Route

```text
reproduce → root-cause evidence → smallest reversible fix → focused and smoke verification → release → mandatory follow-up
```

## Gates

- The scope is limited to restoring expected behavior.
- Any waived check is recorded with reason and approver.
- The fix is independently reversible where possible.
- Production health is checked after release.
- Deferred cleanup, broader testing, and root-cause follow-up become explicit tasks rather than disappearing.

## Evidence

Record the symptom, focused regression, smoke tests, release record, production health, waivers, and the mandatory follow-up change or postmortem.
