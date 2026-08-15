import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  BranchInfo,
  RepositoryStatus,
  WorkspaceLockInfo,
  WorkspaceState
} from '../domain/types';
import { NodePathProbe, WorkspaceLifecycle } from './workspace-lifecycle';

const OID = 'a'.repeat(40);
const WORKSPACE_PATH = '/workspaces/REQ-9';
const WORKTREE_PATH = `${WORKSPACE_PATH}/api`;

function workspaceState(status: WorkspaceState['status'] = 'ready'): WorkspaceState {
  return {
    version: 1,
    status,
    requirement: { id: 'REQ-9', title: 'Lifecycle safety' },
    workspacePath: WORKSPACE_PATH,
    branchName: 'feature/REQ-9',
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
    openCodexOnNextActivation: status !== 'finished',
    repositories: [{
      id: 'api',
      displayName: 'API',
      sourcePath: '/src/api',
      worktreePath: WORKTREE_PATH,
      remote: 'origin',
      baseRef: 'origin/main',
      baseCommit: OID,
      branch: 'feature/REQ-9',
      branchExistedBefore: false,
      branchCreatedByOperation: true,
      branchInitialCommit: OID,
      worktreeCreated: status !== 'finished'
    }]
  };
}

function harness(initial = workspaceState()) {
  const events: string[] = [];
  const writes: WorkspaceState[] = [];
  let authoritative = structuredClone(initial);
  const lock = {
    info: {
      token: 'lock',
      processId: 123,
      operation: 'recover' as const,
      startedAt: '2026-08-15T00:00:00.000Z'
    },
    release: vi.fn(async () => { events.push('release'); })
  };
  const repositories = {
    getBranchInfo: vi.fn(async (
      _sourcePath: string,
      _branch: string
    ): Promise<BranchInfo> => ({
      exists: true,
      head: OID,
      worktreePath: WORKTREE_PATH
    })),
    getStatus: vi.fn(async (): Promise<RepositoryStatus> => ({
      dirtyFileCount: 0,
      publication: 'synced',
      ahead: 0,
      behind: 0
    })),
    addWorktree: vi.fn(async () => { events.push('add'); }),
    removeWorktree: vi.fn(async () => { events.push('remove'); })
  };
  const states = {
    acquireExistingLock: vi.fn(async (
      _workspacePath: string,
      operation: WorkspaceLockInfo['operation']
    ) => {
      events.push(`lock:${operation}`);
      return lock;
    }),
    read: vi.fn(async () => {
      events.push('read');
      return structuredClone(authoritative);
    }),
    write: vi.fn(async (_workspacePath: string, state: WorkspaceState) => {
      events.push(`write:${state.status}:${state.recovery?.stage ?? 'complete'}`);
      authoritative = structuredClone(state);
      writes.push(structuredClone(state));
    })
  };
  const agents = {
    write: vi.fn(async () => { events.push('agents'); })
  };
  const paths = {
    exists: vi.fn(async () => initial.status !== 'finished'),
    isRealDirectory: vi.fn(async () => true),
    isEmptyDirectory: vi.fn(async () => false),
    claim: vi.fn(async () => { events.push('claim'); }),
    removeEmpty: vi.fn(async () => { events.push('remove-empty'); })
  };
  const lifecycle = new WorkspaceLifecycle(
    repositories,
    states,
    agents,
    paths,
    () => new Date('2026-08-15T01:00:00.000Z')
  );
  const options = {
    confirmBreakStaleLock: vi.fn(async () => false),
    confirmUnpublished: vi.fn(async () => true)
  };
  return {
    lifecycle,
    repositories,
    states,
    agents,
    paths,
    lock,
    writes,
    events,
    options,
    replaceAuthoritative: (state: WorkspaceState) => { authoritative = structuredClone(state); }
  };
}

