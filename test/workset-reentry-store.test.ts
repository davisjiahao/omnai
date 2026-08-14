import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { join } from 'node:path';
import { pathExists } from '../src/core/files.js';
import { createAndActivateWorksetProjectChange } from '../src/workspace/change-bindings.js';
import { createTestDirectory, createTestRepository } from './helpers.js';
import { registerProject } from '../src/workspace/project-registry.js';
import {
  addWorksetCandidate,
  beginProjectResearch,
  createWorkset,
  markProjectObservedOnly,
  resolveWorkset,
} from '../src/workspace/worksets.js';
import { worksetReentryPath, worksetWorkspaceRoot } from '../src/workspace/paths.js';
import {
  listWorksetReentries,
  pendingWorksetReentry,
  recordWorksetReentry,
  resolveWorksetReentry,
} from '../src/workspace/reentry.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function activateBound(home: string, worksetId: string, project: string): Promise<void> {
  await addWorksetCandidate(home, worksetId, project);
  await beginProjectResearch(home, worksetId, project);
  await createAndActivateWorksetProjectChange(home, worksetId, project, `${project} Workset Change`, 'small-feature');
}

test('persists monotonic Workset Re-entry records and reloads them in order', async () => {
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(home.cleanup);
  const workset = await createWorkset(home.root, 'Authorization Migration');

  const first = await recordWorksetReentry(home.root, workset.id, {
    kind: 'DOMAIN_CHANGED',
    reason: 'Historical quotes must preserve authorization state at quote time.',
  });
  const second = await recordWorksetReentry(home.root, workset.id, {
    kind: 'TECHNICAL_CONSTRAINT_CHANGED',
    reason: 'Database dual-write is no longer allowed.',
  });

  assert.equal(first.id, 'WRE-0001');
  assert.equal(second.id, 'WRE-0002');
  assert.equal(first.status, 'PENDING');
  assert.equal(first.route.capability, 'model');
  assert.equal(first.route.interaction, 'grill');
  assert.equal(await pathExists(worksetReentryPath(home.root, workset.id, first.id)), true);

  const records = await listWorksetReentries(home.root, workset.id);
  assert.deepEqual(records.map((item) => item.id), ['WRE-0001', 'WRE-0002']);
  assert.deepEqual(records.map((item) => item.reason), [
    'Historical quotes must preserve authorization state at quote time.',
    'Database dual-write is no longer allowed.',
  ]);
  assert.equal((await pendingWorksetReentry(home.root, workset.id))?.id, 'WRE-0001');
});

test('resolves a pending Re-entry without rewriting its original route or reason', async () => {
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(home.cleanup);
  const workset = await createWorkset(home.root, 'Authorization Migration');
  const created = await recordWorksetReentry(home.root, workset.id, {
    kind: 'SCOPE_CHANGED',
    reason: 'The Web client is now in scope.',
    affectedProjects: [],
    candidateProjects: [],
  });

  const resolved = await resolveWorksetReentry(home.root, workset.id, created.id);
  assert.equal(resolved.status, 'RESOLVED');
  assert.ok(resolved.resolvedAt);
  assert.equal(resolved.reason, created.reason);
  assert.deepEqual(resolved.route, created.route);
  assert.deepEqual(resolved.affectedProjects, []);
  assert.deepEqual(resolved.candidateProjects, []);
  assert.equal(await pendingWorksetReentry(home.root, workset.id), null);

  const again = await resolveWorksetReentry(home.root, workset.id, created.id);
  assert.deepEqual(again, resolved);
});

