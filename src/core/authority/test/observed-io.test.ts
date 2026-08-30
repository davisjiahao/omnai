import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createObservedIoRecorder } from '../observed-io.js';
import {
  captureStableBytes,
  observeStableDirectory,
} from '../stable-bytes.js';

test('stable readers reject every non-canonical token before opening a file', async (t) => {
  const root = await fixture(t, 'authority-invalid-token-');
  await writeFile(join(root, 'valid.txt'), 'valid');

  const invalid = [
    '', '.', '..', '/etc/passwd', 'C:\\Windows\\system.ini', 'valid.txt/', './valid.txt',
    'nested/../valid.txt', 'nested//valid.txt', 'nested\\valid.txt', 'valid%2etxt',
    'decomposed-e\u0301.txt', 'nul\0suffix', 'control\u0001.txt', '\ud800.txt',
  ];
  for (const relativePath of invalid) {
    const observedIo = createObservedIoRecorder();
    await assert.rejects(
      captureStableBytes({ containedRoot: root, relativePath, observedIo }),
      /AUTHORITY_IO_PATH_INVALID/,
      relativePath,
    );
    assert.deepEqual([...observedIo.snapshot().fileOpens], []);
    assert.deepEqual([...observedIo.snapshot().stableCaptures], []);
  }
});

test('stable readers reject accessors and extra request keys without executing them', async (t) => {
  const root = await fixture(t, 'authority-request-shape-');
  await writeFile(join(root, 'target'), 'target');
  const observedIo = createObservedIoRecorder();
  let accessorCalled = false;
  const accessorRequest = {
    containedRoot: root,
    observedIo,
  } as Record<string, unknown>;
  Object.defineProperty(accessorRequest, 'relativePath', {
    enumerable: true,
    get() {
      accessorCalled = true;
      return 'target';
    },
  });

  await assert.rejects(
    captureStableBytes(accessorRequest as Parameters<typeof captureStableBytes>[0]),
    /AUTHORITY_IO_REQUEST_INVALID/,
  );
  await assert.rejects(captureStableBytes({
    containedRoot: root,
    relativePath: 'target',
    observedIo,
    extra: true,
  } as Parameters<typeof captureStableBytes>[0]), /AUTHORITY_IO_REQUEST_INVALID/);
  await assert.rejects(observeStableDirectory({
    containedRoot: root,
    relativePath: 'target',
    observedIo,
    maximumBytes: 1,
  } as Parameters<typeof observeStableDirectory>[0]), /AUTHORITY_IO_REQUEST_INVALID/);

  assert.equal(accessorCalled, false);
  assert.deepEqual([...observedIo.snapshot().fileOpens], []);
  assert.deepEqual([...observedIo.snapshot().stableCaptures], []);
  assert.deepEqual([...observedIo.snapshot().directoryReads], []);
});

test('stable readers reject transparent, throwing, and revoked request proxies without touching traps', async (t) => {
  const root = await fixture(t, 'authority-request-proxy-');
  await writeFile(join(root, 'target'), 'target');

  for (const kind of ['transparent', 'throwing', 'revoked'] as const) {
    const observedIo = createObservedIoRecorder();
    const target = { containedRoot: root, relativePath: 'target', observedIo };
    let trapCount = 0;
    const handler: ProxyHandler<typeof target> = {
      get(targetValue, key, receiver) {
        trapCount += 1;
        if (kind === 'throwing') throw new Error('proxy trap must not run');
        return Reflect.get(targetValue, key, receiver);
      },
      getOwnPropertyDescriptor(targetValue, key) {
        trapCount += 1;
        if (kind === 'throwing') throw new Error('proxy trap must not run');
        return Reflect.getOwnPropertyDescriptor(targetValue, key);
      },
      getPrototypeOf(targetValue) {
        trapCount += 1;
        if (kind === 'throwing') throw new Error('proxy trap must not run');
        return Reflect.getPrototypeOf(targetValue);
      },
      ownKeys(targetValue) {
        trapCount += 1;
        if (kind === 'throwing') throw new Error('proxy trap must not run');
        return Reflect.ownKeys(targetValue);
      },
    };
    let request: typeof target;
    if (kind === 'revoked') {
      const revocable = Proxy.revocable(target, handler);
      request = revocable.proxy;
      revocable.revoke();
    } else {
      request = new Proxy(target, handler);
    }

    await assert.rejects(
      captureStableBytes(request),
      /AUTHORITY_IO_REQUEST_INVALID/,
    );
    assert.equal(trapCount, 0, kind);
    assert.deepEqual([...observedIo.snapshot().fileOpens], []);
    assert.deepEqual([...observedIo.snapshot().stableCaptures], []);
    assert.deepEqual([...observedIo.snapshot().directoryReads], []);
  }
});

