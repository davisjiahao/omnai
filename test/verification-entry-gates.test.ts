import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evaluateWaveEntry,
  evaluateWriterEntry,
  type WriterRunPacket,
} from '../src/execution/verification/gates.js';
import { compileTestCase } from '../src/execution/verification/test-cases.js';
import { compileVerificationPlan } from '../src/execution/verification/planner.js';
import { hashRunPacket } from '../src/execution/packets.js';
import {
  hashAdversarialCoveragePolicy,
  hashVerificationPlan,
  legacyVerificationPlanSchema,
  verificationPlanV2Schema,
  type AdversarialCoveragePolicy,
  type AnyVerificationPlan,
  type ContentAddressedSourceRef,
  type ContentHash,
  type ScopedTaskRef,
  type LegacyVerificationPlan,
  type VerificationPlanV2,
  type Wave,
} from '../src/execution/types.js';

const NOW = '2026-08-20T00:00:00.000Z';
const HASH_A = `sha256:${'a'.repeat(64)}` as ContentHash;
const HASH_B = `sha256:${'b'.repeat(64)}` as ContentHash;
const HASH_C = `sha256:${'c'.repeat(64)}` as ContentHash;
const HASH_D = `sha256:${'d'.repeat(64)}` as ContentHash;
const EXPECTED_WORKTREE = '/tmp/quote-center';
const EXPECTED_VERIFICATION_COMMANDS = ['npm test -- quote-center'] as const;

const task: ScopedTaskRef = {
  project: 'quote-center',
  changeId: 'CHG-0001',
  revision: 'REV-0001',
  baseline: 'BL-0001',
  taskId: 'TASK-001',
};

const policyIdentity = {
  schemaVersion: 1,
  id: 'entry-gate-default-adversarial',
  vectors: [
    { id: 'IDENTITY_TAMPERING', safetyProperties: ['NO_UNAUTHORIZED_EFFECT', 'REJECTED'] },
    { id: 'MALFORMED_INPUT', safetyProperties: ['REJECTED', 'SAFE_FAILURE'] },
    { id: 'STALE_REPLAY', safetyProperties: ['INVARIANT_PRESERVED', 'REJECTED'] },
  ],
  requirements: [{
    scope: 'BEHAVIOR_TASK',
    vectorIds: ['IDENTITY_TAMPERING', 'MALFORMED_INPUT', 'STALE_REPLAY'],
  }],
} as const;

const adversarialPolicy: AdversarialCoveragePolicy = {
  ...policyIdentity,
  contentHash: hashAdversarialCoveragePolicy(policyIdentity),
};
const adversarialPolicyRef = {
  ref: 'policies/entry-gate-adversarial.yaml',
  contentHash: adversarialPolicy.contentHash,
} as const;
const authoritativeSourceRefs: readonly ContentAddressedSourceRef[] = [
  { ref: 'design.md', contentHash: HASH_A },
  { ref: 'threats/entry-gates.yaml', contentHash: HASH_B },
];

