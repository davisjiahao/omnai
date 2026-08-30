import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import fs from 'node:fs';
import { cp, rename, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { ZodError } from 'zod';
import {
  applyFlowAssessment,
  type FlowAssessmentMutationRequestV1,
} from '../flow-assessment.js';
import type { SourceLocator } from '../source/types.js';
import {
  parseBaselineId,
  parseChangeId,
  parseDecisionId,
  parseRevisionId,
} from '../../domain/scalars.js';
import { flowAssessmentProposalSchema } from '../../domain/change.js';
import { changeArtifactPathSchema } from '../../domain/public.js';
import { task5Fixture } from './task5-fixture.js';
import {
  createFlowAssessmentTransaction,
  writeFlowAssessmentTransaction,
} from '../flow-transaction.js';
import { withChangeMutationLock } from '../change-mutation-lock.js';
import {
  semanticMutationTransactionSchema,
  writeSemanticMutationTransaction,
} from '../semantic-mutation-journal.js';
import { sourceReboundFlowRequest } from '../flow-semantic-mutation.js';

test('Flow assessment resolves locator authority and accepts the exact active Decision closure', async (t) => {
  const fixture = await task5Fixture(
    t,
    'task5-flow-linkage-positive-',
    ['OPEN', 'BLOCKED', 'RESOLVED'],
  );
  const request = exactRequest(['DEC-0001', 'DEC-0002']);

  const result = await applyFlowAssessment(fixture.repoRoot, fixture.change, request);

  assert.deepEqual(result.flow.assessment, fixture.flow.assessment);
  assert.equal(result.reconcile, null);
});

test('Flow retains the builder-authenticated Change root through source sealing', { concurrency: false }, async (t) => {
  const fixture = await task5Fixture(t, 'task5-flow-root-race-');
  const replacement = join(fixture.repoRoot, 'replacement-flow-root');
  const displaced = join(fixture.repoRoot, 'displaced-flow-root');
  await cp(fixture.changeRoot, replacement, { recursive: true });
  await writeFile(join(replacement, 'domain.md'), 'replacement Flow artifact\n');

  const originalOpen = fs.promises.open;
  let wrapped = false;
  let attacked = false;
  fs.promises.open = async function patchedOpen(this: typeof fs.promises, path, flags, ...rest) {
    const handle = await originalOpen.call(this, path, flags, ...rest);
    if (!wrapped && String(path) === fixture.changeRoot) {
      wrapped = true;
      const originalClose = handle.close.bind(handle);
      handle.close = async (): Promise<void> => {
        await originalClose();
        attacked = true;
        await rename(fixture.changeRoot, displaced);
        await rename(replacement, fixture.changeRoot);
      };
    }
    return handle;
  } as typeof fs.promises.open;
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      applyFlowAssessment(fixture.repoRoot, fixture.change, exactRequest(['DEC-0001'])),
      /AUTHORITY_IO_RACE|AUTHORITY_IO_CONTAINMENT/,
    );
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
  }
  assert.equal(wrapped, true);
  assert.equal(attacked, true);
});

test('Flow assessment rejects missing, extra, closed, unknown, and locator-mismatched Decisions uniformly', async (t) => {
  const fixture = await task5Fixture(
    t,
    'task5-flow-linkage-negative-',
    ['OPEN', 'BLOCKED', 'RESOLVED'],
  );
  const rows: ReadonlyArray<Readonly<{
    name: string;
    decisionIds: readonly string[];
    locatorIds: readonly string[];
  }>> = [
    { name: 'missing', decisionIds: ['DEC-0001'], locatorIds: ['DEC-0001'] },
    {
      name: 'extra unknown',
      decisionIds: ['DEC-0001', 'DEC-0002', 'DEC-9999'],
      locatorIds: ['DEC-0001', 'DEC-0002', 'DEC-9999'],
    },
    {
      name: 'closed',
      decisionIds: ['DEC-0001', 'DEC-0002', 'DEC-0003'],
      locatorIds: ['DEC-0001', 'DEC-0002', 'DEC-0003'],
    },
    {
      name: 'locator mismatch',
      decisionIds: ['DEC-0001', 'DEC-0002'],
      locatorIds: ['DEC-0001'],
    },
  ];

  for (const row of rows) {
    await assert.rejects(
      applyFlowAssessment(
        fixture.repoRoot,
        fixture.change,
        exactRequest(row.decisionIds, row.locatorIds),
      ),
      /FLOW_ASSESSMENT_DECISION_LINKAGE_MISMATCH/,
      row.name,
    );
  }
});

