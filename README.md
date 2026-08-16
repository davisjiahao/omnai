# OmnAI

OmnAI is a lightweight, local-first AI engineering workflow for Codex, Claude Code, OpenCode, and other coding agents.

It keeps engineering truth in files, Git, explicit state machines, and fresh evidence instead of relying on one long chat session.

```text
Reality      current code, configuration, Git, and runtime evidence
Meaning      reviewed domain language, ownership, lifecycle, and invariants
Intent       the active Project Change Revision and specification
Completion   fresh evidence proving the active Revision
```

The core rule is:

> Conversation history and Agent confidence are useful context, but they are not workflow state.

OmnAI v0.2 supports one engineer coordinating one objective across several repositories without adding a persistent Web application, remote server, database, daemon, background scheduler, or built-in LLM API.

## What OmnAI provides

- repository-local `.omnai/` Project Change state;
- read-only investigations separated from implementation work;
- 19 scenario profiles with risk- and impact-aware routing;
- explicit Revision and Baseline lineage;
- task dependency graphs, evidence requirements, review, and delivery guards;
- a personal Project Registry;
- Worksets for one objective spanning multiple repositories;
- real Git worktrees directly under one aggregate execution directory;
- one Workset project bound to one explicitly confirmed Project Change;
- selective mid-flight Re-entry and per-project Reconcile;
- deterministic Readiness and Task closure calculation;
- stale-precondition Replan with immutable attempt history;
- four user-level Agent Skills shared by Codex, Claude Code, and OpenCode;
- versioned internal Protocol Resources selected by OmnAI Core;
- a read-only Show-me interaction and optional loopback Visual Companion.

## Install from this repository

```bash
git checkout feat/omnai-v0.2-personal-workspace
npm install
npm run build
npm link

omnai host install all
omnai host status
```

Node.js 20 or newer is required.

The user-level installation targets are:

```text
Claude Code  ~/.claude/skills
Codex        ~/.agents/skills
OpenCode     ~/.config/opencode/skills
```

Only these four Entry Skills are installed:

```text
omnai
omnai-grill
omnai-brainstorm
omnai-reconcile
```

`omnai init` does not install Agent Skills. It only initializes `.omnai/` in the current Git repository.

## Entry Skills and internal protocols

OmnAI deliberately separates the public Agent surface from detailed workflow guidance.

```text
Agent Host
   ↓
four Entry Skills
   ↓
omnai context --json
   ↓
Core-selected next action + protocolIds
   ↓
omnai protocol show <protocolIds...> --json
   ↓
versioned internal Protocol Resources
   ↓
deterministic OmnAI commands and state
```

The package contains:

```text
skills/                       # Host-discoverable
├── omnai/
├── omnai-grill/
├── omnai-brainstorm/
└── omnai-reconcile/

resources/protocols/          # package-internal, not Host Skills
├── common/
├── repository/
├── interaction/
└── workset/
```

There is one canonical repository protocol for every OmnAI capability, including `research`, `model`, `spec`, `design`, `plan`, `debug`, `work`, `review`, and `verify`.

Core chooses the legal action and ordered protocol IDs. Codex, Claude Code, and OpenCode do not maintain separate routing tables or separate workflow prompts.

Inspect a protocol bundle directly:

```bash
omnai protocol show repository.design --json

omnai protocol show \
  workset.reentry-interaction \
  interaction.grill \
  repository.model \
  workset.reentry-plan \
  --json
```

`protocol show` is read-only. It does not initialize a repository, create a Workset, advance Readiness, or change a Revision.

## Context discovery

Every Entry Skill starts with:

```bash
omnai context --json
```

The result is one of:

```text
workset          aggregate Workset root
workset-project  a project Worktree inside a Workset
repository       an ordinary Git repository
none             no OmnAI-capable filesystem context
```

Workset discovery outranks ordinary Git discovery because every active Workset child is also a Git worktree.

Examples:

```json
{
  "scope": "workset",
  "worksetId": "WKS-0001",
  "project": null
}
```

```json
{
  "scope": "workset-project",
  "worksetId": "WKS-0001",
  "project": "quote",
  "memberStatus": "ACTIVE",
  "changeId": "CHG-0018"
}
```

Context discovery is read-only and never calls `omnai init` automatically.

## Quick start: one multi-project Workset

Register repositories once:

```bash
omnai project register ~/code/user-center --alias user
omnai project register ~/code/quote-center --alias quote
omnai project register ~/code/pricing-center --alias pricing
```

Create one engineering objective:

```bash
omnai workset new "Authorization Migration"
omnai workset add-candidate user
omnai workset inspect-project user
```

The Agent researches the registered original repository read-only. If no modification is required:

```bash
omnai workset inspect-project user --result observed-only
```

If modification is required, existing Project Changes are suggestions only:

```bash
omnai workset change-bindings user
omnai workset bind-change user CHG-0027
omnai workset activate-project user
```

