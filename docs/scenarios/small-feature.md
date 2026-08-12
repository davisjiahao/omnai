# Small Feature

Use for a clear, bounded behavior change whose domain model and product value are already understood.

## Route

```text
spec-lite → design-lite → task plan → incremental work → verify → archive
```

## Gates

- Acceptance criteria describe observable behavior.
- Design records only the choices that affect implementation or testing.
- Each task is independently verifiable and small enough for one fresh context.
- The agent does not perform unrelated cleanup.

## Evidence

At minimum, record build and behavioral test evidence appropriate to the repository. Add review evidence when interfaces, concurrency, or operational behavior are non-trivial.
