import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import YAML from 'yaml';
import { pathExists } from '../src/core/files.js';
import { worksetWorkspaceRoot } from '../src/workspace/paths.js';
import { createTestDirectory, createTestRepository } from './helpers.js';

const ENTRY_SKILLS = ['omnai', 'omnai-brainstorm', 'omnai-grill', 'omnai-reconcile'] as const;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  omnaiHome: string,
  userHome: string,
  cwd: string,
  args: string[],
): RunResult {
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

function runJson<T>(
  omnaiHome: string,
  userHome: string,
  cwd: string,
  args: string[],
): T {
  const result = runCli(omnaiHome, userHome, cwd, [...args, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout) as T;
}

test('user Host installation, Workset routing, Show-me composition, and repository run audit work end to end', async () => {
  const omnaiHome = await createTestDirectory('omnai-e2e-home-');
  const userHome = await createTestDirectory('omnai-e2e-user-');
  const repo = await createTestRepository('user-center');
  cleanups.push(repo.cleanup, userHome.cleanup, omnaiHome.cleanup);
  const packageRoot = process.cwd();

  const install = runJson<Array<{ host: string; action: string }>>(
    omnaiHome.root,
    userHome.root,
    packageRoot,
    ['host', 'install', 'all'],
  );
  assert.deepEqual(install.map((item) => item.host), ['claude', 'codex', 'opencode']);

  const statuses = runJson<Array<{ host: string; status: string }>>(
    omnaiHome.root,
    userHome.root,
    packageRoot,
    ['host', 'status'],
  );
  assert.deepEqual(statuses.map((item) => [item.host, item.status]), [
    ['claude', 'READY'],
    ['codex', 'READY'],
    ['opencode', 'READY'],
  ]);

  for (const destination of [
    join(userHome.root, '.claude', 'skills'),
    join(userHome.root, '.agents', 'skills'),
    join(userHome.root, '.config', 'opencode', 'skills'),
  ]) {
    const installed = (await readdir(destination, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(installed, [...ENTRY_SKILLS]);
    assert.equal(await pathExists(join(destination, 'resources')), false);
    assert.equal(await pathExists(join(destination, 'protocols')), false);
  }

  const registered = runJson<{ alias: string }>(
    omnaiHome.root,
    userHome.root,
    packageRoot,
    ['project', 'register', repo.root, '--alias', 'user'],
  );
  assert.equal(registered.alias, 'user');

  const workset = runJson<{ id: string }>(
    omnaiHome.root,
    userHome.root,
    packageRoot,
    ['workset', 'new', 'Authorization Migration'],
  );
  runJson(omnaiHome.root, userHome.root, packageRoot, ['workset', 'add-candidate', 'user']);
  runJson(omnaiHome.root, userHome.root, packageRoot, ['workset', 'inspect-project', 'user']);
  const activated = runJson<{
    member: { project: string; status: string; changeId: string; worktree: string };
    change: { id: string };
  }>(omnaiHome.root, userHome.root, packageRoot, [
    'workset',
    'create-change',
    'user',
    'Build Authorization ownership',
    '--scenario',
    'small-feature',
  ]);
  assert.equal(activated.member.status, 'ACTIVE');
  assert.equal(activated.member.changeId, activated.change.id);

  const workspaceRoot = worksetWorkspaceRoot(omnaiHome.root, workset.id);
  const beforeReadOnly = {
    omnai: await treeHash(omnaiHome.root),
    worktree: await treeHash(activated.member.worktree),
  };

  const aggregateContext = runJson<{ scope: string; worksetId: string; project: null }>(
    omnaiHome.root,
    userHome.root,
    packageRoot,
    ['context', '--path', workspaceRoot],
  );
  assert.deepEqual(
    { scope: aggregateContext.scope, worksetId: aggregateContext.worksetId, project: aggregateContext.project },
    { scope: 'workset', worksetId: workset.id, project: null },
  );

  const projectContext = runJson<{ scope: string; project: string; changeId: string }>(
    omnaiHome.root,
    userHome.root,
    packageRoot,
    ['context', '--path', activated.member.worktree],
  );
  assert.deepEqual(
    { scope: projectContext.scope, project: projectContext.project, changeId: projectContext.changeId },
    { scope: 'workset-project', project: 'user', changeId: activated.change.id },
  );

  const worksetRoute = runJson<{ action: string; protocolIds: string[] }>(
    omnaiHome.root,
    userHome.root,
    workspaceRoot,
    ['workset', 'next', workset.id],
  );
  assert.deepEqual(worksetRoute, {
    action: 'project-workflow',
    project: 'user',
    reason: 'Active project is ready for its repository-local OmnAI workflow.',
    protocolIds: ['workset.project-workflow-handoff'],
  });

  const worksetBundle = runJson<{
    protocols: Array<{ id: string }>;
    rendered: string;
  }>(omnaiHome.root, userHome.root, workspaceRoot, [
    'protocol',
    'show',
    ...worksetRoute.protocolIds,
  ]);
  assert.deepEqual(worksetBundle.protocols.map((item) => item.id), [
    'common.authoritative-work',
    'workset.project-workflow-handoff',
  ]);

  const worksetShowMe = runJson<{ protocols: Array<{ id: string }> }>(
    omnaiHome.root,
    userHome.root,
    workspaceRoot,
    ['protocol', 'show', 'interaction.show-me', ...worksetRoute.protocolIds],
  );
  assert.deepEqual(worksetShowMe.protocols.map((item) => item.id), [
    'common.authoritative-work',
    'interaction.show-me',
    'workset.project-workflow-handoff',
  ]);

  const repositoryRoute = runJson<{ capability: string; protocolIds: string[] }>(
    omnaiHome.root,
    userHome.root,
    activated.member.worktree,
    ['next'],
  );
  assert.equal(repositoryRoute.capability, 'spec');
  assert.deepEqual(repositoryRoute.protocolIds, ['repository.spec']);

  const repositoryShowMe = runJson<{ protocols: Array<{ id: string }> }>(
    omnaiHome.root,
    userHome.root,
    activated.member.worktree,
    ['protocol', 'show', 'interaction.show-me', ...repositoryRoute.protocolIds],
  );
  assert.deepEqual(repositoryShowMe.protocols.map((item) => item.id), [
    'common.authoritative-work',
    'interaction.show-me',
    'repository.spec',
  ]);

  const conceptShowMe = runJson<{ protocols: Array<{ id: string }> }>(
    omnaiHome.root,
    userHome.root,
    packageRoot,
    ['protocol', 'show', 'interaction.show-me'],
  );
  assert.deepEqual(conceptShowMe.protocols.map((item) => item.id), [
    'common.authoritative-work',
    'interaction.show-me',
  ]);

  assert.deepEqual(
    {
      omnai: await treeHash(omnaiHome.root),
      worktree: await treeHash(activated.member.worktree),
    },
    beforeReadOnly,
    'context, next, and protocol retrieval must not mutate workflow or repository state',
  );

  const emptyWorkset = runJson<{ id: string }>(
    omnaiHome.root,
    userHome.root,
    packageRoot,
    ['workset', 'new', 'Empty Explanation Workset'],
  );
  const beforeNoPendingReadOnly = {
    omnai: await treeHash(omnaiHome.root),
    worktree: await treeHash(activated.member.worktree),
  };
  const noPendingRoute = runJson<{ action: string; protocolIds: string[] }>(
    omnaiHome.root,
    userHome.root,
    packageRoot,
    ['workset', 'next', emptyWorkset.id],
  );
  assert.equal(noPendingRoute.action, 'none');
  assert.deepEqual(noPendingRoute.protocolIds, []);
  const noPendingShowMe = runJson<{ protocols: Array<{ id: string }> }>(
    omnaiHome.root,
    userHome.root,
    packageRoot,
    ['protocol', 'show', 'interaction.show-me'],
  );
  assert.deepEqual(noPendingShowMe.protocols.map((item) => item.id), [
    'common.authoritative-work',
    'interaction.show-me',
  ]);

  assert.deepEqual(
    {
      omnai: await treeHash(omnaiHome.root),
      worktree: await treeHash(activated.member.worktree),
    },
    beforeNoPendingReadOnly,
    'no-pending route and Show-me retrieval must not mutate workflow or repository state',
  );

  const prepared = runCli(
    omnaiHome.root,
    userHome.root,
    activated.member.worktree,
    ['spec', 'Define observable authorization acceptance criteria.'],
  );
  assert.equal(prepared.status, 0, prepared.stderr);

  const changeDirectory = (await readdir(join(activated.member.worktree, '.omnai', 'changes')))
    .find((entry) => entry.startsWith(`${activated.change.id}-`));
  assert.ok(changeDirectory);
  const runsRoot = join(activated.member.worktree, '.omnai', 'changes', changeDirectory, 'runs');
  const runDirectories = await readdir(runsRoot);
  assert.equal(runDirectories.length, 1);
  const runRoot = join(runsRoot, runDirectories[0]!);
  const manifest = YAML.parse(await readFile(join(runRoot, 'run.yaml'), 'utf8')) as {
    schemaVersion: number;
    promptHash: string;
    protocols: Array<{ id: string; version: number; hash: string }>;
  };
  const prompt = await readFile(join(runRoot, 'prompt.md'), 'utf8');

  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(manifest.protocols.map((item) => item.id), [
    'common.authoritative-work',
    'repository.spec',
  ]);
  assert.equal(manifest.promptHash, sha256(prompt));
});

async function treeHash(root: string): Promise<string> {
  const digest = createHash('sha256');
  const files = await listFiles(root);
  for (const path of files) {
    digest.update(relative(root, path));
    digest.update('\0');
    digest.update(await readFile(path));
    digest.update('\0');
  }
  return `sha256:${digest.digest('hex')}`;
}

async function listFiles(root: string): Promise<string[]> {
  if (!(await pathExists(root))) return [];
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() || (await stat(path)).isFile()) {
        result.push(path);
      }
    }
  };
  await visit(root);
  return result.sort();
}

function sha256(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}
