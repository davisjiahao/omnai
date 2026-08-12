---
name: omnai-research
description: Recover how an existing codebase or business flow actually works, with repository evidence and no premature redesign.
---

# OmnAI Research

1. Run `omnai research "<research question>"` and read the generated prompt path.
2. Read explicitly referenced files first.
3. Decompose the question into independent locator, behavior, dependency, history, and pattern searches; parallelize only independent searches.
4. Use live code and configuration as the primary source of truth. Treat old docs as historical context until verified.
5. Update the active change's `research.md` with confirmed facts, assumptions, open questions, and exact path/line evidence.
6. Do not recommend refactors unless the request explicitly asks for recommendations.
7. Run `omnai research --complete`.
