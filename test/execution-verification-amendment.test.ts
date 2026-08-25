import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { LocalExecutionBackend } from '../src/execution/backend.js';
import { readJsonLines } from '../src/core/files.js';
import {
  createProductionAggregateRegistry,
  type ExecutionAggregateType,
  type ExecutionMaterializedState,
} from '../src/execution/aggregate-registry.js';
import { FileEventStore } from '../src/execution/event-store.js';
import { hashObject } from '../src/execution/hashing.js';
import { nextExecutionId } from '../src/execution/ids.js';
import { createDefaultVerificationPolicy } from '../src/execution/verification/test-cases.js';
import {
  commitSetMachine,
  environmentRunMachine,
  transitionLifecycle,
} from '../src/execution/machines.js';
import {
  ensureExecutionLayout,
  executionRoot,
  integrationEnvironmentEventsPath,
  integrationEnvironmentEvidenceRoot,
  integrationEnvironmentInputPath,
  integrationEnvironmentProfilePath,
  integrationEnvironmentStatePath,
  verificationPlanPath,
} from '../src/execution/paths.js';
import {
  contractTestCaseRef,
  commitSetSchema,
  hashIntegrationEnvironmentInput,
  hashVerificationPlan,
  integrationEnvironmentInputSchema,
  integrationEnvironmentProfileSchema,
  integrationEnvironmentRunSchema,
  projectTestCaseRef,
  testCaseRefKey,
  testCaseSchema,
  verificationPlanSchema,
  type IntegrationEnvironmentRun,
  type VerificationPlan,
} from '../src/execution/types.js';
import { createTestDirectory } from './helpers.js';

const NOW = '2026-08-16T00:00:00.000Z';
const HASH_A = hashObject('a');
const HASH_B = hashObject('b');
const HASH_C = hashObject('c');
const HASH_D = hashObject('d');

function projectCaseRef(project: string, id = 'TC-0010', contentHash = HASH_A) {
  return projectTestCaseRef({
    project,
    changeId: 'CHG-0001',
    revision: 'REV-0001',
  }, id, contentHash);
}

function contractCaseRef(worksetId = 'WKS-0001', contractKey = 'authorization-v2') {
  return contractTestCaseRef(
    worksetId,
    contractKey,
    HASH_A,
    { id: 'CTR-0001', contentHash: HASH_B },
    'SC-007',
    'TC-0042',
    HASH_C,
  );
}

function verificationPlanFixture() {
  const quote = projectCaseRef('quote-center', 'TC-0010', HASH_A);
  const order = projectCaseRef('quote-center', 'TC-0011', HASH_B);
  const contract = contractCaseRef();
  const policy = createDefaultVerificationPolicy();
  const withoutHash = {
    schemaVersion: 1 as const,
    machineVersion: 1 as const,
    id: 'VPL-0001',
    worksetId: 'WKS-0001',
    status: 'READY' as const,
    scopeHash: HASH_A,
    contractSnapshots: [{ contractKey: 'authorization-v2', scopeHash: HASH_A, snapshot: { id: 'CTR-0001', contentHash: HASH_B } }],
    applicableContractKeys: ['authorization-v2'],
    testCases: [contract, quote, order].sort((left, right) => testCaseRefKey(left).localeCompare(testCaseRefKey(right))),
    projectInputs: [{
      project: 'quote-center', changeId: 'CHG-0001', revision: 'REV-0001', baseline: 'BL-0001',
      taskId: 'TASK-001', taskContentHash: HASH_A, risk: 'MEDIUM' as const,
      sourceRefs: [{ ref: '.omnai/changes/CHG-0001-quote/spec.md#AC-001', contentHash: HASH_B }],
    }],
    profileRefs: [{ id: 'authorization-local', contentHash: HASH_C }],
    projectChecks: [{
      project: 'quote-center',
      scopedTasks: [{ project: 'quote-center', changeId: 'CHG-0001', revision: 'REV-0001', baseline: 'BL-0001', taskId: 'TASK-001' }],
      caseRefs: [quote, order],
      commandRefs: ['quote:component', 'quote:unit'],
    }],
    commandDefinitions: [{
      commandRef: 'quote:component', project: 'quote-center', executable: 'npm', argv: ['test'], cwd: '.',
      network: 'DENY' as const, timeoutMs: 60_000, outputLimit: 1_048_576, caseRefs: [quote, order],
    }],
    integrationGates: [{
      id: 'IG-0001', required: true, profile: { id: 'authorization-local', contentHash: HASH_C },
      caseRefs: [contract],
    }],
    policyId: policy.id,
    policyVersion: policy.version,
    policyHash: policy.contentHash,
    taskRiskRules: policy.taskRiskRules,
    scenarioClassRules: policy.scenarioClassRules,
    notApplicableRules: policy.notApplicableRules,
    notApplicableDecisions: [],
    validation: [],
    createdAt: NOW,
    updatedAt: NOW,
    lastEventSequence: 0,
    lastEventHash: null,
  };
  return { ...withoutHash, contentHash: hashVerificationPlan(withoutHash) };
}

