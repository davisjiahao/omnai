import { join } from 'node:path';
import {
  impactModelSchema,
  readinessSchema,
  riskModelSchema,
  type ImpactModel,
  type ReadinessStatus,
  type RiskDimensionLevel,
  type RiskLevel,
} from '../domain/types.js';
import { appendJsonLine, ensureDir, pathExists, writeTextAtomic, writeYaml } from './files.js';
import { createInitialIssueState } from './issues.js';
import { changeArtifactPath, changeRoot } from './paths.js';
import { reconcileChange, type ReconcileResult } from './reconcile.js';
import { getScenario } from './scenarios.js';
import type { ChangeRef } from './store.js';
import { loadTasks } from './tasks.js';
import { contractTemplate, deliveryTemplate, fixTemplate, issueTemplate } from './templates.js';

export interface ReclassifyResult {
  change: ChangeRef;
  reconcile: ReconcileResult;
}

export async function reclassifyChange(
  repoRoot: string,
  change: ChangeRef,
  scenarioId: string,
  reason = 'Scenario profile reclassified',
): Promise<ReclassifyResult> {
  if (change.metadata.status === 'ARCHIVED') throw new Error('Archived Changes cannot be reclassified.');

  const previousScenario = getScenario(change.metadata.scenario);
  const nextScenario = getScenario(scenarioId);
  if (nextScenario.workMode === 'READ_ONLY_QUERY') {
    throw new Error(`Scenario '${nextScenario.id}' is a read-only investigation and cannot classify an implementation Change.`);
  }
  if (nextScenario.id === previousScenario.id) {
    throw new Error(`Change ${change.metadata.id} already uses scenario '${nextScenario.id}'.`);
  }

  const nextRisk = mergeRisk(change.metadata.risk, nextScenario);
  const nextImpact = mergeImpact(change.metadata.impact, nextScenario);
  const nextReadiness = reclassifiedReadiness(change.metadata.readiness, nextScenario);

  await ensureScenarioArtifacts(repoRoot, change, nextScenario, nextImpact);
  const taskFile = await loadTasks(changeArtifactPath(repoRoot, change.directoryName, 'tasks.yaml'));
  const affectedTasks = taskFile.tasks.map((task) => task.id);

  change.metadata.scenario = nextScenario.id;
  change.metadata.workMode = nextScenario.workMode;
  change.metadata.risk = nextRisk;
  change.metadata.impact = nextImpact;
  change.metadata.readiness = nextReadiness;

  const reconcile = await reconcileChange(repoRoot, change, {
    level: 'L4',
    type: 'SCENARIO_RECLASSIFIED',
    reason: `${reason}. ${previousScenario.id} -> ${nextScenario.id}`,
    affectedTasks,
  });

  await appendJsonLine(changeArtifactPath(repoRoot, change.directoryName, 'progress.jsonl'), {
    timestamp: new Date().toISOString(),
    event: 'SCENARIO_RECLASSIFIED',
    changeId: change.metadata.id,
    revision: change.metadata.activeRevision,
    detail: `${previousScenario.id} -> ${nextScenario.id}`,
    data: {
      previousScenario: previousScenario.id,
      scenario: nextScenario.id,
      risk: change.metadata.risk,
      impact: change.metadata.impact,
    },
  });

  return { change, reconcile };
}

function reclassifiedReadiness(
  current: ChangeRef['metadata']['readiness'],
  scenario: ReturnType<typeof getScenario>,
): ChangeRef['metadata']['readiness'] {
  const required = (capability: string): boolean => scenario.stages.includes(capability as never);
  const keepOrEnable = (value: ReadinessStatus, needed: boolean): ReadinessStatus => {
    if (!needed) return 'NOT_APPLICABLE';
    return value === 'NOT_APPLICABLE' ? 'MISSING' : value;
  };

  return readinessSchema.parse({
    frame: keepOrEnable(current.frame, required('frame')),
    map: keepOrEnable(current.map, required('map')),
    research: keepOrEnable(current.research, required('research')),
    mitigation: keepOrEnable(current.mitigation, required('mitigate')),
    triage: keepOrEnable(current.triage, required('triage')),
    reproduction: keepOrEnable(current.reproduction, required('reproduce')),
    diagnosis: keepOrEnable(current.diagnosis, scenario.stages.some((stage) => stage === 'debug' || stage === 'diagnose')),
    domain: keepOrEnable(current.domain, required('model')),
    spec: keepOrEnable(current.spec, required('spec')),
    design: keepOrEnable(current.design, required('design')),
    experiment: keepOrEnable(current.experiment, required('experiment')),
    fix: keepOrEnable(current.fix, required('fix')),
    plan: keepOrEnable(current.plan, required('plan')),
    implementation: keepOrEnable(current.implementation, required('work')),
    review: keepOrEnable(current.review, required('review')),
    verification: keepOrEnable(current.verification, required('verify')),
    qa: keepOrEnable(current.qa, required('qa')),
    release: keepOrEnable(current.release, scenario.stages.some((stage) => stage === 'ship' || stage === 'release')),
    canary: keepOrEnable(current.canary, required('canary')),
    learning: keepOrEnable(current.learning, required('learn')),
  });
}

