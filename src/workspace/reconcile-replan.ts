import { changeArtifactPath } from '../core/paths.js';
import { getScenario } from '../core/scenarios.js';
import { resolveChange } from '../core/store.js';
import { loadTasks } from '../core/tasks.js';
import type { ReconcileLevel } from '../domain/types.js';
import {
  calculateReadinessClosure,
  calculateTaskClosure,
  type ReadinessKey,
} from './reconcile-closure.js';
import { findCorrelatedRevision } from './reconcile-lineage.js';
import {
  loadWorksetReentry,
  projectReconcileAttemptSchema,
  saveWorksetReentry,
  type ProjectReconcileApplication,
  type WorksetReentry,
} from './reentry.js';
import { resolveWorkset } from './worksets.js';

export interface FailedApplicationReplanPreview {
  worksetId: string;
  reentryId: string;
  project: string;
  changeId: string;
  level: ReconcileLevel;
  reopenFrom: ReadinessKey;
  taskRoots: string[];
  readinessClosure: ReadinessKey[];
  taskClosure: string[];
  fromRevision: string;
  fromBaseline: string;
}

export async function previewFailedWorksetReentryApplicationReplan(
  home: string,
  worksetRef: string,
  reentryId: string,
  projectAlias: string,
): Promise<FailedApplicationReplanPreview> {
  const workset = await resolveWorkset(home, worksetRef);
  const record = await loadWorksetReentry(home, workset.id, reentryId);
  if (record.schemaVersion !== 2) {
    throw new Error(`Re-entry '${record.id}' is a legacy coordination record and cannot use B2a application replan.`);
  }
  if (record.status !== 'DECIDED') {
    throw new Error(`Re-entry '${record.id}' must be DECIDED before a failed application can be replanned.`);
  }

  const application = requireApplication(record.applications, projectAlias, record.id);
  assertStalePreconditionFailure(application, projectAlias);

  if (!application.changeId || !application.level || !application.reopenFrom || !application.fromRevision || !application.fromBaseline) {
    throw new Error(`Project '${projectAlias}' failed application is missing frozen fields required for replan.`);
  }

  const member = workset.members.find((item) => item.project === projectAlias);
  if (!member || member.status !== 'ACTIVE' || !member.worktree || !member.changeId) {
    throw new Error(`Project '${projectAlias}' must remain ACTIVE with its bound Project Change before replan.`);
  }
  if (member.changeId !== application.changeId) {
    throw new Error(
      `Project '${projectAlias}' is bound to '${member.changeId}', not failed frozen Change '${application.changeId}'.`,
    );
  }

  const change = await resolveChange(member.worktree, application.changeId);
  const correlationId = `${record.id}/${projectAlias}`;
  const correlated = await findCorrelatedRevision(member.worktree, change.directoryName, correlationId);
  if (correlated) {
    throw new Error(
      `Project '${projectAlias}' cannot be replanned because correlation '${correlationId}' already exists in repository Reconcile lineage at ${correlated.id}. Retry idempotent apply recovery or inspect the repository state instead.`,
    );
  }

  const scenario = getScenario(change.metadata.scenario);
  const readinessClosure = calculateReadinessClosure(scenario, application.reopenFrom);
  const tasks = await loadTasks(changeArtifactPath(member.worktree, change.directoryName, 'tasks.yaml'));
  const taskClosure = calculateTaskClosure(tasks, application.taskRoots);

  return {
    worksetId: workset.id,
    reentryId: record.id,
    project: projectAlias,
    changeId: application.changeId,
    level: application.level,
    reopenFrom: application.reopenFrom,
    taskRoots: [...application.taskRoots],
    readinessClosure,
    taskClosure,
    fromRevision: change.metadata.activeRevision,
    fromBaseline: change.metadata.baseline,
  };
}

export async function confirmFailedWorksetReentryApplicationReplan(
  home: string,
  worksetRef: string,
  reentryId: string,
  projectAlias: string,
): Promise<WorksetReentry> {
  const preview = await previewFailedWorksetReentryApplicationReplan(home, worksetRef, reentryId, projectAlias);
  const record = await loadWorksetReentry(home, preview.worksetId, preview.reentryId);
  if (record.status !== 'DECIDED') {
    throw new Error(`Re-entry '${record.id}' changed status during replan confirmation; retry from a fresh preview.`);
  }

  const application = requireApplication(record.applications, projectAlias, record.id);
  assertStalePreconditionFailure(application, projectAlias);
  if (!application.level || !application.reopenFrom || !application.fromRevision || !application.fromBaseline) {
    throw new Error(`Project '${projectAlias}' failed application is missing frozen fields required for replan history.`);
  }
  if (
    application.changeId !== preview.changeId
    || application.level !== preview.level
    || application.reopenFrom !== preview.reopenFrom
    || !sameArray(application.taskRoots, preview.taskRoots)
  ) {
    throw new Error(`Project '${projectAlias}' failed application changed during replan confirmation; retry from a fresh preview.`);
  }

  const replannedAt = new Date().toISOString();
  const attempt = projectReconcileAttemptSchema.parse({
    status: 'FAILED',
    failureKind: application.failureKind,
    level: application.level,
    reopenFrom: application.reopenFrom,
    readinessClosure: application.readinessClosure,
    taskRoots: application.taskRoots,
    taskClosure: application.taskClosure,
    fromRevision: application.fromRevision,
    fromBaseline: application.fromBaseline,
    toRevision: application.toRevision,
    toBaseline: application.toBaseline,
    error: application.error,
    appliedAt: application.appliedAt,
    replannedAt,
  });

  application.attemptHistory.push(attempt);
  application.status = 'PENDING';
  application.failureKind = null;
  application.level = preview.level;
  application.reopenFrom = preview.reopenFrom;
  application.readinessClosure = [...preview.readinessClosure];
  application.taskRoots = [...preview.taskRoots];
  application.taskClosure = [...preview.taskClosure];
  application.fromRevision = preview.fromRevision;
  application.fromBaseline = preview.fromBaseline;
  application.toRevision = null;
  application.toBaseline = null;
  application.error = null;
  application.appliedAt = null;

  await saveWorksetReentry(home, record);
  return record;
}

function assertStalePreconditionFailure(
  application: ProjectReconcileApplication,
  projectAlias: string,
): void {
  if (application.status !== 'FAILED') {
    throw new Error(`Project '${projectAlias}' application must be FAILED before replan; current status is ${application.status}.`);
  }
  if (application.failureKind !== 'STALE_PRECONDITION') {
    throw new Error(
      `Project '${projectAlias}' application must have failureKind STALE_PRECONDITION before replan; current failureKind is ${application.failureKind ?? 'none'}.`,
    );
  }
}

function requireApplication(
  applications: ProjectReconcileApplication[],
  projectAlias: string,
  reentryId: string,
): ProjectReconcileApplication {
  const application = applications.find((item) => item.project === projectAlias);
  if (!application) {
    throw new Error(`Project '${projectAlias}' has no application in Re-entry '${reentryId}'.`);
  }
  return application;
}

function sameArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