function verificationPlanIdentity(plan: VerificationPlan) {
  return {
    schemaVersion: plan.schemaVersion,
    worksetId: plan.worksetId,
    scopeHash: plan.scopeHash,
    contractSnapshots: plan.contractSnapshots,
    applicableContractKeys: plan.applicableContractKeys,
    testCases: plan.testCases,
    projectInputs: plan.projectInputs,
    profileRefs: plan.profileRefs,
    projectChecks: plan.projectChecks,
    commandDefinitions: plan.commandDefinitions,
    integrationGates: plan.integrationGates,
    policyId: plan.policyId,
    policyVersion: plan.policyVersion,
    policyHash: plan.policyHash,
    taskRiskRules: plan.taskRiskRules,
    scenarioClassRules: plan.scenarioClassRules,
    notApplicableRules: plan.notApplicableRules,
    notApplicableDecisions: plan.notApplicableDecisions,
  };
}

function environmentProfile(overrides: Record<string, unknown> = {}) {
  const referencedStep = (name: string) => ({
    commandRef: `environment:${name}`,
    timeoutMs: 60_000,
  });
  const withoutHash = {
    schemaVersion: 2,
    id: 'authorization-local',
    driver: 'compose',
    requiredProjects: ['order-center', 'quote-center'],
    definitionRef: 'compose.yaml',
    definitionContentHash: HASH_B,
    isolation: { mode: 'per-run', maxParallel: 2, requireExclusiveLease: false },
    ports: { mode: 'dynamic', range: [20_000, 29_999] },
    sourceRefs: [{ ref: 'compose.yaml', contentHash: HASH_B }],
    envRefs: { DB_PASSWORD: 'OMNAI_TEST_DB_PASSWORD' },
    sandbox: {
      driver: 'container',
      requiredProofs: ['CREDENTIALS', 'FILESYSTEM', 'NETWORK', 'PROCESS_TREE', 'RESOURCE_LIMITS'],
    },
    steps: {
      setup: referencedStep('setup'),
      build: referencedStep('build'),
      start: referencedStep('start'),
      health: referencedStep('health'),
      seed: referencedStep('seed'),
      test: {
        executable: 'node',
        argv: ['test/e2e.mjs'],
        cwd: '.',
        timeoutMs: 60_000,
        outputLimit: 65_536,
        network: 'ALLOW',
        requiredArtifacts: ['test/e2e.mjs'],
      },
      collect: referencedStep('collect'),
      teardown: referencedStep('teardown'),
    },
    ...overrides,
  };
  return { ...withoutHash, contentHash: hashObject(withoutHash) };
}

function integrationEnvironmentInputFixture() {
  const withoutHash = {
    schemaVersion: 1 as const,
    verificationPlan: { id: 'VPL-0001', contentHash: HASH_A },
    contractSnapshots: [{ contractKey: 'authorization-v2', scopeHash: HASH_B, snapshot: { id: 'CTR-0001', contentHash: HASH_C } }],
    commitSet: { id: 'CST-0001', scopeHash: HASH_D },
    projects: [{
      project: 'quote-center',
      commit: 'a'.repeat(40),
      commitTree: 'b'.repeat(40),
      verifiedTree: 'c'.repeat(40),
      metadataDeltaHash: HASH_A,
    }],
    profile: { id: 'authorization-local', contentHash: HASH_B },
    testCaseRefs: [contractCaseRef()],
    commandDefinitionsHash: HASH_C,
    definitionDigest: HASH_D,
    executorDigests: [{ ref: 'test/e2e.mjs', digest: HASH_A }],
    supportingArtifactDigests: [{ ref: 'postgres', digest: HASH_B }],
    externalDeploymentDigests: [{ ref: 'policy-simulator', digest: HASH_C }],
    environmentReferenceNames: ['OMNAI_TEST_DB_PASSWORD'],
    policyVersion: 1,
  };
  return { ...withoutHash, inputHash: hashIntegrationEnvironmentInput(withoutHash) };
}

