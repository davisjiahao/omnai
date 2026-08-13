import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createTestDirectory } from './helpers.js';

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

test('creates and inspects a Workset through the JSON CLI', async () => {
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(home.cleanup);

  const created = runCli(home.root, ['workset', 'new', 'Authorization Migration', '--json']);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).id, 'WKS-0001');

  const status = runCli(home.root, ['workset', 'status', 'WKS-0001', '--json']);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).title, 'Authorization Migration');
});
