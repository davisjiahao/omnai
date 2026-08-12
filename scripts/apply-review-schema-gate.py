from pathlib import Path

stages = Path('src/core/stages.ts')
text = stages.read_text()

old_import = "import { deliveryTemplate, designTemplate, domainTemplate, emptyTaskFile, fixTemplate, intentTemplate, issueTemplate, researchTemplate, specTemplate } from './templates.js';"
new_import = old_import + "\nimport { validateReviewRecord } from './review.js';"
if new_import not in text:
    if old_import not in text:
        raise SystemExit('stages template import not found')
    text = text.replace(old_import, new_import)

needle = """    if (scaffold !== null && content.trim() === scaffold.trim()) {
      throw new Error(`Required output '${output}' is still the unchanged scaffold and is incomplete`);
    }
"""
replacement = needle + """    if (capability === 'review' && output === 'evidence/review.json') {
      validateReviewRecord(
        content,
        change.metadata.id,
        change.metadata.activeRevision,
        selectReviewLenses(scenario, change.metadata.risk, change.metadata.impact),
      );
    }
"""
if replacement not in text:
    if needle not in text:
        raise SystemExit('completion scaffold block not found')
    text = text.replace(needle, replacement)

stages.write_text(text)

Path('skills/omnai-review/SKILL.md').write_text('''---
name: omnai-review
description: Independently review an implementation against intent using only the risk- and impact-relevant review lenses.
---

# OmnAI Review

Review is distinct from verification: verification asks whether the change works; review asks whether the working change is the right change.

1. Run `omnai review "<scope>"` to generate a fresh-context review packet. The packet lists review lenses derived from scenario, risk, and impact.
2. Check specification compliance separately from implementation quality.
3. Use every required lens and only add extra lenses when evidence justifies them.
4. Classify findings; do not silently patch high-risk findings that invalidate intent/design—reconcile them.
5. Write `evidence/review.json` using this machine contract:

```json
{
  "schemaVersion": 1,
  "changeId": "CHG-0001",
  "revision": "REV-0001",
  "lenses": ["business", "architecture", "engineering"],
  "specCompliance": "PASS",
  "implementationQuality": "PASS",
  "conclusion": "PASS",
  "findings": [
    {
      "lens": "architecture",
      "severity": "MINOR",
      "status": "ACCEPTED",
      "summary": "Documented trade-off"
    }
  ]
}
```

Allowed review states are `PASS | CONCERNS | FAIL`; finding severity is `CRITICAL | IMPORTANT | MINOR`; finding status is `OPEN | RESOLVED | ACCEPTED`.

6. `omnai review --complete` only becomes READY when the record targets the active Change/Revision, covers all required lenses, both compliance and quality are PASS, conclusion is PASS, and no open CRITICAL/IMPORTANT finding remains.
''')