test('TestCase owns sorted scoped task coverage and rejects empty or duplicate coverage', () => {
  const withoutHash = {
    schemaVersion: 1,
    id: 'TC-0010',
    level: 'UNIT',
    title: 'rejects revoked credentials',
    required: true,
    sourceRefs: [{ ref: 'intent.md#revoked', contentHash: HASH_A }],
    scopedTasks: [
      { project: 'quote-center', changeId: 'CHG-0001', revision: 'REV-0001', baseline: 'BL-0001', taskId: 'TASK-001' },
      { project: 'user-center', changeId: 'CHG-0001', revision: 'REV-0001', baseline: 'BL-0001', taskId: 'TASK-002' },
    ],
    acceptanceCriteriaRefs: [{ ref: 'spec.md#AC-001', contentHash: HASH_B }],
    contractRefs: [],
    scenarioRefs: [],
    commandRefs: ['quote:unit'],
    ownerProjects: ['quote-center'],
    testPaths: ['test/auth.test.ts'],
    evidenceRequired: ['exit-code', 'output-hash'],
    expectedOutcome: 'request is rejected without a quote side effect',
  } as const;
  const base = { ...withoutHash, contentHash: hashObject(withoutHash) } as const;
  assert.equal(testCaseSchema.parse(base).scopedTasks.length, 2);
  assert.throws(() => testCaseSchema.parse({ ...base, scopedTasks: [] }), /scopedTasks/);
  assert.throws(() => testCaseSchema.parse({ ...base, scopedTasks: [base.scopedTasks[0], base.scopedTasks[0]] }), /SORTED_UNIQUE/);
  assert.throws(() => testCaseSchema.parse({ ...base, scopedTasks: [...base.scopedTasks].reverse() }), /SORTED_UNIQUE/);
  assert.throws(() => testCaseSchema.parse({ ...base, title: 'silently changed title' }), /CONTENT_HASH_MISMATCH/);
});

test('VerificationPlan freezes sorted case, command, contract, task, and profile refs', () => {
  const plan = verificationPlanSchema.parse(verificationPlanFixture());
  assert.equal(plan.status, 'READY');
  assert.equal(plan.contentHash, hashObject(verificationPlanIdentity(plan)));
  assert.equal(plan.contentHash, hashVerificationPlan(plan));
  assert.deepEqual(plan.projectChecks[0]?.caseRefs.map((item) => item.id), ['TC-0010', 'TC-0011']);
  assert.throws(() => verificationPlanSchema.parse({
    ...plan,
    projectChecks: [{ ...plan.projectChecks[0]!, caseRefs: [...plan.projectChecks[0]!.caseRefs].reverse() }],
  }), /SORTED_UNIQUE/);
  assert.throws(() => verificationPlanSchema.parse({
    ...plan,
    projectChecks: [{ ...plan.projectChecks[0]!, commandRefs: ['quote:e2e', 'quote:unit'] }],
  }), /CONTENT_HASH_MISMATCH/);
  assert.throws(() => verificationPlanSchema.parse({ ...plan, policyHash: HASH_D }), /VERIFICATION_POLICY_HASH_MISMATCH/);
});

test('same display TestCase ID in different project scopes remains unambiguous', () => {
  const quote = projectCaseRef('quote-center');
  const order = projectCaseRef('order-center');
  assert.notEqual(testCaseRefKey(quote), testCaseRefKey(order));
  const plan = verificationPlanFixture();
  assert.throws(() => verificationPlanSchema.parse({
    ...plan,
    projectChecks: [{ ...plan.projectChecks[0], caseRefs: ['TC-0010'] }],
  }), /TEST_CASE_REF_SCOPE_REQUIRED|caseRefs/);
});

