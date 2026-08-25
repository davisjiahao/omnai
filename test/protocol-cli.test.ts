import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
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
  await Promise.all([
    writeSentinel(cwd.root, '.git/HEAD', 'ref: refs/heads/show-me-test\n'),
    writeSentinel(cwd.root, '.omnai/changes/CHG-0001/readiness.yaml', 'design: READY\n'),
    writeSentinel(cwd.root, '.omnai/investigations/INV-0001/research.md', 'known evidence\n'),
    writeSentinel(cwd.root, '.omnai/runs/RUN-0001/run.yaml', 'status: PREPARED\n'),
    writeSentinel(omnaiHome.root, 'worksets/WKS-0001/workset.yaml', 'status: OPEN\n'),
    writeSentinel(omnaiHome.root, 'preferences.yaml', 'visualFrequency: unset\n'),
    writeSentinel(userHome.root, '.config/omnai/sentinel', 'unchanged\n'),
  ]);
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
  assert.match(parsed.rendered, /protocol:repository\.design@3/);
});

test('protocol show preserves requested order and deduplicates repeated IDs', async () => {
  const environment = await createEnvironment();
  const result = runCli(environment, [
    'protocol',
    'show',
    'repository.model',
    'repository.design',
    'repository.model',
    '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as { protocols: Array<{ id: string }> };
  assert.deepEqual(parsed.protocols.map((item) => item.id), [
    'common.authoritative-work',
    'repository.model',
    'repository.design',
  ]);
});

test('protocol show renders the Show-me overlay alone through the closed catalog', async () => {
  const environment = await createEnvironment();
  const result = runCli(environment, ['protocol', 'show', 'interaction.show-me', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const parsed = JSON.parse(result.stdout) as {
    protocols: Array<Record<string, unknown> & { id: string }>;
    rendered: string;
  };
  assert.deepEqual(parsed.protocols.map((item) => item.id), [
    'common.authoritative-work',
    'interaction.show-me',
  ]);
  assert.equal(parsed.protocols.some((item) => 'sourcePath' in item), false);
  assert.match(parsed.rendered, /protocol:interaction\.show-me@1/);
});

test('protocol show composes Show-me before Core-selected repository guidance', async () => {
  const environment = await createEnvironment();
  const result = runCli(environment, [
    'protocol', 'show', 'interaction.show-me', 'repository.design', '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const parsed = JSON.parse(result.stdout) as { protocols: Array<{ id: string }> };
  assert.deepEqual(parsed.protocols.map((item) => item.id), [
    'common.authoritative-work',
    'interaction.show-me',
    'repository.design',
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

  const result = runCli(environment, ['protocol', 'show', 'interaction.show-me', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((JSON.parse(result.stdout) as { protocols: Array<{ id: string }> }).protocols.at(-1)?.id, 'interaction.show-me');
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
  return walk(root);
}

async function walk(root: string, relative = ''): Promise<string[]> {
  const current = join(root, relative);
  const results: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const child = join(relative, entry.name);
    if (entry.isDirectory()) {
      results.push(`directory:${child}`);
      results.push(...await walk(root, child));
      continue;
    }
    if (entry.isFile()) {
      results.push(`file:${child}:${(await readFile(join(root, child))).toString('base64')}`);
      continue;
    }
    results.push(`other:${child}`);
  }
  return results.sort();
}

async function writeSentinel(root: string, relativePath: string, content: string): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}
