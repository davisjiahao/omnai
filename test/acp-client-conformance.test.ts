import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';
import { hashObject } from '../src/execution/hashing.js';
import { createRunPacket, renderRunPrompt, type RunPacketInput } from '../src/execution/packets.js';
import { AcpAgentAdapter, type AcpProcessHandle } from '../src/execution/agents/acp-client.js';
import {
  fakeAgentScriptSchema,
  readFakeAgentCounters,
  runFakeAcpAgent,
} from '../src/execution/testing/fake-acp-agent.js';
import { NativeAdapterRegistry } from '../src/execution/agents/native-adapter.js';
import { runAgentConformance } from '../src/execution/agents/conformance.js';
import type {
  AgentSessionAdapter,
  AgentSessionHooks,
  AgentSessionRequest,
  AgentResumeRequest,
  AgentSignalRequest,
  NormalizedAgentEvent,
} from '../src/execution/agents/types.js';
import { projectTestCaseRef } from '../src/execution/types.js';
import { createTestDirectory } from './helpers.js';

const NOW = '2026-08-16T00:00:00.000Z';
const HASH_A = hashObject('a');
const HASH_B = hashObject('b');
const HASH_C = hashObject('c');
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

type WriterPacketInput = Extract<RunPacketInput, { kind: 'PROJECT_WRITER' }>;

function writerPacketInput(worktree: string): WriterPacketInput {
  return {
    schemaVersion: 1,
    id: 'RUN-0001',
    kind: 'PROJECT_WRITER',
    worksetId: 'WKS-0001',
    waveId: 'WAVE-0001',
    scopedTask: {
      project: 'quote-center', changeId: 'CHG-0001', revision: 'REV-0001',
      baseline: 'BL-0001', taskId: 'TASK-001',
    },
    git: { startingHead: 'a'.repeat(40), worktree, branch: 'omnai/WKS-0001-quote' },
    contracts: [{ id: 'CTR-0001', contentHash: HASH_B }],
    objective: 'Implement authorization v2',
    protocolIds: ['execution.project-writer'],
    allowedPaths: ['src/**', 'test/**'],
    verificationCommands: ['npm test'],
    verificationPlan: { id: 'VPL-0001', contentHash: HASH_C },
    testCaseRefs: [projectTestCaseRef({
      project: 'quote-center', changeId: 'CHG-0001', revision: 'REV-0001',
    }, 'TC-0010', HASH_A)],
    commandRefs: ['quote.unit'],
    evidenceRequired: ['test-results'],
    stopConditions: ['signal stale contract'],
    agent: { agentId: 'codex', protocol: 'acp', role: 'project-writer' },
    limits: { timeoutMs: 10_000, maxOutputBytes: 1_048_576 },
    permissionPolicy: {
      filesystemRoots: [worktree], terminal: true, network: 'DENY',
      denyGitCommit: true, denyNestedOmnai: true,
    },
    createdAt: NOW,
  };
}

function agentProfile() {
  return {
    schemaVersion: 1 as const,
    agentId: 'codex',
    protocol: 'acp' as const,
    command: 'fake-acp-agent',
    args: [],
    envRefs: {},
    protocolVersion: 1 as const,
    priority: 100,
    costClass: 'MEDIUM' as const,
    maxParallelSessions: 1,
    isolation: { mode: 'agent-sandbox' as const, enforcedWorkspaceRoots: true },
    capabilities: {
      loadSession: true,
      resumeSession: true,
      closeSession: true,
      additionalDirectories: true,
      mcpStdio: true,
    },
    omnaiModes: ['project-writer' as const],
  };
}

async function sessionRequest(options: {
  timeoutMs?: number;
  maxOutputBytes?: number;
} = {}): Promise<AgentSessionRequest> {
  const directory = await createTestDirectory('omnai-acp-writer-');
  cleanups.push(directory.cleanup);
  const packet = createRunPacket({
    ...writerPacketInput(directory.root),
    limits: {
      timeoutMs: options.timeoutMs ?? 10_000,
      maxOutputBytes: options.maxOutputBytes ?? 1_048_576,
    },
  });
  return {
    profile: agentProfile(),
    packet,
    cwd: directory.root,
    additionalDirectories: [],
    mcpServers: [],
    prompt: 'Implement the immutable Run Packet.',
    outputPath: join(directory.root, '.omnai-output', 'result.json'),
  };
}

class InMemoryAcpProcess extends EventEmitter implements AcpProcessHandle {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 42_001;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  private connection: acp.AgentConnection | undefined;

  connect(app: acp.AgentApp): void {
    this.connection = app.connect(acp.ndJsonStream(
      Writable.toWeb(this.stdout),
      Readable.toWeb(this.stdin) as ReadableStream<Uint8Array>,
    ));
  }

  sendRaw(value: string | Buffer): void {
    this.stdout.write(value);
  }

