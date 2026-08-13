import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markWorksetProjectInactive } from '../src/workspace/worksets.js';

test('exposes the Workset inactive transition', () => {
  assert.equal(typeof markWorksetProjectInactive, 'function');
});
