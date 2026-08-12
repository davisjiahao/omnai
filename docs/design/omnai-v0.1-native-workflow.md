# OmnAI v0.1 Native Workflow Design

## Purpose

OmnAI is a lightweight, repository-local, native engineering workflow for AI coding agents. It independently reimplements selected mechanisms inspired by HumanLayer, Matt Pocock Skills, OpenSpec, Superpowers, GSD, BMAD, gstack, Compound Engineering, Spec Kit, Addy Osmani agent-skills, Trellis, OMC, and ECC. Those projects are influences, not runtime workflow dependencies.

There is no backend control plane, database, web console, daemon, mandatory issue tracker, or built-in LLM API. Durable state lives under `.omnai/`; the TypeScript CLI owns machine state and thin host skills describe how the current coding agent performs a capability.

## Four kinds of truth

1. **Reality** — what current code, configuration, Git history, and runtime evidence show.
2. **Meaning** — reviewed domain language, ownership, lifecycle, and invariants.
3. **Intent** — what the active Change revision requires.
4. **Completion** — what fresh evidence actually proves.

Code beats stale research for current behavior. Reviewed semantic artifacts beat name-based guesses. The active revision beats old conversation intent. Fresh evidence beats agent confidence.

## Core principles

- Reality before redesign.
- Meaning is distinct from implementation.
- Read-only understanding is not automatically a Change.
- Every Change has one repository-local source of truth.
- Workflow depth is driven by scenario, risk, impact, and readiness—not one waterfall.
- Fresh bounded context is preferred over accumulated chat history.
- Review is distinct from verification.
- Rules define what must hold; Skills describe how; Guards enforce hard transitions.
- New facts create a new revision/baseline and selective invalidation, not a full reset.
- Runtime memory is supplementary, never authoritative.
- Knowledge is promoted only after validation.

## Native reinterpretation of upstream strengths

### Reality Track — HumanLayer-inspired

`research` documents the system as it exists. It reads explicit inputs first, decomposes questions, locates/analyzes/traces code, cites paths/lines, and separates facts from assumptions. Migration/refactor/replacement/removal work also recovers historical lineage: previous approaches, why they changed, constraints that still apply, and constraints that no longer apply.

### Meaning Track — Matt-inspired

`model` uses a dependency-aware decision tree/frontier, asks humans only for genuine decisions, challenges overloaded terminology, stress-tests edge cases, and defines lifecycle, ownership, boundaries and invariants. `map` uses destination/frontier/blocking/fog/out-of-scope for large uncertain efforts. Tasks prefer tracer-bullet vertical slices; wide refactors use expand–migrate–contract.

### Change Track — OpenSpec-inspired

Each implementation effort owns living change-local artifacts. OmnAI adds explicit Revision, Baseline, readiness, task impact and selective invalidation so mid-flight changes preserve history rather than silently rewriting the past.

### Delivery Track — Superpowers-inspired

OmnAI uses risk-scaled design gates, implementation-ready tasks, bounded executor context, independent review, durable progress, root-cause-first debugging, and evidence-before-completion. Bug implementation is blocked by machine issue state, not a prompt reminder alone.

Additional mechanisms: GSD fresh context/durable file state; BMAD right-sized routes/course correction; gstack product/browser QA/delivery; Compound simplify/review/learn; Spec Kit schemas/governance; Addy vertical/risk/contract-first and adversarial doubt; Trellis scoped context injection; OMC/ECC as replaceable runtime/harness infrastructure only.

## Architecture

```text
Request / CLI / Host Skill
          |
          v
Scenario + Risk + Impact
          |
          v
    Readiness Router
          |
   +------+------+
   |             |
Investigation   Change
(read-only)     artifacts/tasks
                 |
             Context Packet
                 |
             Coding Agent
                 |
          Evidence + Review
                 |
          Guard / Reconcile
```

The CLI does not call an LLM. Skills instruct the active host; CLI state remains canonical.

## Canonical 19 scenarios

`system-query`, `field-lineage`, `business-flow`, `bug-fix`, `small-feature`, `complex-domain-feature`, `cross-service-change`, `migration-program`, `data-migration`, `architecture-governance`, `performance-investigation`, `product-discovery`, `ui-ux-feature`, `quality-hardening`, `shared-library`, `emergency-hotfix`, `incident-response`, `release-failure`, `technical-experiment`.

Each profile declares required/optional route, artifacts, default P0–P3 risk, risk dimensions, impact defaults, gates, evidence, and detection signals. Legacy IDs resolve to aliases but never appear in the canonical catalog.

## Risk and impact

Risk:

- P3 — local/reversible/low risk
- P2 — normal engineering change
- P1 — high business/compatibility/data/security/operational risk
- P0 — critical/irreversible/production migration or incident

