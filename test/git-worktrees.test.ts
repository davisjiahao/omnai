import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathExists } from '../src/core/files.js';
import { createTestDirectory, createTestRepository } from './helpers.js';
import { registerProject } from '../src/workspace/project-registry.js';
import { createWorkset } from '../src/workspace/worksets.js';
import { worksetWorkspaceRoot } from '../src/workspace/paths.js';
import {
  createWorksetWorktree,
  worksetBranchName,
} from '../src/workspace/git-worktrees.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

test('derives one deterministic branch name per Workset', async () => {
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(home.cleanup);
  const workset = await createWorkset(home.root, 'Authorization Migration');
  assert.equal(worksetBranchName(workset), 'omnai/WKS-0001-authorization-migration');
});

test('creates an isolated Workset worktree from committed HEAD', async () => {
  const repo = await createTestRepository('user-center');
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(repo.cleanup, home.cleanup);
  await writeFile(join(repo.root, 'LOCAL_ONLY.txt'), 'dirty', 'utf8');

  const project = await registerProject(home.root, repo.root, 'user');
  const workset = await createWorkset(home.root, 'Authorization Migration');
  const result = await createWorksetWorktree(home.root, workset, project);

  assert.equal(await pathExists(join(result.path, 'README.md')), true);
  assert.equal(await pathExists(join(result.path, 'LOCAL_ONLY.txt')), false);
  assert.equal(await pathExists(join(repo.root, 'LOCAL_ONLY.txt')), true);
  assert.equal(result.branch, 'omnai/WKS-0001-authorization-migration');
  assert.match(result.sourceCommit, /^[0-9a-f]{40}$/);
});

test('reuses the expected existing Workset worktree for activation recovery', async () => {
  const repo = await createTestRepository('user-center');
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(repo.cleanup, home.cleanup);

  const project = await registerProject(home.root, repo.root, 'user');
  const workset = await createWorkset(home.root, 'Authorization Migration');
  const first = await createWorksetWorktree(home.root, workset, project);
  const second = await createWorksetWorktree(home.root, workset, project);

  assert.equal(second.path, first.path);
  assert.equal(second.branch, first.branch);
  assert.equal(await pathExists(second.path), true);
});

test('refuses to replace an unrelated existing target directory', async () => {
  const repo = await createTestRepository('user-center');
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(repo.cleanup, home.cleanup);

  const project = await registerProject(home.root, repo.root, 'user');
  const workset = await createWorkset(home.root, 'Authorization Migration');
  const target = join(worksetWorkspaceRoot(home.root, workset.id), 'user');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'KEEP.txt'), 'keep', 'utf8');

  await assert.rejects(
    () => createWorksetWorktree(home.root, workset, project),
    /target.*already exists/i,
  );
  assert.equal(await pathExists(join(target, 'KEEP.txt')), true);
});
