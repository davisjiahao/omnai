import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import YAML from 'yaml';
import { z, type ZodType } from 'zod';
import {
  appendJsonLineDurable,
  ensureDir,
  pathExists,
  readJsonLines,
  readTextIfExists,
  readYaml,
  writeTextAtomic,
  writeYaml,
} from '../core/files.js';
import {
  contractCandidateSchema,
  contractResolutionSchema,
  parseArtifactForPacket,
  projectFindingSchema,
  projectTestPlanCandidateSchema,
  reviewFindingSchema,
  workerResultSchema,
} from './artifacts.js';
import { LocalExecutionBackend, type ExecutionBackend } from './backend.js';
import { canonicalJson, hashObject, sha256 } from './hashing.js';
import { nextExecutionId } from './ids.js';
import { withMutationLockAtPath, withWorksetMutationLock } from './mutation-lock.js';
import {
  loadRunPacket,
  persistRunPacket,
  renderRunPrompt,
  runPacketSchema,
  type RunPacket,
} from './packets.js';
import {
  claimPath,
  ensureExecutionLayout,
  runAcceptedArtifactPath,
  runAgentEventsPath,
  runAgentSessionPath,
  runEventsPath,
  runOutputPath,
  runOutputsRoot,
  runPacketPath,
  runPromptResultPath,
  runStatePath,
  runsRoot,
} from './paths.js';
import {
  agentSessionRecordSchema,
  runStateSchema,
  writerClaimSchema,
  type AgentSessionRecord,
  type ContentHash,
  type RunState,
} from './types.js';
import type {
  AgentMcpServer,
  AgentProfile,
  AgentSessionAdapter,
  NormalizedAgentEvent,
  NormalizedPromptResult,
} from './agents/types.js';
import { evaluatePermission } from './agents/policy.js';

const execFileAsync = promisify(execFile);

export interface RunExecutionContext {
  readonly home: string;
  readonly worksetId: string;
  readonly profile: AgentProfile;
  readonly adapter: AgentSessionAdapter;
  readonly backend?: ExecutionBackend;
  readonly now?: () => string;
  readonly additionalDirectories?: readonly string[];
  readonly mcpServers?: readonly AgentMcpServer[];
  readonly secretValues?: readonly string[];
}

export interface AcceptedRunArtifact {
  readonly runId: string;
  readonly kind: RunPacket['kind'];
  readonly artifact: unknown;
  readonly contentHash: ContentHash;
  readonly path: string;
}

export type RunRecoveryDecision =
  | { readonly action: 'RESUME_SESSION'; readonly runId: string }
  | { readonly action: 'RETAIN_AUTHORITY_AND_WAIT'; readonly runId: string }
  | { readonly action: 'CREATE_RECOVERY_RUN'; readonly sourceRunId: string; readonly preservePatch: true }
  | { readonly action: 'RESTART_SAME_RUN'; readonly runId: string }
  | { readonly action: 'BLOCK_UNCERTAIN_OUTCOME'; readonly runId: string };

export async function createRun(
  context: RunExecutionContext,
  packetInput: RunPacket,
): Promise<RunState> {
  const packet = runPacketSchema.parse(packetInput);
  assertContextPacket(context, packet);
  await ensureExecutionLayout(context.home, context.worksetId);
  const packetPath = runPacketPath(context.home, context.worksetId, packet.id);
  const creationLock = join(runsRoot(context.home, context.worksetId), `.create-${packet.id}.lock`);
  return withMutationLockAtPath(creationLock, async () => {
    await withWorksetMutationLock(context.home, context.worksetId, async () => {
      if (await pathExists(packetPath)) {
        await persistRunPacket(packetPath, packet);
        return;
      }
      const allocated = await nextExecutionId(context.home, context.worksetId, 'run');
      if (packet.id !== allocated) {
        throw new Error(`RUN_ID_ALLOCATION_MISMATCH: expected=${allocated} actual=${packet.id}`);
      }
      await persistRunPacket(packetPath, packet);
    });
    const current = await loadRunState(context, packet);
    return current.lastEventSequence > 0
      ? current
      : transitionRun(context, packet, initialRunState(packet), 'RUN_CREATED');
  }, { timeoutMs: 5_000 });
}