test('Flow mutation input has no caller-hash authority path', async (t) => {
  const fixture = await task5Fixture(t, 'task5-flow-caller-hash-', ['OPEN']);
  const request = exactRequest(['DEC-0001']);
  const forged = {
    ...request,
    sources: request.sources.map((source) => ({
      ...source,
      contentHash: `sha256:${'f'.repeat(64)}`,
    })),
  };

  await assert.rejects(
    applyFlowAssessment(fixture.repoRoot, fixture.change, forged as FlowAssessmentMutationRequestV1),
    /FLOW_ASSESSMENT_REQUEST_INVALID/,
  );

  const staleDecisionProposal = flowAssessmentProposalSchema.parse({
    schemaVersion: 2,
    changeId: fixture.metadata.id,
    revision: fixture.metadata.activeRevision,
    baseline: fixture.metadata.baseline,
    assessment: {
      ...fixture.flow.assessment,
      sourceRefs: fixture.flow.assessment.sourceRefs.map((sourceRef) => (
        sourceRef.kind === 'decision'
          ? { ...sourceRef, contentHash: `sha256:${'0'.repeat(64)}` }
          : sourceRef
      )),
    },
  });
  await assert.rejects(
    applyFlowAssessment(
      fixture.repoRoot,
      fixture.change,
      staleDecisionProposal as unknown as FlowAssessmentMutationRequestV1,
    ),
    /FLOW_ASSESSMENT_REQUEST_INVALID/,
  );
});

test('Flow request Change identity cannot be applied through a differently bound Change handle', async (t) => {
  const fixture = await task5Fixture(t, 'task5-flow-change-binding-', ['OPEN']);
  const wrongChange = {
    ...fixture.change,
    metadata: { ...fixture.metadata, id: parseChangeId('CHG-0002') },
  };

  await assert.rejects(
    applyFlowAssessment(fixture.repoRoot, wrongChange, exactRequest(['DEC-0001'])),
    /FLOW_CHANGE_REF_INVALID/,
  );
});

test('Flow hostile ChangeRef and repository spelling fail before lock allocation', { concurrency: false }, async (t) => {
  const fixture = await task5Fixture(t, 'task5-flow-hostile-change-ref-', ['OPEN']);
  const originalMkdir = fs.promises.mkdir;
  let lockAllocations = 0;
  fs.promises.mkdir = async function patchedMkdir(this: typeof fs.promises, path, ...rest) {
    if (String(path).includes('.core-mutation.lock')) lockAllocations += 1;
    return originalMkdir.call(this, path, ...rest);
  } as typeof fs.promises.mkdir;
  syncBuiltinESMExports();
  try {
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, 'directoryName', {
      enumerable: true,
      get(): never { throw new Error('TASK5_CHANGE_REF_ACCESSOR_EXECUTED'); },
    });
    Object.defineProperty(accessor, 'metadata', {
      enumerable: true,
      value: fixture.metadata,
    });
    const rows: readonly Readonly<{ repoRoot: string; change: unknown }>[] = [
      {
        repoRoot: fixture.repoRoot,
        change: new Proxy(fixture.change, {
          get(): never { throw new Error('TASK5_CHANGE_REF_PROXY_EXECUTED'); },
        }),
      },
      { repoRoot: fixture.repoRoot, change: accessor },
      { repoRoot: fixture.repoRoot, change: { ...fixture.change, extra: true } },
      {
        repoRoot: fixture.repoRoot,
        change: { ...fixture.change, directoryName: 'CHG-0001-wrong-slug' },
      },
      {
        repoRoot: fixture.repoRoot,
        change: { ...fixture.change, directoryName: '../../task5-escaped-change' },
      },
      { repoRoot: `${fixture.repoRoot}/.`, change: fixture.change },
    ];
    for (let index = 0; index < rows.length; index += 1) {
      await assert.rejects(
        applyFlowAssessment(
          rows[index]!.repoRoot,
          rows[index]!.change as typeof fixture.change,
          exactRequest(['DEC-0001']),
        ),
        /FLOW_CHANGE_REF_INVALID|FLOW_REPOSITORY_ROOT_INVALID/,
      );
    }
  } finally {
    fs.promises.mkdir = originalMkdir;
    syncBuiltinESMExports();
  }
  assert.equal(lockAllocations, 0);
});

