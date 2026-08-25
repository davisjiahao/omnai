import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, resolve, win32 as windowsPath } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import YAML from 'yaml';
import { pathExists, readText, writeYaml } from '../../core/files.js';
import { OMNAI_VERSION } from '../../version.js';
import { hashObject, sha256 } from '../hashing.js';
import { withMutationLockAtPath, type MutationLockOptions } from '../mutation-lock.js';
import type { ContentHash } from '../types.js';
import { userHostManifestSchema } from '../../host/user-host-skills.js';
import { hostManifestMutationLockPath, hostManifestPath } from '../../workspace/paths.js';
import {
  agentProbeSchema,
  agentProfileSchema,
  type AgentConformanceEvidence,
  type AgentProbe,
  type AgentProfile,
  type AgentSelectionRejection,
  type AgentSelectionRejectionCode,
  type AgentSelectionRequest,
} from './types.js';

const HOSTS = ['claude', 'codex', 'opencode'] as const;
type SupportedHost = (typeof HOSTS)[number];

const HOST_LAUNCH = {
  codex: { agentId: 'codex', command: 'codex-acp', args: [] },
  claude: { agentId: 'claude', command: 'claude-agent-acp', args: [] },
  opencode: { agentId: 'opencode', command: 'opencode', args: ['acp'] },
} as const;

const NO_CAPABILITIES = {
  loadSession: false,
  resumeSession: false,
  closeSession: false,
  additionalDirectories: false,
  mcpStdio: false,
} as const;

const HEALTH_RANK = { UNHEALTHY: 0, UNKNOWN: 1, DEGRADED: 2, HEALTHY: 3 } as const;
const COST_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;
const AGENT_PROBE_TIMEOUT_MS = 2_000;
const AGENT_PROBE_TERMINATE_GRACE_MS = 250;
const AGENT_PROBE_STDOUT_LIMIT_BYTES = 1024 * 1024;
const AGENT_PROBE_STDERR_LIMIT_BYTES = 64 * 1024;
const ACP_AUTH_REQUIRED = -32_000;
const POSIX_AGENT_ENVIRONMENT_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'USER',
  'LOGNAME',
  'SHELL',
] as const;
const WINDOWS_AGENT_ENVIRONMENT_KEYS = [
  'PATH',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'TEMP',
  'TMP',
  'USERNAME',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
] as const;

export class AgentSelectionError extends Error {
  readonly code = 'AGENT_NOT_ELIGIBLE';

  constructor(readonly rejections: readonly AgentSelectionRejection[]) {
    super(`AGENT_NOT_ELIGIBLE: ${rejections.map((item) => `${item.agentId}=${item.code}`).join(', ') || 'no profiles configured'}`);
    this.name = 'AgentSelectionError';
  }
}

export function defaultAgentProfileForHost(host: SupportedHost): AgentProfile {
  const launch = HOST_LAUNCH[host];
  return agentProfileSchema.parse({
    schemaVersion: 1,
    agentId: launch.agentId,
    protocol: 'acp',
    command: launch.command,
    args: [...launch.args],
    envRefs: {},
    protocolVersion: 1,
    priority: 100,
    costClass: 'MEDIUM',
    maxParallelSessions: 3,
    isolation: { mode: 'agent-sandbox', enforcedWorkspaceRoots: true },
    capabilities: {
      loadSession: true,
      resumeSession: true,
      closeSession: true,
      additionalDirectories: true,
      mcpStdio: true,
    },
    omnaiModes: ['coordination-read-only', 'project-writer', 'project-reviewer'],
  });
}

export async function loadAgentProfiles(omnaiHome: string): Promise<AgentProfile[]> {
  const profiles: AgentProfile[] = [];
  for (const host of HOSTS) {
    const path = hostManifestPath(omnaiHome, host);
    if (!(await pathExists(path))) continue;
    const { parsed } = await readPhysicalManifest(path);
    profiles.push(...parsed.agents);
  }
  assertUniqueIds(profiles.map((profile) => profile.agentId), 'AGENT_PROFILE_ID_DUPLICATE');
  return profiles;
}

