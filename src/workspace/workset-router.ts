import {
  listWorksetReentries,
  type InteractionMode,
  type ReentryCapability,
  type WorksetReentry,
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
  | { action: 'decide-reentry'; reentryId: string; reason: string }
  | {
      action: 'apply-reentry';
      reentryId: string;
      project: string;
      applicationStatus: 'PENDING' | 'APPLYING' | 'FAILED';
      reason: string;
    }
  | { action: 'finalize-reentry'; reentryId: string; reason: string }
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

  const records = await listWorksetReentries(home, workset.id);
  const pending = records.find((record) => record.status === 'PENDING');
  if (pending) {
    if (pending.proposal.length === 0) {
      return {
        action: 'reenter',
        reentryId: pending.id,
        capability: pending.route.capability,
        interaction: pending.route.interaction,
        affectedProjects: pending.affectedProjects,
        reason: pending.route.reason,
      };
    }

    const olderDecided = records.find((record) =>
      record.status === 'DECIDED' && record.id.localeCompare(pending.id) < 0,
    );
    if (olderDecided) return routeDecided(olderDecided);

    return {
      action: 'decide-reentry',
      reentryId: pending.id,
      reason: `Re-entry ${pending.id} has a calculated Project Reconcile proposal ready for explicit decision.`,
    };
  }

  const decided = records.find((record) => record.status === 'DECIDED');
  if (decided) return routeDecided(decided);

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

function routeDecided(record: WorksetReentry): WorksetRouteAction {
  const application = record.applications.find((item) => ['PENDING', 'APPLYING', 'FAILED'].includes(item.status));
  if (application && ['PENDING', 'APPLYING', 'FAILED'].includes(application.status)) {
    return {
      action: 'apply-reentry',
      reentryId: record.id,
      project: application.project,
      applicationStatus: application.status as 'PENDING' | 'APPLYING' | 'FAILED',
      reason: `Approved Re-entry ${record.id} has a ${application.status} project reconciliation for ${application.project}.`,
    };
  }
  return {
    action: 'finalize-reentry',
    reentryId: record.id,
    reason: `Approved Re-entry ${record.id} has all project applications complete and must be finalized.`,
  };
}
