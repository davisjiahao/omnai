import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';

// 背景：编译测试同时保留 dist/test 和模块内 dist/src/**/test，默认入口不能漏发现任何一类。
// 目的：用真实子进程固定 UTF-16 代码单元排序、空清单失败以及状态和信号的逐值传播。
// 上下文：每个夹具只包含最小 Node 测试文件，避免把 runner 的行为委托给模拟对象。
const cleanupDirectories: string[] = [];
const runner = resolve(process.cwd(), 'scripts/run-native-tests.mjs');

afterEach(async () => {
  while (cleanupDirectories.length > 0) {
    const directory = cleanupDirectories.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omnai-native-tests-'));
  cleanupDirectories.push(root);
  return root;
}

function run(root: string, environment: NodeJS.ProcessEnv = {}) {
  const childEnvironment = { ...process.env, ...environment };
  delete childEnvironment.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [runner], {
    cwd: root,
    encoding: 'utf8',
    env: childEnvironment,
  });
}

async function writeTest(root: string, relativePath: string, content: string): Promise<void> {
  const path = join(root, 'dist', relativePath);
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
}

function recordingTest(label: string): string {
  return [
    "import { appendFileSync } from 'node:fs';",
    "import { test } from 'node:test';",
    `test('${label}', () => appendFileSync(process.env.OMNAI_NATIVE_TEST_LOG, '${label}\\n'));`,
  ].join('\n');
}

async function childResultPreload(
  root: string,
  result: '{ status: 0, signal: null }' | '{ status: 7, signal: null }' | "{ status: null, signal: 'SIGTERM' }",
  argvPath?: string,
): Promise<string> {
  const preload = join(root, 'child-result-preload.cjs');
  await writeFile(preload, [
    "const childProcess = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `childProcess.spawnSync = (_command, argv) => { ${argvPath === undefined ? '' : `writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(argv));`} return (${result}); };`,
    "require('node:module').syncBuiltinESMExports();",
  ].join('\n'), 'utf8');
  return preload;
}

test('递归运行模块内和保留测试各一次', async () => {
  const root = await fixture();
  const log = join(root, 'order.log');
  await writeTest(root, 'src/z/test/z.test.js', recordingTest('z'));
  await writeTest(root, 'src/ä/test/umlaut.test.js', recordingTest('ä'));
  await writeTest(root, 'test/legacy.test.js', recordingTest('legacy'));

  const result = run(root, { OMNAI_NATIVE_TEST_LOG: log });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  const labels = (await readFile(log, 'utf8')).trim().split('\n');
  assert.equal(labels.length, 3);
  assert.deepEqual(new Set(labels), new Set(['z', 'ä', 'legacy']));
});

test('传给子进程的完整清单按 UTF-16 代码单元排序且没有串行化参数', async () => {
  const root = await fixture();
  const argvPath = join(root, 'argv.json');
  await writeTest(root, 'src/z/test/z.test.js', recordingTest('z'));
  await writeTest(root, 'src/ä/test/umlaut.test.js', recordingTest('ä'));
  await writeTest(root, 'test/legacy.test.js', recordingTest('legacy'));
  const preload = await childResultPreload(root, '{ status: 0, signal: null }', argvPath);

  const result = run(root, { NODE_OPTIONS: `--require=${preload}` });

  assert.equal(result.status, 0, result.stderr);
  const argv = JSON.parse(await readFile(argvPath, 'utf8')) as string[];
  const expected = [
    '--test',
    resolve(root, 'dist', 'src', 'z', 'test', 'z.test.js'),
    resolve(root, 'dist', 'src', 'ä', 'test', 'umlaut.test.js'),
    resolve(root, 'dist', 'test', 'legacy.test.js'),
  ];
  assert.deepEqual(argv, expected);
  assert.equal(new Set(argv.slice(1)).size, 3);
  assert.equal(argv.includes('--test-concurrency=1'), false);
});

test('空编译测试清单以失败退出', async () => {
  const result = run(await fixture());

  assert.equal(result.status, 1);
  assert.match(result.stderr, /No compiled test files found/);
});

test('子测试状态码原样传递', async () => {
  const root = await fixture();
  await writeTest(root, 'test/status.test.js', recordingTest('status'));
  const preload = await childResultPreload(root, '{ status: 7, signal: null }');

  const result = run(root, { NODE_OPTIONS: `--require=${preload}` });

  assert.equal(result.status, 7);
  assert.equal(result.signal, null);
});

test('子测试信号原样传递', async () => {
  const root = await fixture();
  await writeTest(root, 'test/signal.test.js', recordingTest('signal'));
  const preload = await childResultPreload(root, "{ status: null, signal: 'SIGTERM' }");

  const result = run(root, { NODE_OPTIONS: `--require=${preload}` });

  assert.equal(result.status, null);
  assert.equal(result.signal, 'SIGTERM');
});
