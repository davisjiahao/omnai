import { spawn as spawnProcess } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import {
  Readable as NodeReadable,
  Transform,
  Writable as NodeWritable,
} from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { OMNAI_VERSION } from '../../version.js';
import { agentSessionRecordSchema } from '../types.js';
import { agentProfileSchema, type AgentProfile } from './types.js';
import { probeAgent } from './profiles.js';
import { SessionTerminalRegistry } from './terminals.js';
import {
  evaluatePermission,
  redactSecrets,
  resolveSecretEnvironment,
  type PermissionRequest,
} from './policy.js';
import type {
  AgentCollectRequest,
  AgentInspectionRequest,
  AgentMcpServer,
  AgentResumeRequest,
  AgentSessionAdapter,
  AgentSessionHooks,
  AgentSessionInspection,
  AgentSessionRequest,
  AgentSignalRequest,
  NormalizedAgentResult,
  NormalizedAgentEvent,
  NormalizedPromptResult,
} from './types.js';

export interface AcpProcessHandle {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly killed: boolean;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: string, listener: (...args: unknown[]) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
}

export type SpawnAcpProcess = (
  profile: AgentProfile,
  environment: NodeJS.ProcessEnv,
) => AcpProcessHandle;

export interface AcpAgentAdapterOptions {
  readonly spawn?: SpawnAcpProcess;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => string;
}

export class AcpAgentAdapter implements AgentSessionAdapter {
  private readonly spawn: SpawnAcpProcess;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly now: () => string;

