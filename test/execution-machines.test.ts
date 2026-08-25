import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMachine } from 'xstate';
import {
  claimMachine,
  commitSetMachine,
  contractMachine,
  LifecycleTransitionError,
  type LifecycleMachine,
  type LifecycleStatus,
  runMachineFor,
  transitionLifecycle,
  waveMachine,
} from '../src/execution/machines.js';
import type { ContractStatus } from '../src/execution/types.js';

test('writer Run requires CLAIM before START', () => {
  const machine = runMachineFor('PROJECT_WRITER');
  assert.equal(transitionLifecycle(machine, 'PREPARED', { type: 'RUN_CREATED' }), 'PREPARED');
  assert.throws(() => transitionLifecycle(machine, 'PREPARED', { type: 'START' }), /ILLEGAL_LIFECYCLE_TRANSITION/);
  assert.equal(transitionLifecycle(machine, 'PREPARED', { type: 'CLAIM' }), 'CLAIMED');
  assert.equal(transitionLifecycle(machine, 'CLAIMED', { type: 'START' }), 'STARTING');
});

test('read-only Run can never claim or integrate', () => {
  const machine = runMachineFor('PROJECT_REVIEWER');
  assert.equal(transitionLifecycle(machine, 'PREPARED', { type: 'RUN_CREATED' }), 'PREPARED');
  assert.throws(() => transitionLifecycle(machine, 'PREPARED', { type: 'CLAIM' }), /ILLEGAL/);
  assert.equal(transitionLifecycle(machine, 'PREPARED', { type: 'START' }), 'STARTING');
  assert.throws(() => transitionLifecycle(machine, 'ACCEPTED', { type: 'INTEGRATE' }), /ILLEGAL/);
});

test('Project Test Planner uses the read-only Run lifecycle', () => {
  const machine = runMachineFor('PROJECT_TEST_PLANNER');
  assert.equal(transitionLifecycle(machine, 'PREPARED', { type: 'START' }), 'STARTING');
  assert.throws(() => transitionLifecycle(machine, 'PREPARED', { type: 'CLAIM' }), /ILLEGAL/);
  assert.throws(() => transitionLifecycle(machine, 'ACCEPTED', { type: 'INTEGRATE' }), /ILLEGAL/);
});

test('writer acceptance integrates only after explicit integration event', () => {
  const machine = runMachineFor('RECOVERY_WRITER');
  assert.equal(transitionLifecycle(machine, 'FINISHED', { type: 'ACCEPT' }), 'ACCEPTED');
  assert.equal(transitionLifecycle(machine, 'ACCEPTED', { type: 'INTEGRATE' }), 'INTEGRATED');
});

test('other aggregate machines implement the approved closed graphs', () => {
  assert.equal(transitionLifecycle(contractMachine, 'GENERATING', { type: 'VALIDATE' }), 'VALIDATING');
  assert.equal(transitionLifecycle(contractMachine, 'VALIDATING', { type: 'ACCEPT' }), 'READY');
  assert.equal(transitionLifecycle(waveMachine, 'RUNNING', { type: 'PARTIAL' }), 'PARTIAL');
  assert.equal(transitionLifecycle(claimMachine, 'REVIEWING', { type: 'INTEGRATE' }), 'INTEGRATING');
  assert.equal(transitionLifecycle(commitSetMachine, 'PARTIAL', { type: 'INVALIDATE' }), 'NEEDS_REVALIDATION');
});

test('Run branch and terminal events have only their approved sources', () => {
  const machine = runMachineFor('CONTRACT_PLANNER');
  const cases = [
    ['RUNNING', 'BLOCK', 'BLOCKED'],
    ['RUNNING', 'SIGNAL', 'SIGNALED'],
    ['STARTING', 'FAIL', 'FAILED'],
    ['RUNNING', 'FAIL', 'FAILED'],
    ['FINISHED', 'FAIL', 'FAILED'],
    ['RUNNING', 'STALE', 'STALE'],
    ['FINISHED', 'STALE', 'STALE'],
    ['PREPARED', 'CANCEL', 'CANCELLED'],
    ['STARTING', 'CANCEL', 'CANCELLED'],
    ['RUNNING', 'CANCEL', 'CANCELLED'],
    ['FINISHED', 'RECOVER', 'RECOVERING'],
  ] as const;

  for (const [current, event, next] of cases) {
    assert.equal(transitionLifecycle(machine, current, { type: event }), next, `${current} + ${event}`);
  }
});

