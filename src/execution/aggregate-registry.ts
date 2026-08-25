import type { ZodType } from 'zod';
import {
  attentionMachine,
  claimMachine,
  commitSetMachine,
  contractMachine,
  environmentRunMachine,
  runMachineFor,
  transitionLifecycle,
  verificationPlanMachine,
  waveMachine,
  type LifecycleMachine,
  type LifecycleStatus,
} from './machines.js';
import {
  attentionItemSchema,
  commitSetSchema,
  commitSetV1Schema,
  contentHashSchema,
  contractSnapshotManifestSchema,
  integrationEnvironmentRunSchema,
  runStateSchema,
  verificationPlanSchema,
  waveSchema,
  writerClaimSchema,
  type CommitSetV1,
  type ContractSnapshotManifest,
  type IntegrationEnvironmentRun,
  type ExecutionEvent,
} from './types.js';

export type ExecutionAggregateType = ExecutionEvent['aggregateType'];

export interface ExecutionTransitionEvent {
  type: string;
  payload?: Record<string, unknown>;
}

export interface ExecutionMaterializedState {
  machineVersion: number;
  status?: string | undefined;
  lastEventSequence: number;
  lastEventHash: string | null;
  updatedAt?: string | undefined;
}

export interface AggregateReductionContext {
  mode: 'transition' | 'replay';
  timestamp: string;
}

export type AggregateReducer<TState extends ExecutionMaterializedState> = (
  state: TState,
  event: ExecutionTransitionEvent,
  context: AggregateReductionContext,
) => TState;

export type AggregateMigration<TState extends ExecutionMaterializedState = ExecutionMaterializedState> = (
  state: TState,
) => ExecutionMaterializedState;

export interface AggregateVersionRegistration<TState extends ExecutionMaterializedState> {
  machineVersion: number;
  schema: ZodType<TState>;
  reducer: AggregateReducer<TState>;
  status?: ((state: TState) => string) | undefined;
}

export interface AggregateRegistration<TState extends ExecutionMaterializedState> {
  aggregateType: ExecutionAggregateType;
  currentVersion: number;
  versions: readonly AggregateVersionRegistration<TState>[];
}

export interface RegisteredAggregateMigration {
  aggregateType: ExecutionAggregateType;
  fromVersion: number;
  toVersion: number;
  migrate: AggregateMigration;
}

interface RegisteredAggregateVersion {
  machineVersion: number;
  schema: ZodType<ExecutionMaterializedState>;
  reducer: AggregateReducer<ExecutionMaterializedState>;
  status: (state: ExecutionMaterializedState) => string;
}

interface RegisteredAggregate {
  currentVersion: number;
  versions: Map<number, RegisteredAggregateVersion>;
}

export class ExecutionAggregateRegistry {
  private readonly aggregates = new Map<ExecutionAggregateType, RegisteredAggregate>();
  private readonly migrations = new Map<string, RegisteredAggregateMigration>();

  register<TState extends ExecutionMaterializedState>(registration: AggregateRegistration<TState>): void {
    if (this.aggregates.has(registration.aggregateType)) {
      throw new Error(`AGGREGATE_ALREADY_REGISTERED: aggregateType=${registration.aggregateType}`);
    }
    requireMachineVersion(registration.currentVersion);
    const versions = new Map<number, RegisteredAggregateVersion>();
    for (const version of registration.versions) {
      requireMachineVersion(version.machineVersion);
      if (versions.has(version.machineVersion)) {
        throw new Error(
          `AGGREGATE_VERSION_ALREADY_REGISTERED: aggregateType=${registration.aggregateType} version=${version.machineVersion}`,
        );
      }
      versions.set(version.machineVersion, {
        machineVersion: version.machineVersion,
        schema: version.schema as unknown as ZodType<ExecutionMaterializedState>,
        reducer: version.reducer as unknown as AggregateReducer<ExecutionMaterializedState>,
        status: (version.status ?? defaultStatus) as (state: ExecutionMaterializedState) => string,
      });
    }
    if (!versions.has(registration.currentVersion)) {
      throw new Error(
        `AGGREGATE_CURRENT_VERSION_MISSING: aggregateType=${registration.aggregateType} version=${registration.currentVersion}`,
      );
    }
    this.aggregates.set(registration.aggregateType, { currentVersion: registration.currentVersion, versions });
  }

