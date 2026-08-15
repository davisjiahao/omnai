import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentsGenerator } from '../context/agents-generator';
import { AiWorkspaceError } from '../domain/errors';
import type {
  AddWorktreeInput,
  BranchInfo,
  InspectedRepository,
  RepositoryStatus,
  RepositoryWorkspaceHealth,
  WorkspaceInspection,
  WorkspaceLock,
  WorkspaceLockInfo,
  WorkspaceProgress,
  WorkspaceRepositoryState,
  WorkspaceState
} from '../domain/types';
import { redactGitText } from '../git/git-client';
import type { RepositoryService } from '../git/repository-service';
import type { StateStore } from '../state/state-store';

type RepositoryPort = Pick<RepositoryService,
  'getBranchInfo' | 'addWorktree' | 'removeWorktree' | 'getStatus'>;

type StatePort = Pick<StateStore, 'acquireExistingLock' | 'read' | 'write'>;
type AgentsPort = Pick<AgentsGenerator, 'write'>;

export interface PathProbe {
  exists(targetPath: string): Promise<boolean>;
  isRealDirectory(targetPath: string): Promise<boolean>;
  isEmptyDirectory(targetPath: string): Promise<boolean>;
  claim(targetPath: string): Promise<void>;
  removeEmpty(targetPath: string): Promise<void>;
}

export class NodePathProbe implements PathProbe {
  async exists(targetPath: string): Promise<boolean> {
    try {
      await fs.lstat(targetPath);
      return true;
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return false;
      throw error;
    }
  }

  async isEmptyDirectory(targetPath: string): Promise<boolean> {
    if (!await this.isRealDirectory(targetPath)) return false;
    try {
      return (await fs.readdir(targetPath)).length === 0;
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return false;
      throw error;
    }
  }

  async isRealDirectory(targetPath: string): Promise<boolean> {
    let stats;
    try {
      stats = await fs.lstat(targetPath);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return false;
      throw error;
    }
    return stats.isDirectory() && !stats.isSymbolicLink();
  }

  async claim(targetPath: string): Promise<void> {
    await fs.mkdir(targetPath);
  }

  async removeEmpty(targetPath: string): Promise<void> {
    try {
      await fs.rmdir(targetPath);
    } catch (error) {
      if (!hasCode(error, 'ENOENT') && !hasCode(error, 'ENOTEMPTY')) throw error;
    }
  }
}

export interface LifecycleOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: WorkspaceProgress) => void;
  readonly confirmBreakStaleLock: (lock: WorkspaceLockInfo) => Promise<boolean>;
}

export interface FinishOptions extends LifecycleOptions {
  readonly confirmUnpublished: (
    repositories: InspectedRepository[]
  ) => Promise<boolean>;
}

interface LockedResult {
  result?: WorkspaceState;
  primaryError?: unknown;
}

export class WorkspaceLifecycle {
  constructor(
    private readonly repositories: RepositoryPort,
    private readonly states: StatePort,
    private readonly agents: AgentsPort,
    private readonly paths: PathProbe = new NodePathProbe(),
    private readonly now: () => Date = () => new Date()
  ) {}

  async inspect(workspacePath: string): Promise<WorkspaceInspection> {
    const state = cloneState(await this.states.read(workspacePath));
    assertStateBoundToWorkspace(state, workspacePath);
    return this.inspectState(state);
  }

  async resume(
    workspacePath: string,
    options: LifecycleOptions
  ): Promise<WorkspaceState> {
    const lock = await this.states.acquireExistingLock(
      workspacePath,
      'recover',
      options.confirmBreakStaleLock
    );

    const outcome: LockedResult = {};
    try {
      const authoritative = cloneState(await this.states.read(workspacePath));
      assertStateBoundToWorkspace(authoritative, workspacePath);
      assertResumable(authoritative);
      outcome.result = await this.resumeWhileLocked(authoritative, options);
    } catch (error) {
      outcome.primaryError = error;
    }

    const releaseError = await releaseCapturing(lock);
    if (outcome.primaryError !== undefined) throw outcome.primaryError;
    if (releaseError !== undefined) throw releaseError;
    if (outcome.result === undefined) {
      throw new AiWorkspaceError('RECOVERY_REQUIRED', 'Workspace resume did not complete', {
        workspacePath
      });
    }
    return outcome.result;
  }

