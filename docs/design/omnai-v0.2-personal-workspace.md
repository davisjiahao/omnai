# OmnAI v0.2 Personal Workspace Design

## 1. Purpose

OmnAI v0.2 extends the v0.1 repository-local workflow into a **personal, multi-project engineering workspace** for one engineer working across multiple repositories and multiple AI coding-agent hosts.

v0.2 keeps the v0.1 core principles intact:

- repository-local `.omnai/` remains authoritative for each project's Change, Revision, Baseline, artifacts, tasks, evidence, review, and learning;
- the OmnAI CLI remains the deterministic workflow/state/guard engine;
- the CLI still does not call an LLM;
- the active host agent (Codex, Claude Code, OpenCode, or a VS Code agent integration) performs reasoning and implementation;
- no Web application, backend service, database, daemon, vector store, or cloud control plane is introduced in v0.2.

v0.2 solves a different problem from v0.1:

> v0.1 answers “how should this engineering change be executed safely inside a repository?”
>
> v0.2 answers “how does one engineer safely coordinate one engineering objective across several repositories, worktrees, agent workers, and mid-flight requirement changes?”

## 2. User experience target

The normal user experience is intentionally small:

1. the user talks to the LLM in the agent surface they already use: Codex CLI, Claude Code, OpenCode, or a VS Code agent chat;
2. `/omnai <request>` routes the work;
3. OmnAI performs read-only research before changing unknown repositories;
4. Grill and Brainstorm happen in the current agent conversation only when needed;
5. once a repository is confirmed to require changes, OmnAI gives it a dedicated Git worktree for this Workset;
6. the Workset's writable worktrees form a VS Code multi-root `.code-workspace`;
7. several repositories may be written in parallel when the cross-project dependency graph says it is safe;
8. requirement changes use selective Reconcile and re-enter only the affected Research, Grill, Brainstorm, Spec, Design, Plan, or Work path;
9. a newly affected repository is researched first, then dynamically added to the Workset and VS Code workspace only if modification is confirmed.

The user should not need to remember a long list of CLI commands. The primary interaction remains `/omnai ...` and “continue”.

## 3. Product boundaries

### 3.1 In scope for v0.2

- single-user Project Registry;
- personal Worksets spanning one or more repositories;
- dynamic Workset membership;
- dedicated Git worktree per writable Workset member;
- generated VS Code multi-root `.code-workspace` for the active Workset;
- optional lightweight VS Code extension for native visualization, workspace synchronization, navigation, and commands;
- user-level OmnAI host skills/plugins for Codex, Claude Code, and OpenCode, while keeping v0.1 project-local installation compatible;
- Workset-level dependency graph and parallel Wave planning;
- host-assisted parallel workers across different repositories;
- Run and Claim records;
- selective mid-flight Reconcile;
- re-entry into Grill and Brainstorm where required;
- dynamic discovery and addition of newly affected projects;
- workset-level status, next action, attention, and cross-project search;
- deterministic JSON CLI contracts for agent hosts and the VS Code extension.

### 3.2 Explicit non-goals

v0.2 does not add:

- a Web UI or Webview-based application;
- Fastify, Express, Spring Boot, or another local server;
- SQLite, PostgreSQL, Redis, Elasticsearch, Neo4j, or a vector database;
- a daemon or always-running scheduler;
- automatic LLM API calls from OmnAI Core;
- OmnAI-spawned Codex/Claude/OpenCode processes as the primary execution mode;
- a distributed agent swarm;
- multi-user collaboration, RBAC, tenancy, enterprise approval workflows, or centralized control plane;
- automatic push, pull-request merge, release, or deployment;
- two concurrent writers in the same repository in v0.2.0.

## 4. Core concepts

v0.2 separates four concepts that must not be conflated.

### 4.1 Project Registry

The Project Registry is the user's long-lived catalog of original repositories.

Example:

```text
~/code/
├── user-center
├── quote-center
├── order-center
├── mall-service
├── pricing-center
└── insurance-web
```

The registry records stable aliases and original repository paths. These original repositories are the source for read-only investigation and the source repository for creating Workset worktrees.

The registry is personal local state, not project truth.

### 4.2 Workset

A Workset is one engineering objective that may span multiple repositories.

Example:

```text
WKS-0001 Authorization Migration
```

