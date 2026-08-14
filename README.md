# OmnAI

OmnAI is a lightweight, local-first AI engineering workflow for Claude Code, Codex, OpenCode, and other coding agents.

v0.1 provides repository-local workflow truth under `.omnai/`. v0.2 adds a personal multi-project layer for one engineer coordinating one engineering objective across several repositories without introducing a Web app, server, database, daemon, or built-in LLM API.

```text
Reality      current code / config / Git / runtime evidence
Meaning      reviewed domain language, ownership, lifecycle, invariants
Intent       the active Change revision and specification
Completion   fresh evidence proving the active revision
```

The core rule is: **conversation history and agent confidence are context, not project truth.**

## What OmnAI adds

- repository-local `.omnai/` state instead of chat-only plans;
- read-only Investigation separated from implementation Change;
- 19 canonical scenario profiles with P0-P3 risk and impact-aware routing;
- explicit `Revision + Baseline` lineage and selective reconciliation;
- task DAGs, bounded execution context, Evidence Matrix, review and delivery guards;
- personal Project Registry and Worksets for multi-repository work;
- mandatory Git worktree isolation for writable Workset projects;
- one aggregate execution directory that VS Code and the main coding agent open directly;
- selective Workset Re-entry for mid-flight requirement/fact changes;
- thin host skills for Claude Code, Codex, and OpenCode;
- no backend service, database, daemon, Web UI, or built-in LLM API.

## Install from this repository

```bash
git checkout feat/omnai-v0.2-personal-workspace
npm install
npm run build
npm link
```

Node.js 20 or newer is required.

## v0.2: personal multi-project Worksets

A Workset represents one engineering objective. Projects are registered once, researched read-only in their original repositories, and receive a dedicated Git worktree only after OmnAI confirms that the project must be modified.

Example:

```bash
omnai project register ~/code/user-center --alias user-center
omnai project register ~/code/quote-center --alias quote-center

omnai workset new "Authorization Migration"

omnai workset add-candidate user-center
omnai workset inspect-project user-center
# Agent researches ~/code/user-center read-only.
omnai workset activate-project user-center

omnai workset add-candidate quote-center
omnai workset inspect-project quote-center
omnai workset activate-project quote-center

ROOT=$(omnai workset path)
code "$ROOT"
cd "$ROOT"
codex
# or: claude
# or: opencode
```

The resulting local layout is an ordinary directory, not a VS Code multi-root `.code-workspace`:

```text
~/.omnai/
├── projects.yaml
└── worksets/
    └── WKS-0001/
        ├── workset.yaml
        ├── reentries/
        └── workspace/                    # open this folder in VS Code
            ├── .omnai-workset.yaml       # pointer to the Workset
            ├── user-center/              # real Git worktree
            └── quote-center/             # real Git worktree
```

The main agent runs with `cwd = workspace/`, so it can analyze the whole Workset. An isolated worker runs with `cwd = workspace/<project>` and is bounded to that project Run.

### Project lifecycle

```text
CANDIDATE
  ↓
RESEARCH_ONLY
  ├── no modification needed → OBSERVED_ONLY
  └── modification required  → ACTIVE → dedicated Git worktree

ACTIVE
  └── removed from scope      → INACTIVE
```

`CANDIDATE`, `RESEARCH_ONLY`, and `OBSERVED_ONLY` do not create project directories under the aggregate workspace. `ACTIVE` does. When a project becomes `INACTIVE`, its worktree remains in the aggregate directory so commits, uncommitted work, evidence, and recovery context are not destroyed. Visibility does not imply write permission: new OmnAI Runs may write only to active, claimed, revision-valid projects.

If a new project becomes relevant in the middle of a requirement, add it as a candidate, research the original repository read-only, and activate it only if modification is confirmed. Its Worktree then appears as another normal child directory, so an already-open VS Code window sees it through the filesystem without workspace synchronization.

### Personal workspace commands

```text
omnai project register <path> [--alias <alias>] [--json]
omnai project list [--json]
omnai project inspect <alias> [--json]

omnai workset new <title> [--json]
omnai workset status [workset] [--json]
omnai workset next [workset] [--json]
omnai workset add-candidate <project> [--workset <id>] [--json]
omnai workset inspect-project <project> [--workset <id>] [--result observed-only] [--json]
omnai workset activate-project <project> [--workset <id>] [--json]
omnai workset mark-inactive <project> [--workset <id>] [--json]
omnai workset path [workset] [--json]

omnai workset change --kind <kind> --reason <text> \
  [--project <alias>]... [--candidate <alias>]... [--workset <id>] [--json]
omnai workset reentry list [workset] [--json]
omnai workset reentry resolve <WRE-id> [--workset <id>] [--json]
```

`omnai workset path` returns the aggregate execution directory. OmnAI does not generate a `.code-workspace` file.

### Mid-flight requirement changes

The Agent host interprets the conversation and submits one structured change kind. OmnAI Core does not classify free-form language with an embedded model.

```text
REALITY_CHANGED                -> research
PRODUCT_CHANGED                -> frame / grill
DOMAIN_CHANGED                 -> model / grill
SCOPE_CHANGED                  -> spec / grill
TECHNICAL_CONSTRAINT_CHANGED   -> design / brainstorm
NEEDS_EXPERIMENT               -> experiment
PLAN_CHANGED                   -> plan
IMPLEMENTATION_DETAIL_CHANGED  -> work
```

