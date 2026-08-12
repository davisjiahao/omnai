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


# Readiness dimensions that must be observable by the router.
replace(
    "src/domain/types.ts",
    "  frame: z.enum(READINESS_STATUSES).default('MISSING'),\n  research: z.enum(READINESS_STATUSES).default('MISSING'),\n  triage: z.enum(READINESS_STATUSES).default('MISSING'),",
    "  frame: z.enum(READINESS_STATUSES).default('MISSING'),\n  map: z.enum(READINESS_STATUSES).default('MISSING'),\n  research: z.enum(READINESS_STATUSES).default('MISSING'),\n  mitigation: z.enum(READINESS_STATUSES).default('MISSING'),\n  triage: z.enum(READINESS_STATUSES).default('MISSING'),",
    "readiness map/mitigation",
)
replace(
    "src/domain/types.ts",
    "  release: z.enum(READINESS_STATUSES).default('NOT_APPLICABLE'),\n  learning: z.enum(READINESS_STATUSES).default('MISSING'),",
    "  release: z.enum(READINESS_STATUSES).default('NOT_APPLICABLE'),\n  canary: z.enum(READINESS_STATUSES).default('MISSING'),\n  learning: z.enum(READINESS_STATUSES).default('MISSING'),",
    "readiness canary",
)

# Project initialization and artifact scaffolding.
replace(
    "src/core/store.ts",
    "import { existsSync as existsSyncCompat } from 'node:fs';",
    "import { existsSync as existsSyncCompat, readFileSync } from 'node:fs';",
    "store readFileSync",
)
replace(
    "src/core/store.ts",
    "      frame: required('frame'),\n      research: required('research'),\n      triage: required('triage'),",
    "      frame: required('frame'),\n      map: required('map'),\n      research: required('research'),\n      mitigation: required('mitigate'),\n      triage: required('triage'),",
    "store readiness map/mitigation",
)
replace(
    "src/core/store.ts",
    "      release: scenario.stages.some((stage) => stage === 'ship' || stage === 'release') ? 'MISSING' : 'NOT_APPLICABLE',\n      learning: required('learn'),",
    "      release: scenario.stages.some((stage) => stage === 'ship' || stage === 'release') ? 'MISSING' : 'NOT_APPLICABLE',\n      canary: required('canary'),\n      learning: required('learn'),",
    "store readiness canary",
)
replace(
    "src/core/store.ts",
    "  if (['bug-fix', 'emergency-hotfix', 'performance-investigation', 'technical-experiment'].includes(scenario.id)) await ensureDir(join(root, 'experiments'));",
    "  if (scenario.stages.includes('experiment') || scenario.optionalStages.includes('experiment')) await ensureDir(join(root, 'experiments'));",
    "store experiment directory",
)

store = Path("src/core/store.ts")
text = store.read_text()
old_issue = """  if (scenario.id === 'bug-fix' || scenario.id === 'emergency-hotfix') {
    await writeTextAtomic(changeArtifactPath(repoRoot, directoryName, 'issue.md'), issueTemplate);
    await writeYaml(changeArtifactPath(repoRoot, directoryName, 'issue.yaml'), createInitialIssueState());
    await writeTextAtomic(changeArtifactPath(repoRoot, directoryName, 'fix.md'), fixTemplate);
  }
"""
new_issue = """  if (scenario.stages.some((stage) => ['triage', 'reproduce', 'debug'].includes(stage))) {
    await writeTextAtomic(changeArtifactPath(repoRoot, directoryName, 'issue.md'), issueTemplate);
    await writeYaml(changeArtifactPath(repoRoot, directoryName, 'issue.yaml'), createInitialIssueState());
  }
  if (scenario.stages.includes('fix')) {
    await writeTextAtomic(changeArtifactPath(repoRoot, directoryName, 'fix.md'), fixTemplate);
  }
"""
if new_issue not in text:
    if old_issue not in text:
        raise SystemExit("store issue/fix artifact block not found")
    text = text.replace(old_issue, new_issue)
    store.write_text(text)
    print("store issue/fix artifacts: applied")

