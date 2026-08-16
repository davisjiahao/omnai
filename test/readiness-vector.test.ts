import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveNextAction } from '../src/core/readiness.js';
import { getScenario } from '../src/core/scenarios.js';
import { createChange } from '../src/core/store.js';
import { createTestRepository } from './helpers.js';

test('bug workflow keeps triage reproduction diagnosis fix and review as distinct readiness states', async () => {
  const fixture = await createTestRepository();
  try {
    const change = await createChange(fixture.root, 'Fix duplicate quote', 'bug-fix');
    assert.equal(change.metadata.readiness.triage, 'MISSING');
    assert.equal(change.metadata.readiness.reproduction, 'MISSING');
    assert.equal(change.metadata.readiness.diagnosis, 'MISSING');
    assert.equal(change.metadata.readiness.fix, 'MISSING');
    assert.equal(change.metadata.readiness.review, 'MISSING');

    const profile = getScenario('bug-fix');
    assert.equal(resolveNextAction(change.metadata, profile).capability, 'triage');
    change.metadata.readiness.triage = 'READY';
    assert.equal(resolveNextAction(change.metadata, profile).capability, 'reproduce');
    change.metadata.readiness.reproduction = 'READY';
    assert.equal(resolveNextAction(change.metadata, profile).capability, 'debug');
    change.metadata.readiness.diagnosis = 'READY';
    assert.equal(resolveNextAction(change.metadata, profile).capability, 'fix');
  } finally {
    await fixture.cleanup();
  }
});
