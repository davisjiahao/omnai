---
name: omnai-review
description: Independently review an implementation against intent using only the risk- and impact-relevant review lenses.
---

# OmnAI Review

Review is distinct from verification: verification asks whether the change works; review asks whether the working change is the right change.

1. Run `omnai review "<scope>"` to generate a fresh-context review packet. The packet includes selected review lenses derived from scenario risk and impact.
2. Check specification compliance separately from implementation quality.
3. Use only relevant lenses: business, domain, architecture, contract, engineering, data, security, performance, operations, or UX.
4. Treat reviewer findings as evidence to reconcile, not as automatic truth. Classify each finding as contract misread, valid/actionable, accepted trade-off, or noise.
5. High-risk or irreversible findings that invalidate intent/design must emit a reconcile signal rather than being patched locally.
6. Write structured review evidence and only then run `omnai review --complete` to mark review readiness.
