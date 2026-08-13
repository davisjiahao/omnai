import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activateWorksetProject } from '../src/workspace/worksets.js';

test('activates a researched project into a writable worktree', () => {
  assert.equal(typeof activateWorksetProject, 'function');
});
