import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskFileSchema, type TaskFile, type TaskFileConstructionInput } from '../src/domain/types.js';
import {
  dependentTaskIds,
  invalidateTasks,
  refreshTaskReadiness,
  taskFrontier,
  transitionTask,
  validateTaskGraph,
} from '../src/core/tasks.js';

function graph(): TaskFile {
  const input: TaskFileConstructionInput = {
    schemaVersion: 1,
    revision: 'REV-0001',
    generatedFrom: ['design@1', 'spec@1'],
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
  return taskFileSchema.parse(input);
}

test('validates and advances a dependency frontier', () => {
  const tasks = graph();
  validateTaskGraph(tasks);
  refreshTaskReadiness(tasks);
  assert.deepEqual(taskFrontier(tasks).map((task) => task.id), ['TASK-001']);
  const firstTaskId = tasks.tasks[0]!.id;
  transitionTask(tasks, firstTaskId, 'RUNNING');
  transitionTask(tasks, firstTaskId, 'IMPLEMENTED');
  transitionTask(tasks, firstTaskId, 'VERIFYING');
  transitionTask(tasks, firstTaskId, 'VERIFIED');
  transitionTask(tasks, firstTaskId, 'DONE');
  refreshTaskReadiness(tasks);
  assert.deepEqual(taskFrontier(tasks).map((task) => task.id), ['TASK-002']);
});

test('selectively invalidates a task and all downstream dependents', () => {
  const tasks = graph();
  tasks.tasks[0]!.status = 'DONE';
  tasks.tasks[1]!.status = 'RUNNING';
  const firstTaskId = tasks.tasks[0]!.id;
  assert.deepEqual(dependentTaskIds(tasks, [firstTaskId]), ['TASK-001', 'TASK-002', 'TASK-003']);
  invalidateTasks(tasks, [firstTaskId], true);
  assert.equal(tasks.tasks[0]!.status, 'NEEDS_REVALIDATION');
  assert.equal(tasks.tasks[1]!.status, 'INVALIDATED');
  assert.equal(tasks.tasks[2]!.status, 'INVALIDATED');
});

test('rejects dependency cycles', () => {
  const tasks = graph();
  tasks.tasks[0]!.dependsOn = [tasks.tasks[2]!.id];
  assert.throws(() => validateTaskGraph(tasks), /cycle/);
});

test('task schema rejects the removed contractRefs compatibility field', () => {
  const input: TaskFileConstructionInput = {
    schemaVersion: 1,
    revision: 'REV-0001',
    generatedFrom: ['spec@1'],
    tasks: [{
      id: 'TASK-001', title: 'One slice', objective: 'Deliver one behavior', status: 'PENDING', dependsOn: [],
      slice: 'VERTICAL', risk: 'MEDIUM', files: { create: [], modify: [], tests: [] }, consumes: [], produces: [],
      steps: ['write failing test'], evidenceRequired: ['test'], notes: [],
    }],
  };
  assert.equal(taskFileSchema.safeParse(input).success, true);
  assert.equal(taskFileSchema.safeParse({
    ...input,
    tasks: [{ ...input.tasks[0]!, contractRefs: [] }],
  }).success, false);
});
