import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { compileAdversarialAssurance } from '../src/execution/verification/adversarial.js';
import {
  evaluateWaveEntry,
  evaluateWriterEntry,
  type WriterRunPacket,
} from '../src/execution/verification/gates.js';
import {
  compileImpactClosure,
  hashImpactClosure,
  impactClosureSchema,
  impactNodeKey,
  type ImpactClosure,
  type ImpactGraphEdge,
  type ImpactGraphNode,
} from '../src/execution/verification/impact.js';
import { compileVerificationPlan } from '../src/execution/verification/planner.js';
import { hashRunPacket } from '../src/execution/packets.js';
import {
  compileTestCase,
  VerificationFlowError,
  type CompiledTestCase,
} from '../src/execution/verification/test-cases.js';
import {
  hashAdversarialCoveragePolicy,
  hashVerificationPlan,
  legacyVerificationPlanSchema,
  type AdversarialCoveragePolicy,
  type ContentAddressedSourceRef,
  type ContentHash,
  type ScopedTaskRef,
  type LegacyVerificationPlan,
  type Wave,
} from '../src/execution/types.js';

const HASH_A = `sha256:${'1'.repeat(64)}` as ContentHash;
const HASH_B = `sha256:${'2'.repeat(64)}` as ContentHash;
const HASH_C = `sha256:${'3'.repeat(64)}` as ContentHash;
const HASH_D = `sha256:${'4'.repeat(64)}` as ContentHash;
const NOW = '2026-08-20T12:00:00.000Z';
const WORKTREE = '/tmp/omnai-pricing-writer';
const VERIFICATION_COMMANDS = ['npm test -- pricing'] as const;
const ADVERSARIAL_RUNNER = resolve('scripts/run-adversarial-tests.mjs');

const task: ScopedTaskRef = {
  project: 'pricing-service',
  changeId: 'CHG-4100',
  revision: 'REV-0007',
  baseline: 'BL-0021',
  taskId: 'TASK-060',
};

const authoritativeSources: readonly ContentAddressedSourceRef[] = [
  { ref: 'requirements/repricing.md#writer-boundary', contentHash: HASH_A },
  { ref: 'threat-model/repricing.yaml#packet-inputs', contentHash: HASH_B },
];