  constructor(options: AcpAgentAdapterOptions = {}) {
    this.spawn = options.spawn ?? defaultSpawn;
    this.environment = options.environment ?? process.env;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async probe(profile: AgentProfile) {
    return probeAgent(profile);
  }

  async start(
    request: AgentSessionRequest,
    hooks: AgentSessionHooks,
  ): Promise<NormalizedPromptResult> {
    const profile = agentProfileSchema.parse(request.profile);
    assertPacketProfile(request, profile);
    assertRuntimeRoots(request, profile);
    if (profile.protocol !== 'acp') throw new Error('AGENT_PROTOCOL_NOT_ACP');
    const secrets = resolveSecretEnvironment(profile, this.environment);
    const transport = openAcpTransport({
      spawn: this.spawn,
      profile,
      environment: processEnvironment(profile, this.environment, secrets),
      secretValues: Object.values(secrets),
      maxOutputBytes: request.packet.limits.maxOutputBytes,
      timeoutMs: request.packet.limits.timeoutMs,
      timeoutCode: 'AGENT_SESSION_TIMEOUT',
    });
    const { child, stream } = transport;
    let activeSessionId: string | undefined;
    let terminals: SessionTerminalRegistry | undefined;
    let eventSequence = 0;
    let outputBytes = 0;
    const emitEvent = async (
      kind: NormalizedAgentEvent['kind'],
      sessionId: string,
      value: unknown,
    ): Promise<void> => {
      assertSessionId(activeSessionId, sessionId);
      const payload = redactSecrets(value, Object.values(secrets));
      const bytes = Buffer.byteLength(JSON.stringify(payload));
      if (outputBytes + bytes > request.packet.limits.maxOutputBytes) {
        throw new acp.RequestError(-32_011, 'AGENT_OUTPUT_LIMIT_EXCEEDED');
      }
      outputBytes += bytes;
      eventSequence += 1;
      await hooks.onEvent({
        schemaVersion: 1,
        runId: request.packet.id,
        sessionId,
        sequence: eventSequence,
        kind,
        payload,
        timestamp: this.now(),
      });
    };
    const client = runtimeClient(
      request,
      () => activeSessionId,
      () => terminals,
      emitEvent,
      transport.fail,
    );

    try {
      const operation: Promise<NormalizedPromptResult> = client.connectWith(stream, async (context) => {
        const initialized = await context.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: capabilitiesFor(request),
          clientInfo: { name: 'omnai', title: 'OmnAI', version: OMNAI_VERSION },
        });
        if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
          throw new Error(`AGENT_PROTOCOL_VERSION_UNSUPPORTED: ${initialized.protocolVersion}`);
        }
        assertNegotiatedRoots(request, initialized);

        return context.buildSession({
          cwd: request.cwd,
          mcpServers: request.mcpServers.map(toAcpMcpServer),
          ...(request.additionalDirectories.length === 0
            ? {}
            : { additionalDirectories: [...request.additionalDirectories] }),
        }).withSession(async (session) => {
          activeSessionId = session.sessionId;
          terminals = new SessionTerminalRegistry(
            request.packet,
            session.sessionId,
            request.cwd,
            Object.values(secrets),
          );
          const timestamp = this.now();
          await hooks.onSessionCreated(agentSessionRecordSchema.parse({
            schemaVersion: 1,
            machineVersion: 1,
            lastEventSequence: 0,
            lastEventHash: null,
            runId: request.packet.id,
            agentId: profile.agentId,
            protocol: 'acp',
            sessionId: session.sessionId,
            ...(child.pid === undefined ? {} : { processId: child.pid }),
            promptState: 'NOT_SENT',
            createdAt: timestamp,
            updatedAt: timestamp,
          }));
          await hooks.onPromptIntent();

          const promptResponse = session.prompt(request.prompt);
          for (;;) {
            const message = await session.nextUpdate();
            if (message.kind !== 'stop') continue;
            await promptResponse;
            return {
              status: 'COMPLETED',
              runId: request.packet.id,
              sessionId: session.sessionId,
              stopReason: message.stopReason,
              outputBytes,
            };
          }
        });
      });
      return await transport.run(operation);
    } finally {
      await terminals?.dispose();
      transport.close();
    }
  }

  async inspect(request: AgentInspectionRequest): Promise<AgentSessionInspection> {
    const record = agentSessionRecordSchema.parse(request.record);
    validateEvents(record.runId, record.sessionId, request.events);
    if (request.promptResult !== undefined) {
      assertPromptResultIdentity(record.runId, record.sessionId, request.promptResult);
    }
    const processState = inspectProcess(record.processId);
    const outcome = request.promptResult?.status === 'COMPLETED'
      ? 'COMPLETED'
      : request.promptResult?.status === 'RECOVERY_REQUIRED'
        ? 'RECOVERY_REQUIRED'
        : processState === 'LIVE'
          ? 'RUNNING'
          : 'UNKNOWN';
    return {
      sessionId: record.sessionId,
      process: processState,
      outcome,
      eventCount: request.events.length,
    };
  }

  async signal(request: AgentSignalRequest): Promise<void> {
    const profile = agentProfileSchema.parse(request.profile);
    assertPacketProfile(request, profile);
    if (profile.protocol !== 'acp') throw new Error('AGENT_PROTOCOL_NOT_ACP');
    assertSignalBinding(request);
    const secrets = resolveSecretEnvironment(profile, this.environment);
    const transport = openAcpTransport({
      spawn: this.spawn,
      profile,
      environment: processEnvironment(profile, this.environment, secrets),
      secretValues: Object.values(secrets),
      maxOutputBytes: request.packet.limits.maxOutputBytes,
      timeoutMs: request.packet.limits.timeoutMs,
      timeoutCode: 'AGENT_SIGNAL_TIMEOUT',
    });
    try {
      const operation = acp.client({ name: 'omnai' }).connectWith(transport.stream, async (context) => {
        const initialized = await context.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: 'omnai', title: 'OmnAI', version: OMNAI_VERSION },
        });
        if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
          throw new Error(`AGENT_PROTOCOL_VERSION_UNSUPPORTED: ${initialized.protocolVersion}`);
        }
        await context.notify(acp.methods.agent.session.cancel, {
          sessionId: request.record.sessionId,
        });
        if (initialized.agentCapabilities?.sessionCapabilities?.close != null) {
          await context.request(acp.methods.agent.session.close, {
            sessionId: request.record.sessionId,
          });
        }
      });
      await transport.run(operation);
    } finally {
      transport.close();
    }
  }

  async collect(request: AgentCollectRequest): Promise<NormalizedAgentResult> {
    const record = agentSessionRecordSchema.parse(request.record);
    assertCollectBinding(request, record);
    validateEvents(record.runId, record.sessionId, request.events);
    if (request.promptResult !== undefined) {
      assertPromptResultIdentity(record.runId, record.sessionId, request.promptResult);
    }
    const events = redactSecrets(
      request.events.map((event) => ({
        ...event,
        payload: normalizeCollectedPayload(event.payload),
      })),
      request.secretValues ?? [],
    );
    const serialized = JSON.stringify({ events, promptResult: request.promptResult ?? null });
    const outputBytes = Buffer.byteLength(serialized);
    if (outputBytes > request.packet.limits.maxOutputBytes) {
      throw new Error('AGENT_OUTPUT_LIMIT_EXCEEDED');
    }
    return {
      sessionId: record.sessionId,
      status: request.promptResult?.status === 'COMPLETED'
        ? 'COMPLETED'
        : request.promptResult?.status === 'RECOVERY_REQUIRED'
          ? 'RECOVERY_REQUIRED'
          : 'RUNNING',
      stopReason: request.promptResult?.status === 'COMPLETED'
        ? request.promptResult.stopReason
        : null,
      events,
      outputBytes,
    };
  }

  async resume(
    request: AgentResumeRequest,
    hooks: AgentSessionHooks,
  ): Promise<NormalizedPromptResult> {
    const profile = agentProfileSchema.parse(request.profile);
    assertPacketProfile(request, profile);
    assertRuntimeRoots(request, profile);
    if (profile.protocol !== 'acp') throw new Error('AGENT_PROTOCOL_NOT_ACP');
    assertResumeBinding(request);
    const secrets = resolveSecretEnvironment(profile, this.environment);
    const transport = openAcpTransport({
      spawn: this.spawn,
      profile,
      environment: processEnvironment(profile, this.environment, secrets),
      secretValues: Object.values(secrets),
      maxOutputBytes: request.packet.limits.maxOutputBytes,
      timeoutMs: request.packet.limits.timeoutMs,
      timeoutCode: 'AGENT_SESSION_TIMEOUT',
    });
    const activeSessionId = request.record.sessionId;
    const terminals = new SessionTerminalRegistry(
      request.packet,
      activeSessionId,
      request.cwd,
      Object.values(secrets),
    );
    let eventSequence = 0;
    let outputBytes = 0;
    const emitEvent = async (
      kind: NormalizedAgentEvent['kind'],
      sessionId: string,
      value: unknown,
    ): Promise<void> => {
      assertSessionId(activeSessionId, sessionId);
      const payload = redactSecrets(value, Object.values(secrets));
      const bytes = Buffer.byteLength(JSON.stringify(payload));
      if (outputBytes + bytes > request.packet.limits.maxOutputBytes) {
        throw new acp.RequestError(-32_011, 'AGENT_OUTPUT_LIMIT_EXCEEDED');
      }
      outputBytes += bytes;
      eventSequence += 1;
      await hooks.onEvent({
        schemaVersion: 1,
        runId: request.packet.id,
        sessionId,
        sequence: eventSequence,
        kind,
        payload,
        timestamp: this.now(),
      });
    };
    const client = runtimeClient(
      request,
      () => activeSessionId,
      () => terminals,
      emitEvent,
      transport.fail,
    );

    try {
      const operation: Promise<NormalizedPromptResult> = client.connectWith(
        transport.stream,
        async (context) => {
          const initialized = await context.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: capabilitiesFor(request),
            clientInfo: { name: 'omnai', title: 'OmnAI', version: OMNAI_VERSION },
          });
          if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
            throw new Error(`AGENT_PROTOCOL_VERSION_UNSUPPORTED: ${initialized.protocolVersion}`);
          }
          assertNegotiatedRoots(request, initialized);
          const lifecycle = {
            sessionId: activeSessionId,
            cwd: request.cwd,
            mcpServers: request.mcpServers.map(toAcpMcpServer),
            ...(request.additionalDirectories.length === 0
              ? {}
              : { additionalDirectories: [...request.additionalDirectories] }),
          };
          const sessionCapabilities = initialized.agentCapabilities?.sessionCapabilities;
          if (sessionCapabilities?.resume != null) {
            await context.request(acp.methods.agent.session.resume, lifecycle);
          } else if (initialized.agentCapabilities?.loadSession === true) {
            await context.request(acp.methods.agent.session.load, lifecycle);
          } else {
            return {
              status: 'RECOVERY_REQUIRED',
              runId: request.packet.id,
              sessionId: activeSessionId,
              stopReason: null,
              outputBytes,
              evidence: recoveryEvidence(request),
            };
          }
          return {
            status: 'RESUMED',
            runId: request.packet.id,
            sessionId: activeSessionId,
            stopReason: null,
            outputBytes,
          };
        },
      );
      return await transport.run(operation);
    } finally {
      await terminals.dispose();
      transport.close();
    }
  }
}

