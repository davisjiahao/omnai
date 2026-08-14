import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { pathExists } from '../src/core/files.js';
import { createAndActivateWorksetProjectChange } from '../src/workspace/change-bindings.js';
import { createTestDirectory, createTestRepository } from './helpers.js';
import { registerProject } from '../src/workspace/project-registry.js';
import {
  addWorksetCandidate,
  beginProjectResearch,
  createWorkset,
  markWorksetProjectInactive,
  worksetNext,
} from '../src/workspace/worksets.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

test('marking an active member inactive retains its worktree in place and removes write eligibility', async () => {
  const repo = await createTestRepository('user-center');
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(repo.cleanup, home.cleanup);
  await registerProject(home.root, repo.root, 'user');
  const workset = await createWorkset(home.root, 'Authorization Migration');
  await addWorksetCandidate(home.root, workset.id, 'user');
  await beginProjectResearch(home.root, workset.id, 'user');
  const active = (await createAndActivateWorksetProjectChange(
    home.root,
    workset.id,
    'user',
    'User Workset Change',
    'small-feature',
  )).workset;
  const activeMember = active.members.find((item) => item.project === 'user');
  assert.ok(activeMember?.worktree);
  assert.ok(activeMember.branch);

  const inactive = await markWorksetProjectInactive(home.root, workset.id, 'user');
  const inactiveMember = inactive.members.find((item) => item.project === 'user');
  assert.equal(inactiveMember?.status, 'INACTIVE');
  assert.equal(inactiveMember?.worktree, activeMember.worktree);
  assert.equal(inactiveMember?.branch, activeMember.branch);
  assert.equal(await pathExists(activeMember.worktree), true);
  assert.deepEqual(worksetNext(inactive), {
    action: 'none',
    reason: 'No Workset membership action is currently required.',
  });
});
