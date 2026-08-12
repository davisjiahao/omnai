# Scenario: field-lineage

## Purpose

Trace one business/data field across every meaningful producer, transformation, transport, persistence point, reader, and consumer. This is optimized for legacy systems where the same value may change names several times.

## When to use

Use for questions such as “where does `premiumAmount` come from?”, “who writes this column?”, “what API field maps to this DB field?”, or “which consumers depend on this value?”.

## Route

`investigate(field-lineage) → locate producers → trace transforms → trace storage/transport → trace consumers → synthesize`

The default route is read-only and does not create a Change.

## Artifacts

`research.md` should include a lineage chain, aliases/naming changes, nullable/default semantics where observable, branch conditions, producer and consumer lists, and evidence references. Example shape: `UI.price → QuoteDTO.premium → converter → QuoteEntity.totalPremium → quote_result.total_premium → event.premium`.

## Risk and impact

Default P3 because the workflow only observes. The report may identify potential compatibility blast radius, but it does not automatically classify that as a defect or propose a rewrite.

## Human gates

Ask a human only when code cannot resolve a semantic choice—for example, two fields called “premium” represent different business concepts. Technical facts that can be inspected are the agent’s job to retrieve.

## Evidence

Trace both directions where possible: origin/producers and downstream consumers. Include API/event schema definitions and SQL/ORM mappings, not only Java/TypeScript call sites. Unknown hops must be called out explicitly.

## Reconciliation

If the user asks to change the field, promote the investigation. A public API/event field normally creates `apiContract` impact and requires `contract.md`; persistent changes create `database` impact and data evidence requirements.

## Example

For “trace `authorizationStatus`”, OmnAI may find a UI flag, REST response field, DTO mapping, service calculation, DB enum, MQ event, and an order-service consumer. The output highlights that the UI and MQ consumer use different null/default behavior. That fact becomes input to a later Change but is not “fixed” during lineage analysis.

## Exit condition

All known hops are connected with evidence, aliases are explained, and gaps/uncertainties are visible.