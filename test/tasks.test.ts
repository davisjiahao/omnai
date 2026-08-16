import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskFile } from '../src/domain/types.js';
import {
  dependentTaskIds,
  invalidateTasks,
  refreshTaskReadiness,
  taskFrontier,
  transitionTask,
  validateTaskGraph,
} from '../src/core/tasks.js';

function graph(): TaskFile {
  return {
    schemaVersion: 1,
    revision: 'REV-0001',
    generatedFrom: ['spec@1', 'design@1'],
    tasks: [
      {
        id: 'TASK-001', title: 'First slice', objective: 'Deliver first behavior', status: 'PENDING', dependsOn: [],
        slice: 'VERTICAL', risk: 'MEDIUM', files: { create: [], modify: [], tests: [] }, consumes: [], produces: [],
        steps: ['write failing test'], evidenceRequired: ['test'], notes: [],
      },
      {
        id: 'TASK-002', title: 'Second slice', objective: 'Build on first behavior', status: 'PENDING', dependsOn: ['TASK-001'],
        slice: 'VERTICAL', risk: 'MEDIUM', files: { create: [], modify: [], tests: [] }, consumes: [], produces: [],
        steps: ['write failing test'], evidenceRequired: ['test'], notes: [],
      },
      {
        id: 'TASK-003', title: 'Third slice', objective: 'Build on second behavior', status: 'PENDING', dependsOn: ['TASK-002'],
        slice: 'VERTICAL', risk: 'HIGH', files: { create: [], modify: [], tests: [] }, consumes: [], produces: [],
        steps: ['write failing test'], evidenceRequired: ['test'], notes: [],
      },
    ],
  };
}

test('validates and advances a dependency frontier', () => {
  const tasks = graph();
  validateTaskGraph(tasks);
  refreshTaskReadiness(tasks);
  assert.deepEqual(taskFrontier(tasks).map((task) => task.id), ['TASK-001']);
  transitionTask(tasks, 'TASK-001', 'RUNNING');
  transitionTask(tasks, 'TASK-001', 'IMPLEMENTED');
  transitionTask(tasks, 'TASK-001', 'VERIFYING');
  transitionTask(tasks, 'TASK-001', 'VERIFIED');
  transitionTask(tasks, 'TASK-001', 'DONE');
  refreshTaskReadiness(tasks);
  assert.deepEqual(taskFrontier(tasks).map((task) => task.id), ['TASK-002']);
});

test('selectively invalidates a task and all downstream dependents', () => {
  const tasks = graph();
  tasks.tasks[0]!.status = 'DONE';
  tasks.tasks[1]!.status = 'RUNNING';
  assert.deepEqual(dependentTaskIds(tasks, ['TASK-001']), ['TASK-001', 'TASK-002', 'TASK-003']);
  invalidateTasks(tasks, ['TASK-001'], true);
  assert.equal(tasks.tasks[0]!.status, 'NEEDS_REVALIDATION');
  assert.equal(tasks.tasks[1]!.status, 'INVALIDATED');
  assert.equal(tasks.tasks[2]!.status, 'INVALIDATED');
});

test('rejects dependency cycles', () => {
  const tasks = graph();
  tasks.tasks[0]!.dependsOn = ['TASK-003'];
  assert.throws(() => validateTaskGraph(tasks), /cycle/);
});
