import * as fs from 'node:fs/promises';
import { AiWorkspaceError } from '../domain/errors';
import type {
  AddWorktreeInput,
  BranchInfo,
  CreationPlan,
  WorkspaceLock,
  WorkspaceLockInfo,
  WorkspaceProgress,
  WorkspaceRepositoryState,
  WorkspaceState
} from '../domain/types';

type RepositoryPort = {
  addWorktree(input: AddWorktreeInput): Promise<void>;
  removeWorktree(sourcePath: string, worktreePath: string): Promise<void>;
  deleteBranchIfAt(sourcePath: string, branch: string, expectedOid: string): Promise<boolean>;
  getBranchInfo(sourcePath: string, branch: string): Promise<BranchInfo>;
  isClean(worktreePath: string): Promise<boolean>;
};

type StatePort = {
  acquireLock(
    workspacePath: string,
    operation: WorkspaceLockInfo['operation'],
    confirmBreakStale: (lock: WorkspaceLockInfo) => Promise<boolean>
  ): Promise<WorkspaceLock>;
  acquireExistingLock(
    workspacePath: string,
    operation: WorkspaceLockInfo['operation'],
    confirmBreakStale: (lock: WorkspaceLockInfo) => Promise<boolean>
  ): Promise<WorkspaceLock>;
  read(workspacePath: string): Promise<WorkspaceState>;
  readIfExists(workspacePath: string): Promise<WorkspaceState | undefined>;
  write(workspacePath: string, state: WorkspaceState): Promise<void>;
  cleanupGeneratedMetadata(workspacePath: string, expectedState: WorkspaceState): Promise<void>;
};

type AgentsPort = {
  write(workspacePath: string, state: WorkspaceState): Promise<void>;
};

export interface PathMutator {
  exists(targetPath: string): Promise<boolean>;
  isEmptyDirectory(targetPath: string): Promise<boolean>;
  claim(targetPath: string): Promise<void>;
  removeEmpty(targetPath: string): Promise<void>;
}

export class NodePathMutator implements PathMutator {
  async exists(targetPath: string): Promise<boolean> {
    try {
      await fs.lstat(targetPath);
      return true;
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return false;
      throw error;
    }
  }

  async claim(targetPath: string): Promise<void> {
    await fs.mkdir(targetPath);
  }

  async isEmptyDirectory(targetPath: string): Promise<boolean> {
    try {
      const stats = await fs.lstat(targetPath);
      if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
      return (await fs.readdir(targetPath)).length === 0;
    } catch (error) {
      if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) return false;
      throw error;
    }
  }

  async removeEmpty(targetPath: string): Promise<void> {
    try {
      await fs.rmdir(targetPath);
    } catch (error) {
      if (!hasCode(error, 'ENOENT') && !hasCode(error, 'ENOTEMPTY')) throw error;
    }
  }
}

export interface OrchestrationOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: WorkspaceProgress) => void;
  readonly confirmBreakStaleLock: (lock: WorkspaceLockInfo) => Promise<boolean>;
}

interface LockedCreateResult {
  result?: WorkspaceState;
  primaryError?: unknown;
  cleanupState?: WorkspaceState;
}

interface RollbackResult {
  complete: boolean;
  state: WorkspaceState;
}

export class WorkspaceOrchestrator {
  constructor(
    private readonly repositories: RepositoryPort,
    private readonly states: StatePort,
    private readonly agents: AgentsPort,
    private readonly now: () => Date = () => new Date(),
    private readonly paths: PathMutator = new NodePathMutator()
  ) {}

  async create(
    plan: CreationPlan,
    options: OrchestrationOptions
  ): Promise<WorkspaceState> {
    const lock = await this.states.acquireLock(
      plan.workspacePath,
      'create',
      options.confirmBreakStaleLock
    );

    let outcome: LockedCreateResult;
    try {
      outcome = await this.createWhileLocked(plan, options);
    } catch (error) {
      outcome = { primaryError: error };
    }

    const releaseError = await releaseCapturing(lock);
    if (releaseError === undefined && outcome.cleanupState !== undefined) {
      try {
        await this.states.cleanupGeneratedMetadata(plan.workspacePath, outcome.cleanupState);
      } catch (cleanupError) {
        if (outcome.primaryError === undefined) outcome.primaryError = cleanupError;
      }
    }

    if (outcome.primaryError !== undefined) throw outcome.primaryError;
    if (releaseError !== undefined) throw releaseError;
    if (outcome.result === undefined) {
      throw new AiWorkspaceError('RECOVERY_REQUIRED', 'Workspace creation did not complete');
    }
    return outcome.result;
  }

