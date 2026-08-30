import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import {
  clearInjectedAuthorityCatalogForTest,
  loadInjectedAuthorityCatalogForTest,
  type AuthorityCatalogTestLease,
} from '../../../authority/catalog-loader.js';
import { hashStrictObject, stageAuthorityCatalogV1Schema } from '../../../authority/catalog-schema.js';
import {
  changeMetadataSchema,
  decisionRecordSchema,
} from '../../../domain/change.js';
import {
  normalizedAbsoluteRealPathSchema,
} from '../../../domain/public.js';
import {
  parseChangeId,
  parseDecisionId,
  parseEvidenceId,
  parseRevisionId,
} from '../../../domain/scalars.js';
import {
  buildBaseContext,
} from '../context-builder.js';
import {
  sealForInspection,
  sealForNewMutation,
  type BaseContextHandleV1,
} from '../context.js';
import type { SourceCaptureSession } from '../../source/types.js';
import { resolveCurrentSource } from '../../source/resolver.js';
import {
  assertCompletedSemanticMutationInventory,
  buildAuthorityIndexes,
} from '../indexes.js';

const SHA_A = `sha256:${'a'.repeat(64)}`;
const SHA_B = `sha256:${'b'.repeat(64)}`;
const TIMESTAMP = '2026-08-27T00:00:00.000Z';

