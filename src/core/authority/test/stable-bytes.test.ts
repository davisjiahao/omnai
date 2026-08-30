import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  parseDecisionId,
  parseEvidenceId,
  parseRevisionId,
  parseRunId,
} from '../../../domain/scalars.js';
import { createObservedIoRecorder } from '../observed-io.js';
import {
  buildAuthorityInventoryBase,
  finalizeAuthorityInventory,
  type AuthorityAuxiliaryKeyV1,
  type BuildAuthorityInventoryBaseRequestV1,
} from '../inventory.js';
import { captureStableBytes } from '../stable-bytes.js';

test('stable bytes are read once and returned only through defensive copies', async (t) => {
  const root = await fixture(t, 'authority-stable-copy-');
  await writeFile(join(root, 'payload.bin'), Buffer.from([0, 1, 2, 255]));
  await chmod(join(root, 'payload.bin'), 0o640);
  const observedIo = createObservedIoRecorder();

  const capture = await captureStableBytes({
    containedRoot: root,
    relativePath: 'payload.bin',
    observedIo,
  });
  const first = capture.copyBytes();
  first.fill(7);

  assert.deepEqual([...capture.copyBytes()], [0, 1, 2, 255]);
  assert.equal(capture.byteLength, 4);
  assert.equal(capture.observation.mode, 0o640);
  assert.match(capture.rawBytesHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(capture), true);
  assert.equal(Object.isFrozen(capture.observation), true);
  assert.equal((capture as unknown as { bytes?: unknown }).bytes, undefined);
  assert.deepEqual([...observedIo.snapshot().fileOpens], [['payload.bin', 1]]);
  assert.deepEqual([...observedIo.snapshot().stableCaptures], [['payload.bin', 1]]);
});

test('stable hashing does not expose private bytes to a replaced hash update method', { concurrency: false }, async (t) => {
  // 回归说明：若 hashBytes 动态调用 hash.update，hook 可原地改写 private bytes 并污染后续 copyBytes。
  const root = await fixture(t, 'authority-stable-hash-update-');
  await writeFile(join(root, 'payload.bin'), Buffer.from([4, 5, 6]));
  const prototype = Object.getPrototypeOf(createHash('sha256')) as object;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'update');
  assert.ok(descriptor && typeof descriptor.value === 'function');
  let intercepted = 0;
  let capture;
  try {
    Object.defineProperty(prototype, 'update', {
      ...descriptor,
      value(this: unknown, bytes: Uint8Array, ...rest: unknown[]) {
        intercepted += 1;
        bytes[0] = 99;
        return Reflect.apply(descriptor.value, this, [bytes, ...rest]);
      },
    });
    capture = await captureStableBytes({
      containedRoot: root,
      relativePath: 'payload.bin',
      observedIo: createObservedIoRecorder(),
    });
  } finally {
    Object.defineProperty(prototype, 'update', descriptor);
  }
  assert.equal(intercepted, 0);
  assert.deepEqual([...capture.copyBytes()], [4, 5, 6]);
});

test('stable byte copies do not pass private bytes through replaceable copy helpers', async (t) => {
  const root = await fixture(t, 'authority-stable-copy-builtins-');
  await writeFile(join(root, 'payload.bin'), Buffer.from([10, 20, 30]));
  const capture = await captureStableBytes({
    containedRoot: root,
    relativePath: 'payload.bin',
    observedIo: createObservedIoRecorder(),
  });
  const uint8From = Object.getOwnPropertyDescriptor(Uint8Array, 'from');
  const bufferFrom = Object.getOwnPropertyDescriptor(Buffer, 'from')!;
  const bufferSubarray = Object.getOwnPropertyDescriptor(Buffer.prototype, 'subarray')!;
  let copy: Uint8Array;

  try {
    Object.defineProperty(Uint8Array, 'from', {
      configurable: true,
      writable: true,
      value() { throw new Error('replaceable Uint8Array.from reached'); },
    });
    Object.defineProperty(Buffer, 'from', {
      ...bufferFrom,
      value() { throw new Error('replaceable Buffer.from reached'); },
    });
    Object.defineProperty(Buffer.prototype, 'subarray', {
      ...bufferSubarray,
      value() { throw new Error('replaceable Buffer.prototype.subarray reached'); },
    });
    copy = capture.copyBytes();
    copy[0] = 255;
  } finally {
    if (uint8From === undefined) Reflect.deleteProperty(Uint8Array, 'from');
    else Object.defineProperty(Uint8Array, 'from', uint8From);
    Object.defineProperty(Buffer, 'from', bufferFrom);
    Object.defineProperty(Buffer.prototype, 'subarray', bufferSubarray);
  }

  assert.deepEqual([...copy!], [255, 20, 30]);
  assert.deepEqual([...capture.copyBytes()], [10, 20, 30]);
});

test('stable byte copies bind the intrinsic Uint8Array constructor at module initialization', () => {
  runIsolatedGlobalUint8ArrayCopy();
});

test('stable byte copies do not read a replaceable typed-array length accessor', () => {
  runIsolatedUint8ArrayLengthCopy();
});

for (const race of ['bytes', 'mode', 'rename'] as const) {
  test(`stable capture rejects a deterministic ${race} race with zero retry`, () => {
    runIsolatedFileRace(race);
  });
}

