import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';

test('reports the v0.3 package version from the unified CLI entrypoint', () => {
  const result = spawnSync(process.execPath, [resolve('dist/src/main.js'), '--version'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '0.3.0');
});

test('workspace CLI commands report the unified v0.3 version', () => {
  for (const command of ['project', 'workset']) {
    const result = spawnSync(process.execPath, [resolve('dist/src/main.js'), command, '--version'], {
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    assert.equal(result.stdout.trim(), '0.3.0');
  }
});

test('packed package allowlist includes the checked-in native test runner', async () => {
  const manifest = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { files?: unknown };

  assert.ok(Array.isArray(manifest.files));
  assert.equal(manifest.files.includes('scripts/run-native-tests.mjs'), true);
  await access(resolve('scripts/run-native-tests.mjs'));
});

test('packed recursive test manifest preserves both layouts without provider testing controls', async () => {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packed = spawnSync(npm, ['pack', '--dry-run', '--json'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(packed.status, 0, packed.stderr);
  const result = JSON.parse(packed.stdout) as Array<{ files?: Array<{ path: string }> }>;
  const files = result[0]?.files?.map((item) => item.path) ?? [];

  assert.equal(
    files.filter((path) => path === 'dist/native/verified_fd_provider.node').length,
    1,
  );
  assert.equal(files.includes('scripts/run-native-tests.mjs'), true);
  for (const runtimePath of [
    'dist/src/index.js',
    'dist/src/index.d.ts',
    'dist/src/index.js.map',
    'dist/src/main.js',
    'dist/src/main.d.ts',
    'dist/src/main.js.map',
    'dist/src/core/git-provider/native-binding.js',
    'dist/src/core/git-provider/native-binding.d.ts',
    'dist/src/core/git-provider/native-binding.js.map',
    'dist/src/core/git-provider/provider.js',
    'dist/src/core/git-provider/provider.d.ts',
    'dist/src/core/git-provider/provider.js.map',
  ]) {
    assert.ok(files.includes(runtimePath), `packed runtime is missing ${runtimePath}`);
  }

  const rootTests = files.filter((path) => /^dist\/test\/.*\.test\.js$/u.test(path));
  const moduleTests = files.filter((path) => /^dist\/src\/.*\/test\/.*\.test\.js$/u.test(path));
  assert.ok(rootTests.includes('dist/test/scenarios.test.js'), 'packed root test layout is missing');
  assert.ok(
    moduleTests.includes('dist/src/domain/test/scalars.test.js'),
    'packed module-local test layout is missing',
  );

  const markers = [
    'missing-openat2',
    'force-non-root-owner',
    'block-until-release',
    'child-started',
    'child-release',
    'overflow-output',
    'never-complete',
    'interrupt-waitid-twice',
    'interrupt-waitpid-twice',
    'interrupt-child-error-write',
    'partial-child-error-write',
    'descendant-survived-signaled-leader',
    'descendant-survived-postcheck',
    'descendant-survived-timeout',
    'signaled-leader-closed-descendant',
    'postcheck-closed-descendant',
    'descendant-holds-pipes',
    'postcheck-child-started',
    'postcheck-child-release',
    'hold-drain-after-overflow',
    'release-drain-after-overflow',
    'force-child-setup-failure',
    'record-child-pid',
    'last-child-pid',
    'last-child-stat',
    'last-reaped-child-pid',
    'short-timeout',
    'malicious-executed',
  ] as const;
  const markerLeaks: Array<Readonly<{ path: string; marker: string }>> = [];
  for (const path of files) {
    const bytes = await readFile(resolve(path));
    for (const marker of markers) {
      if (bytes.includes(marker)) markerLeaks.push({ path, marker });
    }
  }

  assert.deepEqual({
    providerTestArtifacts: files.filter((path) => (
      path.startsWith('dist/src/core/git-provider/test/')
      || /verified_fd_provider_test\.node$/u.test(path)
      || /(?:safe-git|malicious-git|fifo-git)$/u.test(path)
    )),
    packageVersionTestArtifacts: files.filter((path) => (
      path.startsWith('dist/test/package-version.test.')
    )),
    privateAddonArtifacts: files.filter((path) => (
      path.endsWith('.node') && path !== 'dist/native/verified_fd_provider.node'
    )),
    markerLeaks,
  }, {
    providerTestArtifacts: [],
    packageVersionTestArtifacts: [],
    privateAddonArtifacts: [],
    markerLeaks: [],
  });
});

test('installed package root omits the internal repository route order at runtime and in declarations', async () => {
  const runtime = await import('../src/index.js') as Record<string, unknown>;
  const declarationPath = resolve('dist/src/index.d.ts');
  const program = ts.createProgram({
    rootNames: [declarationPath],
    options: {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
    },
  });
  const sourceFile = program.getSourceFile(declarationPath);
  assert.ok(sourceFile);
  const rootSymbol = program.getTypeChecker().getSymbolAtLocation(sourceFile);
  assert.ok(rootSymbol);
  const declarationExports = program.getTypeChecker().getExportsOfModule(rootSymbol)
    .map(({ name }) => name);

  const leaks = [
    ...('repositoryRouteOrder' in runtime ? ['runtime'] : []),
    ...(declarationExports.includes('repositoryRouteOrder') ? ['declaration'] : []),
  ];
  assert.deepEqual(leaks, []);
});