  async finish(
    workspacePath: string,
    options: FinishOptions
  ): Promise<WorkspaceState> {
    const lock = await this.states.acquireExistingLock(
      workspacePath,
      'finish',
      options.confirmBreakStaleLock
    );

    const outcome: LockedResult = {};
    try {
      const authoritative = cloneState(await this.states.read(workspacePath));
      assertStateBoundToWorkspace(authoritative, workspacePath);
      assertFinishable(authoritative);
      outcome.result = await this.finishWhileLocked(authoritative, options);
    } catch (error) {
      outcome.primaryError = error;
    }

    const releaseError = await releaseCapturing(lock);
    if (outcome.primaryError !== undefined) throw outcome.primaryError;
    if (releaseError !== undefined) throw releaseError;
    if (outcome.result === undefined) {
      throw new AiWorkspaceError('RECOVERY_REQUIRED', 'Workspace finish did not complete', {
        workspacePath
      });
    }
    return outcome.result;
  }

  private async inspectState(
    state: WorkspaceState,
    signal?: AbortSignal
  ): Promise<WorkspaceInspection> {
    const inspected: InspectedRepository[] = [];
    for (const repository of state.repositories) {
      throwIfCancelled(signal);
      inspected.push(await this.inspectRepository(repository, signal));
    }
    return {
      state: cloneState(state),
      repositories: inspected
    };
  }

  private async inspectRepository(
    repository: WorkspaceRepositoryState,
    signal?: AbortSignal
  ): Promise<InspectedRepository> {
    const state = structuredClone(repository);
    try {
      const targetExists = await this.paths.exists(repository.worktreePath);
      throwIfCancelled(signal);
      if (!targetExists) {
        return { state, health: 'missing', message: 'Worktree path is missing' };
      }

      throwIfCancelled(signal);
      if (!await this.paths.isRealDirectory(repository.worktreePath)) {
        throwIfCancelled(signal);
        return {
          state,
          health: 'occupied',
          message: 'Worktree target is not a real directory'
        };
      }
      const targetIsEmpty = await this.paths.isEmptyDirectory(repository.worktreePath);
      throwIfCancelled(signal);
      const branch = await this.repositories.getBranchInfo(
        repository.sourcePath,
        repository.branch
      );
      throwIfCancelled(signal);
      if (!isExactRecordedWorktree(branch, repository.worktreePath)) {
        if (targetIsEmpty) {
          return {
            state,
            health: 'missing',
            message: 'Worktree is missing; an empty recovery placeholder remains'
          };
        }
        return {
          state,
          health: 'occupied',
          message: occupiedMessage(branch, repository.worktreePath)
        };
      }

      const git = await this.repositories.getStatus(repository.worktreePath);
      throwIfCancelled(signal);
      return {
        state,
        health: healthFromStatus(git),
        git: structuredClone(git)
      };
    } catch (error) {
      if (isCancellation(error) || signal?.aborted === true) throw cancelledError();
      return {
        state,
        health: 'unavailable',
        message: redactGitText(errorMessage(error))
      };
    }
  }

