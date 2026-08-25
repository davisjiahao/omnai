import YAML from 'yaml';
import {
  changeMetadataSchema,
  impactModelSchema,
  readinessSchema,
  riskModelSchema,
  type ChangeMetadata,
  type ReadinessStatus,
  type RiskDimensionLevel,
  type RiskLevel,
} from '../domain/types.js';
import { createInitialIssueState } from './issues.js';
import { getScenario } from './scenarios.js';
import { contractTemplate, deliveryTemplate, fixTemplate, issueTemplate } from './templates.js';

export interface ScenarioArtifactSpecification {
  path: 'contract.md' | 'issue.md' | 'issue.yaml' | 'fix.md' | 'delivery.md' | 'experiments';
  kind: 'FILE' | 'DIRECTORY';
  fallback: string | null;
}

/** @internal Pure derivation shared by the reclassification writer and lineage replay. */
export function scenarioReclassificationMetadata(
  source: ChangeMetadata,
  scenarioId: string,
): ChangeMetadata {
  const scenario = getScenario(scenarioId);
  return changeMetadataSchema.parse({
    ...source,
    scenario: scenario.id,
    workMode: scenario.workMode,
    risk: mergeRisk(source.risk, scenario),
    impact: mergeImpact(source.impact, scenario),
    readiness: reclassifiedReadiness(source.readiness, scenario),
  });
}

/** @internal Exact ordered artifact target set for a deterministic scenario profile. */
export function scenarioArtifactSpecifications(
  metadata: ChangeMetadata,
): ScenarioArtifactSpecification[] {
  const scenario = getScenario(metadata.scenario);
  const targets: ScenarioArtifactSpecification[] = [];
  if (metadata.impact.apiContract || scenario.requiredArtifacts.some((path) => path === 'contract.md')) {
    targets.push({ path: 'contract.md', kind: 'FILE', fallback: contractTemplate });
  }
  if (scenario.stages.some((stage) => ['triage', 'reproduce', 'debug'].includes(stage))) {
    targets.push({ path: 'issue.md', kind: 'FILE', fallback: issueTemplate });
    targets.push({
      path: 'issue.yaml',
      kind: 'FILE',
      fallback: YAML.stringify(createInitialIssueState(), { lineWidth: 100 }),
    });
  }
  if (scenario.stages.includes('fix')) {
    targets.push({ path: 'fix.md', kind: 'FILE', fallback: fixTemplate });
  }
  if (scenario.stages.includes('ship')) {
    targets.push({ path: 'delivery.md', kind: 'FILE', fallback: deliveryTemplate });
  }
  if (scenario.stages.includes('experiment') || scenario.optionalStages.includes('experiment')) {
    targets.push({ path: 'experiments', kind: 'DIRECTORY', fallback: null });
  }
  return targets;
}

function reclassifiedReadiness(
  current: ChangeMetadata['readiness'],
  scenario: ReturnType<typeof getScenario>,
): ChangeMetadata['readiness'] {
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
    release: keepOrEnable(current.release, scenario.stages.includes('ship')),
    canary: keepOrEnable(current.canary, required('canary')),
    learning: keepOrEnable(current.learning, required('learn')),
  });
}

function mergeRisk(
  current: ChangeMetadata['risk'],
  scenario: ReturnType<typeof getScenario>,
): ChangeMetadata['risk'] {
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
  current: ChangeMetadata['impact'],
  scenario: ReturnType<typeof getScenario>,
): ChangeMetadata['impact'] {
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

function strongerRisk(left: RiskLevel, right: RiskLevel): RiskLevel {
  const weight: Record<RiskLevel, number> = { P0: 4, P1: 3, P2: 2, P3: 1 };
  return weight[left] >= weight[right] ? left : right;
}

function strongerDimension(left: RiskDimensionLevel, right: RiskDimensionLevel): RiskDimensionLevel {
  const weight: Record<RiskDimensionLevel, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
  return weight[left] >= weight[right] ? left : right;
}
