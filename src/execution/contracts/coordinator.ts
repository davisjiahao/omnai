import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { chmod, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ZodError } from 'zod';
import {
  contractCandidateSchema,
  contractResolutionSchema,
  projectFindingSchema,
  validateContractResolutionAgainstFindings,
  type ContractCandidate,
  type ContractResolution,
  type ProjectFinding,
} from '../artifacts.js';
import type { AgentProbe, AgentProfile, AgentSessionAdapter } from '../agents/types.js';
import { selectAgent } from '../agents/profiles.js';
import {
  disposeSnapshot,
  materializeCoordinationSnapshot,
  type DisposableSnapshot,
} from '../agents/snapshots.js';
import { LocalExecutionBackend, type ExecutionBackend } from '../backend.js';
import { canonicalJson, hashObject, sha256 } from '../hashing.js';
import { nextExecutionId } from '../ids.js';
import { withMutationLockAtPath, withWorksetMutationLock } from '../mutation-lock.js';
import { createRunPacket, type RunPacket } from '../packets.js';
import {
  attentionPath,
  attentionRoot,
  runRoot,
  runsRoot,
} from '../paths.js';
import {
  acceptRunResult,
  createRun,
  dispatchRun,
  type RunExecutionContext,
} from '../runs.js';
import {
  attentionItemSchema,
  type AttentionItem,
  type ContentHash,
} from '../types.js';
import {
  captureContractSources,
  createContractSnapshot,
  supersedeContractSnapshot,
  validateContractSnapshot,
  type ContractCoordinationParticipant,
  type ContractCoordinationScope,
  type ContractSource,
  type ContractStoreContext,
} from './store.js';
import { pathExists, readYaml, writeYaml } from '../../core/files.js';
import { resolveWorkset } from '../../workspace/worksets.js';
import type { Workset, WorksetMember } from '../../workspace/types.js';

const execFileAsync = promisify(execFile);
const MAX_PLANNER_ATTEMPTS = 3;
const ROLE_TIMEOUT_MS = 120_000;
const ROLE_MAX_OUTPUT_BYTES = 1_048_576;

const protocolByKind = {
  CONTRACT_PLANNER: 'execution.contract-planner',
  PROJECT_CRITIC: 'execution.project-critic',
  CONTRACT_RESOLVER: 'execution.contract-resolver',
} as const;

type CoordinationRunKind = keyof typeof protocolByKind;

export interface ContractCoordinatorContext extends ContractStoreContext {
  readonly agentProfiles: readonly AgentProfile[];
  readonly agentProbes: readonly AgentProbe[];
  readonly adapterFor: (profile: AgentProfile) => AgentSessionAdapter;
}

export interface ContractCoordinationOptions {
  readonly criticCapacity?: number;
  readonly preferredAgentId?: string;
}

interface ContractCoordinationResultBase {
  readonly coordinationCycleId: string;
  readonly contractKey: string;
  readonly scopeHash: ContentHash;
  readonly projects: readonly string[];
  readonly runIds: readonly string[];
}

export type ContractCoordinationResult =
  | (ContractCoordinationResultBase & {
      readonly outcome: 'READY';
      readonly contract: { readonly id: string; readonly contentHash: ContentHash };
    })
  | (ContractCoordinationResultBase & {
      readonly outcome: 'INVALID';
      readonly reason: string;
      readonly contractId?: string;
    })
  | (ContractCoordinationResultBase & {
      readonly outcome: 'NEEDS_DECISION';
      readonly attention: AttentionItem;
      readonly contractId: string;
    });

export interface ClassifiedContractFindings {
  readonly corrections: readonly ProjectFinding[];
  readonly resolvableContradictions: readonly ProjectFinding[];
  readonly unresolvedDecisions: readonly ProjectFinding[];
}

export interface ContractCoordinationPacketInvocation {
  readonly runId: string;
  readonly kind: CoordinationRunKind;
  readonly parentRunId?: string;
  readonly objective: string;
  readonly inputPath: string;
  readonly inputHash: ContentHash;
  readonly filesystemRoots: readonly string[];
}

export interface ContractCoordinationCycle {
  readonly id: string;
  readonly scope: ContractCoordinationScope;
  readonly createdAt: string;
  readonly preferredAgentId?: string;
  readonly invocations: readonly ContractCoordinationPacketInvocation[];
}

interface PreparedCoordinationRun {
  readonly packet: RunPacket;
  readonly profile: AgentProfile;
  readonly adapter: AgentSessionAdapter;
  readonly snapshots: readonly DisposableSnapshot[];
}

interface RoleInputSource {
  readonly kind: ContractSource['kind'];
  readonly project: string;
  readonly ref: string;
  readonly contentHash: ContentHash;
  readonly repositoryPath: string;
}

interface RoleInputBase {
  readonly schemaVersion: 1;
  readonly coordinationCycleId: string;
  readonly kind: CoordinationRunKind;
  readonly contractKey: string;
  readonly scopeHash: ContentHash;
  readonly sourceFingerprint: ContentHash;
  readonly participants: readonly ContractCoordinationParticipant[];
}

export function classifyFindings(findings: readonly ProjectFinding[]): ClassifiedContractFindings {
  const parsed = findings.map((finding) => projectFindingSchema.parse(finding));
  const corrections: ProjectFinding[] = [];
  const resolvableContradictions: ProjectFinding[] = [];
  const unresolvedDecisions: ProjectFinding[] = [];
  for (const finding of parsed) {
    if (finding.disposition === 'CORRECTION') corrections.push(finding);
    else if (finding.disposition === 'CONTRADICTION' && finding.resolution === 'EVIDENCE_BACKED') {
      resolvableContradictions.push(finding);
    } else if (finding.disposition === 'NEEDS_DECISION' || finding.disposition === 'CONTRADICTION') {
      unresolvedDecisions.push(finding);
    }
  }
  return {
    corrections: corrections.sort(compareFindings),
    resolvableContradictions: resolvableContradictions.sort(compareFindings),
    unresolvedDecisions: unresolvedDecisions.sort(compareFindings),
  };
}

