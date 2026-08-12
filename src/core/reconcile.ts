import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  reconcileSignalSchema,
  revisionSchema,
  type ChangeMetadata,
  type ReconcileLevel,
  type ReconcileSignal,
  type Revision,
} from '../domain/types.js';
import { appendJsonLine, writeYaml } from './files.js';
import { changeArtifactPath, changeRevisionsRoot } from './paths.js';
import type { ChangeRef } from './store.js';
import { saveChange } from './store.js';
import { invalidateTasks, loadTasks, saveTasks } from './tasks.js';

const IMPACTS: Record<ReconcileLevel, Array<keyof ChangeMetadata['readiness']>> = {
  L0: ['implementation', 'verification'],
  L1: ['plan', 'implementation', 'verification'],
  L2: ['design', 'plan', 'implementation', 'verification'],
  L3: ['domain', 'spec', 'design', 'plan', 'implementation', 'verification'],
  L4: ['frame', 'research', 'domain', 'spec', 'design', 'plan', 'implementation', 'verification', 'release', 'learning'],
  L5: ['release', 'verification'],
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

export async function reconcileChange(
  repoRoot: string,
  change: ChangeRef,
  input: ReconcileInput,
): Promise<ReconcileResult> {
  const now = new Date().toISOString();
  const affectedReadiness = IMPACTS[input.level];
  const tasksPath = changeArtifactPath(repoRoot, change.directoryName, 'tasks.yaml');
  const taskFile = await loadTasks(tasksPath);
  const requestedTasks = input.affectedTasks ?? [];
  if (requestedTasks.length > 0) {
    invalidateTasks(taskFile, requestedTasks, ['L2', 'L3', 'L4'].includes(input.level));
    await saveTasks(tasksPath, taskFile);
  }
  const affectedTasks = taskFile.tasks
    .filter((task) => ['STALE', 'NEEDS_REVALIDATION', 'INVALIDATED'].includes(task.status))
    .map((task) => task.id);

  const previousRevision = change.metadata.activeRevision;
  const nextRevision = incrementRevision(previousRevision);
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
    createdAt: now,
  });

  await writeYaml(join(changeRevisionsRoot(repoRoot, change.directoryName), `${signal.id}.signal.yaml`), signal);
  await writeYaml(join(changeRevisionsRoot(repoRoot, change.directoryName), `${nextRevision}.yaml`), revision);

  for (const key of affectedReadiness) {
    const current = change.metadata.readiness[key];
    if (current === 'NOT_APPLICABLE') continue;
    if (key === 'implementation' && ['READY', 'CONCERNS'].includes(current)) {
      change.metadata.readiness[key] = 'NEEDS_REVALIDATION';
    } else if (['L2', 'L3', 'L4'].includes(input.level) && ['plan', 'design'].includes(key)) {
      change.metadata.readiness[key] = 'INVALIDATED';
    } else {
      change.metadata.readiness[key] = current === 'MISSING' ? 'MISSING' : 'STALE';
    }
  }
  change.metadata.activeRevision = nextRevision;
  change.metadata.status = 'NEEDS_RECONCILE';
  await saveChange(repoRoot, change);
  await appendJsonLine(changeArtifactPath(repoRoot, change.directoryName, 'progress.jsonl'), {
    timestamp: now,
    event: 'RECONCILE_APPLIED',
    changeId: change.metadata.id,
    revision: nextRevision,
    detail: `${input.level} ${input.type}: ${input.reason}`,
    data: { previousRevision, affectedReadiness, affectedTasks },
  });

  return { signal, revision, affectedReadiness, affectedTasks };
}

export function incrementRevision(revision: string): string {
  const match = /^REV-(\d{4})$/.exec(revision);
  if (!match) throw new Error(`Invalid revision '${revision}'`);
  return `REV-${String(Number(match[1]) + 1).padStart(4, '0')}`;
}