test('same contract TestCase display ID across Worksets and contract scopes remains unambiguous', () => {
  const first = contractCaseRef('WKS-0001', 'authorization-v2');
  const second = contractCaseRef('WKS-0002', 'pricing-v3');
  assert.notEqual(testCaseRefKey(first), testCaseRefKey(second));
  assert.equal(first.scope.kind, 'CONTRACT');
  if (first.scope.kind !== 'CONTRACT') assert.fail('expected CONTRACT scope');
  assert.equal(first.scope.contractSnapshot.contentHash, HASH_B);
});

test('environment profile accepts only compose, commands, or external and stores secret names only', () => {
  assert.equal(integrationEnvironmentProfileSchema.parse(environmentProfile()).driver, 'compose');
  assert.equal(integrationEnvironmentProfileSchema.parse(environmentProfile({ driver: 'commands' })).driver, 'commands');
  assert.equal(integrationEnvironmentProfileSchema.parse(environmentProfile({ driver: 'external' })).driver, 'external');
  assert.throws(() => integrationEnvironmentProfileSchema.parse(environmentProfile({ driver: 'kubernetes' })), /compose|commands|external/);
  assert.throws(() => integrationEnvironmentProfileSchema.parse(environmentProfile({ envRefs: { DB_PASSWORD: 'literal-secret-value' } })), /SECRET_REFERENCE_NAME/);
  assert.throws(() => integrationEnvironmentProfileSchema.parse(environmentProfile({ steps: { setup: { command: 'sh -c dangerous' } } })), /commandRef|executable|argv|unrecognized/i);
  const parsed = integrationEnvironmentProfileSchema.parse(environmentProfile());
  assert.throws(() => integrationEnvironmentProfileSchema.parse({ ...parsed, driver: 'commands' }), /CONTENT_HASH_MISMATCH/);
});

test('environment input hash changes for every authoritative identity field', () => {
  const base = integrationEnvironmentInputSchema.parse(integrationEnvironmentInputFixture());
  const mutations = [
    { ...base, verificationPlan: { ...base.verificationPlan, contentHash: HASH_D } },
    { ...base, contractSnapshots: [{ ...base.contractSnapshots[0]!, scopeHash: HASH_D }] },
    { ...base, commitSet: { ...base.commitSet, scopeHash: HASH_A } },
    { ...base, projects: [{ ...base.projects[0]!, commit: 'd'.repeat(40) }] },
    { ...base, projects: [{ ...base.projects[0]!, commitTree: 'd'.repeat(40) }] },
    { ...base, projects: [{ ...base.projects[0]!, verifiedTree: 'd'.repeat(40) }] },
    { ...base, projects: [{ ...base.projects[0]!, metadataDeltaHash: HASH_D }] },
    { ...base, profile: { ...base.profile, contentHash: HASH_D } },
    { ...base, testCaseRefs: [{ ...base.testCaseRefs[0]!, contentHash: HASH_D }] },
    { ...base, commandDefinitionsHash: HASH_D },
    { ...base, definitionDigest: HASH_A },
    { ...base, executorDigests: [{ ref: 'test/e2e.mjs', digest: HASH_D }] },
    { ...base, supportingArtifactDigests: [{ ref: 'postgres', digest: HASH_D }] },
    { ...base, externalDeploymentDigests: [{ ref: 'policy-simulator', digest: HASH_D }] },
    { ...base, environmentReferenceNames: ['OMNAI_OTHER_SECRET'] },
    { ...base, policyVersion: 2 },
  ];
  for (const changed of mutations) {
    assert.notEqual(hashIntegrationEnvironmentInput(changed), hashIntegrationEnvironmentInput(base));
  }
});

test('environment Run separates primary and cleanup outcomes', () => {
  const input = integrationEnvironmentInputSchema.parse(integrationEnvironmentInputFixture());
  const base = {
    schemaVersion: 1,
    machineVersion: 1,
    id: 'IER-0001',
    worksetId: 'WKS-0001',
    status: 'CLEANUP_REQUIRED',
    inputHash: input.inputHash,
    attempt: 1,
    ownedResourceRefs: ['compose-project:omnai-ier-0001'],
    reservedPorts: [43123],
    caseResults: [{ caseRef: contractCaseRef(), status: 'FAIL', evidenceRefs: ['EVD-0001'] }],
    evidenceRefs: ['EVD-0001'],
    primaryOutcome: 'TEST_FAILED',
    cleanupOutcome: 'FAILED',
    cleanupAttempts: 1,
    createdAt: NOW,
    updatedAt: NOW,
    lastEventSequence: 0,
    lastEventHash: null,
  } as const;
  const parsed = integrationEnvironmentRunSchema.parse(base);
  assert.equal(parsed.primaryOutcome, 'TEST_FAILED');
  assert.equal(parsed.cleanupOutcome, 'FAILED');
  assert.throws(() => integrationEnvironmentRunSchema.parse({ ...base, primaryOutcome: undefined }), /primaryOutcome/);
});

