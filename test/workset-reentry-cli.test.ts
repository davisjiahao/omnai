import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
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

test('routes a mid-flight domain change through new-project research before Grill', async () => {
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
  assert.deepEqual(change.affectedProjects, ['user', 'quote']);
  assert.deepEqual(change.candidateProjects, ['pricing']);

  assert.deepEqual(runJson(home.root, ['workset', 'next', workset.id]), {
    action: 'inspect-project',
    project: 'pricing',
    reason: 'Candidate project requires read-only research before activation.',
  });

  const research = runJson(home.root, ['workset', 'inspect-project', 'pricing']);
  assert.equal(research.status, 'RESEARCH_ONLY');
  assert.equal(research.readOnly, true);

  const observed = runJson(home.root, [
    'workset', 'inspect-project', 'pricing', '--result', 'observed-only',
  ]);
  assert.equal(observed.status, 'OBSERVED_ONLY');

  assert.deepEqual(runJson(home.root, ['workset', 'next', workset.id]), {
    action: 'reenter',
    reentryId: 'WRE-0001',
    capability: 'model',
    interaction: 'grill',
    affectedProjects: ['user', 'quote'],
    reason: 'Domain meaning, ownership, lifecycle, or invariant changed.',
  });

  const records = runJson(home.root, ['workset', 'reentry', 'list', workset.id]);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, 'WRE-0001');
  assert.equal(records[0].status, 'PENDING');

  const resolved = runJson(home.root, [
    'workset', 'reentry', 'resolve', 'WRE-0001', '--workset', workset.id,
  ]);
  assert.equal(resolved.status, 'RESOLVED');

  const next = runJson(home.root, ['workset', 'next', workset.id]);
  assert.equal(next.action, 'project-workflow');
  assert.equal(next.project, 'user');
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