  exit(code = 1): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.stdin.destroy();
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => {
      this.emit('exit', code, null);
      this.emit('close', code, null);
    });
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.killed) return true;
    this.killed = true;
    this.signalCode = signal;
    this.connection?.close();
    this.stdin.destroy();
    this.stdout.destroy();
    this.stderr.destroy();
    queueMicrotask(() => {
      this.emit('exit', this.exitCode, signal);
      this.emit('close', this.exitCode, signal);
    });
    return true;
  }
}

function createScriptedAcpPeer(options: {
  sessionId?: string;
  stopReason?: acp.StopReason;
  onPrompt?: (client: acp.AgentContext, sessionId: string) => Promise<void>;
  capabilities?: { resume?: boolean; load?: boolean; close?: boolean };
  initializeError?: Error;
} = {}) {
  const sessionId = options.sessionId ?? 'sess-one';
  const stopReason = options.stopReason ?? 'end_turn';
  const requests: Array<{ method: string; params: unknown }> = [];
  const order: string[] = [];
  const sessionMethods: string[] = [];
  let promptAllowed = false;
  const capabilities = {
    resume: options.capabilities?.resume ?? true,
    load: options.capabilities?.load ?? true,
    close: options.capabilities?.close ?? true,
  };

  const spawn = (): AcpProcessHandle => {
    const process = new InMemoryAcpProcess();
    const app = acp.agent({ name: 'scripted-test-agent' })
      .onRequest(acp.methods.agent.initialize, ({ params }) => {
        requests.push({ method: acp.methods.agent.initialize, params });
        if (options.initializeError !== undefined) throw options.initializeError;
        return {
          protocolVersion: acp.PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: capabilities.load,
            sessionCapabilities: {
              ...(capabilities.resume ? { resume: {} } : {}),
              ...(capabilities.close ? { close: {} } : {}),
              additionalDirectories: {},
            },
          },
          agentInfo: { name: 'scripted-test-agent', version: '1.0.0' },
        };
      })
      .onRequest(acp.methods.agent.session.new, ({ params }) => {
        requests.push({ method: acp.methods.agent.session.new, params });
        return { sessionId };
      })
      .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
        requests.push({ method: acp.methods.agent.session.prompt, params });
        order.push('prompt');
        if (!promptAllowed) throw new Error('PROMPT_SENT_BEFORE_INTENT_PERSISTED');
        await options.onPrompt?.(client, params.sessionId);
        return { stopReason };
      })
      .onRequest(acp.methods.agent.session.resume, ({ params }) => {
        requests.push({ method: acp.methods.agent.session.resume, params });
        sessionMethods.push(acp.methods.agent.session.resume);
        return {};
      })
      .onRequest(acp.methods.agent.session.load, ({ params }) => {
        requests.push({ method: acp.methods.agent.session.load, params });
        sessionMethods.push(acp.methods.agent.session.load);
        return {};
      })
      .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
        requests.push({ method: acp.methods.agent.session.cancel, params });
        sessionMethods.push(acp.methods.agent.session.cancel);
      })
      .onRequest(acp.methods.agent.session.close, ({ params }) => {
        requests.push({ method: acp.methods.agent.session.close, params });
        sessionMethods.push(acp.methods.agent.session.close);
        return {};
      });
    process.connect(app);
    return process;
  };

  return {
    spawn,
    requests,
    order,
    sessionMethods,
    allowPrompt(): void { promptAllowed = true; },
  };
}

function createRawPeer(action: (process: InMemoryAcpProcess) => void): {
  spawn: () => AcpProcessHandle;
} {
  return {
    spawn: () => {
      const process = new InMemoryAcpProcess();
      queueMicrotask(() => action(process));
      return process;
    },
  };
}

function automaticHooks(
  peer: ReturnType<typeof createScriptedAcpPeer>,
): AgentSessionHooks {
  return {
    onSessionCreated: async () => undefined,
    onPromptIntent: async () => { peer.allowPrompt(); },
    onEvent: async () => undefined,
  };
}

function permissionRequest(sessionId: string, path: string): acp.RequestPermissionRequest {
  return {
    sessionId,
    toolCall: {
      toolCallId: `write:${path}`,
      title: `Write ${path}`,
      kind: 'edit',
      status: 'pending',
      locations: [{ path }],
      rawInput: { path },
    },
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ],
  };
}

