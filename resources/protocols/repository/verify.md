---
schemaVersion: 1
id: repository.verify
version: 2
kind: repository-capability
capability: verify
---

# Verification

## Method

Consume the required Evidence Matrix that Core built from scenario, risk, and impact. Gather fresh, proportionate evidence for every required item, run the full command that proves each claim, read exit codes and failures, verify acceptance criteria line by line, and record honest PASS, FAIL, or INCONCLUSIVE results.

For module-boundary claims already required by that matrix or the artifact contract, use approved architecture applicability only to scale the verification method and proportionate evidence; it does not add or remove matrix items. Verify observable behavior at the stable interface with the required behavioral, characterization, contract, integration, or operability evidence. Verify boundary enforcement, migration and retirement, and compatibility when applicable. Static “unused” analysis alone is insufficient deletion evidence; require fresh proof that observable behavior and contracts remain preserved.

## Stop conditions

- Stop and report a blocking fact when the active Revision or required evidence is insufficient.
- Do not begin a later capability; return control to OmnAI routing after producing the declared output.
- Route a contradiction in current truth or approved intent to Reconcile rather than silently editing upstream decisions.
