# Scenario: technical-experiment

## Purpose

Resolve an uncertain engineering decision with comparable, bounded experiments instead of opinion-driven implementation.

## When to use

Use for technology/algorithm/protocol choices, uncertain bug fixes, performance strategies, migration techniques, or proof-of-concept questions where multiple credible candidates exist.

## Route

`research → define question/metrics → design candidates → experiment → compare → adversarial review → verify conclusion → learn`

`plan/work` are optional only if experimental infrastructure needs implementation. Experiment code is not production code by default.

## Artifacts

Research establishes constraints and existing patterns. Design lists candidates and evaluation contract. Each experiment record captures setup, one changed variable, result, evidence, cleanup and limitations. Final conclusion records selected/rejected options.

## Risk and impact

Default P2. Experiments touching production data/security/expensive infrastructure can be raised to P0/P1 and inherit the corresponding guards.

## Human gates

Humans decide subjective trade-offs such as acceptable cost/complexity when metrics cannot decide. External system spend/destructive actions require explicit authorization.

## Evidence

Comparable measurements, logs/results, correctness checks, cleanup proof where relevant, and decision rationale. Failed candidates are retained because they are valuable negative evidence.

## Reconciliation

If the experiment reveals the original question/contract was wrong, revise the research/design rather than declaring a winner. A production implementation is created as a separate planned task/Change using the experiment as evidence.

## Example

Choose queue vs polling for async insurer status. Define latency, reliability, operational cost and implementation constraints; build minimal isolated candidates; run equal workloads; compare failures and p95; review hidden coupling; select one. Only then create production design/tasks.

## Exit condition

The decision is supported by equivalent evidence, uncertainty/limitations are explicit, and temporary experiment work cannot silently leak into production.