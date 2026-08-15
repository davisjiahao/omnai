import { randomUUID } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { AiWorkspaceError } from '../domain/errors';
import type {
  WorkspaceLock,
  WorkspaceLockInfo,
  WorkspaceState
} from '../domain/types';
import { assertPathInside, normalizeRequirementId } from '../domain/validation';
import {
  parseProtocolGuardInfo,
  parseWorkspaceLockInfo,
  parseWorkspaceState,
  type ProtocolGuardInfo
} from './state-schema';

export const WORKSPACE_STATE_FILE = '.ai-workspace.json';
export const WORKSPACE_LOCK_FILE = '.ai-workspace.lock';
const AGENTS_FILE = 'AGENTS.md';
export const WORKSPACE_LOCK_GUARD_DIRECTORY = '.ai-workspace.lock.guard';
export const WORKSPACE_LOCK_GUARD_PREPARED_PREFIX = '.ai-workspace.lock.guard.prepared.';
export const WORKSPACE_LOCK_GUARD_RELEASED_PREFIX = '.ai-workspace.lock.guard.released.';
const ACTIVE_PROTOCOL_GUARDS = new Set<string>();
const ACTIVE_PREPARED_GUARDS = new Set<string>();

export interface StateStoreFileSystem {
  mkdir(target: string, options?: { recursive?: boolean; mode?: number }): Promise<unknown>;
  open(target: string, flags: string, mode?: number): Promise<FileHandle>;
  readFile(target: string, encoding: 'utf8'): Promise<string>;
  rename(source: string, target: string): Promise<void>;
  unlink(target: string): Promise<void>;
  readdir(target: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  rmdir(target: string): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  lstat(target: string): Promise<Stats>;
}

const DEFAULT_FILE_SYSTEM: StateStoreFileSystem = {
  mkdir: async (target, options) => { await nodeFs.mkdir(target, options); },
  open: (target, flags, mode) => nodeFs.open(target, flags, mode),
  readFile: (target, encoding) => nodeFs.readFile(target, encoding),
  rename: (source, target) => nodeFs.rename(source, target),
  unlink: target => nodeFs.unlink(target),
  readdir: (target, options) => nodeFs.readdir(target, options),
  rmdir: target => nodeFs.rmdir(target),
  link: (existingPath, newPath) => nodeFs.link(existingPath, newPath),
  lstat: target => nodeFs.lstat(target)
};

export interface StateStoreOptions {
  processId?: number;
  isProcessAlive?: (processId: number) => boolean;
  now?: () => Date;
  fileSystem?: Partial<StateStoreFileSystem>;
}

interface FileIdentity {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface TextFileSnapshot {
  raw: string;
  identity: FileIdentity;
}

interface ProtocolGuard {
  info: ProtocolGuardInfo;
  release(): Promise<void>;
}

interface GuardOwnerSnapshot {
  kind: 'owned';
  info: ProtocolGuardInfo;
  ownerPath: string;
  snapshot: TextFileSnapshot;
}

type GuardDirectorySnapshot =
  | { kind: 'missing' }
  | { kind: 'empty' }
  | GuardOwnerSnapshot;

type PreparedArtifactSnapshot =
  | { kind: 'empty' }
  | { kind: 'unknown' }
  | { kind: 'owner'; ownerPath: string; snapshot: TextFileSnapshot };

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

function locked(message: string, details: Readonly<Record<string, unknown>> = {}): AiWorkspaceError {
  return new AiWorkspaceError('LOCKED', message, details);
}

function guardKey(guardPath: string, token: string): string {
  return `${guardPath}\u0000${token}`;
}

function guardOwnerName(token: string): string {
  return `owner.${token}.json`;
}

function identityOf(stats: Stats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sameSnapshot(left: TextFileSnapshot, right: TextFileSnapshot): boolean {
  return left.raw === right.raw && sameIdentity(left.identity, right.identity);
}

function invalidDocument(kind: 'state' | 'lock' | 'lock guard', cause: unknown): AiWorkspaceError {
  const noun = kind === 'state' ? 'workspace state' : `workspace ${kind}`;
  return new AiWorkspaceError(
    'RECOVERY_REQUIRED',
    `Invalid ${noun}`,
    {},
    { cause }
  );
}

function defaultIsProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return !isErrno(error, 'ESRCH');
  }
}

export class StateStore {
  private readonly processId: number;
  private readonly isProcessAlive: (processId: number) => boolean;
  private readonly now: () => Date;
  private readonly fs: StateStoreFileSystem;
  private readonly retainedGuards = new Map<string, ProtocolGuard>();