async function resumeRequest(
  sessionId: string,
  options: { timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<AgentResumeRequest> {
  const { prompt: _prompt, ...request } = await sessionRequest(options);
  return {
    ...request,
    record: {
      schemaVersion: 1,
      machineVersion: 1,
      lastEventSequence: 0,
      lastEventHash: null,
      runId: request.packet.id,
      agentId: request.profile.agentId,
      protocol: 'acp',
      sessionId,
      processId: 42_001,
      promptState: 'OUTCOME_UNCERTAIN',
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

async function signalRequest(
  sessionId: string,
  options: { timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<AgentSignalRequest> {
  const request = await resumeRequest(sessionId, options);
  return {
    profile: request.profile,
    packet: request.packet,
    record: request.record,
    signal: 'STOP',
  };
}

test('initializes ACP v1, persists session ID, then sends one prompt', async () => {
  const peer = createScriptedAcpPeer({ sessionId: 'sess-one', stopReason: 'end_turn' });
  const adapter = new AcpAgentAdapter({ spawn: peer.spawn });
  const hooks: AgentSessionHooks = {
    onSessionCreated: async (record) => {
      peer.order.push(`persist:start:${record.sessionId}`);
      await new Promise<void>((resolve) => setImmediate(resolve));
      peer.order.push(`persist:done:${record.sessionId}`);
    },
    onPromptIntent: async () => {
      peer.order.push('intent:start');
      await new Promise<void>((resolve) => setImmediate(resolve));
      peer.allowPrompt();
      peer.order.push('intent:done');
    },
    onEvent: async () => undefined,
  };

  const result = await adapter.start(await sessionRequest(), hooks);
  peer.order.push(`finish:${result.stopReason}`);

  assert.deepEqual(peer.order, [
    'persist:start:sess-one',
    'persist:done:sess-one',
    'intent:start',
    'intent:done',
    'prompt',
    'finish:end_turn',
  ]);
  assert.equal(
    peer.requests.filter((item) => item.method === acp.methods.agent.session.prompt).length,
    1,
  );
});

test('deterministic Fake ACP Agent persists one session and one prompt across ACP transport', async () => {
  const state = await createTestDirectory('omnai-fake-acp-state-');
  cleanups.push(state.cleanup);
  const base = await sessionRequest();
  const request: AgentSessionRequest = {
    ...base,
    prompt: await renderRunPrompt(base.packet, base.outputPath),
  };
  await mkdir(join(request.cwd, '.omnai-output'), { recursive: true });
  const script = fakeAgentScriptSchema.parse({
    schemaVersion: 1,
    capabilities: {
      loadSession: true,
      resumeSession: true,
      closeSession: true,
      additionalDirectories: true,
    },
    steps: [
      { kind: 'update', update: { message: 'working' } },
      { kind: 'result', value: { ok: true } },
    ],
  });
  const spawn = (): AcpProcessHandle => {
    const process = new InMemoryAcpProcess();
    runFakeAcpAgent(process.stdin, process.stdout, script, { stateDirectory: state.root });
    return process;
  };
  const events: NormalizedAgentEvent[] = [];

  const result = await new AcpAgentAdapter({ spawn }).start(request, {
    onSessionCreated: async () => undefined,
    onPromptIntent: async () => undefined,
    onEvent: async (event) => { events.push(event); },
  });

  assert.equal(result.stopReason, 'end_turn');
  assert.deepEqual(JSON.parse(await readFile(request.outputPath, 'utf8')), { ok: true });
  assert.deepEqual(await readFakeAgentCounters(state.root, request.packet.id), {
    sessions: 1,
    prompts: 1,
  });
  assert.equal(events.length, 1);
});

test('Fake ACP Agent executable serves the same deterministic contract over stdio', async () => {
  const state = await createTestDirectory('omnai-fake-acp-state-');
  cleanups.push(state.cleanup);
  const base = await sessionRequest();
  const executable = fileURLToPath(new URL('../src/execution/testing/fake-acp-agent.js', import.meta.url));
  const scriptPath = join(state.root, 'script.json');
  await writeFile(scriptPath, JSON.stringify({
    schemaVersion: 1,
    capabilities: {
      loadSession: true,
      resumeSession: true,
      closeSession: true,
      additionalDirectories: true,
    },
    steps: [{ kind: 'result', value: { executable: true } }],
  }), 'utf8');
  const request: AgentSessionRequest = {
    ...base,
    profile: {
      ...base.profile,
      command: process.execPath,
      args: [executable, '--script', scriptPath, '--state', state.root],
    },
    prompt: await renderRunPrompt(base.packet, base.outputPath),
  };
  await mkdir(join(request.cwd, '.omnai-output'), { recursive: true });

  const result = await new AcpAgentAdapter().start(request, {
    onSessionCreated: async () => undefined,
    onPromptIntent: async () => undefined,
    onEvent: async () => undefined,
  });

  assert.equal(result.stopReason, 'end_turn');
  assert.deepEqual(JSON.parse(await readFile(request.outputPath, 'utf8')), { executable: true });
  assert.deepEqual(await readFakeAgentCounters(state.root, request.packet.id), {
    sessions: 1,
    prompts: 1,
  });
});

test('reusable conformance harness runs against AcpAgentAdapter and the Fake executable', async () => {
  const fixture = await createTestDirectory('omnai-fake-conformance-');
  cleanups.push(fixture.cleanup);
  const executable = fileURLToPath(new URL('../src/execution/testing/fake-acp-agent.js', import.meta.url));
  const scriptPath = join(fixture.root, 'script.json');
  const stateDirectory = join(fixture.root, 'state');
  const readonlyRoot = join(fixture.root, 'readonly');
  const writerRoot = join(fixture.root, 'writer');
  const outputRoot = join(fixture.root, 'output');
  await mkdir(readonlyRoot, { recursive: true });
  await writeFile(scriptPath, JSON.stringify({
    schemaVersion: 1,
    capabilities: {
      loadSession: true,
      resumeSession: true,
      closeSession: true,
      additionalDirectories: true,
    },
    steps: [
      { kind: 'update', update: { status: 'working' } },
      {
        kind: 'result',
        value: {
          schemaVersion: 1,
          runId: '{{RUN_ID}}',
          packetHash: '{{PACKET_HASH}}',
          findingId: 'FND-0001',
          project: 'conformance-project',
          candidateHash: HASH_A,
          disposition: 'ACCEPT',
          resolution: 'NONE',
          summary: 'Fake Agent conformance finding.',
          evidenceRefs: [],
          candidateOptions: [],
        },
      },
    ],
  }), 'utf8');
  const configured = {
    ...agentProfile(),
    command: process.execPath,
    args: [executable, '--script', scriptPath, '--state', stateDirectory],
    omnaiModes: ['coordination-read-only' as const],
  };
  const probe = {
    schemaVersion: 1 as const,
    agentId: configured.agentId,
    available: true,
    authenticated: true,
    protocolVersion: 1,
    health: 'HEALTHY' as const,
    activeSessions: 0,
    capabilities: configured.capabilities,
    conformanceInputHash: HASH_B,
  };

  const report = await runAgentConformance(() => new AcpAgentAdapter(), {
    adapterId: 'acp-v1',
    inputHash: HASH_B,
    roles: configured.omnaiModes,
    profile: configured,
    probe,
    readonlyRoot,
    writerRoot,
    outputRoot,
    now: () => NOW,
  });

  assert.equal(
    report.passed,
    true,
    JSON.stringify(report.cases.filter((item) => item.status === 'FAIL')),
  );
  assert.deepEqual(await readFakeAgentCounters(stateDirectory, 'RUN-0001'), {
    sessions: 1,
    prompts: 1,
  });
});

test('Native registry returns the shared Adapter contract and rejects duplicate protocol IDs', () => {
  const registry = new NativeAdapterRegistry();
  const expected = {} as AgentSessionAdapter;
  let createdFor: string | undefined;

  registry.register('native', (profile) => {
    createdFor = profile.agentId;
    return expected;
  });

  assert.equal(registry.create({ ...agentProfile(), agentId: 'native-one', protocol: 'native' }), expected);
  assert.equal(createdFor, 'native-one');
  assert.throws(
    () => registry.register('native', () => expected),
    /NATIVE_ADAPTER_PROTOCOL_DUPLICATE: native/,
  );
});

test('maps packet policy to allow-once or rejection without human elicitation', async () => {
  const request = await sessionRequest();
  const outside = await createTestDirectory('omnai-acp-outside-');
  cleanups.push(outside.cleanup);
  const permissionOutcomes: string[] = [];
  const peer = createScriptedAcpPeer({
    onPrompt: async (client, sessionId) => {
      for (const path of [join(request.cwd, 'src', 'auth.ts'), join(outside.root, 'auth.ts')]) {
        const response = await client.request(
          acp.methods.client.session.requestPermission,
          permissionRequest(sessionId, path),
        );
        const outcome = response.outcome;
        const selected = outcome.outcome === 'selected'
          ? permissionRequest(sessionId, path).options.find(
              (option) => option.optionId === outcome.optionId,
            )?.kind
          : 'cancelled';
        permissionOutcomes.push(selected ?? 'unknown');
      }
    },
  });

  await new AcpAgentAdapter({ spawn: peer.spawn }).start(request, automaticHooks(peer));

  assert.deepEqual(permissionOutcomes, ['allow_once', 'reject_once']);
});

test('terminal lifecycle is argv-based, root-bounded, output-bounded, and released', async () => {
  const request = await sessionRequest();
  const terminalLifecycle: string[] = [];
  let output = '';
  const peer = createScriptedAcpPeer({
    onPrompt: async (client, sessionId) => {
      terminalLifecycle.push(acp.methods.client.terminal.create);
      const created = await client.request(acp.methods.client.terminal.create, {
        sessionId,
        command: process.execPath,
        args: ['-e', 'process.stdout.write("ok")'],
        cwd: request.cwd,
        outputByteLimit: 64,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      terminalLifecycle.push(acp.methods.client.terminal.output);
      const current = await client.request(acp.methods.client.terminal.output, {
        sessionId,
        terminalId: created.terminalId,
      });
      terminalLifecycle.push(acp.methods.client.terminal.waitForExit);
      await client.request(acp.methods.client.terminal.waitForExit, {
        sessionId,
        terminalId: created.terminalId,
      });
      output = current.output || (await client.request(acp.methods.client.terminal.output, {
        sessionId,
        terminalId: created.terminalId,
      })).output;
      terminalLifecycle.push(acp.methods.client.terminal.release);
      await client.request(acp.methods.client.terminal.release, {
        sessionId,
        terminalId: created.terminalId,
      });
    },
  });

  await new AcpAgentAdapter({ spawn: peer.spawn }).start(request, automaticHooks(peer));

  assert.deepEqual(terminalLifecycle, [
    'terminal/create',
    'terminal/output',
    'terminal/wait_for_exit',
    'terminal/release',
  ]);
  assert.equal(output, 'ok');
});

test('terminal output reports truncation introduced by secret redaction expansion', async () => {
  const secret = 'x';
  const base = await sessionRequest();
  const request: AgentSessionRequest = {
    ...base,
    profile: { ...base.profile, envRefs: { API_TOKEN: 'TEST_TERMINAL_SECRET' } },
  };
  let terminalOutput: acp.TerminalOutputResponse | undefined;
  const peer = createScriptedAcpPeer({
    onPrompt: async (client, sessionId) => {
      const created = await client.request(acp.methods.client.terminal.create, {
        sessionId,
        command: process.execPath,
        args: ['-e', 'process.stdout.write(process.env.VALUE ?? "")'],
        cwd: request.cwd,
        env: [{ name: 'VALUE', value: secret }],
        outputByteLimit: 8,
      });
      await client.request(acp.methods.client.terminal.waitForExit, {
        sessionId,
        terminalId: created.terminalId,
      });
      terminalOutput = await client.request(acp.methods.client.terminal.output, {
        sessionId,
        terminalId: created.terminalId,
      });
      await client.request(acp.methods.client.terminal.release, {
        sessionId,
        terminalId: created.terminalId,
      });
    },
  });

  await new AcpAgentAdapter({
    spawn: peer.spawn,
    environment: { ...process.env, TEST_TERMINAL_SECRET: secret },
  }).start(request, automaticHooks(peer));

  assert.equal(terminalOutput?.truncated, true);
  assert.ok(Buffer.byteLength(terminalOutput?.output ?? '') <= 8);
  assert.doesNotMatch(terminalOutput?.output ?? '', new RegExp(secret));
});

test('filesystem handlers enforce packet roots and allowed paths independently of permission prompts', async () => {
  const request = await sessionRequest();
  const sourceDirectory = join(request.cwd, 'src');
  const allowedPath = join(sourceDirectory, 'auth.ts');
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(allowedPath, 'before', 'utf8');
  const outside = await createTestDirectory('omnai-acp-fs-outside-');
  cleanups.push(outside.cleanup);
  let observed = '';
  const peer = createScriptedAcpPeer({
    onPrompt: async (client, sessionId) => {
      await client.request(acp.methods.client.fs.writeTextFile, {
        sessionId,
        path: allowedPath,
        content: 'after',
      });
      observed = (await client.request(acp.methods.client.fs.readTextFile, {
        sessionId,
        path: allowedPath,
      })).content;
      await assert.rejects(
        () => client.request(acp.methods.client.fs.writeTextFile, {
          sessionId,
          path: join(outside.root, 'escaped.ts'),
          content: 'forbidden',
        }),
        /FILESYSTEM_NOT_AUTHORIZED: PATH_OUTSIDE_PACKET_ROOTS/,
      );
    },
  });

  await new AcpAgentAdapter({ spawn: peer.spawn }).start(request, automaticHooks(peer));

  assert.equal(observed, 'after');
  assert.equal(await readFile(allowedPath, 'utf8'), 'after');
});

test('filesystem handlers grant one exact Run output path without broadening project writes', async () => {
  const request = await sessionRequest();
  await mkdir(join(request.cwd, '.omnai-output'), { recursive: true });
  const sibling = join(request.cwd, '.omnai-output', 'not-the-result.json');
  const peer = createScriptedAcpPeer({
    onPrompt: async (client, sessionId) => {
      await client.request(acp.methods.client.fs.writeTextFile, {
        sessionId,
        path: request.outputPath,
        content: '{"ok":true}',
      });
      await assert.rejects(
        () => client.request(acp.methods.client.fs.writeTextFile, {
          sessionId,
          path: sibling,
          content: 'forbidden',
        }),
        /FILESYSTEM_NOT_AUTHORIZED: PATH_NOT_ALLOWED_BY_PACKET/,
      );
    },
  });

  await new AcpAgentAdapter({ spawn: peer.spawn }).start(request, automaticHooks(peer));

  assert.equal(await readFile(request.outputPath, 'utf8'), '{"ok":true}');
});

test('session updates are Run-bound, sequenced, byte-counted, and redacted before persistence', async () => {
  const secret = 'agent-secret-value';
  const base = await sessionRequest();
  const request: AgentSessionRequest = {
    ...base,
    profile: {
      ...base.profile,
      envRefs: { API_TOKEN: 'TEST_AGENT_SECRET' },
    },
  };
  const events: NormalizedAgentEvent[] = [];
  const peer = createScriptedAcpPeer({
    onPrompt: async (client, sessionId) => {
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `token=${secret}` },
        },
      });
    },
  });
  const result = await new AcpAgentAdapter({
    spawn: peer.spawn,
    environment: { ...process.env, TEST_AGENT_SECRET: secret },
    now: () => NOW,
  }).start(request, {
    onSessionCreated: async () => undefined,
    onPromptIntent: async () => { peer.allowPrompt(); },
    onEvent: async (event) => { events.push(event); },
  });

  assert.equal(events.length, 1);
  assert.deepEqual(
    { runId: events[0]?.runId, sessionId: events[0]?.sessionId, sequence: events[0]?.sequence },
    { runId: 'RUN-0001', sessionId: 'sess-one', sequence: 1 },
  );
  assert.match(JSON.stringify(events[0]?.payload), /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(events), new RegExp(secret));
  assert.ok(result.outputBytes > 0);
});

test('elicitation is not advertised, is declined, and produces only redacted blocker audit events', async () => {
  const secret = 'elicitation-secret';
  const base = await sessionRequest();
  const request: AgentSessionRequest = {
    ...base,
    profile: { ...base.profile, envRefs: { API_TOKEN: 'TEST_ELICITATION_SECRET' } },
  };
  const events: NormalizedAgentEvent[] = [];
  let action = '';
  const peer = createScriptedAcpPeer({
    onPrompt: async (client, sessionId) => {
      const response = await client.request(acp.methods.client.elicitation.create, {
        mode: 'url',
        sessionId,
        elicitationId: 'elicit-one',
        url: 'https://example.invalid/login',
        message: `Need human input ${secret}`,
      });
      action = response.action;
      await client.notify(acp.methods.client.elicitation.complete, {
        elicitationId: 'elicit-one',
        _meta: { detail: secret },
      });
    },
  });

  await new AcpAgentAdapter({
    spawn: peer.spawn,
    environment: { ...process.env, TEST_ELICITATION_SECRET: secret },
    now: () => NOW,
  }).start(request, {
    onSessionCreated: async () => undefined,
    onPromptIntent: async () => { peer.allowPrompt(); },
    onEvent: async (event) => { events.push(event); },
  });

  const initialize = peer.requests.find((item) => item.method === acp.methods.agent.initialize);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      (initialize?.params as { clientCapabilities?: object }).clientCapabilities ?? {},
      'elicitation',
    ),
    false,
  );
  assert.equal(action, 'decline');
  assert.deepEqual(events.map((event) => event.kind), [
    'ELICITATION_BLOCKED',
    'ELICITATION_COMPLETED',
  ]);
  assert.doesNotMatch(JSON.stringify(events), new RegExp(secret));
  assert.match(JSON.stringify(events), /\[REDACTED\]/);
});

test('resume prefers session/resume, falls back to session/load, and never creates a second session', async () => {
  const hookCalls: string[] = [];
  const hooks: AgentSessionHooks = {
    onSessionCreated: async () => { hookCalls.push('session-created'); },
    onPromptIntent: async () => { hookCalls.push('prompt-intent'); },
    onEvent: async () => undefined,
  };
  const resumable = createScriptedAcpPeer({
    capabilities: { resume: true, load: true },
  });
  const resumed = await new AcpAgentAdapter({ spawn: resumable.spawn })
    .resume(await resumeRequest('sess-one'), hooks);
  assert.equal(resumed.status, 'RESUMED');
  assert.deepEqual(resumable.sessionMethods, ['session/resume']);
  assert.equal(resumable.requests.some((item) => item.method === 'session/new'), false);
  assert.equal(resumable.requests.some((item) => item.method === 'session/prompt'), false);

  const loadOnly = createScriptedAcpPeer({
    capabilities: { resume: false, load: true },
  });
  const loaded = await new AcpAgentAdapter({ spawn: loadOnly.spawn })
    .resume(await resumeRequest('sess-two'), hooks);
  assert.equal(loaded.status, 'RESUMED');
  assert.deepEqual(loadOnly.sessionMethods, ['session/load']);
  assert.equal(loadOnly.requests.some((item) => item.method === 'session/new'), false);
  assert.equal(loadOnly.requests.some((item) => item.method === 'session/prompt'), false);
  assert.deepEqual(hookCalls, []);
});

test('resume returns RECOVERY_REQUIRED evidence when no exact-session recovery method exists', async () => {
  const peer = createScriptedAcpPeer({
    capabilities: { resume: false, load: false },
  });
  const request = await resumeRequest('sess-lost');
  const result = await new AcpAgentAdapter({ spawn: peer.spawn })
    .resume(request, automaticHooks(peer));

  assert.equal(result.status, 'RECOVERY_REQUIRED');
  if (result.status !== 'RECOVERY_REQUIRED') assert.fail('expected recovery evidence');
  assert.equal(result.sessionId, 'sess-lost');
  assert.deepEqual(result.evidence, {
    sessionId: 'sess-lost',
    processId: 42_001,
    promptState: 'OUTCOME_UNCERTAIN',
    git: {
      worktree: 'git' in request.packet ? request.packet.git.worktree : '',
      branch: 'omnai/WKS-0001-quote',
      startingHead: 'a'.repeat(40),
    },
  });
  assert.equal(peer.requests.some((item) => item.method === 'session/new'), false);
  assert.equal(peer.requests.some((item) => item.method === 'session/prompt'), false);
});

test('safe stop cancels and closes only when advertised without releasing authority', async () => {
  const closable = createScriptedAcpPeer({ capabilities: { close: true } });
  await new AcpAgentAdapter({ spawn: closable.spawn })
    .signal(await signalRequest('sess-one'));
  assert.deepEqual(closable.sessionMethods, ['session/cancel', 'session/close']);

  const cancelOnly = createScriptedAcpPeer({ capabilities: { close: false } });
  await new AcpAgentAdapter({ spawn: cancelOnly.spawn })
    .signal(await signalRequest('sess-two'));
  assert.deepEqual(cancelOnly.sessionMethods, ['session/cancel']);
});

test('inspect distinguishes LIVE, DEAD, and UNKNOWN without treating uncertainty as termination', async () => {
  const adapter = new AcpAgentAdapter();
  const request = await resumeRequest('sess-inspect');
  const completed = {
    status: 'COMPLETED' as const,
    runId: request.packet.id,
    sessionId: request.record.sessionId,
    stopReason: 'end_turn' as const,
    outputBytes: 0,
  };
  const live = await adapter.inspect({
    record: { ...request.record, processId: process.pid },
    events: [],
  });
  assert.deepEqual(
    { process: live.process, outcome: live.outcome },
    { process: 'LIVE', outcome: 'RUNNING' },
  );

  const dead = await adapter.inspect({
    record: { ...request.record, processId: 2_147_483_647 },
    events: [],
    promptResult: completed,
  });
  assert.deepEqual(
    { process: dead.process, outcome: dead.outcome },
    { process: 'DEAD', outcome: 'COMPLETED' },
  );

  const { processId: _processId, ...withoutProcess } = request.record;
  const unknown = await adapter.inspect({ record: withoutProcess, events: [] });
  assert.deepEqual(
    { process: unknown.process, outcome: unknown.outcome },
    { process: 'UNKNOWN', outcome: 'UNKNOWN' },
  );
});

test('collect validates identity, redacts recursively, and enforces the final output-byte limit', async () => {
  const secret = 'collect-secret';
  const request = await resumeRequest('sess-collect');
  const event: NormalizedAgentEvent = {
    schemaVersion: 1,
    runId: request.packet.id,
    sessionId: request.record.sessionId,
    sequence: 1,
    kind: 'SESSION_UPDATE',
    payload: { message: `value=${secret}` },
    timestamp: NOW,
  };
  const promptResult = {
    status: 'COMPLETED' as const,
    runId: request.packet.id,
    sessionId: request.record.sessionId,
    stopReason: 'end_turn' as const,
    outputBytes: 1,
  };
  const adapter = new AcpAgentAdapter();
  const result = await adapter.collect({
    packet: request.packet,
    record: request.record,
    events: [event],
    promptResult,
    secretValues: [secret],
  });

  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.stopReason, 'end_turn');
  assert.match(JSON.stringify(result.events), /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  assert.ok(result.outputBytes > promptResult.outputBytes);
  const limited = await resumeRequest('sess-collect', { maxOutputBytes: 32 });
  await assert.rejects(
    () => adapter.collect({
      packet: limited.packet,
      record: limited.record,
      events: [{ ...event, payload: { message: 'x'.repeat(200) } }],
      promptResult,
    }),
    /AGENT_OUTPUT_LIMIT_EXCEEDED/,
  );
  await assert.rejects(
    () => adapter.collect({
      packet: request.packet,
      record: request.record,
      events: [{ ...event, sessionId: 'wrong-session' }],
      promptResult,
    }),
    /AGENT_SESSION_ID_MISMATCH/,
  );
  await assert.rejects(
    () => adapter.collect({
      packet: request.packet,
      record: { ...request.record, runId: 'RUN-0002' },
      events: [],
    }),
    /AGENT_RUN_ID_MISMATCH/,
  );
});

test('rejects session updates for a different session instead of persisting them', async () => {
  const peer = createScriptedAcpPeer({
    onPrompt: async (client) => {
      await client.notify(acp.methods.client.session.update, {
        sessionId: 'wrong-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'wrong' },
        },
      });
    },
  });
  await assert.rejects(
    async () => new AcpAgentAdapter({ spawn: peer.spawn })
      .start(await sessionRequest({ timeoutMs: 500 }), automaticHooks(peer)),
    /AGENT_SESSION_ID_MISMATCH/,
  );
});

test('malformed JSON-RPC is bounded and reported without echoing peer secrets', async () => {
  const secret = 'malformed-peer-secret';
  const peer = createRawPeer((process) => {
    process.sendRaw(`not-json-${secret}\n`);
  });
  await assert.rejects(
    async () => new AcpAgentAdapter({ spawn: peer.spawn })
      .start(await sessionRequest({ timeoutMs: 500 }), {
        onSessionCreated: async () => undefined,
        onPromptIntent: async () => undefined,
        onEvent: async () => undefined,
      }),
    (error: unknown) => {
      assert.match(String(error), /AGENT_PROTOCOL_INVALID/);
      assert.doesNotMatch(String(error), new RegExp(secret));
      return true;
    },
  );
});

test('unexpected Agent process exit is a structured failure', async () => {
  const peer = createRawPeer((process) => process.exit(17));
  await assert.rejects(
    async () => new AcpAgentAdapter({ spawn: peer.spawn })
      .start(await sessionRequest({ timeoutMs: 500 }), {
        onSessionCreated: async () => undefined,
        onPromptIntent: async () => undefined,
        onEvent: async () => undefined,
      }),
    /AGENT_PROCESS_EXIT: code=17/,
  );
});

test('stdout transport bytes are bounded before JSON parsing', async () => {
  const peer = createRawPeer((process) => {
    process.sendRaw('x'.repeat(70_000));
  });
  await assert.rejects(
    async () => new AcpAgentAdapter({ spawn: peer.spawn })
      .start(await sessionRequest({ timeoutMs: 500, maxOutputBytes: 1_024 }), {
        onSessionCreated: async () => undefined,
        onPromptIntent: async () => undefined,
        onEvent: async () => undefined,
      }),
    /AGENT_STDOUT_LIMIT_EXCEEDED/,
  );
});

test('authentication-required initialization is normalized and redacted', async () => {
  const secret = 'auth-peer-secret';
  const peer = createScriptedAcpPeer({
    initializeError: new acp.RequestError(-32_000, `login required ${secret}`),
  });
  await assert.rejects(
    async () => new AcpAgentAdapter({ spawn: peer.spawn })
      .start(await sessionRequest({ timeoutMs: 500 }), automaticHooks(peer)),
    (error: unknown) => {
      assert.match(String(error), /AGENT_AUTHENTICATION_REQUIRED/);
      assert.doesNotMatch(String(error), new RegExp(secret));
      return true;
    },
  );
});

test('an unresponsive Agent is terminated at the Run Packet timeout', async () => {
  const peer = createRawPeer(() => undefined);
  const operation = new AcpAgentAdapter({ spawn: peer.spawn }).start(
    await sessionRequest({ timeoutMs: 50 }),
    {
      onSessionCreated: async () => undefined,
      onPromptIntent: async () => undefined,
      onEvent: async () => undefined,
    },
  );
  await assert.rejects(
    () => Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('TEST_OBSERVER_TIMEOUT')), 250);
        timeout.unref();
      }),
    ]),
    /AGENT_SESSION_TIMEOUT/,
  );
});

