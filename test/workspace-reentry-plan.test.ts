import assert from 'node:assert/strict';
import test from 'node:test';
import { createAndActivateWorksetProjectChange } from '../src/workspace/change-bindings.js';
import { registerProject } from '../src/workspace/project-registry.js';
import {
  decideWorksetReentry,
  planWorksetReentry,
} from '../src/workspace/reconcile-plan.js';
import {
  loadWorksetReentry,
  recordWorksetReentry,
} from '../src/workspace/reentry.js';
import {
  addWorksetCandidate,
  beginProjectResearch,
  createWorkset,
  markProjectObservedOnly,
} from '../src/workspace/worksets.js';
import { listChanges } from '../src/core/store.js';
import { createTestDirectory, createTestRepository } from './helpers.js';

async function activateWithChange(
  home: string,
  worksetId: string,
  project: string,
  scenario = 'complex-domain-feature',
) {
  await addWorksetCandidate(home, worksetId, project);
  await beginProjectResearch(home, worksetId, project);
  return createAndActivateWorksetProjectChange(
    home,
    worksetId,
    project,
    `${project} Workset Change`,
    scenario,
  );
}

test('planning a WRE is analysis-only and does not mutate the bound Project Change', async () => {
  const home = await createTestDirectory('omnai-home-');
  const repo = await createTestRepository('user-center');
  try {
    await registerProject(home.root, repo.root, 'user');
    const workset = await createWorkset(home.root, 'Authorization Migration');
    const active = await activateWithChange(home.root, workset.id, 'user');
    const member = active.workset.members.find((item) => item.project === 'user');
    assert.ok(member?.worktree);
    const before = (await listChanges(member.worktree))[0]!;

    const reentry = await recordWorksetReentry(home.root, workset.id, {
      kind: 'DOMAIN_CHANGED',
      reason: 'AuthorizationUsage becomes an immutable historical fact.',
      affectedProjects: ['user'],
    });

    const planned = await planWorksetReentry(home.root, workset.id, reentry.id, [
      { project: 'user', outcome: 'REQUIRED', level: 'L3', reopenFrom: 'domain', taskRoots: [] },
    ]);
    assert.equal(planned.record.status, 'PENDING');
    assert.deepEqual(planned.preview[0]?.readinessClosure, [
      'domain', 'spec', 'design', 'plan', 'implementation', 'review', 'verification', 'learning',
    ]);

    const after = (await listChanges(member.worktree))[0]!;
    assert.equal(after.metadata.activeRevision, before.metadata.activeRevision);
    assert.equal(after.metadata.baseline, before.metadata.baseline);
    assert.equal((await loadWorksetReentry(home.root, workset.id, reentry.id)).status, 'PENDING');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('a WRE cannot be decided while a newly introduced candidate still needs an impact decision', async () => {
  const home = await createTestDirectory('omnai-home-');
  const userRepo = await createTestRepository('user-center');
  const pricingRepo = await createTestRepository('pricing-center');
  try {
    await registerProject(home.root, userRepo.root, 'user');
    await registerProject(home.root, pricingRepo.root, 'pricing');
    const workset = await createWorkset(home.root, 'Authorization Migration');
    await activateWithChange(home.root, workset.id, 'user');

    const reentry = await recordWorksetReentry(home.root, workset.id, {
      kind: 'DOMAIN_CHANGED',
      reason: 'Pricing may depend on new authorization semantics.',
      affectedProjects: ['user'],
      candidateProjects: ['pricing'],
    });

    await assert.rejects(
      () => planWorksetReentry(home.root, workset.id, reentry.id, [
        { project: 'user', outcome: 'REQUIRED', level: 'L3', reopenFrom: 'domain', taskRoots: [] },
        { project: 'pricing', outcome: 'NOT_REQUIRED' },
      ]),
      /pricing.*impact decision|impact decision.*pricing/i,
    );
  } finally {
    await userRepo.cleanup();
    await pricingRepo.cleanup();
    await home.cleanup();
  }
});

test('the WRE kind enforces a minimum per-project Reconcile level', async () => {
  const home = await createTestDirectory('omnai-home-');
  const repo = await createTestRepository('user-center');
  try {
    await registerProject(home.root, repo.root, 'user');
    const workset = await createWorkset(home.root, 'Authorization Migration');
    await activateWithChange(home.root, workset.id, 'user');
    const reentry = await recordWorksetReentry(home.root, workset.id, {
      kind: 'DOMAIN_CHANGED',
      reason: 'Domain semantics changed.',
      affectedProjects: ['user'],
    });

    await assert.rejects(
      () => planWorksetReentry(home.root, workset.id, reentry.id, [
        { project: 'user', outcome: 'REQUIRED', level: 'L2', reopenFrom: 'domain', taskRoots: [] },
      ]),
      /minimum.*L3|L3.*minimum/i,
    );
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('deciding freezes calculated closures and revision preconditions without applying them', async () => {
  const home = await createTestDirectory('omnai-home-');
  const repo = await createTestRepository('user-center');
  try {
    await registerProject(home.root, repo.root, 'user');
    const workset = await createWorkset(home.root, 'Authorization Migration');
    const active = await activateWithChange(home.root, workset.id, 'user');
    const member = active.workset.members.find((item) => item.project === 'user');
    assert.ok(member?.worktree);
    const before = (await listChanges(member.worktree))[0]!;

    const reentry = await recordWorksetReentry(home.root, workset.id, {
      kind: 'DOMAIN_CHANGED',
      reason: 'AuthorizationUsage becomes immutable.',
      affectedProjects: ['user'],
    });
    await planWorksetReentry(home.root, workset.id, reentry.id, [
      { project: 'user', outcome: 'REQUIRED', level: 'L3', reopenFrom: 'domain', taskRoots: [] },
    ]);

    const decided = await decideWorksetReentry(home.root, workset.id, reentry.id);
    assert.equal(decided.status, 'DECIDED');
    assert.equal(decided.rulesVersion, 1);
    assert.ok(decided.decidedAt);
    assert.equal(decided.applications.length, 1);
    const application = decided.applications[0]!;
    assert.equal(application.project, 'user');
    assert.equal(application.changeId, member.changeId);
    assert.equal(application.status, 'PENDING');
    assert.equal(application.level, 'L3');
    assert.equal(application.reopenFrom, 'domain');
    assert.deepEqual(application.readinessClosure, [
      'domain', 'spec', 'design', 'plan', 'implementation', 'review', 'verification', 'learning',
    ]);
    assert.equal(application.fromRevision, before.metadata.activeRevision);
    assert.equal(application.fromBaseline, before.metadata.baseline);

    const after = (await listChanges(member.worktree))[0]!;
    assert.equal(after.metadata.activeRevision, before.metadata.activeRevision);
    assert.equal(after.metadata.baseline, before.metadata.baseline);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('an observed-only candidate can freeze as NOT_REQUIRED without a Project Change binding', async () => {
  const home = await createTestDirectory('omnai-home-');
  const userRepo = await createTestRepository('user-center');
  const pricingRepo = await createTestRepository('pricing-center');
  try {
    await registerProject(home.root, userRepo.root, 'user');
    await registerProject(home.root, pricingRepo.root, 'pricing');
    const workset = await createWorkset(home.root, 'Authorization Migration');
    await activateWithChange(home.root, workset.id, 'user');
    const reentry = await recordWorksetReentry(home.root, workset.id, {
      kind: 'SCOPE_CHANGED',
      reason: 'Pricing was investigated for possible scope expansion.',
      affectedProjects: ['user'],
      candidateProjects: ['pricing'],
    });
    await beginProjectResearch(home.root, workset.id, 'pricing');
    await markProjectObservedOnly(home.root, workset.id, 'pricing');

    await planWorksetReentry(home.root, workset.id, reentry.id, [
      { project: 'user', outcome: 'REQUIRED', level: 'L3', reopenFrom: 'spec', taskRoots: [] },
      { project: 'pricing', outcome: 'NOT_REQUIRED' },
    ]);
    const decided = await decideWorksetReentry(home.root, workset.id, reentry.id);
    const pricing = decided.applications.find((item) => item.project === 'pricing');
    assert.equal(pricing?.status, 'NOT_REQUIRED');
    assert.equal(pricing?.changeId, undefined);
  } finally {
    await userRepo.cleanup();
    await pricingRepo.cleanup();
    await home.cleanup();
  }
});
