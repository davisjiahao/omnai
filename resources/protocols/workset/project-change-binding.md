---
schemaVersion: 1
id: workset.project-change-binding
version: 1
kind: workset-action
actions:
  - bind-project-change
---

# Project Change binding

Bind one explicitly confirmed Project Change to one Workset project, or create a new Project Change inside that project's dedicated Worktree.

## Method

1. List existing Project Change candidates and distinguish committed-at-HEAD candidates from uncommitted or unrelated work.
2. Recommend an existing committed candidate only when its intent clearly matches the Workset responsibility.
3. Otherwise propose a concise new Project Change title and the appropriate Scenario.
4. Explain the resulting branch and Worktree before asking for confirmation.
5. After explicit confirmation, use the deterministic OmnAI bind/create command and verify the member is ACTIVE with the expected `changeId` and Worktree.

## Safety boundary

Never use activeChange automatically. `activeChange` is a suggestion at most. There is no silent rebind: once this Workset member is bound, changing its Project Change requires an explicit reconcile/rebind decision. Do not create the new Project Change in the original repository; create it only inside the dedicated Worktree.

## Stop conditions

Return control to `omnai workset next --json` after a successful explicit binding/creation, when no safe committed candidate exists and the user declines creation, or when repository truth makes activation unsafe.
