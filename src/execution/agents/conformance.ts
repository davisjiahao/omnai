import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  ensureDir,
  pathExists,
  writeTextAtomic,
} from '../../core/files.js';
import {
  parseArtifactForPacket,
  projectFindingSchema,
  reviewFindingSchema,
  workerResultSchema,
} from '../artifacts.js';
import { canonicalJson, hashObject } from '../hashing.js';
import { createRunPacket, renderRunPrompt, type RunPacket } from '../packets.js';
import { withMutationLockAtPath } from '../mutation-lock.js';
import {
  contentHashSchema,
  projectTestCaseRef,
  type AgentSessionRecord,
} from '../types.js';
import { resolveSecretEnvironment, redactSecrets } from './policy.js';
import {
  agentConformanceInputHash,
  loadAgentProfiles,
  recordAgentConformance,
  resolveAgentCommand,
} from './profiles.js';
import {
  AGENT_ROLES,
  agentProbeSchema,
  agentProfileSchema,
  type AgentProbe,
  type AgentProfile,
  type AgentRole,
  type AgentSessionAdapter,
  type NormalizedAgentEvent,
  type NormalizedPromptResult,
} from './types.js';

export const AGENT_CONFORMANCE_SUITE_VERSION = 1 as const;

export const AGENT_CONFORMANCE_CASE_IDS = [
  'initialize-capabilities',
  'new-session',
  'persist-before-prompt',
  'streamed-update',
  'finish',
  'block',
  'signal',
  'permission-allow',
  'permission-deny',
  'cancellation',
  'close',
  'resume',
  'load',
  'malformed-event-rejection',
  'unexpected-exit',
  'one-session-one-prompt',
  'read-only-roots',
  'writer-root-isolation',
  'output-identity',
  'secret-redaction',
] as const;

export type AgentConformanceCaseId = (typeof AGENT_CONFORMANCE_CASE_IDS)[number];

const conformanceCaseSchema = z.strictObject({
  id: z.enum(AGENT_CONFORMANCE_CASE_IDS),
  status: z.enum(['PASS', 'FAIL']),
  evidenceHash: contentHashSchema,
});

export const conformanceReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  suiteVersion: z.literal(AGENT_CONFORMANCE_SUITE_VERSION),
  adapterId: z.string().min(1),
  inputHash: contentHashSchema,
  roles: z.array(z.enum(AGENT_ROLES)).min(1),
  cases: z.array(conformanceCaseSchema).length(AGENT_CONFORMANCE_CASE_IDS.length),
  passed: z.boolean(),
  evidenceHash: contentHashSchema,
}).superRefine((report, context) => {
  for (let index = 0; index < AGENT_CONFORMANCE_CASE_IDS.length; index += 1) {
    if (report.cases[index]?.id !== AGENT_CONFORMANCE_CASE_IDS[index]) {
      context.addIssue({ code: 'custom', path: ['cases', index, 'id'], message: 'CONFORMANCE_CASE_ORDER_INVALID' });
    }
  }
  if (report.passed !== report.cases.every((item) => item.status === 'PASS')) {
    context.addIssue({ code: 'custom', path: ['passed'], message: 'CONFORMANCE_PASS_STATUS_MISMATCH' });
  }
});

export type ConformanceReport = z.infer<typeof conformanceReportSchema>;

export interface AgentConformanceFixture {
  readonly adapterId: string;
  readonly inputHash: string;
  readonly roles: readonly AgentRole[];
  readonly profile: AgentProfile;
  readonly probe: AgentProbe;
  readonly readonlyRoot: string;
  readonly writerRoot?: string;
  readonly outputRoot: string;
  readonly secretValues?: readonly string[];
  readonly now?: () => string;
}

export type CreateConformanceAdapter = () => AgentSessionAdapter;

export class ExternalActionRequiredError extends Error {
  readonly code = 'EXTERNAL_ACTION_REQUIRED';

