import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createTestRepository } from './helpers.js';
import { createChange, resolveChange, saveChange } from '../src/core/store.js';
import { loadTasks, saveTasks } from '../src/core/tasks.js';
import { changeArtifactPath, changeRevisionsRoot } from '../src/core/paths.js';
import { reconcileChange } from '../src/core/reconcile.js';
import { pathExists } from '../src/core/files.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

test('creates a new revision and baseline while invalidating only the affected task subtree', async () => {
  const fixture = await createTestRepository();
  cleanups.push(fixture.cleanup);
  const created = await createChange(fixture.root, 'Authorization migration', 'complex-domain-feature');
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
  change.metadata.readiness.domain = 'READY';
  change.metadata.readiness.spec = 'READY';
  change.metadata.readiness.design = 'READY';
  change.metadata.readiness.plan = 'READY';
  change.metadata.readiness.implementation = 'IN_PROGRESS';
  await saveChange(fixture.root, change);

  const result = await reconcileChange(fixture.root, change, {
    level: 'L3',
    type: 'DOMAIN_ASSUMPTION_INVALIDATED',
    reason: 'Authorization mixes durable consent and quote usage',
    affectedTasks: ['TASK-002'],
  });

  assert.equal(result.revision.id, 'REV-0002');
  assert.equal(result.revision.previousBaseline, 'BL-0001');
  assert.equal(result.revision.baseline, 'BL-0002');
  assert.equal(change.metadata.baseline, 'BL-0002');
  assert.deepEqual(result.affectedTasks, ['TASK-002', 'TASK-003']);
  const updated = await loadTasks(tasksPath);
  assert.equal(updated.tasks[0]!.status, 'DONE');
  assert.equal(updated.tasks[1]!.status, 'NEEDS_REVALIDATION');
  assert.equal(updated.tasks[2]!.status, 'INVALIDATED');
  assert.equal(change.metadata.readiness.domain, 'STALE');
  assert.equal(change.metadata.readiness.spec, 'STALE');
  assert.equal(change.metadata.readiness.design, 'INVALIDATED');
  assert.equal(change.metadata.readiness.plan, 'INVALIDATED');
  assert.equal(change.metadata.readiness.review, 'MISSING');
  assert.equal(await pathExists(join(fixture.root, '.omnai/changes', created.directoryName, 'revisions/REV-0002.yaml')), true);
});

test('explicit readiness scope invalidates only the frozen readiness closure', async () => {
  const fixture = await createTestRepository();
  cleanups.push(fixture.cleanup);
  const created = await createChange(fixture.root, 'Authorization migration', 'complex-domain-feature');
  const change = await resolveChange(fixture.root, created.metadata.id);
  for (const key of ['domain', 'spec', 'design', 'plan', 'implementation', 'review', 'verification'] as const) {
    change.metadata.readiness[key] = 'READY';
  }
  await saveChange(fixture.root, change);

  const result = await reconcileChange(fixture.root, change, {
    level: 'L3',
    type: 'DOMAIN_ASSUMPTION_INVALIDATED',
    reason: 'Only consumer specification and design are affected in this repository',
    affectedReadiness: ['spec', 'design'],
  });

  assert.deepEqual(result.affectedReadiness, ['spec', 'design']);
  assert.equal(change.metadata.readiness.domain, 'READY');
  assert.equal(change.metadata.readiness.spec, 'STALE');
  assert.equal(change.metadata.readiness.design, 'INVALIDATED');
  assert.equal(change.metadata.readiness.plan, 'READY');
  assert.equal(change.metadata.readiness.implementation, 'READY');
  assert.equal(change.metadata.readiness.review, 'READY');
  assert.equal(change.metadata.readiness.verification, 'READY');
});

test('persists an external correlation id in reconcile lineage for idempotent recovery', async () => {
  const fixture = await createTestRepository();
  cleanups.push(fixture.cleanup);
  const created = await createChange(fixture.root, 'Authorization migration', 'complex-domain-feature');
  const change = await resolveChange(fixture.root, created.metadata.id);

  const result = await reconcileChange(fixture.root, change, {
    level: 'L3',
    type: 'WORKSET_REENTRY',
    reason: 'WRE-0001 project reconciliation',
    affectedReadiness: ['spec'],
    correlationId: 'WRE-0001/user',
  });

  assert.equal(result.signal.correlationId, 'WRE-0001/user');
  assert.equal(result.revision.correlationId, 'WRE-0001/user');

  const signalText = await readFile(
    join(changeRevisionsRoot(fixture.root, created.directoryName), `${result.signal.id}.signal.yaml`),
    'utf8',
  );
  const revisionText = await readFile(
    join(changeRevisionsRoot(fixture.root, created.directoryName), `${result.revision.id}.yaml`),
    'utf8',
  );
  const progressText = await readFile(changeArtifactPath(fixture.root, created.directoryName, 'progress.jsonl'), 'utf8');
  assert.match(signalText, /correlationId:\s*WRE-0001\/user/);
  assert.match(revisionText, /correlationId:\s*WRE-0001\/user/);
  assert.match(progressText, /WRE-0001\/user/);
});

test('reconcile lineage attributes only tasks affected by the current operation', async () => {
  const fixture = await createTestRepository();
  cleanups.push(fixture.cleanup);
  const created = await createChange(fixture.root, 'Authorization migration', 'complex-domain-feature');
  const tasksPath = changeArtifactPath(fixture.root, created.directoryName, 'tasks.yaml');
  const taskFile = await loadTasks(tasksPath);
  taskFile.tasks = [
    {
      id: 'TASK-001', title: 'Previously stale', objective: 'Unrelated earlier work', status: 'STALE', dependsOn: [], slice: 'VERTICAL', risk: 'LOW',
      files: { create: [], modify: [], tests: [] }, consumes: [], produces: [], steps: [], evidenceRequired: [], notes: [],
    },
    {
      id: 'TASK-002', title: 'Current scope', objective: 'Current affected task', status: 'DONE', dependsOn: [], slice: 'VERTICAL', risk: 'MEDIUM',
      files: { create: [], modify: [], tests: [] }, consumes: [], produces: [], steps: [], evidenceRequired: [], notes: [],
    },
  ];
  await saveTasks(tasksPath, taskFile);
  const change = await resolveChange(fixture.root, created.metadata.id);

  const result = await reconcileChange(fixture.root, change, {
    level: 'L3',
    type: 'WORKSET_REENTRY',
    reason: 'Only TASK-002 belongs to this frozen application',
    affectedReadiness: ['spec'],
    affectedTasks: ['TASK-002'],
    affectedTaskClosure: ['TASK-002'],
    correlationId: 'WRE-0001/user',
  });

  assert.deepEqual(result.affectedTasks, ['TASK-002']);
  assert.deepEqual(result.revision.affectedTasks, ['TASK-002']);
  const after = await loadTasks(tasksPath);
  assert.equal(after.tasks.find((task) => task.id === 'TASK-001')?.status, 'STALE');
  assert.equal(after.tasks.find((task) => task.id === 'TASK-002')?.status, 'NEEDS_REVALIDATION');
});