describe('WorkspaceLifecycle authoritative state binding', () => {
  async function invoke(
    operation: 'inspect' | 'resume' | 'finish',
    test: ReturnType<typeof harness>
  ): Promise<unknown> {
    if (operation === 'inspect') return test.lifecycle.inspect(WORKSPACE_PATH);
    if (operation === 'resume') return test.lifecycle.resume(WORKSPACE_PATH, test.options);
    return test.lifecycle.finish(WORKSPACE_PATH, test.options);
  }

  function expectNoExternalAccess(test: ReturnType<typeof harness>): void {
    expect(test.paths.exists).not.toHaveBeenCalled();
    expect(test.paths.isRealDirectory).not.toHaveBeenCalled();
    expect(test.paths.isEmptyDirectory).not.toHaveBeenCalled();
    expect(test.repositories.getBranchInfo).not.toHaveBeenCalled();
    expect(test.repositories.getStatus).not.toHaveBeenCalled();
    expect(test.repositories.addWorktree).not.toHaveBeenCalled();
    expect(test.repositories.removeWorktree).not.toHaveBeenCalled();
    expect(test.agents.write).not.toHaveBeenCalled();
    expect(test.states.write).not.toHaveBeenCalled();
  }

  it.each(['inspect', 'resume', 'finish'] as const)(
    'rejects a copied state file during %s before following its workspace path',
    async operation => {
      const state = workspaceState();
      state.workspacePath = '/copied/REQ-9';
      state.repositories[0]!.worktreePath = '/copied/REQ-9/api';
      const test = harness(state);

      await expect(invoke(operation, test)).rejects.toMatchObject({ code: 'CONFLICT' });
      expectNoExternalAccess(test);
    }
  );

  it.each(['inspect', 'resume', 'finish'] as const)(
    'rejects an external repository target during %s before probing it',
    async operation => {
      const state = workspaceState();
      state.repositories[0]!.worktreePath = '/external/api';
      const test = harness(state);

      await expect(invoke(operation, test)).rejects.toMatchObject({ code: 'CONFLICT' });
      expectNoExternalAccess(test);
    }
  );

  it.each(['inspect', 'resume', 'finish'] as const)(
    'rejects a per-repository branch that differs from branchName during %s',
    async operation => {
      const state = workspaceState();
      state.repositories[0]!.branch = 'feature/other';
      const test = harness(state);

      await expect(invoke(operation, test)).rejects.toMatchObject({ code: 'CONFLICT' });
      expectNoExternalAccess(test);
    }
  );
});