function fixtures() {
  const projectCase = compileTestCase({
    scope: {
      kind: 'PROJECT',
      project: task.project,
      changeId: task.changeId,
      revision: task.revision,
    },
    testCase: {
      schemaVersion: 2,
      id: 'TC-0001',
      level: 'COMPONENT',
      title: '[adversarial] reject forged, malformed, and stale Writer inputs',
      sourceRefs: authoritativeSourceRefs,
      scopedTasks: [task],
      commandRefs: ['quote-center:adversarial'],
      expectedOutcome: 'invalid inputs are rejected without an unauthorized state change',
      adversarial: {
        threatRefs: [{ ref: 'threats/entry-gates.yaml', contentHash: HASH_B }],
        vectorIds: ['IDENTITY_TAMPERING', 'MALFORMED_INPUT', 'STALE_REPLAY'],
        safetyProperties: ['INVARIANT_PRESERVED', 'NO_UNAUTHORIZED_EFFECT', 'REJECTED', 'SAFE_FAILURE'],
        hypothesis: 'a forged, malformed, or stale packet may cross the Writer boundary',
      },
    },
  });
  const cases = [projectCase] as const;
  const adversarialRequirements = [{
    policy: adversarialPolicyRef,
    scope: { kind: 'TASK' as const, scopedTask: task },
    vectorIds: ['IDENTITY_TAMPERING', 'MALFORMED_INPUT', 'STALE_REPLAY'],
  }] as const;
  const plan = compileVerificationPlan({
    id: 'VPL-0001',
    worksetId: 'WKS-0001',
    scopeHash: HASH_C,
    contractSnapshots: [],
    profile: { id: 'authorization-local', contentHash: HASH_C },
    requiredTasks: [task],
    cases,
    adversarialPolicy,
    adversarialPolicyRef,
    adversarialRequirements,
    adversarialExemptions: [],
    authoritativeSourceRefs,
    createdAt: NOW,
  });
  const check = plan.projectChecks[0]!;
  const member: Wave['members'][number] = {
    ...task,
    contracts: [],
    verificationPlan: { id: plan.id, contentHash: plan.contentHash },
    testCaseRefs: check.caseRefs,
    commandRefs: check.commandRefs,
    objective: 'Implement Authorization V2',
    allowedPaths: ['src/**', 'test/**'],
    agentId: 'codex',
  };
  const wave: Wave = {
    schemaVersion: 1,
    machineVersion: 1,
    lastEventSequence: 0,
    lastEventHash: null,
    id: 'WAVE-0001',
    worksetId: 'WKS-0001',
    status: 'PLANNED',
    inputHash: HASH_A,
    members: [member],
    deferred: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
  const packet = writerPacket(member, plan);
  return { cases, plan, member, wave, packet };
}

function writerPacket(
  member: Wave['members'][number],
  plan: VerificationPlanV2,
  verificationCommands: readonly string[] = EXPECTED_VERIFICATION_COMMANDS,
): WriterRunPacket {
  return rehashPacket({
    schemaVersion: 1,
    id: 'RUN-0001',
    kind: 'PROJECT_WRITER',
    worksetId: 'WKS-0001',
    waveId: 'WAVE-0001',
    scopedTask: task,
    git: {
      startingHead: 'a'.repeat(40),
      worktree: EXPECTED_WORKTREE,
      branch: 'omnai/WKS-0001-authorization',
    },
    contracts: member.contracts,
    objective: member.objective,
    protocolIds: ['execution.project-writer'],
    allowedPaths: member.allowedPaths,
    verificationCommands,
    verificationPlan: { id: plan.id, contentHash: plan.contentHash },
    testCaseRefs: member.testCaseRefs ?? [],
    commandRefs: member.commandRefs ?? [],
    evidenceRequired: ['test-case-results'],
    stopConditions: ['signal stale inputs'],
    agent: { agentId: 'codex', protocol: 'acp', role: 'project-writer' },
    limits: { timeoutMs: 900000, maxOutputBytes: 1048576 },
    permissionPolicy: {
      filesystemRoots: [EXPECTED_WORKTREE],
      terminal: true,
      network: 'DENY',
      denyGitCommit: true,
      denyNestedOmnai: true,
    },
    createdAt: NOW,
    packetHash: HASH_C,
  });
}

function fullyExemptEntryFixture() {
  const exemptionSources = [authoritativeSourceRefs[0]!] as const;
  const adversarialRequirements = [{
    policy: adversarialPolicyRef,
    scope: { kind: 'TASK' as const, scopedTask: task },
    vectorIds: ['IDENTITY_TAMPERING', 'MALFORMED_INPUT', 'STALE_REPLAY'],
  }] as const;
  const plan = compileVerificationPlan({
    id: 'VPL-0002',
    worksetId: 'WKS-0001',
    scopeHash: HASH_C,
    contractSnapshots: [],
    profile: { id: 'documentation-local', contentHash: HASH_C },
    requiredTasks: [task],
    cases: [],
    adversarialPolicy,
    adversarialPolicyRef,
    adversarialRequirements,
    adversarialExemptions: [{
      policy: adversarialPolicyRef,
      scope: { kind: 'TASK', scopedTask: task },
      vectorIds: ['IDENTITY_TAMPERING', 'MALFORMED_INPUT', 'STALE_REPLAY'],
      reasonCode: 'DOCUMENTATION_ONLY',
      sourceRefs: exemptionSources,
      explanationHash: HASH_D,
    }],
    authoritativeSourceRefs: exemptionSources,
    createdAt: NOW,
  });
  const check = plan.projectChecks[0]!;
  const member: Wave['members'][number] = {
    ...task,
    contracts: [],
    verificationPlan: { id: plan.id, contentHash: plan.contentHash },
    testCaseRefs: check.caseRefs,
    commandRefs: check.commandRefs,
    objective: 'Update generated documentation only',
    allowedPaths: ['docs/**'],
    agentId: 'codex',
  };
  const wave: Wave = {
    schemaVersion: 1,
    machineVersion: 1,
    lastEventSequence: 0,
    lastEventHash: null,
    id: 'WAVE-0001',
    worksetId: 'WKS-0001',
    status: 'PLANNED',
    inputHash: HASH_A,
    members: [member],
    deferred: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
  const packet = writerPacket(member, plan, []);
  const waveInput = {
    wave,
    verificationPlan: plan,
    adversarialPolicy,
    adversarialPolicyRef,
    authoritativeSourceRefs: exemptionSources,
    cases: [],
    invalidatedTasks: [],
  } as const;
  return {
    waveInput,
    writerInput: {
      ...waveInput,
      member,
      packet,
      expectedAgent: { agentId: 'codex', protocol: 'acp' as const },
      expectedWorktree: EXPECTED_WORKTREE,
      expectedVerificationCommands: [],
      activeWriterProjects: [],
    },
  } as const;
}

function rehashPacket(packet: WriterRunPacket): WriterRunPacket {
  const { packetHash: _discarded, ...withoutHash } = packet;
  return { ...withoutHash, packetHash: hashRunPacket(withoutHash) } as WriterRunPacket;
}

function waveEntryFixture() {
  const { wave, plan, cases } = fixtures();
  return {
    wave,
    verificationPlan: plan,
    adversarialPolicy,
    adversarialPolicyRef,
    authoritativeSourceRefs,
    cases,
    invalidatedTasks: [],
  } as const;
}

function writerEntryFixture() {
  const { wave, plan, cases, member, packet } = fixtures();
  return {
    wave,
    verificationPlan: plan,
    adversarialPolicy,
    adversarialPolicyRef,
    authoritativeSourceRefs,
    cases,
    invalidatedTasks: [],
    member,
    packet,
    expectedAgent: { agentId: 'codex', protocol: 'acp' as const },
    expectedWorktree: EXPECTED_WORKTREE,
    expectedVerificationCommands: EXPECTED_VERIFICATION_COMMANDS,
    activeWriterProjects: [],
  } as const;
}

function verificationPlanV1Fixture(plan: VerificationPlanV2): LegacyVerificationPlan {
  const identity = {
    schemaVersion: 1 as const,
    id: plan.id,
    worksetId: plan.worksetId,
    scopeHash: plan.scopeHash,
    contractSnapshots: plan.contractSnapshots,
    profile: plan.profile,
    projectChecks: plan.projectChecks,
    integrationCaseRefs: plan.integrationCaseRefs,
  };
  return legacyVerificationPlanSchema.parse({
    ...identity,
    machineVersion: 1,
    lastEventSequence: 0,
    lastEventHash: null,
    status: 'READY',
    contentHash: hashVerificationPlan(identity),
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  });
}

function mutatePlanBody(plan: VerificationPlanV2): AnyVerificationPlan {
  return { ...plan, profile: { ...plan.profile, contentHash: HASH_D } };
}

function assertGateIssue(
  result: ReturnType<typeof evaluateWaveEntry> | ReturnType<typeof evaluateWriterEntry>,
  expectedCode: string,
): void {
  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.issues.some((entry) => entry.code === expectedCode), true);
}

test('[adversarial] Writer gate rejects coherently rehashed identity, command, agent, and path drift', async (t) => {
  const attacks: readonly [string, (packet: WriterRunPacket) => unknown, string][] = [
    ['unknown packet kind', (packet) => ({ ...packet, kind: 'UNKNOWN' }), 'PACKET_SCHEMA_INVALID'],
    ['body changed without rehash', (packet) => ({ ...packet, objective: 'forged objective' }),
      'PACKET_CONTENT_HASH_MISMATCH'],
    ['verification command changed and rehashed', (packet) => rehashPacket({
      ...packet,
      verificationCommands: ['npm test -- forged'],
    }), 'PACKET_VERIFICATION_COMMAND_MISMATCH'],
    ['agent id changed and rehashed', (packet) => rehashPacket({
      ...packet,
      agent: { ...packet.agent, agentId: 'other-agent' },
    }), 'PACKET_AGENT_MISMATCH'],
    ['agent protocol changed and rehashed', (packet) => rehashPacket({
      ...packet,
      agent: { ...packet.agent, protocol: 'native' },
    }), 'PACKET_AGENT_MISMATCH'],
    ['allowed path traverses parent and is rehashed', (packet) => rehashPacket({
      ...packet,
      allowedPaths: ['../secrets'],
    }), 'PACKET_ALLOWED_PATH_INVALID'],
    ['filesystem root expands beyond worktree and is rehashed', (packet) => rehashPacket({
      ...packet,
      permissionPolicy: { ...packet.permissionPolicy, filesystemRoots: ['/tmp'] },
    }), 'PACKET_PERMISSION_POLICY_MISMATCH'],
    ['worktree and root coherently expand and are rehashed', (packet) => rehashPacket({
      ...packet,
      git: { ...packet.git, worktree: '/tmp/other-project' },
      permissionPolicy: { ...packet.permissionPolicy, filesystemRoots: ['/tmp/other-project'] },
    }), 'PACKET_PERMISSION_POLICY_MISMATCH'],
  ];
  for (const [name, mutate, expectedCode] of attacks) {
    await t.test(`[adversarial] ${name}`, () => {
      const input = writerEntryFixture();
      assertGateIssue(evaluateWriterEntry({ ...input, packet: mutate(input.packet) }), expectedCode);
    });
  }
});

test('[adversarial] Wave entry fails closed on duplicate members and malformed plan bodies', async (t) => {
  const input = waveEntryFixture();
  const legacy = verificationPlanV1Fixture(input.verificationPlan);
  assert.equal(legacyVerificationPlanSchema.safeParse(legacy).success, true);
  const attacks: readonly [string, Parameters<typeof evaluateWaveEntry>[0], string][] = [
    ['unknown wave status', { ...input, wave: { ...input.wave, status: 'ENTERED' } },
      'WAVE_SCHEMA_INVALID'],
    ['duplicate wave member', {
      ...input,
      wave: { ...input.wave, members: [input.wave.members[0]!, input.wave.members[0]!] },
    }, 'WAVE_SCHEMA_INVALID'],
    ['legacy READY plan replay', { ...input, verificationPlan: legacy },
      'ADVERSARIAL_ASSURANCE_UNPROVEN'],
    ['stale policy ref', {
      ...input,
      adversarialPolicyRef: { ...input.adversarialPolicyRef, contentHash: HASH_D },
    }, 'ADVERSARIAL_POLICY_STALE'],
    ['plan body changed without rehash', {
      ...input,
      verificationPlan: mutatePlanBody(input.verificationPlan),
    }, 'VERIFICATION_PLAN_SCHEMA_INVALID'],
  ];
  for (const [name, attack, expectedCode] of attacks) {
    await t.test(`[adversarial] ${name}`, () => assertGateIssue(evaluateWaveEntry(attack), expectedCode));
  }
});

test('[adversarial] Wave entry rejects authoritative source identity-set drift', async (t) => {
  const input = waveEntryFixture();
  const attacks: readonly [string, readonly ContentAddressedSourceRef[], string][] = [
    ['extra unknown source', [
      ...input.authoritativeSourceRefs,
      { ref: 'unknown.md', contentHash: HASH_C },
    ], 'VERIFICATION_PLAN_CONTENT_MISMATCH'],
    ['missing required source', input.authoritativeSourceRefs.slice(1),
      'VERIFICATION_PLAN_CONTENT_MISMATCH'],
    ['same logical source with substituted hash', input.authoritativeSourceRefs.map((source) =>
      source.ref === 'design.md' ? { ...source, contentHash: HASH_D } : source),
    'VERIFICATION_PLAN_CONTENT_MISMATCH'],
  ];
  for (const [name, suppliedSources, expectedCode] of attacks) {
    await t.test(`[adversarial] ${name}`, () => {
      const result = evaluateWaveEntry({ ...input, authoritativeSourceRefs: suppliedSources });
      assertGateIssue(result, expectedCode);
    });
  }
});

test('[adversarial] Writer entry accepts a correctly hashed lexically contained packet', () => {
  const input = writerEntryFixture();
  assert.equal(hashRunPacket(input.packet), input.packet.packetHash);
  const result = evaluateWriterEntry(input);
  assert.equal(result.ok, true);
  if (!result.ok) assert.fail('expected exact Writer packet admission to pass');
  assert.deepEqual(result.verificationPlan, {
    id: input.verificationPlan.id,
    contentHash: input.verificationPlan.contentHash,
  });
  assert.deepEqual(result.caseRefs, input.member.testCaseRefs);
  assert.deepEqual(result.commandRefs, input.member.commandRefs);
});

test('[adversarial] Wave entry accepts an exactly reproducible v2 assurance plan', () => {
  const input = waveEntryFixture();
  const result = evaluateWaveEntry({
    ...input,
    authoritativeSourceRefs: [...input.authoritativeSourceRefs].reverse(),
  });
  assert.equal(result.ok, true);
  if (!result.ok) assert.fail('expected exact Wave admission to pass');
  assert.deepEqual(result.verificationPlan, {
    id: input.verificationPlan.id,
    contentHash: input.verificationPlan.contentHash,
  });
});

test('[adversarial] Wave and Writer gates reproduce a fully exempt task with no case or command refs', () => {
  const input = fullyExemptEntryFixture();
  const waveResult = evaluateWaveEntry(input.waveInput);
  assert.deepEqual(waveResult, {
    ok: true,
    verificationPlan: {
      id: input.waveInput.verificationPlan.id,
      contentHash: input.waveInput.verificationPlan.contentHash,
    },
    caseRefs: [],
    commandRefs: [],
  });

  const writerResult = evaluateWriterEntry(input.writerInput);
  assert.deepEqual(writerResult, {
    ok: true,
    verificationPlan: {
      id: input.waveInput.verificationPlan.id,
      contentHash: input.waveInput.verificationPlan.contentHash,
    },
    caseRefs: [],
    commandRefs: [],
  });
});

test('[adversarial] runtime inputs return fixed bounded diagnostics without throwing', async (t) => {
  const waveInput = waveEntryFixture();
  const writerInput = writerEntryFixture();
  const throwing = (field: string) => Object.defineProperty({}, field, {
    enumerable: true,
    get: () => { throw new Error('do not expose this runtime detail'); },
  });
  const attacks: readonly [string, () => ReturnType<typeof evaluateWaveEntry> | ReturnType<typeof evaluateWriterEntry>,
    string, string][] = [
    ['malformed Wave', () => evaluateWaveEntry({ ...waveInput, wave: throwing('schemaVersion') }),
      'WAVE_SCHEMA_INVALID', 'wave failed strict schema'],
    ['malformed plan', () => evaluateWaveEntry({
      ...waveInput,
      verificationPlan: throwing('schemaVersion'),
    }), 'VERIFICATION_PLAN_SCHEMA_INVALID', 'verification plan failed strict schema'],
    ['malformed packet', () => evaluateWriterEntry({ ...writerInput, packet: throwing('kind') }),
      'PACKET_SCHEMA_INVALID', 'packet failed strict schema'],
    ['malformed Wave policy', () => evaluateWaveEntry({
      ...waveInput,
      adversarialPolicy: throwing('contentHash') as never,
    }), 'ADVERSARIAL_POLICY_STALE', 'adversarial policy failed strict schema'],
    ['missing Writer policy', () => evaluateWriterEntry({
      ...writerInput,
      adversarialPolicy: null as never,
    }), 'ADVERSARIAL_POLICY_STALE', 'adversarial policy failed strict schema'],
    ['malformed Wave policy ref', () => evaluateWaveEntry({
      ...waveInput,
      adversarialPolicyRef: throwing('contentHash') as never,
    }), 'ADVERSARIAL_POLICY_STALE', 'adversarial policy ref failed strict schema'],
    ['missing Writer policy ref', () => evaluateWriterEntry({
      ...writerInput,
      adversarialPolicyRef: undefined as never,
    }), 'ADVERSARIAL_POLICY_STALE', 'adversarial policy ref failed strict schema'],
  ];
  for (const [name, evaluate, expectedCode, expectedDetail] of attacks) {
    await t.test(`[adversarial] ${name}`, () => {
      let result: ReturnType<typeof evaluateWaveEntry> | ReturnType<typeof evaluateWriterEntry> | undefined;
      assert.doesNotThrow(() => { result = evaluate(); });
      assert.deepEqual(result, { ok: false, issues: [{ code: expectedCode, detail: expectedDetail }] });
    });
  }
});

test('[adversarial] Wave and Writer snapshot every hostile top-level envelope field before use', async (t) => {
  const waveInput = waveEntryFixture();
  const writerInput = writerEntryFixture();
  const throwing = <T extends object>(base: T, field: string): T => Object.defineProperty({ ...base }, field, {
    enumerable: true,
    get: () => { throw new Error('hostile top-level gate detail must not escape'); },
  }) as T;
  const attacks: readonly [
    string,
    () => ReturnType<typeof evaluateWaveEntry> | ReturnType<typeof evaluateWriterEntry>,
    string,
    string,
  ][] = [
    ['Wave getter throws', () => evaluateWaveEntry(throwing(waveInput, 'wave')),
      'WAVE_SCHEMA_INVALID', 'wave failed strict schema'],
    ['Wave has wrong runtime type', () => evaluateWaveEntry({ ...waveInput, wave: null }),
      'WAVE_SCHEMA_INVALID', 'wave failed strict schema'],
    ['plan getter throws', () => evaluateWaveEntry(throwing(waveInput, 'verificationPlan')),
      'VERIFICATION_PLAN_SCHEMA_INVALID', 'verification plan failed strict schema'],
    ['plan has wrong runtime type', () => evaluateWaveEntry({ ...waveInput, verificationPlan: [] }),
      'VERIFICATION_PLAN_SCHEMA_INVALID', 'verification plan failed strict schema'],
    ['policy getter throws', () => evaluateWaveEntry(throwing(waveInput, 'adversarialPolicy')),
      'ADVERSARIAL_POLICY_STALE', 'adversarial policy failed strict schema'],
    ['policy has wrong runtime type', () => evaluateWaveEntry({ ...waveInput, adversarialPolicy: [] as never }),
      'ADVERSARIAL_POLICY_STALE', 'adversarial policy failed strict schema'],
    ['policy ref getter throws', () => evaluateWaveEntry(throwing(waveInput, 'adversarialPolicyRef')),
      'ADVERSARIAL_POLICY_STALE', 'adversarial policy ref failed strict schema'],
    ['policy ref has wrong runtime type', () => evaluateWaveEntry({ ...waveInput, adversarialPolicyRef: 7 as never }),
      'ADVERSARIAL_POLICY_STALE', 'adversarial policy ref failed strict schema'],
    ['invalidated tasks getter throws', () => evaluateWaveEntry(throwing(waveInput, 'invalidatedTasks')),
      'WAVE_SCHEMA_INVALID', 'invalidated tasks failed strict schema'],
    ['invalidated tasks have wrong runtime type', () => evaluateWaveEntry({ ...waveInput, invalidatedTasks: null as never }),
      'WAVE_SCHEMA_INVALID', 'invalidated tasks failed strict schema'],
    ['authoritative source facts getter throws', () => evaluateWaveEntry(throwing(waveInput, 'authoritativeSourceRefs')),
      'VERIFICATION_PLAN_CONTENT_MISMATCH', 'verification plan could not be reproduced'],
    ['authoritative source facts have wrong runtime type', () => evaluateWaveEntry({
      ...waveInput,
      authoritativeSourceRefs: null as never,
    }), 'VERIFICATION_PLAN_CONTENT_MISMATCH', 'verification plan could not be reproduced'],
    ['compiled case facts getter throws', () => evaluateWaveEntry(throwing(waveInput, 'cases')),
      'VERIFICATION_PLAN_CONTENT_MISMATCH', 'verification plan could not be reproduced'],
    ['compiled case facts have wrong runtime type', () => evaluateWaveEntry({ ...waveInput, cases: null as never }),
      'VERIFICATION_PLAN_CONTENT_MISMATCH', 'verification plan could not be reproduced'],
    ['requested member getter throws', () => evaluateWriterEntry(throwing(writerInput, 'member')),
      'PACKET_MEMBER_MISMATCH', 'requested member failed strict schema'],
    ['requested member has wrong runtime type', () => evaluateWriterEntry({ ...writerInput, member: null as never }),
      'PACKET_MEMBER_MISMATCH', 'requested member failed strict schema'],
    ['packet getter throws', () => evaluateWriterEntry(throwing(writerInput, 'packet')),
      'PACKET_SCHEMA_INVALID', 'packet failed strict schema'],
    ['packet has wrong runtime type', () => evaluateWriterEntry({ ...writerInput, packet: null }),
      'PACKET_SCHEMA_INVALID', 'packet failed strict schema'],
    ['expected agent getter throws', () => evaluateWriterEntry(throwing(writerInput, 'expectedAgent')),
      'PACKET_AGENT_MISMATCH', 'expected agent failed strict schema'],
    ['expected agent has wrong runtime type', () => evaluateWriterEntry({ ...writerInput, expectedAgent: null as never }),
      'PACKET_AGENT_MISMATCH', 'expected agent failed strict schema'],
    ['expected worktree getter throws', () => evaluateWriterEntry(throwing(writerInput, 'expectedWorktree')),
      'PACKET_PERMISSION_POLICY_MISMATCH', 'expected worktree failed strict schema'],
    ['expected worktree has wrong runtime type', () => evaluateWriterEntry({ ...writerInput, expectedWorktree: [] as never }),
      'PACKET_PERMISSION_POLICY_MISMATCH', 'expected worktree failed strict schema'],
    ['expected commands getter throws', () => evaluateWriterEntry(throwing(writerInput, 'expectedVerificationCommands')),
      'PACKET_VERIFICATION_COMMAND_MISMATCH', 'expected verification commands failed strict schema'],
    ['expected commands have wrong runtime type', () => evaluateWriterEntry({
      ...writerInput,
      expectedVerificationCommands: null as never,
    }), 'PACKET_VERIFICATION_COMMAND_MISMATCH', 'expected verification commands failed strict schema'],
    ['active projects getter throws', () => evaluateWriterEntry(throwing(writerInput, 'activeWriterProjects')),
      'WRITER_ALREADY_CLAIMED', 'active Writer projects failed strict schema'],
    ['active projects have wrong runtime type', () => evaluateWriterEntry({
      ...writerInput,
      activeWriterProjects: null as never,
    }), 'WRITER_ALREADY_CLAIMED', 'active Writer projects failed strict schema'],
  ];

  for (const [name, evaluate, expectedCode, expectedDetail] of attacks) {
    await t.test(`[adversarial] ${name}`, () => {
      let result: ReturnType<typeof evaluateWaveEntry> | ReturnType<typeof evaluateWriterEntry> | undefined;
      assert.doesNotThrow(() => { result = evaluate(); });
      assert.deepEqual(result, { ok: false, issues: [{ code: expectedCode, detail: expectedDetail }] });
    });
  }
});

test('[adversarial] coherently rehashed VerificationPlan v2 replay fails current-content recompilation', () => {
  const input = waveEntryFixture();
  const changedIdentity = {
    ...input.verificationPlan,
    projectChecks: input.verificationPlan.projectChecks.map((check) => ({
      ...check,
      commandRefs: [...check.commandRefs, 'quote-center:forged'],
    })),
  };
  const replayedPlan = {
    ...changedIdentity,
    contentHash: hashVerificationPlan(changedIdentity),
  };
  assert.equal(verificationPlanV2Schema.safeParse(replayedPlan).success, true);
  const replayedWave = {
    ...input.wave,
    members: input.wave.members.map((member) => ({
      ...member,
      verificationPlan: { id: replayedPlan.id, contentHash: replayedPlan.contentHash },
    })),
  };

  assert.deepEqual(
    evaluateWaveEntry({ ...input, verificationPlan: replayedPlan, wave: replayedWave }),
    {
      ok: false,
      issues: [{
        code: 'VERIFICATION_PLAN_CONTENT_MISMATCH',
        detail: 'verification plan could not be reproduced',
      }],
    },
  );
});

test('[adversarial] Writer entry isolates the requested member after Wave and plan schemas validate', () => {
  const input = writerEntryFixture();
  const unrelated: Wave['members'][number] = {
    ...input.member,
    project: 'zeta-project',
    changeId: 'CHG-0002',
    revision: 'REV-0002',
    baseline: 'BL-0002',
    taskId: 'TASK-002',
    verificationPlan: { id: input.verificationPlan.id, contentHash: HASH_D },
    agentId: 'other-agent',
  };
  const result = evaluateWriterEntry({
    ...input,
    wave: { ...input.wave, members: [input.member, unrelated] },
    invalidatedTasks: [unrelated],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('[adversarial] Writer entry preserves exact member, plan, command-ref, and claim bindings', async (t) => {
  const attacks: readonly [string, (input: ReturnType<typeof writerEntryFixture>) =>
    Parameters<typeof evaluateWriterEntry>[0], string][] = [
    ['unpersisted member', (input) => ({
      ...input,
      member: { ...input.member, taskId: 'TASK-002' },
    }), 'PACKET_MEMBER_MISMATCH'],
    ['plan ref drift', (input) => ({
      ...input,
      packet: rehashPacket({
        ...input.packet,
        verificationPlan: { id: input.verificationPlan.id, contentHash: HASH_D },
      }),
    }), 'PACKET_PLAN_MISMATCH'],
    ['command-ref drift', (input) => ({
      ...input,
      packet: rehashPacket({ ...input.packet, commandRefs: ['quote-center:other'] }),
    }), 'PACKET_COMMAND_REF_MISMATCH'],
    ['active project claim', (input) => ({
      ...input,
      activeWriterProjects: [input.member.project],
    }), 'WRITER_ALREADY_CLAIMED'],
  ];
  for (const [name, mutate, expectedCode] of attacks) {
    await t.test(`[adversarial] ${name}`, () => {
      const input = writerEntryFixture();
      assertGateIssue(evaluateWriterEntry(mutate(input)), expectedCode);
    });
  }
});
