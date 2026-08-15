import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { AiWorkspaceError } from '../domain/errors';

const OWNER_FILE = /^owner\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i;
const activeTokens = new Set<string>();

interface LockOwner {
  version: 1;
  token: string;
  pid: number;
  startedAt: number;
}

export interface ConfigLockHandle {
  release(): Promise<void>;
}

export interface ConfigLockAcquirer {
  acquire(): Promise<ConfigLockHandle>;
}

export interface ConfigFileLockOptions {
  pid?: number;
  now?: () => number;
  randomUUID?: () => string;
  isProcessAlive?: (pid: number) => boolean;
  wait?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  retryDelayMs?: number;
}

interface ConfigFileLockRuntime {
  pid: number;
  now: () => number;
  randomUUID: () => string;
  isProcessAlive: (pid: number) => boolean;
  wait: (milliseconds: number) => Promise<void>;
  timeoutMs: number;
  retryDelayMs: number;
}

export class ConfigFileLock implements ConfigLockAcquirer {
  private readonly runtime: ConfigFileLockRuntime;

  constructor(
    private readonly lockPath: string,
    options: ConfigFileLockOptions = {}
  ) {
    this.runtime = {
      pid: options.pid ?? process.pid,
      now: options.now ?? Date.now,
      randomUUID: options.randomUUID ?? randomUUID,
      isProcessAlive: options.isProcessAlive ?? isProcessAlive,
      wait: options.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))),
      timeoutMs: options.timeoutMs ?? 5_000,
      retryDelayMs: options.retryDelayMs ?? 10
    };
  }

  async acquire(): Promise<ConfigLockHandle> {
    const deadline = this.runtime.now() + this.runtime.timeoutMs;
    const token = this.runtime.randomUUID();
    const owner: LockOwner = {
      version: 1,
      token,
      pid: this.runtime.pid,
      startedAt: this.runtime.now()
    };
    const preparedPath = `${this.lockPath}.prepared.${this.runtime.pid}.${token}`;

    while (true) {
      await this.prepare(preparedPath, owner);
      try {
        await rename(preparedPath, this.lockPath);
        activeTokens.add(token);
        return this.createHandle(owner);
      } catch (error) {
        const lockContention = hasAnyCode(error, ['EEXIST', 'ENOTEMPTY'])
          || (process.platform === 'win32' && hasCode(error, 'EPERM'))
          || await pathExists(this.lockPath);
        let cleanupError: unknown;
        try {
          await rm(preparedPath, { recursive: true, force: true });
        } catch (cleanupFailure) {
          cleanupError = cleanupFailure;
        }
        if (!lockContention) {
          throw error;
        }
        if (cleanupError !== undefined) {
          throw cleanupError;
        }
      }

      const current = await this.readOwner();
      if (current !== undefined && this.isStale(current)) {
        await this.removeOwner(current);
        continue;
      }
      if (current === undefined && await this.removeEmptyLockDirectory()) {
        continue;
      }

      if (this.runtime.now() >= deadline) {
        throw new AiWorkspaceError(
          'CONFIG',
          `Timed out waiting for configuration lock at ${this.lockPath}`,
          { lockPath: this.lockPath }
        );
      }
      await this.runtime.wait(this.runtime.retryDelayMs);
    }
  }

  private async prepare(preparedPath: string, owner: LockOwner): Promise<void> {
    let primaryError: unknown;
    try {
      await mkdir(preparedPath, { mode: 0o700 });
      await writeCompleteFile(
        path.join(preparedPath, ownerFileName(owner.token)),
        `${JSON.stringify(owner)}\n`
      );
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (primaryError !== undefined) {
        await rm(preparedPath, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private async readOwner(): Promise<LockOwner | undefined> {
    let entries: string[];
    try {
      entries = await readdir(this.lockPath);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return undefined;
      throw error;
    }
    if (entries.length !== 1) return undefined;
    const name = entries[0];
    if (name === undefined) return undefined;
    const match = OWNER_FILE.exec(name);
    if (match === null) return undefined;
    const token = match[1];
    if (token === undefined) return undefined;

    let source: string;
    try {
      source = await readFile(path.join(this.lockPath, name), 'utf8');
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return undefined;
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(source);
      if (!isLockOwner(parsed) || parsed.token !== token) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private isStale(owner: LockOwner): boolean {
    if (owner.pid === this.runtime.pid) {
      return !activeTokens.has(owner.token);
    }
    return !this.runtime.isProcessAlive(owner.pid);
  }

  private async removeOwner(owner: LockOwner): Promise<boolean> {
    try {
      await unlink(path.join(this.lockPath, ownerFileName(owner.token)));
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return false;
      throw error;
    }

    try {
      await rmdir(this.lockPath);
    } catch (error) {
      if (!hasAnyCode(error, ['ENOENT', 'ENOTEMPTY', 'EEXIST'])) throw error;
    }
    return true;
  }

  private async removeEmptyLockDirectory(): Promise<boolean> {
    try {
      await rmdir(this.lockPath);
      return true;
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return true;
      if (hasAnyCode(error, ['ENOTEMPTY', 'EEXIST'])) return false;
      throw error;
    }
  }

  private createHandle(owner: LockOwner): ConfigLockHandle {
    let released = false;
    return {
      release: async (): Promise<void> => {
        if (released) return;
        activeTokens.delete(owner.token);
        try {
          await unlink(path.join(this.lockPath, ownerFileName(owner.token)));
        } catch (error) {
          if (hasCode(error, 'ENOENT')) {
            released = true;
            return;
          }
          throw error;
        }

        try {
          await rmdir(this.lockPath);
        } catch (error) {
          if (!hasAnyCode(error, ['ENOENT', 'ENOTEMPTY', 'EEXIST'])) throw error;
        }
        released = true;
      }
    };
  }
}

export async function withConfigLock<T>(
  lock: ConfigLockAcquirer,
  operation: () => Promise<T>
): Promise<T> {
  const handle = await lock.acquire();
  let operationFailed = false;
  try {
    return await operation();
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      await handle.release();
    } catch (error) {
      if (!operationFailed) throw error;
    }
  }
}

function ownerFileName(token: string): string {
  return `owner.${token}.json`;
}

async function writeCompleteFile(targetPath: string, contents: string): Promise<void> {
  const handle = await open(targetPath, 'wx', 0o600);
  let writeFailed = false;
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } catch (error) {
    writeFailed = true;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      if (!writeFailed) throw error;
    }
  }
}

function isLockOwner(value: unknown): value is LockOwner {
  if (typeof value !== 'object' || value === null) return false;
  const owner = value as Partial<LockOwner>;
  return owner.version === 1
    && typeof owner.token === 'string'
    && OWNER_FILE.test(ownerFileName(owner.token))
    && Number.isSafeInteger(owner.pid)
    && (owner.pid ?? 0) > 0
    && Number.isFinite(owner.startedAt)
    && (owner.startedAt ?? 0) >= 0;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, 'ESRCH');
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath);
    return true;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false;
    throw error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === code;
}

function hasAnyCode(error: unknown, codes: readonly string[]): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
    && codes.includes(error.code);
}
