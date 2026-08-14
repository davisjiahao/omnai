import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createAndActivateWorksetProjectChange } from '../src/workspace/change-bindings.js';
import { applyWorksetReentry } from '../src/workspace/reconcile-apply.js';
import { decideWorksetReentry, planWorksetReentry } from '../src/workspace/reconcile-plan.js';
import { recordWorksetReentry, saveWorksetReentry } from '../src/workspace/reentry.js';
import { registerProject } from '../src/workspace/project-registry.js';
import { resolveWorksetNext } from '../src/workspace/workset-router.js';
import { addWorksetCandidate, beginProjectResearch, createWorkset } from '../src/workspace/worksets.js';
import { createTestDirectory, createTestRepository } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

test('router surfaces interrupted finalization when every application is final but WRE is still DECIDED', async () => {
  const home = await createTestDirectory('omnai-home-');
  const repo = await createTestRepository('user-center');
  cleanups.push(home.cleanup, repo.cleanup);
  await registerProject(home.root, repo.root, 'user');
  const workset = await createWorkset(home.root, 'Authorization Migration');
  await addWorksetCandidate(home.root, workset.id, 'user');
  await beginProjectResearch(home.root, workset.id, 'user');
  await createAndActivateWorksetProjectChange(home.root, workset.id, 'user', 'User Workset Change', 'small-feature');

  const reentry = await recordWorksetReentry(home.root, workset.id, {
    kind: 'PLAN_CHANGED',
    reason: 'Delivery sequence changed.',
    affectedProjects: ['user'],
  });
  await planWorksetReentry(home.root, workset.id, reentry.id, [
    { project: 'user', outcome: 'REQUIRED', level: 'L1', reopenFrom: 'plan', taskRoots: [] },
  ]);
  const decided = await decideWorksetReentry(home.root, workset.id, reentry.id);
  decided.applications[0]!.status = 'APPLIED';
  await saveWorksetReentry(home.root, decided);

  assert.deepEqual(await resolveWorksetNext(home.root, workset.id), {
    action: 'finalize-reentry',
    reentryId: reentry.id,
    reason: `Approved Re-entry ${reentry.id} has all project applications complete and must be finalized.`,
  });

  const recovered = await applyWorksetReentry(home.root, workset.id, reentry.id);
  assert.equal(recovered.status, 'RESOLVED');
});
