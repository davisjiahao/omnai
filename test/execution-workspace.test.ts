import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { join } from 'node:path';
import { pathExists, readYaml } from '../src/core/files.js';
import { createTestDirectory } from './helpers.js';
import { createWorkset } from '../src/workspace/worksets.js';
import {
  discoverExecutionContext,
  ensureExecutionWorkspace,
} from '../src/workspace/execution-workspace.js';
import {
  worksetMarkerPath,
  worksetWorkspaceRoot,
} from '../src/workspace/paths.js';
import { z } from 'zod';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const markerSchema = z.object({
  schemaVersion: z.literal(1),
  worksetId: z.string(),
  manifest: z.string(),
});

test('creates one aggregate root with a Workset pointer marker', async () => {
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(home.cleanup);

  const workset = await createWorkset(home.root, 'Authorization Migration');
  const root = await ensureExecutionWorkspace(home.root, workset);

  assert.equal(root, worksetWorkspaceRoot(home.root, workset.id));
  const markerPath = worksetMarkerPath(home.root, workset.id);
  assert.equal(await pathExists(markerPath), true);
  assert.deepEqual(await readYaml(markerPath, markerSchema), {
    schemaVersion: 1,
    worksetId: workset.id,
    manifest: '../workset.yaml',
  });
});

test('discovers Workset scope at aggregate root and project scope below it', async () => {
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(home.cleanup);

  const workset = await createWorkset(home.root, 'Authorization Migration');
  const root = await ensureExecutionWorkspace(home.root, workset);

  assert.deepEqual(await discoverExecutionContext(root), {
    worksetId: workset.id,
    workspaceRoot: root,
  });
  assert.deepEqual(await discoverExecutionContext(join(root, 'user-center', 'src')), {
    worksetId: workset.id,
    workspaceRoot: root,
    project: 'user-center',
  });
});

test('returns null when a path is outside a Workset aggregate workspace', async () => {
  const directory = await createTestDirectory('outside-workset-');
  cleanups.push(directory.cleanup);

  assert.equal(await discoverExecutionContext(directory.root), null);
});
