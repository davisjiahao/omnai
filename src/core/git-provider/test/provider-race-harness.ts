import { createRequire } from 'node:module';
import {
  chmod,
  chown,
  copyFile,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from 'node:worker_threads';

export const expectedEnvironment = Object.freeze({
  GIT_ATTR_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_NO_LAZY_FETCH: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  HOME: '/nonexistent',
  LANG: 'C',
  LC_ALL: 'C',
  TZ: 'UTC',
  XDG_CONFIG_HOME: '/nonexistent',
} as const);

const buildIdentity = basename(process.cwd()).replace(/[^A-Za-z0-9._-]/gu, '_');
export const privateNativeRoot = join(tmpdir(), `omnai-verified-fd-provider-${buildIdentity}`);
export const privateAddonPath = join(privateNativeRoot, 'verified_fd_provider_test.node');
export const safeGitFixturePath = join(privateNativeRoot, 'safe-git');
export const maliciousGitFixturePath = join(privateNativeRoot, 'malicious-git');
export const fifoGitFixturePath = join(privateNativeRoot, 'fifo-git');
export const candidateRoot = join(privateNativeRoot, 'candidates');
export const localCandidatePath = join(candidateRoot, 'usr', 'local', 'bin', 'git');
export const systemCandidatePath = join(candidateRoot, 'usr', 'bin', 'git');
export const controlRoot = join(privateNativeRoot, 'control');

export type RawNativeProviderResult = Readonly<{
  candidatePath: string;
  realPath: string;
  bytesHash: string;
  stdout: Uint8Array;
}>;

export type RawNativeExecutionResult = Readonly<{
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}>;

export type RawNativeProvider = Readonly<{
  acquire: (...unexpected: unknown[]) => RawNativeProviderResult;
  execute: (input: Readonly<{ repositoryRoot: string; args: readonly string[] }>) => RawNativeExecutionResult;
}>;

export function loadPrivateNativeProvider(): RawNativeProvider {
  const require = createRequire(import.meta.url);
  return require(privateAddonPath) as RawNativeProvider;
}

export async function resetNativeFixture(): Promise<void> {
  await rm(candidateRoot, { recursive: true, force: true });
  await rm(controlRoot, { recursive: true, force: true });
  await mkdir(controlRoot, { recursive: true, mode: 0o700 });
}

export async function installSafeLocalCandidate(): Promise<void> {
  await installCandidate(safeGitFixturePath, localCandidatePath);
}

export async function installSafeSystemCandidate(): Promise<void> {
  await installCandidate(safeGitFixturePath, systemCandidatePath);
}

export async function installFifoLocalCandidate(): Promise<void> {
  await mkdir(dirname(localCandidatePath), { recursive: true, mode: 0o755 });
  await link(fifoGitFixturePath, localCandidatePath);
}

export async function replaceLocalCandidateWithMalicious(): Promise<void> {
  const retainedPath = join(privateNativeRoot, 'retained-safe-git');
  await rm(retainedPath, { force: true });
  await rename(localCandidatePath, retainedPath);
  await installCandidate(maliciousGitFixturePath, localCandidatePath);
}

export async function makeLocalCandidateGroupWritable(): Promise<void> {
  await chmod(localCandidatePath, 0o775);
}

export async function makeLocalCandidateWorldWritable(): Promise<void> {
  await chmod(localCandidatePath, 0o757);
}

export async function makeLocalCandidateNonRootOwned(): Promise<void> {
  try {
    await chown(localCandidatePath, 1, 1);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EINVAL') throw error;
    await setControl('non-root-chown-unavailable', code);
    await setControl('force-non-root-owner');
  }
}

export async function makeLocalCandidateDirectory(): Promise<void> {
  await mkdir(localCandidatePath, { recursive: true, mode: 0o755 });
}

export async function makeLocalCandidateSymlinkComponent(): Promise<void> {
  const actualLocal = join(candidateRoot, 'actual-local');
  await installCandidate(safeGitFixturePath, join(actualLocal, 'bin', 'git'));
  await mkdir(dirname(dirname(dirname(localCandidatePath))), { recursive: true });
  await symlink('../actual-local', dirname(dirname(localCandidatePath)));
}

export async function makeLocalCandidateMagicLinkComponent(): Promise<() => Promise<void>> {
  const actualLocal = join(candidateRoot, 'magic-local');
  await installCandidate(safeGitFixturePath, join(actualLocal, 'bin', 'git'));
  const handle = await open(actualLocal, 'r');
  await mkdir(dirname(dirname(dirname(localCandidatePath))), { recursive: true });
  await symlink(`/proc/self/fd/${handle.fd}`, dirname(dirname(localCandidatePath)));
  return async () => handle.close();
}

export async function setControl(name: string, value = '1'): Promise<void> {
  await mkdir(controlRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(controlRoot, name), value, { mode: 0o600 });
}

export async function readControl(name: string): Promise<string> {
  return readFile(join(controlRoot, name), 'utf8');
}

export async function waitForControl(name: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await readFile(join(controlRoot, name));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`native fixture did not create ${name}`);
}

export function executePrivateProviderInWorker(
  args: readonly string[],
): Promise<Readonly<{ ok: true; result: RawNativeExecutionResult } | { ok: false; code: string | null }>> {
  return runPrivateWorker({ kind: 'execute-private-provider', args: [...args] });
}

export function acquirePrivateProviderInWorker(): Promise<Readonly<{ ok: true } | { ok: false; code: string | null }>> {
  return runPrivateWorker({ kind: 'acquire-private-provider' });
}

function runPrivateWorker(
  data: Readonly<{ kind: 'acquire-private-provider' }>,
): Promise<Readonly<{ ok: true } | { ok: false; code: string | null }>>;
function runPrivateWorker(
  data: Readonly<{ kind: 'execute-private-provider'; args: readonly string[] }>,
): Promise<Readonly<{ ok: true; result: RawNativeExecutionResult } | { ok: false; code: string | null }>>;
function runPrivateWorker(
  data: Readonly<{ kind: string; args?: readonly string[] }>,
): Promise<Readonly<{ ok: true; result?: RawNativeExecutionResult } | { ok: false; code: string | null }>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: data });
    worker.once('message', (message) => {
      worker.unref();
      resolve(message);
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`provider worker exited ${code}`));
    });
  });
}

async function installCandidate(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o755 });
  await copyFile(source, target);
  await chmod(target, 0o755);
}

if (!isMainThread && workerData?.kind === 'execute-private-provider') {
  const native = loadPrivateNativeProvider();
  try {
    const result = native.execute({ repositoryRoot: '/', args: workerData.args as string[] });
    parentPort?.postMessage({ ok: true, result });
  } catch (error) {
    parentPort?.postMessage({
      ok: false,
      code: typeof (error as NodeJS.ErrnoException).code === 'string'
        ? (error as NodeJS.ErrnoException).code
        : null,
    });
  }
}

if (!isMainThread && workerData?.kind === 'acquire-private-provider') {
  const native = loadPrivateNativeProvider();
  try {
    native.acquire();
    parentPort?.postMessage({ ok: true });
  } catch (error) {
    parentPort?.postMessage({
      ok: false,
      code: typeof (error as NodeJS.ErrnoException).code === 'string'
        ? (error as NodeJS.ErrnoException).code
        : null,
    });
  }
}