Dimensions: business criticality, data, compatibility, reversibility, security, operational.

Impact: `frontend`, `backend`, `apiContract`, `database`, `mq`, `remoteService`, `security`, `observability`.

Risk and impact alter design depth, review lenses, evidence requirements and human gates. Contract impact makes `contract.md` a first-class conditional artifact. P0/P1 delivery requires recovery and explicit approval; P0 adds rehearsal/dry-run when meaningful.

## Read-only investigations

`system-query`, `field-lineage`, and `business-flow` live under `.omnai/investigations/`. They do not create a Change or modify source. Explicit promotion is required before implementation intent exists.

## Bug state machine

`issue.yaml` owns machine state:

- triage: `needs-info`, `ready-for-debug`, `ready-for-fix`, `needs-experiment`, `ready-for-human`, `wontfix`
- reproduction: `unknown`, `confirmed`, `not-reproducible`, `instrumentation-required`
- root cause: `unknown`, `suspected`, `confirmed`
- fix strategy: `unknown`, `ready`, `needs-experiment`

Ready-for-fix requires confirmed reproduction/root cause plus ready fix strategy. `guard edit` enforces this before implementation.

## Readiness vector

A Change stores independent readiness for `frame`, `research`, `triage`, `reproduction`, `diagnosis`, `domain`, `spec`, `design`, `experiment`, `fix`, `plan`, `implementation`, `review`, `verification`, `qa`, `release`, `learning`.

States are `MISSING`, `IN_PROGRESS`, `READY`, `CONCERNS`, `STALE`, `NEEDS_REVALIDATION`, `INVALIDATED`, `NOT_APPLICABLE`. The deterministic router chooses the first required gap; `NEEDS_RECONCILE` always routes to reconciliation first.

## Task DAG and context packets

Tasks have stable IDs, dependencies, slice type (`VERTICAL`, `CONTRACT_FIRST`, `RISK_FIRST`, `EXPAND`, `MIGRATE`, `CONTRACT`), risk, exact scope/interfaces, execution steps, and evidence IDs. Frontier tasks have all blockers done.

Each executor receives active revision/baseline, the selected task, relevant authoritative artifacts/project policies, scope, and evidence contract—not the entire chat history.

## Evidence Matrix

Verification derives required evidence from scenario + risk + impact: tests/build, contract/event/integration checks, data reconciliation, browser QA, security review, runtime health, rollback plan, approval, P0 rehearsal, and scenario-specific proof.

Evidence carries stable `requirementId` and PASS/FAIL/INCONCLUSIVE. A requirement is satisfied only by PASS evidence for the same ID. Verification is READY only when fresh command verification passes and required gaps are empty.

## Independent review

Review asks whether the implemented change is the **right** change; verification asks whether claims are **proven**. Dynamic lenses are business, domain, architecture, contract, engineering, data, security, performance, operations, and UX.

Fresh-context review separates specification compliance from implementation quality. Findings are classified as contract misread, actionable issue, accepted trade-off, or noise rather than being rubber-stamped.

## Rules / Skills / Guards

- Rules live in project policies and state non-negotiable constraints.
- Skills describe how an agent performs work.
- Guards are host-independent CLI decisions for hard transitions.

`guard edit` protects root-cause-gated bug changes. `guard complete` requires verification/evidence. `guard ship` additionally enforces P0/P1 review and explicit approval.

## Revision, Baseline and Reconcile

Every Change starts `REV-0001 / BL-0001`. Reconcile advances both while preserving lineage.

- L0 implementation detail
- L1 plan/task decomposition
- L2 technical design
- L3 domain/requirement
- L4 product/scope
- L5 delivery

Unaffected work stays done. Directly affected completed work can become `NEEDS_REVALIDATION`; downstream tasks become `INVALIDATED`; abandoned approaches become `SUPERSEDED`. Only affected downstream readiness is invalidated.

## Ship semantics

`ship` assesses delivery readiness, not deployment. It checks artifact identity, Evidence Matrix, required review, rollout, rollback/forward-fix, activation, post-release signals, and human approval. Existing enterprise CI/CD remains the executor.

## Knowledge promotion

`Observation → Learning Candidate → Validated Learning → Project Knowledge → Stale → Refreshed/Retired`.

Durable learning records source revision/baseline, evidence, applicability, limitations, and invalidation conditions. Change-local domain discoveries are promoted only after review/verification.

## v0.1 release criteria

Node 20 and Node 22 CI must pass typecheck, tests, build, package dry-run and diff checks. Inventory tests must prove all 19 scenario pages, the required native skill surface, and the Java authorization migration golden example exist.

## Non-goals

No web UI, backend service, database, vector store, deployment controller, automatic LLM API, full issue/PR project management, distributed swarm, or runtime dependency on upstream workflow projects.
