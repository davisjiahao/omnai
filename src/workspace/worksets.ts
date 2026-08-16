import { readdir } from 'node:fs/promises';
import { pathExists, readYaml, writeYaml } from '../core/files.js';
import { listChanges } from '../core/store.js';
import { ensureExecutionWorkspace } from './execution-workspace.js';
import { createWorksetWorktree } from './git-worktrees.js';
import { requireRegisteredProject } from './project-registry.js';
import {
  personalConfigPath,
  worksetManifestPath,
  worksetsRoot,
} from './paths.js';
import {
  personalConfigSchema,
  worksetSchema,
  type PersonalConfig,
  type Workset,
  type WorksetMember,
} from './types.js';

export interface WorksetNextAction {
  action: string;
  project?: string;
  reason: string;
}

export async function createWorkset(home: string, title: string): Promise<Workset> {
  const id = await nextWorksetId(home);
  const now = new Date().toISOString();
  const workset = worksetSchema.parse({
    schemaVersion: 1,
    id,
    slug: slugify(title),
    title,
    status: 'OPEN',
    members: [],
    createdAt: now,
    updatedAt: now,
  });
  await saveWorkset(home, workset);
  await ensureExecutionWorkspace(home, workset);
  await savePersonalConfig(home, { schemaVersion: 1, activeWorkset: id });
  return workset;
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

  const config = await loadPersonalConfig(home);
  if (!config.activeWorkset) throw new Error('No active Workset is selected.');
  const workset = worksets.find((item) => item.id === config.activeWorkset);
  if (!workset) throw new Error(`Active Workset '${config.activeWorkset}' was not found.`);
  return workset;
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

async function loadPersonalConfig(home: string): Promise<PersonalConfig> {
  const path = personalConfigPath(home);
  if (!(await pathExists(path))) return personalConfigSchema.parse({ schemaVersion: 1, activeWorkset: null });
  return readYaml(path, personalConfigSchema);
}

async function savePersonalConfig(home: string, config: PersonalConfig): Promise<void> {
  await writeYaml(personalConfigPath(home), personalConfigSchema.parse(config));
}

async function nextWorksetId(home: string): Promise<string> {
  const worksets = await listWorksets(home);
  const next = worksets.reduce((maximum, workset) => Math.max(maximum, Number(workset.id.slice(4))), 0) + 1;
  return `WKS-${String(next).padStart(4, '0')}`;
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('Workset title must contain at least one letter or number.');
  return slug;
}
