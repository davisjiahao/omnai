import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { join } from 'node:path';
import { createTestRepository } from './helpers.js';
import { createChange, saveChange } from '../src/core/store.js';
import { getScenario, SCENARIOS } from '../src/core/scenarios.js';
import { resolveNextAction } from '../src/core/readiness.js';
import { reconcileChange } from '../src/core/reconcile.js';
import { pathExists } from '../src/core/files.js';
import { repositoryRouteOrder } from '../src/core/repository-route-order-internal.js';
import { changeMetadataSchema } from '../src/domain/types.js';
import { compileFlowPlan, createInitialFlowAssessment } from '../src/core/flow.js';

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

test('adaptive routing preserves every Scenario floor and inserts promoted capabilities deterministically', () => {
  const orders = new Map<string, string[]>();
  for (const scenario of SCENARIOS) {
    const now = '2026-08-19T00:00:00.000Z';
    const metadata = changeMetadataSchema.parse({
      schemaVersion: 1,
      id: 'CHG-0001',
      slug: 'scenario-order',
      title: `Route ${scenario.id}`,
      scenario: scenario.id,
      workMode: scenario.workMode,
      status: 'DRAFT',
      activeRevision: 'REV-0001',
      baseline: 'BL-0001',
      artifactVersions: {},
      risk: { level: scenario.risk, dimensions: scenario.riskDimensions ?? {} },
      impact: scenario.defaultImpact ?? {},
      createdAt: now,
      updatedAt: now,
      readiness: {},
    });
    const sourceRefs = [{
      kind: 'policy' as const,
      scenarioId: scenario.id,
      contentHash: `sha256:${'1'.repeat(64)}` as const,
    }];
    const flow = compileFlowPlan(
      metadata,
      scenario,
      createInitialFlowAssessment(metadata, scenario, sourceRefs),
      [],
      now,
    );
    const order = repositoryRouteOrder(flow, scenario);
    orders.set(scenario.id, order);
    assert.deepEqual(
      order.filter((capability) => scenario.stages.includes(capability)),
      scenario.stages,
      scenario.id,
    );
    assert.equal(new Set(order).size, order.length, scenario.id);
  }

  assert.deepEqual(orders.get('migration-program'), [
    'frame', 'map', 'research', 'model', 'spec', 'design', 'plan', 'work',
    'review', 'verify', 'ship', 'learn', 'archive',
  ]);
  assert.deepEqual(orders.get('data-migration'), [
    'research', 'map', 'model', 'spec', 'design', 'review', 'plan', 'work',
    'verify', 'ship', 'learn', 'archive',
  ]);
  assert.deepEqual(orders.get('architecture-governance'), [
    'research', 'model', 'design', 'review', 'plan', 'work', 'verify', 'ship',
    'learn', 'archive',
  ]);
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