export async function dispatchRun(
  context: RunExecutionContext,
  runId: string,
): Promise<RunState> {
  const packet = await loadBoundPacket(context, runId);
  let state = await loadRunState(context, packet);
  if (state.status !== 'PREPARED') {
    throw new Error(
      state.status === 'STARTING' || state.status === 'RUNNING'
        ? `RUN_ALREADY_DISPATCHED: ${runId}`
        : `RUN_NOT_DISPATCHABLE: ${runId} status=${state.status}`,
    );
  }
  if (isWriter(packet)) {
    await requireMatchingWriterClaim(context, packet);
    state = await transitionRun(context, packet, initialRunState(packet), 'CLAIM');
  }
  state = await transitionRun(context, packet, initialRunState(packet), 'START');

  const outputPath = boundRunOutputPath(context, packet);
  await ensureDir(dirname(outputPath));
  const prompt = await renderRunPrompt(packet, outputPath);
  const events: NormalizedAgentEvent[] = [];
  let session: AgentSessionRecord | undefined;
  let promptResult: NormalizedPromptResult | undefined;

  try {
    promptResult = await context.adapter.start({
      profile: context.profile,
      packet,
      cwd: runCwd(packet),
      additionalDirectories: context.additionalDirectories ?? [],
      mcpServers: context.mcpServers ?? [],
      prompt,
      outputPath,
    }, {
      onSessionCreated: async (record) => {
        const path = runAgentSessionPath(context.home, context.worksetId, runId);
        if (await pathExists(path)) throw new Error(`RUN_SESSION_ALREADY_PERSISTED: ${runId}`);
        session = agentSessionRecordSchema.parse(record);
        await writeYaml(path, session);
        state = await transitionRun(
          context,
          packet,
          initialRunState(packet),
          'STARTED',
          { agentSessionId: session.sessionId },
        );
      },
      onPromptIntent: async () => {
        if (session === undefined) throw new Error('RUN_SESSION_NOT_PERSISTED_BEFORE_PROMPT');
        session = await writePromptState(context, session, 'INTENDED');
        session = await writePromptState(context, session, 'SENT');
      },
      onEvent: async (event) => {
        events.push(event);
        await appendJsonLineDurable(runAgentEventsPath(context.home, context.worksetId, runId), event);
      },
    });
    if (promptResult.status !== 'COMPLETED') {
      throw new Error(`RUN_AGENT_START_RESULT_INVALID: ${promptResult.status}`);
    }
    if (session === undefined) throw new Error('RUN_SESSION_NOT_PERSISTED');
    await writeTextAtomic(
      runPromptResultPath(context.home, context.worksetId, runId),
      `${JSON.stringify(promptResult)}\n`,
    );
    await context.adapter.collect({
      packet,
      record: session,
      events,
      promptResult,
      secretValues: context.secretValues ?? [],
    });
    if (promptResult.status === 'COMPLETED' && promptResult.stopReason === 'cancelled') {
      const resultHash = hashObject(promptResult);
      session = await writePromptState(context, session, 'COMPLETED');
      return transitionRun(
        context,
        packet,
        initialRunState(packet),
        'SIGNAL',
        { resultHash },
      );
    }
    const rawOutput = await requireRunOutput(outputPath, packet.limits.maxOutputBytes);
    const resultHash = sha256(rawOutput);
    session = await writePromptState(context, session, 'COMPLETED');
    const terminalEvent = terminalEventFor(packet, rawOutput, promptResult);
    state = await transitionRun(
      context,
      packet,
      initialRunState(packet),
      terminalEvent,
      { resultHash },
    );
    return state;
  } catch (error) {
    if (session !== undefined) {
      session = await writePromptState(
        context,
        session,
        promptResult?.status === 'COMPLETED' ? 'COMPLETED' : 'OUTCOME_UNCERTAIN',
      );
    }
    const current = await loadRunState(context, packet);
    if (current.status === 'STARTING' || current.status === 'RUNNING' || current.status === 'FINISHED') {
      await transitionRun(
        context,
        packet,
        initialRunState(packet),
        'FAIL',
        { resultHash: hashObject(normalizeError(error)) },
      );
    }
    throw error;
  }
}

export async function acceptRunResult(
  context: RunExecutionContext,
  runId: string,
): Promise<AcceptedRunArtifact> {
  const packet = await loadBoundPacket(context, runId);
  const state = await loadRunState(context, packet);
  if (state.status !== 'FINISHED') {
    throw new Error(`RUN_RESULT_NOT_ACCEPTABLE: ${runId} status=${state.status}`);
  }
  const outputPath = boundRunOutputPath(context, packet);
  let value: unknown;
  try {
    const raw = await readFile(outputPath, 'utf8');
    value = isContractCoordination(packet) ? YAML.parse(raw) : JSON.parse(raw);
  } catch (error) {
    throw new Error('ARTIFACT_SCHEMA_INVALID: output is not valid structured data', { cause: error });
  }
  let artifact: unknown;
  try {
    artifact = parseArtifactForPacket(packet, artifactSchema(packet.kind), value);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('ARTIFACT_IDENTITY_MISMATCH')) throw error;
    throw new Error('ARTIFACT_SCHEMA_INVALID', { cause: error });
  }
  const acceptedPath = runAcceptedArtifactPath(context.home, context.worksetId, runId);
  const serialized = `${canonicalJson(artifact)}\n`;
  await writeTextAtomic(acceptedPath, serialized);
  const contentHash = sha256(serialized);
  await transitionRun(context, packet, initialRunState(packet), 'ACCEPT', { resultHash: contentHash });
  return { runId, kind: packet.kind, artifact, contentHash, path: acceptedPath };
}

