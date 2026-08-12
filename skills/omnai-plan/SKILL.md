---
name: omnai-plan
description: Turn approved intent and design into a dependency-ordered, independently verifiable task graph.
---

# OmnAI Planning

1. Run `omnai plan` and read the generated prompt.
2. Prefer thin vertical slices that deliver complete behavior. Use contract-first slices for parallel consumer/provider work and risk-first slices for uncertain technology.
3. Use expand-migrate-contract for wide mechanical refactors or migrations that cannot land green as vertical slices.
4. Every task must define objective, exact files, consumed and produced interfaces, ordered steps, risk, dependencies, and required evidence.
5. Size each task for one fresh agent context and one meaningful review gate.
6. Do not write placeholders such as “add validation”, “handle errors”, or “write tests”; state exact expected behavior and verification.
7. Validate the DAG and run `omnai plan --complete`.
