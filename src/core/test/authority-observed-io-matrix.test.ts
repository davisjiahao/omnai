import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cp, mkdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { inspectCurrentSource } from '../public/source-inspection.js';
import { buildChangeBaseContext, sealForNewMutation } from '../authority/context.js';
import { resolveCurrentSource } from '../source/resolver.js';
import { parseRunId } from '../../domain/scalars.js';
import { task5Fixture } from './task5-fixture.js';

test('public source inspection resolves an artifact from the real project and Change roots', async (t) => {
  const fixture = await task5Fixture(t, 'task5-public-inspect-');

  const inspected = await inspectCurrentSource(fixture.repoRoot, 'CHG-0001', {
    changeId: 'CHG-0001',
    revisionId: 'REV-0001',
    kind: 'artifact',
    path: 'domain.md',
  });

  assert.deepEqual(new TextDecoder().decode(inspected.copyCanonicalBytes()), 'real artifact bytes\n');
  assert.equal(inspected.sourceRef.kind, 'artifact');
  assert.deepEqual(Reflect.ownKeys(inspected).sort(), [
    'byteLength', 'copyCanonicalBytes', 'sourceRef',
  ]);
  assert.equal('provider' in inspected, false);
  assert.equal('repositoryRoot' in inspected, false);
  assert.equal('recorder' in inspected, false);
});

test('public source inspection retains the builder-authenticated Change root through capture', { concurrency: false }, async (t) => {
  const fixture = await task5Fixture(t, 'task5-public-inspect-root-race-');
  const replacement = join(fixture.repoRoot, 'replacement-public-inspect-root');
  const displaced = join(fixture.repoRoot, 'displaced-public-inspect-root');
  await cp(fixture.changeRoot, replacement, { recursive: true });
  await writeFile(join(replacement, 'domain.md'), 'replacement public artifact\n');

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
      inspectCurrentSource(fixture.repoRoot, 'CHG-0001', {
        changeId: 'CHG-0001', revisionId: 'REV-0001', kind: 'artifact', path: 'domain.md',
      }),
      /AUTHORITY_IO_RACE|AUTHORITY_IO_CONTAINMENT/,
    );
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
  }
  assert.equal(wrapped, true);
  assert.equal(attacked, true);
});

test('real Change discovery and inventory observe each authority directory once', async (t) => {
  const fixture = await task5Fixture(t, 'task5-observed-layout-');
  const base = await buildChangeBaseContext(fixture.repoRoot, 'CHG-0001');
  const context = await sealForNewMutation(base, async (session) => {
    await resolveCurrentSource(session, {
      changeId: 'CHG-0001', revisionId: 'REV-0001', kind: 'artifact', path: 'domain.md',
    });
  });

  assert.deepEqual([...context.observedIo.directoryReads], [
    ['changes', 1],
    ['changes/CHG-0001-real-layout', 1],
    ['decisions', 1],
    ['evidence', 1],
    ['runs', 1],
    ['revisions', 1],
  ]);
  assert.deepEqual([...context.observedIo.fileOpens], [
    ['workflow.lock.yaml', 1],
    ['change.yaml', 1],
    ['decisions/DEC-0001.yaml', 1],
    ['evidence/EVD-000001.yaml', 1],
    ['flow.yaml', 1],
    ['progress.jsonl', 1],
    ['runs/RUN-000001.yaml', 1],
    ['tasks.yaml', 1],
    ['domain.md', 1],
  ]);
  assert.equal(context.requireRun(parseRunId('RUN-000001')).runId, 'RUN-000001');
});