test('CommitSet cannot transition directly from PARTIAL to COMPLETE', () => {
  assert.equal(transitionLifecycle(commitSetMachine, 'OPEN', { type: 'RECORD_MEMBER' }), 'PARTIAL');
  assert.throws(() => transitionLifecycle(commitSetMachine, 'OPEN', { type: 'VERIFY' }), /ILLEGAL/);
  assert.equal(transitionLifecycle(commitSetMachine, 'PARTIAL', { type: 'VERIFY' }), 'VERIFYING');
  assert.throws(() => transitionLifecycle(commitSetMachine, 'PARTIAL', { type: 'COMPLETE' }), /ILLEGAL/);
  assert.throws(() => transitionLifecycle(commitSetMachine, 'VERIFYING', { type: 'PASS' }), /ILLEGAL/);
  assert.equal(transitionLifecycle(commitSetMachine, 'VERIFYING', { type: 'COMPLETE_WITH_PROOF' }), 'COMPLETE');
  assert.equal(transitionLifecycle(commitSetMachine, 'COMPLETE', { type: 'INVALIDATE' }), 'NEEDS_REVALIDATION');
  assert.equal(transitionLifecycle(commitSetMachine, 'NEEDS_REVALIDATION', { type: 'VERIFY' }), 'VERIFYING');
});

test('environment lifecycle always collects and tears down before a terminal result', () => {
  assert.equal(transitionLifecycle(environmentRunMachine, 'PLANNED', { type: 'SETUP' }), 'SETTING_UP');
  assert.equal(transitionLifecycle(environmentRunMachine, 'SETTING_UP', { type: 'BUILT' }), 'BUILDING');
  assert.equal(transitionLifecycle(environmentRunMachine, 'TESTING', { type: 'TEST_FAILED' }), 'COLLECTING');
  assert.equal(transitionLifecycle(environmentRunMachine, 'COLLECTING', { type: 'COLLECTED' }), 'TEARING_DOWN');
  assert.equal(transitionLifecycle(environmentRunMachine, 'TEARING_DOWN', { type: 'CLEANUP_FAILED' }), 'CLEANUP_REQUIRED');
  assert.equal(transitionLifecycle(environmentRunMachine, 'CLEANUP_REQUIRED', { type: 'RETRY_CLEANUP' }), 'TEARING_DOWN');
  assert.equal(transitionLifecycle(environmentRunMachine, 'SAFETY_UNPROVEN', { type: 'OWNERSHIP_PROVEN' }), 'TEARING_DOWN');
  assert.throws(() => transitionLifecycle(environmentRunMachine, 'TESTING', { type: 'PASS' }), /ILLEGAL/);
});

test('verification and environment paths and IDs are Workset-local', async () => {
  const fixture = await createTestDirectory('omnai-verification-paths-');
  try {
    const root = await ensureExecutionLayout(fixture.root, 'WKS-0001');
    assert.equal(verificationPlanPath(fixture.root, 'WKS-0001', 'VPL-0001'), join(root, 'verification-plans', 'VPL-0001', 'plan.yaml'));
    assert.equal(
      integrationEnvironmentProfilePath(fixture.root, 'WKS-0001', 'authorization-local', HASH_A),
      join(root, 'integration-environments', 'profiles', `authorization-local-${HASH_A.replace(':', '-')}.yaml`),
    );
    assert.equal(integrationEnvironmentInputPath(fixture.root, 'WKS-0001', 'IER-0001'), join(root, 'integration-environments', 'runs', 'IER-0001', 'input.yaml'));
    assert.equal(integrationEnvironmentStatePath(fixture.root, 'WKS-0001', 'IER-0001'), join(root, 'integration-environments', 'runs', 'IER-0001', 'state.yaml'));
    assert.equal(integrationEnvironmentEventsPath(fixture.root, 'WKS-0001', 'IER-0001'), join(root, 'integration-environments', 'runs', 'IER-0001', 'events.jsonl'));
    assert.equal(integrationEnvironmentEvidenceRoot(fixture.root, 'WKS-0001', 'IER-0001'), join(root, 'integration-environments', 'runs', 'IER-0001', 'evidence'));
    assert.equal(await nextExecutionId(fixture.root, 'WKS-0001', 'verification-plan'), 'VPL-0001');
    assert.equal(await nextExecutionId(fixture.root, 'WKS-0001', 'environment-run'), 'IER-0001');
    await mkdir(join(executionRoot(fixture.root, 'WKS-0001'), 'verification-plans'), { recursive: true });
  } finally {
    await fixture.cleanup();
  }
});

