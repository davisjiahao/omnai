import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensureDir } from '../core/files.js';
import { executionRoot, worksetMutationLockPath } from './paths.js';

interface MutationLockOwner {
  token: string;
  pid: number;
  acquiredAt: string;
}

export interface MutationLockOptions {
  timeoutMs?: number;
  faults?: MutationLockFaults;
}

export type WorksetMutationLockOptions = MutationLockOptions;

export interface MutationLockFaults {
  afterDeadOwnerObserved?: () => void | Promise<void>;
  afterOwnerOpen?: () => void | Promise<void>;
  afterOwnerWrite?: () => void | Promise<void>;
  afterOwnerClose?: () => void | Promise<void>;
  afterOwnerPublished?: () => void | Promise<void>;
  afterOwnerUnlink?: () => void | Promise<void>;
  afterRelease?: () => void | Promise<void>;
}

export class WorksetMutationLockError extends Error {
  readonly code = 'WORKSET_MUTATION_LOCKED';

  constructor(readonly path: string) {
    super(`WORKSET_MUTATION_LOCKED: path=${path}`);
    this.name = 'WorksetMutationLockError';
  }
}

export class MutationLockError extends Error {
  readonly code = 'MUTATION_LOCKED';

  constructor(readonly path: string) {
    super(`MUTATION_LOCKED: path=${path}`);
    this.name = 'MutationLockError';
  }
}

export async function withMutationLockAtPath<T>(
  lockPath: string,
  action: () => Promise<T>,
  options: MutationLockOptions = {},
): Promise<T> {
  await ensureDir(dirname(lockPath));
  return withExplicitMutationLock(
    lockPath,
    action,
    options,
    () => new MutationLockError(lockPath),
    (cause) => new Error(`MUTATION_LOCK_PROTOCOL_UNAVAILABLE: path=${lockPath}`, { cause }),
  );
}

export async function withWorksetMutationLock<T>(
  home: string,
  worksetId: string,
  action: () => Promise<T>,
  options: WorksetMutationLockOptions = {},
): Promise<T> {
  const lockPath = worksetMutationLockPath(home, worksetId);
  await ensureDir(executionRoot(home, worksetId));
  return withExplicitMutationLock(
    lockPath,
    action,
    options,
    () => new WorksetMutationLockError(lockPath),
    (cause) => new Error(`WORKSET_MUTATION_LOCK_PROTOCOL_UNAVAILABLE: path=${lockPath}`, { cause }),
  );
}

async function withExplicitMutationLock<T>(
  lockPath: string,
  action: () => Promise<T>,
  options: MutationLockOptions,
  lockedError: () => Error,
  protocolError: (cause: unknown) => Error,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 1_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError(`INVALID_MUTATION_LOCK_TIMEOUT: timeoutMs=${timeoutMs}`);
  }

  const owner: MutationLockOwner = {
    token: randomUUID(),
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const status = await inspectAndRecoverLock(lockPath, options.faults);
    if (status === 'absent' && await tryPublishOwner(lockPath, owner, options.faults, protocolError)) break;
    if (status === 'recovered') continue;
    if (Date.now() >= deadline) throw lockedError();
    await delay(Math.min(10, Math.max(1, deadline - Date.now())));
  }

  let result: T | undefined;
  let actionError: unknown;
  let actionFailed = false;
  try {
    result = await action();
  } catch (error) {
    actionFailed = true;
    actionError = error;
  }

  let releaseError: unknown;
  let releaseFailed = false;
  try {
    await removeExactOwner(lockPath, owner, options.faults);
    await options.faults?.afterRelease?.();
  } catch (error) {
    releaseFailed = true;
    releaseError = error;
  }

  if (actionFailed) {
    if (releaseFailed) attachCleanupError(actionError, releaseError);
    throw actionError;
  }
  if (releaseFailed) throw releaseError;
  return result as T;
}

async function tryPublishOwner(
  lockPath: string,
  owner: MutationLockOwner,
  faults: MutationLockFaults | undefined,
  protocolError: (cause: unknown) => Error,
): Promise<boolean> {
  const stagePath = `${lockPath}.stage-${owner.token}`;
  const childName = ownerFileName(owner);
  await mkdir(stagePath, { mode: 0o700 });

  const handle = await openPreparedOwner(stagePath, childName);

  let preparationError: unknown;
  let preparationFailed = false;
  try {
    await faults?.afterOwnerOpen?.();
    await handle.writeFile(JSON.stringify(owner), 'utf8');
    await faults?.afterOwnerWrite?.();
    await handle.sync();
  } catch (error) {
    preparationFailed = true;
    preparationError = error;
  }
  try {
    await handle.close();
  } catch (error) {
    if (preparationFailed) attachCleanupError(preparationError, error);
    else {
      preparationFailed = true;
      preparationError = error;
    }
  }
  if (preparationFailed) {
    await throwAfterCleanup(preparationError, () => cleanupStage(stagePath, childName));
  }

  try {
    await faults?.afterOwnerClose?.();
  } catch (error) {
    await throwAfterCleanup(error, () => cleanupStage(stagePath, childName));
  }

  try {
    await rename(stagePath, lockPath);
  } catch (error) {
    const contention = isRenameContention(error) || await pathPresent(lockPath);
    if (contention) {
      await cleanupStage(stagePath, childName);
      return false;
    }
    await throwAfterCleanup(protocolError(error), () => cleanupStage(stagePath, childName));
  }

  try {
    await faults?.afterOwnerPublished?.();
  } catch (error) {
    await throwAfterCleanup(error, () => removeExactOwner(lockPath, owner));
  }
  return true;
}

