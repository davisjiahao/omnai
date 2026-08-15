import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AiWorkspaceError } from '../domain/errors';
import type { BranchInfo, CreationPlan, WorkspaceState } from '../domain/types';
import { NodePathMutator, WorkspaceOrchestrator } from './workspace-orchestrator';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

function plan(): CreationPlan {
  return {
    requirement: { id: 'REQ-8', title: 'Create two repositories' },
    workspacePath: '/workspaces/REQ-8',
    branchName: 'feature/REQ-8',
    repositories: [
      {
        id: 'api', displayName: 'API', sourcePath: '/src/api',
        worktreePath: '/workspaces/REQ-8/api', remote: 'origin',
        baseRef: 'origin/main', baseCommit: A, branch: 'feature/REQ-8',
        branchDisposition: 'create', branchInitialCommit: A
      },
      {
        id: 'web', displayName: 'Web', sourcePath: '/src/web',
        worktreePath: '/workspaces/REQ-8/web', remote: 'origin',
        baseRef: 'origin/main', baseCommit: B, branch: 'feature/REQ-8',
        branchDisposition: 'create', branchInitialCommit: B
      }
    ]
  };
}

function recoveringState(): WorkspaceState {
  const creation = plan();
  return {
    version: 1,
    status: 'recoveryRequired',
    requirement: { ...creation.requirement },
    workspacePath: creation.workspacePath,
    branchName: creation.branchName,
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
    openCodexOnNextActivation: true,
    repositories: creation.repositories.map(repository => ({
      id: repository.id,
      displayName: repository.displayName,
      sourcePath: repository.sourcePath,
      worktreePath: repository.worktreePath,
      remote: repository.remote,
      baseRef: repository.baseRef,
      baseCommit: repository.baseCommit,
      branch: repository.branch,
      branchExistedBefore: false,
      branchCreatedByOperation: true,
      branchInitialCommit: repository.branchInitialCommit,
      worktreeCreated: false
    })),
    recovery: { operation: 'create', stage: 'create', message: 'Creation needs recovery' }
  };
}

function harness() {
  const events: string[] = [];
  const writes: WorkspaceState[] = [];
  const lock = {
    info: {
      token: 'lock', processId: 123, operation: 'create' as const,
      startedAt: '2026-08-15T00:00:00.000Z'
    },
    release: vi.fn(async () => { events.push('release'); })
  };
  const repositories = {
    addWorktree: vi.fn(async (input: { targetPath: string }) => {
      events.push(`add:${input.targetPath}`);
    }),
    removeWorktree: vi.fn(async (sourcePath: string, targetPath: string) => {
      events.push(`remove:${targetPath}`);
    }),
    deleteBranchIfAt: vi.fn(async () => true),
    getBranchInfo: vi.fn(async (
      _sourcePath: string,
      _branch: string
    ): Promise<BranchInfo> => ({ exists: false })),
    isClean: vi.fn(async () => true)
  };
  const states = {
    acquireLock: vi.fn(async () => { events.push('lock'); return lock; }),
    acquireExistingLock: vi.fn(async () => { events.push('lock-existing'); return lock; }),
    readIfExists: vi.fn(async () => undefined as WorkspaceState | undefined),
    read: vi.fn(async () => recoveringState()),
    write: vi.fn(async (_workspacePath: string, state: WorkspaceState) => {
      events.push(`write:${state.status}`);
      writes.push(structuredClone(state));
    }),
    cleanupGeneratedMetadata: vi.fn(async (_workspacePath: string, _state: WorkspaceState) => {
      events.push('cleanup');
    })
  };
  const agents = {
    write: vi.fn(async () => { events.push('agents'); })
  };
  const paths = {
    exists: vi.fn(async () => false),
    isEmptyDirectory: vi.fn(async () => true),
    claim: vi.fn(async (targetPath: string) => { events.push(`claim:${targetPath}`); }),
    removeEmpty: vi.fn(async (_targetPath: string) => undefined)
  };
  const orchestrator = new WorkspaceOrchestrator(
    repositories,
    states,
    agents,
    () => new Date('2026-08-15T00:00:00.000Z'),
    paths
  );
  const options = { confirmBreakStaleLock: vi.fn(async () => false) };
  return { orchestrator, repositories, states, agents, paths, lock, writes, events, options };
}

