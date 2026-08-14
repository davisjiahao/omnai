import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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

function activateProject(home: string, project: string): void {
  runJson(home, ['workset', 'add-candidate', project]);
  runJson(home, ['workset', 'inspect-project', project]);
  runJson(home, ['workset', 'create-change', project, `${project} Workset Change`, '--scenario', 'small-feature']);
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