text = store.read_text()
start = text.index("function discoverVerificationCommands(repoRoot: string): string[] {")
verification_tail = r'''function discoverVerificationCommands(repoRoot: string): string[] {
  const commands: string[] = [];
  const packagePath = join(repoRoot, 'package.json');
  if (pathExistsSync(packagePath)) {
    try {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as { scripts?: Record<string, unknown> };
      if (typeof pkg.scripts?.test === 'string' && pkg.scripts.test.trim()) commands.push('npm test');
    } catch {
      // Invalid package metadata is surfaced by repository tooling; do not invent a test command.
    }
  }
  if (pathExistsSync(join(repoRoot, 'pom.xml'))) {
    if (pathExistsSync(join(repoRoot, 'mvnw'))) commands.push('./mvnw test');
    else if (pathExistsSync(join(repoRoot, 'mvnw.cmd'))) commands.push('mvnw.cmd test');
    else commands.push('mvn test');
  }
  if (pathExistsSync(join(repoRoot, 'build.gradle')) || pathExistsSync(join(repoRoot, 'build.gradle.kts'))) {
    if (pathExistsSync(join(repoRoot, 'gradlew'))) commands.push('./gradlew test');
    else if (pathExistsSync(join(repoRoot, 'gradlew.bat'))) commands.push('gradlew.bat test');
    else commands.push('gradle test');
  }
  if (pathExistsSync(join(repoRoot, 'pyproject.toml'))) {
    try {
      if (readFileSync(join(repoRoot, 'pyproject.toml'), 'utf8').toLowerCase().includes('pytest')) commands.push('pytest');
    } catch {
      // Ignore unreadable optional metadata.
    }
  }
  if (pathExistsSync(join(repoRoot, 'go.mod'))) commands.push('go test ./...');
  return commands;
}
function pathExistsSync(path: string): boolean { try { return Boolean(existsSyncCompat(path)); } catch { return false; } }
'''
store.write_text(text[:start] + verification_tail)
print("verification discovery: applied")

# Router bindings.
replace(
    "src/core/readiness.ts",
    "  frame: 'frame',\n  research: 'research',\n  triage: 'triage',",
    "  frame: 'frame',\n  map: 'map',\n  research: 'research',\n  mitigate: 'mitigation',\n  triage: 'triage',",
    "router map/mitigation",
)
replace(
    "src/core/readiness.ts",
    "  release: 'release',\n  learn: 'learning',",
    "  release: 'release',\n  canary: 'canary',\n  learn: 'learning',",
    "router canary",
)

# Stage readiness and completion gates.
replace(
    "src/core/stages.ts",
    "import { randomUUID } from 'node:crypto';",
    "import { randomUUID } from 'node:crypto';\nimport { readdir } from 'node:fs/promises';",
    "stage directory inspection",
)
replace(
    "src/core/stages.ts",
    "import { buildEvidenceMatrix, selectReviewLenses } from './policy.js';",
    "import { buildEvidenceMatrix, selectReviewLenses } from './policy.js';\nimport { deliveryTemplate, designTemplate, domainTemplate, emptyTaskFile, fixTemplate, intentTemplate, issueTemplate, researchTemplate, specTemplate } from './templates.js';",
    "stage scaffold templates",
)
replace("src/core/stages.ts", "  map: { outputs: ['map.yaml'], context:", "  map: { outputs: ['map.yaml'], readiness: 'map', context:", "stage map readiness")
replace("src/core/stages.ts", "  mitigate: { outputs: ['research.md'], context:", "  mitigate: { outputs: ['research.md'], readiness: 'mitigation', context:", "stage mitigation readiness")
replace("src/core/stages.ts", "  canary: { outputs: ['evidence/canary.json'], context:", "  canary: { outputs: ['evidence/canary.json'], readiness: 'canary', context:", "stage canary readiness")

