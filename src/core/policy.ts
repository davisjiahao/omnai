import type { ImpactModel, RiskModel, ScenarioProfile } from '../domain/types.js';

export interface EvidenceRequirement {
  id: string;
  required: boolean;
  because: string;
}

export type ReviewLens =
  | 'business'
  | 'domain'
  | 'architecture'
  | 'contract'
  | 'engineering'
  | 'data'
  | 'security'
  | 'performance'
  | 'operations'
  | 'ux';

export function buildEvidenceMatrix(
  scenario: ScenarioProfile,
  risk: RiskModel,
  impact: ImpactModel,
): EvidenceRequirement[] {
  const requirements = new Map<string, EvidenceRequirement>();
  const add = (id: string, because: string, required = true): void => {
    const existing = requirements.get(id);
    if (!existing || (required && !existing.required)) requirements.set(id, { id, required, because });
  };

  for (const id of scenario.requiredEvidence) add(id, `required by scenario ${scenario.id}`);

  if (impact.backend) {
    add('tests', 'backend behavior is affected');
    add('build', 'backend code must compile/package successfully');
  }
  if (impact.frontend) {
    add('component-tests', 'frontend behavior is affected');
    add('browser-qa', 'user-visible behavior requires real experience evidence');
  }
  if (impact.apiContract) add('contract-test', 'an API, event, or public contract changes');
  if (impact.database) add('data-reconciliation', 'persistent data or schema changes');
  if (impact.mq) add('event-contract-test', 'message/event compatibility is affected');
  if (impact.remoteService) add('integration-test', 'a remote-service boundary is affected');
  if (impact.security || risk.dimensions.security === 'HIGH' || risk.dimensions.security === 'CRITICAL') {
    add('security-review', 'security-sensitive behavior is affected');
  }
  if (impact.observability || risk.dimensions.operational === 'HIGH' || risk.dimensions.operational === 'CRITICAL') {
    add('runtime-health', 'operational behavior must be observed');
  }

  if (risk.level === 'P0' || risk.level === 'P1') {
    add('rollback-plan', `${risk.level} changes require an explicit recovery path`);
    add('human-approval', `${risk.level} changes require explicit human approval`);
  }
  if (risk.level === 'P0') add('rehearsal-or-dry-run', 'P0 changes require rehearsal when technically possible');

  return [...requirements.values()];
}

export function selectReviewLenses(
  scenario: ScenarioProfile,
  risk: RiskModel,
  impact: ImpactModel,
): ReviewLens[] {
  const lenses = new Set<ReviewLens>(['engineering']);

  if (risk.level === 'P0' || risk.level === 'P1') {
    lenses.add('business');
    lenses.add('architecture');
  }
  if (scenario.workMode === 'ARCHITECTURE_CHANGE' || scenario.workMode === 'MIGRATION' || scenario.id === 'complex-domain-feature') {
    lenses.add('domain');
    lenses.add('architecture');
  }
  if (impact.apiContract || impact.mq) lenses.add('contract');
  if (impact.database || risk.dimensions.data === 'HIGH' || risk.dimensions.data === 'CRITICAL') lenses.add('data');
  if (impact.security || risk.dimensions.security === 'HIGH' || risk.dimensions.security === 'CRITICAL') lenses.add('security');
  if (scenario.workMode === 'PERFORMANCE') lenses.add('performance');
  if (impact.remoteService || impact.observability || risk.dimensions.operational === 'HIGH' || risk.dimensions.operational === 'CRITICAL') {
    lenses.add('operations');
  }
  if (impact.frontend) lenses.add('ux');

  const order: ReviewLens[] = ['business', 'domain', 'architecture', 'contract', 'engineering', 'data', 'security', 'performance', 'operations', 'ux'];
  return order.filter((lens) => lenses.has(lens));
}
