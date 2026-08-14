import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { pathExists } from '../src/core/files.js';
import { createTestDirectory } from './helpers.js';
import { createWorkset } from '../src/workspace/worksets.js';
import { worksetReentryPath } from '../src/workspace/paths.js';
import {
  listWorksetReentries,
  pendingWorksetReentry,
  recordWorksetReentry,
  resolveWorksetReentry,
} from '../src/workspace/reentry.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

test('persists monotonic Workset Re-entry records and reloads them in order', async () => {
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(home.cleanup);
  const workset = await createWorkset(home.root, 'Authorization Migration');

  const first = await recordWorksetReentry(home.root, workset.id, {
    kind: 'DOMAIN_CHANGED',
    reason: 'Historical quotes must preserve authorization state at quote time.',
  });
  const second = await recordWorksetReentry(home.root, workset.id, {
    kind: 'TECHNICAL_CONSTRAINT_CHANGED',
    reason: 'Database dual-write is no longer allowed.',
  });

  assert.equal(first.id, 'WRE-0001');
  assert.equal(second.id, 'WRE-0002');
  assert.equal(first.status, 'PENDING');
  assert.equal(first.route.capability, 'model');
  assert.equal(first.route.interaction, 'grill');
  assert.equal(await pathExists(worksetReentryPath(home.root, workset.id, first.id)), true);

  const records = await listWorksetReentries(home.root, workset.id);
  assert.deepEqual(records.map((item) => item.id), ['WRE-0001', 'WRE-0002']);
  assert.deepEqual(records.map((item) => item.reason), [
    'Historical quotes must preserve authorization state at quote time.',
    'Database dual-write is no longer allowed.',
  ]);
  assert.equal((await pendingWorksetReentry(home.root, workset.id))?.id, 'WRE-0001');
});

test('resolves a pending Re-entry without rewriting its original route or reason', async () => {
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(home.cleanup);
  const workset = await createWorkset(home.root, 'Authorization Migration');
  const created = await recordWorksetReentry(home.root, workset.id, {
    kind: 'SCOPE_CHANGED',
    reason: 'The Web client is now in scope.',
    affectedProjects: [],
    candidateProjects: [],
  });

  const resolved = await resolveWorksetReentry(home.root, workset.id, created.id);
  assert.equal(resolved.status, 'RESOLVED');
  assert.ok(resolved.resolvedAt);
  assert.equal(resolved.reason, created.reason);
  assert.deepEqual(resolved.route, created.route);
  assert.deepEqual(resolved.affectedProjects, []);
  assert.deepEqual(resolved.candidateProjects, []);
  assert.equal(await pendingWorksetReentry(home.root, workset.id), null);

  const again = await resolveWorksetReentry(home.root, workset.id, created.id);
  assert.deepEqual(again, resolved);
});

test('fails explicitly for unknown Worksets and Re-entry ids', async () => {
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(home.cleanup);
  const workset = await createWorkset(home.root, 'Authorization Migration');

  await assert.rejects(
    () => recordWorksetReentry(home.root, 'WKS-9999', {
      kind: 'PLAN_CHANGED',
      reason: 'Delivery order changed.',
    }),
    /Workset 'WKS-9999' was not found/,
  );

  await assert.rejects(
    () => resolveWorksetReentry(home.root, workset.id, 'WRE-9999'),
    /Re-entry 'WRE-9999' was not found/,
  );
});