  private async resumeWhileLocked(
    state: WorkspaceState,
    options: LifecycleOptions
  ): Promise<WorkspaceState> {
    throwIfCancelled(options.signal);
    const inspection = await this.inspectState(state, options.signal);
    const blocking = inspection.repositories.find(repository => (
      repository.health === 'occupied' || repository.health === 'unavailable'
    ));
    if (blocking !== undefined) {
      throw lifecycleConflict(
        state.workspacePath,
        blocking.state.id,
        blocking.message ?? `Repository is ${blocking.health}`
      );
    }

    const missing = inspection.repositories.filter(repository => repository.health === 'missing');
    synchronizeOwnership(state, inspection);
    let prepared = false;
    if (missing.length > 0) {
      markRecovery(state, 'resume', 'prepare', this.now);
      await this.states.write(state.workspacePath, state);
      prepared = true;
    }

    for (const inspected of missing) {
      const repository = state.repositories.find(candidate => candidate.id === inspected.state.id);
      if (repository === undefined) {
        throw new AiWorkspaceError('RECOVERY_REQUIRED', 'Workspace repository disappeared', {
          repositoryId: inspected.state.id
        });
      }
      await this.resumeRepository(state, repository, options);
    }

    try {
      throwIfCancelled(options.signal);
      await this.agents.write(state.workspacePath, state);
    } catch (error) {
      if (prepared) {
        markRecovery(state, 'resume', 'context-generation', this.now);
        await writePreservingPrimary(this.states, state, error);
        throw recoveryRequired('resume', state.workspacePath, error);
      }
      throw error;
    }

    state.status = 'ready';
    state.openCodexOnNextActivation = true;
    for (const repository of state.repositories) repository.worktreeCreated = true;
    delete state.recovery;
    touch(state, this.now);
    try {
      await this.states.write(state.workspacePath, state);
    } catch (error) {
      if (prepared) {
        markRecovery(state, 'resume', 'finalize-journal-failed', this.now);
        await writePreservingPrimary(this.states, state, error);
        throw recoveryRequired('resume', state.workspacePath, error);
      }
      throw error;
    }
    return cloneState(state);
  }

  private async resumeRepository(
    state: WorkspaceState,
    repository: WorkspaceRepositoryState,
    options: LifecycleOptions
  ): Promise<void> {
    let claimed = false;
    let addInvoked = false;
    try {
      throwIfCancelled(options.signal);
      const targetExists = await this.paths.exists(repository.worktreePath);
      throwIfCancelled(options.signal);
      if (targetExists) {
        const targetIsReal = await this.paths.isRealDirectory(repository.worktreePath);
        throwIfCancelled(options.signal);
        if (!targetIsReal) {
          throw lifecycleConflict(
            state.workspacePath,
            repository.id,
            `Worktree target is not a real directory: ${repository.worktreePath}`
          );
        }
        const targetIsEmpty = await this.paths.isEmptyDirectory(repository.worktreePath);
        throwIfCancelled(options.signal);
        if (!targetIsEmpty) {
          throw lifecycleConflict(
            state.workspacePath,
            repository.id,
            `Worktree target already exists: ${repository.worktreePath}`
          );
        }
      }

      const branch = await this.repositories.getBranchInfo(
        repository.sourcePath,
        repository.branch
      );
      throwIfCancelled(options.signal);
      if (!branch.exists) {
        throw lifecycleConflict(
          state.workspacePath,
          repository.id,
          `Retained branch is missing: ${repository.branch}`
        );
      }
      if (branch.head === undefined) {
        throw new AiWorkspaceError('GIT', 'Git returned an existing branch without a commit', {
          repositoryId: repository.id,
          branch: repository.branch
        });
      }
      if (branch.worktreePath !== undefined) {
        throw lifecycleConflict(
          state.workspacePath,
          repository.id,
          `Retained branch is occupied at ${branch.worktreePath}`
        );
      }

      if (targetExists) {
        throwIfCancelled(options.signal);
        await this.paths.removeEmpty(repository.worktreePath);
        throwIfCancelled(options.signal);
        const placeholderRemains = await this.paths.exists(repository.worktreePath);
        throwIfCancelled(options.signal);
        if (placeholderRemains) {
          throw lifecycleConflict(
            state.workspacePath,
            repository.id,
            `Empty worktree placeholder could not be removed: ${repository.worktreePath}`
          );
        }
      }

      try {
        await this.paths.claim(repository.worktreePath);
      } catch (error) {
        if (hasCode(error, 'EEXIST')) {
          throw lifecycleConflict(
            state.workspacePath,
            repository.id,
            `Worktree target was claimed concurrently: ${repository.worktreePath}`
          );
        }
        throw error;
      }
      claimed = true;

      report(options, {
        stage: 'resume',
        repositoryId: repository.id,
        message: 'Restoring repository worktree from retained branch'
      });
      throwIfCancelled(options.signal);
      addInvoked = true;
      await this.repositories.addWorktree(addInput(repository, options.signal));
      repository.worktreeCreated = true;
      markRecovery(state, 'resume', 'worktree-added', this.now, repository.id);
      try {
        await this.states.write(state.workspacePath, state);
      } catch (error) {
        markRecovery(state, 'resume', 'journal-failed-after-add', this.now, repository.id);
        await writePreservingPrimary(this.states, state, error);
        throw recoveryRequired('resume', state.workspacePath, error, repository.id);
      }
      claimed = false;
    } catch (error) {
      if (claimed && !addInvoked) {
        await removeClaimPreservingPrimary(this.paths, repository.worktreePath, error);
      }
      if (addInvoked) {
        if (!isRecoveryRequired(error)) {
          markRecovery(state, 'resume', 'ambiguous-git-mutation', this.now, repository.id);
          await writePreservingPrimary(this.states, state, error);
        }
        throw isRecoveryRequired(error)
          ? error
          : recoveryRequired('resume', state.workspacePath, error, repository.id);
      }
      markRecovery(
        state,
        'resume',
        isCancellation(error) ? 'cancelled' : 'blocked',
        this.now,
        repository.id
      );
      await writePreservingPrimary(this.states, state, error);
      throw error;
    }
  }