stages = Path("src/core/stages.ts")
text = stages.read_text()
old_complete = """export async function completeStage(repoRoot: string, change: ChangeRef, capability: Capability): Promise<void> {
  const definition = STAGES[capability];
  for (const output of definition.outputs) {
    if (output.endsWith('/')) continue;
    const path = changeArtifactPath(repoRoot, change.directoryName, output);
    if (!(await pathExists(path))) throw new Error(`Required output '${output}' is missing`);
    const content = await readText(path);
    if (!content.trim()) throw new Error(`Required output '${output}' is empty`);
  }
  if (capability === 'plan') await loadTasks(changeArtifactPath(repoRoot, change.directoryName, 'tasks.yaml'));
  if (definition.readiness) await markReadiness(repoRoot, change, definition.readiness, 'READY');
  await appendJsonLine(changeArtifactPath(repoRoot, change.directoryName, 'progress.jsonl'), {
    timestamp: new Date().toISOString(), event: 'CAPABILITY_COMPLETED', changeId: change.metadata.id,
    revision: change.metadata.activeRevision, detail: capability,
  });
}
"""
new_complete = """export async function completeStage(repoRoot: string, change: ChangeRef, capability: Capability): Promise<void> {
  const definition = STAGES[capability];
  const scenario = getScenario(change.metadata.scenario);
  for (const output of definition.outputs) {
    const path = changeArtifactPath(repoRoot, change.directoryName, output);
    if (output.endsWith('/')) {
      if (!(await pathExists(path))) throw new Error(`Required output '${output}' is missing`);
      const entries = await readdir(path, { withFileTypes: true });
      if (!entries.some((entry) => entry.isFile())) throw new Error(`Required ${capability} output directory '${output}' contains no experiment record`);
      continue;
    }
    if (!(await pathExists(path))) throw new Error(`Required output '${output}' is missing`);
    const content = await readText(path);
    if (!content.trim()) throw new Error(`Required output '${output}' is empty`);
    const scaffold = initialScaffold(output, change, scenario);
    if (scaffold !== null && content.trim() === scaffold.trim()) {
      throw new Error(`Required output '${output}' is still the unchanged scaffold and is incomplete`);
    }
  }
  if (capability === 'plan') {
    const taskFile = await loadTasks(changeArtifactPath(repoRoot, change.directoryName, 'tasks.yaml'));
    if (scenario.stages.includes('work') && taskFile.tasks.length === 0) throw new Error('Plan is incomplete: no implementation tasks were defined');
  }
  if (definition.readiness) await markReadiness(repoRoot, change, definition.readiness, 'READY');
  await appendJsonLine(changeArtifactPath(repoRoot, change.directoryName, 'progress.jsonl'), {
    timestamp: new Date().toISOString(), event: 'CAPABILITY_COMPLETED', changeId: change.metadata.id,
    revision: change.metadata.activeRevision, detail: capability,
  });
}

function initialScaffold(output: string, change: ChangeRef, scenario: ReturnType<typeof getScenario>): string | null {
  switch (output) {
    case 'intent.md': return intentTemplate(change.metadata.title, scenario);
    case 'research.md': return researchTemplate;
    case 'domain.md': return domainTemplate;
    case 'spec.md': return specTemplate;
    case 'design.md': return designTemplate;
    case 'issue.md': return issueTemplate;
    case 'fix.md': return fixTemplate;
    case 'delivery.md': return deliveryTemplate;
    case 'tasks.yaml': return emptyTaskFile;
    default: return null;
  }
}
"""
if new_complete not in text:
    if old_complete not in text:
        raise SystemExit("completeStage block not found")
    stages.write_text(text.replace(old_complete, new_complete))
    print("completion gate: applied")