test('Flow snapshots the canonical ChangeRef before the first await', async (t) => {
  const fixture = await task5Fixture(t, 'task5-flow-change-ref-snapshot-', ['OPEN']);
  const frozenProposal = flowAssessmentProposalSchema.parse({
    schemaVersion: 2,
    changeId: fixture.metadata.id,
    revision: fixture.metadata.activeRevision,
    baseline: fixture.metadata.baseline,
    assessment: { ...fixture.flow.assessment, scale: 'CHANGE' },
  });
  await writeFlowAssessmentTransaction(
    fixture.repoRoot,
    fixture.change,
    createFlowAssessmentTransaction(
      frozenProposal,
      fixture.flow,
      fixture.decisions,
      'FLOW-task5-change-ref-snapshot',
      '2026-08-27T00:02:30.000Z',
    ),
  );
  const mutable = {
    directoryName: fixture.change.directoryName,
    metadata: fixture.metadata,
  };

  const request = exactRequest(['DEC-0001']);
  const resultPromise = applyFlowAssessment(
    fixture.repoRoot,
    mutable,
    { ...request, assessment: { ...request.assessment, scale: 'CHANGE' } },
  );
  mutable.directoryName = 'CHG-9999-mutated-after-call';
  mutable.metadata = { ...fixture.metadata, id: parseChangeId('CHG-9999') };

  await assert.rejects(resultPromise, (error: unknown) => {
    assert.ok(error instanceof ZodError);
    assert.deepEqual(error.issues[0]?.path, ['signalType']);
    return true;
  });
});

test('every locator is bound to the top-level request before PENDING or lock lookup', { concurrency: false }, async (t) => {
  const fixture = await task5Fixture(t, 'task5-flow-locator-request-binding-', ['OPEN']);
  const transaction = createFlowAssessmentTransaction(
    flowAssessmentProposalSchema.parse({
      schemaVersion: 2,
      changeId: fixture.metadata.id,
      revision: fixture.metadata.activeRevision,
      baseline: fixture.metadata.baseline,
      assessment: fixture.flow.assessment,
    }),
    fixture.flow,
    fixture.decisions,
    'FLOW-task5-locator-binding',
    '2026-08-27T00:03:00.000Z',
  );
  await writeFlowAssessmentTransaction(fixture.repoRoot, fixture.change, transaction);

  const originalMkdir = fs.promises.mkdir;
  let lockAllocations = 0;
  fs.promises.mkdir = async function patchedMkdir(this: typeof fs.promises, path, ...rest) {
    if (String(path).includes('.core-mutation.lock')) lockAllocations += 1;
    return originalMkdir.call(this, path, ...rest);
  } as typeof fs.promises.mkdir;
  syncBuiltinESMExports();
  try {
    const request = exactRequest(['DEC-0001']);
    for (const source of [
      { ...request.sources[0]!, changeId: parseChangeId('CHG-0002') },
      { ...request.sources[0]!, revisionId: parseRevisionId('REV-0002') },
    ]) {
      await assert.rejects(
        applyFlowAssessment(fixture.repoRoot, fixture.change, { ...request, sources: [source] }),
        /FLOW_ASSESSMENT_REQUEST_INVALID/,
      );
    }
  } finally {
    fs.promises.mkdir = originalMkdir;
    syncBuiltinESMExports();
  }
  assert.equal(lockAllocations, 0);
});

