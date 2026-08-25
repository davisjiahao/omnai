import { z } from 'zod';
import {
  appendJsonLineDurable,
  pathExists,
  readJsonLines,
  readYaml,
  writeYaml,
} from '../core/files.js';
import { hashObject } from './hashing.js';
import {
  createProductionAggregateRegistry,
  ExecutionAggregateRegistry,
  type ExecutionMaterializedState,
  type ExecutionTransitionEvent,
  type RegisteredAggregateMigration,
} from './aggregate-registry.js';
import { withWorksetMutationLock } from './mutation-lock.js';
import {
  contentHashSchema,
  executionEventSchema,
  type ContentHash,
  type ExecutionEvent,
} from './types.js';

export type { ExecutionMaterializedState, ExecutionTransitionEvent } from './aggregate-registry.js';

export interface ReplayRequest<TState extends ExecutionMaterializedState> {
  home: string;
  worksetId: string;
  aggregateType: ExecutionEvent['aggregateType'];
  aggregateId: string;
  eventsPath: string;
  statePath: string;
  initialState: TState;
  now: () => string;
}

export interface TransitionRequest<TState extends ExecutionMaterializedState> extends ReplayRequest<TState> {
  event: ExecutionTransitionEvent;
}

export interface FileEventStoreFaults {
  afterEventAppend?: (event: StoredExecutionEvent) => void;
}

type AggregateType = ExecutionEvent['aggregateType'];

interface StoredExecutionEvent {
  schemaVersion: 1;
  eventId: string;
  aggregateType: AggregateType;
  aggregateId: string;
  machineVersion: number;
  sequence: number;
  type: string;
  from: string;
  to: string;
  payload: Record<string, unknown>;
  previousHash: ContentHash | null;
  timestamp: string;
  hash: ContentHash;
}

interface ReplayResult<TState extends ExecutionMaterializedState> {
  state: TState;
  snapshots: Map<number, TState>;
  events: StoredExecutionEvent[];
  pendingMigration: RegisteredAggregateMigration | null;
}

export class FileEventStore {
  faults: FileEventStoreFaults | undefined;

  constructor(private readonly registry = createProductionAggregateRegistry()) {}

  async transition<TState extends ExecutionMaterializedState>(request: TransitionRequest<TState>): Promise<TState> {
    return withWorksetMutationLock(request.home, request.worksetId, async () => {
      const current = await this.loadAndRepairUnlocked(request, false);
      const machineVersion = this.registry.currentVersion(request.aggregateType);
      if (current.machineVersion !== machineVersion) {
        throw machineVersionUnsupported(request.aggregateType, current.machineVersion, machineVersion);
      }
      const timestamp = request.now();
      const reduced = this.registry.reduce<TState>(
        request.aggregateType,
        machineVersion,
        current,
        request.event,
        { mode: 'transition', timestamp },
      );
      const currentStatus = this.registry.statusOf(request.aggregateType, machineVersion, current);
      const reducedStatus = this.registry.statusOf(request.aggregateType, machineVersion, reduced);
      const sequence = current.lastEventSequence + 1;
      const eventWithoutHash = {
        schemaVersion: 1 as const,
        eventId: `${request.aggregateId}:${String(sequence).padStart(6, '0')}`,
        aggregateType: request.aggregateType,
        aggregateId: request.aggregateId,
        machineVersion,
        sequence,
        type: request.event.type,
        from: currentStatus,
        to: reducedStatus,
        payload: request.event.payload ?? {},
        previousHash: current.lastEventHash,
        timestamp,
      };
      const event = executionEventSchema.parse({
        ...eventWithoutHash,
        hash: hashObject(eventWithoutHash),
      });
      await appendJsonLineDurable(request.eventsPath, event);
      this.faults?.afterEventAppend?.(event);
      const next = this.registry.parse<TState>(request.aggregateType, machineVersion, {
        ...reduced,
        lastEventSequence: sequence,
        lastEventHash: event.hash,
        updatedAt: event.timestamp,
      });
      await writeYaml(request.statePath, next);
      return next;
    });
  }

