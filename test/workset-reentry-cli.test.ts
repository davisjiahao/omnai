import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { reconcileChange } from '../src/core/reconcile.js';
import { resolveChange } from '../src/core/store.js';
import { createTestDirectory, createTestRepository } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function runCli(home: string, args: string[]) {
  return spawnSync(process.execPath, [resolve('dist/src/main.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, OMNAI_HOME: home },
  });
}

function runJson(home: string, args: string[]) {
  const result = runCli(home, [...args, '--json']);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function activateProject(home: string, project: string) {
  runJson(home, ['workset', 'add-candidate', project]);
  runJson(home, ['workset', 'inspect-project', project]);
  return runJson(home, ['workset', 'create-change', project, `${project} Workset Change`, '--scenario', 'small-feature']);
}

async function createStaleCliReentry(home: string, repoRoot: string) {
  runJson(home, ['project', 'register', repoRoot, '--alias', 'user']);
  const workset = runJson(home, ['workset', 'new', 'Authorization Migration']);
  const active = activateProject(home, 'user');
  const reentry = runJson(home, [
    'workset', 'change',
    '--kind', 'PLAN_CHANGED',
    '--reason', 'Delivery order changed.',
    '--project', 'user',
  ]);
  const proposalPath = join(home, `${reentry.id}-proposal.yaml`);
  await writeFile(proposalPath, [
    '- project: user',
    '  outcome: REQUIRED',
    '  level: L1',
    '  reopenFrom: plan',
    '  taskRoots: []',
    '',
  ].join('\n'), 'utf8');
  runJson(home, ['workset', 'reentry', 'plan', reentry.id, '--file', proposalPath, '--workset', workset.id]);
  runJson(home, ['workset', 'reentry', 'decide', reentry.id, '--workset', workset.id]);

  const worktree = active.member.worktree as string;
  const changeId = active.change.id as string;
  const change = await resolveChange(worktree, changeId);
  await reconcileChange(worktree, change, {
    level: 'L0',
    type: 'INDEPENDENT_CHANGE',
    reason: 'Project changed after the WRE decision.',
  });
  const failed = runJson(home, ['workset', 'reentry', 'apply', reentry.id, '--project', 'user', '--workset', workset.id]);
  assert.equal(failed.applications[0].failureKind, 'STALE_PRECONDITION');
  return { workset, reentry, worktree, changeId };
}

test('runs mid-flight change through research, frozen decision, project reconcile apply, and RESOLVED', async () => {
  const home = await createTestDirectory('omnai-home-');
  const userRepo = await createTestRepository('user-center');
  const quoteRepo = await createTestRepository('quote-center');
  const pricingRepo = await createTestRepository('pricing-center');
  cleanups.push(home.cleanup, userRepo.cleanup, quoteRepo.cleanup, pricingRepo.cleanup);

  runJson(home.root, ['project', 'register', userRepo.root, '--alias', 'user']);
  runJson(home.root, ['project', 'register', quoteRepo.root, '--alias', 'quote']);
  runJson(home.root, ['project', 'register', pricingRepo.root, '--alias', 'pricing']);
  const workset = runJson(home.root, ['workset', 'new', 'Authorization Migration']);
  activateProject(home.root, 'user');
  activateProject(home.root, 'quote');

  const change = runJson(home.root, [
    'workset', 'change',
    '--kind', 'DOMAIN_CHANGED',
    '--reason', 'Historical quotes must preserve authorization state and pricing may be affected.',
    '--project', 'user',
    '--project', 'quote',
    '--candidate', 'pricing',
  ]);
  assert.equal(change.id, 'WRE-0001');
  assert.equal(change.status, 'PENDING');

  assert.equal(runJson(home.root, ['workset', 'next', workset.id]).action, 'inspect-project');
  runJson(home.root, ['workset', 'inspect-project', 'pricing']);
  runJson(home.root, ['workset', 'inspect-project', 'pricing', '--result', 'observed-only']);

  const reenter = runJson(home.root, ['workset', 'next', workset.id]);
  assert.equal(reenter.action, 'reenter');
  assert.equal(reenter.reentryId, 'WRE-0001');
  assert.equal(reenter.capability, 'model');
  assert.equal(reenter.interaction, 'grill');

  const proposalPath = join(home.root, 'WRE-0001-proposal.yaml');
  await writeFile(proposalPath, [
    '- project: user',
    '  outcome: REQUIRED',
    '  level: L3',
    '  reopenFrom: spec',
    '  taskRoots: []',
    '- project: quote',
    '  outcome: REQUIRED',
    '  level: L3',
    '  reopenFrom: spec',
    '  taskRoots: []',
    '- project: pricing',
    '  outcome: NOT_REQUIRED',
    '',
  ].join('\n'), 'utf8');

  const planned = runJson(home.root, [
    'workset', 'reentry', 'plan', 'WRE-0001', '--file', proposalPath, '--workset', workset.id,
  ]);
  assert.equal(planned.record.status, 'PENDING');
  assert.equal(planned.preview.length, 3);
  assert.deepEqual(planned.preview.find((item: { project: string }) => item.project === 'user').readinessClosure, [
    'spec', 'design', 'plan', 'implementation', 'verification',
  ]);

  const decided = runJson(home.root, [
    'workset', 'reentry', 'decide', 'WRE-0001', '--workset', workset.id,
  ]);
  assert.equal(decided.status, 'DECIDED');
  assert.equal(decided.rulesVersion, 1);
  assert.equal(decided.applications.find((item: { project: string }) => item.project === 'pricing').status, 'NOT_REQUIRED');

  const status = runJson(home.root, [
    'workset', 'reentry', 'status', 'WRE-0001', '--workset', workset.id,
  ]);
  assert.equal(status.status, 'DECIDED');

  const next = runJson(home.root, ['workset', 'next', workset.id]);
  assert.equal(next.action, 'apply-reentry');
  assert.equal(next.reentryId, 'WRE-0001');
  assert.equal(next.project, 'user');
  assert.equal(next.applicationStatus, 'PENDING');

  const applied = runJson(home.root, [
    'workset', 'reentry', 'apply', 'WRE-0001', '--workset', workset.id,
  ]);
  assert.equal(applied.status, 'RESOLVED');
  assert.equal(applied.applications.find((item: { project: string }) => item.project === 'user').status, 'APPLIED');
  assert.equal(applied.applications.find((item: { project: string }) => item.project === 'quote').status, 'APPLIED');
  assert.equal(applied.applications.find((item: { project: string }) => item.project === 'pricing').status, 'NOT_REQUIRED');

  const after = runJson(home.root, ['workset', 'next', workset.id]);
  assert.equal(after.action, 'project-workflow');
  assert.equal(after.project, 'user');
});

test('reentry replan CLI previews current frozen replacement without mutating the FAILED application', async () => {
  const home = await createTestDirectory('omnai-home-');
  const repo = await createTestRepository('user-center');
  cleanups.push(home.cleanup, repo.cleanup);
  const setup = await createStaleCliReentry(home.root, repo.root);

  const preview = runJson(home.root, [
    'workset', 'reentry', 'replan', setup.reentry.id,
    '--project', 'user', '--workset', setup.workset.id,
  ]);
  assert.equal(preview.mode, 'preview');
  assert.equal(preview.preview.project, 'user');
  assert.equal(preview.preview.fromRevision, 'REV-0002');
  assert.equal(preview.preview.fromBaseline, 'BL-0002');

  const status = runJson(home.root, ['workset', 'reentry', 'status', setup.reentry.id, '--workset', setup.workset.id]);
  assert.equal(status.applications[0].status, 'FAILED');
  assert.equal(status.applications[0].attemptHistory.length, 0);
});

test('reentry replan CLI confirms one stale application and preserves its failed attempt history', async () => {
  const home = await createTestDirectory('omnai-home-');
  const repo = await createTestRepository('user-center');
  cleanups.push(home.cleanup, repo.cleanup);
  const setup = await createStaleCliReentry(home.root, repo.root);

  const confirmed = runJson(home.root, [
    'workset', 'reentry', 'replan', setup.reentry.id,
    '--project', 'user', '--workset', setup.workset.id, '--confirm',
  ]);
  assert.equal(confirmed.mode, 'confirmed');
  assert.equal(confirmed.record.status, 'DECIDED');
  assert.equal(confirmed.record.applications[0].status, 'PENDING');
  assert.equal(confirmed.record.applications[0].failureKind, null);
  assert.equal(confirmed.record.applications[0].attemptHistory.length, 1);
  assert.equal(confirmed.record.applications[0].attemptHistory[0].failureKind, 'STALE_PRECONDITION');
});

test('rejects an unsupported structured Re-entry kind', async () => {
  const home = await createTestDirectory('omnai-home-');
  cleanups.push(home.cleanup);
  runJson(home.root, ['workset', 'new', 'Authorization Migration']);

  const result = runCli(home.root, [
    'workset', 'change',
    '--kind', 'FREE_FORM_GUESS',
    '--reason', 'Do not classify this in Core.',
    '--json',
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FREE_FORM_GUESS|Invalid|invalid/);
});
