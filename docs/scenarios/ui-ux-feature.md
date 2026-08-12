# Scenario: ui-ux-feature

## Purpose

Deliver user-facing interaction changes with explicit behavior/state design and real browser/experience evidence.

## When to use

Use for pages, components, interactions, responsive flows, accessibility changes, and frontend behavior where “tests compile” does not prove the user experience.

## Route

`frame → spec → design → plan → work → qa → review → verify → learn → archive`, with `research`, `ship`, or `canary` added when needed.

## Artifacts

Intent/spec define user outcome and states. Design covers layout/interaction/state transitions, loading/empty/error/disabled behavior, accessibility, API dependencies, and project-defined visual/performance constraints. Tasks are vertical when possible.

## Risk and impact

Default P2 with frontend impact. API-contract impact becomes true when frontend/backend boundaries change. OmnAI does not hard-code global viewports or Core Web Vital thresholds; project policy defines them.

## Human gates

Human review is important for subjective interaction/design choices. Implementation details that follow an approved design need not repeatedly ask permission.

## Evidence

Component/unit tests as appropriate, browser QA on affected flows/states, accessibility checks, and contract tests when APIs change. Visual-regression/performance evidence is conditional on project policy.

## Reconciliation

If browser QA reveals the interaction model—not just CSS—is wrong, return to design/spec rather than repeatedly polishing code. API mismatches reconcile contract/design.

## Example

Add quote comparison filters: define loading/empty/error and keyboard behavior; design the interaction; implement end-to-end slice; run browser QA across configured mobile/desktop viewports; review accessibility and product intent; verify tests/build.

## Exit condition

The intended interaction works in the real experience, required states/accessibility are evidenced, and technical verification passes.