test('stale top-level revision and baseline cannot pass through candidate no-op', async (t) => {
  const fixture = await task5Fixture(t, 'task5-flow-stale-noop-', ['RESOLVED']);
  const request = exactRequest([]);

  await assert.rejects(
    applyFlowAssessment(fixture.repoRoot, fixture.change, {
      ...request,
      revision: parseRevisionId('REV-0002'),
    }),
    /FLOW_STALE_REVISION/,
  );
  await assert.rejects(
    applyFlowAssessment(fixture.repoRoot, fixture.change, {
      ...request,
      baseline: parseBaselineId('BL-0002'),
    }),
    /FLOW_STALE_BASELINE/,
  );
});

test('candidate no-op still observes an existing mismatched semantic PENDING preflight', async (t) => {
  const fixture = await task5Fixture(t, 'task5-flow-semantic-pending-noop-', ['RESOLVED']);
  const request = exactRequest([]);
  const conflictingProposal = flowAssessmentProposalSchema.parse({
    schemaVersion: 2,
    changeId: request.changeId,
    revision: request.revision,
    baseline: request.baseline,
    assessment: { ...fixture.flow.assessment, scale: 'CHANGE' },
  });
  await writeSemanticMutationTransaction(
    fixture.repoRoot,
    fixture.change,
    semanticMutationTransactionSchema.parse({
      schemaVersion: 1,
      status: 'PENDING',
      id: 'MUT-000001',
      sequence: 1,
      kind: 'FLOW',
      changeId: fixture.metadata.id,
      revision: fixture.metadata.activeRevision,
      baseline: fixture.metadata.baseline,
      createdAt: '2026-08-27T00:04:00.000Z',
      request: sourceReboundFlowRequest(conflictingProposal),
      sourceMetadata: fixture.metadata,
      targetMetadata: fixture.metadata,
      decisions: fixture.decisions,
      sourceFlow: fixture.flow,
      targetFlow: fixture.flow,
      audits: [],
    }),
  );

  await assert.rejects(
    applyFlowAssessment(fixture.repoRoot, fixture.change, request),
    /SEMANTIC_MUTATION_PENDING_REQUEST_MISMATCH/,
  );
});

