# OmnAI Native Architecture

## System shape

OmnAI is a local CLI and a set of thin agent skills. It has no server, database, daemon, or runtime dependency on another workflow project.

```text
User / Issue / Prompt
        │
        ▼
Scenario + Readiness Router
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

`intent.md`, `research.md`, `domain.md`, `spec.md`, and `design.md` are reviewable prose contracts. `tasks.yaml`, `change.yaml`, revision YAML, evidence YAML, and `progress.jsonl` provide machine-readable state.

The active revision is named in `change.yaml`. Every run records the revision it consumed. A later revision never rewrites the historical meaning of an earlier run.

## Thin orchestrator

The CLI owns:

- scenario selection
- readiness
- path and artifact conventions
- task graph validation
- event and evidence recording
- revisioning and selective invalidation
- bounded context-packet generation

The coding agent owns the capability-specific reasoning and code edits, but cannot silently move to a different capability or change upstream intent.

## Context engineering

A capability run receives only the active change's relevant artifacts plus stable project glossary, policies, and learnings. Task executors receive one task, its interfaces, constraints, allowed paths, and evidence contract instead of the entire conversation history.

## Extensibility

Scenario profiles and thin host skills are data and Markdown, not hard-coded personas. Future integrations can add runtime adapters, CI/CD evidence providers, import/export formats, or enterprise policy overlays without replacing the canonical artifact model.
