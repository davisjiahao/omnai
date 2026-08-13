import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createTestDirectory, createTestRepository } from './helpers.js';
import { registerProject } from '../src/workspace/project-registry.js';
import {
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

test('creates monotonic Workset IDs and selects the newest Workset', async () => {
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(home.cleanup);

  const first = await createWorkset(home.root, 'Authorization Migration');
  const second = await createWorkset(home.root, 'Quote Timeout');

  assert.equal(first.id, 'WKS-0001');
  assert.equal(second.id, 'WKS-0002');
  assert.equal((await resolveWorkset(home.root)).id, 'WKS-0002');
  assert.equal((await resolveWorkset(home.root, 'WKS-0001')).title, 'Authorization Migration');
});

test('moves a candidate through read-only research without creating writable state', async () => {
  const repo = await createTestRepository('user-center');
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(repo.cleanup, home.cleanup);
  await registerProject(home.root, repo.root, 'user');
  const workset = await createWorkset(home.root, 'Authorization Migration');

  const candidate = await addWorksetCandidate(home.root, workset.id, 'user');
  assert.equal(candidate.members[0]?.status, 'CANDIDATE');
  assert.equal(candidate.members[0]?.worktree, undefined);
  assert.equal(candidate.members[0]?.branch, undefined);

  const researching = await beginProjectResearch(home.root, workset.id, 'user');
  assert.equal(researching.members[0]?.status, 'RESEARCH_ONLY');
  assert.equal(researching.members[0]?.worktree, undefined);

  const observed = await markProjectObservedOnly(home.root, workset.id, 'user');
  assert.equal(observed.members[0]?.status, 'OBSERVED_ONLY');
  assert.equal(observed.members[0]?.worktree, undefined);
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