  async recover(
    workspacePath: string,
    action: 'continue' | 'rollback',
    options: OrchestrationOptions
  ): Promise<WorkspaceState | undefined> {
    const lock = await this.states.acquireExistingLock(
      workspacePath,
      'recover',
      options.confirmBreakStaleLock
    );

    let result: WorkspaceState | undefined;
    let primaryError: unknown;
    let cleanupState: WorkspaceState | undefined;
    try {
      const authoritative = cloneState(await this.states.read(workspacePath));
      assertCreateRecovery(authoritative);
      if (authoritative.status === 'creating') {
        authoritative.status = 'recoveryRequired';
        authoritative.recovery = recoveryRecord('interrupted-create');
        touch(authoritative, this.now);
        await this.states.write(workspacePath, authoritative);
      }

      if (action === 'continue') {
        result = await this.continueWhileLocked(authoritative, options);
      } else {
        const rollback = await this.rollbackOwned(authoritative, options);
        if (!rollback.complete || await this.hasAmbiguousMutation(rollback.state)) {
          const recovery = markRecovery(rollback.state, 'rollback-incomplete', this.now);
          await this.states.write(workspacePath, recovery);
          throw recoveryRequired(workspacePath);
        }
        if (!await this.removeEmptyTargets(rollback.state)) {
          const recovery = markRecovery(rollback.state, 'target-cleanup-incomplete', this.now);
          await this.states.write(workspacePath, recovery);
          throw recoveryRequired(workspacePath);
        }
        cleanupState = cloneState(rollback.state);
      }
    } catch (error) {
      primaryError = error;
    }

    const releaseError = await releaseCapturing(lock);
    if (releaseError === undefined && cleanupState !== undefined) {
      try {
        await this.states.cleanupGeneratedMetadata(workspacePath, cleanupState);
      } catch (error) {
        primaryError ??= error;
      }
    }
    if (primaryError !== undefined) throw primaryError;
    if (releaseError !== undefined) throw releaseError;
    return result;
  }