test('invalid persisted current produces the uniform lifecycle error context', () => {
  const invalidCurrent = 'NOT_A_STATUS' as ContractStatus;
  assert.throws(
    () => transitionLifecycle(contractMachine, invalidCurrent, { type: 'VALIDATE' }),
    (error: unknown) => {
      if (!(error instanceof LifecycleTransitionError)) return false;
      assert.equal(error.code, 'ILLEGAL_LIFECYCLE_TRANSITION');
      assert.equal(error.aggregate, 'contract-v1');
      assert.equal(error.current, 'NOT_A_STATUS');
      assert.equal(error.event, 'VALIDATE');
      return true;
    },
  );
});

test('guard failures on valid persisted states propagate unchanged', () => {
  const guardFailure = new Error('distinctive guard failure');
  const machine = createMachine({
    id: 'throwing-guard-v1',
    context: {},
    initial: 'READY',
    states: {
      READY: {
        on: {
          ADVANCE: {
            target: 'COMPLETE',
            guard: () => {
              throw guardFailure;
            },
          },
        },
      },
      COMPLETE: {},
    },
  }) as unknown as LifecycleMachine<ContractStatus>;

  assert.throws(
    () => transitionLifecycle(machine, 'READY', { type: 'ADVANCE' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof LifecycleTransitionError, false);
      assert.match(error.message, /distinctive guard failure/);
      return true;
    },
  );
});

