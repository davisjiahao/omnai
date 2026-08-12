# OmnAI v0.1 Native Workflow Design

## Purpose

OmnAI is a lightweight, repository-local, native engineering workflow for AI coding agents. It independently reimplements selected mechanisms inspired by HumanLayer, Matt Pocock Skills, OpenSpec, Superpowers, GSD, BMAD, gstack, Compound Engineering, Spec Kit, Addy Osmani agent-skills, Trellis, OMC, and ECC. Those projects are influences, not runtime workflow dependencies.

There is no backend control plane, database, web console, daemon, mandatory issue tracker, or built-in LLM API. Durable state lives under `.omnai/`; the TypeScript CLI owns machine state and thin host skills describe how the active coding agent performs a capability.

## Four kinds of truth

1. **Reality** — current code, configuration, Git history, and runtime evidence.
2. **Meaning** — reviewed domain language, ownership, lifecycle, and invariants.
3. **Intent** — the active Change revision and specification.
4. **Completion** — fresh evidence proving claims about the active revision.

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
- New facts create a new Revision/Baseline and selective invalidation, not a full reset.
- Runtime memory is supplementary, never authoritative.
- Knowledge is promoted only after validation.

## Native reinterpretation of upstream strengths

### Reality Track

`research` documents the system as it exists. It reads explicit inputs first, decomposes questions, locates/analyzes/traces code, cites paths and evidence, and separates facts from assumptions. Migration/refactor/replacement/removal work also recovers historical lineage and obsolete constraints.

### Meaning Track

`model` uses a dependency-aware decision frontier, asks humans only for genuine decisions, challenges overloaded terminology, stress-tests edge cases, and defines lifecycle, ownership, boundaries, and invariants. `map` represents destination, resolved/frontier/blocked decisions, fog, and out-of-scope for large uncertain efforts.

### Change Track

Each implementation effort owns living change-local artifacts. OmnAI adds explicit Revision, Baseline, readiness, task impact, and selective invalidation so mid-flight changes preserve lineage instead of silently rewriting the past.

### Delivery Track

OmnAI uses risk-scaled design gates, implementation-ready tasks, bounded executor context, independent review, durable progress, root-cause-first debugging, and evidence-before-completion. Issue-backed implementation is blocked by machine state rather than prompt reminders alone.

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

The CLI does not call an LLM. Skills instruct the active host; repository-local CLI state remains canonical.

## Canonical 19 scenarios

`system-query`, `field-lineage`, `business-flow`, `bug-fix`, `small-feature`, `complex-domain-feature`, `cross-service-change`, `migration-program`, `data-migration`, `architecture-governance`, `performance-investigation`, `product-discovery`, `ui-ux-feature`, `quality-hardening`, `shared-library`, `emergency-hotfix`, `incident-response`, `release-failure`, `technical-experiment`.

Each profile declares required and optional capabilities, artifacts, P0-P3 default risk, risk dimensions, impact defaults, gates, evidence, and detection signals. Legacy IDs resolve to aliases but never appear in the canonical catalog.

### Scenario reclassification

A Change cannot silently switch profiles. `omnai scenario select <scenario> [change] --reason <reason>` performs an **L4 reclassification**: it creates a new Revision/Baseline, materializes newly required artifacts, recalculates readiness, invalidates existing task work as affected by the product/scope change, and preserves or escalates existing risk and impact. Automatic reclassification never lowers an already-established risk/impact signal. Implementation Changes cannot be reclassified into read-only Investigation profiles.

## Risk and impact

Risk:

- P3 — local, reversible, low risk
- P2 — normal engineering change
- P1 — high business, compatibility, data, security, or operational risk
- P0 — critical production, migration, incident, or irreversible risk

Dimensions: business criticality, data, compatibility, reversibility, security, operational.

Impact: `frontend`, `backend`, `apiContract`, `database`, `mq`, `remoteService`, `security`, `observability`.

Risk and impact alter design depth, review lenses, evidence requirements, and human gates. Contract impact makes `contract.md` a first-class conditional artifact. P0/P1 delivery requires recovery evidence and explicit approval; P0 can require rehearsal/dry-run when meaningful.

## Read-only investigations

`system-query`, `field-lineage`, and `business-flow` use `.omnai/investigations/` for normal read-only work. They do not create implementation intent or modify source. Explicit promotion creates a Change only when implementation is actually requested. Promotion updates machine metadata to `PROMOTED` and records the resulting Change ID, preserving Investigation → Change lineage and preventing duplicate promotion.

## Issue-backed correction state

`bug-fix`, `emergency-hotfix`, `incident-response`, and `release-failure` own `issue.yaml` machine state:

- triage: `needs-info`, `ready-for-debug`, `ready-for-fix`, `needs-experiment`, `ready-for-human`, `wontfix`
- reproduction: `unknown`, `confirmed`, `not-reproducible`, `instrumentation-required`
- root cause: `unknown`, `suspected`, `confirmed`
- fix strategy: `unknown`, `ready`, `needs-experiment`

Production edits are allowed only when reproduction and root cause are confirmed, the fix strategy is ready, and triage is `ready-for-fix`. Incident mitigation remains separate from root-cause correction.

## Readiness vector

A Change stores independent readiness for:

