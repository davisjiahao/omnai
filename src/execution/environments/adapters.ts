import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { link, open, readFile, readdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { ensureDir, pathExists } from '../../core/files.js';
import { redactSecrets } from '../agents/policy.js';
import { canonicalJson, hashObject } from '../hashing.js';
import { withMutationLockAtPath } from '../mutation-lock.js';
import {
  createComposeEnvironmentAdapter,
  createProductionComposeEnvironmentAdapter,
  type ComposeRuntime,
  type ProductionComposeRuntimeOptions,
} from './compose-adapter.js';
import {
  createProductionCommandsEnvironmentAdapter,
  type EnvironmentCommandResolver,
  type ProductionCommandsEnvironmentAdapterOptions,
} from './commands-adapter.js';
import {
  createProductionExternalEnvironmentAdapter,
  type ExternalEnvironmentAdapterOptions,
} from './external-adapter.js';
import {
  integrationEnvironmentInputSchema,
  integrationEnvironmentProfileSchema,
  type ContentHash,
  type EnvironmentStepName,
  type IntegrationEnvironmentInput,
  type IntegrationEnvironmentProfile,
} from '../types.js';
/*
 * Keep the runtime boundary strict: callers may construct the context object in
 * memory, so schema-valid objects still need their cross-object relationships
 * checked before any adapter is allowed to inspect or mutate infrastructure.
 */
export function validateEnvironmentAdapterContext(
  context: EnvironmentAdapterContext,
  expectedDriver?: EnvironmentDriver,
): void {
  let profile: IntegrationEnvironmentProfile;
  let input: IntegrationEnvironmentInput;
  try {
    profile = integrationEnvironmentProfileSchema.parse(context.profile);
    input = integrationEnvironmentInputSchema.parse(context.integrationInput);
  } catch (error) {
    throw new Error('ENVIRONMENT_CONTEXT_SCHEMA_INVALID', { cause: error });
  }
  if (expectedDriver !== undefined && profile.driver !== expectedDriver) {
    throw new Error(`ENVIRONMENT_CONTEXT_DRIVER_MISMATCH: expected ${expectedDriver}, received ${profile.driver}`);
  }
  if (input.profile.id !== profile.id || input.profile.contentHash !== profile.contentHash) {
    throw new Error('ENVIRONMENT_CONTEXT_PROFILE_MISMATCH');
  }
  if (input.definitionDigest !== profile.definitionContentHash) {
    throw new Error('ENVIRONMENT_CONTEXT_DEFINITION_DIGEST_MISMATCH');
  }
  const inputProjects = input.projects.map((project) => project.project);
  if (canonicalJson(inputProjects) !== canonicalJson(profile.requiredProjects)) {
    throw new Error('ENVIRONMENT_CONTEXT_PROJECTS_MISMATCH');
  }
  const referenceNames = [...new Set(Object.values(profile.envRefs))].sort();
  if (canonicalJson(input.environmentReferenceNames) !== canonicalJson(referenceNames)) {
    throw new Error('ENVIRONMENT_CONTEXT_ENVIRONMENT_REFERENCES_MISMATCH');
  }
  if (!/^WKS-\d{4}$/u.test(context.worksetId) || !/^IER-\d{4}$/u.test(context.environmentRunId)) {
    throw new Error('ENVIRONMENT_CONTEXT_ID_INVALID');
  }
}

export type EnvironmentDriver = IntegrationEnvironmentProfile['driver'];
export type EnvironmentEvidenceMode = 'AUTHORITATIVE' | 'DIAGNOSTIC_ONLY';

export interface ArgvRunRequest {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly shell: false;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly outputLimit: number;
  readonly network: 'ALLOW' | 'DENY';
  readonly ownerRunId: string;
  readonly sandboxProofId: string | undefined;
  readonly stdin?: string;
}

export interface ArgvRunResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly output: string;
  readonly truncated: boolean;
  readonly descendants: readonly number[];
  readonly processContainer?: ArgvProcessContainerEvidence;
}

export interface ArgvProcessContainerEvidence {
  readonly kind: 'CGROUP' | 'PID_NAMESPACE' | 'WINDOWS_JOB' | 'SANDBOX_SERVICE';
  readonly id: string;
  readonly emptyAfterExit: true;
}

export type ArgvProcessContainmentProbe =
  | {
      readonly status: 'PROVEN';
      readonly kind: ArgvProcessContainerEvidence['kind'];
      readonly proofId: string;
    }
  | {
      readonly status: 'UNPROVEN';
      readonly code: string;
    };

