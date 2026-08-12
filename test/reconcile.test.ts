import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { join } from 'node:path';
import { createTestRepository } from './helpers.js';
import { createChange, resolveChange } from '../src/core/store.js';
import { loadTasks, saveTasks } from '../src/core/tasks.js';
import { changeArtifactPath } from '../src/core/paths.js';
import { reconcileChange } from '../src/core/reconcile.js';
import { pathExists } from '../src/core/files.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

test('creates a new revision and invalidates only the affected task subtree', async () => {
  const fixture = await createTestRepository();
  cleanups.push(fixture.cleanup);
  const created = await createChange(fixture.root, 'Authorization migration', 'domain-feature');
  const tasksPath = changeArtifactPath(fixture.root, created.directoryName, 'tasks.yaml');
  const taskFile = await loadTasks(tasksPath);
  taskFile.tasks = [
    {
      id: 'TASK-001', title: 'Logging', objective: 'Add neutral logging', status: 'DONE', dependsOn: [], slice: 'VERTICAL', risk: 'LOW',
      files: { create: [], modify: [], tests: [] }, consumes: [], produces: [], steps: ['test'], evidenceRequired: ['test'], notes: [],
    },
    {
      id: 'TASK-002', title: 'Authorization schema', objective: 'Create schema', status: 'DONE', dependsOn: [], slice: 'EXPAND', risk: 'HIGH',
      files: { create: [], modify: [], tests: [] }, consumes: [], produces: [], steps: ['test'], evidenceRequired: ['migration'], notes: [],
    },
    {
      id: 'TASK-003', title: 'Repository', objective: 'Use schema', status: 'RUNNING', dependsOn: ['TASK-002'], slice: 'MIGRATE', risk: 'HIGH',
      files: { create: [], modify: [], tests: [] }, consumes: [], produces: [], steps: ['test'], evidenceRequired: ['test'], notes: [],
    },
  ];
  await saveTasks(tasksPath, taskFile);

  const change = await resolveChange(fixture.root, created.metadata.id);
  const result = await reconcileChange(fixture.root, change, {
    level: 'L3',
    type: 'DOMAIN_ASSUMPTION_INVALIDATED',
    reason: 'Authorization mixes durable consent and quote usage',
    affectedTasks: ['TASK-002'],
  });

  assert.equal(result.revision.id, 'REV-0002');
  assert.deepEqual(result.affectedTasks, ['TASK-002', 'TASK-003']);
  const updated = await loadTasks(tasksPath);
  assert.equal(updated.tasks[0]!.status, 'DONE');
  assert.equal(updated.tasks[1]!.status, 'NEEDS_REVALIDATION');
  assert.equal(updated.tasks[2]!.status, 'INVALIDATED');
  assert.equal(change.metadata.readiness.spec, 'STALE');
  assert.equal(change.metadata.readiness.design, 'INVALIDATED');
  assert.equal(await pathExists(join(fixture.root, '.omnai/changes', created.directoryName, 'revisions/REV-0002.yaml')), true);
});
