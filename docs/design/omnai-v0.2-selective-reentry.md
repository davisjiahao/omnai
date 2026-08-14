# OmnAI v0.2 Selective Re-entry Design

## 1. Status and scope

This document is the executable contract for **Milestone B1: Selective Re-entry and Interaction Routing**.

B1 answers one question:

> When facts or requirements change while a multi-project Workset is already in progress, what should OmnAI research or decide again, and how does a newly affected repository enter the Workset safely?

B1 is Workset coordination only. It does **not** advance project-local Change Revision/Baseline state. Propagating a Workset Re-entry into each affected repository's existing `.omnai/changes/*` Reconcile machinery is Milestone B2.

OmnAI Core still does not call an LLM. The active Agent host translates the user's natural-language change into one structured `ReentryKind`; OmnAI validates, persists, routes, and explains that structured event.

## 2. Core rule: Selective Re-entry

A requirement change does not restart the entire workflow.

```text
work already in progress
        ↓
new fact / requirement / constraint
        ↓
Agent host chooses structured ReentryKind
        ↓
OmnAI records WRE-xxxx
        ↓
new candidate project exists?
  ├── yes → read-only Research / impact decision first
  └── no
        ↓
route only to the affected capability
        ↓
Research / Grill / Brainstorm / Experiment / Plan / Work
        ↓
resolve WRE coordination record
        ↓
continue normal Workset routing
```

Grill and Brainstorm remain interaction modes inside existing capabilities. They are not new mandatory top-level stages.

## 3. Deterministic routing table

| Structured change kind | Existing capability | Interaction | Meaning |
| --- | --- | --- | --- |
| `REALITY_CHANGED` | `research` | none | Current-system facts changed or are no longer trustworthy. |
| `PRODUCT_CHANGED` | `frame` | `grill` | Product goal or user outcome changed and a human decision is required. |
| `DOMAIN_CHANGED` | `model` | `grill` | Domain meaning, ownership, lifecycle, rule, or invariant changed. |
| `SCOPE_CHANGED` | `spec` | `grill` | Scope, acceptance criteria, or non-goals changed. |
| `TECHNICAL_CONSTRAINT_CHANGED` | `design` | `brainstorm` | A technical constraint invalidated the selected implementation approach. |
| `NEEDS_EXPERIMENT` | `experiment` | none | Remaining options require measured evidence rather than more discussion. |
| `PLAN_CHANGED` | `plan` | none | Only task structure, dependency order, or delivery sequencing changed. |
| `IMPLEMENTATION_DETAIL_CHANGED` | `work` | none | The change stays inside implementation detail and does not reopen upstream decisions. |

This table is deterministic. OmnAI Core never inspects prompt wording to guess which row applies.

## 4. Agent-host responsibility

The Agent host owns semantic interpretation of the conversation.

Example user message:

```text
需求变了：撤销授权后，历史报价必须保留报价发生时的授权状态，
而且 pricing-center 也需要根据授权范围决定数据源。
```

A host integration may translate that into:

```text
kind: DOMAIN_CHANGED
affectedProjects:
  - user
  - quote
candidateProjects:
  - pricing
reason: Historical quote authorization semantics changed and pricing may be affected.
```

The host is not allowed to bypass the structured CLI by silently changing workflow state in chat.

If the user's change contains more than one independent reason to re-enter, the host records more than one WRE event rather than inventing a compound hidden state. The oldest pending WRE is routed first after candidate/research decisions are cleared.

## 5. Re-entry persistence

Each Re-entry is an independent YAML record:

```text
~/.omnai/worksets/WKS-0001/
└── reentries/
    ├── WRE-0001.yaml
    └── WRE-0002.yaml
```

Example:

```yaml
schemaVersion: 1
id: WRE-0001
worksetId: WKS-0001
kind: DOMAIN_CHANGED
reason: Historical quotes must preserve authorization state at quote time.
route:
  capability: model
  interaction: grill
  reason: Domain meaning, ownership, lifecycle, or invariant changed.
affectedProjects:
  - user
  - quote
candidateProjects:
  - pricing
status: PENDING
createdAt: 2026-08-14T00:00:00.000Z
resolvedAt: null
```

Resolving a Re-entry changes only `status` and `resolvedAt`. The original reason, route, and project references remain historical evidence.

Re-entry history is deliberately not embedded as a mutable array inside `workset.yaml`.

## 6. Newly affected repositories

A candidate repository never becomes writable merely because a requirement mentions it.

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
  └── modification    → ACTIVE → dedicated Git worktree