  private async finishWhileLocked(
    state: WorkspaceState,
    options: FinishOptions
  ): Promise<WorkspaceState> {
    throwIfCancelled(options.signal);
    const inspection = await this.inspectState(state, options.signal);
    const blocking = inspection.repositories.find(repository => (
      repository.health === 'dirty'
      || repository.health === 'occupied'
      || repository.health === 'unavailable'
    ));
    if (blocking !== undefined) {
      throw lifecycleConflict(
        state.workspacePath,
        blocking.state.id,
        blocking.message ?? `Repository is ${blocking.health}`
      );
    }

    const unpublished = inspection.repositories
      .filter(repository => repository.health === 'unpublished');
    if (unpublished.length > 0) {
      throwIfCancelled(options.signal);
      if (!await options.confirmUnpublished(unpublished.map(cloneInspectionRepository))) {
        throw new AiWorkspaceError('CANCELLED', 'Finish cancelled');
      }
    }

    throwIfCancelled(options.signal);
    synchronizeOwnership(state, inspection);
    const existing = new Map(
      inspection.repositories
        .filter(repository => repository.health === 'ready' || repository.health === 'unpublished')
        .map(repository => [repository.state.id, repository.health] as const)
    );
    const hasGitMutation = existing.size > 0;
    if (hasGitMutation) {
      markRecovery(state, 'finish', 'prepare', this.now);
      await this.states.write(state.workspacePath, state);
    }

    for (const repository of state.repositories) {
      const initialHealth = existing.get(repository.id);
      if (initialHealth === undefined) continue;
      await this.finishRepository(state, repository, initialHealth, options);
    }

    state.status = 'finished';
    state.openCodexOnNextActivation = false;
    for (const repository of state.repositories) repository.worktreeCreated = false;
    delete state.recovery;
    touch(state, this.now);
    try {
      await this.states.write(state.workspacePath, state);
    } catch (error) {
      if (hasGitMutation) {
        markRecovery(state, 'finish', 'finalize-journal-failed', this.now);
        await writePreservingPrimary(this.states, state, error);
        throw recoveryRequired('finish', state.workspacePath, error);
      }
      throw error;
    }
    return cloneState(state);
  }