function openAcpTransport(options: {
  readonly spawn: SpawnAcpProcess;
  readonly profile: AgentProfile;
  readonly environment: NodeJS.ProcessEnv;
  readonly secretValues: readonly string[];
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
  readonly timeoutCode: string;
}) {
  const child = options.spawn(options.profile, options.environment);
  const fatal = failureLatch();
  const deadline = failureDeadline(options.timeoutMs, options.timeoutCode);
  const maxTransportBytes = transportByteLimit(options.maxOutputBytes);
  const guardedStdout = new AcpInputGuard(maxTransportBytes);
  let stderrBytes = 0;
  let closed = false;

  child.once('exit', (code, signal) => {
    fatal.fail(new AgentAdapterFailure(
      'AGENT_PROCESS_EXIT',
      `code=${formatProcessValue(code)}, signal=${formatProcessValue(signal)}`,
    ));
  });
  child.once('error', () => fatal.fail(new AgentAdapterFailure('AGENT_PROCESS_ERROR')));
  guardedStdout.on('error', fatal.fail);
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderrBytes += Buffer.byteLength(chunk);
    if (stderrBytes > maxTransportBytes) {
      fatal.fail(new AgentAdapterFailure('AGENT_STDERR_LIMIT_EXCEEDED'));
    }
  });
  child.stdout.pipe(guardedStdout);
  const stream = acp.ndJsonStream(
    NodeWritable.toWeb(child.stdin),
    NodeReadable.toWeb(guardedStdout) as ReadableStream<Uint8Array>,
  );

  return {
    child,
    stream,
    fail: fatal.fail,
    run: async <T>(operation: Promise<T>): Promise<T> => {
      try {
        return await Promise.race([operation, fatal.promise, deadline.promise]);
      } catch (error) {
        throw normalizeAdapterError(error, options.secretValues);
      }
    },
    close: (): void => {
      if (closed) return;
      closed = true;
      deadline.cancel();
      child.stdout.unpipe(guardedStdout);
      guardedStdout.destroy();
      if (!child.killed && child.exitCode === null) child.kill('SIGTERM');
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    },
  };
}