describe('WorkspaceLifecycle inspection', () => {
  it('inspects an exact registered ready worktree', async () => {
    const test = harness();

    await expect(test.lifecycle.inspect(WORKSPACE_PATH)).resolves.toMatchObject({
      repositories: [{ health: 'ready', git: { publication: 'synced' } }]
    });
  });

  it('gives a missing path priority and does not query an occupied branch', async () => {
    const test = harness();
    test.paths.exists.mockResolvedValue(false);
    test.repositories.getBranchInfo.mockResolvedValue({
      exists: true,
      head: OID,
      worktreePath: '/other/worktree'
    });

    await expect(test.lifecycle.inspect(WORKSPACE_PATH)).resolves.toMatchObject({
      repositories: [{ health: 'missing' }]
    });
    expect(test.repositories.getBranchInfo).not.toHaveBeenCalled();
    expect(test.repositories.getStatus).not.toHaveBeenCalled();
  });

  it('marks an existing target occupied when its branch is registered elsewhere', async () => {
    const test = harness();
    test.repositories.getBranchInfo.mockResolvedValue({
      exists: true,
      head: OID,
      worktreePath: '/other/worktree'
    });

    await expect(test.lifecycle.inspect(WORKSPACE_PATH)).resolves.toMatchObject({
      repositories: [{ health: 'occupied' }]
    });
    expect(test.repositories.getStatus).not.toHaveBeenCalled();
  });

  it('treats a durable real empty target placeholder as a missing worktree', async () => {
    const test = harness(workspaceState('finished'));
    test.paths.exists.mockResolvedValue(true);
    test.paths.isEmptyDirectory.mockResolvedValue(true);
    test.repositories.getBranchInfo.mockResolvedValue({ exists: true, head: OID });

    await expect(test.lifecycle.inspect(WORKSPACE_PATH)).resolves.toMatchObject({
      repositories: [{ health: 'missing' }]
    });
    expect(test.repositories.getStatus).not.toHaveBeenCalled();
  });

  it('does not follow symlinks or accept non-directories as empty placeholders', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-workspace-path-probe-'));
    const emptyDirectory = path.join(root, 'empty');
    const link = path.join(root, 'link');
    const file = path.join(root, 'file');
    try {
      await mkdir(emptyDirectory);
      await writeFile(file, 'not a directory', 'utf8');
      await symlink(
        emptyDirectory,
        link,
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      const probe = new NodePathProbe();

      await expect(probe.isRealDirectory(emptyDirectory)).resolves.toBe(true);
      await expect(probe.isRealDirectory(link)).resolves.toBe(false);
      await expect(probe.isRealDirectory(file)).resolves.toBe(false);
      await expect(probe.isEmptyDirectory(emptyDirectory)).resolves.toBe(true);
      await expect(probe.isEmptyDirectory(link)).resolves.toBe(false);
      await expect(probe.isEmptyDirectory(file)).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['symlink', 'non-directory'])(
    'rejects an exact registered target that is a %s before Git status',
    async () => {
      const test = harness();
      test.paths.isRealDirectory.mockResolvedValue(false);

      await expect(test.lifecycle.inspect(WORKSPACE_PATH)).resolves.toMatchObject({
        repositories: [{ health: 'occupied' }]
      });
      expect(test.repositories.getBranchInfo).not.toHaveBeenCalled();
      expect(test.repositories.getStatus).not.toHaveBeenCalled();
    }
  );

  it('isolates and redacts per-repository inspection errors', async () => {
    const state = workspaceState();
    state.repositories.push({
      ...state.repositories[0]!,
      id: 'web',
      displayName: 'Web',
      sourcePath: '/src/web',
      worktreePath: `${WORKSPACE_PATH}/web`
    });
    const test = harness(state);
    test.paths.exists.mockResolvedValue(true);
    test.repositories.getBranchInfo
      .mockRejectedValueOnce(new Error('https://user:secret@example.com/private'))
      .mockResolvedValueOnce({
        exists: true,
        head: OID,
        worktreePath: `${WORKSPACE_PATH}/web`
      });

    const inspection = await test.lifecycle.inspect(WORKSPACE_PATH);
    expect(inspection.repositories.map(repository => repository.health))
      .toEqual(['unavailable', 'ready']);
    expect(inspection.repositories[0]?.message).toContain('https://***@example.com/private');
    expect(inspection.repositories[0]?.message).not.toContain('secret');
  });

  it('maps dirty before unpublished and maps no-upstream as unpublished', async () => {
    const state = workspaceState();
    state.repositories.push({
      ...state.repositories[0]!,
      id: 'web',
      displayName: 'Web',
      sourcePath: '/src/web',
      worktreePath: `${WORKSPACE_PATH}/web`
    });
    const test = harness(state);
    test.paths.exists.mockResolvedValue(true);
    test.repositories.getBranchInfo
      .mockResolvedValueOnce({ exists: true, head: OID, worktreePath: WORKTREE_PATH })
      .mockResolvedValueOnce({
        exists: true, head: OID, worktreePath: `${WORKSPACE_PATH}/web`
      });
    test.repositories.getStatus
      .mockResolvedValueOnce({
        dirtyFileCount: 1, publication: 'ahead', ahead: 2, behind: 0
      })
      .mockResolvedValueOnce({
        dirtyFileCount: 0, publication: 'no-upstream', ahead: 0, behind: 0
      });

    const inspection = await test.lifecycle.inspect(WORKSPACE_PATH);
    expect(inspection.repositories.map(repository => repository.health))
      .toEqual(['dirty', 'unpublished']);
  });
});

describe('WorkspaceLifecycle resume', () => {
  it('locks before reading the authoritative replacement and resumes retained branches only', async () => {
    const test = harness(workspaceState('finished'));
    test.repositories.getBranchInfo.mockResolvedValue({ exists: true, head: OID });

    const resumed = await test.lifecycle.resume(WORKSPACE_PATH, test.options);

    expect(test.events.indexOf('lock:recover')).toBeLessThan(test.events.indexOf('read'));
    expect(test.repositories.addWorktree).toHaveBeenCalledWith(expect.objectContaining({
      branch: 'feature/REQ-9',
      createBranch: false
    }));
    expect(test.writes[0]).toMatchObject({
      status: 'recoveryRequired',
      recovery: { operation: 'resume', stage: 'prepare' }
    });
    expect(resumed).toMatchObject({ status: 'ready', openCodexOnNextActivation: true });
  });

  it('uses state installed at the lock barrier rather than an earlier snapshot', async () => {
    const test = harness(workspaceState('ready'));
    const replacement = workspaceState('finished');
    replacement.branchName = 'feature/replaced';
    replacement.repositories[0]!.branch = 'feature/replaced';
    test.paths.exists.mockResolvedValue(false);
    test.repositories.getBranchInfo.mockResolvedValue({ exists: true, head: OID });
    test.states.acquireExistingLock.mockImplementationOnce(async () => {
      test.events.push('lock:recover');
      test.replaceAuthoritative(replacement);
      return test.lock;
    });

    await test.lifecycle.resume(WORKSPACE_PATH, test.options);

    expect(test.states.read).toHaveBeenCalledOnce();
    expect(test.repositories.addWorktree).toHaveBeenCalledWith(expect.objectContaining({
      branch: 'feature/replaced', createBranch: false
    }));
  });

  it('does not invoke Git when the prepare journal cannot be persisted', async () => {
    const test = harness(workspaceState('finished'));
    const failure = new Error('prepare failed');
    test.repositories.getBranchInfo.mockResolvedValue({ exists: true, head: OID });
    test.states.write.mockRejectedValueOnce(failure);

    await expect(test.lifecycle.resume(WORKSPACE_PATH, test.options)).rejects.toBe(failure);
    expect(test.paths.claim).not.toHaveBeenCalled();
    expect(test.repositories.addWorktree).not.toHaveBeenCalled();
  });

  it('removes and exclusively reclaims a durable empty placeholder before retrying add', async () => {
    const test = harness(workspaceState('finished'));
    test.paths.exists
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    test.paths.isEmptyDirectory.mockResolvedValue(true);
    test.repositories.getBranchInfo.mockResolvedValue({ exists: true, head: OID });

    await expect(test.lifecycle.resume(WORKSPACE_PATH, test.options))
      .resolves.toMatchObject({ status: 'ready' });

    expect(test.paths.removeEmpty).toHaveBeenCalledWith(WORKTREE_PATH);
    expect(test.repositories.getBranchInfo.mock.invocationCallOrder[1]).toBeLessThan(
      test.paths.removeEmpty.mock.invocationCallOrder[0]!
    );
    expect(test.paths.removeEmpty.mock.invocationCallOrder[0]).toBeLessThan(
      test.paths.claim.mock.invocationCallOrder[0]!
    );
    expect(test.paths.claim.mock.invocationCallOrder[0]).toBeLessThan(
      test.repositories.addWorktree.mock.invocationCallOrder[0]!
    );
    expect(test.repositories.addWorktree).toHaveBeenCalledWith(expect.objectContaining({
      createBranch: false,
      targetPath: WORKTREE_PATH
    }));
  });

  it('validates the retained branch before removing an empty placeholder', async () => {
    const test = harness(workspaceState('finished'));
    test.paths.exists.mockResolvedValue(true);
    test.paths.isEmptyDirectory.mockResolvedValue(true);
    test.repositories.getBranchInfo.mockResolvedValue({
      exists: true,
      head: OID,
      worktreePath: '/other/worktree'
    });

    await expect(test.lifecycle.resume(WORKSPACE_PATH, test.options))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(test.paths.removeEmpty).not.toHaveBeenCalled();
    expect(test.paths.claim).not.toHaveBeenCalled();
    expect(test.repositories.addWorktree).not.toHaveBeenCalled();
  });

  it('keeps recovery when journalling fails after a successful Git add', async () => {
    const test = harness(workspaceState('finished'));
    test.repositories.getBranchInfo.mockResolvedValue({ exists: true, head: OID });
    test.states.write
      .mockImplementationOnce(async (_path, state) => { test.writes.push(structuredClone(state)); })
      .mockRejectedValueOnce(new Error('journal failed'));

    await expect(test.lifecycle.resume(WORKSPACE_PATH, test.options))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(test.repositories.addWorktree).toHaveBeenCalledOnce();
    expect(test.repositories.removeWorktree).not.toHaveBeenCalled();
    expect(test.writes[0]).toMatchObject({
      status: 'recoveryRequired', recovery: { operation: 'resume', stage: 'prepare' }
    });
  });

  it.each([
    [{ exists: false } satisfies BranchInfo, 'missing'],
    [{ exists: true, head: OID, worktreePath: '/other/worktree' } satisfies BranchInfo, 'occupied']
  ])('rejects a retained branch that is %s without creating a new branch', async (
    branch,
    _label
  ) => {
    const test = harness(workspaceState('finished'));
    test.repositories.getBranchInfo.mockResolvedValue(branch);

    await expect(test.lifecycle.resume(WORKSPACE_PATH, test.options))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(test.repositories.addWorktree).not.toHaveBeenCalled();
    expect(test.writes.at(-1)).toMatchObject({
      status: 'recoveryRequired', recovery: { operation: 'resume' }
    });
  });

  it('rejects a target claimed after inspection and never invokes Git', async () => {
    const test = harness(workspaceState('finished'));
    test.repositories.getBranchInfo.mockResolvedValue({ exists: true, head: OID });
    test.paths.exists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(test.lifecycle.resume(WORKSPACE_PATH, test.options))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(test.repositories.addWorktree).not.toHaveBeenCalled();
  });

  it('converts an exclusive target-claim collision to a conflict', async () => {
    const test = harness(workspaceState('finished'));
    test.repositories.getBranchInfo.mockResolvedValue({ exists: true, head: OID });
    test.paths.exists.mockResolvedValue(false);
    test.paths.claim.mockRejectedValueOnce(Object.assign(new Error('claimed'), { code: 'EEXIST' }));

    await expect(test.lifecycle.resume(WORKSPACE_PATH, test.options))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(test.repositories.addWorktree).not.toHaveBeenCalled();
  });

  it('treats add failure as ambiguous and does not clean the claimed target', async () => {
    const test = harness(workspaceState('finished'));
    const failure = new Error('ambiguous add');
    test.repositories.getBranchInfo.mockResolvedValue({ exists: true, head: OID });
    test.repositories.addWorktree.mockRejectedValueOnce(failure);

    await expect(test.lifecycle.resume(WORKSPACE_PATH, test.options))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED', cause: failure });
    expect(test.paths.removeEmpty).not.toHaveBeenCalled();
    expect(test.writes.at(-1)).toMatchObject({
      recovery: { operation: 'resume', stage: 'ambiguous-git-mutation' }
    });
  });

  it('cancels after a claim but before Git and removes only that empty claim', async () => {
    const test = harness(workspaceState('finished'));
    const controller = new AbortController();
    test.repositories.getBranchInfo.mockResolvedValue({ exists: true, head: OID });

    await expect(test.lifecycle.resume(WORKSPACE_PATH, {
      ...test.options,
      signal: controller.signal,
      onProgress: () => controller.abort()
    })).rejects.toMatchObject({ code: 'CANCELLED' });

    expect(test.repositories.addWorktree).not.toHaveBeenCalled();
    expect(test.paths.removeEmpty).toHaveBeenCalledWith(WORKTREE_PATH);
  });

  it('surfaces unlock failure after an otherwise successful resume', async () => {
    const test = harness(workspaceState('finished'));
    const unlock = new Error('unlock failed');
    test.repositories.getBranchInfo.mockResolvedValue({ exists: true, head: OID });
    test.lock.release.mockRejectedValueOnce(unlock);

    await expect(test.lifecycle.resume(WORKSPACE_PATH, test.options)).rejects.toBe(unlock);
  });
});

describe('WorkspaceLifecycle finish', () => {
  it('blocks a switched target branch before removing any worktree', async () => {
    const test = harness();
    test.repositories.getBranchInfo.mockResolvedValue({ exists: true, head: OID });

    await expect(test.lifecycle.finish(WORKSPACE_PATH, test.options))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(test.repositories.removeWorktree).not.toHaveBeenCalled();
  });

  it('writes a finish prepare journal before removal and preserves metadata on success', async () => {
    const test = harness();

    const finished = await test.lifecycle.finish(WORKSPACE_PATH, test.options);

    expect(test.writes[0]).toMatchObject({
      status: 'recoveryRequired',
      recovery: { operation: 'finish', stage: 'prepare' }
    });
    expect(test.events.indexOf('write:recoveryRequired:prepare'))
      .toBeLessThan(test.events.indexOf('remove'));
    expect(finished).toMatchObject({ status: 'finished', openCodexOnNextActivation: false });
    expect(test.agents.write).not.toHaveBeenCalled();
  });

  it('reads the finish state only after acquiring the existing-directory lock', async () => {
    const test = harness();
    const replacement = workspaceState('ready');
    replacement.branchName = 'feature/replaced';
    replacement.repositories[0]!.branch = 'feature/replaced';
    test.states.acquireExistingLock.mockImplementationOnce(async () => {
      test.events.push('lock:finish');
      test.replaceAuthoritative(replacement);
      return test.lock;
    });

    await test.lifecycle.finish(WORKSPACE_PATH, test.options);

    expect(test.events.indexOf('lock:finish')).toBeLessThan(test.events.indexOf('read'));
    expect(test.states.read).toHaveBeenCalledOnce();
    expect(test.repositories.getBranchInfo).toHaveBeenCalledWith('/src/api', 'feature/replaced');
  });

  it('does not remove anything when the finish prepare journal fails', async () => {
    const test = harness();
    const failure = new Error('prepare failed');
    test.states.write.mockRejectedValueOnce(failure);

    await expect(test.lifecycle.finish(WORKSPACE_PATH, test.options)).rejects.toBe(failure);
    expect(test.repositories.removeWorktree).not.toHaveBeenCalled();
  });

  it('completes inspection and blocks all removals when one repository is dirty', async () => {
    const state = workspaceState();
    state.repositories.push({
      ...state.repositories[0]!,
      id: 'web',
      displayName: 'Web',
      sourcePath: '/src/web',
      worktreePath: `${WORKSPACE_PATH}/web`
    });
    const test = harness(state);
    test.paths.exists.mockResolvedValue(true);
    test.repositories.getBranchInfo
      .mockResolvedValueOnce({ exists: true, head: OID, worktreePath: WORKTREE_PATH })
      .mockResolvedValueOnce({
        exists: true, head: OID, worktreePath: `${WORKSPACE_PATH}/web`
      });
    test.repositories.getStatus
      .mockResolvedValueOnce({
        dirtyFileCount: 2, publication: 'synced', ahead: 0, behind: 0
      })
      .mockResolvedValueOnce({
        dirtyFileCount: 0, publication: 'synced', ahead: 0, behind: 0
      });

    await expect(test.lifecycle.finish(WORKSPACE_PATH, test.options))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(test.repositories.getStatus).toHaveBeenCalledTimes(2);
    expect(test.repositories.removeWorktree).not.toHaveBeenCalled();
  });

  it.each(['ahead', 'no-upstream'] as const)(
    'confirms %s repositories exactly once and cancellation removes nothing',
    async publication => {
      const test = harness();
      test.repositories.getStatus.mockResolvedValue({
        dirtyFileCount: 0,
        publication,
        ahead: publication === 'ahead' ? 2 : 0,
        behind: 0
      });
      test.options.confirmUnpublished.mockResolvedValue(false);

      await expect(test.lifecycle.finish(WORKSPACE_PATH, test.options))
        .rejects.toMatchObject({ code: 'CANCELLED', message: 'Finish cancelled' });
      expect(test.options.confirmUnpublished).toHaveBeenCalledOnce();
      expect(test.repositories.removeWorktree).not.toHaveBeenCalled();
      expect(test.states.write).not.toHaveBeenCalled();
    }
  );

  it('revalidates the exact branch after prepare and never removes a switched target', async () => {
    const test = harness();
    test.repositories.getBranchInfo
      .mockResolvedValueOnce({ exists: true, head: OID, worktreePath: WORKTREE_PATH })
      .mockResolvedValueOnce({ exists: true, head: OID });

    await expect(test.lifecycle.finish(WORKSPACE_PATH, test.options))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(test.writes[0]).toMatchObject({
      status: 'recoveryRequired', recovery: { operation: 'finish', stage: 'prepare' }
    });
    expect(test.repositories.removeWorktree).not.toHaveBeenCalled();
  });

  it('revalidates that the target is a real directory before removal', async () => {
    const test = harness();
    test.paths.isRealDirectory
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(test.lifecycle.finish(WORKSPACE_PATH, test.options))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(test.repositories.getStatus).toHaveBeenCalledOnce();
    expect(test.repositories.removeWorktree).not.toHaveBeenCalled();
  });

  it('keeps finish recovery when the post-remove journal fails', async () => {
    const test = harness();
    const journal = new Error('journal failed');
    test.states.write
      .mockImplementationOnce(async (_path, state) => { test.writes.push(structuredClone(state)); })
      .mockRejectedValueOnce(journal);

    await expect(test.lifecycle.finish(WORKSPACE_PATH, test.options))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED', cause: journal });
    expect(test.repositories.removeWorktree).toHaveBeenCalledOnce();
    expect(test.writes[0]).toMatchObject({
      status: 'recoveryRequired', recovery: { operation: 'finish', stage: 'prepare' }
    });
  });

  it('retains partial finish progress when a later non-force removal fails', async () => {
    const state = workspaceState();
    state.repositories.push({
      ...state.repositories[0]!,
      id: 'web',
      displayName: 'Web',
      sourcePath: '/src/web',
      worktreePath: `${WORKSPACE_PATH}/web`
    });
    const test = harness(state);
    test.paths.exists.mockResolvedValue(true);
    test.repositories.getBranchInfo.mockImplementation(async sourcePath => ({
      exists: true,
      head: OID,
      worktreePath: sourcePath === '/src/api' ? WORKTREE_PATH : `${WORKSPACE_PATH}/web`
    }));
    const failure = new Error('second remove failed');
    test.repositories.removeWorktree
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(failure);

    await expect(test.lifecycle.finish(WORKSPACE_PATH, test.options))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED', cause: failure });
    expect(test.repositories.removeWorktree).toHaveBeenCalledTimes(2);
    expect(test.writes.at(-1)).toMatchObject({
      status: 'recoveryRequired',
      recovery: { operation: 'finish', repositoryId: 'web' },
      repositories: [
        expect.objectContaining({ id: 'api', worktreeCreated: false }),
        expect.objectContaining({ id: 'web', worktreeCreated: true })
      ]
    });
  });

  it('cancels from progress before the first remove and retains recovery', async () => {
    const test = harness();
    const controller = new AbortController();

    await expect(test.lifecycle.finish(WORKSPACE_PATH, {
      ...test.options,
      signal: controller.signal,
      onProgress: () => controller.abort()
    })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(test.repositories.removeWorktree).not.toHaveBeenCalled();
    expect(test.writes.at(-1)).toMatchObject({
      status: 'recoveryRequired', recovery: { operation: 'finish', stage: 'cancelled' }
    });
  });

  it('preserves the primary failure when unlock also fails', async () => {
    const test = harness();
    const primary = new Error('remove failed');
    test.repositories.removeWorktree.mockRejectedValueOnce(primary);
    test.lock.release.mockRejectedValueOnce(new Error('unlock failed'));

    await expect(test.lifecycle.finish(WORKSPACE_PATH, test.options))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED', cause: primary });
  });

  it('does not let unlock failure replace an earlier finish conflict', async () => {
    const test = harness();
    test.repositories.getStatus.mockResolvedValue({
      dirtyFileCount: 1, publication: 'synced', ahead: 0, behind: 0
    });
    test.lock.release.mockRejectedValueOnce(new Error('unlock failed'));

    await expect(test.lifecycle.finish(WORKSPACE_PATH, test.options))
      .rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('surfaces unlock failure after an otherwise successful finish', async () => {
    const test = harness();
    const unlock = new Error('unlock failed');
    test.lock.release.mockRejectedValueOnce(unlock);

    await expect(test.lifecycle.finish(WORKSPACE_PATH, test.options)).rejects.toBe(unlock);
  });
});
