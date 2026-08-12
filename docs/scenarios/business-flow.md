# Scenario: business-flow

## Purpose

Recover a complete business path through a brownfield system: user or API entry point, business branches, state changes, persistence, messages, remote calls, failures, retries, and ownership boundaries.

## When to use

Use for “how does quote purchase work end to end?”, “what happens after this callback?”, “trace the authorization flow”, or requests to understand a process before changing it.

## Route

`investigate(business-flow) → entry points → happy path → branches/failures → persistence/events/remotes → ownership → synthesis`

`model` can be invoked as an optional follow-up when code exposes overloaded domain terms.

## Artifacts

`research.md` records a flow map, important states, branch predicates, transactions, async boundaries, retries/idempotency behavior, remote dependencies, and code evidence. It distinguishes “what currently happens” from “what the domain ought to mean”.

## Risk and impact

Default P2 because flow research often spans several components, although it is still read-only. No production behavior changes until explicit promotion.

## Human gates

No gate for code inspection. Ask only for unresolved business decisions or when runtime behavior cannot be inferred safely from static code and needs user-provided production context.

## Evidence

Evidence includes entry controllers/listeners/jobs, services, DB writes, event definitions, remote clients, failure handlers, and useful tests. A diagram without source references is insufficient.

## Reconciliation

A later change is promoted to a scenario based on blast radius: local changes may be `small-feature`; semantic changes `complex-domain-feature`; multi-service flows `cross-service-change`; long migrations `migration-program`.

## Example

Tracing vehicle authorization may reveal `mall-service` receives consent, writes a record, quote service checks it synchronously, an event updates order state, and a retry job repairs missed callbacks. The report describes current reality and identifies the boundaries without recommending migration. A subsequent “move authorization ownership” becomes a new Change grounded in this report.

## Exit condition

The main path and meaningful failure/async branches are explained with evidence and ownership ambiguities are explicit.