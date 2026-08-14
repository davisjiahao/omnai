import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createAndActivateWorksetProjectChange } from '../src/workspace/change-bindings.js';
import { createTestDirectory, createTestRepository } from './helpers.js';
import { registerProject } from '../src/workspace/project-registry.js';
import {
  addWorksetCandidate,
  beginProjectResearch,
  createWorkset,
  markProjectObservedOnly,
} from '../src/workspace/worksets.js';
import {
  recordWorksetReentry,
  resolveWorksetReentry,
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
  });

  await beginProjectResearch(home.root, workset.id, 'pricing');
  assert.deepEqual(await resolveWorksetNext(home.root, workset.id), {
    action: 'decide-project-impact',
    project: 'pricing',
    reason: 'Read-only research must decide whether this project needs modification.',
  });

  await markProjectObservedOnly(home.root, workset.id, 'pricing');
  assert.deepEqual(await resolveWorksetNext(home.root, workset.id), {
    action: 'reenter',
    reentryId: reentry.id,
    capability: 'model',
    interaction: 'grill',
    affectedProjects: ['user', 'quote'],
    reason: 'Domain meaning, ownership, lifecycle, or invariant changed.',
  });

  await resolveWorksetReentry(home.root, workset.id, reentry.id);
  assert.deepEqual(await resolveWorksetNext(home.root, workset.id), {
    action: 'project-workflow',
    project: 'user',
    reason: 'Active project is ready for its repository-local OmnAI workflow.',
  });
});

test('pending Re-entry outranks ordinary active-project work and resolves oldest first', async () => {
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
  const second = await recordWorksetReentry(home.root, workset.id, {
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
  });

  await resolveWorksetReentry(home.root, workset.id, first.id);
  assert.deepEqual(await resolveWorksetNext(home.root, workset.id), {
    action: 'reenter',
    reentryId: second.id,
    capability: 'plan',
    interaction: 'none',
    affectedProjects: ['user'],
    reason: 'Only task structure, dependency order, or delivery sequencing changed.',
  });
});