test('PENDING identity branches before current source reads and exact retry reaches the downstream writer gate', { concurrency: false }, async (t) => {
  const fixture = await task5Fixture(t, 'task5-flow-pending-', ['OPEN']);
  const frozenArtifactHash = `sha256:${createHash('sha256').update('real artifact bytes\n').digest('hex')}`;
  const frozenProposal = flowAssessmentProposalSchema.parse({
    schemaVersion: 2 as const,
    changeId: fixture.metadata.id,
    revision: fixture.metadata.activeRevision,
    baseline: fixture.metadata.baseline,
    assessment: {
      ...fixture.flow.assessment,
      scale: 'CHANGE' as const,
      sourceRefs: [
        { kind: 'artifact' as const, path: 'domain.md' as const, contentHash: frozenArtifactHash },
        ...fixture.flow.assessment.sourceRefs,
      ],
    },
  });
  const transaction = createFlowAssessmentTransaction(
    frozenProposal,
    fixture.flow,
    fixture.decisions,
    'FLOW-task5-frozen-retry',
    '2026-08-27T00:01:00.000Z',
  );
  await writeFlowAssessmentTransaction(fixture.repoRoot, fixture.change, transaction);
  await writeFile(join(fixture.changeRoot, 'domain.md'), 'edited after pending\n');

  const request = exactRequest(['DEC-0001']);
  const retry: FlowAssessmentMutationRequestV1 = {
    ...request,
    assessment: { ...request.assessment, scale: 'CHANGE' },
    sources: [
      {
        changeId: request.changeId,
        revisionId: request.revision,
        kind: 'artifact',
        path: changeArtifactPathSchema.parse('domain.md'),
      },
      ...request.sources,
    ],
  };
  const originalOpen = fs.promises.open;
  const originalMap = Array.prototype.map;
  const originalStringify = JSON.stringify;
  let currentSourceOpens = 0;
  let liveMapCalls = 0;
  let liveStringifyCalls = 0;
  const observedStages: string[] = [];
  const mutationChannel = channel('omnai:core:change-mutation');
  const listener = (message: unknown): void => {
    if (message !== null && typeof message === 'object'
      && 'correlationId' in message
      && message.correlationId === transaction.correlationId
      && 'stage' in message
      && typeof message.stage === 'string') {
      observedStages.push(message.stage);
    }
  };
  mutationChannel.subscribe(listener);
  Array.prototype.map = function poisonedMap(
    this: unknown[],
    callback: (value: unknown, index: number, array: unknown[]) => unknown,
    thisArg?: unknown,
  ): unknown[] {
    if (callback.name === 'sourceRefLogicalKey') {
      liveMapCalls += 1;
      throw new Error('TASK5_LIVE_MAP_POISON');
    }
    return Reflect.apply(originalMap, this, [callback, thisArg]) as unknown[];
  } as typeof Array.prototype.map;
  JSON.stringify = function poisonedStringify(value: unknown, ...rest: unknown[]): string | undefined {
    if (value !== null && typeof value === 'object' && 'scale' in value && 'uncertainty' in value) {
      liveStringifyCalls += 1;
      throw new Error('TASK5_LIVE_JSON_STRINGIFY_POISON');
    }
    return Reflect.apply(originalStringify, JSON, [value, ...rest]) as string | undefined;
  } as typeof JSON.stringify;
  fs.promises.open = async function patchedOpen(this: typeof fs.promises, path, flags, ...rest) {
    if (String(path).endsWith('/domain.md')) currentSourceOpens += 1;
    return originalOpen.call(this, path, flags, ...rest);
  } as typeof fs.promises.open;
  syncBuiltinESMExports();
  try {
    const nonExact: FlowAssessmentMutationRequestV1 = {
      ...retry,
      sources: request.sources,
    };
    await assert.rejects(
      applyFlowAssessment(fixture.repoRoot, fixture.change, nonExact),
      /FLOW_TRANSACTION_PENDING/,
    );
    assert.equal(currentSourceOpens, 0);

    await assert.rejects(
      applyFlowAssessment(fixture.repoRoot, fixture.change, retry),
      (error: unknown) => {
        assert.ok(error instanceof ZodError);
        assert.deepEqual(error.issues.map(({ code, path }) => ({ code, path })), [
          { code: 'invalid_type', path: ['signalType'] },
          { code: 'invalid_type', path: ['taskRoots'] },
          { code: 'invalid_type', path: ['evidenceIds'] },
          { code: 'invalid_type', path: ['operationRequestId'] },
          { code: 'unrecognized_keys', path: [] },
        ]);
        return true;
      },
    );
  } finally {
    fs.promises.open = originalOpen;
    Array.prototype.map = originalMap;
    JSON.stringify = originalStringify;
    mutationChannel.unsubscribe(listener);
    syncBuiltinESMExports();
  }
  assert.equal(currentSourceOpens, 0);
  assert.equal(liveMapCalls, 0);
  assert.equal(liveStringifyCalls, 0);
  assert.deepEqual(observedStages, ['FLOW_RECONCILE_ARCHIVE_ENSURED']);
  assert.equal(observedStages.includes('FLOW_RECONCILE_SIGNAL_WRITTEN'), false);
  assert.equal(observedStages.includes('FLOW_RECONCILE_REVISION_WRITTEN'), false);
  assert.equal(observedStages.includes('FLOW_RECONCILE_METADATA_SAVED'), false);
  assert.equal(observedStages.includes('FLOW_RECONCILE_REBOUND'), false);
  assert.equal(observedStages.includes('FLOW_REASSESSED_AUDITED'), false);
});