  registerMigration<TState extends ExecutionMaterializedState>(
    aggregateType: ExecutionAggregateType,
    fromVersion: number,
    toVersion: number,
    migrate: AggregateMigration<TState>,
  ): void {
    this.requireAggregate(aggregateType);
    requireMachineVersion(fromVersion);
    requireMachineVersion(toVersion);
    if (toVersion <= fromVersion) {
      throw new Error(`MIGRATION_VERSION_ORDER_INVALID: aggregateType=${aggregateType} from=${fromVersion} to=${toVersion}`);
    }
    if (toVersion !== fromVersion + 1) {
      throw new Error(`MIGRATION_VERSION_SKIP: aggregateType=${aggregateType} from=${fromVersion} to=${toVersion}`);
    }
    if (!this.hasVersion(aggregateType, fromVersion) || !this.hasVersion(aggregateType, toVersion)) {
      throw new Error(
        `MIGRATION_VERSION_UNREGISTERED: aggregateType=${aggregateType} from=${fromVersion} to=${toVersion}`,
      );
    }
    const key = migrationKey(aggregateType, fromVersion, toVersion);
    if (this.migrations.has(key)) {
      throw new Error(`MIGRATION_ALREADY_REGISTERED: aggregateType=${aggregateType} from=${fromVersion} to=${toVersion}`);
    }
    this.migrations.set(key, {
      aggregateType,
      fromVersion,
      toVersion,
      migrate: migrate as unknown as AggregateMigration,
    });
  }

  currentVersion(aggregateType: ExecutionAggregateType): number {
    return this.requireAggregate(aggregateType).currentVersion;
  }

  hasVersion(aggregateType: ExecutionAggregateType, machineVersion: number): boolean {
    return this.requireAggregate(aggregateType).versions.has(machineVersion);
  }

  parse<TState extends ExecutionMaterializedState>(
    aggregateType: ExecutionAggregateType,
    machineVersion: number,
    value: unknown,
  ): TState {
    return this.requireVersion(aggregateType, machineVersion).schema.parse(value) as TState;
  }

  reduce<TState extends ExecutionMaterializedState>(
    aggregateType: ExecutionAggregateType,
    machineVersion: number,
    state: TState,
    event: ExecutionTransitionEvent,
    context: AggregateReductionContext,
  ): TState {
    const definition = this.requireVersion(aggregateType, machineVersion);
    const parsed = definition.schema.parse(state);
    const reduced = definition.reducer(structuredClone(parsed), structuredClone(event), context);
    if (reduced.machineVersion !== parsed.machineVersion ||
        reduced.lastEventSequence !== parsed.lastEventSequence ||
        reduced.lastEventHash !== parsed.lastEventHash) {
      throw new Error(`REGISTERED_REDUCER_MUTATED_EVENT_CURSOR: aggregateType=${aggregateType} version=${machineVersion}`);
    }
    return definition.schema.parse(reduced) as TState;
  }

  statusOf(
    aggregateType: ExecutionAggregateType,
    machineVersion: number,
    state: ExecutionMaterializedState,
  ): string {
    const definition = this.requireVersion(aggregateType, machineVersion);
    return definition.status(definition.schema.parse(state));
  }

  findMigration(
    aggregateType: ExecutionAggregateType,
    fromVersion: number,
    toVersion: number,
  ): RegisteredAggregateMigration | null {
    return this.migrations.get(migrationKey(aggregateType, fromVersion, toVersion)) ?? null;
  }

