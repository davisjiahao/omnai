import {
  ProtocolError,
  repositoryProtocolId,
  type ProtocolId,
} from '../protocols/index.js';
import type { InteractionMode, ReentryCapability } from './reentry.js';
import type { WorksetRouteAction } from './workset-router.js';

export type WorksetRouteName = WorksetRouteAction['action'];

export function protocolIdsForWorksetRoute(
  action: WorksetRouteName,
  capability?: ReentryCapability,
  interaction?: InteractionMode,
): ProtocolId[] {
  switch (action) {
    case 'inspect-project':
      return ['workset.candidate-research'];
    case 'decide-project-impact':
      return ['workset.project-impact-decision'];
    case 'reenter': {
      if (!capability || !interaction) {
        throw new ProtocolError(
          'PROTOCOL_MAPPING_MISSING',
          `Workset route '${action}' requires both capability and interaction.`,
        );
      }
      const protocols: ProtocolId[] = ['workset.reentry-interaction'];
      if (interaction === 'grill') protocols.push('interaction.grill');
      if (interaction === 'brainstorm') protocols.push('interaction.brainstorm');
      protocols.push(repositoryProtocolId(capability));
      protocols.push('workset.reentry-plan');
      return protocols;
    }
    case 'decide-reentry':
      return ['workset.reentry-decision'];
    case 'apply-reentry':
      return ['workset.reentry-apply'];
    case 'replan-reentry':
      return ['workset.reentry-replan'];
    case 'finalize-reentry':
      return ['workset.reentry-finalize'];
    case 'project-workflow':
      return ['workset.project-workflow-handoff'];
    case 'none':
      return [];
  }
}
