import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkset } from '../src/workspace/worksets.js';
import { createTestDirectory } from './helpers.js';
import { worksetBranchName } from '../src/workspace/git-worktrees.js';

test('derives one deterministic branch name per Workset', async () => {
  const home = await createTestDirectory('omnai-home-');
  try {
    const workset = await createWorkset(home.root, 'Authorization Migration');
    assert.equal(worksetBranchName(workset), 'omnai/WKS-0001-authorization-migration');
  } finally {
    await home.cleanup();
  }
});