export async function buildContractCoordinationPackets(
  context: ContractCoordinatorContext,
  cycle: ContractCoordinationCycle,
): Promise<RunPacket[]> {
  requireCycle(cycle);
  return cycle.invocations.map((invocation) => {
    const pool = coordinationAgentPool(context);
    const profile = selectAgent(pool.profiles, pool.probes, {
      role: 'coordination-read-only',
      protocolVersion: 1,
      requireIsolation: true,
      requireResume: true,
      preferredAgentId: cycle.preferredAgentId,
      avoidAgentId: undefined,
    });
    const protocol = protocolByKind[invocation.kind];
    return createRunPacket({
      schemaVersion: 1,
      id: invocation.runId,
      kind: invocation.kind,
      worksetId: context.worksetId,
      ...(invocation.parentRunId === undefined ? {} : { parentRunId: invocation.parentRunId }),
      coordinationCycleId: cycle.id,
      contracts: [],
      objective: invocation.objective,
      protocolIds: [protocol],
      verificationCommands: [],
      evidenceRequired: evidenceRequirements(invocation.kind),
      stopConditions: stopConditions(invocation.kind),
      agent: {
        agentId: profile.agentId,
        protocol: profile.protocol,
        role: 'coordination-read-only',
      },
      limits: { timeoutMs: ROLE_TIMEOUT_MS, maxOutputBytes: ROLE_MAX_OUTPUT_BYTES },
      permissionPolicy: {
        filesystemRoots: sortedUnique(invocation.filesystemRoots),
        terminal: false,
        network: 'DENY',
        denyGitCommit: true,
        denyNestedOmnai: true,
      },
      createdAt: cycle.createdAt,
    });
  });
}