export async function probeAgent(profileInput: AgentProfile): Promise<AgentProbe> {
  const profile = agentProfileSchema.parse(profileInput);
  let conformanceInputHash: ContentHash | undefined;
  try {
    const resolvedCommand = await resolveAgentCommand(profile.command);
    if (!resolvedCommand) return unavailableProbe(profile, 'AGENT_COMMAND_NOT_FOUND');
    conformanceInputHash = await agentConformanceInputHash(profile, resolvedCommand);
    if (profile.protocol !== 'acp') {
      return unavailableProbe(profile, 'AGENT_NATIVE_PROBE_UNPROVEN', conformanceInputHash);
    }
    return await probeAcpAgent(profile, resolvedCommand, conformanceInputHash);
  } catch (error) {
    return unavailableProbe(profile, probeErrorCode(error), conformanceInputHash);
  }
}

async function probeAcpAgent(
  profile: AgentProfile,
  resolvedCommand: string,
  conformanceInputHash: ContentHash,
): Promise<AgentProbe> {
  const child = spawnAgentProbeProcess(
    resolvedCommand,
    profile.args,
    resolveAgentEnvironment(profile),
  );
  const childExited = childExit(child);
  const expectedResponses = new ExpectedAcpResponses();
  const requests = new AcpProbeRequestTransform(expectedResponses);
  const stdout = new AcpProbeOutputTransform(AGENT_PROBE_STDOUT_LIMIT_BYTES, expectedResponses);

  let connection: acp.ClientConnection | undefined;
  let fatalError: AgentProbeFailure | undefined;
  let operationComplete = false;
  const cancellation = new AbortController();
  const fail = (code: string): void => {
    if (operationComplete || fatalError) return;
    fatalError = new AgentProbeFailure(code);
    cancellation.abort();
    connection?.close(fatalError);
  };
  stdout.on('error', (error: Error) => {
    fail(error instanceof AgentProbeFailure ? error.code : 'AGENT_PROBE_PROTOCOL_INVALID');
  });
  requests.on('error', (error: Error) => {
    fail(error instanceof AgentProbeFailure ? error.code : 'AGENT_PROBE_PROTOCOL_INVALID');
  });
  child.stdin.on('error', () => fail('AGENT_PROBE_PROCESS_IO'));
  child.stdout.on('error', () => fail('AGENT_PROBE_PROCESS_IO'));
  child.stderr.on('error', () => fail('AGENT_PROBE_PROCESS_IO'));
  let stderrBytes = 0;
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderrBytes += Buffer.byteLength(chunk);
    if (stderrBytes > AGENT_PROBE_STDERR_LIMIT_BYTES) fail('AGENT_PROBE_STDERR_LIMIT');
  });
  child.once('error', () => fail('AGENT_PROBE_SPAWN_FAILED'));
  child.once('exit', () => fail('AGENT_PROBE_PROCESS_EXIT'));
  const timeout = setTimeout(() => fail('AGENT_PROBE_TIMEOUT'), AGENT_PROBE_TIMEOUT_MS);
  timeout.unref();
  requests.pipe(child.stdin);
  child.stdout.pipe(stdout);

  try {
    const stream = acp.ndJsonStream(
      Writable.toWeb(requests),
      Readable.toWeb(stdout) as ReadableStream<Uint8Array>,
    );
    connection = acp.client({ name: 'omnai-probe' }).connect(stream);
    if (fatalError) throw fatalError;
    const initialized = await connection.agent.request(
      acp.methods.agent.initialize,
      {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'omnai', title: 'OmnAI', version: OMNAI_VERSION },
      },
      { cancellationSignal: cancellation.signal },
    );
    if (fatalError) throw fatalError;

    const compatible = initialized.protocolVersion === acp.PROTOCOL_VERSION;
    const sessionCapabilities = initialized.agentCapabilities?.sessionCapabilities;
    // ACP v1 initialize only advertises authentication capabilities. It does not
    // prove that this process is currently authenticated, so fail closed unless
    // the non-mutating session/list usability check succeeds.
    let authenticated = false;
    if (compatible && sessionCapabilities?.list != null) {
      try {
        await connection.agent.request(
          acp.methods.agent.session.list,
          {},
          { cancellationSignal: cancellation.signal },
        );
        authenticated = true;
      } catch (error) {
        if (error instanceof acp.RequestError && error.code === ACP_AUTH_REQUIRED) {
          authenticated = false;
        } else {
          throw error;
        }
      }
    }
    if (fatalError) throw fatalError;

    return agentProbeSchema.parse({
      schemaVersion: 1,
      agentId: profile.agentId,
      available: true,
      authenticated,
      protocolVersion: initialized.protocolVersion,
      health: compatible && authenticated ? 'HEALTHY' : 'DEGRADED',
      activeSessions: 0,
      capabilities: compatible
        ? {
            loadSession: initialized.agentCapabilities?.loadSession === true,
            resumeSession: sessionCapabilities?.resume != null,
            closeSession: sessionCapabilities?.close != null,
            additionalDirectories: sessionCapabilities?.additionalDirectories != null,
            mcpStdio: true,
          }
        : NO_CAPABILITIES,
      conformanceInputHash,
    });
  } catch (error) {
    if (fatalError) throw fatalError;
    if (child.stdout.readableEnded) {
      throw new AgentProbeFailure('AGENT_PROBE_PROCESS_IO');
    }
    throw error;
  } finally {
    operationComplete = true;
    clearTimeout(timeout);
    cancellation.abort();
    try {
      await terminateProbeChild(child, childExited);
    } finally {
      connection?.close();
      requests.destroy();
      stdout.destroy();
    }
  }
}