test('file and directory readers reject final and nested symlinks without escaping', async (t) => {
  const root = await fixture(t, 'authority-symlink-root-');
  const outside = await fixture(t, 'authority-symlink-outside-');
  await mkdir(join(root, 'safe'));
  await writeFile(join(root, 'safe', 'inside.txt'), 'inside');
  await writeFile(join(outside, 'secret.txt'), 'secret');
  await symlink(join(outside, 'secret.txt'), join(root, 'final-file'));
  await symlink(outside, join(root, 'final-directory'));
  await symlink(outside, join(root, 'borrowed-parent'));

  for (const relativePath of ['final-file', 'borrowed-parent/secret.txt']) {
    await assert.rejects(
      captureStableBytes({
        containedRoot: root,
        relativePath,
        observedIo: createObservedIoRecorder(),
      }),
      /AUTHORITY_IO_(?:CONTAINMENT|NODE_TYPE)/,
    );
  }
  for (const relativePath of ['final-directory', 'borrowed-parent']) {
    await assert.rejects(
      observeStableDirectory({
        containedRoot: root,
        relativePath,
        observedIo: createObservedIoRecorder(),
      }),
      /AUTHORITY_IO_(?:CONTAINMENT|NODE_TYPE)/,
    );
  }
});

test('an opened nested component cannot be swapped for an escaping symlink', () => {
  runIsolatedObservedRace('parent-swap');
});

test('a FIFO is rejected promptly as non-regular, counted once, and never retried', async (t) => {
  const root = await fixture(t, 'authority-fifo-');
  execFileSync('mkfifo', [join(root, 'pipe')]);
  const observedIo = createObservedIoRecorder();
  const started = Date.now();

  await assert.rejects(
    captureStableBytes({ containedRoot: root, relativePath: 'pipe', observedIo }),
    /AUTHORITY_IO_NODE_TYPE/,
  );

  assert.ok(Date.now() - started < 500, 'O_NONBLOCK must prevent a FIFO open from waiting for a writer');
  assert.deepEqual([...observedIo.snapshot().fileOpens], [['pipe', 1]]);
  assert.deepEqual([...observedIo.snapshot().stableCaptures], [['pipe', 1]]);
});

test('directory observations use UTF-16 code-unit order and frozen values', async (t) => {
  const root = await fixture(t, 'authority-directory-order-');
  await mkdir(join(root, 'entries'));
  const names = ['z', '\ue000', '\ud800\udc00', 'a'];
  for (const name of names) await writeFile(join(root, 'entries', name), name);
  await chmod(join(root, 'entries'), 0o750);
  const observedIo = createObservedIoRecorder();

  const observation = await observeStableDirectory({
    containedRoot: root,
    relativePath: 'entries',
    observedIo,
  });

  assert.deepEqual(observation.entries, ['a', 'z', '\ud800\udc00', '\ue000']);
  assert.deepEqual(observation.typedEntries, [
    { name: 'a', nodeType: 'FILE' },
    { name: 'z', nodeType: 'FILE' },
    { name: '\ud800\udc00', nodeType: 'FILE' },
    { name: '\ue000', nodeType: 'FILE' },
  ]);
  assert.equal(observation.mode, 0o750);
  assert.equal(Object.isFrozen(observation), true);
  assert.equal(Object.isFrozen(observation.entries), true);
  assert.equal(Object.isFrozen(observation.typedEntries), true);
  assert.equal(Object.isFrozen(observation.typedEntries[0]), true);
  assert.throws(() => (observation.entries as string[]).push('mutated'), TypeError);
  assert.throws(() => (observation.typedEntries as unknown[]).push({}), TypeError);
  assert.deepEqual([...observedIo.snapshot().directoryReads], [['entries', 1]]);
});

