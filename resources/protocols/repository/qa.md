---
schemaVersion: 1
id: repository.qa
version: 1
kind: repository-capability
capability: qa
---

# Experience QA

## Method

Exercise the actual user experience when UI impact requires it. Cover critical flows first, then medium and cosmetic issues according to project policy. Capture reproducible evidence, verify each fix, and distinguish report-only from edit mode. Do not apply universal viewport or performance thresholds unless the project defines them.

## Stop conditions

- Stop and report a blocking fact when the active Revision or required evidence is insufficient.
- Do not begin a later capability; return control to OmnAI routing after producing the declared output.
- Route a contradiction in current truth or approved intent to Reconcile rather than silently editing upstream decisions.
