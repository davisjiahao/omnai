# OmnAI v0.2 Aggregate Execution Workspace Amendment

## Status

**Approved design change:** replace the generated VS Code multi-root `.code-workspace` model with one ordinary aggregate directory that directly contains the Git worktrees for a Workset.

This amendment supersedes the `.code-workspace`, multi-root folder synchronization, and VS Code workspace-management portions of `docs/design/omnai-v0.2-personal-workspace.md`. All other v0.2 decisions remain in force, including Project Registry, Workset lifecycle, read-only research before activation, mandatory worktree isolation, selective re-entry, parallel cross-repository Waves, and host-based LLM interaction.

## 1. Core model

One engineering objective maps to one Workset and one aggregate execution directory:

```text
one engineering objective
        ↓
one Workset
        ↓
one aggregate execution directory
        ↓
N dedicated Git worktrees
        ↓
VS Code / Codex / Claude Code / OpenCode
```

The aggregate directory is both:

- the directory opened by VS Code; and
- the working directory of the main agent session coordinating the Workset.

No `.code-workspace` file is generated or required.

## 2. Directory layout

```text
~/.omnai/
├── projects.yaml
└── worksets/
    └── WKS-0001/
        ├── workset.yaml
        ├── runs/
        ├── claims/
        ├── packets/
        ├── events.jsonl
        └── workspace/                    # aggregate execution directory
            ├── .omnai-workset.yaml       # lightweight Workset pointer
            ├── user-center/              # Git worktree
            ├── mall-service/             # Git worktree
            ├── quote-center/             # Git worktree
            └── order-center/             # Git worktree
```

Every non-marker child directory under `workspace/` is a real Git worktree. OmnAI does not use symlinks to assemble the workspace.

The default worktree directory name is the registered project alias. Because aliases default to repository directory names, normal layouts remain readable (`user-center`, `quote-center`, and so on), while an explicit alias provides deterministic collision handling when two repositories share a basename.

The aggregate directory is not itself a Git repository.

## 3. Workset marker and context discovery

OmnAI writes a marker at:

```text
<aggregate-root>/.omnai-workset.yaml
```

Conceptual shape:

```yaml
schemaVersion: 1
worksetId: WKS-0001
manifest: ../workset.yaml
```

The marker is a pointer, not a second source of truth. `workset.yaml` remains authoritative.

Context discovery walks upward from the current directory:

- when the current directory is the aggregate root, OmnAI resolves Workset scope;
- when the current directory is `workspace/<project>`, OmnAI resolves both Workset scope and the current project;
- when no marker can be found, normal repository-local v0.1 context discovery applies.

This lets the main agent run from the aggregate root while isolated workers run from individual project worktrees.

## 4. Agent execution model

### 4.1 Main agent

The main Codex, Claude Code, OpenCode, or VS Code agent session starts with:

```text
cwd = ~/.omnai/worksets/WKS-0001/workspace
```

It can read all Workset project worktrees and is responsible for cross-project coordination, Research synthesis, Grill, Brainstorm, Reconcile, Wave planning, and worker dispatch.

### 4.2 Project workers

A worker receives one project-specific working directory:

```text
worker A cwd = workspace/user-center
worker B cwd = workspace/quote-center
worker C cwd = workspace/order-center
```

Each worker remains bound to its Run packet, project Change, Revision, Baseline, task, allowed paths, evidence requirements, and stop conditions.

Multiple repositories may be written in parallel. v0.2.0 still permits at most one active writer per repository.

## 5. Member lifecycle and physical directories

The lifecycle remains:

```text
CANDIDATE
  ↓
RESEARCH_ONLY
  ├── impact disproved       → OBSERVED_ONLY
  └── modification confirmed → ACTIVE
                                  ↓
                              create Git worktree

ACTIVE
  └── removed from scope → INACTIVE
```

Physical behavior is now explicit:

| Status | Original repository | Aggregate directory | Writable by Workset Runs |
| --- | --- | --- | --- |
| `CANDIDATE` | read-only | absent | no |
| `RESEARCH_ONLY` | read-only | absent | no |
| `OBSERVED_ONLY` | read-only | absent | no |
| `ACTIVE` | read-only source | worktree present | yes, through an approved Run |
| `INACTIVE` | unchanged | worktree retained in place | no |

The approved inactive policy is **retain in place**:

- `ACTIVE -> INACTIVE` never moves or deletes the worktree;
- the inactive project remains visible in VS Code and to the main agent;
- its branch, commits, uncommitted changes, evidence, and recovery context remain available;
- OmnAI does not automatically clean it up at Workset completion;
- cleanup is a later explicit operation with separate safety checks.

Because inactive worktrees remain visible, Workset routing and write guards must treat them as non-writable. No Run or Wave may be created for an inactive member until an explicit legal reactivation flow exists.

## 6. Adding a repository mid-flight

A newly suspected project is not immediately placed in the aggregate directory.

```text
new requirement names pricing-center
        ↓
add CANDIDATE
        ↓
read-only Research against original repository
        ↓
impact disproved?
  ├── yes → OBSERVED_ONLY; no directory created
  └── no  → ACTIVE; create workspace/pricing-center worktree
```

