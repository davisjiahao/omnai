---
name: omnai-design
description: Compare viable technical approaches, obtain the required approval, and produce a complete design before implementation.
---

# OmnAI Design

1. Run `omnai design "<design question>"` and read the generated prompt.
2. Confirm scope is small enough for one change; split independent subsystems rather than producing a giant design.
3. Present two or three viable approaches with trade-offs and a recommendation.
4. Cover components, interfaces, data flow, persistence, failure handling, security, observability, testing, deployment, migration, and rollback at a depth proportional to risk.
5. For cross-service, public API, security, data, or irreversible changes, request explicit human approval.
6. Self-review for placeholders, contradictions, scope drift, and ambiguous contracts.
7. Run `omnai design --complete` only after the design reflects the active specification and domain model.
