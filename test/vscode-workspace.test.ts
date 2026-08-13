import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readText } from '../src/core/files.js';
import { createTestDirectory, createTestRepository } from './helpers.js';
import { registerProject } from '../src/workspace/project-registry.js';
import { worksetVsCodePath } from '../src/workspace/paths.js';
import {
  activateWorksetProject,
  addWorksetCandidate,
  beginProjectResearch,
  createWorkset,
} from '../src/workspace/worksets.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

test('activating a researched project creates a worktree and VS Code folder', async () => {
  const repo = await createTestRepository('user-center');
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(repo.cleanup, home.cleanup);
  await registerProject(home.root, repo.root, 'user');
  const workset = await createWorkset(home.root, 'Authorization Migration');
  await addWorksetCandidate(home.root, workset.id, 'user');
  await beginProjectResearch(home.root, workset.id, 'user');

  const active = await activateWorksetProject(home.root, workset.id, 'user');
  const member = active.members.find((item) => item.project === 'user');
  assert.equal(member?.status, 'ACTIVE');
  assert.ok(member?.worktree);
  assert.ok(member?.branch);

  const workspace = JSON.parse(await readText(worksetVsCodePath(home.root, active.id, active.slug)));
  assert.deepEqual(workspace.settings, { 'omnai.worksetId': active.id });
  assert.deepEqual(workspace.folders, [{ name: 'user', path: member.worktree }]);
});
