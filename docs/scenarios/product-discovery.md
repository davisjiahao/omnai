# Scenario: product-discovery

## Purpose

Turn a product idea into a narrow, evidence-grounded outcome before engineering commits to a large solution.

## When to use

Use for new products/features when user, demand, status quo, value proposition, wedge, or success signal is still unclear.

## Route

`frame → research → spec → design → plan → work → qa → review → verify → ship → canary → learn`

`model` is added when the product introduces meaningful domain semantics.

## Artifacts

`intent.md` captures target user, painful status quo, demand evidence, narrowest valuable wedge, measurable success, scope and non-goals. Later artifacts translate the validated intent into software without losing the product contract.

## Risk and impact

Default P2. Product uncertainty is not permission to implement a broad speculative platform; the route intentionally narrows first.

## Human gates

Humans own product trade-offs and willingness to commit to a wedge. Agents should retrieve existing product/code/evidence facts themselves instead of interviewing the user about inspectable information.

## Evidence

User/market/repository evidence as appropriate, product acceptance, browser/experience evidence for UI, runtime/business success signals after release. Technical test evidence still follows impact.

## Reconciliation

If the problem or target user changes fundamentally, start a new Change rather than endlessly patching the original. Same outcome with a better solution is a revision of the same Change.

## Example

Idea: “AI briefing dashboard.” Frame discovers the pain is not dashboards but deciding which engineering changes deserve attention. The wedge becomes a prioritized daily engineering brief with explicit sources. Spec/design focus on that outcome rather than building generic analytics infrastructure.

## Exit condition

The product outcome is concrete, software matches it, and real acceptance/runtime signals are available rather than only implementation completion.