test('directory inventory hash binds each name to its observed node type', async (t) => {
  const root = await fixture(t, 'authority-directory-node-type-');
  await mkdir(join(root, 'entries'));
  await writeFile(join(root, 'entries', 'same-name'), 'file');

  const fileObservation = await observeStableDirectory({
    containedRoot: root,
    relativePath: 'entries',
    observedIo: createObservedIoRecorder(),
  });
  await rm(join(root, 'entries', 'same-name'));
  await mkdir(join(root, 'entries', 'same-name'));
  const directoryObservation = await observeStableDirectory({
    containedRoot: root,
    relativePath: 'entries',
    observedIo: createObservedIoRecorder(),
  });
  await rm(join(root, 'entries', 'same-name'), { recursive: true });
  await symlink('missing-target', join(root, 'entries', 'same-name'));
  const symlinkObservation = await observeStableDirectory({
    containedRoot: root,
    relativePath: 'entries',
    observedIo: createObservedIoRecorder(),
  });

  assert.deepEqual(fileObservation.entries, ['same-name']);
  assert.deepEqual(directoryObservation.entries, ['same-name']);
  assert.deepEqual(symlinkObservation.entries, ['same-name']);
  assert.equal(fileObservation.typedEntries[0]?.nodeType, 'FILE');
  assert.equal(directoryObservation.typedEntries[0]?.nodeType, 'DIRECTORY');
  assert.equal(symlinkObservation.typedEntries[0]?.nodeType, 'SYMBOLIC_LINK');
  assert.notEqual(fileObservation.inventoryHash, directoryObservation.inventoryHash);
  assert.notEqual(fileObservation.inventoryHash, symlinkObservation.inventoryHash);
  assert.notEqual(directoryObservation.inventoryHash, symlinkObservation.inventoryHash);
});

test('directory decoding preserves a leading U+FEFF as part of the entry name', async (t) => {
  // 回归说明：TextDecoder 默认吞掉 UTF-8 BOM；目录名中的 U+FEFF 是身份数据，不能被当成文件 BOM。
  const root = await fixture(t, 'authority-directory-leading-feff-');
  await mkdir(join(root, 'entries'));
  await writeFile(join(root, 'entries', '\uFEFFa'), 'payload');
  const before = await observeStableDirectory({
    containedRoot: root,
    relativePath: 'entries',
    observedIo: createObservedIoRecorder(),
  });
  assert.deepEqual(before.typedEntries, [{ name: '\uFEFFa', nodeType: 'FILE' }]);

  await rename(join(root, 'entries', '\uFEFFa'), join(root, 'entries', 'a'));
  const after = await observeStableDirectory({
    containedRoot: root,
    relativePath: 'entries',
    observedIo: createObservedIoRecorder(),
  });
  assert.notEqual(before.inventoryHash, after.inventoryHash);
});

test('ordinary directory observation records a FIFO node type in one real read', async (t) => {
  const root = await fixture(t, 'authority-directory-fifo-entry-');
  await mkdir(join(root, 'entries'));
  execFileSync('mkfifo', [join(root, 'entries', 'pipe')]);
  const observedIo = createObservedIoRecorder();
  const observation = await observeStableDirectory({
    containedRoot: root,
    relativePath: 'entries',
    observedIo,
  });

  assert.deepEqual(observation.typedEntries, [{ name: 'pipe', nodeType: 'FIFO' }]);
  assert.deepEqual([...observedIo.snapshot().directoryReads], [['entries', 1]]);
});

for (const race of ['entries', 'mode', 'rename'] as const) {
  test(`directory observation rejects a deterministic ${race} race without retry`, () => {
    runIsolatedObservedRace(race);
  });
}

test('counter snapshots are real ordered copies and all three maps are runtime immutable', async (t) => {
  const root = await fixture(t, 'authority-counter-map-');
  await mkdir(join(root, 'b'));
  await mkdir(join(root, 'a'));
  await writeFile(join(root, 'b', 'two'), 'two');
  await writeFile(join(root, 'a', 'one'), 'one');
  const observedIo = createObservedIoRecorder();

  await captureStableBytes({ containedRoot: root, relativePath: 'b/two', observedIo });
  const firstSnapshot = observedIo.snapshot();
  await captureStableBytes({ containedRoot: root, relativePath: 'a/one', observedIo });
  await observeStableDirectory({ containedRoot: root, relativePath: 'b', observedIo });
  await observeStableDirectory({ containedRoot: root, relativePath: 'a', observedIo });
  const finalSnapshot = observedIo.snapshot();

  assert.deepEqual([...firstSnapshot.fileOpens], [['b/two', 1]]);
  assert.deepEqual([...finalSnapshot.fileOpens], [['b/two', 1], ['a/one', 1]]);
  assert.deepEqual([...finalSnapshot.stableCaptures], [['b/two', 1], ['a/one', 1]]);
  assert.deepEqual([...finalSnapshot.directoryReads], [['b', 1], ['a', 1]]);
  assert.equal(Object.isFrozen(finalSnapshot), true);

  for (const map of [
    finalSnapshot.fileOpens,
    finalSnapshot.directoryReads,
    finalSnapshot.stableCaptures,
  ]) {
    assert.equal(Object.isFrozen(map), true);
    assert.equal((map as unknown as { set?: unknown }).set, undefined);
    assert.throws(
      () => Map.prototype.set.call(map, 'forged', 99),
      TypeError,
    );
    assert.deepEqual([...map].some(([path]) => path === 'forged'), false);
  }
});

