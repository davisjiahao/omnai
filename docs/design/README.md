# OmnAI Design Documents

## v0.3 authority and reading order

Read the approved v0.3 work in this order:

1. [`../superpowers/specs/2026-08-16-omnai-v0.3-autonomous-parallel-execution-design.md`](../superpowers/specs/2026-08-16-omnai-v0.3-autonomous-parallel-execution-design.md) — **authoritative autonomous-execution design**.
2. [`../superpowers/plans/2026-08-16-omnai-v0.3-autonomous-parallel-execution.md`](../superpowers/plans/2026-08-16-omnai-v0.3-autonomous-parallel-execution.md) — **authoritative autonomous-execution implementation plan and C1–C4 gates**.
3. [`../superpowers/specs/2026-08-18-omnai-v0.3-module-boundary-protocol-fusion-design.md`](../superpowers/specs/2026-08-18-omnai-v0.3-module-boundary-protocol-fusion-design.md) — **repository-protocol amendment adding the risk-scaled module-boundary assessment**.
4. [`../superpowers/plans/2026-08-18-omnai-v0.3-module-boundary-protocol-fusion.md`](../superpowers/plans/2026-08-18-omnai-v0.3-module-boundary-protocol-fusion.md) — implementation plan for that amendment.

The autonomous-execution design and plan remain authoritative for execution schemas, lifecycle, packets, claims, commits, recovery, and release gates. The module-boundary amendment changes repository guidance and artifact handoffs only; it grants no execution authority and adds no Entry Skill.

The currently installed public Host surface remains the four Entry Skills listed below. The separately approved autonomous-execution plan may add `omnai-run` only after its C4 certification gate; this amendment neither advances that gate nor adds another Skill.

## v0.2 authoritative reading order

Read the v0.2 design in this order:

1. `omnai-v0.2-personal-workspace.md` — base personal multi-project product and workflow model.
2. `omnai-v0.2-aggregate-execution-workspace.md` — **authoritative workspace and VS Code amendment**.
3. `omnai-v0.2-selective-reentry.md` — Milestone B1 mid-flight change detection and interaction routing.
4. `omnai-v0.2-b2a-project-reconcile.md` — **authoritative Project Change binding and end-to-end Re-entry reconciliation amendment**.
5. `omnai-v0.2-b2a-failed-application-replan.md` — **authoritative stale-precondition FAILED application recovery amendment**.
6. `omnai-v0.2-b2b-user-host-skills.md` — user-level Codex, Claude Code, and OpenCode integration.
7. `../superpowers/specs/2026-08-15-omnai-v0.2-b2b-internal-protocol-resources-design.md` — **authoritative B2b amendment separating four public Entry Skills from packaged internal Protocol Resources**.

The later amendment wins whenever an earlier document conflicts with it.

## Current workspace invariant

```text
one Workset
  -> one ordinary aggregate workspace directory
  -> direct child Git worktrees
  -> VS Code and the main Agent open the aggregate directory itself
```

OmnAI does not generate `.code-workspace` files, use VS Code multi-root projection, synchronize workspace folders, or hide inactive project Worktrees.

`ACTIVE -> INACTIVE` retains the child Worktree. Visibility does not grant write permission.

## Current Project Change and Re-entry invariant

```text
registered repository
  -> CANDIDATE
  -> read-only research
  -> explicit impact decision
  -> explicit one-project / one-Project-Change binding
  -> ACTIVE real Git worktree
```

```text
mid-flight change
  -> one structured WRE reason
  -> newly suspected projects become read-only candidates
  -> Core routes only the affected capability and interaction
  -> Agent proposes semantic Readiness roots and Task roots
  -> Core calculates deterministic downstream closures
  -> user reviews and explicitly freezes a DECIDED plan
  -> per-project repository Reconcile applications
  -> stale frozen precondition uses explicit project-scoped Replan
  -> RESOLVED only when every application is APPLIED / NOT_REQUIRED
```

For schema-v2 WRE records, direct `reentry resolve` is not a valid completion path. Historical schema-v1 coordination records may remain readable, but they are not proof that project Revisions and Baselines advanced.

A stale-precondition Replan is project-scoped and explicit:

- preview is read-only;
- confirm recalculates from current repository truth;
- the replaced FAILED attempt is retained in `attemptHistory`;
- APPLIED and NOT_REQUIRED siblings are unchanged;
- existing `<WRE>/<project>` correlation lineage blocks Replan when repository state may already have been written.

## Current B2b Host and protocol invariant

```text
Codex / Claude Code / OpenCode
              ↓
      four shared Entry Skills
              ↓
       omnai context --json
              ↓
Core-selected next action + protocolIds
              ↓
   omnai protocol show ... --json
              ↓
versioned packaged Protocol Resources
              ↓
 deterministic OmnAI state commands
```

The public Host Skill surface is exactly:

```text
omnai
omnai-grill
omnai-brainstorm
omnai-reconcile
```

Detailed `research`, `model`, `spec`, `design`, `plan`, `debug`, `work`, `review`, `verify`, Grill, Brainstorm, Show-me, candidate, binding, and Re-entry methods live under `resources/protocols/` and are not installed as Host Skills.

Core owns legal routing, schemas, state transitions, closures, Revision/Baseline advancement, evidence validity, and guards. The Agent Host interprets language and authors artifacts using the Core-selected protocol bundle.

Protocol loading is preflighted before a repository run mutates state. A missing, invalid, unknown, or unmapped protocol is a hard failure, not a fallback to generic prompts or conversation memory.

## Show-me and visual presentation

Show-me is an internal read-only interaction protocol, not a fifth Skill, lifecycle stage, canonical artifact, or Readiness state.

The `omnai` Entry Skill obtains a fresh Core route and composes:

```text
interaction.show-me
+
current action protocols
```

Show-me uses the smallest useful representation. With just-in-time user consent, richer flows or step-through explanations may use OmnAI's loopback-only Visual Companion. The companion is read-only, token-scoped, and does not execute Agent-provided HTML or JavaScript.

When the user explicitly says that a current or previous explanation did not land, Show-me enters a transient Re-pitch branch. It restores the nearest missing premise and rebuilds the explanation; a repeated failure steps back farther or changes representation instead of merely shortening the same answer. This branch is not persisted as user or workflow state.

Superpowers informs parts of the interaction method but is not an OmnAI runtime dependency or renderer.

## Current implementation plans

- `../superpowers/plans/2026-08-14-omnai-v0.2-milestone-a-aggregate-workspace.md`
- `../superpowers/plans/2026-08-14-omnai-v0.2-milestone-b1-selective-reentry.md`
- `../superpowers/plans/2026-08-14-omnai-v0.2-b2a-project-reconcile.md`
- `../superpowers/plans/2026-08-14-omnai-v0.2-b2a-failed-application-replan.md`
- `../superpowers/plans/2026-08-15-omnai-v0.2-b2b-user-host-skills.md`
- `../superpowers/plans/2026-08-15-omnai-v0.2-b2b-internal-protocol-resources.md`

The earlier `2026-08-14-omnai-v0.2-milestone-a-personal-workset-core.md` plan describes a superseded multi-root workspace experiment and must not be used for new implementation work.

## v0.1 foundation

`omnai-v0.1-native-workflow.md` documents the repository-local workflow foundation inherited by v0.2. Pre-release implementation details that conflict with the v0.2 clean-break documents are not compatibility requirements.
