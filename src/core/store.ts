import { existsSync as existsSyncCompat, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  changeMetadataSchema, projectConfigSchema, readinessSchema, workflowLockSchema,
  type ChangeMetadata, type ProjectConfig, type ReadinessStatus, type WorkflowLock,
} from '../domain/types.js';
import { createInitialIssueState } from './issues.js';
import { getScenario } from './scenarios.js';
import {
  changeArtifactPath, changeEvidenceRoot, changeMetadataPath, changeRevisionsRoot, changeRoot, changeRunsRoot,
  changesRoot, omnaiRoot, projectConfigPath, projectKnowledgeRoot, workflowLockPath,
} from './paths.js';
import {
  contractTemplate, deliveryTemplate, designTemplate, domainTemplate, emptyTaskFile, fixTemplate, intentTemplate,
  issueTemplate, learningsIndexTemplate, projectGlossaryTemplate, projectPoliciesTemplate, researchTemplate, specTemplate,
} from './templates.js';
import { appendJsonLine, ensureDir, pathExists, readYaml, writeTextAtomic, writeYaml } from './files.js';

const WORKFLOW_VERSION = '0.2.0';

export interface ChangeRef { directoryName: string; metadata: ChangeMetadata; }

export async function initializeProject(repoRoot: string): Promise<ProjectConfig> {
  const root = omnaiRoot(repoRoot);
  await ensureDir(root);
  await ensureDir(changesRoot(repoRoot));
  await ensureDir(projectKnowledgeRoot(repoRoot));

  const configPath = projectConfigPath(repoRoot);
  let config: ProjectConfig;
  if (await pathExists(configPath)) config = await readYaml(configPath, projectConfigSchema);
  else {
    config = projectConfigSchema.parse({
      schemaVersion: 1,
      project: basename(repoRoot),
      activeChange: null,
      defaultScenario: 'small-feature',
      verification: { commands: discoverVerificationCommands(repoRoot) },
    });
    await writeYaml(configPath, config);
  }

  const lockPath = workflowLockPath(repoRoot);
  if (!(await pathExists(lockPath))) {
    const lock: WorkflowLock = workflowLockSchema.parse({
      schemaVersion: 1,
      workflowVersion: WORKFLOW_VERSION,
      artifactSchemas: { project: 1, change: 1, task: 1, evidence: 1, revision: 1, issue: 1 },
    });
    await writeYaml(lockPath, lock);
  }

  await createIfMissing(join(projectKnowledgeRoot(repoRoot), 'glossary.md'), projectGlossaryTemplate);
  await createIfMissing(join(projectKnowledgeRoot(repoRoot), 'policies.md'), projectPoliciesTemplate);
  await createIfMissing(join(projectKnowledgeRoot(repoRoot), 'learnings.md'), learningsIndexTemplate);
  await ensureDir(join(projectKnowledgeRoot(repoRoot), 'decisions'));
  return config;
}

export async function loadProjectConfig(repoRoot: string): Promise<ProjectConfig> {
  return readYaml(projectConfigPath(repoRoot), projectConfigSchema);
}

export async function saveProjectConfig(repoRoot: string, config: ProjectConfig): Promise<void> {
  await writeYaml(projectConfigPath(repoRoot), projectConfigSchema.parse(config));
}

