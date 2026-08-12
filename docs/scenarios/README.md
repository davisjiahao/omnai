# OmnAI Scenario Profiles

OmnAI does not force every engineering request through one waterfall. A scenario profile declares the default route, risk posture, expected artifacts, human gates, and verification evidence for a class of work. The readiness router can loop backward through reconciliation when new facts invalidate an assumption.

## Canonical profiles

| Profile | Primary purpose | Default risk |
| --- | --- | --- |
| `system-query` | Read-only code/system question | P3 |
| `field-lineage` | Trace one field end to end | P3 |
| `business-flow` | Recover an end-to-end business flow | P2 |
| `bug-fix` | Triage, RCA, focused fix, regression guard | P2 |
| `small-feature` | Focused, well-understood feature | P3 |
| `complex-domain-feature` | Domain-heavy business capability | P1 |
| `cross-service-change` | Multi-service contract/rollout change | P1 |
| `migration-program` | Long-running capability/system migration | P0 |
| `data-migration` | Schema/data/backfill migration | P0 |
| `architecture-governance` | Architecture evolution and boundary change | P1 |
| `performance-investigation` | Measured performance diagnosis/optimization | P1 |
| `product-discovery` | Product idea to measurable wedge | P2 |
| `ui-ux-feature` | User-facing interaction/UI feature | P2 |
| `quality-hardening` | Strengthen an existing implementation | P2 |
| `shared-library` | SDK/library/public API evolution | P1 |
| `emergency-hotfix` | Minimal production hotfix under pressure | P0 |
| `incident-response` | Mitigate and resolve a live incident | P0 |
| `release-failure` | Diagnose failed release/deployment | P0 |
| `technical-experiment` | Compare uncertain technical options | P2 |

## Common model

Every Change carries a P0-P3 risk level, risk dimensions, an impact model, a readiness vector, an active revision, a baseline, a task DAG, and an evidence ledger. Required evidence is calculated from **scenario + risk + impact**, not from a universal checklist. Read-only investigations are the exception: they live under `.omnai/investigations/` and create no Change until explicitly promoted.

## Legacy aliases

Existing projects can still resolve older identifiers: `read-only-query` → `system-query`, `production-incident` → `incident-response`, `domain-feature` → `complex-domain-feature`, `architecture-evolution` → `architecture-governance`, `frontend-feature` → `ui-ux-feature`, `new-product` → `product-discovery`, `sdk-library` → `shared-library`, and `security-change` → `architecture-governance`.

Use `omnai scenario list`, `omnai scenario show <id>`, or `omnai scenario detect "<request>"` to inspect routing.