test('builder rejects a Proxy request before traps or fixed-loader I/O', async () => {
  let traps = 0;
  const request = new Proxy({
    expectedChangeId: parseChangeId('CHG-0001'),
    containedRoot: normalizedAbsoluteRealPathSchema.parse('/tmp'),
    logicalTargets: [],
    archiveTargets: [],
    knownAuxiliaryTargets: [],
  }, {
    get(target, key, receiver) {
      traps += 1;
      return Reflect.get(target, key, receiver);
    },
    ownKeys(target) {
      traps += 1;
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      traps += 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  await assert.rejects(buildBaseContext(request), /AUTHORITY_CONTEXT_REQUEST_INVALID/);
  assert.equal(traps, 0);
});

test('context runtime surface does not expose a direct authenticated-base mint', async () => {
  // 回归说明：若再次导出可把 caller state 登记进 WeakMap 的 mint，本测试会在真实 ESM surface 上失败。
  const contextModule: Record<string, unknown> = await import('../context.js');
  const builderModule: Record<string, unknown> = await import('../context-builder.js');
  assert.equal(contextModule.createAuthenticatedBaseContextHandle, undefined);
  assert.equal(builderModule.createAuthenticatedBaseContextHandle, undefined);
  assert.equal(builderModule.consumeAuthenticatedBaseContextHandle, undefined);
});

test('context consumes an unforgeable base once and every SEALED getter is read-once memory', async (t) => {
  const fixture = await contextFixture(t, 'authority-context-read-once-');
  const base = await buildBaseContext(fixture.request);

  await assert.rejects(
    sealForInspection({ ...base } as BaseContextHandleV1),
    /AUTHORITY_CONTEXT_BASE_INVALID/,
  );
  await assert.rejects(
    sealForInspection(Object.freeze({ phase: 'BASE_AUTHENTICATED' }) as BaseContextHandleV1),
    /AUTHORITY_CONTEXT_BASE_INVALID/,
  );
  const context = await sealForInspection(base);
  const sealedCounters = context.observedIo;
  assert.deepEqual([...sealedCounters.fileOpens], [
    ['workflow.lock.yaml', 1],
    ['archive/REV-0001.change.yaml', 1],
    ['change.yaml', 1],
    ['decisions/DEC-0001.yaml', 1],
    ['evidence/EVD-000001.yaml', 1],
  ]);
  assert.deepEqual([...sealedCounters.stableCaptures], [...sealedCounters.fileOpens]);
  assert.deepEqual([...sealedCounters.directoryReads], [
    ['archive', 1],
    ['decisions', 1],
    ['evidence', 1],
  ]);
  const decision = context.requireDecision(parseDecisionId('DEC-0001'));
  const evidence = context.requireEvidence(parseEvidenceId('EVD-000001'));
  const archive = context.requireArchive(parseRevisionId('REV-0001'), { kind: 'METADATA' });

  await writeFile(join(fixture.root, 'decisions', 'DEC-0001.yaml'), 'attacker: true\n');
  await unlink(join(fixture.root, 'evidence', 'EVD-000001.yaml'));
  await writeFile(join(fixture.root, 'archive', 'REV-0001.change.yaml'), 'changed');

  assert.deepEqual(context.requireDecision(parseDecisionId('DEC-0001')), decision);
  assert.deepEqual(context.requireEvidence(parseEvidenceId('EVD-000001')), evidence);
  assert.deepEqual(
    [...context.requireArchive(parseRevisionId('REV-0001'), { kind: 'METADATA' }).copyBytes()],
    [...archive.copyBytes()],
  );
  assert.strictEqual(context.observedIo, sealedCounters);
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.decisions), true);
  assert.equal(Object.isFrozen(decision), true);
  assert.equal(Object.isFrozen(evidence), true);
  assert.throws(() => (context.decisions as unknown[]).push({}), TypeError);
  assert.throws(() => ((decision as unknown as { question: string }).question = 'mutated'), TypeError);

  await assert.rejects(sealForInspection(base), /AUTHORITY_CONTEXT_BASE_CONSUMED/);
  assert.strictEqual(context.observedIo, sealedCounters);
});

test('new mutation capture is explicit, exactly once, and failure consumes the capability', async (t) => {
  const first = await contextFixture(t, 'authority-context-new-');
  const base = await buildBaseContext(first.request);
  let captures = 0;
  let retainedSession: SourceCaptureSession | undefined;
  const context = await sealForNewMutation(base, async (session) => {
    retainedSession = session;
    assert.equal(session.phase, 'REQUEST_CAPTURED');
    assert.equal(Object.isFrozen(session), true);
    captures += 1;
  });
  assert.equal(context.phase, 'SEALED');
  assert.equal(captures, 1);
  assert.ok(retainedSession);

  const second = await contextFixture(t, 'authority-context-capture-failure-');
  const failingBase = await buildBaseContext(second.request);
  await assert.rejects(sealForNewMutation(failingBase, async (session) => {
    assert.notStrictEqual(session, retainedSession);
    captures += 1;
    throw new Error('capture failed');
  }), /capture failed/);
  await assert.rejects(sealForNewMutation(failingBase, async () => {
    captures += 1;
  }), /AUTHORITY_CONTEXT_BASE_CONSUMED/);
  assert.equal(captures, 2);

  const recovery = await contextFixture(t, 'authority-context-recovery-');
  const recoveryBase = await buildBaseContext(recovery.request);
  await sealForInspection(recoveryBase);
  assert.equal(captures, 2, 'frozen inspection/recovery never captures current mutable source');
});

test('new mutation callback throwing undefined still rejects and consumes its session', async (t) => {
  const fixture = await contextFixture(t, 'authority-context-undefined-failure-');
  let retained: SourceCaptureSession | undefined;
  let rejected = false;
  try {
    await sealForNewMutation(await buildBaseContext(fixture.request), async (session) => {
      retained = session;
      throw undefined;
    });
  } catch (failure) {
    rejected = true;
    assert.equal(failure, undefined);
  }
  assert.equal(rejected, true);
  assert.ok(retained);
});

test('a dropped rejected capture prevents SEALED context creation and expires the session', async (t) => {
  const fixture = await contextFixture(t, 'authority-context-dropped-capture-');
  let retained: SourceCaptureSession | undefined;
  await assert.rejects(
    sealForNewMutation(await buildBaseContext(fixture.request), async (session) => {
      retained = session;
      const dropped = resolveCurrentSource(session, {
        changeId: 'CHG-0001',
        revisionId: 'REV-0001',
        kind: 'decision',
        decisionId: 'DEC-9999',
      });
      // 模拟调用方避免进程级 unhandled rejection，却没有 await/return capture。
      void dropped.catch(() => undefined);
    }),
    /SOURCE_IDENTITY_MISSING: decision:DEC-9999/,
  );
  assert.ok(retained);
  await assert.rejects(
    resolveCurrentSource(retained, {
      changeId: 'CHG-0001',
      revisionId: 'REV-0001',
      kind: 'decision',
      decisionId: 'DEC-0001',
    }),
    /AUTHORITY_SOURCE_SESSION_INVALID/,
  );
});

test('new mutation callback cannot replace Object.freeze and leak a mutable SEALED context', { concurrency: false }, async (t) => {
  // 回归说明：若 callback 后通过实时 Object.freeze 查找冻结 context/backing，本测试会得到可写 authority。
  const fixture = await contextFixture(t, 'authority-context-freeze-reentrancy-');
  const base = await buildBaseContext(fixture.request);
  const originalFreeze = Object.getOwnPropertyDescriptor(Object, 'freeze');
  assert.ok(originalFreeze);
  const intercepted: unknown[] = [];
  let context;
  try {
    context = await sealForNewMutation(base, async () => {
      Object.defineProperty(Object, 'freeze', {
        ...originalFreeze,
        value(value: unknown) {
          intercepted.push(value);
          return value;
        },
      });
    });
  } finally {
    Object.defineProperty(Object, 'freeze', originalFreeze);
  }

  assert.equal(intercepted.length, 0, 'callback must not observe context or sealed WeakMap backing');
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Reflect.set(context, 'phase', 'REQUEST_CAPTURED'), false);
  assert.equal(context.phase, 'SEALED');
  assert.equal(context.changeId, 'CHG-0001');
});

