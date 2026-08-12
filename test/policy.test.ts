import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getScenario } from '../src/core/scenarios.js';
import { buildEvidenceMatrix, selectReviewLenses } from '../src/core/policy.js';
import { evaluateGuard } from '../src/core/guards.js';

test('derives evidence from scenario risk and impact instead of a fixed global checklist', () => {
  const profile = getScenario('cross-service-change');
  const matrix = buildEvidenceMatrix(profile, {
    level: 'P1',
    dimensions: {
      businessCriticality: 'HIGH',
      data: 'HIGH',
      compatibility: 'HIGH',
      reversibility: 'HIGH',
      security: 'HIGH',
      operational: 'HIGH',
    },
  }, {
    frontend: false,
    backend: true,
    apiContract: true,
    database: true,
    mq: true,
    remoteService: true,
    security: true,
    observability: true,
  });

  const required = new Set(matrix.filter((item) => item.required).map((item) => item.id));
  for (const id of ['tests', 'build', 'contract-test', 'data-reconciliation', 'security-review', 'runtime-health', 'rollback-plan', 'human-approval']) {
    assert.equal(required.has(id), true, `missing ${id}`);
  }
});

test('selects review lenses from impact and risk', () => {
  const lenses = selectReviewLenses(getScenario('cross-service-change'), {
    level: 'P1',
    dimensions: {
      businessCriticality: 'HIGH',
      data: 'HIGH',
      compatibility: 'HIGH',
      reversibility: 'HIGH',
      security: 'HIGH',
      operational: 'HIGH',
    },
  }, {
    frontend: false,
    backend: true,
    apiContract: true,
    database: true,
    mq: false,
    remoteService: true,
    security: true,
    observability: true,
  });

  for (const lens of ['business', 'domain', 'architecture', 'contract', 'engineering', 'data', 'security', 'operations']) {
    assert.equal(lenses.includes(lens), true, `missing ${lens}`);
  }
});

test('guard blocks bug edits before confirmed root cause and blocks high-risk ship without gates', () => {
  const edit = evaluateGuard({
    action: 'edit',
    scenario: 'bug-fix',
    riskLevel: 'P2',
    issue: {
      triageState: 'ready-for-debug',
      reproduction: 'confirmed',
      rootCause: 'suspected',
      fixStrategy: 'unknown',
    },
  });
  assert.equal(edit.allowed, false);
  assert.equal(edit.code, 'BUG_RCA_REQUIRED');

  const ship = evaluateGuard({
    action: 'ship',
    scenario: 'cross-service-change',
    riskLevel: 'P1',
    verificationReady: true,
    reviewReady: true,
    evidenceSatisfied: true,
    humanApproval: false,
  });
  assert.equal(ship.allowed, false);
  assert.equal(ship.code, 'HUMAN_APPROVAL_REQUIRED');
});