export async function coordinateContract(
  context: ContractCoordinatorContext,
  scope: ContractCoordinationScope,
  options: ContractCoordinationOptions = {},
): Promise<ContractCoordinationResult> {
  requireCoordinatorContext(context);
  requireScope(scope);
  const requestedCriticCapacity = requireCriticCapacity(options.criticCapacity, scope.participants.length);
  const criticCapacity = Math.min(
    requestedCriticCapacity,
    provenCoordinationCapacity(context, options.preferredAgentId),
  );
  const sources = await captureContractSources(context, scope);
  const sourceFingerprint = hashObject(sources.map(withoutAbsolutePath));
  const createdAt = (context.now ?? (() => new Date().toISOString()))();
  const cycle: Omit<ContractCoordinationCycle, 'invocations'> = {
    id: coordinationCycleId(createdAt, scope, sourceFingerprint),
    scope,
    createdAt,
    ...(options.preferredAgentId === undefined ? {} : { preferredAgentId: options.preferredAgentId }),
  };
  const workset = await resolveWorkset(context.home, context.worksetId);
  const runIds: string[] = [];
  const sessionIds = new Set<string>();
  let priorFindings: readonly ProjectFinding[] = [];
  let priorResolutions: readonly ContractResolution[] = [];

  for (let attempt = 1; attempt <= MAX_PLANNER_ATTEMPTS; attempt += 1) {
    let candidate: ContractCandidate;
    let plannerRunId: string;
    try {
      const plannerInput = await plannerRoleInput(
        cycle,
        sourceFingerprint,
        sources,
        priorFindings,
        priorResolutions,
        attempt,
        workset,
      );
      const planner = await prepareCoordinationRun(
        context,
        cycle,
        'CONTRACT_PLANNER',
        plannerInput,
        scope.projects,
        workset,
        sources,
        undefined,
        `Coordinate contractKey=${scope.key};scopeHash=${scope.scopeHash};attempt=${attempt}`,
      );
      plannerRunId = planner.packet.id;
      runIds.push(plannerRunId);
      candidate = contractCandidateSchema.parse((await executePreparedRun(context, planner, sessionIds)).artifact);
    } catch (error) {
      return invalidResult(
        cycle.id,
        scope,
        runIds,
        plannerMappingFailure(error) ?? roleFailure('CONTRACT_PLANNER', error),
      );
    }

    const mappingCodes = candidateMappingCodes(candidate, scope, sources);
    if (mappingCodes.length > 0) {
      return invalidResult(cycle.id, scope, runIds, `TEST_CASE_MAPPING_INCOMPLETE:${mappingCodes.join(',')}`);
    }

    let critics: PreparedCoordinationRun[] = [];
    try {
      for (const participant of scope.participants) {
        const criticInput = await criticRoleInput(
          cycle,
          sourceFingerprint,
          sources,
          candidate,
          participant,
          workset,
        );
        const critic = await prepareCoordinationRun(
          context,
          cycle,
          'PROJECT_CRITIC',
          criticInput,
          [participant.project],
          workset,
          sources.filter((source) => source.project === participant.project),
          plannerRunId,
          `Review contractKey=${scope.key};scopeHash=${scope.scopeHash};` +
            `participant=${participant.project};role=${participant.role}`,
        );
        critics.push(critic);
        runIds.push(critic.packet.id);
      }
    } catch (error) {
      await disposePreparedSnapshots(critics);
      return invalidResult(cycle.id, scope, runIds, roleFailure('PROJECT_CRITIC_PREPARATION', error));
    }

    const backend = context.backend ?? new LocalExecutionBackend();
    const settled = await backend.runBounded(critics, criticCapacity, async (critic, index) => {
      const accepted = await executePreparedRun(context, critic, sessionIds);
      const finding = projectFindingSchema.parse(accepted.artifact);
      assertCriticFinding(finding, candidate, scope.participants[index]!, sources);
      return finding;
    });
    const criticFailures = settled
      .filter((item) => item.status === 'rejected')
      .map((item) => item.reason.message)
      .sort(compare);
    if (criticFailures.length > 0) {
      if (attempt < MAX_PLANNER_ATTEMPTS) continue;
      return invalidResult(
        cycle.id,
        scope,
        runIds,
        `CONTRACT_COORDINATION_BUDGET_EXHAUSTED:${criticFailures.join(',')}`,
      );
    }
    const findings = settled.map((item) => {
      if (item.status !== 'fulfilled') throw new Error('UNREACHABLE_REJECTED_CRITIC');
      return item.value;
    });
    const classified = classifyFindings(findings);

    if (classified.unresolvedDecisions.length > 0) {
      try {
        const fingerprint = decisionFingerprint(context, scope, classified.unresolvedDecisions);
        const existing = await findOpenAttention(context, fingerprint);
        if (existing !== null) {
          const existingContractId = existing.scope.contractId;
          if (existingContractId === undefined) throw new Error('CONTRACT_DECISION_CONTRACT_ID_MISSING');
          return {
            ...resultBase(cycle.id, scope, runIds),
            outcome: 'NEEDS_DECISION',
            attention: existing,
            contractId: existingContractId,
          };
        }
        const snapshot = await createContractSnapshot(context, scope, candidate, sources);
        const attention = await persistDecisionAttention(
          context,
          scope,
          snapshot.id,
          classified.unresolvedDecisions,
        );
        const attentionContractId = attention.scope.contractId;
        if (attentionContractId === undefined) throw new Error('CONTRACT_DECISION_CONTRACT_ID_MISSING');
        return {
          ...resultBase(cycle.id, scope, runIds),
          outcome: 'NEEDS_DECISION',
          attention,
          contractId: attentionContractId,
        };
      } catch (error) {
        return invalidResult(cycle.id, scope, runIds, roleFailure('CONTRACT_DECISION', error));
      }
    }

    if (classified.resolvableContradictions.length > 0) {
      try {
        const resolverSources = citedSources(sources, classified.resolvableContradictions);
        const resolverInput = await resolverRoleInput(
          cycle,
          sourceFingerprint,
          candidate,
          classified.resolvableContradictions,
          resolverSources,
          workset,
        );
        const resolver = await prepareCoordinationRun(
          context,
          cycle,
          'CONTRACT_RESOLVER',
          resolverInput,
          sortedUnique(resolverSources.map((source) => source.project)),
          workset,
          resolverSources,
          plannerRunId,
          `Resolve contractKey=${scope.key};scopeHash=${scope.scopeHash};` +
            `contradictions=${classified.resolvableContradictions.map((item) => item.findingId).join(',')}`,
        );
        runIds.push(resolver.packet.id);
        const resolution = contractResolutionSchema.parse(
          (await executePreparedRun(context, resolver, sessionIds)).artifact,
        );
        applyResolution(candidate, classified.resolvableContradictions, resolution, sources);
        priorFindings = [
          ...classified.corrections,
          ...classified.resolvableContradictions,
        ].sort(compareFindings);
        priorResolutions = [...priorResolutions, resolution];
        continue;
      } catch (error) {
        return invalidResult(cycle.id, scope, runIds, roleFailure('CONTRACT_RESOLVER', error));
      }
    } else if (classified.corrections.length > 0) {
      priorFindings = classified.corrections;
      continue;
    }

    let snapshotId: string | undefined;
    try {
      const snapshot = await createContractSnapshot(context, scope, candidate, sources);
      snapshotId = snapshot.id;
      const validation = await validateContractSnapshot(context, snapshot.id);
      if (!validation.valid) {
        return invalidResult(cycle.id, scope, runIds, validation.codes.join(','), snapshot.id);
      }
      if (validation.manifest.previousSnapshot !== null) {
        await supersedeContractSnapshot(context, validation.manifest.previousSnapshot, validation.manifest.id);
      }
      return {
        ...resultBase(cycle.id, scope, runIds),
        outcome: 'READY',
        contract: { id: validation.manifest.id, contentHash: validation.manifest.contentHash },
      };
    } catch (error) {
      return invalidResult(
        cycle.id,
        scope,
        runIds,
        roleFailure('CONTRACT_FINALIZATION', error),
        snapshotId,
      );
    }
  }
  return invalidResult(cycle.id, scope, runIds, 'CONTRACT_COORDINATION_BUDGET_EXHAUSTED');
}

