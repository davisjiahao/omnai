# OmnAI Design Documents

## v0.2 authoritative reading order

For OmnAI v0.2, read these documents in this order:

1. `omnai-v0.2-personal-workspace.md` — base v0.2 product/workflow design.
2. `omnai-v0.2-aggregate-execution-workspace.md` — **authoritative amendment for workspace execution and VS Code integration**.
3. `omnai-v0.2-selective-reentry.md` — Milestone B1 contract for mid-flight change detection, interaction routing, and candidate-project research.
4. `omnai-v0.2-b2a-project-reconcile.md` — **authoritative B2a amendment for Project Change binding and end-to-end Re-entry reconciliation**.
5. `omnai-v0.2-b2a-failed-application-replan.md` — **authoritative B2a recovery amendment for stale-precondition FAILED applications, explicit replan confirmation, and attempt history**.
6. `omnai-v0.2-human-readable-communication.md` — **authoritative cross-cutting contract for terminology, explanation depth, and useful visuals**.

The aggregate-execution-workspace amendment supersedes every earlier v0.2 statement that requires generated `.code-workspace` files, VS Code multi-root projection, workspace-folder synchronization, `workset sync-workspace`, or hiding an inactive project's Worktree.

Current workspace invariant:

```text
one Workset
  -> one ordinary aggregate workspace directory
  -> direct child Git worktrees
  -> VS Code and the main Agent open the aggregate directory itself
```

`ACTIVE -> INACTIVE` retains the child Worktree in place. Visibility does not grant write permission.

Current selective Re-entry invariant after B2a:

```text
mid-flight change
  -> structured WRE
  -> new candidate Research first when needed
  -> re-enter only the affected capability
  -> Agent proposes semantic reopen roots
  -> OmnAI Core calculates deterministic closures
  -> human-approved frozen DECIDED plan
  -> per-project repository Reconcile applications
  -> stale-precondition FAILED application may be explicitly replanned
     while preserving the old frozen attempt in attemptHistory
  -> RESOLVED only after every required application is APPLIED / NOT_REQUIRED
```

For schema-v2 WRE records, B2a supersedes B1's older direct `reentry resolve` coordination semantics. Historical schema-v1 records remain readable as historical coordination records; they are not retroactive proof of project Revision/Baseline reconciliation.

A stale-precondition replan is project-scoped and explicit. Preview is read-only, confirm recalculates from current repository truth, already APPLIED/NOT_REQUIRED siblings are unchanged, and existing `<WRE>/<project>` correlation Revision lineage blocks replan.

The human-readable communication contract applies to every capability prompt and to the canonical Router's on-demand Explain/Show-me protocol. It changes presentation only; it does not add a fifth user-level Host Skill, lifecycle stage, canonical artifact, or readiness state.

Current execution plans:

- `../superpowers/plans/2026-08-14-omnai-v0.2-milestone-a-aggregate-workspace.md`
- `../superpowers/plans/2026-08-14-omnai-v0.2-milestone-b1-selective-reentry.md`
- `../superpowers/plans/2026-08-14-omnai-v0.2-b2a-project-reconcile.md`
- `../superpowers/plans/2026-08-14-omnai-v0.2-b2a-failed-application-replan.md`

The earlier `2026-08-14-omnai-v0.2-milestone-a-personal-workset-core.md` plan is historical for the superseded multi-root implementation and must not be used for new implementation work.

B2b user-level Codex / Claude Code / OpenCode skill installation is intentionally separate from B2a.

## v0.1

`omnai-v0.1-native-workflow.md` remains the repository-local workflow design inherited by v0.2.
