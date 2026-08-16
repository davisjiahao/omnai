import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createAndActivateWorksetProjectChange } from '../src/workspace/change-bindings.js';
import { createTestDirectory, createTestRepository } from './helpers.js';
import { registerProject } from '../src/workspace/project-registry.js';
import {
  decideWorksetReentry,
  planWorksetReentry,
} from '../src/workspace/reconcile-plan.js';
import {
  addWorksetCandidate,
  beginProjectResearch,
  createWorkset,
  markProjectObservedOnly,
} from '../src/workspace/worksets.js';
import {
  recordWorksetReentry,
  resolveWorksetReentry,
  saveWorksetReentry,
} from '../src/workspace/reentry.js';
import { resolveWorksetNext } from '../src/workspace/workset-router.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function activate(home: string, worksetId: string, project: string): Promise<void> {
  await addWorksetCandidate(home, worksetId, project);
  await beginProjectResearch(home, worksetId, project);
  await createAndActivateWorksetProjectChange(home, worksetId, project, `${project} Workset Change`, 'small-feature');
}

test('new candidate research and impact decisions outrank pending Grill re-entry', async () => {
  const home = await createTestDirectory('omnai-home-');
  const userRepo = await createTestRepository('user-center');
  const quoteRepo = await createTestRepository('quote-center');
  const pricingRepo = await createTestRepository('pricing-center');
  cleanups.push(home.cleanup, userRepo.cleanup, quoteRepo.cleanup, pricingRepo.cleanup);

  await registerProject(home.root, userRepo.root, 'user');
  await registerProject(home.root, quoteRepo.root, 'quote');
  await registerProject(home.root, pricingRepo.root, 'pricing');
  const workset = await createWorkset(home.root, 'Authorization Migration');
  await activate(home.root, workset.id, 'user');
  await activate(home.root, workset.id, 'quote');

  const reentry = await recordWorksetReentry(home.root, workset.id, {
    kind: 'DOMAIN_CHANGED',
    reason: 'Historical quote authorization semantics changed and pricing may be affected.',
    affectedProjects: ['user', 'quote'],
    candidateProjects: ['pricing'],
  });

  assert.deepEqual(await resolveWorksetNext(home.root, workset.id), {
    action: 'inspect-project',
    project: 'pricing',
    reason: 'Candidate project requires read-only research before activation.',
    protocolIds: ['workset.candidate-research'],
  });

  await beginProjectResearch(home.root, workset.id, 'pricing');
  assert.deepEqual(await resolveWorksetNext(home.root, workset.id), {
    action: 'decide-project-impact',
    project: 'pricing',
    reason: 'Read-only research must decide whether this project needs modification.',
    protocolIds: ['workset.project-impact-decision'],
  });

  await markProjectObservedOnly(home.root, workset.id, 'pricing');
  assert.deepEqual(await resolveWorksetNext(home.root, workset.id), {
    action: 'reenter',
    reentryId: reentry.id,
    capability: 'model',
    interaction: 'grill',
    affectedProjects: ['user', 'quote'],
    reason: 'Domain meaning, ownership, lifecycle, or invariant changed.',
    protocolIds: [
      'workset.reentry-interaction',
      'interaction.grill',
      'repository.model',
      'workset.reentry-plan',
    ],
  });

  await assert.rejects(
    () => resolveWorksetReentry(home.root, workset.id, reentry.id),
    /B2a lifecycle|cannot be resolved directly/i,
  );
  assert.equal((await resolveWorksetNext(home.root, workset.id)).action, 'reenter');
});

test('oldest pending Re-entry outranks ordinary active-project work', async () => {
  const home = await createTestDirectory('omnai-home-');
  const userRepo = await createTestRepository('user-center');
  cleanups.push(home.cleanup, userRepo.cleanup);
  await registerProject(home.root, userRepo.root, 'user');
  const workset = await createWorkset(home.root, 'Authorization Migration');
  await activate(home.root, workset.id, 'user');

  const first = await recordWorksetReentry(home.root, workset.id, {
    kind: 'TECHNICAL_CONSTRAINT_CHANGED',
    reason: 'Dual-write is prohibited.',
    affectedProjects: ['user'],
  });
  await recordWorksetReentry(home.root, workset.id, {
    kind: 'PLAN_CHANGED',
    reason: 'Delivery order changed.',
    affectedProjects: ['user'],
  });

  assert.deepEqual(await resolveWorksetNext(home.root, workset.id), {
    action: 'reenter',
    reentryId: first.id,
    capability: 'design',
    interaction: 'brainstorm',
    affectedProjects: ['user'],
    reason: 'A technical constraint invalidated the selected implementation approach.',
    protocolIds: [
      'workset.reentry-interaction',
      'interaction.brainstorm',
      'repository.design',
      'workset.reentry-plan',
    ],
  });

  await assert.rejects(
    () => resolveWorksetReentry(home.root, workset.id, first.id),
    /B2a lifecycle|cannot be resolved directly/i,
  );
  assert.equal((await resolveWorksetNext(home.root, workset.id) as { reentryId?: string }).reentryId, first.id);
});

