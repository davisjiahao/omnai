import { execFileSync, spawnSync } from 'node:child_process';

export interface GitMetadata {
  branch: string;
  commit: string;
  repositoryRoot: string;
  dirty: boolean;
}

export function readGitMetadata(cwd: string): GitMetadata {
  return {
    branch: git(cwd, ['branch', '--show-current']) || 'detached',
    commit: git(cwd, ['rev-parse', 'HEAD']),
    repositoryRoot: git(cwd, ['rev-parse', '--show-toplevel']),
    dirty: git(cwd, ['status', '--porcelain']).length > 0,
  };
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function initializeGitRepository(cwd: string): void {
  const result = spawnSync('git', ['init'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || 'Unable to initialize Git repository');
  }
}
