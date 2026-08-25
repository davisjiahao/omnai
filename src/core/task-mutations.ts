import type { Task, TaskFile } from '../domain/types.js';
import { listEvidence } from './evidence.js';
import { appendJsonLine } from './files.js';
import { withGuardedChangeMutation } from './guarded-change-mutation.js';
import { changeArtifactPath } from './paths.js';
import { markReadinessWithinChangeLock } from './readiness-mutation-internal.js';
import type { ChangeRef } from './store.js';
import {
  loadTasks,
  refreshTaskReadiness,
  requireTask,
  saveTasks,
  taskFrontier,
  transitionTask,
} from './tasks.js';

export type ImplementationTaskMutation =
  | { action: 'START'; taskId?: string }
  | { action: 'BLOCK'; taskId?: string; reason: string }
  | { action: 'IMPLEMENTED'; taskId?: string }
  | { action: 'VERIFIED'; taskId?: string };

export interface ImplementationTaskMutationResult {
  task: Task;
  tasks: TaskFile;
}

export async function mutateImplementationTask(
  repoRoot: string,
  change: ChangeRef,
  mutation: ImplementationTaskMutation,
): Promise<ImplementationTaskMutationResult> {
  return withGuardedChangeMutation(repoRoot, change, async () => {
    const tasksPath = changeArtifactPath(repoRoot, change.directoryName, 'tasks.yaml');
    const taskFile = refreshTaskReadiness(await loadTasks(tasksPath));
    const task = mutation.taskId ? requireTask(taskFile, mutation.taskId) : taskFrontier(taskFile)[0];
    if (!task) throw new Error('No ready task exists. Run omnai status or reconcile the task graph.');

    if (mutation.action === 'BLOCK') {
      if (task.status !== 'BLOCKED') transitionTask(taskFile, task.id, 'BLOCKED');
      task.notes.push(mutation.reason);
      await saveTasks(tasksPath, taskFile);
      await appendTaskEventWithinChangeLock(repoRoot, change, task.id, 'TASK_BLOCKED', mutation.reason);
      return { task, tasks: taskFile };
    }

    if (mutation.action === 'IMPLEMENTED') {
      if (task.status === 'RUNNING') transitionTask(taskFile, task.id, 'IMPLEMENTED');
      else if (task.status !== 'IMPLEMENTED') throw new Error(`${task.id} must be RUNNING before --done`);
      await saveTasks(tasksPath, taskFile);
      await markReadinessWithinChangeLock(repoRoot, change, 'implementation', 'CONCERNS');
      await appendTaskEventWithinChangeLock(repoRoot, change, task.id, 'TASK_IMPLEMENTED');
      return { task, tasks: taskFile };
    }

    if (mutation.action === 'VERIFIED') {
      const evidence = await listEvidence(repoRoot, change);
      const missing = task.evidenceRequired.filter((requirement) => !evidence.some((record) => (
        record.revision === change.metadata.activeRevision
        && record.status === 'PASS'
        && record.requirementId === requirement
        && (!record.taskId || record.taskId === task.id)
      )));
      if (missing.length > 0) throw new Error(`${task.id} is missing PASS evidence for: ${missing.join(', ')}`);
      if (task.status === 'IMPLEMENTED') transitionTask(taskFile, task.id, 'VERIFYING');
      if (task.status === 'VERIFYING') transitionTask(taskFile, task.id, 'VERIFIED');
      if (task.status === 'VERIFIED') transitionTask(taskFile, task.id, 'DONE');
      if (task.status !== 'DONE') throw new Error(`${task.id} must be IMPLEMENTED or VERIFYING before --verified`);
      refreshTaskReadiness(taskFile);
      await saveTasks(tasksPath, taskFile);
      if (taskFile.tasks.every((item) => item.status === 'DONE')) {
        await markReadinessWithinChangeLock(repoRoot, change, 'implementation', 'READY');
      }
      await appendTaskEventWithinChangeLock(repoRoot, change, task.id, 'TASK_DONE');
      return { task, tasks: taskFile };
    }

    if (task.status === 'READY') transitionTask(taskFile, task.id, 'RUNNING');
    if (task.status !== 'RUNNING') throw new Error(`${task.id} is ${task.status}, not READY or RUNNING`);
    await saveTasks(tasksPath, taskFile);
    await markReadinessWithinChangeLock(repoRoot, change, 'implementation', 'IN_PROGRESS');
    await appendTaskEventWithinChangeLock(repoRoot, change, task.id, 'TASK_STARTED');
    return { task, tasks: taskFile };
  });
}

async function appendTaskEventWithinChangeLock(
  repoRoot: string,
  change: ChangeRef,
  taskId: string,
  event: string,
  detail?: string,
): Promise<void> {
  await appendJsonLine(changeArtifactPath(repoRoot, change.directoryName, 'progress.jsonl'), {
    timestamp: new Date().toISOString(),
    event,
    changeId: change.metadata.id,
    revision: change.metadata.activeRevision,
    taskId,
    ...(detail ? { detail } : {}),
  });
}
