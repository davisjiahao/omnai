# Release or Deployment Failure

Use when CI/CD, deployment, canary, activation, or production promotion fails.

## Route

```text
pause promotion → collect delivery evidence → localize failure → inspect rollback capability → rollback or forward-fix → verify environment health → learn
```

## Gates

- Promotion is paused before troubleshooting changes the environment further.
- Deployment, release, activation, and data migration states are distinguished.
- Rollback is never assumed safe; traffic, application, configuration, schema, and data recovery are evaluated separately.
- A forward-fix is chosen only with explicit risk and time reasoning.

## Evidence

Preserve workflow and deployment logs, artifact identity, environment state, rollback or forward-fix result, smoke checks, technical and business health, and follow-up actions.