async function inspectAndRecoverLock(
  lockPath: string,
  faults: MutationLockFaults | undefined,
): Promise<'absent' | 'occupied' | 'recovered'> {
  let metadata;
  try {
    metadata = await lstat(lockPath);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return 'absent';
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return 'occupied';

  let entries;
  try {
    entries = await readdir(lockPath, { withFileTypes: true });
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return 'recovered';
    throw error;
  }
  if (entries.length === 0) {
    return await removeEmptyCanonicalDirectory(lockPath) ? 'recovered' : 'occupied';
  }
  if (entries.length !== 1 || !entries[0]!.isFile()) return 'occupied';

  const childName = entries[0]!.name;
  const owner = await readOwnerChild(lockPath, childName);
  if (owner === 'missing') return 'recovered';
  if (owner === 'invalid' || ownerFileName(owner) !== childName) return 'occupied';

  try {
    process.kill(owner.pid, 0);
    return 'occupied';
  } catch (error) {
    if (!hasCode(error, 'ESRCH')) return 'occupied';
  }

  await faults?.afterDeadOwnerObserved?.();
  await removeExactOwner(lockPath, owner, faults);
  return 'recovered';
}

async function removeExactOwner(
  lockPath: string,
  owner: MutationLockOwner,
  faults?: MutationLockFaults,
): Promise<boolean> {
  try {
    await unlink(join(lockPath, ownerFileName(owner)));
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false;
    throw error;
  }

  let hookError: unknown;
  let hookFailed = false;
  try {
    await faults?.afterOwnerUnlink?.();
  } catch (error) {
    hookFailed = true;
    hookError = error;
  }

  let directoryError: unknown;
  let directoryFailed = false;
  try {
    await rmdir(lockPath);
  } catch (error) {
    if (!hasCode(error, 'ENOENT') && !hasCode(error, 'ENOTEMPTY') && !hasCode(error, 'EEXIST')) {
      if ((hasCode(error, 'EPERM') || hasCode(error, 'EACCES')) && await directoryIsNonEmpty(lockPath)) {
        // A new generation replaced the empty directory before this exact
        // owner-child unlink winner could remove the canonical path.
      } else {
        directoryFailed = true;
        directoryError = error;
      }
    }
  }

  if (hookFailed) {
    if (directoryFailed) attachCleanupError(hookError, directoryError);
    throw hookError;
  }
  if (directoryFailed) throw directoryError;
  return true;
}

async function removeEmptyCanonicalDirectory(lockPath: string): Promise<boolean> {
  try {
    await rmdir(lockPath);
    return true;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return true;
    if (hasCode(error, 'ENOTEMPTY') || hasCode(error, 'EEXIST')) return false;
    if ((hasCode(error, 'EPERM') || hasCode(error, 'EACCES')) && await directoryIsNonEmpty(lockPath)) {
      return false;
    }
    throw error;
  }
}

async function readOwnerChild(
  lockPath: string,
  childName: string,
): Promise<MutationLockOwner | 'missing' | 'invalid'> {
  let raw: string;
  try {
    raw = await readFile(join(lockPath, childName), 'utf8');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return 'missing';
    throw error;
  }

  try {
    const value = JSON.parse(raw) as Partial<MutationLockOwner>;
    const keys = typeof value === 'object' && value !== null ? Object.keys(value).sort() : [];
    if (keys.length !== 3 || keys[0] !== 'acquiredAt' || keys[1] !== 'pid' || keys[2] !== 'token' ||
        typeof value.token !== 'string' || value.token.length === 0 ||
        typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid <= 0 ||
        typeof value.acquiredAt !== 'string') return 'invalid';
    return { token: value.token, pid: value.pid, acquiredAt: value.acquiredAt };
  } catch {
    return 'invalid';
  }
}

async function cleanupStage(stagePath: string, childName: string): Promise<void> {
  let cleanupError: unknown;
  let cleanupFailed = false;
  try {
    await unlink(join(stagePath, childName));
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) {
      cleanupFailed = true;
      cleanupError = error;
    }
  }
  try {
    await rmdir(stagePath);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) {
      if (cleanupFailed) attachCleanupError(cleanupError, error);
      else {
        cleanupFailed = true;
        cleanupError = error;
      }
    }
  }
  if (cleanupFailed) throw cleanupError;
}

async function openPreparedOwner(
  stagePath: string,
  childName: string,
): Promise<Awaited<ReturnType<typeof open>>> {
  try {
    return await open(join(stagePath, childName), 'wx', 0o600);
  } catch (error) {
    return throwAfterCleanup(error, () => cleanupStage(stagePath, childName));
  }
}

async function throwAfterCleanup(primary: unknown, cleanup: () => Promise<unknown>): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupError) {
    attachCleanupError(primary, cleanupError);
  }
  throw primary;
}

async function pathPresent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false;
    throw error;
  }
}

async function directoryIsNonEmpty(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length > 0;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false;
    throw error;
  }
}

function ownerFileName(owner: MutationLockOwner): string {
  return `owner-${owner.token}-${owner.pid}.json`;
}

function isRenameContention(error: unknown): boolean {
  return hasCode(error, 'EEXIST') || hasCode(error, 'ENOTEMPTY') ||
    hasCode(error, 'EPERM') || hasCode(error, 'EACCES');
}

function attachCleanupError(primary: unknown, cleanup: unknown): void {
  if ((typeof primary !== 'object' && typeof primary !== 'function') || primary === null) return;
  try {
    Object.defineProperty(primary, 'cleanupError', { value: cleanup, configurable: true });
  } catch {
    // The primary error still takes precedence when it is not extensible.
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
