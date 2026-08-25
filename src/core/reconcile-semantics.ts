import type { ChangeMetadata, FlowAssessment, ReconcileLevel } from '../domain/types.js';

const READINESS_CLOSURES: Record<ReconcileLevel, Array<keyof ChangeMetadata['readiness']>> = {
  L0: ['implementation', 'review', 'verification', 'qa', 'release', 'canary', 'learning'],
  L1: ['plan', 'implementation', 'review', 'verification', 'qa', 'release', 'canary', 'learning'],
  L2: ['design', 'experiment', 'fix', 'plan', 'implementation', 'review', 'verification', 'qa', 'release', 'canary', 'learning'],
  L3: ['domain', 'spec', 'design', 'experiment', 'fix', 'plan', 'implementation', 'review', 'verification', 'qa', 'release', 'canary', 'learning'],
  L4: ['frame', 'map', 'research', 'mitigation', 'triage', 'reproduction', 'diagnosis', 'domain', 'spec', 'design', 'experiment', 'fix', 'plan', 'implementation', 'review', 'verification', 'qa', 'release', 'canary', 'learning'],
  L5: ['review', 'verification', 'qa', 'release', 'canary'],
};

export function readinessClosureForReconcileLevel(
  level: ReconcileLevel,
): Array<keyof ChangeMetadata['readiness']> {
  return [...READINESS_CLOSURES[level]];
}

export function changedFlowAssessmentFields(current: FlowAssessment, next: FlowAssessment): string[] {
  const changed: string[] = [];
  if (current.scale !== next.scale) changed.push('scale');
  if (current.uncertainty.problem !== next.uncertainty.problem) changed.push('uncertainty.problem');
  if (current.uncertainty.domain !== next.uncertainty.domain) changed.push('uncertainty.domain');
  if (current.uncertainty.solution !== next.uncertainty.solution) changed.push('uncertainty.solution');
  if (current.topology !== next.topology) changed.push('topology');
  if (current.architectureApplicability !== next.architectureApplicability) changed.push('architectureApplicability');
  if (current.uncertainty.delivery !== next.uncertainty.delivery) changed.push('uncertainty.delivery');
  if (current.deliveryShape !== next.deliveryShape) changed.push('deliveryShape');
  return changed;
}

export function reconcileLevelForFlowAssessmentChanges(changedFields: readonly string[]): ReconcileLevel {
  if (changedFields.includes('scale') || changedFields.includes('uncertainty.problem')) return 'L4';
  if (changedFields.includes('uncertainty.domain')) return 'L3';
  return 'L2';
}

export function flowAssessmentReconcileReason(changedFields: readonly string[]): string {
  return `Flow assessment changed: ${changedFields.join(', ')}`;
}