test('inventory captures every typed authority family once, orders real I/O, and ignores a decoy', async (t) => {
  const root = await fixture(t, 'authority-inventory-');
  const files = {
    'change.yaml': 'metadata',
    'tasks.yaml': 'tasks',
    'flow.yaml': 'flow',
    'progress.jsonl': 'progress',
    'decisions/DEC-0001.yaml': 'decision',
    'evidence/EVD-000001.yaml': 'evidence',
    'runs/RUN-000001.yaml': 'run',
    'transactions/TXN-000001.yaml': 'transaction',
    'archive/REV-0001.flow.yaml': 'archive',
    'auxiliary/used.bin': 'used',
    'auxiliary/decoy.bin': 'decoy',
  } as const;
  for (const [relativePath, contents] of Object.entries(files)) {
    await mkdir(join(root, relativePath, '..'), { recursive: true });
    await writeFile(join(root, relativePath), contents);
  }

  const observedIo = createObservedIoRecorder();
  const request = completeInventoryRequest(root, observedIo);
  const base = await buildAuthorityInventoryBase(request);
  const inventory = await finalizeAuthorityInventory({
    base,
    verifiedReceiptReferences: [
      {
        receiptId: 'REC-000001',
        targetKey: auxiliaryKey('OUTPUT'),
        relativePath: 'auxiliary/used.bin',
      },
    ],
  });
  const counters = observedIo.snapshot();
  const expectedFiles = [
    'archive/REV-0001.flow.yaml',
    'change.yaml',
    'decisions/DEC-0001.yaml',
    'evidence/EVD-000001.yaml',
    'flow.yaml',
    'progress.jsonl',
    'runs/RUN-000001.yaml',
    'tasks.yaml',
    'transactions/TXN-000001.yaml',
    'auxiliary/used.bin',
  ];

  assert.deepEqual([...counters.fileOpens], expectedFiles.map((path) => [path, 1]));
  assert.deepEqual([...counters.stableCaptures], expectedFiles.map((path) => [path, 1]));
  assert.deepEqual([...counters.directoryReads], [
    ['archive', 1],
    ['decisions', 1],
    ['evidence', 1],
    ['runs', 1],
    ['transactions', 1],
    ['auxiliary', 1],
  ]);
  assert.equal(counters.fileOpens.has('auxiliary/decoy.bin'), false);
  assert.equal(counters.stableCaptures.has('auxiliary/decoy.bin'), false);
  assert.equal(inventory.entries.length, 10);
  assert.equal(inventory.logicalEntries.length, 8);
  assert.equal(inventory.archiveEntries.length, 1);
  assert.equal(inventory.auxiliaryEntries.length, 1);
  assert.equal(inventory.getLogical({ kind: 'METADATA' })?.relativePath, 'change.yaml');
  assert.equal(inventory.getArchive({
    kind: 'ARCHIVE',
    revisionId: parseRevisionId('REV-0001'),
    logicalKey: { kind: 'FLOW' },
  })?.relativePath, 'archive/REV-0001.flow.yaml');
  assert.equal(Object.isFrozen(inventory), true);
  assert.equal(Object.isFrozen(inventory.entries), true);
  assert.equal(Object.isFrozen(inventory.entries[0]), true);
  assert.equal(Object.isFrozen(inventory.entries[0]?.key), true);
  assert.throws(() => (inventory.entries as unknown[]).push({}), TypeError);
  assert.equal((inventory.entriesByKey as unknown as { set?: unknown }).set, undefined);
  assert.throws(() => Map.prototype.set.call(inventory.entriesByKey, 'forged', inventory.entries[0]), TypeError);

  const metadata = inventory.getLogical({ kind: 'METADATA' });
  assert.equal(metadata?.nodeType, 'FILE');
  if (metadata?.nodeType === 'FILE') {
    const hostile = metadata.capture.copyBytes();
    hostile.fill(0);
    assert.equal(new TextDecoder().decode(metadata.capture.copyBytes()), 'metadata');
  }
});

test('inventory rejects duplicate logical and archive keys before any I/O', async (t) => {
  const root = await fixture(t, 'authority-inventory-duplicates-');
  await writeFile(join(root, 'one'), 'one');
  await writeFile(join(root, 'two'), 'two');

  for (const request of [
    {
      containedRoot: root,
      observedIo: createObservedIoRecorder(),
      logicalTargets: [
        { key: { kind: 'METADATA' as const }, relativePath: 'one', nodeType: 'FILE' as const },
        { key: { kind: 'METADATA' as const }, relativePath: 'two', nodeType: 'FILE' as const },
      ],
      archiveTargets: [], knownAuxiliaryTargets: [],
    },
    {
      containedRoot: root,
      observedIo: createObservedIoRecorder(),
      logicalTargets: [],
      archiveTargets: [
        archiveTarget('one'),
        archiveTarget('two'),
      ],
      knownAuxiliaryTargets: [],
    },
  ]) {
    await assert.rejects(buildAuthorityInventoryBase(request), /AUTHORITY_INVENTORY_(?:LOGICAL|ARCHIVE)_KEY_DUPLICATE/);
    assert.deepEqual([...request.observedIo.snapshot().fileOpens], []);
  }
});

test('inventory rejects a distinct archive key that aliases the same archive path', async (t) => {
  const root = await fixture(t, 'authority-archive-path-collision-');
  await writeFile(join(root, 'archive'), 'archive');
  const observedIo = createObservedIoRecorder();

  await assert.rejects(buildAuthorityInventoryBase({
    containedRoot: root,
    observedIo,
    logicalTargets: [],
    archiveTargets: [
      archiveTarget('archive'),
      {
        key: {
          kind: 'ARCHIVE',
          revisionId: parseRevisionId('REV-0001'),
          logicalKey: { kind: 'METADATA' },
        },
        relativePath: 'archive',
        nodeType: 'FILE',
      },
    ],
    knownAuxiliaryTargets: [],
  }), /AUTHORITY_INVENTORY_PATH_COLLISION/);
  assert.deepEqual([...observedIo.snapshot().fileOpens], []);
});