  constructor(readonly agentId: string, readonly reason: 'UNAVAILABLE' | 'AUTHENTICATION_REQUIRED') {
    super(`EXTERNAL_ACTION_REQUIRED: agentId=${agentId} reason=${reason}`);
    this.name = 'ExternalActionRequiredError';
  }
}

export async function runAgentConformance(
  createAdapter: CreateConformanceAdapter,
  fixtureInput: AgentConformanceFixture,
): Promise<ConformanceReport> {
  const profile = agentProfileSchema.parse(fixtureInput.profile);
  const probe = agentProbeSchema.parse(fixtureInput.probe);
  const inputHash = contentHashSchema.parse(fixtureInput.inputHash);
  const roles = normalizedRoles(fixtureInput.roles);
  if (probe.agentId !== profile.agentId ||
      canonicalJson(roles) !== canonicalJson(normalizedRoles(profile.omnaiModes))) {
    throw new Error('AGENT_CONFORMANCE_FIXTURE_BINDING_MISMATCH');
  }
  const now = fixtureInput.now ?? (() => new Date().toISOString());
  const secretValues = fixtureInput.secretValues ?? [];
  const adapter = createAdapter();
  const writerRoot = fixtureInput.writerRoot ?? fixtureInput.readonlyRoot;
  await ensureDir(fixtureInput.readonlyRoot);
  await ensureDir(writerRoot);
  await ensureDir(fixtureInput.outputRoot);
  const challenges: ConformanceChallengeObservation[] = [];
  for (let index = 0; index < roles.length; index += 1) {
    const role = roles[index]!;
    challenges.push(await runConformanceChallenge(adapter, {
      profile,
      role,
      runIndex: index + 1,
      cwd: role === 'project-writer' ? writerRoot : fixtureInput.readonlyRoot,
      outputRoot: fixtureInput.outputRoot,
      secretValues,
      now,
    }));
  }

  const serializedObservations = redactSecrets(challenges.map((challenge) => ({
    role: challenge.role,
    runId: challenge.packet.id,
    order: challenge.order,
    eventCount: challenge.events.length,
    promptStatus: challenge.promptResult?.status ?? null,
    stopReason: challenge.promptResult?.status === 'COMPLETED'
      ? challenge.promptResult.stopReason
      : null,
    collected: challenge.collected,
    inspected: challenge.inspected,
    resumed: challenge.resumed,
    signalled: challenge.signalled,
    outputIdentity: challenge.outputIdentity,
    failure: normalizeError(challenge.failure),
  })), secretValues);
  const noSecretLeak = secretValues.every((secret) =>
    secret.length === 0 || !JSON.stringify(serializedObservations).includes(secret));
  const adapterSurface = hasAdapterSurface(adapter);
  const every = (predicate: (challenge: ConformanceChallengeObservation) => boolean): boolean =>
    challenges.every(predicate);
  const lifecycleSucceeded = every((challenge) => challenge.failure === undefined);
  const observations: Record<AgentConformanceCaseId, boolean> = {
    'initialize-capabilities': probe.available && probe.authenticated && probe.protocolVersion === 1 &&
      canonicalJson(probe.capabilities) === canonicalJson(profile.capabilities),
    'new-session': every((challenge) => challenge.session !== undefined),
    'persist-before-prompt': every((challenge) =>
      challenge.order[0] === 'session-persisted' && challenge.order[1] === 'prompt-intended'),
    'streamed-update': every((challenge) => challenge.events.length > 0),
    finish: every((challenge) => challenge.promptResult?.status === 'COMPLETED' &&
      challenge.promptResult.stopReason === 'end_turn'),
    block: lifecycleSucceeded && adapterSurface,
    signal: every((challenge) => challenge.signalled),
    'permission-allow': lifecycleSucceeded && every((challenge) => challenge.outputIdentity),
    'permission-deny': every((challenge) => challenge.packet.permissionPolicy.network === 'DENY' &&
      challenge.packet.permissionPolicy.denyGitCommit && challenge.packet.permissionPolicy.denyNestedOmnai),
    cancellation: every((challenge) => challenge.signalled),
    close: !profile.capabilities.closeSession || every((challenge) => challenge.signalled),
    resume: every((challenge) => challenge.resumed),
    load: !profile.capabilities.loadSession || every((challenge) => challenge.resumed),
    'malformed-event-rejection': adapterSurface,
    'unexpected-exit': adapterSurface,
    'one-session-one-prompt': every((challenge) =>
      challenge.order.filter((item) => item === 'session-persisted').length === 1 &&
      challenge.order.filter((item) => item === 'prompt-intended').length === 1),
    'read-only-roots': every((challenge) => challenge.role === 'project-writer' || (
      challenge.packet.permissionPolicy.filesystemRoots.length === 1 &&
      challenge.packet.permissionPolicy.filesystemRoots[0] === fixtureInput.readonlyRoot &&
      challenge.packet.permissionPolicy.terminal === false &&
      challenge.packet.permissionPolicy.network === 'DENY'
    )),
    'writer-root-isolation': profile.isolation.mode !== 'none' && profile.isolation.enforcedWorkspaceRoots &&
      (!roles.includes('project-writer') || writerRoot !== fixtureInput.readonlyRoot) &&
      every((challenge) => challenge.role !== 'project-writer' ||
        challenge.packet.permissionPolicy.filesystemRoots[0] === writerRoot),
    'output-identity': every((challenge) => challenge.outputIdentity),
    'secret-redaction': noSecretLeak && every((challenge) => challenge.collected && challenge.inspected),
  };
  const cases = AGENT_CONFORMANCE_CASE_IDS.map((id) => ({
    id,
    status: observations[id] ? 'PASS' as const : 'FAIL' as const,
    evidenceHash: hashObject({ id, passed: observations[id], observations: serializedObservations }),
  }));
  const withoutEvidence = {
    schemaVersion: 1 as const,
    suiteVersion: AGENT_CONFORMANCE_SUITE_VERSION,
    adapterId: fixtureInput.adapterId,
    inputHash,
    roles,
    cases,
    passed: cases.every((item) => item.status === 'PASS'),
  };
  return conformanceReportSchema.parse({
    ...withoutEvidence,
    evidenceHash: hashObject(withoutEvidence),
  });
}

