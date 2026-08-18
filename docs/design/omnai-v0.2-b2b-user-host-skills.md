# OmnAI v0.2 B2b User-level Host Skills

## 1. Status

This document is the authoritative B2b contract for user-level Codex, Claude Code, and OpenCode integration.

It is a clean pre-release design. OmnAI has not published a stable release, so B2b does not retain compatibility with the earlier repository-local Skill installation experiment, `.codex/skills`, `.opencode/skills`, `omnai init --host`, the repository `install` command, or `ProjectConfig.installedHosts`.

The detailed internal Protocol Resource architecture is defined by:

```text
docs/superpowers/specs/
2026-08-15-omnai-v0.2-b2b-internal-protocol-resources-design.md
```

That amendment is authoritative for protocol identity, loading, routing, prompt audit, packaging, and Show-me behavior.

## 2. Goal

B2b makes deterministic OmnAI Core behavior available in the user's normal Agent host without adding another chat surface or control plane.

```text
Codex / Claude Code / OpenCode
              ↓
      four shared Entry Skills
              ↓
       omnai context --json
              ↓
Core-selected route and protocolIds
              ↓
   omnai protocol show ... --json
              ↓
 deterministic OmnAI commands
```

The Host performs language understanding, questions the user, compares options, and authors artifacts. Core owns context discovery, legal routing, Project Change and Workset state, closures, Revision/Baseline advancement, evidence validity, guards, and persistence.

Core never calls an LLM.

## 3. Public Entry Skill surface

B2b installs exactly four Skills:

```text
omnai
omnai-grill
omnai-brainstorm
omnai-reconcile
```

`omnai-run` is not part of B2b. It will be added only after Milestone C provides real Wave planning, writer claims, Run packets, and bounded parallel execution.

The canonical source is shared across all supported Hosts:

```text
skills/
├── omnai/SKILL.md
├── omnai-grill/SKILL.md
├── omnai-brainstorm/SKILL.md
└── omnai-reconcile/SKILL.md
```

B2b does not maintain separate Claude, Codex, and OpenCode workflow prompts.

## 4. Internal Protocol Resources

Detailed engineering methods are package-internal resources, not Host Skills:

```text
resources/protocols/
├── common/
├── repository/
├── interaction/
└── workset/
```

Examples:

```text
repository.research
repository.model
repository.design
repository.debug
repository.review
repository.verify

interaction.grill
interaction.brainstorm
interaction.show-me

workset.candidate-research
workset.project-impact-decision
workset.project-change-binding
workset.reentry-plan
workset.reentry-apply
workset.reentry-replan
```

Core returns ordered protocol IDs. Entry Skills load them through:

```bash
omnai protocol show <protocolIds...> --json
```

Entry Skills never read a physical package path and never recreate the routing table in Markdown.

## 5. Native user-level installation

The installation targets are:

| Host | Destination |
| --- | --- |
| Claude Code | `~/.claude/skills` |
| Codex | `~/.agents/skills` |
| OpenCode | `~/.config/opencode/skills` |

Commands:

```bash
omnai host install claude
omnai host install codex
omnai host install opencode
omnai host install all

omnai host status
omnai host status claude
omnai host status codex
omnai host status opencode
omnai host status all
```

`status` defaults to all Hosts.

Installation copies only the four Entry Skills. It never copies `resources/protocols/` into a Host Skill directory.

## 6. Ownership and integrity

Host installation state is personal OmnAI state:

```text
~/.omnai/hosts/
├── claude.yaml
├── codex.yaml
└── opencode.yaml
```

Each manifest records:

```yaml
schemaVersion: 1
host: codex
omnaiVersion: 0.2.0
destination: /Users/me/.agents/skills
skills:
  - name: omnai
    hash: sha256:...
  - name: omnai-grill
    hash: sha256:...
  - name: omnai-brainstorm
    hash: sha256:...
  - name: omnai-reconcile
    hash: sha256:...
installedAt: 2026-08-15T00:00:00.000Z
updatedAt: 2026-08-15T00:00:00.000Z
```

The hash covers exact installed `SKILL.md` bytes.

Before writing any requested Host, OmnAI preflights the complete selection:

- missing target and no manifest: installable;
- clean OmnAI-owned installation: idempotent or safely upgradeable;
- same-name directory without OmnAI ownership: hard failure;
- OmnAI-owned file missing: hard failure;
- OmnAI-owned file changed from its recorded hash: hard failure.

`host install all` preflights all three Hosts before writing any of them.

Host status values are:

```text
READY
OUTDATED
NOT_INSTALLED
FOREIGN
MISSING
DRIFTED
```

## 7. Context contract

Every Entry Skill begins with:

```bash
omnai context --json
```

The result is a discriminated union.

### Workset root

```json
{
  "scope": "workset",
  "cwd": "/Users/me/.omnai/worksets/WKS-0001/workspace",
  "worksetId": "WKS-0001",
  "workspaceRoot": "/Users/me/.omnai/worksets/WKS-0001/workspace",
  "project": null
}
```

### Workset project

