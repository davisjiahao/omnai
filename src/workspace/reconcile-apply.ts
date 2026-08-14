import { reconcileChange } from '../core/reconcile.js';
import { resolveChange } from '../core/store.js';
import type { Revision } from '../domain/types.js';
import { findCorrelatedRevision } from './reconcile-lineage.js';
import {
  loadWorksetReentry,
  saveWorksetReentry,
  type ProjectReconcileApplication,
  type ProjectReconcileFailureKind,
  type WorksetReentry,
} from './reentry.js';
import { resolveWorkset } from './worksets.js';
import type { Workset } from './types.js';

export async function reentryApplicationStatus(
  home: string,
  worksetRef: string,
  reentryId: string,
): Promise<WorksetReentry> {
  return loadWorksetReentry(home, worksetRef, reentryId);
}

export async function applyWorksetReentry(
  home: string,
  worksetRef: string,
  reentryId: string,
  projectAlias?: string,
): Promise<WorksetReentry> {
  const workset = await resolveWorkset(home, worksetRef);
  let record = await loadWorksetReentry(home, workset.id, reentryId);
  if (record.schemaVersion !== 2) {
    throw new Error(`Re-entry '${record.id}' is a legacy coordination record and has no B2a application plan.`);
  }
  if (record.status === 'RESOLVED') return record;
  if (record.status !== 'DECIDED') {
    throw new Error(`Re-entry '${record.id}' must be DECIDED before project reconciliation can be applied.`);
  }

  const targets = projectAlias
    ? [requireApplication(record, projectAlias)]
    : record.applications.filter((application) => !['APPLIED', 'NOT_REQUIRED'].includes(application.status));

  for (const target of targets) {
    const current = requireApplication(record, target.project);
    if (['APPLIED', 'NOT_REQUIRED'].includes(current.status)) continue;
    await applyOne(home, workset, record, current);
    record = await loadWorksetReentry(home, workset.id, record.id);
  }

  return finalizeIfComplete(home, record);
}

async function applyOne(
  home: string,
  workset: Workset,
  record: WorksetReentry,
  application: ProjectReconcileApplication,
): Promise<void> {
  const member = workset.members.find((item) => item.project === application.project);
  if (!member || member.status !== 'ACTIVE' || !member.worktree || !member.changeId) {
    await failApplication(
      home,
      record,
      application,
      'MEMBER_NOT_WRITABLE',
      `Project '${application.project}' must remain ACTIVE with its bound Project Change before Reconcile apply.`,
    );
    return;
  }
  if (member.changeId !== application.changeId) {
    await failApplication(
      home,
      record,
      application,
      'BOUND_CHANGE_MISMATCH',
      `Project '${application.project}' is bound to '${member.changeId}', not frozen Change '${application.changeId}'.`,
    );
    return;
  }

  if (!application.changeId || !application.level || !application.fromRevision || !application.fromBaseline) {
    await failApplication(
      home,
      record,
      application,
      'MISSING_FROZEN_FIELDS',
      `Reconcile application '${application.project}' is missing frozen required fields.`,
    );
    return;
  }

  const change = await resolveChange(member.worktree, application.changeId);
  const correlationId = `${record.id}/${application.project}`;
  let correlated: Revision | null;
  try {
    correlated = await findCorrelatedRevision(member.worktree, change.directoryName, correlationId);
  } catch (error) {
    await failApplication(home, record, application, 'CORRELATION_CONFLICT', errorMessage(error));
    return;
  }
  if (correlated) {
    const recoveryError = validateCorrelatedRecovery(change.metadata.activeRevision, change.metadata.baseline, application, correlated);
    if (recoveryError) {
      await failApplication(home, record, application, 'CORRELATION_CONFLICT', recoveryError);
      return;
    }
    application.status = 'APPLIED';
    application.failureKind = null;
    application.toRevision = correlated.id;
    application.toBaseline = correlated.baseline ?? null;
    application.error = null;
    application.appliedAt = correlated.createdAt;
    await saveWorksetReentry(home, record);
    return;
  }

  if (
    change.metadata.activeRevision !== application.fromRevision
    || change.metadata.baseline !== application.fromBaseline
  ) {
    await failApplication(
      home,
      record,
      application,
      'STALE_PRECONDITION',
      `Frozen precondition for '${application.project}' expected ${application.fromRevision}/${application.fromBaseline}, but Project Change is ${change.metadata.activeRevision}/${change.metadata.baseline}.`,
    );
    return;
  }

  application.status = 'APPLYING';
  application.failureKind = null;
  application.error = null;
  await saveWorksetReentry(home, record);

  try {
    const result = await reconcileChange(member.worktree, change, {
      level: application.level,
      type: 'WORKSET_REENTRY',
      reason: record.reason,
      affectedReadiness: application.readinessClosure,
      affectedTasks: application.taskRoots,
      affectedTaskClosure: application.taskClosure,
      correlationId,
    });
    application.status = 'APPLIED';
    application.failureKind = null;
    application.toRevision = result.revision.id;
    application.toBaseline = result.revision.baseline ?? change.metadata.baseline;
    application.error = null;
    application.appliedAt = new Date().toISOString();
    await saveWorksetReentry(home, record);
  } catch (error) {
    await failApplication(home, record, application, 'APPLY_ERROR', errorMessage(error));
  }
}

async function finalizeIfComplete(home: string, record: WorksetReentry): Promise<WorksetReentry> {
  if (record.status === 'RESOLVED') return record;
  const complete = record.applications.every((application) => ['APPLIED', 'NOT_REQUIRED'].includes(application.status));
  if (!complete) return record;
  const resolved: WorksetReentry = {
    ...record,
    status: 'RESOLVED',
    resolvedAt: new Date().toISOString(),
  };
  await saveWorksetReentry(home, resolved);
  return resolved;
}

async function failApplication(
  home: string,
  record: WorksetReentry,
  application: ProjectReconcileApplication,
  failureKind: ProjectReconcileFailureKind,
  message: string,
): Promise<void> {
  application.status = 'FAILED';
  application.failureKind = failureKind;
  application.error = message;
  application.appliedAt = null;
  await saveWorksetReentry(home, record);
}

function requireApplication(record: WorksetReentry, projectAlias: string): ProjectReconcileApplication {
  const application = record.applications.find((item) => item.project === projectAlias);
  if (!application) throw new Error(`Project '${projectAlias}' has no application in Re-entry '${record.id}'.`);
  return application;
}

function validateCorrelatedRecovery(
  activeRevision: string,
  activeBaseline: string,
  application: ProjectReconcileApplication,
  revision: Revision,
): string | null {
  if (
    revision.previousRevision !== application.fromRevision
    || revision.previousBaseline !== application.fromBaseline
    || revision.level !== application.level
    || !sameSet(revision.affectedArtifacts, application.readinessClosure)
  ) {
    return `Correlation '${revision.correlationId}' exists but does not match the frozen Reconcile application.`;
  }
  if (activeRevision !== revision.id || activeBaseline !== revision.baseline) {
    return `Correlation '${revision.correlationId}' was applied at ${revision.id}/${revision.baseline ?? 'unknown'}, but the Project Change has since advanced to ${activeRevision}/${activeBaseline}.`;
  }
  return null;
}

function sameSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return left.every((item) => expected.has(item));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