test('an unreferenced known auxiliary candidate cannot collide with selected inventory', async (t) => {
  const root = await fixture(t, 'authority-unreferenced-auxiliary-');
  await writeFile(join(root, 'change.yaml'), 'metadata');
  const observedIo = createObservedIoRecorder();

  const base = await buildAuthorityInventoryBase({
    containedRoot: root,
    observedIo,
    logicalTargets: [
      { key: { kind: 'METADATA' }, relativePath: 'change.yaml', nodeType: 'FILE' },
    ],
    archiveTargets: [],
    knownAuxiliaryTargets: [
      { key: auxiliaryKey('UNREFERENCED'), relativePath: 'change.yaml', nodeType: 'FILE' },
    ],
  });
  const inventory = await finalizeAuthorityInventory({ base, verifiedReceiptReferences: [] });

  assert.equal(inventory.entries.length, 1);
  assert.equal(inventory.auxiliaryEntries.length, 0);
  assert.deepEqual([...observedIo.snapshot().fileOpens], [['change.yaml', 1]]);
  assert.deepEqual([...observedIo.snapshot().stableCaptures], [['change.yaml', 1]]);
});

test('even an empty inventory rejects a counterfeit observed-I/O recorder', async (t) => {
  const root = await fixture(t, 'authority-counterfeit-recorder-');
  const counterfeit = Object.freeze({
    snapshot: () => Object.freeze({
      fileOpens: new Map<string, number>(),
      directoryReads: new Map<string, number>(),
      stableCaptures: new Map<string, number>(),
    }),
  }) as ReturnType<typeof createObservedIoRecorder>;

  await assert.rejects(buildAuthorityInventoryBase({
    containedRoot: root,
    observedIo: counterfeit,
    logicalTargets: [],
    archiveTargets: [],
    knownAuxiliaryTargets: [],
  }), /AUTHORITY_IO_RECORDER_INVALID/);
});

test('two-phase inventory reuses base captures, permits plural/shared receipt targets, and finalizes once', async (t) => {
  const root = await fixture(t, 'authority-inventory-two-phase-');
  await mkdir(join(root, 'shared'));
  await mkdir(join(root, 'new-parent'));
  await writeFile(join(root, 'shared', 'receipt.yaml'), 'receipt');
  await writeFile(join(root, 'shared', 'used.bin'), 'used');
  await writeFile(join(root, 'new-parent', 'other.bin'), 'other');
  await writeFile(join(root, 'new-parent', 'decoy.bin'), 'decoy');
  const observedIo = createObservedIoRecorder();
  const usedKey = auxiliaryKey('OUTPUT');
  const otherKey = auxiliaryKey('LOG');
  const base = await buildAuthorityInventoryBase({
    containedRoot: root,
    observedIo,
    logicalTargets: [
      { key: { kind: 'METADATA' }, relativePath: 'shared/receipt.yaml', nodeType: 'FILE' },
    ],
    archiveTargets: [],
    knownAuxiliaryTargets: [
      { key: usedKey, relativePath: 'shared/used.bin', nodeType: 'FILE' },
      { key: otherKey, relativePath: 'new-parent/other.bin', nodeType: 'FILE' },
      { key: auxiliaryKey('DECOY'), relativePath: 'new-parent/decoy.bin', nodeType: 'FILE' },
    ],
  });

  assert.equal(base.entries.length, 1);
  assert.equal(base.getLogical({ kind: 'METADATA' })?.relativePath, 'shared/receipt.yaml');
  assert.deepEqual([...observedIo.snapshot().fileOpens], [['shared/receipt.yaml', 1]]);
  assert.deepEqual([...observedIo.snapshot().directoryReads], [['shared', 1]]);
  await assert.rejects(finalizeAuthorityInventory({
    base: Object.freeze({ ...base }),
    verifiedReceiptReferences: [],
  }), /AUTHORITY_INVENTORY_BASE_INVALID/);

  const inventory = await finalizeAuthorityInventory({
    base,
    verifiedReceiptReferences: [
      { receiptId: 'REC-000001', targetKey: usedKey, relativePath: 'shared/used.bin' },
      { receiptId: 'REC-000001', targetKey: otherKey, relativePath: 'new-parent/other.bin' },
      { receiptId: 'REC-000002', targetKey: usedKey, relativePath: 'shared/used.bin' },
    ],
  });

  assert.equal(inventory.entries.length, 3);
  assert.equal(inventory.auxiliaryEntries.length, 2);
  assert.equal(inventory.getAuxiliary(usedKey)?.relativePath, 'shared/used.bin');
  assert.equal(inventory.getAuxiliary(otherKey)?.relativePath, 'new-parent/other.bin');
  assert.deepEqual([...observedIo.snapshot().fileOpens], [
    ['shared/receipt.yaml', 1],
    ['new-parent/other.bin', 1],
    ['shared/used.bin', 1],
  ]);
  assert.deepEqual([...observedIo.snapshot().stableCaptures], [
    ['shared/receipt.yaml', 1],
    ['new-parent/other.bin', 1],
    ['shared/used.bin', 1],
  ]);
  assert.deepEqual([...observedIo.snapshot().directoryReads], [
    ['shared', 1],
    ['new-parent', 1],
  ]);
  assert.equal(observedIo.snapshot().fileOpens.has('new-parent/decoy.bin'), false);

  const beforeSecondFinalize = observedIo.snapshot();
  await assert.rejects(finalizeAuthorityInventory({
    base,
    verifiedReceiptReferences: [],
  }), /AUTHORITY_INVENTORY_ALREADY_FINALIZED/);
  assert.deepEqual([...observedIo.snapshot().fileOpens], [...beforeSecondFinalize.fileOpens]);
  assert.deepEqual([...observedIo.snapshot().directoryReads], [...beforeSecondFinalize.directoryReads]);
});