function requireTerminals(
  registry: SessionTerminalRegistry | undefined,
): SessionTerminalRegistry {
  if (registry === undefined) throw new Error('TERMINAL_SESSION_NOT_READY');
  return registry;
}

function defaultSpawn(profile: AgentProfile, environment: NodeJS.ProcessEnv): AcpProcessHandle {
  return spawnProcess(profile.command, profile.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    env: environment,
  }) as unknown as AcpProcessHandle;
}

type AgentRuntimeRequest = AgentSessionRequest | AgentResumeRequest;
type EmitAgentEvent = (
  kind: NormalizedAgentEvent['kind'],
  sessionId: string,
  value: unknown,
) => Promise<void>;

function runtimeClient(
  request: AgentRuntimeRequest,
  activeSessionId: () => string | undefined,
  terminals: () => SessionTerminalRegistry | undefined,
  emitEvent: EmitAgentEvent,
  onFatal: (error: unknown) => void = () => undefined,
): acp.ClientApp {
  return acp.client({ name: 'omnai' })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      assertSessionId(activeSessionId(), params.sessionId);
      const normalized = normalizePermission(params);
      const decision = normalized === null
        ? deniedPermission(params.options)
        : evaluatePermission(request.packet, normalized);
      if (decision.outcome === 'ALLOW_ONCE') {
        return { outcome: { outcome: 'selected', optionId: decision.optionId } };
      }
      return decision.optionId === undefined
        ? { outcome: { outcome: 'cancelled' } }
        : { outcome: { outcome: 'selected', optionId: decision.optionId } };
    })
    .onRequest(acp.methods.client.fs.readTextFile, ({ params }) =>
      readAuthorizedText(request, activeSessionId(), params))
    .onRequest(acp.methods.client.fs.writeTextFile, ({ params }) =>
      writeAuthorizedText(request, activeSessionId(), params))
    .onRequest(acp.methods.client.terminal.create, ({ params }) => requireTerminals(terminals()).create(params))
    .onRequest(acp.methods.client.terminal.output, ({ params }) => requireTerminals(terminals()).output(params))
    .onRequest(acp.methods.client.terminal.waitForExit, ({ params }) => requireTerminals(terminals()).waitForExit(params))
    .onRequest(acp.methods.client.terminal.kill, ({ params }) => requireTerminals(terminals()).kill(params))
    .onRequest(acp.methods.client.terminal.release, ({ params }) => requireTerminals(terminals()).release(params))
    .onRequest(acp.methods.client.elicitation.create, async ({ params }) => {
      const sessionId = elicitationSessionId(params, activeSessionId());
      await emitEvent('ELICITATION_BLOCKED', sessionId, {
        code: 'AGENT_ELICITATION_DECLINED',
        request: params,
      });
      return { action: 'decline' as const };
    })
    .onNotification(acp.methods.client.elicitation.complete, ({ params }) =>
      containNotificationFailure(
        () => emitEvent('ELICITATION_COMPLETED', requireActiveSessionId(activeSessionId()), params),
        onFatal,
      ))
    .onNotification(acp.methods.client.session.update, ({ params }) =>
      containNotificationFailure(
        () => emitEvent('SESSION_UPDATE', params.sessionId, normalizeSessionUpdate(params.update)),
        onFatal,
      ));
}

