import type { ScenarioProfile } from '../domain/types.js';

export function intentTemplate(title: string, scenario: ScenarioProfile): string {
  return `# Intent: ${title}\n\n## Goal\n\nDescribe the outcome this change must create.\n\n## Problem\n\nDescribe the user, business, or engineering problem without assuming a solution.\n\n## Scenario\n\n- Profile: \`${scenario.id}\`\n- Work mode: \`${scenario.workMode}\`\n- Default risk: \`${scenario.risk}\`\n\n## Success Signals\n\n- A measurable signal that proves the outcome.\n\n## Scope\n\n- In scope: the smallest valuable result.\n\n## Non-goals\n\n- Explicitly excluded work.\n`;
}

export const researchTemplate = `# Current-State Report\n\n## Research Question\n\n## Scope\n\n## Executive Summary\n\n## Current Behavior\n\n## Entry Points\n\n## Data Flow\n\n## Dependencies\n\n## Persistence and External Systems\n\n## Similar Patterns\n\n## Historical Context\n\n## Confirmed Facts\n\n## Unconfirmed Assumptions\n\n## Open Questions\n\n## Evidence References\n`;

export const domainTemplate = `# Domain Model\n\n## Context\n\n## Ubiquitous Language\n\n| Term | Canonical meaning | Not this | Evidence |\n| --- | --- | --- | --- |\n\n## Actors and Subjects\n\n## Entities and Value Objects\n\n## Lifecycles and State Transitions\n\n## Ownership and Boundaries\n\n## Invariants\n\n## Edge-Case Scenarios\n\n## Resolved Decisions\n\n## Open Decisions\n\n## ADR Candidates\n`;

export const specTemplate = `# Change Specification\n\n## Why\n\n## Added Requirements\n\n## Modified Requirements\n\n## Removed Requirements\n\n## Preserved Constraints\n\n## Acceptance Criteria\n\nUse stable IDs such as \`AC-001\` and state observable outcomes.\n\n## Non-goals\n\n## Compatibility and Migration Expectations\n\n## Open Questions\n`;

export const designTemplate = `# Technical Design\n\n## Design Goals\n\n## Constraints\n\n## Current Architecture\n\n## Considered Approaches\n\n### Recommended Approach\n\n### Alternatives and Trade-offs\n\n## Components and Responsibilities\n\n## Interfaces and Contracts\n\n## Data Flow\n\n## State and Persistence\n\n## Error Handling and Recovery\n\n## Security and Privacy\n\n## Observability\n\n## Testing Strategy\n\n## Deployment, Migration, and Rollback\n\n## Risks and Mitigations\n\n## Approval\n`;

export const emptyTaskFile = `schemaVersion: 1\nrevision: REV-0001\ngeneratedFrom: []\ntasks: []\n`;

export const projectGlossaryTemplate = `# Project Glossary\n\nOnly stable, reviewed domain language belongs here. Change-local discoveries stay in each change's \`domain.md\` until promoted.\n\n| Term | Canonical meaning | Scope | Source |\n| --- | --- | --- | --- |\n`;

export const projectPoliciesTemplate = `# OmnAI Project Policies\n\n## Evidence\n\n- Any behavior change MUST have fresh verification evidence before completion.\n- Public API changes MUST include compatibility evidence.\n- Data migrations MUST include reconciliation and rollback or forward-fix guidance.\n\n## Scope\n\n- Agents MUST NOT make unrelated cleanup changes while implementing a task.\n- High-risk, irreversible, or cross-service decisions require explicit human approval.\n\n## Knowledge\n\n- Runtime memory is not a source of truth.\n- Knowledge is promoted only after the originating change is verified.\n`;

export const learningsIndexTemplate = `# Validated Learnings\n\nThis index links durable, evidence-backed learnings promoted from completed changes.\n`;