  private async createWhileLocked(
    plan: CreationPlan,
    options: OrchestrationOptions
  ): Promise<LockedCreateResult> {
    throwIfCancelled(options.signal);
    const existing = await this.states.readIfExists(plan.workspacePath);
    if (existing !== undefined) {
      throw new AiWorkspaceError(
        'CONFLICT',
        `Requirement workspace already exists at ${plan.workspacePath}`,
        { workspacePath: plan.workspacePath }
      );
    }

    await this.revalidatePlan(plan, options.signal);
    const state = stateFromPlan(plan, this.now());
    await this.states.write(plan.workspacePath, state);

    const claimed: string[] = [];
    try {
      for (const repository of plan.repositories) {
        throwIfCancelled(options.signal);
        await this.paths.claim(repository.worktreePath);
        claimed.push(repository.worktreePath);
      }
    } catch (error) {
      const claimsRemoved = await this.removeClaims(claimed);
      if (!claimsRemoved) {
        const recovery = markRecovery(state, 'target-cleanup-incomplete', this.now);
        await this.writeRecoveryBestEffort(plan.workspacePath, recovery);
        return { primaryError: recoveryRequired(plan.workspacePath, error) };
      }
      return {
        primaryError: error,
        cleanupState: cloneState(state)
      };
    }

    let ambiguousRepositoryId: string | undefined;
    let originalError: unknown;
    try {
      for (const repository of state.repositories) {
        throwIfCancelled(options.signal);
        report(options, {
          stage: 'create',
          repositoryId: repository.id,
          message: 'Creating repository worktree'
        });
        throwIfCancelled(options.signal);
        try {
          await this.repositories.addWorktree({
            sourcePath: repository.sourcePath,
            targetPath: repository.worktreePath,
            branch: repository.branch,
            baseCommit: repository.baseCommit,
            createBranch: !repository.branchExistedBefore,
            ...(options.signal === undefined ? {} : { signal: options.signal })
          });
        } catch (error) {
          ambiguousRepositoryId = repository.id;
          throw error;
        }
        repository.worktreeCreated = true;
        repository.branchCreatedByOperation = !repository.branchExistedBefore;
        touch(state, this.now);
        await this.states.write(plan.workspacePath, state);
      }

      await this.agents.write(plan.workspacePath, state);
      state.status = 'ready';
      delete state.recovery;
      touch(state, this.now);
      await this.states.write(plan.workspacePath, state);
      return { result: cloneState(state) };
    } catch (error) {
      originalError = error;
    }

    const rollback = await this.rollbackOwned(state, options);
    const claimsRemoved = await this.removeClaims(claimed);
    if (ambiguousRepositoryId !== undefined || !rollback.complete || !claimsRemoved) {
      const recovery = markRecovery(
        rollback.state,
        ambiguousRepositoryId !== undefined
          ? 'ambiguous-git-mutation'
          : claimsRemoved ? 'rollback-incomplete' : 'target-cleanup-incomplete',
        this.now,
        ambiguousRepositoryId
      );
      await this.writeRecoveryBestEffort(plan.workspacePath, recovery);
      return {
        primaryError: recoveryRequired(plan.workspacePath, originalError)
      };
    }

    return {
      primaryError: originalError,
      cleanupState: cloneState(rollback.state)
    };
  }

  private async revalidatePlan(plan: CreationPlan, signal: AbortSignal | undefined): Promise<void> {
    for (const repository of plan.repositories) {
      throwIfCancelled(signal);
      if (await this.paths.exists(repository.worktreePath)) {
        throw new AiWorkspaceError(
          'CONFLICT',
          `Repository target changed after planning: ${repository.worktreePath}`,
          { repositoryId: repository.id, worktreePath: repository.worktreePath }
        );
      }
      throwIfCancelled(signal);
      const branch = await this.repositories.getBranchInfo(repository.sourcePath, repository.branch);
      if (branch.worktreePath !== undefined) {
        throw new AiWorkspaceError(
          'CONFLICT',
          `Requirement branch is checked out at ${branch.worktreePath}`,
          { repositoryId: repository.id, worktreePath: branch.worktreePath }
        );
      }
      const matches = repository.branchDisposition === 'create'
        ? !branch.exists
        : branch.exists && branch.head === repository.branchInitialCommit;
      if (!matches) {
        throw new AiWorkspaceError(
          'CONFLICT',
          `Requirement branch changed after planning: ${repository.branch}`,
          { repositoryId: repository.id, branch: repository.branch }
        );
      }
    }
  }

  private async rollbackOwned(
    state: WorkspaceState,
    options: OrchestrationOptions
  ): Promise<RollbackResult> {
    let complete = true;
    for (const repository of [...state.repositories].reverse()) {
      report(options, {
        stage: 'rollback',
        repositoryId: repository.id,
        message: 'Rolling back repository worktree'
      });
      try {
        if (repository.worktreeCreated) {
          const branch = await this.repositories.getBranchInfo(
            repository.sourcePath,
            repository.branch
          );
          if (branch.worktreePath === repository.worktreePath) {
            if (!await this.repositories.isClean(repository.worktreePath)) {
              complete = false;
              continue;
            }
            await this.repositories.removeWorktree(repository.sourcePath, repository.worktreePath);
          } else if (branch.worktreePath !== undefined) {
            complete = false;
            continue;
          }
          repository.worktreeCreated = false;
          touch(state, this.now);
          await this.states.write(state.workspacePath, state);
        }

        if (repository.branchCreatedByOperation) {
          const deleted = await this.repositories.deleteBranchIfAt(
            repository.sourcePath,
            repository.branch,
            repository.branchInitialCommit
          );
          if (deleted) {
            repository.branchCreatedByOperation = false;
          } else {
            const current = await this.repositories.getBranchInfo(
              repository.sourcePath,
              repository.branch
            );
            if (current.exists) complete = false;
            else repository.branchCreatedByOperation = false;
          }
          touch(state, this.now);
          await this.states.write(state.workspacePath, state);
        }
      } catch {
        complete = false;
      }
    }
    return { complete, state };
  }

