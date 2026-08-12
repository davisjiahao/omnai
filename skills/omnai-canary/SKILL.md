---
name: omnai-canary
description: Evaluate an activated change during a bounded observation window using explicit technical and business thresholds.
---

# OmnAI Canary

1. Run only after delivery readiness and activation prerequisites are satisfied.
2. Define observation window, technical metrics, business metrics, thresholds, and rollback/pause criteria.
3. Record anomalies and evidence in `evidence/canary.json`.
4. End with an explicit continue, pause, or rollback recommendation; absence of alerts alone is not proof.
