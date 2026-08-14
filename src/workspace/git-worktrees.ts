import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { ensureDir, pathExists } from '../core/files.js';
import { worksetWorkspaceRoot } from './paths.js';
import type { RegisteredProject, Workset } from './types.js';

export interface WorksetWorktree {
  path: string;
  branch: string;
  sourceCommit: string;
}

export function worksetBranchName(workset: Workset): string {
  return `omnai/${workset.id}-${workset.slug}`;
}

export async function createWorksetWorktree(
  home: string,
  workset: Workset,
  project: RegisteredProject,
): Promise<WorksetWorktree> {
  const sourceRoot = gitOutput(project.path, ['rev-parse', '--show-toplevel']);
  if (resolve(sourceRoot) !== resolve(project.path)) {
    throw new Error(`Registered project path '${project.path}' is not the Git repository root.`);
  }

  const sourceCommit = gitOutput(sourceRoot, ['rev-parse', 'HEAD']);
  const branch = worksetBranchName(workset);
  const target = join(worksetWorkspaceRoot(home, workset.id), project.alias);

  if (await pathExists(target)) {
    return reuseExpectedWorktree(sourceRoot, target, branch, project.alias);
  }
  if (branchExists(sourceRoot, branch)) {
    throw new Error(`Worktree branch '${branch}' already exists in ${project.name}.`);
  }

  await ensureDir(dirname(target));
  try {
    execFileSync('git', ['worktree', 'add', target, '-b', branch, sourceCommit], {
      cwd: sourceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(`Unable to create Workset worktree for '${project.alias}': ${errorMessage(error)}`);
  }

  return { path: target, branch, sourceCommit };
}

function reuseExpectedWorktree(
  sourceRoot: string,
  target: string,
  expectedBranch: string,
  projectAlias: string,
): WorksetWorktree {
  try {
    const targetRoot = gitOutput(target, ['rev-parse', '--show-toplevel']);
    if (resolve(targetRoot) !== resolve(target)) {
      throw new Error('target is not the root of a Git worktree');
    }

    if (gitCommonDir(target) !== gitCommonDir(sourceRoot)) {
      throw new Error('target belongs to a different Git repository');
    }

    const actualBranch = gitOutput(target, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (actualBranch !== expectedBranch) {
      throw new Error(`target is on branch '${actualBranch}' instead of '${expectedBranch}'`);
    }

    return {
      path: target,
      branch: expectedBranch,
      sourceCommit: gitOutput(target, ['rev-parse', 'HEAD']),
    };
  } catch (error) {
    throw new Error(
      `Worktree target '${target}' already exists but is not the expected Workset worktree for '${projectAlias}': ${errorMessage(error)}`,
    );
  }
}

function gitCommonDir(cwd: string): string {
  const common = gitOutput(cwd, ['rev-parse', '--git-common-dir']);
  return resolve(cwd, common);
}

function gitOutput(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw new Error(`Git command failed in '${cwd}': ${errorMessage(error)}`);
  }
}

function branchExists(cwd: string, branch: string): boolean {
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