# Scenario policy corrections.
replace(
    "src/core/scenarios.ts",
    "    workMode: 'QUALITY', stages: ['research', 'review', 'qa', 'verify', 'learn'], optionalStages: ['plan', 'work', 'reconcile'], requiredArtifacts: ['research.md'],",
    "    workMode: 'QUALITY', stages: ['research', 'review', 'verify', 'learn'], optionalStages: ['qa', 'plan', 'work', 'reconcile'], requiredArtifacts: ['research.md'],",
    "quality hardening conditional QA",
)
replace(
    "src/core/scenarios.ts",
    "    gates: ['Quality findings are tied to an explicit contract or observed behavior', 'Fixes remain within the hardening scope'], requiredEvidence: ['review', 'tests', 'qa'],",
    "    gates: ['Quality findings are tied to an explicit contract or observed behavior', 'Fixes remain within the hardening scope'], requiredEvidence: ['review', 'tests'],",
    "quality hardening evidence",
)
replace(
    "src/core/scenarios.ts",
    "    requiredArtifacts: ['research.md', 'fix.md', 'tasks.yaml', 'delivery.md'], gates: ['Mitigation and root-cause correction are recorded separately', 'Emergency changes require explicit delivery approval'],",
    "    requiredArtifacts: ['issue.md', 'issue.yaml', 'research.md', 'fix.md', 'tasks.yaml', 'delivery.md'], gates: ['Mitigation and root-cause correction are recorded separately', 'Emergency changes require explicit delivery approval'],",
    "incident artifacts",
)
replace(
    "src/core/scenarios.ts",
    "    requiredArtifacts: ['research.md', 'fix.md', 'tasks.yaml', 'delivery.md'], gates: ['Promotion is paused before investigation', 'Rollback capability is checked instead of assumed'],",
    "    requiredArtifacts: ['issue.md', 'issue.yaml', 'research.md', 'fix.md', 'tasks.yaml', 'delivery.md'], gates: ['Promotion is paused before investigation', 'Rollback capability is checked instead of assumed'],",
    "release failure artifacts",
)

# Reconcile creates a new baseline, invalidates selectively, then returns to normal routing.
reconcile = Path("src/core/reconcile.ts")
text = reconcile.read_text()
start = text.index("const IMPACTS: Record<ReconcileLevel")
end = text.index("\n\nexport interface ReconcileInput", start)
impact_block = """const IMPACTS: Record<ReconcileLevel, Array<keyof ChangeMetadata['readiness']>> = {
  L0: ['implementation', 'review', 'verification', 'qa', 'release', 'canary', 'learning'],
  L1: ['plan', 'implementation', 'review', 'verification', 'qa', 'release', 'canary', 'learning'],
  L2: ['design', 'experiment', 'fix', 'plan', 'implementation', 'review', 'verification', 'qa', 'release', 'canary', 'learning'],
  L3: ['domain', 'spec', 'design', 'experiment', 'fix', 'plan', 'implementation', 'review', 'verification', 'qa', 'release', 'canary', 'learning'],
  L4: ['frame', 'map', 'research', 'mitigation', 'triage', 'reproduction', 'diagnosis', 'domain', 'spec', 'design', 'experiment', 'fix', 'plan', 'implementation', 'review', 'verification', 'qa', 'release', 'canary', 'learning'],
  L5: ['review', 'verification', 'qa', 'release', 'canary'],
};"""
text = text[:start] + impact_block + text[end:]
text = text.replace("  change.metadata.status = 'NEEDS_RECONCILE';", "  change.metadata.status = 'IN_PROGRESS';")
reconcile.write_text(text)
print("reconcile routing: applied")

# Host installation checks every collision before any copy and can initialize itself when called directly.
Path("src/core/host-skills.ts").write_text(r'''import { cp, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectConfig } from '../domain/types.js';
import { ensureDir } from './files.js';
import { initializeProject, loadProjectConfig, saveProjectConfig } from './store.js';

export type SupportedHost = 'claude' | 'codex' | 'opencode';

const HOST_DIRECTORIES: Record<SupportedHost, string> = {
  claude: '.claude/skills',
  codex: '.codex/skills',
  opencode: '.opencode/skills',
};

export async function installHostSkills(repoRoot: string, host: SupportedHost): Promise<string[]> {
  const sourceRoot = locateSkillsRoot();
  const destinationRoot = join(repoRoot, HOST_DIRECTORIES[host]);
  const entries = (await readdir(sourceRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && existsSync(join(sourceRoot, entry.name, 'SKILL.md')));

  for (const entry of entries) {
    const destination = join(destinationRoot, entry.name);
    if (!existsSync(destination)) continue;
    const skillPath = join(destination, 'SKILL.md');
    if (!existsSync(skillPath)) throw new Error(`Refusing to overwrite existing foreign skill directory '${destination}'`);
    const content = await readFile(skillPath, 'utf8');
    const name = /^name:\s*([^\r\n]+)$/m.exec(content)?.[1]?.trim();
    if (name !== entry.name || !/^# OmnAI\b/m.test(content)) {
      throw new Error(`Refusing to overwrite existing foreign skill '${destination}'`);
    }
  }

  await initializeProject(repoRoot);
  await ensureDir(destinationRoot);
  const installed: string[] = [];
  for (const entry of entries) {
    const source = join(sourceRoot, entry.name);
    const destination = join(destinationRoot, entry.name);
    await cp(source, destination, { recursive: true, force: true });
    installed.push(destination);
  }

  const config = await loadProjectConfig(repoRoot);
  const installedHosts: ProjectConfig['installedHosts'] = [...new Set([...config.installedHosts, host])];
  await saveProjectConfig(repoRoot, { ...config, installedHosts });
  return installed;
}

export function locateSkillsRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const candidates = [
    resolve(dirname(currentFile), '../../skills'),
    resolve(dirname(currentFile), '../../../skills'),
    resolve(process.cwd(), 'skills'),
  ];
  const match = candidates.find((candidate) => existsSync(join(candidate, 'omnai', 'SKILL.md')));
  if (!match) throw new Error(`Unable to locate packaged OmnAI skills. Checked: ${candidates.join(', ')}`);
  return match;
}
''')
print("host skill collision protection: applied")

