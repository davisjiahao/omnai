import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  reconcileSignalSchema, revisionSchema,
  type ChangeMetadata, type ReconcileLevel, type ReconcileSignal, type Revision,
} from '../domain/types.js';
import { appendJsonLine, writeYaml } from './files.js';
import { changeArtifactPath, changeRevisionsRoot } from './paths.js';
import type { ChangeRef } from './store.js';
import { saveChange } from './store.js';
import { invalidateTasks, loadTasks, saveTasks } from './tasks.js';

const IMPACTS: Record<ReconcileLevel, Array<keyof ChangeMetadata['readiness']>> = {
  L0: ['implementation', 'review', 'verification', 'qa'],
  L1: ['plan', 'implementation', 'review', 'verification', 'qa'],
  L2: ['design', 'experiment', 'fix', 'plan', 'implementation', 'review', 'verification', 'qa', 'release'],
  L3: ['diagnosis', 'domain', 'spec', 'design', 'experiment', 'fix', 'plan', 'implementation', 'review', 'verification', 'qa', 'release'],
  L4: ['frame', 'research', 'triage', 'reproduction', 'diagnosis', 'domain', 'spec', 'design', 'experiment', 'fix', 'plan', 'implementation', 'review', 'verification', 'qa', 'release', 'learning'],
  L5: ['review', 'verification', 'qa', 'release'],
};

export interface ReconcileInput {
  level: ReconcileLevel;
  type: string;
  reason: string;
  affectedTasks?: string[];
  evidence?: string[];
}

export interface ReconcileResult {
  signal: ReconcileSignal;
  revision: Revision;
  affectedReadiness: Array<keyof ChangeMetadata['readiness']>;
  affectedTasks: string[];
}

export async function reconcileChange(repoRoot: string, change: ChangeRef, input: ReconcileInput): Promise<ReconcileResult> {
  const now = new Date().toISOString();
  const affectedReadiness = IMPACTS[input.level];
  const tasksPath = changeArtifactPath(repoRoot, change.directoryName, 'tasks.yaml');
  const taskFile = await loadTasks(tasksPath);
  const requestedTasks = input.affectedTasks ?? [];
  if (requestedTasks.length > 0) {
    invalidateTasks(taskFile, requestedTasks, ['L2', 'L3', 'L4'].includes(input.level));
    await saveTasks(tasksPath, taskFile);
  }
  const affectedTasks = taskFile.tasks.filter((task) => ['STALE', 'NEEDS_REVALIDATION', 'INVALIDATED'].includes(task.status)).map((task) => task.id);

  const previousRevision = change.metadata.activeRevision;
  const previousBaseline = change.metadata.baseline;
  const nextRevision = incrementRevision(previousRevision);
  const nextBaseline = incrementBaseline(previousBaseline);
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
  change.metadata.status = 'NEEDS_RECONCILE';
  await saveChange(repoRoot, change);
  await appendJsonLine(changeArtifactPath(repoRoot, change.directoryName, 'progress.jsonl'), {
    timestamp: now,
    event: 'RECONCILE_APPLIED',
    changeId: change.metadata.id,
    revision: nextRevision,
    detail: `${input.level} ${input.type}: ${input.reason}`,
    data: { previousRevision, previousBaseline, baseline: nextBaseline, affectedReadiness, affectedTasks },
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
