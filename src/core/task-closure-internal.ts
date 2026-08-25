import { taskIdSchema, type TaskFile, type TaskId } from '../domain/types.js';
import { dependentTaskIds } from './tasks.js';

export interface CanonicalTaskClosure {
  roots: TaskId[];
  closure: TaskId[];
}

/** @internal Validates caller-frozen task scope without mutating the TaskFile. */
export function validateCanonicalTaskClosure(
  taskFile: TaskFile,
  roots: readonly string[],
  explicitClosure: readonly string[] | null,
): CanonicalTaskClosure {
  if (new Set(roots).size !== roots.length) fail('task roots must be unique');
  if (explicitClosure && new Set(explicitClosure).size !== explicitClosure.length) {
    fail('task closure must be unique');
  }
  const parsedRoots = roots.map((taskId) => taskIdSchema.parse(taskId));
  const parsedClosure = explicitClosure?.map((taskId) => taskIdSchema.parse(taskId)) ?? null;
  const known = new Set(taskFile.tasks.map(({ id }) => id));
  const unknownRoot = parsedRoots.find((taskId) => !known.has(taskId));
  if (unknownRoot) fail(`unknown task root ${unknownRoot}`);
  const unknownClosure = parsedClosure?.find((taskId) => !known.has(taskId));
  if (unknownClosure) fail(`unknown task closure member ${unknownClosure}`);
  if (parsedClosure && parsedRoots.some((taskId) => !parsedClosure.includes(taskId))) {
    fail('task closure must include every root');
  }
  const rootSet = new Set(parsedRoots);
  const canonicalRoots = taskFile.tasks.filter(({ id }) => rootSet.has(id)).map(({ id }) => id);
  if (JSON.stringify(parsedRoots) !== JSON.stringify(canonicalRoots)) {
    fail('task roots must use canonical TaskFile order');
  }
  const affected = new Set(dependentTaskIds(taskFile, parsedRoots));
  const canonical = taskFile.tasks.filter(({ id }) => affected.has(id)).map(({ id }) => id);
  if (parsedClosure && JSON.stringify(parsedClosure) !== JSON.stringify(canonical)) {
    fail('task closure must equal the canonical dependent closure');
  }
  return { roots: canonicalRoots, closure: canonical };
}

function fail(detail: string): never {
  throw new Error(`RECONCILE_TASK_CLOSURE_INVALID: ${detail}`);
}
