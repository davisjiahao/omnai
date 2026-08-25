import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

export type RepositoryRootErrorCode =
  | 'GIT_UNAVAILABLE'
  | 'REPOSITORY_NOT_FOUND';

export class RepositoryRootError extends Error {
  readonly code: RepositoryRootErrorCode;

  constructor(code: RepositoryRootErrorCode, startDirectory: string, cause?: unknown) {
    const detail = code === 'GIT_UNAVAILABLE'
      ? 'Git executable is unavailable'
      : 'No Git repository found';
    super(
      code + ': ' + detail + ' from ' + startDirectory,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'RepositoryRootError';
    this.code = code;
  }
}

export type GitRepositoryRootResolver = (startDirectory: string) => string;

const GIT_LAUNCH_FAILURE_CODES = new Set([
  'ENOENT',
  'EACCES',
  'ENOEXEC',
  'ETXTBSY',
]);

export function findRepositoryRoot(startDirectory = process.cwd()): string {
  return resolveRepositoryRoot(startDirectory, resolveWithSystemGit);
}

export function resolveRepositoryRoot(
  startDirectory: string,
  resolveWithGit: GitRepositoryRootResolver,
): string {
  const resolvedStartDirectory = requireExistingDirectory(startDirectory, startDirectory);
  let candidate: string;

  try {
    candidate = resolveWithGit(resolvedStartDirectory).trim();
  } catch (cause) {
    // 背景：execFileSync 的 ENOENT 既可能表示 Git 不存在，也可能表示 cwd 在校验后被删除。
    // 目的：再次确认 cwd，避免把目录竞态误报成 Git 安装问题，同时完整保留底层 cause。
    // 上下文：这里不扫描 .git；任何 Git 启动失败都只能失败关闭。
    if (isGitLaunchFailure(cause) && isExistingDirectory(resolvedStartDirectory)) {
      throw new RepositoryRootError('GIT_UNAVAILABLE', startDirectory, cause);
    }
    throw new RepositoryRootError('REPOSITORY_NOT_FOUND', startDirectory, cause);
  }

  if (candidate.length === 0) {
    throw new RepositoryRootError(
      'REPOSITORY_NOT_FOUND',
      startDirectory,
      new Error('git rev-parse returned an empty repository root'),
    );
  }

  return requireExistingDirectory(candidate, startDirectory);
}

function resolveWithSystemGit(startDirectory: string): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: startDirectory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function requireExistingDirectory(directory: string, requestedStart: string): string {
  const resolvedDirectory = resolve(directory);
  try {
    if (statSync(resolvedDirectory).isDirectory()) return resolvedDirectory;
  } catch (cause) {
    throw new RepositoryRootError('REPOSITORY_NOT_FOUND', requestedStart, cause);
  }
  throw new RepositoryRootError('REPOSITORY_NOT_FOUND', requestedStart);
}

function isExistingDirectory(directory: string): boolean {
  try {
    return statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function isGitLaunchFailure(failure: unknown): boolean {
  const code = (failure as NodeJS.ErrnoException).code;
  return typeof code === 'string' && GIT_LAUNCH_FAILURE_CODES.has(code);
}
