# Read-only Query

Use this profile to answer where a field, API, class, configuration, or business rule is used and to explain an existing flow without changing source code.

## Route

```text
question → focused research → evidence-backed answer
```

## Required behavior

- Read explicitly named files first.
- Locate entry points, follow calls and data, and cite paths and line ranges.
- Distinguish current code from historical documentation.
- Do not create a worktree, task graph, or implementation plan unless the request changes into development work.
- Source writes are prohibited.

## Completion evidence

The answer itself must link each load-bearing claim to code, configuration, a formal artifact, or runtime evidence. Unverified conclusions are labeled as assumptions.