test('two-phase private state does not consult replaceable Map or WeakMap prototypes', () => {
  runIsolatedInventoryIntrinsicState();
});

test('Task2 private arrays do not consult replaceable Array.prototype.push', () => {
  runIsolatedPrivateArrayPush();
});

test('inventory rejects unknown, exact duplicate, and conflicting receipt references without auxiliary I/O', async (t) => {
  const root = await fixture(t, 'authority-inventory-receipts-');
  await mkdir(join(root, 'auxiliary'));
  await writeFile(join(root, 'auxiliary', 'used.bin'), 'used');
  await writeFile(join(root, 'auxiliary', 'other.bin'), 'other');
  const usedKey = auxiliaryKey('OUTPUT');
  const otherKey = auxiliaryKey('OTHER');
  const knownAuxiliaryTargets = [
    { key: usedKey, relativePath: 'auxiliary/used.bin', nodeType: 'FILE' as const },
    { key: otherKey, relativePath: 'auxiliary/other.bin', nodeType: 'FILE' as const },
  ];
  const cases = [
    {
      expected: /AUTHORITY_INVENTORY_RECEIPT_UNKNOWN/,
      references: [
        { receiptId: 'REC-000001', targetKey: auxiliaryKey('UNKNOWN'), relativePath: 'auxiliary/missing.bin' },
      ],
    },
    {
      expected: /AUTHORITY_INVENTORY_RECEIPT_DUPLICATE/,
      references: [
        { receiptId: 'REC-000001', targetKey: usedKey, relativePath: 'auxiliary/used.bin' },
        { receiptId: 'REC-000001', targetKey: usedKey, relativePath: 'auxiliary/used.bin' },
      ],
    },
    {
      expected: /AUTHORITY_INVENTORY_RECEIPT_CONFLICT/,
      references: [
        { receiptId: 'REC-000001', targetKey: usedKey, relativePath: 'auxiliary/other.bin' },
      ],
    },
  ];

  for (const { expected, references } of cases) {
    const observedIo = createObservedIoRecorder();
    const base = await buildAuthorityInventoryBase({
      containedRoot: root,
      observedIo,
      logicalTargets: [],
      archiveTargets: [],
      knownAuxiliaryTargets,
    });
    await assert.rejects(finalizeAuthorityInventory({
      base,
      verifiedReceiptReferences: references,
    }), expected);
    assert.deepEqual([...observedIo.snapshot().fileOpens], []);
    assert.deepEqual([...observedIo.snapshot().directoryReads], []);
  }
});

test('a DIRECTORY target is captured from one frozen directory observation', async (t) => {
  const root = await fixture(t, 'authority-inventory-directory-target-');
  await mkdir(join(root, 'tree'));
  await chmod(join(root, 'tree'), 0o750);
  await writeFile(join(root, 'tree', 'b'), 'b');
  await writeFile(join(root, 'tree', 'a'), 'a');
  const observedIo = createObservedIoRecorder();
  const base = await buildAuthorityInventoryBase({
    containedRoot: root,
    observedIo,
    logicalTargets: [
      { key: { kind: 'METADATA' }, relativePath: 'tree', nodeType: 'DIRECTORY' },
    ],
    archiveTargets: [],
    knownAuxiliaryTargets: [],
  });
  const inventory = await finalizeAuthorityInventory({ base, verifiedReceiptReferences: [] });
  const entry = inventory.getLogical({ kind: 'METADATA' });

  assert.equal(entry?.nodeType, 'DIRECTORY');
  if (entry?.nodeType === 'DIRECTORY') {
    const observedDirectory = inventory.observedDirectories.get('tree');
    assert.deepEqual(entry.observation.entries, ['a', 'b']);
    assert.equal(entry.observation.mode, 0o750);
    assert.equal(entry.contentHash, entry.observation.inventoryHash);
    assert.equal(observedDirectory, entry.observation);
    assert.equal(observedDirectory?.inventoryHash, entry.contentHash);
    assert.equal(Object.isFrozen(entry.observation.entries), true);
    assert.equal(Object.isFrozen(inventory.observedDirectories), true);
    assert.equal(
      (inventory.observedDirectories as unknown as { set?: unknown }).set,
      undefined,
    );
    assert.throws(
      () => Map.prototype.set.call(inventory.observedDirectories, 'forged', entry.observation),
      TypeError,
    );
    assert.equal(inventory.observedDirectories.has('forged'), false);
  }
  assert.deepEqual([...observedIo.snapshot().directoryReads], [['tree', 1]]);
  assert.deepEqual([...observedIo.snapshot().fileOpens], []);
});

