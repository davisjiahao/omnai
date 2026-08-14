import assert from 'node:assert/strict';
import test from 'node:test';
import { createChange, initializeProject } from '../src/core/store.js';
import {
  bindWorksetProjectChange,
  listProjectChangeCandidates,
} from '../src/workspace/change-bindings.js';
import { registerProject } from '../src/workspace/project-registry.js';
import {
  activateWorksetProject,
  addWorksetCandidate,
  beginProjectResearch,
  createWorkset,
  resolveWorkset,
} from '../src/workspace/worksets.js';
import { createTestDirectory, createTestRepository } from './helpers.js';

test('existing Project Changes are suggestions until explicitly bound', async () => {
  const home = await createTestDirectory('omnai-home-');
  const repo = await createTestRepository('user-center');
  try {
    await initializeProject(repo.root);
    const existing = await createChange(repo.root, 'Authorization ownership', 'complex-domain-feature');
    await registerProject(home.root, repo.root, 'user');
    const workset = await createWorkset(home.root, 'Authorization Migration');
    await addWorksetCandidate(home.root, workset.id, 'user');
    await beginProjectResearch(home.root, workset.id, 'user');

    const candidates = await listProjectChangeCandidates(home.root, workset.id, 'user');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.id, existing.metadata.id);

    const before = await resolveWorkset(home.root, workset.id);
    assert.equal(before.members[0]?.changeId, undefined);

    const bound = await bindWorksetProjectChange(home.root, workset.id, 'user', existing.metadata.id);
    assert.equal(bound.members[0]?.changeId, existing.metadata.id);
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
