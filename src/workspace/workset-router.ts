import {
  pendingWorksetReentry,
  type InteractionMode,
  type ReentryCapability,
} from './reentry.js';
import { resolveWorkset, worksetNext } from './worksets.js';

export type WorksetRouteAction =
  | { action: 'inspect-project'; project: string; reason: string }
  | { action: 'decide-project-impact'; project: string; reason: string }
  | {
      action: 'reenter';
      reentryId: string;
      capability: ReentryCapability;
      interaction: InteractionMode;
      affectedProjects: string[];
      reason: string;
    }
  | { action: 'project-workflow'; project: string; reason: string }
  | { action: 'none'; reason: string };

export async function resolveWorksetNext(home: string, worksetRef?: string): Promise<WorksetRouteAction> {
  const workset = await resolveWorkset(home, worksetRef);
  const membership = worksetNext(workset);

  if (membership.action === 'inspect-project' && membership.project) {
    return {
      action: 'inspect-project',
      project: membership.project,
      reason: membership.reason,
    };
  }

  if (membership.action === 'decide-project-impact' && membership.project) {
    return {
      action: 'decide-project-impact',
      project: membership.project,
      reason: membership.reason,
    };
  }

  const pending = await pendingWorksetReentry(home, workset.id);
  if (pending) {
    return {
      action: 'reenter',
      reentryId: pending.id,
      capability: pending.route.capability,
      interaction: pending.route.interaction,
      affectedProjects: pending.affectedProjects,
      reason: pending.route.reason,
    };
  }

  if (membership.action === 'project-workflow' && membership.project) {
    return {
      action: 'project-workflow',
      project: membership.project,
      reason: membership.reason,
    };
  }

  return {
    action: 'none',
    reason: membership.reason,
  };
}