test('counter snapshots do not expose private entry arrays to a replaced Object.freeze', { concurrency: false }, async (t) => {
  // 回归说明：若 snapshot 实时查找 Object.freeze，hook 可取得 pair backing 并改写已认证计数。
  const root = await fixture(t, 'authority-counter-freeze-');
  await writeFile(join(root, 'payload'), 'payload');
  const observedIo = createObservedIoRecorder();
  await captureStableBytes({ containedRoot: root, relativePath: 'payload', observedIo });
  const descriptor = Object.getOwnPropertyDescriptor(Object, 'freeze');
  assert.ok(descriptor);
  const intercepted: unknown[] = [];
  let snapshot;
  try {
    Object.defineProperty(Object, 'freeze', {
      ...descriptor,
      value(value: unknown) {
        intercepted.push(value);
        return value;
      },
    });
    snapshot = observedIo.snapshot();
  } finally {
    Object.defineProperty(Object, 'freeze', descriptor);
  }
  for (let index = 0; index < intercepted.length; index += 1) {
    const value = intercepted[index];
    if (Array.isArray(value) && value.length === 2 && value[0] === 'payload') {
      Reflect.set(value, '1', 99);
    }
  }
  assert.equal(intercepted.length, 0);
  assert.equal(snapshot.fileOpens.get('payload'), 1);
  assert.equal(snapshot.stableCaptures.get('payload'), 1);
  assert.equal(Object.isFrozen(snapshot), true);
});

test('counter snapshots do not consult mutable Map prototype methods after construction', async (t) => {
  const root = await fixture(t, 'authority-counter-map-prototype-');
  await writeFile(join(root, 'target'), 'target');
  const observedIo = createObservedIoRecorder();
  await captureStableBytes({ containedRoot: root, relativePath: 'target', observedIo });
  const snapshot = observedIo.snapshot();
  const originalGet = Object.getOwnPropertyDescriptor(Map.prototype, 'get')!;
  const originalHas = Object.getOwnPropertyDescriptor(Map.prototype, 'has')!;
  const originalIterator = Object.getOwnPropertyDescriptor(Map.prototype, Symbol.iterator)!;

  try {
    Object.defineProperty(Map.prototype, 'get', {
      ...originalGet,
      value() { return 999; },
    });
    Object.defineProperty(Map.prototype, 'has', {
      ...originalHas,
      value() { return true; },
    });
    Object.defineProperty(Map.prototype, Symbol.iterator, {
      ...originalIterator,
      value: function* forgedIterator() { yield ['forged', 99]; },
    });

    assert.equal(snapshot.fileOpens.get('target'), 1);
    assert.equal(snapshot.fileOpens.has('missing'), false);
    assert.deepEqual([...snapshot.fileOpens], [['target', 1]]);
  } finally {
    Object.defineProperty(Map.prototype, 'get', originalGet);
    Object.defineProperty(Map.prototype, 'has', originalHas);
    Object.defineProperty(Map.prototype, Symbol.iterator, originalIterator);
  }
});

test('counter snapshots call forEach callbacks with ordinary Map Call semantics', async (t) => {
  const root = await fixture(t, 'authority-counter-map-foreach-');
  await writeFile(join(root, 'target'), 'target');
  const observedIo = createObservedIoRecorder();
  await captureStableBytes({ containedRoot: root, relativePath: 'target', observedIo });
  const fileOpens = observedIo.snapshot().fileOpens;
  const thisArg = Object.freeze({ label: 'receiver' });
  const visits: Array<readonly [number, string, ReadonlyMap<string, number>]> = [];
  function callback(
    this: unknown,
    value: number,
    key: string,
    map: ReadonlyMap<string, number>,
  ): void {
    assert.equal(this, thisArg);
    visits.push(Object.freeze([value, key, map]));
  }
  Object.defineProperty(callback, 'call', {
    configurable: true,
    value() { throw new Error('callable own call property must be ignored'); },
  });

  fileOpens.forEach(callback, thisArg);

  assert.deepEqual(visits, [Object.freeze([1, 'target', fileOpens])]);
});

test('observed I/O module exposes no standalone counter mutation entry point', async () => {
  const observedIoModule: Record<string, unknown> = await import('../observed-io.js');
  assert.equal(observedIoModule.recordObservedIoInvocation, undefined);
});

