---
schemaVersion: 1
id: workset.project-workflow-handoff
version: 1
kind: workset-action
actions:
  - project-workflow
---

# Project workflow handoff

Enter the project-local workflow only through the member's bound ACTIVE Worktree and Project Change.

## Method

- Confirm the Workset member is `ACTIVE`, has one bound `changeId`, and the current directory is the recorded Worktree.
- Run repository-local `omnai status` and `omnai next` against that Project Change.
- Execute only the returned capability and preserve the Workset objective, cross-project contracts, and current Revision.
- Return to Workset routing after the bounded repository action, especially when another project or WRE becomes higher priority.

## Safety boundary

A retained `INACTIVE` Worktree is visible for recovery and audit but is not writable through this Workset. Candidate, research-only, observed-only, and inactive members cannot receive new writable project work. Do not edit the registered original repository.

## Stop conditions

Return control to `omnai workset next --json` after the repository capability is completed or blocked, when a new fact requires Reconcile, or when the member is no longer writable.
