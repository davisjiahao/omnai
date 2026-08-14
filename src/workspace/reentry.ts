import { readdir } from 'node:fs/promises';
import { z } from 'zod';
import { pathExists, readYaml, writeYaml } from '../core/files.js';
import { requireRegisteredProject } from './project-registry.js';
import { worksetReentryPath, worksetReentriesRoot } from './paths.js';
import { addWorksetCandidate, resolveWorkset } from './worksets.js';

export const REENTRY_KINDS = [
  'REALITY_CHANGED',
  'PRODUCT_CHANGED',
  'DOMAIN_CHANGED',
  'SCOPE_CHANGED',
  'TECHNICAL_CONSTRAINT_CHANGED',
  'NEEDS_EXPERIMENT',
  'PLAN_CHANGED',
  'IMPLEMENTATION_DETAIL_CHANGED',
] as const;

export type ReentryKind = (typeof REENTRY_KINDS)[number];
export type InteractionMode = 'none' | 'grill' | 'brainstorm';
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

const routeSchema = z.object({
  capability: z.enum(['research', 'frame', 'model', 'spec', 'design', 'experiment', 'plan', 'work']),
  interaction: z.enum(['none', 'grill', 'brainstorm']),
  reason: z.string().min(1),
});

export const worksetReentrySchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^WRE-\d{4}$/),
  worksetId: z.string().regex(/^WKS-\d{4}$/),
  kind: z.enum(REENTRY_KINDS),
  reason: z.string().min(1),
  route: routeSchema,
  affectedProjects: z.array(z.string().min(1)).default([]),
  candidateProjects: z.array(z.string().min(1)).default([]),
  status: z.enum(['PENDING', 'RESOLVED']),
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
});

export type WorksetReentry = z.infer<typeof worksetReentrySchema>;

export interface WorksetReentryInput {
  kind: ReentryKind;
  reason: string;
  affectedProjects?: string[];
  candidateProjects?: string[];
}

const ROUTES: Record<ReentryKind, ReentryRoute> = {
  REALITY_CHANGED: {
    capability: 'research',
    interaction: 'none',
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
    interaction: 'none',
    reason: 'The remaining implementation choice requires measured evidence.',
  },
  PLAN_CHANGED: {
    capability: 'plan',
    interaction: 'none',
    reason: 'Only task structure, dependency order, or delivery sequencing changed.',
  },
  IMPLEMENTATION_DETAIL_CHANGED: {
    capability: 'work',
    interaction: 'none',
    reason: 'The change is bounded to implementation detail and does not reopen upstream decisions.',
  },
};

export function routeWorksetReentry(kind: ReentryKind): ReentryRoute {
  return ROUTES[kind];
}

export async function recordWorksetReentry(
  home: string,
  worksetRef: string,
  input: WorksetReentryInput,
): Promise<WorksetReentry> {
  const workset = await resolveWorkset(home, worksetRef);
  const affectedProjects = unique(input.affectedProjects ?? []);
  const candidateProjects = unique(input.candidateProjects ?? []);

  for (const projectAlias of affectedProjects) {
    if (!workset.members.some((member) => member.project === projectAlias)) {
      throw new Error(`Project '${projectAlias}' is not a member of ${workset.id}.`);
    }
  }
  for (const projectAlias of candidateProjects) {
    await requireRegisteredProject(home, projectAlias);
  }

  for (const projectAlias of candidateProjects) {
    if (!workset.members.some((member) => member.project === projectAlias)) {
      await addWorksetCandidate(home, workset.id, projectAlias);
    }
  }

  const id = await nextReentryId(home, workset.id);
  const record = worksetReentrySchema.parse({
    schemaVersion: 1,
    id,
    worksetId: workset.id,
    kind: input.kind,
    reason: input.reason,
    route: routeWorksetReentry(input.kind),
    affectedProjects,
    candidateProjects,
    status: 'PENDING',
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  });
  await writeYaml(worksetReentryPath(home, workset.id, id), record);
  return record;
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
    const record = await readYaml(worksetReentryPath(home, workset.id, id), worksetReentrySchema);
    if (record.worksetId !== workset.id) {
      throw new Error(`Re-entry '${record.id}' belongs to ${record.worksetId}, not ${workset.id}.`);
    }
    records.push(record);
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

  const resolved = worksetReentrySchema.parse({
    ...record,
    status: 'RESOLVED',
    resolvedAt: new Date().toISOString(),
  });
  await writeYaml(worksetReentryPath(home, workset.id, reentryId), resolved);
  return resolved;
}

async function nextReentryId(home: string, worksetId: string): Promise<string> {
  const records = await listWorksetReentries(home, worksetId);
  const next = records.reduce((maximum, record) => Math.max(maximum, Number(record.id.slice(4))), 0) + 1;
  return `WRE-${String(next).padStart(4, '0')}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
