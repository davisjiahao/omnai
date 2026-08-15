import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceLock,
  WorkspaceLockInfo,
  WorkspaceState
} from '../domain/types';
import { parseWorkspaceState } from './state-schema';
import { StateStore } from './state-store';

const STATE_FILE = '.ai-workspace.json';
const LOCK_FILE = '.ai-workspace.lock';
const GUARD_DIRECTORY = '.ai-workspace.lock.guard';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function temporaryWorkspace(): Promise<{
  workspaceRoot: string;
  workspacePath: string;
}> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-workspace-state-'));
  roots.push(workspaceRoot);
  const workspacePath = path.join(workspaceRoot, 'REQ-123');
  return { workspaceRoot, workspacePath };
}

function stateFor(
  workspacePath: string,
  overrides: Partial<WorkspaceState> = {}
): WorkspaceState {
  const commit = '0123456789abcdef0123456789abcdef01234567';
  return {
    version: 1,
    status: 'ready',
    requirement: { id: 'REQ-123', title: 'Quote change' },
    workspacePath,
    branchName: 'feature/REQ-123',
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:01:00.000Z',
    openCodexOnNextActivation: false,
    repositories: [
      {
        id: 'quote',
        displayName: 'Quote Service',
        sourcePath: path.join(path.dirname(workspacePath), 'sources', 'quote'),
        worktreePath: path.join(workspacePath, 'quote'),
        remote: 'origin',
        baseRef: 'origin/main',
        baseCommit: commit,
        branch: 'feature/REQ-123',
        branchExistedBefore: false,
        branchCreatedByOperation: true,
        branchInitialCommit: commit,
        worktreeCreated: true
      }
    ],
    ...overrides
  };
}

function lockInfo(overrides: Partial<WorkspaceLockInfo> = {}): WorkspaceLockInfo {
  return {
    token: '11111111-1111-4111-8111-111111111111',
    processId: 101,
    operation: 'create',
    startedAt: '2026-08-14T00:00:00.000Z',
    ...overrides
  };
}

async function seedLock(workspacePath: string, info: WorkspaceLockInfo): Promise<void> {
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.writeFile(path.join(workspacePath, LOCK_FILE), `${JSON.stringify(info)}\n`, { mode: 0o600 });
}