export function assertAgentProbePlatformSupported(
  platform: NodeJS.Platform = process.platform,
): void {
  // taskkill cannot reliably find descendants after an untrusted Agent exits
  // its direct process. A controlled Windows Job Object launcher is required
  // before ACP probes can safely execute on Windows.
  if (platform === 'win32') {
    throw new AgentProbeFailure('AGENT_PROBE_WINDOWS_PROCESS_TREE_UNSUPPORTED');
  }
}

export function spawnAgentProbeProcess(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  spawnProcess: typeof spawn = spawn,
): ChildProcessWithoutNullStreams {
  assertAgentProbePlatformSupported(platform);
  const invocation = buildAgentProcessInvocation(command, args, platform);
  return spawnProcess(invocation.command, invocation.args, {
    env: environment,
    shell: invocation.shell,
    detached: invocation.detached,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

export function buildAgentProcessInvocation(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; detached: boolean; shell: false } {
  // Windows cannot execute batch shims with shell:false. Passing profile argv
  // through cmd.exe would add shell parsing, so fail closed until a native shim
  // executable is configured instead.
  if (platform === 'win32' && /\.(?:cmd|bat)$/iu.test(command)) {
    throw new AgentProbeFailure('AGENT_PROBE_WINDOWS_BATCH_UNSUPPORTED');
  }
  return {
    command,
    args: [...args],
    detached: platform !== 'win32',
    shell: false,
  };
}

export function buildWindowsTaskkillInvocation(
  pid: number,
  environment: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[]; shell: false } {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new AgentProbeFailure('AGENT_PROBE_WINDOWS_TREE_TERMINATION_UNAVAILABLE');
  }
  const systemRoot = environmentValue(environment, 'SystemRoot', 'win32') ??
    environmentValue(environment, 'WINDIR', 'win32');
  if (systemRoot === undefined || !windowsPath.isAbsolute(systemRoot)) {
    throw new AgentProbeFailure('AGENT_PROBE_WINDOWS_TREE_TERMINATION_UNAVAILABLE');
  }
  return {
    command: windowsPath.join(systemRoot, 'System32', 'taskkill.exe'),
    args: ['/PID', String(pid), '/T', '/F'],
    shell: false,
  };
}

export async function agentConformanceInputHash(
  profileInput: AgentProfile,
  resolvedCommand: string,
): Promise<ContentHash> {
  const profile = agentProfileSchema.parse(profileInput);
  const canonicalCommand = await realpath(resolvedCommand);
  const executable = await readFile(canonicalCommand);
  const { conformance: _conformance, ...launchProfile } = profile;
  return hashObject({
    launchProfile,
    resolvedCommand: canonicalCommand,
    executableContentHash: sha256(executable),
  });
}

export async function recordAgentConformance(
  omnaiHome: string,
  agentId: string,
  expectedInputHash: ContentHash,
  evidenceInput: AgentConformanceEvidence,
  mutationOptions: MutationLockOptions = {},
): Promise<AgentProfile> {
  const evidence = agentProfileSchema.shape.conformance.unwrap().parse(evidenceInput);
  if (evidence.inputHash !== expectedInputHash) {
    throw new Error(
      `AGENT_CONFORMANCE_CAS_MISMATCH: evidence input ${evidence.inputHash} does not match expected ${expectedInputHash}`,
    );
  }

  return withMutationLockAtPath(hostManifestMutationLockPath(omnaiHome), async () => {
    const located = await locatePhysicalProfile(omnaiHome, agentId);
    await assertCurrentConformanceInput(located.profile, expectedInputHash);

    const latestText = await readText(located.path);
    if (latestText !== located.rawText) {
      throw new Error(`AGENT_CONFORMANCE_CAS_MISMATCH: Agent profile '${agentId}' changed before update`);
    }
    const latest = await parsePhysicalManifest(latestText);
    const matches = latest.parsed.agents
      .map((profile, index) => ({ profile, index }))
      .filter((item) => item.profile.agentId === agentId);
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? `AGENT_PROFILE_NOT_FOUND: ${agentId}`
        : `AGENT_PROFILE_ID_DUPLICATE: ${agentId}`);
    }
    await assertCurrentConformanceInput(matches[0]!.profile, expectedInputHash);

    const rawAgents = physicalAgents(latest.raw);
    const rawProfile = rawAgents[matches[0]!.index];
    if (!isPlainRecord(rawProfile)) {
      throw new Error(`AGENT_PROFILE_INVALID: ${agentId}`);
    }
    rawAgents[matches[0]!.index] = { ...rawProfile, conformance: evidence };
    await writeYaml(located.path, latest.raw);
    return agentProfileSchema.parse(rawAgents[matches[0]!.index]);
  }, mutationOptions);
}