test('source await cannot expose Flow authentication to live map, push, or find replacements', { concurrency: false }, async (t) => {
  const fixture = await task5Fixture(t, 'task5-flow-intrinsic-poison-', ['OPEN']);
  const originalOpen = fs.promises.open;
  const originalMap = Array.prototype.map;
  const originalPush = Array.prototype.push;
  const originalFind = Array.prototype.find;
  const OriginalMap = Map;
  const OriginalSet = Set;
  const originalMapGet = Map.prototype.get;
  const originalMapSet = Map.prototype.set;
  const originalMapHas = Map.prototype.has;
  const originalMapValues = Map.prototype.values;
  const originalMapIterator = Map.prototype[Symbol.iterator];
  const originalSetAdd = Set.prototype.add;
  const originalSetHas = Set.prototype.has;
  const originalSetIterator = Set.prototype[Symbol.iterator];
  const originalSetSize = Object.getOwnPropertyDescriptor(Set.prototype, 'size')!;
  let poisonInstalled = false;
  let liveMapCalls = 0;
  let livePushCalls = 0;
  let liveFindCalls = 0;
  let liveMapSetCalls = 0;
  let liveMapIteratorCalls = 0;
  let liveSetCalls = 0;

  const flowToken = (value: unknown): boolean => typeof value === 'string'
    && (value.startsWith('DEC-')
      || value.includes('\u0000DEC-')
      || ['frame', 'model', 'research', 'spec'].includes(value));
  const flowSetReceiver = (set: Set<unknown>): boolean => {
    const size = Reflect.apply(originalSetSize.get!, set, []) as number;
    return size < 20 && (Reflect.apply(originalSetHas, set, ['frame'])
      || Reflect.apply(originalSetHas, set, ['model']));
  };

  const installPoison = (): void => {
    if (poisonInstalled) return;
    poisonInstalled = true;
    Array.prototype.map = function poisonedMap(
      this: unknown[],
      callback: (value: unknown, index: number, array: unknown[]) => unknown,
      thisArg?: unknown,
    ): unknown[] {
      const first = this[0];
      if (callback.name === 'sourceRefLogicalKey'
        || (this.length === 24 && typeof first === 'string')) {
        liveMapCalls += 1;
        throw new Error('TASK5_LIVE_MAP_POISON');
      }
      return Reflect.apply(originalMap, this, [callback, thisArg]) as unknown[];
    } as typeof Array.prototype.map;
    Array.prototype.push = function poisonedPush(this: unknown[], ...values: unknown[]): number {
      for (let index = 0; index < values.length; index += 1) {
        const value = values[index];
        if (value !== null && typeof value === 'object' && Object.isFrozen(value)
          && 'kind' in value && value.kind === 'decision' && 'contentHash' in value) {
          livePushCalls += 1;
          throw new Error('TASK5_LIVE_PUSH_POISON');
        }
      }
      return Reflect.apply(originalPush, this, values) as number;
    } as typeof Array.prototype.push;
    Array.prototype.find = function poisonedFind(
      this: unknown[],
      callback: (value: unknown, index: number, array: unknown[]) => unknown,
      thisArg?: unknown,
    ): unknown {
      const first = this[0];
      if (first !== null && typeof first === 'object'
        && 'schemaVersion' in first && first.schemaVersion === 1
        && 'requiredArtifacts' in first) {
        liveFindCalls += 1;
        throw new Error('TASK5_LIVE_FIND_POISON');
      }
      return Reflect.apply(originalFind, this, [callback, thisArg]);
    } as typeof Array.prototype.find;
    class PoisonedMap<K, V> extends OriginalMap<K, V> {
      constructor(iterable?: Iterable<readonly [K, V]> | null) {
        super(iterable);
        if (Array.isArray(iterable) && Array.isArray(iterable[0]) && flowToken(iterable[0][0])) {
          liveMapSetCalls += 1;
        }
      }
    }
    class PoisonedSet<T> extends OriginalSet<T> {
      constructor(iterable?: Iterable<T> | null) {
        super(iterable);
        if (Array.isArray(iterable) && iterable.length > 0 && flowToken(iterable[0])) {
          liveSetCalls += 1;
        }
      }
    }
    globalThis.Map = PoisonedMap as MapConstructor;
    globalThis.Set = PoisonedSet as SetConstructor;
    OriginalMap.prototype.get = function poisonedMapGet<K, V>(this: Map<K, V>, key: K): V | undefined {
      if (flowToken(key)) liveMapSetCalls += 1;
      return Reflect.apply(originalMapGet, this, [key]) as V | undefined;
    };
    OriginalMap.prototype.set = function poisonedMapSet<K, V>(this: Map<K, V>, key: K, value: V): Map<K, V> {
      if (flowToken(key)) liveMapSetCalls += 1;
      return Reflect.apply(originalMapSet, this, [key, value]) as Map<K, V>;
    };
    OriginalMap.prototype.has = function poisonedMapHas<K, V>(this: Map<K, V>, key: K): boolean {
      if (flowToken(key)) liveMapSetCalls += 1;
      return Reflect.apply(originalMapHas, this, [key]) as boolean;
    };
    OriginalMap.prototype.values = function poisonedMapValues<K, V>(this: Map<K, V>): MapIterator<V> {
      if (Reflect.apply(originalMapHas, this, ['frame'])) liveMapIteratorCalls += 1;
      return Reflect.apply(originalMapValues, this, []) as MapIterator<V>;
    };
    OriginalMap.prototype[Symbol.iterator] = function poisonedMapIterator<K, V>(
      this: Map<K, V>,
    ): MapIterator<[K, V]> {
      if (Reflect.apply(originalMapHas, this, ['frame'])) liveMapIteratorCalls += 1;
      return Reflect.apply(originalMapIterator, this, []) as MapIterator<[K, V]>;
    };
    OriginalSet.prototype.add = function poisonedSetAdd<T>(this: Set<T>, value: T): Set<T> {
      const result = Reflect.apply(originalSetAdd, this, [value]) as Set<T>;
      if (flowToken(value) && flowSetReceiver(this)) {
        liveSetCalls += 1;
      }
      return result;
    };
    OriginalSet.prototype.has = function poisonedSetHas<T>(this: Set<T>, value: T): boolean {
      if (flowToken(value) && flowSetReceiver(this)) {
        liveSetCalls += 1;
      }
      return Reflect.apply(originalSetHas, this, [value]) as boolean;
    };
    OriginalSet.prototype[Symbol.iterator] = function poisonedSetIterator<T>(this: Set<T>): SetIterator<T> {
      if (flowSetReceiver(this)) liveMapIteratorCalls += 1;
      return Reflect.apply(originalSetIterator, this, []) as SetIterator<T>;
    };
    Object.defineProperty(OriginalSet.prototype, 'size', {
      configurable: true,
      get(this: Set<unknown>): number {
        if (flowSetReceiver(this)) liveSetCalls += 1;
        return Reflect.apply(originalSetSize.get!, this, []) as number;
      },
    });
  };

  fs.promises.open = async function patchedOpen(this: typeof fs.promises, path, flags, ...rest) {
    const handle = await originalOpen.call(this, path, flags, ...rest);
    if (String(path).endsWith('/workflow.lock.yaml')) installPoison();
    return handle;
  } as typeof fs.promises.open;
  syncBuiltinESMExports();
  try {
    const result = await applyFlowAssessment(
      fixture.repoRoot,
      fixture.change,
      exactRequest(['DEC-0001']),
    );
    assert.equal(result.reconcile, null);
    assert.equal(result.flow.inputHash, fixture.flow.inputHash);
  } finally {
    fs.promises.open = originalOpen;
    Array.prototype.map = originalMap;
    Array.prototype.push = originalPush;
    Array.prototype.find = originalFind;
    globalThis.Map = OriginalMap;
    globalThis.Set = OriginalSet;
    OriginalMap.prototype.get = originalMapGet;
    OriginalMap.prototype.set = originalMapSet;
    OriginalMap.prototype.has = originalMapHas;
    OriginalMap.prototype.values = originalMapValues;
    OriginalMap.prototype[Symbol.iterator] = originalMapIterator;
    OriginalSet.prototype.add = originalSetAdd;
    OriginalSet.prototype.has = originalSetHas;
    OriginalSet.prototype[Symbol.iterator] = originalSetIterator;
    Object.defineProperty(OriginalSet.prototype, 'size', originalSetSize);
    syncBuiltinESMExports();
  }
  assert.equal(poisonInstalled, true);
  assert.equal(liveMapCalls, 0);
  assert.equal(livePushCalls, 0);
  assert.equal(liveFindCalls, 0);
  assert.equal(liveMapSetCalls, 0);
  assert.equal(liveMapIteratorCalls, 0);
  assert.equal(liveSetCalls, 0);
});

