import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { createTestDirectory } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

test('visual validate exposes a one-shot machine-readable preflight', async () => {
  const fixture = await createTestDirectory('visual-cli-');
  cleanups.push(fixture.cleanup);
  const inputPath = join(fixture.root, 'flow.json');
  await writeFile(inputPath, JSON.stringify({
    schemaVersion: 1,
    kind: 'flow',
    title: 'Request flow',
    summary: 'The request follows one legal route.',
    nodes: [
      { id: 'context', label: 'Context', description: 'Read current scope.' },
      { id: 'route', label: 'Route', description: 'Core selects protocol IDs.' },
    ],
    edges: [{ from: 'context', to: 'route' }],
  }), 'utf8');

  const result = spawnSync(process.execPath, [
    resolve('dist/src/main.js'), 'visual', 'validate', inputPath, '--json',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    valid: true,
    schemaVersion: 1,
    kind: 'flow',
    title: 'Request flow',
  });
});

test('visual validate rejects arbitrary HTML instead of executing it', async () => {
  const fixture = await createTestDirectory('visual-cli-invalid-');
  cleanups.push(fixture.cleanup);
  const inputPath = join(fixture.root, 'unsafe.json');
  await writeFile(inputPath, JSON.stringify({
    schemaVersion: 1,
    kind: 'html',
    title: 'Unsafe',
    summary: 'Must not execute.',
    html: '<script>globalThis.compromised = true</script>',
  }), 'utf8');

  const result = spawnSync(process.execPath, [
    resolve('dist/src/main.js'), 'visual', 'validate', inputPath, '--json',
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid visual companion document/i);
});
