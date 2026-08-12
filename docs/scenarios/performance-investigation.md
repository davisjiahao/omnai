# Scenario: performance-investigation

## Purpose

Diagnose and improve performance by measurement rather than intuition, while preserving correctness.

## When to use

Use for latency, throughput, CPU/memory, DB, concurrency, timeout, or resource regressions where the bottleneck is not already proven.

## Route

`research → baseline/instrument → diagnose → design → experiment? → plan → work → review → verify → learn`

No optimization is accepted without a before/after metric.

## Artifacts

`research.md` records baseline, workload, traces/profiles, boundaries, hypotheses, and current architecture. `design.md` explains the chosen optimization and correctness risks. `experiments/` compares uncertain approaches. Tasks remain incremental.

## Risk and impact

Default P1 due to operational consequences. Observability impact is enabled by default. Data/API/security dimensions may raise review/evidence needs.

## Human gates

Agree on meaningful workload and success target when the repository cannot define them. Significant architectural/cost/correctness trade-offs require approval.

## Evidence

Baseline benchmark, profile/trace evidence locating the bottleneck, equivalent after benchmark, regression/correctness tests, and runtime health. Avoid benchmark changes that make the after result incomparable.

## Reconciliation

If evidence contradicts the original bottleneck hypothesis, update research/design and do not stack optimizations. Repeated failed hypotheses can trigger architecture reconsideration.

## Example

Quote requests spend 15s waiting on a remote insurer. Instrument thread occupancy and remote latency, prove blocking wait dominates, compare bounded async vs virtual-thread strategies under the same workload, implement the selected slice, and verify p95/throughput plus functional tests.

## Exit condition

The bottleneck and improvement are demonstrated under comparable conditions, correctness remains green, and operational impact is understood.