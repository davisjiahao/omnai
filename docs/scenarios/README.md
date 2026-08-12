# OmnAI Scenario Profiles

OmnAI does not force every request through one pipeline. A scenario profile selects required capabilities, optional capabilities, quality gates, and evidence while keeping all artifacts in the same canonical change workspace.

| Profile | Typical use | Default route |
| --- | --- | --- |
| [read-only-query](read-only-query.md) | Locate a field, call path, rule, or business flow | research |
| [bug-fix](bug-fix.md) | Reproducible defect or failing test | reproduce → diagnose → work → verify |
| [production-incident](production-incident.md) | Active production impact | mitigate → diagnose → recover → learn |
| [small-feature](small-feature.md) | Clear, bounded feature | spec → design → plan → work → verify |
| [domain-feature](domain-feature.md) | Complex business semantics | research → model → spec → design → work |
| [cross-service-change](cross-service-change.md) | Contracts across services | research → design → compatibility → rollout |
| [migration-program](migration-program.md) | Long-running system migration | frame → map → bounded changes → retirement |
| [architecture-evolution](architecture-evolution.md) | Boundary or platform evolution | research → model → adversarial design → increments |
| [performance-investigation](performance-investigation.md) | Latency, throughput, resource problem | baseline → instrument → hypothesize → benchmark |
| [security-change](security-change.md) | Auth, permissions, secrets, PII | threat model → design → independent verification |
| [data-migration](data-migration.md) | Schema, dual-write, backfill | expand → migrate → reconcile → contract |
| [frontend-feature](frontend-feature.md) | UI and interaction behavior | frame → design → slices → browser QA |
| [new-product](new-product.md) | New product or MVP | demand → wedge → product spec → ship → pulse |
| [sdk-library](sdk-library.md) | Shared library or public API | contract → implementation → consumer verification |
| [emergency-hotfix](emergency-hotfix.md) | Urgent production patch | reduced gate → smallest fix → verify → follow-up |
| [release-failure](release-failure.md) | Failed deploy, canary, or promotion | pause → diagnose → rollback/forward-fix → health |

## Common rules

- Scenario profiles select workflow depth; they do not create separate artifact formats.
- `omnai scenario detect "..."` provides a deterministic heuristic suggestion.
- `omnai scenario select <id>` changes the active profile without deleting prior artifacts.
- A new fact that invalidates the active revision always routes through `omnai reconcile`.
- Any completion claim requires fresh evidence, regardless of profile.
