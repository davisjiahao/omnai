import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { loadProtocolBundle } from '../src/protocols/index.js';
import { createTestDirectory } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function createEnvironment() {
  const cwd = await createTestDirectory('protocol-cli-cwd-');
  const omnaiHome = await createTestDirectory('protocol-cli-omnai-home-');
  const userHome = await createTestDirectory('protocol-cli-user-home-');
  cleanups.push(userHome.cleanup, omnaiHome.cleanup, cwd.cleanup);
  return { cwd: cwd.root, omnaiHome: omnaiHome.root, userHome: userHome.root };
}

function runCli(
  environment: Awaited<ReturnType<typeof createEnvironment>>,
  args: string[],
) {
  return spawnSync(process.execPath, [resolve('dist/src/main.js'), ...args], {
    cwd: environment.cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      OMNAI_HOME: environment.omnaiHome,
      HOME: environment.userHome,
      USERPROFILE: environment.userHome,
    },
  });
}

test('protocol show returns common plus the requested protocol without local source paths', async () => {
  const environment = await createEnvironment();
  const result = runCli(environment, ['protocol', 'show', 'repository.design', '--json']);
  assert.equal(result.status, 0, result.stderr);

  const parsed = JSON.parse(result.stdout) as {
    schemaVersion: number;
    protocols: Array<Record<string, unknown> & { id: string }>;
    rendered: string;
  };
  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual(parsed.protocols.map((item) => item.id), [
    'common.authoritative-work',
    'repository.design',
  ]);
  assert.equal('sourcePath' in parsed.protocols[0]!, false);
  assert.match(parsed.rendered, /protocol:repository\.design@1/);
});

test('protocol show preserves requested order and deduplicates repeated IDs', async () => {
  const environment = await createEnvironment();
  const result = runCli(environment, [
    'protocol',
    'show',
    'interaction.grill',
    'repository.model',
    'interaction.grill',
    '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as { protocols: Array<{ id: string }> };
  assert.deepEqual(parsed.protocols.map((item) => item.id), [
    'common.authoritative-work',
    'interaction.grill',
    'repository.model',
  ]);
});

test('human protocol output equals the canonical rendered bundle', async () => {
  const environment = await createEnvironment();
  const result = runCli(environment, ['protocol', 'show', 'repository.design']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, (await loadProtocolBundle(['repository.design'])).rendered);
});

test('unknown protocol IDs fail with PROTOCOL_UNKNOWN', async () => {
  const environment = await createEnvironment();
  const result = runCli(environment, ['protocol', 'show', '../../secrets', '--json']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PROTOCOL_UNKNOWN/);
});

test('protocol show works outside Git and does not write cwd, HOME, or OMNAI_HOME', async () => {
  const environment = await createEnvironment();
  const before = await snapshot(environment);

  const result = runCli(environment, ['protocol', 'show', 'repository.research', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((JSON.parse(result.stdout) as { protocols: Array<{ id: string }> }).protocols.at(-1)?.id, 'repository.research');
  assert.deepEqual(await snapshot(environment), before);
});

async function snapshot(environment: Awaited<ReturnType<typeof createEnvironment>>) {
  return {
    cwd: await entries(environment.cwd),
    omnaiHome: await entries(environment.omnaiHome),
    userHome: await entries(environment.userHome),
  };
}

async function entries(root: string): Promise<string[]> {
  return (await readdir(root, { recursive: true })).map(String).sort();
}