  async loadAndRepair<TState extends ExecutionMaterializedState>(request: ReplayRequest<TState>): Promise<TState> {
    return withWorksetMutationLock(
      request.home,
      request.worksetId,
      () => this.loadAndRepairUnlocked(request, true),
    );
  }

  async replay<TState extends ExecutionMaterializedState>(request: ReplayRequest<TState>): Promise<TState> {
    const replayed = await this.validateAndReplay(request);
    if (replayed.pendingMigration) {
      throw machineVersionUnsupported(
        request.aggregateType,
        replayed.pendingMigration.fromVersion,
        this.registry.currentVersion(request.aggregateType),
      );
    }
    return this.registry.parse<TState>(request.aggregateType, replayed.state.machineVersion, replayed.state);
  }

  private async loadAndRepairUnlocked<TState extends ExecutionMaterializedState>(
    request: ReplayRequest<TState>,
    materializeEmptyHistory: boolean,
  ): Promise<TState> {
    const replayed = await this.validateAndReplay(request);
    const stored = await readMaterializedState(request.statePath);
    if (stored !== null) validateStoredState(this.registry, request, stored, replayed);

    if (replayed.pendingMigration) {
      return this.appendMigration(request, replayed, replayed.pendingMigration);
    }

    const current = this.registry.parse<TState>(request.aggregateType, replayed.state.machineVersion, replayed.state);
    if (stored === null) {
      if (replayed.events.length > 0 || materializeEmptyHistory) await writeYaml(request.statePath, current);
      return current;
    }
    const storedSequence = stateSequence(stored);
    if (storedSequence < current.lastEventSequence) await writeYaml(request.statePath, current);
    return current;
  }

  private async validateAndReplay<TState extends ExecutionMaterializedState>(
    request: ReplayRequest<TState>,
  ): Promise<ReplayResult<TState>> {
    assertStateShape(request.initialState, 'INITIAL_STATE_INVALID');
    const initialState = this.registry.parse<TState>(
      request.aggregateType,
      request.initialState.machineVersion,
      request.initialState,
    );
    const rawEvents = await readJsonLines<unknown>(request.eventsPath);
    const events = validateEventChain(request, rawEvents);
    const pendingMigration = validateMachineVersions(
      request.aggregateType,
      initialState.machineVersion,
      events,
      this.registry,
    );

    let current = initialState;
    const snapshots = new Map<number, TState>([[0, current]]);
    for (const event of events) {
      if (event.type === 'MACHINE_MIGRATED') {
        const migration = this.registry.findMigration(
          request.aggregateType,
          current.machineVersion,
          event.machineVersion,
        );
        if (!migration) {
          throw machineVersionUnsupported(request.aggregateType, current.machineVersion, event.machineVersion);
        }
        current = applyRecordedMigration(this.registry, request, current, event, migration);
      } else {
        current = applyRecordedTransition(this.registry, request, current, event);
      }
      snapshots.set(event.sequence, current);
    }

    return { state: current, snapshots, events, pendingMigration };
  }

  private async appendMigration<TState extends ExecutionMaterializedState>(
    request: ReplayRequest<TState>,
    replayed: ReplayResult<TState>,
    migration: RegisteredAggregateMigration,
  ): Promise<TState> {
    const oldState = replayed.state;
    const oldStatus = this.registry.statusOf(request.aggregateType, oldState.machineVersion, oldState);
    const oldStateHash = hashObject(oldState);
    const migrated = migration.migrate(structuredClone(oldState)) as TState;
    assertStateShape(migrated, 'MIGRATED_STATE_INVALID');
    if (migrated.machineVersion !== migration.toVersion) {
      throw new Error(
        `MIGRATED_STATE_VERSION_MISMATCH: expected=${migration.toVersion} actual=${migrated.machineVersion}`,
      );
    }
    const parsedMigrated = this.registry.parse<TState>(request.aggregateType, migration.toVersion, migrated);
    const migratedStatus = this.registry.statusOf(request.aggregateType, migration.toVersion, parsedMigrated);
    const sequence = oldState.lastEventSequence + 1;
    const eventWithoutHash = {
      schemaVersion: 1 as const,
      eventId: `${request.aggregateId}:${String(sequence).padStart(6, '0')}`,
      aggregateType: request.aggregateType,
      aggregateId: request.aggregateId,
      machineVersion: migration.toVersion,
      sequence,
      type: 'MACHINE_MIGRATED',
      from: oldStatus,
      to: migratedStatus,
      payload: {
        oldStateHash,
        newStateHash: hashObject(parsedMigrated),
      },
      previousHash: oldState.lastEventHash,
      timestamp: request.now(),
    };
    const event = executionEventSchema.parse({
      ...eventWithoutHash,
      hash: hashObject(eventWithoutHash),
    });
    await appendJsonLineDurable(request.eventsPath, event);
    this.faults?.afterEventAppend?.(event);
    const materialized = this.registry.parse<TState>(request.aggregateType, migration.toVersion, {
      ...parsedMigrated,
      lastEventSequence: sequence,
      lastEventHash: event.hash,
      updatedAt: event.timestamp,
    });
    await writeYaml(request.statePath, materialized);
    return materialized;
  }
}