test('resume rejects malformed transport input without echoing peer secrets', async () => {
  const secret = 'resume-malformed-secret';
  const peer = createRawPeer((process) => {
    process.sendRaw(`not-json-${secret}\n`);
  });
  const operation = new AcpAgentAdapter({ spawn: peer.spawn }).resume(
    await resumeRequest('sess-resume-malformed', { timeoutMs: 50 }),
    {
      onSessionCreated: async () => undefined,
      onPromptIntent: async () => undefined,
      onEvent: async () => undefined,
    },
  );

  await assert.rejects(
    () => Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('TEST_OBSERVER_TIMEOUT')), 250);
        timeout.unref();
      }),
    ]),
    (error: unknown) => {
      assert.match(String(error), /AGENT_PROTOCOL_INVALID/);
      assert.doesNotMatch(String(error), new RegExp(secret));
      return true;
    },
  );
});

test('safe stop is bounded by the immutable Run Packet timeout', async () => {
  const peer = createRawPeer(() => undefined);
  const operation = new AcpAgentAdapter({ spawn: peer.spawn })
    .signal(await signalRequest('sess-stop-timeout', { timeoutMs: 50 }));

  await assert.rejects(
    () => Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('TEST_OBSERVER_TIMEOUT')), 250);
        timeout.unref();
      }),
    ]),
    /AGENT_SIGNAL_TIMEOUT/,
  );
});