export interface ArgvProcessTreeRunner {
  probeProcessContainment(): Promise<ArgvProcessContainmentProbe>;
  run(request: ArgvRunRequest, signal?: AbortSignal): Promise<ArgvRunResult>;
}

export interface ArgvProcessTreeRunnerOptions {
  readonly terminationGraceMs?: number;
}

export interface ProcessTreeTerminationError extends Error {
  readonly ownerRunId: string;
  readonly descendants: readonly number[];
}

export function createArgvProcessTreeRunner(
  options: ArgvProcessTreeRunnerOptions = {},
): ArgvProcessTreeRunner {
  const terminationGraceMs = options.terminationGraceMs ?? 1_000;
  if (!Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 0 || terminationGraceMs > 60_000) {
    throw new Error('PROCESS_TREE_TERMINATION_GRACE_INVALID');
  }
  return {
    async probeProcessContainment() {
      return {
        status: 'UNPROVEN' as const,
        code: 'PROCESS_CONTAINER_UNAVAILABLE',
      };
    },
    run: (request, signal) => runArgvProcessTree(request, signal, terminationGraceMs),
  };
}

type ProcessExit = {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
};

type ProcessWinner =
  | { readonly kind: 'EXIT'; readonly exit: ProcessExit }
  | { readonly kind: 'ABORT' }
  | { readonly kind: 'TIMEOUT' };

