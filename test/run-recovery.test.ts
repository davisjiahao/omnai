import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, test } from 'node:test';
import type { AcpProcessHandle } from '../src/execution/agents/acp-client.js';
import { AcpAgentAdapter } from '../src/execution/agents/acp-client.js';
import type { AgentProfile } from '../src/execution/agents/types.js';
import type {
  AgentProbe,
  AgentSessionAdapter,
  AgentSessionHooks,
  AgentSessionRequest,
} from '../src/execution/agents/types.js';
import {
  conformanceReportPath,
  ensureAgentConformance,
  runAgentConformance,
} from '../src/execution/agents/conformance.js';
import { agentConformanceInputHash } from '../src/execution/agents/profiles.js';
import { hashObject } from '../src/execution/hashing.js';
import { createRunPacket, type RunPacket, type RunPacketInput } from '../src/execution/packets.js';
import {
  acceptRunResult,
  createRun,
  dispatchRun,
  recoverRun,
  signalRun,
  type RunExecutionContext,
} from '../src/execution/runs.js';
import {
  readFakeAgentCounters,
  readFakeAgentPauseToken,
  runFakeAcpAgent,
  type FakeAgentScript,
} from '../src/execution/testing/fake-acp-agent.js';
import {
  claimPath,
  runAgentSessionPath,
  runEventsPath,
  runStatePath,
} from '../src/execution/paths.js';
import { LocalExecutionBackend } from '../src/execution/backend.js';
import { agentSessionRecordSchema, projectTestCaseRef, runStateSchema } from '../src/execution/types.js';
import { readJsonLines, readYaml, writeYaml } from '../src/core/files.js';
import { createTestDirectory, createTestRepository } from './helpers.js';
import { hostManifestPath } from '../src/workspace/paths.js';

const NOW = '2026-08-16T00:00:00.000Z';
const HASH_A = hashObject('run-recovery-a');
const HASH_B = hashObject('run-recovery-b');
const HASH_C = hashObject('run-recovery-c');
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

class FakeAcpProcess extends EventEmitter implements AcpProcessHandle {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  constructor(readonly pid: number) {
    super();
  }

