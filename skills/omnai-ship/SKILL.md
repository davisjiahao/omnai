---
name: omnai-ship
description: Assess delivery readiness from evidence, review, approvals, rollout, recovery, and post-release signals without replacing deployment systems.
---

# OmnAI Ship

1. Run `omnai ship "<delivery context>"` to update `delivery.md` with artifact identity, rollout strategy, rollback/forward-fix path, activation, and post-release signals.
2. Run `omnai verify --matrix` and close every required evidence gap for the active scenario, risk, and impact.
3. Complete independent review when the scenario requires it.
4. P0/P1 work requires explicit human approval. Record it with `omnai ship --approve` only when the human actually approved the active revision.
5. Run `omnai ship --complete` to apply the host-independent delivery guard. It returns READY only when verification, evidence, required review, and approval gates are satisfied.
6. OmnAI never substitutes for Jenkins, GitHub Actions, Argo, a release platform, or a human production-control process. Deployment remains external; OmnAI records readiness and evidence.
