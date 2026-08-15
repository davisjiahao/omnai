import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { initializeProject, createChange } from '../src/core/store.js';
import { pathExists, writeYaml } from '../src/core/files.js';
import { createAndActivateWorksetProjectChange } from '../src/workspace/change-bindings.js';
import { resolveOmnaiContext } from '../src/host/context.js';
import { registerProject } from '../src/workspace/project-registry.js';
import { worksetWorkspaceRoot } from '../src/workspace/paths.js';
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

async function createActiveWorksetProject() {
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
    'complex-domain-feature',
  );
  const member = active.workset.members.find((item) => item.project === 'user');
  assert.ok(member?.worktree);
  assert.ok(member.changeId);
  return { home, workset: active.workset, member };
}

test('resolves the aggregate root as Workset context', async () => {
  const { home, workset } = await createActiveWorksetProject();
  const workspaceRoot = worksetWorkspaceRoot(home.root, workset.id);

  assert.deepEqual(await resolveOmnaiContext(home.root, workspaceRoot), {
    scope: 'workset',
    cwd: workspaceRoot,
    worksetId: workset.id,
    workspaceRoot,
    project: null,
  });
});

test('Workset project context outranks ordinary Git worktree context', async () => {
  const { home, workset, member } = await createActiveWorksetProject();
  const nested = join(member.worktree, 'src', 'main');
  await mkdir(nested, { recursive: true });

  assert.deepEqual(await resolveOmnaiContext(home.root, nested), {
    scope: 'workset-project',
    cwd: nested,
    worksetId: workset.id,
    workspaceRoot: worksetWorkspaceRoot(home.root, workset.id),
    project: 'user',
    memberStatus: 'ACTIVE',
    repoRoot: member.worktree,
    changeId: member.changeId,
  });
});

test('resolves an initialized ordinary repository without mutating it', async () => {
  const home = await createTestDirectory('omnai-home-');
  const repo = await createTestRepository('ordinary-repo');
  cleanups.push(repo.cleanup, home.cleanup);
  await initializeProject(repo.root);
  const change = await createChange(repo.root, 'Ordinary Change', 'small-feature');
  const nested = join(repo.root, 'src');
  await mkdir(nested, { recursive: true });

  assert.deepEqual(await resolveOmnaiContext(home.root, nested), {
    scope: 'repository',
    cwd: nested,
    repoRoot: repo.root,
    initialized: true,
    changeId: change.metadata.id,
  });
});

test('resolves an uninitialized Git repository without creating .omnai state', async () => {
  const home = await createTestDirectory('omnai-home-');
  const repo = await createTestRepository('uninitialized-repo');
  cleanups.push(repo.cleanup, home.cleanup);
  assert.equal(await pathExists(join(repo.root, '.omnai')), false);

  assert.deepEqual(await resolveOmnaiContext(home.root, repo.root), {
    scope: 'repository',
    cwd: repo.root,
    repoRoot: repo.root,
    initialized: false,
    changeId: null,
  });
  assert.equal(await pathExists(join(repo.root, '.omnai')), false);
});

test('returns none outside a Workset and Git repository', async () => {
  const home = await createTestDirectory('omnai-home-');
  const directory = await createTestDirectory('outside-omnai-');
  cleanups.push(directory.cleanup, home.cleanup);

  assert.deepEqual(await resolveOmnaiContext(home.root, directory.root), {
    scope: 'none',
    cwd: directory.root,
  });
});

test('fails explicitly when a Workset marker points to missing personal state', async () => {
  const home = await createTestDirectory('omnai-home-');
  const directory = await createTestDirectory('broken-workset-');
  cleanups.push(directory.cleanup, home.cleanup);
  await writeYaml(join(directory.root, '.omnai-workset.yaml'), {
    schemaVersion: 1,
    worksetId: 'WKS-9999',
    manifest: '../workset.yaml',
  });

  await assert.rejects(
    () => resolveOmnaiContext(home.root, directory.root),
    /WKS-9999.*not found|not found.*WKS-9999/i,
  );
});