test('finalization closes identity conflicts between base and selected auxiliary captures', async (t) => {
  const root = await fixture(t, 'authority-inventory-cross-phase-identity-');
  await mkdir(join(root, 'a'));
  await mkdir(join(root, 'b'));
  await writeFile(join(root, 'a', 'same'), 'before');
  await link(join(root, 'a', 'same'), join(root, 'b', 'same'));
  const observedIo = createObservedIoRecorder();
  const auxKey = auxiliaryKey('OUTPUT');
  const base = await buildAuthorityInventoryBase({
    containedRoot: root,
    observedIo,
    logicalTargets: [
      { key: { kind: 'METADATA' }, relativePath: 'a/same', nodeType: 'FILE' },
    ],
    archiveTargets: [],
    knownAuxiliaryTargets: [
      { key: auxKey, relativePath: 'b/same', nodeType: 'FILE' },
    ],
  });
  await writeFile(join(root, 'a', 'same'), 'after!');

  await assert.rejects(finalizeAuthorityInventory({
    base,
    verifiedReceiptReferences: [
      { receiptId: 'REC-000001', targetKey: auxKey, relativePath: 'b/same' },
    ],
  }), /AUTHORITY_INVENTORY_IDENTITY_HASH_CONFLICT/);
  assert.deepEqual([...observedIo.snapshot().fileOpens], [['a/same', 1], ['b/same', 1]]);
  assert.deepEqual([...observedIo.snapshot().stableCaptures], [['a/same', 1], ['b/same', 1]]);
});

test('inventory rejects request, array, target, key, reference, and base proxies before traps or I/O', async (t) => {
  const root = await fixture(t, 'authority-inventory-proxy-');
  await writeFile(join(root, 'target'), 'target');

  for (const layer of ['request', 'array', 'target', 'key'] as const) {
    const observedIo = createObservedIoRecorder();
    let trapCount = 0;
    const trap: ProxyHandler<object> = {
      get() { trapCount += 1; throw new Error('proxy trap must not run'); },
      getOwnPropertyDescriptor() { trapCount += 1; throw new Error('proxy trap must not run'); },
      getPrototypeOf() { trapCount += 1; throw new Error('proxy trap must not run'); },
      ownKeys() { trapCount += 1; throw new Error('proxy trap must not run'); },
    };
    const key = layer === 'key'
      ? new Proxy({ kind: 'METADATA' }, trap)
      : { kind: 'METADATA' };
    const target = layer === 'target'
      ? new Proxy({ key, relativePath: 'target', nodeType: 'FILE' }, trap)
      : { key, relativePath: 'target', nodeType: 'FILE' };
    const logicalTargets = layer === 'array' ? new Proxy([target], trap) : [target];
    const plain = {
      containedRoot: root,
      observedIo,
      logicalTargets,
      archiveTargets: [],
      knownAuxiliaryTargets: [],
    };
    const request = layer === 'request' ? new Proxy(plain, trap) : plain;

    await assert.rejects(
      buildAuthorityInventoryBase(request as Parameters<typeof buildAuthorityInventoryBase>[0]),
      /AUTHORITY_INVENTORY_INPUT_INVALID/,
    );
    assert.equal(trapCount, 0, layer);
    assert.deepEqual([...observedIo.snapshot().fileOpens], []);
  }

  for (const layer of ['request', 'array', 'reference', 'key', 'base'] as const) {
    const observedIo = createObservedIoRecorder();
    const auxKey = auxiliaryKey('OUTPUT');
    const base = await buildAuthorityInventoryBase({
      containedRoot: root,
      observedIo,
      logicalTargets: [],
      archiveTargets: [],
      knownAuxiliaryTargets: [
        { key: auxKey, relativePath: 'target', nodeType: 'FILE' },
      ],
    });
    let trapCount = 0;
    const trap: ProxyHandler<object> = {
      get() { trapCount += 1; throw new Error('proxy trap must not run'); },
      getOwnPropertyDescriptor() { trapCount += 1; throw new Error('proxy trap must not run'); },
      getPrototypeOf() { trapCount += 1; throw new Error('proxy trap must not run'); },
      ownKeys() { trapCount += 1; throw new Error('proxy trap must not run'); },
    };
    const targetKey = layer === 'key' ? new Proxy(auxKey, trap) : auxKey;
    const plainReference = { receiptId: 'REC-000001', targetKey, relativePath: 'target' };
    const reference = layer === 'reference' ? new Proxy(plainReference, trap) : plainReference;
    const references = layer === 'array' ? new Proxy([reference], trap) : [reference];
    const plainRequest = {
      base: layer === 'base' ? new Proxy(base, trap) : base,
      verifiedReceiptReferences: references,
    };
    const request = layer === 'request' ? new Proxy(plainRequest, trap) : plainRequest;

    await assert.rejects(
      finalizeAuthorityInventory(request as Parameters<typeof finalizeAuthorityInventory>[0]),
      /AUTHORITY_INVENTORY_(?:INPUT|BASE)_INVALID/,
    );
    assert.equal(trapCount, 0, layer);
    assert.deepEqual([...observedIo.snapshot().fileOpens], []);
  }
});

