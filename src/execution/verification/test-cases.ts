import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { pathExists, readYaml, writeTextAtomic } from '../../core/files.js';
import {
  changeArtifactPath,
  changeMetadataPath,
  changeRevisionsRoot,
  projectConfigPath,
} from '../../core/paths.js';
import { loadProjectConfig, resolveChange } from '../../core/store.js';
import { loadTasks } from '../../core/tasks.js';
import { revisionSchema, type Task } from '../../domain/types.js';
import {
  projectTestPlanCandidateSchema,
  type ProjectTestPlanCandidate,
} from '../artifacts.js';
import {
  disposeSnapshot,
  materializeCoordinationSnapshot,
  type DisposableSnapshot,
} from '../agents/snapshots.js';
import {
  loadReadyContractSnapshotsForTask,
  type ContractSnapshot,
} from '../contracts/store.js';
import { canonicalJson, hashObject, sha256 } from '../hashing.js';
import { nextExecutionId } from '../ids.js';
import { withMutationLockAtPath } from '../mutation-lock.js';
import {
  createRunPacket,
  loadRunPacket,
  persistRunPacket,
  type ProjectTestPlannerContractScenario,
  type RunPacket,
} from '../packets.js';
import { executionRoot, runOutputPath, runPacketPath } from '../paths.js';
import {
  acceptRunResult,
  createRun,
  dispatchRun,
  type RunExecutionContext,
} from '../runs.js';
import {
  contractScenarioRefSchema,
  contractTestCaseRef,
  hashTestCase,
  hashVerificationPolicyDefinition,
  projectTestCaseRef,
  scopedTaskRefSchema,
  testCaseSchema,
  type ContentHash,
  type ContractScenarioRef,
  type IntegrationEnvironmentProfile,
  type IntegrationEnvironmentProfileRef,
  type NotApplicableDecision,
  type ScopedTaskRef,
  type TestCase,
  type TestCaseRef,
  type VerificationScenarioClassRule,
  type VerificationNotApplicableRule,
  type VerificationTaskRiskRule,
} from '../types.js';
import { resolveWorkset } from '../../workspace/worksets.js';
export {
  compileTestCase,
  testCaseScopedIdentityKey,
  VerificationFlowError,
} from './test-case-compiler.js';
export type {
  CompiledTestCase,
  VerificationFlowIssueCode,
} from './test-case-compiler.js';

const projectSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const gitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const runIdSchema = z.string().regex(/^RUN-\d{4}$/);
const testCaseIdSchema = z.string().regex(/^TC-\d{4}$/);
const sourceRefSchema = z.strictObject({
  ref: z.string().min(1),
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

const coreTestCaseEvidenceRequirements = new Set([
  'build', 'contract', 'data', 'exit-code', 'lint', 'manual', 'migration', 'output-hash',
  'qa', 'reproduction', 'review', 'rollback', 'runtime', 'security', 'service-logs',
  'test', 'test-results', 'typecheck',
]);

export const projectTestCommandDefinitionSchema = z.strictObject({
  commandRef: z.string().min(1),
  executable: z.string().min(1),
  argv: z.array(z.string()).readonly(),
  cwd: z.string().min(1),
  network: z.enum(['ALLOW', 'DENY']),
  timeoutMs: z.number().int().positive(),
  outputLimit: z.number().int().positive(),
  caseRefs: z.array(testCaseIdSchema).min(1).readonly(),
}).superRefine((definition, context) => {
  requireSortedUnique(definition.caseRefs, (item) => item, 'caseRefs', context);
});
export type ProjectTestCommandDefinition = z.infer<typeof projectTestCommandDefinitionSchema>;

const projectTestCaseSetWithoutHashSchema = z.strictObject({
  schemaVersion: z.literal(1),
  project: projectSchema,
  changeId: z.string().regex(/^CHG-\d{4}$/),
  revision: z.string().regex(/^REV-\d{4}$/),
  baseline: z.string().regex(/^BL-\d{4}$/),
  sourceSnapshot: z.strictObject({
    head: gitObjectIdSchema,
    tree: gitObjectIdSchema,
    contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }),
  sourceRefs: z.array(sourceRefSchema).min(1).readonly(),
  acceptanceCriteria: z.array(sourceRefSchema).min(1).readonly(),
  manifestRefs: z.array(sourceRefSchema).readonly(),
  scopedTasks: z.array(scopedTaskRefSchema).min(1).readonly(),
  testCases: z.array(testCaseSchema).readonly(),
  commandDefinitions: z.array(projectTestCommandDefinitionSchema).readonly(),
  plannerRun: z.strictObject({
    id: runIdSchema,
    kind: z.literal('PROJECT_TEST_PLANNER'),
    packetHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    createdAt: z.string().datetime(),
  }),
});

export const projectTestCaseSetSchema = projectTestCaseSetWithoutHashSchema.extend({
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict().superRefine((set, context) => {
  requireSortedUnique(set.scopedTasks, scopedTaskKey, 'scopedTasks', context);
  requireSortedUnique(set.sourceRefs, sourceRefKey, 'sourceRefs', context);
  requireSortedUnique(set.acceptanceCriteria, sourceRefKey, 'acceptanceCriteria', context);
  requireSortedUnique(set.manifestRefs, sourceRefKey, 'manifestRefs', context);
  requireSortedUnique(set.testCases, (item) => item.id, 'testCases', context);
  requireSortedUnique(set.commandDefinitions, (item) => item.commandRef, 'commandDefinitions', context);
  if (set.scopedTasks.some((task) => task.project !== set.project || task.changeId !== set.changeId ||
      task.revision !== set.revision || task.baseline !== set.baseline)) {
    context.addIssue({ code: 'custom', path: ['scopedTasks'], message: 'PROJECT_TEST_CASE_SET_SCOPE_MISMATCH' });
  }
  const caseIds = new Set(set.testCases.map((item) => item.id));
  const definitions = new Map(set.commandDefinitions.map((item) => [item.commandRef, item]));
  for (const testCase of set.testCases) {
    for (const commandRef of testCase.commandRefs) {
      const definition = definitions.get(commandRef);
      if (definition === undefined || !definition.caseRefs.includes(testCase.id)) {
        context.addIssue({
          code: 'custom', path: ['commandDefinitions'],
          message: `COMMAND_CASE_MAPPING_MISSING:${commandRef}:${testCase.id}`,
        });
      }
    }
  }
  if (set.commandDefinitions.some((definition) => definition.caseRefs.some((id) => !caseIds.has(id)))) {
    context.addIssue({ code: 'custom', path: ['commandDefinitions'], message: 'COMMAND_CASE_UNDEFINED' });
  }
  if (set.contentHash !== hashProjectTestCaseSet(set)) {
    context.addIssue({ code: 'custom', path: ['contentHash'], message: 'PROJECT_TEST_CASE_SET_HASH_MISMATCH' });
  }
});
export type ProjectTestCaseSet = z.infer<typeof projectTestCaseSetSchema>;

export interface VerificationPolicyRef {
  readonly id: string;
  readonly version: number;
  readonly taskRiskRules: readonly VerificationTaskRiskRule[];
  readonly scenarioClassRules: readonly VerificationScenarioClassRule[];
  readonly notApplicableRules: readonly VerificationNotApplicableRule[];
  readonly contentHash: ContentHash;
}

export function createVerificationPolicy(
  input: Omit<VerificationPolicyRef, 'contentHash'>,
): VerificationPolicyRef {
  const normalized = {
    id: input.id,
    version: input.version,
    taskRiskRules: [...input.taskRiskRules].map((rule) => ({
      risk: rule.risk,
      requiredLevelGroups: [...rule.requiredLevelGroups]
        .map((group) => [...group].sort(compare))
        .sort((left, right) => compare(JSON.stringify(left), JSON.stringify(right))),
    })).sort((left, right) => compare(left.risk, right.risk)),
    scenarioClassRules: [...input.scenarioClassRules].map((rule) => ({
      scenarioClass: rule.scenarioClass,
      allowedLevels: [...rule.allowedLevels].sort(compare),
    })).sort((left, right) => compare(left.scenarioClass, right.scenarioClass)),
    notApplicableRules: [...input.notApplicableRules].map((rule) => ({
      subjectKind: rule.subjectKind,
      allowedTaskRisks: [...rule.allowedTaskRisks].sort(compare),
      allowedScenarioClasses: [...rule.allowedScenarioClasses].sort(compare),
    })).sort((left, right) => compare(left.subjectKind, right.subjectKind)),
  };
  return { ...normalized, contentHash: hashVerificationPolicyDefinition(normalized) };
}

export function createDefaultVerificationPolicy(): VerificationPolicyRef {
  return createVerificationPolicy({
    id: 'omnai-default-verification',
    version: 1,
    taskRiskRules: [
      { risk: 'CRITICAL', requiredLevelGroups: [['COMPONENT', 'UNIT'], ['E2E', 'INTEGRATION']] },
      { risk: 'HIGH', requiredLevelGroups: [['COMPONENT', 'UNIT'], ['E2E', 'INTEGRATION']] },
      {
        risk: 'LOW',
        requiredLevelGroups: [[
          'COMPONENT', 'CONTRACT_CONSUMER', 'CONTRACT_PROVIDER', 'E2E', 'INTEGRATION', 'UNIT',
        ]],
      },
      {
        risk: 'MEDIUM',
        requiredLevelGroups: [[
          'COMPONENT', 'CONTRACT_CONSUMER', 'CONTRACT_PROVIDER', 'E2E', 'INTEGRATION', 'UNIT',
        ]],
      },
    ],
    scenarioClassRules: [
      'BOUNDARY', 'COMPATIBILITY', 'FAILURE', 'NORMAL', 'RETRY',
    ].map((scenarioClass) => ({
      scenarioClass: scenarioClass as 'BOUNDARY' | 'COMPATIBILITY' | 'FAILURE' | 'NORMAL' | 'RETRY',
      allowedLevels: ['CONTRACT_CONSUMER', 'CONTRACT_PROVIDER', 'E2E', 'INTEGRATION'],
    })),
    notApplicableRules: [
      { subjectKind: 'ACCEPTANCE_CRITERION', allowedTaskRisks: ['LOW'], allowedScenarioClasses: [] },
      { subjectKind: 'CONTRACT_SCENARIO', allowedTaskRisks: [], allowedScenarioClasses: ['COMPATIBILITY'] },
      { subjectKind: 'TASK', allowedTaskRisks: ['LOW'], allowedScenarioClasses: [] },
    ],
  });
}

export interface VerificationPlannerContext {
  readonly home: string;
  readonly worksetId: string;
  readonly now?: () => string;
  readonly runContext?: RunExecutionContext;
  readonly plannerRunner?: (request: ProjectTestPlannerRequest) => Promise<ProjectTestPlanCandidate>;
  readonly contractSnapshotResolver?: (scopedTask: ScopedTaskRef) => Promise<ContractSnapshot[]>;
  readonly profileResolver?: (profileId: string) => Promise<IntegrationEnvironmentProfile>;
  readonly profileRefResolver?: (profileId: string) => Promise<IntegrationEnvironmentProfileRef>;
  readonly policy?: VerificationPolicyRef;
  readonly notApplicableDecisions?: readonly NotApplicableDecision[];
  readonly planPersistenceFaults?: {
    readonly afterInventoryStaged?: () => void | Promise<void>;
  };
  readonly metadataCommitFaults?: {
    readonly beforeRefUpdate?: () => void | Promise<void>;
    readonly afterRefUpdate?: () => void | Promise<void>;
  };
}

export interface ProjectTestPlannerRequest {
  readonly packet: Extract<RunPacket, { kind: 'PROJECT_TEST_PLANNER' }>;
  readonly snapshot: DisposableSnapshot;
}

export interface ProjectTestCasePreparation {
  readonly status: 'READY';
  readonly project: string;
  readonly plannerRun: {
    readonly id: string;
    readonly kind: 'PROJECT_TEST_PLANNER';
    readonly contentHash: ContentHash;
  };
  readonly commit: string;
  readonly contentHash: ContentHash;
  readonly testCases: readonly TestCase[];
  readonly commandDefinitions: readonly ProjectTestCommandDefinition[];
}

interface ProjectPlanningInput {
  readonly project: string;
  readonly worktree: string;
  readonly branch: string;
  readonly headRef: string;
  readonly changeDirectory: string;
  readonly changeId: string;
  readonly revision: string;
  readonly baseline: string;
  readonly head: string;
  readonly tree: string;
  readonly treeInventoryHash: ContentHash;
  readonly scopedTasks: readonly ScopedTaskRef[];
  readonly tasks: readonly Task[];
  readonly sourceRefs: readonly z.infer<typeof sourceRefSchema>[];
  readonly acceptanceCriteria: readonly z.infer<typeof sourceRefSchema>[];
  readonly manifestRefs: readonly z.infer<typeof sourceRefSchema>[];
  readonly legacyCommands: readonly string[];
  readonly authorizedCommands: readonly AuthorizedCommand[];
}

interface AuthorizedCommand {
  readonly hint: { readonly executable: string; readonly argv: readonly string[] };
  readonly resolved: { readonly executable: string; readonly argv: readonly string[] };
}

export async function ensureProjectTestCases(
  context: VerificationPlannerContext,
  scopedTask: ScopedTaskRef,
): Promise<ProjectTestCasePreparation> {
  assertContextTask(context, scopedTask);
  const lockPath = join(
    executionRoot(context.home, context.worksetId),
    `project-test-cases-${scopedTask.project}.lock`,
  );
  return withMutationLockAtPath(lockPath, async () => {
    const input = await captureProjectPlanningInput(context, scopedTask);
    assertSafeLegacyCommands(input.worktree, input.legacyCommands);
    const path = projectTestCasesPath(input);
    if (await pathExists(path)) {
      try {
        const set = await loadProjectTestCaseSet(context, scopedTask);
        const trustedCommit = trustedPreparationCommit(input.worktree, path, set);
        if (trustedCommit !== undefined) {
          assertOnlyTargetMayBeDirty(input.worktree, path);
          synchronizeTargetIndexToCommit(input.worktree, path, trustedCommit);
          return preparationFromSet(set, trustedCommit);
        }
        if (gitText(input.worktree, ['rev-parse', 'HEAD']) === set.sourceSnapshot.head) {
          assertOnlyTargetMayBeDirty(input.worktree, path);
          const recovered = await publishProjectTestCaseSet(context, input, path, set);
          return preparationFromSet(recovered.set, recovered.commit);
        }
        throw new Error(`PROJECT_TEST_CASE_PREPARATION_COMMIT_UNTRUSTED:${input.project}`);
      } catch (error) {
        if (!isReplannableCaseError(error)) throw error;
      }
    }
    const recovered = await recoverPublishedPreparation(context, input, path);
    if (recovered !== undefined) return recovered;
    const staged = await loadStagedProjectTestCaseSet(context, input);
    if (staged !== undefined) {
      const published = await publishProjectTestCaseSet(context, input, path, staged);
      return preparationFromSet(published.set, published.commit);
    }
    assertOnlyTargetMayBeDirty(input.worktree, path);
    const candidate = await runProjectTestPlanner(context, scopedTask);
    const set = await validateAndPersistProjectTestCases(context, candidate);
    return preparationFromSet(set, gitText(input.worktree, ['rev-parse', 'HEAD']));
  }, { timeoutMs: 300_000 });
}

export async function runProjectTestPlanner(
  context: VerificationPlannerContext,
  scopedTask: ScopedTaskRef,
): Promise<ProjectTestPlanCandidate> {
  assertContextTask(context, scopedTask);
  const input = await captureProjectPlanningInput(context, scopedTask);
  assertOnlyTargetMayBeDirty(input.worktree, projectTestCasesPath(input));
  assertSafeLegacyCommands(input.worktree, input.legacyCommands);
  const runId = await nextExecutionId(context.home, context.worksetId, 'run');
  const snapshotPath = coordinationSnapshotPath(context, runId, input.project);
  const snapshots = await loadApplicableContractSnapshots(context, input.scopedTasks);
  const contracts = uniqueBy(
    snapshots.map((snapshot) => ({ id: snapshot.manifest.id, contentHash: snapshot.manifest.contentHash })),
    (item) => `${item.id}\0${item.contentHash}`,
  );
  const packet = createRunPacket({
    schemaVersion: 1,
    id: runId,
    kind: 'PROJECT_TEST_PLANNER',
    worksetId: context.worksetId,
    contracts,
    objective: `Propose source-traceable tests for ${input.project}/${input.changeId}/${input.revision}`,
    protocolIds: ['execution.project-test-planner'],
    verificationCommands: input.legacyCommands,
    evidenceRequired: ['project-test-plan-candidate'],
    stopConditions: ['signal ambiguous command definition', 'signal stale source'],
    agent: plannerPacketAgent(context.runContext),
    limits: { timeoutMs: 300_000, maxOutputBytes: 1_048_576 },
    permissionPolicy: {
      filesystemRoots: [snapshotPath],
      terminal: false,
      network: 'DENY',
      denyGitCommit: true,
      denyNestedOmnai: true,
    },
    project: input.project,
    scopedTasks: input.scopedTasks,
    sourceSnapshot: {
      path: snapshotPath,
      head: input.head,
      tree: input.tree,
      contentHash: input.treeInventoryHash,
      sourceRefs: input.sourceRefs,
    },
    acceptanceCriteria: input.acceptanceCriteria,
    manifestRefs: input.manifestRefs,
    contractScenarios: snapshots.flatMap(contractScenariosForPacket)
      .sort((left, right) => contractScenarioKey(left).localeCompare(contractScenarioKey(right))),
    outputPath: runOutputPath(context.home, context.worksetId, runId),
    createdAt: now(context),
  });

  let snapshot: DisposableSnapshot | undefined;
  try {
    if (context.plannerRunner === undefined) {
      if (context.runContext === undefined) throw new Error('PROJECT_TEST_PLANNER_RUN_CONTEXT_REQUIRED');
      await createRun(context.runContext, packet);
    } else {
      await persistRunPacket(runPacketPath(context.home, context.worksetId, packet.id), packet);
    }
    snapshot = await materializeCoordinationSnapshot({
      home: context.home,
      worksetId: context.worksetId,
      runId,
      project: input.project,
      repoRoot: input.worktree,
      head: input.head,
    });
    if (snapshot.path !== packet.sourceSnapshot.path || snapshot.head !== packet.sourceSnapshot.head ||
        snapshot.contentHash !== packet.sourceSnapshot.contentHash) {
      throw new Error('PROJECT_TEST_PLANNER_SNAPSHOT_MISMATCH');
    }
    const candidate = context.plannerRunner === undefined
      ? await executePlannerRun(context.runContext!, packet)
      : await context.plannerRunner({ packet, snapshot });
    return projectTestPlanCandidateSchema.parse(candidate);
  } finally {
    if (snapshot !== undefined) await disposeSnapshot(snapshot);
  }
}

export async function validateAndPersistProjectTestCases(
  context: VerificationPlannerContext,
  candidateInput: ProjectTestPlanCandidate,
): Promise<ProjectTestCaseSet> {
  const candidate = projectTestPlanCandidateSchema.parse(candidateInput);
  const packet = await loadRunPacket(runPacketPath(context.home, context.worksetId, candidate.runId));
  if (packet.kind !== 'PROJECT_TEST_PLANNER' || packet.packetHash !== candidate.packetHash) {
    throw new Error(`PROJECT_TEST_PLAN_PACKET_IDENTITY_MISMATCH:${candidate.runId}`);
  }
  const firstTask = candidate.scopedTasks[0]!;
  const input = await captureProjectPlanningInput(context, firstTask);
  assertCandidateIdentity(candidate, input);
  if (packet.project !== candidate.project || canonicalJson(packet.scopedTasks) !== canonicalJson(candidate.scopedTasks) ||
      packet.sourceSnapshot.head !== candidate.sourceSnapshot.head || packet.sourceSnapshot.tree !== candidate.sourceSnapshot.tree ||
      packet.sourceSnapshot.contentHash !== candidate.sourceSnapshot.contentHash) {
    throw new Error(`PROJECT_TEST_PLAN_PACKET_SCOPE_MISMATCH:${candidate.runId}`);
  }
  const snapshots = await loadApplicableContractSnapshots(context, input.scopedTasks);
  const acceptedScenarioRefs = new Map(snapshots.flatMap((snapshot) =>
    contractScenariosForPacket(snapshot).map((scenario) => [contractScenarioKey(scenario), scenario] as const)));
  const sourceRefs = new Map([
    ...input.sourceRefs,
    ...input.acceptanceCriteria,
    ...input.manifestRefs,
  ].map((ref) => [sourceRefKey(ref), ref]));
  for (const scenario of acceptedScenarioRefs.values()) {
    for (const ref of [...scenario.sourceRefs, ...scenario.contractElementRefs, ...scenario.fixtureRefs]) {
      sourceRefs.set(sourceRefKey(ref), ref);
    }
  }
  await assertCandidateCoverage(context, candidate, input, sourceRefs, acceptedScenarioRefs);
  const testCases = candidate.testCases.map((proposed) => normalizeTestCase({
    schemaVersion: 1,
    id: proposed.id,
    level: proposed.level,
    title: proposed.title,
    required: proposed.required,
    sourceRefs: proposed.sourceRefs,
    scopedTasks: proposed.scopedTasks,
    acceptanceCriteriaRefs: proposed.acceptanceCriteriaRefs,
    contractRefs: proposed.contractRefs,
    scenarioRefs: proposed.scenarioRefs,
    commandRefs: proposed.commandRefs,
    ownerProjects: proposed.ownerProjects,
    testPaths: proposed.testPaths,
    evidenceRequired: proposed.evidenceRequired,
    expectedOutcome: proposed.expectedOutcome,
  })).sort((left, right) => left.id.localeCompare(right.id));
  const commandDefinitions = normalizeAndValidateCommandDefinitions(candidate, input, testCases);
  const withoutHash = projectTestCaseSetWithoutHashSchema.parse({
    schemaVersion: 1,
    project: input.project,
    changeId: input.changeId,
    revision: input.revision,
    baseline: input.baseline,
    sourceSnapshot: {
      head: input.head,
      tree: input.tree,
      contentHash: input.treeInventoryHash,
    },
    sourceRefs: input.sourceRefs,
    acceptanceCriteria: input.acceptanceCriteria,
    manifestRefs: input.manifestRefs,
    scopedTasks: input.scopedTasks,
    testCases,
    commandDefinitions,
    plannerRun: {
      id: candidate.runId,
      kind: 'PROJECT_TEST_PLANNER',
      packetHash: candidate.packetHash,
      createdAt: packet.createdAt,
    },
  });
  const set = projectTestCaseSetSchema.parse({
    ...withoutHash,
    contentHash: hashProjectTestCaseSet(withoutHash),
  });
  const path = projectTestCasesPath(input);
  await writeTextAtomic(projectTestCaseStagingPath(context, input.project), YAML.stringify(set, { lineWidth: 100 }));
  return (await publishProjectTestCaseSet(context, input, path, set)).set;
}

export async function loadProjectTestCases(
  context: VerificationPlannerContext,
  scopedTask: ScopedTaskRef,
): Promise<TestCase[]> {
  return [...(await loadProjectTestCaseSet(context, scopedTask)).testCases];
}

export function deriveContractTestCases(snapshot: ContractSnapshot): TestCase[] {
  if (snapshot.manifest.status !== 'READY') {
    throw new Error(`CONTRACT_NOT_READY:${snapshot.manifest.contractKey}`);
  }
  const missingBaseline = snapshot.manifest.participants.find((participant) => participant.baseline === undefined);
  if (missingBaseline !== undefined) {
    throw new Error(
      `CONTRACT_BASELINE_IDENTITY_MISSING_REQUIRES_RECOORDINATION:${snapshot.manifest.contractKey}:${missingBaseline.project}`,
    );
  }
  const manifestScenarioIds = [...snapshot.manifest.businessScenarios].sort(compare);
  const candidateScenarioIds = snapshot.candidate.businessScenarios.map((scenario) => scenario.id).sort(compare);
  if (canonicalJson(manifestScenarioIds) !== canonicalJson(candidateScenarioIds)) {
    throw new Error(`CONTRACT_SCENARIO_INVENTORY_MISMATCH:${snapshot.manifest.contractKey}`);
  }
  const manifestParticipants = snapshot.manifest.participants.map((participant) => scopedTaskRefSchema.parse({
    project: participant.project,
    changeId: participant.changeId,
    revision: participant.revision,
    baseline: participant.baseline,
    taskId: participant.taskId,
  })).sort((left, right) => scopedTaskKey(left).localeCompare(scopedTaskKey(right)));
  const snapshotRef = { id: snapshot.manifest.id, contentHash: snapshot.manifest.contentHash };
  const cases = [...snapshot.candidate.businessScenarios]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((scenario) => {
      if (scenario.executorRefs.length === 0) throw new Error(`CONTRACT_SCENARIO_EXECUTOR_MISSING:${scenario.id}`);
      const participantProjects = new Set(scenario.participantProjects);
      const participants = manifestParticipants.filter((participant) => participantProjects.has(participant.project));
      if (canonicalJson(sortUnique(participants.map((participant) => participant.project), (project) => project)) !==
          canonicalJson([...scenario.participantProjects].sort(compare))) {
        throw new Error(`CONTRACT_SCENARIO_PARTICIPANT_MISMATCH:${scenario.id}`);
      }
      const scenarioRef = contractScenarioRef(snapshot, scenario.id);
      const sourceHashByRef = new Map(snapshot.candidate.sourceHashes.map((item) => [item.ref, item.contentHash]));
      const sourceRefs = scenario.sourceRefs.map((ref) => ({
        ref,
        contentHash: requireMap(sourceHashByRef, ref, `CONTRACT_SCENARIO_SOURCE_UNBOUND:${scenario.id}`),
      }));
      sourceRefs.push({ ref: contractScenarioLogicalRef(snapshot, scenario.id), contentHash: scenarioRef.contentHash });
      const id = contractTestCaseId(snapshot.manifest.contractKey, scenario.id);
      return normalizeTestCase({
        schemaVersion: 1,
        id,
        level: 'E2E',
        title: scenario.title,
        required: true,
        sourceRefs,
        scopedTasks: participants,
        acceptanceCriteriaRefs: [],
        contractRefs: [snapshotRef],
        scenarioRefs: [scenarioRef],
        commandRefs: scenario.executorRefs,
        ownerProjects: scenario.participantProjects,
        testPaths: scenario.fixtureRefs,
        evidenceRequired: ['contract', 'service-logs', 'test'],
        expectedOutcome: scenario.expectedOutcome,
      });
    });
  return cases.sort((left, right) => left.id.localeCompare(right.id));
}

export function projectTestCaseReference(testCase: TestCase, scopedTask: ScopedTaskRef): TestCaseRef {
  return projectTestCaseRef({
    project: scopedTask.project,
    changeId: scopedTask.changeId,
    revision: scopedTask.revision,
  }, testCase.id, testCase.contentHash);
}

export function contractTestCaseReference(snapshot: ContractSnapshot, testCase: TestCase): TestCaseRef {
  const scenario = testCase.scenarioRefs[0];
  if (scenario === undefined) throw new Error(`CONTRACT_TEST_CASE_SCENARIO_REQUIRED:${testCase.id}`);
  return contractTestCaseRef(
    snapshot.manifest.worksetId,
    snapshot.manifest.contractKey,
    snapshot.manifest.scopeHash,
    { id: snapshot.manifest.id, contentHash: snapshot.manifest.contentHash },
    scenario.scenarioId,
    testCase.id,
    testCase.contentHash,
  );
}

export async function loadProjectTestCaseSet(
  context: VerificationPlannerContext,
  scopedTask: ScopedTaskRef,
): Promise<ProjectTestCaseSet> {
  const input = await captureProjectPlanningInput(context, scopedTask);
  const path = projectTestCasesPath(input);
  if (!(await pathExists(path))) throw new Error(`PROJECT_TEST_CASES_MISSING:${input.project}`);
  const set = await readYaml(path, projectTestCaseSetSchema);
  await validateProjectTestCaseSetAgainstInput(context, set, input);
  return set;
}

async function validateProjectTestCaseSetAgainstInput(
  context: VerificationPlannerContext,
  set: ProjectTestCaseSet,
  input: ProjectPlanningInput,
): Promise<void> {
  if (set.project !== input.project || set.changeId !== input.changeId || set.revision !== input.revision ||
      set.baseline !== input.baseline) {
    throw new Error(`PROJECT_TEST_CASES_STALE:SCOPE:${input.project}`);
  }
  if (canonicalJson(set.sourceRefs) !== canonicalJson(input.sourceRefs) ||
      canonicalJson(set.acceptanceCriteria) !== canonicalJson(input.acceptanceCriteria) ||
      canonicalJson(set.manifestRefs) !== canonicalJson(input.manifestRefs)) {
    throw new Error(`PROJECT_TEST_CASES_STALE:SOURCE:${input.project}`);
  }
  const currentTaskKeys = new Set(input.scopedTasks.map(scopedTaskKey));
  if (set.scopedTasks.some((task) => !currentTaskKeys.has(scopedTaskKey(task)))) {
    throw new Error(`PROJECT_TEST_CASES_STALE:TASK:${input.project}`);
  }
  const snapshots = await loadApplicableContractSnapshots(context, input.scopedTasks);
  const acceptedScenarios = new Map(snapshots.flatMap((snapshot) =>
    contractScenariosForPacket(snapshot).map((scenario) => [contractScenarioKey(scenario), scenario] as const)));
  const acceptedContracts = new Set(snapshots.map((snapshot) =>
    `${snapshot.manifest.id}\0${snapshot.manifest.contentHash}`));
  const currentRefs = new Set([
    ...input.sourceRefs,
    ...input.acceptanceCriteria,
    ...input.manifestRefs,
    ...[...acceptedScenarios.values()].flatMap((scenario) => [
      ...scenario.sourceRefs,
      ...scenario.contractElementRefs,
      ...scenario.fixtureRefs,
    ]),
  ].map(sourceRefKey));
  const taskByKey = new Map(input.scopedTasks.map((task) => [
    scopedTaskKey(task),
    requireMap(new Map(input.tasks.map((item) => [item.id, item])), task.taskId, `TASK_NOT_FOUND:${task.taskId}`),
  ]));
  for (const testCase of set.testCases) {
    if (testCase.sourceRefs.some((ref) => !currentRefs.has(sourceRefKey(ref))) ||
        testCase.acceptanceCriteriaRefs.some((ref) => !currentRefs.has(sourceRefKey(ref)))) {
      throw new Error(`PROJECT_TEST_CASES_STALE:SOURCE:${input.project}:${testCase.id}`);
    }
    if (testCase.contractRefs.some((ref) => !acceptedContracts.has(`${ref.id}\0${ref.contentHash}`)) ||
        testCase.scenarioRefs.some((ref) => !acceptedScenarios.has(contractScenarioKey(ref)))) {
      throw new Error(`PROJECT_TEST_CASES_STALE:CONTRACT:${input.project}:${testCase.id}`);
    }
    try {
      assertAuthoritativeTestCaseFields(testCase, taskByKey, acceptedScenarios);
    } catch (error) {
      throw new Error(`PROJECT_TEST_CASES_STALE:AUTHORITY:${input.project}:${testCase.id}:${errorMessage(error)}`);
    }
  }
  assertStoredCoverage(context, set, input);
  normalizeAndValidateStoredCommands(set, input);
}

function hashProjectTestCaseSet(
  set: z.infer<typeof projectTestCaseSetWithoutHashSchema> | ProjectTestCaseSet,
): ContentHash {
  return hashObject({
    schemaVersion: set.schemaVersion,
    project: set.project,
    changeId: set.changeId,
    revision: set.revision,
    baseline: set.baseline,
    sourceSnapshot: set.sourceSnapshot,
    sourceRefs: set.sourceRefs,
    acceptanceCriteria: set.acceptanceCriteria,
    manifestRefs: set.manifestRefs,
    scopedTasks: set.scopedTasks,
    testCases: set.testCases,
    commandDefinitions: set.commandDefinitions,
    plannerRun: set.plannerRun,
  });
}

async function captureProjectPlanningInput(
  context: VerificationPlannerContext,
  scopedTask: ScopedTaskRef,
): Promise<ProjectPlanningInput> {
  const workset = await resolveWorkset(context.home, context.worksetId);
  const member = workset.members.find((item) => item.project === scopedTask.project);
  if (member?.status !== 'ACTIVE' || member.worktree === undefined || member.changeId === undefined) {
    throw new Error(`PROJECT_NOT_ACTIVE:${scopedTask.project}`);
  }
  if (member.changeId !== scopedTask.changeId) throw new Error(`SCOPED_TASK_CHANGE_STALE:${scopedTask.project}`);
  const change = await resolveChange(member.worktree, member.changeId);
  if (change.metadata.activeRevision !== scopedTask.revision || change.metadata.baseline !== scopedTask.baseline) {
    throw new Error(`SCOPED_TASK_REVISION_STALE:${scopedTask.project}:${scopedTask.taskId}`);
  }
  const tasksPath = changeArtifactPath(member.worktree, change.directoryName, 'tasks.yaml');
  const taskFile = await loadTasks(tasksPath);
  if (taskFile.revision !== change.metadata.activeRevision) throw new Error(`TASK_FILE_REVISION_STALE:${scopedTask.project}`);
  if (!taskFile.tasks.some((task) => task.id === scopedTask.taskId)) {
    throw new Error(`SCOPED_TASK_NOT_FOUND:${scopedTask.project}:${scopedTask.taskId}`);
  }
  const tasks = taskFile.tasks.filter(isPlanningTask).sort((left, right) => left.id.localeCompare(right.id));
  const scopedTasks = tasks.map((task) => scopedTaskRefSchema.parse({
    project: member.project,
    changeId: change.metadata.id,
    revision: change.metadata.activeRevision,
    baseline: change.metadata.baseline,
    taskId: task.id,
  })).sort((left, right) => scopedTaskKey(left).localeCompare(scopedTaskKey(right)));
  const specPath = changeArtifactPath(member.worktree, change.directoryName, 'spec.md');
  const revisionPath = join(changeRevisionsRoot(member.worktree, change.directoryName), `${scopedTask.revision}.yaml`);
  const revision = await readYaml(revisionPath, revisionSchema);
  if (revision.id !== scopedTask.revision || revision.changeId !== scopedTask.changeId ||
      (revision.baseline !== undefined && revision.baseline !== scopedTask.baseline)) {
    throw new Error(`SCOPED_TASK_REVISION_STALE:${scopedTask.project}:${scopedTask.taskId}`);
  }
  const acceptanceCriteria = await extractAcceptanceCriteria(member.worktree, specPath);
  const sourcePaths = [
    changeMetadataPath(member.worktree, change.directoryName),
    revisionPath,
    specPath,
    tasksPath,
    projectConfigPath(member.worktree),
    changeArtifactPath(member.worktree, change.directoryName, 'design.md'),
    changeArtifactPath(member.worktree, change.directoryName, 'intent.md'),
  ];
  const sourceRefs = await contentAddressedFiles(member.worktree, sourcePaths);
  const manifestPaths = [
    'package.json', 'pyproject.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'go.mod', 'Cargo.toml',
  ]
    .map((path) => join(member.worktree!, path));
  const manifestRefs = await contentAddressedFiles(member.worktree, manifestPaths);
  const config = await loadProjectConfig(member.worktree);
  const head = gitText(member.worktree, ['rev-parse', 'HEAD']);
  const headRef = gitText(member.worktree, ['symbolic-ref', '--quiet', 'HEAD']);
  const branch = headRef.replace(/^refs\/heads\//u, '');
  if (member.branch !== undefined && member.branch !== branch) {
    throw new Error(`PROJECT_BRANCH_STALE:${member.project}:expected=${member.branch}:actual=${branch}`);
  }
  const tree = gitText(member.worktree, ['rev-parse', `${head}^{tree}`]);
  const treeInventory = gitBuffer(member.worktree, ['ls-tree', '-r', '--full-tree', head]);
  assertCapturedFilesMatchHead(member.worktree, head, [...sourceRefs, ...manifestRefs]);
  const authorizedCommands = await authorizeLegacyCommands(member.worktree, config.verification.commands);
  return {
    project: member.project,
    worktree: member.worktree,
    branch,
    headRef,
    changeDirectory: change.directoryName,
    changeId: change.metadata.id,
    revision: change.metadata.activeRevision,
    baseline: change.metadata.baseline,
    head,
    tree,
    treeInventoryHash: sha256(treeInventory),
    scopedTasks,
    tasks,
    sourceRefs,
    acceptanceCriteria,
    manifestRefs,
    legacyCommands: [...config.verification.commands],
    authorizedCommands,
  };
}

async function extractAcceptanceCriteria(
  worktree: string,
  specPath: string,
): Promise<Array<z.infer<typeof sourceRefSchema>>> {
  const text = await readFile(specPath, 'utf8');
  const lines = text.split(/\r?\n/u);
  let inSection = false;
  const refs = new Map<string, z.infer<typeof sourceRefSchema>>();
  for (const line of lines) {
    if (/^##\s+Acceptance Criteria\s*$/iu.test(line.trim())) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/u.test(line.trim())) break;
    if (!inSection) continue;
    const ids = [...line.matchAll(/\bAC-\d{3,}\b/gu)].map((match) => match[0]!);
    for (const id of ids) {
      const ref = `${normalizeRepoRef(worktree, specPath)}#${id}`;
      refs.set(ref, { ref, contentHash: sha256(line.trim()) });
    }
  }
  if (refs.size === 0) throw new Error(`ACCEPTANCE_CRITERIA_MISSING:${normalizeRepoRef(worktree, specPath)}`);
  return [...refs.values()].sort((left, right) => left.ref.localeCompare(right.ref));
}

async function contentAddressedFiles(
  worktree: string,
  paths: readonly string[],
): Promise<Array<z.infer<typeof sourceRefSchema>>> {
  const refs: Array<z.infer<typeof sourceRefSchema>> = [];
  for (const path of paths) {
    if (!(await pathExists(path))) continue;
    refs.push({ ref: normalizeRepoRef(worktree, path), contentHash: sha256(await readFile(path)) });
  }
  return refs.sort((left, right) => left.ref.localeCompare(right.ref));
}

async function loadApplicableContractSnapshots(
  context: VerificationPlannerContext,
  scopedTasks: readonly ScopedTaskRef[],
): Promise<ContractSnapshot[]> {
  const resolver = context.contractSnapshotResolver ?? ((task: ScopedTaskRef) =>
    loadReadyContractSnapshotsForTask(context, task.project, task.taskId));
  const snapshots: ContractSnapshot[] = [];
  for (const task of scopedTasks) snapshots.push(...await resolver(task));
  const unique = uniqueBy(snapshots, (snapshot) =>
    `${snapshot.manifest.contractKey}\0${snapshot.manifest.id}\0${snapshot.manifest.contentHash}`)
    .sort((left, right) => left.manifest.contractKey.localeCompare(right.manifest.contractKey));
  const byKey = new Map<string, number>();
  for (const snapshot of unique) {
    byKey.set(snapshot.manifest.contractKey, (byKey.get(snapshot.manifest.contractKey) ?? 0) + 1);
  }
  const ambiguous = [...byKey].find(([, count]) => count > 1)?.[0];
  if (ambiguous !== undefined) throw new Error(`CONTRACT_READY_SELECTION_REQUIRED:${ambiguous}`);
  return unique;
}

function contractScenariosForPacket(snapshot: ContractSnapshot): ProjectTestPlannerContractScenario[] {
  if (snapshot.manifest.status !== 'READY') throw new Error(`CONTRACT_NOT_READY:${snapshot.manifest.contractKey}`);
  const sourceHashes = new Map(snapshot.candidate.sourceHashes.map((item) => [item.ref, item.contentHash]));
  const elements = new Map(snapshot.candidate.contract.elements.map((item) => [item.id, item]));
  const fixtures = new Map(snapshot.candidate.fixtures.map((item) => [item.ref, item.contentHash]));
  return snapshot.candidate.businessScenarios.map((scenario) => {
    const scenarioRef = contractScenarioRef(snapshot, scenario.id);
    return {
      ...scenarioRef,
      title: scenario.title,
      participantProjects: [...scenario.participantProjects].sort(),
      sourceRefs: scenario.sourceRefs.map((ref) => ({
        ref,
        contentHash: requireMap(sourceHashes, ref, `CONTRACT_SCENARIO_SOURCE_UNBOUND:${scenario.id}`),
      })).sort((left, right) => left.ref.localeCompare(right.ref)),
      contractElementRefs: scenario.contractElementRefs.map((ref) => ({
        ref,
        contentHash: hashObject(requireMap(elements, ref, `CONTRACT_SCENARIO_ELEMENT_UNBOUND:${scenario.id}`)),
      })).sort((left, right) => left.ref.localeCompare(right.ref)),
      fixtureRefs: scenario.fixtureRefs.map((ref) => ({
        ref,
        contentHash: requireMap(fixtures, ref, `CONTRACT_SCENARIO_FIXTURE_UNBOUND:${scenario.id}`),
      })).sort((left, right) => left.ref.localeCompare(right.ref)),
      executorRefs: [...scenario.executorRefs].sort(),
      expectedOutcome: scenario.expectedOutcome,
    };
  }).sort((left, right) => contractScenarioKey(left).localeCompare(contractScenarioKey(right)));
}

function contractScenarioRef(snapshot: ContractSnapshot, scenarioId: string): ContractScenarioRef {
  const scenario = snapshot.candidate.businessScenarios.find((item) => item.id === scenarioId);
  if (scenario === undefined) throw new Error(`CONTRACT_SCENARIO_NOT_FOUND:${scenarioId}`);
  return contractScenarioRefSchema.parse({
    contractKey: snapshot.manifest.contractKey,
    scopeHash: snapshot.manifest.scopeHash,
    snapshot: { id: snapshot.manifest.id, contentHash: snapshot.manifest.contentHash },
    scenarioId: scenario.id,
    scenarioClass: scenario.class,
    contentHash: hashObject({
      snapshot: { id: snapshot.manifest.id, contentHash: snapshot.manifest.contentHash },
      scenario,
    }),
  });
}

function assertCandidateIdentity(candidate: ProjectTestPlanCandidate, input: ProjectPlanningInput): void {
  if (candidate.project !== input.project || canonicalJson(candidate.scopedTasks) !== canonicalJson(input.scopedTasks)) {
    throw new Error('PROJECT_TEST_PLAN_SCOPE_MISMATCH');
  }
  if (candidate.sourceSnapshot.head !== input.head || candidate.sourceSnapshot.tree !== input.tree ||
      candidate.sourceSnapshot.contentHash !== input.treeInventoryHash) {
    throw new Error('PROJECT_TEST_PLAN_SOURCE_SNAPSHOT_STALE');
  }
}

async function assertCandidateCoverage(
  context: VerificationPlannerContext,
  candidate: ProjectTestPlanCandidate,
  input: ProjectPlanningInput,
  sourceRefs: ReadonlyMap<string, z.infer<typeof sourceRefSchema>>,
  acceptedScenarios: ReadonlyMap<string, ProjectTestPlannerContractScenario>,
): Promise<void> {
  const taskKeys = new Set(input.scopedTasks.map(scopedTaskKey));
  const acceptanceKeys = new Set(input.acceptanceCriteria.map((ref) =>
    acceptanceCriterionKey(input.project, ref)));
  const taskByKey = new Map(input.scopedTasks.map((task) => [
    scopedTaskKey(task),
    requireMap(new Map(input.tasks.map((item) => [item.id, item])), task.taskId, `TASK_NOT_FOUND:${task.taskId}`),
  ]));
  const coveredTasks = new Set<string>();
  const coveredAcceptance = new Set<string>();
  for (const testCase of candidate.testCases) {
    if (canonicalJson(testCase.ownerProjects) !== canonicalJson([input.project])) {
      throw new Error(`TEST_CASE_OWNER_PROJECT_UNRESOLVED:${testCase.id}`);
    }
    if (testCase.sourceRefs.some((ref) => !sourceRefs.has(sourceRefKey(ref))) ||
        testCase.acceptanceCriteriaRefs.some((ref) =>
          !acceptanceKeys.has(acceptanceCriterionKey(input.project, ref)))) {
      throw new Error(`PROJECT_TEST_PLAN_SOURCE_UNRESOLVED:${testCase.id}`);
    }
    for (const task of testCase.scopedTasks) {
      const key = scopedTaskKey(task);
      if (!taskKeys.has(key)) throw new Error(`PROJECT_TEST_PLAN_TASK_UNRESOLVED:${testCase.id}`);
      if (testCase.required) coveredTasks.add(key);
    }
    for (const ref of testCase.acceptanceCriteriaRefs) {
      if (testCase.required) coveredAcceptance.add(acceptanceCriterionKey(input.project, ref));
    }
    for (const scenario of testCase.scenarioRefs) {
      if (!acceptedScenarios.has(contractScenarioKey(scenario))) {
        throw new Error(`PROJECT_TEST_PLAN_SCENARIO_UNRESOLVED:${testCase.id}:${scenario.scenarioId}`);
      }
    }
    assertAuthoritativeTestCaseFields(testCase, taskByKey, acceptedScenarios);
    if (testCase.testPaths.length === 0) throw new Error(`TEST_PATH_UNRESOLVED:${testCase.id}:missing`);
    const declaredTestPaths = new Set(input.tasks.flatMap((task) => task.files.tests));
    for (const path of testCase.testPaths) {
      assertNormalizedProjectPath(path, 'TEST_PATH_INVALID');
      if (!declaredTestPaths.has(path) && !(await pathExists(join(input.worktree, path)))) {
        throw new Error(`TEST_PATH_UNRESOLVED:${testCase.id}:${path}`);
      }
    }
  }
  const notApplicableTasks = new Set([...taskKeys].filter((key) =>
    hasContextNotApplicable(
      context,
      'TASK',
      key,
      hashObject(requireMap(taskByKey, key, `TASK_NOT_FOUND:${key}`)),
      { taskRisks: [requireMap(taskByKey, key, `TASK_NOT_FOUND:${key}`).risk] },
    )));
  const missingTasks = [...taskKeys].filter((key) =>
    !coveredTasks.has(key) && !notApplicableTasks.has(key));
  const missingEvidence = missingTaskEvidenceCoverage(candidate.testCases, taskByKey, notApplicableTasks);
  const missingAcceptance = input.acceptanceCriteria.filter((ref) =>
    !coveredAcceptance.has(acceptanceCriterionKey(input.project, ref)) &&
    !hasContextNotApplicable(
      context,
      'ACCEPTANCE_CRITERION',
      acceptanceCriterionSubjectRef(input.project, ref.ref),
      ref.contentHash,
      {
      taskRisks: input.tasks.map((task) => task.risk),
      },
    ))
    .map((ref) => acceptanceCriterionKey(input.project, ref));
  if (missingTasks.length > 0 || missingAcceptance.length > 0) {
    throw new Error(`REQUIRED_COVERAGE_MISSING:${[...missingTasks, ...missingAcceptance].join(',')}`);
  }
  if (missingEvidence.length > 0) {
    throw new Error(`TASK_EVIDENCE_COVERAGE_MISSING:${missingEvidence.join(',')}`);
  }
}

function assertAuthoritativeTestCaseFields(
  testCase: {
    readonly id: string;
    readonly scopedTasks: readonly ScopedTaskRef[];
    readonly scenarioRefs: readonly ContractScenarioRef[];
    readonly evidenceRequired: readonly string[];
    readonly expectedOutcome: string;
  },
  taskByKey: ReadonlyMap<string, Task>,
  acceptedScenarios: ReadonlyMap<string, ProjectTestPlannerContractScenario>,
): void {
  const tasks = testCase.scopedTasks.map((task) =>
    requireMap(taskByKey, scopedTaskKey(task), `PROJECT_TEST_PLAN_TASK_UNRESOLVED:${testCase.id}`));
  const allowedEvidence = new Set([
    ...coreTestCaseEvidenceRequirements,
    ...tasks.flatMap((task) => task.evidenceRequired),
  ]);
  const unresolvedEvidence = testCase.evidenceRequired.filter((item) => !allowedEvidence.has(item));
  if (unresolvedEvidence.length > 0) {
    throw new Error(`TEST_CASE_EVIDENCE_UNRESOLVED:${testCase.id}:${unresolvedEvidence.join(',')}`);
  }
  const outcomes = testCase.scenarioRefs.length > 0
    ? testCase.scenarioRefs.map((scenario) =>
        requireMap(
          acceptedScenarios,
          contractScenarioKey(scenario),
          `PROJECT_TEST_PLAN_SCENARIO_UNRESOLVED:${testCase.id}:${scenario.scenarioId}`,
        ).expectedOutcome)
    : tasks.map((task) => task.objective);
  const authoritativeOutcomes = sortUnique(outcomes, (item) => item);
  if (authoritativeOutcomes.length !== 1 || testCase.expectedOutcome !== authoritativeOutcomes[0]) {
    throw new Error(`TEST_CASE_EXPECTED_OUTCOME_MISMATCH:${testCase.id}`);
  }
}

function missingTaskEvidenceCoverage(
  testCases: ReadonlyArray<{
    readonly required: boolean;
    readonly scopedTasks: readonly ScopedTaskRef[];
    readonly evidenceRequired: readonly string[];
  }>,
  taskByKey: ReadonlyMap<string, Task>,
  ignoredTaskKeys: ReadonlySet<string> = new Set(),
): string[] {
  const provided = new Map<string, Set<string>>();
  for (const testCase of testCases) {
    if (!testCase.required) continue;
    for (const task of testCase.scopedTasks) {
      const evidence = provided.get(scopedTaskKey(task)) ?? new Set<string>();
      for (const requirement of testCase.evidenceRequired) evidence.add(requirement);
      provided.set(scopedTaskKey(task), evidence);
    }
  }
  const missing: string[] = [];
  for (const [key, task] of taskByKey) {
    if (ignoredTaskKeys.has(key)) continue;
    const absent = task.evidenceRequired.filter((requirement) => !provided.get(key)?.has(requirement));
    if (absent.length > 0) missing.push(`${key}=>${[...absent].sort(compare).join('+')}`);
  }
  return missing.sort(compare);
}

function normalizeAndValidateCommandDefinitions(
  candidate: ProjectTestPlanCandidate,
  input: ProjectPlanningInput,
  testCases: readonly TestCase[],
): ProjectTestCommandDefinition[] {
  const safeLegacy = input.authorizedCommands;
  const caseById = new Map(testCases.map((testCase) => [testCase.id, testCase]));
  const definitions = candidate.commandDefinitions.map((definition) => {
    assertStructuredCommandSafe(input.worktree, definition.executable, definition.argv, definition.cwd);
    if (definition.network !== 'DENY') throw new Error(`COMMAND_NETWORK_POLICY_UNAUTHORIZED:${definition.commandRef}`);
    if (definition.timeoutMs > 1_800_000 || definition.outputLimit > 16_777_216) {
      throw new Error(`COMMAND_LIMIT_EXCEEDS_POLICY:${definition.commandRef}`);
    }
    const authority = safeLegacy.find((legacy) => commandMatchesAuthorized(legacy, definition));
    if (authority === undefined || definition.cwd !== '.') {
      throw new Error(`COMMAND_DEFINITION_UNRESOLVED:${definition.commandRef}`);
    }
    return projectTestCommandDefinitionSchema.parse({
      ...definition,
      executable: authority.resolved.executable,
      argv: authority.resolved.argv,
      caseRefs: [...definition.caseRefs].sort(),
    });
  }).sort((left, right) => left.commandRef.localeCompare(right.commandRef));
  const byRef = new Map(definitions.map((definition) => [definition.commandRef, definition]));
  for (const testCase of testCases) {
    for (const commandRef of testCase.commandRefs) {
      const definition = byRef.get(commandRef);
      if (definition === undefined || !definition.caseRefs.includes(testCase.id)) {
        throw new Error(`COMMAND_CASE_MAPPING_MISSING:${commandRef}:${testCase.id}`);
      }
    }
  }
  if (definitions.some((definition) => definition.caseRefs.some((id) => !caseById.has(id)))) {
    throw new Error('COMMAND_CASE_UNDEFINED');
  }
  return definitions;
}

function normalizeAndValidateStoredCommands(set: ProjectTestCaseSet, input: ProjectPlanningInput): void {
  const safeLegacy = input.authorizedCommands;
  for (const definition of set.commandDefinitions) {
    assertStructuredCommandSafe(input.worktree, definition.executable, definition.argv, definition.cwd);
    if (definition.network !== 'DENY' || definition.timeoutMs > 1_800_000 || definition.outputLimit > 16_777_216 ||
        !safeLegacy.some((legacy) =>
          legacy.resolved.executable === definition.executable &&
          canonicalJson(legacy.resolved.argv) === canonicalJson(definition.argv)) || definition.cwd !== '.') {
      throw new Error(`PROJECT_TEST_CASES_STALE:COMMAND:${definition.commandRef}`);
    }
  }
}

function assertStoredCoverage(
  context: VerificationPlannerContext,
  set: ProjectTestCaseSet,
  input: ProjectPlanningInput,
): void {
  const coveredTasks = new Set(set.testCases.filter((item) => item.required)
    .flatMap((item) => item.scopedTasks.map(scopedTaskKey)));
  const coveredAcceptance = new Set(set.testCases.filter((item) => item.required)
    .flatMap((item) => item.acceptanceCriteriaRefs.map((ref) => acceptanceCriterionKey(input.project, ref))));
  const taskById = new Map(input.tasks.map((task) => [task.id, task]));
  const taskByKey = new Map(input.scopedTasks.map((task) => [
    scopedTaskKey(task),
    requireMap(taskById, task.taskId, `TASK_NOT_FOUND:${task.taskId}`),
  ]));
  const notApplicableTasks = new Set(input.scopedTasks.filter((task) =>
    hasContextNotApplicable(
      context,
      'TASK',
      scopedTaskKey(task),
      hashObject(requireMap(taskById, task.taskId, `TASK_NOT_FOUND:${task.taskId}`)),
      { taskRisks: [requireMap(taskById, task.taskId, `TASK_NOT_FOUND:${task.taskId}`).risk] },
    )).map(scopedTaskKey));
  const missing = [
    ...input.scopedTasks.filter((task) => !coveredTasks.has(scopedTaskKey(task)) &&
      !notApplicableTasks.has(scopedTaskKey(task))).map(scopedTaskKey),
    ...input.acceptanceCriteria.filter((ref) =>
      !coveredAcceptance.has(acceptanceCriterionKey(input.project, ref)) &&
      !hasContextNotApplicable(
        context,
        'ACCEPTANCE_CRITERION',
        acceptanceCriterionSubjectRef(input.project, ref.ref),
        ref.contentHash,
        {
        taskRisks: input.tasks.map((task) => task.risk),
        },
      )).map((ref) => acceptanceCriterionKey(input.project, ref)),
  ];
  if (missing.length > 0) throw new Error(`PROJECT_TEST_CASES_STALE:COVERAGE:${missing.join(',')}`);
  const missingEvidence = missingTaskEvidenceCoverage(set.testCases, taskByKey, notApplicableTasks);
  if (missingEvidence.length > 0) {
    throw new Error(`PROJECT_TEST_CASES_STALE:EVIDENCE:${missingEvidence.join(',')}`);
  }
}

function normalizeTestCase(input: Omit<TestCase, 'contentHash'>): TestCase {
  const normalized = {
    ...input,
    sourceRefs: sortUnique(input.sourceRefs, sourceRefKey),
    scopedTasks: sortUnique(input.scopedTasks, scopedTaskKey),
    acceptanceCriteriaRefs: sortUnique(input.acceptanceCriteriaRefs, sourceRefKey),
    contractRefs: sortUnique(input.contractRefs, (item) => `${item.id}\0${item.contentHash}`),
    scenarioRefs: sortUnique(input.scenarioRefs, contractScenarioKey),
    commandRefs: sortUnique(input.commandRefs, (item) => item),
    ownerProjects: sortUnique(input.ownerProjects, (item) => item),
    testPaths: sortUnique(input.testPaths, (item) => item),
    evidenceRequired: sortUnique(input.evidenceRequired, (item) => item),
  };
  return testCaseSchema.parse({ ...normalized, contentHash: hashTestCase(normalized) });
}

function hasContextNotApplicable(
  context: VerificationPlannerContext,
  kind: NotApplicableDecision['subjectKind'],
  ref: string,
  hash: ContentHash,
  subject: {
    readonly taskRisks?: readonly Task['risk'][];
    readonly scenarioClass?: ContractScenarioRef['scenarioClass'];
  },
): boolean {
  const policy = context.policy;
  if (policy === undefined) return false;
  return policyAllowsNotApplicable(policy, kind, subject) &&
    (context.notApplicableDecisions ?? []).some((decision) =>
    decision.subjectKind === kind && decision.subjectRef === ref && decision.subjectHash === hash &&
    decision.policyId === policy.id && decision.policyHash === policy.contentHash);
}

function policyAllowsNotApplicable(
  policy: VerificationPolicyRef,
  kind: NotApplicableDecision['subjectKind'],
  subject: {
    readonly taskRisks?: readonly Task['risk'][];
    readonly scenarioClass?: ContractScenarioRef['scenarioClass'];
  },
): boolean {
  const rule = policy.notApplicableRules.find((candidate) => candidate.subjectKind === kind);
  if (rule === undefined) return false;
  if (kind === 'CONTRACT_SCENARIO') {
    return subject.scenarioClass !== undefined && rule.allowedScenarioClasses.includes(subject.scenarioClass);
  }
  return subject.taskRisks !== undefined && subject.taskRisks.length > 0 &&
    subject.taskRisks.every((risk) => rule.allowedTaskRisks.includes(risk));
}

async function publishProjectTestCaseSet(
  context: VerificationPlannerContext,
  input: ProjectPlanningInput,
  absolutePath: string,
  set: ProjectTestCaseSet,
): Promise<{ readonly set: ProjectTestCaseSet; readonly commit: string }> {
  const gitLockPath = gitText(input.worktree, ['rev-parse', '--git-path', 'omnai-test-case-preparation.lock']);
  return withMutationLockAtPath(resolve(input.worktree, gitLockPath), async () => {
    const current = await captureProjectPlanningInput(context, input.scopedTasks[0]!);
    assertPlanningInputUnchanged(input, current);
    await validateProjectTestCaseSetAgainstInput(context, set, current);
    if (set.sourceSnapshot.head !== input.head) {
      throw new Error('PROJECT_TEST_CASE_PREPARATION_INPUT_STALE');
    }
    assertOnlyTargetMayBeDirty(input.worktree, absolutePath);
    const serialized = YAML.stringify(set, { lineWidth: 100 });
    const commit = await createMetadataPreparationCommit(context, input, absolutePath, set, serialized);
    const stored = await readYaml(absolutePath, projectTestCaseSetSchema);
    if (canonicalJson(stored) !== canonicalJson(set) || gitText(input.worktree, ['rev-parse', 'HEAD']) !== commit) {
      throw new Error('PROJECT_TEST_CASE_PREPARATION_READBACK_MISMATCH');
    }
    await rm(projectTestCaseStagingPath(context, input.project), { force: true });
    return { set: stored, commit };
  }, { timeoutMs: 5_000 });
}

async function recoverPublishedPreparation(
  context: VerificationPlannerContext,
  input: ProjectPlanningInput,
  absolutePath: string,
): Promise<ProjectTestCasePreparation | undefined> {
  const relativePath = normalizeRepoRef(input.worktree, absolutePath);
  const commit = gitText(input.worktree, ['log', '-1', '--format=%H', '--', relativePath]);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit)) return undefined;
  let set: ProjectTestCaseSet;
  try {
    set = projectTestCaseSetSchema.parse(YAML.parse(gitText(input.worktree, ['show', `${commit}:${relativePath}`])));
    if (trustedPreparationCommit(input.worktree, absolutePath, set) !== commit) return undefined;
    await validateProjectTestCaseSetAgainstInput(context, set, input);
  } catch (error) {
    if (isReplannableCaseError(error)) return undefined;
    throw error;
  }
  const gitLockPath = gitText(input.worktree, ['rev-parse', '--git-path', 'omnai-test-case-preparation.lock']);
  return withMutationLockAtPath(resolve(input.worktree, gitLockPath), async () => {
    assertOnlyTargetMayBeDirty(input.worktree, absolutePath);
    const currentHead = gitText(input.worktree, ['rev-parse', 'HEAD']);
    if (!gitSucceeds(input.worktree, ['merge-base', '--is-ancestor', commit, currentHead])) {
      throw new Error(`PROJECT_TEST_CASE_PREPARATION_COMMIT_UNTRUSTED:${input.project}`);
    }
    await writeTextAtomic(absolutePath, gitBuffer(input.worktree, ['show', `${commit}:${relativePath}`]).toString('utf8'));
    synchronizeTargetIndexToCommit(input.worktree, absolutePath, commit);
    await rm(projectTestCaseStagingPath(context, input.project), { force: true });
    return preparationFromSet(set, commit);
  }, { timeoutMs: 5_000 });
}

async function loadStagedProjectTestCaseSet(
  context: VerificationPlannerContext,
  input: ProjectPlanningInput,
): Promise<ProjectTestCaseSet | undefined> {
  const path = projectTestCaseStagingPath(context, input.project);
  if (!(await pathExists(path))) return undefined;
  try {
    const set = await readYaml(path, projectTestCaseSetSchema);
    if (set.sourceSnapshot.head !== input.head) {
      await rm(path, { force: true });
      return undefined;
    }
    await validateProjectTestCaseSetAgainstInput(context, set, input);
    return set;
  } catch (error) {
    await rm(path, { force: true });
    if (isReplannableCaseError(error)) return undefined;
    throw new Error(`PROJECT_TEST_CASE_PREPARATION_STAGE_INVALID:${input.project}:${error instanceof Error ? error.message : String(error)}`);
  }
}

async function createMetadataPreparationCommit(
  context: VerificationPlannerContext,
  input: ProjectPlanningInput,
  absolutePath: string,
  set: ProjectTestCaseSet,
  serialized: string,
): Promise<string> {
  const relativePath = normalizeRepoRef(input.worktree, absolutePath);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'omnai-test-index-'));
  const temporaryIndex = join(temporaryRoot, 'index');
  const environment = {
    ...process.env,
    GIT_INDEX_FILE: temporaryIndex,
    GIT_AUTHOR_NAME: 'OmnAI Core',
    GIT_AUTHOR_EMAIL: 'core@omnai.invalid',
    GIT_COMMITTER_NAME: 'OmnAI Core',
    GIT_COMMITTER_EMAIL: 'core@omnai.invalid',
    GIT_AUTHOR_DATE: set.plannerRun.createdAt,
    GIT_COMMITTER_DATE: set.plannerRun.createdAt,
  };
  try {
    gitText(input.worktree, ['read-tree', input.head], environment);
    const blob = gitTextWithInput(input.worktree, ['hash-object', '-w', '--stdin'], serialized);
    gitText(input.worktree, ['update-index', '--add', '--cacheinfo', '100644', blob, relativePath], environment);
    const changed = gitText(input.worktree, ['diff', '--cached', '--name-only'], environment)
      .split('\n').filter(Boolean);
    if (canonicalJson(changed) !== canonicalJson([relativePath])) {
      throw new Error(`PROJECT_TEST_CASE_PREPARATION_DELTA_INVALID:${changed.join(',')}`);
    }
    const tree = gitText(input.worktree, ['write-tree'], environment);
    const message = [
      'chore(omnai): prepare project test cases',
      '',
      `OmnAI-Test-Plan-Run: ${set.plannerRun.id}`,
      `OmnAI-Test-Plan-Hash: ${set.contentHash}`,
    ].join('\n');
    const commit = gitText(input.worktree, ['commit-tree', tree, '-p', input.head, '-m', message], environment);
    await context.metadataCommitFaults?.beforeRefUpdate?.();
    if (gitText(input.worktree, ['symbolic-ref', '--quiet', 'HEAD']) !== input.headRef) {
      throw new Error(`PROJECT_TEST_CASE_PREPARATION_BRANCH_CHANGED:${input.branch}`);
    }
    gitText(input.worktree, ['update-ref', input.headRef, commit, input.head]);
    if (gitText(input.worktree, ['symbolic-ref', '--quiet', 'HEAD']) !== input.headRef ||
        gitText(input.worktree, ['rev-parse', input.headRef]) !== commit) {
      throw new Error(`PROJECT_TEST_CASE_PREPARATION_BRANCH_CHANGED:${input.branch}`);
    }
    await context.metadataCommitFaults?.afterRefUpdate?.();
    if (gitText(input.worktree, ['symbolic-ref', '--quiet', 'HEAD']) !== input.headRef ||
        gitText(input.worktree, ['rev-parse', input.headRef]) !== commit ||
        gitText(input.worktree, ['rev-parse', 'HEAD']) !== commit) {
      throw new Error(`PROJECT_TEST_CASE_PREPARATION_BRANCH_CHANGED:${input.branch}`);
    }
    await writeTextAtomic(absolutePath, serialized);
    synchronizeTargetIndexToCommit(input.worktree, absolutePath, commit);
    return commit;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function trustedPreparationCommit(
  worktree: string,
  absolutePath: string,
  set: ProjectTestCaseSet,
): string | undefined {
  const relativePath = normalizeRepoRef(worktree, absolutePath);
  const commit = gitText(worktree, ['log', '-1', '--format=%H', '--', relativePath]);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit)) return undefined;
  if (!gitSucceeds(worktree, ['merge-base', '--is-ancestor', commit, 'HEAD'])) return undefined;
  if (gitText(worktree, ['rev-parse', `${commit}^`]) !== set.sourceSnapshot.head) return undefined;
  const changed = gitText(worktree, ['diff-tree', '--no-commit-id', '--name-only', '-r', commit])
    .split('\n').filter(Boolean);
  if (canonicalJson(changed) !== canonicalJson([relativePath])) return undefined;
  const message = gitText(worktree, ['show', '-s', '--format=%B', commit]);
  const trailers = gitTextWithInput(worktree, ['interpret-trailers', '--parse'], message)
    .split(/\r?\n/u).filter((line) =>
      line.startsWith('OmnAI-Test-Plan-Run:') || line.startsWith('OmnAI-Test-Plan-Hash:'));
  if (canonicalJson(trailers) !== canonicalJson([
    `OmnAI-Test-Plan-Run: ${set.plannerRun.id}`,
    `OmnAI-Test-Plan-Hash: ${set.contentHash}`,
  ])) return undefined;
  try {
    const committed = projectTestCaseSetSchema.parse(YAML.parse(
      gitText(worktree, ['show', `${commit}:${relativePath}`]),
    ));
    if (canonicalJson(committed) !== canonicalJson(set)) return undefined;
  } catch {
    return undefined;
  }
  return commit;
}

function synchronizeTargetIndexToCommit(worktree: string, absolutePath: string, commit: string): void {
  const relativePath = normalizeRepoRef(worktree, absolutePath);
  const treeEntry = gitText(worktree, ['ls-tree', commit, '--', relativePath]);
  const match = /^(\d{6})\s+blob\s+([0-9a-f]+)\t/u.exec(treeEntry);
  if (match === null) throw new Error(`PROJECT_TEST_CASE_PREPARATION_TREE_ENTRY_MISSING:${relativePath}`);
  gitText(worktree, ['update-index', '--add', '--cacheinfo', match[1]!, match[2]!, relativePath]);
  if (gitText(worktree, ['diff', '--name-only', '--', relativePath]) !== '' ||
      gitText(worktree, ['diff', '--cached', '--name-only', '--', relativePath]) !== '') {
    throw new Error('PROJECT_TEST_CASE_PREPARATION_WORKTREE_MISMATCH');
  }
}

function gitSucceeds(worktree: string, args: readonly string[]): boolean {
  try {
    execFileSync('git', [...args], { cwd: worktree, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function assertPlanningInputUnchanged(before: ProjectPlanningInput, after: ProjectPlanningInput): void {
  const identity = (input: ProjectPlanningInput) => ({
    project: input.project,
    changeId: input.changeId,
    revision: input.revision,
    baseline: input.baseline,
    branch: input.branch,
    headRef: input.headRef,
    head: input.head,
    tree: input.tree,
    treeInventoryHash: input.treeInventoryHash,
    scopedTasks: input.scopedTasks,
    sourceRefs: input.sourceRefs,
    acceptanceCriteria: input.acceptanceCriteria,
    manifestRefs: input.manifestRefs,
    legacyCommands: input.legacyCommands,
    authorizedCommands: input.authorizedCommands,
  });
  if (canonicalJson(identity(before)) !== canonicalJson(identity(after))) {
    throw new Error('PROJECT_TEST_CASE_PREPARATION_INPUT_STALE');
  }
}

function assertOnlyTargetMayBeDirty(worktree: string, targetPath: string): void {
  const target = normalizeRepoRef(worktree, targetPath);
  const status = gitText(worktree, ['status', '--porcelain', '--untracked-files=all']);
  const unrelated = status.split('\n').filter(Boolean).filter((line) => {
    const path = line.slice(3).split(' -> ').at(-1) ?? '';
    return path !== target;
  });
  if (unrelated.length > 0) throw new Error(`PROJECT_TEST_CASE_PREPARATION_DIRTY:${unrelated.join('|')}`);
}

function assertSafeLegacyCommands(worktree: string, commands: readonly string[]): void {
  for (const command of commands) normalizeLegacyCommand(worktree, command);
}

function normalizeLegacyCommand(worktree: string, command: string): { executable: string; argv: string[] } {
  const trimmed = command.trim();
  if (trimmed.length === 0 || /[;&|<>`$\n\r\\"']/u.test(trimmed)) {
    throw new Error(`COMMAND_DEFINITION_AMBIGUOUS:${command}`);
  }
  const tokens = trimmed.split(/\s+/u);
  const executable = tokens.shift()!;
  assertStructuredCommandSafe(worktree, executable, tokens, '.');
  return { executable, argv: tokens };
}

function assertStructuredCommandSafe(
  worktree: string,
  executable: string,
  argv: readonly string[],
  cwd: string,
): void {
  if (/^(?:ba|z|k|c)?sh(?:\.exe)?$|^(?:cmd|powershell|pwsh)(?:\.exe)?$/iu.test(executable) ||
      executable.includes('\0') || argv.some((item) => item.includes('\0'))) {
    throw new Error(`COMMAND_DEFINITION_AMBIGUOUS:${executable}`);
  }
  assertSafeExecutable(executable);
  if (argv.some(commandArgumentHasTraversal)) {
    throw new Error(`COMMAND_ARGUMENT_INVALID:${executable}`);
  }
  assertNormalizedProjectPath(cwd, 'COMMAND_CWD_INVALID');
  assertExistingCommandArgumentsOwned(worktree, cwd, argv);
}

function assertSafeExecutable(executable: string): void {
  if (isAbsolute(executable) || executable.includes('\0')) {
    throw new Error(`COMMAND_EXECUTABLE_INVALID:${executable}`);
  }
  const parts = executable.split(/[\\/]/u);
  if (parts.length !== 1 || parts.includes('..') || parts.some((part, index) => part.length === 0 && index > 0) ||
      /\.(?:ba|z|k|c)?sh$|\.(?:cmd|bat|ps1)$/iu.test(executable)) {
    throw new Error(`COMMAND_EXECUTABLE_INVALID:${executable}`);
  }
}

function commandArgumentHasTraversal(argument: string): boolean {
  return commandArgumentPathValues(argument).some((value) =>
    isAbsolute(value) || /^[a-z]:[\\/]/iu.test(value) || value.split(/[\\/]/u).includes('..'));
}

function commandArgumentPathValues(argument: string): string[] {
  return argument.split('=').flatMap((part) => {
    const responseFile = part.startsWith('@') ? part.slice(1) : part;
    if (responseFile.length === 0) return [];
    if (responseFile.startsWith('--')) {
      const attached = responseFile.slice(2);
      return commandAttachedPathLike(attached) ? [attached] : [];
    }
    if (/^-[^-]/u.test(responseFile)) {
      const attached = responseFile.slice(2);
      return commandAttachedPathLike(attached) ? [attached] : [];
    }
    if (responseFile.startsWith('-')) return [];
    return [responseFile];
  });
}

function commandAttachedPathLike(value: string): boolean {
  return value.length > 0 && (
    isAbsolute(value) || /^[a-z]:[\\/]/iu.test(value) || /[\\/]/u.test(value) ||
    value.split(/[\\/]/u).includes('..')
  );
}

function assertExistingCommandArgumentsOwned(
  worktree: string,
  cwd: string,
  argv: readonly string[],
): void {
  const root = realpathSync(worktree);
  const commandRoot = realpathSync(resolve(root, cwd));
  const commandRootChild = relative(root, commandRoot);
  if (commandRootChild === '..' || commandRootChild.startsWith(`..${sep}`) || isAbsolute(commandRootChild)) {
    throw new Error(`COMMAND_CWD_OUTSIDE_PROJECT:${cwd}`);
  }
  for (const argument of argv) {
    for (const value of commandArgumentPathValues(argument)) {
      const candidate = resolve(commandRoot, value);
      const ancestor = nearestExistingCommandPath(candidate);
      let owned: string;
      try {
        owned = realpathSync(ancestor);
      } catch {
        throw new Error(`COMMAND_ARGUMENT_PATH_UNRESOLVED:${argument}`);
      }
      const child = relative(root, owned);
      if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
        throw new Error(`COMMAND_ARGUMENT_OUTSIDE_PROJECT:${argument}`);
      }
    }
  }
}

function nearestExistingCommandPath(candidate: string): string {
  let current = candidate;
  while (!pathEntryExists(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw error;
  }
}

async function authorizeLegacyCommands(
  worktree: string,
  commands: readonly string[],
): Promise<AuthorizedCommand[]> {
  const authorized: AuthorizedCommand[] = [];
  for (const command of commands) {
    const hint = normalizeLegacyCommand(worktree, command);
    const resolved = await commandAuthorizedByManifest(worktree, hint);
    if (resolved === undefined) {
      throw new Error(`COMMAND_DEFINITION_UNRESOLVED:${command}`);
    }
    authorized.push({ hint, resolved });
  }
  return sortUnique(authorized, (item) => JSON.stringify([
    item.hint.executable, item.hint.argv, item.resolved.executable, item.resolved.argv,
  ]));
}

async function commandAuthorizedByManifest(
  worktree: string,
  command: { executable: string; argv: readonly string[] },
): Promise<{ executable: string; argv: readonly string[] } | undefined> {
  const executable = command.executable.replace(/^\.\//u, '');
  const packagePath = join(worktree, 'package.json');
  if (['npm', 'pnpm', 'yarn'].includes(executable) && await pathExists(packagePath)) {
    try {
      const pkg = JSON.parse(await readFile(packagePath, 'utf8')) as { scripts?: Record<string, unknown> };
      const script = command.argv[0] === 'run' ? command.argv[1] : command.argv[0];
      const consumed = command.argv[0] === 'run' ? 2 : 1;
      if (script === undefined || command.argv.length !== consumed || typeof pkg.scripts?.[script] !== 'string') {
        return undefined;
      }
      const resolved = normalizeLegacyCommand(worktree, pkg.scripts[script]);
      if (['npm', 'pnpm', 'yarn'].includes(resolved.executable)) return undefined;
      return await commandAuthorizedByManifest(worktree, resolved);
    } catch (error) {
      if (error instanceof Error && /^COMMAND_(?:ARGUMENT|EXECUTABLE|CWD)_/u.test(error.message)) throw error;
      throw new Error(`COMMAND_DEFINITION_AMBIGUOUS:${command.executable} ${command.argv.join(' ')}`);
    }
  }
  if (executable === 'node' && command.argv[0] === '--test' && await pathExists(packagePath)) return command;
  if (executable === 'pytest' && await pathExists(join(worktree, 'pyproject.toml'))) return command;
  if (executable === 'mvn' && await pathExists(join(worktree, 'pom.xml'))) return command;
  if (executable === 'gradle' &&
      (await pathExists(join(worktree, 'build.gradle')) || await pathExists(join(worktree, 'build.gradle.kts')))) return command;
  if (executable === 'go' && command.argv[0] === 'test' && await pathExists(join(worktree, 'go.mod'))) return command;
  if (executable === 'cargo' && command.argv[0] === 'test' && await pathExists(join(worktree, 'Cargo.toml'))) return command;
  return undefined;
}

function commandMatchesAuthorized(
  base: AuthorizedCommand,
  definition: { executable: string; argv: readonly string[] },
): boolean {
  return [base.hint, base.resolved].some((candidate) =>
    candidate.executable === definition.executable &&
    canonicalJson(candidate.argv) === canonicalJson(definition.argv));
}

function assertNormalizedProjectPath(path: string, code: string): void {
  if (path === '.') return;
  if (isAbsolute(path) || path.includes('\0') || path.split(/[\\/]/u).includes('..') ||
      path.startsWith(`.${sep}`) || path.startsWith('./') || path.startsWith('.\\')) {
    throw new Error(`${code}:${path}`);
  }
}

async function executePlannerRun(
  runContext: RunExecutionContext,
  packet: Extract<RunPacket, { kind: 'PROJECT_TEST_PLANNER' }>,
): Promise<ProjectTestPlanCandidate> {
  await dispatchRun(runContext, packet.id);
  const accepted = await acceptRunResult(runContext, packet.id);
  if (accepted.kind !== 'PROJECT_TEST_PLANNER') throw new Error('PROJECT_TEST_PLANNER_RESULT_KIND_MISMATCH');
  return projectTestPlanCandidateSchema.parse(accepted.artifact);
}

function plannerPacketAgent(runContext: RunExecutionContext | undefined): {
  agentId: string;
  protocol: 'acp' | 'native';
  role: 'coordination-read-only';
} {
  return {
    agentId: runContext?.profile.agentId ?? 'fake-acp',
    protocol: runContext?.profile.protocol ?? 'acp',
    role: 'coordination-read-only',
  };
}

function preparationFromSet(set: ProjectTestCaseSet, commit: string): ProjectTestCasePreparation {
  return {
    status: 'READY',
    project: set.project,
    plannerRun: {
      id: set.plannerRun.id,
      kind: 'PROJECT_TEST_PLANNER',
      contentHash: set.plannerRun.packetHash,
    },
    commit,
    contentHash: set.contentHash,
    testCases: set.testCases,
    commandDefinitions: set.commandDefinitions,
  };
}

function projectTestCasesPath(input: ProjectPlanningInput): string {
  return changeArtifactPath(input.worktree, input.changeDirectory, 'test-cases.yaml');
}

function projectTestCaseStagingPath(context: VerificationPlannerContext, project: string): string {
  return join(executionRoot(context.home, context.worksetId), 'project-test-case-staging', `${project}.yaml`);
}

function contractTestCaseId(contractKey: string, scenarioId: string): string {
  const digest = sha256(`${contractKey}\0${scenarioId}`).slice('sha256:'.length);
  const value = Number.parseInt(digest.slice(0, 8), 16) % 10_000;
  return `TC-${String(value).padStart(4, '0')}`;
}

function contractScenarioLogicalRef(snapshot: ContractSnapshot, scenarioId: string): string {
  return `contract:${snapshot.manifest.contractKey}/${snapshot.manifest.id}/${scenarioId}`;
}

function contractScenarioKey(ref: ContractScenarioRef | ProjectTestPlannerContractScenario): string {
  return JSON.stringify([
    ref.contractKey,
    ref.scopeHash,
    ref.snapshot.id,
    ref.snapshot.contentHash,
    ref.scenarioId,
    ref.contentHash,
  ]);
}

export function scopedTaskKey(task: ScopedTaskRef): string {
  return JSON.stringify([task.project, task.changeId, task.revision, task.baseline, task.taskId]);
}

function sourceRefKey(ref: { ref: string; contentHash: string }): string {
  return `${ref.ref}\0${ref.contentHash}`;
}

function acceptanceCriterionSubjectRef(project: string, ref: string): string {
  return JSON.stringify([project, ref]);
}

function acceptanceCriterionKey(
  project: string,
  ref: { readonly ref: string; readonly contentHash: string },
): string {
  return JSON.stringify([project, ref.ref, ref.contentHash]);
}

function assertCapturedFilesMatchHead(
  worktree: string,
  head: string,
  refs: readonly { readonly ref: string; readonly contentHash: string }[],
): void {
  for (const ref of sortUnique(refs, (item) => item.ref)) {
    let bytes: Buffer;
    try {
      bytes = gitBuffer(worktree, ['show', `${head}:${ref.ref}`]);
    } catch {
      throw new Error(`PROJECT_PLANNING_INPUT_NOT_IN_HEAD:${ref.ref}`);
    }
    if (sha256(bytes) !== ref.contentHash) {
      throw new Error(`PROJECT_PLANNING_INPUT_NOT_IN_HEAD:${ref.ref}`);
    }
  }
}

function normalizeRepoRef(worktree: string, path: string): string {
  const ref = relative(worktree, path).split(sep).join('/');
  if (ref === '..' || ref.startsWith('../') || isAbsolute(ref)) throw new Error(`PROJECT_SOURCE_ESCAPE:${path}`);
  return ref;
}

function coordinationSnapshotPath(context: VerificationPlannerContext, runId: string, project: string): string {
  return join(context.home, 'worksets', context.worksetId, 'execution', 'runs', runId, 'snapshots', project);
}

function now(context: VerificationPlannerContext): string {
  return (context.now ?? (() => new Date().toISOString()))();
}

function isPlanningTask(task: Task): boolean {
  return !['CANCELLED', 'SUPERSEDED', 'INVALIDATED'].includes(task.status);
}

function assertContextTask(context: VerificationPlannerContext, task: ScopedTaskRef): void {
  scopedTaskRefSchema.parse(task);
  if (!/^WKS-\d{4}$/u.test(context.worksetId)) throw new Error(`WORKSET_ID_INVALID:${context.worksetId}`);
}

function isReplannableCaseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /PROJECT_TEST_CASES_(?:MISSING|STALE)|PROJECT_TEST_CASE_SET_HASH_MISMATCH/u.test(error.message);
}

function sortUnique<T>(items: readonly T[], key: (item: T) => string): T[] {
  const byKey = new Map(items.map((item) => [key(item), item]));
  return [...byKey.entries()].sort(([left], [right]) => compare(left, right)).map(([, item]) => item);
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  return sortUnique(items, key);
}

function requireMap<K, V>(map: ReadonlyMap<K, V>, key: K, code: string): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(code);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireSortedUnique<T>(
  items: readonly T[],
  key: (item: T) => string,
  field: string,
  context: z.RefinementCtx,
): void {
  for (let index = 1; index < items.length; index += 1) {
    if (key(items[index - 1]!) >= key(items[index]!)) {
      context.addIssue({ code: 'custom', path: [field], message: `SORTED_UNIQUE:${field}` });
      return;
    }
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function gitText(cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitTextWithInput(cwd: string, args: readonly string[], input: string): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function gitBuffer(cwd: string, args: readonly string[]): Buffer {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
