import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createAndBindWorksetProjectChange } from '../src/workspace/change-bindings.js';
import { createTestDirectory, createTestRepository } from './helpers.js';
import { registerProject } from '../src/workspace/project-registry.js';
import {
  activateWorksetProject,
  addWorksetCandidate,
  beginProjectResearch,
  createWorkset,
  markProjectObservedOnly,
} from '../src/workspace/worksets.js';
import {
  recordWorksetReentry,
  resolveWorksetReentry,
} from '../src/workspace/reentry.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function activate(home: string, worksetId: string, project: string): Promise<void> {
  await addWorksetCandidate(home, worksetId, project);
  await beginProjectResearch(home, worksetId, project);
  await createAndBindWorksetProjectChange(home, worksetId, project, `${project} Workset Change`, 'small-feature');
  await activateWorksetProject(home, worksetId, project);
}

test('cannot resolve a Re-entry while one of its newly introduced candidates still needs an impact decision', async () => {
  const home = await createTestDirectory('omnai-home-');
  const userRepo = await createTestRepository('user-center');
  const pricingRepo = await createTestRepository('pricing-center');
  cleanups.push(home.cleanup, userRepo.cleanup, pricingRepo.cleanup);

  await registerProject(home.root, userRepo.root, 'user');
  await registerProject(home.root, pricingRepo.root, 'pricing');
  const workset = await createWorkset(home.root, 'Authorization Migration');
  await activate(home.root, workset.id, 'user');

  const reentry = await recordWorksetReentry(home.root, workset.id, {
    kind: 'DOMAIN_CHANGED',
    reason: 'Pricing may now depend on authorization semantics.',
    affectedProjects: ['user'],
    candidateProjects: ['pricing'],
  });

  await assert.rejects(
    () => resolveWorksetReentry(home.root, workset.id, reentry.id),
    /pricing.*impact decision|impact decision.*pricing/i,
  );

  await beginProjectResearch(home.root, workset.id, 'pricing');
  await assert.rejects(
    () => resolveWorksetReentry(home.root, workset.id, reentry.id),
    /pricing.*impact decision|impact decision.*pricing/i,
  );

  await markProjectObservedOnly(home.root, workset.id, 'pricing');
  const resolved = await resolveWorksetReentry(home.root, workset.id, reentry.id);
  assert.equal(resolved.status, 'RESOLVED');
});

test('cannot resolve a newer pending Re-entry before the oldest pending record', async () => {
  const home = await createTestDirectory('omnai-home-');
  const userRepo = await createTestRepository('user-center');
  cleanups.push(home.cleanup, userRepo.cleanup);

  await registerProject(home.root, userRepo.root, 'user');
  const workset = await createWorkset(home.root, 'Authorization Migration');
  await activate(home.root, workset.id, 'user');

  const first = await recordWorksetReentry(home.root, workset.id, {
    kind: 'DOMAIN_CHANGED',
    reason: 'Domain semantics changed.',
    affectedProjects: ['user'],
  });
  const second = await recordWorksetReentry(home.root, workset.id, {
    kind: 'PLAN_CHANGED',
    reason: 'Delivery order also changed.',
    affectedProjects: ['user'],
  });

  await assert.rejects(
    () => resolveWorksetReentry(home.root, workset.id, second.id),
    new RegExp(`${first.id}.*before|before.*${first.id}`, 'i'),
  );

  assert.equal((await resolveWorksetReentry(home.root, workset.id, first.id)).status, 'RESOLVED');
  assert.equal((await resolveWorksetReentry(home.root, workset.id, second.id)).status, 'RESOLVED');
});
