import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { hObject } from '../../../domain/public.js';
import { buildBaseContext } from '../../authority/context-builder.js';
import { sealForNewMutation } from '../../authority/context.js';
import { inspectCurrentSource } from '../inspect.js';
import { resolveCurrentSource } from '../resolver.js';
import type { SourceCaptureSession, SourceLocator } from '../types.js';
import { sourceFixture } from './source-fixture.js';

const identity = { changeId: 'CHG-0001', revisionId: 'REV-0001' } as const;

test('one authenticated session resolves all six source kinds in caller order from real current authority', async (t) => {
  const fixture = await sourceFixture(t, 'source-ref-six-kinds-');
  const scenario = fixture.catalog.scenarioProfiles.find(({ id }) => id === 'small-feature');
  assert.ok(scenario);
  const locators = [
    { ...identity, kind: 'artifact', path: 'domain.md' },
    { ...identity, kind: 'policy', scenarioId: 'small-feature' },
    { ...identity, kind: 'evidence', evidenceId: 'EVD-000001' },
    { ...identity, kind: 'decision', decisionId: 'DEC-0001' },
    { ...identity, kind: 'task', taskId: 'TASK-001' },
    { ...identity, kind: 'code', path: 'src/current.ts' },
  ] as const;
  const expectedHashes = [
    hashBytes('artifact bytes\n'),
    hObject(scenario),
    hObject(fixture.evidence),
    hObject(fixture.decision),
    hObject(fixture.task),
    hashBytes('export const current = true;\n'),
  ];
  const resolved: Awaited<ReturnType<typeof resolveCurrentSource>>[] = [];

  const context = await sealForNewMutation(await buildBaseContext(fixture.request), async (session) => {
    for (const locator of locators) resolved.push(await resolveCurrentSource(session, locator));
  });

  assert.deepEqual(resolved.map(({ sourceRef }) => sourceRef.kind), locators.map(({ kind }) => kind));
  assert.deepEqual(resolved.map(({ sourceRef }) => sourceRef.contentHash), expectedHashes);
  assert.deepEqual([...context.observedIo.fileOpens].filter(([path]) => (
    path === 'domain.md' || path === 'src/current.ts'
  )), [['domain.md', 1], ['src/current.ts', 1]]);
  for (const result of resolved) {
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.sourceRef), true);
    const bytes = result.copyCanonicalBytes();
    bytes.fill(0);
    assert.equal(result.sourceRef.contentHash, hashBytes(result.copyCanonicalBytes()));
  }
  assert.equal(resolved[5]?.observation.kind, 'code');
  assert.match(String(resolved[5]?.observation.providerBindingHash), /^sha256:[0-9a-f]{64}$/u);
  assert.equal('providerBindingHash' in resolved[0]!.sourceRef, false);
});

test('policy resolution binds collection and hash intrinsics before an untrusted callback', { concurrency: false }, async (t) => {
  const fixture = await sourceFixture(t, 'source-policy-intrinsics-');
  const scenario = fixture.catalog.scenarioProfiles.find(({ id }) => id === 'small-feature');
  assert.ok(scenario);
  const expectedHash = hObject(scenario);
  const arrayFind = Object.getOwnPropertyDescriptor(Array.prototype, 'find');
  const arrayIncludes = Object.getOwnPropertyDescriptor(Array.prototype, 'includes');
  const hashPrototype = Object.getPrototypeOf(createHash('sha256')) as object;
  const hashUpdate = Object.getOwnPropertyDescriptor(hashPrototype, 'update');
  const hashDigest = Object.getOwnPropertyDescriptor(hashPrototype, 'digest');
  assert.ok(arrayFind && arrayIncludes && hashUpdate && hashDigest);
  const intercepted = { find: 0, includes: 0, update: 0, digest: 0 };
  let resolved: Awaited<ReturnType<typeof resolveCurrentSource>> | undefined;
  try {
    await sealForNewMutation(await buildBaseContext(fixture.request), async (session) => {
      Object.defineProperty(Array.prototype, 'find', {
        ...arrayFind,
        value() {
          intercepted.find += 1;
          return Object.freeze({ id: 'attacker-policy', authority: 'attacker' });
        },
      });
      Object.defineProperty(Array.prototype, 'includes', {
        ...arrayIncludes,
        value() {
          intercepted.includes += 1;
          return true;
        },
      });
      Object.defineProperty(hashPrototype, 'update', {
        ...hashUpdate,
        value(this: unknown, ...args: unknown[]) {
          intercepted.update += 1;
          return Reflect.apply(hashUpdate.value as (...input: unknown[]) => unknown, this, args);
        },
      });
      Object.defineProperty(hashPrototype, 'digest', {
        ...hashDigest,
        value(this: unknown, ...args: unknown[]) {
          intercepted.digest += 1;
          return Reflect.apply(hashDigest.value as (...input: unknown[]) => unknown, this, args);
        },
      });
      resolved = await resolveCurrentSource(session, {
        ...identity,
        kind: 'policy',
        scenarioId: 'small-feature',
      });
    });
  } finally {
    Object.defineProperty(Array.prototype, 'find', arrayFind);
    Object.defineProperty(Array.prototype, 'includes', arrayIncludes);
    Object.defineProperty(hashPrototype, 'update', hashUpdate);
    Object.defineProperty(hashPrototype, 'digest', hashDigest);
  }
  assert.equal(resolved?.sourceRef.contentHash, expectedHash);
  assert.deepEqual(intercepted, { find: 0, includes: 0, update: 0, digest: 0 });
});

