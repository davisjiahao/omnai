import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { createChange, initializeProject } from '../store.js';
import { assertNativeWorkflowSupported } from '../native-workflow-gate.js';

// 背景：v0.3 发布候选锁尚未认证，外部初始化不能通过门禁隐式创建工作流状态。
// 目的：固定所有入口的 fail-closed 结果，并保证门禁只读取现有文件而不产生副作用。
// 上下文：测试使用临时目录而非 Git 仓库，证明门禁仅依赖原生 .omnai 标记。
const cleanupDirectories: string[] = [];

afterEach(async () => {
  while (cleanupDirectories.length > 0) {
    const directory = cleanupDirectories.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

async function temporaryRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), 'omnai-native-gate-'));
  cleanupDirectories.push(repository);
  return repository;
}

test('external initialization is closed before the candidate lock exists', async () => {
  const repo = await temporaryRepository();

  await assert.rejects(
    assertNativeWorkflowSupported(repo, 'INITIALIZE'),
    /UNSUPPORTED_WORKFLOW_VERSION/,
  );
  assert.equal(await exists(join(repo, '.omnai')), false);
});

test('missing native state rejects every gate mode without writing', async () => {
  const repo = await temporaryRepository();

  await assertUnsupportedForEveryMode(repo);
  assert.equal(await exists(join(repo, '.omnai')), false);
});

test('missing and old workflow markers reject every mode without writing', async () => {
  const repo = await temporaryRepository();
  const omnai = join(repo, '.omnai');
  await mkdir(omnai);

  await assertUnsupportedForEveryMode(repo);
  await writeFile(join(omnai, 'workflow.lock.yaml'), 'workflowVersion: 0.2.0\n', 'utf8');
  await assertUnsupportedForEveryMode(repo);
  assert.equal(await readFile(join(omnai, 'workflow.lock.yaml'), 'utf8'), 'workflowVersion: 0.2.0\n');
});

test('only one uncommented top-level v0.3 marker passes the minimal gate', async () => {
  const repo = await temporaryRepository();
  const omnai = join(repo, '.omnai');
  await mkdir(omnai);
  await writeFile(
    join(omnai, 'workflow.lock.yaml'),
    'workflowVersion: 0.3.0\nartifactSchemas: [\n',
    'utf8',
  );

  await assert.doesNotReject(assertNativeWorkflowSupported(repo, 'READ_ONLY'));
});

test('ambiguous, repeated, and pseudo workflow markers reject every mode without writing', async () => {
  const fixtures = [
    'workflowVersion: 0.3.0 # 认证候选\n',
    'workflowVersion: 0.2.0\nworkflowVersion: 0.3.0\n',
    ' workflowVersion: 0.3.0\n',
    'workflowVersion: 0.3.0\n  workflowVersion: 0.3.0\n',
  ];

  for (const contents of fixtures) {
    const repo = await temporaryRepository();
    const lock = join(repo, '.omnai', 'workflow.lock.yaml');
    await mkdir(join(repo, '.omnai'));
    await writeFile(lock, contents, 'utf8');

    await assertUnsupportedForEveryMode(repo);
    assert.equal(await readFile(lock, 'utf8'), contents);
  }
});