test('injects newly affected registered repositories as read-only candidates before persisting Re-entry', async () => {
  const home = await createTestDirectory('omnai-home-');
  const userRepo = await createTestRepository('user-center');
  const quoteRepo = await createTestRepository('quote-center');
  const pricingRepo = await createTestRepository('pricing-center');
  cleanups.push(home.cleanup, userRepo.cleanup, quoteRepo.cleanup, pricingRepo.cleanup);

  await registerProject(home.root, userRepo.root, 'user');
  await registerProject(home.root, quoteRepo.root, 'quote');
  await registerProject(home.root, pricingRepo.root, 'pricing');
  const workset = await createWorkset(home.root, 'Authorization Migration');

  await activateBound(home.root, workset.id, 'user');
  await activateBound(home.root, workset.id, 'quote');

  const record = await recordWorksetReentry(home.root, workset.id, {
    kind: 'SCOPE_CHANGED',
    reason: 'Pricing must now use authorization scope.',
    affectedProjects: ['user', 'quote'],
    candidateProjects: ['pricing'],
  });

  const updated = await resolveWorkset(home.root, workset.id);
  const pricing = updated.members.find((member) => member.project === 'pricing');
  assert.equal(pricing?.status, 'CANDIDATE');
  assert.equal(pricing?.worktree, undefined);
  assert.equal(await pathExists(join(worksetWorkspaceRoot(home.root, workset.id), 'pricing')), false);
  assert.deepEqual(record.affectedProjects, ['user', 'quote']);
  assert.deepEqual(record.candidateProjects, ['pricing']);
});

test('candidate injection never resets an existing member lifecycle', async () => {
  const home = await createTestDirectory('omnai-home-');
  const userRepo = await createTestRepository('user-center');
  const pricingRepo = await createTestRepository('pricing-center');
  cleanups.push(home.cleanup, userRepo.cleanup, pricingRepo.cleanup);

  await registerProject(home.root, userRepo.root, 'user');
  await registerProject(home.root, pricingRepo.root, 'pricing');
  const workset = await createWorkset(home.root, 'Authorization Migration');
  await activateBound(home.root, workset.id, 'user');
  await addWorksetCandidate(home.root, workset.id, 'pricing');
  await beginProjectResearch(home.root, workset.id, 'pricing');
  await markProjectObservedOnly(home.root, workset.id, 'pricing');

  await recordWorksetReentry(home.root, workset.id, {
    kind: 'DOMAIN_CHANGED',
    reason: 'Authorization semantics changed.',
    affectedProjects: ['user'],
    candidateProjects: ['pricing'],
  });

  const updated = await resolveWorkset(home.root, workset.id);
  assert.equal(updated.members.filter((member) => member.project === 'pricing').length, 1);
  assert.equal(updated.members.find((member) => member.project === 'pricing')?.status, 'OBSERVED_ONLY');
});

test('validates every affected and candidate project before mutating Workset or Re-entry state', async () => {
  const home = await createTestDirectory('omnai-home-');
  const userRepo = await createTestRepository('user-center');
  cleanups.push(home.cleanup, userRepo.cleanup);
  await registerProject(home.root, userRepo.root, 'user');
  const workset = await createWorkset(home.root, 'Authorization Migration');
  await activateBound(home.root, workset.id, 'user');

  await assert.rejects(
    () => recordWorksetReentry(home.root, workset.id, {
      kind: 'SCOPE_CHANGED',
      reason: 'A missing service might be affected.',
      affectedProjects: ['user'],
      candidateProjects: ['missing-service'],
    }),
    /not registered/,
  );
  assert.deepEqual((await resolveWorkset(home.root, workset.id)).members.map((member) => member.project), ['user']);
  assert.deepEqual(await listWorksetReentries(home.root, workset.id), []);

  await assert.rejects(
    () => recordWorksetReentry(home.root, workset.id, {
      kind: 'DOMAIN_CHANGED',
      reason: 'Unknown affected project.',
      affectedProjects: ['ghost'],
    }),
    /not a member/,
  );
  assert.deepEqual(await listWorksetReentries(home.root, workset.id), []);
});

test('fails explicitly for unknown Worksets and Re-entry ids', async () => {
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(home.cleanup);
  const workset = await createWorkset(home.root, 'Authorization Migration');

  await assert.rejects(
    () => recordWorksetReentry(home.root, 'WKS-9999', {
      kind: 'PLAN_CHANGED',
      reason: 'Delivery order changed.',
    }),
    /Workset 'WKS-9999' was not found/,
  );

  await assert.rejects(
    () => resolveWorksetReentry(home.root, workset.id, 'WRE-9999'),
    /Re-entry 'WRE-9999' was not found/,
  );
});