test('builder owns a synchronous deep copy of target declarations before its first await', async (t) => {
  const fixture = await contextFixture(t, 'authority-context-request-copy-');
  const logicalTargets = structuredClone(fixture.request.logicalTargets);
  const request = { ...fixture.request, logicalTargets };
  const building = buildBaseContext(request);
  logicalTargets.length = 0;
  const context = await sealForInspection(await building);
  assert.equal(context.requireDecision(parseDecisionId('DEC-0001')).id, 'DEC-0001');
  assert.equal(context.requireEvidence(parseEvidenceId('EVD-000001')).id, 'EVD-000001');
});

test('context indexes reject duplicate domain identities from distinct physical targets', async (t) => {
  const fixture = await contextFixture(t, 'authority-context-duplicate-');
  await writeFile(
    join(fixture.root, 'decisions', 'DEC-0002.yaml'),
    YAML.stringify(decisionRecord()),
  );
  const request = {
    ...fixture.request,
    logicalTargets: [
      ...fixture.request.logicalTargets,
      {
        key: { kind: 'DECISION' as const, decisionId: parseDecisionId('DEC-0002') },
        relativePath: 'decisions/DEC-0002.yaml',
        nodeType: 'FILE' as const,
      },
    ],
  };
  await assert.rejects(
    buildBaseContext(request),
    /AUTHORITY_CONTEXT_RECORD_INVALID: Decision key binding/,
  );
});