function validateEventChain<TState extends ExecutionMaterializedState>(
  request: ReplayRequest<TState>,
  rawEvents: readonly unknown[],
): StoredExecutionEvent[] {
  const events: StoredExecutionEvent[] = [];
  let previousHash: ContentHash | null = null;
  for (let index = 0; index < rawEvents.length; index += 1) {
    const event = parseStoredEvent(rawEvents[index], index + 1);
    const expectedSequence = index + 1;
    if (event.sequence !== expectedSequence) {
      throw new Error(`EVENT_SEQUENCE_MISMATCH: expected=${expectedSequence} actual=${event.sequence}`);
    }
    const expectedEventId = `${request.aggregateId}:${String(expectedSequence).padStart(6, '0')}`;
    if (event.eventId !== expectedEventId) {
      throw new Error(`EVENT_ID_MISMATCH: expected=${expectedEventId} actual=${event.eventId}`);
    }
    if (event.previousHash !== previousHash) {
      throw new Error(
        `EVENT_PREVIOUS_HASH_MISMATCH: sequence=${event.sequence} expected=${previousHash} actual=${event.previousHash}`,
      );
    }
    const { hash, ...withoutHash } = event;
    const recomputed = hashObject(withoutHash);
    if (hash !== recomputed) {
      throw new Error(`EVENT_HASH_MISMATCH: sequence=${event.sequence} expected=${recomputed} actual=${hash}`);
    }
    if (event.aggregateId !== request.aggregateId) {
      throw new Error(
        `EVENT_AGGREGATE_ID_MISMATCH: expected=${request.aggregateId} actual=${event.aggregateId}`,
      );
    }
    if (event.aggregateType !== request.aggregateType) {
      throw new Error(
        `EVENT_AGGREGATE_TYPE_MISMATCH: expected=${request.aggregateType} actual=${event.aggregateType}`,
      );
    }
    if (event.type === 'MACHINE_MIGRATED') validateMigrationPayload(event);
    events.push(event);
    previousHash = event.hash;
  }
  return events;
}

function parseStoredEvent(value: unknown, line: number): StoredExecutionEvent {
  if (!isRecord(value)) throw new Error(`EVENT_SCHEMA_INVALID: line=${line}`);
  const normalized = executionEventSchema.safeParse({
    ...value,
    machineVersion: 1,
    sequence: 1,
    previousHash: null,
  });
  if (!normalized.success) {
    throw new Error(`EVENT_SCHEMA_INVALID: line=${line} detail=${z.prettifyError(normalized.error)}`);
  }
  const machineVersion = value.machineVersion;
  const sequence = value.sequence;
  const previousHash = value.previousHash;
  requireMachineVersion(machineVersion);
  if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence <= 0) {
    throw new Error(`EVENT_SEQUENCE_INVALID: line=${line}`);
  }
  const parsedPreviousHash = previousHash === null ? null : contentHashSchema.safeParse(previousHash);
  if (parsedPreviousHash !== null && !parsedPreviousHash.success) {
    throw new Error(`EVENT_PREVIOUS_HASH_INVALID: line=${line}`);
  }
  return {
    ...normalized.data,
    machineVersion,
    sequence,
    previousHash: parsedPreviousHash === null ? null : parsedPreviousHash.data,
  };
}

