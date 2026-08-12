# Shared SDK or Library

Use for packages consumed by other repositories, teams, or applications.

## Route

```text
consumer research → public contract → compatibility design → implementation → consumer verification → publish artifact
```

## Gates

- Public interfaces, error semantics, and versioning policy are explicit.
- Consumer behavior is considered before implementation detail.
- Breaking changes require migration guidance and approval.
- The package can be built, tested, and published independently.

## Evidence

Require API compatibility results, representative consumer tests, package build output, artifact identity, and publication evidence. Deployment stages are not applicable unless the library has a hosted component.
