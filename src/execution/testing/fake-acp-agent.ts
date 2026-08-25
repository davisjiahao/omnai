import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import {
  Readable as NodeReadable,
  Writable as NodeWritable,
} from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import {
  ensureDir,
  readTextIfExists,
  writeTextAtomic,
} from '../../core/files.js';
import { withMutationLockAtPath } from '../mutation-lock.js';
import {
  normalizedPermissionRequestSchema,
  type PermissionRequest,
} from '../agents/policy.js';

const fakeAgentStepSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('permission'),
    request: normalizedPermissionRequestSchema,
  }),
  z.strictObject({
    kind: z.literal('write'),
    relativePath: z.string().min(1),
    content: z.string(),
  }),
  z.strictObject({
    kind: z.literal('update'),
    update: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    kind: z.literal('result'),
    value: z.unknown(),
  }),
  z.strictObject({
    kind: z.literal('pause'),
    token: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('exit'),
    code: z.number().int(),
  }),
]);

export const fakeAgentScriptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  agentId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).default('fake-acp'),
  capabilities: z.strictObject({
    loadSession: z.boolean(),
    resumeSession: z.boolean(),
    closeSession: z.boolean(),
    additionalDirectories: z.boolean(),
  }),
  steps: z.array(fakeAgentStepSchema),
});

export type FakeAgentScript = z.infer<typeof fakeAgentScriptSchema>;

export interface FakeAgentOptions {
  readonly stateDirectory: string;
  readonly now?: () => string;
  readonly onExit?: (code: number) => void;
}

export interface FakeAgentCounters {
  readonly sessions: number;
  readonly prompts: number;
}

const fakeSessionSchema = z.strictObject({
  cwd: z.string().min(1),
  additionalDirectories: z.array(z.string()),
  runId: z.string().regex(/^RUN-\d{4}$/).nullable(),
  closed: z.boolean(),
  cancelled: z.boolean(),
  updatedAt: z.string().datetime(),
});

const fakeAgentStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  nextSession: z.number().int().positive(),
  sessions: z.record(z.string(), fakeSessionSchema),
  counters: z.record(z.string(), z.strictObject({
    sessions: z.number().int().nonnegative(),
    prompts: z.number().int().nonnegative(),
  })),
  pauseTokens: z.record(z.string(), z.string()),
});

type FakeAgentState = z.infer<typeof fakeAgentStateSchema>;

const INITIAL_STATE: FakeAgentState = {
  schemaVersion: 1,
  nextSession: 1,
  sessions: {},
  counters: {},
  pauseTokens: {},
};

/**
 * Connect a deterministic ACP v1 Agent to the supplied NDJSON streams.
 * All cross-process identity and counter state is kept in stateDirectory.
 */