export async function recoverRun(
  context: RunExecutionContext,
  runId: string,
): Promise<RunRecoveryDecision> {
  const packet = await loadBoundPacket(context, runId);
  await loadRunState(context, packet);
  const session = await readYaml(
    runAgentSessionPath(context.home, context.worksetId, runId),
    agentSessionRecordSchema,
  );
  const events = await readJsonLines<NormalizedAgentEvent>(
    runAgentEventsPath(context.home, context.worksetId, runId),
  );
  const promptResult = await readPromptResult(context, runId);
  const inspection = await context.adapter.inspect({
    record: session,
    events,
    ...(promptResult === undefined ? {} : { promptResult }),
  });

  if (inspection.process === 'LIVE') {
    const outputPath = boundRunOutputPath(context, packet);
    try {
      const resumed = await context.adapter.resume({
        profile: context.profile,
        packet,
        cwd: runCwd(packet),
        additionalDirectories: context.additionalDirectories ?? [],
        mcpServers: context.mcpServers ?? [],
        outputPath,
        record: session,
      }, noOpHooks());
      return resumed.status === 'RESUMED'
        ? { action: 'RESUME_SESSION', runId }
        : { action: 'RETAIN_AUTHORITY_AND_WAIT', runId };
    } catch {
      return { action: 'RETAIN_AUTHORITY_AND_WAIT', runId };
    }
  }
  if (inspection.process === 'UNKNOWN') {
    return { action: 'RETAIN_AUTHORITY_AND_WAIT', runId };
  }
  if (isWriter(packet) && await hasWriterDiff(packet)) {
    return { action: 'CREATE_RECOVERY_RUN', sourceRunId: runId, preservePatch: true };
  }
  if (session.promptState === 'NOT_SENT') {
    return { action: 'RESTART_SAME_RUN', runId };
  }
  return { action: 'BLOCK_UNCERTAIN_OUTCOME', runId };
}

export async function signalRun(context: RunExecutionContext, runId: string): Promise<void> {
  const packet = await loadBoundPacket(context, runId);
  const state = await loadRunState(context, packet);
  if (state.status !== 'STARTING' && state.status !== 'RUNNING') {
    throw new Error(`RUN_NOT_SIGNALABLE: ${runId} status=${state.status}`);
  }
  const session = await readYaml(
    runAgentSessionPath(context.home, context.worksetId, runId),
    agentSessionRecordSchema,
  );
  await context.adapter.signal({
    profile: context.profile,
    packet,
    record: session,
    signal: 'STOP',
  });
}

function initialRunState(packet: RunPacket): RunState {
  return runStateSchema.parse({
    schemaVersion: 1,
    machineVersion: 1,
    lastEventSequence: 0,
    lastEventHash: null,
    id: packet.id,
    kind: packet.kind,
    worksetId: packet.worksetId,
    status: 'PREPARED',
    packetHash: packet.packetHash,
    ...(packet.waveId === undefined ? {} : { waveId: packet.waveId }),
    ...(packet.parentRunId === undefined ? {} : { parentRunId: packet.parentRunId }),
    ...('scopedTask' in packet ? { scopedTask: packet.scopedTask } : {}),
    evidenceRefs: [],
    createdAt: packet.createdAt,
    updatedAt: packet.createdAt,
  });
}

async function loadRunState(context: RunExecutionContext, packet: RunPacket): Promise<RunState> {
  const backend = context.backend ?? new LocalExecutionBackend();
  return backend.loadAndRepair(runReplayRequest(context, packet));
}

async function transitionRun(
  context: RunExecutionContext,
  packet: RunPacket,
  initialState: RunState,
  type: string,
  payload?: Record<string, unknown>,
): Promise<RunState> {
  const backend = context.backend ?? new LocalExecutionBackend();
  return backend.transition({
    ...runReplayRequest(context, packet),
    initialState,
    event: { type, ...(payload === undefined ? {} : { payload }) },
  });
}

