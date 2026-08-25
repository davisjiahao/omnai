import { readdir } from 'node:fs/promises';
import { pathExists, readYaml, writeYaml } from '../core/files.js';
import {
  REENTRY_KINDS,
  projectReconcileApplicationSchema,
  projectReconcileAttemptSchema,
  projectReconcileProposalSchema,
  worksetReentrySchema,
  type ProjectReconcileApplication,
  type ProjectReconcileAttempt,
  type ProjectReconcileProposal,
  type ReentryKindV2,
  type WorksetReentry,
} from '../domain/types.js';
import { requireRegisteredProject } from './project-registry.js';
import { worksetReentryPath, worksetReentriesRoot } from './paths.js';
import { worksetReentryInputSchema, type WorksetReentryInput } from './reentry-input.js';
import { addWorksetCandidate, resolveWorkset } from './worksets.js';

export const REENTRY_STATUSES = ['PENDING', 'DECIDED', 'RESOLVED'] as const;
export const REENTRY_APPLICATION_STATUSES = ['PENDING', 'APPLIED', 'FAILED', 'NOT_REQUIRED'] as const;
export const REENTRY_APPLICATION_FAILURE_KINDS = [
  'STALE_PRECONDITION',
  'MEMBER_NOT_WRITABLE',
  'BOUND_CHANGE_MISMATCH',
  'CORRELATION_CONFLICT',
  'APPLY_ERROR',
] as const;

export type ReentryKind = ReentryKindV2;
export type ProjectReconcileFailureKind = (typeof REENTRY_APPLICATION_FAILURE_KINDS)[number];
export type InteractionMode = 'grill' | 'brainstorm' | 'show-me';
export type ReentryCapability =
  | 'research'
  | 'frame'
  | 'model'
  | 'spec'
  | 'design'
  | 'experiment'
  | 'plan'
  | 'work';

export interface ReentryRoute {
  capability: ReentryCapability;
  interaction: InteractionMode;
  reason: string;
}

export {
  REENTRY_KINDS,
  projectReconcileApplicationSchema,
  projectReconcileAttemptSchema,
  projectReconcileProposalSchema,
  worksetReentrySchema,
};
export { worksetReentryInputSchema } from './reentry-input.js';
export type { WorksetReentryInput } from './reentry-input.js';
export type { ProjectReconcileApplication, ProjectReconcileAttempt, ProjectReconcileProposal, WorksetReentry };

const ROUTES: Record<ReentryKind, ReentryRoute> = {
  REALITY_CHANGED: {
    capability: 'research',
    interaction: 'show-me',
    reason: 'Current-system reality changed or is no longer trustworthy.',
  },
  PRODUCT_CHANGED: {
    capability: 'frame',
    interaction: 'grill',
    reason: 'Product goal or user outcome changed and requires a new decision.',
  },
  DOMAIN_CHANGED: {
    capability: 'model',
    interaction: 'grill',
    reason: 'Domain meaning, ownership, lifecycle, or invariant changed.',
  },
  SCOPE_CHANGED: {
    capability: 'spec',
    interaction: 'grill',
    reason: 'Scope, acceptance criteria, or non-goals changed.',
  },
  TECHNICAL_CONSTRAINT_CHANGED: {
    capability: 'design',
    interaction: 'brainstorm',
    reason: 'A technical constraint invalidated the selected implementation approach.',
  },
  NEEDS_EXPERIMENT: {
    capability: 'experiment',
    interaction: 'show-me',
    reason: 'The remaining implementation choice requires measured evidence.',
  },
  PLAN_CHANGED: {
    capability: 'plan',
    interaction: 'brainstorm',
    reason: 'Only task structure, dependency order, or delivery sequencing changed.',
  },
  IMPLEMENTATION_DETAIL_CHANGED: {
    capability: 'work',
    interaction: 'show-me',
    reason: 'The change is bounded to implementation detail and does not reopen upstream decisions.',
  },
};

export function parseReentryKind(value: string): ReentryKind {
  const kind = REENTRY_KINDS.find((candidate) => candidate === value);
  if (kind === undefined) throw new Error(`Unknown Re-entry kind '${value}'.`);
  return kind;
}

export function routeWorksetReentry(kind: ReentryKind): ReentryRoute {
  return ROUTES[kind];
}