A Workset coordinates child project Changes, dependencies, Runs, Waves, worktrees, and local execution metadata. A Workset does **not** replace each project's `.omnai/changes/CHG-*` state and does not become a second project-level source of truth.

### 4.3 Execution Workspace

The Execution Workspace is the set of dedicated Git worktrees belonging to the current Workset.

Example:

```text
~/.omnai/worksets/WKS-0001/
├── workspace/
│   ├── user-center/
│   ├── mall-service/
│   ├── quote-center/
│   └── order-center/
├── Authorization-Migration.code-workspace
├── workset.yaml
├── runs/
├── claims/
└── events.jsonl
```

Every directory under `workspace/` is a Git worktree. Original project directories are not writable execution targets.

### 4.4 VS Code Workspace

The generated `.code-workspace` is a view over the current Workset's writable worktrees.

Default relationship:

```text
one engineering objective
        ↓
one Workset
        ↓
one Execution Workspace
        ↓
one .code-workspace
        ↓
one VS Code window
```

The VS Code Workspace is not authoritative state. It can be regenerated from Workset state and the Git worktree registry.

## 5. Persistence model

### 5.1 Project truth

Project-level truth remains Git-managed under each project worktree:

```text
<project-worktree>/.omnai/
├── project/
├── investigations/
└── changes/
```

The existing v0.1 ownership remains:

- Reality facts come from code/configuration/Git/runtime evidence;
- Meaning is captured in reviewed domain artifacts;
- Intent is the active project Change revision;
- Completion is fresh evidence for the active Revision.

### 5.2 Personal execution state

Personal state lives under the user's OmnAI home:

```text
~/.omnai/
├── projects.yaml
└── worksets/
    └── WKS-0001/
        ├── workset.yaml
        ├── Authorization-Migration.code-workspace
        ├── workspace/
        ├── runs/
        ├── claims/
        ├── packets/
        └── events.jsonl
```

Personal state may contain paths, process/host metadata, claims, cached summaries, and cross-project references. It is not allowed to override project `.omnai` truth.

### 5.3 Workset member state

A Workset member has a lifecycle:

```text
CANDIDATE
  ↓
RESEARCH_ONLY
  ├── impact disproved → OBSERVED_ONLY
  └── modification confirmed → ACTIVE
                                  ↓
                              worktree created
                                  ↓
                              Change linked
                                  ↓
                              writable execution

ACTIVE
  └── later removed from scope → INACTIVE
                                   ↓
                               retained until safe cleanup
```

Rules:

- `CANDIDATE` and `RESEARCH_ONLY` use the original repository read-only;
- `ACTIVE` requires a dedicated Workset worktree before any source write;
- `INACTIVE` worktrees are not immediately deleted because they may contain commits, evidence, or incomplete work;
- `OBSERVED_ONLY` repositories are retained in Workset history but are not added to the VS Code workspace.

## 6. Worktree safety model

### 6.1 Mandatory isolation

All source-code writes for Workset work must occur inside the Workset-specific worktree.

The following are forbidden execution targets:

```text
~/code/user-center
~/code/quote-center
~/code/order-center
```

Writable targets are instead:

```text
~/.omnai/worksets/WKS-0001/workspace/user-center
~/.omnai/worksets/WKS-0001/workspace/quote-center
~/.omnai/worksets/WKS-0001/workspace/order-center
```

### 6.2 Branch naming

Each Workset member uses a dedicated branch derived from the Workset identity. The branch name is deterministic and repository-local, for example:

```text
omnai/WKS-0001-authorization-migration
```

Because each branch lives in a different repository, the same branch name may safely be used across member repositories.

### 6.3 Write guard

A Run may write only when all of these hold:

- the project is an `ACTIVE` member of the Workset;
- the current Run owns the Task claim;
- the target path is under that project's Workset worktree;
- the target path satisfies the Task's allowed scope;
- the project's active Revision and Baseline still match the Run packet;
- no blocking Reconcile signal applies to the Run;
- no other active writer exists for the same repository.

Violations are hard failures, not warnings.

## 7. LLM and interaction surfaces

### 7.1 Where human/LLM conversation happens

OmnAI does not create a new chat UI. Human interaction happens in the active agent host:

- Codex CLI inside the VS Code terminal;
- Claude Code inside the VS Code terminal;
- OpenCode inside the VS Code terminal;
- a supported VS Code agent-chat plugin.