test('production aggregate versions are explicit and only CommitSet advances to v2', () => {
  const registry = createProductionAggregateRegistry();
  assert.deepEqual(
    (['contract', 'wave', 'run', 'claim', 'attention'] as const).map((aggregateType) =>
      registry.currentVersion(aggregateType)),
    [1, 1, 1, 1, 1],
  );
  assert.equal(registry.currentVersion('commitset'), 2);
  assert.equal(registry.currentVersion('verification-plan'), 1);
  assert.equal(registry.currentVersion('environment-run'), 1);
  assert.equal(registry.findMigration('contract', 1, 2), null);
  assert.notEqual(registry.findMigration('commitset', 1, 2), null);
});

test('existing non-CommitSet aggregate histories stay at v1 without migration events', async () => {
  const fixture = await createTestDirectory('omnai-v1-aggregate-histories-');
  try {
    const registry = createProductionAggregateRegistry();
    const store = new FileEventStore(registry);
    const states: ReadonlyArray<{ aggregateType: ExecutionAggregateType; aggregateId: string; value: unknown }> = [
      {
        aggregateType: 'contract',
        aggregateId: 'CTR-0001',
        value: {
          schemaVersion: 1, machineVersion: 1, lastEventSequence: 0, lastEventHash: null,
          id: 'CTR-0001', worksetId: 'WKS-0001', status: 'GENERATING', contractKey: 'authorization-v2',
          scopeHash: HASH_A, contentHash: HASH_B, previousSnapshot: null,
          participants: [
            { project: 'api', changeId: 'CHG-0001', revision: 'REV-0001', baseline: 'BL-0001', taskId: 'TASK-001', role: 'PROVIDER' },
            { project: 'client', changeId: 'CHG-0001', revision: 'REV-0001', baseline: 'BL-0001', taskId: 'TASK-002', role: 'CONSUMER' },
          ],
          sources: [{ kind: 'intent', project: 'api', ref: 'intent.md', contentHash: HASH_A }],
          businessScenarios: [], validationEvidence: [], createdByRun: 'RUN-0001', createdAt: NOW, updatedAt: NOW,
        },
      },
      {
        aggregateType: 'wave',
        aggregateId: 'WAVE-0001',
        value: {
          schemaVersion: 1, machineVersion: 1, lastEventSequence: 0, lastEventHash: null,
          id: 'WAVE-0001', worksetId: 'WKS-0001', status: 'PLANNED', inputHash: HASH_A,
          members: [], deferred: [], createdAt: NOW, updatedAt: NOW,
        },
      },
      {
        aggregateType: 'run',
        aggregateId: 'RUN-0001',
        value: {
          schemaVersion: 1, machineVersion: 1, lastEventSequence: 0, lastEventHash: null,
          id: 'RUN-0001', kind: 'PROJECT_TEST_PLANNER', worksetId: 'WKS-0001', status: 'PREPARED',
          packetHash: HASH_A, evidenceRefs: [], createdAt: NOW, updatedAt: NOW,
        },
      },
      {
        aggregateType: 'claim',
        aggregateId: 'quote-center',
        value: {
          schemaVersion: 1, machineVersion: 1, lastEventSequence: 0, lastEventHash: null,
          project: 'quote-center', runId: 'RUN-0001', runKind: 'PROJECT_WRITER', phase: 'WRITING',
          worktree: '/tmp/quote-center', branch: 'omnai/WKS-0001-auth', ownerProcess: 42,
          agentProtocol: 'acp', agentId: 'codex', acquiredAt: NOW, heartbeatAt: NOW,
        },
      },
      {
        aggregateType: 'attention',
        aggregateId: 'ATTN-0001',
        value: {
          schemaVersion: 1, machineVersion: 1, lastEventSequence: 0, lastEventHash: null,
          id: 'ATTN-0001', kind: 'NEEDS_DECISION', scope: { worksetId: 'WKS-0001' },
          question: 'Choose one policy', options: [], evidenceRefs: [], blockingProjects: [], createdByRuns: [],
          status: 'OPEN', fingerprint: HASH_A, createdAt: NOW,
        },
      },
    ];
    for (const item of states) {
      const initialState = registry.parse<ExecutionMaterializedState>(item.aggregateType, 1, item.value);
      const eventsPath = join(fixture.root, `${item.aggregateType}.events.jsonl`);
      const loaded = await store.loadAndRepair({
        home: fixture.root,
        worksetId: 'WKS-0001',
        aggregateType: item.aggregateType,
        aggregateId: item.aggregateId,
        eventsPath,
        statePath: join(fixture.root, `${item.aggregateType}.state.yaml`),
        initialState,
        now: () => NOW,
      });
      assert.equal(loaded.machineVersion, 1);
      assert.deepEqual(await readJsonLines(eventsPath), []);
    }
  } finally {
    await fixture.cleanup();
  }
});