export function selectAgent(
  profileInputs: readonly AgentProfile[],
  probeInputs: readonly AgentProbe[],
  request: AgentSelectionRequest,
): AgentProfile {
  const profiles = profileInputs.map((profile) => agentProfileSchema.parse(profile));
  const probes = probeInputs.map((probe) => agentProbeSchema.parse(probe));
  assertUniqueIds(profiles.map((profile) => profile.agentId), 'AGENT_PROFILE_ID_DUPLICATE');
  assertUniqueIds(probes.map((probe) => probe.agentId), 'AGENT_PROBE_ID_DUPLICATE');

  const profileIds = new Set(profiles.map((profile) => profile.agentId));
  const unknownProbe = probes.find((probe) => !profileIds.has(probe.agentId));
  if (unknownProbe) throw new Error(`AGENT_PROBE_PROFILE_UNKNOWN: ${unknownProbe.agentId}`);
  const probesById = new Map(probes.map((probe) => [probe.agentId, probe]));

  const candidates: Array<{ profile: AgentProfile; probe: AgentProbe }> = [];
  const rejections: AgentSelectionRejection[] = [];
  for (const profile of [...profiles].sort((left, right) => compareCodeUnits(left.agentId, right.agentId))) {
    const probe = probesById.get(profile.agentId);
    const reason = firstRejection(profile, probe, request);
    if (reason) rejections.push({ agentId: profile.agentId, code: reason });
    else candidates.push({ profile, probe: probe! });
  }

  if (candidates.length === 0) throw new AgentSelectionError(rejections);
  candidates.sort((left, right) =>
    left.profile.priority - right.profile.priority ||
    HEALTH_RANK[right.probe.health] - HEALTH_RANK[left.probe.health] ||
    left.probe.activeSessions - right.probe.activeSessions ||
    COST_RANK[left.profile.costClass] - COST_RANK[right.profile.costClass] ||
    Number(left.profile.agentId === request.avoidAgentId) - Number(right.profile.agentId === request.avoidAgentId) ||
    compareCodeUnits(left.profile.agentId, right.profile.agentId));
  return candidates[0]!.profile;
}

