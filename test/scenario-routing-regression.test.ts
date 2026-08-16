import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { join } from 'node:path';
import { createTestRepository } from './helpers.js';
import { createChange, saveChange } from '../src/core/store.js';
import { getScenario } from '../src/core/scenarios.js';
import { resolveNextAction } from '../src/core/readiness.js';
import { reconcileChange } from '../src/core/reconcile.js';
import { pathExists } from '../src/core/files.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

test('migration-program routes through map after frame', async () => {
  const fixture = await createTestRepository();
  cleanups.push(fixture.cleanup);
  const change = await createChange(fixture.root, 'Retire mall', 'migration-program');
  assert.equal(resolveNextAction(change.metadata, getScenario('migration-program')).capability, 'frame');
  change.metadata.readiness.frame = 'READY';
  assert.equal(resolveNextAction(change.metadata, getScenario('migration-program')).capability, 'map');
});

test('incident-response starts with mitigation and scaffolds fix strategy', async () => {
  const fixture = await createTestRepository();
  cleanups.push(fixture.cleanup);
  const change = await createChange(fixture.root, 'Quote outage', 'incident-response');
  assert.equal(resolveNextAction(change.metadata, getScenario('incident-response')).capability, 'mitigate');
  assert.equal(await pathExists(join(fixture.root, '.omnai/changes', change.directoryName, 'fix.md')), true);
});

test('product-discovery requires canary after delivery readiness', async () => {
  const fixture = await createTestRepository();
  cleanups.push(fixture.cleanup);
  const change = await createChange(fixture.root, 'New quote assistant', 'product-discovery');
  for (const key of ['frame', 'research', 'spec', 'design', 'plan', 'implementation', 'qa', 'review', 'verification', 'release'] as const) {
    change.metadata.readiness[key] = 'READY';
  }
  assert.equal(resolveNextAction(change.metadata, getScenario('product-discovery')).capability, 'canary');
});

test('quality-hardening QA is conditional rather than universally required', async () => {
  const fixture = await createTestRepository();
  cleanups.push(fixture.cleanup);
  const change = await createChange(fixture.root, 'Harden quote service', 'quality-hardening');
  change.metadata.readiness.research = 'READY';
  change.metadata.readiness.review = 'READY';
  assert.equal(resolveNextAction(change.metadata, getScenario('quality-hardening')).capability, 'verify');
});

test('applied reconciliation returns to normal readiness routing instead of reconcile loop', async () => {
  const fixture = await createTestRepository();
  cleanups.push(fixture.cleanup);
  const change = await createChange(fixture.root, 'Authorization split', 'complex-domain-feature');
  change.metadata.readiness.research = 'READY';
  change.metadata.readiness.domain = 'READY';
  change.metadata.readiness.spec = 'READY';
  change.metadata.readiness.design = 'READY';
  change.metadata.readiness.plan = 'READY';
  change.metadata.readiness.implementation = 'IN_PROGRESS';
  await saveChange(fixture.root, change);

  await reconcileChange(fixture.root, change, {
    level: 'L3',
    type: 'DOMAIN_ASSUMPTION_INVALIDATED',
    reason: 'Authorization mixes durable consent and quote usage',
  });

  assert.equal(change.metadata.status, 'IN_PROGRESS');
  assert.notEqual(resolveNextAction(change.metadata, getScenario('complex-domain-feature')).capability, 'reconcile');
  assert.equal(resolveNextAction(change.metadata, getScenario('complex-domain-feature')).capability, 'model');
});