async function prepareCoordinationRun(
  context: ContractCoordinatorContext,
  cycle: Omit<ContractCoordinationCycle, 'invocations'>,
  kind: CoordinationRunKind,
  input: RoleInputBase & Record<string, unknown>,
  snapshotProjects: readonly string[],
  workset: Workset,
  exactSources: readonly ContractSource[],
  parentRunId: string | undefined,
  objectivePrefix: string,
): Promise<PreparedCoordinationRun> {
  const snapshotIdentities = await Promise.all(sortedUnique(snapshotProjects).map(async (project) => {
    const member = requireActiveMember(workset, project);
    const head = await gitHead(member.worktree);
    return {
      project,
      head,
      contentHash: await gitTreeInventoryHash(member.worktree, head),
    };
  }));
  const allocation = await withMutationLockAtPath(
    join(runsRoot(context.home, context.worksetId), '.coordination-allocation.lock'),
    async () => {
      for (let allocationAttempt = 1; allocationAttempt <= 10; allocationAttempt += 1) {
        const runId = await nextExecutionId(context.home, context.worksetId, 'run');
        const inputRoot = join(runRoot(context.home, context.worksetId, runId), 'inputs');
        const inputPath = join(inputRoot, 'coordination.yaml');
        const snapshotRoots = snapshotIdentities.map((identity) => ({
          ...identity,
          path: plannedCoordinationSnapshotPath(
            context.home,
            context.worksetId,
            runId,
            identity.project,
          ),
        }));
        const boundInput = { ...input, snapshotRoots };
        const inputHash = hashObject(boundInput);
        const invocation: ContractCoordinationPacketInvocation = {
          runId,
          kind,
          ...(parentRunId === undefined ? {} : { parentRunId }),
          objective: `${objectivePrefix};input=${inputPath};inputHash=${inputHash}`,
          inputPath,
          inputHash,
          filesystemRoots: sortedUnique([inputRoot, ...snapshotRoots.map((item) => item.path)]),
        };
        const [packet] = await buildContractCoordinationPackets(context, {
          ...cycle,
          invocations: [invocation],
        });
        if (packet === undefined) throw new Error('CONTRACT_COORDINATION_PACKET_MISSING');
        const profile = requirePacketProfile(context.agentProfiles, packet);
        const adapter = context.adapterFor(profile);
        const runContext = runExecutionContext(
          context,
          profile,
          packet.permissionPolicy.filesystemRoots,
          adapter,
        );
        try {
          await createRun(runContext, packet);
          return { runId, inputPath, snapshotRoots, boundInput, packet, profile, adapter };
        } catch (error) {
          if (!isRunAllocationConflict(error)) throw error;
        }
      }
      throw new Error('CONTRACT_COORDINATION_RUN_ALLOCATION_EXHAUSTED');
    },
    { timeoutMs: 5_000 },
  );
  const { runId, inputPath, snapshotRoots, boundInput, packet, profile, adapter } = allocation;

  const snapshots: DisposableSnapshot[] = [];
  try {
    await writeYaml(inputPath, boundInput);
    await chmod(inputPath, 0o444);
    for (const binding of snapshotRoots) {
      const member = requireActiveMember(workset, binding.project);
      const snapshot = await materializeCoordinationSnapshot({
        home: context.home,
        worksetId: context.worksetId,
        runId,
        project: binding.project,
        repoRoot: member.worktree,
        head: binding.head,
      });
      if (snapshot.path !== binding.path || snapshot.head !== binding.head ||
          snapshot.contentHash !== binding.contentHash) {
        throw new Error(`COORDINATION_SNAPSHOT_BINDING_MISMATCH: ${binding.project}`);
      }
      snapshots.push(snapshot);
    }
    await assertSnapshotSources(workset, snapshots, exactSources);
    return { packet, profile, adapter, snapshots };
  } catch (error) {
    await disposeSnapshots(snapshots);
    throw error;
  }
}

async function executePreparedRun(
  context: ContractCoordinatorContext,
  prepared: PreparedCoordinationRun,
  sessionIds: Set<string>,
) {
  const runContext = runExecutionContext(
    context,
    prepared.profile,
    prepared.packet.permissionPolicy.filesystemRoots,
    prepared.adapter,
  );
  let terminal = false;
  try {
    const finished = await dispatchRun(runContext, prepared.packet.id);
    terminal = finished.status === 'FINISHED' || finished.status === 'BLOCKED' || finished.status === 'SIGNALED';
    const sessionId = finished.agentSessionId;
    if (sessionId === undefined) throw new Error(`CONTRACT_COORDINATION_SESSION_MISSING: ${prepared.packet.id}`);
    if (sessionIds.has(sessionId)) throw new Error(`CONTRACT_COORDINATION_SESSION_REUSED: ${sessionId}`);
    sessionIds.add(sessionId);
    return await acceptRunResult(runContext, prepared.packet.id);
  } finally {
    if (terminal) await disposeSnapshots(prepared.snapshots);
  }
}

function runExecutionContext(
  context: ContractCoordinatorContext,
  profile: AgentProfile,
  roots: readonly string[],
  adapter: AgentSessionAdapter,
): RunExecutionContext {
  return {
    home: context.home,
    worksetId: context.worksetId,
    profile,
    adapter,
    ...(context.backend === undefined ? {} : { backend: context.backend }),
    ...(context.now === undefined ? {} : { now: context.now }),
    additionalDirectories: roots.slice(1),
  };
}

async function plannerRoleInput(
  cycle: Omit<ContractCoordinationCycle, 'invocations'>,
  sourceFingerprint: ContentHash,
  sources: readonly ContractSource[],
  priorFindings: readonly ProjectFinding[],
  priorResolutions: readonly ContractResolution[],
  attempt: number,
  workset: Workset,
): Promise<RoleInputBase & Record<string, unknown>> {
  return {
    ...roleInputBase(cycle, 'CONTRACT_PLANNER', sourceFingerprint),
    attempt,
    sources: roleInputSources(sources, workset),
    priorFindings,
    priorResolutions,
  };
}

async function criticRoleInput(
  cycle: Omit<ContractCoordinationCycle, 'invocations'>,
  sourceFingerprint: ContentHash,
  sources: readonly ContractSource[],
  candidate: ContractCandidate,
  participant: ContractCoordinationParticipant,
  workset: Workset,
): Promise<RoleInputBase & Record<string, unknown>> {
  const ownSources = sources.filter((source) => source.project === participant.project);
  const sharedIntentExcerpts = await Promise.all(sources
    .filter((source) => source.kind === 'intent')
    .map(async (source) => ({
      ref: source.ref,
      contentHash: source.contentHash,
      text: await readExactSourceText(source),
    })));
  return {
    ...roleInputBase(cycle, 'PROJECT_CRITIC', sourceFingerprint),
    participant,
    candidate,
    projectSources: roleInputSources(ownSources, workset),
    sharedIntentExcerpts,
  };
}

