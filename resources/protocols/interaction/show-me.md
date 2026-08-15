---
schemaVersion: 1
id: interaction.show-me
version: 1
kind: interaction
interaction: show-me
---

# Show me

Use this presentation protocol only when the user explicitly asks for an explanation, comparison, visualization, “show me”, or says the current explanation is unclear.

## Explain for understanding

- Begin with the practical conclusion, user-visible outcome, or plain-language meaning.
- Prefer ordinary words when they are equally precise. Do not introduce terminology merely to sound expert.
- When a specialized term or acronym is necessary, define it briefly on first use and retain the canonical name so the answer remains precise and searchable.
- Use short sentences, concrete nouns, observable outcomes, trade-offs, and user impact.
- Calibrate depth from familiarity demonstrated in the current domain. Do not infer or persist a user profile from one conversation.
- Preserve exact constraints, evidence references, assumptions, exceptions, edge cases, and unknowns. Never replace them with a vague analogy or a guess.

## Choose the smallest adequate representation

Use a representation only when it materially reduces the effort needed to understand the answer:

- one fact or a short explanation: prose or a short list;
- exact alternatives, mappings, repeated fields, or structured comparisons: a Markdown table;
- static flow, hierarchy, state transition, dependency, or multi-project relationship: Mermaid when the Host renders it, otherwise a compact labeled-text flow;
- visual appearance, spatial structure, changing behavior, or adjustable scenarios: the built-in OmnAI Visual Companion, but only when it is materially clearer and technically accurate.

Every non-text representation needs a concise textual takeaway and must identify important assumptions or exceptions. Do not add decorative visuals, and do not present generated imagery as technical evidence.

## Visual-companion direction

Decide separately for each question whether seeing the subject would be clearer than reading about it. A UI topic alone does not require a visual.

A richer visual is usually appropriate for UI mockups, wireframes, layouts, navigation, component relationships, architecture and data flow, dependency maps, spatial state relationships, side-by-side visual directions, look and feel, or a dynamic scenario that cannot be explained precisely with a static diagram.

Requirements, scope, ordinary trade-offs, conceptual choices, API or data-model decisions, and clarifying questions stay in prose or tables unless spatial or changing structure is the point.

Use the first adequate level:

```text
prose or list
  -> table
  -> Mermaid or labeled-text flow
  -> inline Host-native visual or interactive explainer
  -> built-in OmnAI Visual Companion in a local browser
```

An explicit Show-me request authorizes an inline Host-native visual. Before starting the built-in companion or opening its local browser URL, ask for just-in-time consent and state that a temporary loopback server will run until stopped. If consent is declined or a browser is unavailable, fall back to the preceding level without weakening the explanation.

## Built-in OmnAI Visual Companion

For a richer visual, create a temporary declarative JSON document outside repository and OmnAI state. Never place executable HTML or JavaScript in the document. Choose one closed presentation kind:

- `directions`: compare two to four visual directions with equal fidelity, including name, emphasis, user impact, main trade-off, and optional details;
- `flow`: show two to twelve labeled nodes and their explicit relationships;
- `step-through`: start with one overview and reveal one changing step at a time.

Validate before serving:

```bash
omnai visual validate <temporary-document.json> --json
omnai visual companion <temporary-document.json> --json
```

The companion is an OmnAI-owned renderer. It binds only to `127.0.0.1`, returns a random, unguessable token-scoped URL, exposes no writable HTTP route, and renders document values as text. It never executes Agent-provided HTML or JavaScript. Open the returned URL only after consent. Updating the same temporary JSON document refreshes the open presentation. Stop the companion process when the explanation ends.

Superpowers Visual Companion remains a behavioral influence and possible separately authorized integration, not the default renderer or an OmnAI runtime dependency.

Match fidelity to the decision: use a wireframe for structure and higher polish only for a polish question. Normally compare two to four visual directions at once in the same frame and fidelity. Give each direction a short name, its emphasis, the user-visible consequence, and its main trade-off. Use realistic content when placeholder content would hide the issue.

For a dynamic system, start with an overview and then step through one changing dominant visual instead of showing a dashboard of unrelated panels. Keep interactive controls local, keyboard-accessible, clearly labeled, and paired with an accessible text alternative.

Selections, clicks, and sliders are presentation feedback only. Treat the user's conversational response as the primary feedback, but do not treat either visual events or conversation as project truth until an authorized OmnAI action records the decision.

Generated visual content is ephemeral, Host-owned, and noncanonical unless the user separately authorizes an artifact-producing workflow action.

## Read-only boundary

Show-me changes presentation only. It does not create a Workset, Project Change, Investigation, run, progress event, readiness transition, canonical artifact, or personal preference state. It does not initialize a repository, bind or approve a decision, advance the current workflow action, or write generated visual content into project truth.

If required facts are missing, state the gap and unknowns rather than guessing. Research or Investigation begins only through a separate, normally authorized Core route. If verified facts conflict with active intent, follow the normal Reconcile route.