  constructor(options: StateStoreOptions = {}) {
    this.processId = options.processId ?? process.pid;
    if (!Number.isSafeInteger(this.processId) || this.processId <= 0) {
      throw new AiWorkspaceError('VALIDATION', 'processId must be a positive safe integer');
    }
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.now = options.now ?? (() => new Date());
    this.fs = { ...DEFAULT_FILE_SYSTEM, ...options.fileSystem };
  }

  workspacePath(workspaceRoot: string, requirementId: string): string {
    const root = path.resolve(workspaceRoot);
    const candidate = path.join(root, normalizeRequirementId(requirementId));
    assertPathInside(root, candidate);
    return candidate;
  }

  async read(workspacePath: string): Promise<WorkspaceState> {
    const statePath = path.join(path.resolve(workspacePath), WORKSPACE_STATE_FILE);
    let raw: string;
    try {
      raw = await this.fs.readFile(statePath, 'utf8');
    } catch (error) {
      throw error;
    }
    return this.parseStateJson(raw);
  }

  async readIfExists(workspacePath: string): Promise<WorkspaceState | undefined> {
    try {
      return await this.read(workspacePath);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined;
      throw error;
    }
  }

  async write(workspacePath: string, state: WorkspaceState): Promise<void> {
    const directory = path.resolve(workspacePath);
    const parsed = parseWorkspaceState(state);
    await this.fs.mkdir(directory, { recursive: true });
    const target = path.join(directory, WORKSPACE_STATE_FILE);
    const temporary = path.join(
      directory,
      `${WORKSPACE_STATE_FILE}.${this.processId}.${randomUUID()}.tmp`
    );
    await this.atomicWrite(temporary, target, this.serializeState(parsed));
  }

