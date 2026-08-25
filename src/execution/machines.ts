import { initialTransition, setup, transition, type AnyStateMachine } from 'xstate';
import type {
  ClaimPhase,
  CommitSetStatus,
  ContractStatus,
  EnvironmentRunStatus,
  RunKind,
  RunStatus,
  VerificationPlanStatus,
  WaveStatus,
} from './types.js';

export const COMMITSET_MACHINE_VERSION = 2;

export type LifecycleStatus = RunStatus | ContractStatus | WaveStatus | ClaimPhase | CommitSetStatus |
  VerificationPlanStatus | EnvironmentRunStatus | 'OPEN' | 'RESOLVED';

export type LifecycleMachine<TStatus extends LifecycleStatus> = AnyStateMachine & {
  readonly __lifecycleStatus?: TStatus;
};

const lifecycle = setup({
  types: {
    context: {} as Record<string, never>,
    events: {} as { type: string },
  },
});

const readOnlyRunMachine: LifecycleMachine<RunStatus> = lifecycle.createMachine({
  id: 'read-only-run-v1',
  context: {},
  initial: 'PREPARED',
  states: {
    PREPARED: { on: { RUN_CREATED: 'PREPARED', START: 'STARTING', CANCEL: 'CANCELLED' } },
    STARTING: { on: { STARTED: 'RUNNING', FAIL: 'FAILED', CANCEL: 'CANCELLED' } },
    RUNNING: { on: { FINISH: 'FINISHED', BLOCK: 'BLOCKED', SIGNAL: 'SIGNALED', FAIL: 'FAILED', STALE: 'STALE', CANCEL: 'CANCELLED' } },
    FINISHED: { on: { ACCEPT: 'ACCEPTED', RECOVER: 'RECOVERING', FAIL: 'FAILED', STALE: 'STALE' } },
    ACCEPTED: {},
    BLOCKED: {},
    SIGNALED: {},
    FAILED: {},
    STALE: {},
    CANCELLED: {},
    RECOVERING: {},
  },
});

const writerRunMachine: LifecycleMachine<RunStatus> = lifecycle.createMachine({
  id: 'writer-run-v1',
  context: {},
  initial: 'PREPARED',
  states: {
    PREPARED: { on: { RUN_CREATED: 'PREPARED', CLAIM: 'CLAIMED', CANCEL: 'CANCELLED' } },
    CLAIMED: { on: { START: 'STARTING' } },
    STARTING: { on: { STARTED: 'RUNNING', FAIL: 'FAILED', CANCEL: 'CANCELLED' } },
    RUNNING: { on: { FINISH: 'FINISHED', BLOCK: 'BLOCKED', SIGNAL: 'SIGNALED', FAIL: 'FAILED', STALE: 'STALE', CANCEL: 'CANCELLED' } },
    FINISHED: { on: { ACCEPT: 'ACCEPTED', RECOVER: 'RECOVERING', FAIL: 'FAILED', STALE: 'STALE' } },
    ACCEPTED: { on: { INTEGRATE: 'INTEGRATED' } },
    INTEGRATED: {},
    BLOCKED: {},
    SIGNALED: {},
    FAILED: {},
    STALE: {},
    CANCELLED: {},
    RECOVERING: {},
  },
});

export const contractMachine: LifecycleMachine<ContractStatus> = lifecycle.createMachine({
  id: 'contract-v1',
  context: {},
  initial: 'GENERATING',
  states: {
    GENERATING: { on: { VALIDATE: 'VALIDATING' } },
    VALIDATING: { on: { ACCEPT: 'READY', INVALIDATE: 'INVALID' } },
    READY: { on: { SUPERSEDE: 'SUPERSEDED' } },
    SUPERSEDED: {},
    INVALID: {},
  },
});

export const waveMachine: LifecycleMachine<WaveStatus> = lifecycle.createMachine({
  id: 'wave-v1',
  context: {},
  initial: 'PLANNED',
  states: {
    PLANNED: { on: { START: 'RUNNING' } },
    RUNNING: { on: { COMPLETE: 'COMPLETE', PARTIAL: 'PARTIAL', SUPERSEDE: 'SUPERSEDED' } },
    COMPLETE: {},
    PARTIAL: {},
    SUPERSEDED: {},
  },
});

export const claimMachine: LifecycleMachine<ClaimPhase> = lifecycle.createMachine({
  id: 'claim-v1',
  context: {},
  initial: 'WRITING',
  states: {
    WRITING: { on: { REVIEW: 'REVIEWING', RECOVER: 'RECOVERING' } },
    REVIEWING: { on: { INTEGRATE: 'INTEGRATING', RECOVER: 'RECOVERING' } },
    INTEGRATING: {},
    RECOVERING: {},
  },
});

export const commitSetMachine: LifecycleMachine<CommitSetStatus> = lifecycle.createMachine({
  id: 'commitset-v2',
  context: {},
  initial: 'OPEN',
  states: {
    OPEN: { on: { RECORD_MEMBER: 'PARTIAL' } },
    PARTIAL: { on: { RECORD_MEMBER: 'PARTIAL', VERIFY: 'VERIFYING', INVALIDATE: 'NEEDS_REVALIDATION' } },
    VERIFYING: { on: { COMPLETE_WITH_PROOF: 'COMPLETE', PARTIAL: 'PARTIAL', INVALIDATE: 'NEEDS_REVALIDATION' } },
    COMPLETE: { on: { INVALIDATE: 'NEEDS_REVALIDATION' } },
    NEEDS_REVALIDATION: { on: { RECORD_MEMBER: 'PARTIAL', PARTIAL: 'PARTIAL', VERIFY: 'VERIFYING' } },
  },
});

