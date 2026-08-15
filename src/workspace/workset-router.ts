import type { ProtocolId } from '../protocols/index.js';
import {
  listWorksetReentries,
  type InteractionMode,
  type ReentryCapability,
  type WorksetReentry,
} from './reentry.js';
import { protocolIdsForWorksetRoute } from './workset-protocols.js';
import { resolveWorkset, worksetNext } from './worksets.js';

export type WorksetRouteAction = (
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
  | { action: 'replan-reentry'; reentryId: string; project: string; reason: string }
  | { action: 'finalize-reentry'; reentryId: string; reason: string }
  | { action: 'project-workflow'; project: string; reason: string }
  | { action: 'none'; reason: string }
) & { protocolIds: ProtocolId[] };

export async function resolveWorksetNext(home: string, worksetRef?: string): Promise<WorksetRouteAction> {
  const workset = await resolveWorkset(home, worksetRef);
  const membership = worksetNext(workset);

  if (membership.action === 'inspect-project' && membership.project) {
    return {
      action: 'inspect-project',
      project: membership.project,
      reason: membership.reason,
      protocolIds: protocolIdsForWorksetRoute('inspect-project'),
    };
  }

  if (membership.action === 'decide-project-impact' && membership.project) {
    return {
      action: 'decide-project-impact',
      project: membership.project,
      reason: membership.reason,
      protocolIds: protocolIdsForWorksetRoute('decide-project-impact'),
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
        protocolIds: protocolIdsForWorksetRoute(
          'reenter',
          pending.route.capability,
          pending.route.interaction,
        ),
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
      protocolIds: protocolIdsForWorksetRoute('decide-reentry'),
    };
  }

  const decided = records.find((record) => record.status === 'DECIDED');
  if (decided) return routeDecided(decided);

  if (membership.action === 'project-workflow' && membership.project) {
    return {
      action: 'project-workflow',
      project: membership.project,
      reason: membership.reason,
      protocolIds: protocolIdsForWorksetRoute('project-workflow'),
    };
  }

  return {
    action: 'none',
    reason: membership.reason,
    protocolIds: protocolIdsForWorksetRoute('none'),
  };
}

function routeDecided(record: WorksetReentry): WorksetRouteAction {
  const application = record.applications.find((item) => ['PENDING', 'APPLYING', 'FAILED'].includes(item.status));
  if (application?.status === 'FAILED' && application.failureKind === 'STALE_PRECONDITION') {
    return {
      action: 'replan-reentry',
      reentryId: record.id,
      project: application.project,
      reason: `Approved Re-entry ${record.id} has a stale frozen precondition for ${application.project} and requires explicit replan.`,
      protocolIds: protocolIdsForWorksetRoute('replan-reentry'),
    };
  }
  if (application && ['PENDING', 'APPLYING', 'FAILED'].includes(application.status)) {
    return {
      action: 'apply-reentry',
      reentryId: record.id,
      project: application.project,
      applicationStatus: application.status as 'PENDING' | 'APPLYING' | 'FAILED',
      reason: `Approved Re-entry ${record.id} has a ${application.status} project reconciliation for ${application.project}.`,
      protocolIds: protocolIdsForWorksetRoute('apply-reentry'),
    };
  }
  return {
    action: 'finalize-reentry',
    reentryId: record.id,
    reason: `Approved Re-entry ${record.id} has all project applications complete and must be finalized.`,
    protocolIds: protocolIdsForWorksetRoute('finalize-reentry'),
  };
}
