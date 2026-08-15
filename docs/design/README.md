# OmnAI Design Documents

## v0.2 authoritative reading order

For OmnAI v0.2, read these documents in this order:

1. `omnai-v0.2-personal-workspace.md` — base v0.2 product/workflow design.
2. `omnai-v0.2-aggregate-execution-workspace.md` — **authoritative amendment for workspace execution and VS Code integration**.
3. `omnai-v0.2-selective-reentry.md` — Milestone B1 contract for mid-flight change detection, interaction routing, and candidate-project research.
4. `omnai-v0.2-b2a-project-reconcile.md` — **authoritative B2a amendment for Project Change binding and end-to-end Re-entry reconciliation**.
5. `omnai-v0.2-b2a-failed-application-replan.md` — **authoritative B2a recovery amendment for stale-precondition FAILED applications, explicit replan confirmation, and attempt history**.
6. `../superpowers/specs/2026-08-15-omnai-v0.2-b2b-internal-protocol-resources-design.md` — **approved B2b amendment separating four public Entry Skills from packaged internal Protocol Resources, including the explicit Show-me interaction**.

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

The common protocol defines only a minimum product-level accessibility floor. Show-me is the richer explicit, read-only interaction protocol and includes OmnAI's own consent-aware, loopback-only Visual Companion with text/static fallback. Superpowers may influence its visual method but is not its renderer or runtime dependency. Show-me is not a fifth Host Skill, a persisted personal preference, a lifecycle stage, a canonical artifact, or a readiness state. Configurable interaction preferences remain a future user-level concern.

Current execution plans:

- `../superpowers/plans/2026-08-14-omnai-v0.2-milestone-a-aggregate-workspace.md`
- `../superpowers/plans/2026-08-14-omnai-v0.2-milestone-b1-selective-reentry.md`
- `../superpowers/plans/2026-08-14-omnai-v0.2-b2a-project-reconcile.md`
- `../superpowers/plans/2026-08-14-omnai-v0.2-b2a-failed-application-replan.md`
- `../superpowers/plans/2026-08-15-omnai-v0.2-b2b-user-host-skills.md`
- `../superpowers/plans/2026-08-15-omnai-v0.2-b2b-internal-protocol-resources.md`

The earlier `2026-08-14-omnai-v0.2-milestone-a-personal-workset-core.md` plan is historical for the superseded multi-root implementation and must not be used for new implementation work.

B2b user-level Codex / Claude Code / OpenCode skill installation is intentionally separate from B2a.

## v0.1

`omnai-v0.1-native-workflow.md` remains the repository-local workflow design inherited by v0.2.