export const verificationPlanMachine: LifecycleMachine<VerificationPlanStatus> = lifecycle.createMachine({
  id: 'verification-plan-v1',
  context: {},
  initial: 'DRAFT',
  states: {
    DRAFT: { on: { READY: 'READY', INVALIDATE: 'INVALID', SUPERSEDE: 'SUPERSEDED' } },
    READY: { on: { INVALIDATE: 'INVALID', SUPERSEDE: 'SUPERSEDED' } },
    INVALID: { on: { SUPERSEDE: 'SUPERSEDED' } },
    SUPERSEDED: {},
  },
});

export const attentionMachine: LifecycleMachine<'OPEN' | 'RESOLVED'> = lifecycle.createMachine({
  id: 'attention-v1',
  context: {},
  initial: 'OPEN',
  states: {
    OPEN: { on: { RESOLVE: 'RESOLVED' } },
    RESOLVED: {},
  },
});

export const environmentRunMachine: LifecycleMachine<EnvironmentRunStatus> = lifecycle.createMachine({
  id: 'environment-run-v1',
  context: {},
  initial: 'PLANNED',
  states: {
    PLANNED: { on: { SETUP: 'SETTING_UP', CANCEL: 'COLLECTING', BLOCK: 'COLLECTING' } },
    SETTING_UP: { on: { BUILT: 'BUILDING', SETUP_COMPLETE: 'BUILDING', INFRA_FAILED: 'COLLECTING', CANCEL: 'COLLECTING', OWNERSHIP_UNPROVEN: 'SAFETY_UNPROVEN' } },
    BUILDING: { on: { BUILT: 'STARTING', BUILD_COMPLETE: 'STARTING', INFRA_FAILED: 'COLLECTING', CANCEL: 'COLLECTING', OWNERSHIP_UNPROVEN: 'SAFETY_UNPROVEN' } },
    STARTING: { on: { STARTED: 'HEALTHCHECKING', INFRA_FAILED: 'COLLECTING', CANCEL: 'COLLECTING', OWNERSHIP_UNPROVEN: 'SAFETY_UNPROVEN' } },
    HEALTHCHECKING: { on: { HEALTHY: 'SEEDING', INFRA_FAILED: 'COLLECTING', CANCEL: 'COLLECTING', OWNERSHIP_UNPROVEN: 'SAFETY_UNPROVEN' } },
    SEEDING: { on: { SEEDED: 'TESTING', INFRA_FAILED: 'COLLECTING', CANCEL: 'COLLECTING', OWNERSHIP_UNPROVEN: 'SAFETY_UNPROVEN' } },
    TESTING: { on: { TESTS_PASSED: 'COLLECTING', TEST_FAILED: 'COLLECTING', INFRA_FAILED: 'COLLECTING', CANCEL: 'COLLECTING', BLOCK: 'COLLECTING', OWNERSHIP_UNPROVEN: 'SAFETY_UNPROVEN' } },
    COLLECTING: { on: { COLLECTED: 'TEARING_DOWN', OWNERSHIP_UNPROVEN: 'SAFETY_UNPROVEN' } },
    TEARING_DOWN: { on: { FINISH_PASSED: 'PASSED', FINISH_TEST_FAILED: 'TEST_FAILED', FINISH_INFRA_FAILED: 'INFRA_FAILED', FINISH_BLOCKED: 'BLOCKED', FINISH_CANCELLED: 'CANCELLED', CLEANUP_FAILED: 'CLEANUP_REQUIRED', OWNERSHIP_UNPROVEN: 'SAFETY_UNPROVEN' } },
    CLEANUP_REQUIRED: { on: { RETRY_CLEANUP: 'TEARING_DOWN', OWNERSHIP_UNPROVEN: 'SAFETY_UNPROVEN' } },
    SAFETY_UNPROVEN: { on: { OWNERSHIP_PROVEN: 'TEARING_DOWN' } },
    PASSED: {},
    TEST_FAILED: {},
    INFRA_FAILED: {},
    BLOCKED: {},
    CANCELLED: {},
  },
});

export function runMachineFor(kind: RunKind): LifecycleMachine<RunStatus> {
  return kind === 'PROJECT_WRITER' || kind === 'RECOVERY_WRITER' ? writerRunMachine : readOnlyRunMachine;
}

export class LifecycleTransitionError extends Error {
  readonly code = 'ILLEGAL_LIFECYCLE_TRANSITION';

  constructor(
    readonly aggregate: string,
    readonly current: string,
    readonly event: string,
  ) {
    super(`ILLEGAL_LIFECYCLE_TRANSITION: aggregate=${aggregate} current=${current} event=${event}`);
    this.name = 'LifecycleTransitionError';
  }
}

export function transitionLifecycle<TStatus extends LifecycleStatus>(
  machine: LifecycleMachine<TStatus>,
  current: NoInfer<TStatus>,
  event: { type: string },
): TStatus {
  const [initial] = initialTransition(machine);
  let snapshot: ReturnType<typeof machine.resolveState>;
  try {
    snapshot = machine.resolveState({ value: current, context: initial.context });
  } catch {
    throw new LifecycleTransitionError(machine.id, current, event.type);
  }
  if (!snapshot.can(event)) {
    throw new LifecycleTransitionError(machine.id, current, event.type);
  }
  const [next] = transition(machine, snapshot, event);
  return String(next.value) as TStatus;
}