test('planned PENDING Re-entry routes to explicit decision instead of repeating the interaction', async () => {
  const home = await createTestDirectory('omnai-home-');
  const userRepo = await createTestRepository('user-center');
  cleanups.push(home.cleanup, userRepo.cleanup);
  await registerProject(home.root, userRepo.root, 'user');
  const workset = await createWorkset(home.root, 'Authorization Migration');
  await activate(home.root, workset.id, 'user');

  const reentry = await recordWorksetReentry(home.root, workset.id, {
    kind: 'PLAN_CHANGED',
    reason: 'Delivery order changed.',
    affectedProjects: ['user'],
  });
  await planWorksetReentry(home.root, workset.id, reentry.id, [
    { project: 'user', outcome: 'REQUIRED', level: 'L1', reopenFrom: 'plan', taskRoots: [] },
  ]);

  assert.deepEqual(await resolveWorksetNext(home.root, workset.id), {
    action: 'decide-reentry',
    reentryId: reentry.id,
    reason: `Re-entry ${reentry.id} has a calculated Project Reconcile proposal ready for explicit decision.`,
    protocolIds: ['workset.reentry-decision'],
  });
});

test('a planned newer PENDING Re-entry yields to an older outstanding DECIDED application', async () => {
  const home = await createTestDirectory('omnai-home-');
  const userRepo = await createTestRepository('user-center');
  cleanups.push(home.cleanup, userRepo.cleanup);
  await registerProject(home.root, userRepo.root, 'user');
  const workset = await createWorkset(home.root, 'Authorization Migration');
  await activate(home.root, workset.id, 'user');

  const first = await recordWorksetReentry(home.root, workset.id, {
    kind: 'PLAN_CHANGED',
    reason: 'First delivery order change.',
    affectedProjects: ['user'],
  });
  await planWorksetReentry(home.root, workset.id, first.id, [
    { project: 'user', outcome: 'REQUIRED', level: 'L1', reopenFrom: 'plan', taskRoots: [] },
  ]);
  await decideWorksetReentry(home.root, workset.id, first.id);

  const second = await recordWorksetReentry(home.root, workset.id, {
    kind: 'PLAN_CHANGED',
    reason: 'Second delivery order change.',
    affectedProjects: ['user'],
  });
  await planWorksetReentry(home.root, workset.id, second.id, [
    { project: 'user', outcome: 'REQUIRED', level: 'L1', reopenFrom: 'plan', taskRoots: [] },
  ]);

  assert.deepEqual(await resolveWorksetNext(home.root, workset.id), {
    action: 'apply-reentry',
    reentryId: first.id,
    project: 'user',
    applicationStatus: 'PENDING',
    reason: `Approved Re-entry ${first.id} has a PENDING project reconciliation for user.`,
    protocolIds: ['workset.reentry-apply'],
  });
});

test('stale-precondition FAILED application routes to explicit replan instead of guaranteed-failing apply retry', async () => {
  const home = await createTestDirectory('omnai-home-');
  const userRepo = await createTestRepository('user-center');
  cleanups.push(home.cleanup, userRepo.cleanup);
  await registerProject(home.root, userRepo.root, 'user');
  const workset = await createWorkset(home.root, 'Authorization Migration');
  await activate(home.root, workset.id, 'user');

  const reentry = await recordWorksetReentry(home.root, workset.id, {
    kind: 'PLAN_CHANGED',
    reason: 'Delivery order changed.',
    affectedProjects: ['user'],
  });
  await planWorksetReentry(home.root, workset.id, reentry.id, [
    { project: 'user', outcome: 'REQUIRED', level: 'L1', reopenFrom: 'plan', taskRoots: [] },
  ]);
  const decided = await decideWorksetReentry(home.root, workset.id, reentry.id);
  const application = decided.applications[0]!;
  application.status = 'FAILED';
  application.failureKind = 'STALE_PRECONDITION';
  application.error = 'Frozen revision drifted.';
  await saveWorksetReentry(home.root, decided);

  assert.deepEqual(await resolveWorksetNext(home.root, workset.id), {
    action: 'replan-reentry',
    reentryId: reentry.id,
    project: 'user',
    reason: `Approved Re-entry ${reentry.id} has a stale frozen precondition for user and requires explicit replan.`,
    protocolIds: ['workset.reentry-replan'],
  });
});

test('non-stale FAILED application remains on repair-and-retry apply route', async () => {
  const home = await createTestDirectory('omnai-home-');
  const userRepo = await createTestRepository('user-center');
  cleanups.push(home.cleanup, userRepo.cleanup);
  await registerProject(home.root, userRepo.root, 'user');
  const workset = await createWorkset(home.root, 'Authorization Migration');
  await activate(home.root, workset.id, 'user');

  const reentry = await recordWorksetReentry(home.root, workset.id, {
    kind: 'PLAN_CHANGED',
    reason: 'Delivery order changed.',
    affectedProjects: ['user'],
  });
  await planWorksetReentry(home.root, workset.id, reentry.id, [
    { project: 'user', outcome: 'REQUIRED', level: 'L1', reopenFrom: 'plan', taskRoots: [] },
  ]);
  const decided = await decideWorksetReentry(home.root, workset.id, reentry.id);
  const application = decided.applications[0]!;
  application.status = 'FAILED';
  application.failureKind = 'APPLY_ERROR';
  application.error = 'Transient apply failure.';
  await saveWorksetReentry(home.root, decided);

  assert.deepEqual(await resolveWorksetNext(home.root, workset.id), {
    action: 'apply-reentry',
    reentryId: reentry.id,
    project: 'user',
    applicationStatus: 'FAILED',
    reason: `Approved Re-entry ${reentry.id} has a FAILED project reconciliation for user.`,
    protocolIds: ['workset.reentry-apply'],
  });
});