async function resolverRoleInput(
  cycle: Omit<ContractCoordinationCycle, 'invocations'>,
  sourceFingerprint: ContentHash,
  candidate: ContractCandidate,
  findings: readonly ProjectFinding[],
  sources: readonly ContractSource[],
  workset: Workset,
): Promise<RoleInputBase & Record<string, unknown>> {
  const citedSourceExcerpts = await Promise.all(sources.map(async (source) => ({
    ref: source.ref,
    contentHash: source.contentHash,
    text: await readExactSourceText(source),
  })));
  return {
    ...roleInputBase(cycle, 'CONTRACT_RESOLVER', sourceFingerprint),
    candidate,
    contradictoryFindings: findings,
    citedSources: roleInputSources(sources, workset),
    citedSourceExcerpts,
  };
}

function roleInputBase(
  cycle: Omit<ContractCoordinationCycle, 'invocations'>,
  kind: CoordinationRunKind,
  sourceFingerprint: ContentHash,
): RoleInputBase {
  return {
    schemaVersion: 1,
    coordinationCycleId: cycle.id,
    kind,
    contractKey: cycle.scope.key,
    scopeHash: cycle.scope.scopeHash,
    sourceFingerprint,
    participants: cycle.scope.participants,
  };
}

function roleInputSources(
  sources: readonly ContractSource[],
  workset: Workset,
): RoleInputSource[] {
  return sources.map((source) => {
    const member = requireActiveMember(workset, source.project);
    const repositoryPath = safeRelative(member.worktree, source.absolutePath);
    return {
      kind: source.kind,
      project: source.project,
      ref: source.ref,
      contentHash: source.contentHash,
      repositoryPath,
    };
  });
}

async function readExactSourceText(source: ContractSource): Promise<string> {
  const bytes = await readFile(source.absolutePath);
  if (sha256(bytes) !== source.contentHash) {
    throw new Error(`COORDINATION_SOURCE_STALE: ${source.ref}`);
  }
  return bytes.toString('utf8');
}

function candidateMappingCodes(
  candidateInput: ContractCandidate,
  scope: ContractCoordinationScope,
  sources: readonly ContractSource[],
): string[] {
  const candidate = contractCandidateSchema.parse(candidateInput);
  const codes: string[] = [];
  if (candidate.contractKey !== scope.key) codes.push('CONTRACT_KEY_MISMATCH');
  if (candidate.scopeHash !== scope.scopeHash) codes.push('CONTRACT_SCOPE_MISMATCH');
  if (canonicalJson(candidate.participants) !== canonicalJson(groupParticipants(scope.participants))) {
    codes.push('PARTICIPANT_SET_MISMATCH');
  }
  const expectedSources = sources.map((source) => ({ ref: source.ref, contentHash: source.contentHash }));
  if (canonicalJson(candidate.sourceHashes) !== canonicalJson(expectedSources)) codes.push('SOURCE_SET_MISMATCH');
  const elementOwners = new Map(candidate.contract.elements.map((element) => [element.id, element.ownerProject]));
  for (const scenario of candidate.businessScenarios) {
    if (scenario.expectedOutcome.trim().length === 0) codes.push(`${scenario.id}:EXPECTED_OUTCOME`);
    if (scenario.executorRefs.length === 0) codes.push(`${scenario.id}:EXECUTOR_REF`);
    if (scenario.participantProjects.length < 2) codes.push(`${scenario.id}:PARTICIPANTS`);
    if (!scenario.contractElementRefs.some((ref) => elementOwners.has(ref))) {
      codes.push(`${scenario.id}:OWNER_PROJECT`);
    }
  }
  return sortedUnique(codes);
}

function assertCriticFinding(
  findingInput: ProjectFinding,
  candidate: ContractCandidate,
  participant: ContractCoordinationParticipant,
  sources: readonly ContractSource[],
): void {
  const finding = projectFindingSchema.parse(findingInput);
  if (finding.project !== participant.project) {
    throw new Error(`CRITIC_PARTICIPANT_MISMATCH: ${finding.project}`);
  }
  if (finding.candidateHash !== hashObject(candidate)) {
    throw new Error(`CRITIC_CANDIDATE_MISMATCH: ${finding.findingId}`);
  }
  const sourceRefs = new Set(sources.map((source) => source.ref));
  const ownSourceRefs = new Set(sources
    .filter((source) => source.project === participant.project)
    .map((source) => source.ref));
  if (finding.evidenceRefs.length === 0 || finding.evidenceRefs.some((ref) => !sourceRefs.has(ref)) ||
      !finding.evidenceRefs.some((ref) => ownSourceRefs.has(ref))) {
    throw new Error(`CRITIC_EVIDENCE_INVALID: ${finding.findingId}`);
  }
  for (const option of finding.candidateOptions) {
    if (option.evidenceRefs.some((ref) => !sourceRefs.has(ref))) {
      throw new Error(`CRITIC_OPTION_EVIDENCE_INVALID: ${finding.findingId}:${option.id}`);
    }
  }
  if ((finding.disposition === 'CONTRADICTION' || finding.disposition === 'NEEDS_DECISION') &&
      finding.candidateOptions.length < 2) {
    throw new Error(`CRITIC_OPTIONS_INCOMPLETE: ${finding.findingId}`);
  }
  if ((finding.disposition === 'CORRECTION' && finding.resolution !== 'NONE') ||
      (finding.disposition === 'NEEDS_DECISION' && finding.resolution !== 'UNRESOLVED')) {
    throw new Error(`CRITIC_RESOLUTION_INVALID: ${finding.findingId}`);
  }
}

