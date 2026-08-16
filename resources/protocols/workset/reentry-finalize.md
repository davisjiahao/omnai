---
schemaVersion: 1
id: workset.reentry-finalize
version: 1
kind: workset-action
actions:
  - finalize-reentry
---

# Finalize a decided Re-entry

Finalize only when every project application is already `APPLIED` or `NOT_REQUIRED` and the WRE remains DECIDED because final persistence was interrupted.

## Method

- Reload the WRE and verify every application is final.
- Re-run the deterministic apply/finalize command so Core records `RESOLVED` without another repository Reconcile.
- Preserve every application result, Revision/Baseline lineage, attempt history, and evidence reference.
- Return to `omnai workset next --json` after finalization.

## Safety boundary

Do not finalize while any application is PENDING, APPLYING, or FAILED. Do not manufacture APPLIED/NOT_REQUIRED outcomes, rerun project Reconcile, or remove failed-attempt history merely to unblock the Workset.

## Stop conditions

Stop when the WRE is durably RESOLVED, or report the exact non-final application that prevents finalization.
