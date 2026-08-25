---
schemaVersion: 1
id: repository.work
version: 2
kind: repository-capability
capability: work
---

# Implementation Work

## Method

Implement only the selected task from its context packet and its approved boundary. Use a failing behavioral test before production code when behavior changes. Test observable behavior through the stable interface; focused unit tests remain appropriate for algorithms and failure cases, but callers and tests must not reach through the interface merely to couple to implementation. Keep the change incremental, compilable, rollback-friendly, and within allowed paths. Report DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, or BLOCKED.

If required ordering, cancellation, retries, lifecycle, errors, ownership, or other load-bearing semantics contradict the approved seam, do not stack another adapter, weaken a test or evidence requirement, or silently reinterpret the Design. Preserve the patch, tests, logs, and evidence and route Reconcile. Host-assisted repository Work reports `BLOCKED`. A v0.3 `PROJECT_WRITER` emits a `WorkerResult` with `outcome: SIGNAL` and `signalKind: ASSUMPTION_INVALID`; `outcome: BLOCK` is reserved for execution blocked without a new invalidating fact.

## Stop conditions

- Stop and report a blocking fact when the active Revision or required evidence is insufficient.
- Do not begin a later capability; return control to OmnAI routing after producing the declared output.
- Route a contradiction in current truth or approved intent to Reconcile rather than silently editing upstream decisions.