test('unexpected native-state nodes reject every mode without writing', async () => {
  const fileRepo = await temporaryRepository();
  const fileRoot = join(fileRepo, '.omnai');
  await writeFile(fileRoot, '不是目录\n', 'utf8');
  await assertUnsupportedForEveryMode(fileRepo);
  assert.equal(await readFile(fileRoot, 'utf8'), '不是目录\n');

  const rootLinkRepo = await temporaryRepository();
  const rootTarget = join(rootLinkRepo, 'candidate-state');
  const rootLink = join(rootLinkRepo, '.omnai');
  await mkdir(rootTarget);
  await writeFile(join(rootTarget, 'workflow.lock.yaml'), 'workflowVersion: 0.3.0\n', 'utf8');
  await symlink(rootTarget, rootLink, 'dir');
  await assertUnsupportedForEveryMode(rootLinkRepo);
  assert.equal((await lstat(rootLink)).isSymbolicLink(), true);

  const directoryLockRepo = await temporaryRepository();
  const directoryLock = join(directoryLockRepo, '.omnai', 'workflow.lock.yaml');
  await mkdir(directoryLock, { recursive: true });
  await assertUnsupportedForEveryMode(directoryLockRepo);
  assert.equal((await lstat(directoryLock)).isDirectory(), true);

  const lockLinkRepo = await temporaryRepository();
  const lockTarget = join(lockLinkRepo, 'candidate-lock.yaml');
  const lockLink = join(lockLinkRepo, '.omnai', 'workflow.lock.yaml');
  await mkdir(join(lockLinkRepo, '.omnai'));
  await writeFile(lockTarget, 'workflowVersion: 0.3.0\n', 'utf8');
  await symlink(lockTarget, lockLink, 'file');
  await assertUnsupportedForEveryMode(lockLinkRepo);
  assert.equal((await lstat(lockLink)).isSymbolicLink(), true);
});

// 背景：Task 9H 尚未安装并激活最终候选，旧 exported store API 却会先创建 .omnai、changes 与
// project，再因 v0.3 schema 不兼容失败。目的：从真实 package API 锁定 missing、手工 0.3.0 与
// legacy 三类状态都在第一笔文件系统 mutation 前返回稳定版本错误。上下文：手工 marker 只是
// 最小读取探针，不是获认证候选；测试保留原始目录清单与 lock bytes，避免把“最终失败”误当零写。
test('exported initializeProject 与 createChange 在候选未激活时全部零写拒绝', async () => {
  for (const marker of [null, 'workflowVersion: 0.3.0\n', 'workflowVersion: 0.2.0\n'] as const) {
    for (const operation of ['initializeProject', 'createChange'] as const) {
      const repo = await temporaryRepository();
      if (marker !== null) {
        await mkdir(join(repo, '.omnai'));
        await writeFile(join(repo, '.omnai', 'workflow.lock.yaml'), marker, 'utf8');
      }
      const before = await nativeTree(repo);

      const promise = operation === 'initializeProject'
        ? initializeProject(repo)
        : createChange(repo, '不得落盘的变更', 'small-feature');
      await assert.rejects(promise, /UNSUPPORTED_WORKFLOW_VERSION/);

      assert.deepEqual(await nativeTree(repo), before, `${operation}:${marker ?? 'missing'}`);
      if (marker === null) assert.equal(await exists(join(repo, '.omnai')), false);
      else assert.equal(await readFile(join(repo, '.omnai', 'workflow.lock.yaml'), 'utf8'), marker);
    }
  }
});

// 背景：CLI 是 exported store API 的另一条真实外部路径；只测 helper 会漏掉 commander/module-link
// 或入口 action 在 gate 前做初始化。目的：在 disposable Git repository 中执行真实 init/new，
// 要求同样的三类状态返回稳定版本错误且目录树逐项不变。上下文：git init 只建立测试仓库定位，
// 不创建任何 OmnAI authority；dist/src/main.js 来自本轮 RED 前的真实 build。
test('真实 CLI init/new 在候选未激活时全部零写拒绝', async () => {
  const cli = resolve('dist/src/main.js');
  for (const marker of [null, 'workflowVersion: 0.3.0\n', 'workflowVersion: 0.2.0\n'] as const) {
    for (const args of [['init'], ['new', '不得落盘的 CLI 变更']] as const) {
      const repo = await temporaryRepository();
      const initialized = spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8' });
      assert.equal(initialized.status, 0, initialized.stderr);
      if (marker !== null) {
        await mkdir(join(repo, '.omnai'));
        await writeFile(join(repo, '.omnai', 'workflow.lock.yaml'), marker, 'utf8');
      }
      const before = await nativeTree(repo);

      const result = spawnSync(process.execPath, [cli, ...args], { cwd: repo, encoding: 'utf8' });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /UNSUPPORTED_WORKFLOW_VERSION/);
      assert.deepEqual(await nativeTree(repo), before, `${args[0]}:${marker ?? 'missing'}`);
    }
  }
});