test('policy locator validation binds scenario membership before an untrusted callback', { concurrency: false }, async (t) => {
  const fixture = await sourceFixture(t, 'source-policy-includes-');
  const arrayIncludes = Object.getOwnPropertyDescriptor(Array.prototype, 'includes');
  assert.ok(arrayIncludes);
  let intercepted = 0;
  try {
    await assert.rejects(
      sealForNewMutation(await buildBaseContext(fixture.request), async (session) => {
        Object.defineProperty(Array.prototype, 'includes', {
          ...arrayIncludes,
          value() {
            intercepted += 1;
            return true;
          },
        });
        await resolveCurrentSource(session, {
          ...identity,
          kind: 'policy',
          scenarioId: 'attacker-policy',
        } as never);
      }),
      /SOURCE_LOCATOR_INVALID/,
    );
  } finally {
    Object.defineProperty(Array.prototype, 'includes', arrayIncludes);
  }
  assert.equal(intercepted, 0);
});

test('inspection returns a provider-free immutable projection and contract never falls back', async (t) => {
  const fixture = await sourceFixture(t, 'source-inspection-safe-');
  let inspection;
  const context = await sealForNewMutation(await buildBaseContext(fixture.request), async (session) => {
    inspection = await inspectCurrentSource(session, {
      ...identity,
      kind: 'code',
      path: 'src/current.ts',
    });
  });
  await assert.rejects(sealForNewMutation(await buildBaseContext(fixture.request), async (session) => {
    await inspectCurrentSource(session, {
      ...identity,
      kind: 'contract',
      contractId: 'CONTRACT-001',
    });
  }), /SOURCE_KIND_UNAVAILABLE/);
  assert.ok(inspection);
  assert.equal(Object.isFrozen(inspection), true);
  assert.equal(JSON.stringify(inspection).includes('bindingHash'), false);
  assert.deepEqual([...context.observedIo.fileOpens].filter(([path]) => path === 'src/current.ts'), [
    ['src/current.ts', 1],
  ]);
});

