import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import { buildBaseContext } from '../../authority/context-builder.js';
import { sealForNewMutation } from '../../authority/context.js';
import { inspectCurrentSource } from '../inspect.js';
import { resolveCurrentSource } from '../resolver.js';
import type { SourceCaptureSession } from '../types.js';
import type { InspectedCurrentSource, ResolvedCurrentSource } from '../types.js';
import { sourceFixture } from './source-fixture.js';

const identity = { changeId: 'CHG-0001', revisionId: 'REV-0001' } as const;

test('code capture discovers the containing worktree only through the verified provider', async (t) => {
  const fixture = await sourceFixture(t, 'source-code-provider-');
  const captured: ResolvedCurrentSource[] = [];
  const context = await sealForNewMutation(await buildBaseContext(fixture.request), async (session) => {
    captured.push(await resolveCurrentSource(session, {
      ...identity,
      kind: 'code',
      path: 'src/current.ts',
    }));
  });
  const resolved = captured[0];
  assert.ok(resolved);
  assert.equal(resolved.observation.kind, 'code');
  assert.equal(resolved.observation.repositoryRoot, fixture.root);
  assert.match(resolved.observation.providerBindingHash, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual([...context.observedIo.fileOpens].filter(([path]) => path === 'src/current.ts'), [
    ['src/current.ts', 1],
  ]);
});

test('code capture rejects replacement of the discovered worktree root before its first open', { concurrency: false }, async (t) => {
  const fixture = await sourceFixture(t, 'source-code-root-race-');
  const displaced = `${fixture.root}-displaced`;
  t.after(() => rm(displaced, { recursive: true, force: true }));
  const base = await buildBaseContext(fixture.request);
  const originalOpen = fs.promises.open;
  let replaced = false;
  fs.promises.open = async function patchedOpen(this: typeof fs.promises, path, flags, ...rest) {
    if (!replaced
      && String(path) === fixture.root
      && (Number(flags) & fs.constants.O_DIRECTORY) !== 0) {
      replaced = true;
      await rename(fixture.root, displaced);
      await mkdir(join(fixture.root, 'src'), { recursive: true });
      await writeFile(join(fixture.root, 'src', 'current.ts'), 'export const attacker = true;\n');
    }
    return originalOpen.call(this, path, flags, ...rest);
  } as typeof fs.promises.open;
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      sealForNewMutation(base, async (session) => {
        await resolveCurrentSource(session, {
          ...identity,
          kind: 'code',
          path: 'src/current.ts',
        });
      }),
      /SOURCE_REPOSITORY_UNAVAILABLE|AUTHORITY_IO_RACE/,
    );
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
  }
  assert.equal(replaced, true);
});

test('provider failure wins before session access, locator validation, source I/O, or inspection projection', async (t) => {
  // 回归说明：复制 fresh emit 的 JS closure，但故意不复制 native provider；这是真实 acquire
  // 失败，不改动共享构建产物，也不会与并行测试争用 provider 文件。
  const isolated = await mkdtemp(join(process.cwd(), 'source-provider-unavailable-'));
  t.after(() => rm(isolated, { recursive: true, force: true }));
  await cp(join(process.cwd(), 'dist', 'src'), join(isolated, 'src'), { recursive: true });
  const resolverUrl = pathToFileURL(join(isolated, 'src', 'core', 'source', 'resolver.js')).href;
  const inspectUrl = pathToFileURL(join(isolated, 'src', 'core', 'source', 'inspect.js')).href;
  const isolatedResolver = await import(resolverUrl) as typeof import('../resolver.js');
  const isolatedInspect = await import(inspectUrl) as typeof import('../inspect.js');
  const counterfeit = Object.freeze({ phase: 'REQUEST_CAPTURED' }) as SourceCaptureSession;
  const unsafeCode = {
    ...identity,
    kind: 'code',
    path: '../sibling',
    contentHash: `sha256:${'f'.repeat(64)}`,
  } as never;

  await assert.rejects(
    isolatedResolver.resolveCurrentSource(counterfeit, unsafeCode),
    (error: unknown) => (
      error instanceof Error
      && error.name === 'GitProviderError'
      && String(error).startsWith('GitProviderError: GIT_PROVIDER_UNAVAILABLE')
    ),
  );
  await assert.rejects(
    isolatedInspect.inspectCurrentSource(counterfeit, unsafeCode),
    /GIT_PROVIDER_UNAVAILABLE/,
  );
});

test('safe inspection never projects provider binding state', async (t) => {
  const fixture = await sourceFixture(t, 'source-code-inspect-');
  const projections: InspectedCurrentSource[] = [];
  await sealForNewMutation(await buildBaseContext(fixture.request), async (session) => {
    projections.push(await inspectCurrentSource(session, {
      ...identity,
      kind: 'code',
      path: 'src/current.ts',
    }));
  });
  const inspected = projections[0];
  assert.ok(inspected);
  assert.equal(Object.isFrozen(inspected), true);
  assert.equal(Reflect.ownKeys(inspected).includes('observation'), false);
  assert.equal(JSON.stringify(inspected).includes('provider'), false);
});
