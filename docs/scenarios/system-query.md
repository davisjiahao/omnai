# Scenario: system-query

## Purpose

Answer a question about the current repository—where behavior lives, which component owns something, how code is connected, or what a current rule does—without turning the question into implementation work.

## When to use

Use when the user asks “where is…”, “which service owns…”, “how does this code work?”, or needs a factual system map. If the request is specifically about one field, prefer `field-lineage`; if it is about a complete user/business process, prefer `business-flow`.

## Route

`investigate(system-query) → research → answer`

This route is read-only. It does not create a Change, task graph, branch, or source edit. Use `omnai investigate create system-query "<question>"`.

## Artifacts

The investigation owns `investigation.yaml` and `research.md`. The report separates confirmed facts, assumptions, unknowns, and evidence references. Existing ADRs or historical docs can explain intent, but live code/configuration remains the primary source for current behavior.

## Risk and impact

Default risk is P3 because no behavior changes. If the investigation exposes a sensitive/security fact, handling of that information follows project policy even though the workflow remains read-only.

## Human gates

No approval is required to inspect code. A human decision is required only if the investigation is promoted into a Change or if the repository cannot answer an ambiguous business meaning.

## Evidence

Every load-bearing conclusion cites exact files and useful line ranges. Unknowns stay unknown; names alone are not accepted as proof of business semantics.

## Reconciliation

There is no Change to reconcile. If the user asks to modify what was found, explicitly promote the investigation and choose the appropriate Change scenario. The investigation becomes input evidence, not mutable planning state.

## Example

Question: “Which service owns vehicle authorization status?” OmnAI locates authorization entry points, storage, clients, and callers; reports that current ownership is in `mall-service`; notes that `user-center` only consumes a projection; and cites the relevant code. It does **not** move the capability. If the next request is “move it to user-center”, promote to `complex-domain-feature` or `migration-program`.

## Exit condition

The question is answered from current evidence, important unknowns are explicit, and no source code was changed.