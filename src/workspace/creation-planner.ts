import * as fs from 'node:fs/promises';
import path from 'node:path';
import { AiWorkspaceError } from '../domain/errors';
import type {
  CreationPlan,
  EffectiveConfig,
  EffectiveRepositoryConfig,
  PlannedRepository,
  RepositorySelection,
  Requirement,
  WorkspaceProgress
} from '../domain/types';
import {
  assertPathInside,
  isPortablePathComponent,
  normalizeRequirementId,
  renderBranchName
} from '../domain/validation';
import type { RepositoryService } from '../git/repository-service';
import { parseProtocolGuardInfo } from '../state/state-schema';
import {
  WORKSPACE_LOCK_FILE,
  WORKSPACE_LOCK_GUARD_DIRECTORY,
  WORKSPACE_LOCK_GUARD_PREPARED_PREFIX,
  WORKSPACE_LOCK_GUARD_RELEASED_PREFIX,
  type StateStore
} from '../state/state-store';

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const OWNER_FILE = new RegExp(`^owner\\.(${UUID_PATTERN})\\.json$`);
const TRANSIENT_GUARD_DIRECTORY = new RegExp(
  `^(${escapeRegExp(WORKSPACE_LOCK_GUARD_PREPARED_PREFIX)}`
    + `|${escapeRegExp(WORKSPACE_LOCK_GUARD_RELEASED_PREFIX)})`
    + `([1-9][0-9]*)\\.(${UUID_PATTERN})$`
);

type RepositoryPort = Pick<RepositoryService,
  | 'assertUsableRepository'
  | 'fetch'
  | 'validateBaseRef'
  | 'resolveCommit'
  | 'validateBranchName'
  | 'getBranchInfo'>;

type StatePort = Pick<StateStore, 'workspacePath' | 'readIfExists'>;

interface ResolvedSelection {
  selection: RepositorySelection;
  repository: EffectiveRepositoryConfig & { path: string };
  worktreePath: string;
}

export interface CreationRequest {
  readonly requirement: Requirement;
  readonly config: EffectiveConfig;
  readonly selections: readonly RepositorySelection[];
}

export interface PlanningOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: WorkspaceProgress) => void;
}

export interface PathProbe {
  exists(targetPath: string): Promise<boolean>;
  isManagedArtifactOnly?(targetPath: string): Promise<boolean>;
}

export interface PathIdentity {
  identify(targetPath: string): string;
}

export class LexicalPathIdentity implements PathIdentity {
  private readonly pathApi: typeof path.posix;
  private readonly caseFold: boolean;

  constructor(platform: NodeJS.Platform = process.platform) {
    this.pathApi = platform === 'win32' ? path.win32 : path.posix;
    this.caseFold = platform === 'win32' || platform === 'darwin';
  }

  identify(targetPath: string): string {
    const resolved = this.pathApi.resolve(targetPath);
    return this.caseFold ? resolved.toLowerCase() : resolved;
  }
}

export interface NodePathProbeOptions {
  readonly isProcessAlive?: (processId: number) => boolean;
}

export class NodePathProbe implements PathProbe {
  private readonly isProcessAlive: (processId: number) => boolean;

  constructor(options: NodePathProbeOptions = {}) {
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  }

  async exists(targetPath: string): Promise<boolean> {
    try {
      await fs.lstat(targetPath);
      return true;
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return false;
      throw error;
    }
  }

  async isManagedArtifactOnly(targetPath: string): Promise<boolean> {
    let targetStats;
    try {
      targetStats = await fs.lstat(targetPath);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return false;
      throw error;
    }
    if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) return false;

    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    if (entries.length === 0) return false;

    for (const entry of entries) {
      if (entry.name === WORKSPACE_LOCK_FILE) {
        if (!entry.isFile() || entry.isSymbolicLink()) return false;
        continue;
      }

      if (entry.name === WORKSPACE_LOCK_GUARD_DIRECTORY) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
        if (!await this.isStrictGuardDirectory(path.join(targetPath, entry.name))) return false;
        continue;
      }

