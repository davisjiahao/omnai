---
schemaVersion: 1
id: repository.map
version: 2
kind: repository-capability
capability: map
---

# Decision Map

## Method

Create a destination-oriented decision map for work too large or uncertain for one session. Separate resolved decisions, current frontier, blocked decisions, fog that is not yet precise enough to ticket, and out-of-scope work. Every entry in the resolved, frontier, and blocked decision sections references its stable `DEC-*` DecisionRecord ID. Fog is not a DecisionRecord or Task; keep it as explicitly unstructured uncertainty until Core opens a precise decision. Do not pretend the fog is known.

## Stop conditions

- Stop and report a blocking fact when the active Revision or required evidence is insufficient.
- Do not begin a later capability; return control to OmnAI routing after producing the declared output.
- Route a contradiction in current truth or approved intent to Reconcile rather than silently editing upstream decisions.
