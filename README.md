# OmnAI

OmnAI is a lightweight, repository-local, native AI engineering workflow for Claude Code, Codex, OpenCode, and other coding agents.

It does **not** run HumanLayer, Matt Pocock Skills, OpenSpec, Superpowers, or other workflow projects at runtime. OmnAI independently implements selected engineering ideas in one coherent artifact and state model:

- **Reality** — recover how an existing codebase actually works.
- **Meaning** — clarify domain language, boundaries, lifecycle, and decisions.
- **Change** — manage intent, delta requirements, design, revisions, and task dependencies per change.
- **Delivery** — execute incrementally, review independently, and prove completion with fresh evidence.
- **Reconcile** — respond to new facts through impact analysis and selective invalidation rather than restarting everything.

## Why OmnAI

AI coding workflows commonly fail in four ways:

1. Chat history is treated as durable project truth.
2. Requirements, domain language, design, and execution plans are mixed together.
3. A plan silently becomes wrong during implementation, but the agent keeps executing it.
4. “Done” is claimed from confidence or an agent report rather than fresh evidence.

OmnAI separates four kinds of facts:

```text
Code, configuration, Git, runtime evidence   → Reality facts
Reviewed domain decisions                    → Semantic facts
The active change specification              → Intent facts
Fresh tests, review, build and runtime proof  → Completion facts
```

## Install from this repository

```bash
npm install
git checkout feat/omnai-v0.1
npm run build
npm link
```

Node.js 20 or newer is required.

## Quick start

```bash
# Inside an existing Git repository
omnai init --host claude

# Create a change with an explicit scenario profile
omnai new "Move authorization to user center" --scenario domain-feature

# Inspect readiness and ask what is required next
omnai status
omnai next

# Prepare native workflow capabilities
omnai research "Map authorization code, data, callers, and historical behavior"
omnai model "Separate durable authorization from per-quote authorization usage"
omnai spec
omnai design
omnai plan

# Execute one ready task at a time
omnai work
omnai work TASK-001 --done
omnai verify --command "npm test"
omnai work TASK-001 --verified

# Revise safely when implementation discovers a wrong assumption
omnai reconcile \
  --level L3 \
  --type DOMAIN_ASSUMPTION_INVALIDATED \
  --reason "AuthorizationRecord mixes consent and quote usage" \
  --task TASK-002
```

Each capability creates a bounded prompt under the active change's `runs/` directory. Thin host skills read that prompt, update canonical artifacts, and call the corresponding `--complete` gate.

## Canonical repository state

```text
.omnai/
├── config.yaml
├── workflow.lock.yaml
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
        ├── design.md
        ├── tasks.yaml
        ├── progress.jsonl
        ├── decisions/
        ├── evidence/
        ├── revisions/
        └── runs/
```

Markdown is the human-readable contract. YAML and JSONL hold machine-readable state, dependencies, revisions, task status, and evidence.

## Scenario profiles

OmnAI v0.1 includes profiles for:

- read-only queries
- bug fixes
- production incidents
- small features
- complex domain features
- cross-service changes
- long-running migration programs
- architecture evolution
- performance investigations
- security-sensitive changes
- data migrations
- frontend and UX features
- new products
- shared SDKs and libraries
- emergency hotfixes
- release failures

See [docs/scenarios](docs/scenarios/README.md) or run:

```bash
omnai scenario list
omnai scenario show domain-feature
omnai scenario detect "migrate historical data with dual writes"
```

## Native workflow commands

| Command | Purpose |
| --- | --- |
| `omnai init` | Initialize project-local state and optional host skills |
| `omnai new` | Create a change workspace |
| `omnai use` | Select an active change |
| `omnai status` | Show readiness, tasks, evidence, and next action |
| `omnai next` | Resolve the next required capability |
| `omnai frame` | Challenge product framing and define the narrowest wedge |
| `omnai research` | Recover current code and system reality |
| `omnai map` | Map a large program as decisions, frontier, blockers, and fog |
| `omnai model` | Resolve domain language, lifecycle, ownership, and invariants |
| `omnai spec` | Define delta requirements and acceptance criteria |
| `omnai design` | Compare approaches and produce technical design |
| `omnai plan` | Build a dependency-ordered task graph |
| `omnai work` | Execute and track one task |
| `omnai verify` | Record fresh completion evidence |
| `omnai reconcile` | Create a revision and selectively invalidate affected work |
| `omnai archive` | Archive a verified change without deleting history |

Additional capability commands include `reproduce`, `diagnose`, `mitigate`, `simplify`, `review`, `qa`, `release`, `canary`, and `learn`.

## Design principles

- One canonical artifact model; no duplicate OpenSpec/Superpowers/Matt/HumanLayer documents.
- Scenario-dependent depth instead of one mandatory pipeline.
- A thin orchestrator and fresh, bounded task contexts.
- Evidence before completion claims.
- Change revisions are append-only and previous baselines remain inspectable.
- New facts trigger selective reconciliation, not an all-or-nothing reset.
- Knowledge is promoted only after verification and review.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

The detailed v0.1 design and implementation plan are under `docs/superpowers/` on the feature branch.

## License

MIT
