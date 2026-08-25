import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAPABILITIES } from '../src/domain/types.js';
import {
  EXECUTION_PROTOCOL_RUN_KINDS,
  loadProtocol,
  repositoryProtocolId,
} from '../src/protocols/index.js';

test('the packaged common protocol owns authoritative facts and only the minimum accessibility floor', async () => {
  const document = await loadProtocol('common.authoritative-work');
  assert.equal(document.kind, 'common');

  for (const pattern of [
    /code, configuration, approved artifacts, Git history, and fresh evidence as facts/i,
    /conversation memory as supplementary context/i,
    /do not silently change upstream intent/i,
    /stay within the declared capability/i,
    /preserve evidence references.*confirmed facts from assumptions/i,
    /practical result or meaning before implementation detail/i,
    /ordinary wording whenever it is equally precise/i,
    /specialized term.*first use.*canonical name.*precision and search/i,
    /never weaken an exact contract, evidence claim, safety rule, edge case, or unknown/i,
  ]) {
    assert.match(document.content, pattern);
  }

  for (const richerMethod of [
    /Markdown table/i,
    /Mermaid/i,
    /visual companion/i,
    /interactive explainer/i,
    /external browser/i,
    /two to four/i,
  ]) {
    assert.doesNotMatch(document.content, richerMethod);
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

test('execution role protocols declare bounded inputs, outputs, evidence, authority, and stop conditions', async () => {
  for (const id of Object.keys(EXECUTION_PROTOCOL_RUN_KINDS) as Array<keyof typeof EXECUTION_PROTOCOL_RUN_KINDS>) {
    const document = await loadProtocol(id);
    assert.equal(document.kind, 'execution-role', id);
    assert.match(document.content, /## Allowed inputs/i, id);
    assert.match(document.content, /## Structured output/i, id);
    assert.match(document.content, /## Evidence expectations/i, id);
    assert.match(document.content, /## Forbidden authority/i, id);
    assert.match(document.content, /## Stop and signal conditions/i, id);
  }
  assert.match((await loadProtocol('execution.project-writer')).content, /must not create the final Git commit/i);
  assert.match((await loadProtocol('execution.recovery-writer')).content, /TDD_PROOF_UNAVAILABLE/i);
  assert.match((await loadProtocol('execution.project-reviewer')).content, /must not write project source/i);
  assert.match((await loadProtocol('execution.project-test-planner')).content, /ProjectTestPlanCandidate/);
});