test('registered environment reducer preserves the primary result through cleanup failure and retry', () => {
  const registry = createProductionAggregateRegistry();
  let state: IntegrationEnvironmentRun = integrationEnvironmentRunSchema.parse({
    schemaVersion: 1,
    machineVersion: 1,
    id: 'IER-0001',
    worksetId: 'WKS-0001',
    status: 'TESTING',
    inputHash: HASH_A,
    attempt: 1,
    ownedResourceRefs: ['compose-project:omnai-ier-0001'],
    reservedPorts: [],
    caseResults: [],
    evidenceRefs: [],
    cleanupOutcome: 'NOT_ATTEMPTED',
    cleanupAttempts: 0,
    createdAt: NOW,
    updatedAt: NOW,
    lastEventSequence: 0,
    lastEventHash: null,
  });
  const reduce = (type: string): void => {
    state = registry.reduce('environment-run', 1, state, { type }, { mode: 'transition', timestamp: NOW });
  };
  reduce('TEST_FAILED');
  assert.equal(state.status, 'COLLECTING');
  assert.equal(state.primaryOutcome, 'TEST_FAILED');
  reduce('COLLECTED');
  reduce('CLEANUP_FAILED');
  assert.equal(state.status, 'CLEANUP_REQUIRED');
  assert.equal(state.primaryOutcome, 'TEST_FAILED');
  assert.equal(state.cleanupOutcome, 'FAILED');
  assert.equal(state.cleanupAttempts, 1);
  reduce('RETRY_CLEANUP');
  assert.equal(state.status, 'TEARING_DOWN');
  assert.equal(state.primaryOutcome, 'TEST_FAILED');
});