test('ordered Decision and Evidence views do not inherit attacker-controlled physical path order', async (t) => {
  const fixture = await contextFixture(t, 'authority-context-index-order-');
  await rename(
    join(fixture.root, 'decisions', 'DEC-0001.yaml'),
    join(fixture.root, 'decisions', 'z.yaml'),
  );
  await writeFile(
    join(fixture.root, 'decisions', 'a.yaml'),
    YAML.stringify(decisionRecord('DEC-0002')),
  );
  await rename(
    join(fixture.root, 'evidence', 'EVD-000001.yaml'),
    join(fixture.root, 'evidence', 'z.yaml'),
  );
  await writeFile(
    join(fixture.root, 'evidence', 'a.yaml'),
    YAML.stringify(evidenceRecord('EVD-000002')),
  );
  const request = {
    ...fixture.request,
    logicalTargets: [
      { key: { kind: 'METADATA' as const }, relativePath: 'change.yaml', nodeType: 'FILE' as const },
      {
        key: { kind: 'DECISION' as const, decisionId: parseDecisionId('DEC-0002') },
        relativePath: 'decisions/a.yaml',
        nodeType: 'FILE' as const,
      },
      {
        key: { kind: 'DECISION' as const, decisionId: parseDecisionId('DEC-0001') },
        relativePath: 'decisions/z.yaml',
        nodeType: 'FILE' as const,
      },
      {
        key: { kind: 'EVIDENCE' as const, evidenceId: parseEvidenceId('EVD-000002') },
        relativePath: 'evidence/a.yaml',
        nodeType: 'FILE' as const,
      },
      {
        key: { kind: 'EVIDENCE' as const, evidenceId: parseEvidenceId('EVD-000001') },
        relativePath: 'evidence/z.yaml',
        nodeType: 'FILE' as const,
      },
    ],
  };
  const context = await sealForInspection(await buildBaseContext(request));
  assert.deepEqual(context.decisions.map((record) => record.id), ['DEC-0001', 'DEC-0002']);
  assert.deepEqual(context.evidence.map((record) => record.id), ['EVD-000001', 'EVD-000002']);
});