function validateMachineVersions(
  aggregateType: AggregateType,
  initialVersion: number,
  events: readonly StoredExecutionEvent[],
  registry: ExecutionAggregateRegistry,
): RegisteredAggregateMigration | null {
  requireMachineVersion(initialVersion);
  if (!registry.hasVersion(aggregateType, initialVersion)) {
    throw machineVersionUnsupported(aggregateType, initialVersion, registry.currentVersion(aggregateType));
  }
  let activeVersion = initialVersion;
  for (const event of events) {
    if (event.type === 'MACHINE_MIGRATED') {
      const migration = registry.findMigration(aggregateType, activeVersion, event.machineVersion);
      if (!migration || !registry.hasVersion(aggregateType, event.machineVersion)) {
        throw machineVersionUnsupported(aggregateType, activeVersion, event.machineVersion);
      }
      activeVersion = event.machineVersion;
    } else if (event.machineVersion !== activeVersion) {
      throw machineVersionUnsupported(aggregateType, event.machineVersion, activeVersion);
    }
  }

  const currentVersion = registry.currentVersion(aggregateType);
  if (activeVersion === currentVersion) return null;
  const pending = registry.findMigration(aggregateType, activeVersion, currentVersion);
  if (!pending) throw machineVersionUnsupported(aggregateType, activeVersion, currentVersion);
  return pending;
}

function applyRecordedTransition<TState extends ExecutionMaterializedState>(
  registry: ExecutionAggregateRegistry,
  request: ReplayRequest<TState>,
  current: TState,
  event: StoredExecutionEvent,
): TState {
  const currentStatus = registry.statusOf(request.aggregateType, current.machineVersion, current);
  if (event.from !== currentStatus) {
    throw new Error(
      `EVENT_FROM_MISMATCH: sequence=${event.sequence} expected=${currentStatus} actual=${event.from}`,
    );
  }
  const reduced = registry.reduce<TState>(
    request.aggregateType,
    current.machineVersion,
    current,
    { type: event.type, payload: event.payload },
    { mode: 'replay', timestamp: event.timestamp },
  );
  const reducedStatus = registry.statusOf(request.aggregateType, current.machineVersion, reduced);
  if (event.to !== reducedStatus) {
    throw new Error(
      `EVENT_TRANSITION_MISMATCH: sequence=${event.sequence} expected=${reducedStatus} actual=${event.to}`,
    );
  }
  return {
    ...reduced,
    lastEventSequence: event.sequence,
    lastEventHash: event.hash,
    updatedAt: event.timestamp,
  };
}

function applyRecordedMigration<TState extends ExecutionMaterializedState>(
  registry: ExecutionAggregateRegistry,
  request: ReplayRequest<TState>,
  current: TState,
  event: StoredExecutionEvent,
  migration: RegisteredAggregateMigration,
): TState {
  const payload = validateMigrationPayload(event);
  const currentStatus = registry.statusOf(request.aggregateType, current.machineVersion, current);
  if (event.from !== currentStatus) {
    throw new Error(
      `MIGRATION_FROM_MISMATCH: sequence=${event.sequence} expected=${currentStatus} actual=${event.from}`,
    );
  }
  if (payload.oldStateHash !== hashObject(current)) {
    throw new Error(`MIGRATION_OLD_STATE_HASH_MISMATCH: sequence=${event.sequence}`);
  }
  const migrated = migration.migrate(structuredClone(current)) as TState;
  assertStateShape(migrated, 'MIGRATED_STATE_INVALID');
  if (migrated.machineVersion !== event.machineVersion) {
    throw new Error(
      `MIGRATED_STATE_VERSION_MISMATCH: expected=${event.machineVersion} actual=${migrated.machineVersion}`,
    );
  }
  const migratedStatus = registry.statusOf(request.aggregateType, event.machineVersion, migrated);
  if (event.to !== migratedStatus) {
    throw new Error(
      `MIGRATION_TO_MISMATCH: sequence=${event.sequence} expected=${migratedStatus} actual=${event.to}`,
    );
  }
  const parsed = registry.parse<TState>(request.aggregateType, event.machineVersion, migrated);
  if (payload.newStateHash !== hashObject(parsed)) {
    throw new Error(`MIGRATION_NEW_STATE_HASH_MISMATCH: sequence=${event.sequence}`);
  }
  return {
    ...parsed,
    lastEventSequence: event.sequence,
    lastEventHash: event.hash,
    updatedAt: event.timestamp,
  };
}