export async function createChange(repoRoot: string, title: string, scenarioId?: string): Promise<ChangeRef> {
  await initializeProject(repoRoot);
  const config = await loadProjectConfig(repoRoot);
  const scenario = getScenario(scenarioId ?? config.defaultScenario);
  if (scenario.workMode === 'READ_ONLY_QUERY') {
    throw new Error(`Scenario '${scenario.id}' is a read-only investigation. Use 'omnai investigate create ${scenario.id} "<question>"' and explicitly promote it before implementation.`);
  }
  const id = await nextChangeId(repoRoot);
  const slug = slugify(title);
  const directoryName = `${id}-${slug}`;
  const now = new Date().toISOString();
  const required = (capability: string): ReadinessStatus => scenario.stages.includes(capability as never) ? 'MISSING' : 'NOT_APPLICABLE';
  const metadata = changeMetadataSchema.parse({
    schemaVersion: 1,
    id, slug, title, scenario: scenario.id, workMode: scenario.workMode, status: 'DRAFT', activeRevision: 'REV-0001', baseline: 'BL-0001', artifactVersions: {},
    risk: { level: scenario.risk, dimensions: scenario.riskDimensions ?? {} },
    impact: scenario.defaultImpact ?? {},
    createdAt: now,
    updatedAt: now,
    readiness: readinessSchema.parse({
      frame: required('frame'),
      map: required('map'),
      research: required('research'),
      mitigation: required('mitigate'),
      triage: required('triage'),
      reproduction: required('reproduce'),
      diagnosis: scenario.stages.some((stage) => stage === 'debug' || stage === 'diagnose') ? 'MISSING' : 'NOT_APPLICABLE',
      domain: required('model'),
      spec: required('spec'),
      design: required('design'),
      experiment: required('experiment'),
      fix: required('fix'),
      plan: required('plan'),
      implementation: required('work'),
      review: required('review'),
      verification: required('verify'),
      qa: required('qa'),
      release: scenario.stages.some((stage) => stage === 'ship' || stage === 'release') ? 'MISSING' : 'NOT_APPLICABLE',
      canary: required('canary'),
      learning: required('learn'),
    }),
  });

  const root = changeRoot(repoRoot, directoryName);
  await ensureDir(root);
  await ensureDir(join(root, 'decisions'));
  await ensureDir(changeEvidenceRoot(repoRoot, directoryName));
  await ensureDir(changeRevisionsRoot(repoRoot, directoryName));
  await ensureDir(changeRunsRoot(repoRoot, directoryName));
  if (scenario.stages.includes('experiment') || scenario.optionalStages.includes('experiment')) await ensureDir(join(root, 'experiments'));

  await writeYaml(changeMetadataPath(repoRoot, directoryName), metadata);
  await writeTextAtomic(changeArtifactPath(repoRoot, directoryName, 'intent.md'), intentTemplate(title, scenario));
  await writeTextAtomic(changeArtifactPath(repoRoot, directoryName, 'research.md'), researchTemplate);
  await writeTextAtomic(changeArtifactPath(repoRoot, directoryName, 'domain.md'), domainTemplate);
  await writeTextAtomic(changeArtifactPath(repoRoot, directoryName, 'spec.md'), specTemplate);
  await writeTextAtomic(changeArtifactPath(repoRoot, directoryName, 'design.md'), designTemplate);
  if (metadata.impact.apiContract || scenario.requiredArtifacts.includes('contract.md')) await writeTextAtomic(changeArtifactPath(repoRoot, directoryName, 'contract.md'), contractTemplate);
  if (scenario.stages.some((stage) => ['triage', 'reproduce', 'debug'].includes(stage))) {
    await writeTextAtomic(changeArtifactPath(repoRoot, directoryName, 'issue.md'), issueTemplate);
    await writeYaml(changeArtifactPath(repoRoot, directoryName, 'issue.yaml'), createInitialIssueState());
  }
  if (scenario.stages.includes('fix')) {
    await writeTextAtomic(changeArtifactPath(repoRoot, directoryName, 'fix.md'), fixTemplate);
  }
  if (scenario.stages.some((stage) => stage === 'ship' || stage === 'release')) await writeTextAtomic(changeArtifactPath(repoRoot, directoryName, 'delivery.md'), deliveryTemplate);
  await writeTextAtomic(changeArtifactPath(repoRoot, directoryName, 'tasks.yaml'), emptyTaskFile);
  await writeTextAtomic(changeArtifactPath(repoRoot, directoryName, 'progress.jsonl'), '');
  await writeYaml(join(changeRevisionsRoot(repoRoot, directoryName), 'REV-0001.yaml'), {
    schemaVersion: 1, id: 'REV-0001', changeId: id, previousRevision: null, reason: 'Initial change baseline', level: 'L0', affectedArtifacts: [], affectedTasks: [], createdAt: now,
  });
  await appendJsonLine(changeArtifactPath(repoRoot, directoryName, 'progress.jsonl'), {
    timestamp: now, event: 'CHANGE_CREATED', changeId: id, revision: 'REV-0001', detail: `Scenario ${scenario.id}`,
    data: { risk: metadata.risk, impact: metadata.impact, baseline: metadata.baseline },
  });
  await saveProjectConfig(repoRoot, { ...config, activeChange: id });
  return { directoryName, metadata };
}

export async function listChanges(repoRoot: string): Promise<ChangeRef[]> {
  const root = changesRoot(repoRoot);
  if (!(await pathExists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const changes: ChangeRef[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^CHG-\d{4}-/.test(entry.name)) continue;
    const metadata = await readYaml(changeMetadataPath(repoRoot, entry.name), changeMetadataSchema);
    changes.push({ directoryName: entry.name, metadata });
  }
  return changes.sort((left, right) => left.metadata.id.localeCompare(right.metadata.id));
}

export async function resolveChange(repoRoot: string, reference?: string): Promise<ChangeRef> {
  const changes = await listChanges(repoRoot);
  const config = await loadProjectConfig(repoRoot);
  const target = reference ?? config.activeChange ?? undefined;
  if (!target) throw new Error("No active change. Create one with 'omnai new <title>' or select one with 'omnai use <id>'.");
  const match = changes.find(({ directoryName, metadata }) => metadata.id === target || metadata.slug === target || directoryName === target);
  if (!match) throw new Error(`Change '${target}' was not found.`);
  return match;
}

export async function selectChange(repoRoot: string, reference: string): Promise<ChangeRef> {
  const change = await resolveChange(repoRoot, reference);
  const config = await loadProjectConfig(repoRoot);
  await saveProjectConfig(repoRoot, { ...config, activeChange: change.metadata.id });
  return change;
}

export async function saveChange(repoRoot: string, change: ChangeRef): Promise<void> {
  const metadata = changeMetadataSchema.parse({ ...change.metadata, updatedAt: new Date().toISOString() });
  await writeYaml(changeMetadataPath(repoRoot, change.directoryName), metadata);
  change.metadata = metadata;
}

export async function markReadiness(repoRoot: string, change: ChangeRef, key: keyof ChangeMetadata['readiness'], value: ReadinessStatus): Promise<void> {
  change.metadata.readiness[key] = value;
  if (change.metadata.status === 'DRAFT' && value === 'IN_PROGRESS') change.metadata.status = 'IN_PROGRESS';
  await saveChange(repoRoot, change);
}

export async function nextChangeId(repoRoot: string): Promise<string> {
  const changes = await listChanges(repoRoot);
  const next = changes.reduce((max, change) => Math.max(max, Number(change.metadata.id.slice(4))), 0) + 1;
  return `CHG-${String(next).padStart(4, '0')}`;
}

export function slugify(value: string): string {
  const slug = value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return slug || 'change';
}

async function createIfMissing(path: string, content: string): Promise<void> { if (!(await pathExists(path))) await writeTextAtomic(path, content); }

function discoverVerificationCommands(repoRoot: string): string[] {
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
