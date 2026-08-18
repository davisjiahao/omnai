# OmnAI Show-me Re-pitch Design

## Context

`interaction.show-me` already handles explicit explanation, comparison, and visualization requests. It also accepts an unclear-explanation request, but the protocol does not yet distinguish a first explanation from recovery after an explanation has failed. Without that distinction, an Agent can respond to “I still do not understand” by shortening the same explanation and removing useful context.

## Decision

Add **Re-pitch after comprehension failure** as a transient branch inside `interaction.show-me`.

The branch applies only when the user explicitly indicates that the current or previous explanation did not land. Natural-language signals include “I do not understand,” “wait what,” “say that plainly,” “too much jargon,” “start again,” or an equivalent expression in the user's language. A first request to explain a concept, a comparison request, and a request for a shorter summary use the normal Show-me method instead.

This is presentation behavior, not a new Entry Skill, protocol ID, `Capability`, Workset action, readiness key, or persisted interaction mode. The existing `omnai` Entry Skill discovers the explicit intent and loads `interaction.show-me`; the detailed recovery method remains only in the protocol resource.

## Re-pitch response contract

On the first comprehension failure, the response has this shape:

1. State where the conversation is now and why the subject matters.
2. Restore the nearest missing premise instead of merely deleting words.
3. Rebuild the explanation one causal step at a time with short sentences and explicit referents.
4. Pair each necessary formal term with a plain-language gloss on first use, then keep the canonical term stable.
5. Add one small concrete example or the smallest adequate representation when it materially improves understanding.
6. Preserve exact constraints, evidence, assumptions, exceptions, edge cases, and unknowns.

If the user explicitly reports another comprehension failure, step back farther or change the representation. Prefer a concrete example before a table, labeled flow, or Visual Companion, according to the existing representation ladder. Repeated recovery must not degrade into terse fragments.

## Routing and safety

- Re-pitch uses the same fresh, read-only Show-me routing contract.
- It does not infer or persist a user profile or comprehension state.
- It does not start the Visual Companion automatically; the existing material-clarity test and just-in-time consent still apply.
- It creates no workflow state or canonical artifact.

## Verification

Deterministic contract tests verify:

- the `omnai` discovery description includes the failed-explanation symptom;
- the canonical Show-me resource defines the positive trigger and the first-explanation/summary negative boundary;
- the first recovery restores context and the nearest missing premise;
- repeated failure steps back or changes representation instead of only compressing;
- no fifth Skill or workflow-state value is introduced.

Generated-response quality remains a Host forward-evaluation concern. Required future scenarios are: first recovery, repeated recovery, summary-only non-trigger, canonical project term with a first-use gloss, and multilingual recovery.
