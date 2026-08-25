import assert from 'node:assert/strict';
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  contractCandidateSchema,
  contractResolutionSchema,
  parseArtifactForPacket,
  projectFindingSchema,
  projectTestPlanCandidateSchema,
  reviewFindingSchema,
  validateContractResolutionAgainstFindings,
  verificationEvidenceSchema,
  workerResultSchema,
} from '../src/execution/artifacts.js';
import { hashObject } from '../src/execution/hashing.js';
import {
  createRunPacket,
  loadRunPacket,
  persistRunPacket,
  renderRunPrompt,
  type RunPacketInput,
} from '../src/execution/packets.js';
import {
  evaluatePermission,
  redactSecrets,
  resolveSecretEnvironment,
} from '../src/execution/agents/policy.js';
import {
  hashIntegrationEnvironmentInput,
  projectTestCaseRef,
  type ContentHash,
} from '../src/execution/types.js';
import { createTestDirectory } from './helpers.js';

const NOW = '2026-08-16T00:00:00.000Z';
const HASH_A = hashObject('a');
const HASH_B = hashObject('b');
const HASH_C = hashObject('c');
const HASH_D = hashObject('d');

type WriterPacketInput = Extract<RunPacketInput, { kind: 'PROJECT_WRITER' }>;
type PlannerPacketInput = Extract<RunPacketInput, { kind: 'PROJECT_TEST_PLANNER' }>;

function projectCase(id = 'TC-0010', contentHash: ContentHash = HASH_A) {
  return projectTestCaseRef({
    project: 'quote-center',
    changeId: 'CHG-0001',
    revision: 'REV-0001',
  }, id, contentHash);
}

function writerPacketInput(overrides: Partial<WriterPacketInput> = {}): WriterPacketInput {
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
    git: { startingHead: 'a'.repeat(40), worktree: '/tmp/quote', branch: 'omnai/WKS-0001-quote' },
    contracts: [{ id: 'CTR-0001', contentHash: HASH_B }],
    objective: 'Implement authorization v2',
    protocolIds: ['execution.project-writer'],
    allowedPaths: ['src/**', 'test/**'],
    verificationCommands: ['npm test'],
    verificationPlan: { id: 'VPL-0001', contentHash: HASH_C },
    testCaseRefs: [projectCase('TC-0010', HASH_A), projectCase('TC-0011', HASH_B)],
    commandRefs: ['quote.component', 'quote.unit'],
    evidenceRequired: ['test-results'],
    stopConditions: ['signal stale contract'],
    agent: { agentId: 'codex', protocol: 'acp', role: 'project-writer' },
    limits: { timeoutMs: 900_000, maxOutputBytes: 1_048_576 },
    permissionPolicy: {
      filesystemRoots: ['/tmp/quote'], terminal: true, network: 'DENY',
      denyGitCommit: true, denyNestedOmnai: true,
    },
    createdAt: NOW,
    ...overrides,
  };
}

function projectTestPlannerPacketInput(overrides: Partial<PlannerPacketInput> = {}): PlannerPacketInput {
  return {
    schemaVersion: 1,
    id: 'RUN-0002',
    kind: 'PROJECT_TEST_PLANNER',
    worksetId: 'WKS-0001',
    contracts: [{ id: 'CTR-0001', contentHash: HASH_B }],
    objective: 'Propose source-traceable project tests',
    protocolIds: ['execution.project-test-planner'],
    verificationCommands: [],
    evidenceRequired: ['project-test-plan-candidate'],
    stopConditions: ['signal stale source'],
    agent: { agentId: 'codex', protocol: 'acp', role: 'coordination-read-only' },
    limits: { timeoutMs: 300_000, maxOutputBytes: 1_048_576 },
    permissionPolicy: {
      filesystemRoots: ['/tmp/planner-source'], terminal: false, network: 'DENY',
      denyGitCommit: true, denyNestedOmnai: true,
    },
    project: 'quote-center',
    scopedTasks: [{
      project: 'quote-center', changeId: 'CHG-0001', revision: 'REV-0001',
      baseline: 'BL-0001', taskId: 'TASK-001',
    }],
    sourceSnapshot: {
      path: '/tmp/planner-source', head: 'a'.repeat(40), tree: 'b'.repeat(40),
      contentHash: HASH_A,
      sourceRefs: [{ ref: 'src/auth.ts', contentHash: HASH_B }],
    },
    acceptanceCriteria: [{ ref: 'spec.md#authorization', contentHash: HASH_C }],
    manifestRefs: [{ ref: 'package.json', contentHash: HASH_D }],
    contractScenarios: [{
      contractKey: 'authorization-v2', scopeHash: HASH_A,
      snapshot: { id: 'CTR-0001', contentHash: HASH_B },
      scenarioId: 'SC-007', scenarioClass: 'NORMAL', contentHash: HASH_D,
      title: 'revoked authorization is rejected', participantProjects: ['quote-center', 'user-center'],
      sourceRefs: [{ ref: 'contract/authorization.yaml', contentHash: HASH_B }],
      contractElementRefs: [{ ref: 'authorization.response', contentHash: HASH_C }],
      fixtureRefs: [], executorRefs: ['validator:parser'],
      expectedOutcome: 'revoked authorization is rejected',
    }],
    outputPath: '/tmp/run-output/project-test-plan.yaml',
    createdAt: NOW,
    ...overrides,
  };
}

