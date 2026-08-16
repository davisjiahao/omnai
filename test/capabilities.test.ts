import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAPABILITIES } from '../src/domain/types.js';
import { stageOutputs } from '../src/core/stages.js';

test('ships native bug experiment review and ship capabilities', () => {
  for (const capability of ['triage', 'debug', 'experiment', 'fix', 'review', 'ship'] as const) {
    assert.equal(CAPABILITIES.includes(capability), true, `missing ${capability}`);
    assert.ok(stageOutputs(capability).length > 0, `missing stage outputs for ${capability}`);
  }
});

test('bug capabilities use explicit issue and fix artifacts', () => {
  assert.deepEqual(stageOutputs('triage'), ['issue.md']);
  assert.deepEqual(stageOutputs('debug'), ['issue.md']);
  assert.deepEqual(stageOutputs('fix'), ['fix.md']);
  assert.deepEqual(stageOutputs('ship'), ['delivery.md']);
});
