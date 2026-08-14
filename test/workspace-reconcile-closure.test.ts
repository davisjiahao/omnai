import assert from 'node:assert/strict';
import test from 'node:test';
import { getScenario } from '../src/core/scenarios.js';
import { taskFileSchema, type ScenarioProfile } from '../src/domain/types.js';
import {
  buildEffectiveReadinessPath,
  calculateReadinessClosure,
  calculateTaskClosure,
  minimumReconcileLevel,
} from '../src/workspace/reconcile-closure.js';

test('derives the effective readiness path from the current Scenario stages', () => {
  const scenario = getScenario('complex-domain-feature');
  assert.deepEqual(buildEffectiveReadinessPath(scenario), [
    'research',
    'domain',
    'spec',
    'design',
    'plan',
    'implementation',
    'review',
    'verification',
    'learning',
  ]);

  assert.deepEqual(calculateReadinessClosure(scenario, 'domain'), [
    'domain',
    'spec',
    'design',
    'plan',
    'implementation',
    'review',
    'verification',
    'learning',
  ]);
});

test('preserves Scenario-specific order rather than using one global workflow graph', () => {
  const bugFix = getScenario('bug-fix');
  assert.deepEqual(buildEffectiveReadinessPath(bugFix), [
    'triage',
    'reproduction',
    'diagnosis',
    'fix',
    'plan',
    'implementation',
    'verification',
    'review',
    'learning',
  ]);
  assert.deepEqual(calculateReadinessClosure(bugFix, 'fix'), [
    'fix',
    'plan',
    'implementation',
    'verification',
    'review',
    'learning',
  ]);
});

test('normalizes duplicate capabilities into one readiness node', () => {
  const scenario: ScenarioProfile = {
    id: 'synthetic-diagnosis',
    label: 'Synthetic diagnosis',
    description: 'Test-only scenario.',
    workMode: 'BUG_FIX',
    stages: ['research', 'debug', 'diagnose', 'fix', 'work', 'verify'],
    optionalStages: [],
    requiredArtifacts: [],
    gates: [],
    requiredEvidence: [],
    signals: [],
    risk: 'P2',
  };
  assert.deepEqual(buildEffectiveReadinessPath(scenario), [
    'research',
    'diagnosis',
    'fix',
    'implementation',
    'verification',
  ]);
});

test('rejects a reopen root that is not active in the current Scenario', () => {
  assert.throws(
    () => calculateReadinessClosure(getScenario('small-feature'), 'domain'),
    /domain.*small-feature|small-feature.*domain/i,
  );
});

test('enforces the minimum Reconcile level for each structured Workset change kind', () => {
  assert.equal(minimumReconcileLevel('REALITY_CHANGED'), 'L4');
  assert.equal(minimumReconcileLevel('PRODUCT_CHANGED'), 'L4');
  assert.equal(minimumReconcileLevel('DOMAIN_CHANGED'), 'L3');
  assert.equal(minimumReconcileLevel('SCOPE_CHANGED'), 'L3');
  assert.equal(minimumReconcileLevel('TECHNICAL_CONSTRAINT_CHANGED'), 'L2');
  assert.equal(minimumReconcileLevel('NEEDS_EXPERIMENT'), 'L2');
  assert.equal(minimumReconcileLevel('PLAN_CHANGED'), 'L1');
  assert.equal(minimumReconcileLevel('IMPLEMENTATION_DETAIL_CHANGED'), 'L0');
});

test('calculates downstream Task closure with the existing Task DAG', () => {
  const tasks = taskFileSchema.parse({
    schemaVersion: 1,
    revision: 'REV-0001',
    tasks: [
      { id: 'TASK-001', title: 'Root', objective: 'Root objective' },
      { id: 'TASK-002', title: 'Independent', objective: 'Independent objective' },
      { id: 'TASK-003', title: 'Consumer', objective: 'Consumer objective', dependsOn: ['TASK-001'] },
      { id: 'TASK-004', title: 'Downstream', objective: 'Downstream objective', dependsOn: ['TASK-003'] },
    ],
  });

  assert.deepEqual(calculateTaskClosure(tasks, ['TASK-001']), ['TASK-001', 'TASK-003', 'TASK-004']);
  assert.deepEqual(calculateTaskClosure(tasks, ['TASK-002']), ['TASK-002']);
  assert.throws(() => calculateTaskClosure(tasks, ['TASK-999']), /TASK-999.*not found|unknown.*TASK-999/i);
});
