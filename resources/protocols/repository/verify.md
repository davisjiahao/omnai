---
schemaVersion: 1
id: repository.verify
version: 1
kind: repository-capability
capability: verify
---

# Verification

## Method

Build the required evidence matrix from scenario, risk, and impact. Gather fresh evidence for every required item, run the full command that proves each claim, read exit codes and failures, verify acceptance criteria line by line, and record honest PASS, FAIL, or INCONCLUSIVE results.

## Stop conditions

- Stop and report a blocking fact when the active Revision or required evidence is insufficient.
- Do not begin a later capability; return control to OmnAI routing after producing the declared output.
- Route a contradiction in current truth or approved intent to Reconcile rather than silently editing upstream decisions.
