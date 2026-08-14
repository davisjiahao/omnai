import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as omnai from '../src/index.js';

test('exports the aggregate Milestone A workspace surface without VS Code projection APIs', () => {
  assert.equal(typeof omnai.registerProject, 'function');
  assert.equal(typeof omnai.createWorkset, 'function');
  assert.equal(typeof omnai.activateWorksetProject, 'function');
  assert.equal(typeof omnai.createWorksetWorktree, 'function');
  assert.equal(typeof omnai.resolveOmnaiHome, 'function');
  assert.equal(typeof omnai.worksetWorkspaceRoot, 'function');
  assert.equal(typeof omnai.worksetMarkerPath, 'function');
  assert.equal(typeof omnai.ensureExecutionWorkspace, 'function');
  assert.equal(typeof omnai.discoverExecutionContext, 'function');
  assert.equal('syncVsCodeWorkspace' in omnai, false);
  assert.equal('worksetVsCodePath' in omnai, false);
});
