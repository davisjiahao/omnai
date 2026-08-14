import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as omnai from '../src/index.js';

test('exports the Milestone A personal workspace surface', () => {
  assert.equal(typeof omnai.registerProject, 'function');
  assert.equal(typeof omnai.createWorkset, 'function');
  assert.equal(typeof omnai.activateWorksetProject, 'function');
  assert.equal(typeof omnai.createWorksetWorktree, 'function');
  assert.equal(typeof omnai.syncVsCodeWorkspace, 'function');
  assert.equal(typeof omnai.resolveOmnaiHome, 'function');
});