  private async finishRepository(
    state: WorkspaceState,
    repository: WorkspaceRepositoryState,
    initialHealth: RepositoryWorkspaceHealth,
    options: FinishOptions
  ): Promise<void> {
    let removeInvoked = false;
    try {
      throwIfCancelled(options.signal);
      const targetExists = await this.paths.exists(repository.worktreePath);
      throwIfCancelled(options.signal);
      if (!targetExists) {
        repository.worktreeCreated = false;
        markRecovery(state, 'finish', 'worktree-already-missing', this.now, repository.id);
        await this.states.write(state.workspacePath, state);
        return;
      }
      const targetIsReal = await this.paths.isRealDirectory(repository.worktreePath);
      throwIfCancelled(options.signal);
      if (!targetIsReal) {
        throw lifecycleConflict(
          state.workspacePath,
          repository.id,
          'Worktree target is no longer a real directory'
        );
      }

      const branch = await this.repositories.getBranchInfo(
        repository.sourcePath,
        repository.branch
      );
      throwIfCancelled(options.signal);
      if (!isExactRecordedWorktree(branch, repository.worktreePath)) {
        throw lifecycleConflict(
          state.workspacePath,
          repository.id,
          occupiedMessage(branch, repository.worktreePath)
        );
      }

      const status = await this.repositories.getStatus(repository.worktreePath);
      throwIfCancelled(options.signal);
      if (status.dirtyFileCount > 0) {
        throw lifecycleConflict(
          state.workspacePath,
          repository.id,
          'Repository became dirty during finish'
        );
      }
      if (healthFromStatus(status) === 'unpublished' && initialHealth !== 'unpublished') {
        throw lifecycleConflict(
          state.workspacePath,
          repository.id,
          'Repository publication changed during finish; confirm again'
        );
      }

      report(options, {
        stage: 'finish',
        repositoryId: repository.id,
        message: 'Removing clean repository worktree'
      });
      throwIfCancelled(options.signal);
      removeInvoked = true;
      await this.repositories.removeWorktree(
        repository.sourcePath,
        repository.worktreePath
      );
      repository.worktreeCreated = false;
      markRecovery(state, 'finish', 'worktree-removed', this.now, repository.id);
      try {
        await this.states.write(state.workspacePath, state);
      } catch (error) {
        markRecovery(state, 'finish', 'journal-failed-after-remove', this.now, repository.id);
        await writePreservingPrimary(this.states, state, error);
        throw recoveryRequired('finish', state.workspacePath, error, repository.id);
      }
    } catch (error) {
      if (removeInvoked) {
        if (!isRecoveryRequired(error)) {
          markRecovery(state, 'finish', 'ambiguous-git-mutation', this.now, repository.id);
          await writePreservingPrimary(this.states, state, error);
        }
        throw isRecoveryRequired(error)
          ? error
          : recoveryRequired('finish', state.workspacePath, error, repository.id);
      }
      markRecovery(
        state,
        'finish',
        isCancellation(error) ? 'cancelled' : 'blocked',
        this.now,
        repository.id
      );
      await writePreservingPrimary(this.states, state, error);
      throw error;
    }
  }
}

function addInput(
  repository: WorkspaceRepositoryState,
  signal: AbortSignal | undefined
): AddWorktreeInput {
  return {
    sourcePath: repository.sourcePath,
    targetPath: repository.worktreePath,
    branch: repository.branch,
    baseCommit: repository.baseCommit,
    createBranch: false,
    ...(signal === undefined ? {} : { signal })
  };
}

function healthFromStatus(status: RepositoryStatus): InspectedRepository['health'] {
  if (status.dirtyFileCount > 0) return 'dirty';
  if (status.publication === 'ahead' || status.publication === 'no-upstream') {
    return 'unpublished';
  }
  return 'ready';
}

function isExactRecordedWorktree(branch: BranchInfo, expectedPath: string): boolean {
  return branch.exists
    && branch.worktreePath !== undefined
    && path.resolve(branch.worktreePath) === path.resolve(expectedPath);
}

function occupiedMessage(branch: BranchInfo, expectedPath: string): string {
  if (!branch.exists) return 'Recorded branch is missing while the target path exists';
  if (branch.worktreePath === undefined) {
    return 'Target path exists but the recorded branch is not checked out there';
  }
  return redactGitText(
    `Recorded branch is occupied at ${branch.worktreePath}, not ${expectedPath}`
  );
}

function synchronizeOwnership(state: WorkspaceState, inspection: WorkspaceInspection): void {
  const byId = new Map(
    inspection.repositories.map(repository => [repository.state.id, repository] as const)
  );
  for (const repository of state.repositories) {
    const inspected = byId.get(repository.id);
    if (inspected === undefined) continue;
    repository.worktreeCreated = inspected.health !== 'missing';
  }
}

function cloneInspectionRepository(repository: InspectedRepository): InspectedRepository {
  return structuredClone(repository);
}

