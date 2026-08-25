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
