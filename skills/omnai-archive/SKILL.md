---
name: omnai-archive
description: Archive a verified change while preserving revisions, evidence, and knowledge lineage.
---

# OmnAI Archive

1. Run `omnai status` and confirm required tasks, verification, review, delivery, and scenario evidence are satisfied.
2. Do not use `--force` to hide unresolved evidence except for an explicitly documented human waiver.
3. Run `omnai archive` only after canonical artifacts agree with the active revision and baseline.
4. Preserve the full change history; archive is a lifecycle state, not deletion.