function firstRejection(
  profile: AgentProfile,
  probe: AgentProbe | undefined,
  request: AgentSelectionRequest,
): AgentSelectionRejectionCode | undefined {
  if (request.preferredAgentId !== undefined && profile.agentId !== request.preferredAgentId) {
    return 'AGENT_ID_NOT_REQUESTED';
  }
  if (!probe) return 'AGENT_PROBE_MISSING';
  if (!probe.available) return 'AGENT_UNAVAILABLE';
  if (!probe.authenticated) return 'AGENT_AUTHENTICATION_REQUIRED';
  if (probe.protocolVersion !== request.protocolVersion) return 'AGENT_PROTOCOL_VERSION_UNSUPPORTED';
  if (!profile.omnaiModes.includes(request.role)) return 'AGENT_ROLE_UNSUPPORTED';
  if (request.requireIsolation &&
      (profile.isolation.mode === 'none' || !profile.isolation.enforcedWorkspaceRoots)) {
    return 'AGENT_ISOLATION_REQUIRED';
  }
  if (request.requireResume && !probe.capabilities.resumeSession && !probe.capabilities.loadSession) {
    return 'AGENT_RECOVERY_UNSUPPORTED';
  }
  if ((request.requiredMcpTools?.length ?? 0) > 0 && !probe.capabilities.mcpStdio) {
    return 'AGENT_MCP_STDIO_REQUIRED';
  }
  if (!profile.conformance) return 'AGENT_CONFORMANCE_MISSING';
  if (!probe.conformanceInputHash || profile.conformance.inputHash !== probe.conformanceInputHash) {
    return 'AGENT_CONFORMANCE_STALE';
  }
  if (probe.activeSessions >= profile.maxParallelSessions) return 'AGENT_CAPACITY_EXHAUSTED';
  return undefined;
}

async function locatePhysicalProfile(omnaiHome: string, agentId: string): Promise<{
  path: string;
  rawText: string;
  profile: AgentProfile;
}> {
  const matches: Array<{ path: string; rawText: string; profile: AgentProfile }> = [];
  for (const host of HOSTS) {
    const path = hostManifestPath(omnaiHome, host);
    if (!(await pathExists(path))) continue;
    const rawText = await readText(path);
    const { parsed } = await parsePhysicalManifest(rawText);
    for (const profile of parsed.agents) {
      if (profile.agentId === agentId) matches.push({ path, rawText, profile });
    }
  }
  if (matches.length === 0) throw new Error(`AGENT_PROFILE_NOT_FOUND: ${agentId}`);
  if (matches.length !== 1) throw new Error(`AGENT_PROFILE_ID_DUPLICATE: ${agentId}`);
  return matches[0]!;
}

async function assertCurrentConformanceInput(
  profile: AgentProfile,
  expectedInputHash: ContentHash,
): Promise<void> {
  const resolvedCommand = await resolveAgentCommand(profile.command);
  if (!resolvedCommand) {
    throw new Error(`AGENT_CONFORMANCE_CAS_MISMATCH: Agent command for '${profile.agentId}' no longer resolves`);
  }
  const currentInputHash = await agentConformanceInputHash(profile, resolvedCommand);
  if (currentInputHash !== expectedInputHash) {
    throw new Error(
      `AGENT_CONFORMANCE_CAS_MISMATCH: Agent '${profile.agentId}' input changed from ${expectedInputHash} to ${currentInputHash}`,
    );
  }
}

async function readPhysicalManifest(path: string) {
  return parsePhysicalManifest(await readText(path));
}

async function parsePhysicalManifest(rawText: string) {
  const raw: unknown = YAML.parse(rawText);
  return { raw, parsed: userHostManifestSchema.parse(raw) };
}

function physicalAgents(raw: unknown): unknown[] {
  if (!isPlainRecord(raw) || !Array.isArray(raw.agents)) {
    throw new Error('AGENT_MANIFEST_PHYSICAL_AGENTS_MISSING');
  }
  return raw.agents;
}

export async function resolveAgentCommand(command: string): Promise<string | null> {
  const candidates = command.includes('/') || command.includes('\\')
    ? [isAbsolute(command) ? command : resolve(command)]
    : executableCandidates(command);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const canonical = await realpath(candidate);
      if ((await stat(canonical)).isFile()) return canonical;
    } catch {
      // A missing, unreadable, or non-file candidate is not an available Agent.
    }
  }
  return null;
}