Example: while `user` and `quote` are already active, the user says that historical quotes must preserve authorization state and `pricing` may now be affected. The host records:

```bash
omnai workset change \
  --kind DOMAIN_CHANGED \
  --reason "Historical quote authorization semantics changed and pricing may be affected" \
  --project user \
  --project quote \
  --candidate pricing
```

Then:

```bash
omnai workset next --json
```

returns `inspect-project pricing` first. `pricing` is researched read-only in its original repository. Only after its impact decision is complete can the same pending Re-entry route to:

```text
model / grill
```

A later technical constraint can create another Re-entry that routes to `design / brainstorm`; if discussion cannot decide safely, `NEEDS_EXPERIMENT` routes to the existing experiment capability.

Re-entry records are durable YAML history under `worksets/<WKS>/reentries/`. They must resolve oldest-first, and a Re-entry cannot be resolved while one of its newly introduced candidate projects still needs an impact decision.

Milestone B1 stops at Workset coordination. Project-local Revision/Baseline advancement and selective task/evidence invalidation are deliberately deferred to B2, which will bind these Workset events to the existing repository-local Reconcile engine.

## Repository-local implementation Change

Inside one repository or Workset child worktree, v0.1 repository-local workflow commands remain available:

```bash
omnai init --host claude
omnai new "Move authorization to user center" --scenario complex-domain-feature

omnai status
omnai next

omnai research "Map authorization code, data, callers, and historical behavior"
omnai model "Separate durable Authorization from per-quote AuthorizationUsage"
omnai spec
omnai design
omnai plan

omnai work
omnai work TASK-001 --done
omnai verify --matrix
omnai verify --command "npm test"
omnai work TASK-001 --verified
```

New facts or requirement changes advance Revision/Baseline state rather than silently rewriting history:

```bash
omnai reconcile \
  --level L3 \
  --type DOMAIN_ASSUMPTION_INVALIDATED \
  --reason "AuthorizationRecord mixes consent and quote usage" \
  --task TASK-002
```

Each capability prepares bounded context under the active Change's `runs/` directory. The coding agent performs the reasoning and implementation; the CLI owns deterministic state, guards, readiness, evidence, and revision transitions.

## Read-only investigation

Do not create a Change just to answer a question about the current system:

```bash
omnai investigate create field-lineage "Trace premiumAmount from API request to database and downstream events"
```

`system-query`, `field-lineage`, and `business-flow` live under `.omnai/investigations/` and remain read-only until explicit promotion:

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
        ├── issue.yaml
        ├── fix.md
        ├── tasks.yaml
        ├── delivery.md
        ├── progress.jsonl
        ├── decisions/
        ├── experiments/
        ├── evidence/
        ├── revisions/
        └── runs/
```

Markdown carries human-readable engineering context. YAML and JSONL carry machine state, task status, risk/impact, evidence, revisions, and baselines.

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

Legacy IDs remain aliases for compatibility but are not canonical profiles.

## Risk, impact and evidence

Every Change stores a P0-P3 risk level plus dimensions for business criticality, data, compatibility, reversibility, security, and operations. Impact tracks frontend, backend, API contract, database, MQ, remote service, security, and observability.

Those values determine required review lenses and Evidence Matrix entries. A requirement is satisfied only by matching fresh **PASS** evidence for the active Change lineage.

```bash
omnai verify --matrix
omnai verify --record contract --requirement contract-test --status PASS --summary "Consumer contract suite passed"
```

## Issue-backed correction safety

`bug-fix`, `emergency-hotfix`, `incident-response`, and `release-failure` use explicit issue state. Production edits are blocked until machine state confirms reproduction, root cause, and fix strategy readiness. Incident mitigation remains separate from root-cause correction, and `reconcile` is event-driven rather than a mandatory stage in every workflow.

## Native repository-local commands

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

`ship` assesses readiness; it does not deploy. Existing CI/CD remains the delivery executor.

## Design references

Current v0.2 contract:

- [`docs/design/README.md`](docs/design/README.md) — authoritative reading order
- [`docs/design/omnai-v0.2-personal-workspace.md`](docs/design/omnai-v0.2-personal-workspace.md)
- [`docs/design/omnai-v0.2-aggregate-execution-workspace.md`](docs/design/omnai-v0.2-aggregate-execution-workspace.md) — supersedes the earlier `.code-workspace` / multi-root portions
- [`docs/design/omnai-v0.2-selective-reentry.md`](docs/design/omnai-v0.2-selective-reentry.md) — Milestone B1 contract
- [`docs/superpowers/plans/2026-08-14-omnai-v0.2-milestone-a-aggregate-workspace.md`](docs/superpowers/plans/2026-08-14-omnai-v0.2-milestone-a-aggregate-workspace.md)
- [`docs/superpowers/plans/2026-08-14-omnai-v0.2-milestone-b1-selective-reentry.md`](docs/superpowers/plans/2026-08-14-omnai-v0.2-milestone-b1-selective-reentry.md)

Repository-local v0.1 reference:

- [`docs/design/omnai-v0.1-native-workflow.md`](docs/design/omnai-v0.1-native-workflow.md)
- [`examples/golden/java-authorization-migration/`](examples/golden/java-authorization-migration/)

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
