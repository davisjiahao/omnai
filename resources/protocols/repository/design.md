---
schemaVersion: 1
id: repository.design
version: 3
kind: repository-capability
capability: design
---

# Solution Design

## Method

Explore 2-3 viable approaches, recommend one with trade-offs, and describe components, interfaces, data flow, state, errors, security, observability, testing, delivery, migration, and rollback. Scale depth to risk and complexity. Reference and remain consistent with `contract.md` or another authoritative formal contract. When external semantics must change, route the required change to that artifact and its owner rather than rewriting it from Design.

Reference selected and rejected approaches by their stable `DEC-*` DecisionRecord IDs. Explain their consequences in `design.md`; persist selection, rejection, ownership, and status only through the Core-owned DecisionRecords and `omnai decision` commands.

Declare architecture applicability as exactly one of:

- `not-applicable`: the change stays behind a stable interface and does not change callers, ownership, seams, adapters, the interface test boundary, or dependency direction. State why briefly and do not invent a port, adapter, or module.
- `focused`: an existing internal interface or module boundary changes while ownership and the wider architecture remain stable. Cover only the affected module, callers, interface semantics, dependency direction, interface test surface, and migration.
- `full`: architecture governance, shared-library or cross-service work, migration, a new or materially changed boundary, an ownership or lifecycle change, or another P0/P1 boundary decision. Complete the assessment, compare materially different shapes, define enforcement and retirement, and require architecture review and proportionate evidence.

For a focused or full assessment, use stable change-local IDs: `MOD-*` for modules, `IF-*` for interfaces, `SEAM-*` for seams, and `ADP-*` for concrete adapters. Define module responsibilities, ownership, callers, owned data, hidden complexity, and locality. Define interface semantics including operations, invariants, ordering, lifecycle, errors, configuration, cancellation, retries, and performance where relevant. For every seam and adapter, record dependency direction and classify the dependency as `in-process`, `local-substitutable`, `remote-but-owned`, or `true-external`.

Assess depth, leverage, and locality at the interface. Apply the deletion test: state what callers would need to know, where complexity would move, and which observable behavior would break if the abstraction were removed. Define boundary enforcement through dependency rules and package/export constraints, and define the smallest stable interface test surface with proportionate characterization, contract, integration, and operability evidence.

A seam is not automatically a bounded context. One adapter is only a hypothetical variation point, not proof of variation, and no artificial adapter is required. Do not improve a shallow pass-through by adding another layer. For consequential or difficult-to-reverse interface choices, compare two or three genuinely distinct module shapes—three when viable, or record why only two survive known constraints—on depth, locality, dependency direction, migration risk, testability, operability, and deletion behavior.

Keep external HTTP, event, and public-library semantics in `contract.md` or another authoritative contract source and reference its ID rather than duplicating semantics in the internal assessment.

## Stop conditions

- Stop and report a blocking fact when the active Revision or required evidence is insufficient.
- Do not begin a later capability; return control to OmnAI routing after producing the declared output.
- Route a contradiction in current truth or approved intent to Reconcile rather than silently editing upstream decisions.
