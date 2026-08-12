from pathlib import Path


def replace(path: str, old: str, new: str, label: str) -> None:
    p = Path(path)
    text = p.read_text()
    if new in text:
        print(f"{label}: already applied")
        return
    if old not in text:
        raise SystemExit(f"{label}: expected text not found in {path}")
    p.write_text(text.replace(old, new))
    print(f"{label}: applied")


replace(
    'src/core/scenarios.ts',
    "    workMode: 'RELEASE', stages: ['mitigate', 'research', 'debug', 'reconcile', 'fix', 'work', 'verify', 'review', 'ship', 'learn'], optionalStages: [],",
    "    workMode: 'RELEASE', stages: ['mitigate', 'research', 'debug', 'fix', 'work', 'verify', 'review', 'ship', 'learn'], optionalStages: ['reconcile'],",
    'release failure event-driven reconcile',
)

replace(
    'src/cli.ts',
    """    if (!options.block && !options.done && !options.verified && (change.metadata.scenario === 'bug-fix' || change.metadata.scenario === 'emergency-hotfix')) {\n      const issue = await loadIssueState(changeArtifactPath(repoRoot, change.directoryName, 'issue.yaml'));\n      const decision = evaluateGuard({ action: 'edit', scenario: change.metadata.scenario, riskLevel: change.metadata.risk.level, issue });\n      if (!decision.allowed) throw new Error(`${decision.code}: ${decision.reason}`);\n    }\n""",
    """    if (!options.block && !options.done && !options.verified) {\n      const issuePath = changeArtifactPath(repoRoot, change.directoryName, 'issue.yaml');\n      if (await pathExists(issuePath)) {\n        const issue = await loadIssueState(issuePath);\n        const decision = evaluateGuard({ action: 'edit', scenario: change.metadata.scenario, riskLevel: change.metadata.risk.level, issue });\n        if (!decision.allowed) throw new Error(`${decision.code}: ${decision.reason}`);\n      }\n    }\n""",
    'work issue-backed guard',
)

replace(
    'src/cli.ts',
    "  if (!['bug-fix', 'emergency-hotfix'].includes(scenario)) throw new Error(`Scenario '${scenario}' does not use issue.yaml triage state.`);",
    "  if (!['bug-fix', 'emergency-hotfix', 'incident-response', 'release-failure'].includes(scenario)) throw new Error(`Scenario '${scenario}' does not use issue.yaml triage state.`);",
    'issue CLI scenarios',
)
