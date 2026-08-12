---
name: omnai-work
description: Execute one ready OmnAI task in isolated context, incrementally, with tests, durable progress, and independent review.
---

# OmnAI Work

1. Run `omnai work [TASK-ID]`; read the generated prompt and task context packet.
2. Work only on the selected task and allowed paths. Do not carry the whole chat history into the executor context.
3. For behavior changes, write a failing behavioral test and observe the expected failure before production code.
4. Implement the smallest complete slice, run relevant tests, keep the repository compilable, and avoid unrelated cleanup.
5. Report one status: DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, or BLOCKED.
6. If a task assumption conflicts with code, domain, specification, or design, stop and emit a reconcile signal instead of silently changing intent.
7. Run `omnai work TASK-ID --done` after implementation. After independent verification, run `omnai work TASK-ID --verified`.