skills = {
    "omnai-reproduce": """---\nname: omnai-reproduce\ndescription: Establish deterministic bug reproduction or a concrete instrumentation plan before diagnosis or fixing.\n---\n\n# OmnAI Reproduce\n\n1. Run `omnai reproduce \"<symptom>\"` for the active bug-oriented change.\n2. Capture exact preconditions, inputs, environment, expected behavior, actual behavior, and evidence.\n3. Prefer the smallest deterministic reproducer; if impossible, define instrumentation that can falsify hypotheses.\n4. Update `issue.md` and `issue.yaml`; do not edit production code.\n5. Complete only when reproduction is confirmed or an explicit instrumentation route is recorded.\n""",
    "omnai-simplify": """---\nname: omnai-simplify\ndescription: Simplify an implemented diff without changing behavior before independent review.\n---\n\n# OmnAI Simplify\n\n1. Work only on the active task's diff and preserve observable behavior.\n2. Remove accidental complexity, duplication, dead branches, and unnecessary abstractions only when safe.\n3. Do not expand scope or redesign unrelated code.\n4. Re-run relevant verification and record fresh evidence.\n""",
    "omnai-mitigate": """---\nname: omnai-mitigate\ndescription: Reduce active production impact before root-cause correction while preserving evidence and reversibility.\n---\n\n# OmnAI Mitigate\n\n1. Use for `incident-response` and `release-failure` before normal diagnosis.\n2. Choose the smallest reversible action that reduces customer or operational impact.\n3. Preserve logs, traces, versions, timestamps, and other evidence before destructive actions.\n4. Record action, reversibility, side effects, remaining impact, owner, and evidence in `research.md`.\n5. Mitigation is not root-cause completion; continue through research/debug/fix.\n""",
    "omnai-canary": """---\nname: omnai-canary\ndescription: Evaluate an activated change during a bounded observation window using explicit technical and business thresholds.\n---\n\n# OmnAI Canary\n\n1. Run only after delivery readiness and activation prerequisites are satisfied.\n2. Define observation window, technical metrics, business metrics, thresholds, and rollback/pause criteria.\n3. Record anomalies and evidence in `evidence/canary.json`.\n4. End with an explicit continue, pause, or rollback recommendation; absence of alerts alone is not proof.\n""",
    "omnai-archive": """---\nname: omnai-archive\ndescription: Archive a verified change while preserving revisions, evidence, and knowledge lineage.\n---\n\n# OmnAI Archive\n\n1. Run `omnai status` and confirm required tasks, verification, review, delivery, and scenario evidence are satisfied.\n2. Do not use `--force` to hide unresolved evidence except for an explicitly documented human waiver.\n3. Run `omnai archive` only after canonical artifacts agree with the active revision and baseline.\n4. Preserve the full change history; archive is a lifecycle state, not deletion.\n""",
}
for name, content in skills.items():
    path = Path("skills") / name / "SKILL.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    print(f"{name}: written")
