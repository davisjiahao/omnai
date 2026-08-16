import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createTestDirectory } from './helpers.js';
import { createWorkset, resolveWorkset } from '../src/workspace/worksets.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

test('creates and resolves a Workset whose title contains Chinese characters', async () => {
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(home.cleanup);

  const workset = await createWorkset(home.root, '授权迁移');

  assert.equal(workset.id, 'WKS-0001');
  assert.equal(workset.title, '授权迁移');
  assert.equal(workset.slug, '授权迁移');
  assert.equal((await resolveWorkset(home.root, '授权迁移')).id, workset.id);
});
