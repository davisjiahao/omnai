---
schemaVersion: 1
id: repository.review
version: 2
kind: repository-capability
capability: review
---

# Independent Review

## Method

Review from fresh context against the artifact contract. Use only the review lenses Core selected from scenario, risk, and impact. Separate specification compliance from code quality and apply business, domain, architecture, contract, data, security, performance, operations, and UX review only when its lens was selected. Findings are data, not automatic verdicts.

Apply the module-boundary assessment only when Core selected the existing `architecture` lens, and scale it to the declared `not-applicable`, `focused`, or `full` applicability. Cite `design.md`, authoritative contracts, task evidence, and the diff. Challenge shallow pass-through modules, caller leakage, reversed dependency direction, unevidenced seams, adapters that conceal incompatible semantics, tests that reach through an interface, migrations without retirement or rollback, and deletion claims without preservation proof.

Keep the review records distinct. Repository-stage review writes `ReviewRecord.findings` with `CRITICAL | IMPORTANT | MINOR` severity. v0.3 execution review writes `ReviewFinding` with `INFO | NON_BLOCKING | BLOCKING` severity. Do not merge or reinterpret either schema.

## Stop conditions

- Stop and report a blocking fact when the active Revision or required evidence is insufficient.
- Do not begin a later capability; return control to OmnAI routing after producing the declared output.
- Route a contradiction in current truth or approved intent to Reconcile rather than silently editing upstream decisions.