async function runArgvProcessTree(
  request: ArgvRunRequest,
  signal: AbortSignal | undefined,
  terminationGraceMs: number,
): Promise<ArgvRunResult> {
  validateArgvRunRequest(request);
  if (abortRequested(signal)) throw terminationError('ABORT', request.ownerRunId, []);
  const secretValues = Object.values(request.environment);
  let child;
  try {
    child = spawn(request.executable, [...request.argv], {
      cwd: request.cwd,
      env: safeChildEnvironment(request.environment),
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    throw runnerError(error, secretValues);
  }
  const internalOutputLimit = request.outputLimit +
    Math.max(1_024, ...secretValues.map((value) => Buffer.byteLength(value) * 2));
  let output: Buffer = Buffer.alloc(0);
  let rawTruncated = false;
  const append = (chunk: Buffer | string): void => {
    const combined = Buffer.concat([output, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    if (combined.byteLength > internalOutputLimit) {
      rawTruncated = true;
      output = utf8Tail(combined, internalOutputLimit);
    } else {
      output = combined;
    }
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);

  let settleExit: ((exit: ProcessExit) => void) | undefined;
  const exit = new Promise<ProcessExit>((resolveExit) => {
    settleExit = resolveExit;
  });
  let exitSettled = false;
  const settle = (value: ProcessExit): void => {
    if (exitSettled) return;
    exitSettled = true;
    settleExit?.(value);
  };
  child.once('exit', (exitCode, childSignal) => settle({ exitCode, signal: childSignal }));
  child.once('error', (error) => settle({ exitCode: null, signal: null, error }));
  const closed = new Promise<void>((resolveClose) => child.once('close', () => resolveClose()));
  child.stdin?.once('error', (error) => {
    if (!(error instanceof Error && 'code' in error && error.code === 'EPIPE')) {
      settle({ exitCode: null, signal: null, error });
    }
  });
  try {
    child.stdin?.end(request.stdin ?? '');
  } catch (error) {
    settle({ exitCode: null, signal: null, error: error instanceof Error ? error : new Error(String(error)) });
  }

  const pid = child.pid;
  const processTree = pid === undefined ? undefined : captureProcessTreeIdentity(pid);
  const trackedDescendants = new Map<number, TrackedLinuxProcess>();
  const sampleDescendants = (): void => {
    if (processTree === undefined) return;
    for (const descendant of captureOwnedDescendants(processTree)) {
      trackedDescendants.set(descendant.hostPid, descendant);
    }
  };
  sampleDescendants();
  const descendantMonitor = processTree?.linux === undefined
    ? undefined
    : setInterval(sampleDescendants, 10);
  descendantMonitor?.unref();

  let notifyAbort: (() => void) | undefined;
  const abort = new Promise<ProcessWinner>((resolveAbort) => {
    notifyAbort = () => resolveAbort({ kind: 'ABORT' });
    signal?.addEventListener('abort', notifyAbort, { once: true });
  });
  if (abortRequested(signal)) notifyAbort?.();
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<ProcessWinner>((resolveTimeout) => {
    timeout = setTimeout(() => resolveTimeout({ kind: 'TIMEOUT' }), request.timeoutMs);
  });
  timeout?.unref();

  try {
    const winner = await Promise.race<ProcessWinner>([
      exit.then((result) => ({ kind: 'EXIT', exit: result })),
      abort,
      timedOut,
    ]);
    if (winner.kind === 'EXIT') {
      if (winner.exit.error !== undefined) throw runnerError(winner.exit.error, secretValues);
      sampleDescendants();
      const groupDescendants = processTree === undefined ? [] : await ownedProcessGroupMembers(processTree);
      const descendants = sortedUniqueNumbers([
        ...groupDescendants,
        ...[...trackedDescendants.values()].map((descendant) => descendant.namespacePid),
      ]);
      if (processTree !== undefined && (groupDescendants.length > 0 || processGroupAlive(processTree.pid))) {
        await terminateProcessTree(processTree, exit, terminationGraceMs);
      }
      await terminateTrackedProcesses([...trackedDescendants.values()], terminationGraceMs);
      await requireChildPipeClose(closed, Math.max(1_000, terminationGraceMs));
      const bounded = boundedRedactedOutput(output, request.outputLimit, secretValues);
      return {
        exitCode: winner.exit.exitCode,
        signal: winner.exit.signal,
        output: bounded.output,
        truncated: rawTruncated || bounded.truncated,
        descendants,
      };
    }

    sampleDescendants();
    const descendants = sortedUniqueNumbers([
      ...(processTree === undefined ? [] : await ownedDescendants(processTree)),
      ...[...trackedDescendants.values()].map((descendant) => descendant.namespacePid),
    ]);
    if (processTree !== undefined) await terminateProcessTree(processTree, exit, terminationGraceMs);
    await terminateTrackedProcesses([...trackedDescendants.values()], terminationGraceMs);
    await requireChildPipeClose(closed, Math.max(1_000, terminationGraceMs));
    throw terminationError(winner.kind, request.ownerRunId, descendants);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (notifyAbort !== undefined) signal?.removeEventListener('abort', notifyAbort);
    if (descendantMonitor !== undefined) clearInterval(descendantMonitor);
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.stdin?.destroy();
  }
}

function validateArgvRunRequest(request: ArgvRunRequest): void {
  if (request.shell !== false) throw new Error('ARGV_RUNNER_SHELL_FORBIDDEN');
  if (request.network === 'DENY') {
    throw new Error('ARGV_RUNNER_NETWORK_DENY_UNENFORCED');
  }
  if (request.executable.length === 0 || request.executable.includes('\0')) {
    throw new Error('ARGV_RUNNER_EXECUTABLE_INVALID');
  }
  if (request.argv.some((argument) => argument.includes('\0'))) throw new Error('ARGV_RUNNER_ARGUMENT_INVALID');
  if (request.stdin?.includes('\0') === true) throw new Error('ARGV_RUNNER_STDIN_INVALID');
  if (!isAbsolute(request.cwd)) throw new Error('ARGV_RUNNER_CWD_ABSOLUTE_REQUIRED');
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
    throw new Error('ARGV_RUNNER_TIMEOUT_INVALID');
  }
  if (!Number.isSafeInteger(request.outputLimit) || request.outputLimit <= 0) {
    throw new Error('ARGV_RUNNER_OUTPUT_LIMIT_INVALID');
  }
  if (!/^IER-\d{4}$/u.test(request.ownerRunId)) throw new Error('ARGV_RUNNER_OWNER_RUN_ID_INVALID');
  for (const [name, value] of Object.entries(request.environment)) {
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(name) || value.includes('\0')) {
      throw new Error(`ARGV_RUNNER_ENVIRONMENT_INVALID: ${name}`);
    }
  }
}

function safeChildEnvironment(values: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  for (const [name, value] of Object.entries(values)) {
    if (Object.prototype.hasOwnProperty.call(environment, name)) {
      throw new Error(`ARGV_RUNNER_ENVIRONMENT_RESERVED: ${name}`);
    }
    environment[name] = value;
  }
  return environment;
}

interface ProcessTreeIdentity {
  readonly pid: number;
  readonly linux?: {
    readonly hostLeaderPid: number;
    readonly hostProcessGroupId: number;
    readonly pidNamespace: string;
  };
}

interface TrackedLinuxProcess {
  readonly hostPid: number;
  readonly namespacePid: number;
  readonly pidNamespace: string;
  readonly startTime: string;
}

function captureProcessTreeIdentity(pid: number): ProcessTreeIdentity {
  if (process.platform !== 'linux') return { pid };
  try {
    const pidNamespace = readlinkSync('/proc/self/ns/pid');
    const hostLeaderPid = findHostPid(pid, pidNamespace);
    if (hostLeaderPid === undefined) return { pid };
    const stat = readHostProcessStat(hostLeaderPid);
    if (stat === undefined) return { pid };
    return {
      pid,
      linux: {
        hostLeaderPid,
        hostProcessGroupId: stat.processGroupId,
        pidNamespace,
      },
    };
  } catch {
    return { pid };
  }
}

async function terminateProcessTree(
  identity: ProcessTreeIdentity,
  exit: Promise<ProcessExit>,
  graceMs: number,
): Promise<void> {
  if (process.platform === 'win32') {
    await taskkill(identity.pid, false);
    await Promise.race([exit, delay(graceMs)]);
    await taskkill(identity.pid, true);
  } else {
    signalProcessGroup(identity.pid, 'SIGTERM');
    await Promise.race([
      waitForProcessGroupExit(identity, graceMs),
      exit.then(() => delay(graceMs)),
    ]);
    if (await processGroupHasLiveMembers(identity)) signalProcessGroup(identity.pid, 'SIGKILL');
  }
  if (process.platform === 'win32') {
    await Promise.race([exit, delay(Math.max(1_000, graceMs))]);
    return;
  }
  await waitForProcessGroupExit(identity, Math.max(1_000, graceMs));
  if (await processGroupHasLiveMembers(identity)) {
    signalProcessGroup(identity.pid, 'SIGKILL');
    throw new Error(`PROCESS_TREE_TERMINATION_FAILED: ${String(identity.pid)}`);
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    return false;
  }
}

async function taskkill(pid: number, force: boolean): Promise<void> {
  await new Promise<void>((resolveTaskkill) => {
    const args = ['/pid', String(pid), '/t', ...(force ? ['/f'] : [])];
    const killer = spawn('taskkill', args, { shell: false, stdio: 'ignore', windowsHide: true });
    killer.once('error', () => resolveTaskkill());
    killer.once('exit', () => resolveTaskkill());
  });
}

async function ownedDescendants(identity: ProcessTreeIdentity): Promise<number[]> {
  return captureOwnedDescendants(identity)
    .map((descendant) => descendant.namespacePid)
    .sort((left, right) => left - right);
}

function captureOwnedDescendants(identity: ProcessTreeIdentity): TrackedLinuxProcess[] {
  if (identity.linux === undefined) return [];
  const descendants = new Map<number, TrackedLinuxProcess>();
  const candidates = safeProcEntries().map(Number).flatMap((hostPid) => {
    const stat = readHostProcessStat(hostPid);
    const namespacePid = readNamespacePid(hostPid, identity.linux!.pidNamespace);
    return stat === undefined || namespacePid === undefined
      ? []
      : [{ hostPid, namespacePid, stat }];
  });
  const ownedHostPids = new Set([identity.linux.hostLeaderPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of candidates) {
      if (ownedHostPids.has(candidate.hostPid) || !ownedHostPids.has(candidate.stat.parentPid)) continue;
      ownedHostPids.add(candidate.hostPid);
      changed = true;
      if (candidate.namespacePid !== identity.pid) {
        descendants.set(candidate.hostPid, {
          hostPid: candidate.hostPid,
          namespacePid: candidate.namespacePid,
          pidNamespace: identity.linux.pidNamespace,
          startTime: candidate.stat.startTime,
        });
      }
    }
  }
  return [...descendants.values()].sort((left, right) => left.namespacePid - right.namespacePid);
}

async function terminateTrackedProcesses(
  processes: readonly TrackedLinuxProcess[],
  graceMs: number,
): Promise<void> {
  if (process.platform !== 'linux' || processes.length === 0) return;
  for (const tracked of processes) signalTrackedProcess(tracked, 'SIGTERM');
  await waitForTrackedProcesses(processes, graceMs);
  for (const tracked of processes) signalTrackedProcess(tracked, 'SIGKILL');
  await waitForTrackedProcesses(processes, Math.max(1_000, graceMs));
  if (processes.some(trackedProcessIsLive)) {
    throw new Error('PROCESS_TREE_TERMINATION_FAILED: detached descendant survived');
  }
}

function signalTrackedProcess(tracked: TrackedLinuxProcess, signal: NodeJS.Signals): void {
  if (!trackedProcessIsLive(tracked)) return;
  try {
    process.kill(tracked.namespacePid, signal);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

function trackedProcessIsLive(tracked: TrackedLinuxProcess): boolean {
  const stat = readHostProcessStat(tracked.hostPid);
  return stat !== undefined && stat.startTime === tracked.startTime &&
    stat.state !== 'Z' && stat.state !== 'X' &&
    readNamespacePid(tracked.hostPid, tracked.pidNamespace) === tracked.namespacePid;
}

async function waitForTrackedProcesses(
  processes: readonly TrackedLinuxProcess[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processes.some(trackedProcessIsLive)) {
    if (Date.now() >= deadline) return;
    await delay(Math.min(20, Math.max(1, deadline - Date.now())));
  }
}

async function ownedProcessGroupMembers(identity: ProcessTreeIdentity): Promise<number[]> {
  if (identity.linux === undefined) return [];
  return linuxProcessGroupMembers(identity)
    .filter((member) => member.namespacePid !== identity.pid)
    .map((member) => member.namespacePid)
    .sort((left, right) => left - right);
}

async function processGroupHasLiveMembers(identity: ProcessTreeIdentity): Promise<boolean> {
  if (identity.linux === undefined) return processGroupAlive(identity.pid);
  return linuxProcessGroupMembers(identity)
    .some((member) => member.state !== 'Z' && member.state !== 'X');
}

async function waitForProcessGroupExit(identity: ProcessTreeIdentity, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (await processGroupHasLiveMembers(identity)) {
    if (Date.now() >= deadline) return;
    await delay(Math.min(20, Math.max(1, deadline - Date.now())));
  }
}

function linuxProcessGroupMembers(identity: ProcessTreeIdentity): Array<{
  readonly namespacePid: number;
  readonly state: string;
}> {
  if (identity.linux === undefined) return [];
  const members: Array<{ namespacePid: number; state: string }> = [];
  for (const entry of safeProcEntries()) {
    const hostPid = Number(entry);
    const stat = readHostProcessStat(hostPid);
    if (stat?.processGroupId !== identity.linux.hostProcessGroupId) continue;
    const namespacePid = readNamespacePid(hostPid, identity.linux.pidNamespace);
    if (namespacePid !== undefined) members.push({ namespacePid, state: stat.state });
  }
  return members;
}

function findHostPid(namespacePid: number, pidNamespace: string): number | undefined {
  const directChildren = new Set<number>();
  try {
    const selfHostPid = Number(readFileSync('/proc/self/stat', 'utf8').split(' ', 1)[0]);
    if (Number.isSafeInteger(selfHostPid)) {
      for (const value of readFileSync(
        `/proc/self/task/${String(selfHostPid)}/children`,
        'utf8',
      ).trim().split(/\s+/u)) {
        const candidate = Number(value);
        if (Number.isSafeInteger(candidate)) directChildren.add(candidate);
      }
    }
  } catch {
    // Fall through to the namespace-wide scan.
  }
  const candidates = [...directChildren, ...safeProcEntries().map(Number)];
  for (const hostPid of candidates) {
    if (readNamespacePid(hostPid, pidNamespace) === namespacePid) return hostPid;
  }
  return undefined;
}

function readNamespacePid(hostPid: number, pidNamespace: string): number | undefined {
  try {
    if (readlinkSync(`/proc/${String(hostPid)}/ns/pid`) !== pidNamespace) return undefined;
    const line = readFileSync(`/proc/${String(hostPid)}/status`, 'utf8')
      .split('\n')
      .find((candidate) => candidate.startsWith('NSpid:'));
    const values = line?.slice('NSpid:'.length).trim().split(/\s+/u).map(Number) ?? [];
    const namespacePid = values.at(-1);
    return namespacePid !== undefined && Number.isSafeInteger(namespacePid)
      ? namespacePid
      : undefined;
  } catch {
    return undefined;
  }
}

function safeProcEntries(): string[] {
  try {
    return readdirSync('/proc', { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function readHostProcessStat(
  hostPid: number,
): {
  readonly state: string;
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly startTime: string;
} | undefined {
  try {
    const value = readFileSync(`/proc/${String(hostPid)}/stat`, 'utf8');
    const fields = value.slice(value.lastIndexOf(') ') + 2).split(' ');
    const state = fields[0];
    const parentPid = Number(fields[1]);
    const processGroupId = Number(fields[2]);
    const startTime = fields[19];
    if (state === undefined || startTime === undefined || !Number.isSafeInteger(parentPid) ||
        !Number.isSafeInteger(processGroupId)) {
      return undefined;
    }
    return { state, parentPid, processGroupId, startTime };
  } catch {
    return undefined;
  }
}

function terminationError(
  kind: 'ABORT' | 'TIMEOUT',
  ownerRunId: string,
  descendants: readonly number[],
): ProcessTreeTerminationError {
  const error = new Error(
    kind === 'ABORT'
      ? `AbortError: owned process tree terminated for ${ownerRunId}`
      : `PROCESS_TREE_TIMEOUT: owned process tree terminated for ${ownerRunId}`,
  ) as ProcessTreeTerminationError;
  error.name = kind === 'ABORT' ? 'AbortError' : 'TimeoutError';
  Object.defineProperties(error, {
    ownerRunId: { value: ownerRunId, enumerable: true },
    descendants: { value: [...descendants], enumerable: true },
  });
  return error;
}

function runnerError(error: unknown, secretValues: readonly string[]): Error {
  const original = error instanceof Error ? error : new Error(String(error));
  const redacted = new Error(redactSecrets(original.message, secretValues));
  redacted.name = original.name;
  return redacted;
}

function boundedRedactedOutput(
  value: Buffer,
  limit: number,
  secretValues: readonly string[],
): { readonly output: string; readonly truncated: boolean } {
  const redacted = redactSecrets(value.toString('utf8'), secretValues);
  const encoded = Buffer.from(redacted);
  return {
    output: utf8Tail(encoded, limit).toString('utf8'),
    truncated: encoded.byteLength > limit,
  };
}

function utf8Tail(value: Buffer, limit: number): Buffer {
  if (value.byteLength <= limit) return value;
  let start = value.byteLength - limit;
  while (start < value.byteLength && (value[start]! & 0xc0) === 0x80) start += 1;
  return value.subarray(start);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function requireChildPipeClose(closed: Promise<void>, timeoutMs: number): Promise<void> {
  const complete = await Promise.race([
    closed.then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
  if (!complete) throw new Error('ARGV_RUNNER_OUTPUT_CLOSE_TIMEOUT');
}

function sortedUniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function abortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

interface EnvironmentAllocationClaim {
  readonly schemaVersion: 1;
  readonly environmentRunId: string;
  readonly profileContentHash: ContentHash;
  readonly integrationInputHash: ContentHash;
  readonly maxParallel: number;
  readonly contentHash: ContentHash;
}

export async function claimEnvironmentAllocation(context: EnvironmentAdapterContext): Promise<void> {
  const root = environmentAllocationRoot(context);
  const path = environmentAllocationClaimPath(context);
  await withMutationLockAtPath(environmentAllocationLockPath(context), async () => {
    await ensureDir(root);
    const expected = allocationClaim(context);
    if (await pathExists(path)) {
      const existing = await readAllocationClaim(path);
      if (canonicalJson(existing) !== canonicalJson(expected)) {
        throw new Error('ENVIRONMENT_ALLOCATION_CLAIM_CONFLICT');
      }
      return;
    }
    const entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^IER-\d{4}\.json$/u.test(entry.name));
    let active = 0;
    for (const entry of entries) {
      const claim = await readAllocationClaim(join(root, entry.name));
      if (claim.profileContentHash === context.profile.contentHash) active += 1;
    }
    if (active >= context.profile.isolation.maxParallel) {
      throw new Error(
        `ENVIRONMENT_MAX_PARALLEL_REACHED: ${String(active)}/${String(context.profile.isolation.maxParallel)}`,
      );
    }
    await publishAllocationClaim(path, expected);
  }, { timeoutMs: 5_000 });
}

export async function releaseEnvironmentAllocation(context: EnvironmentAdapterContext): Promise<void> {
  const path = environmentAllocationClaimPath(context);
  await withMutationLockAtPath(environmentAllocationLockPath(context), async () => {
    if (!(await pathExists(path))) return;
    const existing = await readAllocationClaim(path);
    const expected = allocationClaim(context);
    if (canonicalJson(existing) !== canonicalJson(expected)) {
      throw new Error('ENVIRONMENT_ALLOCATION_CLAIM_CONFLICT');
    }
    await unlink(path);
    await syncDirectory(dirname(path));
  }, { timeoutMs: 5_000 });
}

function environmentAllocationRoot(context: EnvironmentAdapterContext): string {
  return join(dirname(context.runRoot), 'allocations');
}

function environmentAllocationClaimPath(context: EnvironmentAdapterContext): string {
  return join(environmentAllocationRoot(context), `${context.environmentRunId}.json`);
}

function environmentAllocationLockPath(context: EnvironmentAdapterContext): string {
  return join(dirname(context.runRoot), 'allocation.mutation-lock');
}

function allocationClaim(context: EnvironmentAdapterContext): EnvironmentAllocationClaim {
  const content = {
    schemaVersion: 1 as const,
    environmentRunId: context.environmentRunId,
    profileContentHash: context.profile.contentHash,
    integrationInputHash: context.integrationInput.inputHash,
    maxParallel: context.profile.isolation.maxParallel,
  };
  return { ...content, contentHash: hashObject(content) };
}

async function readAllocationClaim(path: string): Promise<EnvironmentAllocationClaim> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`ENVIRONMENT_ALLOCATION_CLAIM_INVALID: ${path}`, { cause: error });
  }
  if (!isPlainRecord(value) || value.schemaVersion !== 1 ||
      typeof value.environmentRunId !== 'string' || !/^IER-\d{4}$/u.test(value.environmentRunId) ||
      typeof value.profileContentHash !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.profileContentHash) ||
      typeof value.integrationInputHash !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.integrationInputHash) ||
      typeof value.maxParallel !== 'number' || !Number.isSafeInteger(value.maxParallel) || value.maxParallel <= 0 ||
      typeof value.contentHash !== 'string') {
    throw new Error(`ENVIRONMENT_ALLOCATION_CLAIM_INVALID: ${path}`);
  }
  const { contentHash, ...content } = value;
  if (contentHash !== hashObject(content)) {
    throw new Error(`ENVIRONMENT_ALLOCATION_CLAIM_INVALID: ${path}`);
  }
  return value as unknown as EnvironmentAllocationClaim;
}

async function publishAllocationClaim(
  path: string,
  claim: EnvironmentAllocationClaim,
): Promise<void> {
  const stagePath = `${path}.stage-${randomUUID()}`;
  const handle = await open(stagePath, 'wx', 0o600);
  try {
    await handle.writeFile(`${canonicalJson(claim)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(stagePath, path);
    await syncDirectory(dirname(path));
  } finally {
    await unlink(stagePath).catch(() => undefined);
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is unavailable on some supported platforms.
  } finally {
    await handle?.close();
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface EnvironmentAdapterContext {
  readonly worksetId: string;
  readonly environmentRunId: string;
  readonly integrationInput: IntegrationEnvironmentInput;
  readonly profile: IntegrationEnvironmentProfile;
  readonly workspaceRoot: string;
  readonly runRoot: string;
  readonly sourceRoots: readonly string[];
  readonly requestedMode: EnvironmentEvidenceMode;
  readonly sourceEnvironment: () => Readonly<Record<string, string | undefined>>;
}

export interface EnvironmentProbe {
  readonly driver: EnvironmentDriver;
  readonly authoritative: boolean;
  readonly mode: EnvironmentEvidenceMode;
  readonly code: string;
  readonly reasons: readonly string[];
  readonly details?: Readonly<Record<string, unknown>>;
}

interface PreparedEnvironmentBase {
  readonly driver: EnvironmentDriver;
  readonly context: EnvironmentAdapterContext;
  readonly probe: EnvironmentProbe;
}

export interface ReadyPreparedEnvironment extends PreparedEnvironmentBase {
  readonly status: 'READY';
  readonly preparedData: unknown;
}

export interface BlockedPreparedEnvironment extends PreparedEnvironmentBase {
  readonly status: 'BLOCKED';
  readonly code: string;
  readonly reason: string;
}

export type PreparedEnvironment = ReadyPreparedEnvironment | BlockedPreparedEnvironment;

export interface EnvironmentStep {
  readonly name: EnvironmentStepName;
}

export interface EnvironmentResourceIdentity {
  readonly driver: EnvironmentDriver;
  readonly ownerRunId: string;
  readonly resourceRefs: readonly string[];
  readonly reservedPorts: readonly number[];
  readonly labels: Readonly<Record<string, string>>;
  readonly composeProjectName?: string;
  readonly networkNames: readonly string[];
  readonly volumeNames: readonly string[];
  readonly containerNames: readonly string[];
  readonly exclusiveLeaseId?: string;
}

export interface EnvironmentStepResult {
  readonly status: 'SUCCEEDED';
  readonly step: EnvironmentStepName;
  readonly exitCode: number;
  readonly output: string;
  readonly truncated: boolean;
  readonly resource?: EnvironmentResourceIdentity;
  readonly executionIdentity?: {
    readonly kind: 'SANDBOX';
    readonly proofId: string;
    readonly bindingHash: ContentHash;
    readonly executablePath: string;
    readonly executableDigest: ContentHash;
    readonly processContainer: {
      readonly kind: 'CGROUP' | 'PID_NAMESPACE' | 'WINDOWS_JOB' | 'SANDBOX_SERVICE';
      readonly id: string;
    };
  };
  readonly composeIdentity?: {
    readonly executorPath: string;
    readonly executorDigest: ContentHash;
    readonly normalizedConfigDigest: ContentHash;
    readonly buildContextDigests: readonly {
      readonly ref: string;
      readonly digest: ContentHash;
    }[];
    readonly imageDigests: readonly {
      readonly ref: string;
      readonly digest: ContentHash;
    }[];
  };
}

export interface EnvironmentInspection {
  readonly driver: EnvironmentDriver;
  readonly ownership: 'PROVEN' | 'UNPROVEN' | 'ABSENT';
  readonly resource?: EnvironmentResourceIdentity;
  readonly code: string;
}

export interface EnvironmentReleaseResult {
  readonly driver: EnvironmentDriver;
  readonly status: 'RELEASED' | 'ALREADY_ABSENT' | 'BLOCKED';
  readonly code: string;
}

export interface IntegrationEnvironmentAdapter {
  readonly driver: EnvironmentDriver;
  probe(profile: IntegrationEnvironmentProfile): Promise<EnvironmentProbe>;
  prepare(context: EnvironmentAdapterContext): Promise<PreparedEnvironment>;
  runStep(
    context: ReadyPreparedEnvironment,
    step: EnvironmentStep,
    signal?: AbortSignal,
  ): Promise<EnvironmentStepResult>;
  inspect(context: EnvironmentAdapterContext): Promise<EnvironmentInspection>;
  release(context: EnvironmentAdapterContext, signal?: AbortSignal): Promise<EnvironmentReleaseResult>;
}

export class EnvironmentAdapterRegistry {
  private readonly adapters = new Map<EnvironmentDriver, IntegrationEnvironmentAdapter>();

  constructor(adapters: readonly IntegrationEnvironmentAdapter[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.driver)) {
        throw new Error(`ENVIRONMENT_ADAPTER_DUPLICATE: ${adapter.driver}`);
      }
      this.adapters.set(adapter.driver, adapter);
    }
  }

  forProfile(profile: IntegrationEnvironmentProfile): IntegrationEnvironmentAdapter {
    return this.forDriver(profile.driver);
  }

  forDriver(driver: EnvironmentDriver): IntegrationEnvironmentAdapter {
    const adapter = this.adapters.get(driver);
    if (adapter === undefined) {
      throw new Error(`ENVIRONMENT_ADAPTER_NOT_REGISTERED: ${driver}`);
    }
    return adapter;
  }
}

export interface ProductionEnvironmentAdapterRegistryOptions {
  readonly workspaceRoot: string;
  readonly compose?: ProductionComposeRuntimeOptions & {
    readonly runtime?: ComposeRuntime;
    readonly resolveCommand?: EnvironmentCommandResolver;
  };
  readonly commands?: ProductionCommandsEnvironmentAdapterOptions;
  readonly external?: ExternalEnvironmentAdapterOptions;
}

export function createProductionEnvironmentAdapterRegistry(
  options: ProductionEnvironmentAdapterRegistryOptions,
): EnvironmentAdapterRegistry {
  const compose = options.compose?.runtime === undefined
    ? createProductionComposeEnvironmentAdapter({
        workspaceRoot: options.workspaceRoot,
        ...(options.compose ?? {}),
      })
    : createComposeEnvironmentAdapter({
        workspaceRoot: options.workspaceRoot,
        runtime: options.compose.runtime,
        ...(options.compose.resolveCommand === undefined
          ? {}
          : { resolveCommand: options.compose.resolveCommand }),
      });
  return new EnvironmentAdapterRegistry([
    compose,
    createProductionCommandsEnvironmentAdapter(options.commands),
    createProductionExternalEnvironmentAdapter(options.external),
  ]);
}