  private requireAggregate(aggregateType: ExecutionAggregateType): RegisteredAggregate {
    const aggregate = this.aggregates.get(aggregateType);
    if (!aggregate) throw new Error(`AGGREGATE_NOT_REGISTERED: aggregateType=${aggregateType}`);
    return aggregate;
  }

  private requireVersion(
    aggregateType: ExecutionAggregateType,
    machineVersion: number,
  ): RegisteredAggregateVersion {
    const aggregate = this.requireAggregate(aggregateType);
    const version = aggregate.versions.get(machineVersion);
    if (!version) {
      throw new Error(
        `MACHINE_VERSION_UNSUPPORTED: aggregateType=${aggregateType} version=${machineVersion} current=${aggregate.currentVersion}`,
      );
    }
    return version;
  }
}

export function createProductionAggregateRegistry(): ExecutionAggregateRegistry {
  const registry = new ExecutionAggregateRegistry();
  registry.register({
    aggregateType: 'contract',
    currentVersion: 1,
    versions: [{
      machineVersion: 1,
      schema: contractSnapshotManifestSchema,
      reducer: reduceContract,
    }],
  });
  registerLifecycleAggregate(registry, 'wave', 1, waveSchema, waveMachine);
  registry.register({
    aggregateType: 'run',
    currentVersion: 1,
    versions: [{
      machineVersion: 1,
      schema: runStateSchema,
      reducer: reduceRun,
    }],
  });
  registry.register({
    aggregateType: 'claim',
    currentVersion: 1,
    versions: [{
      machineVersion: 1,
      schema: writerClaimSchema,
      status: (state) => state.phase,
      reducer: (state, event) => ({
        ...state,
        phase: transitionLifecycle(claimMachine, state.phase, event),
      }),
    }],
  });
  registry.register({
    aggregateType: 'attention',
    currentVersion: 1,
    versions: [{
      machineVersion: 1,
      schema: attentionItemSchema,
      reducer: (state, event, context) => {
        const status = transitionLifecycle(attentionMachine, state.status, event);
        return status === 'RESOLVED'
          ? { ...state, status, resolvedAt: context.timestamp }
          : { ...state, status };
      },
    }],
  });
  registry.register<ExecutionMaterializedState>({
    aggregateType: 'commitset',
    currentVersion: 2,
    versions: [
      {
        machineVersion: 1,
        schema: commitSetV1Schema as unknown as ZodType<ExecutionMaterializedState>,
        reducer: reduceCommitSetV1 as unknown as AggregateReducer<ExecutionMaterializedState>,
      },
      {
        machineVersion: 2,
        schema: commitSetSchema as unknown as ZodType<ExecutionMaterializedState>,
        reducer: reduceCommitSetV2 as unknown as AggregateReducer<ExecutionMaterializedState>,
      },
    ],
  });
  registry.registerMigration('commitset', 1, 2, migrateCommitSetV1ToV2);
  registerLifecycleAggregate(registry, 'verification-plan', 1, verificationPlanSchema, verificationPlanMachine);
  registry.register({
    aggregateType: 'environment-run',
    currentVersion: 1,
    versions: [{
      machineVersion: 1,
      schema: integrationEnvironmentRunSchema,
      reducer: reduceEnvironmentRun,
    }],
  });
  return registry;
}

function reduceContract(
  state: ContractSnapshotManifest,
  event: ExecutionTransitionEvent,
): ContractSnapshotManifest {
  const status = transitionLifecycle(contractMachine, state.status, event);
  if (event.type !== 'ACCEPT' && event.type !== 'INVALIDATE') return { ...state, status };
  const rawEvidence = event.payload?.validationEvidence;
  if (!Array.isArray(rawEvidence) || rawEvidence.length === 0 ||
      rawEvidence.some((item) => typeof item !== 'string' || !/^EVD-\d{4}$/.test(item))) {
    throw new Error('CONTRACT_EVENT_EVIDENCE_INVALID');
  }
  const validationEvidence = rawEvidence as string[];
  for (let index = 1; index < validationEvidence.length; index += 1) {
    if (validationEvidence[index - 1]! >= validationEvidence[index]!) {
      throw new Error('CONTRACT_EVENT_EVIDENCE_NOT_SORTED_UNIQUE');
    }
  }
  return { ...state, status, validationEvidence };
}