function executableCandidates(command: string): string[] {
  const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  const commandHasWindowsExtension = process.platform === 'win32' &&
    extensions.some((extension) => command.toLowerCase().endsWith(extension.toLowerCase()));
  return pathEntries.flatMap((entry) => [
    ...(commandHasWindowsExtension ? [resolve(entry, command)] : []),
    ...extensions.map((extension) => resolve(entry, `${command}${extension}`)),
  ]);
}

function unavailableProbe(
  profile: AgentProfile,
  error: string,
  conformanceInputHash?: ContentHash,
): AgentProbe {
  return agentProbeSchema.parse({
    schemaVersion: 1,
    agentId: profile.agentId,
    available: false,
    authenticated: false,
    protocolVersion: null,
    health: 'UNHEALTHY',
    activeSessions: 0,
    capabilities: NO_CAPABILITIES,
    error,
    ...(conformanceInputHash === undefined ? {} : { conformanceInputHash }),
  });
}

function probeErrorCode(error: unknown): string {
  if (error instanceof AgentProbeFailure) return error.code;
  if (error instanceof acp.RequestError) return 'AGENT_PROBE_PROTOCOL_ERROR';
  if (error instanceof SyntaxError || error instanceof TypeError) return 'AGENT_PROBE_PROTOCOL_INVALID';
  return 'AGENT_PROBE_FAILED';
}

function resolveAgentEnvironment(
  profile: AgentProfile,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const essentialKeys = platform === 'win32'
    ? WINDOWS_AGENT_ENVIRONMENT_KEYS
    : POSIX_AGENT_ENVIRONMENT_KEYS;
  for (const key of essentialKeys) {
    const value = environmentValue(sourceEnvironment, key, platform);
    if (value !== undefined) env[key] = value;
  }
  for (const [targetName, sourceName] of Object.entries(profile.envRefs)) {
    deleteEnvironmentValue(env, targetName, platform);
    const value = environmentValue(sourceEnvironment, sourceName, platform);
    if (value !== undefined) env[targetName] = value;
  }
  return env;
}

function environmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== 'win32') return environment[name];
  const key = Object.keys(environment).find((item) => item.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : environment[key];
}

function deleteEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): void {
  if (platform !== 'win32') {
    delete environment[name];
    return;
  }
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === name.toLowerCase()) delete environment[key];
  }
}

class AgentProbeFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AgentProbeFailure';
  }
}

class ExpectedAcpResponses {
  private readonly requests = new Map<string, ProbeAcpMethod>();

  expect(id: unknown, method: ProbeAcpMethod): void {
    const key = jsonRpcIdKey(id);
    if (key === undefined || this.requests.has(key)) {
      throw new AgentProbeFailure('AGENT_PROBE_PROTOCOL_INVALID');
    }
    this.requests.set(key, method);
  }

  accept(message: unknown): boolean {
    if (!isPlainRecord(message) || message.jsonrpc !== '2.0' || 'method' in message) return false;
    const key = jsonRpcIdKey(message.id);
    if (key === undefined) return false;
    const method = this.requests.get(key);
    if (method === undefined) return false;
    const hasResult = Object.hasOwn(message, 'result');
    const hasError = Object.hasOwn(message, 'error');
    if (hasResult === hasError) return false;
    const allowedKeys = hasResult
      ? new Set(['jsonrpc', 'id', 'result'])
      : new Set(['jsonrpc', 'id', 'error']);
    if (Object.keys(message).some((item) => !allowedKeys.has(item))) return false;
    if (hasError && !isSafeJsonRpcError(message.error)) return false;
    if (hasResult && !isValidAcpProbeResult(method, message.result)) return false;
    this.requests.delete(key);
    return true;
  }
}

type ProbeAcpMethod = typeof acp.methods.agent.initialize | typeof acp.methods.agent.session.list;

class AcpProbeRequestTransform extends Transform {
  private pending = Buffer.alloc(0);

