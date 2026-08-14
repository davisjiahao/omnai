import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathExists } from '../src/core/files.js';
import { worksetRoot, worksetWorkspaceRoot } from '../src/workspace/paths.js';
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

test('creates, inspects, and resolves an aggregate Workset path through the JSON CLI', async () => {
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(home.cleanup);

  const created = runCli(home.root, ['workset', 'new', 'Authorization Migration', '--json']);
  assert.equal(created.status, 0, created.stderr);
  const workset = JSON.parse(created.stdout);
  assert.equal(workset.id, 'WKS-0001');

  const status = runCli(home.root, ['workset', 'status', 'WKS-0001', '--json']);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).title, 'Authorization Migration');

  const pathResult = runCli(home.root, ['workset', 'path', 'WKS-0001', '--json']);
  assert.equal(pathResult.status, 0, pathResult.stderr);
  assert.deepEqual(JSON.parse(pathResult.stdout), {
    workset: 'WKS-0001',
    path: worksetWorkspaceRoot(home.root, 'WKS-0001'),
  });
});

test('runs candidate research activation into the aggregate directory without a code-workspace file', async () => {
  const home = await createTestDirectory('omnai-home-');
  const repo = await createTestRepository('user-center');
  cleanups.push(home.cleanup, repo.cleanup);

  const registered = runCli(home.root, ['project', 'register', repo.root, '--alias', 'user', '--json']);
  assert.equal(registered.status, 0, registered.stderr);
  assert.equal(JSON.parse(registered.stdout).alias, 'user');

  const created = runCli(home.root, ['workset', 'new', 'Authorization Migration', '--json']);
  assert.equal(created.status, 0, created.stderr);
  const workset = JSON.parse(created.stdout);

  const candidate = runCli(home.root, ['workset', 'add-candidate', 'user', '--json']);
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.equal(JSON.parse(candidate.stdout).members[0].status, 'CANDIDATE');

  const research = runCli(home.root, ['workset', 'inspect-project', 'user', '--json']);
  assert.equal(research.status, 0, research.stderr);
  assert.deepEqual(JSON.parse(research.stdout), {
    project: 'user',
    path: repo.root,
    readOnly: true,
    status: 'RESEARCH_ONLY',
  });

  const activated = runCli(home.root, ['workset', 'activate-project', 'user', '--json']);
  assert.equal(activated.status, 0, activated.stderr);
  const member = JSON.parse(activated.stdout);
  assert.equal(member.status, 'ACTIVE');
  assert.equal(member.worktree, `${worksetWorkspaceRoot(home.root, workset.id)}/user`);
  assert.equal(await pathExists(member.worktree), true);
  assert.notEqual(member.worktree, repo.root);

  const entries = await readdir(worksetRoot(home.root, workset.id));
  assert.equal(entries.some((entry) => entry.endsWith('.code-workspace')), false);
});