function capabilitiesFor(request: AgentRuntimeRequest): acp.ClientCapabilities {
  return {
    fs: {
      readTextFile: true,
      // Every role may write exactly its coordinator-owned output artifact.
      // Project writers may additionally write packet-authorized worktree files.
      writeTextFile: true,
    },
    ...(request.packet.permissionPolicy.terminal ? { terminal: true } : {}),
  };
}

function assertSessionId(expected: string | undefined, actual: string): void {
  if (expected === undefined || expected !== actual) {
    throw new Error(`AGENT_SESSION_ID_MISMATCH: expected ${expected ?? 'none'}, received ${actual}`);
  }
}

function normalizePermission(params: acp.RequestPermissionRequest): PermissionRequest | null {
  const options = params.options.map((option) => ({
    optionId: option.optionId,
    name: option.name,
    kind: option.kind,
  }));
  const raw = isRecord(params.toolCall.rawInput) ? params.toolCall.rawInput : {};
  const locatedPath = params.toolCall.locations?.find((location) => typeof location.path === 'string')?.path;
  const path = typeof raw.path === 'string' ? raw.path : locatedPath;

  switch (params.toolCall.kind) {
    case 'read':
    case 'search':
      return typeof path === 'string' ? { kind: 'read-file', path, options } : null;
    case 'edit':
    case 'delete':
    case 'move':
      return typeof path === 'string' ? { kind: 'write-file', path, options } : null;
    case 'execute': {
      const command = normalizeCommand(raw);
      return command !== null && typeof raw.cwd === 'string'
        ? { kind: 'terminal', command, cwd: raw.cwd, options }
        : null;
    }
    case 'fetch': {
      const host = typeof raw.host === 'string' ? raw.host : hostFromUrl(raw.url);
      return host === null ? null : { kind: 'network', host, options };
    }
    default:
      return null;
  }
}

function normalizeCommand(raw: Readonly<Record<string, unknown>>): readonly string[] | null {
  if (Array.isArray(raw.command) && raw.command.length > 0 && raw.command.every((item) => typeof item === 'string')) {
    return raw.command;
  }
  if (typeof raw.command !== 'string' || raw.command.length === 0) return null;
  if (raw.args === undefined) return [raw.command];
  if (!Array.isArray(raw.args) || !raw.args.every((item) => typeof item === 'string')) return null;
  return [raw.command, ...raw.args];
}

function hostFromUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

function deniedPermission(options: readonly acp.PermissionOption[]): {
  outcome: 'DENY';
  optionId?: string;
  reason: string;
} {
  const option = options.find((item) => item.kind === 'reject_once') ??
    options.find((item) => item.kind === 'reject_always');
  return {
    outcome: 'DENY',
    ...(option === undefined ? {} : { optionId: option.optionId }),
    reason: 'PERMISSION_REQUEST_INVALID',
  };
}

async function readAuthorizedText(
  request: AgentRuntimeRequest,
  sessionId: string | undefined,
  params: acp.ReadTextFileRequest,
): Promise<acp.ReadTextFileResponse> {
  assertSessionId(sessionId, params.sessionId);
  const decision = evaluatePermission(request.packet, {
    kind: 'read-file',
    path: params.path,
    options: filesystemPermissionOptions(),
  });
  if (decision.outcome !== 'ALLOW_ONCE') {
    throw new acp.RequestError(-32_010, `FILESYSTEM_NOT_AUTHORIZED: ${decision.reason}`);
  }
  const raw = await readFile(params.path, 'utf8');
  const content = selectLines(raw, params.line, params.limit);
  if (Buffer.byteLength(content) > request.packet.limits.maxOutputBytes) {
    throw new Error('FILESYSTEM_OUTPUT_LIMIT_EXCEEDED');
  }
  return { content };
}

