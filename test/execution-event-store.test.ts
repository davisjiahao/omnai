import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import {
  pathExists,
  readJsonLines,
  readYaml,
  writeYaml,
} from '../src/core/files.js';
import { LocalExecutionBackend } from '../src/execution/backend.js';
import { ExecutionAggregateRegistry } from '../src/execution/aggregate-registry.js';
import {
  FileEventStore,
  type TransitionRequest,
} from '../src/execution/event-store.js';
import { hashObject } from '../src/execution/hashing.js';
import {
  WorksetMutationLockError,
  withWorksetMutationLock,
} from '../src/execution/mutation-lock.js';
import { worksetMutationLockPath } from '../src/execution/paths.js';
import { createTestDirectory } from './helpers.js';

const NOW = '2026-08-16T00:00:00.000Z';
const EVENT_NOW = '2026-08-16T00:00:01.000Z';
const MIGRATION_NOW = '2026-08-16T00:00:02.000Z';
const WORKSET_ID = 'WKS-0001';
const AGGREGATE_ID = 'RUN-0001';
const FAKE_HASH = `sha256:${'f'.repeat(64)}` as const;

const fixtureStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  machineVersion: z.number().int().nonnegative(),
  id: z.literal(AGGREGATE_ID),
  status: z.enum(['PREPARED', 'RUNNING', 'FINISHED']),
  note: z.string(),
  lastEventSequence: z.number().int().nonnegative(),
  lastEventHash: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).superRefine((state, context) => {
  if ((state.lastEventSequence === 0) !== (state.lastEventHash === null)) {
    context.addIssue({ code: 'custom', path: ['lastEventHash'], message: 'cursor and hash must agree' });
  }
});

type FixtureState = z.infer<typeof fixtureStateSchema>;
type FixtureEvent = { type: string; payload?: Record<string, unknown> };

interface StoredEvent {
  schemaVersion: number;
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  machineVersion: number;
  sequence: number;
  type: string;
  from: string;
  to: string;
  payload: Record<string, unknown>;
  previousHash: string | null;
  timestamp: string;
  hash: string;
}

