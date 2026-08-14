# OmnAI Design Documents

## v0.2 authoritative reading order

For OmnAI v0.2, read these documents in this order:

1. `omnai-v0.2-personal-workspace.md` — base v0.2 product/workflow design.
2. `omnai-v0.2-aggregate-execution-workspace.md` — **authoritative amendment for workspace execution and VS Code integration**.

The aggregate-execution-workspace amendment supersedes every earlier v0.2 statement that requires:

- generated `.code-workspace` files;
- VS Code multi-root workspace projection;
- dynamic workspace-folder synchronization;
- `workset sync-workspace`;
- removal of an inactive project's Worktree from the visible workspace.

Current workspace invariant:

```text
one Workset
  -> one ordinary aggregate workspace directory
  -> direct child Git worktrees
  -> VS Code and the main Agent open the aggregate directory itself
```

`ACTIVE -> INACTIVE` retains the child Worktree in place. Visibility does not grant write permission.

The current Milestone A execution plan is:

`../superpowers/plans/2026-08-14-omnai-v0.2-milestone-a-aggregate-workspace.md`

The earlier `2026-08-14-omnai-v0.2-milestone-a-personal-workset-core.md` plan is historical for the superseded multi-root implementation and must not be used for new implementation work.

## v0.1

`omnai-v0.1-native-workflow.md` remains the repository-local workflow design inherited by v0.2.
