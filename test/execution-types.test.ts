import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createTestDirectory } from './helpers.js';
import { canonicalJson, hashObject } from '../src/execution/hashing.js';
import { nextExecutionId } from '../src/execution/ids.js';
import {
  ensureExecutionLayout,
  executionRoot,
  runPacketPath,
  contractManifestPath,
} from '../src/execution/paths.js';
import {
  attentionItemSchema,
  contractSnapshotManifestSchema,
  executionEventSchema,
  runPacketSchema,
  runStateSchema,
  writerClaimSchema,
} from '../src/execution/types.js';

const NOW = '2026-08-16T00:00:00.000Z';
const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

function writerPacket() {
  return {
    schemaVersion: 1,
    id: 'RUN-0001',
    kind: 'PROJECT_WRITER',
    worksetId: 'WKS-0001',
    scopedTask: { project: 'quote', changeId: 'CHG-0001', revision: 'REV-0001', baseline: 'BL-0001', taskId: 'TASK-001' },
    git: { startingHead: 'a'.repeat(40), worktree: '/tmp/quote', branch: 'omnai/WKS-0001-auth' },
    contracts: [{ id: 'CTR-0001', contentHash: HASH_B }],
    objective: 'Implement Authorization V2', protocolIds: ['execution.project-writer'],
    allowedPaths: ['src/**', 'test/**'], verificationCommands: ['npm test'], evidenceRequired: ['test'], stopConditions: ['signal stale contract'],
    agent: { agentId: 'codex', protocol: 'acp', role: 'project-writer' },
    limits: { timeoutMs: 900000, maxOutputBytes: 1048576 },
    permissionPolicy: { filesystemRoots: ['/tmp/quote'], terminal: true, network: 'DENY', denyGitCommit: true, denyNestedOmnai: true },
    createdAt: NOW, packetHash: `sha256:${'c'.repeat(64)}`,
  } as const;
}

function coordinationPacket() {
  return {
    schemaVersion: 1,
    id: 'RUN-0002',
    kind: 'CONTRACT_PLANNER',
    worksetId: 'WKS-0001',
    contracts: [],
    objective: 'Plan Authorization V2',
    protocolIds: ['execution.contract-planner'],
    verificationCommands: [], evidenceRequired: [], stopConditions: ['signal stale sources'],
    agent: { agentId: 'codex', protocol: 'acp', role: 'coordination-read-only' },
    limits: { timeoutMs: 900000, maxOutputBytes: 1048576 },
    permissionPolicy: { filesystemRoots: ['/tmp/output'], terminal: false, network: 'DENY', denyGitCommit: true, denyNestedOmnai: true },
    createdAt: NOW, packetHash: `sha256:${'d'.repeat(64)}`,
  } as const;
}

function runState() {
  return {
    schemaVersion: 1, machineVersion: 1, id: 'RUN-0001', kind: 'PROJECT_WRITER', worksetId: 'WKS-0001',
    status: 'PREPARED', packetHash: HASH_A, evidenceRefs: [], createdAt: NOW, updatedAt: NOW,
    lastEventSequence: 0, lastEventHash: null,
  } as const;
}

function executionEvent() {
  return {
    schemaVersion: 1, eventId: 'RUN-0001:000001', aggregateType: 'run', aggregateId: 'RUN-0001', machineVersion: 1,
    sequence: 1, type: 'START', from: 'PREPARED', to: 'STARTING', payload: {}, previousHash: null, timestamp: NOW, hash: HASH_A,
  } as const;
}

function contractManifest() {
  return {
    schemaVersion: 1, machineVersion: 1, lastEventSequence: 1, lastEventHash: HASH_A,
    id: 'CTR-0001', worksetId: 'WKS-0001', status: 'GENERATING', contractKey: 'authorization-v2', scopeHash: HASH_A,
    contentHash: HASH_B, previousSnapshot: null,
    participants: [
      { project: 'api', changeId: 'CHG-0001', revision: 'REV-0001', taskId: 'TASK-001', role: 'PROVIDER' },
      { project: 'client', changeId: 'CHG-0001', revision: 'REV-0001', taskId: 'TASK-001', role: 'CONSUMER' },
    ],
    sources: [{ kind: 'intent', project: 'api', ref: 'intent.md', contentHash: HASH_A }],
    businessScenarios: [], validationEvidence: [], createdByRun: 'RUN-0001', createdAt: NOW, updatedAt: NOW,
  } as const;
}