The VS Code OmnAI extension does not implement an LLM chat window.

### 7.2 Division of responsibility

```text
VS Code Extension
= visualize, navigate, synchronize, invoke CLI commands

OmnAI CLI
= route, validate, persist, guard, reconcile, plan cross-project waves

Agent Host
= reason, ask the user, research, grill, brainstorm, implement, review
```

The agent host may use its own native subagent/worker facility. OmnAI does not require the CLI to spawn or supervise those LLM processes in v0.2.0.

## 8. Grill and Brainstorm semantics

Grill and Brainstorm are **interaction protocols**, not new mandatory linear workflow stages.

This keeps the v0.1 Readiness model intact and prevents a second waterfall from forming.

### 8.1 Grill

Grill resolves decisions where the problem meaning, scope, rule, ownership, lifecycle, or acceptance criteria are not defined well enough to continue.

Grill may be invoked while making an existing capability ready:

- `frame` → product/goal Grill;
- `model` → domain Grill;
- `spec` → scope/acceptance Grill;
- `design` → boundary/constraint Grill when the unresolved item is a decision rather than an implementation option.

Typical trigger:

```text
Evidence is insufficient to answer a blocking decision,
and the decision must come from the user/domain owner.
```

Example:

```text
“Is durable Authorization the same concept as one quote's AuthorizationUsage?”
```

### 8.2 Brainstorm

Brainstorm compares multiple viable approaches once the desired outcome is sufficiently clear.

Typical locations:

- `frame` → product approach Brainstorm;
- `design` → technical architecture Brainstorm;
- `qa` / UX work → interaction Brainstorm;
- `release` / migration work → delivery Brainstorm.

Typical trigger:

```text
At least two viable approaches remain,
the tradeoff is material,
and selecting one is required before the target capability can be READY.
```

Example:

```text
“Should authorization migration use big-bang cutover, dual-write migration, or event synchronization?”
```

### 8.3 Experiment

When Brainstorm cannot choose reliably by reasoning alone, the active workflow routes to the existing `experiment` capability and uses measured evidence.

### 8.4 User commands

The user-facing host integration exposes:

```text
/omnai <request>
/omnai-grill <topic>
/omnai-brainstorm <topic>
/omnai-run
/omnai-reconcile
```

`/omnai` remains the default. The two explicit interaction commands are escape hatches for users who intentionally want deeper questioning or option comparison.

## 9. Routing model

The CLI remains deterministic; the LLM host translates natural-language intent into structured OmnAI operations.

The high-level decision model is:

```text
unknown current reality
  → Research

unresolved product/domain/scope decision
  → Grill within the blocked capability

multiple viable implementation/delivery approaches
  → Brainstorm within the blocked capability

reasoning cannot select safely
  → Experiment

spec/design/plan ready
  → Work

new fact or changed requirement invalidates active assumptions
  → Reconcile
```

The CLI must expose an explainable next-action JSON contract so the host can show why an interaction is required rather than inventing a parallel workflow in chat.

Conceptual result:

```json
{
  "next": "model",
  "interaction": "grill",
  "reason": [
    "Authorization has multiple meanings across project evidence",
    "ownership and lifecycle are unresolved",
    "specification depends on this decision"
  ]
}
```

## 10. Cross-project Workset workflow

Consider the request:

```text
Move authorization ownership from mall-service to user-center,
and update quote-center and order-center.
```

### 10.1 Step A: Workset creation

OmnAI creates a local Workset:

```text
WKS-0001 Authorization Migration
```

Initial candidate projects:

```text
mall-service
user-center
quote-center
order-center
```

### 10.2 Step B: parallel read-only research

The agent host may research candidate repositories in parallel. The original repositories are read-only targets.

Example findings:

- `mall-service` owns `AuthorizationRecord` and persistence;
- `user-center` has partial consent capability;
- `quote-center` reads authorization before quoting;
- `order-center` preserves an authorization snapshot;
- the same `AuthorizationRecord` name mixes durable authorization, quote usage, and historical snapshot semantics.

### 10.3 Step C: confirm active members and create worktrees

Repositories confirmed to require changes become `ACTIVE` members. OmnAI creates one dedicated worktree per active member, links/creates the project Change, and adds the worktree to the generated `.code-workspace`.

