import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateGuard } from '../src/core/guards.js';
import { createInitialIssueState, transitionIssue } from '../src/core/issues.js';
import { getScenario } from '../src/core/scenarios.js';

const ISSUE_BACKED_SCENARIOS = ['bug-fix', 'emergency-hotfix', 'incident-response', 'release-failure'] as const;

test('every issue-backed correction route blocks production edits before ready-for-fix', () => {
  for (const scenario of ISSUE_BACKED_SCENARIOS) {
    const blocked = evaluateGuard({
      action: 'edit',
      scenario,
      riskLevel: getScenario(scenario).risk,
      issue: createInitialIssueState(),
    });
    assert.equal(blocked.allowed, false, scenario);
    assert.equal(blocked.code, 'BUG_RCA_REQUIRED', scenario);
  }
});

test('every issue-backed correction route permits edit after reproduction RCA and fix strategy are confirmed', () => {
  for (const scenario of ISSUE_BACKED_SCENARIOS) {
    const issue = createInitialIssueState();
    issue.reproduction = 'confirmed';
    issue.rootCause = 'confirmed';
    issue.fixStrategy = 'ready';
    transitionIssue(issue, 'ready-for-fix');

    const decision = evaluateGuard({
      action: 'edit',
      scenario,
      riskLevel: getScenario(scenario).risk,
      issue,
    });
    assert.equal(decision.allowed, true, scenario);
  }
});

test('release failure keeps reconcile event-driven instead of making it a fixed mandatory stage', () => {
  const scenario = getScenario('release-failure');
  assert.equal(scenario.stages.includes('reconcile'), false);
  assert.equal(scenario.optionalStages.includes('reconcile'), true);
});
