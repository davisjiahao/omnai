import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathExists } from '../src/core/files.js';
import { worksetWorkspaceRoot } from '../src/workspace/paths.js';
import { createTestDirectory, createTestRepository } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function runCli(home: string, args: string[]) {
  return spawnSync(process.execPath, [resolve('dist/src/main.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, OMNAI_HOME: home },
  });
}

test('mark-inactive retains the Worktree in the aggregate directory', async () => {
  const home = await createTestDirectory('omnai-home-');
  const repo = await createTestRepository('user-center');
  cleanups.push(home.cleanup, repo.cleanup);

  assert.equal(runCli(home.root, ['project', 'register', repo.root, '--alias', 'user', '--json']).status, 0);
  const created = runCli(home.root, ['workset', 'new', 'Authorization Migration', '--json']);
  assert.equal(created.status, 0, created.stderr);
  const workset = JSON.parse(created.stdout);
  assert.equal(runCli(home.root, ['workset', 'add-candidate', 'user', '--json']).status, 0);
  assert.equal(runCli(home.root, ['workset', 'inspect-project', 'user', '--json']).status, 0);
  const createdChange = runCli(home.root, [
    'workset', 'create-change', 'user', 'Authorization ownership', '--scenario', 'small-feature', '--json',
  ]);
  assert.equal(createdChange.status, 0, createdChange.stderr);
  const activeMember = JSON.parse(createdChange.stdout).member;

  const inactive = runCli(home.root, ['workset', 'mark-inactive', 'user', '--json']);
  assert.equal(inactive.status, 0, inactive.stderr);
  const inactiveMember = JSON.parse(inactive.stdout);
  assert.equal(inactiveMember.status, 'INACTIVE');
  assert.equal(inactiveMember.worktree, activeMember.worktree);
  assert.equal(inactiveMember.branch, activeMember.branch);
  assert.equal(await pathExists(activeMember.worktree), true);

  const pathResult = runCli(home.root, ['workset', 'path', workset.id, '--json']);
  assert.equal(pathResult.status, 0, pathResult.stderr);
  assert.deepEqual(JSON.parse(pathResult.stdout), {
    workset: workset.id,
    path: worksetWorkspaceRoot(home.root, workset.id),
  });
});
