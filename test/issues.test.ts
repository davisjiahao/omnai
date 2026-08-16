import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInitialIssueState, transitionIssue } from '../src/core/issues.js';

test('bug issue starts in needs-info and cannot skip root-cause confirmation', () => {
  const issue = createInitialIssueState();
  assert.equal(issue.triageState, 'needs-info');
  assert.throws(() => transitionIssue(issue, 'ready-for-fix'), /root cause/i);
});

test('bug issue can route to experiment or fix after evidence is established', () => {
  const issue = createInitialIssueState();
  issue.reproduction = 'confirmed';
  issue.rootCause = 'confirmed';
  issue.fixStrategy = 'needs-experiment';
  transitionIssue(issue, 'needs-experiment');
  assert.equal(issue.triageState, 'needs-experiment');

  issue.fixStrategy = 'ready';
  transitionIssue(issue, 'ready-for-fix');
  assert.equal(issue.triageState, 'ready-for-fix');
});
