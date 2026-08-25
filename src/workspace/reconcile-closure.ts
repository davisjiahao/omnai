import { dependentTaskIds } from '../core/tasks.js';
import {
  taskIdSchema,
  type Capability,
  type ChangeMetadata,
  type ReconcileLevel,
  type ScenarioProfile,
  type TaskFile,
} from '../domain/types.js';
import type { ReentryKind } from './reentry.js';

export type ReadinessKey = keyof ChangeMetadata['readiness'];

const CAPABILITY_TO_READINESS: Partial<Record<Capability, ReadinessKey>> = {
  frame: 'frame',
  map: 'map',
  research: 'research',
  mitigate: 'mitigation',
  triage: 'triage',
  reproduce: 'reproduction',
  debug: 'diagnosis',
  diagnose: 'diagnosis',
  model: 'domain',
  spec: 'spec',
  design: 'design',
  experiment: 'experiment',
  fix: 'fix',
  plan: 'plan',
  work: 'implementation',
  review: 'review',
  verify: 'verification',
  qa: 'qa',
  ship: 'release',
  canary: 'canary',
  learn: 'learning',
};

const MINIMUM_LEVEL: Record<ReentryKind, ReconcileLevel> = {
  REALITY_CHANGED: 'L4',
  PRODUCT_CHANGED: 'L4',
  DOMAIN_CHANGED: 'L3',
  SCOPE_CHANGED: 'L3',
  TECHNICAL_CONSTRAINT_CHANGED: 'L2',
  NEEDS_EXPERIMENT: 'L2',
  PLAN_CHANGED: 'L1',
  IMPLEMENTATION_DETAIL_CHANGED: 'L0',
};

export function minimumReconcileLevel(kind: ReentryKind): ReconcileLevel {
  return MINIMUM_LEVEL[kind];
}

export function buildEffectiveReadinessPath(scenario: ScenarioProfile): ReadinessKey[] {
  const path: ReadinessKey[] = [];
  const seen = new Set<ReadinessKey>();
  for (const capability of scenario.stages) {
    const readiness = CAPABILITY_TO_READINESS[capability];
    if (!readiness || seen.has(readiness)) continue;
    seen.add(readiness);
    path.push(readiness);
  }
  return path;
}

export function calculateReadinessClosure(
  scenario: ScenarioProfile,
  reopenFrom: ReadinessKey,
): ReadinessKey[] {
  const path = buildEffectiveReadinessPath(scenario);
  const index = path.indexOf(reopenFrom);
  if (index < 0) {
    throw new Error(`Readiness '${reopenFrom}' is not active in scenario '${scenario.id}'.`);
  }
  return path.slice(index);
}

export function calculateTaskClosure(taskFile: TaskFile, taskRoots: string[]): string[] {
  const parsedTaskRoots = taskRoots.map((taskId) => taskIdSchema.parse(taskId));
  const known = new Set(taskFile.tasks.map((task) => task.id));
  for (const taskId of parsedTaskRoots) {
    if (!known.has(taskId)) throw new Error(`Task '${taskId}' was not found in the active Task DAG.`);
  }
  const affected = new Set(dependentTaskIds(taskFile, parsedTaskRoots));
  return taskFile.tasks.filter((task) => affected.has(task.id)).map((task) => task.id);
}
