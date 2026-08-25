import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensureDir } from './files.js';
import { changeMutationLockPath } from './paths.js';
import type { ChangeRef } from './store.js';

interface ChangeMutationLockOwner {
  token: string;
  pid: number;
  acquiredAt: string;
}

const LOCK_TIMEOUT_MS = 10_000;

/** @internal Serializes every structured mutation for one Change across processes. */
export async function withChangeMutationLock<T>(
  repoRoot: string,
  change: ChangeRef,
  action: () => Promise<T>,
): Promise<T> {
  const lockPath = changeMutationLockPath(repoRoot, change.directoryName);
  await ensureDir(dirname(lockPath));
  const owner: ChangeMutationLockOwner = {
    token: randomUUID(),
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    const status = await inspectAndRecoverLock(lockPath);
    if (status === 'absent' && await tryPublishOwner(lockPath, owner)) break;
    if (status === 'recovered') continue;
    if (Date.now() >= deadline) throw new Error(`CHANGE_MUTATION_LOCKED: path=${lockPath}`);
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
    await removeExactOwner(lockPath, owner);
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

async function tryPublishOwner(lockPath: string, owner: ChangeMutationLockOwner): Promise<boolean> {
  const stagePath = `${lockPath}.stage-${owner.token}`;
  const childName = ownerFileName(owner);
  await mkdir(stagePath, { mode: 0o700 });
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(join(stagePath, childName), 'wx', 0o600);
  } catch (error) {
    await cleanupStage(stagePath, childName);
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify(owner), 'utf8');
    await handle.sync();
  } catch (error) {
    try {
      await handle.close();
    } catch (cleanupError) {
      attachCleanupError(error, cleanupError);
    }
    await cleanupAfterError(error, () => cleanupStage(stagePath, childName));
  }
  try {
    await handle.close();
  } catch (error) {
    await cleanupAfterError(error, () => cleanupStage(stagePath, childName));
  }

  try {
    await rename(stagePath, lockPath);
    return true;
  } catch (error) {
    if (isContention(error) || await pathPresent(lockPath)) {
      await cleanupStage(stagePath, childName);
      return false;
    }
    return cleanupAfterError(error, () => cleanupStage(stagePath, childName));
  }
}

async function inspectAndRecoverLock(lockPath: string): Promise<'absent' | 'occupied' | 'recovered'> {
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
  if (entries.length === 0) return await removeEmptyDirectory(lockPath) ? 'recovered' : 'occupied';
  if (entries.length !== 1 || !entries[0]!.isFile()) return 'occupied';

  const childName = entries[0]!.name;
  const owner = await readOwner(lockPath, childName);
  if (owner === 'missing') return 'recovered';
  if (owner === 'invalid' || ownerFileName(owner) !== childName) return 'occupied';
  try {
    process.kill(owner.pid, 0);
    return 'occupied';
  } catch (error) {
    if (!hasCode(error, 'ESRCH')) return 'occupied';
  }
  await removeExactOwner(lockPath, owner);
  return 'recovered';
}

async function removeExactOwner(lockPath: string, owner: ChangeMutationLockOwner): Promise<boolean> {
  try {
    await unlink(join(lockPath, ownerFileName(owner)));
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false;
    throw error;
  }
  try {
    await rmdir(lockPath);
  } catch (error) {
    if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTEMPTY') || hasCode(error, 'EEXIST')) return true;
    if ((hasCode(error, 'EPERM') || hasCode(error, 'EACCES')) && await directoryIsNonEmpty(lockPath)) return true;
    throw error;
  }
  return true;
}

async function removeEmptyDirectory(lockPath: string): Promise<boolean> {
  try {
    await rmdir(lockPath);
    return true;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return true;
    if (hasCode(error, 'ENOTEMPTY') || hasCode(error, 'EEXIST')) return false;
    if ((hasCode(error, 'EPERM') || hasCode(error, 'EACCES')) && await directoryIsNonEmpty(lockPath)) return false;
    throw error;
  }
}

async function readOwner(
  lockPath: string,
  childName: string,
): Promise<ChangeMutationLockOwner | 'missing' | 'invalid'> {
  let raw: string;
  try {
    raw = await readFile(join(lockPath, childName), 'utf8');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return 'missing';
    throw error;
  }
  try {
    const value = JSON.parse(raw) as Partial<ChangeMutationLockOwner>;
    const keys = typeof value === 'object' && value !== null ? Object.keys(value).sort() : [];
    if (
      keys.length !== 3 || keys[0] !== 'acquiredAt' || keys[1] !== 'pid' || keys[2] !== 'token' ||
      typeof value.token !== 'string' || value.token.length === 0 ||
      typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid <= 0 ||
      typeof value.acquiredAt !== 'string'
    ) return 'invalid';
    return { token: value.token, pid: value.pid, acquiredAt: value.acquiredAt };
  } catch {
    return 'invalid';
  }
}

async function cleanupStage(stagePath: string, childName: string): Promise<void> {
  try {
    await unlink(join(stagePath, childName));
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
  try {
    await rmdir(stagePath);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
}

async function cleanupAfterError(error: unknown, cleanup: () => Promise<void>): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupError) {
    attachCleanupError(error, cleanupError);
  }
  throw error;
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

function ownerFileName(owner: ChangeMutationLockOwner): string {
  return `owner-${owner.token}-${owner.pid}.json`;
}

function isContention(error: unknown): boolean {
  return hasCode(error, 'EEXIST') || hasCode(error, 'ENOTEMPTY') || hasCode(error, 'EPERM') || hasCode(error, 'EACCES');
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function attachCleanupError(primary: unknown, cleanup: unknown): void {
  if ((typeof primary !== 'object' && typeof primary !== 'function') || primary === null) return;
  try {
    Object.defineProperty(primary, 'cleanupError', { value: cleanup, configurable: true });
  } catch {
    // The primary error remains authoritative when it cannot carry cleanup detail.
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