  async list(workspaceRoot: string): Promise<WorkspaceState[]> {
    let entries: Dirent[];
    try {
      entries = await this.fs.readdir(path.resolve(workspaceRoot), { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return [];
      throw error;
    }

    const states: WorkspaceState[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const state = await this.readIfExists(path.join(path.resolve(workspaceRoot), entry.name));
      if (state !== undefined) states.push(state);
    }
    states.sort((left, right) => {
      const byUpdatedAt = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      return byUpdatedAt || left.workspacePath.localeCompare(right.workspacePath);
    });
    return states;
  }

  async acquireLock(
    workspacePath: string,
    operation: WorkspaceLockInfo['operation'],
    confirmBreakStale: (lock: WorkspaceLockInfo) => Promise<boolean>
  ): Promise<WorkspaceLock> {
    const directory = path.resolve(workspacePath);
    await this.fs.mkdir(directory, { recursive: true });
    return this.acquireLockInDirectory(directory, operation, confirmBreakStale);
  }

  async acquireExistingLock(
    workspacePath: string,
    operation: WorkspaceLockInfo['operation'],
    confirmBreakStale: (lock: WorkspaceLockInfo) => Promise<boolean>
  ): Promise<WorkspaceLock> {
    return this.acquireLockInExistingDirectory(workspacePath, operation, confirmBreakStale);
  }

  async acquireLockInExistingDirectory(
    workspacePath: string,
    operation: WorkspaceLockInfo['operation'],
    confirmBreakStale: (lock: WorkspaceLockInfo) => Promise<boolean>
  ): Promise<WorkspaceLock> {
    const directory = path.resolve(workspacePath);
    let stats: Stats;
    try {
      stats = await this.fs.lstat(directory);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        throw new AiWorkspaceError(
          'RECOVERY_REQUIRED',
          'Workspace directory does not exist',
          { workspacePath: directory }
        );
      }
      throw error;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new AiWorkspaceError(
        'RECOVERY_REQUIRED',
        'Workspace path is not a real directory',
        { workspacePath: directory }
      );
    }
    return this.acquireLockInDirectory(directory, operation, confirmBreakStale);
  }

  private async acquireLockInDirectory(
    directory: string,
    operation: WorkspaceLockInfo['operation'],
    confirmBreakStale: (lock: WorkspaceLockInfo) => Promise<boolean>
  ): Promise<WorkspaceLock> {
    const lockPath = path.join(directory, WORKSPACE_LOCK_FILE);
    const guard = await this.acquireProtocolGuard(directory);

    let info: WorkspaceLockInfo | undefined;
    try {
      info = await this.acquireCanonicalLock(lockPath, operation, confirmBreakStale);
    } catch (error) {
      await this.releaseGuardPreservingPrimary(lockPath, guard, error);
    }

    if (info === undefined) {
      throw new AiWorkspaceError('RECOVERY_REQUIRED', 'Workspace lock acquisition did not complete');
    }

    try {
      await guard.release();
      return this.createWorkspaceLock(lockPath, info);
    } catch {
      // The canonical lock is already ours. Returning it with the still-owned
      // guard keeps the caller able to release both instead of orphaning either.
      return this.createWorkspaceLock(lockPath, info, guard);
    }
  }

  async cleanupGeneratedMetadata(
    workspacePath: string,
    expectedState: WorkspaceState
  ): Promise<void> {
    const directory = path.resolve(workspacePath);
    const lockPath = path.join(directory, WORKSPACE_LOCK_FILE);
    const statePath = path.join(directory, WORKSPACE_STATE_FILE);
    const expected = this.serializeState(expectedState);
    const guard = await this.acquireProtocolGuard(directory);
    let primaryError: unknown;
    try {
      const canonicalLock = await this.captureSnapshot(lockPath, 'workspace lock');
      if (canonicalLock !== undefined) {
        const info = this.parseLockSnapshot(canonicalLock);
        throw locked('Workspace was locked before generated metadata cleanup', { lock: info });
      }

      const observed = await this.captureSnapshot(statePath, 'workspace state');
      if (observed !== undefined) {
        if (observed.raw !== expected) {
          throw new AiWorkspaceError(
            'CONFLICT',
            'Workspace state changed before generated metadata cleanup',
            { workspacePath: directory }
          );
        }
        await this.unlinkIfPresent(path.join(directory, AGENTS_FILE));

        const lockBeforeStateRemoval = await this.captureSnapshot(lockPath, 'workspace lock');
        if (lockBeforeStateRemoval !== undefined) {
          const info = this.parseLockSnapshot(lockBeforeStateRemoval);
          throw locked('Workspace was locked during generated metadata cleanup', { lock: info });
        }
        const current = await this.captureSnapshot(statePath, 'workspace state');
        if (current === undefined || !sameSnapshot(observed, current) || current.raw !== expected) {
          throw new AiWorkspaceError(
            'CONFLICT',
            'Workspace state changed during generated metadata cleanup',
            { workspacePath: directory }
          );
        }
        await this.fs.unlink(statePath);
      }
    } catch (error) {
      primaryError = error;
    }

    try {
      await guard.release();
    } catch (error) {
      this.retainedGuards.set(lockPath, guard);
      primaryError ??= error;
    }
    if (primaryError !== undefined) throw primaryError;

    try {
      await this.fs.rmdir(directory);
    } catch (error) {
      if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTEMPTY')) throw error;
    }
  }

  async removeGeneratedMetadata(
    workspacePath: string,
    expectedState: WorkspaceState
  ): Promise<void> {
    await this.cleanupGeneratedMetadata(workspacePath, expectedState);
  }

  private parseStateJson(raw: string): WorkspaceState {
    try {
      return parseWorkspaceState(JSON.parse(raw));
    } catch (error) {
      if (error instanceof AiWorkspaceError) throw error;
      throw invalidDocument('state', error);
    }
  }

  private serializeState(state: WorkspaceState): string {
    return `${JSON.stringify(parseWorkspaceState(state), null, 2)}\n`;
  }

  private parseLockSnapshot(snapshot: TextFileSnapshot): WorkspaceLockInfo {
    try {
      return parseWorkspaceLockInfo(JSON.parse(snapshot.raw));
    } catch (error) {
      if (error instanceof AiWorkspaceError) throw error;
      throw invalidDocument('lock', error);
    }
  }

  private parseGuardSnapshot(snapshot: TextFileSnapshot): ProtocolGuardInfo {
    try {
      return parseProtocolGuardInfo(JSON.parse(snapshot.raw));
    } catch (error) {
      if (error instanceof AiWorkspaceError) throw error;
      throw invalidDocument('lock guard', error);
    }
  }

  private async atomicWrite(temporary: string, target: string, contents: string): Promise<void> {
    let handle: FileHandle | undefined;
    let created = false;
    let primaryError: unknown;
    try {
      handle = await this.fs.open(temporary, 'wx', 0o600);
      created = true;
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.fs.rename(temporary, target);
    } catch (error) {
      primaryError = error;
    }

    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (error) {
        primaryError ??= error;
      }
    }
    if (created) {
      try {
        await this.fs.unlink(temporary);
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) primaryError ??= error;
      }
    }
    if (primaryError !== undefined) throw primaryError;
  }

