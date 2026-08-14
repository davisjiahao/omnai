import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { listChanges, createChange, initializeProject } from '../src/core/store.js';
import {
  bindWorksetProjectChange,
  createAndActivateWorksetProjectChange,
  listProjectChangeCandidates,
} from '../src/workspace/change-bindings.js';
import { createWorksetWorktree } from '../src/workspace/git-worktrees.js';
import { registerProject } from '../src/workspace/project-registry.js';
import {
  activateWorksetProject,
  addWorksetCandidate,
  beginProjectResearch,
  createWorkset,
  resolveWorkset,
} from '../src/workspace/worksets.js';
import { createTestDirectory, createTestRepository } from './helpers.js';

function commitAll(repoRoot: string, message: string): void {
  execFileSync('git', ['add', '-A'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', message], { cwd: repoRoot, stdio: 'ignore' });
}

test('existing committed Project Changes are suggestions until explicitly bound', async () => {
  const home = await createTestDirectory('omnai-home-');
  const repo = await createTestRepository('user-center');
  try {
    await initializeProject(repo.root);
    const existing = await createChange(repo.root, 'Authorization ownership', 'complex-domain-feature');
    commitAll(repo.root, 'test: add existing omnai change');
    await registerProject(home.root, repo.root, 'user');
    const workset = await createWorkset(home.root, 'Authorization Migration');
    await addWorksetCandidate(home.root, workset.id, 'user');
    await beginProjectResearch(home.root, workset.id, 'user');

    const candidates = await listProjectChangeCandidates(home.root, workset.id, 'user');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.id, existing.metadata.id);
    assert.equal(candidates[0]?.committedAtHead, true);

    const before = await resolveWorkset(home.root, workset.id);
    assert.equal(before.members[0]?.changeId, undefined);

    const bound = await bindWorksetProjectChange(home.root, workset.id, 'user', existing.metadata.id);
    assert.equal(bound.members[0]?.changeId, existing.metadata.id);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('an uncommitted existing Project Change is visible but cannot be bound for a HEAD-based Worktree', async () => {
  const home = await createTestDirectory('omnai-home-');
  const repo = await createTestRepository('quote-center');
  try {
    await initializeProject(repo.root);
    const existing = await createChange(repo.root, 'Authorization consumer', 'cross-service-change');
    await registerProject(home.root, repo.root, 'quote');
    const workset = await createWorkset(home.root, 'Authorization Migration');
    await addWorksetCandidate(home.root, workset.id, 'quote');
    await beginProjectResearch(home.root, workset.id, 'quote');

    const candidates = await listProjectChangeCandidates(home.root, workset.id, 'quote');
    assert.equal(candidates[0]?.committedAtHead, false);
    await assert.rejects(
      () => bindWorksetProjectChange(home.root, workset.id, 'quote', existing.metadata.id),
      /committed HEAD/i,
    );
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('a Workset project cannot silently rebind to another Project Change', async () => {
  const home = await createTestDirectory('omnai-home-');
  const repo = await createTestRepository('quote-center');
  try {
    await initializeProject(repo.root);
    const first = await createChange(repo.root, 'Authorization consumer', 'cross-service-change');
    const second = await createChange(repo.root, 'Pricing cleanup', 'small-feature');
    commitAll(repo.root, 'test: add two existing omnai changes');
    await registerProject(home.root, repo.root, 'quote');
    const workset = await createWorkset(home.root, 'Authorization Migration');
    await addWorksetCandidate(home.root, workset.id, 'quote');
    await beginProjectResearch(home.root, workset.id, 'quote');

    await bindWorksetProjectChange(home.root, workset.id, 'quote', first.metadata.id);
    await assert.rejects(
      () => bindWorksetProjectChange(home.root, workset.id, 'quote', second.metadata.id),
      /already bound/i,
    );
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('creating a new Project Change creates it inside the dedicated Worktree and activates atomically', async () => {
  const home = await createTestDirectory('omnai-home-');
  const repo = await createTestRepository('pricing-center');
  try {
    await registerProject(home.root, repo.root, 'pricing');
    const workset = await createWorkset(home.root, 'Authorization Migration');
    await addWorksetCandidate(home.root, workset.id, 'pricing');
    await beginProjectResearch(home.root, workset.id, 'pricing');

    const result = await createAndActivateWorksetProjectChange(
      home.root,
      workset.id,
      'pricing',
      'Use AuthorizationScope in pricing routing',
      'cross-service-change',
    );

    const member = result.workset.members.find((item) => item.project === 'pricing');
    assert.equal(member?.status, 'ACTIVE');
    assert.equal(member?.changeId, result.change.metadata.id);
    assert.ok(member?.worktree);
    assert.equal((await listChanges(repo.root)).length, 0);
    assert.equal((await listChanges(member.worktree)).length, 1);
    assert.equal((await listChanges(member.worktree))[0]?.metadata.id, result.change.metadata.id);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('retry reuses the unique matching uncommitted Project Change after binding persistence interruption', async () => {
  const home = await createTestDirectory('omnai-home-');
  const repo = await createTestRepository('pricing-center');
  try {
    const registered = await registerProject(home.root, repo.root, 'pricing');
    const workset = await createWorkset(home.root, 'Authorization Migration');
    await addWorksetCandidate(home.root, workset.id, 'pricing');
    await beginProjectResearch(home.root, workset.id, 'pricing');

    const createdWorktree = await createWorksetWorktree(home.root, workset, registered);
    const interrupted = await createChange(
      createdWorktree.path,
      'Use AuthorizationScope in pricing routing',
      'cross-service-change',
    );
    assert.equal((await resolveWorkset(home.root, workset.id)).members[0]?.changeId, undefined);

    const recovered = await createAndActivateWorksetProjectChange(
      home.root,
      workset.id,
      'pricing',
      'Use AuthorizationScope in pricing routing',
      'cross-service-change',
    );

    const member = recovered.workset.members.find((item) => item.project === 'pricing');
    assert.equal(recovered.change.metadata.id, interrupted.metadata.id);
    assert.equal(member?.changeId, interrupted.metadata.id);
    assert.equal(member?.status, 'ACTIVE');
    assert.equal((await listChanges(createdWorktree.path)).length, 1);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('retry refuses ambiguous matching uncommitted Project Changes in a retained Worktree', async () => {
  const home = await createTestDirectory('omnai-home-');
  const repo = await createTestRepository('pricing-center');
  try {
    const registered = await registerProject(home.root, repo.root, 'pricing');
    const workset = await createWorkset(home.root, 'Authorization Migration');
    await addWorksetCandidate(home.root, workset.id, 'pricing');
    await beginProjectResearch(home.root, workset.id, 'pricing');

    const createdWorktree = await createWorksetWorktree(home.root, workset, registered);
    await createChange(createdWorktree.path, 'Use AuthorizationScope in pricing routing', 'cross-service-change');
    await createChange(createdWorktree.path, 'Use AuthorizationScope in pricing routing', 'cross-service-change');

    await assert.rejects(
      () => createAndActivateWorksetProjectChange(
        home.root,
        workset.id,
        'pricing',
        'Use AuthorizationScope in pricing routing',
        'cross-service-change',
      ),
      /multiple|ambiguous/i,
    );
    assert.equal((await resolveWorkset(home.root, workset.id)).members[0]?.changeId, undefined);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('activation requires an explicitly bound Project Change', async () => {
  const home = await createTestDirectory('omnai-home-');
  const repo = await createTestRepository('order-center');
  try {
    await initializeProject(repo.root);
    await createChange(repo.root, 'Authorization snapshot', 'complex-domain-feature');
    await registerProject(home.root, repo.root, 'order');
    const workset = await createWorkset(home.root, 'Authorization Migration');
    await addWorksetCandidate(home.root, workset.id, 'order');
    await beginProjectResearch(home.root, workset.id, 'order');

    await assert.rejects(
      () => activateWorksetProject(home.root, workset.id, 'order'),
      /Project Change/i,
    );
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});
