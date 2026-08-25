import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateTaskGraph } from '../src/core/tasks.js';
import type { TaskFile } from '../src/domain/types.js';

function oneTaskFile(dependsOn: string[]): TaskFile {
  return {
    schemaVersion: 1,
    revision: 'REV-0001',
    generatedFrom: [],
    tasks: [{
      id: 'TASK-001',
      title: 'Authorization contract',
      objective: 'Publish the local authorization behavior',
      status: 'PENDING',
      dependsOn,
      slice: 'CONTRACT',
      risk: 'MEDIUM',
      files: { create: [], modify: [], tests: [] },
      consumes: [],
      produces: [],
      steps: [],
      evidenceRequired: [],
      notes: [],
    }],
  };
}

function localTwoTaskFile(): TaskFile {
  const value = oneTaskFile([]);
  value.tasks.push({
    ...value.tasks[0]!,
    id: 'TASK-002',
    title: 'Local consumer',
    dependsOn: ['TASK-001'],
  });
  return value;
}

test('rejects fully scoped cross-project dependsOn with the supported alternatives', () => {
  const tasks = oneTaskFile(['user/CHG-0001/REV-0001/TASK-001']);
  assert.throws(
    () => validateTaskGraph(tasks),
    /CROSS_PROJECT_TASK_DEPENDENCY.*contractRef.*integration gate.*rollout gate/,
  );
});

test('rejects project-prefixed shorthand rather than reporting an unknown local task', () => {
  assert.throws(
    () => validateTaskGraph(oneTaskFile(['user:TASK-001'])),
    /CROSS_PROJECT_TASK_DEPENDENCY/,
  );
});

test('continues to allow project-local dependencies and reject their cycles', () => {
  const tasks = localTwoTaskFile();
  assert.doesNotThrow(() => validateTaskGraph(tasks));
  tasks.tasks[0]!.dependsOn = ['TASK-002'];
  assert.throws(() => validateTaskGraph(tasks), /cycle/);
});

test('allows an immutable contract pin without creating a cross-project task edge', () => {
  const tasks = oneTaskFile([]);
  tasks.tasks[0]!.contractRefs = [{ id: 'CTR-0001', contentHash: `sha256:${'a'.repeat(64)}` }];
  assert.doesNotThrow(() => validateTaskGraph(tasks));
});

test('allows a logical producer or consumer key without naming another repository task', () => {
  const tasks = oneTaskFile([]);
  tasks.tasks[0]!.produces = ['contract:authorization-v2'];
  assert.doesNotThrow(() => validateTaskGraph(tasks));
});