test('a concurrent writer cannot publish PENDING between the retry branch and current capture', { concurrency: false }, async (t) => {
  const fixture = await task5Fixture(t, 'task5-flow-pending-race-', ['OPEN']);
  const frozenProposal = flowAssessmentProposalSchema.parse({
    schemaVersion: 2,
    changeId: fixture.metadata.id,
    revision: fixture.metadata.activeRevision,
    baseline: fixture.metadata.baseline,
    assessment: { ...fixture.flow.assessment, scale: 'CHANGE' },
  });
  const transaction = createFlowAssessmentTransaction(
    frozenProposal,
    fixture.flow,
    fixture.decisions,
    'FLOW-task5-concurrent-pending',
    '2026-08-27T00:02:00.000Z',
  );

  let writerEnteredResolve!: () => void;
  const writerEntered = new Promise<void>((resolve) => { writerEnteredResolve = resolve; });
  let raceReachedResolve!: () => void;
  const raceReached = new Promise<void>((resolve) => { raceReachedResolve = resolve; });
  const writer = withChangeMutationLock(fixture.repoRoot, fixture.change, async () => {
    writerEnteredResolve();
    await raceReached;
    await writeFlowAssessmentTransaction(fixture.repoRoot, fixture.change, transaction);
  });
  await writerEntered;

  const originalOpen = fs.promises.open;
  const originalLstat = fs.promises.lstat;
  let currentSourceOpens = 0;
  let raceReachedOnce = false;
  const signalRace = (): void => {
    if (raceReachedOnce) return;
    raceReachedOnce = true;
    raceReachedResolve();
  };
  fs.promises.open = async function patchedOpen(this: typeof fs.promises, path, flags, ...rest) {
    if (String(path).endsWith('/domain.md')) {
      currentSourceOpens += 1;
      signalRace();
    }
    return originalOpen.call(this, path, flags, ...rest);
  } as typeof fs.promises.open;
  fs.promises.lstat = async function patchedLstat(this: typeof fs.promises, path, ...rest) {
    if (String(path).endsWith('/.core-mutation.lock')) signalRace();
    return originalLstat.call(this, path, ...rest);
  } as typeof fs.promises.lstat;
  syncBuiltinESMExports();
  try {
    const baseRequest = exactRequest(['DEC-0001']);
    const racingRequest: FlowAssessmentMutationRequestV1 = {
      ...baseRequest,
      sources: [
        {
          changeId: baseRequest.changeId,
          revisionId: baseRequest.revision,
          kind: 'artifact',
          path: changeArtifactPathSchema.parse('domain.md'),
        },
        ...baseRequest.sources,
      ],
    };
    await assert.rejects(
      applyFlowAssessment(fixture.repoRoot, fixture.change, racingRequest),
      /FLOW_TRANSACTION_PENDING/,
    );
    await writer;
  } finally {
    signalRace();
    await writer.catch(() => undefined);
    fs.promises.open = originalOpen;
    fs.promises.lstat = originalLstat;
    syncBuiltinESMExports();
  }
  assert.equal(raceReachedOnce, true);
  assert.equal(currentSourceOpens, 0);
});

function exactRequest(
  decisionIds: readonly string[],
  locatorIds: readonly string[] = decisionIds,
): FlowAssessmentMutationRequestV1 {
  const sources = locatorIds.map((decisionId): SourceLocator => ({
    changeId: parseChangeId('CHG-0001'),
    revisionId: parseRevisionId('REV-0001'),
    kind: 'decision',
    decisionId: parseDecisionId(decisionId),
  }));
  return {
    schemaVersion: 1,
    changeId: parseChangeId('CHG-0001'),
    revision: parseRevisionId('REV-0001'),
    baseline: parseBaselineId('BL-0001'),
    assessment: {
      scale: 'LOCAL',
      uncertainty: { problem: 'CLEAR', domain: 'CLEAR', solution: 'CLEAR', delivery: 'CLEAR' },
      topology: 'SINGLE_MODULE',
      architectureApplicability: 'NOT_APPLICABLE',
      deliveryShape: 'STANDARD',
      decisionIds: decisionIds.map(parseDecisionId),
    },
    sources,
  };
}
