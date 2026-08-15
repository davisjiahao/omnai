# OmnAI v0.2 B2b User-level Host Skills Design

## 1. Status

This document is the authoritative B2b contract for local Codex, Claude Code, and OpenCode integration.

B2b is a clean pre-release design. OmnAI has not shipped a public release, so this milestone does not preserve the earlier repository-local Host installation experiment, `.codex/skills`, `.opencode/skills`, `omnai init --host`, or `ProjectConfig.installedHosts`.

## 2. Goal

B2b makes the existing deterministic OmnAI Core usable from the user's normal Agent host without adding another chat surface, server, database, daemon, background scheduler, or embedded LLM API.

```text
Codex / Claude Code / OpenCode
              ↓
      four canonical Skills
              ↓
       omnai context --json
              ↓
 deterministic OmnAI CLI/Core
```

The Host performs language understanding and user interaction. Core owns context discovery, Workset routing, Project Change state, closure calculation, Revision/Baseline advancement, guards, and persistence.

## 3. Scope

B2b delivers exactly four canonical user-level Skills:

```text
omnai
omnai-grill
omnai-brainstorm
omnai-reconcile
```

`omnai-run` is not part of B2b. It will be introduced only after Milestone C implements Wave planning, writer claims, Run packets, and bounded parallel execution.

B2b also delivers:

- one shared Skill source for all three Hosts;
- native user-level installation targets for each Host;
- `omnai context --json` as the common context contract;
- `omnai host install` and `omnai host status`;
- a user-local ownership/integrity manifest under the OmnAI home;
- removal of the unreleased project-local Host installation path;
- exact Skill inventory and contract tests.

## 4. Canonical Skill model

The repository contains one canonical definition per Skill:

```text
skills/
├── omnai/SKILL.md
├── omnai-grill/SKILL.md
├── omnai-brainstorm/SKILL.md
└── omnai-reconcile/SKILL.md
```

The same content is installed for all Hosts. Host-specific behavior may be represented only by a thin metadata/adapter file when a Host requires it. B2b does not maintain separate Claude, Codex, and OpenCode workflow prompts.

The canonical Skill directory is package content, not project truth and not a user customization surface.

Personal preferences belong in future user-level OmnAI preferences. Company/team/project rules remain repository-managed under `.omnai/project/` and related project artifacts.

## 5. Native user-level installation targets

The installation targets are:

| Host | User-level destination |
| --- | --- |
| Claude Code | `~/.claude/skills` |
| Codex | `~/.agents/skills` |
| OpenCode | `~/.config/opencode/skills` |

Only the four B2b entry Skills are copied to these directories.

OpenCode can also discover Claude-compatible and Agent-compatible locations, but OmnAI installs to OpenCode's own native global directory to keep ownership and status unambiguous.

## 6. Context contract

Every B2b Skill begins by obtaining machine context through:

```bash
omnai context --json
```

Skills must not infer context by independently probing marker files, Git state, or a sequence of failing CLI commands.

The result is a discriminated union.

### 6.1 Workset root

```json
{
  "scope": "workset",
  "cwd": "/Users/me/.omnai/worksets/WKS-0001/workspace",
  "worksetId": "WKS-0001",
  "workspaceRoot": "/Users/me/.omnai/worksets/WKS-0001/workspace",
  "project": null
}
```

### 6.2 Workset project

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

### 6.3 Ordinary Git repository

```json
{
  "scope": "repository",
  "cwd": "/Users/me/code/user-center/src",
  "repoRoot": "/Users/me/code/user-center",
  "initialized": true,
  "changeId": "CHG-0027"
}
```

An uninitialized Git repository still returns `scope: repository`, with `initialized: false` and `changeId: null`. Context discovery never initializes the repository.

### 6.4 No OmnAI-capable filesystem context

```json
{
  "scope": "none",
  "cwd": "/Users/me/Downloads"
}
```

### 6.5 Precedence

```text
Workset marker/context
    outranks
ordinary Git repository context
    outranks
none
```

This is required because every Workset child is itself a Git worktree.

## 7. Skill responsibilities

### 7.1 `omnai`

The default entry/router.

It must:

1. call `omnai context --json`;
2. in Workset scope, call `omnai workset next --json` and follow the returned action;
3. in repository scope, use repository-local `status`/`next` truth;
4. route a Workset `grill` interaction to `omnai-grill` behavior;
5. route a Workset `brainstorm` interaction to `omnai-brainstorm` behavior;
6. route change/reconcile/apply/replan/finalize work to `omnai-reconcile` behavior;
7. avoid creating a Workset, project state, or Project Change without an explicit user decision;
8. avoid completion claims without fresh verification evidence.

It must not implement Wave/Run behavior before Milestone C.

### 7.2 `omnai-grill`

Use when a blocking product, domain, scope, ownership, lifecycle, invariant, or acceptance decision is unresolved.

It must:

- ground questions in current research and authoritative artifacts;
- identify the smallest Decision Frontier;
- ask one high-leverage question at a time;
- make options and consequences concrete;
- preserve decisions already settled by the active Revision;
- stop once the active capability has enough decisions to continue;
- return control to the deterministic Router after recording the decision in the relevant artifact/context.

It must not compare technical implementation options merely because multiple implementations exist; that belongs to Brainstorm after outcome/meaning is clear.

### 7.3 `omnai-brainstorm`

Use when the desired outcome is sufficiently clear and two or more materially different technical, migration, UX, or delivery approaches remain viable.

It must:

