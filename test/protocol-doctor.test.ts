import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { PROTOCOL_IDS } from '../src/protocols/index.js';
import { createTestDirectory, createTestRepository } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function createEnvironment() {
  const omnaiHome = await createTestDirectory('omnai-home-');
  const userHome = await createTestDirectory('user-home-');
  const repo = await createTestRepository('doctor-repo');
  cleanups.push(repo.cleanup, userHome.cleanup, omnaiHome.cleanup);
  return { omnaiHome: omnaiHome.root, userHome: userHome.root, repo: repo.root };
}

function runCli(
  omnaiHome: string,
  userHome: string,
  cwd: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
) {
  return spawnSync(process.execPath, [resolve('dist/src/main.js'), ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      OMNAI_HOME: omnaiHome,
      HOME: userHome,
      USERPROFILE: userHome,
      ...extraEnv,
    },
  });
}

test('doctor validates all packaged protocols before repository artifacts', async () => {
  const fixture = await createEnvironment();
  const initialized = runCli(fixture.omnaiHome, fixture.userHome, fixture.repo, ['init']);
  assert.equal(initialized.status, 0, initialized.stderr);

  const result = runCli(fixture.omnaiHome, fixture.userHome, fixture.repo, ['doctor']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`PASS protocols: ${PROTOCOL_IDS.length}`));
  assert.match(result.stdout, /PASS git repository:/);
  assert.match(result.stdout, /PASS config:/);
  assert.ok(
    result.stdout.indexOf(`PASS protocols: ${PROTOCOL_IDS.length}`) < result.stdout.indexOf('PASS config:'),
    'protocol inventory should be validated before repository artifacts',
  );
});

test('doctor fails with the explicit ProtocolError when an injected test inventory is invalid', async () => {
  const fixture = await createEnvironment();
  const protocolFixture = await createTestDirectory('omnai-protocol-root-');
  cleanups.push(protocolFixture.cleanup);
  await cp(join(process.cwd(), 'resources', 'protocols'), protocolFixture.root, { recursive: true });
  await writeFile(
    join(protocolFixture.root, 'repository', 'design.md'),
    '---\nschemaVersion: 1\nid: repository.spec\nversion: 1\nkind: repository-capability\ncapability: design\n---\n\n# Invalid design protocol\n',
    'utf8',
  );

  const initialized = runCli(fixture.omnaiHome, fixture.userHome, fixture.repo, ['init']);
  assert.equal(initialized.status, 0, initialized.stderr);
  const result = runCli(
    fixture.omnaiHome,
    fixture.userHome,
    fixture.repo,
    ['doctor'],
    { OMNAI_PROTOCOL_ROOT: protocolFixture.root },
  );

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /PROTOCOL_METADATA_INVALID/);
  assert.doesNotMatch(result.stdout, /PASS config:/);
});

test('the npm package contains all protocols and exactly four Host Skill files', async () => {
  const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
    files?: string[];
  };
  assert.ok(packageJson.files?.includes('resources'));
  assert.deepEqual(
    packageJson.files,
    [...new Set(packageJson.files)],
    'package.json files entries must be unique',
  );

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packed = spawnSync(npm, ['pack', '--dry-run', '--json'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(packed.status, 0, packed.stderr);
  const result = JSON.parse(packed.stdout) as Array<{ files?: Array<{ path: string }> }>;
  const files = result[0]?.files?.map((item) => item.path) ?? [];

  const protocols = files.filter((path) => path.startsWith('resources/protocols/') && path.endsWith('.md'));
  assert.equal(protocols.length, PROTOCOL_IDS.length);
  assert.ok(protocols.includes('resources/protocols/common/authoritative-work.md'));
  assert.ok(protocols.includes('resources/protocols/interaction/show-me.md'));

  const skillFiles = files
    .filter((path) => /^skills\/[^/]+\/SKILL\.md$/.test(path))
    .sort();
  assert.deepEqual(skillFiles, [
    'skills/omnai-brainstorm/SKILL.md',
    'skills/omnai-grill/SKILL.md',
    'skills/omnai-reconcile/SKILL.md',
    'skills/omnai/SKILL.md',
  ]);
});