  constructor(private readonly expectedResponses: ExpectedAcpResponses) {
    super();
  }

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.pending = Buffer.concat([this.pending, bytes]);
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
      callback(error instanceof Error ? error : new AgentProbeFailure('AGENT_PROBE_PROTOCOL_INVALID'));
    }
  }

  override _flush(callback: (error?: Error | null) => void): void {
    try {
      if (this.pending.byteLength > 0) this.validateAndPush(this.pending, false);
      this.pending = Buffer.alloc(0);
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new AgentProbeFailure('AGENT_PROBE_PROTOCOL_INVALID'));
    }
  }

  private validateAndPush(line: Buffer, newline: boolean): void {
    const text = line.toString('utf8').trim();
    if (text !== '') {
      let message: unknown;
      try {
        message = JSON.parse(text);
      } catch {
        throw new AgentProbeFailure('AGENT_PROBE_PROTOCOL_INVALID');
      }
      if (!isPlainRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
        throw new AgentProbeFailure('AGENT_PROBE_PROTOCOL_INVALID');
      }
      if (Object.hasOwn(message, 'id')) {
        if (message.method !== acp.methods.agent.initialize && message.method !== acp.methods.agent.session.list) {
          throw new AgentProbeFailure('AGENT_PROBE_PROTOCOL_INVALID');
        }
        this.expectedResponses.expect(message.id, message.method);
      } else if (message.method !== '$/cancel_request') {
        throw new AgentProbeFailure('AGENT_PROBE_PROTOCOL_INVALID');
      }
    }
    this.push(line);
    if (newline) this.push(Buffer.from('\n'));
  }
}

class AcpProbeOutputTransform extends Transform {
  private bytes = 0;
  private pending = Buffer.alloc(0);

  constructor(
    private readonly maxBytes: number,
    private readonly expectedResponses: ExpectedAcpResponses,
  ) {
    super();
  }

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer | string) => void,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.bytes += bytes.byteLength;
    if (this.bytes > this.maxBytes) {
      callback(new AgentProbeFailure('AGENT_PROBE_STDOUT_LIMIT'));
      return;
    }
    this.pending = Buffer.concat([this.pending, bytes]);
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
      callback(error instanceof Error ? error : new AgentProbeFailure('AGENT_PROBE_PROTOCOL_INVALID'));
    }
  }

  override _flush(callback: (error?: Error | null) => void): void {
    try {
      if (this.pending.byteLength > 0) this.validateAndPush(this.pending, false);
      this.pending = Buffer.alloc(0);
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new AgentProbeFailure('AGENT_PROBE_PROTOCOL_INVALID'));
    }
  }

  private validateAndPush(line: Buffer, newline: boolean): void {
    const text = line.toString('utf8').trim();
    if (text !== '') {
      let message: unknown;
      try {
        message = JSON.parse(text);
      } catch {
        throw new AgentProbeFailure('AGENT_PROBE_PROTOCOL_INVALID');
      }
      if (!this.expectedResponses.accept(message)) {
        throw new AgentProbeFailure('AGENT_PROBE_PROTOCOL_INVALID');
      }
    }
    this.push(line);
    if (newline) this.push(Buffer.from('\n'));
  }
}

function jsonRpcIdKey(value: unknown): string | undefined {
  if (value === null) return 'null';
  if (typeof value === 'string') return `string:${value}`;
  if (typeof value === 'number' && Number.isFinite(value)) return `number:${value}`;
  return undefined;
}

function isSafeJsonRpcError(value: unknown): boolean {
  if (!isPlainRecord(value) || !Number.isInteger(value.code) || typeof value.message !== 'string') return false;
  const allowedKeys = new Set(['code', 'message', 'data']);
  return Object.keys(value).every((item) => allowedKeys.has(item));
}

function isValidAcpProbeResult(method: ProbeAcpMethod, value: unknown): boolean {
  return method === acp.methods.agent.initialize
    ? isValidInitializeResult(value)
    : isValidListSessionsResult(value);
}

function isValidInitializeResult(value: unknown): boolean {
  if (!isPlainRecord(value) || !Number.isInteger(value.protocolVersion) ||
      (value.protocolVersion as number) <= 0 || (value.protocolVersion as number) > 65_535) {
    return false;
  }
  // Capabilities from an incompatible protocol version are never consumed.
  if (value.protocolVersion !== acp.PROTOCOL_VERSION) return true;
  if (value.agentCapabilities !== undefined && !isValidAgentCapabilities(value.agentCapabilities)) return false;
  if (value.authMethods !== undefined &&
      (!Array.isArray(value.authMethods) || !value.authMethods.every(isValidAuthMethod))) {
    return false;
  }
  return true;
}