function integrationFixture() {
  const policyIdentity = {
    schemaVersion: 1,
    id: 'pricing-adversarial-policy',
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
  const policy: AdversarialCoveragePolicy = {
    ...policyIdentity,
    contentHash: hashAdversarialCoveragePolicy(policyIdentity),
  };
  const policyRef = {
    ref: 'policies/pricing-adversarial.yaml',
    contentHash: policy.contentHash,
  } as const;
  const requirement = {
    policy: policyRef,
    scope: { kind: 'TASK' as const, scopedTask: task },
    vectorIds: ['IDENTITY_TAMPERING', 'MALFORMED_INPUT', 'STALE_REPLAY'],
  } as const;
  const compiledCase = compileTestCase({
    scope: {
      kind: 'PROJECT',
      project: task.project,
      changeId: task.changeId,
      revision: task.revision,
    },
    testCase: {
      schemaVersion: 2,
      id: 'TC-9060',
      level: 'COMPONENT',
      title: '[adversarial] pricing writer rejects mutated authority inputs',
      sourceRefs: authoritativeSources,
      scopedTasks: [task],
      commandRefs: ['pricing:adversarial'],
      expectedOutcome: 'the writer rejects the request without changing protected pricing state',
      adversarial: {
        threatRefs: [{ ref: 'threat-model/repricing.yaml#packet-inputs', contentHash: HASH_B }],
        vectorIds: ['IDENTITY_TAMPERING', 'MALFORMED_INPUT', 'STALE_REPLAY'],
        safetyProperties: [
          'INVARIANT_PRESERVED',
          'NO_UNAUTHORIZED_EFFECT',
          'REJECTED',
          'SAFE_FAILURE',
        ],
        hypothesis: 'a forged packet may bypass the pricing writer admission boundary',
      },
    },
  });
  const cases = [compiledCase] as const;
  const plan = compileVerificationPlan({
    id: 'VPL-9060',
    worksetId: 'WKS-9060',
    scopeHash: HASH_C,
    contractSnapshots: [],
    profile: { id: 'pricing-local', contentHash: HASH_D },
    requiredTasks: [task],
    cases,
    adversarialPolicy: policy,
    adversarialPolicyRef: policyRef,
    adversarialRequirements: [requirement],
    adversarialExemptions: [],
    authoritativeSourceRefs: authoritativeSources,
    createdAt: NOW,
  });
  const projectCheck = plan.projectChecks[0]!;
  const member: Wave['members'][number] = {
    ...task,
    contracts: [],
    verificationPlan: { id: plan.id, contentHash: plan.contentHash },
    testCaseRefs: projectCheck.caseRefs,
    commandRefs: projectCheck.commandRefs,
    objective: 'Protect repricing writes',
    allowedPaths: ['src/pricing/**', 'test/pricing/**'],
    agentId: 'pricing-writer',
  };
  const wave: Wave = {
    schemaVersion: 1,
    machineVersion: 1,
    lastEventSequence: 0,
    lastEventHash: null,
    id: 'WAVE-9060',
    worksetId: 'WKS-9060',
    status: 'PLANNED',
    inputHash: HASH_A,
    members: [member],
    deferred: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
  const packet = bindPacketHash({
    schemaVersion: 1,
    id: 'RUN-9060',
    kind: 'PROJECT_WRITER',
    worksetId: wave.worksetId,
    waveId: wave.id,
    scopedTask: task,
    git: {
      startingHead: '6'.repeat(40),
      worktree: WORKTREE,
      branch: 'omnai/WKS-9060-pricing',
    },
    contracts: [],
    objective: member.objective,
    protocolIds: ['execution.project-writer'],
    allowedPaths: member.allowedPaths,
    verificationCommands: VERIFICATION_COMMANDS,
    verificationPlan: member.verificationPlan!,
    testCaseRefs: member.testCaseRefs!,
    commandRefs: member.commandRefs!,
    evidenceRequired: ['test-case-results'],
    stopConditions: ['stop on stale authority'],
    agent: { agentId: 'pricing-writer', protocol: 'acp', role: 'project-writer' },
    limits: { timeoutMs: 120000, maxOutputBytes: 262144 },
    permissionPolicy: {
      filesystemRoots: [WORKTREE],
      terminal: true,
      network: 'DENY',
      denyGitCommit: true,
      denyNestedOmnai: true,
    },
    createdAt: NOW,
  });
  const waveInput = {
    wave,
    verificationPlan: plan,
    adversarialPolicy: policy,
    adversarialPolicyRef: policyRef,
    authoritativeSourceRefs: authoritativeSources,
    cases,
    invalidatedTasks: [],
  } as const;
  const writerInput = {
    ...waveInput,
    member,
    packet,
    expectedAgent: { agentId: 'pricing-writer', protocol: 'acp' as const },
    expectedWorktree: WORKTREE,
    expectedVerificationCommands: VERIFICATION_COMMANDS,
    activeWriterProjects: [],
  } as const;

  const sourceNode: ImpactGraphNode = {
    kind: 'SOURCE',
    ref: authoritativeSources[0]!.ref,
    contentHash: authoritativeSources[0]!.contentHash,
  };
  const caseNode: ImpactGraphNode = {
    kind: 'TEST_CASE',
    ref: compiledCase.ref.id,
    contentHash: compiledCase.ref.contentHash,
  };
  const planNode: ImpactGraphNode = {
    kind: 'VERIFICATION_PLAN',
    ref: plan.id,
    contentHash: plan.contentHash,
  };
  const runNode: ImpactGraphNode = {
    kind: 'RUN',
    ref: packet.id,
    contentHash: packet.packetHash,
  };
  const impactNodes = [sourceNode, caseNode, planNode, runNode] as const;
  const impactEdges: readonly ImpactGraphEdge[] = [
    { from: sourceNode, to: caseNode },
    { from: caseNode, to: planNode },
    { from: planNode, to: runNode },
  ];
  const closure = compileImpactClosure({
    worksetId: wave.worksetId,
    scopeHash: plan.scopeHash,
    roots: [{ node: sourceNode, previousContentHash: HASH_D }],
    nodes: impactNodes,
    edges: impactEdges,
  });

  return {
    policy,
    policyRef,
    requirement,
    compiledCase,
    cases,
    plan,
    member,
    wave,
    packet,
    waveInput,
    writerInput,
    closure,
  };
}

function bindPacketHash(packet: Omit<WriterRunPacket, 'packetHash'>): WriterRunPacket {
  return { ...packet, packetHash: hashRunPacket(packet) } as WriterRunPacket;
}

function rebindPacketHash(packet: WriterRunPacket): WriterRunPacket {
  const { packetHash: _oldHash, ...body } = packet;
  return bindPacketHash(body);
}

function rebindClosureHash(closure: ImpactClosure): ImpactClosure {
  const { contentHash: _oldHash, ...body } = closure;
  return { ...body, contentHash: hashImpactClosure(body) };
}

function compiledProposal(compiled: CompiledTestCase) {
  const { contentHash: _oldHash, ...proposal } = compiled.testCase;
  return proposal;
}

function legacyPlanFromCurrent(fixture: ReturnType<typeof integrationFixture>): LegacyVerificationPlan {
  const {
    schemaVersion: _schemaVersion,
    machineVersion: _machineVersion,
    lastEventSequence: _lastEventSequence,
    lastEventHash: _lastEventHash,
    status: _status,
    contentHash: _contentHash,
    adversarialPolicy: _adversarialPolicy,
    adversarialRequirements: _adversarialRequirements,
    adversarialChecks: _adversarialChecks,
    adversarialExemptions: _adversarialExemptions,
    createdAt,
    updatedAt,
    ...sharedIdentity
  } = fixture.plan;
  const identity = {
    schemaVersion: 1 as const,
    ...sharedIdentity,
  };
  return legacyVerificationPlanSchema.parse({
    ...identity,
    machineVersion: 1,
    lastEventSequence: 0,
    lastEventHash: null,
    status: 'READY',
    contentHash: hashVerificationPlan(identity),
    createdAt,
    updatedAt,
  });
}

function thrownVerificationCode(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    if (error instanceof VerificationFlowError) return error.code;
    throw error;
  }
  return 'NO_FAILURE';
}

function gateCodes(result: ReturnType<typeof evaluateWaveEntry> | ReturnType<typeof evaluateWriterEntry>): string[] {
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

function closureCodes(operation: () => unknown): string[] {
  try {
    operation();
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'issues' in error) {
      return (error as { readonly issues: readonly { readonly message: string }[] })
        .issues.map((issue) => issue.message);
    }
    throw error;
  }
  return [];
}

test('[adversarial] cross-module verification rejects coherent identity and assurance mutations', async (t) => {
  const attacks = [
    {
      boundary: 'TestCase v2 compiler',
      mutation: 'one logical source ref binds two hashes',
      safetyProperty: 'REJECTED',
      expectedCode: 'TEST_CASE_SOURCE_IDENTITY_CONFLICT',
      observe: () => {
        const fixture = integrationFixture();
        const proposal = compiledProposal(fixture.compiledCase);
        return [thrownVerificationCode(() => compileTestCase({
          scope: fixture.compiledCase.ref.scope,
          testCase: {
            ...proposal,
            sourceRefs: [
              ...proposal.sourceRefs,
              { ref: authoritativeSources[0]!.ref, contentHash: HASH_D },
            ],
          },
        }))];
      },
    },
    {
      boundary: 'assurance compiler',
      mutation: 'required MALFORMED_INPUT safety oracle is stripped',
      safetyProperty: 'SAFE_FAILURE',
      expectedCode: 'ADVERSARIAL_SAFETY_ORACLE_MISSING',
      observe: () => {
        const fixture = integrationFixture();
        const proposal = compiledProposal(fixture.compiledCase);
        assert.equal(proposal.schemaVersion, 2);
        const weakenedCase = compileTestCase({
          scope: fixture.compiledCase.ref.scope,
          testCase: {
            ...proposal,
            adversarial: {
              ...proposal.adversarial!,
              safetyProperties: ['INVARIANT_PRESERVED', 'NO_UNAUTHORIZED_EFFECT', 'REJECTED'],
            },
          },
        });
        return [thrownVerificationCode(() => compileAdversarialAssurance({
          policy: fixture.policy,
          policyRef: fixture.policyRef,
          requirements: [fixture.requirement],
          exemptions: [],
          authoritativeSourceRefs: authoritativeSources,
          requiredTasks: [task],
          cases: [weakenedCase],
        }))];
      },
    },
    {
      boundary: 'Wave entry gate',
      mutation: 'legacy READY VerificationPlan v1 is replayed',
      safetyProperty: 'INVARIANT_PRESERVED',
      expectedCode: 'ADVERSARIAL_ASSURANCE_UNPROVEN',
      observe: () => {
        const fixture = integrationFixture();
        return gateCodes(evaluateWaveEntry({
          ...fixture.waveInput,
          verificationPlan: legacyPlanFromCurrent(fixture),
        }));
      },
    },
    {
      boundary: 'Writer entry gate',
      mutation: 'verification command drifts and packet is coherently rehashed',
      safetyProperty: 'NO_UNAUTHORIZED_EFFECT',
      expectedCode: 'PACKET_VERIFICATION_COMMAND_MISMATCH',
      observe: () => {
        const fixture = integrationFixture();
        return gateCodes(evaluateWriterEntry({
          ...fixture.writerInput,
          packet: rebindPacketHash({
            ...fixture.packet,
            verificationCommands: ['npm test -- pricing:forged'],
          }),
        }));
      },
    },
    {
      boundary: 'Writer entry gate',
      mutation: 'agent principal and protocol drift and packet is coherently rehashed',
      safetyProperty: 'NO_UNAUTHORIZED_EFFECT',
      expectedCode: 'PACKET_AGENT_MISMATCH',
      observe: () => {
        const fixture = integrationFixture();
        return gateCodes(evaluateWriterEntry({
          ...fixture.writerInput,
          packet: rebindPacketHash({
            ...fixture.packet,
            agent: { agentId: 'pricing-impostor', protocol: 'native', role: 'project-writer' },
          }),
        }));
      },
    },
    {
      boundary: 'Writer entry gate',
      mutation: 'allowed path contains parent traversal and packet is coherently rehashed',
      safetyProperty: 'REJECTED',
      expectedCode: 'PACKET_ALLOWED_PATH_INVALID',
      observe: () => {
        const fixture = integrationFixture();
        return gateCodes(evaluateWriterEntry({
          ...fixture.writerInput,
          packet: rebindPacketHash({
            ...fixture.packet,
            allowedPaths: ['src/pricing/../secrets/**'],
          }),
        }));
      },
    },
    {
      boundary: 'ImpactClosure schema',
      mutation: 'unreachable node is appended and closure is coherently rehashed',
      safetyProperty: 'INVARIANT_PRESERVED',
      expectedCode: 'IMPACT_CLOSURE_SEMANTIC_MISMATCH',
      observe: () => {
        const fixture = integrationFixture();
        const unreachable: ImpactGraphNode = {
          kind: 'COMMITSET',
          ref: 'CST-9999',
          contentHash: HASH_D,
        };
        const affected = [...fixture.closure.affected, unreachable]
          .sort((left, right) => impactNodeKey(left).localeCompare(impactNodeKey(right)));
        const forged = rebindClosureHash({ ...fixture.closure, affected });
        return closureCodes(() => impactClosureSchema.parse(forged));
      },
    },
  ] as const;

  for (const attack of attacks) {
    await t.test(
      `[adversarial] ${attack.boundary}: ${attack.mutation} preserves ${attack.safetyProperty}`,
      () => assert.equal(attack.observe().includes(attack.expectedCode), true),
    );
  }
});

interface RunnerFixtureFile {
  readonly name: string;
  readonly source?: string;
  readonly compiled?: string;
}

async function runAdversarialRunnerFixture(files: readonly RunnerFixtureFile[]) {
  const root = await mkdtemp(join(tmpdir(), 'omnai-adversarial-runner-'));
  const sourceDirectory = join(root, 'test');
  const compiledDirectory = join(root, 'dist', 'test');
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(compiledDirectory, { recursive: true });
  try {
    for (const file of files) {
      if (file.source !== undefined) {
        const sourcePath = join(sourceDirectory, `${file.name}.test.ts`);
        await mkdir(dirname(sourcePath), { recursive: true });
        await writeFile(sourcePath, file.source, 'utf8');
      }
      if (file.compiled !== undefined) {
        const compiledPath = join(compiledDirectory, `${file.name}.test.js`);
        await mkdir(dirname(compiledPath), { recursive: true });
        await writeFile(compiledPath, file.compiled, 'utf8');
      }
    }
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [ADVERSARIAL_RUNNER], {
      cwd: root,
      encoding: 'utf8',
      env: environment,
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      status: result.status,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
      error: result.error,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('[adversarial] dedicated runner rejects false-green source and execution states', async (t) => {
  const active = [
    "import { test } from 'node:test';",
    "test('[adversarial] future source attack', () => {});",
    '',
  ].join('\n');
  const ordinary = [
    "import { test } from 'node:test';",
    "test('ordinary behavior', () => {});",
    '',
  ].join('\n');
  const failures: readonly [string, readonly RunnerFixtureFile[], RegExp][] = [
    ['marker occurs only in a comment', [{
      name: 'comment-only',
      source: "// test('[adversarial] comment is not a test', () => {});\n",
      compiled: "// test('[adversarial] comment is not a test', () => {});\n",
    }], /No runnable \[adversarial\] source tests found/],
    ['only declaration is test.skip', [{
      name: 'skip-only',
      source: "import { test } from 'node:test';\ntest.skip('[adversarial] skipped attack', () => {});\n",
      compiled: "import { test } from 'node:test';\ntest.skip('[adversarial] skipped attack', () => {});\n",
    }], /Tagged source skip-only\.test\.ts failed adversarial TAP requirements/],
    ['valid tagged file cannot mask skip and todo declarations', [
      { name: 'active', source: active, compiled: active },
      {
        name: 'disabled-skip',
        source: "import { test } from 'node:test';\ntest.skip('[adversarial] skipped attack', () => {});\n",
        compiled: "import { test } from 'node:test';\ntest.skip('[adversarial] skipped attack', () => {});\n",
      },
      {
        name: 'disabled-todo',
        source: "import { test } from 'node:test';\ntest.todo('[adversarial] todo attack');\n",
        compiled: "import { test } from 'node:test';\ntest.todo('[adversarial] todo attack');\n",
      },
    ], /Tagged source disabled-skip\.test\.ts failed adversarial TAP requirements/],
    ['nested disabled declaration cannot disappear behind a valid root file', [
      { name: 'active', source: active, compiled: active },
      {
        name: 'nested/disabled',
        source: "import { test } from 'node:test';\ntest.todo('[adversarial] nested todo attack');\n",
        compiled: "import { test } from 'node:test';\ntest.todo('[adversarial] nested todo attack');\n",
      },
    ], /Tagged source nested\/disabled\.test\.ts failed adversarial TAP requirements/],
    ['tagged declaration registers zero matching tests', [{
      name: 'zero-matches',
      source: "import { test } from 'node:test';\nif (false) test('[adversarial] unreachable attack', () => {});\n",
      compiled: "import { test } from 'node:test';\nif (false) test('[adversarial] unreachable attack', () => {});\n",
    }], /contributed zero passing \[adversarial\] tests/],
    ['stale compiled marker has no tagged source', [{
      name: 'stale-output',
      source: ordinary,
      compiled: active,
    }], /Stale compiled \[adversarial\] marker/],
    ['tagged source has no compiled counterpart', [{
      name: 'missing-output',
      source: active,
    }], /Missing compiled counterpart/],
    ['tagged file contributes only a skipped result', [{
      name: 'zero-passes',
      source: "import { test } from 'node:test';\ntest('[adversarial] runtime-skipped attack', { skip: true }, () => {});\n",
      compiled: "import { test } from 'node:test';\ntest('[adversarial] runtime-skipped attack', { skip: true }, () => {});\n",
    }], /failed adversarial TAP requirements/],
  ];

  for (const [name, files, expected] of failures) {
    await t.test(`[adversarial] ${name}`, async () => {
      const result = await runAdversarialRunnerFixture(files);
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0, result.output);
      assert.match(result.output, expected);
    });
  }
});

test('[adversarial] dedicated runner auto-discovers future source files and reports positive TAP totals', async () => {
  const source = (name: string) => [
    "import { test } from 'node:test';",
    `test('[adversarial] ${name}', () => {});`,
    '',
  ].join('\n');
  const result = await runAdversarialRunnerFixture([
    { name: 'alpha/shared', source: source('future alpha'), compiled: source('future alpha') },
    { name: 'zeta/shared', source: source('future zeta'), compiled: source('future zeta') },
  ]);

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Adversarial source files: 2/);
  assert.match(result.output, /alpha\/shared\.test\.ts: tests 1, pass 1, fail 0, cancelled 0, skipped 0, todo 0/);
  assert.match(result.output, /zeta\/shared\.test\.ts: tests 1, pass 1, fail 0, cancelled 0, skipped 0, todo 0/);
  assert.match(
    result.output,
    /Adversarial aggregate: files 2, tests 2, pass 2, fail 0, cancelled 0, skipped 0, todo 0/,
  );
});
