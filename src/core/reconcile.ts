import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  readinessSchema, reconcileSignalSchema, revisionSchema,
  type ChangeMetadata, type ReconcileLevel, type ReconcileSignal, type Revision,
} from '../domain/types.js';
import { appendJsonLine, writeYaml } from './files.js';
import { changeArtifactPath, changeRevisionsRoot } from './paths.js';
import type { ChangeRef } from './store.js';
import { saveChange } from './store.js';
import {
  dependentTaskIds,
  invalidateExactTasks,
  invalidateTasks,
  loadTasks,
  saveTasks,
} from './tasks.js';

const IMPACTS: Record<ReconcileLevel, Array<keyof ChangeMetadata['readiness']>> = {
  L0: ['implementation', 'review', 'verification', 'qa', 'release', 'canary', 'learning'],
  L1: ['plan', 'implementation', 'review', 'verification', 'qa', 'release', 'canary', 'learning'],
  L2: ['design', 'experiment', 'fix', 'plan', 'implementation', 'review', 'verification', 'qa', 'release', 'canary', 'learning'],
  L3: ['domain', 'spec', 'design', 'experiment', 'fix', 'plan', 'implementation', 'review', 'verification', 'qa', 'release', 'canary', 'learning'],
  L4: ['frame', 'map', 'research', 'mitigation', 'triage', 'reproduction', 'diagnosis', 'domain', 'spec', 'design', 'experiment', 'fix', 'plan', 'implementation', 'review', 'verification', 'qa', 'release', 'canary', 'learning'],
  L5: ['review', 'verification', 'qa', 'release', 'canary'],
};

export interface ReconcileInput {
  level: ReconcileLevel;
  type: string;
  reason: string;
  affectedTasks?: string[];
  affectedTaskClosure?: string[];
  affectedReadiness?: Array<keyof ChangeMetadata['readiness']>;
  evidence?: string[];
  correlationId?: string;
}

export interface ReconcileResult {
  signal: ReconcileSignal;
  revision: Revision;
  affectedReadiness: Array<keyof ChangeMetadata['readiness']>;
  affectedTasks: string[];
}

export async function reconcileChange(repoRoot: string, change: ChangeRef, input: ReconcileInput): Promise<ReconcileResult> {
  const now = new Date().toISOString();
  const affectedReadiness = normalizeAffectedReadiness(input.affectedReadiness ?? IMPACTS[input.level]);
  const tasksPath = changeArtifactPath(repoRoot, change.directoryName, 'tasks.yaml');
  const taskFile = await loadTasks(tasksPath);
  const requestedTasks = input.affectedTasks ?? [];
  const severeTaskInvalidation = ['L2', 'L3', 'L4'].includes(input.level);
  let affectedTasks: string[] = [];

  if (input.affectedTaskClosure !== undefined) {
    affectedTasks = unique(input.affectedTaskClosure);
    invalidateExactTasks(taskFile, affectedTasks, severeTaskInvalidation);
    if (affectedTasks.length > 0) await saveTasks(tasksPath, taskFile);
  } else if (requestedTasks.length > 0) {
    const knownTaskIds = new Set(taskFile.tasks.map((task) => task.id));
    affectedTasks = dependentTaskIds(taskFile, requestedTasks).filter((taskId) => knownTaskIds.has(taskId));
    invalidateTasks(taskFile, requestedTasks, severeTaskInvalidation);
    await saveTasks(tasksPath, taskFile);
  }

  const previousRevision = change.metadata.activeRevision;
  const previousBaseline = change.metadata.baseline;
  const nextRevision = incrementRevision(previousRevision);
  const nextBaseline = incrementBaseline(previousBaseline);
  const correlation = input.correlationId ? { correlationId: input.correlationId } : {};
  const signal = reconcileSignalSchema.parse({
    schemaVersion: 1,
    id: `SIG-${Date.now()}-${randomUUID().slice(0, 8)}`,
    changeId: change.metadata.id,
    revision: previousRevision,
    level: input.level,
    type: input.type,
    reason: input.reason,
    affectedTasks: requestedTasks,
    evidence: input.evidence ?? [],
    ...correlation,
    createdAt: now,
  });
  const revision = revisionSchema.parse({
    schemaVersion: 1,
    id: nextRevision,
    changeId: change.metadata.id,
    previousRevision,
    reason: input.reason,
    level: input.level,
    affectedArtifacts: affectedReadiness,
    affectedTasks,
    previousBaseline,
    baseline: nextBaseline,
    ...correlation,
    createdAt: now,
  });

  await writeYaml(join(changeRevisionsRoot(repoRoot, change.directoryName), `${signal.id}.signal.yaml`), signal);
  await writeYaml(join(changeRevisionsRoot(repoRoot, change.directoryName), `${nextRevision}.yaml`), revision);

  for (const key of affectedReadiness) {
    const current = change.metadata.readiness[key];
    if (current === 'NOT_APPLICABLE') continue;
    if (key === 'implementation' && ['READY', 'CONCERNS'].includes(current)) change.metadata.readiness[key] = 'NEEDS_REVALIDATION';
    else if (['L2', 'L3', 'L4'].includes(input.level) && ['plan', 'design'].includes(key)) change.metadata.readiness[key] = 'INVALIDATED';
    else change.metadata.readiness[key] = current === 'MISSING' ? 'MISSING' : 'STALE';
  }
  change.metadata.activeRevision = nextRevision;
  change.metadata.baseline = nextBaseline;
  change.metadata.status = 'IN_PROGRESS';
  await saveChange(repoRoot, change);
  await appendJsonLine(changeArtifactPath(repoRoot, change.directoryName, 'progress.jsonl'), {
    timestamp: now,
    event: 'RECONCILE_APPLIED',
    changeId: change.metadata.id,
    revision: nextRevision,
    detail: `${input.level} ${input.type}: ${input.reason}`,
    data: {
      previousRevision,
      previousBaseline,
      baseline: nextBaseline,
      affectedReadiness,
      affectedTasks,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    },
  });
  return { signal, revision, affectedReadiness, affectedTasks };
}

export function incrementRevision(revision: string): string {
  const match = /^REV-(\d{4})$/.exec(revision);
  if (!match?.[1]) throw new Error(`Invalid revision '${revision}'`);
  return `REV-${String(Number(match[1]) + 1).padStart(4, '0')}`;
}

export function incrementBaseline(baseline: string): string {
  const match = /^BL-(\d{4})$/.exec(baseline);
  if (!match?.[1]) throw new Error(`Invalid baseline '${baseline}'`);
  return `BL-${String(Number(match[1]) + 1).padStart(4, '0')}`;
}

function normalizeAffectedReadiness(
  values: Array<keyof ChangeMetadata['readiness']>,
): Array<keyof ChangeMetadata['readiness']> {
  const keySchema = readinessSchema.keyof();
  const normalized: Array<keyof ChangeMetadata['readiness']> = [];
  for (const value of values) {
    const parsed = keySchema.parse(value) as keyof ChangeMetadata['readiness'];
    if (!normalized.includes(parsed)) normalized.push(parsed);
  }
  return normalized;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
