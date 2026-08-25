import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { pathExists, readYaml, writeYaml } from '../src/core/files.js';
import { defaultAgentProfileForHost } from '../src/execution/agents/profiles.js';
import { userHostManifestSchema } from '../src/host/user-host-skills.js';
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

function runCli(
  omnaiHome: string,
  userHome: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
) {
  return spawnSync(process.execPath, [resolve('dist/src/main.js'), ...args], {
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
  assert.equal(await pathExists(join(root, 'resources')), false);
  assert.equal(await pathExists(join(root, 'protocols')), false);
  assert.equal(await pathExists(join(userHome, '.codex', 'skills')), false);
  assert.equal(await pathExists(hostManifestPath(omnaiHome, 'codex')), true);
  const manifest = await readYaml(hostManifestPath(omnaiHome, 'codex'), userHostManifestSchema);
  assert.deepEqual(manifest.skills.map((item) => item.name), [...ENTRY_SKILLS]);

  const status = runJson(omnaiHome, userHome, ['host', 'status', 'codex']);
  assert.equal(status.length, 1);
  assert.equal(status[0].status, 'READY');
});

test('host install all writes three manifests and twelve canonical Skill files without protocol resources', async () => {
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
    assert.equal(await pathExists(join(destination, 'resources')), false, destination);
    assert.equal(await pathExists(join(destination, 'protocols')), false, destination);
  }
  for (const host of ['claude', 'codex', 'opencode'] as const) {
    const path = hostManifestPath(omnaiHome, host);
    assert.equal(await pathExists(path), true, host);
    const manifest = await readYaml(path, userHostManifestSchema);
    assert.deepEqual(manifest.skills.map((item) => item.name), [...ENTRY_SKILLS]);
  }
  assert.deepEqual(
    runJson(omnaiHome, userHome, ['host', 'status', 'all'])
      .map((item: { host: string; status: string }) => [item.host, item.status]),
    [['claude', 'READY'], ['codex', 'READY'], ['opencode', 'READY']],
  );
});

test('host status JSON probes each configured Agent and exposes only the non-secret readiness whitelist', async () => {
  const { omnaiHome, userHome } = await createHomes();
  assert.equal(runCli(omnaiHome, userHome, ['host', 'install', 'codex', '--json']).status, 0);
  const bin = join(userHome, 'bin');
  await mkdir(bin, { recursive: true });
  const executable = join(bin, 'ready-agent.mjs');
  await writeFile(executable, String.raw`
process.stderr.write(process.env.API_TOKEN ?? '');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    const result = request.method === 'initialize'
      ? { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {} } } }
      : { sessions: [] };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  }
});
process.stdin.on('end', () => process.exit(0));
`, 'utf8');
  const brokenExecutable = join(userHome, 'broken-agent-directory');
  await mkdir(brokenExecutable, { recursive: true });

  const manifestPath = hostManifestPath(omnaiHome, 'codex');
  const manifest = await readYaml(manifestPath, userHostManifestSchema);
  const ready = {
    ...defaultAgentProfileForHost('codex'),
    agentId: 'ready-agent',
    command: process.execPath,
    args: [executable, '--token', 'argument-must-not-leak'],
    envRefs: { API_TOKEN: 'SUPER_SECRET_REF' },
  };
  const broken = {
    ...defaultAgentProfileForHost('codex'),
    agentId: 'broken-agent',
    command: brokenExecutable,
    envRefs: { OTHER_TOKEN: 'OTHER_SECRET_REF' },
  };
  await writeYaml(manifestPath, { ...manifest, agents: [ready, broken] });

  const result = runCli(
    omnaiHome,
    userHome,
    ['host', 'status', 'codex', '--json'],
    { SUPER_SECRET_REF: 'resolved-value-must-not-leak' },
  );
  assert.equal(result.status, 0, result.stderr);
  const statuses = JSON.parse(result.stdout) as Array<{ agents: Array<Record<string, unknown>> }>;
  assert.equal(statuses.length, 1);
  assert.deepEqual(statuses[0]?.agents.map((item) => item.agentId), ['ready-agent', 'broken-agent']);
  assert.deepEqual(
    statuses[0]?.agents.map((item) => Object.keys(item).sort()),
    [
      ['activeSessions', 'agentId', 'authenticated', 'available', 'isolation', 'maxParallelSessions', 'protocol', 'protocolVersion'],
      ['activeSessions', 'agentId', 'authenticated', 'available', 'isolation', 'maxParallelSessions', 'protocol', 'protocolVersion'],
    ],
  );
  assert.equal(statuses[0]?.agents[0]?.available, true);
  assert.equal(statuses[0]?.agents[0]?.authenticated, true);
  assert.equal(statuses[0]?.agents[1]?.available, false);
  for (const forbidden of [
    executable,
    brokenExecutable,
    'argument-must-not-leak',
    'SUPER_SECRET_REF',
    'OTHER_SECRET_REF',
    'resolved-value-must-not-leak',
    'API_TOKEN',
    'OTHER_TOKEN',
  ]) {
    assert.equal(result.stdout.includes(forbidden), false, forbidden);
  }
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