test('real Change context resolves all six current SourceRef kinds in request order', async (t) => {
  const fixture = await task5Fixture(t, 'task5-real-six-source-kinds-');
  const resolvedKinds: string[] = [];
  const base = await buildChangeBaseContext(fixture.repoRoot, 'CHG-0001');
  const context = await sealForNewMutation(base, async (session) => {
    for (const locator of [
      { changeId: 'CHG-0001', revisionId: 'REV-0001', kind: 'artifact', path: 'domain.md' },
      { changeId: 'CHG-0001', revisionId: 'REV-0001', kind: 'code', path: 'src/current.ts' },
      { changeId: 'CHG-0001', revisionId: 'REV-0001', kind: 'policy', scenarioId: 'small-feature' },
      { changeId: 'CHG-0001', revisionId: 'REV-0001', kind: 'evidence', evidenceId: 'EVD-000001' },
      { changeId: 'CHG-0001', revisionId: 'REV-0001', kind: 'decision', decisionId: 'DEC-0001' },
      { changeId: 'CHG-0001', revisionId: 'REV-0001', kind: 'task', taskId: 'TASK-001' },
    ]) {
      const resolved = await resolveCurrentSource(session, locator);
      resolvedKinds.push(resolved.sourceRef.kind);
    }
  });

  assert.deepEqual(resolvedKinds, ['artifact', 'code', 'policy', 'evidence', 'decision', 'task']);
  assert.deepEqual([...context.observedIo.fileOpens].slice(-2), [
    ['domain.md', 1],
    ['src/current.ts', 1],
  ]);
});

test('code source discovery does not observe live String framing methods after await', { concurrency: false }, async (t) => {
  const fixture = await task5Fixture(t, 'task5-code-string-intrinsics-');
  const originalOpen = fs.promises.open;
  const originalEndsWith = String.prototype.endsWith;
  const originalIncludes = String.prototype.includes;
  const originalSlice = String.prototype.slice;
  const originalStartsWith = String.prototype.startsWith;
  let poisonInstalled = false;
  const liveStringCalls = { endsWith: 0, includes: 0, slice: 0, startsWith: 0 };
  const isGitFramingValue = (value: string): boolean => value === `${fixture.repoRoot}\n`
    || Reflect.apply(originalIncludes, value, [fixture.change.directoryName]) as boolean;
  const installPoison = (): void => {
    if (poisonInstalled) return;
    poisonInstalled = true;
    String.prototype.endsWith = function poisonedEndsWith(
      this: string,
      searchString: string,
      endPosition?: number,
    ): boolean {
      if (isGitFramingValue(String(this))) {
        liveStringCalls.endsWith += 1;
        throw new Error('TASK5_LIVE_CODE_STRING_ENDS_WITH_POISON');
      }
      return Reflect.apply(originalEndsWith, this, [searchString, endPosition]) as boolean;
    };
    String.prototype.includes = function poisonedIncludes(
      this: string,
      searchString: string,
      position?: number,
    ): boolean {
      if (isGitFramingValue(String(this))) {
        liveStringCalls.includes += 1;
        throw new Error('TASK5_LIVE_CODE_STRING_INCLUDES_POISON');
      }
      return Reflect.apply(originalIncludes, this, [searchString, position]) as boolean;
    };
    String.prototype.slice = function poisonedSlice(this: string, start?: number, end?: number): string {
      if (isGitFramingValue(String(this))) liveStringCalls.slice += 1;
      return Reflect.apply(originalSlice, this, [start, end]) as string;
    };
    String.prototype.startsWith = function poisonedStartsWith(
      this: string,
      searchString: string,
      position?: number,
    ): boolean {
      if (isGitFramingValue(String(this))) liveStringCalls.startsWith += 1;
      return Reflect.apply(originalStartsWith, this, [searchString, position]) as boolean;
    };
  };
  fs.promises.open = async function patchedOpen(this: typeof fs.promises, path, flags, ...rest) {
    const handle = await originalOpen.call(this, path, flags, ...rest);
    if (!poisonInstalled
      && Reflect.apply(originalEndsWith, String(path), ['/workflow.lock.yaml'])) installPoison();
    return handle;
  } as typeof fs.promises.open;
  syncBuiltinESMExports();
  try {
    const inspected = await inspectCurrentSource(fixture.repoRoot, 'CHG-0001', {
      changeId: 'CHG-0001', revisionId: 'REV-0001', kind: 'code', path: 'src/current.ts',
    });
    assert.equal(inspected.sourceRef.kind, 'code');
  } finally {
    fs.promises.open = originalOpen;
    String.prototype.endsWith = originalEndsWith;
    String.prototype.includes = originalIncludes;
    String.prototype.slice = originalSlice;
    String.prototype.startsWith = originalStartsWith;
    syncBuiltinESMExports();
  }
  assert.equal(poisonInstalled, true);
  assert.deepEqual(liveStringCalls, { endsWith: 0, includes: 0, slice: 0, startsWith: 0 });
});

