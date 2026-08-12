import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectScenario, getScenario, listScenarios } from '../src/core/scenarios.js';

test('ships a broad scenario catalog', () => {
  const ids = new Set(listScenarios().map((scenario) => scenario.id));
  for (const id of [
    'read-only-query',
    'bug-fix',
    'production-incident',
    'small-feature',
    'domain-feature',
    'cross-service-change',
    'migration-program',
    'architecture-evolution',
    'performance-investigation',
    'security-change',
    'data-migration',
    'frontend-feature',
    'new-product',
    'sdk-library',
    'emergency-hotfix',
    'release-failure',
  ]) assert.equal(ids.has(id), true, `missing ${id}`);
});

test('detects specialized scenarios and defaults to a small feature', () => {
  assert.equal(detectScenario('production outage with customer impact').id, 'production-incident');
  assert.equal(detectScenario('move historical rows with dual write and backfill').id, 'data-migration');
  assert.equal(detectScenario('improve p95 latency and investigate CPU').id, 'performance-investigation');
  assert.equal(detectScenario('add a clear endpoint').id, 'small-feature');
});

test('exposes required gates and evidence for every scenario', () => {
  for (const scenario of listScenarios()) {
    assert.ok(scenario.stages.length > 0, scenario.id);
    assert.ok(scenario.gates.length > 0, scenario.id);
    assert.ok(scenario.requiredEvidence.length > 0, scenario.id);
    assert.equal(getScenario(scenario.id).id, scenario.id);
  }
});