function validateStoredState<TState extends ExecutionMaterializedState>(
  registry: ExecutionAggregateRegistry,
  request: ReplayRequest<TState>,
  stored: unknown,
  replayed: ReplayResult<TState>,
): void {
  assertStateShape(stored, 'MATERIALIZED_STATE_INVALID');
  if (stored.lastEventSequence > replayed.events.length) {
    throw new Error(
      `STATE_AHEAD_OF_HISTORY: stateSequence=${stored.lastEventSequence} historySequence=${replayed.events.length}`,
    );
  }
  if (stored.lastEventSequence < replayed.events.length) return;
  const expected = replayed.snapshots.get(stored.lastEventSequence);
  if (!expected) {
    throw new Error(`STATE_HISTORY_DIVERGENCE: sequence=${stored.lastEventSequence}`);
  }
  if (stored.machineVersion !== expected.machineVersion) {
    throw machineVersionUnsupported(request.aggregateType, stored.machineVersion, expected.machineVersion);
  }
  const parsed = registry.parse(request.aggregateType, stored.machineVersion, stored);
  if (hashObject(parsed) !== hashObject(expected)) {
    throw new Error(`STATE_HISTORY_DIVERGENCE: sequence=${stored.lastEventSequence}`);
  }
}

function validateMigrationPayload(
  event: StoredExecutionEvent,
): { oldStateHash: ContentHash; newStateHash: ContentHash } {
  const keys = Object.keys(event.payload).sort();
  const oldStateHash = contentHashSchema.safeParse(event.payload.oldStateHash);
  const newStateHash = contentHashSchema.safeParse(event.payload.newStateHash);
  if (keys.length !== 2 || keys[0] !== 'newStateHash' || keys[1] !== 'oldStateHash' ||
      !oldStateHash.success || !newStateHash.success) {
    throw new Error(`MIGRATION_PAYLOAD_INVALID: sequence=${event.sequence}`);
  }
  return { oldStateHash: oldStateHash.data, newStateHash: newStateHash.data };
}

async function readMaterializedState(path: string): Promise<unknown | null> {
  if (!(await pathExists(path))) return null;
  return readYaml(path, z.unknown());
}

function assertStateShape(value: unknown, code: string): asserts value is ExecutionMaterializedState {
  if (!isRecord(value) ||
      typeof value.machineVersion !== 'number' || !Number.isInteger(value.machineVersion) || value.machineVersion <= 0 ||
      typeof value.lastEventSequence !== 'number' || !Number.isInteger(value.lastEventSequence) || value.lastEventSequence < 0 ||
      (value.lastEventHash !== null && !contentHashSchema.safeParse(value.lastEventHash).success) ||
      (value.updatedAt !== undefined && typeof value.updatedAt !== 'string')) {
    throw new Error(`${code}: invalid lifecycle materialization`);
  }
  if ((value.lastEventSequence === 0) !== (value.lastEventHash === null)) {
    throw new Error(`${code}: cursor and hash disagree`);
  }
}

function stateSequence(value: unknown): number {
  assertStateShape(value, 'MATERIALIZED_STATE_INVALID');
  return value.lastEventSequence;
}

function requireMachineVersion(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`MACHINE_VERSION_INVALID: value=${String(value)}`);
  }
}

function machineVersionUnsupported(aggregateType: AggregateType, from: number, to: number): Error {
  return new Error(`MACHINE_VERSION_UNSUPPORTED: aggregateType=${aggregateType} from=${from} to=${to}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