test('real Change discovery fails closed on zero or multiple matching directories', async (t) => {
  await t.test('missing', async (t) => {
    const fixture = await task5Fixture(t, 'task5-missing-change-');
    await rename(
      fixture.changeRoot,
      join(fixture.projectAuthorityRoot, 'changes', 'REMOVED-real-layout'),
    );

    await assert.rejects(
      buildChangeBaseContext(fixture.repoRoot, 'CHG-0001'),
      /AUTHORITY_CONTEXT_CHANGE_MISSING/,
    );
  });

  await t.test('ambiguous', async (t) => {
    const fixture = await task5Fixture(t, 'task5-ambiguous-change-');
    await mkdir(join(fixture.projectAuthorityRoot, 'changes', 'CHG-0001-duplicate'));

    await assert.rejects(
      buildChangeBaseContext(fixture.repoRoot, 'CHG-0001'),
      /AUTHORITY_CONTEXT_CHANGE_AMBIGUOUS/,
    );
  });
});

test('real Change root is bound to its authenticated metadata slug', async (t) => {
  const fixture = await task5Fixture(t, 'task5-directory-binding-');
  const mismatched = join(fixture.projectAuthorityRoot, 'changes', 'CHG-0001-other-slug');
  await rename(fixture.changeRoot, mismatched);

  await assert.rejects(
    buildChangeBaseContext(fixture.repoRoot, 'CHG-0001'),
    /AUTHORITY_CONTEXT_CHANGE_DIRECTORY_MISMATCH/,
  );
});

test('real Change inventory rejects required and recognized layout mismatches', async (t) => {
  await t.test('missing metadata', async (t) => {
    const fixture = await task5Fixture(t, 'task5-missing-metadata-');
    await unlink(join(fixture.changeRoot, 'change.yaml'));

    await assert.rejects(
      buildChangeBaseContext(fixture.repoRoot, 'CHG-0001'),
      /AUTHORITY_CONTEXT_REQUIRED_TARGET_MISSING/,
    );
  });

  await t.test('optional file has the wrong node type', async (t) => {
    const fixture = await task5Fixture(t, 'task5-wrong-node-type-');
    await rm(join(fixture.changeRoot, 'tasks.yaml'));
    await mkdir(join(fixture.changeRoot, 'tasks.yaml'));

    await assert.rejects(
      buildChangeBaseContext(fixture.repoRoot, 'CHG-0001'),
      /AUTHORITY_CONTEXT_LAYOUT_MISMATCH/,
    );
  });

  await t.test('unknown Decision filename', async (t) => {
    const fixture = await task5Fixture(t, 'task5-unknown-decision-');
    await writeFile(join(fixture.changeRoot, 'decisions', 'DEC-0002.txt'), 'not authority YAML\n');

    await assert.rejects(
      buildChangeBaseContext(fixture.repoRoot, 'CHG-0001'),
      /AUTHORITY_CONTEXT_RECOGNIZED_TARGET_INVALID/,
    );
  });

  await t.test('unowned run target', async (t) => {
    const fixture = await task5Fixture(t, 'task5-unowned-run-');
    await writeFile(join(fixture.changeRoot, 'runs', 'RUN-000002.txt'), 'not a final manifest\n');

    await assert.rejects(
      buildChangeBaseContext(fixture.repoRoot, 'CHG-0001'),
      /AUTHORITY_CONTEXT_RECOGNIZED_TARGET_INVALID/,
    );
  });
});

