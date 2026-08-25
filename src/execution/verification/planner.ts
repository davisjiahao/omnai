import { mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { ensureDir, pathExists, readYaml, writeTextAtomic } from '../../core/files.js';
import { changeArtifactPath } from '../../core/paths.js';
import { resolveChange } from '../../core/store.js';
import { loadTasks } from '../../core/tasks.js';
import { resolveWorkset } from '../../workspace/worksets.js';
import type { Task } from '../../domain/types.js';
import type { ContractSnapshot } from '../contracts/store.js';
import { loadReadyContractSnapshotsForTask } from '../contracts/store.js';
import { resolveIntegrationEnvironmentProfile } from '../environments/profiles.js';
import { canonicalJson, hashObject, sha256 } from '../hashing.js';
import { nextExecutionId } from '../ids.js';
import { withWorksetMutationLock } from '../mutation-lock.js';
import {
  verificationPlanPath,
  verificationPlanRoot,
  verificationPlansRoot,
  verificationPlanTestCasesPath,
} from '../paths.js';
import {
  ENVIRONMENT_STEP_NAMES,
  hashVerificationPlan,
  integrationEnvironmentProfileSchema,
  projectTestCaseRef,
  testCaseRefKey,
  testCaseSchema,
  verificationCommandDefinitionKey,
  verificationPlanRefSchema,
  verificationPlanSchema,
  type ContentHash,
  type EnvironmentStepName,
  type IntegrationEnvironmentProfile,
  type IntegrationEnvironmentProfileRef,
  type NotApplicableDecision,
  type ScopedTaskRef,
  type TestCase,
  type TestCaseRef,
  type VerificationCommandDefinition,
  type VerificationDiagnostic,
  type VerificationPlan,
  type VerificationPlanV2,
  type VerificationPlanRef,
  type VerificationProjectInput,
} from '../types.js';
import {
  contractTestCaseReference,
  createDefaultVerificationPolicy,
  createVerificationPolicy,
  deriveContractTestCases,
  ensureProjectTestCases,
  loadProjectTestCaseSet,
  projectTestCaseReference,
  type ProjectTestCaseSet,
  type VerificationPlannerContext,
  type VerificationPolicyRef,
} from './test-cases.js';
import {
  compileVerificationPlanV2,
  type CompileVerificationPlanInput as CompileVerificationPlanV2Input,
} from './planner-v2.js';

export interface VerificationPlanScope {
  readonly scopedTasks: readonly ScopedTaskRef[];
  readonly profileId: string;
  readonly notApplicableDecisions?: readonly NotApplicableDecision[];
}

export interface CoverageResult {
  readonly valid: boolean;
  readonly diagnostics: readonly VerificationDiagnostic[];
  readonly coveredTasks: readonly string[];
  readonly coveredAcceptanceCriteria: readonly string[];
  readonly coveredContractScenarios: readonly string[];
}

export type VerificationChangedRef =
  | string
  | {
      readonly kind: 'SOURCE';
      readonly project: string;
      readonly ref: string;
      readonly contentHash?: ContentHash;
    }
  | {
      readonly kind: 'TASK' | 'CONTRACT' | 'POLICY' | 'PROFILE';
      readonly ref: string;
      readonly contentHash?: ContentHash;
    }
  | {
      readonly kind: 'COMMAND';
      readonly project: string;
      readonly ref: string;
      readonly contentHash?: ContentHash;
    }
  | {
      readonly kind: 'TEST_CASE';
      readonly ref: Pick<TestCaseRef, 'id' | 'scope'>;
      readonly contentHash?: ContentHash;
    };

interface ProjectCompilation {
  readonly set: ProjectTestCaseSet;
  readonly scopedTasks: readonly ScopedTaskRef[];
  readonly selectedCases: readonly TestCase[];
  readonly caseRefs: readonly TestCaseRef[];
  readonly projectInputs: readonly VerificationProjectInput[];
  readonly commandDefinitions: readonly VerificationCommandDefinition[];
}

interface PlanInventory {
  readonly testCases: readonly TestCase[];
  readonly refs: readonly TestCaseRef[];
}

const testCaseInventorySchema = z.strictObject({
  schemaVersion: z.literal(1),
  testCases: z.array(testCaseSchema).readonly(),
});

const legacyVerificationPlanV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  machineVersion: z.literal(1),
  lastEventSequence: z.number().int().nonnegative(),
  lastEventHash: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
  id: z.string().regex(/^VPL-\d{4}$/),
  worksetId: z.string().regex(/^WKS-\d{4}$/),
  status: z.enum(['DRAFT', 'READY', 'INVALID']),
  scopeHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  contractSnapshots: z.array(z.unknown()).readonly(),
  profile: z.unknown(),
  projectChecks: z.array(z.unknown()).readonly(),
  integrationCaseRefs: z.array(z.unknown()).readonly(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).superRefine((plan, validation) => {
  const expected = hashObject({
    schemaVersion: plan.schemaVersion,
    id: plan.id,
    worksetId: plan.worksetId,
    scopeHash: plan.scopeHash,
    contractSnapshots: plan.contractSnapshots,
    profile: plan.profile,
    projectChecks: plan.projectChecks,
    integrationCaseRefs: plan.integrationCaseRefs,
  });
  if (plan.contentHash !== expected) {
    validation.addIssue({ code: 'custom', path: ['contentHash'], message: 'LEGACY_CONTENT_HASH_MISMATCH' });
  }
});

export function compileVerificationPlan(input: CompileVerificationPlanV2Input): VerificationPlanV2;
export function compileVerificationPlan(
  context: VerificationPlannerContext,
  scopeInput: VerificationPlanScope,
): Promise<VerificationPlan>;
/**
 * 统一暴露历史持久化编译与 V2 纯编译入口。
 *
 * 两参数调用保持 Task 9A 的异步、落盘语义；单参数调用只复算 V2 准入证明。
 * 通过参数数量而不是字段猜测分流，可避免 hostile getter 或部分输入触发错误权威路径。
 */
export function compileVerificationPlan(
  contextOrInput: VerificationPlannerContext | CompileVerificationPlanV2Input,
  scopeInput?: VerificationPlanScope,
): Promise<VerificationPlan> | VerificationPlanV2 {
  if (scopeInput === undefined) {
    return compileVerificationPlanV2(contextOrInput as CompileVerificationPlanV2Input);
  }
  return compilePersistedVerificationPlan(contextOrInput as VerificationPlannerContext, scopeInput);
}

async function compilePersistedVerificationPlan(
  context: VerificationPlannerContext,
  scopeInput: VerificationPlanScope,
): Promise<VerificationPlan> {
  const scope = normalizeScope(scopeInput);
  const policy = verificationPolicy(context);
  const diagnostics: VerificationDiagnostic[] = [];
  const preparationContext: VerificationPlannerContext = {
    ...context,
    policy,
    notApplicableDecisions: scope.notApplicableDecisions ?? [],
  };
  const projectCompilations: ProjectCompilation[] = [];
  const fallbackProjectInputs: VerificationProjectInput[] = [];
  const projectGroups = groupTasksByProject(scope.scopedTasks);
  for (const [project, scopedTasks] of projectGroups) {
    try {
      fallbackProjectInputs.push(...await captureProjectInputs(context, scopedTasks));
    } catch (error) {
      diagnostics.push(diagnostic('PROJECT_INPUT_CAPTURE_FAILED', project, errorMessage(error)));
    }
    try {
      await ensureProjectTestCases(preparationContext, scopedTasks[0]!);
      projectCompilations.push(await compileProject(preparationContext, project, scopedTasks));
    } catch (error) {
      diagnostics.push(diagnostic(
        classifyProjectCompilationError(error),
        project,
        errorMessage(error),
      ));
    }
  }

  const snapshots: ContractSnapshot[] = [];
  const applicableContractKeys = new Set<string>();
  for (const scopedTask of scope.scopedTasks) {
    try {
      const resolved = await resolveContractSnapshots(context, scopedTask);
      snapshots.push(...resolved);
      for (const snapshot of resolved) applicableContractKeys.add(snapshot.manifest.contractKey);
    } catch (error) {
      const missingKey = contractNotReadyKey(error);
      if (missingKey !== undefined) applicableContractKeys.add(missingKey);
      diagnostics.push(diagnostic(
        contractDiagnosticCode(error),
        scopedTaskKey(scopedTask),
        errorMessage(error),
      ));
    }
  }
  const uniqueSnapshots = uniqueBy(snapshots, (snapshot) =>
    `${snapshot.manifest.contractKey}\0${snapshot.manifest.id}\0${snapshot.manifest.contentHash}`)
    .sort((left, right) => left.manifest.contractKey.localeCompare(right.manifest.contractKey));
  const snapshotsByContractKey = new Map<string, ContractSnapshot[]>();
  for (const snapshot of uniqueSnapshots) {
    snapshotsByContractKey.set(snapshot.manifest.contractKey, [
      ...(snapshotsByContractKey.get(snapshot.manifest.contractKey) ?? []),
      snapshot,
    ]);
  }
  for (const [contractKey, matching] of snapshotsByContractKey) {
    if (matching.length > 1) {
      diagnostics.push(diagnostic(
        `CONTRACT_READY_SELECTION_REQUIRED:${contractKey}`,
        contractKey,
        `Multiple READY ContractSnapshots are applicable for ${contractKey}.`,
      ));
    }
  }

  let profile: IntegrationEnvironmentProfile | undefined;
  let profileRef: IntegrationEnvironmentProfileRef | undefined;
  try {
    profile = await resolveProfileSnapshot(context, scope.profileId);
    profileRef = profile === undefined
      ? await resolveProfileRef(context, scope.profileId)
      : { id: profile.id, contentHash: profile.contentHash };
  } catch (error) {
    diagnostics.push(diagnostic('INTEGRATION_PROFILE_UNRESOLVED', scope.profileId, errorMessage(error)));
  }

  const projectCases = projectCompilations.flatMap((project) => project.selectedCases);
  const projectRefs = projectCompilations.flatMap((project) => project.caseRefs);
  const contractCases: TestCase[] = [];
  const contractRefs: TestCaseRef[] = [];
  for (const snapshot of uniqueSnapshots) {
    try {
      const cases = deriveContractTestCases(snapshot);
      contractCases.push(...cases);
      contractRefs.push(...cases.map((testCase) => contractTestCaseReference(snapshot, testCase)));
    } catch (error) {
      diagnostics.push(diagnostic(
        'CONTRACT_TEST_CASE_DERIVATION_FAILED',
        snapshot.manifest.contractKey,
        errorMessage(error),
      ));
    }
  }

  const notApplicableDecisions = sortUnique(
    [...(scope.notApplicableDecisions ?? [])],
    notApplicableKey,
  );

  const testCases = sortUnique([...projectCases, ...contractCases], testCaseIdentity);
  const testCaseRefs = sortUnique([...projectRefs, ...contractRefs], testCaseRefKey);
  const contractCaseEntries = contractCases.map((testCase) => ({
    testCase,
    ref: requireTestCaseRef(contractRefs, testCase),
  }));
  const projectChecks = projectCompilations.map((project) => {
    const scopedTaskKeys = new Set(project.scopedTasks.map(scopedTaskKey));
    const relevantContractRefs = contractCaseEntries
      .filter(({ testCase, ref }) => testCase.required &&
        !contractCaseNotApplicable(policy, notApplicableDecisions, ref, testCase) &&
        testCase.scopedTasks.some((task) => scopedTaskKeys.has(scopedTaskKey(task))))
      .map(({ ref }) => ref);
    return {
      project: project.set.project,
      scopedTasks: project.scopedTasks,
      caseRefs: sortUnique([...project.caseRefs, ...relevantContractRefs], testCaseRefKey),
      commandRefs: sortUnique(project.selectedCases.flatMap((item) => item.commandRefs), (item) => item),
    };
  }).sort((left, right) => left.project.localeCompare(right.project));
  const commandDefinitions = projectCompilations.flatMap((project) => project.commandDefinitions)
    .sort((left, right) =>
      verificationCommandDefinitionKey(left).localeCompare(verificationCommandDefinitionKey(right)));
  const caseEntries = [
    ...projectCompilations.flatMap((project) => project.selectedCases.map((testCase) => ({
      testCase,
      ref: requireTestCaseRef(project.caseRefs, testCase),
    }))),
    ...contractCaseEntries,
  ];
  const integrationEntries = caseEntries.filter(({ testCase, ref }) =>
    testCase.required && ['INTEGRATION', 'E2E'].includes(testCase.level) &&
    !contractCaseNotApplicable(policy, notApplicableDecisions, ref, testCase));
  if (integrationEntries.length > 0 && profile === undefined) {
    diagnostics.push(diagnostic(
      'INTEGRATION_PROFILE_DETAILS_UNRESOLVED',
      scope.profileId,
      'Integration/E2E cases require the complete immutable profile, not an ID/hash-only reference.',
    ));
  }
  for (const { testCase, ref } of integrationEntries) {
    for (const executorRef of testCase.commandRefs) {
      if (profile === undefined || resolveProfileExecutor(profile, executorRef) === undefined) {
        diagnostics.push(diagnostic(
          'INTEGRATION_EXECUTOR_UNRESOLVED',
          testCaseRefKey(ref),
          `Executor ${executorRef} does not resolve to one exact lifecycle step in profile ${scope.profileId}.`,
        ));
      }
    }
  }
  const integrationGates = profileRef === undefined || integrationEntries.length === 0
    ? []
    : [{
        id: 'IG-0001',
        required: true,
        profile: profileRef,
        caseRefs: sortUnique(integrationEntries.map((entry) => entry.ref), testCaseRefKey),
      }];
  const compiledProjects = new Set(projectCompilations.map((project) => project.set.project));
  const projectInputs = [
    ...projectCompilations.flatMap((project) => project.projectInputs),
    ...fallbackProjectInputs.filter((input) => !compiledProjects.has(input.project)),
  ].sort((left, right) => projectInputKey(left).localeCompare(projectInputKey(right)));
  const contractSnapshots = uniqueSnapshots.map((snapshot) => ({
    contractKey: snapshot.manifest.contractKey,
    scopeHash: snapshot.manifest.scopeHash,
    snapshot: { id: snapshot.manifest.id, contentHash: snapshot.manifest.contentHash },
  }));
  const scopeHash = hashObject({
    worksetId: context.worksetId,
    scopedTasks: scope.scopedTasks,
    profileId: scope.profileId,
    policy,
    notApplicableDecisions,
  });
  const semantic = {
    schemaVersion: 1,
    worksetId: context.worksetId,
    scopeHash,
    contractSnapshots,
    applicableContractKeys: [...applicableContractKeys].sort(),
    testCases: testCaseRefs,
    projectInputs,
    profileRefs: profileRef === undefined ? [] : [profileRef],
    projectChecks,
    commandDefinitions,
    integrationGates,
    policyId: policy.id,
    policyVersion: policy.version,
    policyHash: policy.contentHash,
    taskRiskRules: policy.taskRiskRules,
    scenarioClassRules: policy.scenarioClassRules,
    notApplicableRules: policy.notApplicableRules,
    notApplicableDecisions,
  };
  diagnostics.push(...validateCoverageInventory(
    semantic,
    { testCases, refs: testCaseRefs },
  ).diagnostics);
  const normalizedDiagnostics = sortUnique(diagnostics, diagnosticKey);
  const contentHash = hashVerificationPlan(semantic);

  return withWorksetMutationLock(context.home, context.worksetId, async () => {
    const existing = await findPlanByContentHash(context, contentHash, normalizedDiagnostics);
    if (existing !== undefined) return existing;
    const id = await nextExecutionId(context.home, context.worksetId, 'verification-plan');
    const timestamp = now(context);
    const draft = verificationPlanSchema.parse({
      ...semantic,
      id,
      machineVersion: 1,
      status: 'DRAFT',
      contentHash,
      validation: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      lastEventSequence: 0,
      lastEventHash: null,
    });
    const plan = transitionPlan(
      draft,
      normalizedDiagnostics.length === 0 ? 'READY' : 'INVALID',
      normalizedDiagnostics,
      context,
    );
    if (plan.status === 'READY') {
      const stale = await validatePlanFreshness(preparationContext, plan);
      if (stale !== undefined) throw new Error(`VERIFICATION_PLAN_STALE_DURING_COMPILE:${stale}`);
    }
    await persistPlanBundle(context, plan, testCases);
    return plan;
  }, { timeoutMs: 5_000 });
}

export async function validateVerificationPlanCoverage(
  context: VerificationPlannerContext,
  planInput: VerificationPlan,
): Promise<CoverageResult> {
  const plan = verificationPlanSchema.parse(planInput);
  const inventory = await loadPlanInventory(context, plan.id);
  const coverage = validateCoverageInventory(plan, inventory);
  const integrationDiagnostics = await validateIntegrationExecutorCoverage(context, plan, inventory);
  const diagnostics = sortUnique([...coverage.diagnostics, ...integrationDiagnostics], diagnosticKey);
  return { ...coverage, valid: diagnostics.length === 0, diagnostics };
}

export async function markVerificationPlanReady(
  context: VerificationPlannerContext,
  id: string,
): Promise<VerificationPlan> {
  return withWorksetMutationLock(context.home, context.worksetId, async () => {
    const plan = await loadVerificationPlan(context, id);
    if (plan.status === 'READY') return plan;
    if (plan.status !== 'DRAFT') throw new Error(`VERIFICATION_PLAN_NOT_DRAFT:${id}:${plan.status}`);
    if (plan.validation.length > 0) {
      const invalid = transitionPlan(plan, 'INVALID', plan.validation, context);
      await persistVerificationPlan(context, invalid);
      return invalid;
    }
    const coverage = await validateVerificationPlanCoverage(context, plan);
    if (!coverage.valid) {
      const invalid = transitionPlan(plan, 'INVALID', coverage.diagnostics, context);
      await persistVerificationPlan(context, invalid);
      return invalid;
    }
    const stale = await validatePlanFreshness(context, plan);
    if (stale !== undefined) {
      const invalid = transitionPlan(plan, 'INVALID', [diagnostic(
        'VERIFICATION_PLAN_STALE',
        stale,
        `Verification plan input is stale: ${stale}`,
      )], context);
      await persistVerificationPlan(context, invalid);
      return invalid;
    }
    const ready = transitionPlan(plan, 'READY', [], context);
    await persistVerificationPlan(context, ready);
    return ready;
  }, { timeoutMs: 5_000 });
}

export async function loadReadyVerificationPlan(
  context: VerificationPlannerContext,
  refInput: VerificationPlanRef,
): Promise<VerificationPlan> {
  const ref = verificationPlanRefSchema.parse(refInput);
  const plan = await loadVerificationPlan(context, ref.id);
  if (plan.contentHash !== ref.contentHash) throw new Error(`VERIFICATION_PLAN_REF_MISMATCH:${ref.id}`);
  if (plan.status !== 'READY') throw new Error(`VERIFICATION_PLAN_NOT_READY:${ref.id}:${plan.status}`);
  const stale = await validatePlanFreshness(context, plan);
  if (stale !== undefined) throw new Error(`VERIFICATION_PLAN_STALE:${stale}`);
  const coverage = await validateVerificationPlanCoverage(context, plan);
  if (!coverage.valid) {
    throw new Error(`VERIFICATION_PLAN_STALE:COVERAGE:${coverage.diagnostics.map((item) => item.code).join(',')}`);
  }
  return plan;
}

export async function invalidateVerificationPlans(
  context: VerificationPlannerContext,
  changedRef: VerificationChangedRef,
): Promise<string[]> {
  return withWorksetMutationLock(context.home, context.worksetId, async () => {
    const plans = await listVerificationPlans(context);
    const invalidated: string[] = [];
    for (const plan of plans) {
      if (plan.status !== 'READY' || !planIntersects(plan, changedRef)) continue;
      const ref = typeof changedRef === 'string'
        ? changedRef
        : changedRef.kind === 'SOURCE'
          ? `SOURCE:${JSON.stringify([changedRef.project, changedRef.ref])}${changedRef.contentHash === undefined ? '' : `:${changedRef.contentHash}`}`
          : changedRef.kind === 'TEST_CASE'
            ? `TEST_CASE:${testCaseLogicalKey(changedRef.ref)}${changedRef.contentHash === undefined ? '' : `:${changedRef.contentHash}`}`
            : changedRef.kind === 'COMMAND'
              ? `COMMAND:${verificationCommandDefinitionKey({
                  project: changedRef.project,
                  commandRef: changedRef.ref,
                })}${changedRef.contentHash === undefined ? '' : `:${changedRef.contentHash}`}`
            : `${changedRef.kind}:${changedRef.ref}${changedRef.contentHash === undefined ? '' : `:${changedRef.contentHash}`}`;
      const next = transitionPlan(plan, 'INVALID', [diagnostic(
        'VERIFICATION_INPUT_CHANGED',
        ref,
        `Verification input changed: ${ref}`,
      )], context);
      await persistVerificationPlan(context, next);
      invalidated.push(plan.id);
    }
    return invalidated.sort();
  }, { timeoutMs: 5_000 });
}

async function compileProject(
  context: VerificationPlannerContext,
  project: string,
  scopedTasks: readonly ScopedTaskRef[],
): Promise<ProjectCompilation> {
  const set = await loadProjectTestCaseSet(context, scopedTasks[0]!);
  const selectedTaskKeys = new Set(scopedTasks.map(scopedTaskKey));
  const selectedCases = set.testCases.filter((testCase) =>
    testCase.scopedTasks.some((task) => selectedTaskKeys.has(scopedTaskKey(task))));
  const caseRefs = selectedCases.map((testCase) =>
    projectTestCaseReference(testCase, scopedTasks[0]!)).sort((left, right) =>
      testCaseRefKey(left).localeCompare(testCaseRefKey(right)));
  const refById = new Map(selectedCases.map((testCase) => [
    testCase.id,
    projectTestCaseReference(testCase, scopedTasks[0]!),
  ]));
  const commandDefinitions = set.commandDefinitions.flatMap((definition) => {
    const refs = definition.caseRefs.flatMap((id) => {
      const ref = refById.get(id);
      return ref === undefined ? [] : [ref];
    }).sort((left, right) => testCaseRefKey(left).localeCompare(testCaseRefKey(right)));
    return refs.length === 0 ? [] : [{
      commandRef: definition.commandRef,
      project,
      executable: definition.executable,
      argv: definition.argv,
      cwd: definition.cwd,
      network: definition.network,
      timeoutMs: definition.timeoutMs,
      outputLimit: definition.outputLimit,
      caseRefs: refs,
    }];
  }).sort((left, right) =>
    verificationCommandDefinitionKey(left).localeCompare(verificationCommandDefinitionKey(right)));
  const workset = await resolveWorkset(context.home, context.worksetId);
  const member = workset.members.find((item) => item.project === project);
  if (member?.status !== 'ACTIVE' || member.worktree === undefined || member.changeId === undefined) {
    throw new Error(`PROJECT_NOT_ACTIVE:${project}`);
  }
  const change = await resolveChange(member.worktree, member.changeId);
  const taskFile = await loadTasks(changeArtifactPath(member.worktree, change.directoryName, 'tasks.yaml'));
  const taskById = new Map(taskFile.tasks.map((task) => [task.id, task]));
  const sourceRefs = sortUnique([
    ...set.sourceRefs,
    ...set.acceptanceCriteria,
    ...set.manifestRefs,
  ], sourceRefKey);
  const projectInputs = scopedTasks.map((scopedTask) => {
    const task = taskById.get(scopedTask.taskId);
    if (task === undefined) throw new Error(`SCOPED_TASK_NOT_FOUND:${scopedTaskKey(scopedTask)}`);
    return {
      project: scopedTask.project,
      changeId: scopedTask.changeId,
      revision: scopedTask.revision,
      baseline: scopedTask.baseline,
      taskId: scopedTask.taskId,
      taskContentHash: hashObject(task),
      risk: task.risk,
      sourceRefs,
    };
  }).sort((left, right) => projectInputKey(left).localeCompare(projectInputKey(right)));
  return { set, scopedTasks, selectedCases, caseRefs, projectInputs, commandDefinitions };
}

async function captureProjectInputs(
  context: VerificationPlannerContext,
  scopedTasks: readonly ScopedTaskRef[],
): Promise<VerificationProjectInput[]> {
  const first = scopedTasks[0]!;
  const workset = await resolveWorkset(context.home, context.worksetId);
  const member = workset.members.find((item) => item.project === first.project);
  if (member?.status !== 'ACTIVE' || member.worktree === undefined || member.changeId !== first.changeId) {
    throw new Error(`PROJECT_NOT_ACTIVE:${first.project}`);
  }
  const change = await resolveChange(member.worktree, first.changeId);
  if (change.metadata.activeRevision !== first.revision || change.metadata.baseline !== first.baseline) {
    throw new Error(`SCOPED_TASK_REVISION_STALE:${first.project}`);
  }
  const taskFile = await loadTasks(changeArtifactPath(member.worktree, change.directoryName, 'tasks.yaml'));
  const taskById = new Map(taskFile.tasks.map((task) => [task.id, task]));
  const specPath = changeArtifactPath(member.worktree, change.directoryName, 'spec.md');
  const specText = await readFile(specPath, 'utf8');
  const specRef = `.omnai/changes/${change.directoryName}/spec.md`;
  const sourceRefs = [{ ref: specRef, contentHash: sha256(specText) }, ...specText.split(/\r?\n/u)
    .flatMap((line) => [...line.matchAll(/\bAC-\d{3,}\b/gu)].map((match) => ({
      ref: `${specRef}#${match[0]}`,
      contentHash: sha256(line.trim()),
    })))]
    .sort((left, right) => compare(sourceRefKey(left), sourceRefKey(right)));
  return scopedTasks.map((scopedTask) => {
    const task = taskById.get(scopedTask.taskId);
    if (task === undefined) throw new Error(`SCOPED_TASK_NOT_FOUND:${scopedTaskKey(scopedTask)}`);
    return {
      project: scopedTask.project,
      changeId: scopedTask.changeId,
      revision: scopedTask.revision,
      baseline: scopedTask.baseline,
      taskId: scopedTask.taskId,
      taskContentHash: hashObject(task),
      risk: task.risk,
      sourceRefs,
    };
  }).sort((left, right) => projectInputKey(left).localeCompare(projectInputKey(right)));
}

function validateCoverageInventory(
  plan: Pick<VerificationPlan,
    'worksetId' | 'testCases' | 'projectInputs' | 'projectChecks' | 'commandDefinitions' | 'applicableContractKeys' | 'contractSnapshots' |
    'integrationGates' | 'notApplicableDecisions' | 'policyId' | 'policyHash' |
    'taskRiskRules' | 'scenarioClassRules' | 'notApplicableRules'>,
  inventory: PlanInventory,
): CoverageResult {
  const diagnostics: VerificationDiagnostic[] = [];
  const caseByRef = new Map<string, TestCase>();
  for (const [index, ref] of plan.testCases.entries()) {
    const testCase = inventory.testCases.find((item) => item.contentHash === ref.contentHash && item.id === ref.id);
    if (testCase === undefined) {
      diagnostics.push(diagnostic('TEST_CASE_INVENTORY_MISSING', testCaseRefKey(ref), 'Referenced TestCase is absent.'));
      continue;
    }
    caseByRef.set(testCaseRefKey(ref), testCase);
    if (inventory.refs[index] !== undefined && testCaseRefKey(inventory.refs[index]!) !== testCaseRefKey(ref)) {
      // Inventory order does not carry authority; exact references above do.
    }
  }
  const coveredTasks = new Set<string>();
  const coveredAcceptance = new Set<string>();
  const coveredScenarios = new Set<string>();
  const levelsByTask = new Map<string, Set<TestCase['level']>>();
  const levelsByScenario = new Map<string, Set<TestCase['level']>>();
  const boundContractRefs = new Set(plan.contractSnapshots.map((binding) =>
    `${binding.snapshot.id}\0${binding.snapshot.contentHash}`));
  const boundContractScenarios = new Set(plan.contractSnapshots.map((binding) =>
    contractSnapshotBindingKey(binding)));
  const mappedCases = new Set(plan.commandDefinitions.flatMap((definition) => definition.caseRefs.map(testCaseRefKey)));
  const gatedCases = new Set(plan.integrationGates.flatMap((gate) => gate.caseRefs.map(testCaseRefKey)));
  for (const input of plan.projectInputs) {
    const taskKey = scopedTaskKey(input);
    const check = plan.projectChecks.find((candidate) => candidate.project === input.project);
    if (check === undefined || !check.scopedTasks.some((task) => scopedTaskKey(task) === taskKey)) {
      diagnostics.push(diagnostic(
        'PROJECT_CHECK_TASK_SCOPE_MISSING',
        taskKey,
        'Project check does not freeze this scoped task.',
      ));
      continue;
    }
    const checkCases = new Set(check.caseRefs.map(testCaseRefKey));
    for (const [key, testCase] of caseByRef) {
      const reference = plan.testCases.find((item) => testCaseRefKey(item) === key)!;
      if (testCase.required && testCase.scopedTasks.some((task) => scopedTaskKey(task) === taskKey) &&
          !contractCaseNotApplicable(plan, plan.notApplicableDecisions, reference, testCase) &&
          !checkCases.has(key)) {
        diagnostics.push(diagnostic(
          'PROJECT_CHECK_CASE_MISSING',
          key,
          `Project check ${input.project} does not freeze a required case for ${taskKey}.`,
        ));
      }
    }
  }
  for (const [key, testCase] of caseByRef) {
    const reference = plan.testCases.find((item) => testCaseRefKey(item) === key)!;
    for (const contractRef of testCase.contractRefs) {
      if (!boundContractRefs.has(`${contractRef.id}\0${contractRef.contentHash}`)) {
        diagnostics.push(diagnostic(
          'TEST_CASE_CONTRACT_BINDING_MISMATCH',
          key,
          'TestCase references a ContractSnapshot that is not frozen in this plan.',
        ));
      }
    }
    for (const scenario of testCase.scenarioRefs) {
      if (!boundContractScenarios.has(contractScenarioBindingKey(scenario))) {
        diagnostics.push(diagnostic(
          'TEST_CASE_CONTRACT_BINDING_MISMATCH',
          key,
          'TestCase scenario does not bind an exact ContractSnapshot frozen in this plan.',
        ));
      }
    }
    if (!testCase.required || contractCaseNotApplicable(plan, plan.notApplicableDecisions, reference, testCase)) continue;
    for (const task of testCase.scopedTasks) {
      const taskKey = scopedTaskKey(task);
      coveredTasks.add(taskKey);
      const levels = levelsByTask.get(taskKey) ?? new Set<TestCase['level']>();
      levels.add(testCase.level);
      levelsByTask.set(taskKey, levels);
    }
    if (reference.scope.kind === 'PROJECT') {
      for (const ref of testCase.acceptanceCriteriaRefs) {
        coveredAcceptance.add(acceptanceCriterionKey(reference.scope.project, ref));
      }
    } else if (testCase.acceptanceCriteriaRefs.length > 0) {
      diagnostics.push(diagnostic(
        'TEST_CASE_ACCEPTANCE_SCOPE_UNRESOLVED',
        key,
        'Contract-scoped cases cannot satisfy a project acceptance criterion.',
      ));
    }
    for (const ref of testCase.scenarioRefs) {
      const scenarioKey = contractScenarioKey(ref);
      if (!boundContractScenarios.has(contractScenarioBindingKey(ref))) {
        diagnostics.push(diagnostic(
          'TEST_CASE_CONTRACT_BINDING_MISMATCH',
          key,
          'TestCase scenario does not bind an exact ContractSnapshot frozen in this plan.',
        ));
        continue;
      }
      coveredScenarios.add(scenarioKey);
      const levels = levelsByScenario.get(scenarioKey) ?? new Set<TestCase['level']>();
      levels.add(testCase.level);
      levelsByScenario.set(scenarioKey, levels);
    }
    if (reference.scope.kind === 'PROJECT' && !mappedCases.has(key)) {
      diagnostics.push(diagnostic('COMMAND_CASE_MAPPING_MISSING', key, 'Required project case has no command mapping.'));
    }
    if (['INTEGRATION', 'E2E'].includes(testCase.level) && !gatedCases.has(key)) {
      diagnostics.push(diagnostic('INTEGRATION_CASE_GATE_MISSING', key, 'Required Integration/E2E case has no profile-bound gate.'));
    }
  }
  for (const input of plan.projectInputs) {
    const taskRef = scopedTaskKey(input);
    const taskNotApplicable = hasNotApplicable(
      plan,
      'TASK',
      taskRef,
      input.taskContentHash,
      { taskRisks: [input.risk] },
    );
    if (!coveredTasks.has(taskRef) && !taskNotApplicable) {
      diagnostics.push(diagnostic('REQUIRED_COVERAGE_MISSING:TASK', taskRef, 'Behavior-changing task has no required TestCase.'));
    }
    if (!taskNotApplicable) {
      const rule = plan.taskRiskRules.find((candidate) => candidate.risk === input.risk);
      if (rule === undefined) {
        diagnostics.push(diagnostic(
          'RISK_POLICY_RULE_MISSING:TASK',
          taskRef,
          `No verification coverage rule is defined for task risk ${input.risk}.`,
        ));
      } else {
        const actualLevels = levelsByTask.get(taskRef) ?? new Set<TestCase['level']>();
        for (const requiredGroup of rule.requiredLevelGroups) {
          if (!requiredGroup.some((level) => actualLevels.has(level))) {
            diagnostics.push(diagnostic(
              'RISK_POLICY_LEVEL_MISSING:TASK',
              taskRef,
              `Risk ${input.risk} requires one of: ${requiredGroup.join(',')}.`,
            ));
          }
        }
      }
    }
    for (const ref of input.sourceRefs.filter((item) => /#AC-\d+$/u.test(item.ref))) {
      const key = acceptanceCriterionKey(input.project, ref);
      if (!coveredAcceptance.has(key) && !hasNotApplicable(
        plan,
        'ACCEPTANCE_CRITERION',
        acceptanceCriterionSubjectRef(input.project, ref.ref),
        ref.contentHash,
        { taskRisks: [input.risk] },
      )) {
        diagnostics.push(diagnostic('REQUIRED_COVERAGE_MISSING:ACCEPTANCE_CRITERION', key, 'Acceptance criterion has no required TestCase.'));
      }
    }
  }
  const boundContractKeys = new Set(plan.contractSnapshots.map((binding) => binding.contractKey));
  const contractBindingCounts = new Map<string, number>();
  for (const binding of plan.contractSnapshots) {
    contractBindingCounts.set(binding.contractKey, (contractBindingCounts.get(binding.contractKey) ?? 0) + 1);
  }
  for (const [contractKey, count] of contractBindingCounts) {
    if (count > 1) {
      diagnostics.push(diagnostic(
        `CONTRACT_READY_SELECTION_REQUIRED:${contractKey}`,
        contractKey,
        `Multiple ContractSnapshot bindings exist for ${contractKey}.`,
      ));
    }
  }
  for (const key of plan.applicableContractKeys) {
    if (!boundContractKeys.has(key)) {
      diagnostics.push(diagnostic(`CONTRACT_NOT_READY:${key}`, key, `No exact READY ContractSnapshot is bound for ${key}.`));
    }
  }
  for (const testCase of inventory.testCases) {
    for (const scenario of testCase.scenarioRefs) {
      const key = contractScenarioKey(scenario);
      const scenarioNotApplicable = hasNotApplicable(
        plan,
        'CONTRACT_SCENARIO',
        scenario.scenarioId,
        scenario.contentHash,
        { scenarioClass: scenario.scenarioClass },
      );
      if (!coveredScenarios.has(key) && !scenarioNotApplicable) {
        diagnostics.push(diagnostic('REQUIRED_COVERAGE_MISSING:CONTRACT_SCENARIO', scenario.scenarioId, 'Contract scenario has no required TestCase.'));
      }
      if (!scenarioNotApplicable) {
        const rule = plan.scenarioClassRules.find((candidate) => candidate.scenarioClass === scenario.scenarioClass);
        if (rule === undefined) {
          diagnostics.push(diagnostic(
            'RISK_POLICY_RULE_MISSING:CONTRACT_SCENARIO',
            scenario.scenarioId,
            `No verification coverage rule is defined for ${scenario.scenarioClass} scenarios.`,
          ));
        } else {
          const actualLevels = levelsByScenario.get(key) ?? new Set<TestCase['level']>();
          if (!rule.allowedLevels.some((level) => actualLevels.has(level))) {
            diagnostics.push(diagnostic(
              'RISK_POLICY_LEVEL_MISSING:CONTRACT_SCENARIO',
              scenario.scenarioId,
              `${scenario.scenarioClass} scenarios require one of: ${rule.allowedLevels.join(',')}.`,
            ));
          }
        }
      }
    }
  }
  diagnostics.push(...validateNotApplicableDecisions(plan, inventory));
  return {
    valid: diagnostics.length === 0,
    diagnostics: sortUnique(diagnostics, diagnosticKey),
    coveredTasks: [...coveredTasks].sort(),
    coveredAcceptanceCriteria: [...coveredAcceptance].sort(),
    coveredContractScenarios: [...coveredScenarios].sort(),
  };
}

async function validateIntegrationExecutorCoverage(
  context: VerificationPlannerContext,
  plan: VerificationPlan,
  inventory: PlanInventory,
): Promise<VerificationDiagnostic[]> {
  const diagnostics: VerificationDiagnostic[] = [];
  const caseByRef = new Map<string, TestCase>();
  for (const ref of plan.testCases) {
    const matching = inventory.testCases.filter((testCase) =>
      testCase.id === ref.id && testCase.contentHash === ref.contentHash);
    if (matching.length === 1) caseByRef.set(testCaseRefKey(ref), matching[0]!);
  }
  const profileCache = new Map<string, IntegrationEnvironmentProfile | undefined>();
  for (const ref of plan.testCases) {
    const testCase = caseByRef.get(testCaseRefKey(ref));
    if (testCase === undefined || !testCase.required || !['INTEGRATION', 'E2E'].includes(testCase.level) ||
        contractCaseNotApplicable(plan, plan.notApplicableDecisions, ref, testCase)) continue;
    const matchingGates = plan.integrationGates.filter((gate) =>
      gate.required && gate.caseRefs.some((caseRef) => testCaseRefKey(caseRef) === testCaseRefKey(ref)));
    if (matchingGates.length !== 1) {
      diagnostics.push(diagnostic(
        matchingGates.length === 0 ? 'INTEGRATION_CASE_GATE_MISSING' : 'INTEGRATION_CASE_GATE_AMBIGUOUS',
        testCaseRefKey(ref),
        'Every required Integration/E2E case must bind exactly one required profile gate.',
      ));
      continue;
    }
    const gate = matchingGates[0]!;
    const profileKey = `${gate.profile.id}\0${gate.profile.contentHash}`;
    if (!profileCache.has(profileKey)) {
      try {
        const profile = await resolveProfileSnapshot(context, gate.profile.id);
        profileCache.set(profileKey, profile);
      } catch {
        profileCache.set(profileKey, undefined);
      }
    }
    const profile = profileCache.get(profileKey);
    if (profile === undefined || profile.id !== gate.profile.id || profile.contentHash !== gate.profile.contentHash) {
      diagnostics.push(diagnostic(
        'INTEGRATION_PROFILE_DETAILS_UNRESOLVED',
        gate.id,
        `Gate ${gate.id} does not resolve to its exact immutable profile.`,
      ));
      continue;
    }
    for (const executorRef of testCase.commandRefs) {
      if (resolveProfileExecutor(profile, executorRef) === undefined) {
        diagnostics.push(diagnostic(
          'INTEGRATION_EXECUTOR_UNRESOLVED',
          testCaseRefKey(ref),
          `Executor ${executorRef} does not resolve to one exact lifecycle step in profile ${profile.id}.`,
        ));
      }
    }
  }
  for (const gate of plan.integrationGates) {
    for (const ref of gate.caseRefs) {
      const testCase = caseByRef.get(testCaseRefKey(ref));
      if (testCase !== undefined && !['INTEGRATION', 'E2E'].includes(testCase.level)) {
        diagnostics.push(diagnostic(
          'INTEGRATION_GATE_CASE_LEVEL_INVALID',
          testCaseRefKey(ref),
          `Gate ${gate.id} contains a non-integration TestCase.`,
        ));
      }
    }
  }
  return sortUnique(diagnostics, diagnosticKey);
}

async function validatePlanFreshness(
  context: VerificationPlannerContext,
  plan: VerificationPlan,
): Promise<string | undefined> {
  const policy = verificationPolicy(context);
  if (policy.id !== plan.policyId || policy.version !== plan.policyVersion || policy.contentHash !== plan.policyHash) {
    return `POLICY:${policy.id}`;
  }
  const caseContext: VerificationPlannerContext = {
    ...context,
    policy,
    notApplicableDecisions: plan.notApplicableDecisions,
  };
  const workset = await resolveWorkset(context.home, context.worksetId);
  for (const input of plan.projectInputs) {
    const member = workset.members.find((item) => item.project === input.project);
    if (member?.status !== 'ACTIVE' || member.worktree === undefined || member.changeId !== input.changeId) {
      return `TASK:${projectInputKey(input)}`;
    }
    const change = await resolveChange(member.worktree, input.changeId);
    if (change.metadata.activeRevision !== input.revision || change.metadata.baseline !== input.baseline) {
      return `TASK:${projectInputKey(input)}`;
    }
    const taskFile = await loadTasks(changeArtifactPath(member.worktree, change.directoryName, 'tasks.yaml'));
    const task = taskFile.tasks.find((item) => item.id === input.taskId);
    if (task === undefined || hashObject(task) !== input.taskContentHash) return `TASK:${projectInputKey(input)}`;
    for (const ref of input.sourceRefs) {
      const actual = await currentProjectSourceHash(member.worktree, ref.ref);
      if (actual !== ref.contentHash) return `SOURCE:${ref.ref}`;
    }
    try {
      await loadProjectTestCaseSet(caseContext, input);
    } catch (error) {
      const detail = errorMessage(error);
      if (/SOURCE/u.test(detail)) return `SOURCE:${input.project}`;
      if (/COMMAND/u.test(detail)) return `COMMAND:${input.project}`;
      return `TEST_CASE:${input.project}`;
    }
  }
  const expectedContracts = new Map(plan.contractSnapshots.map((binding) => [binding.contractKey, binding]));
  const currentSnapshots: ContractSnapshot[] = [];
  for (const input of plan.projectInputs) {
    try {
      currentSnapshots.push(...await resolveContractSnapshots(context, input));
    } catch {
      return `CONTRACT:${input.project}:${input.taskId}`;
    }
  }
  const distinctCurrentSnapshots = uniqueBy(currentSnapshots, (item) =>
    `${item.manifest.contractKey}\0${item.manifest.id}\0${item.manifest.contentHash}`);
  const currentSnapshotCounts = new Map<string, number>();
  for (const snapshot of distinctCurrentSnapshots) {
    currentSnapshotCounts.set(
      snapshot.manifest.contractKey,
      (currentSnapshotCounts.get(snapshot.manifest.contractKey) ?? 0) + 1,
    );
  }
  for (const [contractKey, count] of currentSnapshotCounts) {
    if (count > 1) return `CONTRACT:${contractKey}:ambiguous`;
  }
  const uniqueCurrentSnapshots = uniqueBy(distinctCurrentSnapshots, (item) => item.manifest.contractKey);
  for (const snapshot of uniqueCurrentSnapshots) {
    const expected = expectedContracts.get(snapshot.manifest.contractKey);
    if (expected === undefined || expected.scopeHash !== snapshot.manifest.scopeHash ||
        expected.snapshot.id !== snapshot.manifest.id || expected.snapshot.contentHash !== snapshot.manifest.contentHash) {
      return `CONTRACT:${snapshot.manifest.contractKey}`;
    }
  }
  const currentContractKeys = new Set(uniqueCurrentSnapshots.map((snapshot) => snapshot.manifest.contractKey));
  for (const expectedKey of expectedContracts.keys()) {
    if (!currentContractKeys.has(expectedKey)) return `CONTRACT:${expectedKey}:missing`;
  }
  for (const profile of plan.profileRefs) {
    try {
      const current = await resolveProfileRef(context, profile.id);
      if (current.contentHash !== profile.contentHash) return `PROFILE:${profile.id}`;
    } catch {
      return `PROFILE:${profile.id}`;
    }
  }
  return undefined;
}

async function currentProjectSourceHash(worktree: string, ref: string): Promise<ContentHash | undefined> {
  const [path, fragment] = ref.split('#', 2);
  if (path === undefined) return undefined;
  const absolute = join(worktree, path);
  if (!(await pathExists(absolute))) return undefined;
  if (fragment?.startsWith('AC-')) {
    const text = await readFile(absolute, 'utf8');
    const line = text.split(/\r?\n/u).find((item) => new RegExp(`\\b${escapeRegExp(fragment)}\\b`, 'u').test(item));
    return line === undefined ? undefined : sha256(line.trim());
  }
  return sha256(await readFile(absolute));
}

async function resolveContractSnapshots(
  context: VerificationPlannerContext,
  scopedTask: ScopedTaskRef,
): Promise<ContractSnapshot[]> {
  return context.contractSnapshotResolver === undefined
    ? loadReadyContractSnapshotsForTask(context, scopedTask.project, scopedTask.taskId)
    : context.contractSnapshotResolver(scopedTask);
}

async function resolveProfileRef(
  context: VerificationPlannerContext,
  profileId: string,
): Promise<IntegrationEnvironmentProfileRef> {
  if (context.profileRefResolver !== undefined) return context.profileRefResolver(profileId);
  const profile = await resolveIntegrationEnvironmentProfile(context, profileId);
  return { id: profile.id, contentHash: profile.contentHash };
}

async function resolveProfileSnapshot(
  context: VerificationPlannerContext,
  profileId: string,
): Promise<IntegrationEnvironmentProfile | undefined> {
  if (context.profileResolver !== undefined) {
    return integrationEnvironmentProfileSchema.parse(await context.profileResolver(profileId));
  }
  if (context.profileRefResolver !== undefined) return undefined;
  return resolveIntegrationEnvironmentProfile(context, profileId);
}

function verificationPolicy(context: VerificationPlannerContext): VerificationPolicyRef {
  const policy = context.policy ?? createDefaultVerificationPolicy();
  const normalized = createVerificationPolicy(policy);
  if (normalized.contentHash !== policy.contentHash) {
    throw new Error(`VERIFICATION_POLICY_HASH_MISMATCH:${policy.id}`);
  }
  return normalized;
}

async function persistPlanBundle(
  context: VerificationPlannerContext,
  plan: VerificationPlan,
  testCases: readonly TestCase[],
): Promise<void> {
  const root = verificationPlansRoot(context.home, context.worksetId);
  await ensureDir(root);
  const stage = await mkdtemp(join(root, `.${plan.id}.stage-`));
  const target = verificationPlanRoot(context.home, context.worksetId, plan.id);
  let published = false;
  try {
    await writeTextAtomic(join(stage, 'test-cases.yaml'), YAML.stringify(testCaseInventorySchema.parse({
      schemaVersion: 1,
      testCases,
    }), { lineWidth: 100 }));
    await context.planPersistenceFaults?.afterInventoryStaged?.();
    if (plan.status === 'READY') {
      const stale = await validatePlanFreshness(context, plan);
      if (stale !== undefined) throw new Error(`VERIFICATION_PLAN_STALE_DURING_COMPILE:${stale}`);
      const coverage = validateCoverageInventory(plan, { testCases, refs: plan.testCases });
      const executorDiagnostics = await validateIntegrationExecutorCoverage(
        context,
        plan,
        { testCases, refs: plan.testCases },
      );
      if (!coverage.valid || executorDiagnostics.length > 0) {
        throw new Error(
          `VERIFICATION_PLAN_STALE_DURING_COMPILE:COVERAGE:${[
            ...coverage.diagnostics, ...executorDiagnostics,
          ].map((item) => item.code).join(',')}`,
        );
      }
    }
    await writeTextAtomic(
      join(stage, 'plan.yaml'),
      YAML.stringify(verificationPlanSchema.parse(plan), { lineWidth: 100 }),
    );
    if (await pathExists(target)) throw new Error(`VERIFICATION_PLAN_ALREADY_EXISTS:${plan.id}`);
    await rename(stage, target);
    published = true;
  } finally {
    if (!published) await rm(stage, { recursive: true, force: true });
  }
}

async function loadPlanInventory(
  context: VerificationPlannerContext,
  id: string,
): Promise<PlanInventory> {
  const path = verificationPlanTestCasesPath(context.home, context.worksetId, id);
  const inventory = await readYaml(path, testCaseInventorySchema);
  const plan = await loadVerificationPlan(context, id);
  const refs: TestCaseRef[] = [];
  for (const testCase of inventory.testCases) {
    const matching = plan.testCases.filter((ref) => ref.id === testCase.id && ref.contentHash === testCase.contentHash);
    if (matching.length !== 1) throw new Error(`VERIFICATION_PLAN_TEST_CASE_INVENTORY_MISMATCH:${testCase.id}`);
    refs.push(matching[0]!);
  }
  const inventoryKeys = sortUnique(refs, testCaseRefKey).map(testCaseRefKey);
  const planKeys = plan.testCases.map(testCaseRefKey);
  if (inventory.testCases.length !== plan.testCases.length || refs.length !== plan.testCases.length ||
      canonicalJson(inventoryKeys) !== canonicalJson(planKeys)) {
    throw new Error(`VERIFICATION_PLAN_TEST_CASE_INVENTORY_MISMATCH:${id}`);
  }
  return { testCases: inventory.testCases, refs: refs.sort((left, right) => testCaseRefKey(left).localeCompare(testCaseRefKey(right))) };
}

async function persistVerificationPlan(
  context: VerificationPlannerContext,
  plan: VerificationPlan,
): Promise<void> {
  const path = verificationPlanPath(context.home, context.worksetId, plan.id);
  await ensureDir(dirname(path));
  await writeTextAtomic(path, YAML.stringify(verificationPlanSchema.parse(plan), { lineWidth: 100 }));
}

async function loadVerificationPlan(
  context: VerificationPlannerContext,
  id: string,
): Promise<VerificationPlan> {
  const path = verificationPlanPath(context.home, context.worksetId, id);
  const modernRoot = verificationPlanRoot(context.home, context.worksetId, id);
  const legacyPath = join(verificationPlansRoot(context.home, context.worksetId), `${id}.yaml`);
  const [modernRootExists, modernExists, legacyExists] = await Promise.all([
    pathExists(modernRoot), pathExists(path), pathExists(legacyPath),
  ]);
  if (modernRootExists && legacyExists) throw new Error(`VERIFICATION_PLAN_ID_COLLISION:${id}`);
  if (modernRootExists && !modernExists) throw new Error(`VERIFICATION_PLAN_MODERN_CORRUPT:${id}:PLAN_MISSING`);
  if (modernExists) {
    try {
      const plan = await readYaml(path, verificationPlanSchema);
      if (plan.id !== id || plan.worksetId !== context.worksetId) {
        throw new Error('IDENTITY_MISMATCH');
      }
      return plan;
    } catch (error) {
      throw new Error(`VERIFICATION_PLAN_MODERN_CORRUPT:${id}:${errorMessage(error)}`);
    }
  }
  if (legacyExists) {
    await recognizeLegacyVerificationPlan(context, id, legacyPath);
    throw new Error(`VERIFICATION_PLAN_LEGACY_RECOMPILE_REQUIRED:${id}`);
  }
  return readYaml(path, verificationPlanSchema);
}

async function listVerificationPlans(context: VerificationPlannerContext): Promise<VerificationPlan[]> {
  const root = verificationPlansRoot(context.home, context.worksetId);
  if (!(await pathExists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const legacyIds = new Set<string>();
  for (const entry of entries) {
    const match = entry.isFile() ? /^(VPL-\d{4})\.yaml$/u.exec(entry.name) : null;
    if (match === null) continue;
    const id = match[1]!;
    legacyIds.add(id);
    await recognizeLegacyVerificationPlan(context, id, join(root, entry.name));
  }
  const plans: VerificationPlan[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^VPL-\d{4}$/u.test(entry.name)) continue;
    if (legacyIds.has(entry.name)) throw new Error(`VERIFICATION_PLAN_ID_COLLISION:${entry.name}`);
    if (!(await pathExists(verificationPlanPath(context.home, context.worksetId, entry.name)))) {
      throw new Error(`VERIFICATION_PLAN_MODERN_CORRUPT:${entry.name}:PLAN_MISSING`);
    }
    plans.push(await loadVerificationPlan(context, entry.name));
  }
  return plans.sort((left, right) => left.id.localeCompare(right.id));
}

async function recognizeLegacyVerificationPlan(
  context: VerificationPlannerContext,
  id: string,
  path: string,
): Promise<void> {
  try {
    const legacy = await readYaml(path, legacyVerificationPlanV1Schema);
    if (legacy.id !== id || legacy.worksetId !== context.worksetId) {
      throw new Error('LEGACY_IDENTITY_MISMATCH');
    }
  } catch (error) {
    throw new Error(`VERIFICATION_PLAN_LEGACY_CORRUPT:${id}:${errorMessage(error)}`);
  }
}

async function findPlanByContentHash(
  context: VerificationPlannerContext,
  contentHash: ContentHash,
  diagnostics: readonly VerificationDiagnostic[],
): Promise<VerificationPlan | undefined> {
  const expectedDiagnostics = canonicalJson(sortUnique([...diagnostics], diagnosticKey));
  const match = (await listVerificationPlans(context)).find((plan) => {
    if (plan.contentHash !== contentHash) return false;
    if (diagnostics.length === 0) return plan.status === 'READY';
    return plan.status === 'INVALID' && plan.lastEventSequence === 1 &&
      canonicalJson(plan.validation) === expectedDiagnostics;
  });
  if (match === undefined) return undefined;
  const inventory = await loadPlanInventory(context, match.id);
  if (match.status === 'READY') {
    const stale = await validatePlanFreshness(context, match);
    if (stale !== undefined) throw new Error(`VERIFICATION_PLAN_STALE:${stale}`);
    const coverage = validateCoverageInventory(match, inventory);
    const executorDiagnostics = await validateIntegrationExecutorCoverage(context, match, inventory);
    if (!coverage.valid || executorDiagnostics.length > 0) {
      throw new Error(`VERIFICATION_PLAN_STALE:COVERAGE:${[
        ...coverage.diagnostics, ...executorDiagnostics,
      ].map((item) => item.code).join(',')}`);
    }
  }
  return match;
}

function transitionPlan(
  plan: VerificationPlan,
  status: 'READY' | 'INVALID',
  diagnostics: readonly VerificationDiagnostic[],
  context: VerificationPlannerContext,
): VerificationPlan {
  const timestamp = now(context);
  const event = hashObject({
    aggregateId: plan.id,
    sequence: plan.lastEventSequence + 1,
    from: plan.status,
    to: status,
    diagnostics,
    previousHash: plan.lastEventHash,
    timestamp,
  });
  return verificationPlanSchema.parse({
    ...plan,
    status,
    validation: sortUnique([...diagnostics], diagnosticKey),
    updatedAt: timestamp,
    lastEventSequence: plan.lastEventSequence + 1,
    lastEventHash: event,
  });
}

function planIntersects(plan: VerificationPlan, changedRef: VerificationChangedRef): boolean {
  const identities = new Set<string>();
  for (const input of plan.projectInputs) {
    identities.add(scopedTaskKey(input));
    identities.add(`TASK:${scopedTaskKey(input)}:${input.taskContentHash}`);
    for (const source of input.sourceRefs) {
      const sourceIdentity = JSON.stringify([input.project, source.ref]);
      identities.add(sourceIdentity);
      identities.add(`SOURCE:${sourceIdentity}:${source.contentHash}`);
    }
  }
  for (const binding of plan.contractSnapshots) {
    identities.add(binding.contractKey);
    identities.add(binding.snapshot.id);
    identities.add(`CONTRACT:${binding.contractKey}:${binding.snapshot.contentHash}`);
  }
  for (const key of plan.applicableContractKeys) identities.add(key);
  for (const definition of plan.commandDefinitions) {
    const logical = verificationCommandDefinitionKey(definition);
    identities.add(logical);
    identities.add(`COMMAND:${logical}:${hashObject(definition)}`);
  }
  for (const profile of plan.profileRefs) {
    identities.add(profile.id);
    identities.add(`PROFILE:${profile.id}:${profile.contentHash}`);
  }
  identities.add(plan.policyId);
  identities.add(`POLICY:${plan.policyId}:${plan.policyHash}`);
  for (const ref of plan.testCases) {
    const logical = testCaseLogicalKey(ref);
    identities.add(logical);
    identities.add(`TEST_CASE:${logical}:${ref.contentHash}`);
  }
  if (typeof changedRef === 'string') return identities.has(changedRef);
  const logicalRef = changedRef.kind === 'SOURCE'
    ? JSON.stringify([changedRef.project, changedRef.ref])
    : changedRef.kind === 'TEST_CASE'
      ? testCaseLogicalKey(changedRef.ref)
      : changedRef.kind === 'COMMAND'
        ? verificationCommandDefinitionKey({ project: changedRef.project, commandRef: changedRef.ref })
      : changedRef.ref;
  const exact = `${changedRef.kind}:${logicalRef}${changedRef.contentHash === undefined ? '' : `:${changedRef.contentHash}`}`;
  if (identities.has(exact)) return true;
  if (identities.has(logicalRef)) return true;
  return changedRef.contentHash === undefined &&
    [...identities].some((identity) => identity.startsWith(`${changedRef.kind}:${logicalRef}:`));
}

function normalizeScope(scope: VerificationPlanScope): VerificationPlanScope {
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(scope.profileId)) throw new Error(`PROFILE_ID_INVALID:${scope.profileId}`);
  const scopedTasks = sortUnique(scope.scopedTasks, scopedTaskKey);
  if (scopedTasks.length === 0) throw new Error('VERIFICATION_PLAN_SCOPE_EMPTY');
  return {
    scopedTasks,
    profileId: scope.profileId,
    notApplicableDecisions: sortUnique(scope.notApplicableDecisions ?? [], notApplicableKey),
  };
}

function groupTasksByProject(tasks: readonly ScopedTaskRef[]): Array<[string, ScopedTaskRef[]]> {
  const groups = new Map<string, ScopedTaskRef[]>();
  for (const task of tasks) groups.set(task.project, [...(groups.get(task.project) ?? []), task]);
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function hasNotApplicable(
  plan: Pick<VerificationPlan, 'notApplicableDecisions' | 'policyId' | 'policyHash' | 'notApplicableRules'>,
  kind: NotApplicableDecision['subjectKind'],
  ref: string,
  hash: ContentHash,
  subject: {
    readonly taskRisks?: readonly VerificationProjectInput['risk'][];
    readonly scenarioClass?: TestCase['scenarioRefs'][number]['scenarioClass'];
  },
): boolean {
  return policyAllowsNotApplicable(plan, kind, subject) && plan.notApplicableDecisions.some((decision) =>
    decision.subjectKind === kind && decision.subjectRef === ref && decision.subjectHash === hash &&
    decision.policyId === plan.policyId && decision.policyHash === plan.policyHash);
}

function policyAllowsNotApplicable(
  policy: Pick<VerificationPlan, 'notApplicableRules'> | VerificationPolicyRef,
  kind: NotApplicableDecision['subjectKind'],
  subject: {
    readonly taskRisks?: readonly VerificationProjectInput['risk'][];
    readonly scenarioClass?: TestCase['scenarioRefs'][number]['scenarioClass'];
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

function contractCaseNotApplicable(
  policy: Pick<VerificationPlan, 'policyId' | 'policyHash' | 'notApplicableRules'> | VerificationPolicyRef,
  decisions: readonly NotApplicableDecision[],
  ref: TestCaseRef,
  testCase: TestCase,
): boolean {
  const policyId = 'policyId' in policy ? policy.policyId : policy.id;
  const policyHash = 'policyHash' in policy ? policy.policyHash : policy.contentHash;
  return ref.scope.kind === 'CONTRACT' && testCase.scenarioRefs.length > 0 &&
    testCase.scenarioRefs.every((scenario) =>
      policyAllowsNotApplicable(policy, 'CONTRACT_SCENARIO', { scenarioClass: scenario.scenarioClass }) &&
      decisions.some((decision) =>
        decision.subjectKind === 'CONTRACT_SCENARIO' && decision.subjectRef === scenario.scenarioId &&
        decision.subjectHash === scenario.contentHash && decision.policyId === policyId &&
        decision.policyHash === policyHash));
}

function validateNotApplicableDecisions(
  plan: Pick<VerificationPlan,
    'projectInputs' | 'policyId' | 'policyHash' | 'notApplicableRules' | 'notApplicableDecisions'>,
  inventory: PlanInventory,
): VerificationDiagnostic[] {
  const subjects = [
    ...plan.projectInputs.map((input) => ({
      kind: 'TASK' as const,
      ref: scopedTaskKey(input),
      hash: input.taskContentHash,
      taskRisks: [input.risk],
    })),
    ...plan.projectInputs.flatMap((input) => input.sourceRefs
      .filter((ref) => /#AC-\d+$/u.test(ref.ref))
      .map((ref) => ({
        kind: 'ACCEPTANCE_CRITERION' as const,
        ref: acceptanceCriterionSubjectRef(input.project, ref.ref),
        hash: ref.contentHash,
        taskRisks: [input.risk],
      }))),
    ...inventory.testCases.flatMap((testCase) => testCase.scenarioRefs.map((scenario) => ({
      kind: 'CONTRACT_SCENARIO' as const,
      ref: scenario.scenarioId,
      hash: scenario.contentHash,
      scenarioClass: scenario.scenarioClass,
    }))),
  ];
  const diagnostics: VerificationDiagnostic[] = [];
  for (const decision of plan.notApplicableDecisions) {
    const matching = subjects.filter((subject) =>
      subject.kind === decision.subjectKind && subject.ref === decision.subjectRef && subject.hash === decision.subjectHash);
    if (matching.length === 0) {
      diagnostics.push(diagnostic(
        'NOT_APPLICABLE_SUBJECT_UNRESOLVED',
        decision.subjectRef,
        'The N/A decision does not bind an exact subject in this plan.',
      ));
      continue;
    }
    const allowed = decision.policyId === plan.policyId && decision.policyHash === plan.policyHash && matching.every((subject) =>
      policyAllowsNotApplicable(
        plan,
        decision.subjectKind,
        'taskRisks' in subject
          ? { taskRisks: subject.taskRisks }
          : { scenarioClass: subject.scenarioClass },
      ));
    if (!allowed) {
      diagnostics.push(diagnostic(
        'NOT_APPLICABLE_POLICY_DENIED',
        decision.subjectRef,
        'The frozen verification policy does not allow this subject to be N/A.',
      ));
    }
  }
  return diagnostics;
}

function requireTestCaseRef(refs: readonly TestCaseRef[], testCase: TestCase): TestCaseRef {
  const matches = refs.filter((ref) => ref.id === testCase.id && ref.contentHash === testCase.contentHash);
  if (matches.length !== 1) throw new Error(`TEST_CASE_REF_RESOLUTION_FAILED:${testCase.id}`);
  return matches[0]!;
}

function resolveProfileExecutor(
  profile: IntegrationEnvironmentProfile,
  executorRef: string,
): EnvironmentStepName | undefined {
  const matches = ENVIRONMENT_STEP_NAMES.filter((step) => {
    const definition = profile.steps[step];
    return executorRef === `environment.${step}` ||
      ('commandRef' in definition && definition.commandRef === executorRef);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function classifyProjectCompilationError(error: unknown): string {
  const message = errorMessage(error);
  if (/COMMAND_DEFINITION_AMBIGUOUS/u.test(message)) return 'COMMAND_DEFINITION_AMBIGUOUS';
  if (/REQUIRED_COVERAGE_MISSING/u.test(message)) return 'REQUIRED_COVERAGE_MISSING';
  if (/COMMAND_CASE_MAPPING_MISSING/u.test(message)) return 'COMMAND_CASE_MAPPING_MISSING';
  return 'PROJECT_TEST_CASE_PREPARATION_FAILED';
}

function contractDiagnosticCode(error: unknown): string {
  const key = contractNotReadyKey(error);
  return key === undefined ? 'CONTRACT_SNAPSHOT_UNRESOLVED' : `CONTRACT_NOT_READY:${key}`;
}

function contractNotReadyKey(error: unknown): string | undefined {
  return /CONTRACT_NOT_READY:([^:\s]+)/u.exec(errorMessage(error))?.[1];
}

function diagnostic(code: string, subjectRef: string, message: string): VerificationDiagnostic {
  return { code, subjectRef, message };
}

function diagnosticKey(item: VerificationDiagnostic): string {
  return JSON.stringify([item.code, item.subjectRef, item.message]);
}

function projectInputKey(input: Pick<VerificationProjectInput, 'project' | 'changeId' | 'revision' | 'baseline' | 'taskId'>): string {
  return JSON.stringify([input.project, input.changeId, input.revision, input.baseline, input.taskId]);
}

function scopedTaskKey(task: Pick<ScopedTaskRef, 'project' | 'changeId' | 'revision' | 'baseline' | 'taskId'>): string {
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

function contractSnapshotBindingKey(binding: {
  readonly contractKey: string;
  readonly scopeHash: string;
  readonly snapshot: { readonly id: string; readonly contentHash: string };
}): string {
  return JSON.stringify([
    binding.contractKey,
    binding.scopeHash,
    binding.snapshot.id,
    binding.snapshot.contentHash,
  ]);
}

function contractScenarioBindingKey(ref: {
  readonly contractKey: string;
  readonly scopeHash: string;
  readonly snapshot: { readonly id: string; readonly contentHash: string };
}): string {
  return contractSnapshotBindingKey(ref);
}

function testCaseLogicalKey(ref: Pick<TestCaseRef, 'id' | 'scope'>): string {
  return JSON.stringify([
    ref.scope.kind,
    ref.scope.kind === 'PROJECT'
      ? [ref.scope.project, ref.scope.changeId, ref.scope.revision]
      : [
          ref.scope.worksetId,
          ref.scope.contractKey,
          ref.scope.scopeHash,
          ref.scope.contractSnapshot.id,
          ref.scope.contractSnapshot.contentHash,
          ref.scope.scenarioId,
        ],
    ref.id,
  ]);
}

function contractScenarioKey(ref: {
  contractKey: string;
  scopeHash: string;
  snapshot: { id: string; contentHash: string };
  scenarioId: string;
  contentHash: string;
}): string {
  return JSON.stringify([
    ref.contractKey,
    ref.scopeHash,
    ref.snapshot.id,
    ref.snapshot.contentHash,
    ref.scenarioId,
    ref.contentHash,
  ]);
}

function notApplicableKey(item: NotApplicableDecision): string {
  return JSON.stringify([item.subjectKind, item.subjectRef, item.subjectHash, item.policyId, item.policyHash, item.reasonHash]);
}

function testCaseIdentity(testCase: TestCase): string {
  return `${testCase.id}\0${testCase.contentHash}`;
}

function sortUnique<T>(items: readonly T[], key: (item: T) => string): T[] {
  const byKey = new Map(items.map((item) => [key(item), item]));
  return [...byKey.entries()].sort(([left], [right]) => compare(left, right)).map(([, item]) => item);
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  return sortUnique(items, key);
}

function now(context: VerificationPlannerContext): string {
  return (context.now ?? (() => new Date().toISOString()))();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
