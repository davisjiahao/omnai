# OmnAI

OmnAI is a lightweight, repository-local, native AI engineering workflow for Claude Code, Codex, OpenCode, and other coding agents.

It does **not** run HumanLayer, Matt Pocock Skills, OpenSpec, Superpowers, GSD, BMAD, gstack, Compound Engineering, Spec Kit, Trellis, OMC, or ECC at runtime. OmnAI independently reimplements selected engineering mechanisms behind one artifact, state, policy, evidence, and revision model.

```text
Reality      current code / config / Git / runtime evidence
Meaning      reviewed domain language, ownership, lifecycle, invariants
Intent       the active Change revision and specification
Completion   fresh evidence proving the active revision
```

The core rule is simple: **conversation history and agent confidence are context, not project truth.**

## What OmnAI adds

- repository-local `.omnai/` state instead of chat-only plans;
- read-only Investigation separated from implementation Change;
- 19 canonical scenario profiles with P0-P3 risk and impact-aware routing;
- explicit `Revision + Baseline` lineage and selective reconciliation;
- independent readiness for framing, mapping, research, mitigation, bug diagnosis, domain, specification, design, experiments, fixes, implementation, review, verification, QA, delivery, canary, and learning;
- task DAGs with evidence requirements and bounded executor context;
- dynamic Evidence Matrix derived from scenario + risk + impact;
- machine guards for issue-backed edits and high-risk delivery;
- thin native skills installable for Claude Code, Codex, and OpenCode;
- no backend service, database, daemon, or built-in LLM API.

## Install from this repository

```bash
git checkout feat/omnai-v0.1
npm install
npm run build
npm link
```

Node.js 20 or newer is required.

## Quick start: implementation Change

```bash
# Inside an existing Git repository
omnai init --host claude

# Use a canonical scenario profile
omnai new "Move authorization to user center" --scenario complex-domain-feature

omnai status
omnai next

# Recover reality and domain meaning before changing a legacy system
omnai research "Map authorization code, data, callers, and historical behavior"
omnai model "Separate durable Authorization from per-quote AuthorizationUsage"
omnai spec
omnai design
omnai plan

# Execute one ready task at a time
omnai work
omnai work TASK-001 --done
omnai verify --matrix
omnai verify --command "npm test"
omnai work TASK-001 --verified

# New facts create a revision/baseline instead of silently rewriting history
omnai reconcile \
  --level L3 \
  --type DOMAIN_ASSUMPTION_INVALIDATED \
  --reason "AuthorizationRecord mixes consent and quote usage" \
  --task TASK-002
```

Each capability prepares a bounded prompt under the active Change's `runs/` directory. The coding agent reads authoritative artifacts, performs the bounded capability, writes canonical outputs, and completes the stage through the CLI gate.

## Quick start: read-only investigation

Do not create a Change just to answer a question about the current system:

```bash
omnai investigate create field-lineage "Trace premiumAmount from API request to database and downstream events"
```

`system-query`, `field-lineage`, and `business-flow` live under `.omnai/investigations/` and are read-only. Implementation intent exists only after explicit promotion:

```bash
omnai investigate promote INV-0001 "Correct premium amount ownership" --scenario complex-domain-feature
```

## Canonical repository state

```text
.omnai/
├── config.yaml
├── workflow.lock.yaml
├── investigations/
├── project/
│   ├── glossary.md
│   ├── policies.md
│   ├── learnings.md
│   └── decisions/
└── changes/
    └── CHG-0001-authorization-migration/
        ├── change.yaml
        ├── intent.md
        ├── research.md
        ├── domain.md
        ├── spec.md
        ├── contract.md          # conditional
        ├── design.md
        ├── issue.md             # issue-backed scenarios
        ├── issue.yaml           # machine bug/incident state
        ├── fix.md               # correction scenarios
        ├── tasks.yaml
        ├── delivery.md          # delivery scenarios
        ├── progress.jsonl
        ├── decisions/
        ├── experiments/
        ├── evidence/
        ├── revisions/
        └── runs/
```

Markdown is human-readable engineering context. YAML and JSONL carry machine state, task status, risk/impact, evidence, revisions, and baselines.

## Canonical 19 scenarios