Once activation creates the new child directory, VS Code and terminal agents see it through the normal filesystem. There is no multi-root workspace update, workspace reload, or folder synchronization step.

Selective Reconcile still determines which existing Runs, tasks, artifacts, and dependencies are paused, invalidated, retained, or recalculated.

## 7. Removing a repository mid-flight

When a project is removed from active scope:

```text
ACTIVE → INACTIVE
```

The worktree stays at the same aggregate path. The Workset manifest changes status, and the following behavior applies:

- running affected Runs are blocked or paused before the transition completes;
- no new Run may claim the project;
- unrelated projects continue;
- the main agent may read the retained project for comparison or recovery;
- VS Code continues displaying the directory because it is physically present;
- an optional VS Code extension may decorate it as inactive, but does not hide, move, or delete it.

## 8. VS Code behavior

The normal open command is conceptually:

```bash
code "$(omnai workset path WKS-0001)"
```

VS Code opens one ordinary folder, not a multi-root workspace.

The optional extension is reduced to:

- detect the Workset through `.omnai-workset.yaml`;
- call OmnAI JSON CLI commands;
- show Workset, Runs, and Attention state;
- decorate active/inactive/blocked project directories;
- navigate to worktrees, artifacts, tasks, evidence, and diffs;
- invoke CLI/host commands.

The extension no longer:

- generates or edits `.code-workspace` files;
- adds or removes VS Code workspace folders;
- synchronizes multi-root workspace state;
- controls which project directories are physically visible.

It still does not implement chat, workflow state, LLM calls, or a Webview.

## 9. CLI contract changes

Remove the Milestone A command and API surface associated with generated workspaces:

```text
omnai workset sync-workspace
syncVsCodeWorkspace(...)
worksetVsCodePath(...)
```

Delete the generated `.code-workspace` projection and its dedicated production module.

Add:

```text
omnai workset path [workset] [--json]
```

Human output is the absolute aggregate directory path. JSON output is:

```json
{
  "workset": "WKS-0001",
  "path": "/Users/me/.omnai/worksets/WKS-0001/workspace"
}
```

A later convenience command may run the user's configured editor:

```text
omnai workset open [workset]
```

`open` is not required for the aggregate-directory model and is not part of the revised Milestone A completion gate.

## 10. Milestone A implementation changes

Milestone A now delivers:

- Project Registry;
- Workset state and member lifecycle;
- read-only candidate research;
- dedicated Git worktree creation under one aggregate directory;
- retained-in-place inactive worktrees;
- aggregate-root marker generation;
- `workset path` text/JSON CLI contract;
- public Core exports;
- no VS Code extension dependency.

Milestone A no longer delivers:

- `.code-workspace` generation;
- VS Code multi-root workspace projection;
- workspace-folder synchronization;
- `sync-workspace` CLI behavior.

## 11. Test contract

The revised regression suite must prove:

1. creating a Workset establishes a deterministic aggregate path;
2. the aggregate root contains `.omnai-workset.yaml` with a valid pointer;
3. `CANDIDATE`, `RESEARCH_ONLY`, and `OBSERVED_ONLY` members create no child worktree;
4. activating a researched project creates a real Git worktree directly under the aggregate root;
5. original uncommitted files do not leak into the worktree;
6. activating another repository creates another sibling worktree without changing existing worktrees;
7. marking a project inactive keeps its directory, branch, and files in place;
8. inactive members are excluded from writable next-action/Run eligibility;
9. no `.code-workspace` file is generated;
10. `omnai workset path --json` returns the aggregate root;
11. the public package exports the workspace APIs required by host and VS Code integrations;
12. existing repository-local v0.1 commands still route through the original CLI path.

## 12. Acceptance example

```bash
omnai project register ~/code/user-center --alias user-center
omnai project register ~/code/quote-center --alias quote-center

omnai workset new "Authorization Migration"
omnai workset add-candidate user-center
omnai workset inspect-project user-center
# The agent researches ~/code/user-center read-only.
omnai workset activate-project user-center

omnai workset add-candidate quote-center
omnai workset inspect-project quote-center
omnai workset activate-project quote-center

ROOT=$(omnai workset path)
code "$ROOT"
cd "$ROOT"
codex
```

The opened directory is:

```text
workspace/
├── .omnai-workset.yaml
├── user-center/
└── quote-center/
```

If `pricing-center` becomes affected later, activation adds `workspace/pricing-center/`. The open VS Code window sees it automatically.

If `quote-center` becomes inactive, `workspace/quote-center/` remains in place and visible, but OmnAI refuses to create new writable Runs for it.

## 13. Invariants

1. The aggregate directory is the main Agent workspace and the folder opened by VS Code.
2. Every writable project child is a dedicated Git worktree.
3. Original registered repositories remain read-only execution sources.
4. No `.code-workspace` file or multi-root synchronization is part of the model.
5. Candidate research does not create writable directories.
6. New active projects appear by ordinary filesystem creation.
7. Inactive worktrees remain in their original aggregate location until explicit cleanup.
8. Visibility does not imply writability; member state, Run claims, Revision/Baseline, and guards determine write eligibility.
9. The marker file is only a pointer; `workset.yaml` remains authoritative.
10. OmnAI remains CLI-first, host-agent-assisted, and free of a server, database, daemon, Web UI, or built-in LLM API.