  private async writeExclusive(target: string, contents: string): Promise<void> {
    let handle: FileHandle | undefined;
    let created = false;
    let primaryError: unknown;
    try {
      handle = await this.fs.open(target, 'wx', 0o600);
      created = true;
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
    } catch (error) {
      primaryError = error;
    }

    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (error) {
        primaryError ??= error;
      }
    }
    if (primaryError !== undefined && created) {
      try {
        await this.fs.unlink(target);
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) primaryError ??= error;
      }
    }
    if (primaryError !== undefined) throw primaryError;
  }

  private async captureSnapshot(target: string, description: string): Promise<TextFileSnapshot | undefined> {
    let before: Stats;
    try {
      before = await this.fs.lstat(target);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined;
      throw error;
    }
    if (!before.isFile()) {
      throw new AiWorkspaceError(
        'RECOVERY_REQUIRED',
        `Invalid ${description}`,
        { path: target }
      );
    }

    let raw: string;
    try {
      raw = await this.fs.readFile(target, 'utf8');
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined;
      throw error;
    }

    let after: Stats;
    try {
      after = await this.fs.lstat(target);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined;
      throw error;
    }
    const beforeIdentity = identityOf(before);
    const afterIdentity = identityOf(after);
    if (!sameIdentity(beforeIdentity, afterIdentity)) {
      throw locked(`${description} changed while it was being inspected`, { path: target });
    }
    return { raw, identity: afterIdentity };
  }

  private async acquireCanonicalLock(
    lockPath: string,
    operation: WorkspaceLockInfo['operation'],
    confirmBreakStale: (lock: WorkspaceLockInfo) => Promise<boolean>
  ): Promise<WorkspaceLockInfo> {
    const info: WorkspaceLockInfo = {
      token: randomUUID(),
      processId: this.processId,
      operation,
      startedAt: this.now().toISOString()
    };

    try {
      await this.writeExclusive(lockPath, `${JSON.stringify(info)}\n`);
      return info;
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
    }

    const observed = await this.captureSnapshot(lockPath, 'workspace lock');
    if (observed === undefined) return this.createCanonicalAfterBreak(lockPath, info);
    const existing = this.parseLockSnapshot(observed);
    if (this.isProcessAlive(existing.processId)) {
      throw locked('Workspace is locked by an active process', { lock: existing });
    }
    if (!await confirmBreakStale(existing)) {
      throw locked('Stale workspace lock was retained', { lock: existing });
    }

    const current = await this.captureSnapshot(lockPath, 'workspace lock');
    if (current === undefined || !sameSnapshot(observed, current)) {
      throw locked('Workspace lock changed after stale-lock confirmation', { lock: existing });
    }
    await this.fs.unlink(lockPath);
    return this.createCanonicalAfterBreak(lockPath, info);
  }

  private async createCanonicalAfterBreak(
    lockPath: string,
    info: WorkspaceLockInfo
  ): Promise<WorkspaceLockInfo> {
    try {
      await this.writeExclusive(lockPath, `${JSON.stringify(info)}\n`);
      return info;
    } catch (error) {
      if (isErrno(error, 'EEXIST')) {
        throw locked('Workspace lock was acquired concurrently');
      }
      throw error;
    }
  }

  private createWorkspaceLock(
    lockPath: string,
    info: WorkspaceLockInfo,
    initiallyHeldGuard?: ProtocolGuard
  ): WorkspaceLock {
    let heldGuard = initiallyHeldGuard;
    let released = false;
    return {
      info,
      release: async (): Promise<void> => {
        if (released) return;
        const guard = heldGuard ?? await this.acquireProtocolGuard(path.dirname(lockPath));
        heldGuard = undefined;
        let completed = false;
        let primaryError: unknown;
        try {
          const observed = await this.captureSnapshot(lockPath, 'workspace lock');
          if (observed === undefined) {
            completed = true;
          } else {
            const existing = this.parseLockSnapshot(observed);
            if (existing.token !== info.token) {
              completed = true;
            } else {
              const current = await this.captureSnapshot(lockPath, 'workspace lock');
              if (current === undefined || !sameSnapshot(observed, current)) {
                completed = true;
              } else {
                await this.fs.unlink(lockPath);
                completed = true;
              }
            }
          }
        } catch (error) {
          if (error instanceof AiWorkspaceError && error.code === 'LOCKED') {
            // A replacement observed during release is not ours to remove.
            completed = true;
          } else {
            primaryError = error;
          }
        }

        try {
          await guard.release();
        } catch (error) {
          this.retainedGuards.set(lockPath, guard);
          primaryError ??= error;
        }
        if (primaryError !== undefined) throw primaryError;
        released = completed;
      }
    };
  }

  private async acquireProtocolGuard(workspacePath: string): Promise<ProtocolGuard> {
    const guardPath = path.join(workspacePath, WORKSPACE_LOCK_GUARD_DIRECTORY);
    const lockPath = path.join(workspacePath, WORKSPACE_LOCK_FILE);
    const retained = this.retainedGuards.get(lockPath);
    if (retained !== undefined) {
      this.retainedGuards.delete(lockPath);
      return retained;
    }

    await this.cleanupGuardArtifacts(workspacePath);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const info: ProtocolGuardInfo = {
        version: 1,
        token: randomUUID(),
        processId: this.processId,
        startedAt: this.now().toISOString()
      };
      const preparedPath = path.join(
        workspacePath,
        `${WORKSPACE_LOCK_GUARD_PREPARED_PREFIX}${this.processId}.${info.token}`
      );
      const ownerPath = path.join(preparedPath, guardOwnerName(info.token));
      await this.fs.mkdir(preparedPath, { mode: 0o700 });
      ACTIVE_PREPARED_GUARDS.add(preparedPath);

      try {
        await this.writeExclusive(ownerPath, `${JSON.stringify(info)}\n`);
      } catch (error) {
        await this.cleanupOwnedGuardDirectory(preparedPath, info).catch(() => undefined);
        ACTIVE_PREPARED_GUARDS.delete(preparedPath);
        throw error;
      }

      let publicationError: unknown;
      try {
        await this.fs.rename(preparedPath, guardPath);
        ACTIVE_PREPARED_GUARDS.delete(preparedPath);
        ACTIVE_PROTOCOL_GUARDS.add(guardKey(guardPath, info.token));
        return this.protocolGuard(guardPath, info);
      } catch (error) {
        publicationError = error;
      }

      let publicationInspectionError: unknown;
      try {
        const published = await this.captureGuardDirectory(guardPath);
        if (published.kind === 'owned'
          && published.info.token === info.token
          && published.info.processId === info.processId
          && published.info.startedAt === info.startedAt) {
          ACTIVE_PREPARED_GUARDS.delete(preparedPath);
          await this.cleanupOwnedGuardDirectory(preparedPath, info).catch(() => undefined);
          ACTIVE_PROTOCOL_GUARDS.add(guardKey(guardPath, info.token));
          return this.protocolGuard(guardPath, info);
        }
      } catch (error) {
        publicationInspectionError = error;
      }

      ACTIVE_PREPARED_GUARDS.delete(preparedPath);
      await this.cleanupOwnedGuardDirectory(preparedPath, info).catch(() => undefined);
      if (publicationInspectionError !== undefined) throw publicationInspectionError;
      if (!await this.isGuardPublicationCollision(guardPath, publicationError)) {
        throw publicationError;
      }

      const observed = await this.captureGuardDirectory(guardPath);
      if (observed.kind === 'missing') continue;
      if (observed.kind === 'empty') {
        await this.removeEmptyDirectoryIfPresent(guardPath);
        continue;
      }
      if (ACTIVE_PROTOCOL_GUARDS.has(guardKey(guardPath, observed.info.token))
        || this.isProcessAlive(observed.info.processId)) {
        throw locked('Workspace lock protocol is busy');
      }
      await this.removeObservedGuardOwner(guardPath, observed);
    }
    throw locked('Could not acquire workspace lock protocol guard');
  }

  private protocolGuard(guardPath: string, info: ProtocolGuardInfo): ProtocolGuard {
    let released = false;
    return {
      info,
      release: async (): Promise<void> => {
        if (released) return;
        await this.cleanupOwnedGuardDirectory(guardPath, info);
        ACTIVE_PROTOCOL_GUARDS.delete(guardKey(guardPath, info.token));
        released = true;
      }
    };
  }

  private async captureGuardDirectory(guardPath: string): Promise<GuardDirectorySnapshot> {
    let stats: Stats;
    try {
      stats = await this.fs.lstat(guardPath);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return { kind: 'missing' };
      throw error;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new AiWorkspaceError(
        'RECOVERY_REQUIRED',
        'Invalid workspace lock guard',
        { path: guardPath }
      );
    }

    let entries: Dirent[];
    try {
      entries = await this.fs.readdir(guardPath, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return { kind: 'missing' };
      throw error;
    }
    if (entries.length === 0) return { kind: 'empty' };
    if (entries.length !== 1) {
      throw new AiWorkspaceError(
        'RECOVERY_REQUIRED',
        'Invalid workspace lock guard',
        { path: guardPath }
      );
    }
    const entry = entries[0];
    const match = /^owner\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/.exec(
      entry?.name ?? ''
    );
    if (entry === undefined || !entry.isFile() || match === null) {
      throw new AiWorkspaceError(
        'RECOVERY_REQUIRED',
        'Invalid workspace lock guard',
        { path: guardPath }
      );
    }
    const ownerPath = path.join(guardPath, entry.name);
    const snapshot = await this.captureSnapshot(ownerPath, 'workspace lock guard owner');
    if (snapshot === undefined) return { kind: 'empty' };
    const info = this.parseGuardSnapshot(snapshot);
    if (info.token !== match[1]) {
      throw new AiWorkspaceError(
        'RECOVERY_REQUIRED',
        'Invalid workspace lock guard',
        { path: guardPath }
      );
    }
    return { kind: 'owned', info, ownerPath, snapshot };
  }

  private async removeObservedGuardOwner(
    guardPath: string,
    observed: GuardOwnerSnapshot
  ): Promise<void> {
    const current = await this.captureSnapshot(
      path.join(guardPath, guardOwnerName(observed.info.token)),
      'workspace lock guard owner'
    );
    if (current !== undefined && sameSnapshot(observed.snapshot, current)) {
      try {
        await this.fs.unlink(observed.ownerPath);
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error;
      }
    }
    await this.removeEmptyDirectoryIfPresent(guardPath);
    ACTIVE_PROTOCOL_GUARDS.delete(guardKey(guardPath, observed.info.token));
  }

  private async cleanupOwnedGuardDirectory(
    guardPath: string,
    expected: ProtocolGuardInfo
  ): Promise<void> {
    const ownerPath = path.join(guardPath, guardOwnerName(expected.token));
    const observed = await this.captureSnapshot(ownerPath, 'workspace lock guard owner');
    if (observed !== undefined) {
      const info = this.parseGuardSnapshot(observed);
      if (info.token !== expected.token
        || info.processId !== expected.processId
        || info.startedAt !== expected.startedAt) {
        return;
      }
      const current = await this.captureSnapshot(ownerPath, 'workspace lock guard owner');
      if (current === undefined || !sameSnapshot(observed, current)) return;
      try {
        await this.fs.unlink(ownerPath);
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error;
      }
    }
    await this.removeEmptyDirectoryIfPresent(guardPath);
  }

  private async removeEmptyDirectoryIfPresent(directory: string): Promise<void> {
    try {
      await this.fs.rmdir(directory);
    } catch (error) {
      if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTEMPTY')) throw error;
    }
  }

  private async isGuardPublicationCollision(
    guardPath: string,
    error: unknown
  ): Promise<boolean> {
    if (isErrno(error, 'EEXIST') || isErrno(error, 'ENOTEMPTY')) return true;
    if (!isErrno(error, 'EPERM') && !isErrno(error, 'EACCES')) return false;
    try {
      await this.fs.lstat(guardPath);
      return true;
    } catch (statError) {
      if (isErrno(statError, 'ENOENT')) return false;
      throw statError;
    }
  }

  private async cleanupGuardArtifacts(workspacePath: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await this.fs.readdir(workspacePath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const artifactPath = path.join(workspacePath, entry.name);
      if (entry.name.startsWith(WORKSPACE_LOCK_GUARD_PREPARED_PREFIX)) {
        if (ACTIVE_PREPARED_GUARDS.has(artifactPath)) continue;
        const suffix = entry.name.slice(WORKSPACE_LOCK_GUARD_PREPARED_PREFIX.length);
        const match = /^(\d+)\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(
          suffix
        );
        if (match === null) continue;
        const processId = Number(match[1]);
        if (!Number.isSafeInteger(processId) || processId <= 0 || this.isProcessAlive(processId)) {
          continue;
        }
        await this.cleanupDeadPreparedArtifact(artifactPath, match[2] ?? '');
      } else if (entry.name.startsWith(WORKSPACE_LOCK_GUARD_RELEASED_PREFIX)) {
        await this.cleanupArtifactDirectory(artifactPath);
      }
    }
  }

  private async cleanupDeadPreparedArtifact(
    artifactPath: string,
    expectedToken: string
  ): Promise<void> {
    try {
      const observed = await this.capturePreparedArtifact(artifactPath, expectedToken);
      if (observed.kind === 'unknown') return;
      if (observed.kind === 'empty') {
        await this.removeEmptyDirectoryIfPresent(artifactPath);
        return;
      }
      const current = await this.capturePreparedArtifact(artifactPath, expectedToken);
      if (current.kind !== 'owner'
        || current.ownerPath !== observed.ownerPath
        || !sameSnapshot(observed.snapshot, current.snapshot)) {
        return;
      }
      try {
        await this.fs.unlink(observed.ownerPath);
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error;
      }
      await this.removeEmptyDirectoryIfPresent(artifactPath);
    } catch {
      // A changing or unknown crash artifact is preserved rather than widened
      // into recursive cleanup.
    }
  }

  private async capturePreparedArtifact(
    artifactPath: string,
    expectedToken: string
  ): Promise<PreparedArtifactSnapshot> {
    let entries: Dirent[];
    try {
      entries = await this.fs.readdir(artifactPath, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return { kind: 'empty' };
      throw error;
    }
    if (entries.length === 0) return { kind: 'empty' };
    if (entries.length !== 1) return { kind: 'unknown' };
    const entry = entries[0];
    if (entry === undefined
      || entry.name !== guardOwnerName(expectedToken)
      || !entry.isFile()) {
      return { kind: 'unknown' };
    }
    const ownerPath = path.join(artifactPath, entry.name);
    const snapshot = await this.captureSnapshot(ownerPath, 'workspace lock guard owner');
    if (snapshot === undefined) return { kind: 'unknown' };
    return { kind: 'owner', ownerPath, snapshot };
  }

  private async cleanupArtifactDirectory(
    artifactPath: string,
    expectedToken?: string
  ): Promise<void> {
    try {
      const observed = await this.captureGuardDirectory(artifactPath);
      if (observed.kind === 'missing') return;
      if (observed.kind === 'empty') {
        await this.removeEmptyDirectoryIfPresent(artifactPath);
        return;
      }
      if (expectedToken !== undefined && observed.info.token !== expectedToken) return;
      await this.removeObservedGuardOwner(artifactPath, observed);
    } catch {
      // Crash artifacts never block the canonical guard protocol. Unknown or
      // concurrently changing contents are deliberately preserved for review.
    }
  }

  private async releaseGuardPreservingPrimary(
    lockPath: string,
    guard: ProtocolGuard,
    primaryError: unknown
  ): Promise<never> {
    try {
      await guard.release();
    } catch {
      this.retainedGuards.set(lockPath, guard);
    }
    throw primaryError;
  }

  private async unlinkIfPresent(target: string): Promise<void> {
    try {
      await this.fs.unlink(target);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
  }
}