async function writeAuthorizedText(
  request: AgentRuntimeRequest,
  sessionId: string | undefined,
  params: acp.WriteTextFileRequest,
): Promise<acp.WriteTextFileResponse> {
  assertSessionId(sessionId, params.sessionId);
  if (params.path === request.outputPath) {
    if (Buffer.byteLength(params.content) > request.packet.limits.maxOutputBytes) {
      throw new Error('FILESYSTEM_INPUT_LIMIT_EXCEEDED');
    }
    await writeFile(params.path, params.content, 'utf8');
    return {};
  }
  const decision = evaluatePermission(request.packet, {
    kind: 'write-file',
    path: params.path,
    options: filesystemPermissionOptions(),
  });
  if (decision.outcome !== 'ALLOW_ONCE') {
    throw new acp.RequestError(-32_010, `FILESYSTEM_NOT_AUTHORIZED: ${decision.reason}`);
  }
  if (Buffer.byteLength(params.content) > request.packet.limits.maxOutputBytes) {
    throw new Error('FILESYSTEM_INPUT_LIMIT_EXCEEDED');
  }
  await writeFile(params.path, params.content, 'utf8');
  return {};
}

function filesystemPermissionOptions() {
  return [
    { optionId: 'omnai-allow-once', name: 'Allow once', kind: 'allow_once' as const },
    { optionId: 'omnai-reject-once', name: 'Reject', kind: 'reject_once' as const },
  ];
}

function selectLines(
  content: string,
  line: number | null | undefined,
  limit: number | null | undefined,
): string {
  if (line === undefined && limit === undefined) return content;
  const start = line ?? 1;
  if (!Number.isSafeInteger(start) || start < 1) throw new Error('FILESYSTEM_LINE_INVALID');
  if (limit !== undefined && limit !== null && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new Error('FILESYSTEM_LINE_LIMIT_INVALID');
  }
  const lines = content.match(/.*(?:\r?\n|$)/g)?.filter((item) => item.length > 0) ?? [];
  return lines.slice(start - 1, limit === undefined || limit === null ? undefined : start - 1 + limit).join('');
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSessionUpdate(update: acp.SessionUpdate): unknown {
  if (update.sessionUpdate !== 'agent_thought_chunk') return update;
  return {
    sessionUpdate: update.sessionUpdate,
    content: { type: 'text', text: '[PRIVATE_REASONING_OMITTED]' },
    ...(update.messageId === undefined ? {} : { messageId: update.messageId }),
  };
}

function elicitationSessionId(
  params: acp.CreateElicitationRequest,
  activeSessionId: string | undefined,
): string {
  if ('sessionId' in params && typeof params.sessionId === 'string') {
    assertSessionId(activeSessionId, params.sessionId);
    return params.sessionId;
  }
  return requireActiveSessionId(activeSessionId);
}

function requireActiveSessionId(sessionId: string | undefined): string {
  if (sessionId === undefined) throw new Error('AGENT_SESSION_NOT_READY');
  return sessionId;
}

function assertResumeBinding(request: AgentResumeRequest): void {
  if (request.record.runId !== request.packet.id) throw new Error('AGENT_RUN_ID_MISMATCH');
  if (request.record.agentId !== request.profile.agentId) throw new Error('AGENT_ID_MISMATCH');
  if (request.record.protocol !== request.profile.protocol) throw new Error('AGENT_PROTOCOL_MISMATCH');
}

function assertSignalBinding(request: AgentSignalRequest): void {
  if (request.record.runId !== request.packet.id) throw new Error('AGENT_RUN_ID_MISMATCH');
  if (request.record.agentId !== request.profile.agentId) throw new Error('AGENT_ID_MISMATCH');
  if (request.record.protocol !== request.profile.protocol) throw new Error('AGENT_PROTOCOL_MISMATCH');
}

function assertCollectBinding(
  request: AgentCollectRequest,
  record: ReturnType<typeof agentSessionRecordSchema.parse>,
): void {
  if (record.runId !== request.packet.id) throw new Error('AGENT_RUN_ID_MISMATCH');
  if (record.agentId !== request.packet.agent.agentId) throw new Error('AGENT_ID_MISMATCH');
  if (record.protocol !== request.packet.agent.protocol) throw new Error('AGENT_PROTOCOL_MISMATCH');
}

function assertPacketProfile(
  request: { readonly packet: AgentSessionRequest['packet']; readonly profile: AgentProfile },
  profile: AgentProfile,
): void {
  if (request.packet.agent.agentId !== profile.agentId ||
      request.packet.agent.protocol !== profile.protocol ||
      !profile.omnaiModes.includes(request.packet.agent.role)) {
    throw new Error('AGENT_PACKET_PROFILE_MISMATCH');
  }
}

function assertRuntimeRoots(request: AgentRuntimeRequest, profile: AgentProfile): void {
  if (!isAbsolute(request.outputPath) || resolve(request.outputPath) !== request.outputPath) {
    throw new Error('AGENT_OUTPUT_PATH_INVALID');
  }
  if (!packetAuthorizesReadPath(request, request.cwd)) {
    throw new Error('AGENT_CWD_OUTSIDE_PACKET_ROOTS');
  }
  const seen = new Set<string>();
  for (const directory of request.additionalDirectories) {
    if (seen.has(directory)) throw new Error('AGENT_ADDITIONAL_DIRECTORY_DUPLICATE');
    seen.add(directory);
    if (!packetAuthorizesReadPath(request, directory)) {
      throw new Error('AGENT_ADDITIONAL_DIRECTORY_OUTSIDE_PACKET_ROOTS');
    }
  }
  if (request.additionalDirectories.length > 0 && !profile.capabilities.additionalDirectories) {
    throw new Error('AGENT_ADDITIONAL_DIRECTORIES_UNSUPPORTED');
  }
}

function assertNegotiatedRoots(
  request: AgentRuntimeRequest,
  initialized: acp.InitializeResponse,
): void {
  if (request.additionalDirectories.length > 0 &&
      initialized.agentCapabilities?.sessionCapabilities?.additionalDirectories == null) {
    throw new Error('AGENT_ADDITIONAL_DIRECTORIES_UNSUPPORTED');
  }
}

function packetAuthorizesReadPath(request: AgentRuntimeRequest, path: string): boolean {
  return evaluatePermission(request.packet, {
    kind: 'read-file',
    path,
    options: filesystemPermissionOptions(),
  }).outcome === 'ALLOW_ONCE';
}

function recoveryEvidence(request: AgentResumeRequest): Readonly<Record<string, unknown>> {
  return {
    sessionId: request.record.sessionId,
    processId: request.record.processId ?? null,
    promptState: request.record.promptState,
    git: 'git' in request.packet
      ? {
          worktree: request.packet.git.worktree,
          branch: request.packet.git.branch,
          startingHead: request.packet.git.startingHead,
        }
      : null,
  };
}

function validateEvents(
  runId: string,
  sessionId: string,
  events: readonly NormalizedAgentEvent[],
): void {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.schemaVersion !== 1) throw new Error('AGENT_EVENT_SCHEMA_UNSUPPORTED');
    if (event.runId !== runId) throw new Error('AGENT_RUN_ID_MISMATCH');
    if (event.sessionId !== sessionId) throw new Error('AGENT_SESSION_ID_MISMATCH');
    if (event.sequence !== index + 1) throw new Error('AGENT_EVENT_SEQUENCE_INVALID');
    if (!Number.isFinite(Date.parse(event.timestamp))) throw new Error('AGENT_EVENT_TIMESTAMP_INVALID');
  }
}