function runReplayRequest(context: RunExecutionContext, packet: RunPacket) {
  return {
    home: context.home,
    worksetId: context.worksetId,
    aggregateType: 'run' as const,
    aggregateId: packet.id,
    eventsPath: runEventsPath(context.home, context.worksetId, packet.id),
    statePath: runStatePath(context.home, context.worksetId, packet.id),
    initialState: initialRunState(packet),
    now: context.now ?? (() => new Date().toISOString()),
  };
}

async function loadBoundPacket(context: RunExecutionContext, runId: string): Promise<RunPacket> {
  const packet = await loadRunPacket(runPacketPath(context.home, context.worksetId, runId));
  assertContextPacket(context, packet);
  if (packet.id !== runId) throw new Error(`RUN_PACKET_ID_MISMATCH: ${runId}`);
  if (packet.agent.agentId !== context.profile.agentId || packet.agent.protocol !== context.profile.protocol) {
    throw new Error('RUN_AGENT_PROFILE_MISMATCH');
  }
  return packet;
}

function assertContextPacket(context: RunExecutionContext, packet: RunPacket): void {
  if (packet.worksetId !== context.worksetId) {
    throw new Error(`RUN_WORKSET_MISMATCH: expected=${context.worksetId} actual=${packet.worksetId}`);
  }
  if (packet.agent.agentId !== context.profile.agentId ||
      packet.agent.protocol !== context.profile.protocol ||
      !context.profile.omnaiModes.includes(packet.agent.role)) {
    throw new Error('RUN_AGENT_PROFILE_MISMATCH');
  }
  if (packet.kind === 'PROJECT_TEST_PLANNER' &&
      packet.outputPath !== runOutputPath(context.home, context.worksetId, packet.id)) {
    throw new Error('RUN_PACKET_OUTPUT_PATH_MISMATCH');
  }
}

function isWriter(
  packet: RunPacket,
): packet is Extract<RunPacket, { kind: 'PROJECT_WRITER' | 'RECOVERY_WRITER' }> {
  return packet.kind === 'PROJECT_WRITER' || packet.kind === 'RECOVERY_WRITER';
}

function isContractCoordination(
  packet: RunPacket,
): packet is Extract<RunPacket, {
  kind: 'CONTRACT_PLANNER' | 'PROJECT_CRITIC' | 'CONTRACT_RESOLVER';
}> {
  return packet.kind === 'CONTRACT_PLANNER' ||
    packet.kind === 'PROJECT_CRITIC' ||
    packet.kind === 'CONTRACT_RESOLVER';
}

function boundRunOutputPath(context: RunExecutionContext, packet: RunPacket): string {
  const coordinationNames = {
    CONTRACT_PLANNER: 'contract-candidate.yaml',
    PROJECT_CRITIC: 'project-finding.yaml',
    CONTRACT_RESOLVER: 'contract-resolution.yaml',
  } as const;
  if (isContractCoordination(packet)) {
    return join(runOutputsRoot(context.home, context.worksetId, packet.id), coordinationNames[packet.kind]);
  }
  return packet.kind === 'PROJECT_TEST_PLANNER'
    ? packet.outputPath
    : runOutputPath(context.home, context.worksetId, packet.id);
}

async function requireMatchingWriterClaim(
  context: RunExecutionContext,
  packet: Extract<RunPacket, { kind: 'PROJECT_WRITER' | 'RECOVERY_WRITER' }>,
): Promise<void> {
  const claim = await readYaml(
    claimPath(context.home, context.worksetId, packet.scopedTask.project),
    writerClaimSchema,
  ).catch((error: unknown) => {
    if (isMissing(error)) throw new Error(`RUN_WRITER_CLAIM_REQUIRED: ${packet.id}`);
    throw error;
  });
  if (claim.runId !== packet.id || claim.runKind !== packet.kind ||
      claim.worktree !== packet.git.worktree || claim.branch !== packet.git.branch ||
      claim.agentProtocol !== packet.agent.protocol || claim.agentId !== packet.agent.agentId) {
    throw new Error(`RUN_WRITER_CLAIM_MISMATCH: ${packet.id}`);
  }
}

function runCwd(packet: RunPacket): string {
  return 'git' in packet ? packet.git.worktree : packet.permissionPolicy.filesystemRoots[0]!;
}

