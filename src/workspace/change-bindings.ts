import { execFileSync } from 'node:child_process';
import { getScenario } from '../core/scenarios.js';
import { createChange, listChanges, type ChangeRef } from '../core/store.js';
import { createWorksetWorktree } from './git-worktrees.js';
import { requireRegisteredProject } from './project-registry.js';
import { resolveWorkset, saveWorkset } from './worksets.js';
import type { Workset, WorksetMember } from './types.js';

export interface ProjectChangeCandidate {
  id: string;
  title: string;
  scenario: string;
  status: string;
  activeRevision: string;
  baseline: string;
  committedAtHead: boolean;
}

export async function listProjectChangeCandidates(
  home: string,
  worksetRef: string,
  projectAlias: string,
): Promise<ProjectChangeCandidate[]> {
  const workset = await resolveWorkset(home, worksetRef);
  const member = requireWorksetMember(workset, projectAlias);
  const registered = await requireRegisteredProject(home, projectAlias);
  const repoRoot = member.worktree ?? registered.path;
  const changes = await listChanges(repoRoot);
  return changes.map((change) => toCandidate(repoRoot, change));
}

export async function bindWorksetProjectChange(
  home: string,
  worksetRef: string,
  projectAlias: string,
  changeId: string,
): Promise<Workset> {
  const workset = await resolveWorkset(home, worksetRef);
  const member = requireWorksetMember(workset, projectAlias);
  if (!['RESEARCH_ONLY', 'ACTIVE', 'INACTIVE'].includes(member.status)) {
    throw new Error(`Project '${projectAlias}' must complete read-only research before binding a Project Change.`);
  }
  if (member.changeId) {
    if (member.changeId === changeId) return workset;
    throw new Error(`Project '${projectAlias}' is already bound to Project Change '${member.changeId}'.`);
  }

  const registered = await requireRegisteredProject(home, projectAlias);
  const repoRoot = member.worktree ?? registered.path;
  const change = await requireBindableChange(repoRoot, changeId);
  if (!member.worktree && !changeExistsAtHead(repoRoot, change)) {
    throw new Error(
      `Project Change '${changeId}' is not present in committed HEAD. Commit the Project Change before binding it to a HEAD-based Worktree, or create a new Workset Project Change explicitly.`,
    );
  }

  member.changeId = change.metadata.id;
  member.updatedAt = new Date().toISOString();
  workset.updatedAt = member.updatedAt;
  await saveWorkset(home, workset);
  return workset;
}

export async function createAndActivateWorksetProjectChange(
  home: string,
  worksetRef: string,
  projectAlias: string,
  title: string,
  scenario: string,
): Promise<{ workset: Workset; change: ChangeRef }> {
  const workset = await resolveWorkset(home, worksetRef);
  const member = requireWorksetMember(workset, projectAlias);
  const canonicalScenario = getScenario(scenario).id;

  if (member.status === 'ACTIVE' && member.changeId && member.worktree) {
    const bound = (await listChanges(member.worktree)).find((change) => change.metadata.id === member.changeId);
    if (
      bound
      && bound.metadata.status !== 'ARCHIVED'
      && bound.metadata.title === title
      && bound.metadata.scenario === canonicalScenario
    ) {
      return { workset, change: bound };
    }
    throw new Error(`Project '${projectAlias}' is already ACTIVE and bound to Project Change '${member.changeId}'.`);
  }

  if (member.status !== 'RESEARCH_ONLY') {
    throw new Error(`Project '${projectAlias}' must be RESEARCH_ONLY before creating a Project Change for this Workset.`);
  }
  if (member.changeId) {
    throw new Error(`Project '${projectAlias}' is already bound to Project Change '${member.changeId}'.`);
  }

  const registered = await requireRegisteredProject(home, projectAlias);
  const createdWorktree = await createWorksetWorktree(home, workset, registered);
  const recoveryCandidates = (await listChanges(createdWorktree.path)).filter((change) =>
    !changeExistsAtHead(createdWorktree.path, change)
    && change.metadata.status !== 'ARCHIVED'
    && change.metadata.title === title
    && change.metadata.scenario === canonicalScenario,
  );
  if (recoveryCandidates.length > 1) {
    throw new Error(
      `Multiple matching uncommitted Project Changes exist in the retained Worktree for '${projectAlias}'. Recovery is ambiguous; inspect the Worktree before retrying.`,
    );
  }
  const change = recoveryCandidates[0] ?? await createChange(createdWorktree.path, title, canonicalScenario);

  const now = new Date().toISOString();
  member.changeId = change.metadata.id;
  member.status = 'ACTIVE';
  member.worktree = createdWorktree.path;
  member.branch = createdWorktree.branch;
  member.updatedAt = now;
  workset.updatedAt = now;
  await saveWorkset(home, workset);
  return { workset, change };
}

function requireWorksetMember(workset: Workset, projectAlias: string): WorksetMember {
  const member = workset.members.find((item) => item.project === projectAlias);
  if (!member) throw new Error(`Project '${projectAlias}' is not a member of ${workset.id}.`);
  return member;
}

async function requireBindableChange(repoRoot: string, changeId: string): Promise<ChangeRef> {
  const changes = await listChanges(repoRoot);
  const change = changes.find((item) => item.metadata.id === changeId);
  if (!change) throw new Error(`Project Change '${changeId}' was not found.`);
  if (change.metadata.status === 'ARCHIVED') {
    throw new Error(`Project Change '${changeId}' is archived and cannot be bound.`);
  }
  return change;
}

function toCandidate(repoRoot: string, change: ChangeRef): ProjectChangeCandidate {
  return {
    id: change.metadata.id,
    title: change.metadata.title,
    scenario: change.metadata.scenario,
    status: change.metadata.status,
    activeRevision: change.metadata.activeRevision,
    baseline: change.metadata.baseline,
    committedAtHead: changeExistsAtHead(repoRoot, change),
  };
}

function changeExistsAtHead(repoRoot: string, change: ChangeRef): boolean {
  const gitPath = `.omnai/changes/${change.directoryName}/change.yaml`;
  try {
    execFileSync('git', ['cat-file', '-e', `HEAD:${gitPath}`], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}