describe('WorkspaceOrchestrator core transaction safety', () => {
  it('rejects a symlink to an empty directory as a recovery target', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-workspace-orchestrator-'));
    try {
      const outside = path.join(root, 'outside');
      const target = path.join(root, 'target');
      await fs.mkdir(outside);
      await fs.symlink(outside, target, 'dir');

      const paths = new NodePathMutator();
      await expect(paths.isEmptyDirectory(target)).resolves.toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('creates sequentially, journals every successful worktree, and marks ready', async () => {
    const test = harness();
    const state = await test.orchestrator.create(plan(), test.options);

    expect(test.repositories.addWorktree.mock.calls.map(call => call[0].targetPath))
      .toEqual(['/workspaces/REQ-8/api', '/workspaces/REQ-8/web']);
    expect(test.writes.filter(write => write.status === 'creating').map(write =>
      write.repositories.map(repository => repository.worktreeCreated)))
      .toEqual([[false, false], [true, false], [true, true]]);
    expect(state.status).toBe('ready');
    expect(state.repositories.every(repository => repository.worktreeCreated)).toBe(true);
    expect(test.agents.write).toHaveBeenCalledWith(plan().workspacePath, state);
  });

  it('does not let a delayed create overwrite state that appeared before lock acquisition', async () => {
    const test = harness();
    test.states.readIfExists.mockResolvedValueOnce(recoveringState());

    await expect(test.orchestrator.create(plan(), test.options))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(test.states.acquireLock).toHaveBeenCalled();
    expect(test.states.write).not.toHaveBeenCalled();
    expect(test.repositories.addWorktree).not.toHaveBeenCalled();
  });

  it('claims all targets exclusively before any Git mutation', async () => {
    const test = harness();
    const race = Object.assign(new Error('target appeared'), { code: 'EEXIST' });
    test.paths.claim.mockResolvedValueOnce(undefined).mockRejectedValueOnce(race);

    await expect(test.orchestrator.create(plan(), test.options)).rejects.toBe(race);
    expect(test.repositories.addWorktree).not.toHaveBeenCalled();
    expect(test.states.write).toHaveBeenCalledWith(
      '/workspaces/REQ-8',
      expect.objectContaining({ status: 'creating' })
    );
    expect(test.states.cleanupGeneratedMetadata).toHaveBeenCalledWith(
      '/workspaces/REQ-8',
      test.writes.at(-1)
    );
    expect(test.states.write.mock.invocationCallOrder[0]).toBeLessThan(
      test.paths.claim.mock.invocationCallOrder[0]!
    );
  });

  it('preserves the claim error when cleanup and recovery journalling also fail', async () => {
    const test = harness();
    const primary = Object.assign(new Error('target appeared'), { code: 'EEXIST' });
    const journal = new Error('recovery journal failed');
    test.paths.claim.mockResolvedValueOnce(undefined).mockRejectedValueOnce(primary);
    test.paths.removeEmpty.mockRejectedValueOnce(new Error('claim cleanup failed'));
    test.states.write.mockResolvedValueOnce(undefined).mockRejectedValueOnce(journal);

    await expect(test.orchestrator.create(plan(), test.options)).rejects.toMatchObject({
      code: 'RECOVERY_REQUIRED',
      cause: primary
    });

    expect(test.states.cleanupGeneratedMetadata).not.toHaveBeenCalled();
  });

  it('rejects a changed planned branch head or new worktree occupancy before mutation', async () => {
    const test = harness();
    const original = plan();
    const stalePlan: CreationPlan = {
      ...original,
      repositories: [
        {
          ...original.repositories[0]!,
          branchDisposition: 'reuse',
          branchInitialCommit: A
        },
        original.repositories[1]!
      ]
    };
    test.repositories.getBranchInfo.mockResolvedValueOnce({ exists: true, head: C });

    await expect(test.orchestrator.create(stalePlan, test.options))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(test.paths.claim).not.toHaveBeenCalled();
    expect(test.repositories.addWorktree).not.toHaveBeenCalled();
  });

  it('treats an add error as ambiguous, never removes that repository, and keeps recovery state', async () => {
    const test = harness();
    test.repositories.getBranchInfo
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce({
        exists: true,
        head: A,
        worktreePath: '/workspaces/REQ-8/api'
      });
    test.repositories.addWorktree
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('ambiguous second add'));

    await expect(test.orchestrator.create(plan(), test.options))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(test.repositories.removeWorktree).toHaveBeenCalledWith(
      '/src/api', '/workspaces/REQ-8/api'
    );
    expect(test.repositories.removeWorktree).not.toHaveBeenCalledWith(
      '/src/web', '/workspaces/REQ-8/web'
    );
    expect(test.writes.at(-1)).toMatchObject({
      status: 'recoveryRequired', recovery: { operation: 'create' }
    });
  });

  it('does not clean metadata when lock release fails and preserves the primary error', async () => {
    const test = harness();
    const primary = new Error('AGENTS write failed');
    test.agents.write.mockRejectedValueOnce(primary);
    test.lock.release.mockRejectedValueOnce(new Error('release failed'));

    await expect(test.orchestrator.create(plan(), test.options)).rejects.toBe(primary);
    expect(test.states.cleanupGeneratedMetadata).not.toHaveBeenCalled();
  });

  it('uses the exact cleanup journal after complete rollback and rethrows the original error', async () => {
    const test = harness();
    const primary = new Error('AGENTS write failed');
    test.agents.write.mockRejectedValueOnce(primary);

    await expect(test.orchestrator.create(plan(), test.options)).rejects.toBe(primary);
    const [workspacePath, expected] = test.states.cleanupGeneratedMetadata.mock.calls[0]!;
    expect(workspacePath).toBe('/workspaces/REQ-8');
    expect(expected).toEqual(test.writes.at(-1));
    expect(test.events.indexOf('release')).toBeLessThan(test.events.indexOf('cleanup'));
  });

  it('acquires an existing lock before rereading authoritative recovery state', async () => {
    const test = harness();
    test.states.read.mockImplementationOnce(async () => {
      test.events.push('read');
      return recoveringState();
    });
    test.repositories.getBranchInfo.mockImplementation(async (sourcePath: string, _branch: string) => ({
      exists: true,
      head: sourcePath === '/src/api' ? A : B,
      worktreePath: sourcePath === '/src/api'
        ? '/workspaces/REQ-8/api'
        : '/workspaces/REQ-8/web'
    }));

    await test.orchestrator.recover('/workspaces/REQ-8', 'continue', test.options);
    expect(test.events.indexOf('lock-existing')).toBeLessThan(test.events.indexOf('read'));
    expect(test.states.readIfExists).not.toHaveBeenCalled();
  });

  it('honours cancellation raised by the progress callback before invoking Git', async () => {
    const test = harness();
    const controller = new AbortController();

    await expect(test.orchestrator.create(plan(), {
      ...test.options,
      signal: controller.signal,
      onProgress: progress => {
        if (progress.stage === 'create') controller.abort();
      }
    })).rejects.toMatchObject({ code: 'CANCELLED' });

    expect(test.repositories.addWorktree).not.toHaveBeenCalled();
  });

  it('does not adopt an unowned branch that appeared at a different commit during recovery', async () => {
    const test = harness();
    const state = recoveringState();
    state.repositories[0]!.branchCreatedByOperation = false;
    test.states.read.mockResolvedValueOnce(state);
    test.repositories.getBranchInfo.mockResolvedValueOnce({ exists: true, head: C });

    await expect(test.orchestrator.recover(
      '/workspaces/REQ-8',
      'continue',
      test.options
    )).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(test.repositories.addWorktree).not.toHaveBeenCalled();
  });

  it('never deletes a branch that the transaction planned to reuse', async () => {
    const test = harness();
    const original = plan();
    const reused: CreationPlan = {
      ...original,
      repositories: [
        {
          ...original.repositories[0]!,
          branchDisposition: 'reuse',
          branchInitialCommit: C
        },
        original.repositories[1]!
      ]
    };
    test.repositories.getBranchInfo
      .mockResolvedValueOnce({ exists: true, head: C })
      .mockResolvedValueOnce({ exists: false });
    const primary = new Error('AGENTS write failed');
    test.agents.write.mockRejectedValueOnce(primary);

    await expect(test.orchestrator.create(reused, test.options)).rejects.toBe(primary);

    expect(test.repositories.deleteBranchIfAt).not.toHaveBeenCalledWith(
      '/src/api',
      'feature/REQ-8',
      C
    );
  });

  it('keeps a dirty owned worktree in recovery instead of removing it', async () => {
    const test = harness();
    test.agents.write.mockRejectedValueOnce(new Error('AGENTS write failed'));
    test.repositories.isClean.mockResolvedValue(false);
    test.repositories.getBranchInfo
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce({
        exists: true,
        head: B,
        worktreePath: '/workspaces/REQ-8/web'
      })
      .mockResolvedValueOnce({
        exists: true,
        head: A,
        worktreePath: '/workspaces/REQ-8/api'
      });

    await expect(test.orchestrator.create(plan(), test.options))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });

    expect(test.repositories.removeWorktree).not.toHaveBeenCalled();
    expect(test.writes.at(-1)).toMatchObject({
      status: 'recoveryRequired',
      recovery: { operation: 'create', stage: 'rollback-incomplete' }
    });
  });

  it('explicitly rolls back only journalled ownership and cleans after releasing the lock', async () => {
    const test = harness();
    const state = recoveringState();
    for (const repository of state.repositories) repository.worktreeCreated = true;
    test.states.read.mockResolvedValueOnce(state);
    test.repositories.getBranchInfo
      .mockResolvedValueOnce({
        exists: true,
        head: B,
        worktreePath: '/workspaces/REQ-8/web'
      })
      .mockResolvedValueOnce({
        exists: true,
        head: A,
        worktreePath: '/workspaces/REQ-8/api'
      });

    await expect(test.orchestrator.recover(
      '/workspaces/REQ-8',
      'rollback',
      test.options
    )).resolves.toBeUndefined();

    expect(test.repositories.removeWorktree.mock.calls.map(call => call[1]))
      .toEqual(['/workspaces/REQ-8/web', '/workspaces/REQ-8/api']);
    expect(test.paths.removeEmpty.mock.calls.map(call => call[0]))
      .toEqual(['/workspaces/REQ-8/web', '/workspaces/REQ-8/api']);
    expect(test.events.indexOf('release')).toBeLessThan(test.events.indexOf('cleanup'));
  });

  it('does not infer ownership for an ambiguous exact-target worktree during rollback', async () => {
    const test = harness();
    const state = recoveringState();
    state.repositories[0]!.branchCreatedByOperation = false;
    test.states.read.mockResolvedValueOnce(state);
    test.repositories.getBranchInfo.mockResolvedValueOnce({
      exists: true,
      head: A,
      worktreePath: '/workspaces/REQ-8/api'
    });

    await expect(test.orchestrator.recover(
      '/workspaces/REQ-8',
      'rollback',
      test.options
    )).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });

    expect(test.repositories.removeWorktree).not.toHaveBeenCalled();
    expect(test.repositories.deleteBranchIfAt).not.toHaveBeenCalledWith(
      '/src/api',
      'feature/REQ-8',
      A
    );
    expect(test.states.cleanupGeneratedMetadata).not.toHaveBeenCalled();
  });

  it('surfaces unlock failure when successful creation has no earlier error', async () => {
    const test = harness();
    const unlock = new Error('release failed');
    test.lock.release.mockRejectedValueOnce(unlock);

    await expect(test.orchestrator.create(plan(), test.options)).rejects.toBe(unlock);
    expect(test.states.cleanupGeneratedMetadata).not.toHaveBeenCalled();
  });

  it('reconciles a worktree already removed before its rollback journal write', async () => {
    const test = harness();
    const state = recoveringState();
    state.repositories = [state.repositories[0]!];
    state.repositories[0]!.worktreeCreated = true;
    state.repositories[0]!.branchCreatedByOperation = true;
    test.states.read.mockResolvedValueOnce(state);
    test.repositories.getBranchInfo
      .mockResolvedValueOnce({ exists: true, head: A })
      .mockResolvedValueOnce({ exists: false });
    test.repositories.deleteBranchIfAt.mockResolvedValueOnce(false);

    await expect(test.orchestrator.recover(
      '/workspaces/REQ-8',
      'rollback',
      test.options
    )).resolves.toBeUndefined();

    expect(test.repositories.removeWorktree).not.toHaveBeenCalled();
    expect(test.repositories.deleteBranchIfAt).toHaveBeenCalled();
    expect(test.writes.some(write =>
      write.repositories[0]?.worktreeCreated === false
      && write.repositories[0]?.branchCreatedByOperation === true)).toBe(true);
    expect(test.writes.at(-1)?.repositories[0]).toMatchObject({
      worktreeCreated: false,
      branchCreatedByOperation: false
    });
  });

  it('continues an exact-target worktree without claiming ownership of its branch', async () => {
    const test = harness();
    const state = recoveringState();
    state.repositories = [state.repositories[0]!];
    state.repositories[0]!.worktreeCreated = false;
    state.repositories[0]!.branchCreatedByOperation = false;
    test.states.read.mockResolvedValueOnce(state);
    test.repositories.getBranchInfo.mockResolvedValueOnce({
      exists: true,
      head: A,
      worktreePath: '/workspaces/REQ-8/api'
    });

    const result = await test.orchestrator.recover(
      '/workspaces/REQ-8',
      'continue',
      test.options
    );

    expect(result?.repositories[0]).toMatchObject({
      worktreeCreated: true,
      branchCreatedByOperation: false
    });
    expect(test.repositories.addWorktree).not.toHaveBeenCalled();
  });

  it('claims a missing recovery target before adding an unoccupied retained branch', async () => {
    const test = harness();
    const state = recoveringState();
    state.repositories = [state.repositories[0]!];
    state.repositories[0]!.worktreeCreated = false;
    state.repositories[0]!.branchCreatedByOperation = false;
    test.states.read.mockResolvedValueOnce(state);
    test.repositories.getBranchInfo.mockResolvedValueOnce({ exists: true, head: A });

    await test.orchestrator.recover('/workspaces/REQ-8', 'continue', test.options);

    expect(test.paths.claim).toHaveBeenCalledWith('/workspaces/REQ-8/api');
    expect(test.paths.claim.mock.invocationCallOrder[0]).toBeLessThan(
      test.repositories.addWorktree.mock.invocationCallOrder[0]!
    );
    expect(test.repositories.addWorktree).toHaveBeenCalledWith(expect.objectContaining({
      targetPath: '/workspaces/REQ-8/api',
      createBranch: false
    }));
  });

  it('reclaims an existing empty recovery placeholder before invoking Git', async () => {
    const test = harness();
    const state = recoveringState();
    state.repositories = [state.repositories[0]!];
    state.repositories[0]!.branchCreatedByOperation = false;
    test.states.read.mockResolvedValueOnce(state);
    test.repositories.getBranchInfo.mockResolvedValueOnce({ exists: true, head: A });
    test.paths.exists.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    test.paths.isEmptyDirectory.mockResolvedValueOnce(true);

    await test.orchestrator.recover('/workspaces/REQ-8', 'continue', test.options);

    expect(test.paths.removeEmpty).toHaveBeenCalledWith('/workspaces/REQ-8/api');
    expect(test.paths.claim).toHaveBeenCalledWith('/workspaces/REQ-8/api');
    expect(test.paths.claim.mock.invocationCallOrder[0]).toBeLessThan(
      test.repositories.addWorktree.mock.invocationCallOrder[0]!
    );
  });
});
