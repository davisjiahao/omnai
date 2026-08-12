# Production Incident

Use when users or production systems are actively affected.

## Route

```text
mitigate impact → preserve evidence → diagnose → recover → verify production → postmortem → learn
```

## Gates

- Containment is separated from root-cause correction.
- Reversible mitigation is preferred; side effects and remaining impact are recorded.
- Emergency changes are minimal and require explicit release approval.
- Production recovery is verified with technical and business health signals.
- A postmortem is mandatory even when a hotfix succeeds.

## Evidence

Keep an incident timeline, mitigation record, diagnostic evidence, release record, production health checks, and follow-up actions.
