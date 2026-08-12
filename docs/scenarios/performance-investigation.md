# Performance Investigation

Use for latency, throughput, resource use, timeouts, or performance regressions.

## Route

```text
baseline → instrumentation → boundary trace → one hypothesis → minimal experiment → focused change → after benchmark → regression guard
```

## Gates

- No optimization without a reproducible baseline.
- Instrument component boundaries before blaming a layer.
- Change one variable at a time.
- Performance gains may not weaken correctness, security, or reliability.
- Results include workload, environment, and confidence limits.

## Evidence

Record baseline and after measurements, profiles or traces, experiment history, functional regression tests, and production-like validation where available.
