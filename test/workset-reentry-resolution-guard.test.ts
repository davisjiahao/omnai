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
  pendingWorksetReentry,
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
  await createAndActivateWorksetProjectChange(home, worksetId, project, `${project} Workset Change`, 'small-feature');
}

test('B2a Re-entry cannot resolve directly even after candidate impact is decided', async () => {
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
    /B2a lifecycle|cannot be resolved directly/i,
  );

  await beginProjectResearch(home.root, workset.id, 'pricing');
  await markProjectObservedOnly(home.root, workset.id, 'pricing');
  await assert.rejects(
    () => resolveWorksetReentry(home.root, workset.id, reentry.id),
    /B2a lifecycle|cannot be resolved directly/i,
  );
  assert.equal((await pendingWorksetReentry(home.root, workset.id))?.id, reentry.id);
});

test('oldest B2a PENDING Re-entry remains the deterministic pending record', async () => {
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
    /B2a lifecycle|cannot be resolved directly/i,
  );
  assert.equal((await pendingWorksetReentry(home.root, workset.id))?.id, first.id);
});