export function runFakeAcpAgent(
  input: Readable,
  output: Writable,
  scriptInput: FakeAgentScript,
  options?: FakeAgentOptions,
): acp.AgentConnection {
  const script = fakeAgentScriptSchema.parse(scriptInput);
  const stateDirectory = options?.stateDirectory ?? process.env.OMNAI_FAKE_AGENT_STATE;
  if (stateDirectory === undefined || stateDirectory.length === 0) {
    throw new Error('FAKE_AGENT_STATE_DIRECTORY_REQUIRED');
  }
  const now = options?.now ?? (() => new Date().toISOString());
  const state = new FakeStateStore(stateDirectory);

  const app = acp.agent({ name: 'omnai-fake-agent' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: script.capabilities.loadSession,
        sessionCapabilities: {
          list: {},
          ...(script.capabilities.resumeSession ? { resume: {} } : {}),
          ...(script.capabilities.closeSession ? { close: {} } : {}),
          ...(script.capabilities.additionalDirectories ? { additionalDirectories: {} } : {}),
        },
      },
      agentInfo: { name: script.agentId, version: '1.0.0' },
    }))
    .onRequest(acp.methods.agent.session.list, async () => {
      const current = await state.read();
      return {
        sessions: Object.entries(current.sessions)
          .filter(([, session]) => !session.closed)
          .sort(([left], [right]) => compare(left, right))
          .map(([sessionId, session]) => ({
            sessionId,
            cwd: session.cwd,
            additionalDirectories: session.additionalDirectories,
            updatedAt: session.updatedAt,
          })),
      };
    })
    .onRequest(acp.methods.agent.session.new, async ({ params }) => {
      const sessionId = await state.update((current) => {
        const id = `fake-${String(current.nextSession).padStart(4, '0')}`;
        current.nextSession += 1;
        current.sessions[id] = {
          cwd: params.cwd,
          additionalDirectories: [...(params.additionalDirectories ?? [])],
          runId: null,
          closed: false,
          cancelled: false,
          updatedAt: now(),
        };
        return id;
      });
      return { sessionId };
    })
    .onRequest(acp.methods.agent.session.load, async ({ params }) => {
      if (!script.capabilities.loadSession) throw new Error('FAKE_LOAD_SESSION_UNSUPPORTED');
      await state.requireSession(params.sessionId);
      return {};
    })
    .onRequest(acp.methods.agent.session.resume, async ({ params }) => {
      if (!script.capabilities.resumeSession) throw new Error('FAKE_RESUME_SESSION_UNSUPPORTED');
      await state.requireSession(params.sessionId);
      return {};
    })
    .onRequest(acp.methods.agent.session.close, async ({ params }) => {
      if (!script.capabilities.closeSession) throw new Error('FAKE_CLOSE_SESSION_UNSUPPORTED');
      await state.update((current) => {
        const session = requireSession(current, params.sessionId);
        session.closed = true;
        session.updatedAt = now();
      });
      return {};
    })
    .onNotification(acp.methods.agent.session.cancel, async ({ params }) => {
      await state.update((current) => {
        const session = requireSession(current, params.sessionId);
        session.cancelled = true;
        session.updatedAt = now();
      });
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      const prompt = promptText(params.prompt);
      const runId = requirePromptRunId(prompt);
      const session = await state.update((current) => {
        const found = requireSession(current, params.sessionId);
        if (found.closed) throw new Error(`FAKE_SESSION_CLOSED: ${params.sessionId}`);
        if (found.runId !== null && found.runId !== runId) {
          throw new Error(`FAKE_SESSION_RUN_MISMATCH: ${params.sessionId}`);
        }
        const counter = current.counters[runId] ?? { sessions: 0, prompts: 0 };
        if (found.runId === null) {
          found.runId = runId;
          counter.sessions += 1;
        }
        counter.prompts += 1;
        current.counters[runId] = counter;
        found.updatedAt = now();
        return structuredClone(found);
      });

      for (const step of script.steps) {
        if (step.kind === 'permission') {
          await requestPermission(client, params.sessionId, step.request);
        } else if (step.kind === 'write') {
          const path = safeRelativePath(session.cwd, step.relativePath);
          await client.request(acp.methods.client.fs.writeTextFile, {
            sessionId: params.sessionId,
            path,
            content: step.content,
          });
        } else if (step.kind === 'update') {
          await client.notify(acp.methods.client.session.update, {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: JSON.stringify(step.update) },
            },
          });
        } else if (step.kind === 'result') {
          await client.request(acp.methods.client.fs.writeTextFile, {
            sessionId: params.sessionId,
            path: requireOutputPath(prompt),
            content: JSON.stringify(materializeResult(step.value, {
              runId,
              packetHash: requirePromptPacketHash(prompt),
            })),
          });
        } else if (step.kind === 'pause') {
          await state.update((current) => {
            current.pauseTokens[params.sessionId] = step.token;
          });
          await waitUntilCancelled(state, params.sessionId);
          return { stopReason: 'cancelled' as const };
        } else {
          options?.onExit?.(step.code);
          throw new Error(`FAKE_AGENT_EXIT: ${step.code}`);
        }
      }
      return { stopReason: 'end_turn' as const };
    });

  return app.connect(acp.ndJsonStream(
    NodeWritable.toWeb(output),
    NodeReadable.toWeb(input) as ReadableStream<Uint8Array>,
  ));
}

export async function readFakeAgentCounters(
  stateDirectory: string,
  runId: string,
): Promise<FakeAgentCounters> {
  const state = await new FakeStateStore(stateDirectory).read();
  const counters = state.counters[runId] ?? { sessions: 0, prompts: 0 };
  return { sessions: counters.sessions, prompts: counters.prompts };
}

export async function readFakeAgentPauseToken(
  stateDirectory: string,
  sessionId: string,
): Promise<string | null> {
  const state = await new FakeStateStore(stateDirectory).read();
  return state.pauseTokens[sessionId] ?? null;
}

class FakeStateStore {
  private readonly path: string;
  private readonly lockPath: string;

  constructor(private readonly directory: string) {
    this.path = resolve(directory, 'state.json');
    this.lockPath = resolve(directory, '.state.lock');
  }

  async read(): Promise<FakeAgentState> {
    const text = await readTextIfExists(this.path);
    return text === null
      ? structuredClone(INITIAL_STATE)
      : fakeAgentStateSchema.parse(JSON.parse(text));
  }

  async update<T>(mutate: (state: FakeAgentState) => T | Promise<T>): Promise<T> {
    await ensureDir(this.directory);
    return withMutationLockAtPath(this.lockPath, async () => {
      const current = await this.read();
      const result = await mutate(current);
      await writeTextAtomic(this.path, `${JSON.stringify(fakeAgentStateSchema.parse(current))}\n`);
      return result;
    });
  }

  async requireSession(sessionId: string): Promise<void> {
    const current = await this.read();
    requireSession(current, sessionId);
  }
}

function requireSession(state: FakeAgentState, sessionId: string) {
  const session = state.sessions[sessionId];
  if (session === undefined) throw new Error(`FAKE_SESSION_NOT_FOUND: ${sessionId}`);
  return session;
}

function promptText(blocks: readonly acp.ContentBlock[]): string {
  return blocks
    .map((block) => block.type === 'text' && 'text' in block && typeof block.text === 'string'
      ? block.text
      : '')
    .filter((text) => text.length > 0)
    .join('\n');
}