test('real Change builder rejects whole-root replacement after discovery', { concurrency: false }, async (t) => {
  const fixture = await task5Fixture(t, 'task5-change-root-race-');
  const replacement = join(fixture.repoRoot, 'replacement-change-root');
  const displaced = join(fixture.repoRoot, 'displaced-change-root');
  await cp(fixture.changeRoot, replacement, { recursive: true });
  await writeFile(join(replacement, 'domain.md'), 'replacement artifact bytes\n');

  const originalOpen = fs.promises.open;
  let attacked = false;
  fs.promises.open = async function patchedOpen(this: typeof fs.promises, path, flags, ...rest) {
    if (!attacked && String(path).endsWith('/workflow.lock.yaml')) {
      attacked = true;
      await rename(fixture.changeRoot, displaced);
      await rename(replacement, fixture.changeRoot);
    }
    return originalOpen.call(this, path, flags, ...rest);
  } as typeof fs.promises.open;
  syncBuiltinESMExports();
  let failure: unknown;
  try {
    try {
      await buildChangeBaseContext(fixture.repoRoot, 'CHG-0001');
    } catch (cause) {
      failure = cause;
    }
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
  }
  assert.equal(attacked, true);
  assert.match(String(failure), /AUTHORITY_IO_RACE|AUTHORITY_IO_CONTAINMENT/);
});

test('collection observation and child capture retain one directory identity', { concurrency: false }, async (t) => {
  const fixture = await task5Fixture(t, 'task5-collection-child-race-');
  const decisionPath = join(fixture.changeRoot, 'decisions', 'DEC-0001.yaml');
  const displaced = join(fixture.changeRoot, 'decisions', 'DEC-0001.displaced.yaml');
  const replacement = join(fixture.repoRoot, 'replacement-decision.yaml');
  await cp(decisionPath, replacement);
  await writeFile(replacement, (await fs.promises.readFile(replacement, 'utf8')).replace(
    'Decision DEC-0001',
    'Replacement DEC-0001',
  ));

  const originalOpen = fs.promises.open;
  const originalReaddir = fs.promises.readdir;
  let attacked = false;
  let decisionOpens = 0;
  let decisionObserved = false;
  fs.promises.open = async function patchedOpen(this: typeof fs.promises, path, flags, ...rest) {
    if (String(path) === fixture.changeRoot && decisionObserved && !attacked) {
      attacked = true;
      await rename(decisionPath, displaced);
      await rename(replacement, decisionPath);
    }
    if (String(path).endsWith('/DEC-0001.yaml')) {
      decisionOpens += 1;
    }
    return originalOpen.call(this, path, flags, ...rest);
  } as typeof fs.promises.open;
  fs.promises.readdir = async function patchedReaddir(this: typeof fs.promises, path, options) {
    const result = await originalReaddir.call(this, path, options as never);
    const rows = result as unknown as readonly { name?: Uint8Array | string }[];
    if (rows.some((entry) => String(entry.name).includes('68,69,67,45,48,48,48,49'))
      || rows.some((entry) => String(entry.name) === 'DEC-0001.yaml')) {
      decisionObserved = true;
    }
    return result as never;
  } as typeof fs.promises.readdir;
  syncBuiltinESMExports();
  let failure: unknown;
  try {
    try {
      await buildChangeBaseContext(fixture.repoRoot, 'CHG-0001');
    } catch (cause) {
      failure = cause;
    }
  } finally {
    fs.promises.open = originalOpen;
    fs.promises.readdir = originalReaddir;
    syncBuiltinESMExports();
  }
  assert.equal(attacked, true);
  assert.equal(decisionOpens, 1);
  assert.match(String(failure), /AUTHORITY_IO_RACE|AUTHORITY_IO_CONTAINMENT/);
});

test('collection descriptor cleanup attempts every retained anchor after one close failure', { concurrency: false }, async (t) => {
  const fixture = await task5Fixture(t, 'task5-collection-close-cleanup-');
  const originalOpen = fs.promises.open;
  const closeAttempts = { decisions: 0, evidence: 0, runs: 0 };
  fs.promises.open = async function patchedOpen(this: typeof fs.promises, path, flags, ...rest) {
    const handle = await originalOpen.call(this, path, flags, ...rest);
    const value = String(path);
    const collection = value === join(fixture.changeRoot, 'decisions') ? 'decisions'
      : value === join(fixture.changeRoot, 'evidence') ? 'evidence'
        : value === join(fixture.changeRoot, 'runs') ? 'runs'
          : undefined;
    if (collection !== undefined) {
      const originalClose = handle.close.bind(handle);
      handle.close = async (): Promise<void> => {
        closeAttempts[collection] += 1;
        await originalClose();
        if (collection === 'runs') throw new Error('TASK5_COLLECTION_CLOSE_FAILURE');
      };
    }
    return handle;
  } as typeof fs.promises.open;
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      buildChangeBaseContext(fixture.repoRoot, 'CHG-0001'),
      /TASK5_COLLECTION_CLOSE_FAILURE/,
    );
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
  }
  assert.deepEqual(closeAttempts, { decisions: 1, evidence: 1, runs: 1 });
});

