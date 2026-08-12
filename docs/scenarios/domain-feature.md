# Complex Domain Feature

Use when business terminology, ownership, lifecycle, or rules are ambiguous or historically mixed across code.

## Route

```text
current-state research → domain decision tree → delta spec → technical design → vertical tasks → independent review → verify → learn
```

## Gates

- Code facts and business decisions are recorded separately.
- Blocking domain questions are resolved before technical design.
- Terms have one canonical meaning within the affected context.
- Ownership and lifecycle changes require human approval.
- Edge cases challenge the model before implementation.

## Evidence

Preserve code references, domain decisions, acceptance tests, integration evidence, and any approved ADRs. Promote glossary changes only after the change is verified.
