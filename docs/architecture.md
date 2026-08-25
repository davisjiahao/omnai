# OmnAI Native Architecture

## System shape

OmnAI is a local CLI and a set of thin agent skills. It has no server, database, daemon, or runtime dependency on another workflow project.

```text
User / Issue / Prompt
        │
        ▼
Scenario safety floor + FlowPlan + Decisions
        │
        ▼
Core route (Readiness + Revision/Baseline)
        │
        ▼
Canonical Capability Prompt
        │
        ▼
Claude Code / Codex / OpenCode
        │
        ▼
Canonical Artifact + Evidence
        │
        ▼
Readiness and Reconcile
```

## Four fact classes

- **Reality facts** come from code, configuration, Git, and runtime evidence.
- **Semantic facts** come from reviewed domain decisions.
- **Intent facts** come from the active change specification.
- **Completion facts** come from fresh verification evidence.

These fact classes have separate artifacts so a code observation cannot silently become a requirement, and an agent's confidence cannot become completion evidence.

## Canonical artifacts

`intent.md`, `research.md`, `domain.md`, `spec.md`, and `design.md` are reviewable prose contracts. `flow.yaml`, Decision YAML, `tasks.yaml`, `change.yaml`, revision YAML, evidence YAML, and `progress.jsonl` provide machine-readable state.

The Scenario's ordered capabilities are the routing safety floor. Core compiles
`flow.yaml` from that floor plus risk, impact, accepted assessment, and Decision
records. It may promote conditional capabilities, but it cannot downgrade or
reorder Scenario-required work. The full route model is documented in
[Adaptive Flow](concepts/adaptive-flow.md).

The active revision is named in `change.yaml`. Every run records the revision it consumed. A later revision never rewrites the historical meaning of an earlier run.

## Thin orchestrator

The CLI owns:

- scenario selection
- Flow assessment and capability compilation
- Decision identity, ownership, and guarded mutation
- decision-aware protocol composition
- readiness
- path and artifact conventions
- task graph validation
- event and evidence recording
- revisioning and selective invalidation
- bounded context-packet generation

The coding agent owns the capability-specific reasoning and code edits, but cannot silently move to a different capability or change upstream intent. Only Core can advance Readiness or accept a Flow transition.

Workset remains an outer multi-project container, not a repository capability.
Reconcile remains a cross-cutting interrupt that archives the prior FlowPlan,
advances Revision/Baseline lineage, and selectively invalidates affected state.
F1 provides this routing spine but does not release autonomous execution.

## Context engineering

A capability run receives only the active change's relevant artifacts plus stable project glossary, policies, and learnings. Task executors receive one task, its interfaces, constraints, allowed paths, and evidence contract instead of the entire conversation history.

## Extensibility

Scenario profiles and thin host skills are data and Markdown, not hard-coded personas. Future integrations can add runtime adapters, CI/CD evidence providers, import/export formats, or enterprise policy overlays without replacing the canonical artifact model.
