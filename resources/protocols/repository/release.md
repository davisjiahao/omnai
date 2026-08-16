---
schemaVersion: 1
id: repository.release
version: 1
kind: repository-capability
capability: release
---

# Release

## Method

Legacy delivery capability. Promote a verified artifact using the repository's delivery contract. Separate deployment from release and activation. Check approvals, rollout strategy, rollback capabilities, and post-release verification before progressing traffic.

## Stop conditions

- Stop and report a blocking fact when the active Revision or required evidence is insufficient.
- Do not begin a later capability; return control to OmnAI routing after producing the declared output.
- Route a contradiction in current truth or approved intent to Reconcile rather than silently editing upstream decisions.
