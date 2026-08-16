import { resolve } from 'node:path';
import { pathExists } from '../core/files.js';
import { findRepositoryRoot, projectConfigPath } from '../core/paths.js';
import { loadProjectConfig } from '../core/store.js';
import { discoverExecutionContext } from '../workspace/execution-workspace.js';
import { resolveWorkset } from '../workspace/worksets.js';
import type { WorksetMemberStatus } from '../workspace/types.js';

export type OmnaiContext =
  | {
      scope: 'workset';
      cwd: string;
      worksetId: string;
      workspaceRoot: string;
      project: null;
    }
  | {
      scope: 'workset-project';
      cwd: string;
      worksetId: string;
      workspaceRoot: string;
      project: string;
      memberStatus: WorksetMemberStatus;
      repoRoot: string;
      changeId: string | null;
    }
  | {
      scope: 'repository';
      cwd: string;
      repoRoot: string;
      initialized: boolean;
      changeId: string | null;
    }
  | {
      scope: 'none';
      cwd: string;
    };

export async function resolveOmnaiContext(
  home: string,
  startPath = process.cwd(),
): Promise<OmnaiContext> {
  const cwd = resolve(startPath);
  const execution = await discoverExecutionContext(cwd);
  if (execution) {
    const workset = await resolveWorkset(home, execution.worksetId);
    const member = execution.project
      ? workset.members.find((item) => item.project === execution.project)
      : undefined;

    if (member?.worktree) {
      return {
        scope: 'workset-project',
        cwd,
        worksetId: workset.id,
        workspaceRoot: execution.workspaceRoot,
        project: member.project,
        memberStatus: member.status,
        repoRoot: member.worktree,
        changeId: member.changeId ?? null,
      };
    }

    return {
      scope: 'workset',
      cwd,
      worksetId: workset.id,
      workspaceRoot: execution.workspaceRoot,
      project: null,
    };
  }

  const repoRoot = tryFindRepositoryRoot(cwd);
  if (!repoRoot) return { scope: 'none', cwd };

  const initialized = await pathExists(projectConfigPath(repoRoot));
  if (!initialized) {
    return {
      scope: 'repository',
      cwd,
      repoRoot,
      initialized: false,
      changeId: null,
    };
  }

  const config = await loadProjectConfig(repoRoot);
  return {
    scope: 'repository',
    cwd,
    repoRoot,
    initialized: true,
    changeId: config.activeChange,
  };
}

function tryFindRepositoryRoot(startPath: string): string | null {
  try {
    return findRepositoryRoot(startPath);
  } catch {
    return null;
  }
}