function attentionItem() {
  return {
    schemaVersion: 1, machineVersion: 1, lastEventSequence: 1, lastEventHash: HASH_A,
    id: 'ATTN-0001', kind: 'NEEDS_DECISION', scope: { worksetId: 'WKS-0001', contractId: 'CTR-0001' },
    question: 'Which retry rule applies?', options: [], evidenceRefs: [], blockingProjects: ['quote'],
    createdByRuns: ['RUN-0001'], status: 'OPEN', fingerprint: HASH_B, createdAt: NOW,
  } as const;
}

test('canonical object hashes ignore insertion order', () => {
  assert.equal(hashObject({ a: 1, b: 2 }), hashObject({ b: 2, a: 1 }));
});

test('execution layout is lazy and deterministic', async () => {
  const fixture = await createTestDirectory('omnai-execution-types-');
  try {
    const root = await ensureExecutionLayout(fixture.root, 'WKS-0001');
    assert.equal(root, join(fixture.root, 'worksets', 'WKS-0001', 'execution'));
    assert.equal(runPacketPath(fixture.root, 'WKS-0001', 'RUN-0002'), join(root, 'runs', 'RUN-0002', 'packet.yaml'));
    assert.equal(contractManifestPath(fixture.root, 'WKS-0001', 'CTR-0003'), join(root, 'contracts', 'CTR-0003', 'manifest.yaml'));
  } finally { await fixture.cleanup(); }
});

test('writer packets require project truth while read-only packets omit it', () => {
  const base = writerPacket();
  assert.equal(runPacketSchema.parse(base).kind, 'PROJECT_WRITER');
  assert.throws(() => runPacketSchema.parse({ ...base, scopedTask: undefined, git: undefined }), /scopedTask|git/);
});

test('a persisted claim cannot name a read-only Run kind', () => {
  assert.throws(() => writerClaimSchema.parse({
    schemaVersion: 1, machineVersion: 1, project: 'quote', runId: 'RUN-0001', runKind: 'PROJECT_REVIEWER', phase: 'WRITING',
    worktree: '/tmp/quote', branch: 'omnai/WKS-0001-auth', ownerProcess: 10, agentProtocol: 'acp', agentId: 'codex',
    acquiredAt: '2026-08-16T00:00:00.000Z', heartbeatAt: '2026-08-16T00:00:00.000Z', lastEventSequence: 1,
    lastEventHash: `sha256:${'d'.repeat(64)}`,
  }), /PROJECT_WRITER|RECOVERY_WRITER/);
});

test('coordination packets reject forbidden own properties even when their values are undefined', () => {
  const base = coordinationPacket();
  assert.equal(runPacketSchema.parse(base).kind, 'CONTRACT_PLANNER');
  for (const forbidden of ['scopedTask', 'git', 'allowedPaths'] as const) {
    assert.throws(() => runPacketSchema.parse({ ...base, [forbidden]: undefined }), /unrecognized|forbidden/i);
  }
});

test('materialized lifecycle cursors and execution events require possible hash links', () => {
  assert.equal(runStateSchema.parse(runState()).lastEventSequence, 0);
  assert.throws(() => runStateSchema.parse({ ...runState(), lastEventSequence: 1, lastEventHash: null }), /lastEventHash/);
  assert.throws(() => runStateSchema.parse({ ...runState(), lastEventSequence: 0, lastEventHash: HASH_A }), /lastEventHash/);
  assert.equal(executionEventSchema.parse(executionEvent()).sequence, 1);
  assert.throws(() => executionEventSchema.parse({ ...executionEvent(), sequence: 2, previousHash: null }), /previousHash/);
  assert.throws(() => executionEventSchema.parse({ ...executionEvent(), sequence: 1, previousHash: HASH_B }), /previousHash/);
});

