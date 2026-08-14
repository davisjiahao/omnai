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
  type ProjectReconcileApplication,
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
  if (application.status !== 'FAILED') {
    throw new Error(`Project '${projectAlias}' application must be FAILED before replan; current status is ${application.status}.`);
  }
  if (application.failureKind !== 'STALE_PRECONDITION') {
    throw new Error(
      `Project '${projectAlias}' application must have failureKind STALE_PRECONDITION before replan; current failureKind is ${application.failureKind ?? 'none'}.`,
    );
  }
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