test('sealed archive lookup rejects Proxy/accessor keys without traps or I/O', async (t) => {
  const fixture = await contextFixture(t, 'authority-context-archive-key-');
  const context = await sealForInspection(await buildBaseContext(fixture.request));
  const counters = context.observedIo;
  let traps = 0;
  const key = new Proxy({ kind: 'METADATA' as const }, {
    get(target, property, receiver) {
      traps += 1;
      return Reflect.get(target, property, receiver);
    },
    getOwnPropertyDescriptor(target, property) {
      traps += 1;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
    ownKeys(target) {
      traps += 1;
      return Reflect.ownKeys(target);
    },
  });
  assert.throws(
    () => context.requireArchive(parseRevisionId('REV-0001'), key),
    /AUTHORITY_INDEX_LOGICAL_KEY_INVALID/,
  );
  assert.equal(traps, 0);

  let accessorCalled = false;
  const accessorKey: Record<string, unknown> = {};
  Object.defineProperty(accessorKey, 'kind', {
    enumerable: true,
    get() {
      accessorCalled = true;
      return 'METADATA';
    },
  });
  assert.throws(
    () => context.requireArchive(
      parseRevisionId('REV-0001'),
      accessorKey as { kind: 'METADATA' },
    ),
    /AUTHORITY_INDEX_LOGICAL_KEY_INVALID/,
  );
  assert.equal(accessorCalled, false);

  let revisionTraps = 0;
  const revisionProxy = new Proxy(Object('REV-0001'), {
    get(target, property, receiver) {
      revisionTraps += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(
    () => context.requireArchive(
      revisionProxy as unknown as ReturnType<typeof parseRevisionId>,
      { kind: 'METADATA' },
    ),
    /AUTHORITY_INDEX_REVISION_ID_INVALID/,
  );
  assert.equal(revisionTraps, 0);
  assert.strictEqual(context.observedIo, counters);
});

test('pure authority index closure contains no raw filesystem or store fallback', async () => {
  const entry = join(process.cwd(), 'src/core/authority/indexes.ts');
  const closure = await runtimeImportClosure(entry);
  for (const forbidden of [
    'node:fs', './files.js', '../files.js', './paths.js', '../paths.js',
    'decision-store', 'flow-store', 'transaction-lineage', 'readdir(', 'readFile(', 'readYaml(',
  ]) {
    for (const [path, source] of closure) {
      assert.equal(source.includes(forbidden), false, `${forbidden} in ${path}`);
    }
  }
  const semantic = await readFile(join(process.cwd(), 'src/core/semantic-mutation-journal.ts'), 'utf8');
  assert.doesNotMatch(
    semantic,
    /assertCompletedSemanticMutationLineage\([\s\S]*?inventory\?\s*:/u,
  );
  assert.doesNotMatch(semantic, /inventory\?\.transactions\s*\?\?/u);
});

test('semantic completed consumer requires and validates an explicit indexed inventory', async () => {
  const buildSemanticMutationLineageView = await requireSemanticViewBuilder();
  const event = Object.freeze({ data: Object.freeze({ semanticMutationId: 'MUT-000001' }) });
  const view = buildSemanticMutationLineageView({
    transactions: [Object.freeze({
      id: 'MUT-000001',
      status: 'COMPLETED',
      kind: 'FLOW',
      audits: [event],
    })],
    events: [event],
  });
  assert.doesNotThrow(() => assertCompletedSemanticMutationInventory(view));
  const orphanView = buildSemanticMutationLineageView({
    transactions: [],
    events: [event],
  });
  assert.throws(
    () => assertCompletedSemanticMutationInventory(orphanView),
    /SEMANTIC_MUTATION_AUDIT_ORPHAN/,
  );
});

test('semantic completed consumer rejects a caller map that disagrees with the single captured event list', async () => {
  const buildSemanticMutationLineageView = await requireSemanticViewBuilder();
  // 回归说明：若 completed consumer 重新信任 caller Map，而不是认证的派生 view，隐藏 event 会被接受。
  const event = Object.freeze({ data: Object.freeze({ semanticMutationId: 'MUT-000001' }) });
  const callerMap = new Map([['MUT-000001', [event]]]);
  assert.throws(() => buildSemanticMutationLineageView({
    transactions: [Object.freeze({
      id: 'MUT-000001',
      status: 'COMPLETED',
      kind: 'FLOW',
      audits: [event],
    })],
    events: [],
    eventsByMutationId: callerMap,
  } as never), /AUTHORITY_SEMANTIC_VIEW_INVALID/);
});

test('semantic correlation view rejects Proxy input without traps and snapshots source arrays', async () => {
  // 回归说明：若 view 保存 caller array backing，构建后的清空会改变 completed 校验结果。
  const buildSemanticMutationLineageView = await requireSemanticViewBuilder();
  let traps = 0;
  const proxyMap = new Proxy(new Map<string, readonly Readonly<{ data: unknown }>[]>() , {
    get(target, property, receiver) {
      traps += 1;
      return Reflect.get(target, property, receiver);
    },
    getPrototypeOf(target) {
      traps += 1;
      return Reflect.getPrototypeOf(target);
    },
  });
  assert.throws(() => buildSemanticMutationLineageView({
    transactions: [],
    events: [],
    eventsByMutationId: proxyMap,
  } as never), /AUTHORITY_SEMANTIC_VIEW_INVALID/);
  assert.equal(traps, 0);

  const event = { data: { semanticMutationId: 'MUT-000001' } };
  const transactions = [{
    id: 'MUT-000001',
    status: 'COMPLETED',
    kind: 'FLOW',
    audits: [event],
  }];
  const events = [event];
  const view = buildSemanticMutationLineageView({ transactions, events });
  transactions.length = 0;
  events.length = 0;

  assert.doesNotThrow(() => assertCompletedSemanticMutationInventory(view));
  assert.equal(Object.isFrozen(view), true);
  assert.equal(Object.isFrozen(view.transactions), true);
  assert.equal(Object.isFrozen(view.events), true);
  assert.equal(Object.isFrozen(view.eventsByMutationId), true);

  const proxyView = new Proxy(view, {
    get(target, property, receiver) {
      traps += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(
    () => assertCompletedSemanticMutationInventory(proxyView),
    /AUTHORITY_SEMANTIC_VIEW_INVALID/,
  );
  assert.equal(traps, 0);
  assert.throws(() => assertCompletedSemanticMutationInventory(Object.freeze({
    schemaVersion: 1,
    kind: 'SEMANTIC_MUTATION_LINEAGE_VIEW_V1',
    transactions: [],
    events: [],
    eventsByMutationId: new Map(),
  }) as never), /AUTHORITY_SEMANTIC_VIEW_INVALID/);
});

async function requireSemanticViewBuilder(): Promise<(input: unknown) => any> {
  const indexesModule: Record<string, unknown> = await import('../indexes.js');
  const buildView = indexesModule.buildSemanticMutationLineageView;
  assert.equal(typeof buildView, 'function');
  return buildView as (input: unknown) => any;
}

test('authority index maps do not expose private entry arrays to a replaced Object.freeze', { concurrency: false }, () => {
  // 回归说明：若 FrozenReadonlyMap 仍实时调用 Object.freeze，hook 可改写私有 pair 并破坏 exact lookup。
  const metadata = changeMetadataSchema.parse(changeMetadata());
  const decision = decisionRecordSchema.parse(decisionRecord());
  const originalFreeze = Object.getOwnPropertyDescriptor(Object, 'freeze');
  assert.ok(originalFreeze);
  const intercepted: unknown[] = [];
  let indexes;
  try {
    Object.defineProperty(Object, 'freeze', {
      ...originalFreeze,
      value(value: unknown) {
        intercepted.push(value);
        return value;
      },
    });
    indexes = buildAuthorityIndexes({
      expectedChangeId: parseChangeId('CHG-0001'),
      metadata,
      taskFile: null,
      flow: null,
      decisions: [decision],
      evidence: [],
      runs: [],
      progress: [],
      archiveEntries: [],
      transactionEntries: [],
    });
  } finally {
    Object.defineProperty(Object, 'freeze', originalFreeze);
  }
  for (let index = 0; index < intercepted.length; index += 1) {
    const value = intercepted[index];
    if (Array.isArray(value) && value.length === 2 && value[0] === 'DEC-0001') {
      Reflect.set(value, '0', 'DEC-9999');
    }
  }
  assert.equal(indexes.decisionsById.get(parseDecisionId('DEC-0001'))?.id, 'DEC-0001');
  assert.equal(Object.isFrozen(indexes.decisionsById), true);
});

async function runtimeImportClosure(entry: string): Promise<ReadonlyMap<string, string>> {
  const pending = [entry];
  const visited = new Map<string, string>();
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    const source = await readFile(path, 'utf8');
    visited.set(path, source);
    const imports = /import\s+(type\s+)?[\s\S]*?\sfrom\s+['"]([^'"]+)['"]\s*;/gu;
    for (const match of source.matchAll(imports)) {
      if (match[1] !== undefined) continue;
      const specifier = match[2]!;
      if (!specifier.startsWith('.')) continue;
      const target = resolve(dirname(path), specifier.replace(/\.js$/u, '.ts'));
      pending.push(target);
    }
  }
  return visited;
}

async function contextFixture(t: test.TestContext, prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lease = await acquireCatalogLease();
  t.after(() => clearInjectedAuthorityCatalogForTest(lease));
  const catalogHash = hashStrictObject(lease.catalog);

  await mkdir(join(root, 'decisions'), { recursive: true });
  await mkdir(join(root, 'evidence'), { recursive: true });
  await mkdir(join(root, 'archive'), { recursive: true });
  await writeFile(join(root, 'workflow.lock.yaml'), YAML.stringify({
    schemaVersion: 2,
    workflowVersion: '0.3.0',
    authorityCatalogId: 'omnai.stage-authority.v1',
    authorityCatalogSchemaVersion: 1,
    authorityCatalogHash: catalogHash,
    resourceBundleHash: SHA_B,
  }));
  await writeFile(join(root, 'change.yaml'), YAML.stringify(changeMetadata()));
  await writeFile(join(root, 'decisions', 'DEC-0001.yaml'), YAML.stringify(decisionRecord()));
  await writeFile(join(root, 'evidence', 'EVD-000001.yaml'), YAML.stringify(evidenceRecord()));
  await writeFile(join(root, 'archive', 'REV-0001.change.yaml'), 'archived bytes');

  const request = {
    expectedChangeId: parseChangeId('CHG-0001'),
    containedRoot: normalizedAbsoluteRealPathSchema.parse(root),
    logicalTargets: [
      { key: { kind: 'METADATA' as const }, relativePath: 'change.yaml', nodeType: 'FILE' as const },
      {
        key: { kind: 'DECISION' as const, decisionId: parseDecisionId('DEC-0001') },
        relativePath: 'decisions/DEC-0001.yaml',
        nodeType: 'FILE' as const,
      },
      {
        key: { kind: 'EVIDENCE' as const, evidenceId: parseEvidenceId('EVD-000001') },
        relativePath: 'evidence/EVD-000001.yaml',
        nodeType: 'FILE' as const,
      },
    ],
    archiveTargets: [{
      key: {
        kind: 'ARCHIVE' as const,
        revisionId: parseRevisionId('REV-0001'),
        logicalKey: { kind: 'METADATA' as const },
      },
      relativePath: 'archive/REV-0001.change.yaml',
      nodeType: 'FILE' as const,
    }],
    knownAuxiliaryTargets: [],
  };
  return {
    root,
    request,
  };
}

let cachedCatalog: unknown;
async function acquireCatalogLease(): Promise<AuthorityCatalogTestLease> {
  if (cachedCatalog === undefined) {
    const raw = await readFile(join(
      process.cwd(), 'src', 'authority', 'test', 'fixtures', 'stage-authority-catalog-v1.yaml',
    ), 'utf8');
    cachedCatalog = stageAuthorityCatalogV1Schema.parse(YAML.parse(raw));
  }
  return loadInjectedAuthorityCatalogForTest(cachedCatalog);
}

function changeMetadata(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: 'CHG-0001',
    slug: 'authority-context',
    title: 'Authority Context',
    scenario: 'small-feature',
    workMode: 'FEATURE',
    status: 'IN_PROGRESS',
    activeRevision: 'REV-0001',
    baseline: 'BL-0001',
    artifactVersions: {},
    risk: {
      level: 'P2',
      dimensions: {
        businessCriticality: 'MEDIUM', data: 'LOW', compatibility: 'LOW',
        reversibility: 'MEDIUM', security: 'LOW', operational: 'LOW',
      },
    },
    impact: {
      frontend: false, backend: true, apiContract: false, database: false,
      mq: false, remoteService: false, security: false, observability: false,
    },
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    readiness: {
      frame: 'READY', map: 'NOT_APPLICABLE', research: 'READY', mitigation: 'NOT_APPLICABLE',
      triage: 'NOT_APPLICABLE', reproduction: 'NOT_APPLICABLE', diagnosis: 'NOT_APPLICABLE',
      domain: 'READY', spec: 'READY', design: 'READY', experiment: 'NOT_APPLICABLE',
      fix: 'NOT_APPLICABLE', plan: 'READY', implementation: 'IN_PROGRESS', review: 'MISSING',
      simplification: 'MISSING', verification: 'MISSING', qa: 'MISSING', release: 'MISSING',
      canary: 'MISSING', learning: 'MISSING',
    },
  };
}

function decisionRecord(id = 'DEC-0001'): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id,
    changeId: 'CHG-0001',
    openedRevision: 'REV-0001',
    resolvedRevision: null,
    kind: 'DOMAIN',
    owner: 'HUMAN',
    status: 'OPEN',
    blocking: true,
    question: 'Who owns the authority context?',
    options: [],
    resolution: null,
    supersededBy: null,
    affects: { capabilities: ['model'], artifacts: [], tasks: [], projects: [], contracts: [] },
    sourceRefs: [],
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function evidenceRecord(id = 'EVD-000001'): Record<string, unknown> {
  const subject = { kind: 'CHANGE_AUTHORITY', revision: 'REV-0001', authorityHead: SHA_A };
  return {
    schemaVersion: 1,
    id,
    changeId: 'CHG-0001',
    revision: 'REV-0001',
    runBinding: null,
    requirementId: null,
    gateId: null,
    taskId: null,
    type: 'manual',
    status: 'PASS',
    producer: 'GENERIC_IMPORT',
    subjectBinding: {
      subject,
      subjectHash: hashStrictObject(subject),
    },
    summary: 'Frozen evidence',
    verificationCommand: null,
    createdAt: TIMESTAMP,
    outputFile: null,
  };
}