interface ConformanceChallengeObservation {
  readonly role: AgentRole;
  readonly packet: RunPacket;
  readonly order: string[];
  readonly events: NormalizedAgentEvent[];
  readonly session: AgentSessionRecord | undefined;
  readonly promptResult: NormalizedPromptResult | undefined;
  readonly collected: boolean;
  readonly inspected: boolean;
  readonly resumed: boolean;
  readonly signalled: boolean;
  readonly outputIdentity: boolean;
  readonly failure: unknown;
}

async function runConformanceChallenge(
  adapter: AgentSessionAdapter,
  input: {
    readonly profile: AgentProfile;
    readonly role: AgentRole;
    readonly runIndex: number;
    readonly cwd: string;
    readonly outputRoot: string;
    readonly secretValues: readonly string[];
    readonly now: () => string;
  },
): Promise<ConformanceChallengeObservation> {
  const packet = createConformancePacket(input.profile, input.role, input.cwd, input.now(), input.runIndex);
  const outputDirectory = join(input.outputRoot, input.role);
  const outputPath = join(outputDirectory, 'result.json');
  await ensureDir(outputDirectory);
  const prompt = await renderRunPrompt(packet, outputPath);
  const events: NormalizedAgentEvent[] = [];
  const order: string[] = [];
  let session: AgentSessionRecord | undefined;
  let promptResult: NormalizedPromptResult | undefined;
  let collected = false;
  let inspected = false;
  let resumed = !input.profile.capabilities.resumeSession && !input.profile.capabilities.loadSession;
  let signalled = false;
  let outputIdentity = false;
  let failure: unknown;

  try {
    promptResult = await adapter.start({
      profile: input.profile,
      packet,
      cwd: input.cwd,
      additionalDirectories: [],
      mcpServers: [],
      prompt,
      outputPath,
    }, {
      onSessionCreated: async (record) => {
        order.push('session-persisted');
        session = record;
      },
      onPromptIntent: async () => {
        if (session === undefined) throw new Error('CONFORMANCE_PROMPT_BEFORE_SESSION');
        order.push('prompt-intended');
      },
      onEvent: async (event) => { events.push(event); },
    });
    if (session === undefined) throw new Error('CONFORMANCE_SESSION_MISSING');
    parseConformanceArtifact(packet, JSON.parse(await readFile(outputPath, 'utf8')) as unknown);
    outputIdentity = true;
    await adapter.collect({
      packet,
      record: session,
      events,
      promptResult,
      secretValues: input.secretValues,
    });
    collected = true;
    await adapter.inspect({ record: session, events, promptResult });
    inspected = true;
    if (input.profile.capabilities.resumeSession || input.profile.capabilities.loadSession) {
      const resumedResult = await adapter.resume({
        profile: input.profile,
        packet,
        cwd: input.cwd,
        additionalDirectories: [],
        mcpServers: [],
        outputPath,
        record: session,
      }, {
        onSessionCreated: async () => { throw new Error('CONFORMANCE_RESUME_CREATED_SESSION'); },
        onPromptIntent: async () => { throw new Error('CONFORMANCE_RESUME_SENT_PROMPT'); },
        onEvent: async () => undefined,
      });
      resumed = resumedResult.status === 'RESUMED' || resumedResult.status === 'RECOVERY_REQUIRED';
    }
    await adapter.signal({ profile: input.profile, packet, record: session, signal: 'STOP' });
    signalled = true;
  } catch (error) {
    failure = error;
  }
  return {
    role: input.role,
    packet,
    order,
    events,
    session,
    promptResult,
    collected,
    inspected,
    resumed,
    signalled,
    outputIdentity,
    failure,
  };
}

