import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { pathExists } from '../src/core/files.js';
import { hostManifestPath } from '../src/workspace/paths.js';
import { createTestDirectory } from './helpers.js';

const ENTRY_SKILLS = ['omnai', 'omnai-grill', 'omnai-brainstorm', 'omnai-reconcile'] as const;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function createHomes() {
  const omnaiHome = await createTestDirectory('omnai-home-');
  const userHome = await createTestDirectory('user-home-');
  cleanups.push(userHome.cleanup, omnaiHome.cleanup);
  return { omnaiHome: omnaiHome.root, userHome: userHome.root };
}

function runCli(omnaiHome: string, userHome: string, args: string[]) {
  return spawnSync(process.execPath, [resolve('dist/src/main.js'), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      OMNAI_HOME: omnaiHome,
      HOME: userHome,
      USERPROFILE: userHome,
    },
  });
}

function runJson(omnaiHome: string, userHome: string, args: string[]) {
  const result = runCli(omnaiHome, userHome, [...args, '--json']);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('host status defaults to all three Hosts and reports NOT_INSTALLED', async () => {
  const { omnaiHome, userHome } = await createHomes();
  const statuses = runJson(omnaiHome, userHome, ['host', 'status']);
  assert.deepEqual(statuses.map((item: { host: string; status: string }) => [item.host, item.status]), [
    ['claude', 'NOT_INSTALLED'],
    ['codex', 'NOT_INSTALLED'],
    ['opencode', 'NOT_INSTALLED'],
  ]);
});

test('host install codex writes exactly four Skills to the native user directory', async () => {
  const { omnaiHome, userHome } = await createHomes();
  const results = runJson(omnaiHome, userHome, ['host', 'install', 'codex']);
  assert.equal(results.length, 1);
  assert.equal(results[0].host, 'codex');
  assert.equal(results[0].action, 'INSTALLED');

  const root = join(userHome, '.agents', 'skills');
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(entries, [...ENTRY_SKILLS].sort());
  for (const skill of ENTRY_SKILLS) {
    assert.equal(await pathExists(join(root, skill, 'SKILL.md')), true);
  }
  assert.equal(await pathExists(join(userHome, '.codex', 'skills')), false);
  assert.equal(await pathExists(hostManifestPath(omnaiHome, 'codex')), true);

  const status = runJson(omnaiHome, userHome, ['host', 'status', 'codex']);
  assert.equal(status.length, 1);
  assert.equal(status[0].status, 'READY');
});

test('host install all writes three manifests and twelve canonical Skill files', async () => {
  const { omnaiHome, userHome } = await createHomes();
  const results = runJson(omnaiHome, userHome, ['host', 'install', 'all']);
  assert.deepEqual(results.map((item: { host: string }) => item.host), ['claude', 'codex', 'opencode']);

  const destinations = [
    join(userHome, '.claude', 'skills'),
    join(userHome, '.agents', 'skills'),
    join(userHome, '.config', 'opencode', 'skills'),
  ];
  for (const destination of destinations) {
    for (const skill of ENTRY_SKILLS) {
      assert.equal(await pathExists(join(destination, skill, 'SKILL.md')), true, `${destination}/${skill}`);
    }
  }
  for (const host of ['claude', 'codex', 'opencode']) {
    assert.equal(await pathExists(hostManifestPath(omnaiHome, host)), true, host);
  }
  assert.deepEqual(
    runJson(omnaiHome, userHome, ['host', 'status', 'all'])
      .map((item: { host: string; status: string }) => [item.host, item.status]),
    [['claude', 'READY'], ['codex', 'READY'], ['opencode', 'READY']],
  );
});

test('host commands reject an unsupported Host', async () => {
  const { omnaiHome, userHome } = await createHomes();
  const install = runCli(omnaiHome, userHome, ['host', 'install', 'unknown', '--json']);
  assert.notEqual(install.status, 0);
  assert.match(install.stderr, /unknown|unsupported|invalid/i);

  const status = runCli(omnaiHome, userHome, ['host', 'status', 'unknown', '--json']);
  assert.notEqual(status.status, 0);
  assert.match(status.stderr, /unknown|unsupported|invalid/i);
});