  private async continueWhileLocked(
    state: WorkspaceState,
    options: OrchestrationOptions
  ): Promise<WorkspaceState> {
    for (const repository of state.repositories) {
      throwIfCancelled(options.signal);
      const branch = await this.repositories.getBranchInfo(repository.sourcePath, repository.branch);
      if (branch.worktreePath !== undefined) {
        if (branch.worktreePath !== repository.worktreePath) {
          throw new AiWorkspaceError(
            'CONFLICT',
            `Requirement branch is checked out elsewhere: ${branch.worktreePath}`,
            { repositoryId: repository.id, worktreePath: branch.worktreePath }
          );
        }
        repository.worktreeCreated = true;
      } else if (branch.exists) {
        if (branch.head === undefined) {
          throw new AiWorkspaceError(
            'GIT',
            'Git returned an existing branch without a commit',
            { repositoryId: repository.id, branch: repository.branch }
          );
        }
        if (!repository.branchExistedBefore
          && !repository.branchCreatedByOperation
          && branch.head !== repository.branchInitialCommit) {
          throw new AiWorkspaceError(
            'CONFLICT',
            `Unowned requirement branch changed during recovery: ${repository.branch}`,
            { repositoryId: repository.id, branch: repository.branch }
          );
        }
        await this.ensureRecoveryTarget(repository.worktreePath);
        await this.repositories.addWorktree({
          sourcePath: repository.sourcePath,
          targetPath: repository.worktreePath,
          branch: repository.branch,
          baseCommit: repository.baseCommit,
          createBranch: false,
          ...(options.signal === undefined ? {} : { signal: options.signal })
        });
        repository.worktreeCreated = true;
      } else if (!repository.branchExistedBefore) {
        await this.ensureRecoveryTarget(repository.worktreePath);
        await this.repositories.addWorktree({
          sourcePath: repository.sourcePath,
          targetPath: repository.worktreePath,
          branch: repository.branch,
          baseCommit: repository.baseCommit,
          createBranch: true,
          ...(options.signal === undefined ? {} : { signal: options.signal })
        });
        repository.worktreeCreated = true;
        repository.branchCreatedByOperation = true;
      } else {
        throw new AiWorkspaceError(
          'CONFLICT',
          `Pre-existing requirement branch is missing: ${repository.branch}`,
          { repositoryId: repository.id, branch: repository.branch }
        );
      }
      touch(state, this.now);
      await this.states.write(state.workspacePath, state);
    }
    await this.agents.write(state.workspacePath, state);
    state.status = 'ready';
    delete state.recovery;
    touch(state, this.now);
    await this.states.write(state.workspacePath, state);
    return cloneState(state);
  }

  private async hasAmbiguousMutation(state: WorkspaceState): Promise<boolean> {
    for (const repository of state.repositories) {
      if (repository.worktreeCreated) return true;
      const branch = await this.repositories.getBranchInfo(repository.sourcePath, repository.branch);
      if (branch.worktreePath === repository.worktreePath) return true;
      if (repository.branchCreatedByOperation && branch.exists) return true;
      if (state.recovery?.stage === 'ambiguous-git-mutation'
        && state.recovery.repositoryId === repository.id
        && branch.exists) return true;
    }
    return false;
  }

  private async removeClaims(claimed: readonly string[]): Promise<boolean> {
    let complete = true;
    for (const target of [...claimed].reverse()) {
      try {
        await this.paths.removeEmpty(target);
        if (await this.paths.exists(target)) complete = false;
      } catch {
        complete = false;
      }
    }
    return complete;
  }