Repositories disproven as write targets remain `OBSERVED_ONLY` and do not receive worktrees.

### 10.4 Step D: Grill

The current agent conversation resolves blocking domain decisions, for example:

```text
Authorization
= durable authorization relationship

AuthorizationUsage
= historical fact that a quote used authorization

AuthorizationSnapshot
= transaction-time historical snapshot where required
```

The results update the appropriate project artifacts and Workset cross-project references.

### 10.5 Step E: Brainstorm

Once meaning is clear, technical migration options are compared:

- big-bang switch;
- dual-write gradual migration;
- event-based synchronization.

The selected approach updates project design/contract/delivery artifacts.

### 10.6 Step F: plan cross-project Waves

Project task DAGs remain authoritative. The Workset creates a coordination graph referencing fully-qualified child tasks.

Example:

```text
WAVE-1
  user/TASK-001       READY
  mall/TASK-002       READY

WAVE-2
  quote/TASK-003      depends on user/TASK-001 contract
  order/TASK-004      depends on user/TASK-001 contract

WAVE-3
  reconciliation / retirement
```

A task reference is always fully scoped:

```text
project/change/revision/task
```

so two repositories may both have `TASK-001` without ambiguity.

## 11. Parallel write model

v0.2 explicitly allows multiple repositories to be written in parallel.

### 11.1 Rule

```text
multiple repositories: parallel writers allowed
same repository: at most one active writer in v0.2.0
```

### 11.2 Wave Planner

Parallelism is decided by OmnAI's deterministic Wave Planner, not by a worker prompt.

A task can join the same parallel Wave only if:

- its project is active in the Workset;
- its project has a dedicated worktree;
- its project has no active writer claim;
- all task dependencies are satisfied;
- all cross-project contract dependencies are satisfied for the referenced active Revision;
- no blocking Reconcile signal affects the task;
- policy/risk rules permit execution;
- the host reports that it can execute isolated workers safely.

### 11.3 Host-assisted workers

The active agent host owns actual LLM worker creation.

Example:

```text
Codex main session
  ├── worker A → user-center worktree
  └── worker B → mall-service worktree
```

OmnAI provides each worker a Run packet containing only the bounded context required for that task.

A worker does not choose the next scenario, redefine the Workset, switch repositories, or spawn further OmnAI tasks. It executes the bound Run and reports completion, block, or invalidating signal.

### 11.4 Run packet

A Run packet binds execution to project truth:

```yaml
runId: RUN-0101
worksetId: WKS-0001
project: user-center
changeId: CHG-0027
revision: REV-0004
baseline: BL-0004
taskId: TASK-001
worktree: ~/.omnai/worksets/WKS-0001/workspace/user-center
allowedPaths:
  - src/main/java/**/authorization/**
  - src/test/**/authorization/**
requiredEvidence:
  - unit-test
  - contract-test
stopConditions:
  - DOMAIN_ASSUMPTION_INVALIDATED
  - CONTRACT_REVISION_CHANGED
  - OUT_OF_SCOPE_CHANGE_REQUIRED
```

## 12. Mid-flight requirement changes: Selective Re-entry

v0.2 formalizes **Selective Re-entry** on top of v0.1 Reconcile.

A requirement change does not restart the whole workflow. Reconcile first identifies what changed and which facts/artifacts/tasks depend on it.

Conceptually:

```text
Work
  ↓
new requirement / new system fact / failed assumption
  ↓
Reconcile
  ↓
classify impact
  ├── reality unknown       → Research
  ├── meaning/scope changed → Grill
  ├── implementation choice changed → Brainstorm
  ├── evidence needed       → Experiment
  ├── task structure only   → Plan
  └── implementation detail → Work
  ↓
new Revision/Baseline where required
  ↓
selective invalidation
  ↓
resume unaffected work
```

### 12.1 Example: domain requirement changes

Existing assumption:

```text
quote reads current Authorization
```

New requirement:

```text
historical quotes must preserve the authorization state used at quote time
```

OmnAI classifies this as a domain/requirement change. The affected project Changes re-enter Domain Grill, then Technical Brainstorm only if more than one implementation approach remains.

Unaffected completed tasks stay valid. Affected tasks become `NEEDS_REVALIDATION` or `INVALIDATED` under existing v0.1 reconcile semantics.

