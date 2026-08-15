import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import YAML from 'yaml';
import * as omnai from '../src/index.js';
import { projectConfigSchema } from '../src/domain/types.js';
import { pathExists } from '../src/core/files.js';
import { createTestDirectory, createTestRepository } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function createEnvironment() {
  const omnaiHome = await createTestDirectory('omnai-home-');
  const userHome = await createTestDirectory('user-home-');
  const repo = await createTestRepository('user-center');
  cleanups.push(repo.cleanup, userHome.cleanup, omnaiHome.cleanup);
  return { omnaiHome: omnaiHome.root, userHome: userHome.root, repo: repo.root };
}

function runCli(
  omnaiHome: string,
  userHome: string,
  cwd: string,
  args: string[],
) {
  return spawnSync(process.execPath, [resolve('dist/src/main.js'), ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      OMNAI_HOME: omnaiHome,
      HOME: userHome,
      USERPROFILE: userHome,
    },
  });
}

test('omnai init rejects the unreleased --host option without creating project state', async () => {
  const fixture = await createEnvironment();
  const result = runCli(fixture.omnaiHome, fixture.userHome, fixture.repo, ['init', '--host', 'codex']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown option.*host|host.*unknown option/i);
  assert.equal(await pathExists(join(fixture.repo, '.omnai')), false);
});

test('omnai init initializes only repository-local state and no Host Skill directories', async () => {
  const fixture = await createEnvironment();
  const result = runCli(fixture.omnaiHome, fixture.userHome, fixture.repo, ['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await pathExists(join(fixture.repo, '.omnai', 'config.yaml')), true);

  for (const path of [
    join(fixture.repo, '.claude'),
    join(fixture.repo, '.codex'),
    join(fixture.repo, '.opencode'),
    join(fixture.userHome, '.claude', 'skills'),
    join(fixture.userHome, '.agents', 'skills'),
    join(fixture.userHome, '.config', 'opencode', 'skills'),
  ]) {
    assert.equal(await pathExists(path), false, path);
  }

  const raw = YAML.parse(await readFile(join(fixture.repo, '.omnai', 'config.yaml'), 'utf8')) as Record<string, unknown>;
  assert.equal(Object.hasOwn(raw, 'installedHosts'), false);
});

test('ProjectConfig no longer has an installedHosts field', () => {
  const parsed = projectConfigSchema.parse({
    schemaVersion: 1,
    project: 'user-center',
    activeChange: null,
    defaultScenario: 'small-feature',
    verification: { commands: [] },
  });
  assert.equal(Object.hasOwn(parsed, 'installedHosts'), false);
});

test('the public package no longer exposes the repository-local Host installer', () => {
  assert.equal('installHostSkills' in omnai, false);
  assert.equal('locateSkillsRoot' in omnai, false);
});