      const transient = TRANSIENT_GUARD_DIRECTORY.exec(entry.name);
      if (transient === null || !entry.isDirectory() || entry.isSymbolicLink()) return false;
      const prefix = transient[1];
      const processId = Number(transient[2]);
      const token = transient[3];
      if (prefix === undefined
        || !Number.isSafeInteger(processId)
        || processId <= 0
        || token === undefined
        || (prefix === WORKSPACE_LOCK_GUARD_PREPARED_PREFIX
          && this.isProcessAlive(processId))
        || !await this.isStrictGuardDirectory(
          path.join(targetPath, entry.name),
          {
            token,
            processId,
            allowPartialOwner: prefix === WORKSPACE_LOCK_GUARD_PREPARED_PREFIX
          }
        )) {
        return false;
      }
    }
    return true;
  }

  private async isStrictGuardDirectory(
    guardPath: string,
    expected?: {
      token: string;
      processId: number;
      allowPartialOwner: boolean;
    }
  ): Promise<boolean> {
    const entries = await fs.readdir(guardPath, { withFileTypes: true });
    if (entries.length === 0) return true;
    if (entries.length !== 1) return false;
    const owner = entries[0];
    if (owner === undefined || !owner.isFile() || owner.isSymbolicLink()) return false;
    const match = OWNER_FILE.exec(owner.name);
    const fileToken = match?.[1];
    if (fileToken === undefined) return false;
    if (expected !== undefined && fileToken !== expected.token) return false;

    let raw: string;
    try {
      raw = await fs.readFile(path.join(guardPath, owner.name), 'utf8');
    } catch {
      return false;
    }

    try {
      const info = parseProtocolGuardInfo(JSON.parse(raw));
      return info.token === fileToken
        && (expected === undefined
          || (info.token === expected.token && info.processId === expected.processId));
    } catch {
      // StateStore can safely compare-and-remove an incomplete owner only when
      // the enclosing prepared artifact has a strict token/PID name and its PID
      // is confirmed dead. Canonical and released owners must always parse.
      return expected?.allowPartialOwner === true;
    }
  }
}

export class CreationPlanner {
  constructor(
    private readonly repositories: RepositoryPort,
    private readonly states: StatePort,
    private readonly paths: PathProbe = new NodePathProbe(),
    private readonly pathIdentities: PathIdentity = new LexicalPathIdentity()
  ) {}

  async plan(
    request: CreationRequest,
    options: PlanningOptions = {}
  ): Promise<CreationPlan> {
    throwIfCancelled(options.signal);
    const requirement = normalizeRequirement(request.requirement);
    assertSelections(request.selections);
    if (!path.isAbsolute(request.config.workspaceRoot)) {
      throw new AiWorkspaceError('CONFIG', 'workspaceRoot must be an absolute path');
    }
    const branchName = renderBranchName(request.config.branchPattern, requirement.id);
    report(options, { stage: 'preflight', message: 'Validating workspace request' });
    throwIfCancelled(options.signal);

    const workspacePath = this.states.workspacePath(
      request.config.workspaceRoot,
      requirement.id
    );
    const existingState = await this.states.readIfExists(workspacePath);
    throwIfCancelled(options.signal);
    if (existingState !== undefined) {
      throw new AiWorkspaceError(
        'CONFLICT',
        `Requirement workspace already exists at ${workspacePath}`,
        { workspacePath }
      );
    }

    const workspaceExists = await this.paths.exists(workspacePath);
    throwIfCancelled(options.signal);
    if (workspaceExists) {
      const managedArtifactOnly = await this.paths.isManagedArtifactOnly?.(workspacePath) ?? false;
      throwIfCancelled(options.signal);
      if (!managedArtifactOnly) {
        throw new AiWorkspaceError(
          'CONFLICT',
          `Requirement directory already exists without managed state: ${workspacePath}`,
          { workspacePath }
        );
      }
    }

    const resolved = await this.resolveSelections(
      request.config,
      request.selections,
      workspacePath,
      options.signal
    );

    for (const item of resolved) {
      throwIfCancelled(options.signal);
      report(options, {
        stage: 'preflight',
        repositoryId: item.repository.id,
        message: 'Validating repository'
      });
      throwIfCancelled(options.signal);
      await this.repositories.assertUsableRepository(
        item.repository.path,
        item.repository.remote
      );
      throwIfCancelled(options.signal);
      await this.repositories.validateBaseRef(
        item.repository.path,
        item.repository.remote,
        item.selection.baseRef
      );
      throwIfCancelled(options.signal);
      await this.repositories.validateBranchName(item.repository.path, branchName);
    }

    const planned: PlannedRepository[] = [];
    for (const item of resolved) {
      throwIfCancelled(options.signal);
      report(options, {
        stage: 'fetch',
        repositoryId: item.repository.id,
        message: 'Fetching repository'
      });
      throwIfCancelled(options.signal);
      await this.repositories.fetch(
        item.repository.path,
        item.repository.remote,
        options.signal
      );
      throwIfCancelled(options.signal);
      const baseCommit = await this.repositories.resolveCommit(
        item.repository.path,
        item.selection.baseRef
      );
      throwIfCancelled(options.signal);
      const branch = await this.repositories.getBranchInfo(item.repository.path, branchName);
      throwIfCancelled(options.signal);

      if (branch.worktreePath !== undefined) {
        throw new AiWorkspaceError(
          'CONFLICT',
          `Requirement branch is already checked out at ${branch.worktreePath}`,
          {
            repositoryId: item.repository.id,
            branch: branchName,
            worktreePath: branch.worktreePath
          }
        );
      }
      if (branch.exists && branch.head === undefined) {
        throw new AiWorkspaceError(
          'GIT',
          'Git returned an existing branch without a commit',
          { repositoryId: item.repository.id, branch: branchName }
        );
      }

      planned.push(Object.freeze({
        id: item.repository.id,
        displayName: item.repository.displayName,
        sourcePath: item.repository.path,
        worktreePath: item.worktreePath,
        remote: item.repository.remote,
        baseRef: item.selection.baseRef,
        baseCommit,
        branch: branchName,
        branchDisposition: branch.exists ? 'reuse' : 'create',
        branchInitialCommit: branch.exists ? branch.head! : baseCommit
      }));
    }

    return Object.freeze({
      requirement: Object.freeze(requirement),
      workspacePath,
      branchName,
      repositories: Object.freeze(planned)
    });
  }