test('Change-root identity remains bound from base return through source capture', async (t) => {
  const fixture = await task5Fixture(t, 'task5-base-to-source-root-race-');
  const base = await buildChangeBaseContext(fixture.repoRoot, 'CHG-0001');
  const replacement = join(fixture.repoRoot, 'replacement-after-base');
  const displaced = join(fixture.repoRoot, 'displaced-after-base');
  await cp(fixture.changeRoot, replacement, { recursive: true });
  await writeFile(join(replacement, 'domain.md'), 'replacement after base\n');
  await rename(fixture.changeRoot, displaced);
  await rename(replacement, fixture.changeRoot);

  await assert.rejects(
    sealForNewMutation(base, async (session) => {
      await resolveCurrentSource(session, {
        changeId: 'CHG-0001', revisionId: 'REV-0001', kind: 'artifact', path: 'domain.md',
      });
    }),
    /AUTHORITY_IO_RACE|AUTHORITY_IO_CONTAINMENT/,
  );
});

test('collection parsing does not observe live RegExp.test or String.slice after await', { concurrency: false }, async (t) => {
  const fixture = await task5Fixture(t, 'task5-collection-intrinsics-');
  const originalReaddir = fs.promises.readdir;
  const originalRegExpTest = RegExp.prototype.test;
  const originalStringSlice = String.prototype.slice;
  const originalStringLastIndexOf = String.prototype.lastIndexOf;
  const originalStringIncludes = String.prototype.includes;
  const originalStringNormalize = String.prototype.normalize;
  const originalStringSplit = String.prototype.split;
  const OriginalSet = Set;
  const originalSetAdd = Set.prototype.add;
  const originalSetHas = Set.prototype.has;
  const originalSetIterator = Set.prototype[Symbol.iterator];
  let directoryReads = 0;
  let poisonInstalled = false;
  let liveRegExpCalls = 0;
  let liveSliceCalls = 0;
  let liveLastIndexOfCalls = 0;
  let liveIncludesCalls = 0;
  let liveNormalizeCalls = 0;
  let liveSplitCalls = 0;
  let liveSetCalls = 0;
  const inventoryToken = (value: unknown): boolean => typeof value === 'string'
    && (value.startsWith('LOGICAL:DECISION:') || value.startsWith('decisions/DEC-'));
  const installPoison = (): void => {
    if (poisonInstalled) return;
    poisonInstalled = true;
    RegExp.prototype.test = function poisonedTest(this: RegExp, value: string): boolean {
      if (typeof value === 'string'
        && Reflect.apply(originalStringSlice, value, [0, 4]) === 'DEC-'
        && (Reflect.apply(originalStringIncludes, this.source, ['yaml'])
          || this.source === '[\\u0001-\\u001f\\u007f]')) liveRegExpCalls += 1;
      return Reflect.apply(originalRegExpTest, this, [value]) as boolean;
    };
    String.prototype.slice = function poisonedSlice(this: string, start?: number, end?: number): string {
      const value = String(this);
      if ((value.startsWith('DEC-') && start === 0 && end === -5)
        || value.startsWith('decisions/DEC-')) {
        liveSliceCalls += 1;
        throw new Error('TASK5_LIVE_STRING_SLICE_POISON');
      }
      return Reflect.apply(originalStringSlice, this, [start, end]) as string;
    };
    String.prototype.lastIndexOf = function poisonedLastIndexOf(
      this: string,
      searchString: string,
      position?: number,
    ): number {
      if (String(this).startsWith('decisions/DEC-') && searchString === '/') {
        liveLastIndexOfCalls += 1;
      }
      return Reflect.apply(originalStringLastIndexOf, this, [searchString, position]) as number;
    };
    String.prototype.includes = function poisonedIncludes(
      this: string,
      searchString: string,
      position?: number,
    ): boolean {
      if (Reflect.apply(originalStringSlice, String(this), [0, 4]) === 'DEC-') {
        liveIncludesCalls += 1;
      }
      return Reflect.apply(originalStringIncludes, this, [searchString, position]) as boolean;
    };
    String.prototype.normalize = function poisonedNormalize(this: string, form?: string): string {
      if (Reflect.apply(originalStringSlice, String(this), [0, 4]) === 'DEC-') {
        liveNormalizeCalls += 1;
      }
      return Reflect.apply(originalStringNormalize, this, [form]) as string;
    };
    String.prototype.split = (function poisonedSplit(
      this: string,
      separator?: string | RegExp,
      limit?: number,
    ): string[] {
      if (Reflect.apply(originalStringSlice, String(this), [0, 4]) === 'DEC-'
        && separator === '/') {
        liveSplitCalls += 1;
        throw new Error('TASK5_LIVE_STRING_SPLIT_POISON');
      }
      return Reflect.apply(originalStringSplit, this, [separator, limit]) as string[];
    }) as typeof String.prototype.split;
    OriginalSet.prototype.add = function poisonedSetAdd<T>(this: Set<T>, value: T): Set<T> {
      if (inventoryToken(value)) {
        liveSetCalls += 1;
        throw new Error('TASK5_LIVE_INVENTORY_SET_ADD_POISON');
      }
      return Reflect.apply(originalSetAdd, this, [value]) as Set<T>;
    };
    OriginalSet.prototype.has = function poisonedSetHas<T>(this: Set<T>, value: T): boolean {
      if (inventoryToken(value)) {
        liveSetCalls += 1;
        throw new Error('TASK5_LIVE_INVENTORY_SET_HAS_POISON');
      }
      return Reflect.apply(originalSetHas, this, [value]) as boolean;
    };
    OriginalSet.prototype[Symbol.iterator] = function poisonedSetIterator<T>(this: Set<T>): SetIterator<T> {
      if (Reflect.apply(originalSetHas, this, ['decisions/DEC-0001.yaml'])) {
        liveSetCalls += 1;
        throw new Error('TASK5_LIVE_INVENTORY_SET_ITERATOR_POISON');
      }
      return Reflect.apply(originalSetIterator, this, []) as SetIterator<T>;
    };
  };
  fs.promises.readdir = async function patchedReaddir(this: typeof fs.promises, path, options) {
    const result = await originalReaddir.call(this, path, options as never);
    directoryReads += 1;
    if (directoryReads === 3) installPoison();
    return result as never;
  } as typeof fs.promises.readdir;
  syncBuiltinESMExports();
  try {
    const context = await sealForNewMutation(
      await buildChangeBaseContext(fixture.repoRoot, 'CHG-0001'),
      async () => undefined,
    );
    assert.equal(context.decisions[0]?.id, 'DEC-0001');
  } finally {
    fs.promises.readdir = originalReaddir;
    RegExp.prototype.test = originalRegExpTest;
    String.prototype.slice = originalStringSlice;
    String.prototype.lastIndexOf = originalStringLastIndexOf;
    String.prototype.includes = originalStringIncludes;
    String.prototype.normalize = originalStringNormalize;
    String.prototype.split = originalStringSplit;
    OriginalSet.prototype.add = originalSetAdd;
    OriginalSet.prototype.has = originalSetHas;
    OriginalSet.prototype[Symbol.iterator] = originalSetIterator;
    syncBuiltinESMExports();
  }
  assert.equal(poisonInstalled, true);
  assert.equal(liveRegExpCalls, 0);
  assert.equal(liveSliceCalls, 0);
  assert.equal(liveLastIndexOfCalls, 0);
  assert.equal(liveIncludesCalls, 0);
  assert.equal(liveNormalizeCalls, 0);
  assert.equal(liveSplitCalls, 0);
  assert.equal(liveSetCalls, 0);
});
