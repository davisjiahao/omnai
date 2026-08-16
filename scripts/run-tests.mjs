import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const directory = resolve('dist/test');
const files = (await readdir(directory))
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => resolve(directory, name));

if (files.length === 0) {
  console.error(`No compiled test files found under ${directory}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: process.cwd(),
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