function requirePromptRunId(prompt: string): string {
  const match = /^Run ID: (RUN-\d{4})$/mu.exec(prompt);
  if (!match?.[1]) throw new Error('FAKE_PROMPT_RUN_ID_MISSING');
  return match[1];
}

function requirePromptPacketHash(prompt: string): string {
  const match = /^Packet hash: (sha256:[0-9a-f]{64})$/mu.exec(prompt);
  if (!match?.[1]) throw new Error('FAKE_PROMPT_PACKET_HASH_MISSING');
  return match[1];
}

function materializeResult(
  value: unknown,
  bindings: { readonly runId: string; readonly packetHash: string },
): unknown {
  if (typeof value === 'string') {
    return value
      .replaceAll('{{RUN_ID}}', bindings.runId)
      .replaceAll('{{PACKET_HASH}}', bindings.packetHash);
  }
  if (Array.isArray(value)) return value.map((item) => materializeResult(item, bindings));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, materializeResult(child, bindings)]),
  );
}

function requireOutputPath(prompt: string): string {
  const match = /^Write exactly one .+ artifact to (.+)\.$/mu.exec(prompt);
  const path = match?.[1];
  if (!path || !isAbsolute(path) || resolve(path) !== path) {
    throw new Error('FAKE_PROMPT_OUTPUT_PATH_MISSING');
  }
  return path;
}

function safeRelativePath(cwd: string, path: string): string {
  if (isAbsolute(path)) throw new Error('FAKE_WRITE_PATH_ABSOLUTE');
  const absolute = resolve(cwd, path);
  const child = relative(cwd, absolute);
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error('FAKE_WRITE_PATH_OUTSIDE_CWD');
  }
  return absolute;
}

async function requestPermission(
  client: acp.AgentContext,
  sessionId: string,
  request: PermissionRequest,
): Promise<void> {
  const common = {
    sessionId,
    options: request.options.map((option) => ({ ...option })),
  };
  if (request.kind === 'read-file' || request.kind === 'write-file') {
    await client.request(acp.methods.client.session.requestPermission, {
      ...common,
      toolCall: {
        toolCallId: `fake:${request.kind}:${request.path}`,
        title: `${request.kind} ${request.path}`,
        kind: request.kind === 'read-file' ? 'read' : 'edit',
        status: 'pending',
        locations: [{ path: request.path }],
        rawInput: { path: request.path },
      },
    });
  } else if (request.kind === 'terminal') {
    await client.request(acp.methods.client.session.requestPermission, {
      ...common,
      toolCall: {
        toolCallId: `fake:terminal:${request.command.join(':')}`,
        title: `execute ${request.command[0]}`,
        kind: 'execute',
        status: 'pending',
        rawInput: { command: [...request.command], cwd: request.cwd },
      },
    });
  } else {
    await client.request(acp.methods.client.session.requestPermission, {
      ...common,
      toolCall: {
        toolCallId: `fake:network:${request.host}`,
        title: `fetch ${request.host}`,
        kind: 'fetch',
        status: 'pending',
        rawInput: { host: request.host },
      },
    });
  }
}

async function waitUntilCancelled(state: FakeStateStore, sessionId: string): Promise<void> {
  for (;;) {
    if ((await state.read()).sessions[sessionId]?.cancelled === true) return;
    await new Promise<void>((resolveDelay) => {
      const timer = setTimeout(resolveDelay, 10);
      timer.unref();
    });
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function runFakeAgentCli(argv: readonly string[]): Promise<void> {
  const options = parseCliOptions(argv);
  const script = fakeAgentScriptSchema.parse(JSON.parse(await readFile(options.scriptPath, 'utf8')));
  const connection = runFakeAcpAgent(process.stdin, process.stdout, script, {
    stateDirectory: options.stateDirectory,
    onExit: (code) => {
      process.exitCode = code;
      process.stdin.destroy();
    },
  });
  await connection.closed;
}

function parseCliOptions(argv: readonly string[]): { scriptPath: string; stateDirectory: string } {
  let scriptPath: string | undefined;
  let stateDirectory: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if ((argument === '--script' || argument === '--state') && value === undefined) {
      throw new Error(`FAKE_AGENT_CLI_VALUE_REQUIRED: ${argument}`);
    }
    if (argument === '--script') {
      scriptPath = resolve(value!);
      index += 1;
    } else if (argument === '--state') {
      stateDirectory = resolve(value!);
      index += 1;
    } else {
      throw new Error(`FAKE_AGENT_CLI_ARGUMENT_UNKNOWN: ${String(argument)}`);
    }
  }
  if (scriptPath === undefined || stateDirectory === undefined) {
    throw new Error('FAKE_AGENT_CLI_USAGE: --script <path> --state <directory>');
  }
  return { scriptPath, stateDirectory };
}

const entryPath = process.argv[1];
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  void runFakeAgentCli(process.argv.slice(2)).catch(() => {
    process.stderr.write('FAKE_ACP_AGENT_FAILED\n');
    process.exitCode = 1;
  });
}