  private async resolveSelections(
    config: EffectiveConfig,
    selections: readonly RepositorySelection[],
    workspacePath: string,
    signal: AbortSignal | undefined
  ): Promise<ResolvedSelection[]> {
    const resolved: ResolvedSelection[] = [];
    const sourceOwners = new Map<string, string>();
    const worktreeOwners = new Map<string, string>();
    for (const selection of selections) {
      throwIfCancelled(signal);
      if (!Object.prototype.hasOwnProperty.call(config.repositories, selection.repositoryId)) {
        throw new AiWorkspaceError(
          'CONFIG',
          `Unknown repository: ${selection.repositoryId}`,
          { repositoryId: selection.repositoryId }
        );
      }
      const repository = config.repositories[selection.repositoryId];
      if (repository === undefined
        || repository.id !== selection.repositoryId
        || !isPortablePathComponent(repository.id)) {
        throw new AiWorkspaceError(
          'CONFIG',
          `Invalid effective repository configuration: ${selection.repositoryId}`,
          { repositoryId: selection.repositoryId }
        );
      }
      if (repository.path === undefined || !path.isAbsolute(repository.path)) {
        throw new AiWorkspaceError(
          'CONFIG',
          `Repository ${selection.repositoryId} requires an absolute local path`,
          { repositoryId: selection.repositoryId }
        );
      }

      const worktreePath = path.join(workspacePath, repository.id);
      assertPathInside(workspacePath, worktreePath);
      this.claimPathIdentity(
        sourceOwners,
        this.pathIdentities.identify(repository.path),
        repository.id,
        'source repository'
      );
      this.claimPathIdentity(
        worktreeOwners,
        this.pathIdentities.identify(worktreePath),
        repository.id,
        'worktree target'
      );
      resolved.push({
        selection,
        repository: repository as EffectiveRepositoryConfig & { path: string },
        worktreePath
      });
    }

    // This is deliberately lexical preflight only. Task 8 must repeat target and
    // repository identity checks while holding the workspace lock, then claim each
    // target atomically before Git mutation. Symlink and Git-common-dir identity are
    // not asserted here and must not be inferred from this early plan.
    for (const item of resolved) {
      const childExists = await this.paths.exists(item.worktreePath);
      throwIfCancelled(signal);
      if (childExists) {
        throw new AiWorkspaceError(
          'CONFLICT',
          `Repository worktree target already exists: ${item.worktreePath}`,
          { repositoryId: item.repository.id, worktreePath: item.worktreePath }
        );
      }
    }
    return resolved;
  }

  private claimPathIdentity(
    owners: Map<string, string>,
    identity: string,
    repositoryId: string,
    kind: string
  ): void {
    const conflictingRepositoryId = owners.get(identity);
    if (conflictingRepositoryId !== undefined) {
      throw new AiWorkspaceError(
        'CONFLICT',
        `Repositories ${conflictingRepositoryId} and ${repositoryId} share one ${kind}`,
        { repositoryId, conflictingRepositoryId, kind }
      );
    }
    owners.set(identity, repositoryId);
  }
}

function normalizeRequirement(requirement: Requirement): Requirement {
  const id = normalizeRequirementId(requirement.id);
  const title = requirement.title.trim();
  if (title.length === 0) {
    throw new AiWorkspaceError('VALIDATION', 'Requirement title must not be empty');
  }
  return { id, title };
}

function assertSelections(selections: readonly RepositorySelection[]): void {
  if (selections.length === 0) {
    throw new AiWorkspaceError('VALIDATION', 'Select at least one repository');
  }
  const ids = new Set<string>();
  for (const selection of selections) {
    if (ids.has(selection.repositoryId)) {
      throw new AiWorkspaceError(
        'VALIDATION',
        `Repository selected more than once: ${selection.repositoryId}`,
        { repositoryId: selection.repositoryId }
      );
    }
    ids.add(selection.repositoryId);
  }
}

function report(options: PlanningOptions, progress: WorkspaceProgress): void {
  options.onProgress?.(Object.freeze(progress));
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new AiWorkspaceError('CANCELLED', 'Operation cancelled');
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

function defaultIsProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return !hasCode(error, 'ESRCH');
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
