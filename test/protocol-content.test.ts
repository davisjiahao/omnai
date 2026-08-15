import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAPABILITIES } from '../src/domain/types.js';
import {
  loadProtocol,
  repositoryProtocolId,
} from '../src/protocols/index.js';

test('the packaged common protocol owns authoritative facts and readable communication rules', async () => {
  const document = await loadProtocol('common.authoritative-work');
  assert.equal(document.kind, 'common');

  for (const pattern of [
    /code, configuration, approved artifacts, Git history, and fresh evidence as facts/i,
    /conversation memory as supplementary context/i,
    /do not silently change upstream intent/i,
    /stay within the declared capability/i,
    /preserve evidence references.*confirmed facts from assumptions/i,
    /lead with the conclusion/i,
    /first use of a specialized term or acronym/i,
    /retain the canonical term.*searchable/i,
    /observable outcomes, trade-offs, and user impact/i,
    /smallest useful visual/i,
    /tables for exact comparisons/i,
    /Mermaid for flows, hierarchy, state, or relationships/i,
    /skip decorative visuals/i,
    /textual conclusion with every visual/i,
    /do not ban necessary terminology/i,
  ]) {
    assert.match(document.content, pattern);
  }
});

test('every canonical capability has one independently maintainable packaged repository protocol', async () => {
  for (const capability of CAPABILITIES) {
    const document = await loadProtocol(repositoryProtocolId(capability));
    assert.equal(document.kind, 'repository-capability', capability);
    assert.match(document.content, /^# /m, capability);
    assert.match(document.content, /## Method/, capability);
    assert.match(document.content, /## Stop conditions/, capability);
    assert.match(document.content, /Do not begin a later capability/i, capability);
    assert.match(document.content, /return control to OmnAI routing/i, capability);
    assert.match(document.content, /route .* contradiction .* Reconcile/i, capability);
  }
});

test('capability-specific safety rules survive extraction from embedded prompts', async () => {
  const expected: Array<[Parameters<typeof repositoryProtocolId>[0], RegExp]> = [
    ['frame', /Do not design implementation yet/i],
    ['research', /Do not propose refactors unless .* explicitly asks/i],
    ['triage', /Do not edit production code/i],
    ['reproduce', /Do not propose fixes yet/i],
    ['debug', /root cause before any production fix/i],
    ['experiment', /Experimental code must not silently become production code/i],
    ['work', /failing behavioral test before production code/i],
    ['simplify', /without altering behavior/i],
    ['verify', /PASS, FAIL, or INCONCLUSIVE/i],
    ['ship', /without replacing the organization's deployment system/i],
    ['archive', /without deleting its audit trail/i],
    ['reconcile', /preserve the previous revision and baseline/i],
  ];

  for (const [capability, pattern] of expected) {
    assert.match((await loadProtocol(repositoryProtocolId(capability))).content, pattern, capability);
  }
});
