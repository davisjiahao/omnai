import { taskFileSchema, type Task, type TaskFile, type TaskStatus } from '../domain/types.js';
import { readYaml, writeYaml } from './files.js';

const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  PENDING: ['READY', 'BLOCKED', 'CANCELLED', 'INVALIDATED', 'SUPERSEDED'],
  READY: ['RUNNING', 'BLOCKED', 'CANCELLED', 'INVALIDATED', 'SUPERSEDED'],
  RUNNING: ['BLOCKED', 'IMPLEMENTED', 'CANCELLED', 'INVALIDATED', 'NEEDS_REVALIDATION'],
  BLOCKED: ['READY', 'RUNNING', 'CANCELLED', 'INVALIDATED', 'SUPERSEDED'],
  IMPLEMENTED: ['VERIFYING', 'NEEDS_REVALIDATION', 'INVALIDATED'],
  VERIFYING: ['VERIFIED', 'BLOCKED', 'NEEDS_REVALIDATION', 'INVALIDATED'],
  VERIFIED: ['DONE', 'NEEDS_REVALIDATION', 'STALE', 'INVALIDATED'],
  DONE: ['NEEDS_REVALIDATION', 'STALE', 'INVALIDATED', 'SUPERSEDED'],
  STALE: ['READY', 'NEEDS_REVALIDATION', 'INVALIDATED', 'SUPERSEDED'],
  NEEDS_REVALIDATION: ['VERIFYING', 'READY', 'INVALIDATED', 'SUPERSEDED'],
  INVALIDATED: ['SUPERSEDED'],
  SUPERSEDED: [],
  CANCELLED: ['READY', 'SUPERSEDED'],
};

export async function loadTasks(path: string): Promise<TaskFile> {
  const taskFile = await readYaml(path, taskFileSchema);
  validateTaskGraph(taskFile);
  return taskFile;
}

export async function saveTasks(path: string, taskFile: TaskFile): Promise<void> {
  validateTaskGraph(taskFile);
  await writeYaml(path, taskFileSchema.parse(taskFile));
}

export function validateTaskGraph(taskFile: TaskFile): void {
  const ids = new Set<string>();
  for (const task of taskFile.tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate task ID ${task.id}`);
    ids.add(task.id);
  }

  for (const task of taskFile.tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`Task ${task.id} depends on unknown task ${dependency}`);
      }
      if (dependency === task.id) throw new Error(`Task ${task.id} cannot depend on itself`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(taskFile.tasks.map((task) => [task.id, task]));

  const visit = (taskId: string): void => {
    if (visiting.has(taskId)) throw new Error(`Task dependency cycle detected at ${taskId}`);
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    const task = byId.get(taskId);
    for (const dependency of task?.dependsOn ?? []) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };

  for (const task of taskFile.tasks) visit(task.id);
}

export function taskFrontier(taskFile: TaskFile): Task[] {
  const byId = new Map(taskFile.tasks.map((task) => [task.id, task]));
  return taskFile.tasks.filter((task) => {
    if (!['PENDING', 'READY', 'STALE'].includes(task.status)) return false;
    return task.dependsOn.every((dependency) => {
      const upstream = byId.get(dependency);
      return upstream && ['VERIFIED', 'DONE'].includes(upstream.status);
    });
  });
}

export function refreshTaskReadiness(taskFile: TaskFile): TaskFile {
  const frontierIds = new Set(taskFrontier(taskFile).map((task) => task.id));
  for (const task of taskFile.tasks) {
    if (frontierIds.has(task.id) && ['PENDING', 'STALE'].includes(task.status)) {
      task.status = 'READY';
    }
  }
  return taskFile;
}

export function transitionTask(taskFile: TaskFile, taskId: string, nextStatus: TaskStatus): Task {
  const task = requireTask(taskFile, taskId);
  if (!ALLOWED_TRANSITIONS[task.status].includes(nextStatus)) {
    throw new Error(`Invalid task transition ${task.status} -> ${nextStatus} for ${taskId}`);
  }
  task.status = nextStatus;
  return task;
}

export function requireTask(taskFile: TaskFile, taskId: string): Task {
  const task = taskFile.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`Task '${taskId}' was not found`);
  return task;
}

export function dependentTaskIds(taskFile: TaskFile, roots: string[]): string[] {
  const affected = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of taskFile.tasks) {
      if (!affected.has(task.id) && task.dependsOn.some((dependency) => affected.has(dependency))) {
        affected.add(task.id);
        changed = true;
      }
    }
  }
  return [...affected];
}

export function invalidateTasks(taskFile: TaskFile, taskIds: string[], severe: boolean): void {
  applyTaskInvalidation(taskFile, new Set(dependentTaskIds(taskFile, taskIds)), severe);
}

export function invalidateExactTasks(taskFile: TaskFile, taskIds: string[], severe: boolean): void {
  const uniqueIds = [...new Set(taskIds)];
  for (const taskId of uniqueIds) requireTask(taskFile, taskId);
  applyTaskInvalidation(taskFile, new Set(uniqueIds), severe);
}

export function summarizeTasks(taskFile: TaskFile): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const task of taskFile.tasks) summary[task.status] = (summary[task.status] ?? 0) + 1;
  return summary;
}

function applyTaskInvalidation(taskFile: TaskFile, affected: Set<string>, severe: boolean): void {
  for (const task of taskFile.tasks) {
    if (!affected.has(task.id)) continue;
    if (['DONE', 'VERIFIED', 'IMPLEMENTED'].includes(task.status)) {
      task.status = 'NEEDS_REVALIDATION';
    } else if (severe) {
      task.status = 'INVALIDATED';
    } else if (!['SUPERSEDED', 'CANCELLED'].includes(task.status)) {
      task.status = 'STALE';
    }
  }
}
