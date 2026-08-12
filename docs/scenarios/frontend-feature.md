# Frontend or UX Feature

Use when the primary behavior is experienced through a browser or visual interface.

## Route

```text
user framing → interaction specification → visual/technical design → accessible vertical slices → browser QA → verify → release
```

## Gates

- Empty, loading, error, success, permission, and responsive states are designed.
- Accessibility expectations are explicit.
- Components follow existing design-system conventions unless the change intentionally evolves them.
- Browser behavior is verified in the real runtime, not inferred from unit tests alone.

## Evidence

Record component or integration tests, browser QA, accessibility checks, screenshots or traces for material interactions, and release health when deployed.