export async function recordWorksetReentry(
  home: string,
  worksetRef: string,
  input: WorksetReentryInput,
): Promise<WorksetReentry> {
  const parsedInput = worksetReentryInputSchema.parse(input);
  const workset = await resolveWorkset(home, worksetRef);
  const { affectedProjects, candidateProjects } = parsedInput;

  for (const projectAlias of affectedProjects) {
    if (!workset.members.some((member) => member.projectAlias === projectAlias)) {
      throw new Error(`Project '${projectAlias}' is not a member of ${workset.id}.`);
    }
  }
  for (const projectAlias of candidateProjects) {
    await requireRegisteredProject(home, projectAlias);
  }

  for (const projectAlias of candidateProjects) {
    if (!workset.members.some((member) => member.projectAlias === projectAlias)) {
      await addWorksetCandidate(home, workset.id, projectAlias);
    }
  }

  const id = await nextReentryId(home, workset.id);
  const record = worksetReentrySchema.parse({
    schemaVersion: 2,
    id,
    worksetId: workset.id,
    kind: parsedInput.kind,
    reason: parsedInput.reason,
    route: routeWorksetReentry(parsedInput.kind),
    affectedProjects,
    candidateProjects,
    status: 'PENDING',
    proposal: [],
    applications: [],
    rulesVersion: null,
    createdAt: new Date().toISOString(),
    decidedAt: null,
    resolvedAt: null,
  });
  await saveWorksetReentry(home, record);
  return record;
}

export async function loadWorksetReentry(
  home: string,
  worksetRef: string,
  reentryId: string,
): Promise<WorksetReentry> {
  const workset = await resolveWorkset(home, worksetRef);
  const path = worksetReentryPath(home, workset.id, reentryId);
  if (!(await pathExists(path))) throw new Error(`Re-entry '${reentryId}' was not found in ${workset.id}.`);
  const record = await readYaml(path, worksetReentrySchema);
  if (record.worksetId !== workset.id) {
    throw new Error(`Re-entry '${record.id}' belongs to ${record.worksetId}, not ${workset.id}.`);
  }
  return record;
}

export async function saveWorksetReentry(home: string, record: WorksetReentry): Promise<void> {
  await writeYaml(worksetReentryPath(home, record.worksetId, record.id), worksetReentrySchema.parse(record));
}

export async function listWorksetReentries(home: string, worksetRef: string): Promise<WorksetReentry[]> {
  const workset = await resolveWorkset(home, worksetRef);
  const root = worksetReentriesRoot(home, workset.id);
  if (!(await pathExists(root))) return [];

  const entries = await readdir(root, { withFileTypes: true });
  const records: WorksetReentry[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^WRE-\d{4}\.yaml$/.test(entry.name)) continue;
    const id = entry.name.slice(0, -5);
    records.push(await loadWorksetReentry(home, workset.id, id));
  }
  return records.sort((left, right) => left.id.localeCompare(right.id));
}

export async function pendingWorksetReentry(home: string, worksetRef: string): Promise<WorksetReentry | null> {
  const records = await listWorksetReentries(home, worksetRef);
  return records.find((record) => record.status === 'PENDING') ?? null;
}

export async function resolveWorksetReentry(
  home: string,
  worksetRef: string,
  reentryId: string,
): Promise<WorksetReentry> {
  const workset = await resolveWorkset(home, worksetRef);
  const records = await listWorksetReentries(home, workset.id);
  const record = records.find((item) => item.id === reentryId);
  if (!record) throw new Error(`Re-entry '${reentryId}' was not found in ${workset.id}.`);
  if (record.status === 'RESOLVED') return record;

  throw new Error(
    `Re-entry '${reentryId}' uses the final v2 lifecycle and cannot be resolved directly. Decide and apply every exact Project reconciliation.`,
  );
}

export function unresolvedCandidateProjects(
  members: Array<{ projectAlias: string; status: string }>,
  candidateProjects: string[],
): string[] {
  return candidateProjects.filter((projectAlias) => {
    const member = members.find((item) => item.projectAlias === projectAlias);
    return !member || member.status === 'CANDIDATE' || member.status === 'RESEARCH_ONLY';
  });
}

async function nextReentryId(home: string, worksetId: string): Promise<string> {
  const records = await listWorksetReentries(home, worksetId);
  const next = records.reduce((maximum, record) => Math.max(maximum, Number(record.id.slice(4))), 0) + 1;
  return `WRE-${String(next).padStart(4, '0')}`;
}
