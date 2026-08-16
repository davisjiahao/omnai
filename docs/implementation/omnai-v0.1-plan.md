# OmnAI v0.1 Implementation Plan

**Goal:** ship a lightweight repository-local TypeScript CLI plus native skills implementing the complete adaptive workflow and all 19 canonical scenarios.

**Architecture:** machine state lives under `.omnai/`; scenario + P0-P3 risk + impact determines readiness, evidence, review, and delivery gates. Read-only investigations stay outside Change state. Revision/baseline history and a task DAG provide durable recovery. Host skills describe bounded work; the CLI owns canonical state and hard guards.

**Runtime:** Node.js 20+, TypeScript ESM, Commander, YAML, Zod. No server, database, daemon, hosted control plane, or built-in LLM API.

## Constraints

- All durable workflow state remains under `.omnai/`.
- User-derived paths stay inside known repository/host roots.
- Runtime dependencies remain small and auditable.
- Investigation is read-only until explicit promotion.
- Behavior-changing completion requires fresh evidence.
- Public contract/data/security/operational impact expands verification automatically.
- P0/P1 delivery requires recovery and explicit human approval.
- Reconciliation preserves history and selectively invalidates downstream work.
- Existing enterprise CI/CD remains the delivery executor.

## Task 1 — Runtime and portable test harness

TypeScript package, ESM build, Node 20/22 CI, strict typecheck, portable compiled-test discovery, package entrypoint and smoke coverage.

## Task 2 — Canonical types, safe paths and file primitives

Schemas for Project/Change/Task/Evidence/Revision, atomic YAML/text/JSONL helpers, directory-aware existence checks, slug/ID generation, and path boundaries.

## Task 3 — Risk and Impact model

P0-P3 plus business/data/compatibility/reversibility/security/operational dimensions and frontend/backend/apiContract/database/mq/remoteService/security/observability impact.

## Task 4 — Canonical 19 Scenario Profiles

19-profile registry, detection, required/optional routes, artifacts, gates/evidence, risk/impact defaults, and legacy aliases that do not pollute the canonical list.

## Task 5 — Change, Revision and Baseline

Initialize `.omnai`, create Change artifacts, active revision/baseline, progress ledger, project policy/knowledge, and conditional contract/delivery/bug artifacts.

## Task 6 — Read-only Investigation subsystem

`system-query`, `field-lineage`, `business-flow` under `.omnai/investigations/`; zero Change/source mutation by default; explicit promotion copies research into a selected Change.

## Task 7 — Bug Triage/RCA state machine

`issue.md` + `issue.yaml`; triage/reproduction/rootCause/fixStrategy transitions; native triage/reproduce/debug/experiment/fix capabilities.

## Task 8 — Conditional boundary contracts and delivery artifacts

Create `contract.md` only when impact/profile requires it; `delivery.md` for ship scenarios; historical lineage in research; recovery in design/fix.

## Task 9 — Task DAG and Context Packets

Stable tasks/dependencies/frontier; vertical/contract/risk-first/expand-migrate-contract slices; progress transitions; bounded capability prompts with relevant context only.

## Task 10 — Expanded Readiness Router

Track frame/research/triage/reproduction/diagnosis/domain/spec/design/experiment/fix/plan/implementation/review/verification/qa/release/learning independently and route to the first required gap.

## Task 11 — Native Reconcile

L0-L5 signals, Revision+Baseline advancement, selective readiness invalidation, and task impact (`NEEDS_REVALIDATION`, `INVALIDATED`, `SUPERSEDED`).

## Task 12 — Evidence Matrix and verification

Derive evidence from scenario+risk+impact; stable requirement IDs; command/external evidence; verification READY only when fresh commands pass and required gaps are empty.

## Task 13 — Independent multidimensional Review

Dynamic fresh review lenses: business/domain/architecture/contract/engineering/data/security/performance/operations/UX; separate spec compliance from code quality.

## Task 14 — Host-independent Guards and delivery readiness

Edit/complete/ship guards; P0/P1 approval/recovery; `ship` checks readiness without deploying. Host hooks may call the same CLI guard.

## Task 15 — Native host skills + 19 scenario expansion pages

Complete native skill surface and safe project-local installers for Claude/Codex/OpenCode. Every canonical scenario page includes When to use, Route, Artifacts, Risk/Impact, Human gates, Evidence, Reconciliation, Example, and Exit condition.

## Task 16 — Golden example, README, CI and package evidence

Root usage documentation, Java/Spring authorization migration golden example (Reality → Meaning → Intent → Completion plus L3 reconciliation), CI, package metadata and final dry-run.

## Final verification

```bash
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
git diff --check
```

Implementation is not complete until Node 20 and Node 22 CI jobs pass and inventory tests prove scenario pages, native skills, and the golden example are present.