function applyResolution(
  candidate: ContractCandidate,
  findings: readonly ProjectFinding[],
  resolutionInput: ContractResolution,
  sources: readonly ContractSource[],
): ContractCandidate {
  const resolution = validateContractResolutionAgainstFindings(resolutionInput, findings);
  if (resolution.candidateHash !== hashObject(candidate)) {
    throw new Error('CONTRACT_RESOLUTION_CANDIDATE_MISMATCH');
  }
  const expected = findings.map((finding) => finding.findingId).sort(compare);
  const actual = resolution.resolutions.map((item) => item.findingId);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error('CONTRACT_RESOLUTION_FINDING_SET_MISMATCH');
  }
  const sourceRefs = new Set(sources.map((source) => source.ref));
  for (const item of resolution.resolutions) {
    if (item.evidenceRefs.some((ref) => !sourceRefs.has(ref))) {
      throw new Error(`CONTRACT_RESOLUTION_EVIDENCE_INVALID: ${item.findingId}`);
    }
  }
  return candidate;
}

async function persistDecisionAttention(
  context: ContractCoordinatorContext,
  scope: ContractCoordinationScope,
  contractId: string,
  findings: readonly ProjectFinding[],
): Promise<AttentionItem> {
  const details = decisionDetails(context, scope, findings);
  const core = {
    kind: 'NEEDS_DECISION' as const,
    scope: { worksetId: context.worksetId, contractId },
    question: details.question,
    options: details.options,
    evidenceRefs: details.evidenceRefs,
    blockingProjects: details.blockingProjects,
    createdByRuns: sortedUnique(findings.map((finding) => finding.runId)),
  };
  return withWorksetMutationLock(context.home, context.worksetId, async () => {
    const existing = await findOpenAttention(context, details.fingerprint);
    if (existing !== null) return existing;
    const id = await nextExecutionId(context.home, context.worksetId, 'attention');
    const createdAt = (context.now ?? (() => new Date().toISOString()))();
    const attention = attentionItemSchema.parse({
      schemaVersion: 1,
      machineVersion: 1,
      lastEventSequence: 0,
      lastEventHash: null,
      id,
      ...core,
      fingerprint: details.fingerprint,
      status: 'OPEN',
      createdAt,
    });
    await writeYaml(attentionPath(context.home, context.worksetId, id), attention);
    return attention;
  }, { timeoutMs: 5_000 });
}

function decisionFingerprint(
  context: ContractStoreContext,
  scope: ContractCoordinationScope,
  findings: readonly ProjectFinding[],
): ContentHash {
  return decisionDetails(context, scope, findings).fingerprint;
}

function decisionDetails(
  context: ContractStoreContext,
  scope: ContractCoordinationScope,
  findings: readonly ProjectFinding[],
): {
  readonly question: string;
  readonly options: AttentionItem['options'];
  readonly evidenceRefs: readonly string[];
  readonly blockingProjects: readonly string[];
  readonly fingerprint: ContentHash;
} {
  const questions = sortedUnique(findings.map((finding) => finding.summary.trim()));
  if (questions.length !== 1 || questions[0]!.length === 0) {
    throw new Error('CONTRACT_DECISION_NOT_PRECISE');
  }
  const optionById = new Map<string, AttentionItem['options'][number]>();
  for (const finding of findings) {
    for (const option of finding.candidateOptions) {
      const value = {
        id: option.id,
        label: option.summary,
        description: option.summary,
        evidenceRefs: option.evidenceRefs,
      };
      const existing = optionById.get(option.id);
      if (existing !== undefined) {
        if (existing.label !== value.label || existing.description !== value.description) {
          throw new Error(`CONTRACT_DECISION_OPTION_CONFLICT: ${option.id}`);
        }
        optionById.set(option.id, {
          ...existing,
          evidenceRefs: sortedUnique([...existing.evidenceRefs, ...value.evidenceRefs]),
        });
      } else {
        optionById.set(option.id, value);
      }
    }
  }
  const stable = {
    kind: 'NEEDS_DECISION' as const,
    scope: {
      worksetId: context.worksetId,
      contractKey: scope.key,
      scopeHash: scope.scopeHash,
    },
    question: questions[0]!,
    options: [...optionById.values()].sort((left, right) => compare(left.id, right.id)),
    evidenceRefs: sortedUnique(findings.flatMap((finding) => [...finding.evidenceRefs])),
    blockingProjects: sortedUnique(findings.map((finding) => finding.project)),
  };
  return { ...stable, fingerprint: hashObject(stable) };
}

async function findOpenAttention(
  context: ContractStoreContext,
  fingerprint: ContentHash,
): Promise<AttentionItem | null> {
  const root = attentionRoot(context.home, context.worksetId);
  if (!(await pathExists(root))) return null;
  const entries = await readdir(root);
  for (const entry of entries.sort(compare)) {
    if (!/^ATTN-\d{4}\.yaml$/.test(entry)) continue;
    const attention = await readYaml(join(root, entry), attentionItemSchema);
    if (attention.status === 'OPEN' && attention.fingerprint === fingerprint) return attention;
  }
  return null;
}

async function assertSnapshotSources(
  workset: Workset,
  snapshots: readonly DisposableSnapshot[],
  sources: readonly ContractSource[],
): Promise<void> {
  const snapshotByProject = new Map(snapshots.map((snapshot) => [snapshot.project, snapshot]));
  for (const source of sources) {
    const snapshot = snapshotByProject.get(source.project);
    if (snapshot === undefined) throw new Error(`COORDINATION_SNAPSHOT_MISSING: ${source.project}`);
    const member = requireActiveMember(workset, source.project);
    const path = join(snapshot.path, safeRelative(member.worktree, source.absolutePath));
    const bytes = await readFile(path);
    if (sha256(bytes) !== source.contentHash) {
      throw new Error(`COORDINATION_SOURCE_SNAPSHOT_STALE: ${source.ref}`);
    }
  }
}

async function disposePreparedSnapshots(prepared: readonly PreparedCoordinationRun[]): Promise<void> {
  await Promise.all(prepared.map((item) => disposeSnapshots(item.snapshots)));
}

