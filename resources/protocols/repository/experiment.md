---
schemaVersion: 1
id: repository.experiment
version: 1
kind: repository-capability
capability: experiment
---

# Technical Experiment

## Method

Resolve an uncertain technical or fix decision with explicit candidates, a measurable success criterion, one-variable trials, captured evidence, cleanup between attempts, and a bounded conclusion. Experimental code must not silently become production code.

## Stop conditions

- Stop and report a blocking fact when the active Revision or required evidence is insufficient.
- Do not begin a later capability; return control to OmnAI routing after producing the declared output.
- Route a contradiction in current truth or approved intent to Reconcile rather than silently editing upstream decisions.
