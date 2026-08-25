import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import YAML from 'yaml';
import { pathExists, readYaml } from '../src/core/files.js';
import {
  ENTRY_SKILLS,
  USER_HOSTS,
  getUserHostSkillStatus,
  hostSkillDestination,
  installUserHostSkills,
  listUserHostSkillStatuses,
  userHostManifestSchema,
} from '../src/host/user-host-skills.js';
import { hostManifestPath } from '../src/workspace/paths.js';
import { createTestDirectory } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function createCanonicalSkillsFixture() {
  const fixture = await createTestDirectory('omnai-skills-');
  cleanups.push(fixture.cleanup);
  for (const skill of ENTRY_SKILLS) {
    const directory = join(fixture.root, skill);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'SKILL.md'),
      `---\nname: ${skill}\ndescription: Use when testing ${skill}.\n---\n\n# ${skill}\n\nCanonical ${skill}.\n`,
      'utf8',
    );
  }
  return fixture.root;
}

async function createHomes() {
  const omnaiHome = await createTestDirectory('omnai-home-');
  const userHome = await createTestDirectory('user-home-');
  cleanups.push(userHome.cleanup, omnaiHome.cleanup);
  return { omnaiHome: omnaiHome.root, userHome: userHome.root };
}

function sha256(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

test('uses native user-level Skill destinations and exactly four canonical entry Skills', () => {
  assert.deepEqual(USER_HOSTS, ['claude', 'codex', 'opencode']);
  assert.deepEqual(ENTRY_SKILLS, ['omnai', 'omnai-grill', 'omnai-brainstorm', 'omnai-reconcile']);
  assert.equal(ENTRY_SKILLS.includes('omnai-run' as never), false);

  assert.equal(hostSkillDestination('/Users/me', 'claude'), '/Users/me/.claude/skills');
  assert.equal(hostSkillDestination('/Users/me', 'codex'), '/Users/me/.agents/skills');
  assert.equal(hostSkillDestination('/Users/me', 'opencode'), '/Users/me/.config/opencode/skills');
});

test('first install copies exactly four Skills, writes ownership hashes, and repeated install is idempotent', async () => {
  const sourceRoot = await createCanonicalSkillsFixture();
  const { omnaiHome, userHome } = await createHomes();

  const [first] = await installUserHostSkills(omnaiHome, userHome, ['codex'], sourceRoot);
  assert.equal(first?.host, 'codex');
  assert.equal(first?.action, 'INSTALLED');
  assert.deepEqual(first?.skills, [...ENTRY_SKILLS]);

  for (const skill of ENTRY_SKILLS) {
    assert.equal(await pathExists(join(userHome, '.agents', 'skills', skill, 'SKILL.md')), true);
  }
  assert.equal(await pathExists(join(userHome, '.agents', 'skills', 'omnai-run', 'SKILL.md')), false);

  const manifestPath = hostManifestPath(omnaiHome, 'codex');
  const firstManifest = await readYaml(manifestPath, userHostManifestSchema);
  assert.equal(firstManifest.host, 'codex');
  assert.equal(firstManifest.destination, join(userHome, '.agents', 'skills'));
  assert.deepEqual(firstManifest.skills.map((item) => item.name), [...ENTRY_SKILLS]);
  for (const item of firstManifest.skills) {
    const installed = await readFile(join(firstManifest.destination, item.name, 'SKILL.md'), 'utf8');
    assert.equal(item.hash, sha256(installed));
  }

  const [second] = await installUserHostSkills(omnaiHome, userHome, ['codex'], sourceRoot);
  const secondManifest = await readYaml(manifestPath, userHostManifestSchema);
  assert.equal(second?.action, 'UNCHANGED');
  assert.equal(secondManifest.installedAt, firstManifest.installedAt);
  assert.deepEqual(secondManifest.skills, firstManifest.skills);
  assert.equal((await getUserHostSkillStatus(omnaiHome, userHome, 'codex', sourceRoot)).status, 'READY');
});

test('status reports NOT_INSTALLED and READY deterministically', async () => {
  const sourceRoot = await createCanonicalSkillsFixture();
  const { omnaiHome, userHome } = await createHomes();

  assert.equal((await getUserHostSkillStatus(omnaiHome, userHome, 'claude', sourceRoot)).status, 'NOT_INSTALLED');
  await installUserHostSkills(omnaiHome, userHome, ['claude'], sourceRoot);
  assert.equal((await getUserHostSkillStatus(omnaiHome, userHome, 'claude', sourceRoot)).status, 'READY');

  const statuses = await listUserHostSkillStatuses(omnaiHome, userHome, undefined, sourceRoot);
  assert.deepEqual(statuses.map((item) => [item.host, item.status]), [
    ['claude', 'READY'],
    ['codex', 'NOT_INSTALLED'],
    ['opencode', 'NOT_INSTALLED'],
  ]);
});

test('status reports FOREIGN when a same-name Skill exists without OmnAI ownership', async () => {
  const sourceRoot = await createCanonicalSkillsFixture();
  const { omnaiHome, userHome } = await createHomes();
  const foreign = join(hostSkillDestination(userHome, 'codex'), 'omnai', 'SKILL.md');
  await mkdir(join(foreign, '..'), { recursive: true });
  await writeFile(foreign, 'foreign skill\n', 'utf8');

  const status = await getUserHostSkillStatus(omnaiHome, userHome, 'codex', sourceRoot);
  assert.equal(status.status, 'FOREIGN');
  assert.match(status.details.join('\n'), /omnai/i);
});

test('status reports MISSING when a manifest-owned Skill file disappears', async () => {
  const sourceRoot = await createCanonicalSkillsFixture();
  const { omnaiHome, userHome } = await createHomes();
  await installUserHostSkills(omnaiHome, userHome, ['claude'], sourceRoot);
  await rm(join(hostSkillDestination(userHome, 'claude'), 'omnai-grill', 'SKILL.md'));

  const status = await getUserHostSkillStatus(omnaiHome, userHome, 'claude', sourceRoot);
  assert.equal(status.status, 'MISSING');
  assert.match(status.details.join('\n'), /omnai-grill/i);
});

test('status reports DRIFTED when a manifest-owned Skill changes locally', async () => {
  const sourceRoot = await createCanonicalSkillsFixture();
  const { omnaiHome, userHome } = await createHomes();
  await installUserHostSkills(omnaiHome, userHome, ['opencode'], sourceRoot);
  const installed = join(hostSkillDestination(userHome, 'opencode'), 'omnai', 'SKILL.md');
  await writeFile(installed, 'locally changed\n', 'utf8');

  const status = await getUserHostSkillStatus(omnaiHome, userHome, 'opencode', sourceRoot);
  assert.equal(status.status, 'DRIFTED');
  assert.match(status.details.join('\n'), /omnai/i);
});

test('status reports OUTDATED when clean installed bytes match the manifest but packaged canonical content advances', async () => {
  const sourceRoot = await createCanonicalSkillsFixture();
  const { omnaiHome, userHome } = await createHomes();
  await installUserHostSkills(omnaiHome, userHome, ['codex'], sourceRoot);
  await writeFile(
    join(sourceRoot, 'omnai', 'SKILL.md'),
    '---\nname: omnai\ndescription: Use when testing a newer router.\n---\n\n# omnai\n\nNew canonical content.\n',
    'utf8',
  );

  const status = await getUserHostSkillStatus(omnaiHome, userHome, 'codex', sourceRoot);
  assert.equal(status.status, 'OUTDATED');
  assert.match(status.details.join('\n'), /omnai/i);
});

test('installer refuses to overwrite FOREIGN, MISSING, or DRIFTED targets', async () => {
  const sourceRoot = await createCanonicalSkillsFixture();

  const foreignHomes = await createHomes();
  const foreignPath = join(hostSkillDestination(foreignHomes.userHome, 'codex'), 'omnai', 'SKILL.md');
  await mkdir(join(foreignPath, '..'), { recursive: true });
  await writeFile(foreignPath, 'foreign skill\n', 'utf8');
  await assert.rejects(
    () => installUserHostSkills(foreignHomes.omnaiHome, foreignHomes.userHome, ['codex'], sourceRoot),
    /FOREIGN|foreign/i,
  );
  assert.equal(await readFile(foreignPath, 'utf8'), 'foreign skill\n');

  const missingHomes = await createHomes();
  await installUserHostSkills(missingHomes.omnaiHome, missingHomes.userHome, ['claude'], sourceRoot);
  await rm(join(hostSkillDestination(missingHomes.userHome, 'claude'), 'omnai', 'SKILL.md'));
  await assert.rejects(
    () => installUserHostSkills(missingHomes.omnaiHome, missingHomes.userHome, ['claude'], sourceRoot),
    /MISSING|missing/i,
  );

  const driftedHomes = await createHomes();
  await installUserHostSkills(driftedHomes.omnaiHome, driftedHomes.userHome, ['opencode'], sourceRoot);
  const driftedPath = join(hostSkillDestination(driftedHomes.userHome, 'opencode'), 'omnai-reconcile', 'SKILL.md');
  await writeFile(driftedPath, 'drifted\n', 'utf8');
  await assert.rejects(
    () => installUserHostSkills(driftedHomes.omnaiHome, driftedHomes.userHome, ['opencode'], sourceRoot),
    /DRIFTED|drifted/i,
  );
  assert.equal(await readFile(driftedPath, 'utf8'), 'drifted\n');
});

test('a clean OUTDATED installation upgrades canonical bytes while preserving installedAt', async () => {
  const sourceRoot = await createCanonicalSkillsFixture();
  const { omnaiHome, userHome } = await createHomes();
  await installUserHostSkills(omnaiHome, userHome, ['codex'], sourceRoot);
  const before = await readYaml(hostManifestPath(omnaiHome, 'codex'), userHostManifestSchema);
  const newContent = '---\nname: omnai\ndescription: Use when testing a newer router.\n---\n\n# omnai\n\nUpgraded.\n';
  await writeFile(join(sourceRoot, 'omnai', 'SKILL.md'), newContent, 'utf8');

  const [result] = await installUserHostSkills(omnaiHome, userHome, ['codex'], sourceRoot);
  const after = await readYaml(hostManifestPath(omnaiHome, 'codex'), userHostManifestSchema);
  assert.equal(result?.action, 'UPDATED');
  assert.equal(after.installedAt, before.installedAt);
  assert.equal(await readFile(join(hostSkillDestination(userHome, 'codex'), 'omnai', 'SKILL.md'), 'utf8'), newContent);
  assert.equal((await getUserHostSkillStatus(omnaiHome, userHome, 'codex', sourceRoot)).status, 'READY');
});

test('Host Skill update preserves the physically configured Agent array without adding defaults or reordering', async () => {
  const sourceRoot = await createCanonicalSkillsFixture();
  const { omnaiHome, userHome } = await createHomes();
  await installUserHostSkills(omnaiHome, userHome, ['codex'], sourceRoot);
  const manifestPath = hostManifestPath(omnaiHome, 'codex');
  const raw = YAML.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  const configuredAgents = [
    rawAgent('second-agent', '/opt/second-agent'),
    rawAgent('first-agent', '/opt/first-agent'),
  ];
  raw.agents = configuredAgents;
  await writeFile(manifestPath, YAML.stringify(raw), 'utf8');
  await writeFile(
    join(sourceRoot, 'omnai', 'SKILL.md'),
    '---\nname: omnai\ndescription: Use when testing a newer router.\n---\n\n# omnai\n\nAgent-safe update.\n',
    'utf8',
  );

  const [result] = await installUserHostSkills(omnaiHome, userHome, ['codex'], sourceRoot);
  const updatedRaw = YAML.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  assert.equal(result?.action, 'UPDATED');
  assert.deepEqual(updatedRaw.agents, configuredAgents);

  const parsed = await readYaml(manifestPath, userHostManifestSchema);
  assert.deepEqual(parsed.agents.map((item) => item.agentId), ['second-agent', 'first-agent']);
  assert.deepEqual(parsed.agents.map((item) => item.args), [[], []]);
});

test('multi-host install preflights every Host before writing any destination', async () => {
  const sourceRoot = await createCanonicalSkillsFixture();
  const { omnaiHome, userHome } = await createHomes();
  const foreign = join(hostSkillDestination(userHome, 'opencode'), 'omnai', 'SKILL.md');
  await mkdir(join(foreign, '..'), { recursive: true });
  await writeFile(foreign, 'foreign opencode skill\n', 'utf8');

  await assert.rejects(
    () => installUserHostSkills(omnaiHome, userHome, [...USER_HOSTS], sourceRoot),
    /FOREIGN|foreign/i,
  );

  assert.equal(await pathExists(join(hostSkillDestination(userHome, 'claude'), 'omnai', 'SKILL.md')), false);
  assert.equal(await pathExists(join(hostSkillDestination(userHome, 'codex'), 'omnai', 'SKILL.md')), false);
  assert.equal(await pathExists(hostManifestPath(omnaiHome, 'claude')), false);
  assert.equal(await pathExists(hostManifestPath(omnaiHome, 'codex')), false);
  assert.equal(await readFile(foreign, 'utf8'), 'foreign opencode skill\n');
});

function rawAgent(agentId: string, command: string) {
  return {
    schemaVersion: 1,
    agentId,
    protocol: 'acp',
    command,
    protocolVersion: 1,
    maxParallelSessions: 2,
    isolation: { mode: 'agent-sandbox', enforcedWorkspaceRoots: true },
    capabilities: {
      loadSession: true,
      resumeSession: true,
      closeSession: true,
      additionalDirectories: true,
      mcpStdio: true,
    },
    omnaiModes: ['coordination-read-only', 'project-writer', 'project-reviewer'],
  };
}
