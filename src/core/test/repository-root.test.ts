import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  findRepositoryRoot,
  RepositoryRootError,
  type RepositoryRootErrorCode,
  resolveRepositoryRoot,
} from '../repository-root.js';

// 背景：权限核心必须从真实 Git 解析仓库身份，祖先目录中的占位 .git 不能成为授权依据。
// 目的：固定 Git 成功、非仓库、命令缺失、权限失败和目录竞态的稳定错误语义。
// 上下文：Git 失败通过模块内命令网关注入，不修改整个测试进程的 PATH，避免并发测试互相污染。
const cleanupDirectories: string[] = [];

afterEach(async () => {
  while (cleanupDirectories.length > 0) {
    const directory = cleanupDirectories.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanupDirectories.push(directory);
  return directory;
}

function failureWithCode(code: string): Error {
  return Object.assign(new Error('模拟 Git 启动失败'), { code });
}

function expectRepositoryRootError(
  action: () => unknown,
  expectedCode: RepositoryRootErrorCode,
  expectedCause?: unknown,
): RepositoryRootError {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof RepositoryRootError);
  assert.equal(caught.code, expectedCode);
  if (expectedCause !== undefined) assert.equal(caught.cause, expectedCause);
  return caught;
}

test('成功的 Git 结果是唯一仓库根来源', async () => {
  const root = await temporaryDirectory('omnai-repository-root-');
  const nested = join(root, 'nested', 'work');
  await mkdir(nested, { recursive: true });

  const actual = resolveRepositoryRoot(nested, (cwd) => {
    assert.equal(cwd, resolve(nested));
    return root + '\n';
  });

  assert.equal(actual, resolve(root));
});

test('Git 判定非仓库时不接受祖先占位 .git', async () => {
  const root = await temporaryDirectory('omnai-placeholder-git-');
  const nested = join(root, 'nested', 'work');
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(nested, { recursive: true });
  const cause = Object.assign(new Error('not a git repository'), { status: 128 });

  expectRepositoryRootError(
    () => resolveRepositoryRoot(nested, () => {
      throw cause;
    }),
    'REPOSITORY_NOT_FOUND',
    cause,
  );
});

test('Git 命令不存在时返回 GIT_UNAVAILABLE 并保留 cause', async () => {
  const root = await temporaryDirectory('omnai-git-missing-');
  const cause = failureWithCode('ENOENT');

  expectRepositoryRootError(
    () => resolveRepositoryRoot(root, () => {
      throw cause;
    }),
    'GIT_UNAVAILABLE',
    cause,
  );
});

test('Git 命令无执行权限时返回 GIT_UNAVAILABLE 并保留 cause', async () => {
  const root = await temporaryDirectory('omnai-git-eacces-');
  const cause = failureWithCode('EACCES');

  expectRepositoryRootError(
    () => resolveRepositoryRoot(root, () => {
      throw cause;
    }),
    'GIT_UNAVAILABLE',
    cause,
  );
});

test('起始目录不存在时不调用 Git 并保留文件系统 cause', async () => {
  const root = await temporaryDirectory('omnai-missing-start-');
  const missing = join(root, 'deleted', 'work');
  let called = false;

  const error = expectRepositoryRootError(
    () => resolveRepositoryRoot(missing, () => {
      called = true;
      return root;
    }),
    'REPOSITORY_NOT_FOUND',
  );

  assert.equal(called, false);
  assert.equal((error.cause as NodeJS.ErrnoException).code, 'ENOENT');
});

test('默认入口能够解析真实 Git 仓库', async () => {
  const root = await temporaryDirectory('omnai-real-git-');
  const nested = join(root, 'nested');
  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'ignore' });
  await mkdir(nested);
  const expected = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: nested,
    encoding: 'utf8',
  }).trim();

  assert.equal(findRepositoryRoot(nested), expected);
});