  private async removeEmptyTargets(state: WorkspaceState): Promise<boolean> {
    let complete = true;
    for (const repository of [...state.repositories].reverse()) {
      try {
        await this.paths.removeEmpty(repository.worktreePath);
        if (await this.paths.exists(repository.worktreePath)) complete = false;
      } catch {
        complete = false;
      }
    }
    return complete;
  }

  private async ensureRecoveryTarget(targetPath: string): Promise<void> {
    if (await this.paths.exists(targetPath)) {
      if (!await this.paths.isEmptyDirectory(targetPath)) {
        throw recoveryTargetConflict(targetPath);
      }
      await this.paths.removeEmpty(targetPath);
      if (await this.paths.exists(targetPath)) throw recoveryTargetConflict(targetPath);
    }
    try {
      await this.paths.claim(targetPath);
    } catch (error) {
      if (hasCode(error, 'EEXIST')) throw recoveryTargetConflict(targetPath, error);
      throw error;
    }
  }

  private async writeRecoveryBestEffort(
    workspacePath: string,
    state: WorkspaceState
  ): Promise<void> {
    try {
      await this.states.write(workspacePath, state);
    } catch {
      // The caller still receives a typed recovery error with the original
      // operation as its cause; a secondary journal fault must not replace it.
    }
  }
}

function stateFromPlan(plan: CreationPlan, now: Date): WorkspaceState {
  const timestamp = now.toISOString();
  return {
    version: 1,
    status: 'creating',
    requirement: { ...plan.requirement },
    workspacePath: plan.workspacePath,
    branchName: plan.branchName,
    createdAt: timestamp,
    updatedAt: timestamp,
    openCodexOnNextActivation: true,
    repositories: plan.repositories.map(repository => ({
      id: repository.id,
      displayName: repository.displayName,
      sourcePath: repository.sourcePath,
      worktreePath: repository.worktreePath,
      remote: repository.remote,
      baseRef: repository.baseRef,
      baseCommit: repository.baseCommit,
      branch: repository.branch,
      branchExistedBefore: repository.branchDisposition === 'reuse',
      branchCreatedByOperation: false,
      branchInitialCommit: repository.branchInitialCommit,
      worktreeCreated: false
    }))
  };
}

function assertCreateRecovery(state: WorkspaceState): void {
  if (state.status === 'creating') return;
  if (state.status === 'recoveryRequired' && state.recovery?.operation === 'create') return;
  throw new AiWorkspaceError(
    'CONFLICT',
    'Workspace is not in recoverable creation state',
    { workspacePath: state.workspacePath, status: state.status }
  );
}

function markRecovery(
  state: WorkspaceState,
  stage: string,
  now: () => Date,
  repositoryId?: string
): WorkspaceState {
  state.status = 'recoveryRequired';
  state.recovery = recoveryRecord(stage, repositoryId);
  touch(state, now);
  return state;
}

function recoveryRecord(stage: string, repositoryId?: string): NonNullable<WorkspaceState['recovery']> {
  return {
    operation: 'create',
    stage,
    ...(repositoryId === undefined ? {} : { repositoryId }),
    message: 'Workspace creation requires recovery'
  };
}

function recoveryRequired(workspacePath: string, cause?: unknown): AiWorkspaceError {
  return new AiWorkspaceError(
    'RECOVERY_REQUIRED',
    'Workspace creation requires recovery',
    { workspacePath },
    cause === undefined ? undefined : { cause }
  );
}

function recoveryTargetConflict(targetPath: string, cause?: unknown): AiWorkspaceError {
  return new AiWorkspaceError(
    'CONFLICT',
    `Recovery target is not an exclusively claimed empty directory: ${targetPath}`,
    { targetPath },
    cause === undefined ? undefined : { cause }
  );
}

function touch(state: WorkspaceState, now: () => Date): void {
  state.updatedAt = now().toISOString();
}

function cloneState(state: WorkspaceState): WorkspaceState {
  return structuredClone(state);
}

function report(options: OrchestrationOptions, progress: WorkspaceProgress): void {
  options.onProgress?.(Object.freeze(progress));
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new AiWorkspaceError('CANCELLED', 'Operation cancelled');
  }
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