Or explicitly create a new Project Change inside the dedicated Worktree:

```bash
omnai workset create-change user \
  "Build Authorization ownership" \
  --scenario complex-domain-feature
```

Open the aggregate directory itself:

```bash
ROOT=$(omnai workset path)
code "$ROOT"
cd "$ROOT"
codex
# or: claude
# or: opencode
```

The layout is an ordinary directory:

```text
~/.omnai/worksets/WKS-0001/
├── workset.yaml
├── reentries/
└── workspace/
    ├── .omnai-workset.yaml
    ├── user/       # real Git worktree
    └── quote/      # real Git worktree
```

OmnAI does not generate a `.code-workspace` file. The main Agent runs at `workspace/`; a project-bounded worker runs at `workspace/<project>`.

### Project lifecycle

```text
CANDIDATE
  ↓
RESEARCH_ONLY
  ├── no modification needed → OBSERVED_ONLY
  └── modification required
          ↓
      explicit Project Change confirmation
          ↓
      ACTIVE → real Git worktree

ACTIVE
  └── removed from current scope → INACTIVE
```

`CANDIDATE`, `RESEARCH_ONLY`, and `OBSERVED_ONLY` do not create writable project directories. `ACTIVE` does. `INACTIVE` retains its Worktree for audit and recovery, but visibility does not grant new write permission.

## Deterministic Workset routing

From the aggregate directory, run:

```bash
omnai workset next --json
```

An actionable result includes ordered `protocolIds`:

```json
{
  "action": "reenter",
  "reentryId": "WRE-0001",
  "capability": "model",
  "interaction": "grill",
  "protocolIds": [
    "workset.reentry-interaction",
    "interaction.grill",
    "repository.model",
    "workset.reentry-plan"
  ]
}
```

The Agent loads exactly that bundle, performs the bounded action, records durable results in authoritative artifacts, and asks Core for the next action again.

Candidate research and impact decisions outrank ordinary implementation. Older PENDING or DECIDED Re-entry records also outrank normal project work.

## Mid-flight requirement and reality changes

The Agent interprets natural language and records one structured Workset Re-entry kind. OmnAI Core does not call an LLM.

```text
REALITY_CHANGED                research              minimum L4
PRODUCT_CHANGED                frame / grill         minimum L4
DOMAIN_CHANGED                 model / grill         minimum L3
SCOPE_CHANGED                  spec / grill          minimum L3
TECHNICAL_CONSTRAINT_CHANGED   design / brainstorm   minimum L2
NEEDS_EXPERIMENT               experiment            minimum L2
PLAN_CHANGED                   plan                  minimum L1
IMPLEMENTATION_DETAIL_CHANGED  work                  minimum L0
```

Example:

```bash
omnai workset change \
  --kind DOMAIN_CHANGED \
  --reason "Historical quotes must preserve authorization at quote time" \
  --project user \
  --project quote \
  --candidate pricing
```

After research and the required interaction, the Agent proposes semantic roots only:

```yaml
- project: user
  outcome: REQUIRED
  level: L3
  reopenFrom: domain
  taskRoots:
    - TASK-003

- project: quote
  outcome: REQUIRED
  level: L3
  reopenFrom: spec
  taskRoots: []

- project: pricing
  outcome: NOT_REQUIRED
```

Core calculates the complete downstream closures:

```bash
omnai workset reentry plan WRE-0001 --file proposal.yaml --json
```

The user explicitly approves the frozen plan:

```bash
omnai workset reentry decide WRE-0001 --json
```

Then Core routes each project application:

```bash
omnai workset reentry apply WRE-0001 --project user --json
omnai workset reentry apply WRE-0001 --json
```

A schema-v2 WRE reaches `RESOLVED` only when every application is `APPLIED` or `NOT_REQUIRED`.

### Stale frozen preconditions

If a Project Change advances after DECIDED but before apply, OmnAI records `FAILED + STALE_PRECONDITION` and routes to explicit Replan:

```bash
# read-only preview
omnai workset reentry replan WRE-0001 --project quote --json

# explicit replacement of only the stale frozen application
omnai workset reentry replan WRE-0001 --project quote --confirm --json

# normal apply resumes
omnai workset reentry apply WRE-0001 --project quote --json
```

The old failed attempt is retained in `attemptHistory`. Already APPLIED or NOT_REQUIRED siblings remain unchanged.

## Repository-local Project Change workflow

Inside an ordinary repository or an active Workset child:

```bash
omnai init
omnai new "Move authorization to user center" --scenario complex-domain-feature

omnai status
omnai next --json

omnai research "Recover current authorization behavior and callers"
omnai model "Separate durable authorization from per-quote usage"
omnai spec
omnai design
omnai plan
```

Each preparation creates a bounded run prompt. The run manifest records the exact protocol versions and hashes, plus a hash of the complete rendered prompt.