test('all descriptors close after successful and failing reads', async (t) => {
  if (constants.O_NOFOLLOW === undefined) return;
  const root = await fixture(t, 'authority-fd-cleanup-');
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested', 'file'), 'bytes');
  await symlink(join(root, 'nested', 'file'), join(root, 'nested', 'link'));
  const baseline = await descriptorCount();

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await captureStableBytes({
      containedRoot: root,
      relativePath: 'nested/file',
      observedIo: createObservedIoRecorder(),
    });
    await assert.rejects(captureStableBytes({
      containedRoot: root,
      relativePath: 'nested/link',
      observedIo: createObservedIoRecorder(),
    }));
    await observeStableDirectory({
      containedRoot: root,
      relativePath: 'nested',
      observedIo: createObservedIoRecorder(),
    });
  }

  assert.equal(await descriptorCount(), baseline);
});

async function fixture(t: test.TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function descriptorCount(): Promise<number> {
  return (await readdir('/proc/self/fd')).length;
}

function runIsolatedObservedRace(
  scenario: 'parent-swap' | 'entries' | 'mode' | 'rename',
): void {
  const moduleUrl = new URL('../stable-bytes.js', import.meta.url).href;
  const script = String.raw`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { mkdtemp, rm, writeFile } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';

    const [moduleUrl, scenario] = process.argv.slice(1);
    const root = await mkdtemp(join(tmpdir(), 'authority-isolated-observed-race-'));
    const outside = await mkdtemp(join(tmpdir(), 'authority-isolated-observed-outside-'));
    const directory = join(root, 'entries');
    await fs.promises.mkdir(join(root, 'nested'));
    await fs.promises.mkdir(directory);
    await writeFile(join(root, 'nested', 'target'), 'contained');
    await writeFile(join(outside, 'target'), 'outside');
    await writeFile(join(directory, 'one'), 'one');
    const originalOpen = fs.promises.open;
    const originalReaddir = fs.promises.readdir;
    let mutated = false;
    fs.promises.open = async function patchedOpen(path, flags, ...rest) {
      const handle = await originalOpen.call(this, path, flags, ...rest);
      if (scenario === 'parent-swap'
        && String(path).endsWith('/target')
        && (Number(flags) & fs.constants.O_DIRECTORY) === 0) {
        const originalRead = handle.read;
        handle.read = async function patchedRead(...args) {
          const result = await originalRead.apply(handle, args);
          if (!mutated && result.bytesRead === 0) {
            mutated = true;
            await fs.promises.rename(join(root, 'nested'), join(root, 'displaced'));
            await fs.promises.symlink(outside, join(root, 'nested'));
          }
          return result;
        };
      }
      return handle;
    };
    fs.promises.readdir = async function patchedReaddir(path, options) {
      const result = await originalReaddir.call(this, path, options);
      if (scenario !== 'parent-swap' && !mutated) {
        mutated = true;
        if (scenario === 'entries') await fs.promises.writeFile(join(directory, 'two'), 'two');
        if (scenario === 'mode') await fs.promises.chmod(directory, 0o700);
        if (scenario === 'rename') {
          await fs.promises.rename(directory, join(root, 'displaced'));
          await fs.promises.mkdir(directory);
          await fs.promises.writeFile(join(directory, 'one'), 'one');
        }
      }
      return result;
    };
    syncBuiltinESMExports();

    let failure;
    let counters;
    try {
      const stable = await import(moduleUrl);
      const { createObservedIoRecorder } = await import(new URL('./observed-io.js', moduleUrl).href);
      const observedIo = createObservedIoRecorder();
      try {
        if (scenario === 'parent-swap') {
          await stable.captureStableBytes({
            containedRoot: root,
            relativePath: 'nested/target',
            observedIo,
          });
        } else {
          await stable.observeStableDirectory({
            containedRoot: root,
            relativePath: 'entries',
            observedIo,
          });
        }
      } catch (cause) {
        failure = cause;
      }
      counters = observedIo.snapshot();
    } finally {
      fs.promises.open = originalOpen;
      fs.promises.readdir = originalReaddir;
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
    assert.equal(mutated, true);
    assert.match(String(failure), /AUTHORITY_IO_RACE/);
    if (scenario === 'parent-swap') {
      assert.deepEqual([...counters.fileOpens], [['nested/target', 1]]);
      assert.deepEqual([...counters.stableCaptures], [['nested/target', 1]]);
    } else {
      assert.deepEqual([...counters.directoryReads], [['entries', 1]]);
    }
  `;
  execFileSync(process.execPath, [
    '--input-type=module',
    '--eval',
    script,
    moduleUrl,
    scenario,
  ], { encoding: 'utf8', timeout: 15_000, stdio: 'pipe' });
}