test('every omitted edge and unknown event is illegal', () => {
  assertTransitionMatrix(runMachineFor('CONTRACT_PLANNER'), [
    'PREPARED', 'STARTING', 'RUNNING', 'FINISHED', 'ACCEPTED', 'BLOCKED', 'SIGNALED', 'FAILED', 'STALE', 'CANCELLED', 'RECOVERING',
  ], ['RUN_CREATED', 'START', 'STARTED', 'FINISH', 'ACCEPT', 'BLOCK', 'SIGNAL', 'FAIL', 'STALE', 'CANCEL', 'RECOVER'], {
    PREPARED: { RUN_CREATED: 'PREPARED', START: 'STARTING', CANCEL: 'CANCELLED' },
    STARTING: { STARTED: 'RUNNING', FAIL: 'FAILED', CANCEL: 'CANCELLED' },
    RUNNING: { FINISH: 'FINISHED', BLOCK: 'BLOCKED', SIGNAL: 'SIGNALED', FAIL: 'FAILED', STALE: 'STALE', CANCEL: 'CANCELLED' },
    FINISHED: { ACCEPT: 'ACCEPTED', RECOVER: 'RECOVERING', FAIL: 'FAILED', STALE: 'STALE' },
  });
  assertTransitionMatrix(runMachineFor('PROJECT_WRITER'), [
    'PREPARED', 'CLAIMED', 'STARTING', 'RUNNING', 'FINISHED', 'ACCEPTED', 'INTEGRATED', 'BLOCKED', 'SIGNALED', 'FAILED', 'STALE', 'CANCELLED', 'RECOVERING',
  ], ['RUN_CREATED', 'CLAIM', 'START', 'STARTED', 'FINISH', 'ACCEPT', 'INTEGRATE', 'BLOCK', 'SIGNAL', 'FAIL', 'STALE', 'CANCEL', 'RECOVER'], {
    PREPARED: { RUN_CREATED: 'PREPARED', CLAIM: 'CLAIMED', CANCEL: 'CANCELLED' },
    CLAIMED: { START: 'STARTING' },
    STARTING: { STARTED: 'RUNNING', FAIL: 'FAILED', CANCEL: 'CANCELLED' },
    RUNNING: { FINISH: 'FINISHED', BLOCK: 'BLOCKED', SIGNAL: 'SIGNALED', FAIL: 'FAILED', STALE: 'STALE', CANCEL: 'CANCELLED' },
    FINISHED: { ACCEPT: 'ACCEPTED', RECOVER: 'RECOVERING', FAIL: 'FAILED', STALE: 'STALE' },
    ACCEPTED: { INTEGRATE: 'INTEGRATED' },
  });
  assertTransitionMatrix(contractMachine, ['GENERATING', 'VALIDATING', 'READY', 'SUPERSEDED', 'INVALID'], ['VALIDATE', 'ACCEPT', 'SUPERSEDE', 'INVALIDATE'], {
    GENERATING: { VALIDATE: 'VALIDATING' },
    VALIDATING: { ACCEPT: 'READY', INVALIDATE: 'INVALID' },
    READY: { SUPERSEDE: 'SUPERSEDED' },
  });
  assertTransitionMatrix(waveMachine, ['PLANNED', 'RUNNING', 'COMPLETE', 'PARTIAL', 'SUPERSEDED'], ['START', 'COMPLETE', 'PARTIAL', 'SUPERSEDE'], {
    PLANNED: { START: 'RUNNING' },
    RUNNING: { COMPLETE: 'COMPLETE', PARTIAL: 'PARTIAL', SUPERSEDE: 'SUPERSEDED' },
  });
  assertTransitionMatrix(claimMachine, ['WRITING', 'REVIEWING', 'INTEGRATING', 'RECOVERING'], ['REVIEW', 'INTEGRATE', 'RECOVER'], {
    WRITING: { REVIEW: 'REVIEWING', RECOVER: 'RECOVERING' },
    REVIEWING: { INTEGRATE: 'INTEGRATING', RECOVER: 'RECOVERING' },
  });
  assertTransitionMatrix(commitSetMachine, ['OPEN', 'PARTIAL', 'VERIFYING', 'COMPLETE', 'NEEDS_REVALIDATION'], ['RECORD_MEMBER', 'VERIFY', 'COMPLETE_WITH_PROOF', 'PARTIAL', 'INVALIDATE'], {
    OPEN: { RECORD_MEMBER: 'PARTIAL' },
    PARTIAL: { RECORD_MEMBER: 'PARTIAL', VERIFY: 'VERIFYING', INVALIDATE: 'NEEDS_REVALIDATION' },
    VERIFYING: { COMPLETE_WITH_PROOF: 'COMPLETE', PARTIAL: 'PARTIAL', INVALIDATE: 'NEEDS_REVALIDATION' },
    COMPLETE: { INVALIDATE: 'NEEDS_REVALIDATION' },
    NEEDS_REVALIDATION: { RECORD_MEMBER: 'PARTIAL', PARTIAL: 'PARTIAL', VERIFY: 'VERIFYING' },
  });

  assert.throws(
    () => transitionLifecycle(contractMachine, 'GENERATING', { type: 'UNKNOWN' }),
    (error: unknown) => {
      if (!(error instanceof LifecycleTransitionError)) return false;
      assert.equal(error.code, 'ILLEGAL_LIFECYCLE_TRANSITION');
      assert.equal(error.aggregate, 'contract-v1');
      assert.equal(error.current, 'GENERATING');
      assert.equal(error.event, 'UNKNOWN');
      return true;
    },
  );
});

function assertTransitionMatrix(
  machine: LifecycleMachine<LifecycleStatus>,
  states: readonly string[],
  events: readonly string[],
  legal: Readonly<Record<string, Readonly<Record<string, string>>>>,
): void {
  for (const current of states) {
    for (const event of events) {
      const expected = legal[current]?.[event];
      if (expected === undefined) {
        assert.throws(
          () => transitionLifecycle(machine, current as LifecycleStatus, { type: event }),
          /ILLEGAL_LIFECYCLE_TRANSITION/,
          `${machine.id}: ${current} + ${event} must be rejected`,
        );
      } else {
        assert.equal(transitionLifecycle(machine, current as LifecycleStatus, { type: event }), expected, `${machine.id}: ${current} + ${event}`);
      }
    }
  }
}