export async function ensureAgentConformance(
  omnaiHome: string,
  profileInput: AgentProfile,
  probeInput: AgentProbe,
  createAdapter: CreateConformanceAdapter,
): Promise<AgentProfile> {
  const profile = agentProfileSchema.parse(profileInput);
  const probe = agentProbeSchema.parse(probeInput);
  if (probe.agentId !== profile.agentId) throw new Error('AGENT_CONFORMANCE_PROBE_ID_MISMATCH');
  if (!probe.available) throw new ExternalActionRequiredError(profile.agentId, 'UNAVAILABLE');
  if (!probe.authenticated) throw new ExternalActionRequiredError(profile.agentId, 'AUTHENTICATION_REQUIRED');
  if (probe.protocolVersion !== profile.protocolVersion || probe.conformanceInputHash === undefined) {
    throw new Error('AGENT_CONFORMANCE_PROBE_INCOMPATIBLE');
  }
  const inputHash = probe.conformanceInputHash;
  const resolvedCommand = await resolveAgentCommand(profile.command);
  if (resolvedCommand === null || await agentConformanceInputHash(profile, resolvedCommand) !== inputHash) {
    throw new Error('AGENT_CONFORMANCE_INPUT_HASH_MISMATCH');
  }
  const path = conformanceReportPath(omnaiHome, profile.agentId, inputHash);
  return withMutationLockAtPath(`${path}.lock`, async () => {
    const currentProfile = await requireCurrentProfile(omnaiHome, profile.agentId);
    const currentCommand = await resolveAgentCommand(currentProfile.command);
    if (currentCommand === null || await agentConformanceInputHash(currentProfile, currentCommand) !== inputHash) {
      throw new Error('AGENT_CONFORMANCE_INPUT_HASH_MISMATCH');
    }
    const reusable = await loadReusableReport(path, currentProfile, inputHash);
    if (reusable !== null &&
        currentProfile.conformance?.suiteVersion === AGENT_CONFORMANCE_SUITE_VERSION &&
        currentProfile.conformance.inputHash === inputHash &&
        currentProfile.conformance.evidenceHash === reusable.evidenceHash) {
      return currentProfile;
    }

    const temporaryRoot = await mkdtemp(join(tmpdir(), 'omnai-agent-conformance-'));
    try {
      const readonlyRoot = join(temporaryRoot, 'readonly');
      const writerRoot = join(temporaryRoot, 'writer');
      const outputRoot = join(temporaryRoot, 'output');
      await ensureDir(readonlyRoot);
      await ensureDir(writerRoot);
      await ensureDir(outputRoot);
      const secrets = Object.values(resolveSecretEnvironment(currentProfile, process.env));
      const report = await runAgentConformance(createAdapter, {
        adapterId: `${currentProfile.protocol}-v${currentProfile.protocolVersion}`,
        inputHash,
        roles: currentProfile.omnaiModes,
        profile: currentProfile,
        probe,
        readonlyRoot,
        writerRoot,
        outputRoot,
        secretValues: secrets,
      });
      await persistConformanceReport(path, report, secrets);
      if (!report.passed) throw new Error(`AGENT_CONFORMANCE_FAILED: ${currentProfile.agentId}`);
      return recordAgentConformance(omnaiHome, currentProfile.agentId, inputHash, {
        suiteVersion: AGENT_CONFORMANCE_SUITE_VERSION,
        passedAt: new Date().toISOString(),
        inputHash,
        evidenceHash: report.evidenceHash,
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, { timeoutMs: 120_000 });
}

export function conformanceReportPath(
  omnaiHome: string,
  agentId: string,
  inputHash: string,
): string {
  const parsedHash = /^sha256:([0-9a-f]{64})$/.exec(inputHash);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(agentId) || !parsedHash) {
    throw new Error('AGENT_CONFORMANCE_PATH_INVALID');
  }
  return join(
    omnaiHome,
    'conformance',
    'agents',
    agentId,
    `sha256-${parsedHash[1]}.json`,
  );
}

async function loadReusableReport(
  path: string,
  profile: AgentProfile,
  inputHash: string,
): Promise<ConformanceReport | null> {
  if (!(await pathExists(path))) return null;
  try {
    const report = conformanceReportSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    const { evidenceHash: _evidenceHash, ...withoutEvidence } = report;
    if (!report.passed || report.adapterId !== `${profile.protocol}-v${profile.protocolVersion}` ||
        report.inputHash !== inputHash ||
        canonicalJson(report.roles) !== canonicalJson(normalizedRoles(profile.omnaiModes)) ||
        report.evidenceHash !== hashObject(withoutEvidence)) {
      return null;
    }
    return report;
  } catch {
    return null;
  }
}

async function requireCurrentProfile(omnaiHome: string, agentId: string): Promise<AgentProfile> {
  const profiles = (await loadAgentProfiles(omnaiHome)).filter((item) => item.agentId === agentId);
  if (profiles.length === 0) throw new Error(`AGENT_PROFILE_NOT_FOUND: ${agentId}`);
  if (profiles.length !== 1) throw new Error(`AGENT_PROFILE_ID_DUPLICATE: ${agentId}`);
  return profiles[0]!;
}

async function persistConformanceReport(
  path: string,
  report: ConformanceReport,
  secretValues: readonly string[],
): Promise<void> {
  const redacted = redactSecrets(report, secretValues);
  const parsed = conformanceReportSchema.parse(redacted);
  await ensureDir(dirname(path));
  await writeTextAtomic(path, `${JSON.stringify(parsed, null, 2)}\n`);
}

function createConformancePacket(
  profile: AgentProfile,
  role: AgentRole,
  root: string,
  createdAt: string,
  runIndex: number,
): RunPacket {
  const common = {
    schemaVersion: 1,
    id: `RUN-${String(runIndex).padStart(4, '0')}`,
    worksetId: 'WKS-0001',
    contracts: [],
    verificationCommands: [],
    evidenceRequired: [],
    stopConditions: [],
    limits: { timeoutMs: 30_000, maxOutputBytes: 1_048_576 },
    createdAt,
  } as const;
  if (role === 'coordination-read-only') {
    return createRunPacket({
      ...common,
      kind: 'PROJECT_CRITIC',
      objective: 'Conformance probe: write one ACCEPT ProjectFinding for project conformance-project.',
      protocolIds: ['execution.project-critic'],
      agent: {
        agentId: profile.agentId,
        protocol: profile.protocol,
        role: 'coordination-read-only',
      },
      permissionPolicy: {
        filesystemRoots: [root],
        terminal: false,
        network: 'DENY',
        denyGitCommit: true,
        denyNestedOmnai: true,
      },
    });
  }

  const projectCommon = {
    ...common,
    waveId: 'WAVE-0001',
    scopedTask: {
      project: 'conformance-project',
      changeId: 'CHG-0001',
      revision: 'REV-0001',
      baseline: 'BL-0001',
      taskId: 'TASK-001',
    },
    git: {
      startingHead: 'a'.repeat(40),
      worktree: root,
      branch: 'omnai/conformance',
    },
    allowedPaths: ['**'],
    verificationPlan: { id: 'VPL-0001', contentHash: hashObject('conformance-plan') },
    testCaseRefs: [projectTestCaseRef({
      project: 'conformance-project',
      changeId: 'CHG-0001',
      revision: 'REV-0001',
    }, 'TC-0001', hashObject('conformance-case'))],
    commandRefs: ['conformance.noop'],
  } as const;
  if (role === 'project-reviewer') {
    return createRunPacket({
      ...projectCommon,
      kind: 'PROJECT_REVIEWER',
      objective: 'Conformance probe: write one APPROVE ReviewFinding.',
      protocolIds: ['execution.project-reviewer'],
      agent: {
        agentId: profile.agentId,
        protocol: profile.protocol,
        role: 'project-reviewer',
      },
      permissionPolicy: {
        filesystemRoots: [root],
        terminal: false,
        network: 'DENY',
        denyGitCommit: true,
        denyNestedOmnai: true,
      },
    });
  }
  return createRunPacket({
    ...projectCommon,
    kind: 'PROJECT_WRITER',
    objective: 'Conformance probe: write one FINISH WorkerResult without changing project files.',
    protocolIds: ['execution.project-writer'],
    agent: {
      agentId: profile.agentId,
      protocol: profile.protocol,
      role: 'project-writer',
    },
    permissionPolicy: {
      filesystemRoots: [root],
      terminal: true,
      network: 'DENY',
      denyGitCommit: true,
      denyNestedOmnai: true,
    },
  });
}

function parseConformanceArtifact(packet: RunPacket, value: unknown): void {
  if (packet.kind === 'PROJECT_WRITER' || packet.kind === 'RECOVERY_WRITER') {
    parseArtifactForPacket(packet, workerResultSchema, value);
  } else if (packet.kind === 'PROJECT_REVIEWER') {
    parseArtifactForPacket(packet, reviewFindingSchema, value);
  } else {
    parseArtifactForPacket(packet, projectFindingSchema, value);
  }
}

function normalizedRoles(roles: readonly AgentRole[]): AgentRole[] {
  return [...new Set(roles)].sort(compare);
}

function hasAdapterSurface(adapter: AgentSessionAdapter): boolean {
  return ['probe', 'start', 'inspect', 'signal', 'collect', 'resume']
    .every((method) => typeof adapter[method as keyof AgentSessionAdapter] === 'function');
}

function normalizeError(error: unknown): { name: string; message: string } | null {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : error === undefined
      ? null
      : { name: 'Error', message: String(error) };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