function mergeRisk(
  current: ChangeRef['metadata']['risk'],
  scenario: ReturnType<typeof getScenario>,
): ChangeRef['metadata']['risk'] {
  const target = riskModelSchema.parse({ level: scenario.risk, dimensions: scenario.riskDimensions ?? {} });
  return riskModelSchema.parse({
    level: strongerRisk(current.level, target.level),
    dimensions: {
      businessCriticality: strongerDimension(current.dimensions.businessCriticality, target.dimensions.businessCriticality),
      data: strongerDimension(current.dimensions.data, target.dimensions.data),
      compatibility: strongerDimension(current.dimensions.compatibility, target.dimensions.compatibility),
      reversibility: strongerDimension(current.dimensions.reversibility, target.dimensions.reversibility),
      security: strongerDimension(current.dimensions.security, target.dimensions.security),
      operational: strongerDimension(current.dimensions.operational, target.dimensions.operational),
    },
  });
}

function mergeImpact(
  current: ImpactModel,
  scenario: ReturnType<typeof getScenario>,
): ImpactModel {
  const target = impactModelSchema.parse(scenario.defaultImpact ?? {});
  return impactModelSchema.parse({
    frontend: current.frontend || target.frontend,
    backend: current.backend || target.backend,
    apiContract: current.apiContract || target.apiContract,
    database: current.database || target.database,
    mq: current.mq || target.mq,
    remoteService: current.remoteService || target.remoteService,
    security: current.security || target.security,
    observability: current.observability || target.observability,
  });
}

async function ensureScenarioArtifacts(
  repoRoot: string,
  change: ChangeRef,
  scenario: ReturnType<typeof getScenario>,
  impact: ImpactModel,
): Promise<void> {
  const writeIfMissing = async (name: string, content: string): Promise<void> => {
    const path = changeArtifactPath(repoRoot, change.directoryName, name);
    if (!(await pathExists(path))) await writeTextAtomic(path, content);
  };

  if (impact.apiContract || scenario.requiredArtifacts.includes('contract.md')) await writeIfMissing('contract.md', contractTemplate);
  if (scenario.stages.some((stage) => ['triage', 'reproduce', 'debug'].includes(stage))) {
    await writeIfMissing('issue.md', issueTemplate);
    const issuePath = changeArtifactPath(repoRoot, change.directoryName, 'issue.yaml');
    if (!(await pathExists(issuePath))) await writeYaml(issuePath, createInitialIssueState());
  }
  if (scenario.stages.includes('fix')) await writeIfMissing('fix.md', fixTemplate);
  if (scenario.stages.some((stage) => stage === 'ship' || stage === 'release')) await writeIfMissing('delivery.md', deliveryTemplate);
  if (scenario.stages.includes('experiment') || scenario.optionalStages.includes('experiment')) {
    await ensureDir(join(changeRoot(repoRoot, change.directoryName), 'experiments'));
  }
}

function strongerRisk(left: RiskLevel, right: RiskLevel): RiskLevel {
  const weight: Record<RiskLevel, number> = { P0: 4, P1: 3, P2: 2, P3: 1 };
  return weight[left] >= weight[right] ? left : right;
}

function strongerDimension(left: RiskDimensionLevel, right: RiskDimensionLevel): RiskDimensionLevel {
  const weight: Record<RiskDimensionLevel, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
  return weight[left] >= weight[right] ? left : right;
}