test('start rejects a profile that does not match the immutable Run Packet before spawning', async () => {
  const base = await sessionRequest();
  const request: AgentSessionRequest = {
    ...base,
    profile: { ...base.profile, agentId: 'claude' },
  };
  const peer = createScriptedAcpPeer();

  await assert.rejects(
    () => new AcpAgentAdapter({ spawn: peer.spawn }).start(request, automaticHooks(peer)),
    /AGENT_PACKET_PROFILE_MISMATCH/,
  );
  assert.deepEqual(peer.requests, []);
});

test('start rejects cwd and additional workspace roots outside the immutable packet', async () => {
  const base = await sessionRequest();
  const outside = await createTestDirectory('omnai-acp-root-outside-');
  cleanups.push(outside.cleanup);
  const peer = createScriptedAcpPeer();

  await assert.rejects(
    () => new AcpAgentAdapter({ spawn: peer.spawn }).start(
      { ...base, cwd: outside.root },
      automaticHooks(peer),
    ),
    /AGENT_CWD_OUTSIDE_PACKET_ROOTS/,
  );
  await assert.rejects(
    () => new AcpAgentAdapter({ spawn: peer.spawn }).start(
      { ...base, additionalDirectories: [outside.root] },
      automaticHooks(peer),
    ),
    /AGENT_ADDITIONAL_DIRECTORY_OUTSIDE_PACKET_ROOTS/,
  );
  assert.deepEqual(peer.requests, []);
});