async function disposeSnapshots(snapshots: readonly DisposableSnapshot[]): Promise<void> {
  const errors: unknown[] = [];
  for (const snapshot of [...snapshots].reverse()) {
    try {
      await disposeSnapshot(snapshot);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'COORDINATION_SNAPSHOT_DISPOSAL_FAILED');
}

function citedSources(
  sources: readonly ContractSource[],
  findings: readonly ProjectFinding[],
): ContractSource[] {
  const refs = new Set(findings.flatMap((finding) => [
    ...finding.evidenceRefs,
    ...finding.candidateOptions.flatMap((option) => [...option.evidenceRefs]),
  ]));
  const cited = sources.filter((source) => refs.has(source.ref));
  if (cited.length !== refs.size) throw new Error('CONTRACT_RESOLVER_SOURCE_MISSING');
  return cited;
}

function groupParticipants(
  participants: readonly ContractCoordinationParticipant[],
): ContractCandidate['participants'] {
  const grouped = new Map<string, { project: string; role: 'PROVIDER' | 'CONSUMER'; taskRefs: string[] }>();
  for (const participant of participants) {
    const key = `${participant.project}\0${participant.role}`;
    const value = grouped.get(key) ?? {
      project: participant.project,
      role: participant.role,
      taskRefs: [],
    };
    if (!value.taskRefs.includes(participant.taskId)) value.taskRefs.push(participant.taskId);
    value.taskRefs.sort(compare);
    grouped.set(key, value);
  }
  return [...grouped.values()].sort((left, right) =>
    compare(`${left.project}\0${left.role}`, `${right.project}\0${right.role}`));
}

function requireCoordinatorContext(context: ContractCoordinatorContext): void {
  if (context.home.length === 0 || context.worksetId.length === 0) throw new Error('CONTRACT_COORDINATOR_CONTEXT_INVALID');
  if (context.agentProfiles.length === 0 || context.agentProbes.length === 0) {
    throw new Error('CONTRACT_COORDINATOR_AGENT_REQUIRED');
  }
}

function requireScope(scope: ContractCoordinationScope): void {
  if (scope.participants.length < 2 || scope.projects.length < 2) {
    throw new Error('CONTRACT_COORDINATION_PARTICIPANTS_INCOMPLETE');
  }
  if (canonicalJson(scope.projects) !== canonicalJson(sortedUnique(scope.projects))) {
    throw new Error('CONTRACT_COORDINATION_PROJECTS_UNSTABLE');
  }
}

function requireCycle(cycle: ContractCoordinationCycle): void {
  if (!/^CCY-[a-zA-Z0-9._-]+$/.test(cycle.id)) throw new Error('CONTRACT_COORDINATION_CYCLE_ID_INVALID');
  if (cycle.invocations.length === 0) throw new Error('CONTRACT_COORDINATION_INVOCATION_REQUIRED');
  const ids = cycle.invocations.map((invocation) => invocation.runId);
  if (new Set(ids).size !== ids.length) throw new Error('CONTRACT_COORDINATION_RUN_ID_DUPLICATE');
  for (const invocation of cycle.invocations) {
    if (!isAbsolute(invocation.inputPath) || resolve(invocation.inputPath) !== invocation.inputPath) {
      throw new Error('CONTRACT_COORDINATION_INPUT_PATH_INVALID');
    }
    if (!invocation.filesystemRoots.includes(resolve(invocation.inputPath, '..'))) {
      throw new Error('CONTRACT_COORDINATION_INPUT_ROOT_MISSING');
    }
    const binding = `;input=${invocation.inputPath};inputHash=${invocation.inputHash}`;
    if (!/^sha256:[0-9a-f]{64}$/.test(invocation.inputHash) || !invocation.objective.endsWith(binding)) {
      throw new Error('CONTRACT_COORDINATION_INPUT_BINDING_MISMATCH');
    }
  }
}

function requireCriticCapacity(value: number | undefined, participantCount: number): number {
  const capacity = value ?? participantCount;
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new RangeError(`INVALID_CRITIC_CAPACITY: ${String(value)}`);
  }
  return Math.min(capacity, participantCount);
}

function provenCoordinationCapacity(
  context: ContractCoordinatorContext,
  preferredAgentId: string | undefined,
): number {
  const pool = coordinationAgentPool(context);
  const profile = selectAgent(pool.profiles, pool.probes, {
    role: 'coordination-read-only',
    protocolVersion: 1,
    requireIsolation: true,
    requireResume: true,
    preferredAgentId,
    avoidAgentId: undefined,
  });
  const probe = pool.probes.find((candidate) => candidate.agentId === profile.agentId);
  if (probe === undefined) throw new Error(`AGENT_PROBE_MISSING: ${profile.agentId}`);
  const capacity = profile.maxParallelSessions - probe.activeSessions;
  if (capacity <= 0) throw new Error(`AGENT_CAPACITY_EXHAUSTED: ${profile.agentId}`);
  return capacity;
}

function coordinationAgentPool(context: ContractCoordinatorContext): {
  readonly profiles: readonly AgentProfile[];
  readonly probes: readonly AgentProbe[];
} {
  const profiles = context.agentProfiles.filter((profile) => profile.capabilities.additionalDirectories);
  const profileIds = new Set(profiles.map((profile) => profile.agentId));
  const probes = context.agentProbes.filter((probe) => profileIds.has(probe.agentId));
  if (profiles.length === 0) throw new Error('AGENT_ADDITIONAL_DIRECTORIES_REQUIRED');
  return { profiles, probes };
}

function requirePacketProfile(profiles: readonly AgentProfile[], packet: RunPacket): AgentProfile {
  const profile = profiles.find((candidate) => candidate.agentId === packet.agent.agentId &&
    candidate.protocol === packet.agent.protocol);
  if (profile === undefined) throw new Error(`CONTRACT_COORDINATION_PROFILE_MISSING: ${packet.agent.agentId}`);
  return profile;
}

