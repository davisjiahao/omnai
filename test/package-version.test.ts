import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('reports the v0.2 package version from the unified CLI entrypoint', () => {
  const result = spawnSync(process.execPath, [resolve('dist/src/main.js'), '--version'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '0.2.0');
});