function permissionOptions() {
  return [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' as const },
    { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' as const },
    { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' as const },
  ];
}

test('packet hashing covers semantic fields, deep-freezes values, and persistence is immutable', async () => {
  const first = createRunPacket(writerPacketInput());
  const semanticMutations: Array<Partial<WriterPacketInput>> = [
    { objective: 'Implement authorization v3' },
    { verificationPlan: { id: 'VPL-0001', contentHash: HASH_D } },
    { testCaseRefs: [projectCase('TC-0010', HASH_A), projectCase('TC-0011', HASH_D)] },
    { commandRefs: ['quote.contract', 'quote.unit'] },
    { allowedPaths: ['src/**'] },
    { permissionPolicy: { ...writerPacketInput().permissionPolicy, network: 'ALLOW' } },
  ];
  for (const mutation of semanticMutations) {
    assert.notEqual(createRunPacket(writerPacketInput(mutation)).packetHash, first.packetHash);
  }
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.testCaseRefs), true);
  assert.throws(() => { (first as { objective: string }).objective = 'mutated'; }, TypeError);

  const fixture = await createTestDirectory('omnai-packet-');
  try {
    const path = join(fixture.root, 'packet.yaml');
    await persistRunPacket(path, first);
    await persistRunPacket(path, first);
    await assert.rejects(
      () => persistRunPacket(path, createRunPacket(writerPacketInput({ objective: 'different' }))),
      /RUN_PACKET_IMMUTABLE/,
    );
    assert.deepEqual(await loadRunPacket(path), first);
  } finally {
    await fixture.cleanup();
  }
});