function requireActiveMember(workset: Workset, project: string): WorksetMember & { worktree: string } {
  const member = workset.members.find((candidate) => candidate.project === project);
  if (member?.status !== 'ACTIVE' || member.worktree === undefined) {
    throw new Error(`CONTRACT_PARTICIPANT_NOT_ACTIVE: ${project}`);
  }
  return member as WorksetMember & { worktree: string };
}

async function gitHead(root: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  });
  const head = stdout.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) throw new Error('COORDINATION_GIT_HEAD_INVALID');
  return head;
}

async function gitTreeInventoryHash(root: string, head: string): Promise<ContentHash> {
  return new Promise<ContentHash>((resolveHash, rejectHash) => {
    const child = spawn('git', ['ls-tree', '-r', '--full-tree', head], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const hash = createHash('sha256');
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    let settled = false;
    child.stdout.on('data', (chunk: Buffer) => hash.update(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= 8_192) return;
      const remaining = 8_192 - stderrBytes;
      stderr.push(chunk.subarray(0, remaining));
      stderrBytes += Math.min(chunk.length, remaining);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      rejectHash(new Error('COORDINATION_GIT_TREE_INVENTORY_FAILED', { cause: error }));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolveHash(`sha256:${hash.digest('hex')}`);
        return;
      }
      const detail = Buffer.concat(stderr).toString('utf8').trim();
      rejectHash(new Error(
        `COORDINATION_GIT_TREE_INVENTORY_FAILED: ${String(code ?? signal)}${detail ? `:${detail}` : ''}`,
      ));
    });
  });
}

function safeRelative(root: string, path: string): string {
  const value = relative(resolve(root), resolve(path));
  if (value.length === 0 || value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new Error(`COORDINATION_SOURCE_PATH_INVALID: ${path}`);
  }
  return value;
}

function plannedCoordinationSnapshotPath(
  home: string,
  worksetId: string,
  runId: string,
  project: string,
): string {
  return join(runRoot(home, worksetId, runId), 'snapshots', project);
}

function coordinationCycleId(
  createdAt: string,
  scope: ContractCoordinationScope,
  sourceFingerprint: ContentHash,
): string {
  const timestamp = createdAt.replace(/[^0-9]/gu, '').slice(0, 17);
  const suffix = hashObject({
    worksetScope: { key: scope.key, scopeHash: scope.scopeHash },
    sourceFingerprint,
    createdAt,
  }).slice('sha256:'.length, 'sha256:'.length + 12);
  return `CCY-${timestamp}-${suffix}`;
}

function resultBase(
  coordinationCycleIdValue: string,
  scope: ContractCoordinationScope,
  runIds: readonly string[],
): ContractCoordinationResultBase {
  return {
    coordinationCycleId: coordinationCycleIdValue,
    contractKey: scope.key,
    scopeHash: scope.scopeHash,
    projects: [...scope.projects],
    runIds: [...runIds],
  };
}

function invalidResult(
  coordinationCycleIdValue: string,
  scope: ContractCoordinationScope,
  runIds: readonly string[],
  reason: string,
  contractId?: string,
): Extract<ContractCoordinationResult, { outcome: 'INVALID' }> {
  return {
    ...resultBase(coordinationCycleIdValue, scope, runIds),
    outcome: 'INVALID',
    reason: reason.length === 0 ? 'CONTRACT_VALIDATION_FAILED' : reason,
    ...(contractId === undefined ? {} : { contractId }),
  };
}

function roleFailure(kind: string, error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return `${kind}_FAILED:${messages.join(':') || String(error)}`;
}

function isRunAllocationConflict(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (current.message.startsWith('RUN_ID_ALLOCATION_MISMATCH') ||
        current.message.startsWith('RUN_PACKET_IMMUTABLE')) return true;
    current = current.cause;
  }
  return false;
}

function plannerMappingFailure(error: unknown): string | undefined {
  const mappingFields = new Set([
    'expectedOutcome',
    'executorRefs',
    'participantProjects',
    'sourceRefs',
    'contractElementRefs',
    'fixtureRefs',
  ]);
  let current: unknown = error;
  while (current instanceof Error) {
    if (current instanceof ZodError) {
      const paths = current.issues
        .filter((issue) => issue.path[0] === 'businessScenarios' &&
          mappingFields.has(String(issue.path[2])))
        .map((issue) => `${String(issue.path[1])}:${String(issue.path[2])}`)
        .sort(compare);
      if (paths.length > 0) return `TEST_CASE_MAPPING_INCOMPLETE:${paths.join(',')}`;
    }
    current = current.cause;
  }
  return undefined;
}

function evidenceRequirements(kind: CoordinationRunKind): string[] {
  if (kind === 'CONTRACT_PLANNER') return ['source-hash-traceability', 'stable-business-scenarios'];
  if (kind === 'PROJECT_CRITIC') return ['candidate-hash', 'project-source-citations'];
  return ['candidate-hash', 'contradictory-findings', 'source-citations'];
}

function stopConditions(kind: CoordinationRunKind): string[] {
  const common = ['do-not-invent-absent-intent', 'stop-on-stale-source'];
  return sortedUnique(kind === 'CONTRACT_RESOLVER'
    ? [...common, 'stop-on-irreducible-business-choice']
    : common);
}

function withoutAbsolutePath(source: ContractSource): Omit<ContractSource, 'absolutePath'> {
  const { absolutePath: _absolutePath, ...persisted } = source;
  return persisted;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compare);
}

function compareFindings(left: ProjectFinding, right: ProjectFinding): number {
  return compare(left.findingId, right.findingId);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