function isValidAgentCapabilities(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  if (value.loadSession !== undefined && typeof value.loadSession !== 'boolean') return false;
  if (value.sessionCapabilities === undefined) return true;
  if (!isPlainRecord(value.sessionCapabilities)) return false;
  for (const name of ['list', 'resume', 'close', 'additionalDirectories'] as const) {
    const capability = value.sessionCapabilities[name];
    if (capability !== undefined && capability !== null && !isPlainRecord(capability)) return false;
  }
  return true;
}

function isValidAuthMethod(value: unknown): boolean {
  return isPlainRecord(value) && typeof value.id === 'string' && typeof value.name === 'string';
}

function isValidListSessionsResult(value: unknown): boolean {
  if (!isPlainRecord(value) || !Array.isArray(value.sessions)) return false;
  if (value.nextCursor !== undefined && value.nextCursor !== null && typeof value.nextCursor !== 'string') {
    return false;
  }
  return value.sessions.every(isValidSessionInfo);
}

function isValidSessionInfo(value: unknown): boolean {
  if (!isPlainRecord(value) || typeof value.sessionId !== 'string' || typeof value.cwd !== 'string') return false;
  if (value.additionalDirectories !== undefined &&
      (!Array.isArray(value.additionalDirectories) ||
       !value.additionalDirectories.every((item) => typeof item === 'string'))) {
    return false;
  }
  for (const name of ['title', 'updatedAt'] as const) {
    const property = value[name];
    if (property !== undefined && property !== null && typeof property !== 'string') return false;
  }
  return true;
}

function childExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolveExit) => {
    child.once('exit', () => resolveExit());
    child.once('error', () => resolveExit());
  });
}

async function terminateProbeChild(
  child: ChildProcessWithoutNullStreams,
  childExited: Promise<void>,
): Promise<void> {
  try {
    if (process.platform === 'win32') {
      throw new AgentProbeFailure('AGENT_PROBE_WINDOWS_PROCESS_TREE_UNSUPPORTED');
    }
    await terminatePosixProcessGroup(child, childExited);
  } finally {
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

async function terminatePosixProcessGroup(
  child: ChildProcessWithoutNullStreams,
  childExited: Promise<void>,
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill('SIGKILL');
    if (!(await settlesWithin(childExited, AGENT_PROBE_TERMINATE_GRACE_MS))) {
      throw new AgentProbeFailure('AGENT_PROBE_TREE_TERMINATION_FAILED');
    }
    return;
  }

  signalPosixProcessGroup(pid, 'SIGTERM');
  if (!(await waitForPosixProcessGroupExit(pid, AGENT_PROBE_TERMINATE_GRACE_MS))) {
    signalPosixProcessGroup(pid, 'SIGKILL');
    if (!(await waitForPosixProcessGroupExit(pid, AGENT_PROBE_TIMEOUT_MS))) {
      child.kill('SIGKILL');
      throw new AgentProbeFailure('AGENT_PROBE_TREE_TERMINATION_FAILED');
    }
  }
  if (!(await settlesWithin(childExited, AGENT_PROBE_TIMEOUT_MS))) {
    child.kill('SIGKILL');
    if (!(await settlesWithin(childExited, AGENT_PROBE_TERMINATE_GRACE_MS))) {
      throw new AgentProbeFailure('AGENT_PROBE_TREE_TERMINATION_FAILED');
    }
  }
}

function signalPosixProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return false;
    throw new AgentProbeFailure('AGENT_PROBE_TREE_TERMINATION_FAILED');
  }
}

async function waitForPosixProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!posixProcessGroupExists(pid)) return true;
    await boundedDelay(10);
  } while (Date.now() < deadline);
  return !posixProcessGroupExists(pid);
}

function posixProcessGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return false;
    if (errorCode(error) === 'EPERM') return true;
    throw new AgentProbeFailure('AGENT_PROBE_TREE_TERMINATION_FAILED');
  }
}

function boundedDelay(timeoutMs: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, timeoutMs));
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveSettled) => {
    const timeout = setTimeout(() => resolveSettled(false), timeoutMs);
    timeout.unref();
    void promise.then(() => {
      clearTimeout(timeout);
      resolveSettled(true);
    });
  });
}

function assertUniqueIds(ids: readonly string[], code: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`${code}: ${id}`);
    seen.add(id);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