function reduceRun(
  state: ReturnType<typeof runStateSchema.parse>,
  event: ExecutionTransitionEvent,
): ReturnType<typeof runStateSchema.parse> {
  const status = transitionLifecycle(runMachineFor(state.kind), state.status, event);
  const agentSessionId = event.payload?.agentSessionId;
  const resultHash = event.payload?.resultHash;
  return {
    ...state,
    status,
    ...(agentSessionId === undefined ? {} : { agentSessionId: requireNonEmptyString(agentSessionId, 'agentSessionId') }),
    ...(resultHash === undefined ? {} : { resultHash: contentHashSchema.parse(resultHash) }),
  };
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`RUN_EVENT_PAYLOAD_INVALID: ${field}`);
  }
  return value;
}

function registerLifecycleAggregate<TState extends ExecutionMaterializedState, TStatus extends LifecycleStatus>(
  registry: ExecutionAggregateRegistry,
  aggregateType: ExecutionAggregateType,
  machineVersion: number,
  schema: ZodType<TState>,
  machine: LifecycleMachine<TStatus>,
): void {
  registry.register({
    aggregateType,
    currentVersion: machineVersion,
    versions: [{
      machineVersion,
      schema,
      reducer: (state, event) => ({
        ...state,
        status: transitionLifecycle(machine, state.status as TStatus, event),
      }),
    }],
  });
}

function reduceCommitSetV1(
  state: CommitSetV1,
  event: ExecutionTransitionEvent,
): CommitSetV1 {
  let status: CommitSetV1['status'];
  if (state.status === 'OPEN' && (event.type === 'PARTIAL' || event.type === 'RECORD_MEMBER')) status = 'PARTIAL';
  else if (state.status === 'PARTIAL' && event.type === 'COMPLETE') status = 'COMPLETE';
  else if (state.status === 'PARTIAL' && event.type === 'INVALIDATE') status = 'NEEDS_REVALIDATION';
  else throw illegalLegacyCommitSetTransition(state.status, event.type);
  return { ...state, status };
}

function reduceEnvironmentRun(
  state: IntegrationEnvironmentRun,
  event: ExecutionTransitionEvent,
): IntegrationEnvironmentRun {
  const status = transitionLifecycle(environmentRunMachine, state.status, event);
  const primaryOutcome = environmentPrimaryOutcome(event.type) ?? state.primaryOutcome;
  if (event.type.startsWith('FINISH_')) {
    const expected = environmentFinishOutcome(event.type);
    if (expected !== undefined && state.primaryOutcome !== expected) {
      throw new Error(
        `ENVIRONMENT_PRIMARY_OUTCOME_MISMATCH: expected=${expected} actual=${String(state.primaryOutcome)}`,
      );
    }
  }
  if (event.type === 'CLEANUP_FAILED') {
    return {
      ...state,
      status,
      primaryOutcome,
      cleanupOutcome: 'FAILED',
      cleanupAttempts: state.cleanupAttempts + 1,
    };
  }
  if (event.type === 'OWNERSHIP_UNPROVEN') {
    return {
      ...state,
      status,
      primaryOutcome: primaryOutcome ?? 'SAFETY_UNPROVEN',
      cleanupOutcome: 'SAFETY_UNPROVEN',
    };
  }
  if (event.type.startsWith('FINISH_')) {
    return { ...state, status, primaryOutcome, cleanupOutcome: 'SUCCEEDED' };
  }
  return primaryOutcome === undefined
    ? { ...state, status }
    : { ...state, status, primaryOutcome };
}

