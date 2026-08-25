import { readdir } from 'node:fs/promises';
import { pathExists, readYaml, writeYaml } from '../core/files.js';
import { listChanges } from '../core/store.js';
import { createWorksetWorktree } from './git-worktrees.js';
import { requireRegisteredProject } from './project-registry.js';
import {
  worksetManifestPath,
  worksetsRoot,
} from './paths.js';
import {
  worksetSchema,
  type Workset,
  type WorksetMember,
} from './types.js';

export interface WorksetNextAction {
  action: string;
  project?: string;
  reason: string;
}

export async function createWorkset(_home: string, _title: string): Promise<Workset> {
  // 背景：final-v0.3 删除 PersonalConfig，但 legacy Workset writer 仍在模块加载时导入该符号，
  // 导致 package root/CLI 连 --version 都无法链接。目的：Plan 06 publication transaction 接入前
  // 明确 fail-closed；本计划只恢复模块可链接性，不伪造 v2 writer、兼容 config 或 partial state。
  throw new Error('NATIVE_WORKSET_PUBLICATION_UNAVAILABLE: Plan 06 Workset writer is not active');
}

export async function listWorksets(home: string): Promise<Workset[]> {
  const root = worksetsRoot(home);
  if (!(await pathExists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const worksets: Workset[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^WKS-\d{4}$/.test(entry.name)) continue;
    const path = worksetManifestPath(home, entry.name);
    if (!(await pathExists(path))) continue;
    worksets.push(await readYaml(path, worksetSchema));
  }
  return worksets.sort((left, right) => left.id.localeCompare(right.id));
}

export async function resolveWorkset(home: string, reference?: string): Promise<Workset> {
  const worksets = await listWorksets(home);
  if (reference) {
    const workset = worksets.find((item) => item.id === reference || item.slug === reference);
    if (!workset) throw new Error(`Workset '${reference}' was not found.`);
    return workset;
  }

  throw new Error(
    'NATIVE_WORKSET_PUBLICATION_UNAVAILABLE: implicit active Workset resolution requires the Plan 06 authority context',
  );
}

export async function saveWorkset(home: string, workset: Workset): Promise<void> {
  await writeYaml(worksetManifestPath(home, workset.id), worksetSchema.parse(workset));
}

export async function addWorksetCandidate(home: string, worksetRef: string, projectAlias: string): Promise<Workset> {
  await requireRegisteredProject(home, projectAlias);
  const workset = await resolveWorkset(home, worksetRef);
  const existing = workset.members.find((member) => member.project === projectAlias);
  if (existing) return workset;

  const now = new Date().toISOString();
  workset.members.push({ project: projectAlias, status: 'CANDIDATE', addedAt: now, updatedAt: now });
  workset.updatedAt = now;
  await saveWorkset(home, workset);
  return workset;
}

export async function beginProjectResearch(home: string, worksetRef: string, projectAlias: string): Promise<Workset> {
  return transitionMember(home, worksetRef, projectAlias, 'CANDIDATE', 'RESEARCH_ONLY');
}

export async function markProjectObservedOnly(home: string, worksetRef: string, projectAlias: string): Promise<Workset> {
  return transitionMember(home, worksetRef, projectAlias, 'RESEARCH_ONLY', 'OBSERVED_ONLY');
}

export async function activateWorksetProject(home: string, worksetRef: string, projectAlias: string): Promise<Workset> {
  const workset = await resolveWorkset(home, worksetRef);
  const member = requireMember(workset, projectAlias);
  if (member.status !== 'RESEARCH_ONLY') {
    throw new Error(`Project '${projectAlias}' must be RESEARCH_ONLY before activation.`);
  }
  if (!member.changeId) {
    throw new Error(`Project '${projectAlias}' must bind a Project Change before activation.`);
  }

  const project = await requireRegisteredProject(home, projectAlias);
  const created = await createWorksetWorktree(home, workset, project);
  const worktreeChanges = await listChanges(created.path);
  const boundChange = worktreeChanges.find((change) => change.metadata.id === member.changeId);
  if (!boundChange) {
    throw new Error(
      `Bound Project Change '${member.changeId}' is not present in the created Worktree for '${projectAlias}'. The original repository remains untouched; fix the committed Change state before retrying.`,
    );
  }
  if (boundChange.metadata.status === 'ARCHIVED') {
    throw new Error(`Bound Project Change '${member.changeId}' is archived in the created Worktree.`);
  }

  const now = new Date().toISOString();
  member.status = 'ACTIVE';
  member.worktree = created.path;
  member.branch = created.branch;
  member.updatedAt = now;
  workset.updatedAt = now;
  await saveWorkset(home, workset);
  return workset;
}

export async function markWorksetProjectInactive(home: string, worksetRef: string, projectAlias: string): Promise<Workset> {
  const workset = await resolveWorkset(home, worksetRef);
  const member = requireMember(workset, projectAlias);
  if (member.status !== 'ACTIVE') {
    throw new Error(`Project '${projectAlias}' must be ACTIVE before it can become INACTIVE.`);
  }

  const now = new Date().toISOString();
  member.status = 'INACTIVE';
  member.updatedAt = now;
  workset.updatedAt = now;
  await saveWorkset(home, workset);
  return workset;
}

export function worksetNext(workset: Workset): WorksetNextAction {
  const candidate = workset.members.find((member) => member.status === 'CANDIDATE');
  if (candidate) {
    return { action: 'inspect-project', project: candidate.project, reason: 'Candidate project requires read-only research before activation.' };
  }

  const researching = workset.members.find((member) => member.status === 'RESEARCH_ONLY');
  if (researching) {
    return { action: 'decide-project-impact', project: researching.project, reason: 'Read-only research must decide whether this project needs modification.' };
  }

  const active = workset.members.find((member) => member.status === 'ACTIVE');
  if (active) {
    return { action: 'project-workflow', project: active.project, reason: 'Active project is ready for its repository-local OmnAI workflow.' };
  }

  return { action: 'none', reason: 'No Workset membership action is currently required.' };
}

async function transitionMember(home: string, worksetRef: string, projectAlias: string, requiredStatus: WorksetMember['status'], targetStatus: WorksetMember['status']): Promise<Workset> {
  const workset = await resolveWorkset(home, worksetRef);
  const member = requireMember(workset, projectAlias);
  if (member.status !== requiredStatus) {
    throw new Error(`Project '${projectAlias}' must be ${requiredStatus} before transition to ${targetStatus}.`);
  }
  const now = new Date().toISOString();
  member.status = targetStatus;
  member.updatedAt = now;
  workset.updatedAt = now;
  await saveWorkset(home, workset);
  return workset;
}

function requireMember(workset: Workset, projectAlias: string): WorksetMember {
  const member = workset.members.find((item) => item.project === projectAlias);
  if (!member) throw new Error(`Project '${projectAlias}' is not a member of ${workset.id}.`);
  return member;
}