test('legacy completion migrates deterministically to NEEDS_REVALIDATION without fabricated proof', async () => {
  const fixture = await createTestDirectory('omnai-commitset-migration-');
  try {
    const eventsPath = join(fixture.root, 'events.jsonl');
    const statePath = join(fixture.root, 'state.yaml');
    const initialState = {
      schemaVersion: 1,
      machineVersion: 1,
      id: 'CST-0001',
      worksetId: 'WKS-0001',
      status: 'COMPLETE',
      scopeHash: HASH_A,
      contractSnapshots: [{ id: 'CTR-0001', contentHash: HASH_B }],
      members: [{
        project: 'quote-center',
        changeId: 'CHG-0001',
        revision: 'REV-0001',
        baseline: 'BL-0001',
        taskId: 'TASK-001',
        runId: 'RUN-0001',
        contracts: [{ id: 'CTR-0001', contentHash: HASH_B }],
        status: 'INTEGRATED',
        reviewRunId: 'RUN-0002',
        commit: 'a'.repeat(40),
        evidenceRefs: ['EVD-0001'],
      }],
      createdAt: NOW,
      updatedAt: NOW,
      lastEventSequence: 0,
      lastEventHash: null,
    } as const;
    const store = new FileEventStore(createProductionAggregateRegistry());
    const migrated = await store.loadAndRepair({
      home: fixture.root,
      worksetId: 'WKS-0001',
      aggregateType: 'commitset',
      aggregateId: 'CST-0001',
      eventsPath,
      statePath,
      initialState,
      now: () => NOW,
    });
    assert.equal(migrated.machineVersion, 2);
    assert.equal(migrated.status, 'NEEDS_REVALIDATION');
    assert.deepEqual((migrated as { integrationGateRefs?: unknown[] }).integrationGateRefs, []);
    assert.equal((migrated as { completionProofHash?: string }).completionProofHash, undefined);
    const events = await readJsonLines<{ type: string; machineVersion: number }>(eventsPath);
    assert.equal(events.at(-1)?.type, 'MACHINE_MIGRATED');
    assert.equal(events.at(-1)?.machineVersion, 2);
    await store.loadAndRepair({
      home: fixture.root,
      worksetId: 'WKS-0001',
      aggregateType: 'commitset',
      aggregateId: 'CST-0001',
      eventsPath,
      statePath,
      initialState,
      now: () => NOW,
    });
    assert.equal((await readJsonLines(eventsPath)).length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test('raw backend transition cannot bypass CommitSet completion authority', async () => {
  const fixture = await createTestDirectory('omnai-commitset-authority-');
  try {
    const initialState = {
      schemaVersion: 1,
      machineVersion: 2,
      id: 'CST-0001',
      worksetId: 'WKS-0001',
      status: 'VERIFYING',
      scopeHash: HASH_A,
      contractSnapshots: [],
      members: [{
        project: 'quote-center',
        changeId: 'CHG-0001',
        revision: 'REV-0001',
        baseline: 'BL-0001',
        taskId: 'TASK-001',
        runId: 'RUN-0001',
        contracts: [],
        status: 'INTEGRATED',
        reviewRunId: 'RUN-0002',
        commit: 'a'.repeat(40),
        commitTree: 'b'.repeat(40),
        verifiedTree: 'c'.repeat(40),
        metadataDeltaHash: HASH_B,
        evidenceRefs: ['EVD-0001'],
      }],
      integrationGateRefs: [{ id: 'IER-0001', inputHash: HASH_C }],
      createdAt: NOW,
      updatedAt: NOW,
      lastEventSequence: 0,
      lastEventHash: null,
    } as const;
    const { commitTree: _commitTree, ...memberWithoutCommitTree } = initialState.members[0];
    assert.throws(() => commitSetSchema.parse({
      ...initialState,
      members: [memberWithoutCommitTree],
    }), /commitTree/);
    const backend = new LocalExecutionBackend(new FileEventStore(createProductionAggregateRegistry()));
    for (const type of ['COMPLETE', 'COMPLETE_WITH_PROOF']) {
      await assert.rejects(() => backend.transition({
        home: fixture.root,
        worksetId: 'WKS-0001',
        aggregateType: 'commitset',
        aggregateId: 'CST-0001',
        eventsPath: join(fixture.root, 'events.jsonl'),
        statePath: join(fixture.root, 'state.yaml'),
        initialState,
        now: () => NOW,
        event: { type, payload: { completionProofHash: HASH_D } },
      }), /COMMITSET_COMPLETION_AUTHORITY_REQUIRED/);
    }
    assert.equal((await readJsonLines(join(fixture.root, 'events.jsonl'))).length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('runBounded returns every fulfilled or rejected callback result in input order', async () => {
  const backend = new LocalExecutionBackend();
  const results = await backend.runBounded([1, 2, 3], 3, async (value) => {
    if (value === 2) throw Object.assign(new Error('writer failed'), { code: 'WRITER_FAILED', secret: 'do-not-persist' });
    return value * 10;
  });
  assert.deepEqual(results.map((item) => item.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.deepEqual(results.filter((item) => item.status === 'fulfilled').map((item) => item.value), [10, 30]);
  assert.deepEqual(results[1], {
    status: 'rejected',
    reason: { name: 'Error', message: 'writer failed', code: 'WRITER_FAILED' },
  });
});