function environmentPrimaryOutcome(
  event: string,
): IntegrationEnvironmentRun['primaryOutcome'] {
  switch (event) {
    case 'TESTS_PASSED': return 'PASSED';
    case 'TEST_FAILED': return 'TEST_FAILED';
    case 'INFRA_FAILED': return 'INFRA_FAILED';
    case 'BLOCK': return 'BLOCKED';
    case 'CANCEL': return 'CANCELLED';
    default: return undefined;
  }
}

function environmentFinishOutcome(event: string): IntegrationEnvironmentRun['primaryOutcome'] {
  switch (event) {
    case 'FINISH_PASSED': return 'PASSED';
    case 'FINISH_TEST_FAILED': return 'TEST_FAILED';
    case 'FINISH_INFRA_FAILED': return 'INFRA_FAILED';
    case 'FINISH_BLOCKED': return 'BLOCKED';
    case 'FINISH_CANCELLED': return 'CANCELLED';
    default: return undefined;
  }
}

function reduceCommitSetV2(
  state: ReturnType<typeof commitSetSchema.parse>,
  event: ExecutionTransitionEvent,
  context: AggregateReductionContext,
): ReturnType<typeof commitSetSchema.parse> {
  if (event.type === 'COMPLETE' || event.type === 'COMPLETE_WITH_PROOF') {
    if (context.mode === 'transition') {
      throw new Error('COMMITSET_COMPLETION_AUTHORITY_REQUIRED');
    }
    const proofHash = contentHashSchema.safeParse(event.payload?.completionProofHash);
    if (!proofHash.success) throw new Error('COMMITSET_COMPLETION_PROOF_INVALID');
    const status = transitionLifecycle(commitSetMachine, state.status, event);
    return { ...state, status, completionProofHash: proofHash.data };
  }
  const status = transitionLifecycle(commitSetMachine, state.status, event);
  if (event.type === 'INVALIDATE') {
    const { completionProofHash: _completionProofHash, ...withoutProof } = state;
    return { ...withoutProof, status };
  }
  return { ...state, status };
}

function migrateCommitSetV1ToV2(state: CommitSetV1): ExecutionMaterializedState {
  const legacy = commitSetV1Schema.parse(state);
  const members = legacy.members.map((member) => {
    if (member.status !== 'INTEGRATED') return member;
    return { ...member, status: 'NEEDS_REVALIDATION' as const };
  });
  const missingExactIdentity = members.some((member) => member.status === 'NEEDS_REVALIDATION');
  const status = legacy.status === 'COMPLETE' || legacy.status === 'NEEDS_REVALIDATION' || missingExactIdentity
    ? 'NEEDS_REVALIDATION' as const
    : legacy.status;
  return commitSetSchema.parse({
    ...legacy,
    machineVersion: 2,
    status,
    contractSnapshots: [],
    legacyContractSnapshots: legacy.contractSnapshots,
    members,
    integrationGateRefs: [],
  });
}

function illegalLegacyCommitSetTransition(status: string, event: string): Error {
  return new Error(`ILLEGAL_LIFECYCLE_TRANSITION: aggregate=commitset-v1 current=${status} event=${event}`);
}

function migrationKey(aggregateType: ExecutionAggregateType, fromVersion: number, toVersion: number): string {
  return `${aggregateType}\0${fromVersion}\0${toVersion}`;
}

function requireMachineVersion(value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`MACHINE_VERSION_INVALID: value=${String(value)}`);
  }
}

function defaultStatus(state: ExecutionMaterializedState): string {
  if (typeof state.status !== 'string' || state.status.length === 0) {
    throw new Error('AGGREGATE_STATUS_UNAVAILABLE');
  }
  return state.status;
}
