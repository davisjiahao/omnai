import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { join } from 'node:path';
import { pathExists } from '../src/core/files.js';
import { createTestDirectory, createTestRepository } from './helpers.js';
import { registerProject } from '../src/workspace/project-registry.js';
import { worksetMarkerPath, worksetWorkspaceRoot } from '../src/workspace/paths.js';
import {
  activateWorksetProject,
  addWorksetCandidate,
  beginProjectResearch,
  createWorkset,
  markProjectObservedOnly,
  resolveWorkset,
  worksetNext,
} from '../src/workspace/worksets.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

test('creates monotonic Workset IDs, aggregate roots, and selects the newest Workset', async () => {
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(home.cleanup);

  const first = await createWorkset(home.root, 'Authorization Migration');
  const second = await createWorkset(home.root, 'Quote Timeout');

  assert.equal(first.id, 'WKS-0001');
  assert.equal(second.id, 'WKS-0002');
  assert.equal((await resolveWorkset(home.root)).id, 'WKS-0002');
  assert.equal((await resolveWorkset(home.root, 'WKS-0001')).title, 'Authorization Migration');
  assert.equal(await pathExists(worksetWorkspaceRoot(home.root, first.id)), true);
  assert.equal(await pathExists(worksetMarkerPath(home.root, first.id)), true);
  assert.equal(await pathExists(worksetWorkspaceRoot(home.root, second.id)), true);
  assert.equal(await pathExists(worksetMarkerPath(home.root, second.id)), true);
});

test('moves a candidate through read-only research without creating a project worktree', async () => {
  const repo = await createTestRepository('user-center');
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(repo.cleanup, home.cleanup);
  await registerProject(home.root, repo.root, 'user');
  const workset = await createWorkset(home.root, 'Authorization Migration');
  const projectPath = join(worksetWorkspaceRoot(home.root, workset.id), 'user');

  const candidate = await addWorksetCandidate(home.root, workset.id, 'user');
  assert.equal(candidate.members[0]?.status, 'CANDIDATE');
  assert.equal(candidate.members[0]?.worktree, undefined);
  assert.equal(candidate.members[0]?.branch, undefined);
  assert.equal(await pathExists(projectPath), false);

  const researching = await beginProjectResearch(home.root, workset.id, 'user');
  assert.equal(researching.members[0]?.status, 'RESEARCH_ONLY');
  assert.equal(researching.members[0]?.worktree, undefined);
  assert.equal(await pathExists(projectPath), false);

  const observed = await markProjectObservedOnly(home.root, workset.id, 'user');
  assert.equal(observed.members[0]?.status, 'OBSERVED_ONLY');
  assert.equal(observed.members[0]?.worktree, undefined);
  assert.equal(await pathExists(projectPath), false);
});

test('activating repositories creates sibling Git worktrees under one aggregate root', async () => {
  const userRepo = await createTestRepository('user-center');
  const quoteRepo = await createTestRepository('quote-center');
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(userRepo.cleanup, quoteRepo.cleanup, home.cleanup);
  await registerProject(home.root, userRepo.root, 'user');
  await registerProject(home.root, quoteRepo.root, 'quote');
  const workset = await createWorkset(home.root, 'Authorization Migration');
  const root = worksetWorkspaceRoot(home.root, workset.id);

  await addWorksetCandidate(home.root, workset.id, 'user');
  await beginProjectResearch(home.root, workset.id, 'user');
  const userActive = await activateWorksetProject(home.root, workset.id, 'user');
  const userWorktree = userActive.members.find((item) => item.project === 'user')?.worktree;
  assert.equal(userWorktree, join(root, 'user'));
  assert.equal(await pathExists(join(root, 'user', 'README.md')), true);

  await addWorksetCandidate(home.root, workset.id, 'quote');
  await beginProjectResearch(home.root, workset.id, 'quote');
  const quoteActive = await activateWorksetProject(home.root, workset.id, 'quote');
  const quoteWorktree = quoteActive.members.find((item) => item.project === 'quote')?.worktree;
  assert.equal(quoteWorktree, join(root, 'quote'));
  assert.equal(await pathExists(join(root, 'quote', 'README.md')), true);
  assert.equal(await pathExists(join(root, 'user', 'README.md')), true);
});

test('next action explains candidate and research-only decisions', async () => {
  const repo = await createTestRepository('user-center');
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(repo.cleanup, home.cleanup);
  await registerProject(home.root, repo.root, 'user');
  const workset = await createWorkset(home.root, 'Authorization Migration');

  const candidate = await addWorksetCandidate(home.root, workset.id, 'user');
  assert.deepEqual(worksetNext(candidate), {
    action: 'inspect-project',
    project: 'user',
    reason: 'Candidate project requires read-only research before activation.',
  });

  const researching = await beginProjectResearch(home.root, workset.id, 'user');
  assert.deepEqual(worksetNext(researching), {
    action: 'decide-project-impact',
    project: 'user',
    reason: 'Read-only research must decide whether this project needs modification.',
  });
});

test('rejects an illegal lifecycle transition', async () => {
  const repo = await createTestRepository('user-center');
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(repo.cleanup, home.cleanup);
  await registerProject(home.root, repo.root, 'user');
  const workset = await createWorkset(home.root, 'Authorization Migration');
  await addWorksetCandidate(home.root, workset.id, 'user');

  await assert.rejects(
    () => markProjectObservedOnly(home.root, workset.id, 'user'),
    /must be RESEARCH_ONLY/,
  );
});