```yaml
schemaVersion: 2
protocols:
  - id: common.authoritative-work
    version: 1
    hash: sha256:...
  - id: repository.design
    version: 1
    hash: sha256:...
promptHash: sha256:...
```

Protocol loading and complete prompt construction happen before OmnAI creates a run directory, appends progress, or changes Readiness. A missing or invalid protocol therefore fails without leaving half-written workflow state.

Repository-local Reconcile remains available:

```bash
omnai reconcile \
  --level L3 \
  --type DOMAIN_ASSUMPTION_INVALIDATED \
  --reason "AuthorizationRecord mixes consent and quote usage" \
  --task TASK-002
```

## Read-only investigation

Do not create a Project Change merely to answer a question about the current system:

```bash
omnai investigate create field-lineage \
  "Trace premiumAmount from API request to persistence and downstream events"
```

Read-only investigations can be promoted explicitly when implementation is actually required:

```bash
omnai investigate promote INV-0001 \
  "Correct premium amount ownership" \
  --scenario complex-domain-feature
```

## Show-me and Visual Companion

Show-me is an internal read-only interaction protocol, not a fifth Host Skill.

For explanations, comparisons, flows, state machines, or “show me” requests, the `omnai` Entry Skill obtains a fresh Core route and composes:

```text
interaction.show-me
+
current Core-selected action protocols
```

It chooses the smallest useful representation: prose, a table, a static diagram, or—with just-in-time user consent—the built-in Visual Companion.

Validate a declarative visual document:

```bash
omnai visual validate /tmp/omnai-visual.json --json
```

Start a read-only loopback companion:

```bash
omnai visual companion /tmp/omnai-visual.json --json
```

The companion:

- accepts only closed OmnAI JSON document formats;
- binds to `127.0.0.1` with a random token URL;
- exposes no HTTP write API;
- does not execute Agent-provided HTML or JavaScript;
- does not modify workflow state;
- does not open the browser without consent.

Superpowers influences parts of the interaction method but is not a runtime dependency or renderer.

## Important commands

```text
omnai context [--path <path>] [--json]

omnai host install <claude|codex|opencode|all> [--json]
omnai host status [claude|codex|opencode|all] [--json]

omnai protocol show <protocols...> [--json]

omnai project register <path> [--alias <alias>] [--json]
omnai project list [--json]
omnai project inspect <alias> [--json]

omnai workset new <title> [--json]
omnai workset status [workset] [--json]
omnai workset next [workset] [--json]
omnai workset path [workset] [--json]
omnai workset add-candidate <project> [--workset <id>] [--json]
omnai workset inspect-project <project> [--workset <id>] [--result observed-only] [--json]
omnai workset change-bindings <project> [--workset <id>] [--json]
omnai workset bind-change <project> <CHG-id> [--workset <id>] [--json]
omnai workset create-change <project> <title> --scenario <scenario> [--workset <id>] [--json]
omnai workset activate-project <project> [--workset <id>] [--json]
omnai workset mark-inactive <project> [--workset <id>] [--json]

omnai workset change --kind <kind> --reason <text> \
  [--project <alias>]... [--candidate <alias>]... [--workset <id>] [--json]
omnai workset reentry list [workset] [--json]
omnai workset reentry plan <WRE-id> --file <proposal.yaml> [--workset <id>] [--json]
omnai workset reentry decide <WRE-id> [--workset <id>] [--json]
omnai workset reentry apply <WRE-id> [--project <alias>] [--workset <id>] [--json]
omnai workset reentry replan <WRE-id> --project <alias> [--workset <id>] [--confirm] [--json]
omnai workset reentry status <WRE-id> [--workset <id>] [--json]

omnai visual validate <document.json> [--json]
omnai visual companion <document.json> [--port <port>] [--json]

omnai doctor
```

## Safety invariants

1. Original registered repositories are read-only during candidate research.
2. Writable Workset projects are real isolated Git worktrees.
3. A Workset project is never silently bound or rebound to a Project Change.
4. An inactive Worktree is retained but is not eligible for new Workset writes.
5. Agent-proposed Reconcile roots are semantic; Core calculates complete closures.
6. DECIDED freezes exact closures and Revision/Baseline preconditions.
7. Evidence remains attached to the Revision it actually proves.
8. Protocols guide judgment; TypeScript and schemas enforce mechanics.
9. Host installation copies only four Entry Skills, never Protocol Resources.
10. Missing, invalid, unknown, or unmapped protocols are hard failures.
11. Show-me and the Visual Companion are read-only presentation paths.
12. `omnai-run` remains unavailable until Milestone C implements real Wave, Claim, and Run Packet primitives.

## Development verification

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
git diff --check
```

CI runs the full gate on Node.js 20 and Node.js 22.

## Design documents

The authoritative v0.2 reading order is maintained in `docs/design/README.md`.
