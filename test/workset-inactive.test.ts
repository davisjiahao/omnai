import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { pathExists, readText } from '../src/core/files.js';
import { createTestDirectory, createTestRepository } from './helpers.js';
import { registerProject } from '../src/workspace/project-registry.js';
import { worksetVsCodePath } from '../src/workspace/paths.js';
import {
  activateWorksetProject,
  addWorksetCandidate,
  beginProjectResearch,
  createWorkset,
  markWorksetProjectInactive,
} from '../src/workspace/worksets.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

test('marking an active member inactive retains its worktree and removes its VS Code folder', async () => {
  const repo = await createTestRepository('user-center');
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(repo.cleanup, home.cleanup);
  await registerProject(home.root, repo.root, 'user');
  const workset = await createWorkset(home.root, 'Authorization Migration');
  await addWorksetCandidate(home.root, workset.id, 'user');
  await beginProjectResearch(home.root, workset.id, 'user');
  const active = await activateWorksetProject(home.root, workset.id, 'user');
  const worktree = active.members.find((item) => item.project === 'user')?.worktree;
  assert.ok(worktree);

  const inactive = await markWorksetProjectInactive(home.root, workset.id, 'user');
  assert.equal(inactive.members.find((item) => item.project === 'user')?.status, 'INACTIVE');
  assert.equal(await pathExists(worktree), true);

  const workspace = JSON.parse(await readText(worksetVsCodePath(home.root, inactive.id, inactive.slug)));
  assert.deepEqual(workspace.folders, []);
});
