---
name: omnai-experiment
description: Resolve an uncertain fix or technical decision with bounded, evidence-producing experiments.
---

# OmnAI Experiment

Use when the root cause or question is known but the best solution is not.

1. Run `omnai experiment "<question and candidates>"` inside the active Change.
2. Define the decision question, candidates, success metrics, environment, and stop condition before changing code.
3. Test one meaningful variable at a time. Capture setup, result, evidence, and cleanup for every candidate, including failed attempts.
4. Compare candidates under equivalent conditions. Do not rationalize a winner after the fact by changing the metric.
5. Experimental code is disposable unless it is explicitly promoted into a planned implementation task.
6. Finish with a bounded conclusion: chosen candidate, rejected candidates, remaining uncertainty, and evidence references.
