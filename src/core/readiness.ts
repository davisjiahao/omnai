import type { Capability, ChangeMetadata, ReadinessStatus, ScenarioProfile } from '../domain/types.js';

const STAGE_READINESS: Partial<Record<Capability, keyof ChangeMetadata['readiness']>> = {
  frame: 'frame',
  research: 'research',
  model: 'domain',
  spec: 'spec',
  design: 'design',
  plan: 'plan',
  work: 'implementation',
  verify: 'verification',
  release: 'release',
  learn: 'learning',
};

export interface NextAction {
  capability: Capability | null;
  reason: string;
  blocked: boolean;
}

export function resolveNextAction(metadata: ChangeMetadata, scenario: ScenarioProfile): NextAction {
  if (metadata.status === 'ARCHIVED') {
    return { capability: null, reason: 'Change is archived.', blocked: false };
  }

  if (metadata.status === 'NEEDS_RECONCILE') {
    return {
      capability: 'reconcile',
      reason: 'A previous artifact or task was invalidated. Complete reconciliation before continuing.',
      blocked: true,
    };
  }

  for (const capability of scenario.stages) {
    const key = STAGE_READINESS[capability];
    if (!key) continue;
    const readiness = metadata.readiness[key];
    if (['MISSING', 'STALE', 'INVALIDATED', 'NEEDS_REVALIDATION', 'CONCERNS'].includes(readiness)) {
      return {
        capability,
        reason: reasonFor(capability, readiness),
        blocked: ['INVALIDATED', 'NEEDS_REVALIDATION'].includes(readiness),
      };
    }
  }

  if (scenario.stages.includes('archive') && metadata.status !== 'READY_TO_ARCHIVE') {
    return { capability: 'archive', reason: 'Required capabilities are ready; archive the verified change.', blocked: false };
  }
  return { capability: null, reason: 'No pending required capability.', blocked: false };
}

export function readinessTable(metadata: ChangeMetadata): Array<[string, ReadinessStatus]> {
  return Object.entries(metadata.readiness) as Array<[string, ReadinessStatus]>;
}

function reasonFor(capability: Capability, status: ReadinessStatus): string {
  if (status === 'MISSING') return `${capability} has not been completed.`;
  if (status === 'STALE') return `${capability} is stale after a change in upstream facts.`;
  if (status === 'INVALIDATED') return `${capability} is invalidated and must be regenerated.`;
  if (status === 'NEEDS_REVALIDATION') return `${capability} must be revalidated against the active revision.`;
  if (status === 'CONCERNS') return `${capability} has unresolved concerns.`;
  return `${capability} is in state ${status}.`;
}