```text
frame
map
research
mitigation
triage
reproduction
diagnosis
domain
spec
design
experiment
fix
plan
implementation
review
verification
qa
release
canary
learning
```

States are `MISSING`, `IN_PROGRESS`, `READY`, `CONCERNS`, `STALE`, `NEEDS_REVALIDATION`, `INVALIDATED`, and `NOT_APPLICABLE`.

The deterministic router selects the first required capability whose readiness is not acceptable. Capabilities such as `reconcile`, `archive`, and some optional QA/canary work are control/lifecycle operations rather than universal linear stages.

## Task DAG and bounded context

Tasks have stable IDs, dependencies, slice type (`VERTICAL`, `CONTRACT_FIRST`, `RISK_FIRST`, `EXPAND`, `MIGRATE`, `CONTRACT`), risk, exact scope/interfaces, execution steps, and required evidence IDs. A frontier task is runnable only when all blockers are complete.

Each executor receives the active Revision/Baseline, selected task, relevant authoritative artifacts/project policies, scope, and evidence contract—not the entire accumulated conversation.

Task verification only accepts PASS evidence from the active Revision. `verify --command --task TASK-xxx` records task scope explicitly; reconciliation therefore cannot accidentally reuse stale task proof from a previous Revision.

## Completion gate

A capability cannot become `READY` simply because its scaffold file exists. Completion validates required output, rejects unchanged canonical scaffolds, requires non-empty experiment records for experiment directories, and requires real task definitions when a plan feeds implementation.

This prevents `--complete` from turning generated placeholders into false project truth.

## Evidence Matrix

Verification derives evidence requirements from scenario + risk + impact. Possible requirements include tests/build, contract/event/integration checks, data reconciliation, browser QA, security review, runtime health, rollback plan, approval, P0 rehearsal, and scenario-specific proof.

Evidence carries a stable `requirementId`, its producing Revision, and `PASS`, `FAIL`, or `INCONCLUSIVE`. A requirement is satisfied only by **PASS evidence for the same requirement ID and the active Revision**. Historical evidence remains inspectable but becomes non-authoritative after Revision/Baseline advancement. Verification is READY only when configured command verification passes and all required active-Revision Evidence Matrix gaps are closed.

`human-approval` is a reserved requirement. Generic evidence recording cannot synthesize it; the dedicated ship approval path records approval for the active Revision.

## Independent review

Review asks whether the implemented change is the **right** change; verification asks whether claims are **proven**. Dynamic review lenses can include business, domain, architecture, contract, engineering, data, security, performance, operations, and UX.

Fresh-context review separates specification compliance from implementation quality. `evidence/review.json` is machine-validated before review readiness can become `READY`. The record must identify the current Change and active Revision, cover every risk/impact-required review lens, report PASS for specification compliance and implementation quality, conclude PASS, and contain no open CRITICAL/IMPORTANT finding. Arbitrary, stale, incomplete, or concern-bearing review JSON cannot satisfy the gate.

## Rules / Skills / Guards

- Rules live in project policies and state non-negotiable constraints.
- Skills describe how an agent performs work.
- Guards are host-independent CLI decisions for hard transitions.

`guard edit` protects all issue-backed correction routes. `guard complete` requires fresh verification and satisfied active-Revision evidence. `guard ship` additionally enforces P0/P1 independent review and explicit active-Revision approval.

Host skill installation checks for same-name foreign skills before copying and refuses to overwrite them.

## Revision, Baseline and Reconcile

Every Change starts `REV-0001 / BL-0001`. Reconcile advances both while preserving lineage.

- L0 — implementation detail
- L1 — plan/task decomposition
- L2 — technical design
- L3 — domain/requirement
- L4 — product/scope
- L5 — delivery

A pending contradiction can route the Change into reconciliation. **After reconciliation is applied**, OmnAI returns the Change to `IN_PROGRESS` and the normal router selects the first invalidated/stale capability. It does not remain in a self-repeating `reconcile` loop.

Unaffected work stays done. Directly affected completed work can become `NEEDS_REVALIDATION`; downstream tasks become `INVALIDATED`; abandoned approaches can become `SUPERSEDED`. Only affected downstream readiness is invalidated.

`reconcile` is event-driven. It may occur in bug, incident, release, feature, migration, or delivery work whenever new facts invalidate the active baseline; it is not a mandatory ceremony in every route.

## Ship semantics

`ship` assesses delivery readiness, not deployment. It checks artifact identity, active-Revision Evidence Matrix, required structured review, rollout, rollback/forward-fix, activation, post-release signals, and explicit active-Revision approval. Existing enterprise CI/CD remains the executor.

## Knowledge promotion

```text
Observation
  -> Learning Candidate
  -> Validated Learning
  -> Project Knowledge
  -> Stale
  -> Refreshed / Retired
```

Durable learning records source Revision/Baseline, evidence, applicability, limitations, and invalidation conditions. Change-local discoveries are promoted only after review/verification.

## v0.1 release criteria

The supported Node 20 and Node 22 matrix must pass:

```text
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
git diff --check
```

Inventory tests must prove all 19 scenario pages, the required native skill surface, and the Java authorization migration golden example exist.

## Non-goals

No web UI, backend service, database, vector store, deployment controller, automatic LLM API, full issue/PR project management, distributed swarm, or runtime dependency on upstream workflow projects.
