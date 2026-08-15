---
name: omnai-reconcile
description: Use when a new fact, changed requirement, changed constraint, or failed assumption may invalidate an active Workset or Project Change baseline.
---

# OmnAI Reconcile

Start with `omnai context --json`. Stop only plausibly affected work and preserve unaffected progress. Chat is not Reconcile state; every durable transition goes through OmnAI Core.

## Workset change classification

Translate the change into exactly one structured Workset Re-entry kind:

| Kind | Use when |
| --- | --- |
| `REALITY_CHANGED` | Current-system facts changed or are no longer trustworthy. |
| `PRODUCT_CHANGED` | Product goal or user outcome changed. |
| `DOMAIN_CHANGED` | Meaning, ownership, lifecycle, rule, or invariant changed. |
| `SCOPE_CHANGED` | Scope, acceptance criteria, or non-goals changed. |
| `TECHNICAL_CONSTRAINT_CHANGED` | A technical constraint invalidated the selected approach. |
| `NEEDS_EXPERIMENT` | The remaining choice requires measured evidence. |
| `PLAN_CHANGED` | Task structure, dependency order, or delivery sequence changed. |
| `IMPLEMENTATION_DETAIL_CHANGED` | The change remains inside implementation detail. |

Separate independent reasons into independent WRE records rather than hiding several changes under one classification.

## Workset protocol

1. Identify existing affected Workset projects and newly suspected registered candidate projects.
2. Record the event with `omnai workset change --kind <KIND> --reason "..." --project <alias> --candidate <alias>`.
3. Repeatedly run `omnai workset next --json` and obey its precedence:
   - research `CANDIDATE` projects against their original repositories read-only;
   - decide `RESEARCH_ONLY` impact before creating a Worktree;
   - perform requested Grill, Brainstorm, experiment, plan, or work interaction;
   - never skip an older PENDING or DECIDED WRE to resume ordinary implementation.
4. After the interaction establishes the new decision, propose only each project's semantic `reopenFrom` and Task roots.
5. Run `omnai workset reentry plan <WRE> --file <proposal.yaml> --json` and show the calculated project plan. OmnAI Core calculates the full Readiness and Task closure. Do not manually expand closure lists or treat an LLM-generated list as workflow truth.
6. Obtain explicit user approval of the project outcomes, levels, reopen roots, calculated closures, and frozen Revision/Baseline preconditions.
7. Only after explicit user approval run `omnai workset reentry decide <WRE> --json`.
8. Follow `omnai workset next --json` again:
   - `apply-reentry`: run `omnai workset reentry apply <WRE> [--project <alias>] --json`;
   - `replan-reentry`: preview with `omnai workset reentry replan <WRE> --project <alias> --json`, explain the changed current truth, then use `--confirm` only after explicit approval;
   - `finalize-reentry`: rerun `omnai workset reentry apply <WRE> --json` to finalize without another repository Reconcile.
9. A schema-v2 WRE is RESOLVED only when every required application is APPLIED or NOT_REQUIRED.

Never use `omnai workset reentry resolve` for a schema-v2 WRE. That command exists only for historical schema-v1 coordination records.

## Repository protocol

In ordinary repository scope, gather evidence, choose the correct Reconcile level and root affected Tasks, then use repository-local `omnai reconcile`. Review the new Revision/Baseline, stale readiness, exact affected Task subtree, and fresh evidence requirements before resuming.

## Safety

- Never erase previous Revision, attempt history, or Evidence.
- Never silently bind or rebind a Workset project to a Project Change.
- Never activate a newly mentioned project before read-only impact research and explicit Project Change confirmation.
- Never silently refresh a stale DECIDED precondition; use the explicit project-scoped replan path.