// 背景：minimal pre-lock gate 只需要识别一个顶层 marker，旧 readFile 却会把整个 regular file
// 无界读入。目的：固定 64 KiB 的最后合法字节与首个非法字节；大量尾随空格仍匹配旧 marker
// regex，因此 over case 会在未实现 size gate 时可靠地 RED。上下文：sparse 与 special 节点也
// 必须 fail-closed，且测试不依赖计时或进程内存等不稳定观测。
test('native marker 以 no-follow fd 和 64 KiB 字节边界读取', async () => {
  const exactRepo = await temporaryRepository();
  const exactLock = join(exactRepo, '.omnai', 'workflow.lock.yaml');
  await mkdir(join(exactRepo, '.omnai'));
  const prefix = 'workflowVersion: 0.3.0';
  await writeFile(exactLock, `${prefix}${' '.repeat(64 * 1024 - Buffer.byteLength(prefix))}`, 'utf8');
  await assert.doesNotReject(assertNativeWorkflowSupported(exactRepo, 'READ_ONLY'));

  const overRepo = await temporaryRepository();
  const overLock = join(overRepo, '.omnai', 'workflow.lock.yaml');
  await mkdir(join(overRepo, '.omnai'));
  await writeFile(overLock, `${prefix}${' '.repeat(64 * 1024 + 1 - Buffer.byteLength(prefix))}`, 'utf8');
  await assert.rejects(assertNativeWorkflowSupported(overRepo, 'READ_ONLY'), /UNSUPPORTED_WORKFLOW_VERSION/);

  const sparseRepo = await temporaryRepository();
  const sparseLock = join(sparseRepo, '.omnai', 'workflow.lock.yaml');
  await mkdir(join(sparseRepo, '.omnai'));
  const sparseHandle = await open(sparseLock, 'w');
  try {
    await sparseHandle.write(prefix, 0, 'utf8');
    await sparseHandle.truncate(64 * 1024 + 1);
  } finally {
    await sparseHandle.close();
  }
  await assert.rejects(assertNativeWorkflowSupported(sparseRepo, 'READ_ONLY'), /UNSUPPORTED_WORKFLOW_VERSION/);

  if (process.platform !== 'win32') {
    const specialRepo = await temporaryRepository();
    const specialLock = join(specialRepo, '.omnai', 'workflow.lock.yaml');
    await mkdir(join(specialRepo, '.omnai'));
    const created = spawnSync('mkfifo', [specialLock], { encoding: 'utf8' });
    assert.equal(created.status, 0, created.stderr);
    await assert.rejects(assertNativeWorkflowSupported(specialRepo, 'READ_ONLY'), /UNSUPPORTED_WORKFLOW_VERSION/);
  }
});

async function assertUnsupportedForEveryMode(repo: string): Promise<void> {
  for (const mode of ['READ_ONLY', 'MUTATION', 'INITIALIZE'] as const) {
    await assert.rejects(assertNativeWorkflowSupported(repo, mode), /UNSUPPORTED_WORKFLOW_VERSION/);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await import('node:fs/promises').then(({ access }) => access(path));
    return true;
  } catch {
    return false;
  }
}

async function nativeTree(repo: string): Promise<string[]> {
  const root = join(repo, '.omnai');
  if (!(await exists(root))) return [];
  const output: string[] = [];
  const pending = [''];
  while (pending.length > 0) {
    const relative = pending.pop()!;
    const absolute = relative === '' ? root : join(root, relative);
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      output.push(`${entry.isDirectory() ? 'D' : entry.isFile() ? 'F' : 'O'}:${child}`);
      if (entry.isDirectory()) pending.push(child);
    }
  }
  return output.sort();
}
