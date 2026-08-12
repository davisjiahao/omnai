---
name: omnai-model
description: Clarify domain language, lifecycle, ownership, invariants, and hard-to-reverse decisions before design.
---

# OmnAI Domain Modeling

1. Run `omnai model "<domain question>"` and read the generated prompt.
2. Extract overloaded terms and compare them with existing project glossary entries.
3. Build a decision tree. Ask only the current frontier: questions whose prerequisites are already settled.
4. Research code facts yourself; ask the user only for genuine business or design decisions.
5. Challenge each proposed model with concrete boundary and lifecycle scenarios.
6. Update `domain.md`; keep implementation details in `design.md`, not the domain glossary.
7. Propose an ADR only when the decision is hard to reverse, surprising without context, and the result of a real trade-off.
8. Run `omnai model --complete` after blocking domain questions are resolved.
