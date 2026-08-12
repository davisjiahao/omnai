import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { join } from 'node:path';
import { createTestRepository } from './helpers.js';
import { createChange, initializeProject, listChanges, loadProjectConfig } from '../src/core/store.js';
import { pathExists, readText } from '../src/core/files.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

test('initializes repository-local OmnAI state', async () => {
  const fixture = await createTestRepository();
  cleanups.push(fixture.cleanup);
  const config = await initializeProject(fixture.root);

  assert.equal(config.project, fixture.root.split('/').at(-1));
  assert.equal(await pathExists(join(fixture.root, '.omnai/config.yaml')), true);
  assert.equal(await pathExists(join(fixture.root, '.omnai/workflow.lock.yaml')), true);
  assert.match(await readText(join(fixture.root, '.omnai/project/policies.md')), /Evidence/);
});

test('creates a canonical change with all core artifacts and selects it', async () => {
  const fixture = await createTestRepository();
  cleanups.push(fixture.cleanup);
  const change = await createChange(fixture.root, 'Authorization migration', 'domain-feature');

  assert.equal(change.metadata.id, 'CHG-0001');
  assert.equal(change.metadata.scenario, 'domain-feature');
  for (const artifact of ['intent.md', 'research.md', 'domain.md', 'spec.md', 'design.md', 'tasks.yaml', 'progress.jsonl']) {
    assert.equal(await pathExists(join(fixture.root, '.omnai/changes', change.directoryName, artifact)), true);
  }
  assert.equal((await loadProjectConfig(fixture.root)).activeChange, 'CHG-0001');
  assert.equal((await listChanges(fixture.root)).length, 1);
});
