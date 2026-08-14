# OmnAI v0.2 Selective Re-entry Design

## 1. Status and scope

This document is the **Milestone B1** contract for detecting and routing mid-flight changes. It remains authoritative for:

- structured `ReentryKind` classification boundaries;
- Research-first handling of newly affected repositories;
- Grill / Brainstorm interaction routing;
- oldest-PENDING routing precedence.

**B2a supersession:** `omnai-v0.2-b2a-project-reconcile.md` is authoritative for Project Change binding, WRE schema v2, `PENDING -> DECIDED -> RESOLVED`, project Revision/Baseline propagation, and completion semantics. B1's former direct `reentry resolve` behavior applies only to historical schema-v1 coordination records.

B1 answers:

> When facts or requirements change while a multi-project Workset is already in progress, what should OmnAI research or decide again, and how does a newly affected repository enter the Workset safely?

OmnAI Core still does not call an LLM. The active Agent host translates natural-language change into one structured `ReentryKind`; OmnAI validates, persists, routes, and explains that structured event.

## 2. Core rule: selective Re-entry

A requirement change does not restart the whole workflow.

```text
work already in progress
        ↓
new fact / requirement / constraint
        ↓
Agent host chooses ReentryKind
        ↓
OmnAI records WRE-xxxx
        ↓
new candidate project exists?
  ├── yes → read-only Research / impact decision first
  └── no
        ↓
re-enter only the affected capability
        ↓
Research / Grill / Brainstorm / Experiment / Plan / Work
        ↓
B2a Project Reconcile planning / decision / application
```

Grill and Brainstorm are interaction modes inside existing capabilities, not mandatory top-level stages.

## 3. Deterministic routing table

| Structured change kind | Capability | Interaction | Meaning |
| --- | --- | --- | --- |
| `REALITY_CHANGED` | `research` | none | Current-system facts changed or are no longer trustworthy. |
| `PRODUCT_CHANGED` | `frame` | `grill` | Product goal or user outcome changed. |
| `DOMAIN_CHANGED` | `model` | `grill` | Domain meaning, ownership, lifecycle, rule, or invariant changed. |
| `SCOPE_CHANGED` | `spec` | `grill` | Scope, acceptance criteria, or non-goals changed. |
| `TECHNICAL_CONSTRAINT_CHANGED` | `design` | `brainstorm` | A technical constraint invalidated the selected approach. |
| `NEEDS_EXPERIMENT` | `experiment` | none | Remaining choices require measured evidence. |
| `PLAN_CHANGED` | `plan` | none | Task structure, dependency order, or delivery sequencing changed. |
| `IMPLEMENTATION_DETAIL_CHANGED` | `work` | none | Change remains within implementation detail. |

The table is deterministic. OmnAI Core never inspects prompt wording to guess the row.

## 4. Agent-host responsibility

The Agent host owns semantic interpretation.

Example user message:

```text
需求变了：撤销授权后，历史报价必须保留报价发生时的授权状态，
而且 pricing-center 也需要根据授权范围决定数据源。
```

A host may translate it into:

```text
kind: DOMAIN_CHANGED
affectedProjects:
  - user
  - quote
candidateProjects:
  - pricing
reason: Historical quote authorization semantics changed and pricing may be affected.
```

The host cannot bypass structured Core state by silently treating chat as workflow truth. Independent reasons should become independent WRE records.

## 5. Re-entry persistence

Each WRE is an independent YAML record under:

```text
~/.omnai/worksets/WKS-0001/reentries/
├── WRE-0001.yaml
└── WRE-0002.yaml
```

B1 introduced schema v1. B2a introduces schema v2 and readers accept both. Historical schema-v1 RESOLVED records remain historical coordination evidence; they do not prove that project Revision/Baseline reconciliation occurred.

## 6. Newly affected repositories

A repository never becomes writable merely because a requirement mentions it.

```text
new project named by change
        ↓
validate Project Registry
        ↓
CANDIDATE
        ↓
original repository: READ ONLY
        ↓
RESEARCH_ONLY
        ↓
impact decision
  ├── no modification → OBSERVED_ONLY
  └── modification    → explicit Project Change binding/creation → ACTIVE
```

Recording a Re-entry may inject a registered repository as `CANDIDATE`, but it cannot directly create writable scope. Existing member lifecycle is not reset if the same project appears again.

## 7. Routing precedence

B1 established the first three precedence rules, retained by B2a:

```text
1. CANDIDATE
   → inspect-project

2. RESEARCH_ONLY
   → decide-project-impact

3. oldest PENDING WRE
   → reenter <capability>/<interaction>
```

B2a extends the remainder:

```text
4. oldest DECIDED WRE application / recovery
5. ACTIVE project workflow
6. none
```

This ensures new-project reality is understood before Grill/Brainstorm and approved Reconcile work is completed before normal implementation resumes.

## 8. CLI boundary

B1 records and inspects structured changes:

```bash
omnai workset change \
  --kind DOMAIN_CHANGED \
  --reason "Historical quote authorization semantics changed" \
  --project user \
  --project quote \
  --candidate pricing

omnai workset next --json
omnai workset reentry list --json
```

For new schema-v2 records, completion continues through B2a:

```bash
omnai workset reentry plan WRE-0001 --file proposal.yaml
omnai workset reentry decide WRE-0001
omnai workset reentry apply WRE-0001
omnai workset reentry status WRE-0001
```

`omnai workset reentry resolve` is retained only for historical schema-v1 records.

## 9. B1 / B2a boundary

B1 owns change detection and interaction routing. B2a owns:

- Project ↔ Project Change binding;
- deterministic Readiness and Task closure calculation;
- frozen DECIDED plans;
- repository-local Revision/Baseline advancement;
- selective task/readiness invalidation;
- partial failure and correlation-based retry;
- truthful end-to-end RESOLVED semantics.

B2b separately owns user-level Agent-host Skills.

## 10. Invariants retained from B1

1. Natural-language classification belongs to the Agent host, not OmnAI Core.
2. Re-entry is selective; requirement changes do not restart the whole workflow.
3. Grill and Brainstorm are interaction modes within existing capabilities.
4. New candidate repositories are researched before writable activation.
5. Candidate/research decisions outrank pending interaction work.
6. WRE history is durable.
7. Workset coordination cannot override repository-local `.omnai` truth.
8. No server, database, daemon, Web UI, background scheduler, or built-in LLM API is introduced.