### 12.2 Worker handling

If a running worker becomes affected:

```text
RUNNING → PAUSE_REQUESTED / BLOCKED
```

Unaffected workers continue.

There is no “stop every worker because anything changed” rule.

## 13. Adding a newly affected repository mid-flight

A new repository follows a staged process.

Example requirement change:

```text
pricing-center must now use authorization scope when choosing data sources.
```

### 13.1 Candidate first

`pricing-center` is added as a Workset `CANDIDATE`, not immediately as a writable workspace folder.

### 13.2 Read-only research

The original `pricing-center` repository is researched read-only.

Outcomes:

1. impact disproved → member becomes `OBSERVED_ONLY`, no worktree, no VS Code folder;
2. modification confirmed → member becomes `ACTIVE`.

### 13.3 Promote to active member

When modification is confirmed, OmnAI:

1. creates the Workset-specific `pricing-center` worktree;
2. creates or links the project-local Change in that worktree;
3. records Workset dependencies;
4. adds the worktree to the generated `.code-workspace`;
5. invalidates only affected cross-project tasks/artifacts;
6. recalculates Waves.

### 13.4 VS Code behavior

With the optional OmnAI VS Code extension installed, the new worktree is dynamically added to the current multi-root workspace without reopening the window.

Without the extension, OmnAI updates the `.code-workspace` file and reports that a workspace reload may be required.

## 14. Removing a repository from active scope

A repository already written in the Workset is never immediately deleted when scope changes.

It transitions:

```text
ACTIVE → INACTIVE
```

Its worktree and commits remain available until explicit safe cleanup. The VS Code extension may mark it inactive and offer removal from the visible workspace after there are no active claims and the user accepts cleanup.

Historical Workset/Run references remain inspectable after cleanup.

## 15. VS Code extension

The VS Code extension is optional. OmnAI CLI and host skills must remain fully usable without it.

### 15.1 Responsibilities

The extension may:

- detect the current Workset from the generated `.code-workspace`;
- call OmnAI CLI JSON commands;
- show current workflow/readiness, Workset members, Waves, Runs, and attention items;
- open project worktrees, artifacts, tasks, evidence, and diffs;
- synchronize multi-root workspace folders with active Workset worktrees;
- invoke commands such as “Open Worktree”, “Refresh”, “Run Next”, or “Reconcile” by delegating to the CLI/host integration;
- surface blocking changes and stale dependencies.

The extension must not:

- contain a workflow state machine;
- invent a next step independently of OmnAI CLI;
- call LLM APIs;
- implement a custom chat UI;
- directly mutate project truth without going through CLI contracts.

### 15.2 UI model

Use native VS Code APIs only; no Webview and no React.

One OmnAI Activity Bar container exposes three compact native views:

```text
WORKSET
  current objective
  active/observed/inactive projects
  workflow next action
  Waves and task readiness

RUNS
  active and recent Runs
  worktree / task / status / claim

ATTENTION
  reconcile required
  stale contract
  blocked task
  missing evidence
```

### 15.3 Dynamic workspace synchronization

The extension treats the Workset manifest as authoritative for which worktrees should be visible.

When a new project becomes `ACTIVE`:

```text
Workset updated
  ↓
worktree created
  ↓
.code-workspace updated
  ↓
VS Code extension adds workspace folder
```

When a project becomes `INACTIVE`, the extension does not remove it automatically while a claim, uncommitted work, or unresolved cleanup state remains.

## 16. Host skill/plugin model

### 16.1 User-level entry skills

v0.2 adds user-level installation for the small control surface:

```text
omnai
omnai-grill
omnai-brainstorm
omnai-run
omnai-reconcile
```

The host adapter resolves the correct user-level integration location. v0.1 project-local skill installation remains supported for compatibility.

### 16.2 Skill responsibility

The entry skill must:

- inspect current OmnAI context through CLI JSON;
- translate user language into structured CLI operations;
- follow the CLI-provided next action;
- perform Grill/Brainstorm in the current host conversation when requested;
- ask the host to create isolated workers only for CLI-approved parallel Runs;
- report Run outcomes and invalidating signals back to OmnAI.

The entry skill must not maintain its own long-lived workflow state.

### 16.3 Project-specific differences