function assertStateBoundToWorkspace(state: WorkspaceState, workspacePath: string): void {
  const lockedDirectory = path.resolve(workspacePath);
  if (path.resolve(state.workspacePath) !== lockedDirectory) {
    throw lifecycleConflict(
      lockedDirectory,
      undefined,
      'Workspace state belongs to a different directory'
    );
  }

  for (const repository of state.repositories) {
    const expectedWorktreePath = path.join(lockedDirectory, repository.id);
    if (repository.worktreePath !== expectedWorktreePath) {
      throw lifecycleConflict(
        lockedDirectory,
        repository.id,
        'Repository worktree path is outside its recorded workspace child'
      );
    }
    if (repository.branch !== state.branchName) {
      throw lifecycleConflict(
        lockedDirectory,
        repository.id,
        'Repository branch does not match the workspace branch'
      );
    }
  }
}

function assertResumable(state: WorkspaceState): void {
  if (state.status === 'ready' || state.status === 'finished') return;
  if (state.status === 'recoveryRequired'
    && (state.recovery?.operation === 'resume' || state.recovery?.operation === 'finish')) {
    return;
  }
  throw lifecycleConflict(
    state.workspacePath,
    undefined,
    'Workspace is not in a resumable lifecycle state'
  );
}

function assertFinishable(state: WorkspaceState): void {
  if (state.status === 'ready') return;
  if (state.status === 'recoveryRequired' && state.recovery?.operation === 'finish') return;
  throw lifecycleConflict(
    state.workspacePath,
    undefined,
    'Workspace is not in a finishable lifecycle state'
  );
}

function markRecovery(
  state: WorkspaceState,
  operation: 'resume' | 'finish',
  stage: string,
  now: () => Date,
  repositoryId?: string
): void {
  state.status = 'recoveryRequired';
  state.recovery = {
    operation,
    stage,
    ...(repositoryId === undefined ? {} : { repositoryId }),
    message: `Workspace ${operation} requires recovery`
  };
  touch(state, now);
}

function lifecycleConflict(
  workspacePath: string,
  repositoryId: string | undefined,
  message: string
): AiWorkspaceError {
  return new AiWorkspaceError(
    'CONFLICT',
    redactGitText(message),
    {
      workspacePath,
      ...(repositoryId === undefined ? {} : { repositoryId })
    }
  );
}

function recoveryRequired(
  operation: 'resume' | 'finish',
  workspacePath: string,
  cause: unknown,
  repositoryId?: string
): AiWorkspaceError {
  return new AiWorkspaceError(
    'RECOVERY_REQUIRED',
    `Workspace ${operation} requires recovery`,
    {
      workspacePath,
      ...(repositoryId === undefined ? {} : { repositoryId })
    },
    { cause }
  );
}

function isRecoveryRequired(error: unknown): error is AiWorkspaceError {
  return error instanceof AiWorkspaceError && error.code === 'RECOVERY_REQUIRED';
}

async function writePreservingPrimary(
  states: Pick<StateStore, 'write'>,
  state: WorkspaceState,
  _primary: unknown
): Promise<void> {
  try {
    await states.write(state.workspacePath, state);
  } catch {
    // The already-durable prepare journal remains authoritative. A best-effort
    // detail update must never replace the operation's primary failure.
  }
}

async function removeClaimPreservingPrimary(
  paths: PathProbe,
  targetPath: string,
  _primary: unknown
): Promise<void> {
  try {
    await paths.removeEmpty(targetPath);
  } catch {
    // The pre-Git primary failure stays visible. The recovery journal records
    // that the resume did not complete.
  }
}

function report(options: LifecycleOptions, progress: WorkspaceProgress): void {
  options.onProgress?.(Object.freeze(progress));
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw cancelledError();
}

function cancelledError(): AiWorkspaceError {
  return new AiWorkspaceError('CANCELLED', 'Operation cancelled');
}

function isCancellation(error: unknown): boolean {
  return error instanceof AiWorkspaceError && error.code === 'CANCELLED';
}

function touch(state: WorkspaceState, now: () => Date): void {
  state.updatedAt = now().toISOString();
}

function cloneState(state: WorkspaceState): WorkspaceState {
  return structuredClone(state);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Repository is unavailable';
}

async function releaseCapturing(lock: WorkspaceLock): Promise<unknown | undefined> {
  try {
    await lock.release();
    return undefined;
  } catch (error) {
    return error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}
