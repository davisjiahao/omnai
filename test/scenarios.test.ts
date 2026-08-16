import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectScenario, getScenario, listScenarios } from '../src/core/scenarios.js';

const CANONICAL_SCENARIOS = [
  'system-query',
  'field-lineage',
  'business-flow',
  'bug-fix',
  'small-feature',
  'complex-domain-feature',
  'cross-service-change',
  'migration-program',
  'data-migration',
  'architecture-governance',
  'performance-investigation',
  'product-discovery',
  'ui-ux-feature',
  'quality-hardening',
  'shared-library',
  'emergency-hotfix',
  'incident-response',
  'release-failure',
  'technical-experiment',
] as const;

test('ships the canonical 19-scenario catalog', () => {
  const scenarios = listScenarios();
  assert.equal(scenarios.length, CANONICAL_SCENARIOS.length);
  assert.deepEqual(scenarios.map((scenario) => scenario.id), CANONICAL_SCENARIOS);
});

test('detects specialized scenarios and defaults to a small feature', () => {
  assert.equal(detectScenario('where does premiumAmount come from and where is this field written').id, 'field-lineage');
  assert.equal(detectScenario('explain the full policy purchase business flow from API to database').id, 'business-flow');
  assert.equal(detectScenario('production outage with customer impact').id, 'incident-response');
  assert.equal(detectScenario('move historical rows with dual write and backfill').id, 'data-migration');
  assert.equal(detectScenario('compare queue versus polling with a measured spike').id, 'technical-experiment');
  assert.equal(detectScenario('improve p95 latency and investigate CPU').id, 'performance-investigation');
  assert.equal(detectScenario('add a clear endpoint').id, 'small-feature');
});

test('keeps legacy scenario ids as aliases without polluting the canonical list', () => {
  assert.equal(getScenario('read-only-query').id, 'system-query');
  assert.equal(getScenario('production-incident').id, 'incident-response');
  assert.equal(getScenario('domain-feature').id, 'complex-domain-feature');
  assert.equal(getScenario('architecture-evolution').id, 'architecture-governance');
  assert.equal(getScenario('frontend-feature').id, 'ui-ux-feature');
  assert.equal(getScenario('new-product').id, 'product-discovery');
  assert.equal(getScenario('sdk-library').id, 'shared-library');
});

test('exposes P0-P3 risk, gates and evidence for every scenario', () => {
  for (const scenario of listScenarios()) {
    assert.ok(scenario.stages.length > 0, scenario.id);
    assert.ok(scenario.gates.length > 0, scenario.id);
    assert.ok(scenario.requiredEvidence.length > 0, scenario.id);
    assert.match(scenario.risk, /^P[0-3]$/);
    assert.equal(getScenario(scenario.id).id, scenario.id);
  }
});
