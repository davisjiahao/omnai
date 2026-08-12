from pathlib import Path

path = Path('src/cli.ts')
text = path.read_text()

old_import = "import { evidenceSummary, findEvidenceGaps, listEvidence, recordEvidence, runVerificationCommand } from './core/evidence.js';"
new_import = "import { evidenceSummary, findEvidenceGaps, listEvidence, recordEvidence, recordHumanApproval, runVerificationCommand } from './core/evidence.js';"
if new_import not in text:
    if old_import not in text:
        raise SystemExit('evidence import not found')
    text = text.replace(old_import, new_import)

old_approval = """    if (options.approve) {
      await recordEvidence(repoRoot, change, {
        requirementId: 'human-approval', type: 'manual', status: 'PASS', summary: 'Explicit human approval recorded by omnai ship --approve',
      });
    }
"""
new_approval = """    if (options.approve) {
      await recordHumanApproval(repoRoot, change, 'Explicit human approval recorded by omnai ship --approve');
    }
"""
if new_approval not in text:
    if old_approval not in text:
        raise SystemExit('ship approval block not found')
    text = text.replace(old_approval, new_approval)

path.write_text(text)