```

Recording a Re-entry may inject a missing registered repository as `CANDIDATE`, but it cannot call `activateWorksetProject` or create a Git worktree.

Existing member lifecycle is never reset. For example, a project already `OBSERVED_ONLY`, `ACTIVE`, or `INACTIVE` remains in that state if it appears again in `candidateProjects`.

All affected and candidate project references are validated before OmnAI mutates Workset membership or writes the Re-entry record.

## 7. Next-action precedence

`omnai workset next` exposes one explainable routing contract.

Precedence is:

```text
1. CANDIDATE
   → inspect-project

2. RESEARCH_ONLY
   → decide-project-impact

3. oldest PENDING WRE
   → reenter <capability>/<interaction>

4. ACTIVE project
   → project-workflow

5. otherwise
   → none
```

This precedence is important. If a domain change also introduces `pricing-center`, OmnAI must not start Domain Grill before it has enough pricing reality to know whether pricing is actually affected.

Example JSON after recording the change:

```json
{
  "action": "inspect-project",
  "project": "pricing",
  "reason": "Candidate project requires read-only research before activation."
}
```

After pricing research concludes:

```json
{
  "action": "reenter",
  "reentryId": "WRE-0001",
  "capability": "model",
  "interaction": "grill",
  "affectedProjects": ["user", "quote"],
  "reason": "Domain meaning, ownership, lifecycle, or invariant changed."
}
```

## 8. CLI contract

### Record a structured change

```bash
omnai workset change \
  --kind DOMAIN_CHANGED \
  --reason "Historical quote authorization semantics changed" \
  --project user \
  --project quote \
  --candidate pricing \
  --json
```

`--project` and `--candidate` may be repeated.

### Inspect the next action

```bash
omnai workset next --json
```

### Inspect Re-entry history

```bash
omnai workset reentry list --json
```

### Resolve Workset coordination

```bash
omnai workset reentry resolve WRE-0001 --json
```

Resolution means the Workset-level interaction has been handled. In B1 it does **not** imply that any project Change Revision has advanced; B2 will bind those two levels explicitly.

## 9. Authorization-migration example

Initial Workset:

```text
workspace/
├── user/      ACTIVE
└── quote/     ACTIVE
```

The user changes the requirement:

```text
撤销授权后，历史报价必须保留报价发生时的授权状态，
并且 pricing-center 也要使用授权范围。
```

The Agent host records:

```text
DOMAIN_CHANGED
affected: user, quote
candidate: pricing
```

OmnAI then routes:

```text
pricing CANDIDATE
   ↓
read-only Research
   ↓
impact decision
   ↓
WRE-0001 → model / grill
```

During Grill the user may decide that an immutable `AuthorizationUsage` is required.

If that decision creates several viable implementation options, the Agent host records another structured event:

```text
TECHNICAL_CONSTRAINT_CHANGED
        ↓
design / brainstorm
```

If Brainstorm cannot choose safely without data, the next record may be:

```text
NEEDS_EXPERIMENT
        ↓
experiment
```

The loop therefore re-enters only as far upstream as the new information requires.

## 10. B1 versus B2 boundary

B1 owns:

- WRE history;
- deterministic routing;
- Grill/Brainstorm interaction mode selection;
- candidate-project injection;
- research-first precedence;
- Workset-level CLI next action.

B2 will own:

- mapping an affected Workset WRE onto each project's active Change;
- calling the existing repository-local Reconcile machinery;
- advancing affected Revision/Baseline state where required;
- selective invalidation of project tasks/evidence;
- cross-project stale dependency propagation;
- user-level host skills such as `omnai`, `omnai-grill`, `omnai-brainstorm`, and `omnai-reconcile`.

Until B2 exists, a `RESOLVED` WRE is explicitly a **coordination-resolution marker**, not proof that project intent/evidence has been reconciled.

## 11. Failure and recovery rules

- unknown Workset: hard failure;
- unknown affected project: hard failure before mutation;
- unregistered candidate project: hard failure before mutation;
- duplicate project aliases in one input: deduplicated;
- candidate already a Workset member: existing lifecycle retained;
- process restart: pending WRE records are recovered from YAML;
- multiple pending WRE records: oldest pending record routes first;
- resolving an already resolved WRE: idempotent;
- no WRE operation deletes, resets, moves, or cleans a Git worktree.

## 12. Invariants

1. Natural-language classification belongs to the Agent host, not OmnAI Core.
2. Re-entry is selective; requirement changes do not restart the entire workflow.
3. Grill and Brainstorm are interaction modes within existing capabilities.
4. New candidate repositories are researched before writable activation.
5. Candidate/research decisions outrank pending Grill/Brainstorm interactions.
6. WRE history is durable and remains visible after resolution.
7. Workset coordination state cannot override project-local `.omnai` truth.
8. B1 does not claim to advance project Revision/Baseline state.
9. No server, database, daemon, Web UI, background scheduler, or built-in LLM API is introduced.