Project-specific conventions remain project-managed under `.omnai/project/` and existing policy/artifact mechanisms. v0.2 must not fork full host skills per project to represent Java, frontend, database, or delivery differences.

## 17. CLI surface

The exact user-visible syntax should remain small. The internal CLI may expose more structured commands for plugins and the VS Code extension.

### 17.1 Project Registry

```text
omnai project register <path> [--alias <alias>]
omnai project list
omnai project inspect <alias>
```

### 17.2 Worksets

```text
omnai workset new <title>
omnai workset status [workset]
omnai workset next [workset]
omnai workset add-candidate <project>
omnai workset inspect-project <project>
omnai workset activate-project <project>
omnai workset deactivate-project <project>
omnai workset sync-workspace
omnai workset open
```

### 17.3 Parallel execution

```text
omnai wave plan
omnai wave claim <wave>
omnai run prepare <task>
omnai run finish <run>
omnai run block <run>
omnai run signal <run>
```

Human-facing skills should normally hide these details.

### 17.4 Reconcile

The agent host turns a user requirement change or worker signal into a structured Reconcile proposal. The CLI validates and applies the existing v0.1 reconcile semantics, advances Revision/Baseline where required, and returns the next affected capability plus interaction mode.

The CLI still does not classify natural language with an embedded model.

## 18. Cross-project dependency and evidence rules

### 18.1 Task identity

Cross-project dependency references use:

```text
project/change/revision/task
```

### 18.2 Contract dependencies

A downstream task may depend on a specific upstream contract artifact/version. If the upstream Revision advances and that dependency is invalidated, the downstream task is blocked or requires revalidation.

### 18.3 Evidence isolation

Evidence remains project Change + active Revision scoped. A passing test in `user-center` cannot satisfy an Evidence Matrix requirement in `quote-center` unless the downstream requirement explicitly points to imported cross-project evidence and the policy permits it.

### 18.4 CommitSet

A Workset may record a local `CommitSet` linking the commits produced by its member repositories:

```yaml
id: CST-0001
worksetId: WKS-0001
commits:
  - project: user-center
    commit: abc123
    changeId: CHG-0027
    revision: REV-0004
  - project: quote-center
    commit: def456
    changeId: CHG-0018
    revision: REV-0003
```

CommitSet is a coordination record, not a claim of atomic Git transactions across repositories.

## 19. Error and recovery behavior

### 19.1 Missing repository

If a referenced project is not registered, OmnAI returns a structured “project not registered” state. The VS Code extension may offer a folder picker; terminal hosts ask the user for the repository path.

### 19.2 Dirty or incompatible source repository

Worktree creation validates the source Git repository and branch/ref. OmnAI must not destroy, reset, or overwrite the user's original working copy to create an Execution Workspace.

### 19.3 Stale claim

Claims include enough local metadata to detect obvious abandoned Runs. Recovery is explicit; OmnAI never silently lets two writers own the same repository.

### 19.4 Partial Wave completion

Cross-repository Waves are not transactions. If one Run fails after another commits, the Workset becomes partially complete. Successful commits remain recorded; failed/blocked Runs remain visible; subsequent Reconcile or recovery work decides the next action.

### 19.5 VS Code unavailable

All core operations remain CLI-capable. Generating the `.code-workspace` file is still useful, but absence of VS Code never blocks Workset execution.

## 20. Technical stack

v0.2 intentionally stays close to v0.1.

### Core

- Node.js 20+;
- TypeScript;
- Commander;
- Zod;
- YAML / JSON / JSONL / Markdown;
- Node standard `fs`, `path`, `crypto`, and `child_process` APIs;
- native Git CLI for worktree/branch/repository operations;
- no persistence database.

### VS Code extension

- TypeScript;
- VS Code Extension API;
- native TreeView / commands / workspace folder APIs;
- no React;
- no Webview;
- no local HTTP server.

### Testing

- current Node-based test harness for Core;
- filesystem/Git integration fixtures for worktree and Workset behavior;
- deterministic fixture-based host-adapter tests;
- VS Code extension unit/integration tests around CLI adapter and tree projection;
- CI continues to cover Node 20 and Node 22 for Core.

## 21. Implementation decomposition

The complete v0.2 design spans several independently testable subsystems. It must be implemented as separate plans rather than one giant change.

### Milestone A — Personal Workset Core

