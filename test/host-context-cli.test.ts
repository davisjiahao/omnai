import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { createAndActivateWorksetProjectChange } from '../src/workspace/change-bindings.js';
import { registerProject } from '../src/workspace/project-registry.js';
import {
  addWorksetCandidate,
  beginProjectResearch,
  createWorkset,
} from '../src/workspace/worksets.js';
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

test('context --json emits one none-scope object outside Git', async () => {
  const home = await createTestDirectory('omnai-home-');
  const outside = await createTestDirectory('outside-omnai-');
  cleanups.push(outside.cleanup, home.cleanup);

  const result = runCli(home.root, ['context', '--path', outside.root, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    scope: 'none',
    cwd: outside.root,
  });
});

test('context --json emits Workset project identity from a nested child path', async () => {
  const home = await createTestDirectory('omnai-home-');
  const repo = await createTestRepository('user-center');
  cleanups.push(repo.cleanup, home.cleanup);
  await registerProject(home.root, repo.root, 'user');
  const workset = await createWorkset(home.root, 'Authorization Migration');
  await addWorksetCandidate(home.root, workset.id, 'user');
  await beginProjectResearch(home.root, workset.id, 'user');
  const active = await createAndActivateWorksetProjectChange(
    home.root,
    workset.id,
    'user',
    'Build Authorization ownership',
    'small-feature',
  );
  const member = active.workset.members.find((item) => item.project === 'user');
  assert.ok(member?.worktree);
  assert.ok(member.changeId);
  const nested = join(member.worktree, 'src');
  await mkdir(nested, { recursive: true });

  const result = runCli(home.root, ['context', '--path', nested, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.scope, 'workset-project');
  assert.equal(parsed.worksetId, workset.id);
  assert.equal(parsed.project, 'user');
  assert.equal(parsed.changeId, member.changeId);
  assert.equal(parsed.repoRoot, member.worktree);
});