```json
{
  "scope": "workset-project",
  "cwd": "/Users/me/.omnai/worksets/WKS-0001/workspace/quote/src",
  "worksetId": "WKS-0001",
  "workspaceRoot": "/Users/me/.omnai/worksets/WKS-0001/workspace",
  "project": "quote",
  "memberStatus": "ACTIVE",
  "repoRoot": "/Users/me/.omnai/worksets/WKS-0001/workspace/quote",
  "changeId": "CHG-0018"
}
```

### Ordinary repository

```json
{
  "scope": "repository",
  "cwd": "/Users/me/code/user-center/src",
  "repoRoot": "/Users/me/code/user-center",
  "initialized": true,
  "changeId": "CHG-0027"
}
```

An uninitialized Git repository still returns `scope: repository`, with `initialized: false` and `changeId: null`. Discovery never initializes it.

### None

```json
{
  "scope": "none",
  "cwd": "/Users/me/Downloads"
}
```

Precedence is:

```text
Workset marker/context
    outranks
ordinary Git repository context
    outranks
none
```

This is required because a Workset child is also a Git worktree.

## 8. Entry Skill responsibilities

### `omnai`

The default router:

1. runs `omnai context --json`;
2. in Workset scope, runs `omnai workset next --json`;
3. in repository scope, runs `omnai next --json`;
4. loads Core-selected `protocolIds`;
5. executes only the current legal action;
6. returns to the deterministic router;
7. requires fresh verification evidence for completion claims.

For explanation, comparison, visualization, “show me,” or unclear-explanation requests, it obtains a fresh Core route and composes `interaction.show-me` with the current action protocols. When a prior explanation did not land, the protocol restores the missing premise and escalates repeated failures by stepping back or changing representation. The path is read-only, and the recovery branch is not persisted as user or workflow state.

### `omnai-grill`

A thin explicit entry for unresolved product, domain, scope, ownership, lifecycle, invariant, or acceptance decisions.

It loads:

```text
interaction.grill
+
active repository capability protocol
+
any Workset action protocols selected by Core
```

The full Decision Frontier and questioning method live in the internal protocol.

### `omnai-brainstorm`

A thin explicit entry when the desired outcome is clear but multiple materially different approaches remain viable.

It loads:

```text
interaction.brainstorm
+
active repository capability protocol
+
any Workset action protocols selected by Core
```

The full option-comparison and Experiment escalation method live in the internal protocol.

### `omnai-reconcile`

A thin explicit entry when a new fact or changed requirement may invalidate the active baseline.

Before recording a new Workset Re-entry, it loads `workset.reentry-classification`. After the WRE exists, `omnai workset next --json` supplies the authoritative protocols for interaction, plan, decision, apply, replan, and finalization.

It must preserve these safety rules:

- unaffected work remains intact;
- no silent Project Change bind or rebind;
- no writable candidate before read-only research and explicit confirmation;
- no manually expanded closure;
- explicit user approval before DECIDED;
- no direct resolve for schema-v2 WRE records;
- stale preconditions use explicit project-scoped Replan.

## 9. Repository run integration

Repository `omnai <capability>` commands load the same canonical protocol source used by Host interactions.

```text
omnai next --json
  -> repository.<capability>
  -> prepareStage()
  -> validate protocol bundle
  -> build complete prompt in memory
  -> hash prompt and protocol files
  -> create bounded Run
```

Run manifests use schema version 2:

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

Protocol failure is preflighted before run directories, prompts, progress events, or Readiness changes are written.

## 10. Read-only protocol and visual commands

Read protocols:

```bash
omnai protocol show repository.design
omnai protocol show repository.design --json
```

Validate a Visual Companion document:

```bash
omnai visual validate /tmp/omnai-visual.json --json
```

Run the loopback-only companion:

```bash
omnai visual companion /tmp/omnai-visual.json --json
```

The Visual Companion is a process-scoped read-only presentation surface, not a control plane. It requires just-in-time consent, binds to loopback with a random token URL, executes no Agent-provided HTML or JavaScript, and writes no workflow state.

## 11. Clean-break removals

B2b removes:

- `src/core/host-skills.ts`;
- `omnai init --host`;
- the repository-local `omnai install --host` command;
- `ProjectConfig.installedHosts`;
- `.codex/skills` and `.opencode/skills` mappings;
- fine-grained Host Skills for individual repository capabilities;
- embedded `stagePrompts` as the canonical method source;
- the unused `workflow.lock.yaml.promptVersions` field.

Repository capabilities and deterministic state machines remain. Removing fine-grained Host Skills does not remove `research`, `model`, `spec`, `design`, `plan`, `work`, `review`, `verify`, or other Core capabilities.

## 12. Invariants

1. Four shared Entry Skills, not three Host-specific workflow forks.
2. Every Entry Skill starts from `omnai context --json`.
3. Workset truth comes from `omnai workset next --json`.
4. Repository truth comes from `omnai next --json` and repository state.
5. Core selects legal actions and ordered protocol IDs.
6. Protocols guide judgment; Core enforces mechanics.
7. User-level installation is independent of repository initialization.
8. Host installation never copies Protocol Resources.
9. Foreign, missing, or drifted managed files are never silently overwritten.
10. Project-specific rules remain project truth, not global Skill forks.
11. Show-me is read-only and is not a fifth Skill.
12. `omnai-run` remains unavailable until Milestone C provides real execution primitives.
13. No Web UI, server, database, daemon, background scheduler, or embedded LLM API is introduced.