test('attention materializations carry event linkage and enforce status timestamps', () => {
  assert.equal(attentionItemSchema.parse(attentionItem()).status, 'OPEN');
  const { machineVersion: _machineVersion, lastEventSequence: _sequence, lastEventHash: _hash, ...unversioned } = attentionItem();
  assert.throws(() => attentionItemSchema.parse(unversioned), /machineVersion|lastEventSequence|lastEventHash/);
  assert.throws(() => attentionItemSchema.parse({ ...attentionItem(), status: 'RESOLVED' }), /resolvedAt/);
  assert.throws(() => attentionItemSchema.parse({ ...attentionItem(), resolvedAt: NOW }), /resolvedAt/);
  assert.equal(executionEventSchema.parse({ ...executionEvent(), aggregateType: 'attention', aggregateId: 'ATTN-0001' }).aggregateType, 'attention');
});

test('contract sources require a total canonical order', () => {
  const sameLocation = { project: 'api', ref: 'contract.yaml' } as const;
  assert.throws(() => contractSnapshotManifestSchema.parse({
    ...contractManifest(),
    sources: [
      { ...sameLocation, kind: 'test', contentHash: HASH_A },
      { ...sameLocation, kind: 'intent', contentHash: HASH_A },
    ],
  }), /sources must be sorted/);
  assert.throws(() => contractSnapshotManifestSchema.parse({
    ...contractManifest(),
    sources: [
      { ...sameLocation, kind: 'intent', contentHash: HASH_B },
      { ...sameLocation, kind: 'intent', contentHash: HASH_A },
    ],
  }), /sources must be sorted/);
});

test('canonical JSON rejects values that JSON cannot represent without loss', () => {
  const symbol = Symbol('unsupported');
  const accessor = {};
  Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 1 });
  const arrayWithHiddenState = [1];
  Object.defineProperty(arrayWithHiddenState, 'hidden', { value: 2 });
  const unsupported: unknown[] = [
    undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n, symbol, () => undefined,
    { missing: undefined }, [undefined], new Date(NOW), new Map([['a', 1]]), { [symbol]: 1 }, accessor, arrayWithHiddenState,
  ];
  for (const value of unsupported) assert.throws(() => canonicalJson(value), /JSON-safe/);
  assert.equal(canonicalJson({ a: 2, Z: 1 }), '{"Z":1,"a":2}');
  assert.throws(() => executionEventSchema.parse({ ...executionEvent(), payload: { lost: undefined } }), /payload|invalid/i);
  assert.throws(() => executionEventSchema.parse({ ...executionEvent(), payload: { lost: Number.NaN } }), /payload|invalid/i);
  assert.throws(() => executionEventSchema.parse({ ...executionEvent(), payload: { lost: new Map([['a', 1]]) } }), /payload|invalid/i);
  assert.throws(() => executionEventSchema.parse({ ...executionEvent(), payload: { [symbol]: 1 } }), /payload|invalid/i);
});

test('execution ID allocation reports exhaustion after 9999', async () => {
  const fixture = await createTestDirectory('omnai-execution-id-exhaustion-');
  try {
    await ensureExecutionLayout(fixture.root, 'WKS-0001');
    await mkdir(join(executionRoot(fixture.root, 'WKS-0001'), 'contracts', 'CTR-9999'));
    await assert.rejects(() => nextExecutionId(fixture.root, 'WKS-0001', 'contract'), /EXECUTION_ID_EXHAUSTED/);
  } finally { await fixture.cleanup(); }
});

test('Git object IDs accept exactly SHA-1 or SHA-256 widths', () => {
  const base = writerPacket();
  const sha1 = runPacketSchema.parse(base);
  if (sha1.kind !== 'PROJECT_WRITER') assert.fail('expected PROJECT_WRITER');
  assert.equal(sha1.git.startingHead.length, 40);
  const sha256 = runPacketSchema.parse({ ...base, git: { ...base.git, startingHead: 'f'.repeat(64) } });
  if (sha256.kind !== 'PROJECT_WRITER') assert.fail('expected PROJECT_WRITER');
  assert.equal(sha256.git.startingHead.length, 64);
  for (const width of [41, 63]) {
    assert.throws(() => runPacketSchema.parse({ ...base, git: { ...base.git, startingHead: 'f'.repeat(width) } }), /startingHead|invalid/i);
  }
});