test('Core approves only packet-bounded permissions and never grants persistent authority', async () => {
  const packet = createRunPacket(writerPacketInput());
  assert.equal(evaluatePermission(packet, {
    kind: 'write-file', path: '/tmp/quote/src/auth.ts', options: permissionOptions(),
  }).outcome, 'ALLOW_ONCE');
  assert.equal(evaluatePermission(packet, {
    kind: 'write-file', path: '/tmp/order/src/auth.ts', options: permissionOptions(),
  }).outcome, 'DENY');
  const globstarPacket = createRunPacket(writerPacketInput({ allowedPaths: ['src/**/auth.ts'] }));
  assert.equal(evaluatePermission(globstarPacket, {
    kind: 'write-file', path: '/tmp/quote/src/auth.ts', options: permissionOptions(),
  }).outcome, 'ALLOW_ONCE');
  assert.equal(evaluatePermission(packet, {
    kind: 'terminal', command: ['npm', 'test'], cwd: '/tmp/quote', options: permissionOptions(),
  }).outcome, 'ALLOW_ONCE');
  for (const command of [
    ['git', 'commit', '-m', 'worker'], ['git', 'reset', '--hard'], ['omnai', 'run'],
  ]) {
    assert.equal(evaluatePermission(packet, {
      kind: 'terminal', command, cwd: '/tmp/quote', options: permissionOptions(),
    }).outcome, 'DENY');
  }
  assert.equal(evaluatePermission(packet, {
    kind: 'network', host: 'example.com', options: permissionOptions(),
  }).outcome, 'DENY');

  const fixture = await createTestDirectory('omnai-policy-symlink-');
  try {
    const worktree = join(fixture.root, 'worktree');
    const outside = join(fixture.root, 'outside');
    await mkdir(join(worktree, 'src'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(worktree, 'src', 'escape'));
    const bounded = createRunPacket(writerPacketInput({
      git: { ...writerPacketInput().git, worktree },
      permissionPolicy: { ...writerPacketInput().permissionPolicy, filesystemRoots: [worktree] },
    }));
    assert.equal(evaluatePermission(bounded, {
      kind: 'write-file', path: join(worktree, 'src', 'escape', 'secret.txt'), options: permissionOptions(),
    }).outcome, 'DENY');
  } finally {
    await fixture.cleanup();
  }
});

test('resolved secrets stay outside packets and are recursively redacted', () => {
  const packet = createRunPacket(writerPacketInput());
  assert.equal(JSON.stringify(packet).includes('secret-token'), false);
  assert.deepEqual(resolveSecretEnvironment(
    { envRefs: { API_TOKEN: 'OMNAI_API_TOKEN', DB_PASSWORD: 'OMNAI_DB_PASSWORD' } },
    { OMNAI_API_TOKEN: 'secret-token', OMNAI_DB_PASSWORD: 'db-secret', UNRELATED: 'ignore' },
  ), { API_TOKEN: 'secret-token', DB_PASSWORD: 'db-secret' });
  assert.throws(
    () => resolveSecretEnvironment({ envRefs: { API_TOKEN: 'OMNAI_MISSING' } }, {}),
    /SECRET_REFERENCE_MISSING.*OMNAI_MISSING/,
  );
  assert.deepEqual(
    redactSecrets({ header: 'Bearer secret-token', nested: ['db-secret', { 'secret-token-key': 'xsecret-tokenx' }] }, ['secret-token', 'db-secret']),
    { header: 'Bearer [REDACTED]', nested: ['[REDACTED]', { '[REDACTED]-key': 'x[REDACTED]x' }] },
  );
});

test('Project Test Planner packet is project-scoped and structurally read-only', () => {
  const packet = createRunPacket(projectTestPlannerPacketInput());
  assert.equal(packet.kind, 'PROJECT_TEST_PLANNER');
  assert.equal(packet.agent.role, 'coordination-read-only');
  assert.deepEqual(packet.scopedTasks.map((item) => item.project), ['quote-center']);
  assert.equal('allowedPaths' in packet, false);
  assert.equal('git' in packet, false);
  assert.equal(packet.permissionPolicy.terminal, false);
  assert.equal(packet.permissionPolicy.network, 'DENY');
  assert.throws(() => createRunPacket({
    ...projectTestPlannerPacketInput(),
    permissionPolicy: { ...projectTestPlannerPacketInput().permissionPolicy, terminal: true },
  } as unknown as PlannerPacketInput), /PROJECT_TEST_PLANNER_READ_ONLY|Invalid input/);
});

test('rendered prompts bind one packet identity, role protocol, output schema, and authority boundary', async () => {
  const packet = createRunPacket(writerPacketInput());
  const prompt = await renderRunPrompt(packet, '/tmp/run-output/worker-result.yaml');
  assert.match(prompt, new RegExp(packet.id));
  assert.match(prompt, new RegExp(packet.packetHash.replace(':', '\\:')));
  assert.match(prompt, /execution\.project-writer/);
  assert.match(prompt, /WorkerResult/);
  assert.match(prompt, /\/tmp\/run-output\/worker-result\.yaml/);
  assert.match(prompt, /must not.*commit/i);
  assert.match(prompt, /must not.*nested OmnAI/i);
});

test('structured results are strict and must match both Run ID and packet hash', () => {
  const packet = createRunPacket(writerPacketInput());
  const value = {
    schemaVersion: 1,
    runId: packet.id,
    packetHash: packet.packetHash,
    outcome: 'FINISH',
    summary: 'done',
    changedPaths: ['src/auth.ts'],
    evidenceRefs: [],
    logs: [],
  } as const;
  assert.equal(parseArtifactForPacket(packet, workerResultSchema, value).outcome, 'FINISH');
  assert.throws(
    () => parseArtifactForPacket(packet, workerResultSchema, { ...value, packetHash: HASH_D }),
    /ARTIFACT_IDENTITY_MISMATCH.*packetHash/,
  );
  assert.throws(
    () => parseArtifactForPacket(packet, workerResultSchema, { ...value, runId: 'RUN-9999' }),
    /ARTIFACT_IDENTITY_MISMATCH.*runId/,
  );
  assert.throws(() => workerResultSchema.parse({ ...value, unexpected: true }), /unrecognized/i);
});

test('test-planner and reviewer artifacts stay self-contained and strict', () => {
  const plannerPacket = createRunPacket(projectTestPlannerPacketInput());
  const scopedTask = plannerPacket.scopedTasks[0]!;
  const candidate = projectTestPlanCandidateSchema.parse({
    schemaVersion: 1,
    runId: plannerPacket.id,
    packetHash: plannerPacket.packetHash,
    project: 'quote-center',
    sourceSnapshot: {
      head: plannerPacket.sourceSnapshot.head,
      tree: plannerPacket.sourceSnapshot.tree,
      contentHash: plannerPacket.sourceSnapshot.contentHash,
    },
    scopedTasks: [scopedTask],
    testCases: [{
      id: 'TC-0010', level: 'UNIT', title: 'rejects revoked authorization', required: true,
      sourceRefs: [{ ref: 'src/auth.ts', contentHash: HASH_B }],
      scopedTasks: [scopedTask],
      acceptanceCriteriaRefs: [{ ref: 'spec.md#authorization', contentHash: HASH_C }],
      contractRefs: [{ id: 'CTR-0001', contentHash: HASH_B }],
      scenarioRefs: [{
        contractKey: 'authorization-v2', scopeHash: HASH_A,
        snapshot: { id: 'CTR-0001', contentHash: HASH_B },
        scenarioId: 'SC-007', scenarioClass: 'NORMAL', contentHash: HASH_D,
      }],
      commandRefs: ['quote.unit'], ownerProjects: ['quote-center'],
      testPaths: ['test/auth.test.ts'], evidenceRequired: ['exit-code', 'output-hash'],
      expectedOutcome: 'revoked authorization is rejected',
    }],
    commandDefinitions: [{
      commandRef: 'quote.unit', executable: 'npm', argv: ['test', '--', 'test/auth.test.ts'],
      cwd: '.', network: 'DENY', timeoutMs: 60_000, outputLimit: 1_048_576,
      caseRefs: ['TC-0010'],
    }],
    summary: 'one source-traceable case',
  });
  assert.equal(candidate.commandDefinitions[0]?.executable, 'npm');
  assert.throws(() => projectTestPlanCandidateSchema.parse({
    ...candidate,
    commandDefinitions: [{ ...candidate.commandDefinitions[0]!, caseRefs: ['TC-9999'] }],
  }), /PROJECT_TEST_PLAN_CASE_UNDEFINED/);

  const review = {
    schemaVersion: 1,
    runId: 'RUN-0003',
    packetHash: HASH_A,
    outcome: 'REQUEST_CHANGES',
    summary: 'missing failure coverage',
    findings: [{
      id: 'RF-0001', severity: 'BLOCKING', category: 'TEST', path: 'test/auth.test.ts',
      detail: 'revoked authorization is not covered', evidenceRefs: ['TC-0010'],
    }],
    evidenceRefs: ['TC-0010'],
    logs: [],
  } as const;
  assert.equal(reviewFindingSchema.parse(review).outcome, 'REQUEST_CHANGES');
  assert.throws(() => reviewFindingSchema.parse({ ...review, unexpected: true }), /unrecognized/i);
});

test('contract artifacts carry traceability and resolutions cannot select an absent option', () => {
  const identity = { schemaVersion: 1 as const, runId: 'RUN-0001', packetHash: HASH_A };
  const candidate = contractCandidateSchema.parse({
    ...identity,
    contractKey: 'authorization-v2',
    scopeHash: HASH_B,
    participants: [
      { project: 'quote-center', role: 'CONSUMER', taskRefs: ['TASK-001'] },
      { project: 'user-center', role: 'PROVIDER', taskRefs: ['TASK-001'] },
    ],
    contract: {
      elements: [{
        id: 'authorization.response', kind: 'SCHEMA', name: 'Authorization response',
        ownerProject: 'user-center', definition: { type: 'object' },
        sourceRefs: ['user-center/spec.md#response'],
      }],
      compatibilityPolicy: { mode: 'BACKWARD_COMPATIBLE', rules: ['do not remove fields'] },
    },
    businessScenarios: [{
      id: 'SC-007', class: 'NORMAL', title: 'quote consumes authorization',
      participantProjects: ['quote-center', 'user-center'],
      sourceRefs: ['quote-center/spec.md#authorization'],
      contractElementRefs: ['authorization.response'], fixtureRefs: ['valid-user'],
      executorRefs: ['quote.contract-consumer'], expectedOutcome: 'request succeeds',
    }],
    fixtures: [{ ref: 'valid-user', ownerProject: 'user-center', contentHash: HASH_C }],
    traceability: [{
      sourceRef: 'quote-center/spec.md#authorization', sourceHash: HASH_D,
      contractElementRefs: ['authorization.response'], scenarioIds: ['SC-007'],
    }],
    sourceHashes: [{ ref: 'quote-center/spec.md#authorization', contentHash: HASH_D }],
    validatorRequests: [{
      id: 'quote.contract-consumer', project: 'quote-center', required: true,
      scenarioIds: ['SC-007'],
    }],
    summary: 'authorization contract candidate',
  });
  assert.equal(candidate.contractKey, 'authorization-v2');
  const finding = projectFindingSchema.parse({
    ...identity, findingId: 'FND-0001', project: 'quote-center', candidateHash: HASH_B,
    disposition: 'CONTRADICTION', resolution: 'EVIDENCE_BACKED', summary: 'two valid shapes',
    evidenceRefs: ['spec.md#authorization'], candidateOptions: [
      { id: 'keep-v2', summary: 'keep the v2 response', evidenceRefs: ['spec.md#authorization'] },
    ],
  });
  assert.equal(finding.disposition, 'CONTRADICTION');
  assert.throws(() => contractResolutionSchema.parse({
    ...identity, candidateHash: HASH_B, summary: 'resolved', resolutions: [{
      findingId: 'FND-0001', selectedOptionId: 'invented', candidateOptionIds: ['keep-v2'],
      evidenceRefs: ['spec.md#authorization'],
    }],
  }), /RESOLUTION_OPTION_NOT_CANDIDATE/);
  const selfConsistentButInvented = contractResolutionSchema.parse({
    ...identity, candidateHash: HASH_B, summary: 'resolved', resolutions: [{
      findingId: 'FND-0001', selectedOptionId: 'invented', candidateOptionIds: ['invented'],
      evidenceRefs: ['spec.md#authorization'],
    }],
  });
  assert.throws(
    () => validateContractResolutionAgainstFindings(selfConsistentButInvented, [finding]),
    /RESOLUTION_OPTION_NOT_CANDIDATE/,
  );
});

test('verification evidence is exact, case-addressed, and environment-input-bound', () => {
  const packet = createRunPacket(writerPacketInput());
  const caseRef = projectCase();
  const projectEvidence = {
    schemaVersion: 1,
    runId: packet.id,
    packetHash: packet.packetHash,
    id: 'EVD-0001',
    status: 'PASS',
    verificationPlan: packet.verificationPlan,
    testCaseRefs: [caseRef],
    caseOutcomes: [{ caseRef, status: 'PASS' }],
    contractRefs: [{ id: 'CTR-0001', contentHash: HASH_B }],
    command: { commandRef: 'quote.unit', contentHash: HASH_C },
    exitCode: 0,
    outputHash: HASH_D,
    artifactHashes: [],
    startedAt: NOW,
    finishedAt: '2026-08-16T00:00:01.000Z',
    verifier: { kind: 'CORE', id: 'omnai-core' },
    subject: {
      kind: 'PROJECT', project: 'quote-center', commit: 'a'.repeat(40),
      commitTree: 'b'.repeat(40), verifiedTree: 'c'.repeat(40), metadataDeltaHash: HASH_A,
    },
  } as const;
  assert.equal(verificationEvidenceSchema.parse(projectEvidence).status, 'PASS');
  assert.throws(
    () => verificationEvidenceSchema.parse({
      ...projectEvidence,
      subject: { ...projectEvidence.subject, verifiedTree: undefined },
    }),
    /verifiedTree/,
  );

  const environmentWithoutHash = {
    schemaVersion: 1 as const,
    verificationPlan: packet.verificationPlan,
    contractSnapshots: [{
      contractKey: 'authorization-v2', scopeHash: HASH_A,
      snapshot: { id: 'CTR-0001', contentHash: HASH_B },
    }],
    commitSet: { id: 'CST-0001', scopeHash: HASH_C },
    projects: [{
      project: 'quote-center', commit: 'a'.repeat(40), commitTree: 'b'.repeat(40),
      verifiedTree: 'c'.repeat(40), metadataDeltaHash: HASH_D,
    }],
    profile: { id: 'authorization-local', contentHash: HASH_A },
    testCaseRefs: [caseRef],
    commandDefinitionsHash: HASH_B,
    definitionDigest: HASH_C,
    executorDigests: [], supportingArtifactDigests: [], externalDeploymentDigests: [],
    environmentReferenceNames: ['OMNAI_DB_PASSWORD'], policyVersion: 1,
  };
  const environmentInput = {
    ...environmentWithoutHash,
    inputHash: hashIntegrationEnvironmentInput(environmentWithoutHash),
  };
  const environmentEvidence = {
    ...projectEvidence,
    subject: { kind: 'ENVIRONMENT' as const, environmentRunId: 'IER-0001', input: environmentInput },
  };
  assert.equal(verificationEvidenceSchema.parse(environmentEvidence).subject.kind, 'ENVIRONMENT');
  assert.throws(() => verificationEvidenceSchema.parse({
    ...environmentEvidence,
    verificationPlan: { id: 'VPL-0002', contentHash: HASH_D },
  }), /VERIFICATION_INPUT_MISMATCH/);
});
