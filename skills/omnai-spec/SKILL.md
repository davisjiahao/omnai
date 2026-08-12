---
name: omnai-spec
description: Define observable change intent and acceptance criteria without prematurely freezing implementation.
---

# OmnAI Specification

1. Run `omnai spec "<change intent>"` and read the generated prompt.
2. Ground the specification in `intent.md`, confirmed research, domain decisions, and project policies.
3. Express delta requirements under Added, Modified, Removed, and Preserved sections.
4. Assign stable acceptance-criterion IDs and describe externally observable outcomes.
5. State compatibility, migration expectations, non-goals, and unresolved questions.
6. Do not hide implementation choices inside requirements.
7. Run `omnai spec --complete` only when the specification contains no blocking ambiguity.
