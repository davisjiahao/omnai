import assert from 'node:assert/strict';
import { test } from 'node:test';
import { client, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { createMachine, initialTransition, transition } from 'xstate';

test('execution uses stable ACP v1 and XState pure transitions', () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(typeof client, 'function');
  const machine = createMachine({
    initial: 'ready',
    states: { ready: { on: { START: 'running' } }, running: {} },
  });
  const [initial] = initialTransition(machine);
  const [next] = transition(machine, initial, { type: 'START' });
  assert.equal(next.value, 'running');
});