describe('workspace state schema and durability', () => {
  it('writes and reads a versioned workspace state atomically with private permissions', async () => {
    const { workspacePath } = await temporaryWorkspace();
    const store = new StateStore({ processId: 101, isProcessAlive: () => true });
    const state = stateFor(workspacePath);

    await store.write(workspacePath, state);

    await expect(store.read(workspacePath)).resolves.toEqual(state);
    const names = await fs.readdir(workspacePath);
    expect(names.filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect((await fs.stat(path.join(workspacePath, STATE_FILE))).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(path.join(workspacePath, STATE_FILE), 'utf8')).toMatch(/\n$/);
  });

  it('keeps the primary atomic-write error and removes its temporary file', async () => {
    const { workspacePath } = await temporaryWorkspace();
    const primary = Object.assign(new Error('rename failed'), { code: 'EIO' });
    const cleanup = Object.assign(new Error('cleanup report'), { code: 'EIO' });
    const store = new StateStore({
      processId: 101,
      fileSystem: {
        rename: async () => { throw primary; },
        unlink: async target => {
          await fs.unlink(target);
          if (target.endsWith('.tmp')) throw cleanup;
        }
      }
    });

    await expect(store.write(workspacePath, stateFor(workspacePath))).rejects.toBe(primary);
    expect((await fs.readdir(workspacePath)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects unknown fields, relative paths, malformed commits, and invalid timestamps', () => {
    const workspacePath = path.resolve('/tmp/ai-workspace-schema/REQ-123');
    const valid = stateFor(workspacePath);
    const invalidValues: unknown[] = [
      { ...valid, unexpected: true },
      { ...valid, workspacePath: 'relative/workspace' },
      {
        ...valid,
        repositories: [{ ...valid.repositories[0], baseCommit: 'ABCDEF' }]
      },
      { ...valid, updatedAt: 'yesterday' },
      {
        ...valid,
        repositories: [{ ...valid.repositories[0], unexpected: true }]
      }
    ];

    for (const value of invalidValues) {
      expect(() => parseWorkspaceState(value)).toThrow(expect.objectContaining({
        code: 'RECOVERY_REQUIRED',
        message: 'Invalid workspace state'
      }));
    }
  });

  it('accepts both lowercase SHA-1 and SHA-256 commit identifiers', () => {
    const workspacePath = path.resolve('/tmp/ai-workspace-schema/REQ-123');
    const sha256 = '0123456789abcdef'.repeat(4);
    const state = stateFor(workspacePath);

    expect(parseWorkspaceState(state)).toEqual(state);
    expect(parseWorkspaceState({
      ...state,
      repositories: [{
        ...state.repositories[0],
        baseCommit: sha256,
        branchInitialCommit: sha256
      }]
    }).repositories[0]?.baseCommit).toBe(sha256);
  });

  it('enforces repository and recovery-state invariants', () => {
    const workspacePath = path.resolve('/tmp/ai-workspace-schema/REQ-123');
    const valid = stateFor(workspacePath);
    const repository = valid.repositories[0];
    expect(repository).toBeDefined();
    const recovery = {
      operation: 'create' as const,
      stage: 'worktree',
      repositoryId: 'quote',
      message: 'Creation was interrupted'
    };
    const invalidValues: unknown[] = [
      { ...valid, repositories: [] },
      { ...valid, repositories: [repository, { ...repository }] },
      { ...valid, status: 'recoveryRequired' },
      { ...valid, recovery },
      {
        ...valid,
        status: 'recoveryRequired',
        recovery: { ...recovery, repositoryId: 'missing-repository' }
      }
    ];

    for (const value of invalidValues) {
      expect(() => parseWorkspaceState(value)).toThrow(expect.objectContaining({
        code: 'RECOVERY_REQUIRED',
        message: 'Invalid workspace state'
      }));
    }
    expect(parseWorkspaceState({ ...valid, status: 'recoveryRequired', recovery }))
      .toMatchObject({ status: 'recoveryRequired', recovery });
  });

  it('surfaces malformed state instead of treating it as absent', async () => {
    const { workspacePath } = await temporaryWorkspace();
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, STATE_FILE), '{not-json');
    const store = new StateStore();

    await expect(store.readIfExists(workspacePath)).rejects.toMatchObject({
      code: 'RECOVERY_REQUIRED',
      message: 'Invalid workspace state'
    });
  });

  it('lists only direct state-bearing directories newest first', async () => {
    const { workspaceRoot } = await temporaryWorkspace();
    const store = new StateStore();
    const olderPath = path.join(workspaceRoot, 'REQ-OLD');
    const newerPath = path.join(workspaceRoot, 'REQ-NEW');
    await store.write(olderPath, stateFor(olderPath, {
      requirement: { id: 'REQ-OLD', title: 'Older' },
      updatedAt: '2026-08-14T00:01:00.000Z'
    }));
    await store.write(newerPath, stateFor(newerPath, {
      requirement: { id: 'REQ-NEW', title: 'Newer' },
      updatedAt: '2026-08-14T00:02:00.000Z'
    }));
    await fs.mkdir(path.join(workspaceRoot, 'unrelated'));
    await fs.writeFile(path.join(workspaceRoot, 'plain-file'), 'not a workspace');

    await expect(store.list(workspaceRoot)).resolves.toEqual([
      stateFor(newerPath, {
        requirement: { id: 'REQ-NEW', title: 'Newer' },
        updatedAt: '2026-08-14T00:02:00.000Z'
      }),
      stateFor(olderPath, {
        requirement: { id: 'REQ-OLD', title: 'Older' },
        updatedAt: '2026-08-14T00:01:00.000Z'
      })
    ]);
    await expect(store.list(path.join(workspaceRoot, 'missing'))).resolves.toEqual([]);
  });

  it('surfaces malformed state found during listing', async () => {
    const { workspaceRoot } = await temporaryWorkspace();
    const malformedPath = path.join(workspaceRoot, 'REQ-BAD');
    await fs.mkdir(malformedPath);
    await fs.writeFile(path.join(malformedPath, STATE_FILE), '{}');

    await expect(new StateStore().list(workspaceRoot)).rejects.toMatchObject({
      code: 'RECOVERY_REQUIRED'
    });
  });

  it('builds a normalized path only for a portable requirement id', async () => {
    const { workspaceRoot } = await temporaryWorkspace();
    const store = new StateStore();

    expect(store.workspacePath(workspaceRoot, '  REQ-123  ')).toBe(
      path.join(path.resolve(workspaceRoot), 'REQ-123')
    );
    expect(() => store.workspacePath(workspaceRoot, '../escape')).toThrow(expect.objectContaining({
      code: 'VALIDATION'
    }));
  });
});

describe('workspace locks', () => {
  it('creates the canonical lock exclusively with private permissions and refuses an active lock', async () => {
    const { workspacePath } = await temporaryWorkspace();
    const confirm = vi.fn(async () => true);
    const store = new StateStore({
      processId: 101,
      isProcessAlive: processId => processId === 101,
      now: () => new Date('2026-08-14T00:00:00.000Z')
    });
    const lock = await store.acquireLock(workspacePath, 'create', async () => false);

    await expect(store.acquireLock(workspacePath, 'finish', confirm)).rejects.toMatchObject({
      code: 'LOCKED'
    });
    expect(confirm).not.toHaveBeenCalled();
    expect((await fs.stat(path.join(workspacePath, LOCK_FILE))).mode & 0o777).toBe(0o600);
    await lock.release();
  });

  it('rejects a malformed lock without offering to break it', async () => {
    const { workspacePath } = await temporaryWorkspace();
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, LOCK_FILE), '{bad-json');
    const confirm = vi.fn(async () => true);

    await expect(new StateStore({ isProcessAlive: () => false })
      .acquireLock(workspacePath, 'finish', confirm)).rejects.toMatchObject({
        code: 'RECOVERY_REQUIRED',
        message: 'Invalid workspace lock'
      });
    expect(confirm).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(workspacePath, LOCK_FILE), 'utf8')).resolves.toBe('{bad-json');
  });

  it('rejects a lock with unknown or invalid fields as malformed', async () => {
    const { workspacePath } = await temporaryWorkspace();
    const invalid = { ...lockInfo(), processId: 0, unexpected: true };
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, LOCK_FILE), `${JSON.stringify(invalid)}\n`);

    await expect(new StateStore({ isProcessAlive: () => false })
      .acquireLock(workspacePath, 'finish', async () => true)).rejects.toMatchObject({
        code: 'RECOVERY_REQUIRED',
        message: 'Invalid workspace lock'
      });
  });

  it('retains a stale lock when confirmation is declined', async () => {
    const { workspacePath } = await temporaryWorkspace();
    const stale = lockInfo();
    await seedLock(workspacePath, stale);

    await expect(new StateStore({ processId: 202, isProcessAlive: () => false })
      .acquireLock(workspacePath, 'finish', async existing => {
        expect(existing).toEqual(stale);
        return false;
      })).rejects.toMatchObject({ code: 'LOCKED' });
    expect(JSON.parse(await fs.readFile(path.join(workspacePath, LOCK_FILE), 'utf8'))).toEqual(stale);
  });

  it('breaks a stale lock only after confirmation and protects the replacement from the stale handle', async () => {
    const { workspacePath } = await temporaryWorkspace();
    const first = new StateStore({ processId: 101, isProcessAlive: () => false });
    const stale = await first.acquireLock(workspacePath, 'create', async () => false);
    const second = new StateStore({ processId: 202, isProcessAlive: () => false });
    const confirm = vi.fn(async () => true);

    const replacement = await second.acquireLock(workspacePath, 'finish', confirm);
    await stale.release();
    expect(JSON.parse(await fs.readFile(path.join(workspacePath, LOCK_FILE), 'utf8')).token)
      .toBe(replacement.info.token);
    await replacement.release();
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('rechecks stale-lock token and file identity after confirmation before deleting', async () => {
    const { workspacePath } = await temporaryWorkspace();
    const stale = lockInfo();
    const successor = lockInfo({
      token: '22222222-2222-4222-8222-222222222222',
      processId: 303,
      operation: 'finish'
    });
    await seedLock(workspacePath, stale);
    const lockPath = path.join(workspacePath, LOCK_FILE);
    const store = new StateStore({ processId: 202, isProcessAlive: () => false });

    await expect(store.acquireLock(workspacePath, 'recover', async () => {
      await fs.unlink(lockPath);
      await fs.writeFile(lockPath, `${JSON.stringify(successor)}\n`, { mode: 0o600 });
      return true;
    })).rejects.toMatchObject({ code: 'LOCKED' });
    expect(JSON.parse(await fs.readFile(lockPath, 'utf8'))).toEqual(successor);
  });

  it('allows at most one concurrent stale-lock breaker to succeed', async () => {
    const { workspacePath } = await temporaryWorkspace();
    await seedLock(workspacePath, lockInfo());
    const first = new StateStore({ processId: 202, isProcessAlive: () => false });
    const second = new StateStore({ processId: 303, isProcessAlive: () => false });

    const results = await Promise.allSettled([
      first.acquireLock(workspacePath, 'recover', async () => {
        await new Promise(resolve => setImmediate(resolve));
        return true;
      }),
      second.acquireLock(workspacePath, 'finish', async () => true)
    ]);
    const successes = results.filter(
      (result): result is PromiseFulfilledResult<WorkspaceLock> => result.status === 'fulfilled'
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toMatchObject({ code: 'LOCKED' });
    await successes[0]?.value.release();
  });

  it('rereads the token during release and never deletes a successor', async () => {
    const { workspacePath } = await temporaryWorkspace();
    const lockPath = path.join(workspacePath, LOCK_FILE);
    let canonicalReads = 0;
    const successor = lockInfo({
      token: '33333333-3333-4333-8333-333333333333',
      processId: 303,
      operation: 'finish'
    });
    const store = new StateStore({
      processId: 202,
      isProcessAlive: () => true,
      fileSystem: {
        readFile: async (target, encoding) => {
          if (target === lockPath && ++canonicalReads === 2) {
            await fs.unlink(lockPath);
            await fs.writeFile(lockPath, `${JSON.stringify(successor)}\n`, { mode: 0o600 });
          }
          return fs.readFile(target, encoding);
        }
      }
    });
    const owned = await store.acquireLock(workspacePath, 'create', async () => false);

    await owned.release();

    expect(canonicalReads).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(await fs.readFile(lockPath, 'utf8'))).toEqual(successor);
  });

  it('returns an owned lock handle when initial guard cleanup fails, then releases without an orphan', async () => {
    const { workspacePath } = await temporaryWorkspace();
    const guardPath = path.join(workspacePath, '.ai-workspace.lock.guard');
    let failGuardUnlink = true;
    const store = new StateStore({
      processId: 202,
      isProcessAlive: () => true,
      fileSystem: {
        rmdir: async target => {
          if (target === guardPath && failGuardUnlink) {
            failGuardUnlink = false;
            throw Object.assign(new Error('guard cleanup failed'), { code: 'EIO' });
          }
          await fs.rmdir(target);
        }
      }
    });

    const lock = await store.acquireLock(workspacePath, 'create', async () => false);
    await lock.release();

    await expect(fs.stat(path.join(workspacePath, LOCK_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(guardPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readdir(workspacePath)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('acquires in an existing real directory without creating missing, file, or symlink targets', async () => {
    const { workspaceRoot, workspacePath } = await temporaryWorkspace();
    const store = new StateStore({ processId: 202, isProcessAlive: () => true });
    const missing = path.join(workspaceRoot, 'missing');
    const file = path.join(workspaceRoot, 'file');
    const realTarget = path.join(workspaceRoot, 'real-target');
    const symlink = path.join(workspaceRoot, 'symlink');
    await fs.writeFile(file, 'keep');
    await fs.mkdir(realTarget);
    await fs.symlink(realTarget, symlink, process.platform === 'win32' ? 'junction' : 'dir');

    for (const invalidTarget of [missing, file, symlink]) {
      await expect(store.acquireExistingLock(invalidTarget, 'finish', async () => false))
        .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    }
    await expect(fs.lstat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(file, 'utf8')).resolves.toBe('keep');
    expect((await fs.lstat(symlink)).isSymbolicLink()).toBe(true);
    expect(await fs.readdir(realTarget)).toEqual([]);

    await fs.mkdir(workspacePath);
    const lock = await store.acquireLockInExistingDirectory(
      workspacePath,
      'finish',
      async () => false
    );
    await lock.release();
  });

  it.each(['ENOTSUP', 'EPERM'])('does not require hard links when the filesystem reports %s', async code => {
    const { workspacePath } = await temporaryWorkspace();
    const store = new StateStore({
      processId: 202,
      isProcessAlive: () => true,
      fileSystem: {
        link: async () => { throw Object.assign(new Error('hard links unavailable'), { code }); }
      }
    });

    const lock = await store.acquireLock(workspacePath, 'create', async () => false);
    await lock.release();
  });

  it('treats an EPERM directory rename as a collision only when a canonical guard exists', async () => {
    const { workspacePath } = await temporaryWorkspace();
    await fs.mkdir(workspacePath);
    const staleToken = '66666666-6666-4666-8666-666666666666';
    const guardPath = path.join(workspacePath, GUARD_DIRECTORY);
    await fs.mkdir(guardPath);
    await fs.writeFile(
      path.join(guardPath, `owner.${staleToken}.json`),
      `${JSON.stringify({
        version: 1,
        token: staleToken,
        processId: 101,
        startedAt: '2026-08-14T00:00:00.000Z'
      })}\n`
    );
    const store = new StateStore({
      processId: 202,
      isProcessAlive: () => false,
      fileSystem: {
        rename: async (source, target) => {
          if (target === guardPath) {
            try {
              await fs.lstat(guardPath);
              throw Object.assign(new Error('Windows directory collision'), { code: 'EPERM' });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
          }
          await fs.rename(source, target);
        }
      }
    });

    const lock = await store.acquireExistingLock(workspacePath, 'recover', async () => false);
    await lock.release();
  });

  it('adopts an exactly owned guard when rename publishes it and then reports an error', async () => {
    const { workspacePath } = await temporaryWorkspace();
    const guardPath = path.join(workspacePath, GUARD_DIRECTORY);
    const ambiguousError = Object.assign(new Error('rename result was ambiguous'), { code: 'EIO' });
    let injectAmbiguousResult = true;
    const store = new StateStore({
      processId: 202,
      isProcessAlive: () => true,
      now: () => new Date('2026-08-14T00:00:00.000Z'),
      fileSystem: {
        rename: async (source, target) => {
          await fs.rename(source, target);
          if (target === guardPath && injectAmbiguousResult) {
            injectAmbiguousResult = false;
            throw ambiguousError;
          }
        }
      }
    });

    const lock = await store.acquireLock(workspacePath, 'create', async () => false);
    await lock.release();

    await expect(fs.lstat(path.join(workspacePath, LOCK_FILE)))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(guardPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves the original rename error and a nonmatching published guard', async () => {
    const { workspacePath } = await temporaryWorkspace();
    const guardPath = path.join(workspacePath, GUARD_DIRECTORY);
    const ambiguousError = Object.assign(new Error('rename result was ambiguous'), { code: 'EIO' });
    let successorOwnerPath = '';
    const store = new StateStore({
      processId: 202,
      isProcessAlive: () => true,
      now: () => new Date('2026-08-14T00:00:00.000Z'),
      fileSystem: {
        rename: async (source, target) => {
          await fs.rename(source, target);
          if (target === guardPath) {
            const [ownerName] = await fs.readdir(guardPath);
            successorOwnerPath = path.join(guardPath, ownerName ?? '');
            const owner = JSON.parse(await fs.readFile(successorOwnerPath, 'utf8')) as {
              processId: number;
            };
            await fs.writeFile(
              successorOwnerPath,
              `${JSON.stringify({ ...owner, processId: 999 })}\n`,
              { mode: 0o600 }
            );
            throw ambiguousError;
          }
        }
      }
    });

    await expect(store.acquireLock(workspacePath, 'create', async () => false))
      .rejects.toBe(ambiguousError);
    expect(JSON.parse(await fs.readFile(successorOwnerPath, 'utf8')).processId).toBe(999);
  });

  it('does not publish a partial prepared guard or let it block another acquirer', async () => {
    const { workspacePath } = await temporaryWorkspace();
    await fs.mkdir(workspacePath);
    let signalOwnerWrite!: () => void;
    let resumeOwnerWrite!: () => void;
    const ownerWriteStarted = new Promise<void>(resolve => { signalOwnerWrite = resolve; });
    const ownerWriteCanContinue = new Promise<void>(resolve => { resumeOwnerWrite = resolve; });
    const firstStore = new StateStore({
      processId: 202,
      isProcessAlive: () => true,
      fileSystem: {
        open: async (target, flags, mode) => {
          if (target.includes(`${GUARD_DIRECTORY}.prepared.`)
            && path.basename(target).startsWith('owner.')) {
            signalOwnerWrite();
            await ownerWriteCanContinue;
          }
          return fs.open(target, flags, mode);
        }
      }
    });
    const firstResult = firstStore.acquireLockInExistingDirectory(
      workspacePath,
      'create',
      async () => false
    );

    const publicationCheckpoint = await Promise.race([
      ownerWriteStarted.then(() => 'owner-write' as const),
      firstResult.then(() => 'acquired' as const, () => 'failed' as const)
    ]);
    expect(publicationCheckpoint).toBe('owner-write');

    const secondStore = new StateStore({ processId: 303, isProcessAlive: () => true });
    const secondLock = await secondStore.acquireExistingLock(
      workspacePath,
      'finish',
      async () => false
    );
    resumeOwnerWrite();
    await expect(firstResult).rejects.toMatchObject({ code: 'LOCKED' });
    await secondLock.release();
    expect((await fs.readdir(workspacePath)).filter(
      name => name.startsWith(`${GUARD_DIRECTORY}.prepared.`)
    )).toEqual([]);
  });

  it('keeps a successor guard intact when a second stale breaker resumes late', async () => {
    const { workspacePath } = await temporaryWorkspace();
    await fs.mkdir(workspacePath);
    const staleToken = '11111111-1111-4111-8111-111111111111';
    const guardPath = path.join(workspacePath, GUARD_DIRECTORY);
    const staleOwnerPath = path.join(guardPath, `owner.${staleToken}.json`);
    await fs.mkdir(guardPath);
    await fs.writeFile(staleOwnerPath, `${JSON.stringify({
      version: 1,
      token: staleToken,
      processId: 101,
      startedAt: '2026-08-14T00:00:00.000Z'
    })}\n`, { mode: 0o600 });

    let staleArrivals = 0;
    let signalBothStale!: () => void;
    let releaseFirstStale!: () => void;
    let releaseSecondStale!: () => void;
    let signalSuccessorPublished!: () => void;
    let releaseSuccessor!: () => void;
    const bothStaleReady = new Promise<void>(resolve => { signalBothStale = resolve; });
    const firstStaleCanContinue = new Promise<void>(resolve => { releaseFirstStale = resolve; });
    const secondStaleCanContinue = new Promise<void>(resolve => { releaseSecondStale = resolve; });
    const successorPublished = new Promise<void>(resolve => { signalSuccessorPublished = resolve; });
    const successorCanRelease = new Promise<void>(resolve => { releaseSuccessor = resolve; });
    const arrive = (): void => {
      staleArrivals += 1;
      if (staleArrivals === 2) signalBothStale();
    };
    let pauseSuccessor = true;
    const first = new StateStore({
      processId: 202,
      isProcessAlive: () => false,
      fileSystem: {
        unlink: async target => {
          if (target === staleOwnerPath) {
            arrive();
            await firstStaleCanContinue;
          } else if (path.dirname(target) === guardPath
            && path.basename(target).startsWith('owner.')
            && pauseSuccessor) {
            pauseSuccessor = false;
            signalSuccessorPublished();
            await successorCanRelease;
          }
          await fs.unlink(target);
        }
      }
    });
    const second = new StateStore({
      processId: 303,
      isProcessAlive: () => false,
      fileSystem: {
        unlink: async target => {
          if (target === staleOwnerPath) {
            arrive();
            await secondStaleCanContinue;
          }
          await fs.unlink(target);
        }
      }
    });
    const firstResult = first.acquireExistingLock(workspacePath, 'recover', async () => false);
    const secondResult = second.acquireExistingLock(workspacePath, 'finish', async () => false);

    const staleCheckpoint = await Promise.race([
      bothStaleReady.then(() => 'both-ready' as const),
      Promise.allSettled([firstResult, secondResult]).then(() => 'settled' as const)
    ]);
    expect(staleCheckpoint).toBe('both-ready');
    releaseFirstStale();
    await successorPublished;
    releaseSecondStale();
    await expect(secondResult).rejects.toMatchObject({ code: 'LOCKED' });

    const successorOwners = (await fs.readdir(guardPath)).filter(name => name.startsWith('owner.'));
    expect(successorOwners).toHaveLength(1);
    expect(successorOwners[0]).not.toContain(staleToken);
    expect((await fs.stat(path.join(guardPath, successorOwners[0] ?? ''))).mode & 0o777)
      .toBe(0o600);
    releaseSuccessor();
    const firstLock = await firstResult;
    await firstLock.release();
  });

  it('recovers empty, dead prepared, and released guard artifacts without blocking acquisition', async () => {
    const { workspacePath } = await temporaryWorkspace();
    await fs.mkdir(workspacePath);
    const preparedToken = '44444444-4444-4444-8444-444444444444';
    const releasedToken = '55555555-5555-4555-8555-555555555555';
    const emptyCanonical = path.join(workspacePath, GUARD_DIRECTORY);
    const prepared = path.join(
      workspacePath,
      `${GUARD_DIRECTORY}.prepared.101.${preparedToken}`
    );
    const released = path.join(
      workspacePath,
      `${GUARD_DIRECTORY}.released.101.${releasedToken}`
    );
    await fs.mkdir(emptyCanonical);
    await fs.mkdir(prepared);
    await fs.writeFile(
      path.join(prepared, `owner.${preparedToken}.json`),
      `${JSON.stringify({
        version: 1,
        token: preparedToken,
        processId: 101,
        startedAt: '2026-08-14T00:00:00.000Z'
      })}\n`
    );
    await fs.mkdir(released);
    await fs.writeFile(
      path.join(released, `owner.${releasedToken}.json`),
      `${JSON.stringify({
        version: 1,
        token: releasedToken,
        processId: 101,
        startedAt: '2026-08-14T00:00:00.000Z'
      })}\n`
    );
    const store = new StateStore({ processId: 202, isProcessAlive: () => false });

    const lock = await store.acquireExistingLock(workspacePath, 'recover', async () => false);
    await lock.release();

    await expect(fs.lstat(prepared)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(released)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(emptyCanonical)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('narrowly removes a dead prepared partial owner while preserving unknown contents', async () => {
    const { workspacePath } = await temporaryWorkspace();
    await fs.mkdir(workspacePath);
    const partialToken = '77777777-7777-4777-8777-777777777777';
    const extraToken = '88888888-8888-4888-8888-888888888888';
    const nonFileToken = '99999999-9999-4999-8999-999999999999';
    const partial = path.join(
      workspacePath,
      `${GUARD_DIRECTORY}.prepared.101.${partialToken}`
    );
    const withExtra = path.join(
      workspacePath,
      `${GUARD_DIRECTORY}.prepared.101.${extraToken}`
    );
    const withNonFileOwner = path.join(
      workspacePath,
      `${GUARD_DIRECTORY}.prepared.101.${nonFileToken}`
    );
    await fs.mkdir(partial);
    await fs.writeFile(path.join(partial, `owner.${partialToken}.json`), '{partial');
    await fs.mkdir(withExtra);
    await fs.writeFile(path.join(withExtra, `owner.${extraToken}.json`), '{partial');
    await fs.writeFile(path.join(withExtra, 'unknown'), 'preserve');
    await fs.mkdir(withNonFileOwner);
    await fs.mkdir(path.join(withNonFileOwner, `owner.${nonFileToken}.json`));
    const store = new StateStore({ processId: 202, isProcessAlive: () => false });

    const lock = await store.acquireExistingLock(workspacePath, 'recover', async () => false);
    await lock.release();

    await expect(fs.lstat(partial)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(withExtra, 'unknown'), 'utf8')).resolves.toBe('preserve');
    expect((await fs.lstat(path.join(withNonFileOwner, `owner.${nonFileToken}.json`))).isDirectory())
      .toBe(true);
  });
});

describe('generated metadata cleanup', () => {
  it('removes only generated metadata and preserves a child repository', async () => {
    const { workspacePath } = await temporaryWorkspace();
    const store = new StateStore();
    await store.write(workspacePath, stateFor(workspacePath));
    await fs.writeFile(path.join(workspacePath, 'AGENTS.md'), 'generated instructions');
    await fs.mkdir(path.join(workspacePath, 'quote'));
    await fs.writeFile(path.join(workspacePath, 'quote', 'tracked.txt'), 'keep child repository');

    await store.cleanupGeneratedMetadata(workspacePath, stateFor(workspacePath));

    await expect(fs.stat(path.join(workspacePath, STATE_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(workspacePath, 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(workspacePath, 'quote', 'tracked.txt'), 'utf8'))
      .resolves.toBe('keep child repository');
  });

  it('removes the workspace directory when generated metadata was its only content', async () => {
    const { workspacePath } = await temporaryWorkspace();
    const store = new StateStore();
    await store.write(workspacePath, stateFor(workspacePath));
    await fs.writeFile(path.join(workspacePath, 'AGENTS.md'), 'generated instructions');

    await store.cleanupGeneratedMetadata(workspacePath, stateFor(workspacePath));

    await expect(fs.stat(workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a successor state and AGENTS file created under a successor lock', async () => {
    const { workspacePath } = await temporaryWorkspace();
    const first = new StateStore({ processId: 101, isProcessAlive: () => true });
    const successorStore = new StateStore({ processId: 202, isProcessAlive: () => true });
    const expected = stateFor(workspacePath);
    const successor = stateFor(workspacePath, {
      requirement: { id: 'REQ-123', title: 'Successor' },
      updatedAt: '2026-08-14T00:02:00.000Z'
    });
    await first.write(workspacePath, expected);
    await fs.writeFile(path.join(workspacePath, 'AGENTS.md'), 'first');
    const firstLock = await first.acquireLock(workspacePath, 'create', async () => false);
    await firstLock.release();

    const successorLock = await successorStore.acquireExistingLock(
      workspacePath,
      'finish',
      async () => false
    );
    await successorStore.write(workspacePath, successor);
    await fs.writeFile(path.join(workspacePath, 'AGENTS.md'), 'successor');

    await expect(first.cleanupGeneratedMetadata(workspacePath, expected))
      .rejects.toMatchObject({ code: 'LOCKED' });
    await expect(successorStore.read(workspacePath)).resolves.toEqual(successor);
    await expect(fs.readFile(path.join(workspacePath, 'AGENTS.md'), 'utf8'))
      .resolves.toBe('successor');
    await successorLock.release();
  });

  it('rejects an unlocked successor state by compare-and-swap without deleting its metadata', async () => {
    const { workspacePath } = await temporaryWorkspace();
    const store = new StateStore();
    const expected = stateFor(workspacePath);
    const successor = stateFor(workspacePath, { updatedAt: '2026-08-14T00:03:00.000Z' });
    await store.write(workspacePath, successor);
    await fs.writeFile(path.join(workspacePath, 'AGENTS.md'), 'successor');

    await expect(store.cleanupGeneratedMetadata(workspacePath, expected))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(store.read(workspacePath)).resolves.toEqual(successor);
    await expect(fs.readFile(path.join(workspacePath, 'AGENTS.md'), 'utf8'))
      .resolves.toBe('successor');
  });

  it('keeps canonical state when AGENTS deletion fails and preserves the primary error', async () => {
    const { workspacePath } = await temporaryWorkspace();
    const expected = stateFor(workspacePath);
    await new StateStore().write(workspacePath, expected);
    await fs.writeFile(path.join(workspacePath, 'AGENTS.md'), 'generated');
    const primary = Object.assign(new Error('AGENTS unlink failed'), { code: 'EIO' });
    const secondary = Object.assign(new Error('guard release failed'), { code: 'EIO' });
    let failGuardRelease = true;
    let failAgents = true;
    const store = new StateStore({
      fileSystem: {
        unlink: async target => {
          if (target.endsWith('AGENTS.md') && failAgents) {
            failAgents = false;
            throw primary;
          }
          await fs.unlink(target);
        },
        rmdir: async target => {
          if (target.endsWith(GUARD_DIRECTORY) && failGuardRelease) {
            failGuardRelease = false;
            throw secondary;
          }
          await fs.rmdir(target);
        }
      }
    });

    await expect(store.cleanupGeneratedMetadata(workspacePath, expected)).rejects.toBe(primary);
    await expect(store.read(workspacePath)).resolves.toEqual(expected);
    await store.cleanupGeneratedMetadata(workspacePath, expected);
    await expect(fs.lstat(workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retries cleanup after guard release fails after canonical state removal', async () => {
    const { workspacePath } = await temporaryWorkspace();
    const expected = stateFor(workspacePath);
    await new StateStore().write(workspacePath, expected);
    await fs.writeFile(path.join(workspacePath, 'AGENTS.md'), 'generated');
    const releaseError = Object.assign(new Error('guard release failed'), { code: 'EIO' });
    let failGuardRelease = true;
    const store = new StateStore({
      fileSystem: {
        rmdir: async target => {
          if (target.endsWith(GUARD_DIRECTORY) && failGuardRelease) {
            failGuardRelease = false;
            throw releaseError;
          }
          await fs.rmdir(target);
        }
      }
    });

    await expect(store.cleanupGeneratedMetadata(workspacePath, expected)).rejects.toBe(releaseError);
    await expect(fs.lstat(path.join(workspacePath, STATE_FILE)))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await store.cleanupGeneratedMetadata(workspacePath, expected);
    await expect(fs.lstat(workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