test('inspection rejects a Proxy locator without invoking any trap', async (t) => {
  const fixture = await sourceFixture(t, 'source-inspection-proxy-');
  let traps = 0;
  const locator = new Proxy({
    ...identity,
    kind: 'contract',
    contractId: 'CONTRACT-001',
  }, {
    getOwnPropertyDescriptor(target, key) {
      traps += 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  await assert.rejects(sealForNewMutation(await buildBaseContext(fixture.request), async (session) => {
    await inspectCurrentSource(session, locator);
  }), /SOURCE_LOCATOR_INVALID/);
  assert.equal(traps, 0);
});

test('locator identity is exact and caller hashes cannot be smuggled into current resolution', async (t) => {
  const fixture = await sourceFixture(t, 'source-ref-identity-');
  const failures: unknown[] = [];
  await assert.rejects(sealForNewMutation(await buildBaseContext(fixture.request), async (session) => {
    for (const locator of [
      { kind: 'artifact', revisionId: 'REV-0001', path: 'domain.md' },
      { ...identity, changeId: 'CHG-0002', kind: 'artifact', path: 'domain.md' },
      { ...identity, revisionId: 'REV-0002', kind: 'artifact', path: 'domain.md' },
      { ...identity, kind: 'decision', decisionId: 'DEC-9999' },
      { ...identity, kind: 'artifact', path: 'domain.md', contentHash: `sha256:${'f'.repeat(64)}` },
    ]) {
      try {
        await resolveCurrentSource(session, locator as SourceLocator);
      } catch (error) {
        failures.push(error);
      }
    }
  }), /SOURCE_LOCATOR_INVALID/);
  assert.deepEqual(failures.map(String), [
    'SourceResolutionError: SOURCE_LOCATOR_INVALID: locator',
    'SourceResolutionError: SOURCE_CONTEXT_MISMATCH: CHG-0002/REV-0001',
    'SourceResolutionError: SOURCE_CONTEXT_MISMATCH: CHG-0001/REV-0002',
    'SourceResolutionError: SOURCE_IDENTITY_MISSING: decision:DEC-9999',
    'SourceResolutionError: SOURCE_LOCATOR_INVALID: locator',
  ]);
});

test('all six kinds reject missing locator identity and a wrong Change or Revision before source I/O', async (t) => {
  const fixture = await sourceFixture(t, 'source-ref-six-identity-negative-');
  const identities = [
    { kind: 'artifact', path: 'domain.md' },
    { kind: 'policy', scenarioId: 'small-feature' },
    { kind: 'evidence', evidenceId: 'EVD-000001' },
    { kind: 'decision', decisionId: 'DEC-0001' },
    { kind: 'task', taskId: 'TASK-001' },
    { kind: 'code', path: 'src/current.ts' },
  ] as const;
  const failures: unknown[] = [];
  await assert.rejects(sealForNewMutation(await buildBaseContext(fixture.request), async (session) => {
    for (const source of identities) {
      for (const locator of [
        { ...source, revisionId: 'REV-0001' },
        { ...source, ...identity, changeId: 'CHG-0002' },
        { ...source, ...identity, revisionId: 'REV-0002' },
        { ...source, ...identity, contentHash: `sha256:${'f'.repeat(64)}` },
      ]) {
        try {
          await resolveCurrentSource(session, locator);
        } catch (error) {
          failures.push(error);
        }
      }
    }
  }), /SOURCE_LOCATOR_INVALID/);
  assert.equal(failures.length, 24);
  assert.equal(failures.filter((error) => /SOURCE_LOCATOR_INVALID/u.test(String(error))).length, 12);
  assert.equal(failures.filter((error) => /SOURCE_CONTEXT_MISMATCH/u.test(String(error))).length, 12);
});

test('all structured current-record kinds reject an authenticated but missing identity', async (t) => {
  const fixture = await sourceFixture(t, 'source-ref-structured-missing-');
  const failures: unknown[] = [];
  await assert.rejects(sealForNewMutation(await buildBaseContext(fixture.request), async (session) => {
    for (const locator of [
      { ...identity, kind: 'evidence' as const, evidenceId: 'EVD-999999' },
      { ...identity, kind: 'decision' as const, decisionId: 'DEC-9999' },
      { ...identity, kind: 'task' as const, taskId: 'TASK-999' },
    ]) {
      try {
        await resolveCurrentSource(session, locator);
      } catch (error) {
        failures.push(error);
      }
    }
  }), /SOURCE_IDENTITY_MISSING: evidence:EVD-999999/);
  assert.deepEqual(failures.map(String), [
    'SourceResolutionError: SOURCE_IDENTITY_MISSING: evidence:EVD-999999',
    'SourceResolutionError: SOURCE_IDENTITY_MISSING: decision:DEC-9999',
    'SourceResolutionError: SOURCE_IDENTITY_MISSING: task:TASK-999',
  ]);
});

test('editing artifact and code bytes makes each previously resolved SourceRef stale', async (t) => {
  const fixture = await sourceFixture(t, 'source-ref-stale-bytes-');
  for (const row of [
    { kind: 'artifact' as const, path: 'domain.md', edited: 'edited artifact bytes\n' },
    { kind: 'code' as const, path: 'src/current.ts', edited: 'export const edited = true;\n' },
  ]) {
    const refs: Array<Awaited<ReturnType<typeof resolveCurrentSource>>['sourceRef']> = [];
    await sealForNewMutation(await buildBaseContext(fixture.request), async (session) => {
      refs.push((await resolveCurrentSource(session, { ...identity, kind: row.kind, path: row.path })).sourceRef);
    });
    await writeFile(join(fixture.root, row.path), row.edited);
    await sealForNewMutation(await buildBaseContext(fixture.request), async (session) => {
      refs.push((await resolveCurrentSource(session, { ...identity, kind: row.kind, path: row.path })).sourceRef);
    });
    assert.equal(refs[0]?.kind, row.kind);
    assert.equal(refs[1]?.kind, row.kind);
    assert.notEqual(refs[0]?.contentHash, refs[1]?.contentHash);
  }
});

test('one session rejects a repeated logical identity for all six source kinds', async (t) => {
  const fixture = await sourceFixture(t, 'source-ref-duplicate-');
  for (const locator of [
    { ...identity, kind: 'artifact' as const, path: 'domain.md' },
    { ...identity, kind: 'policy' as const, scenarioId: 'small-feature' },
    { ...identity, kind: 'evidence' as const, evidenceId: 'EVD-000001' },
    { ...identity, kind: 'decision' as const, decisionId: 'DEC-0001' },
    { ...identity, kind: 'task' as const, taskId: 'TASK-001' },
    { ...identity, kind: 'code' as const, path: 'src/current.ts' },
  ]) {
    let duplicate: unknown;
    await assert.rejects(sealForNewMutation(await buildBaseContext(fixture.request), async (session) => {
      await resolveCurrentSource(session, locator);
      try {
        await resolveCurrentSource(session, locator);
      } catch (error) {
        duplicate = error;
      }
    }), /SOURCE_LOGICAL_IDENTITY_DUPLICATE/);
    assert.match(String(duplicate), new RegExp(`SOURCE_LOGICAL_IDENTITY_DUPLICATE: ${locator.kind}`));
  }
});

test('callback cannot replace Set identity methods to bypass duplicate rejection', { concurrency: false }, async (t) => {
  const fixture = await sourceFixture(t, 'source-ref-set-intrinsic-');
  const originalHas = Object.getOwnPropertyDescriptor(Set.prototype, 'has');
  assert.ok(originalHas);
  let duplicate: unknown;
  try {
    await assert.rejects(sealForNewMutation(await buildBaseContext(fixture.request), async (session) => {
      Object.defineProperty(Set.prototype, 'has', {
        ...originalHas,
        value() {
          return false;
        },
      });
      await resolveCurrentSource(session, { ...identity, kind: 'artifact', path: 'domain.md' });
      try {
        await resolveCurrentSource(session, { ...identity, kind: 'artifact', path: 'domain.md' });
      } catch (error) {
        duplicate = error;
      }
    }), /SOURCE_LOGICAL_IDENTITY_DUPLICATE/);
  } finally {
    Object.defineProperty(Set.prototype, 'has', originalHas);
  }
  assert.match(String(duplicate), /SOURCE_LOGICAL_IDENTITY_DUPLICATE/);
});

test('artifact and code path tables reject aliases and reserved/sibling reach without source I/O', async (t) => {
  const fixture = await sourceFixture(t, 'source-ref-path-table-');
  const unsafe = [
    '/etc/passwd', '../sibling', 'a\\b', '.', 'a//b', 'a%2fb', 'e\u0301.md',
    '.git/config', '.omnai/secret', 'a/../sibling', 'C:\\Windows\\file',
  ];
  const failures: unknown[] = [];
  await assert.rejects(sealForNewMutation(await buildBaseContext(fixture.request), async (session) => {
    for (const kind of ['artifact', 'code'] as const) {
      for (const path of unsafe) {
        try {
          await resolveCurrentSource(session, { ...identity, kind, path } as SourceLocator);
        } catch (error) {
          failures.push(error);
        }
      }
    }
  }), /SOURCE_LOCATOR_INVALID/);
  assert.equal(failures.length, unsafe.length * 2);
  assert.equal(failures.every((error) => /SOURCE_LOCATOR_INVALID/u.test(String(error))), true);
});

test('artifact and code capture reject symlink parents/finals and non-regular nodes', async (t) => {
  const fixture = await sourceFixture(t, 'source-ref-node-safety-');
  await mkdir(join(fixture.root, 'outside'));
  await writeFile(join(fixture.root, 'outside', 'target'), 'outside');
  await symlink(join(fixture.root, 'outside'), join(fixture.root, 'linked-parent'));
  await symlink(join(fixture.root, 'outside', 'target'), join(fixture.root, 'linked-final'));
  await mkdir(join(fixture.root, 'directory-node'));
  const failures: unknown[] = [];
  await assert.rejects(sealForNewMutation(await buildBaseContext(fixture.request), async (session) => {
    for (const kind of ['artifact', 'code'] as const) {
      for (const path of ['linked-parent/target', 'linked-final', 'directory-node']) {
        try {
          await resolveCurrentSource(session, { ...identity, kind, path });
        } catch (error) {
          failures.push(error);
        }
      }
    }
  }), /AUTHORITY_IO_(?:CONTAINMENT|NODE_TYPE)/);
  assert.equal(failures.length, 6);
  assert.equal(failures.every((error) => /AUTHORITY_IO_(?:CONTAINMENT|NODE_TYPE)/u.test(String(error))), true);
});

test('artifact and code resolver propagate deterministic stable-byte races', { concurrency: false }, async (t) => {
  const fixture = await sourceFixture(t, 'source-ref-race-');
  await writeFile(join(fixture.root, 'artifact-race.txt'), 'before');
  await writeFile(join(fixture.root, 'src', 'code-race.ts'), 'before');
  for (const row of [
    { kind: 'artifact' as const, path: 'artifact-race.txt' },
    { kind: 'code' as const, path: 'src/code-race.ts' },
  ]) {
    const base = await buildBaseContext(fixture.request);
    const originalOpen = fs.promises.open;
    let mutated = false;
    fs.promises.open = async function patchedOpen(this: typeof fs.promises, path, flags, ...rest) {
      const handle = await originalOpen.call(this, path, flags, ...rest);
      if (String(path).endsWith(`/${row.path.split('/').at(-1)}`)
        && (Number(flags) & fs.constants.O_DIRECTORY) === 0) {
        const originalRead = handle.read;
        const patchedRead = async (...args: unknown[]) => {
          const result = await Reflect.apply(
            originalRead as unknown as (...input: unknown[]) => Promise<{ bytesRead: number; buffer: unknown }>,
            handle,
            args,
          );
          if (!mutated && result.bytesRead === 0) {
            mutated = true;
            await chmod(join(fixture.root, row.path), 0o400);
          }
          return result;
        };
        handle.read = patchedRead as typeof handle.read;
      }
      return handle;
    } as typeof fs.promises.open;
    syncBuiltinESMExports();
    let failure: unknown;
    try {
      await assert.rejects(sealForNewMutation(base, async (session) => {
        try {
          await resolveCurrentSource(session, { ...identity, kind: row.kind, path: row.path });
        } catch (error) {
          failure = error;
        }
      }), /AUTHORITY_IO_RACE/);
    } finally {
      fs.promises.open = originalOpen;
      syncBuiltinESMExports();
    }
    assert.equal(mutated, true);
    assert.match(String(failure), /AUTHORITY_IO_RACE/);
  }
});

test('retained sessions and SEALED contexts cannot capture a late current source', async (t) => {
  const fixture = await sourceFixture(t, 'source-session-expiry-');
  let retained: SourceCaptureSession | undefined;
  const context = await sealForNewMutation(await buildBaseContext(fixture.request), async (session) => {
    retained = session;
  });
  assert.ok(retained);
  await assert.rejects(
    resolveCurrentSource(retained, { ...identity, kind: 'artifact', path: 'domain.md' }),
    /AUTHORITY_SOURCE_SESSION_INVALID/,
  );
  await assert.rejects(
    resolveCurrentSource(context as unknown as SourceCaptureSession, {
      ...identity,
      kind: 'artifact',
      path: 'domain.md',
    }),
    /AUTHORITY_SOURCE_SESSION_INVALID/,
  );
});

function hashBytes(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