  exit(code: number): void {
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

function fakeAdapter(
  script: FakeAgentScript,
  stateDirectory: string,
  processId = process.pid,
): AcpAgentAdapter {
  return new AcpAgentAdapter({
    now: () => NOW,
    spawn: () => {
      const child = new FakeAcpProcess(processId);
      runFakeAcpAgent(child.stdin, child.stdout, script, {
        stateDirectory,
        now: () => NOW,
        onExit: (code) => child.exit(code),
      });
      return child;
    },
  });
}

function profile(role: AgentProfile['omnaiModes'][number]): AgentProfile {
  return {
    schemaVersion: 1,
    agentId: 'fake-acp',
    protocol: 'acp',
    command: 'fake-acp-agent',
    args: [],
    envRefs: {},
    protocolVersion: 1,
    priority: 1,
    costClass: 'LOW',
    maxParallelSessions: 1,
    isolation: { mode: 'agent-sandbox', enforcedWorkspaceRoots: true },
    capabilities: {
      loadSession: true,
      resumeSession: true,
      closeSession: true,
      additionalDirectories: true,
      mcpStdio: true,
    },
    omnaiModes: [role],
  };
}

async function fixtureFor(
  packet: RunPacket,
  script: FakeAgentScript,
  processId = process.pid,
): Promise<{
  context: RunExecutionContext;
  stateDirectory: string;
  cleanup: () => Promise<void>;
}> {
  const home = await createTestDirectory('omnai-run-home-');
  const state = await createTestDirectory('omnai-run-agent-state-');
  const backend = new LocalExecutionBackend();
  return {
    context: {
      home: home.root,
      worksetId: packet.worksetId,
      profile: profile(packet.agent.role),
      adapter: fakeAdapter(script, state.root, processId),
      backend,
      now: () => NOW,
    },
    stateDirectory: state.root,
    cleanup: async () => {
      await state.cleanup();
      await home.cleanup();
    },
  };
}

function criticPacket(root: string, id = 'RUN-0001'): Extract<RunPacket, { kind: 'PROJECT_CRITIC' }> {
  return createRunPacket({
    schemaVersion: 1,
    id,
    kind: 'PROJECT_CRITIC',
    worksetId: 'WKS-0001',
    contracts: [],
    objective: 'Review the proposed contract',
    protocolIds: ['execution.project-critic'],
    verificationCommands: [],
    evidenceRequired: [],
    stopConditions: [],
    agent: { agentId: 'fake-acp', protocol: 'acp', role: 'coordination-read-only' },
    limits: { timeoutMs: 5_000, maxOutputBytes: 1_048_576 },
    permissionPolicy: {
      filesystemRoots: [root],
      terminal: false,
      network: 'DENY',
      denyGitCommit: true,
      denyNestedOmnai: true,
    },
    createdAt: NOW,
  });
}

function criticResult(packet: RunPacket, runId = packet.id) {
  return {
    schemaVersion: 1,
    runId,
    packetHash: packet.packetHash,
    findingId: 'FND-0001',
    project: 'quote-center',
    candidateHash: HASH_A,
    disposition: 'ACCEPT',
    resolution: 'NONE',
    summary: 'The contract is consistent with the project evidence.',
    evidenceRefs: [],
    candidateOptions: [],
  };
}

function script(steps: FakeAgentScript['steps']): FakeAgentScript {
  return {
    schemaVersion: 1,
    agentId: 'fake-acp',
    capabilities: {
      loadSession: true,
      resumeSession: true,
      closeSession: true,
      additionalDirectories: true,
    },
    steps,
  };
}

test('a new read-only Run persists session identity before one prompt', async () => {
  const source = await createTestDirectory('omnai-run-source-');
  cleanups.push(source.cleanup);
  const packet = criticPacket(source.root);
  const fixture = await fixtureFor(packet, script([{ kind: 'result', value: criticResult(packet) }]));
  cleanups.push(fixture.cleanup);

  const created = await createRun(fixture.context, packet);
  const finished = await dispatchRun(fixture.context, created.id);

  assert.equal(finished.status, 'FINISHED');
  assert.match(finished.resultHash ?? '', /^sha256:[0-9a-f]{64}$/);
  const session = await readYaml(
    runAgentSessionPath(fixture.context.home, packet.worksetId, packet.id),
    agentSessionRecordSchema,
  );
  assert.match(session.sessionId, /^fake-/);
  assert.equal(finished.agentSessionId, session.sessionId);
  assert.equal(session.promptState, 'COMPLETED');
  assert.deepEqual(await readFakeAgentCounters(fixture.stateDirectory, packet.id), {
    sessions: 1,
    prompts: 1,
  });
});

test('retrying Run creation reuses one immutable packet and one RUN_CREATED event', async () => {
  const source = await createTestDirectory('omnai-run-source-');
  cleanups.push(source.cleanup);
  const packet = criticPacket(source.root);
  const fixture = await fixtureFor(packet, script([]));
  cleanups.push(fixture.cleanup);

  const first = await createRun(fixture.context, packet);
  const second = await createRun(fixture.context, packet);

  assert.deepEqual(second, first);
  const events = await readJsonLines<{ type: string }>(
    runEventsPath(fixture.context.home, packet.worksetId, packet.id),
  );
  assert.deepEqual(events.map((event) => event.type), ['RUN_CREATED']);
});

test('duplicate dispatch of the same Run ID never creates a second session', async () => {
  const source = await createTestDirectory('omnai-run-source-');
  cleanups.push(source.cleanup);
  const packet = criticPacket(source.root);
  const fixture = await fixtureFor(packet, script([{ kind: 'pause', token: 'paused' }]));
  cleanups.push(fixture.cleanup);
  await createRun(fixture.context, packet);

  const firstDispatch = dispatchRun(fixture.context, packet.id);
  const session = await waitForSession(fixture.context, packet.id);
  await waitForPause(fixture.stateDirectory, session.sessionId);

  await assert.rejects(
    () => dispatchRun(fixture.context, packet.id),
    /RUN_ALREADY_DISPATCHED|RUN_OUTCOME_UNCERTAIN/,
  );
  assert.deepEqual(await readFakeAgentCounters(fixture.stateDirectory, packet.id), {
    sessions: 1,
    prompts: 1,
  });

  await signalRun(fixture.context, packet.id);
  assert.equal((await firstDispatch).status, 'SIGNALED');
});

test('restart reconnects to a live session and repairs stale Run materialization', async () => {
  const source = await createTestDirectory('omnai-run-source-');
  cleanups.push(source.cleanup);
  const packet = criticPacket(source.root);
  const fixture = await fixtureFor(packet, script([{ kind: 'pause', token: 'paused' }]));
  cleanups.push(fixture.cleanup);
  const created = await createRun(fixture.context, packet);

  const firstDispatch = dispatchRun(fixture.context, packet.id);
  const session = await waitForSession(fixture.context, packet.id);
  await waitForPause(fixture.stateDirectory, session.sessionId);
  await writeYaml(runStatePath(fixture.context.home, packet.worksetId, packet.id), created);

  const decision = await recoverRun({
    ...fixture.context,
    adapter: fakeAdapter(script([{ kind: 'pause', token: 'paused' }]), fixture.stateDirectory),
  }, packet.id);

  assert.deepEqual(decision, { action: 'RESUME_SESSION', runId: packet.id });
  assert.equal((await readYaml(
    runStatePath(fixture.context.home, packet.worksetId, packet.id),
    runStateSchema,
  )).status, 'RUNNING');
  assert.deepEqual(await readFakeAgentCounters(fixture.stateDirectory, packet.id), {
    sessions: 1,
    prompts: 1,
  });

  await signalRun(fixture.context, packet.id);
  await firstDispatch;
});

test('a dead session with a recoverable writer diff requests a linked recovery Run', async () => {
  const repository = await createTestRepository('quote-center');
  cleanups.push(repository.cleanup);
  const sourcePath = join(repository.root, 'src', 'recovery.ts');
  await mkdir(join(repository.root, 'src'), { recursive: true });
  const packet = writerPacket(repository.root);
  const deadPid = 999_999_999;
  const fixture = await fixtureFor(packet, script([
    { kind: 'write', relativePath: 'src/recovery.ts', content: 'export const recovered = true;\n' },
    { kind: 'exit', code: 17 },
  ]), deadPid);
  cleanups.push(fixture.cleanup);
  await createRun(fixture.context, packet);
  await writeWriterClaim(fixture.context, packet);

  await assert.rejects(() => dispatchRun(fixture.context, packet.id), /AGENT_PROCESS_EXIT|FAKE_AGENT_EXIT/);
  assert.equal(await readFile(sourcePath, 'utf8'), 'export const recovered = true;\n');

  const decision = await recoverRun(fixture.context, packet.id);
  assert.deepEqual(decision, {
    action: 'CREATE_RECOVERY_RUN',
    sourceRunId: packet.id,
    preservePatch: true,
  });
});

test('a dead writer session never treats an out-of-scope diff as recoverable authority', async () => {
  const repository = await createTestRepository('quote-center');
  cleanups.push(repository.cleanup);
  const packet = writerPacket(repository.root);
  const fixture = await fixtureFor(packet, script([]));
  cleanups.push(fixture.cleanup);
  await createRun(fixture.context, packet);
  await writeSession(fixture.context, packet.id, 'SENT', 999_999_999);
  await writeFile(join(repository.root, 'outside.txt'), 'not authorized\n', 'utf8');

  const decision = await recoverRun({
    ...fixture.context,
    adapter: inspectionAdapter('DEAD'),
  }, packet.id);

  assert.deepEqual(decision, { action: 'BLOCK_UNCERTAIN_OUTCOME', runId: packet.id });
});

test('recovery retains unknown authority and restarts only a proven-unsent dead session', async (context) => {
  for (const scenario of [
    { process: 'UNKNOWN' as const, promptState: 'NOT_SENT' as const, action: 'RETAIN_AUTHORITY_AND_WAIT' },
    { process: 'DEAD' as const, promptState: 'NOT_SENT' as const, action: 'RESTART_SAME_RUN' },
    { process: 'DEAD' as const, promptState: 'SENT' as const, action: 'BLOCK_UNCERTAIN_OUTCOME' },
  ]) {
    await context.test(`${scenario.process}/${scenario.promptState}`, async () => {
      const source = await createTestDirectory('omnai-run-source-');
      const packet = criticPacket(source.root);
      const fixture = await fixtureFor(packet, script([]));
      try {
        await createRun(fixture.context, packet);
        await writeSession(fixture.context, packet.id, scenario.promptState, 999_999_999);
        const decision = await recoverRun({
          ...fixture.context,
          adapter: inspectionAdapter(scenario.process),
        }, packet.id);
        assert.equal(decision.action, scenario.action);
      } finally {
        await fixture.cleanup();
        await source.cleanup();
      }
    });
  }
});

test('malformed or packet-mismatched output cannot advance FINISHED to ACCEPTED', async () => {
  const source = await createTestDirectory('omnai-run-source-');
  cleanups.push(source.cleanup);
  const packet = criticPacket(source.root);
  const fixture = await fixtureFor(packet, script([{
    kind: 'result',
    value: criticResult(packet, 'RUN-9999'),
  }]));
  cleanups.push(fixture.cleanup);
  await createRun(fixture.context, packet);
  await dispatchRun(fixture.context, packet.id);

  await assert.rejects(
    () => acceptRunResult(fixture.context, packet.id),
    /ARTIFACT_IDENTITY_MISMATCH|ARTIFACT_SCHEMA_INVALID/,
  );
  assert.equal((await readYaml(
    runStatePath(fixture.context.home, packet.worksetId, packet.id),
    runStateSchema,
  )).status, 'FINISHED');
});

test('a schema-valid identity-bound artifact is copied to evidence before ACCEPTED', async () => {
  const source = await createTestDirectory('omnai-run-source-');
  cleanups.push(source.cleanup);
  const packet = criticPacket(source.root);
  const result = criticResult(packet);
  const fixture = await fixtureFor(packet, script([{ kind: 'result', value: result }]));
  cleanups.push(fixture.cleanup);
  await createRun(fixture.context, packet);
  await dispatchRun(fixture.context, packet.id);

  const accepted = await acceptRunResult(fixture.context, packet.id);

  assert.deepEqual(accepted.artifact, result);
  assert.match(accepted.contentHash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(await readFile(accepted.path, 'utf8')), result);
  assert.equal((await readYaml(
    runStatePath(fixture.context.home, packet.worksetId, packet.id),
    runStateSchema,
  )).status, 'ACCEPTED');
});

test('a malformed writer blocker cannot move a Run into authoritative BLOCKED state', async () => {
  const repository = await createTestRepository('quote-center');
  cleanups.push(repository.cleanup);
  const packet = writerPacket(repository.root);
  const fixture = await fixtureFor(packet, script([{
    kind: 'result',
    value: { outcome: 'BLOCK' },
  }]));
  cleanups.push(fixture.cleanup);
  await createRun(fixture.context, packet);
  await writeWriterClaim(fixture.context, packet);

  await assert.rejects(
    () => dispatchRun(fixture.context, packet.id),
    /ARTIFACT_SCHEMA_INVALID/,
  );
  assert.equal((await readYaml(
    runStatePath(fixture.context.home, packet.worksetId, packet.id),
    runStateSchema,
  )).status, 'FAILED');
  assert.equal((await readYaml(
    runAgentSessionPath(fixture.context.home, packet.worksetId, packet.id),
    agentSessionRecordSchema,
  )).promptState, 'COMPLETED');
});

test('first eligible use runs conformance once and reuses only exact bound evidence', async () => {
  const home = await createTestDirectory('omnai-conformance-home-');
  cleanups.push(home.cleanup);
  const executable = join(home.root, 'fake-agent');
  await writeFile(executable, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(executable, 0o755);
  const configured: AgentProfile = {
    ...profile('coordination-read-only'),
    command: executable,
    envRefs: { API_TOKEN: 'TEST_CONFORMANCE_SECRET' },
  };
  await writeYaml(hostManifestPath(home.root, 'codex'), {
    schemaVersion: 1,
    host: 'codex',
    omnaiVersion: '0.2.0',
    destination: join(home.root, 'skills'),
    skills: [],
    installedAt: NOW,
    updatedAt: NOW,
    agents: [configured],
  });
  const expectedInputHash = await agentConformanceInputHash(configured, executable);
  const probe: AgentProbe = {
    schemaVersion: 1,
    agentId: configured.agentId,
    available: true,
    authenticated: true,
    protocolVersion: 1,
    health: 'HEALTHY',
    activeSessions: 0,
    capabilities: configured.capabilities,
    conformanceInputHash: expectedInputHash,
  };
  let invocations = 0;
  const createAdapter = (): AgentSessionAdapter => {
    invocations += 1;
    return new ConformanceAdapter(probe);
  };
  const previousSecret = process.env.TEST_CONFORMANCE_SECRET;
  process.env.TEST_CONFORMANCE_SECRET = 'never-persist-this';
  try {
    const first = await ensureAgentConformance(home.root, configured, probe, createAdapter);
    const second = await ensureAgentConformance(home.root, first, probe, createAdapter);

    assert.equal(invocations, 1);
    assert.equal(first.conformance?.inputHash, expectedInputHash);
    assert.deepEqual(second.conformance, first.conformance);
    const reportText = await readFile(
      conformanceReportPath(home.root, configured.agentId, expectedInputHash),
      'utf8',
    );
    assert.equal(reportText.includes('never-persist-this'), false);
    const corrupted = JSON.parse(reportText) as { evidenceHash: string };
    corrupted.evidenceHash = HASH_A;
    await writeFile(
      conformanceReportPath(home.root, configured.agentId, expectedInputHash),
      `${JSON.stringify(corrupted)}\n`,
      'utf8',
    );
    const repaired = await ensureAgentConformance(home.root, first, probe, createAdapter);
    assert.equal(invocations, 2);

    const reportPath = conformanceReportPath(home.root, configured.agentId, expectedInputHash);
    const wrongAdapterReport = JSON.parse(await readFile(reportPath, 'utf8')) as Record<string, unknown>;
    wrongAdapterReport.adapterId = 'native-v1';
    const { evidenceHash: _evidenceHash, ...wrongAdapterEvidence } = wrongAdapterReport;
    wrongAdapterReport.evidenceHash = hashObject(wrongAdapterEvidence);
    await writeFile(reportPath, `${JSON.stringify(wrongAdapterReport)}\n`, 'utf8');
    await writeYaml(hostManifestPath(home.root, 'codex'), {
      schemaVersion: 1,
      host: 'codex',
      omnaiVersion: '0.2.0',
      destination: join(home.root, 'skills'),
      skills: [],
      installedAt: NOW,
      updatedAt: NOW,
      agents: [{
        ...repaired,
        conformance: {
          ...repaired.conformance!,
          evidenceHash: wrongAdapterReport.evidenceHash,
        },
      }],
    });
    await ensureAgentConformance(home.root, repaired, probe, createAdapter);
    assert.equal(invocations, 3);
  } finally {
    if (previousSecret === undefined) delete process.env.TEST_CONFORMANCE_SECRET;
    else process.env.TEST_CONFORMANCE_SECRET = previousSecret;
  }
});

test('the reusable conformance harness exercises a writer-only Adapter profile', async () => {
  const root = await createTestDirectory('omnai-writer-conformance-');
  cleanups.push(root.cleanup);
  const configured = profile('project-writer');
  const probe: AgentProbe = {
    schemaVersion: 1,
    agentId: configured.agentId,
    available: true,
    authenticated: true,
    protocolVersion: 1,
    health: 'HEALTHY',
    activeSessions: 0,
    capabilities: configured.capabilities,
    conformanceInputHash: HASH_A,
  };

  const report = await runAgentConformance(() => new ConformanceAdapter(probe), {
    adapterId: 'test-adapter',
    inputHash: HASH_A,
    roles: configured.omnaiModes,
    profile: configured,
    probe,
    readonlyRoot: root.root,
    writerRoot: join(root.root, 'writer'),
    outputRoot: join(root.root, 'output'),
    now: () => NOW,
  });

  assert.equal(
    report.passed,
    true,
    JSON.stringify(report.cases.filter((item) => item.status === 'FAIL')),
  );
  assert.deepEqual(report.roles, ['project-writer']);
});

test('conformance exercises every role before reporting exact multi-role authority', async () => {
  const root = await createTestDirectory('omnai-multi-role-conformance-');
  cleanups.push(root.cleanup);
  const configured: AgentProfile = {
    ...profile('coordination-read-only'),
    omnaiModes: ['coordination-read-only', 'project-writer', 'project-reviewer'],
  };
  const probe: AgentProbe = {
    schemaVersion: 1,
    agentId: configured.agentId,
    available: true,
    authenticated: true,
    protocolVersion: 1,
    health: 'HEALTHY',
    activeSessions: 0,
    capabilities: configured.capabilities,
    conformanceInputHash: HASH_A,
  };
  const seenRoles: string[] = [];

  const report = await runAgentConformance(() => new ConformanceAdapter(probe, seenRoles), {
    adapterId: 'test-adapter',
    inputHash: HASH_A,
    roles: configured.omnaiModes,
    profile: configured,
    probe,
    readonlyRoot: root.root,
    writerRoot: join(root.root, 'writer'),
    outputRoot: join(root.root, 'output'),
    now: () => NOW,
  });

  assert.equal(report.passed, true);
  assert.deepEqual(seenRoles, ['coordination-read-only', 'project-reviewer', 'project-writer']);
  assert.deepEqual(report.roles, seenRoles);
});

test('concurrent first-use conformance serializes to one suite invocation', async () => {
  const home = await createTestDirectory('omnai-conformance-home-');
  cleanups.push(home.cleanup);
  const executable = join(home.root, 'fake-agent');
  await writeFile(executable, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(executable, 0o755);
  const configured: AgentProfile = {
    ...profile('coordination-read-only'),
    command: executable,
  };
  await writeYaml(hostManifestPath(home.root, 'codex'), {
    schemaVersion: 1,
    host: 'codex',
    omnaiVersion: '0.2.0',
    destination: join(home.root, 'skills'),
    skills: [],
    installedAt: NOW,
    updatedAt: NOW,
    agents: [configured],
  });
  const expectedInputHash = await agentConformanceInputHash(configured, executable);
  const probe: AgentProbe = {
    schemaVersion: 1,
    agentId: configured.agentId,
    available: true,
    authenticated: true,
    protocolVersion: 1,
    health: 'HEALTHY',
    activeSessions: 0,
    capabilities: configured.capabilities,
    conformanceInputHash: expectedInputHash,
  };
  let invocations = 0;
  const factory = (): AgentSessionAdapter => {
    invocations += 1;
    return new ConformanceAdapter(probe);
  };

  const [first, second] = await Promise.all([
    ensureAgentConformance(home.root, configured, probe, factory),
    ensureAgentConformance(home.root, configured, probe, factory),
  ]);

  assert.equal(invocations, 1);
  assert.deepEqual(first.conformance, second.conformance);
});

test('unavailable conformance returns EXTERNAL_ACTION_REQUIRED without touching the manifest', async () => {
  const home = await createTestDirectory('omnai-conformance-home-');
  cleanups.push(home.cleanup);
  const executable = join(home.root, 'fake-agent');
  await writeFile(executable, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(executable, 0o755);
  const configured: AgentProfile = { ...profile('coordination-read-only'), command: executable };
  const manifestPath = hostManifestPath(home.root, 'codex');
  await writeYaml(manifestPath, {
    schemaVersion: 1,
    host: 'codex',
    omnaiVersion: '0.2.0',
    destination: join(home.root, 'skills'),
    skills: [],
    installedAt: NOW,
    updatedAt: NOW,
    agents: [configured],
  });
  const before = await readFile(manifestPath, 'utf8');
  let factoryCalls = 0;

  await assert.rejects(
    () => ensureAgentConformance(home.root, configured, {
      schemaVersion: 1,
      agentId: configured.agentId,
      available: false,
      authenticated: false,
      protocolVersion: null,
      health: 'UNHEALTHY',
      activeSessions: 0,
      capabilities: configured.capabilities,
      error: 'AGENT_COMMAND_NOT_FOUND',
    }, () => {
      factoryCalls += 1;
      return inspectionAdapter('UNKNOWN');
    }),
    (error: unknown) => error instanceof Error &&
      'code' in error && error.code === 'EXTERNAL_ACTION_REQUIRED',
  );
  assert.equal(factoryCalls, 0);
  assert.equal(await readFile(manifestPath, 'utf8'), before);
});

test('conformance rejects a probe hash that is not bound to current executable bytes before running', async () => {
  const home = await createTestDirectory('omnai-conformance-home-');
  cleanups.push(home.cleanup);
  const executable = join(home.root, 'fake-agent');
  await writeFile(executable, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(executable, 0o755);
  const configured: AgentProfile = { ...profile('coordination-read-only'), command: executable };
  await writeYaml(hostManifestPath(home.root, 'codex'), {
    schemaVersion: 1,
    host: 'codex',
    omnaiVersion: '0.2.0',
    destination: join(home.root, 'skills'),
    skills: [],
    installedAt: NOW,
    updatedAt: NOW,
    agents: [configured],
  });
  let factoryCalls = 0;

  await assert.rejects(
    () => ensureAgentConformance(home.root, configured, {
      schemaVersion: 1,
      agentId: configured.agentId,
      available: true,
      authenticated: true,
      protocolVersion: 1,
      health: 'HEALTHY',
      activeSessions: 0,
      capabilities: configured.capabilities,
      conformanceInputHash: HASH_A,
    }, () => {
      factoryCalls += 1;
      return inspectionAdapter('UNKNOWN');
    }),
    /AGENT_CONFORMANCE_INPUT_HASH_MISMATCH/,
  );
  assert.equal(factoryCalls, 0);
});

class ConformanceAdapter implements AgentSessionAdapter {
  constructor(
    private readonly agentProbe: AgentProbe,
    private readonly seenRoles?: string[],
  ) {}

  async probe(): Promise<AgentProbe> {
    return this.agentProbe;
  }

  async start(request: AgentSessionRequest, hooks: AgentSessionHooks) {
    if (!request.profile.omnaiModes.includes(request.packet.agent.role)) {
      throw new Error('TEST_CONFORMANCE_ROLE_MISMATCH');
    }
    this.seenRoles?.push(request.packet.agent.role);
    const record = {
      schemaVersion: 1 as const,
      machineVersion: 1 as const,
      lastEventSequence: 0,
      lastEventHash: null,
      runId: request.packet.id,
      agentId: request.profile.agentId,
      protocol: request.profile.protocol,
      sessionId: 'conformance-session',
      processId: process.pid,
      promptState: 'NOT_SENT' as const,
      createdAt: NOW,
      updatedAt: NOW,
    };
    await hooks.onSessionCreated(record);
    await hooks.onPromptIntent();
    await hooks.onEvent({
      schemaVersion: 1,
      runId: request.packet.id,
      sessionId: record.sessionId,
      sequence: 1,
      kind: 'SESSION_UPDATE',
      payload: { status: 'working' },
      timestamp: NOW,
    });
    await writeFile(request.outputPath, JSON.stringify(conformanceResult(request.packet)), 'utf8');
    return {
      status: 'COMPLETED' as const,
      runId: request.packet.id,
      sessionId: record.sessionId,
      stopReason: 'end_turn' as const,
      outputBytes: 1,
    };
  }

  async inspect(request: Parameters<AgentSessionAdapter['inspect']>[0]) {
    return {
      sessionId: request.record.sessionId,
      process: 'LIVE' as const,
      outcome: 'COMPLETED' as const,
      eventCount: request.events.length,
    };
  }

  async signal(): Promise<void> {}

  async collect(request: Parameters<AgentSessionAdapter['collect']>[0]) {
    return {
      sessionId: request.record.sessionId,
      status: 'COMPLETED' as const,
      stopReason: 'end_turn' as const,
      events: request.events,
      outputBytes: 1,
    };
  }

  async resume(request: Parameters<AgentSessionAdapter['resume']>[0]) {
    return {
      status: 'RESUMED' as const,
      runId: request.packet.id,
      sessionId: request.record.sessionId,
      stopReason: null,
      outputBytes: 0,
    };
  }
}

function conformanceResult(packet: RunPacket): unknown {
  if (packet.kind === 'PROJECT_WRITER' || packet.kind === 'RECOVERY_WRITER') {
    return {
      schemaVersion: 1,
      runId: packet.id,
      packetHash: packet.packetHash,
      outcome: 'FINISH',
      summary: 'Conformance writer completed.',
      changedPaths: [],
      evidenceRefs: [],
      logs: [],
    };
  }
  if (packet.kind === 'PROJECT_REVIEWER') {
    return {
      schemaVersion: 1,
      runId: packet.id,
      packetHash: packet.packetHash,
      outcome: 'APPROVE',
      summary: 'Conformance reviewer approved.',
      findings: [],
      evidenceRefs: [],
      logs: [],
    };
  }
  return criticResult(packet);
}

function writerPacket(worktree: string): Extract<RunPacket, { kind: 'PROJECT_WRITER' }> {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
  const input: Extract<RunPacketInput, { kind: 'PROJECT_WRITER' }> = {
    schemaVersion: 1,
    id: 'RUN-0001',
    kind: 'PROJECT_WRITER',
    worksetId: 'WKS-0001',
    waveId: 'WAVE-0001',
    scopedTask: {
      project: 'quote-center',
      changeId: 'CHG-0001',
      revision: 'REV-0001',
      baseline: 'BL-0001',
      taskId: 'TASK-001',
    },
    git: { startingHead: head, worktree, branch: 'omnai/WKS-0001-quote-center' },
    contracts: [{ id: 'CTR-0001', contentHash: HASH_A }],
    objective: 'Implement the authorized project change',
    protocolIds: ['execution.project-writer'],
    allowedPaths: ['src/**'],
    verificationCommands: ['npm test'],
    verificationPlan: { id: 'VPL-0001', contentHash: HASH_B },
    testCaseRefs: [projectTestCaseRef({
      project: 'quote-center',
      changeId: 'CHG-0001',
      revision: 'REV-0001',
    }, 'TC-0001', HASH_C)],
    commandRefs: ['quote.unit'],
    evidenceRequired: ['test-results'],
    stopConditions: ['signal stale contract'],
    agent: { agentId: 'fake-acp', protocol: 'acp', role: 'project-writer' },
    limits: { timeoutMs: 5_000, maxOutputBytes: 1_048_576 },
    permissionPolicy: {
      filesystemRoots: [worktree],
      terminal: true,
      network: 'DENY',
      denyGitCommit: true,
      denyNestedOmnai: true,
    },
    createdAt: NOW,
  };
  return createRunPacket(input);
}

async function writeWriterClaim(
  context: RunExecutionContext,
  packet: Extract<RunPacket, { kind: 'PROJECT_WRITER' }>,
): Promise<void> {
  await writeYaml(claimPath(context.home, packet.worksetId, packet.scopedTask.project), {
    schemaVersion: 1,
    machineVersion: 1,
    lastEventSequence: 0,
    lastEventHash: null,
    project: packet.scopedTask.project,
    runId: packet.id,
    runKind: packet.kind,
    phase: 'WRITING',
    worktree: packet.git.worktree,
    branch: packet.git.branch,
    ownerProcess: process.pid,
    agentProtocol: packet.agent.protocol,
    agentId: packet.agent.agentId,
    acquiredAt: NOW,
    heartbeatAt: NOW,
    updatedAt: NOW,
  });
}

async function writeSession(
  context: RunExecutionContext,
  runId: string,
  promptState: 'NOT_SENT' | 'SENT',
  processId: number,
): Promise<void> {
  await writeYaml(runAgentSessionPath(context.home, context.worksetId, runId), {
    schemaVersion: 1,
    machineVersion: 1,
    lastEventSequence: 0,
    lastEventHash: null,
    runId,
    agentId: context.profile.agentId,
    protocol: context.profile.protocol,
    sessionId: 'seeded-session',
    processId,
    promptState,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function inspectionAdapter(processState: 'LIVE' | 'DEAD' | 'UNKNOWN'): AgentSessionAdapter {
  const unsupported = async (): Promise<never> => { throw new Error('TEST_ADAPTER_OPERATION_UNEXPECTED'); };
  return {
    probe: unsupported,
    start: unsupported,
    inspect: async (request) => ({
      sessionId: request.record.sessionId,
      process: processState,
      outcome: processState === 'LIVE' ? 'RUNNING' : 'UNKNOWN',
      eventCount: request.events.length,
    }),
    signal: unsupported,
    collect: unsupported,
    resume: unsupported,
  };
}

async function waitForSession(context: RunExecutionContext, runId: string) {
  const path = runAgentSessionPath(context.home, context.worksetId, runId);
  return waitFor(async () => {
    try {
      return await readYaml(path, agentSessionRecordSchema);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  });
}

async function waitForPause(stateDirectory: string, sessionId: string): Promise<void> {
  await waitFor(async () => (await readFakeAgentPauseToken(stateDirectory, sessionId)) === null
    ? null
    : true);
}

async function waitFor<T>(read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() >= deadline) throw new Error('TEST_CONDITION_TIMEOUT');
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
