import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createTestDirectory, createTestRepository } from './helpers.js';
import {
  listRegisteredProjects,
  registerProject,
  requireRegisteredProject,
} from '../src/workspace/project-registry.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

test('registers a Git repository with a stable alias', async () => {
  const repo = await createTestRepository('user-center');
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(repo.cleanup, home.cleanup);

  const project = await registerProject(home.root, repo.root, 'user');

  assert.equal(project.alias, 'user');
  assert.equal(project.name, 'user-center');
  assert.equal(project.path, repo.root);
  assert.deepEqual(await listRegisteredProjects(home.root), [project]);
  assert.deepEqual(await requireRegisteredProject(home.root, 'user'), project);
});

test('defaults the alias from the repository directory name', async () => {
  const repo = await createTestRepository('Quote Center');
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(repo.cleanup, home.cleanup);

  const project = await registerProject(home.root, repo.root);

  assert.equal(project.alias, 'quote-center');
});

test('re-registering the same repository is idempotent', async () => {
  const repo = await createTestRepository('user-center');
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(repo.cleanup, home.cleanup);

  const first = await registerProject(home.root, repo.root, 'user');
  const second = await registerProject(home.root, repo.root, 'other-alias');

  assert.deepEqual(second, first);
  assert.equal((await listRegisteredProjects(home.root)).length, 1);
});

test('rejects the same alias for a different repository', async () => {
  const first = await createTestRepository('user-center');
  const second = await createTestRepository('quote-center');
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(first.cleanup, second.cleanup, home.cleanup);

  await registerProject(home.root, first.root, 'service');
  await assert.rejects(() => registerProject(home.root, second.root, 'service'), /already registered/);
});

test('rejects a path that is not a Git repository', async () => {
  const directory = await createTestDirectory('not-git-');
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(directory.cleanup, home.cleanup);

  await assert.rejects(() => registerProject(home.root, directory.root, 'bad'), /Git repository/);
});