- state constraints and evaluation criteria;
- compare a small set of genuinely distinct options;
- recommend one option with explicit tradeoffs;
- route to `experiment` when evidence, rather than reasoning, is required;
- record the selected decision in the appropriate design/delivery artifact;
- return control to the deterministic Router.

It must not reopen product/domain meaning unless the comparison exposes a genuine upstream ambiguity; in that case it stops and routes to Grill/Reconcile.

### 7.4 `omnai-reconcile`

Use when the user, research, runtime evidence, or a worker introduces a fact that may invalidate the active Workset or Project Change baseline.

In Workset scope it must:

- classify the change into one structured WRE kind;
- identify existing affected projects and newly suspected candidate projects;
- record the WRE through `omnai workset change`;
- repeatedly follow `omnai workset next --json` precedence;
- research candidate projects read-only before activation;
- use Grill/Brainstorm only when the Router requests it;
- propose semantic `reopenFrom` and Task roots, never a manually expanded closure;
- run `reentry plan` and show Core-calculated closures;
- obtain explicit user approval before `reentry decide`;
- use `apply`, `replan`, and finalization exactly as routed;
- never use legacy direct `reentry resolve` for schema-v2 WRE records.

In repository scope it uses repository-local `omnai reconcile` and the existing deterministic Reconcile engine.

## 8. User-level Host commands

```text
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

`omnai init` only initializes repository-local `.omnai` state. It has no `--host` option.

## 9. Installation ownership and integrity

Personal Host installation state is stored under:

```text
~/.omnai/hosts/
├── claude.yaml
├── codex.yaml
└── opencode.yaml
```

Conceptual manifest:

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

The hash covers canonical `SKILL.md` bytes.

### 9.1 Install preflight

Before changing any destination, OmnAI validates every requested Host/Skill target.

- target absent: installable;
- target exists and is owned by the Host manifest and still matches its recorded hash: safely upgradeable;
- target exists without OmnAI ownership: hard failure;
- target is OmnAI-owned but missing or differs from its recorded hash: hard failure with `MISSING` or `DRIFTED` status.

`install all` preflights all three Hosts before writing any Host.

The installer never silently overwrites a third-party same-name Skill or a drifted managed Skill.

### 9.2 Status

Each Host reports one of:

```text
READY
OUTDATED
NOT_INSTALLED
FOREIGN
MISSING
DRIFTED
```

- `READY`: installed files equal the current packaged canonical Skills;
- `OUTDATED`: installed files still match their manifest but packaged canonical hashes/version have advanced;
- `NOT_INSTALLED`: no manifest and no conflicting entry Skill directories;
- `FOREIGN`: an entry Skill directory exists without OmnAI ownership;
- `MISSING`: a manifest-owned Skill file is missing;
- `DRIFTED`: a manifest-owned Skill file no longer matches its recorded hash.

B2b does not add an automatic repair command. A later explicit repair/uninstall design may be added after the first public release requirements are known.

## 10. Clean break removals

B2b removes:

- `src/core/host-skills.ts` repository-local installer;
- `omnai init --host`;
- `ProjectConfig.installedHosts`;
- `.codex/skills` and `.opencode/skills` installation mappings;
- all canonical fine-grained Host Skill files other than the four B2b entry Skills;
- tests and documentation that claim the full fine-grained Skill inventory is a public Host surface.

Repository-local workflow commands and deterministic capability implementations remain. Removing fine-grained Host Skill files does not remove Core capabilities.

## 11. CLI and Core boundaries

The Host and context modules expose stable Core APIs; Commander remains a thin adapter.

Core performs:

- path derivation;
- context discovery;
- manifest validation;
- ownership/integrity checks;
- copy/update operations;
- status calculation.

Skills/Hosts perform:

- natural-language interpretation;
- user questioning;
- semantic WRE classification/proposals;
- artifact authoring through the existing workflow.

## 12. Test contract

Tests must prove:

1. Workset context outranks Git repository context;
2. aggregate root and project descendants return the exact discriminated context shape;
3. initialized and uninitialized ordinary repositories are distinguished without mutation;
4. non-Git paths return `scope: none`;
5. `omnai context --json` emits exactly one JSON object;
6. each Host destination uses its current native user-level path;
7. only the four canonical entry Skills are installed;
8. first install writes Skills and one Host manifest;
9. repeated install is idempotent;
10. a clean old OmnAI installation upgrades safely;
11. foreign same-name directories are never overwritten;
12. missing/drifted managed files are reported and installation refuses to overwrite them;
13. `install all` performs global preflight before any write;
14. `host status` reports all six statuses deterministically;
15. `omnai init --host` is rejected;
16. project configuration no longer persists `installedHosts`;
17. the package canonical Skill inventory is exactly four;
18. each Skill has valid matching frontmatter and required routing/guard statements;
19. `omnai-run` is absent from the B2b packaged/installable surface;
20. Node 20 and Node 22 pass typecheck, tests, build, package dry-run, and whitespace checks.

## 13. Invariants

1. Four canonical Skills, not three Host-specific workflow forks.
2. Every Skill starts from `omnai context --json`.
3. Workset routing truth comes from `omnai workset next --json`.
4. OmnAI Core never calls an LLM.
5. Skills never replace Workset/Project Change state with chat memory.
6. User-level Skill installation is independent of repository initialization.
7. `omnai init` never installs Host Skills.
8. No compatibility layer is retained for unreleased project-local Host installation.
9. Host installation never silently overwrites foreign or drifted files.
10. Project-specific rules remain project truth, not global Skill forks.
11. `omnai-run` remains unavailable until Milestone C provides real execution primitives.
12. No Web UI, server, database, daemon, background scheduler, or embedded LLM API is introduced.