Deliver a usable CLI-only vertical slice:

- Project Registry;
- Workset model and local persistence;
- candidate/observed/active/inactive membership;
- mandatory per-project Git worktree creation;
- generated `.code-workspace`;
- Workset status/next JSON;
- safe dynamic project activation/deactivation;
- no VS Code extension dependency.

A user should be able to create one multi-repository Workset and obtain a safe Worktree-based execution workspace using only the CLI.

### Milestone B — Selective Re-entry and interaction routing

Add:

- Grill and Brainstorm interaction modes;
- explainable routing contracts;
- user-level `omnai`, `omnai-grill`, `omnai-brainstorm`, and `omnai-reconcile` entry skills;
- Workset-aware Reconcile;
- mid-flight candidate project discovery and activation;
- propagation from upstream Revision changes to cross-project dependencies.

### Milestone C — Parallel Waves and host-assisted Runs

Add:

- cross-project task references;
- Wave Planner;
- per-repository writer claims;
- Run packets;
- host capability contract for isolated parallel workers;
- Run finish/block/signal;
- partial-Wave recovery;
- CommitSet.

### Milestone D — VS Code Personal Workspace Extension

Add the optional native extension:

- Workset, Runs, and Attention TreeViews;
- dynamic workspace folder synchronization;
- open worktree/artifact/task commands;
- CLI JSON adapter;
- no chat and no Webview.

Each milestone must be independently testable and releasable on the v0.2 branch.

## 22. Acceptance scenarios

v0.2 is not complete until these scenarios work end-to-end.

### Scenario 1 — Cross-repository migration

Given registered `mall-service`, `user-center`, `quote-center`, and `order-center`, a user starts one authorization-migration Workset. Read-only research identifies affected repositories, dedicated worktrees are created, a `.code-workspace` is generated, and project Changes remain repository-local.

### Scenario 2 — Grill then Brainstorm

Research exposes an overloaded authorization concept. `/omnai` routes to Domain Grill before Design. Once domain decisions are resolved, multiple migration approaches route to Brainstorm. The interaction happens in the current Agent host; the CLI records no hidden LLM state.

### Scenario 3 — parallel repositories

A Wave containing an independent `user-center` task and `mall-service` task can be claimed concurrently in separate worktrees. A second writer to either repository is rejected. Downstream `quote-center` and `order-center` tasks remain blocked until referenced upstream dependencies are satisfied.

### Scenario 4 — mid-flight requirement change

While `quote-center` and `order-center` work is active, the user changes historical authorization semantics. OmnAI selectively pauses affected work, re-enters Domain Grill, advances affected Revision/Baseline state, invalidates only affected downstream tasks/evidence, and allows unaffected work to continue.

### Scenario 5 — new project discovered mid-flight

A new requirement names `pricing-center`. OmnAI researches its original repository read-only. If no code change is required it stays `OBSERVED_ONLY`. If a change is confirmed, OmnAI creates a dedicated worktree, adds it as an active Workset member, updates the `.code-workspace`, and recalculates cross-project Waves.

### Scenario 6 — VS Code is optional

All scenarios above remain operable through CLI + host skills without the VS Code extension. When the extension is installed, it reflects the same CLI state rather than creating a second workflow state.

## 23. Design invariants

The following are non-negotiable v0.2 invariants:

1. Project `.omnai/` truth always outranks Workset cache/coordination state.
2. Original registered repositories are never used as Workset source-write targets.
3. Writable Workset members always use dedicated Git worktrees.
4. New repositories are researched before writable activation.
5. Grill and Brainstorm happen in the existing Agent conversation; VS Code does not implement chat.
6. Grill and Brainstorm are interaction protocols within existing workflow capabilities, not mandatory universal stages.
7. Reconcile performs selective re-entry; requirement changes do not restart the entire workflow.
8. Multiple repositories may write in parallel; one repository has at most one active writer in v0.2.0.
9. OmnAI CLI decides whether a task is eligible for a parallel Wave; worker prompts do not decide workflow legality.
10. The active Host performs LLM worker dispatch; OmnAI CLI does not become an agent-process supervisor in v0.2.0.
11. VS Code is an optional view/navigation/integration layer, never the workflow state owner.
12. No Web UI, server, database, daemon, or built-in LLM API is introduced in v0.2.