function assertPromptResultIdentity(
  runId: string,
  sessionId: string,
  result: NormalizedPromptResult,
): void {
  if (result.runId !== runId) throw new Error('AGENT_RUN_ID_MISMATCH');
  if (result.sessionId !== sessionId) throw new Error('AGENT_SESSION_ID_MISMATCH');
}

function inspectProcess(processId: number | undefined): AgentSessionInspection['process'] {
  if (processId === undefined) return 'UNKNOWN';
  try {
    process.kill(processId, 0);
    return 'LIVE';
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ESRCH') return 'DEAD';
    if (code === 'EPERM') return 'LIVE';
    return 'UNKNOWN';
  }
}

function normalizeCollectedPayload(payload: unknown): unknown {
  if (!isRecord(payload) || typeof payload.sessionUpdate !== 'string') return payload;
  if (payload.sessionUpdate !== 'agent_thought_chunk') return payload;
  return {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: '[PRIVATE_REASONING_OMITTED]' },
    ...(payload.messageId === undefined ? {} : { messageId: payload.messageId }),
  };
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

class AgentAdapterFailure extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'AgentAdapterFailure';
  }
}

class AcpInputGuard extends Transform {
  private bytes = 0;
  private pending = Buffer.alloc(0);

  constructor(private readonly maxBytes: number) {
    super();
  }

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.bytes += value.byteLength;
    if (this.bytes > this.maxBytes) {
      callback(new AgentAdapterFailure('AGENT_STDOUT_LIMIT_EXCEEDED'));
      return;
    }
    this.pending = Buffer.concat([this.pending, value]);
    try {
      for (;;) {
        const newline = this.pending.indexOf(0x0a);
        if (newline < 0) break;
        const line = this.pending.subarray(0, newline);
        this.pending = this.pending.subarray(newline + 1);
        this.validateAndPush(line, true);
      }
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new AgentAdapterFailure('AGENT_PROTOCOL_INVALID'));
    }
  }

  override _flush(callback: (error?: Error | null) => void): void {
    try {
      if (this.pending.byteLength > 0) this.validateAndPush(this.pending, false);
      this.pending = Buffer.alloc(0);
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new AgentAdapterFailure('AGENT_PROTOCOL_INVALID'));
    }
  }

  private validateAndPush(line: Buffer, newline: boolean): void {
    const text = line.toString('utf8').trim();
    if (text !== '') {
      let message: unknown;
      try {
        message = JSON.parse(text);
      } catch {
        throw new AgentAdapterFailure('AGENT_PROTOCOL_INVALID');
      }
      const messages = Array.isArray(message) ? message : [message];
      if (messages.length === 0 || !messages.every(isSafeJsonRpcMessage)) {
        throw new AgentAdapterFailure('AGENT_PROTOCOL_INVALID');
      }
    }
    this.push(line);
    if (newline) this.push(Buffer.from('\n'));
  }
}