async function writePromptState(
  context: RunExecutionContext,
  session: AgentSessionRecord,
  promptState: AgentSessionRecord['promptState'],
): Promise<AgentSessionRecord> {
  const next = agentSessionRecordSchema.parse({
    ...session,
    promptState,
    updatedAt: (context.now ?? (() => new Date().toISOString()))(),
  });
  await writeYaml(runAgentSessionPath(context.home, context.worksetId, session.runId), next);
  return next;
}

async function requireRunOutput(path: string, maximumBytes: number): Promise<string> {
  const content = await readFile(path, 'utf8').catch((error: unknown) => {
    if (isMissing(error)) throw new Error('RUN_OUTPUT_MISSING');
    throw error;
  });
  if (Buffer.byteLength(content) > maximumBytes) throw new Error('RUN_OUTPUT_LIMIT_EXCEEDED');
  return content;
}

function terminalEventFor(
  packet: RunPacket,
  rawOutput: string,
  promptResult: NormalizedPromptResult,
): 'FINISH' | 'BLOCK' | 'SIGNAL' {
  if (promptResult.status === 'COMPLETED' && promptResult.stopReason === 'cancelled') return 'SIGNAL';
  if (isWriter(packet)) {
    try {
      const result = parseArtifactForPacket(packet, workerResultSchema, JSON.parse(rawOutput));
      if (result.outcome === 'BLOCK') return 'BLOCK';
      if (result.outcome === 'SIGNAL') return 'SIGNAL';
    } catch (error) {
      throw new Error('ARTIFACT_SCHEMA_INVALID: writer terminal outcome is not authoritative', { cause: error });
    }
  }
  if (packet.kind === 'PROJECT_REVIEWER') {
    try {
      const result = parseArtifactForPacket(packet, reviewFindingSchema, JSON.parse(rawOutput));
      if (result.outcome === 'BLOCK') return 'BLOCK';
    } catch (error) {
      throw new Error('ARTIFACT_SCHEMA_INVALID: reviewer terminal outcome is not authoritative', { cause: error });
    }
  }
  return 'FINISH';
}

function artifactSchema(kind: RunPacket['kind']): ZodType<unknown> {
  const schemas: Record<RunPacket['kind'], ZodType<unknown>> = {
    CONTRACT_PLANNER: contractCandidateSchema,
    PROJECT_CRITIC: projectFindingSchema,
    CONTRACT_RESOLVER: contractResolutionSchema,
    PROJECT_TEST_PLANNER: projectTestPlanCandidateSchema,
    PROJECT_WRITER: workerResultSchema,
    PROJECT_REVIEWER: reviewFindingSchema,
    RECOVERY_WRITER: workerResultSchema,
  };
  return schemas[kind];
}

async function readPromptResult(
  context: RunExecutionContext,
  runId: string,
): Promise<NormalizedPromptResult | undefined> {
  const text = await readTextIfExists(runPromptResultPath(context.home, context.worksetId, runId));
  return text === null ? undefined : JSON.parse(text) as NormalizedPromptResult;
}

async function hasWriterDiff(
  packet: Extract<RunPacket, { kind: 'PROJECT_WRITER' | 'RECOVERY_WRITER' }>,
): Promise<boolean> {
  try {
    const options = {
      cwd: packet.git.worktree,
      encoding: 'utf8' as const,
      maxBuffer: packet.limits.maxOutputBytes,
    };
    const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], options)).stdout.trim();
    if (head !== packet.git.startingHead) return false;
    const tracked = (await execFileAsync(
      'git',
      ['diff', '--name-only', '-z', 'HEAD', '--'],
      options,
    )).stdout;
    const untracked = (await execFileAsync(
      'git',
      ['ls-files', '--others', '--exclude-standard', '-z', '--'],
      options,
    )).stdout;
    const paths = [...new Set([...nulPaths(tracked), ...nulPaths(untracked)])];
    if (paths.length === 0) return false;
    return paths.every((path) => {
      const absolute = resolve(packet.git.worktree, path);
      const child = relative(packet.git.worktree, absolute);
      if (path.length === 0 || isAbsolute(path) || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
        return false;
      }
      return evaluatePermission(packet, {
        kind: 'write-file',
        path: absolute,
        options: [
          { optionId: 'recover-allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'recover-reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      }).outcome === 'ALLOW_ONCE';
    });
  } catch (error) {
    throw new Error('RUN_WRITER_DIFF_INSPECTION_FAILED', { cause: error });
  }
}

function nulPaths(value: string): string[] {
  return value.split('\0').filter((path) => path.length > 0);
}

function noOpHooks() {
  return {
    onSessionCreated: async () => undefined,
    onPromptIntent: async () => undefined,
    onEvent: async () => undefined,
  };
}

function normalizeError(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'Error', message: String(error) };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
