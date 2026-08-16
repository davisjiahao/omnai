import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcileChange } from '../src/core/reconcile.js';
import { resolveChange } from '../src/core/store.js';
import { createAndActivateWorksetProjectChange } from '../src/workspace/change-bindings.js';
import { registerProject } from '../src/workspace/project-registry.js';
import { applyWorksetReentry } from '../src/workspace/reconcile-apply.js';
import { decideWorksetReentry, planWorksetReentry } from '../src/workspace/reconcile-plan.js';
import {
  confirmFailedWorksetReentryApplicationReplan,
  previewFailedWorksetReentryApplicationReplan,
} from '../src/workspace/reconcile-replan.js';
import { recordWorksetReentry } from '../src/workspace/reentry.js';
import { addWorksetCandidate, beginProjectResearch, createWorkset } from '../src/workspace/worksets.js';
import { createTestDirectory, createTestRepository } from './helpers.js';

async function activate(home: string, worksetId: string, repoRoot: string, alias: string) {
  await registerProject(home, repoRoot, alias);
  await addWorksetCandidate(home, worksetId, alias);
  await beginProjectResearch(home, worksetId, alias);
  const active = await createAndActivateWorksetProjectChange(
    home,
    worksetId,
    alias,
    `${alias} Workset Change`,
    'complex-domain-feature',
  );
  const member = active.workset.members.find((item) => item.project === alias);
  assert.ok(member?.worktree);
  assert.ok(member.changeId);
  return { worktree: member.worktree, changeId: member.changeId };
}

test('APPLIED sibling stays fixed while stale sibling is previewed, confirmed, applied once, and resolves the WRE', async () => {
  const home = await createTestDirectory('omnai-home-');
  const userRepo = await createTestRepository('user-center');
  const quoteRepo = await createTestRepository('quote-center');
  try {
    const workset = await createWorkset(home.root, 'Authorization Migration');
    const user = await activate(home.root, workset.id, userRepo.root, 'user');
    const quote = await activate(home.root, workset.id, quoteRepo.root, 'quote');

    const reentry = await recordWorksetReentry(home.root, workset.id, {
      kind: 'SCOPE_CHANGED',
      reason: 'Authorization scope changed across user and quote.',
      affectedProjects: ['user', 'quote'],
    });
    await planWorksetReentry(home.root, workset.id, reentry.id, [
      { project: 'user', outcome: 'REQUIRED', level: 'L3', reopenFrom: 'spec', taskRoots: [] },
      { project: 'quote', outcome: 'REQUIRED', level: 'L3', reopenFrom: 'spec', taskRoots: [] },
    ]);
    const decided = await decideWorksetReentry(home.root, workset.id, reentry.id);

    const quoteChange = await resolveChange(quote.worktree, quote.changeId);
    await reconcileChange(quote.worktree, quoteChange, {
      level: 'L0',
      type: 'INDEPENDENT_CHANGE',
      reason: 'Quote changed after WRE decision.',
    });
    assert.equal(quoteChange.metadata.activeRevision, 'REV-0002');

    const partiallyApplied = await applyWorksetReentry(home.root, workset.id, decided.id);
    assert.equal(partiallyApplied.status, 'DECIDED');
    assert.equal(partiallyApplied.applications.find((item) => item.project === 'user')?.status, 'APPLIED');
    assert.equal(partiallyApplied.applications.find((item) => item.project === 'quote')?.failureKind, 'STALE_PRECONDITION');
    assert.equal((await resolveChange(user.worktree, user.changeId)).metadata.activeRevision, 'REV-0002');
    assert.equal((await resolveChange(quote.worktree, quote.changeId)).metadata.activeRevision, 'REV-0002');

    const preview = await previewFailedWorksetReentryApplicationReplan(home.root, workset.id, decided.id, 'quote');
    assert.equal(preview.fromRevision, 'REV-0002');
    assert.equal(preview.fromBaseline, 'BL-0002');
    assert.equal(partiallyApplied.applications.find((item) => item.project === 'quote')?.status, 'FAILED');

    const confirmed = await confirmFailedWorksetReentryApplicationReplan(home.root, workset.id, decided.id, 'quote');
    const quotePending = confirmed.applications.find((item) => item.project === 'quote');
    assert.equal(confirmed.status, 'DECIDED');
    assert.equal(quotePending?.status, 'PENDING');
    assert.equal(quotePending?.fromRevision, 'REV-0002');
    assert.equal(quotePending?.attemptHistory.length, 1);
    assert.equal((await resolveChange(user.worktree, user.changeId)).metadata.activeRevision, 'REV-0002');

    const resolved = await applyWorksetReentry(home.root, workset.id, decided.id, 'quote');
    assert.equal(resolved.status, 'RESOLVED');
    assert.equal(resolved.applications.find((item) => item.project === 'user')?.toRevision, 'REV-0002');
    assert.equal(resolved.applications.find((item) => item.project === 'quote')?.toRevision, 'REV-0003');
    assert.equal((await resolveChange(user.worktree, user.changeId)).metadata.activeRevision, 'REV-0002');
    assert.equal((await resolveChange(quote.worktree, quote.changeId)).metadata.activeRevision, 'REV-0003');
  } finally {
    await userRepo.cleanup();
    await quoteRepo.cleanup();
    await home.cleanup();
  }
});
