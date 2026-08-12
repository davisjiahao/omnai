# Security-sensitive Change

Use for authentication, authorization, secrets, encryption, PII, trust boundaries, or privileged operations.

## Route

```text
current-state research → threat and domain model → security requirements → defensive design → adversarial review → implementation → independent verification
```

## Gates

- Assets, actors, trust boundaries, threats, and abuse cases are explicit.
- Privilege and data exposure changes require approval.
- Safe defaults and least privilege are mandatory.
- Security review uses independent context and evidence.
- Findings are reconciled rather than blindly accepted or ignored.

## Evidence

Require security-focused tests, threat review, dependency and secret scanning where applicable, and runtime or manual verification of critical controls.
