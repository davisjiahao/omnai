import { changeArtifactPath } from '../core/paths.js';
import { getScenario } from '../core/scenarios.js';
import { listChanges, type ChangeRef } from '../core/store.js';
import { loadTasks } from '../core/tasks.js';
import { RECONCILE_LEVELS } from '../domain/types.js';
import {
  calculateReadinessClosure,
  calculateTaskClosure,
  minimumReconcileLevel,
} from './reconcile-closure.js';
import {
  listWorksetReentries,
  loadWorksetReentry,
  projectReconcileApplicationSchema,
  projectReconcileProposalSchema,
  saveWorksetReentry,
  unresolvedCandidateProjects,
  type ProjectReconcileApplication,
  type ProjectReconcileProposal,
  type WorksetReentry,
} from './reentry.js';
import { resolveWorkset } from './worksets.js';
import type { Workset, WorksetMember } from './types.js';

const RECONCILE_RULES_VERSION = 1;

export interface WorksetReentryPlanResult {
  record: WorksetReentry;
  preview: ProjectReconcileApplication[];
}

export async function planWorksetReentry(
  home: string,
  worksetRef: string,
  reentryId: string,
  proposalInput: ProjectReconcileProposal[],
): Promise<WorksetReentryPlanResult> {
  const workset = await resolveWorkset(home, worksetRef);
  const record = await loadWorksetReentry(home, workset.id, reentryId);
  await assertPlannable(home, workset, record);

  const proposal = proposalInput.map((item) => projectReconcileProposalSchema.parse(item));
  validateProposalCoverage(record, proposal);
  const preview = await buildFrozenApplications(workset, record, proposal);

  const updated = {
    ...record,
    schemaVersion: 2 as const,
    proposal,
  };
  await saveWorksetReentry(home, updated);
  return { record: updated, preview };
}

export async function decideWorksetReentry(
  home: string,
  worksetRef: string,
  reentryId: string,
): Promise<WorksetReentry> {
  const workset = await resolveWorkset(home, worksetRef);
  const record = await loadWorksetReentry(home, workset.id, reentryId);
  await assertPlannable(home, workset, record);
  validateProposalCoverage(record, record.proposal);

  const applications = await buildFrozenApplications(workset, record, record.proposal);
  const decided = {
    ...record,
    schemaVersion: 2 as const,
    status: 'DECIDED' as const,
    rulesVersion: RECONCILE_RULES_VERSION,
    applications,
    decidedAt: new Date().toISOString(),
    resolvedAt: null,
  };
  await saveWorksetReentry(home, decided);
  return decided;
}

async function assertPlannable(home: string, workset: Workset, record: WorksetReentry): Promise<void> {
  if (record.status !== 'PENDING') {
    throw new Error(`Re-entry '${record.id}' must be PENDING before planning or deciding; current status is ${record.status}.`);
  }

  const records = await listWorksetReentries(home, workset.id);
  const oldestPending = records.find((item) => item.status === 'PENDING');
  if (oldestPending && oldestPending.id !== record.id) {
    throw new Error(`Re-entry '${record.id}' cannot be planned before older pending Re-entry '${oldestPending.id}'.`);
  }

  const unresolved = unresolvedCandidateProjects(workset.members, record.candidateProjects);
  if (unresolved.length > 0) {
    throw new Error(
      `Re-entry '${record.id}' cannot be planned while candidate project '${unresolved.join(', ')}' still requires an impact decision.`,
    );
  }
}

function validateProposalCoverage(record: WorksetReentry, proposals: ProjectReconcileProposal[]): void {
  const expected = new Set([...record.affectedProjects, ...record.candidateProjects]);
  const seen = new Set<string>();
  for (const proposal of proposals) {
    if (seen.has(proposal.project)) throw new Error(`Project '${proposal.project}' appears more than once in the Re-entry proposal.`);
    seen.add(proposal.project);
    if (!expected.has(proposal.project)) {
      throw new Error(`Project '${proposal.project}' is not part of Re-entry '${record.id}'.`);
    }
  }

  const missing = [...expected].filter((project) => !seen.has(project));
  if (missing.length > 0) {
    throw new Error(`Re-entry '${record.id}' proposal is missing project decision(s): ${missing.join(', ')}.`);
  }
}

async function buildFrozenApplications(
  workset: Workset,
  record: WorksetReentry,
  proposals: ProjectReconcileProposal[],
): Promise<ProjectReconcileApplication[]> {
  const applications: ProjectReconcileApplication[] = [];
  for (const proposal of proposals) {
    const member = requireMember(workset, proposal.project);
    if (proposal.outcome === 'NOT_REQUIRED') {
      applications.push(projectReconcileApplicationSchema.parse({
        project: proposal.project,
        changeId: member.changeId,
        status: 'NOT_REQUIRED',
      }));
      continue;
    }

    if (member.status !== 'ACTIVE' || !member.worktree || !member.changeId) {
      throw new Error(
        `Project '${proposal.project}' must be ACTIVE with a bound Project Change before a required Reconcile application can be frozen.`,
      );
    }

    const minimum = minimumReconcileLevel(record.kind);
    if (levelRank(proposal.level) < levelRank(minimum)) {
      throw new Error(
        `Re-entry '${record.id}' requires minimum Reconcile level ${minimum}; project '${proposal.project}' proposed ${proposal.level}.`,
      );
    }

    const change = await requireBoundChange(member);
    const scenario = getScenario(change.metadata.scenario);
    const readinessClosure = calculateReadinessClosure(scenario, proposal.reopenFrom);
    const tasks = await loadTasks(changeArtifactPath(member.worktree, change.directoryName, 'tasks.yaml'));
    const taskClosure = calculateTaskClosure(tasks, proposal.taskRoots);

    applications.push(projectReconcileApplicationSchema.parse({
      project: proposal.project,
      changeId: change.metadata.id,
      status: 'PENDING',
      level: proposal.level,
      reopenFrom: proposal.reopenFrom,
      readinessClosure,
      taskRoots: proposal.taskRoots,
      taskClosure,
      fromRevision: change.metadata.activeRevision,
      fromBaseline: change.metadata.baseline,
      toRevision: null,
      toBaseline: null,
      error: null,
      appliedAt: null,
    }));
  }
  return applications;
}

async function requireBoundChange(member: WorksetMember): Promise<ChangeRef> {
  if (!member.worktree || !member.changeId) throw new Error(`Project '${member.project}' has no bound Project Change in a Worktree.`);
  const changes = await listChanges(member.worktree);
  const change = changes.find((item) => item.metadata.id === member.changeId);
  if (!change) {
    throw new Error(`Bound Project Change '${member.changeId}' was not found in Worktree for '${member.project}'.`);
  }
  if (change.metadata.status === 'ARCHIVED') {
    throw new Error(`Bound Project Change '${member.changeId}' for '${member.project}' is archived.`);
  }
  return change;
}

function requireMember(workset: Workset, project: string): WorksetMember {
  const member = workset.members.find((item) => item.project === project);
  if (!member) throw new Error(`Project '${project}' is not a member of ${workset.id}.`);
  return member;
}

function levelRank(level: (typeof RECONCILE_LEVELS)[number]): number {
  return RECONCILE_LEVELS.indexOf(level);
}
