import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type * as acp from '@agentclientprotocol/sdk';
import type { RunPacket } from '../packets.js';
import { evaluatePermission, redactSecrets } from './policy.js';

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TERMINAL_PERMISSION_OPTIONS = [
  { optionId: 'omnai-allow-once', name: 'Allow once', kind: 'allow_once' as const },
  { optionId: 'omnai-reject-once', name: 'Reject', kind: 'reject_once' as const },
];

export type SpawnTerminalProcess = typeof spawn;

interface TerminalHandle {
  readonly id: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly outputLimit: number;
  readonly exit: Promise<acp.WaitForTerminalExitResponse>;
  output: Buffer;
  truncated: boolean;
  exitStatus: acp.WaitForTerminalExitResponse | undefined;
  timeout: NodeJS.Timeout;
}

export class SessionTerminalRegistry {
  private readonly terminals = new Map<string, TerminalHandle>();

  constructor(
    private readonly packet: RunPacket,
    private readonly sessionId: string,
    private readonly defaultCwd: string,
    private readonly secretValues: readonly string[],
    private readonly spawnProcess: SpawnTerminalProcess = spawn,
  ) {}

  async create(params: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse> {
    this.assertSession(params.sessionId);
    const cwd = params.cwd ?? this.defaultCwd;
    const argv = [params.command, ...(params.args ?? [])];
    const permission = evaluatePermission(this.packet, {
      kind: 'terminal',
      command: argv,
      cwd,
      options: TERMINAL_PERMISSION_OPTIONS,
    });
    if (permission.outcome !== 'ALLOW_ONCE') {
      throw new Error(`TERMINAL_NOT_AUTHORIZED: ${permission.reason}`);
    }
    const outputLimit = terminalOutputLimit(params.outputByteLimit, this.packet.limits.maxOutputBytes);
    const environment = terminalEnvironment(params.env ?? []);
    const child = this.spawnProcess(params.command, params.args ?? [], {
      cwd,
      env: environment,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const id = `terminal-${randomUUID()}`;
    let settleExit: ((status: acp.WaitForTerminalExitResponse) => void) | undefined;
    const exit = new Promise<acp.WaitForTerminalExitResponse>((resolve) => {
      settleExit = resolve;
    });
    const handle: TerminalHandle = {
      id,
      child,
      outputLimit,
      exit,
      output: Buffer.alloc(0),
      truncated: false,
      exitStatus: undefined,
      timeout: setTimeout(() => child.kill('SIGKILL'), this.packet.limits.timeoutMs),
    };
    handle.timeout.unref();
    const append = (chunk: Buffer | string): void => {
      const combined = Buffer.concat([handle.output, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (combined.byteLength > handle.outputLimit) {
        handle.truncated = true;
        handle.output = utf8Tail(combined, handle.outputLimit);
      } else {
        handle.output = combined;
      }
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const settle = (status: acp.WaitForTerminalExitResponse): void => {
      if (handle.exitStatus !== undefined) return;
      handle.exitStatus = status;
      clearTimeout(handle.timeout);
      settleExit?.(status);
    };
    child.once('exit', (exitCode, signal) => settle({ exitCode, signal }));
    child.once('error', (error) => {
      append(error.message);
      settle({ exitCode: null, signal: 'SPAWN_ERROR' });
    });
    this.terminals.set(id, handle);
    return { terminalId: id };
  }

  async output(params: acp.TerminalOutputRequest): Promise<acp.TerminalOutputResponse> {
    const handle = this.handle(params.sessionId, params.terminalId);
    const bounded = boundedRedactedOutput(handle.output, handle.outputLimit, this.secretValues);
    return {
      output: bounded.output,
      truncated: handle.truncated || bounded.truncated,
      ...(handle.exitStatus === undefined ? {} : { exitStatus: handle.exitStatus }),
    };
  }

  async waitForExit(params: acp.WaitForTerminalExitRequest): Promise<acp.WaitForTerminalExitResponse> {
    return this.handle(params.sessionId, params.terminalId).exit;
  }

  async kill(params: acp.KillTerminalRequest): Promise<acp.KillTerminalResponse> {
    const handle = this.handle(params.sessionId, params.terminalId);
    if (handle.exitStatus === undefined) handle.child.kill('SIGTERM');
    return {};
  }

  async release(params: acp.ReleaseTerminalRequest): Promise<acp.ReleaseTerminalResponse> {
    const handle = this.handle(params.sessionId, params.terminalId);
    if (handle.exitStatus === undefined) handle.child.kill('SIGTERM');
    clearTimeout(handle.timeout);
    handle.child.stdin.destroy();
    handle.child.stdout.destroy();
    handle.child.stderr.destroy();
    this.terminals.delete(handle.id);
    return {};
  }

  async dispose(): Promise<void> {
    for (const handle of this.terminals.values()) {
      if (handle.exitStatus === undefined) handle.child.kill('SIGTERM');
      clearTimeout(handle.timeout);
      handle.child.stdin.destroy();
      handle.child.stdout.destroy();
      handle.child.stderr.destroy();
    }
    this.terminals.clear();
  }

  private handle(sessionId: string, terminalId: string): TerminalHandle {
    this.assertSession(sessionId);
    const handle = this.terminals.get(terminalId);
    if (handle === undefined) throw new Error(`TERMINAL_UNKNOWN: ${terminalId}`);
    return handle;
  }

  private assertSession(sessionId: string): void {
    if (sessionId !== this.sessionId) {
      throw new Error(`AGENT_SESSION_ID_MISMATCH: expected ${this.sessionId}, received ${sessionId}`);
    }
  }
}

function terminalOutputLimit(requested: number | null | undefined, packetLimit: number): number {
  if (requested !== undefined && requested !== null &&
      (!Number.isSafeInteger(requested) || requested <= 0)) {
    throw new Error('TERMINAL_OUTPUT_LIMIT_INVALID');
  }
  return Math.min(requested ?? packetLimit, packetLimit);
}

function terminalEnvironment(items: readonly acp.EnvVariable[]): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  for (const item of items) {
    if (!ENVIRONMENT_NAME.test(item.name) || item.value.includes('\0')) {
      throw new Error(`TERMINAL_ENVIRONMENT_INVALID: ${item.name}`);
    }
    if (Object.prototype.hasOwnProperty.call(environment, item.name) ||
        items.filter((candidate) => candidate.name === item.name).length > 1) {
      throw new Error(`TERMINAL_ENVIRONMENT_DUPLICATE: ${item.name}`);
    }
    environment[item.name] = item.value;
  }
  return environment;
}

function utf8Tail(value: Buffer, limit: number): Buffer {
  if (value.byteLength <= limit) return value;
  let start = value.byteLength - limit;
  while (start < value.byteLength && (value[start]! & 0xc0) === 0x80) start += 1;
  return value.subarray(start);
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
