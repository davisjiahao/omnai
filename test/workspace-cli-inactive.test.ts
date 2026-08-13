import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathExists, readText } from '../src/core/files.js';
import { worksetVsCodePath } from '../src/workspace/paths.js';
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

test('deactivate-project retains the Worktree while removing it from the VS Code workspace', async () => {
  const home = await createTestDirectory('omnai-home-');
  const repo = await createTestRepository('user-center');
  cleanups.push(home.cleanup, repo.cleanup);

  assert.equal(runCli(home.root, ['project', 'register', repo.root, '--alias', 'user', '--json']).status, 0);
  const created = runCli(home.root, ['workset', 'new', 'Authorization Migration', '--json']);
  assert.equal(created.status, 0, created.stderr);
  const workset = JSON.parse(created.stdout);
  assert.equal(runCli(home.root, ['workset', 'add-candidate', 'user', '--json']).status, 0);
  assert.equal(runCli(home.root, ['workset', 'inspect-project', 'user', '--json']).status, 0);
  const activated = runCli(home.root, ['workset', 'activate-project', 'user', '--json']);
  assert.equal(activated.status, 0, activated.stderr);
  const activeMember = JSON.parse(activated.stdout);

  const inactive = runCli(home.root, ['workset', 'deactivate-project', 'user', '--json']);
  assert.equal(inactive.status, 0, inactive.stderr);
  const inactiveMember = JSON.parse(inactive.stdout);
  assert.equal(inactiveMember.status, 'INACTIVE');
  assert.equal(await pathExists(activeMember.worktree), true);

  const workspace = JSON.parse(await readText(worksetVsCodePath(home.root, workset.id, workset.slug)));
  assert.deepEqual(workspace.folders, []);
});