function initialState(machineVersion = 1): FixtureState {
  return {
    schemaVersion: 1,
    machineVersion,
    id: AGGREGATE_ID,
    status: 'PREPARED',
    note: 'fixture',
    lastEventSequence: 0,
    lastEventHash: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function reduceFixture(status: FixtureState['status'], event: FixtureEvent): FixtureState['status'] {
  if (status === 'PREPARED' && event.type === 'START') return 'RUNNING';
  if (status === 'RUNNING' && event.type === 'FINISH') return 'FINISHED';
  throw new Error(`ILLEGAL_TEST_TRANSITION: current=${status} event=${event.type}`);
}

async function createExecutionFixture(options: { machineVersion?: number; currentVersion?: number } = {}) {
  const directory = await createTestDirectory('omnai-event-store-');
  const eventsPath = join(directory.root, 'events.jsonl');
  const statePath = join(directory.root, 'state.yaml');
  const registry = new ExecutionAggregateRegistry();
  let reducerCalls = 0;
  let clockIndex = 0;
  const timestamps = [EVENT_NOW, MIGRATION_NOW, '2026-08-16T00:00:03.000Z'];
  const reducer = (state: FixtureState, event: FixtureEvent): FixtureState => {
    reducerCalls += 1;
    return { ...state, status: reduceFixture(state.status, event) };
  };
  registry.register({
    aggregateType: 'run',
    currentVersion: options.currentVersion ?? 1,
    versions: [1, 2, 3].map((machineVersion) => ({
      machineVersion,
      schema: fixtureStateSchema,
      reducer,
    })),
  });
  const store = new FileEventStore(registry);
  const baseRequest = {
    home: directory.root,
    worksetId: WORKSET_ID,
    aggregateType: 'run' as const,
    aggregateId: AGGREGATE_ID,
    eventsPath,
    statePath,
    initialState: initialState(options.machineVersion ?? 1),
    now: () => timestamps[clockIndex++] ?? timestamps.at(-1)!,
  };

  return {
    root: directory.root,
    eventsPath,
    statePath,
    registry,
    store,
    baseRequest,
    transition: (type: string) => store.transition({
      ...baseRequest,
      event: { type },
    } satisfies TransitionRequest<FixtureState>),
    loadAndRepair: () => store.loadAndRepair(baseRequest),
    replay: () => store.replay(baseRequest),
    readState: () => readYaml(statePath, fixtureStateSchema),
    events: () => readJsonLines<StoredEvent>(eventsPath),
    reducerCalls: () => reducerCalls,
    resetReducerCalls: () => { reducerCalls = 0; },
    cleanup: directory.cleanup,
  };
}

function withRecomputedHash(event: Omit<StoredEvent, 'hash'> | StoredEvent): StoredEvent {
  const { hash: _hash, ...withoutHash } = event as StoredEvent;
  return { ...withoutHash, hash: hashObject(withoutHash) };
}

async function replaceEvents(path: string, events: readonly StoredEvent[]): Promise<void> {
  await writeFile(path, events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');
}

async function writeHistoricalStartEvent(path: string, machineVersion: number): Promise<string> {
  const event = withRecomputedHash({
    schemaVersion: 1,
    eventId: `${AGGREGATE_ID}:000001`,
    aggregateType: 'run',
    aggregateId: AGGREGATE_ID,
    machineVersion,
    sequence: 1,
    type: 'START',
    from: 'PREPARED',
    to: 'RUNNING',
    payload: {},
    previousHash: null,
    timestamp: EVENT_NOW,
  });
  const line = `${JSON.stringify(event)}\n`;
  await writeFile(path, line, 'utf8');
  return line;
}

async function writeHistoricalMigrationEvent(
  path: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const event = withRecomputedHash({
    schemaVersion: 1,
    eventId: `${AGGREGATE_ID}:000001`,
    aggregateType: 'run',
    aggregateId: AGGREGATE_ID,
    machineVersion: 1,
    sequence: 1,
    type: 'MACHINE_MIGRATED',
    from: 'PREPARED',
    to: 'PREPARED',
    payload,
    previousHash: null,
    timestamp: EVENT_NOW,
  });
  await replaceEvents(path, [event]);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

interface TestLockOwner {
  token: string;
  pid: number;
  acquiredAt: string;
}

function testOwnerFileName(owner: TestLockOwner): string {
  return `owner-${owner.token}-${owner.pid}.json`;
}

async function writeTestLockOwner(lockPath: string, owner: TestLockOwner): Promise<void> {
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, testOwnerFileName(owner)), JSON.stringify(owner), 'utf8');
}

async function readTestLockOwner(lockPath: string): Promise<TestLockOwner> {
  const names = await readdir(lockPath);
  assert.equal(names.length, 1);
  return JSON.parse(await readFile(join(lockPath, names[0]!), 'utf8')) as TestLockOwner;
}

async function removeTestLockOwner(lockPath: string, owner: TestLockOwner): Promise<void> {
  await unlink(join(lockPath, testOwnerFileName(owner)));
  await rmdir(lockPath);
}

function crashLockChild(
  root: string,
  fault: 'afterOwnerOpen' | 'afterOwnerPublished' | 'afterOwnerUnlink',
  exitCode: number,
): number {
  const moduleUrl = new URL('../src/execution/mutation-lock.js', import.meta.url).href;
  const source = [
    `import { withWorksetMutationLock } from ${JSON.stringify(moduleUrl)};`,
    `await withWorksetMutationLock(${JSON.stringify(root)}, ${JSON.stringify(WORKSET_ID)}, async () => undefined, {`,
    '  timeoutMs: 500,',
    `  faults: { [${JSON.stringify(fault)}]: () => process.exit(${exitCode}) },`,
    '});',
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, exitCode, child.stderr);
  assert.equal(typeof child.pid, 'number');
  return child.pid!;
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!(await pathExists(path))) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('appends and fsyncs an event before replacing materialized state', async () => {
  const fixture = await createExecutionFixture();
  try {
    fixture.store.faults = { afterEventAppend: () => { throw new Error('injected crash'); } };
    await assert.rejects(() => fixture.transition('START'), /injected crash/);
    assert.equal((await fixture.events()).length, 1);
    assert.equal(await pathExists(fixture.statePath), false);

    fixture.store.faults = undefined;
    const repaired = await fixture.loadAndRepair();
    assert.equal(repaired.status, 'RUNNING');
    assert.equal(repaired.lastEventSequence, 1);
    assert.equal(repaired.lastEventHash, (await fixture.events())[0]!.hash);
  } finally {
    await fixture.cleanup();
  }
});

test('rejects a broken event hash without replacing materialized state', async () => {
  const fixture = await createExecutionFixture();
  try {
    const materialized = await fixture.transition('START');
    const [event] = await fixture.events();
    await replaceEvents(fixture.eventsPath, [{ ...event!, hash: FAKE_HASH }]);

    await assert.rejects(() => fixture.loadAndRepair(), /EVENT_HASH_MISMATCH/);
    assert.deepEqual(await fixture.readState(), materialized);
  } finally {
    await fixture.cleanup();
  }
});

test('state ahead of history blocks transition dispatch', async () => {
  const fixture = await createExecutionFixture();
  try {
    await fixture.transition('START');
    const state = await fixture.readState();
    await writeYaml(fixture.statePath, {
      ...state,
      lastEventSequence: 9,
      lastEventHash: FAKE_HASH,
    });

    await assert.rejects(() => fixture.transition('FINISH'), /STATE_AHEAD_OF_HISTORY/);
    assert.equal((await fixture.events()).length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test('same-sequence state disagreement blocks transition dispatch', async () => {
  const fixture = await createExecutionFixture();
  try {
    await fixture.transition('START');
    const state = await fixture.readState();
    await writeYaml(fixture.statePath, { ...state, status: 'FINISHED' });

    await assert.rejects(() => fixture.transition('FINISH'), /STATE_HISTORY_DIVERGENCE/);
    assert.equal((await fixture.events()).length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test('a divergent behind materialization is repaired from durable history', async () => {
  const fixture = await createExecutionFixture();
  try {
    await fixture.transition('START');
    await fixture.transition('FINISH');
    const events = await fixture.events();
    await writeYaml(fixture.statePath, {
      ...initialState(),
      status: 'FINISHED',
      lastEventSequence: 1,
      lastEventHash: events[0]!.hash,
      updatedAt: events[0]!.timestamp,
    });

    const repaired = await fixture.loadAndRepair();
    assert.equal(repaired.status, 'FINISHED');
    assert.equal(repaired.lastEventSequence, 2);
    assert.deepEqual(await fixture.readState(), repaired);
  } finally {
    await fixture.cleanup();
  }
});

test('public empty-history repair materializes initial state without weakening append-first transition', async () => {
  const fixture = await createExecutionFixture();
  try {
    const repaired = await fixture.loadAndRepair();
    assert.deepEqual(repaired, initialState());
    assert.deepEqual(await fixture.readState(), initialState());
  } finally {
    await fixture.cleanup();
  }
});

test('blocks an unregistered materialized lifecycle machine version', async () => {
  const fixture = await createExecutionFixture();
  try {
    await fixture.transition('START');
    await writeYaml(fixture.statePath, { ...await fixture.readState(), machineVersion: 99 });

    await assert.rejects(() => fixture.loadAndRepair(), /MACHINE_VERSION_UNSUPPORTED/);
    assert.equal((await fixture.events()).length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test('validates sequence, previous hash, hash, identity, type, and version before reducing', async (context) => {
  const cases: ReadonlyArray<{
    name: string;
    mutate: (event: StoredEvent) => StoredEvent;
    error: RegExp;
  }> = [
    {
      name: 'sequence',
      mutate: (event) => withRecomputedHash({ ...event, eventId: `${AGGREGATE_ID}:000002`, sequence: 2 }),
      error: /EVENT_SEQUENCE_MISMATCH/,
    },
    {
      name: 'previous hash',
      mutate: (event) => withRecomputedHash({ ...event, previousHash: FAKE_HASH }),
      error: /EVENT_PREVIOUS_HASH_MISMATCH/,
    },
    {
      name: 'recomputed hash',
      mutate: (event) => ({ ...event, hash: FAKE_HASH }),
      error: /EVENT_HASH_MISMATCH/,
    },
    {
      name: 'aggregate id',
      mutate: (event) => withRecomputedHash({ ...event, aggregateId: 'RUN-9999' }),
      error: /EVENT_AGGREGATE_ID_MISMATCH/,
    },
    {
      name: 'aggregate type',
      mutate: (event) => withRecomputedHash({ ...event, aggregateType: 'wave' }),
      error: /EVENT_AGGREGATE_TYPE_MISMATCH/,
    },
    {
      name: 'machine version',
      mutate: (event) => withRecomputedHash({ ...event, machineVersion: 99 }),
      error: /MACHINE_VERSION_UNSUPPORTED/,
    },
  ];

  for (const item of cases) {
    await context.test(item.name, async () => {
      const fixture = await createExecutionFixture();
      try {
        await fixture.transition('START');
        const [event] = await fixture.events();
        await replaceEvents(fixture.eventsPath, [item.mutate(event!)]);
        fixture.resetReducerCalls();

        await assert.rejects(() => fixture.replay(), item.error);
        assert.equal(fixture.reducerCalls(), 0);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test('applies only an exact registered migration and preserves old event bytes', async () => {
  const fixture = await createExecutionFixture({ machineVersion: 1, currentVersion: 2 });
  try {
    const oldLine = await writeHistoricalStartEvent(fixture.eventsPath, 1);
    fixture.registry.registerMigration<FixtureState>('run', 1, 2, (state: FixtureState) => ({
      ...state,
      machineVersion: 2,
    }));

    const migrated = await fixture.loadAndRepair();
    const raw = await readFile(fixture.eventsPath, 'utf8');
    const events = await fixture.events();
    assert.equal(raw.startsWith(oldLine), true);
    assert.equal(raw.slice(0, oldLine.length), oldLine);
    assert.equal(events.length, 2);
    assert.equal(events[1]!.type, 'MACHINE_MIGRATED');
    assert.equal(events[1]!.machineVersion, 2);
    assert.equal(events[1]!.previousHash, events[0]!.hash);
    assert.equal(migrated.machineVersion, 2);
    assert.equal(migrated.status, 'RUNNING');
    assert.equal(migrated.lastEventSequence, 2);

    const oldReplayedState = {
      ...initialState(1),
      status: 'RUNNING' as const,
      lastEventSequence: 1,
      lastEventHash: events[0]!.hash,
      updatedAt: EVENT_NOW,
    };
    assert.equal(events[1]!.payload.oldStateHash, hashObject(oldReplayedState));
    assert.equal(events[1]!.payload.newStateHash, hashObject({ ...oldReplayedState, machineVersion: 2 }));
    assert.deepEqual(await fixture.replay(), migrated);
  } finally {
    await fixture.cleanup();
  }
});

test('rejects an old chain without one exact registered migration before reducing or appending', async () => {
  const fixture = await createExecutionFixture({ machineVersion: 1, currentVersion: 2 });
  try {
    const oldLine = await writeHistoricalStartEvent(fixture.eventsPath, 1);
    assert.throws(
      () => fixture.registry.registerMigration<FixtureState>('run', 1, 3, (state: FixtureState) => ({ ...state, machineVersion: 3 })),
      /MIGRATION_VERSION_SKIP/,
    );
    fixture.resetReducerCalls();

    await assert.rejects(() => fixture.loadAndRepair(), /MACHINE_VERSION_UNSUPPORTED/);
    assert.equal(fixture.reducerCalls(), 0);
    assert.equal(await readFile(fixture.eventsPath, 'utf8'), oldLine);
    assert.equal(await pathExists(fixture.statePath), false);
  } finally {
    await fixture.cleanup();
  }
});

test('validates the old hash chain before invoking a registered migration', async () => {
  const fixture = await createExecutionFixture({ machineVersion: 1, currentVersion: 2 });
  try {
    await writeHistoricalStartEvent(fixture.eventsPath, 1);
    const [event] = await fixture.events();
    await replaceEvents(fixture.eventsPath, [{ ...event!, hash: FAKE_HASH }]);
    let migrations = 0;
    fixture.registry.registerMigration<FixtureState>('run', 1, 2, (state: FixtureState) => {
      migrations += 1;
      return { ...state, machineVersion: 2 };
    });

    await assert.rejects(() => fixture.loadAndRepair(), /EVENT_HASH_MISMATCH/);
    assert.equal(migrations, 0);
    assert.equal((await fixture.events()).length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test('an in-place migration cannot mutate old state or corrupt migration hashes', async () => {
  const fixture = await createExecutionFixture({ machineVersion: 1, currentVersion: 2 });
  const pristine = structuredClone(fixture.baseRequest.initialState);
  try {
    fixture.registry.registerMigration<FixtureState>('run', 1, 2, (state: FixtureState) => {
      state.machineVersion = 2;
      return state;
    });

    const migrated = await fixture.loadAndRepair();
    const [event] = await fixture.events();
    assert.equal(event!.payload.oldStateHash, hashObject(pristine));
    assert.equal(event!.payload.newStateHash, hashObject({ ...pristine, machineVersion: 2 }));
    assert.deepEqual(fixture.baseRequest.initialState, pristine);
    assert.deepEqual(await fixture.replay(), migrated);
  } finally {
    await fixture.cleanup();
  }
});

test('an invalid migration hash payload is rejected before invoking migration code', async () => {
  const fixture = await createExecutionFixture({ machineVersion: 1, currentVersion: 2 });
  let migrationCalls = 0;
  try {
    await writeHistoricalMigrationEvent(fixture.eventsPath, {
      oldStateHash: hashObject(initialState(1)),
      newStateHash: 'not-a-content-hash',
    });
    fixture.registry.registerMigration<FixtureState>('run', 1, 2, (state: FixtureState) => {
      migrationCalls += 1;
      return { ...state, machineVersion: 2 };
    });

    await assert.rejects(() => fixture.loadAndRepair(), /MIGRATION_PAYLOAD_INVALID/);
    assert.equal(migrationCalls, 0);
    assert.equal(await pathExists(fixture.statePath), false);
  } finally {
    await fixture.cleanup();
  }
});

test('the Workset mutation lock admits one owner', async () => {
  const fixture = await createTestDirectory('omnai-lock-');
  let release!: () => void;
  try {
    const held = withWorksetMutationLock(fixture.root, WORKSET_ID, () => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const lockPath = worksetMutationLockPath(fixture.root, WORKSET_ID);
    await waitForPath(lockPath);

    await assert.rejects(
      () => withWorksetMutationLock(fixture.root, WORKSET_ID, async () => undefined, { timeoutMs: 25 }),
      (error: unknown) => error instanceof WorksetMutationLockError &&
        (error as { code?: string }).code === 'WORKSET_MUTATION_LOCKED',
    );
    release();
    await held;
    assert.equal(await pathExists(lockPath), false);
  } finally {
    release?.();
    await fixture.cleanup();
  }
});

test('lock cleanup unlinks only its exact never-reused owner child', async () => {
  const fixture = await createTestDirectory('omnai-lock-token-');
  const lockPath = worksetMutationLockPath(fixture.root, WORKSET_ID);
  const replacement = {
    token: 'replacement-owner',
    pid: process.pid,
    acquiredAt: NOW,
  };
  try {
    await withWorksetMutationLock(fixture.root, WORKSET_ID, async () => {
      const acquired = await readTestLockOwner(lockPath);
      assert.notEqual(acquired.token, replacement.token);
      await removeTestLockOwner(lockPath, acquired);
      await writeTestLockOwner(lockPath, replacement);
    });

    assert.deepEqual(await readTestLockOwner(lockPath), replacement);
  } finally {
    await fixture.cleanup();
  }
});

test('two stale-lock reclaimers cannot delete a newly acquired owner', async () => {
  const fixture = await createTestDirectory('omnai-lock-reapers-');
  const lockPath = worksetMutationLockPath(fixture.root, WORKSET_ID);
  const firstObserved = deferred();
  const secondObserved = deferred();
  const allowFirst = deferred();
  const allowSecond = deferred();
  const firstActionStarted = deferred();
  const releaseFirst = deferred();
  let firstOwnerToken = '';
  try {
    await writeTestLockOwner(lockPath, {
      token: 'dead-owner',
      pid: 2_147_483_647,
      acquiredAt: NOW,
    });

    const first = withWorksetMutationLock(fixture.root, WORKSET_ID, async () => {
      firstOwnerToken = (await readTestLockOwner(lockPath)).token;
      firstActionStarted.resolve();
      await releaseFirst.promise;
    }, {
      timeoutMs: 500,
      faults: {
        afterDeadOwnerObserved: async () => {
          firstObserved.resolve();
          await allowFirst.promise;
        },
      },
    });
    const second = withWorksetMutationLock(fixture.root, WORKSET_ID, async () => {
      assert.fail('second reclaimer must not enter while first owner is active');
    }, {
      timeoutMs: 150,
      faults: {
        afterDeadOwnerObserved: async () => {
          secondObserved.resolve();
          await allowSecond.promise;
        },
      },
    });

    await Promise.all([firstObserved.promise, secondObserved.promise]);
    allowFirst.resolve();
    await firstActionStarted.promise;
    allowSecond.resolve();

    await assert.rejects(second, /WORKSET_MUTATION_LOCKED/);
    assert.equal((await readTestLockOwner(lockPath)).token, firstOwnerToken);
    await assert.rejects(
      () => withWorksetMutationLock(fixture.root, WORKSET_ID, async () => undefined, { timeoutMs: 25 }),
      /WORKSET_MUTATION_LOCKED/,
    );
    releaseFirst.resolve();
    await first;
    assert.equal(await pathExists(lockPath), false);
  } finally {
    allowFirst.resolve();
    allowSecond.resolve();
    releaseFirst.resolve();
    await fixture.cleanup();
  }
});

test('a crash before owner publication leaves staging garbage but no canonical lock wedge', async () => {
  const fixture = await createTestDirectory('omnai-lock-prepublish-crash-');
  const lockPath = worksetMutationLockPath(fixture.root, WORKSET_ID);
  try {
    crashLockChild(fixture.root, 'afterOwnerOpen', 71);
    assert.equal(await pathExists(lockPath), false);
    assert.equal((await readdir(dirname(lockPath))).some((name) => name.startsWith('.mutation.lock.stage-')), true);

    let actionCalls = 0;
    await withWorksetMutationLock(fixture.root, WORKSET_ID, async () => { actionCalls += 1; }, { timeoutMs: 200 });
    assert.equal(actionCalls, 1);
    assert.equal(await pathExists(lockPath), false);
  } finally {
    await fixture.cleanup();
  }
});

test('a complete owner published by a crashed child is reaped by its exact child name', async () => {
  const fixture = await createTestDirectory('omnai-lock-published-crash-');
  const lockPath = worksetMutationLockPath(fixture.root, WORKSET_ID);
  try {
    const childPid = crashLockChild(fixture.root, 'afterOwnerPublished', 72);
    const deadOwner = await readTestLockOwner(lockPath);
    assert.equal(deadOwner.pid, childPid);

    let actionCalls = 0;
    await withWorksetMutationLock(fixture.root, WORKSET_ID, async () => { actionCalls += 1; }, { timeoutMs: 200 });
    assert.equal(actionCalls, 1);
    assert.equal(await pathExists(lockPath), false);
  } finally {
    await fixture.cleanup();
  }
});

test('an empty canonical directory left by a release crash is recovered safely', async () => {
  const fixture = await createTestDirectory('omnai-lock-release-crash-');
  const lockPath = worksetMutationLockPath(fixture.root, WORKSET_ID);
  try {
    crashLockChild(fixture.root, 'afterOwnerUnlink', 73);
    assert.deepEqual(await readdir(lockPath), []);

    let actionCalls = 0;
    await withWorksetMutationLock(fixture.root, WORKSET_ID, async () => { actionCalls += 1; }, { timeoutMs: 200 });
    assert.equal(actionCalls, 1);
    assert.equal(await pathExists(lockPath), false);
  } finally {
    await fixture.cleanup();
  }
});

test('owner-record write and close failures remove the exclusively created lock', async () => {
  const fixture = await createTestDirectory('omnai-lock-acquire-fault-');
  const lockPath = worksetMutationLockPath(fixture.root, WORKSET_ID);
  let actionCalls = 0;
  try {
    await assert.rejects(
      () => withWorksetMutationLock(fixture.root, WORKSET_ID, async () => { actionCalls += 1; }, {
        faults: { afterOwnerWrite: () => { throw new Error('injected owner write failure'); } },
      }),
      /injected owner write failure/,
    );
    assert.equal(await pathExists(lockPath), false);

    await assert.rejects(
      () => withWorksetMutationLock(fixture.root, WORKSET_ID, async () => { actionCalls += 1; }, {
        faults: { afterOwnerClose: () => { throw new Error('injected owner close failure'); } },
      }),
      /injected owner close failure/,
    );
    assert.equal(await pathExists(lockPath), false);
    assert.equal(actionCalls, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('a release failure never masks the action error', async () => {
  const fixture = await createTestDirectory('omnai-lock-release-fault-');
  const lockPath = worksetMutationLockPath(fixture.root, WORKSET_ID);
  try {
    await assert.rejects(
      () => withWorksetMutationLock(fixture.root, WORKSET_ID, async () => {
        throw new Error('primary action failure');
      }, {
        faults: { afterRelease: () => { throw new Error('secondary release failure'); } },
      }),
      /primary action failure/,
    );
    assert.equal(await pathExists(lockPath), false);
  } finally {
    await fixture.cleanup();
  }
});

test('lock stealing removes only a proven dead PID and preserves alive or unknown owners', async () => {
  const fixture = await createTestDirectory('omnai-lock-pid-');
  const lockPath = worksetMutationLockPath(fixture.root, WORKSET_ID);
  try {
    const dead = {
      token: 'dead-owner',
      pid: 2_147_483_647,
      acquiredAt: NOW,
    };
    await writeTestLockOwner(lockPath, dead);
    await withWorksetMutationLock(fixture.root, WORKSET_ID, async () => undefined, { timeoutMs: 100 });
    assert.equal(await pathExists(lockPath), false);

    const alive = { token: 'alive-owner', pid: process.pid, acquiredAt: NOW };
    await writeTestLockOwner(lockPath, alive);
    await assert.rejects(
      () => withWorksetMutationLock(fixture.root, WORKSET_ID, async () => undefined, { timeoutMs: 25 }),
      /WORKSET_MUTATION_LOCKED/,
    );
    assert.deepEqual(await readTestLockOwner(lockPath), alive);
    await removeTestLockOwner(lockPath, alive);

    const unknown = { token: 'unknown-owner', pid: Number.MAX_SAFE_INTEGER, acquiredAt: NOW };
    await writeTestLockOwner(lockPath, unknown);
    await assert.rejects(
      () => withWorksetMutationLock(fixture.root, WORKSET_ID, async () => undefined, { timeoutMs: 25 }),
      /WORKSET_MUTATION_LOCKED/,
    );
    assert.deepEqual(await readTestLockOwner(lockPath), unknown);
  } finally {
    await fixture.cleanup();
  }
});

test('malformed or multiple canonical owner children fail closed', async (context) => {
  await context.test('malformed child', async () => {
    const fixture = await createTestDirectory('omnai-lock-malformed-');
    const lockPath = worksetMutationLockPath(fixture.root, WORKSET_ID);
    try {
      await mkdir(lockPath, { recursive: true });
      await writeFile(join(lockPath, 'garbage.json'), '{}', 'utf8');
      await assert.rejects(
        () => withWorksetMutationLock(fixture.root, WORKSET_ID, async () => undefined, { timeoutMs: 25 }),
        /WORKSET_MUTATION_LOCKED/,
      );
      assert.deepEqual(await readdir(lockPath), ['garbage.json']);
    } finally {
      await fixture.cleanup();
    }
  });

  await context.test('multiple children', async () => {
    const fixture = await createTestDirectory('omnai-lock-multiple-');
    const lockPath = worksetMutationLockPath(fixture.root, WORKSET_ID);
    try {
      await writeTestLockOwner(lockPath, { token: 'owner-one', pid: process.pid, acquiredAt: NOW });
      await writeTestLockOwner(lockPath, { token: 'owner-two', pid: process.pid, acquiredAt: NOW });
      await assert.rejects(
        () => withWorksetMutationLock(fixture.root, WORKSET_ID, async () => undefined, { timeoutMs: 25 }),
        /WORKSET_MUTATION_LOCKED/,
      );
      assert.equal((await readdir(lockPath)).length, 2);
    } finally {
      await fixture.cleanup();
    }
  });
});

test('bounded dispatch never exceeds configured concurrency and preserves input order', async () => {
  const backend = new LocalExecutionBackend();
  let active = 0;
  let peak = 0;
  const result = await backend.runBounded([1, 2, 3, 4], 2, async (item: number) => {
    active += 1;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active -= 1;
    return item * 10;
  });

  assert.equal(peak, 2);
  assert.deepEqual(result, [
    { status: 'fulfilled', value: 10 },
    { status: 'fulfilled', value: 20 },
    { status: 'fulfilled', value: 30 },
    { status: 'fulfilled', value: 40 },
  ]);
  await assert.rejects(() => backend.runBounded([1], 0, async (item: number) => item), /INVALID_CONCURRENCY_LIMIT/);
});

test('the local backend delegates transitions and repair to the durable store', async () => {
  const fixture = await createExecutionFixture();
  try {
    const backend = new LocalExecutionBackend(fixture.store);
    const state = await backend.transition({ ...fixture.baseRequest, event: { type: 'START' } });
    assert.equal(state.status, 'RUNNING');
    assert.equal((await fixture.events()).length, 1);
    await unlink(fixture.baseRequest.statePath);
    assert.equal((await backend.loadAndRepair(fixture.baseRequest)).status, 'RUNNING');
  } finally {
    await fixture.cleanup();
  }
});

test('waitUntil is wakeable in-process and abortable', async () => {
  const backend = new LocalExecutionBackend();
  let woke = false;
  const waiting = backend.waitUntil(Date.now() + 1_000).then(() => { woke = true; });
  await Promise.resolve();
  assert.equal(woke, false);
  backend.wake(WORKSET_ID);
  await waiting;
  assert.equal(woke, true);

  const controller = new AbortController();
  const aborted = backend.waitUntil(Date.now() + 1_000, controller.signal);
  controller.abort();
  await assert.rejects(aborted, (error: unknown) => error instanceof Error && error.name === 'AbortError');

  await backend.waitUntil(Date.now() - 1);
});
