# OmnAI v0.2 Personal Workspace Design

> **Amendment:** The execution workspace model in this document has been superseded by [`omnai-v0.2-aggregate-execution-workspace.md`](./omnai-v0.2-aggregate-execution-workspace.md). OmnAI no longer generates `.code-workspace` files or manages VS Code multi-root folders. One Workset now owns one aggregate directory that directly contains its project Git worktrees; VS Code and the main agent open that ordinary directory. Where this document refers to `.code-workspace`, multi-root synchronization, adding/removing VS Code folders, or hiding inactive worktrees, the amendment takes precedence.

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

The remainder of the original design is retained in Git history. The aggregate execution workspace amendment is the authoritative current contract for workspace layout and VS Code integration.
