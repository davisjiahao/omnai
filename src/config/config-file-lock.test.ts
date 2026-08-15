import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigFileLock, withConfigLock } from './config-file-lock';

const roots: string[] = [];
const OLD_TOKEN = '11111111-1111-4111-8111-111111111111';
const NEW_TOKEN = '22222222-2222-4222-8222-222222222222';
const SUCCESSOR_TOKEN = '33333333-3333-4333-8333-333333333333';

afterEach(async () => Promise.all(
  roots.splice(0).map(root => rm(root, { recursive: true, force: true }))
));

async function temporaryLockPath(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ai-workspace-config-lock-'));
  roots.push(root);
  return path.join(root, '.config.yaml.lock');
}

async function writeOwner(
  lockPath: string,
  token: string,
  pid: number,
  startedAt: number
): Promise<void> {
  await mkdir(lockPath);
  await writeFile(
    path.join(lockPath, `owner.${token}.json`),
    `${JSON.stringify({ version: 1, token, pid, startedAt })}\n`,
    'utf8'
  );
}

describe('ConfigFileLock', () => {
  it('recovers a lock whose recorded owner process is dead', async () => {
    const lockPath = await temporaryLockPath();
    await writeOwner(lockPath, OLD_TOKEN, 101, 900);
    let now = 1_000;
    const lock = new ConfigFileLock(lockPath, {
      pid: 202,
      now: () => now,
      randomUUID: () => NEW_TOKEN,
      isProcessAlive: () => false,
      wait: async milliseconds => { now += milliseconds; },
      timeoutMs: 50,
      retryDelayMs: 5
    });

    const handle = await lock.acquire();
    expect(await readdir(lockPath)).toEqual([`owner.${NEW_TOKEN}.json`]);
    await handle.release();
    await expect(readdir(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers an empty lock directory left after owner-file removal', async () => {
    const lockPath = await temporaryLockPath();
    await mkdir(lockPath);
    let now = 1_000;
    const lock = new ConfigFileLock(lockPath, {
      pid: 202,
      now: () => now,
      randomUUID: () => NEW_TOKEN,
      wait: async milliseconds => { now += milliseconds; },
      timeoutMs: 10,
      retryDelayMs: 5
    });

    const handle = await lock.acquire();
    expect(await readdir(lockPath)).toEqual([`owner.${NEW_TOKEN}.json`]);
    await handle.release();
  });

  it('does not steal a lock from a live owner', async () => {
    const lockPath = await temporaryLockPath();
    await writeOwner(lockPath, OLD_TOKEN, 101, 900);
    let now = 1_000;
    const lock = new ConfigFileLock(lockPath, {
      pid: 202,
      now: () => now,
      randomUUID: () => NEW_TOKEN,
      isProcessAlive: pid => pid === 101,
      wait: async milliseconds => { now += milliseconds; },
      timeoutMs: 10,
      retryDelayMs: 5
    });

    await expect(lock.acquire()).rejects.toMatchObject({ code: 'CONFIG' });
    expect(JSON.parse(await readFile(path.join(lockPath, `owner.${OLD_TOKEN}.json`), 'utf8')))
      .toMatchObject({ token: OLD_TOKEN, pid: 101 });
  });

  it('never removes a successor lock when an old handle releases late', async () => {
    const lockPath = await temporaryLockPath();
    const lock = new ConfigFileLock(lockPath, {
      pid: 202,
      randomUUID: () => NEW_TOKEN
    });
    const handle = await lock.acquire();

    await rm(lockPath, { recursive: true });
    await writeOwner(lockPath, SUCCESSOR_TOKEN, 303, Date.now());
    await handle.release();

    expect(JSON.parse(
      await readFile(path.join(lockPath, `owner.${SUCCESSOR_TOKEN}.json`), 'utf8')
    )).toMatchObject({ token: SUCCESSOR_TOKEN, pid: 303 });
  });
});

describe('withConfigLock', () => {
  it('preserves the operation error when release also fails', async () => {
    const primary = new Error('primary failure');
    const release = new Error('release failure');
    const lock = {
      acquire: async () => ({ release: async () => { throw release; } })
    };

    await expect(withConfigLock(lock, async () => { throw primary; })).rejects.toBe(primary);
  });

  it('surfaces a release error after a successful operation', async () => {
    const release = new Error('release failure');
    const lock = {
      acquire: async () => ({ release: async () => { throw release; } })
    };

    await expect(withConfigLock(lock, async () => 'done')).rejects.toBe(release);
  });
});
