# Scenario: shared-library

## Purpose

Evolve a shared SDK/library/public API without surprising downstream consumers.

## When to use

Use for reusable packages, shared Java libraries, npm packages, SDKs, schema packages, or public programmatic APIs with independent consumers.

## Route

`research(consumers) → spec → contract → design → review → plan → work → verify → ship → learn → archive`

`model` and `reconcile` are used when semantics change.

## Artifacts

`contract.md` is required: current/target public API, types, error/default/null semantics, compatibility, consumers and migration. Design addresses versioning/deprecation and release packaging.

## Risk and impact

Default P1 with high compatibility risk and `apiContract` impact. Even a small implementation diff can be high-risk when many consumers compile/run independently.

## Human gates

Approval is required for breaking behavior, semantic/versioning trade-offs, and P1 delivery. Consumers may need explicit coordination before old surfaces are removed.

## Evidence

API/binary/source compatibility as applicable, consumer tests/examples, package build, tests, release artifact identity, rollback/deprecation plan, human approval.

## Reconciliation

An unknown consumer or hidden compatibility dependency invalidates contract/design assumptions. Reconcile and keep backward-compatible expansion until consumer migration is evidenced.

## Example

Change a Java authorization client return type. First identify consumers and current null/error semantics; add a new API beside the old; migrate consumers; verify compatibility; only remove the old method in a later contract phase after usage is gone.

## Exit condition

Published contract is explicit, all required consumers are compatible/migrated, and package/release evidence is complete.