function isSafeJsonRpcMessage(value: unknown): boolean {
  if (!isRecord(value) || value.jsonrpc !== '2.0') return false;
  if ('method' in value) {
    return typeof value.method === 'string' &&
      (!('id' in value) || jsonRpcId(value.id));
  }
  if (!('id' in value) || !jsonRpcId(value.id)) return false;
  const hasResult = Object.prototype.hasOwnProperty.call(value, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(value, 'error');
  if (hasResult === hasError) return false;
  return !hasError || (
    isRecord(value.error) &&
    Number.isInteger(value.error.code) &&
    typeof value.error.message === 'string'
  );
}

function jsonRpcId(value: unknown): boolean {
  return value === null || typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value));
}

function transportByteLimit(outputByteLimit: number): number {
  return Math.max(64 * 1_024, outputByteLimit * 4);
}

function formatProcessValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : 'null';
}

function normalizeAdapterError(error: unknown, secretValues: readonly string[]): Error {
  if (error instanceof AgentAdapterFailure) return error;
  if (error instanceof acp.RequestError) {
    return error.code === -32_000
      ? new AgentAdapterFailure('AGENT_AUTHENTICATION_REQUIRED')
      : new AgentAdapterFailure('AGENT_PROTOCOL_REQUEST_FAILED', `code=${error.code}`);
  }
  if (error instanceof Error) {
    const message = redactSecrets(error.message, secretValues);
    const code = /^([A-Z][A-Z0-9_]+)(?::|$)/.exec(message)?.[1];
    if (code !== undefined) return new AgentAdapterFailure(code, message.slice(code.length + 1).trim() || undefined);
  }
  return new AgentAdapterFailure('AGENT_CONNECTION_FAILED');
}

function failureLatch(): {
  readonly promise: Promise<never>;
  readonly fail: (error: unknown) => void;
} {
  let rejectFailure: ((error: unknown) => void) | undefined;
  let failed = false;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  return {
    promise,
    fail: (error: unknown): void => {
      if (failed) return;
      failed = true;
      rejectFailure?.(error);
    },
  };
}

function failureDeadline(timeoutMs: number, code: string): {
  readonly promise: Promise<never>;
  readonly cancel: () => void;
} {
  let timeout: NodeJS.Timeout | undefined = setTimeout(() => {
    timeout = undefined;
    rejectDeadline?.(new AgentAdapterFailure(code));
  }, timeoutMs);
  timeout.unref();
  let rejectDeadline: ((error: unknown) => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  return {
    promise,
    cancel: (): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      timeout = undefined;
    },
  };
}

async function containNotificationFailure(
  operation: () => Promise<void>,
  onFatal: (error: unknown) => void,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    onFatal(error);
  }
}

function toAcpMcpServer(server: AgentMcpServer): acp.McpServer {
  if ('command' in server) {
    return {
      name: server.name,
      command: server.command,
      args: [...server.args],
      env: server.env.map((item) => ({ ...item })),
    };
  }
  if (server.type === 'acp') return { ...server };
  return {
    type: server.type,
    name: server.name,
    url: server.url,
    headers: server.headers.map((item) => ({ ...item })),
  };
}

function processEnvironment(
  profile: AgentProfile,
  source: NodeJS.ProcessEnv,
  secrets: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const essentials = process.platform === 'win32'
    ? ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'TEMP', 'TMP']
    : ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'USER', 'LOGNAME', 'SHELL'];
  for (const key of essentials) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  for (const [name, value] of Object.entries(secrets)) result[name] = value;
  for (const targetName of Object.keys(profile.envRefs)) {
    if (secrets[targetName] === undefined) delete result[targetName];
  }
  return result;
}
