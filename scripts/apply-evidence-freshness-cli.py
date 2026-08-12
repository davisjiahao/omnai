from pathlib import Path

path = Path('src/cli.ts')
text = path.read_text()

replacements = [
    (
        "findEvidenceGaps(matrix, evidence)",
        "findEvidenceGaps(matrix, evidence, change.metadata.activeRevision)",
        "matrix evidence gaps",
    ),
    (
        "findEvidenceGaps(buildEvidenceMatrix(scenario, change.metadata.risk, change.metadata.impact), evidence)",
        "findEvidenceGaps(buildEvidenceMatrix(scenario, change.metadata.risk, change.metadata.impact), evidence, change.metadata.activeRevision)",
        "inline evidence gaps",
    ),
    (
        "const missing = task.evidenceRequired.filter((requirement) => !evidence.some((record) => record.status === 'PASS' && record.requirementId === requirement && (!record.taskId || record.taskId === task.id)));",
        "const missing = task.evidenceRequired.filter((requirement) => !evidence.some((record) => record.revision === change.metadata.activeRevision && record.status === 'PASS' && record.requirementId === requirement && (!record.taskId || record.taskId === task.id)));",
        "task evidence revision",
    ),
    (
        "const result = await runVerificationCommand(repoRoot, change, command, type, defaultRequirementForEvidenceType(type));",
        "const result = await runVerificationCommand(repoRoot, change, command, type, defaultRequirementForEvidenceType(type), options.task);",
        "verification task scope",
    ),
    (
        "humanApproval: evidence.some((record) => record.requirementId === 'human-approval' && record.status === 'PASS'),",
        "humanApproval: evidence.some((record) => record.revision === change.metadata.activeRevision && record.requirementId === 'human-approval' && record.status === 'PASS'),",
        "human approval revision",
    ),
]

for old, new, label in replacements:
    if new in text:
        print(f'{label}: already applied')
        continue
    count = text.count(old)
    if count == 0:
        raise SystemExit(f'{label}: expected text not found')
    text = text.replace(old, new)
    print(f'{label}: applied to {count} occurrence(s)')

path.write_text(text)