| Scenario | Purpose | Default risk |
| --- | --- | --- |
| `system-query` | Read-only code/system question | P3 |
| `field-lineage` | Trace one field end to end | P3 |
| `business-flow` | Recover an end-to-end business flow | P2 |
| `bug-fix` | Triage → reproduce → RCA → focused correction | P2 |
| `small-feature` | Focused, well-understood feature | P3 |
| `complex-domain-feature` | Domain-heavy business capability | P1 |
| `cross-service-change` | Contract/ownership/rollout across services | P1 |
| `migration-program` | Long-running capability/system migration | P0 |
| `data-migration` | Schema/data/backfill migration | P0 |
| `architecture-governance` | Architecture and boundary evolution | P1 |
| `performance-investigation` | Measured diagnosis and optimization | P1 |
| `product-discovery` | Product idea to measurable wedge | P2 |
| `ui-ux-feature` | User-facing interaction/UI change | P2 |
| `quality-hardening` | Strengthen an existing implementation | P2 |
| `shared-library` | SDK/library/public API evolution | P1 |
| `emergency-hotfix` | Minimal high-pressure production correction | P0 |
| `incident-response` | Mitigate and resolve live production impact | P0 |
| `release-failure` | Diagnose failed release/deployment | P0 |
| `technical-experiment` | Compare uncertain technical options | P2 |

Legacy IDs remain aliases for compatibility but are not canonical profiles. See [`docs/scenarios/README.md`](docs/scenarios/README.md).

```bash
omnai scenario list
omnai scenario show complex-domain-feature
omnai scenario detect "migrate historical data with dual writes"
```

## Risk, impact and evidence

Every Change stores a P0-P3 risk level plus dimensions for business criticality, data, compatibility, reversibility, security, and operations. Impact tracks frontend, backend, API contract, database, MQ, remote service, security, and observability.

Those values change the required review lenses and Evidence Matrix. Examples include tests/build, contract checks, data reconciliation, browser QA, security review, runtime health, rollback evidence, explicit approval, and P0 rehearsal when applicable.

Evidence is keyed by stable requirement ID. A requirement is satisfied only by matching **PASS** evidence for the active Change lineage.

```bash
omnai verify --matrix
omnai verify --record contract --requirement contract-test --status PASS --summary "Consumer contract suite passed"
```

## Issue-backed correction safety

`bug-fix`, `emergency-hotfix`, `incident-response`, and `release-failure` use `issue.yaml`. Production edits are blocked until machine state confirms:

```text
reproduction = confirmed
rootCause    = confirmed
fixStrategy  = ready
triageState  = ready-for-fix
```

Incident mitigation is intentionally separate from root-cause correction. `reconcile` is an event-driven loop when new facts invalidate the active baseline, not a mandatory ceremony in every correction.

## Native commands

| Command | Purpose |
| --- | --- |
| `omnai init` | Initialize project-local state and optional host skills |
| `omnai investigate` | Create/promote read-only investigations |
| `omnai new` / `use` / `list` | Manage Change workspaces |
| `omnai status` / `next` | Inspect readiness and deterministic next action |
| `omnai frame` / `map` / `research` / `model` | Product, program, reality and domain work |
| `omnai spec` / `design` / `plan` | Define implementation intent and task graph |
| `omnai triage` / `reproduce` / `debug` / `experiment` / `fix` | Correction workflow |
| `omnai work` / `simplify` | Execute bounded implementation tasks |
| `omnai review` / `verify` / `qa` | Independent review and evidence collection |
| `omnai mitigate` | Reduce production impact while preserving evidence |
| `omnai ship` / `canary` | Assess delivery readiness and post-activation evidence |
| `omnai reconcile` | Advance revision/baseline and selectively invalidate work |
| `omnai learn` / `archive` | Promote validated knowledge and close lifecycle |
| `omnai guard` | Evaluate host-independent hard transitions |
| `omnai doctor` | Validate repository-local OmnAI state |

`ship` assesses readiness; it does **not** deploy. Existing enterprise CI/CD remains the delivery executor.

## Design and implementation references

The current source of truth is:

- [`docs/design/omnai-v0.1-native-workflow.md`](docs/design/omnai-v0.1-native-workflow.md)
- [`docs/implementation/omnai-v0.1-plan.md`](docs/implementation/omnai-v0.1-plan.md)
- [`examples/golden/java-authorization-migration/`](examples/golden/java-authorization-migration/)

The older `docs/superpowers/` documents are retained as historical planning material and are not the current v0.1 contract.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
git diff --check
```

CI runs the supported Node matrix and the same release-oriented checks.

## License

MIT