test('inventory rejects transparent, throwing, and revoked top-level proxies without touching traps', async (t) => {
  const root = await fixture(t, 'authority-inventory-proxy-kinds-');
  for (const kind of ['transparent', 'throwing', 'revoked'] as const) {
    const observedIo = createObservedIoRecorder();
    const plain = {
      containedRoot: root,
      observedIo,
      logicalTargets: [],
      archiveTargets: [],
      knownAuxiliaryTargets: [],
    };
    let trapCount = 0;
    const handler: ProxyHandler<typeof plain> = {
      get(target, key, receiver) {
        trapCount += 1;
        if (kind === 'throwing') throw new Error('proxy trap must not run');
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor(target, key) {
        trapCount += 1;
        if (kind === 'throwing') throw new Error('proxy trap must not run');
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      getPrototypeOf(target) {
        trapCount += 1;
        if (kind === 'throwing') throw new Error('proxy trap must not run');
        return Reflect.getPrototypeOf(target);
      },
      ownKeys(target) {
        trapCount += 1;
        if (kind === 'throwing') throw new Error('proxy trap must not run');
        return Reflect.ownKeys(target);
      },
    };
    let request: typeof plain;
    if (kind === 'revoked') {
      const revocable = Proxy.revocable(plain, handler);
      request = revocable.proxy;
      revocable.revoke();
    } else {
      request = new Proxy(plain, handler);
    }

    await assert.rejects(
      buildAuthorityInventoryBase(request),
      /AUTHORITY_INVENTORY_INPUT_INVALID/,
    );
    assert.equal(trapCount, 0, kind);
    assert.deepEqual([...observedIo.snapshot().fileOpens], []);
  }
});

test('authority production modules export no testing seam', async () => {
  const stableModule: Record<string, unknown> = await import('../stable-bytes.js');
  const inventoryModule: Record<string, unknown> = await import('../inventory.js');
  for (const key of [
    'captureStableBytesWithInternalSeamForTesting',
    'observeStableDirectoryWithInternalSeamForTesting',
    'buildAuthorityInventoryWithInternalSeamForTesting',
  ]) {
    assert.equal(stableModule[key] ?? inventoryModule[key], undefined, key);
  }
});

function completeInventoryRequest(
  containedRoot: string,
  observedIo: ReturnType<typeof createObservedIoRecorder>,
): BuildAuthorityInventoryBaseRequestV1 {
  const auxKey = auxiliaryKey('OUTPUT');
  return {
    containedRoot,
    observedIo,
    logicalTargets: [
      { key: { kind: 'METADATA' }, relativePath: 'change.yaml', nodeType: 'FILE' },
      { key: { kind: 'TASKS' }, relativePath: 'tasks.yaml', nodeType: 'FILE' },
      { key: { kind: 'FLOW' }, relativePath: 'flow.yaml', nodeType: 'FILE' },
      { key: { kind: 'PROGRESS' }, relativePath: 'progress.jsonl', nodeType: 'FILE' },
      { key: { kind: 'DECISION', decisionId: parseDecisionId('DEC-0001') }, relativePath: 'decisions/DEC-0001.yaml', nodeType: 'FILE' },
      { key: { kind: 'EVIDENCE', evidenceId: parseEvidenceId('EVD-000001') }, relativePath: 'evidence/EVD-000001.yaml', nodeType: 'FILE' },
      { key: { kind: 'RUN', runId: parseRunId('RUN-000001') }, relativePath: 'runs/RUN-000001.yaml', nodeType: 'FILE' },
      { key: { kind: 'TRANSACTION', transactionId: 'TXN-000001' }, relativePath: 'transactions/TXN-000001.yaml', nodeType: 'FILE' },
    ],
    archiveTargets: [archiveTarget('archive/REV-0001.flow.yaml')],
    knownAuxiliaryTargets: [
      { key: auxKey, relativePath: 'auxiliary/used.bin', nodeType: 'FILE' },
      { key: auxiliaryKey('DECOY'), relativePath: 'auxiliary/decoy.bin', nodeType: 'FILE' },
    ],
  };
}

function archiveTarget(relativePath: string) {
  return {
    key: {
      kind: 'ARCHIVE' as const,
      revisionId: parseRevisionId('REV-0001'),
      logicalKey: { kind: 'FLOW' as const },
    },
    relativePath,
    nodeType: 'FILE' as const,
  };
}

function auxiliaryKey(role: string): AuthorityAuxiliaryKeyV1 {
  return { kind: 'AUXILIARY', ownerKind: 'RUN', ownerId: 'RUN-000001', role };
}

function runIsolatedGlobalUint8ArrayCopy(): void {
  const moduleUrl = new URL('../stable-bytes.js', import.meta.url).href;
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { mkdtemp, rm, writeFile } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';

    const moduleUrl = process.argv[1];
    const stable = await import(moduleUrl);
    const { createObservedIoRecorder } = await import(new URL('./observed-io.js', moduleUrl).href);
    const root = await mkdtemp(join(tmpdir(), 'authority-isolated-uint8array-'));
    await writeFile(join(root, 'payload'), Buffer.from([4, 5, 6]));
    const capture = await stable.captureStableBytes({
      containedRoot: root,
      relativePath: 'payload',
      observedIo: createObservedIoRecorder(),
    });
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Uint8Array');
    let copy;
    try {
      Object.defineProperty(globalThis, 'Uint8Array', {
        ...descriptor,
        value: function replacedUint8Array() {
          throw new Error('replaceable global Uint8Array reached');
        },
      });
      copy = capture.copyBytes();
      copy[0] = 99;
    } finally {
      Object.defineProperty(globalThis, 'Uint8Array', descriptor);
      await rm(root, { recursive: true, force: true });
    }
    assert.deepEqual([...copy], [99, 5, 6]);
    assert.deepEqual([...capture.copyBytes()], [4, 5, 6]);
  `;
  execFileSync(process.execPath, [
    '--input-type=module',
    '--eval',
    script,
    moduleUrl,
  ], { encoding: 'utf8', timeout: 15_000, stdio: 'pipe' });
}

function runIsolatedUint8ArrayLengthCopy(): void {
  const moduleUrl = new URL('../stable-bytes.js', import.meta.url).href;
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { mkdtemp, rm, writeFile } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';

    const moduleUrl = process.argv[1];
    const stable = await import(moduleUrl);
    const { createObservedIoRecorder } = await import(new URL('./observed-io.js', moduleUrl).href);
    const root = await mkdtemp(join(tmpdir(), 'authority-isolated-uint8array-length-'));
    await writeFile(join(root, 'payload'), Buffer.from([7, 8, 9]));
    const capture = await stable.captureStableBytes({
      containedRoot: root,
      relativePath: 'payload',
      observedIo: createObservedIoRecorder(),
    });
    const priorDescriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'length');
    const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
    const intrinsicLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length').get;
    const reflectApply = Reflect.apply;
    let lengthReads = 0;
    let copy;
    try {
      Object.defineProperty(Uint8Array.prototype, 'length', {
        configurable: true,
        get() {
          lengthReads += 1;
          return reflectApply(intrinsicLengthGetter, this, []);
        },
      });
      copy = capture.copyBytes();
      copy[0] = 99;
    } finally {
      if (priorDescriptor === undefined) Reflect.deleteProperty(Uint8Array.prototype, 'length');
      else Object.defineProperty(Uint8Array.prototype, 'length', priorDescriptor);
      await rm(root, { recursive: true, force: true });
    }
    assert.equal(lengthReads, 0);
    assert.deepEqual([...copy], [99, 8, 9]);
    assert.deepEqual([...capture.copyBytes()], [7, 8, 9]);
  `;
  execFileSync(process.execPath, [
    '--input-type=module',
    '--eval',
    script,
    moduleUrl,
  ], { encoding: 'utf8', timeout: 15_000, stdio: 'pipe' });
}

function runIsolatedInventoryIntrinsicState(): void {
  const moduleUrl = new URL('../inventory.js', import.meta.url).href;
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';

    const moduleUrl = process.argv[1];
    const inventoryModule = await import(moduleUrl);
    const { createObservedIoRecorder } = await import(new URL('./observed-io.js', moduleUrl).href);
    const root = await mkdtemp(join(tmpdir(), 'authority-isolated-private-state-'));
    await mkdir(join(root, 'shared'));
    await writeFile(join(root, 'shared', 'base'), 'base');
    await link(join(root, 'shared', 'base'), join(root, 'shared', 'aux'));
    const observedIo = createObservedIoRecorder();
    const auxiliaryKey = {
      kind: 'AUXILIARY', ownerKind: 'RUN', ownerId: 'RUN-000001', role: 'OUTPUT',
    };
    const base = await inventoryModule.buildAuthorityInventoryBase({
      containedRoot: root,
      observedIo,
      logicalTargets: [
        { key: { kind: 'METADATA' }, relativePath: 'shared/base', nodeType: 'FILE' },
      ],
      archiveTargets: [],
      knownAuxiliaryTargets: [
        { key: auxiliaryKey, relativePath: 'shared/aux', nodeType: 'FILE' },
      ],
    });
    const descriptors = [
      [Map.prototype, 'get', Object.getOwnPropertyDescriptor(Map.prototype, 'get')],
      [Map.prototype, 'set', Object.getOwnPropertyDescriptor(Map.prototype, 'set')],
      [Map.prototype, 'has', Object.getOwnPropertyDescriptor(Map.prototype, 'has')],
      [Map.prototype, Symbol.iterator, Object.getOwnPropertyDescriptor(Map.prototype, Symbol.iterator)],
      [WeakMap.prototype, 'get', Object.getOwnPropertyDescriptor(WeakMap.prototype, 'get')],
      [WeakMap.prototype, 'set', Object.getOwnPropertyDescriptor(WeakMap.prototype, 'set')],
    ];
    let observed;
    try {
      for (const [owner, key, descriptor] of descriptors) {
        Object.defineProperty(owner, key, {
          ...descriptor,
          value() { throw new Error('replaceable collection prototype reached'); },
        });
      }
      const inventory = await inventoryModule.finalizeAuthorityInventory({
        base,
        verifiedReceiptReferences: [
          { receiptId: 'REC-000001', targetKey: auxiliaryKey, relativePath: 'shared/aux' },
        ],
      });
      const counters = observedIo.snapshot();
      observed = {
        entries: inventory.entries.length,
        auxiliaryPath: inventory.getAuxiliary(auxiliaryKey)?.relativePath,
        fileOpens: [...counters.fileOpens],
        directoryReads: [...counters.directoryReads],
      };
    } finally {
      for (const [owner, key, descriptor] of descriptors) {
        Object.defineProperty(owner, key, descriptor);
      }
      await rm(root, { recursive: true, force: true });
    }
    assert.deepEqual(observed, {
      entries: 2,
      auxiliaryPath: 'shared/aux',
      fileOpens: [['shared/base', 1], ['shared/aux', 1]],
      directoryReads: [['shared', 1]],
    });
  `;
  execFileSync(process.execPath, [
    '--input-type=module',
    '--eval',
    script,
    moduleUrl,
  ], { encoding: 'utf8', timeout: 15_000, stdio: 'pipe' });
}

function runIsolatedPrivateArrayPush(): void {
  const moduleUrl = new URL('../inventory.js', import.meta.url).href;
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';

    const moduleUrl = process.argv[1];
    const inventoryModule = await import(moduleUrl);
    const { createObservedIoRecorder } = await import(new URL('./observed-io.js', moduleUrl).href);
    const root = await mkdtemp(join(tmpdir(), 'authority-isolated-private-array-push-'));
    await mkdir(join(root, 'base-parent'));
    await mkdir(join(root, 'aux-parent'));
    await writeFile(join(root, 'base-parent', 'base'), 'base');
    await writeFile(join(root, 'aux-parent', 'aux'), 'aux');
    const observedIo = createObservedIoRecorder();
    const auxiliaryKey = {
      kind: 'AUXILIARY', ownerKind: 'RUN', ownerId: 'RUN-000001', role: 'OUTPUT',
    };
    const base = await inventoryModule.buildAuthorityInventoryBase({
      containedRoot: root,
      observedIo,
      logicalTargets: [
        { key: { kind: 'METADATA' }, relativePath: 'base-parent/base', nodeType: 'FILE' },
      ],
      archiveTargets: [],
      knownAuxiliaryTargets: [
        { key: auxiliaryKey, relativePath: 'aux-parent/aux', nodeType: 'FILE' },
      ],
    });
    const pushDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'push');
    const originalPush = pushDescriptor.value;
    const reflectApply = Reflect.apply;
    const leaked = {
      counter: false,
      directory: false,
      identity: false,
      handles: false,
      anchors: false,
      readonlyMap: false,
      inventory: false,
    };
    let result;
    try {
      Object.defineProperty(Array.prototype, 'push', {
        ...pushDescriptor,
        value: function replacedPush(...items) {
          const receiver = this;
          const first = Array.isArray(receiver) && receiver.length > 0 ? receiver[0] : undefined;
          const item = items[0];
          if (first !== null && typeof first === 'object') {
            if (typeof first.relativePath === 'string' && typeof first.count === 'number') {
              leaked.counter = true;
            }
            if (typeof first.relativePath === 'string' && first.observation?.nodeType === 'DIRECTORY') {
              leaked.directory = true;
            }
            if (typeof first.identity === 'string' && first.observation?.contentHash !== undefined) {
              leaked.identity = true;
            }
          }
          if (item !== null && typeof item === 'object') {
            if (typeof item.fd === 'number' && typeof item.close === 'function') leaked.handles = true;
            if (typeof item.anchoredPath === 'string' && item.handle !== undefined) leaked.anchors = true;
            if (Array.isArray(item) && item.length === 2 && typeof item[0] === 'string') {
              leaked.readonlyMap = true;
            }
            if (typeof item.keyToken === 'string' || typeof item.scope === 'string') {
              leaked.inventory = true;
            }
          }
          return reflectApply(originalPush, receiver, items);
        },
      });
      const inventory = await inventoryModule.finalizeAuthorityInventory({
        base,
        verifiedReceiptReferences: [
          { receiptId: 'REC-000001', targetKey: auxiliaryKey, relativePath: 'aux-parent/aux' },
        ],
      });
      const counters = observedIo.snapshot();
      result = {
        entries: inventory.entries.length,
        fileOpens: [...counters.fileOpens],
        directoryReads: [...counters.directoryReads],
      };
    } finally {
      Object.defineProperty(Array.prototype, 'push', pushDescriptor);
      await rm(root, { recursive: true, force: true });
    }
    assert.deepEqual(leaked, {
      counter: false,
      directory: false,
      identity: false,
      handles: false,
      anchors: false,
      readonlyMap: false,
      inventory: false,
    });
    assert.deepEqual(result, {
      entries: 2,
      fileOpens: [['base-parent/base', 1], ['aux-parent/aux', 1]],
      directoryReads: [['base-parent', 1], ['aux-parent', 1]],
    });
  `;
  execFileSync(process.execPath, [
    '--input-type=module',
    '--eval',
    script,
    moduleUrl,
  ], { encoding: 'utf8', timeout: 15_000, stdio: 'pipe' });
}

function runIsolatedFileRace(race: 'bytes' | 'mode' | 'rename'): void {
  const moduleUrl = new URL('../stable-bytes.js', import.meta.url).href;
  const script = String.raw`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { mkdtemp, rm, writeFile } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';

    const [moduleUrl, race] = process.argv.slice(1);
    const root = await mkdtemp(join(tmpdir(), 'authority-isolated-file-race-'));
    const target = join(root, 'target');
    await writeFile(target, 'before');
    const originalOpen = fs.promises.open;
    let mutated = false;
    fs.promises.open = async function patchedOpen(path, flags, ...rest) {
      const handle = await originalOpen.call(this, path, flags, ...rest);
      if (String(path).endsWith('/target') && (Number(flags) & fs.constants.O_DIRECTORY) === 0) {
        const originalRead = handle.read;
        handle.read = async function patchedRead(...args) {
          const result = await originalRead.apply(handle, args);
          if (!mutated && result.bytesRead === 0) {
            mutated = true;
            if (race === 'bytes') await fs.promises.writeFile(target, 'after!');
            if (race === 'mode') await fs.promises.chmod(target, 0o400);
            if (race === 'rename') {
              await fs.promises.rename(target, join(root, 'displaced'));
              await fs.promises.writeFile(target, 'before');
            }
          }
          return result;
        };
      }
      return handle;
    };
    syncBuiltinESMExports();

    let failure;
    let counters;
    try {
      const { captureStableBytes } = await import(moduleUrl + '?isolated=' + race);
      const { createObservedIoRecorder } = await import(
        new URL('./observed-io.js', moduleUrl).href
      );
      const observedIo = createObservedIoRecorder();
      try {
        await captureStableBytes({ containedRoot: root, relativePath: 'target', observedIo });
      } catch (cause) {
        failure = cause;
      }
      counters = observedIo.snapshot();
    } finally {
      fs.promises.open = originalOpen;
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
    assert.equal(mutated, true);
    assert.match(String(failure), /AUTHORITY_IO_RACE/);
    assert.deepEqual([...counters.fileOpens], [['target', 1]]);
    assert.deepEqual([...counters.stableCaptures], [['target', 1]]);
  `;
  execFileSync(process.execPath, [
    '--input-type=module',
    '--eval',
    script,
    moduleUrl,
    race,
  ], { encoding: 'utf8', timeout: 15_000, stdio: 'pipe' });
}

async function fixture(t: test.TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
