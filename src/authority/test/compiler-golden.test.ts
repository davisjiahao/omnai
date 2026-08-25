import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import YAML from 'yaml';
import { z } from 'zod';
import {
  hashStrictObject,
  stageAuthorityCatalogV1Schema,
  type StageAuthorityCatalogV1,
} from '../catalog-schema.js';
import { hashUtf8, instantiateEvidenceTemplate, parseCompilerInput } from '../compiler-runtime.js';
import { compileCanaryPolicyByScenario } from '../compilers/canary-policy-by-scenario.js';
import { compileDeliveryPolicy } from '../compilers/delivery-policy.js';
import { compilePromptRender } from '../compilers/prompt-render.js';
import { compileQaPolicyByScenario } from '../compilers/qa-policy-by-scenario.js';
import { compileReviewPolicy } from '../compilers/review-policy.js';
import { compileRunDescendants } from '../compilers/run-descendants.js';
import { compileScenarioDetection } from '../compilers/scenario-detection.js';
import { compileStageCompletion } from '../compilers/stage-completion.js';
import { compileAuthenticatedStageTerminal as compileStageTerminal } from '../compilers/stage-terminal.js';
import * as stageTerminalCompiler from '../compilers/stage-terminal.js';
import { compileVerifyScenarioTaskEvidence } from '../compilers/verify-scenario-task-evidence.js';
import {
  changeMetadataSchema,
  repositoryWorkBasisSchema,
  taskFileSchema,
  type ChangeMetadata,
  type RepositoryWorkBasis,
  type TaskFile,
} from '../../domain/change.js';
import { archiveGateSnapshotSchema } from '../../domain/run.js';

let catalog: StageAuthorityCatalogV1;

async function authorityCatalog(): Promise<StageAuthorityCatalogV1> {
  if (catalog !== undefined) return catalog;
  const raw = await readFile(join(
    process.cwd(),
    'src',
    'authority',
    'test',
    'fixtures',
    'stage-authority-catalog-v1.yaml',
  ), 'utf8');
  catalog = stageAuthorityCatalogV1Schema.parse(YAML.parse(raw));
  return catalog;
}

function frozenClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  return Object.freeze(value);
}

function assertDeterministic<Input, Output>(compiler: (input: Input) => Output, input: Input): Output {
  const first = compiler(frozenClone(input));
  const second = compiler(frozenClone(input));
  assert.deepEqual(first, second);
  assert.equal(hashStrictObject(first), hashStrictObject(second));
  return first;
}

// 背景：目录已经声明十个规范 compilerId，但 Task 4 开始前没有任何对应的可执行纯函数。
// 目的：这个首个 RED 只证明十个公开 reference compiler 缺失，避免先写实现再反推测试 API。
// 上下文：后续测试会在同一文件逐个锁定黄金对象、哈希、字段敏感性与严格拒绝边界。
test('exact 十个 StageCompilerArtifactId 都有唯一纯函数入口', () => {
  assert.deepEqual([
    compileStageTerminal,
    compileStageCompletion,
    compileRunDescendants,
    compileReviewPolicy,
    compileQaPolicyByScenario,
    compileCanaryPolicyByScenario,
    compileVerifyScenarioTaskEvidence,
    compileDeliveryPolicy,
    compileScenarioDetection,
    compilePromptRender,
  ].map((compiler) => typeof compiler), Array.from({ length: 10 }, () => 'function'));
});

// 该测试会在 Zod 先读取 getter、接受自定义 prototype 或让 hostile raw graph 绕过 strict JSON 时失败。
test('所有 compiler 在字段读取前拒绝 accessor hostile input', () => {
  let getterRead = false;
  const hostile = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(hostile, 'query', {
    enumerable: true,
    get() {
      getterRead = true;
      return 'should never execute';
    },
  });
  assert.throws(() => compileScenarioDetection(hostile));
  assert.equal(getterRead, false);
});

// 背景：compiler preflight 虽用 descriptor walk，却在每个节点先执行 getPrototypeOf/ownKeys；
// transparent Proxy 因而可进入 clone/schema，throwing Proxy 则执行 caller trap。目的：真实纯
// compiler 对 root/nested/revoked Proxy 全部在零 trap 下拒绝。上下文：输入来自认证 catalog 的
// plain clone；预期不通过 mock 构造，确保 parseCompilerInput 的共享边界被实际执行。
test('compiler preflight 零 trap 拒绝 transparent、throwing、revoked root/nested Proxy', async () => {
  const current = await authorityCatalog();
  const input = {
    query: 'public SDK architecture review',
    profiles: current.scenarioProfiles,
    policy: current.scenarioDetectionPolicy,
  };
  assert.throws(() => compileScenarioDetection(new Proxy(structuredClone(input), {})));
  assert.throws(() => compileScenarioDetection({
    ...structuredClone(input),
    policy: new Proxy(structuredClone(input.policy), {}),
  }));

  for (const nested of [false, true]) {
    let traps = 0;
    const proxy = new Proxy(structuredClone(input.policy), {
      getPrototypeOf() { traps += 1; throw new Error('HOSTILE_COMPILER_PROTOTYPE'); },
      ownKeys() { traps += 1; throw new Error('HOSTILE_COMPILER_KEYS'); },
      getOwnPropertyDescriptor() { traps += 1; throw new Error('HOSTILE_COMPILER_DESCRIPTOR'); },
      get() { traps += 1; throw new Error('HOSTILE_COMPILER_GET'); },
    });
    const value = nested ? { ...structuredClone(input), policy: proxy } : proxy;
    assert.throws(() => compileScenarioDetection(value));
    assert.equal(traps, 0, nested ? 'nested' : 'root');
  }

  const revoked = Proxy.revocable(structuredClone(input), {});
  revoked.revoke();
  assert.throws(() => compileScenarioDetection(revoked.proxy));
});

// 该 RED 会在 Stage terminal 仍允许 caller 自报 template，或认证入口没有拿完整 catalog
// 反向投影 Artifact/Evidence/HumanGate 行时失败。公开测试只寻找认证 wrapper，不触碰内部 ABI。
test('stage-terminal 公开入口必须是 catalog 认证 wrapper', async () => {
  const current = await authorityCatalog();
  const compiler = Reflect.get(stageTerminalCompiler, 'compileAuthenticatedStageTerminal');
  assert.equal(typeof compiler, 'function');
  if (typeof compiler !== 'function') return;
  const fixture = terminalCompilerFixture(current, 'experiment');
  const input = { ...fixture.input };
  Reflect.deleteProperty(input, 'template');
  const terminal = compiler(input);
  assert.equal(Reflect.get(terminal, 'kind'), 'ARTIFACT_STAGE');
});

// 该 RED 会在 compiler clone 前没有累计所有 UTF-8 字符串与疑似 Base64 估算时失败；
// 预检必须在任何 schema transform/decode 前给出稳定预算错误，而不是先分配巨型 Buffer。
test('compiler 输入在 clone/schema 前执行 descriptor-only 字节预算', () => {
  const exact32MiBBase64 = `${'A'.repeat(44_739_243)}=`;
  const parsed = parseCompilerInput(
    z.strictObject({ rawBytesBase64: z.string() }),
    { rawBytesBase64: exact32MiBBase64 },
  );
  assert.equal(parsed.rawBytesBase64.length, 44_739_244);
  const suspiciousBase64 = 'A'.repeat(44_739_244);
  assert.throws(
    () => parseCompilerInput(z.strictObject({ rawBytesBase64: z.string() }), { rawBytesBase64: suspiciousBase64 }),
    /Base64.*32 MiB|32 MiB.*Base64/u,
  );
  assert.throws(
    () => compileStageCompletion({ mode: 'VALIDATE', rawBytesBase64: suspiciousBase64 }),
    /Base64.*32 MiB|32 MiB.*Base64/u,
  );
  assert.throws(
    () => parseCompilerInput(z.array(z.strictObject({ rawBytesBase64: z.string() })), [
      ...Array.from({ length: 4 }, () => ({ rawBytesBase64: exact32MiBBase64 })),
      { rawBytesBase64: 'AAAA' },
    ]),
    /aggregate.*128 MiB|128 MiB.*aggregate/u,
  );
});

// 该测试会在 detector 偷偷恢复固定候选顺序、重复计分或 fallback 旁路时失败。
test('scenario-detection 锁定 UTF-16 计分、架构 override、排序与 fallback', async () => {
  const current = await authorityCatalog();
  const architecture = assertDeterministic(compileScenarioDetection, {
    query: 'public SDK architecture review',
    profiles: current.scenarioProfiles,
    policy: current.scenarioDetectionPolicy,
  });
  assert.equal(hashStrictObject(architecture), 'sha256:93cd5641cb726226a6a514dea67e02095649489fb61534e7ba938150112c1ddf');
  assert.equal(architecture.scenarioId, 'shared-library');
  assert.deepEqual(
    architecture.scores.slice(0, 3).map(({ scenarioId }) => scenarioId),
    ['architecture-governance', 'shared-library', 'system-query'],
  );
  assert.equal(compileScenarioDetection({
    query: 'no catalog signal at all',
    profiles: current.scenarioProfiles,
    policy: current.scenarioDetectionPolicy,
  }).scenarioId, 'small-feature');
  assert.throws(() => compileScenarioDetection({
    query: 'anything',
    profiles: current.scenarioProfiles,
    policy: { ...current.scenarioDetectionPolicy, fallbackScenarioId: 'bug-fix' },
  }));
});

// 该测试会在 Review compiler 接受 caller check list、漏掉影响维度或不稳定排序时失败。
test('review-policy 逐字段推导三个 exact sorted check 轴', async () => {
  const current = await authorityCatalog();
  const scenario = current.scenarioProfiles.find(({ id }) => id === 'architecture-governance')!;
  const input = {
    scenario,
    risk: {
      level: 'P1',
      dimensions: {
        businessCriticality: 'HIGH', data: 'HIGH', compatibility: 'HIGH',
        reversibility: 'HIGH', security: 'HIGH', operational: 'HIGH',
      },
    },
    impact: {
      frontend: true, backend: true, apiContract: true, database: true,
      mq: true, remoteService: true, security: true, observability: true,
    },
  };
  const policy = assertDeterministic(compileReviewPolicy, input);
  assert.equal(hashStrictObject(policy), 'sha256:528da4c5fe9c36a8519396b5ba6c8316e41768ebea4b71ac825714648332e457');
  assert.deepEqual(policy, {
    schemaVersion: 1,
    specification: ['non-goals', 'observable-behavior', 'requirements'],
    standards: ['architecture', 'business', 'contract', 'data', 'domain', 'engineering', 'performance', 'security', 'ux'],
    riskProduction: ['migration', 'operability', 'rollback-forward-fix', 'runtime-health'],
  });
  const changed = compileReviewPolicy({ ...input, impact: { ...input.impact, frontend: false } });
  assert.notEqual(hashStrictObject(policy), hashStrictObject(changed));
  assert.throws(() => compileReviewPolicy({ ...input, callerChecks: ['engineering'] } as never));
});

// 该测试会在 QA compiler 内嵌第二份 policy、选择缺失时 default 或接受未排序 rows 时失败。
test('qa-policy-by-scenario 只投影 exact catalog row 且无 default', async () => {
  const current = await authorityCatalog();
  const input = {
    scenarioId: 'product-discovery',
    policies: current.qaPoliciesByScenario,
  };
  const qaPolicy = assertDeterministic(compileQaPolicyByScenario, input);
  assert.equal(hashStrictObject(qaPolicy), 'sha256:97e9ce78b7a36dfcfc9ce86fc740e960db2bb133b1aac2a6bb17ddfbede02c7f');
  assert.deepEqual(qaPolicy, {
    schemaVersion: 1,
    checks: [
      { checkId: 'product-acceptance', evidenceRequirementIds: ['product-acceptance'] },
      { checkId: 'runtime-readiness', evidenceRequirementIds: ['runtime-signal'] },
    ],
    findingVerdicts: { CRITICAL: 'FAIL', IMPORTANT: 'CONCERNS', MINOR: 'PASS' },
  });
  assert.throws(() => compileQaPolicyByScenario({ ...input, scenarioId: 'bug-fix' }));
  assert.throws(() => compileQaPolicyByScenario({ ...input, policies: [...input.policies].reverse() }));
});

// 该测试会在 Canary compiler 忽略同 Revision ship 前置、改写 opening time 或制造空 policy 时失败。
test('canary-policy-by-scenario 绑定同 Revision ship 与 Core time', async () => {
  const current = await authorityCatalog();
  const input = {
    scenarioId: 'product-discovery',
    policies: current.canaryPoliciesByScenario,
    ship: completedShipAuthority(current),
    coreTime: '2026-08-24T00:05:00.000Z',
  };
  const result = assertDeterministic(compileCanaryPolicyByScenario, input);
  assert.equal(hashStrictObject(result), 'sha256:5cc7c0d2d1e98c2516b822e0996b80a5df911e7268af9bf186a2150d39d1db52');
  assert.equal(result.windowOpenedAt, input.coreTime);
  // persistent catalog row 是 null-prototype authenticated output，而 compiler 的既有
  // presentation contract 是普通 JSON object；structuredClone 只在测试侧物化同一
  // JSON expected，不调用 production clone helper 推导结果。
  assert.deepEqual(result.policy, structuredClone(current.canaryPoliciesByScenario.find(
    ({ scenarioId }) => scenarioId === input.scenarioId,
  )!.policy));
  assert.throws(() => compileCanaryPolicyByScenario({
    ...input,
    ship: { ...input.ship, changeId: 'CHG-0002' },
  }));
  assert.throws(() => compileCanaryPolicyByScenario({
    ...input,
    ship: { ...input.ship, completedAt: '2026-08-24T00:06:00.000Z' },
  }));
  assert.throws(() => compileCanaryPolicyByScenario({ ...input, scenarioId: 'bug-fix' }));
});

// 该回归会在 Canary 继续接受缩减 ship 投影，或未绑定 Change/Run/完成入口/交付产物时失败。
test('canary-policy-by-scenario 只接受完整 CompletedShipAuthority', async () => {
  const current = await authorityCatalog();
  const ship = completedShipAuthority(current);
  const result = compileCanaryPolicyByScenario({
    scenarioId: 'product-discovery',
    policies: current.canaryPoliciesByScenario,
    ship,
    coreTime: '2026-08-24T00:05:00.000Z',
  });
  assert.equal(result.windowOpenedAt, '2026-08-24T00:05:00.000Z');
  assert.deepEqual(result.policy, structuredClone(current.canaryPoliciesByScenario.find(
    ({ scenarioId }) => scenarioId === 'product-discovery',
  )!.policy));
});

const SHA_A = `sha256:${'a'.repeat(64)}` as const;
const SHA_B = `sha256:${'b'.repeat(64)}` as const;
const SHA_C = `sha256:${'c'.repeat(64)}` as const;
const TEST_ISSUE_STATE_SCHEMA = z.strictObject({
  triageState: z.enum(['needs-info', 'ready-for-debug', 'ready-for-fix', 'needs-experiment', 'ready-for-human', 'wontfix']),
  reproduction: z.enum(['unknown', 'confirmed', 'not-reproducible', 'instrumentation-required']),
  rootCause: z.enum(['unknown', 'suspected', 'confirmed']),
  fixStrategy: z.enum(['unknown', 'ready', 'needs-experiment']),
});
const BASIS = {
  objectFormat: 'sha1',
  headCommit: '1'.repeat(40),
  indexTreeHash: '2'.repeat(40),
  workingPatchHash: SHA_A,
  eligibleUntrackedInventoryHash: SHA_B,
} as const;

function completedShipAuthority(current: StageAuthorityCatalogV1) {
  const artifactIdentity = {
    schemaVersion: 1,
    workflowVersion: '0.3.0',
    authorityCatalogHash: hashStrictObject(current),
    changeId: 'CHG-0001',
    revision: 'REV-0001',
    repositoryBasis: BASIS,
    repositoryBasisHash: hashStrictObject(BASIS),
    delivery: {
      artifactAuthorityEntryId: 'ship:DELIVERY',
      role: 'DELIVERY',
      path: 'delivery.md',
      rawBytesHash: SHA_C,
    },
  } as const;
  return {
    schemaVersion: 1,
    changeId: 'CHG-0001',
    revision: 'REV-0001',
    capability: 'ship',
    terminalKind: 'DELIVERY_STAGE',
    disposition: 'COMPLETED',
    shipRunId: 'RUN-000009',
    completionSequence: 9,
    completionEntryHash: SHA_B,
    completedAt: '2026-08-24T00:00:00.000Z',
    artifactIdentity,
    artifactIdentityHash: hashStrictObject(artifactIdentity),
  } as const;
}
const SOURCE_TASK_FILE = {
  schemaVersion: 1,
  revision: 'REV-0001',
  generatedFrom: ['design.md'],
  tasks: [{
    id: 'TASK-001',
    title: '实现权限编译器',
    objective: '建立可审计的纯函数权限边界',
    status: 'IMPLEMENTED',
    dependsOn: [],
    slice: 'CONTRACT_FIRST',
    risk: 'HIGH',
    files: { create: ['src/compiler.ts'], modify: [], tests: ['src/test/compiler.test.ts'] },
    consumes: ['design'],
    produces: ['compiler'],
    steps: ['实现并验证'],
    evidenceRequired: ['task-behavior'],
    notes: ['保持纯函数'],
  }],
} as const;
const ACTIVE_ROUTE = {
  schemaVersion: 1,
  scenarioId: 'small-feature',
  requiredCapabilities: ['plan', 'work', 'verify'],
  selectedOptionalCapabilities: [],
  activeCapabilities: ['plan', 'work', 'verify'],
  implementationRequired: true,
} as const;

// 该测试会在 Delivery compiler 接受自选 Evidence/gate、遗漏任一三联证据或复制 gate 时失败。
test('delivery-policy exact 投影三项 Evidence 与唯一 human gate', async () => {
  const current = await authorityCatalog();
  const input = {
    mode: 'PREPARE',
    evidenceRequirementIds: ['delivery-contract', 'delivery-rollback', 'delivery-runtime'],
    humanGateIds: ['delivery-approval'],
    evidenceTemplates: current.evidenceTemplates,
    humanGateTemplates: current.humanGateTemplates,
  };
  const result = assertDeterministic(compileDeliveryPolicy, input);
  assert.equal(hashStrictObject(result), 'sha256:9a2e5658163ec4f62aa0dfe346ca219ea42e2c9a635a4f13713f6fb380c7f032');
  assert.deepEqual(result, {
    mode: 'PREPARE',
    fragment: {
      evidenceRequirements: [
        {
          requirementId: 'delivery-contract', producer: 'GENERIC_IMPORT', allowedTypes: ['contract'],
          allowedStatuses: ['FAIL', 'INCONCLUSIVE', 'PASS'], satisfyingStatus: 'PASS',
          outputPolicy: 'OWNED_OUTPUT_REQUIRED', sourceScope: 'RUN_BOUND', subjectPolicy: 'EXACT_RUN_SUBJECT',
          taskScope: { kind: 'NONE' }, minimumRecords: 1,
        },
        {
          requirementId: 'delivery-rollback', producer: 'GENERIC_IMPORT', allowedTypes: ['rollback'],
          allowedStatuses: ['FAIL', 'INCONCLUSIVE', 'PASS'], satisfyingStatus: 'PASS',
          outputPolicy: 'OWNED_OUTPUT_REQUIRED', sourceScope: 'RUN_BOUND', subjectPolicy: 'EXACT_RUN_SUBJECT',
          taskScope: { kind: 'NONE' }, minimumRecords: 1,
        },
        {
          requirementId: 'delivery-runtime', producer: 'GENERIC_IMPORT', allowedTypes: ['runtime'],
          allowedStatuses: ['FAIL', 'INCONCLUSIVE', 'PASS'], satisfyingStatus: 'PASS',
          outputPolicy: 'OWNED_OUTPUT_REQUIRED', sourceScope: 'RUN_BOUND', subjectPolicy: 'EXACT_RUN_SUBJECT',
          taskScope: { kind: 'NONE' }, minimumRecords: 1,
        },
      ],
      evidenceRequirementsHash: 'sha256:9990e4a20df246a15d28b1562ba1c7b439a3740f33dbf38e9445259e7c0da028',
      requiredHumanGates: [{
        gateId: 'delivery-approval', sourceScope: 'RUN_BOUND', approvedArtifactRole: 'DELIVERY',
      }],
    },
  });
  assert.throws(() => compileDeliveryPolicy({
    ...input,
    evidenceRequirementIds: ['delivery-contract', 'delivery-runtime', 'delivery-rollback'],
  }));
});

// 该测试会在 Verify 漏掉 Task-declared contract、重复 Task、保留 IMPLEMENTED 或改写非状态字段时失败。
test('verify compiler 固化 distinct Task set、证据 bindings 与 DONE target TaskFile', async () => {
  const current = await authorityCatalog();
  const input = {
    scenarioRequiredEvidence: ['build'],
    taskFile: SOURCE_TASK_FILE,
    taskEvidenceRequirementIds: current.taskEvidenceRequirementIds,
    evidenceTemplates: current.evidenceTemplates,
    verifiedBasis: BASIS,
    activeRoute: ACTIVE_ROUTE,
  };
  const fragment = assertDeterministic(compileVerifyScenarioTaskEvidence, input);
  assert.equal(hashStrictObject(fragment), 'sha256:45dcf4ad8df13c4b0ea560be4ff823a962949cfbc102663f2763bd06cac7bf73');
  assert.deepEqual(fragment.verificationTaskIds, ['TASK-001']);
  assert.deepEqual(fragment.verificationTaskRequirements, [
    { taskId: 'TASK-001', requirementIds: ['task-behavior'] },
  ]);
  assert.deepEqual(fragment.evidenceRequirements.map(({ requirementId, taskScope }) => ({
    requirementId,
    taskScope: taskScope.kind,
  })), [
    { requirementId: 'build', taskScope: 'NONE' },
    { requirementId: 'task-behavior', taskScope: 'TASK_DECLARED' },
  ]);
  assert.equal(fragment.targetTaskFile.tasks[0]!.status, 'DONE');
  assert.deepEqual(
    { ...fragment.targetTaskFile.tasks[0], status: SOURCE_TASK_FILE.tasks[0].status },
    SOURCE_TASK_FILE.tasks[0],
  );
  assert.equal(fragment.sourceTasksHash, hashStrictObject(SOURCE_TASK_FILE));
  assert.equal(fragment.targetTasksHash, hashStrictObject(fragment.targetTaskFile));
  assert.throws(() => compileVerifyScenarioTaskEvidence({
    ...input,
    taskFile: { ...SOURCE_TASK_FILE, tasks: [{ ...SOURCE_TASK_FILE.tasks[0], evidenceRequired: [] }] },
  }));
  assert.throws(() => compileVerifyScenarioTaskEvidence({
    ...input,
    activeRoute: { ...ACTIVE_ROUTE, implementationRequired: false },
  }));
});

// 该回归会在 Scenario 分区能够借用 TASK_DECLARED 名称并被 Task 映射吞并时失败。
test('verify compiler 拒绝 Scenario 与 exact7 TASK_DECLARED Evidence 命名空间夹带', async () => {
  const current = await authorityCatalog();
  assert.throws(() => compileVerifyScenarioTaskEvidence({
    scenarioRequiredEvidence: ['task-behavior'],
    taskFile: SOURCE_TASK_FILE,
    taskEvidenceRequirementIds: current.taskEvidenceRequirementIds,
    evidenceTemplates: current.evidenceTemplates,
    verifiedBasis: BASIS,
    activeRoute: ACTIVE_ROUTE,
  }));
});

// 背景：DONE/SUPERSEDED/CANCELLED 不参与本次 verification minimum，但完整 targetTaskFile
// 仍会保留它们的 Evidence policy。目的：分别证明三种 inactive 状态不能借状态筛选绕过 exact7
// TASK_DECLARED registry；unknown 与 catalog 中真实 NONE-scoped `build` 各形成一个独立 RED。
for (const inactiveStatus of ['DONE', 'SUPERSEDED', 'CANCELLED'] as const) {
  for (const invalidPolicy of [
    { label: 'unknown', evidenceRequired: ['zzz-inactive-unknown'] },
    { label: 'wrong-scope', evidenceRequired: ['build'] },
  ] as const) {
    test(`verify compiler 拒绝 ${inactiveStatus} Task 的 ${invalidPolicy.label} Evidence policy`, async () => {
      const current = await authorityCatalog();
      assert.throws(() => compileVerifyScenarioTaskEvidence({
        scenarioRequiredEvidence: ['build'],
        taskFile: {
          ...SOURCE_TASK_FILE,
          tasks: [{
            ...SOURCE_TASK_FILE.tasks[0], status: inactiveStatus,
            evidenceRequired: [...invalidPolicy.evidenceRequired],
          }],
        },
        taskEvidenceRequirementIds: current.taskEvidenceRequirementIds,
        evidenceTemplates: current.evidenceTemplates,
        verifiedBasis: BASIS,
        activeRoute: { ...ACTIVE_ROUTE, implementationRequired: false },
      }), /invalid Evidence policy|TASK_DECLARED registry/u);
    });
  }
}

// 背景：inactive Task 没有本次 verification minimum；修复不能误把“全体 membership 校验”
// 扩成“全体必须非空”。目的：三种状态以 empty Evidence policy 同时保留在完整 targetTaskFile，
// 且不进入 verification Task set/mapping，锁定 inactive empty 的规范 positive。
test('verify compiler 保留三类 inactive empty Task 且不制造 verification minimum', async () => {
  const current = await authorityCatalog();
  const inactiveTaskFile = {
    ...SOURCE_TASK_FILE,
    tasks: (['DONE', 'SUPERSEDED', 'CANCELLED'] as const).map((status, index) => ({
      ...SOURCE_TASK_FILE.tasks[0],
      id: `TASK-${String(index + 1).padStart(3, '0')}`,
      status,
      evidenceRequired: [],
    })),
  };
  const fragment = compileVerifyScenarioTaskEvidence({
    scenarioRequiredEvidence: ['build'],
    taskFile: inactiveTaskFile,
    taskEvidenceRequirementIds: current.taskEvidenceRequirementIds,
    evidenceTemplates: current.evidenceTemplates,
    verifiedBasis: BASIS,
    activeRoute: { ...ACTIVE_ROUTE, implementationRequired: false },
  });
  assert.deepEqual(fragment.verificationTaskIds, []);
  assert.deepEqual(fragment.verificationTaskRequirements, []);
  assert.deepEqual(fragment.targetTaskFile, inactiveTaskFile);
  assert.equal(fragment.sourceTasksHash, hashStrictObject(inactiveTaskFile));
  assert.equal(fragment.targetTasksHash, hashStrictObject(inactiveTaskFile));
});

// 该测试会在 descendant compiler 错映 producer/count/scope、漏掉 WORK automaton 或 ISSUE-last 语法时失败。
test('run-descendants exact 编译 COUNTED、TASK_WORK_SEQUENCE 与 ISSUE_FINALIZATION_SEQUENCE', async () => {
  const current = await authorityCatalog();
  const workCheck = current.evidenceTemplates.find(({ requirementId }) => requirementId === 'work-check')!;
  const evidenceRequirement = {
    requirementId: workCheck.requirementId,
    producer: workCheck.producer,
    allowedTypes: workCheck.allowedTypes,
    allowedStatuses: workCheck.allowedStatuses,
    satisfyingStatus: workCheck.satisfyingStatus,
    outputPolicy: workCheck.outputPolicy,
    sourceScope: workCheck.sourceScope,
    subjectPolicy: workCheck.subjectPolicy,
    taskScope: { kind: 'SELECTED_TASK' },
    minimumRecordsPerTask: 1,
  } as const;
  const lineage = { kind: 'ROOT', rootRunId: 'RUN-000001', abandonedFailureRunId: null } as const;
  const workTerminal = {
    kind: 'WORK_STAGE',
    taskId: 'TASK-001',
    sourceTasksHash: hashStrictObject(SOURCE_TASK_FILE),
    sourceTaskHash: hashStrictObject(SOURCE_TASK_FILE.tasks[0]),
    basis: BASIS,
    repositoryLineage: lineage,
    repositoryLineageHash: hashStrictObject(lineage),
    allowedRepositoryPaths: ['src/compiler.ts', 'src/test/compiler.test.ts'],
    allowedRepositoryPathsHash: hashStrictObject(['src/compiler.ts', 'src/test/compiler.test.ts']),
    requiredTaskStatus: 'IMPLEMENTED',
    requiredRepositoryDelta: 'NON_EMPTY',
    negativeEvidenceRecovery: {
      kind: 'RESET_SELECTED_TASK_TO_READY',
      allowedSourceStatuses: ['READY', 'RUNNING', 'BLOCKED', 'IMPLEMENTED'],
      targetStatus: 'READY',
      preserveAllOtherTaskFileFields: true,
    },
    evidenceRequirements: [evidenceRequirement],
    evidenceRequirementsHash: hashStrictObject([evidenceRequirement]),
  } as const;
  const rows = assertDeterministic(compileRunDescendants, {
    runId: 'RUN-000001', terminal: workTerminal,
    evidenceRequirements: [evidenceRequirement], humanGates: [],
  });
  assert.equal(hashStrictObject(rows), 'sha256:6f9d40f1a2c8ca7ca5f40557ce3579c8a2a64f2115924d3f840d1517867f0952');
  assert.deepEqual(rows, [
    {
      kind: 'TASK_WORK_SEQUENCE', ownerKind: 'TASK_WORK',
      binding: { kind: 'TASK_ID', taskId: 'TASK-001' },
      grammar: 'START (BLOCK START)* IMPLEMENTED', sourceStatus: 'READY', terminalStatus: 'IMPLEMENTED',
    },
    {
      kind: 'COUNTED', ownerKind: 'VERIFICATION_COMMAND',
      binding: { kind: 'EVIDENCE_REQUIREMENT', requirementId: 'work-check', taskId: 'TASK-001' },
      minimum: 1, maximum: 1,
    },
  ]);
  const issueTerminal = {
    kind: 'ISSUE_STAGE', sourceIssueHash: SHA_C, observedBasis: BASIS,
    requiredIssuePredicates: [{ kind: 'TRIAGE_STATE_IN', values: [
      'needs-experiment', 'ready-for-debug', 'ready-for-fix', 'ready-for-human', 'wontfix',
    ] }],
    evidenceRequirements: [], evidenceRequirementsHash: hashStrictObject([]),
  } as const;
  assert.deepEqual(compileRunDescendants({
    runId: 'RUN-000001', terminal: issueTerminal,
    evidenceRequirements: [], humanGates: [],
  }), [{
    kind: 'ISSUE_FINALIZATION_SEQUENCE', ownerKind: 'ISSUE_UPDATE', binding: { kind: 'RUN_ONLY' },
    grammar: 'ALL_REQUIRED_EVIDENCE_PASS THEN ISSUE_UPDATE_LAST', actionKind: 'TRIAGE_RESULT',
  }]);
});

// 背景：Verify mapping 不是仅一个 TaskId set；它同时冻结每个 Task 宣告的
// exact TASK_DECLARED Evidence 权限。目的：run-descendants 必须拒绝删除冻结 ID、
// 添加未知/非 TASK_DECLARED ID，以及与 targetTaskFile.evidenceRequired 不一致的映射。
test('run-descendants 拒绝未与 target Task/Evidence contract exact 闭合的 Verify mapping', async () => {
  const current = await authorityCatalog();
  for (const mutation of verifyMappingMutationFixtures(current)) {
    assert.throws(() => {
      compileRunDescendants({
        runId: 'RUN-000001', terminal: mutation.terminal,
        evidenceRequirements: mutation.terminal.evidenceRequirements,
        humanGates: mutation.terminal.requiredHumanGates,
      });
    }, /Run descendant compiler.*Verify mapping|Run descendant compiler.*TASK_DECLARED/u, mutation.label);
  }
});

// 背景：stage-completion 与 descendant compiler 必须使用同一份 Verify mapping
// 闭包；否则 caller 可同步修改 manifest/descendant/Evidence hash 让缺失映射自洽。
// 目的：四类变异都构造完整 authenticated context，旧的 TaskId-only 校验不得通过。
test('stage-completion 拒绝自洽但不 exact 的 Verify Task/requirement mapping', async () => {
  const current = await authorityCatalog();
  const base = positiveCompletionFixture(current, 'verify');
  for (const mutation of verifyMappingMutationFixtures(current)) {
    assert.throws(() => {
      compileStageCompletion({
        mode: 'VALIDATE', authorityCatalog: current, request: base.request,
        context: verifyCompletionContextWithMappingMutation(base, mutation),
      });
    }, /Stage completion compiler.*Verify mapping|Stage completion compiler.*TASK_DECLARED/u, mutation.label);
  }
});

function planCompilerInput(current: StageAuthorityCatalogV1) {
  const template = current.capabilityTemplates.find(({ capability }) => capability === 'plan')!;
  return {
    authorityCatalog: current,
    capability: template.capability,
    changeTitle: 'Native Schema',
    sealedArtifactRenders: [],
    identity: { changeId: 'CHG-0001', revision: 'REV-0001', runId: 'RUN-000001' },
    source: {
      authorityHead: SHA_A,
      metadataHash: SHA_B,
      currentRisk: { level: 'P2', dimensions: {
        businessCriticality: 'MEDIUM', data: 'LOW', compatibility: 'LOW',
        reversibility: 'LOW', security: 'LOW', operational: 'LOW',
      } },
      currentImpact: {
        frontend: false, backend: true, apiContract: false, database: false,
        mq: false, remoteService: false, security: false, observability: false,
      },
      activeRoute: ACTIVE_ROUTE,
      activeRouteHash: hashStrictObject(ACTIVE_ROUTE),
      tasksHash: hashStrictObject(SOURCE_TASK_FILE),
      taskFile: SOURCE_TASK_FILE,
      issueHash: null,
      issueState: null,
      repositoryBasis: null,
      repositoryRetryState: null,
      repositoryRetryStartResult: null,
      archiveGateSnapshot: null,
    },
    selection: { taskId: null, retryRunId: null, reviewScope: null },
    outputBindings: [{
      kind: 'TASKFILE_DRAFT', role: 'TASKFILE_DRAFT',
      path: 'stage-outputs/RUN-000001/tasks.draft.yaml',
    }],
    evidenceRequirements: [],
    humanGates: [],
    policies: { review: null, qa: null, canary: null },
    verify: null,
    delivery: null,
    ship: null,
    coreTime: '2026-08-24T00:05:00.000Z',
  };
}

// 该测试会在 stage-terminal 以 capability switch 的 default 制造 terminal、忽略 output 或 route 时失败。
test('stage-terminal 从 exact capability template 编译 PLAN terminal 且闭合动态绑定', async () => {
  const current = await authorityCatalog();
  const input = planCompilerInput(current);
  const terminal = assertDeterministic(compileStageTerminal, input);
  assert.equal(hashStrictObject(terminal), 'sha256:1e76c9095bdda79b92d723d98ef15944b49a67dc71d4e09dbb1e61f03f7d49e6');
  assert.deepEqual(terminal, {
    kind: 'PLAN_STAGE',
    draftRole: 'TASKFILE_DRAFT',
    sourceTasksHash: hashStrictObject(SOURCE_TASK_FILE),
    requireNonemptyWorkPlan: true,
  });
  assert.throws(() => compileStageTerminal({
    ...input,
    outputBindings: [{ ...input.outputBindings[0]!, path: 'stage-outputs/RUN-000002/tasks.draft.yaml' }],
  }));
  assert.throws(() => compileStageTerminal({
    ...input,
    template: { ...current.capabilityTemplates.find(({ capability }) => capability === 'plan')!, terminalKind: 'ARTIFACT_STAGE' },
  }));
});

// 该回归会在 ISSUE terminal 只投影 caller 传入值，而未与 reproduce template 权限反向闭合时失败。
test('stage-terminal 拒绝删除 reproduce template 的 Evidence 与 authored output', async () => {
  const current = await authorityCatalog();
  const template = current.capabilityTemplates.find(({ capability }) => capability === 'reproduce')!;
  const route = {
    ...ACTIVE_ROUTE,
    requiredCapabilities: ['reproduce'],
    activeCapabilities: ['reproduce'],
    implementationRequired: false,
  } as const;
  const input = {
    ...planCompilerInput(current),
    capability: template.capability,
    source: {
      ...planCompilerInput(current).source,
      activeRoute: route,
      activeRouteHash: hashStrictObject(route),
      issueHash: SHA_C,
      issueState: {
        triageState: 'ready-for-debug',
        reproduction: 'confirmed',
        rootCause: 'unknown',
        fixStrategy: 'unknown',
      },
      repositoryBasis: BASIS,
    },
    outputBindings: [],
    evidenceRequirements: [],
  };
  assert.throws(() => compileStageTerminal(input));
});

// 背景：只测 PLAN 会让 capability→terminal switch、零/非零 Evidence、gate 与 output 权限
// 在其余二十三行悄悄漂移。目的：用独立 literal mapping 穷举 exact24，并对每行分别删除或
// 注入 template-bearing 三类字段；reproduce/work/plan 还锁 replacement 语义。
test('stage-terminal exact24 capability rows 与十二 terminal kind 权限闭合', async () => {
  const current = await authorityCatalog();
  const expectedKinds = {
    archive: 'ARCHIVE_STAGE', canary: 'CANARY_STAGE', debug: 'ISSUE_STAGE', design: 'ARTIFACT_STAGE',
    diagnose: 'ARTIFACT_STAGE', experiment: 'ARTIFACT_STAGE', fix: 'ARTIFACT_STAGE', frame: 'ARTIFACT_STAGE',
    learn: 'ARTIFACT_STAGE', map: 'ARTIFACT_STAGE', mitigate: 'ARTIFACT_STAGE', model: 'ARTIFACT_STAGE',
    plan: 'PLAN_STAGE', qa: 'QA_STAGE', reconcile: 'RECONCILE_STAGE', reproduce: 'ISSUE_STAGE',
    research: 'ARTIFACT_STAGE', review: 'REVIEW_STAGE', ship: 'DELIVERY_STAGE', simplify: 'SIMPLIFY_STAGE',
    spec: 'ARTIFACT_STAGE', triage: 'ISSUE_STAGE', verify: 'VERIFY_STAGE', work: 'WORK_STAGE',
  } as const;
  const injectedEvidence = instantiateEvidenceTemplate(current.evidenceTemplates.find(
    (row) => row.requirementId === 'build',
  )!);
  const injectedGate = current.humanGateTemplates[0]!;
  const compiledRows: Array<{ capability: string; terminal: ReturnType<typeof compileStageTerminal> }> = [];
  for (const capability of Object.keys(expectedKinds).sort() as Array<keyof typeof expectedKinds>) {
    const fixture = terminalCompilerFixture(current, capability);
    compiledRows.push({ capability, terminal: fixture.terminal });
    assert.equal(fixture.terminal.kind, expectedKinds[capability], `${capability} terminal kind`);

    const outputMutation = fixture.input.outputBindings.length === 0
      ? [terminalOutputBindings(current, 'plan')[0]!]
      : fixture.input.outputBindings.slice(0, -1);
    assert.throws(() => compileStageTerminal({ ...fixture.input, outputBindings: outputMutation }),
      `${capability} authored output closure`);

    const evidenceMutation = fixture.input.evidenceRequirements.length === 0
      ? [injectedEvidence] : fixture.input.evidenceRequirements.slice(0, -1);
    assert.throws(() => compileStageTerminal({ ...fixture.input, evidenceRequirements: evidenceMutation }),
      `${capability} Evidence closure`);

    const gateMutation = fixture.input.humanGates.length === 0
      ? [injectedGate] : fixture.input.humanGates.slice(0, -1);
    assert.throws(() => compileStageTerminal({ ...fixture.input, humanGates: gateMutation }),
      `${capability} HumanGate closure`);
  }
  assert.equal(hashStrictObject(compiledRows),
    'sha256:1a8c1bf4348e0123e2f9edf233cd5614ad258fc883f057b5c7138776b22c456d');

  const reproduce = terminalCompilerFixture(current, 'reproduce');
  assert.throws(() => compileStageTerminal({
    ...reproduce.input,
    outputBindings: [{ ...reproduce.input.outputBindings[0]!, path: 'replacement.md' }],
  }));
  for (const capability of ['work', 'plan'] as const) {
    const fixture = terminalCompilerFixture(current, capability);
    assert.throws(() => compileStageTerminal({
      ...fixture.input,
      outputBindings: [{ ...fixture.input.outputBindings[0]!, role: 'UNAUTHORIZED' }],
    }));
  }
});

// 背景：只删除整行抓不到“同 role 换 path”“同 ID 换 producer/count”这类等数量替换。
// 目的：对 catalog 认证 wrapper 的 Artifact/Evidence/HumanGate 完整行逐字段变异；每个变异
// 都必须在 trusted exact ABI 前拒绝。上下文：这些 expected 值来自 literal mutation，未调用
// production 投影 helper，因此第二份硬编码 catalog 无法让测试自洽通过。
test('stage-terminal catalog wrapper 拒绝完整权限行的逐字段替换', async () => {
  const current = await authorityCatalog();
  for (const template of current.capabilityTemplates) {
    const fixture = terminalCompilerFixture(current, template.capability);
    for (const [index, binding] of fixture.input.outputBindings.entries()) {
      const replaceOutput = (replacement: unknown) => compileStageTerminal({
        ...fixture.input,
        outputBindings: fixture.input.outputBindings.map((row, rowIndex) => rowIndex === index ? replacement : row),
      });
      assert.throws(() => replaceOutput({ ...binding, role: 'UNAUTHORIZED_ROLE' }), `${template.capability}:role`);
      if ('path' in binding) assert.throws(() => replaceOutput({ ...binding, path: 'replacement.md' }), `${template.capability}:path`);
      if (binding.kind === 'AUTHORED_DIRECTORY') {
        assert.throws(() => replaceOutput({ ...binding, minimumRegularFiles: binding.minimumRegularFiles + 1 }), `${template.capability}:minimumRegularFiles`);
      }
      if (binding.kind === 'AUTHORED_FILE') {
        if (binding.scaffoldBinding === null) {
          assert.throws(() => replaceOutput({ ...binding, scaffoldBinding: {
            templateId: 'injected', templateHash: SHA_A, renderInputs: {}, renderedScaffoldHash: SHA_B,
          } }), `${template.capability}:null-scaffold`);
        } else {
          for (const scaffoldMutation of [
            { ...binding.scaffoldBinding, templateId: 'replacement' },
            { ...binding.scaffoldBinding, templateHash: SHA_B },
            { ...binding.scaffoldBinding, renderInputs: { replacement: true } },
            { ...binding.scaffoldBinding, renderedScaffoldHash: binding.scaffoldBinding.renderedScaffoldHash === SHA_A ? SHA_B : SHA_A },
          ]) {
            assert.throws(() => replaceOutput({ ...binding, scaffoldBinding: scaffoldMutation }), `${template.capability}:scaffold`);
          }
        }
      }
    }
    for (const [index, requirement] of fixture.input.evidenceRequirements.entries()) {
      const replaceEvidence = (replacement: unknown) => compileStageTerminal({
        ...fixture.input,
        evidenceRequirements: fixture.input.evidenceRequirements.map((row, rowIndex) => rowIndex === index ? replacement : row),
      });
      const mutations = [
        { ...requirement, producer: requirement.producer === 'GENERIC_IMPORT' ? 'VERIFICATION_COMMAND' : 'GENERIC_IMPORT' },
        { ...requirement, allowedTypes: requirement.allowedTypes[0] === 'build' ? ['manual'] : ['build'] },
        { ...requirement, allowedStatuses: ['FAIL', 'PASS'] },
        { ...requirement, satisfyingStatus: 'FAIL' },
        { ...requirement, outputPolicy: requirement.outputPolicy === 'OPTIONAL' ? 'OWNED_OUTPUT_REQUIRED' : 'OPTIONAL' },
        { ...requirement, sourceScope: 'CHANGE_BOUND' },
        { ...requirement, subjectPolicy: 'CALLER_SELECTED' },
        'minimumRecords' in requirement
          ? { ...requirement, minimumRecords: requirement.minimumRecords + 1 }
          : { ...requirement, minimumRecordsPerTask: requirement.minimumRecordsPerTask + 1 },
      ];
      for (const mutation of mutations) assert.throws(() => replaceEvidence(mutation), `${template.capability}:${requirement.requirementId}`);
    }
    for (const [index, gate] of fixture.input.humanGates.entries()) {
      const replaceGate = (replacement: unknown) => compileStageTerminal({
        ...fixture.input,
        humanGates: fixture.input.humanGates.map((row, rowIndex) => rowIndex === index ? replacement : row),
      });
      assert.throws(() => replaceGate({ ...gate, gateId: 'replacement-gate' }));
      assert.throws(() => replaceGate({ ...gate, sourceScope: 'CHANGE_BOUND' }));
      assert.throws(() => replaceGate({ ...gate, approvedArtifactRole: 'REPLACEMENT' }));
    }
  }
});

// 背景：Issue source 同时携带 strict state 与相邻 hash；如果 wrapper 只冻结 caller 给出的 hash，
// completion 就无法证明最终更新只改变 action 授权的字段。目的：在 terminal 边界先认证完整 source。
test('stage-terminal 拒绝与完整 Issue source state 不相邻的 hash', async () => {
  const current = await authorityCatalog();
  const fixture = terminalCompilerFixture(current, 'triage');
  assert.throws(() => compileStageTerminal({
    ...fixture.input,
    source: { ...fixture.input.source, issueHash: SHA_C },
  }), /Issue.*hash|hash.*Issue/u);
});

// 背景：完整 catalog wrapper 不能只认证 Artifact/Evidence/gate，再信任 caller 预制的 policy
// fragment。目的：Review/QA/Canary/Verify/Delivery 必须分别等于其规范 compiler 的纯值投影。
test('stage-terminal 拒绝 caller 预制的五类 policy compiler fragment', async () => {
  const current = await authorityCatalog();
  const review = terminalCompilerFixture(current, 'review');
  assert.throws(() => compileStageTerminal({
    ...review.input,
    policies: {
      ...review.input.policies,
      review: { ...review.input.policies.review!, standards: review.input.policies.review!.standards.slice(1) },
    },
  }), 'Review policy');

  const qa = terminalCompilerFixture(current, 'qa');
  assert.throws(() => compileStageTerminal({
    ...qa.input,
    policies: {
      ...qa.input.policies,
      qa: { ...qa.input.policies.qa!, checks: [...qa.input.policies.qa!.checks].reverse() },
    },
  }), 'QA policy');

  const canary = terminalCompilerFixture(current, 'canary');
  assert.throws(() => compileStageTerminal({
    ...canary.input,
    policies: {
      ...canary.input.policies,
      canary: {
        ...canary.input.policies.canary!,
        minimumWindowSeconds: canary.input.policies.canary!.minimumWindowSeconds + 1,
      },
    },
  }), 'Canary policy');

  const verify = terminalCompilerFixture(current, 'verify');
  assert.throws(() => compileStageTerminal({
    ...verify.input,
    verify: { ...verify.input.verify!, verifiedBasis: { ...BASIS, workingPatchHash: SHA_C } },
  }), 'Verify fragment');

  const delivery = terminalCompilerFixture(current, 'ship');
  assert.throws(() => compileStageTerminal({
    ...delivery.input,
    delivery: { ...delivery.input.delivery!, requiredHumanGates: [] },
  }), 'Delivery fragment');
});

// 背景：旧 retry 只复制 prior failedResult.changedPaths，既不证明当前工作树已从 root
// 演进到 retry-start，也会把失败叶子的越权路径带入新 lineage。目的：要求认证的当前
// root→retry-start 完整 result，并证明返回值使用它而不是 prior failed result。
test('stage-terminal retry lineage 绑定当前 root 到 retry-start result', async () => {
  const current = await authorityCatalog();
  const fixture = terminalCompilerFixture(current, 'work');
  const failedBasis = { ...BASIS, workingPatchHash: SHA_B, eligibleUntrackedInventoryHash: SHA_C };
  const retryStartBasis = { ...BASIS, workingPatchHash: SHA_C, eligibleUntrackedInventoryHash: SHA_A };
  const failedResultCore = { prepared: BASIS, completed: failedBasis, changedPaths: ['outside.txt'] };
  const failedResult = { ...failedResultCore, resultHash: hashStrictObject(failedResultCore) };
  const latestFailure = {
    kind: 'REPOSITORY_STAGE_FAILURE', capability: 'work', taskId: 'TASK-001',
    rootRunId: 'RUN-000001', retryOfRunId: null,
    rootPreparedBasis: BASIS, rootPreparedBasisHash: hashStrictObject(BASIS),
    failedBasis, failedBasisHash: hashStrictObject(failedBasis), failedResult,
    policyViolatingPaths: ['outside.txt'],
  } as const;
  const retryStartCore = {
    prepared: BASIS, completed: retryStartBasis, changedPaths: ['src/compiler.ts'],
  } as const;
  const retryStartResult = { ...retryStartCore, resultHash: hashStrictObject(retryStartCore) };
  const retryState = {
    capability: 'work', taskId: 'TASK-001', rootRunId: 'RUN-000001',
    latestFailedRunId: 'RUN-000009', latestFailure,
    latestFailureHash: hashStrictObject(latestFailure), completedRunId: null, abandonedByRunId: null,
  } as const;
  const input = {
    ...fixture.input,
    identity: { ...fixture.input.identity, runId: 'RUN-000002' },
    source: {
      ...fixture.input.source,
      repositoryBasis: retryStartBasis,
      repositoryRetryState: retryState,
      repositoryRetryStartResult: retryStartResult,
    },
    selection: { ...fixture.input.selection, retryRunId: 'RUN-000009' },
    outputBindings: [{
      kind: 'REPOSITORY_DIFF', role: 'IMPLEMENTATION_DIFF', taskId: 'TASK-001', basis: BASIS,
    }],
  };
  const terminal = compileStageTerminal(input);
  assert.equal(terminal.kind, 'WORK_STAGE');
  if (terminal.kind !== 'WORK_STAGE') assert.fail('retry 必须保持 WORK terminal');
  assert.equal(terminal.repositoryLineage.kind, 'RETRY');
  if (terminal.repositoryLineage.kind !== 'RETRY') assert.fail('必须生成 RETRY lineage');
  assert.deepEqual(terminal.repositoryLineage.retryStartResult.changedPaths, ['src/compiler.ts']);
  assert.notDeepEqual(
    terminal.repositoryLineage.retryStartResult.changedPaths,
    latestFailure.failedResult.changedPaths,
  );
  assert.throws(() => compileStageTerminal({
    ...input,
    source: { ...input.source, repositoryRetryStartResult: null },
  }));
  assert.throws(() => compileStageTerminal({
    ...input,
    source: { ...input.source, repositoryRetryStartResult: failedResult },
  }));
});

function planTerminalResult(terminal: ReturnType<typeof compileStageTerminal>) {
  return {
    kind: 'PLAN_STAGE',
    terminalHash: hashStrictObject(terminal),
    descendantEntryHashes: [],
    descendantEntryHashesHash: hashStrictObject([]),
    satisfaction: { evidence: [], gates: [] },
    satisfactionHash: hashStrictObject({ evidence: [], gates: [] }),
    outputObservations: [],
    outputObservationsHash: hashStrictObject([]),
    draftRawBytesHash: SHA_C,
    sourceTasksHash: hashStrictObject(SOURCE_TASK_FILE),
    targetTasksHash: SHA_A,
  } as const;
}

// 该测试会在 stage-completion 恢复 caller 预制 result、漏验 context 相邻 hash、
// PLAN draft 原始字节或 validation ticket 任一字段时失败。
test('stage-completion 从规范 PLAN context 纯派生 VALIDATE ticket 与终端证明', async () => {
  const current = await authorityCatalog();
  const { request, context } = planCompletionFixture(current);
  const validated = assertDeterministic(compileStageCompletion, {
    mode: 'VALIDATE', authorityCatalog: current, request, context,
  });
  if (validated.mode !== 'VALIDATE') assert.fail('VALIDATE 必须返回规范 hash ticket 投影');
  const validation = literalCompletionTicket(current, request, context, validated.normalizedResultHash);
  const instantiated = assertDeterministic(compileStageCompletion, {
    mode: 'INSTANTIATE', authorityCatalog: current, request, context, validation,
  });
  assert.equal(instantiated.mode, 'INSTANTIATE');
  if (instantiated.mode !== 'INSTANTIATE') assert.fail('INSTANTIATE 必须生成完整 terminal result');
  assert.equal(hashStrictObject({ validated, validation, instantiated }),
    'sha256:46ca05f1ec43871b9207044109e62686bf0669f73513b298eebff5d1304c24bf');
  assert.equal(instantiated.terminalResult.kind, 'PLAN_STAGE');
  assert.equal(instantiated.terminalResultHash, validated.normalizedResultHash);
  assert.equal(instantiated.terminalResult.sourceTasksHash, hashStrictObject(SOURCE_TASK_FILE));
  assert.equal(instantiated.terminalResult.targetTasksHash, request.expectedTasksHash);
  assert.deepEqual(instantiated.terminalResult.outputObservations, [{
    kind: 'FILE', role: 'TASKFILE_DRAFT',
    path: 'stage-outputs/RUN-000001/tasks.draft.yaml',
    rawBytesHash: context.planDraft.bytes.rawBytesHash,
  }]);
  assert.throws(() => compileStageCompletion({
    mode: 'VALIDATE', authorityCatalog: current,
    request: { ...request, expectedAuthorityHead: SHA_C }, context,
  }));
  assert.throws(() => compileStageCompletion({
    mode: 'INSTANTIATE', authorityCatalog: current, request, context,
    validation: { ...validation, contextHash: SHA_C },
  }));
  assert.throws(() => compileStageCompletion({
    mode: 'VALIDATE', authorityCatalog: current, request,
    context: {
      ...context,
      planDraft: { ...context.planDraft, targetTasksHash: SHA_C },
    },
  }));
});

// 该回归会在旧的 caller-prebuilt authorityContract/terminalResult ABI 仍可被调用时失败。
test('stage-completion 拒绝 caller 预制 authority contract 与 terminal result', async () => {
  const current = await authorityCatalog();
  const terminal = compileStageTerminal(planCompilerInput(current));
  const authorityContract = planAuthorityContract(terminal);
  assert.throws(() => compileStageCompletion({
    mode: 'VALIDATE',
    authorityContract,
    terminalResult: planTerminalResult(terminal),
  }));
});

// 该 RED 会在 DIRECTORY observation 仍复制 authored binding 的尾斜线，或删除多于一个
// 尾斜线时失败。规范 observation 是文件式路径 `experiments`，binding 才是 `experiments/`。
test('stage-completion DIRECTORY observation 恰好去掉 binding 的一个尾斜线', async () => {
  const current = await authorityCatalog();
  const { request, context } = directoryCompletionFixture(current);
  const validated = compileStageCompletion({ mode: 'VALIDATE', authorityCatalog: current, request, context });
  assert.equal(validated.mode, 'VALIDATE');
  if (validated.mode !== 'VALIDATE') assert.fail('Artifact VALIDATE 必须返回 ticket preimage hash');
  const validation = literalCompletionTicket(current, request, context, validated.normalizedResultHash);
  const instantiated = compileStageCompletion({ mode: 'INSTANTIATE', authorityCatalog: current, request, context, validation });
  assert.equal(instantiated.mode, 'INSTANTIATE');
  if (instantiated.mode !== 'INSTANTIATE') assert.fail('Artifact INSTANTIATE 必须返回 terminal result');
  assert.equal(instantiated.terminalResult.kind, 'ARTIFACT_STAGE');
});

// 该 RED 会在合法 1500 行 completion context 被通用 node budget 提前拒绝，或恢复
// allowedDescendants×descendants / requirements×Evidence 二次扫描时失败。测试不依赖机器毫秒；
// 它只要求线性索引能走完全部 1500 行并抵达最后的、刻意缺失的 Review capture 证明。
test('stage-completion 以单次索引处理 1500×1500 descendant/Evidence 压力向量', async () => {
  const current = await authorityCatalog();
  const { request, context } = reviewStressCompletionFixture(current, 1500);
  assert.throws(
    () => compileStageCompletion({ mode: 'VALIDATE', authorityCatalog: current, request, context }),
    /output capture set is not exhaustive/u,
  );
});

// 背景：一个 PLAN positive 不能证明 switch 的其余十一种权限分支仍存在。
// 目的：每个 terminal 都先由 exact stage-terminal 与 run-descendants 编译出 strict manifest，
// 再独立删除该分支必需的 proof；任何分支被默认吞掉、映射错 capability 或放宽证明都会使对应 row 通过。
test('stage-completion 十二维 terminal oracle 分别拒绝缺失分支证明', async () => {
  const current = await authorityCatalog();
  const rows = [
    ['design', 'ARTIFACT_STAGE'],
    ['triage', 'ISSUE_STAGE'],
    ['work', 'WORK_STAGE'],
    ['simplify', 'SIMPLIFY_STAGE'],
    ['review', 'REVIEW_STAGE'],
    ['verify', 'VERIFY_STAGE'],
    ['qa', 'QA_STAGE'],
    ['canary', 'CANARY_STAGE'],
    ['ship', 'DELIVERY_STAGE'],
    ['archive', 'ARCHIVE_STAGE'],
    ['reconcile', 'RECONCILE_STAGE'],
  ] as const;
  for (const [capability, terminalKind] of rows) {
    const base = planCompletionFixture(current);
    const compiled = terminalCompilerFixture(current, capability);
    assert.equal(compiled.terminal.kind, terminalKind);
    const authorityContract = {
      ...base.context.manifest.authorityContract,
      capability,
      authoredOutputBindings: compiled.input.outputBindings,
      allowedDescendants: compileRunDescendants({
        runId: 'RUN-000001', terminal: compiled.terminal,
        evidenceRequirements: compiled.input.evidenceRequirements,
        humanGates: compiled.input.humanGates,
      }),
      terminal: compiled.terminal,
      terminalHash: hashStrictObject(compiled.terminal),
    };
    const manifest = {
      ...base.context.manifest,
      capability,
      authorityContract,
      authorityContractHash: hashStrictObject(authorityContract),
    };
    const context = { ...base.context, manifest, planDraft: null, outputCaptures: [] };
    assert.throws(() => compileStageCompletion({
      mode: 'VALIDATE', authorityCatalog: current,
      request: { runId: 'RUN-000001', expectedAuthorityHead: SHA_B, expectedTasksHash: null },
      context,
    }), `${terminalKind} 必须独立拒绝缺失证明`);
  }
});

// 背景：一个 PLAN 与十一个 negative 只能证明拒绝路径，不能证明 exact terminal 分支可达。
// 目的：其余十种 terminal 各自构造完整认证 context，逐一执行 VALIDATE→独立 literal ticket→
// INSTANTIATE。上下文：PLAN 与 ARTIFACT 已由上方两个独立 positive 覆盖，合计 exact 12/12。
test('stage-completion exact12 terminal kinds 都有独立 positive VALIDATE 与 INSTANTIATE', async () => {
  const current = await authorityCatalog();
  const rows = [
    ['triage', 'ISSUE_STAGE'],
    ['work', 'WORK_STAGE'],
    ['simplify', 'SIMPLIFY_STAGE'],
    ['review', 'REVIEW_STAGE'],
    ['verify', 'VERIFY_STAGE'],
    ['qa', 'QA_STAGE'],
    ['canary', 'CANARY_STAGE'],
    ['ship', 'DELIVERY_STAGE'],
    ['archive', 'ARCHIVE_STAGE'],
    ['reconcile', 'RECONCILE_STAGE'],
  ] as const;
  for (const [capability, terminalKind] of rows) {
    const { request, context } = positiveCompletionFixture(current, capability);
    const validated = compileStageCompletion({ mode: 'VALIDATE', authorityCatalog: current, request, context });
    assert.equal(validated.mode, 'VALIDATE', capability);
    if (validated.mode !== 'VALIDATE') assert.fail(`${capability} VALIDATE 必须返回 normalized hash`);
    const validation = literalCompletionTicket(current, request, context, validated.normalizedResultHash);
    const instantiated = compileStageCompletion({ mode: 'INSTANTIATE', authorityCatalog: current, request, context, validation });
    assert.equal(instantiated.mode, 'INSTANTIATE', capability);
    if (instantiated.mode !== 'INSTANTIATE') assert.fail(`${capability} INSTANTIATE 必须返回 terminal result`);
    assert.equal(instantiated.terminalResult.kind, terminalKind, capability);
    switch (instantiated.terminalResult.kind) {
      case 'ISSUE_STAGE':
        assert.equal(instantiated.terminalResult.targetIssueHash, context.currentIssueHash);
        break;
      case 'WORK_STAGE':
        assert.equal(instantiated.terminalResult.repositoryWorkResult.resultHash, context.repositoryWorkResult?.resultHash);
        break;
      case 'SIMPLIFY_STAGE':
        assert.deepEqual(
          instantiated.terminalResult.repositoryWorkResult.completed,
          structuredClone(context.currentRepositoryBasis),
        );
        break;
      case 'REVIEW_STAGE':
      case 'QA_STAGE':
        assert.match(instantiated.terminalResult.aggregateEvidenceId, /^EVD-/u);
        break;
      case 'VERIFY_STAGE':
        assert.equal(instantiated.terminalResult.targetTasksHash, context.currentTasksHash);
        break;
      case 'CANARY_STAGE':
        assert.equal(instantiated.terminalResult.measurementEvidenceIds.length, 2);
        assert.equal(instantiated.terminalResult.decision, 'CONTINUE');
        break;
      case 'DELIVERY_STAGE':
        assert.match(instantiated.terminalResult.approvalEvidenceId, /^EVD-/u);
        assert.equal(instantiated.terminalResult.releaseArtifactIdentityHash,
          hashStrictObject(instantiated.terminalResult.releaseArtifactIdentity));
        break;
      case 'ARCHIVE_STAGE':
        assert.equal(instantiated.terminalResult.targetMetadataHash, context.currentMetadataHash);
        break;
      case 'RECONCILE_STAGE':
        assert.equal(instantiated.terminalResult.targetRevision, 'REV-0002');
        assert.equal(instantiated.terminalResult.selectedOwner.kind, 'FLOW_ASSESSMENT');
        break;
    }
    const branchContext: unknown = capability === 'triage'
      ? { ...context, currentIssueState: null, currentIssueHash: null }
      : capability === 'work' || capability === 'simplify'
        ? { ...context, repositoryWorkResult: null }
        : capability === 'review' || capability === 'verify' || capability === 'qa' || capability === 'ship'
          ? { ...context, currentRepositoryBasis: null }
          : capability === 'canary'
            ? { ...context, outputCaptures: [] }
            : capability === 'archive'
              ? { ...context, currentArchiveGateSnapshot: null }
              : {
                ...context, descendants: [],
                currentAuthorityHead: context.prepareReceiptEntryHash,
              };
    assert.throws(() => compileStageCompletion({
      mode: 'VALIDATE', authorityCatalog: current, request,
      context: branchContext,
    }), `${capability} 必须拒绝 terminal-specific proof mutation`);
  }
});

// 背景：AUTHORED_FILE 的 scaffold 只是起始材料，不是完成产物。目的：即使 caller 同步改写
// manifest/contract 的相邻 hash，也不能把与 renderedScaffoldHash 相同的 bytes 当作完成证明。
test('stage-completion 拒绝仍等于 frozen scaffold 的 authored file', async () => {
  const current = await authorityCatalog();
  const base = positiveCompletionFixture(current, 'triage');
  const capture = base.context.outputCaptures[0]!;
  assert.equal(capture.kind, 'FILE');
  if (capture.kind !== 'FILE') assert.fail('Triage positive 必须捕获 issue.md');
  const authoredOutputBindings = base.context.manifest.authorityContract.authoredOutputBindings.map((binding) => (
    binding.kind === 'AUTHORED_FILE' && binding.scaffoldBinding !== null
      ? { ...binding, scaffoldBinding: { ...binding.scaffoldBinding, renderedScaffoldHash: capture.bytes.rawBytesHash } }
      : binding
  ));
  const authorityContract = { ...base.context.manifest.authorityContract, authoredOutputBindings };
  const manifest = {
    ...base.context.manifest,
    authorityContract,
    authorityContractHash: hashStrictObject(authorityContract),
  };
  assert.throws(() => compileStageCompletion({
    mode: 'VALIDATE', authorityCatalog: current, request: base.request,
    context: { ...base.context, manifest },
  }), /scaffold/u);
});

// 背景：REPRO/DEBUG 的 action row 没有重复携带全部派生字段；只比 action 自身会允许 triage
// 漂移。目的：用 sourceIssueHash 的有限状态反投影证明非授权字段保持，并锁定规范派生 triage。
test('stage-completion 闭合 REPRO 与 DEBUG 的完整 Issue target 派生', async () => {
  const current = await authorityCatalog();
  for (const [capability, invalidTriage] of [
    ['reproduce', 'ready-for-human'],
    ['debug', 'ready-for-debug'],
  ] as const) {
    const base = positiveCompletionFixture(current, capability);
    assert.equal(base.context.currentIssueState?.reproduction, 'confirmed', capability);
    assert.equal(base.context.currentIssueState?.rootCause, 'confirmed', capability);
    assert.equal(base.context.currentIssueState?.fixStrategy, 'ready', capability);
    let positiveMode: string | null = null;
    assert.doesNotThrow(() => {
      positiveMode = compileStageCompletion({
        mode: 'VALIDATE', authorityCatalog: current, request: base.request, context: base.context,
      }).mode;
    }, capability);
    assert.equal(positiveMode, 'VALIDATE');
    const descendants = [...base.context.descendants];
    const old = descendants.at(-1)!;
    assert.equal(Reflect.get(old, 'kind'), 'ISSUE_UPDATE');
    const targetIssueState = {
      ...TEST_ISSUE_STATE_SCHEMA.parse(Reflect.get(old, 'targetIssueState')),
      triageState: invalidTriage,
    };
    const targetIssueHash = hashStrictObject(targetIssueState);
    const row = {
      kind: 'ISSUE_UPDATE', binding: Reflect.get(old, 'binding'), action: Reflect.get(old, 'action'),
      sourceIssueHash: Reflect.get(old, 'sourceIssueHash'), targetIssueState, targetIssueHash,
    };
    const entryHash = hashStrictObject({
      ordinal: Reflect.get(old, 'ordinal'), predecessorEntryHash: Reflect.get(old, 'predecessorEntryHash'), row,
    });
    descendants[descendants.length - 1] = { ...old, ...row, entryHash };
    assert.throws(() => compileStageCompletion({
      mode: 'VALIDATE', authorityCatalog: current, request: base.request,
      context: {
        ...base.context, descendants, currentAuthorityHead: entryHash,
        currentIssueState: targetIssueState, currentIssueHash: targetIssueHash,
      },
    }), /ISSUE|Issue/u, capability);
  }
});

// 背景：WORK terminal 中的 negativeEvidenceRecovery 只是失败后复原凭据，
// 不是新一次 START 的前置状态集合。目的：锁定准备阶段只能从 READY Task
// 编译 WORK terminal，同时保留完整失败恢复语义供后续 writer 使用。
test('stage-terminal WORK 只接受 READY selected Task 且不混用 negative recovery', async () => {
  const current = await authorityCatalog();
  const base = terminalCompilerFixture(current, 'work');
  assert.equal(base.terminal.kind, 'WORK_STAGE');
  if (base.terminal.kind !== 'WORK_STAGE') assert.fail('WORK fixture 必须生成 WORK terminal');
  assert.deepEqual(base.terminal.negativeEvidenceRecovery, {
    kind: 'RESET_SELECTED_TASK_TO_READY',
    allowedSourceStatuses: ['READY', 'RUNNING', 'BLOCKED', 'IMPLEMENTED'],
    targetStatus: 'READY',
    preserveAllOtherTaskFileFields: true,
  });
  for (const status of ['RUNNING', 'BLOCKED', 'IMPLEMENTED'] as const) {
    const taskFile = taskFileSchema.parse({
      ...base.input.source.taskFile,
      tasks: base.input.source.taskFile.tasks.map((task) => (
        task.id === 'TASK-001' ? { ...task, status } : task
      )),
    });
    assert.throws(() => compileStageTerminal({
      ...base.input,
      source: { ...base.input.source, taskFile, tasksHash: hashStrictObject(taskFile) },
    }), /READY/u, status);
  }
});

// 背景：旧 completion 把 negative recovery 的四个状态当成正常 START 反投影
// 候选，因而可认证 RUNNING→RUNNING 的无状态变化 START。目的：首行必须
// 只用 target RUNNING 反投影出完整 READY source TaskFile；非 selected Task 和顶层
// TaskFile 字段也不得漂移。
test('stage-completion WORK 首次 START 只认证完整 READY source TaskFile', async () => {
  const current = await authorityCatalog();
  const base = positiveCompletionFixture(current, 'work');
  for (const status of ['RUNNING', 'BLOCKED', 'IMPLEMENTED'] as const) {
    const context = workCompletionWithSourceStatus(base, status);
    assert.throws(() => compileStageCompletion({
      mode: 'VALIDATE', authorityCatalog: current, request: base.request, context,
    }), /READY|first Task transition/u, status);
  }

  const first = firstWorkTargetTaskFile(base);
  const nonselectedTask = {
    ...first.tasks[0]!, id: 'TASK-002', title: '未选任务', status: 'READY' as const,
  };
  const nonselectedDrift = taskFileSchema.parse({ ...first, tasks: [...first.tasks, nonselectedTask] });
  assert.throws(() => compileStageCompletion({
    mode: 'VALIDATE', authorityCatalog: current, request: base.request,
    context: workCompletionWithFirstTargetDrift(base, nonselectedDrift),
  }), /Task/u);
  const topLevelDrift = taskFileSchema.parse({ ...first, generatedFrom: ['contract.md'] });
  assert.throws(() => compileStageCompletion({
    mode: 'VALIDATE', authorityCatalog: current, request: base.request,
    context: workCompletionWithFirstTargetDrift(base, topLevelDrift),
  }), /Task/u);
});

// 背景：Review finding 的 axis/check 是权限选择字段，不能只凭 schema
// enum 认证。目的：即使 finding 的 fold 结果仍为 PASS，也必须拒绝
// 未出现在 frozen reviewPolicy 对应轴中的 reviewer probe。
test('stage-completion Review finding 必须绑定 frozen axis/check contract', async () => {
  const current = await authorityCatalog();
  const base = positiveCompletionFixture(current, 'review');
  const terminal = base.context.manifest.authorityContract.terminal;
  assert.equal(terminal.kind, 'REVIEW_STAGE');
  if (terminal.kind !== 'REVIEW_STAGE') assert.fail('Review fixture 必须生成 Review terminal');
  assert.equal(terminal.reviewPolicy.standards.includes('security'), false);
  const context = mutateAggregateDraftContext(
    base.context,
    'REVIEW_DRAFT',
    'EVIDENCE_REVIEW_IMPORT',
    (draft) => ({
      ...draft,
      findings: [{
        id: 'FINDING-001', axis: 'STANDARDS', check: 'security', severity: 'MINOR',
        status: 'OPEN', summary: '未授权安全检查探针', evidenceIds: [], waiverDecisionId: null,
      }],
    }),
  );
  assert.throws(() => compileStageCompletion({
    mode: 'VALIDATE', authorityCatalog: current, request: base.request, context,
  }), /Review.*check|frozen.*policy/u);
});

// 背景：stage-completion 对已认证 Review capture 仍直接 JSON.parse，root/nested 重复键会
// last-wins 后进入同一个 ReviewDraftV2 schema。目的：用真实 positive completion context 只改
// authored bytes，并同步所有 capture/descendant hash，证明共享 strict decoder 在 Zod/canonical
// work 前拒绝两级 duplicate。上下文：若仅 hash 漂移会在更早相邻性检查失败，不能复现本 finding。
test('stage-completion strict JSON 边界拒绝 root 与 nested duplicate key', async () => {
  const current = await authorityCatalog();
  const base = positiveCompletionFixture(current, 'review');
  const mutations = [
    (raw: string) => raw.replace(
      '{"schemaVersion":2',
      '{"schemaVersion":2,"schemaVersion":2',
    ),
    (raw: string) => raw.replace(
      '"specification":{"status":"PASS"',
      '"specification":{"status":"PASS","status":"PASS"',
    ),
  ];
  for (const mutate of mutations) {
    const context = mutateAggregateDraftRawContext(
      base.context,
      'REVIEW_DRAFT',
      'EVIDENCE_REVIEW_IMPORT',
      mutate,
    );
    assert.throws(() => compileStageCompletion({
      mode: 'VALIDATE', authorityCatalog: current, request: base.request, context,
    }), /duplicate|strict JSON/u);
  }
});

// 背景：QA 的多个 check 可以同时拥有 current PASS Evidence，全局集合成员
// 检查会允许 product-acceptance finding 偷用 runtime-readiness Evidence。
// 目的：finding 只能引用其 frozen check.evidenceRequirementIds 所属的当前 PASS 证据。
test('stage-completion QA finding Evidence 不得跨 frozen check 借用', async () => {
  const current = await authorityCatalog();
  const base = positiveCompletionFixture(current, 'qa');
  const runtimeEvidenceId = completionEvidenceId(base.context, 'runtime-signal');
  const context = mutateAggregateDraftContext(
    base.context,
    'QA_DRAFT',
    'EVIDENCE_QA_IMPORT',
    (draft) => ({
      ...draft,
      findings: [{
        id: 'FINDING-001', checkId: 'product-acceptance', severity: 'MINOR', status: 'OPEN',
        summary: '跨 check Evidence 探针', evidenceIds: [runtimeEvidenceId], waiverDecisionId: null,
      }],
    }),
  );
  assert.throws(() => compileStageCompletion({
    mode: 'VALIDATE', authorityCatalog: current, request: base.request, context,
  }), /QA finding.*check|QA finding Evidence/u);
});

// 背景：round3 只阻止 finding 跨 check 引用，但同一 check 内的空集或
// 仅覆盖部分 requirement 仍会通过。目的：finding 必须对 frozen check 的
// 每个 evidenceRequirementId 至少引用一条 exact tested-basis current PASS Evidence；
// 同 check 全覆盖 positive 必须继续可达。
test('stage-completion QA finding Evidence 必须覆盖 frozen check 的每个 requirement', async () => {
  const current = await authorityCatalog();
  const base = positiveCompletionFixture(current, 'qa');
  const productEvidenceId = completionEvidenceId(base.context, 'product-acceptance');
  const runtimeEvidenceId = completionEvidenceId(base.context, 'runtime-signal');
  const invalid = [
    {
      label: 'empty',
      context: qaFindingCoverageContext(base, ['product-acceptance'], [productEvidenceId], []),
    },
    {
      label: 'partial',
      context: qaFindingCoverageContext(
        base,
        ['product-acceptance', 'runtime-signal'],
        [productEvidenceId, runtimeEvidenceId],
        [productEvidenceId],
      ),
    },
  ];
  for (const mutation of invalid) {
    assert.throws(() => {
      compileStageCompletion({
        mode: 'VALIDATE', authorityCatalog: current, request: base.request, context: mutation.context,
      });
    }, /QA finding Evidence\/check\/waiver binding is invalid/u, mutation.label);
  }
  assert.doesNotThrow(() => compileStageCompletion({
    mode: 'VALIDATE', authorityCatalog: current, request: base.request,
    context: qaFindingCoverageContext(
      base,
      ['product-acceptance', 'runtime-signal'],
      [productEvidenceId, runtimeEvidenceId],
      [productEvidenceId, runtimeEvidenceId],
    ),
  }));
});

// 背景：WORK/SIMPLIFY Evidence 必须观测 repositoryWorkResult.completed，准备时
// terminal.basis 只是变更前的 root。目的：直接把合法 Evidence subject 的 basis
// 替换为 prepared basis 并回算全部相邻 hash，仍必须因观测对象过期被拒绝。
test('stage-completion WORK/SIMPLIFY Evidence subject 直接绑定 completed basis', async () => {
  const current = await authorityCatalog();
  for (const capability of ['work', 'simplify'] as const) {
    const base = positiveCompletionFixture(current, capability);
    const terminal = base.context.manifest.authorityContract.terminal;
    if (terminal.kind !== 'WORK_STAGE' && terminal.kind !== 'SIMPLIFY_STAGE') {
      assert.fail(`${capability} fixture 必须生成 repository terminal`);
    }
    const evidenceIndex = base.context.descendants.findIndex((row) => row.kind === 'EVIDENCE');
    if (evidenceIndex < 0) assert.fail(`${capability} fixture 缺少 Evidence`);
    const oldRow = base.context.descendants[evidenceIndex]!;
    const oldEvidence = requireTestJsonRecord(Reflect.get(oldRow, 'evidence'));
    const taskId = Reflect.get(oldEvidence, 'taskId');
    const subject = typeof taskId === 'string'
      ? {
        kind: 'TASK_REPOSITORY_BASIS', revision: base.context.manifest.revision,
        taskId, basis: terminal.basis,
      }
      : { kind: 'REPOSITORY_BASIS', revision: base.context.manifest.revision, basis: terminal.basis };
    const subjectBinding = { subject, subjectHash: hashStrictObject(subject) };
    const evidence = { ...oldEvidence, subjectBinding };
    const changedRows = base.context.descendants.map((row, index) => (
      index === evidenceIndex
        ? { ...row, evidence, evidenceRecordHash: hashStrictObject(evidence), subjectBinding }
        : row
    ));
    const chain = rechainTestDescendants(changedRows, base.context.prepareReceiptEntryHash);
    assert.throws(() => compileStageCompletion({
      mode: 'VALIDATE', authorityCatalog: current, request: base.request,
      context: {
        ...base.context,
        descendants: chain.descendants,
        currentAuthorityHead: chain.currentAuthorityHead,
      },
    }), /Evidence descendant binding|subject/u, capability);
  }
});

// 背景：changedPaths×allowedRepositoryPaths 的嵌套 includes 在对等 30k
// inventory 上会放大为二次工作。目的：合法 30k+30k 向量必须走完，
// 而超过显式线性 work budget 的 30001+30000 在成员 join 前稳定拒绝；
// 不用机器毫秒作为正确性断言。
test('stage-completion WORK 路径成员 join 使用显式线性 work budget', async () => {
  const current = await authorityCatalog();
  const base = positiveCompletionFixture(current, 'work');
  const paths = Array.from({ length: 30_000 }, (_, index) => (
    `src/generated/${String(index).padStart(5, '0')}.ts`
  ));
  assert.doesNotThrow(() => compileStageCompletion({
    mode: 'VALIDATE', authorityCatalog: current, request: base.request,
    context: workCompletionWithRepositoryPaths(base, paths, paths),
  }));
  assert.throws(() => compileStageCompletion({
    mode: 'VALIDATE', authorityCatalog: current, request: base.request,
    context: workCompletionWithRepositoryPaths(base, paths, ['a/overflow.ts', ...paths]),
  }), /linear membership work budget/u);
});

function verifyMappingMutationFixtures(current: StageAuthorityCatalogV1) {
  const compiled = terminalCompilerFixture(current, 'verify');
  if (compiled.terminal.kind !== 'VERIFY_STAGE') assert.fail('Verify mapping fixture 必须生成 VERIFY terminal');
  const original = compiled.terminal;
  const taskContractTemplate = current.evidenceTemplates.find((row) => row.requirementId === 'task-contract');
  if (taskContractTemplate === undefined) assert.fail('catalog 缺少 task-contract template');
  const taskContractRequirement = instantiateEvidenceTemplate(taskContractTemplate);
  if (taskContractRequirement.taskScope.kind !== 'TASK_DECLARED') {
    assert.fail('task-contract 必须位于 TASK_DECLARED partition');
  }
  const withMapping = (
    requirementIds: readonly string[],
    evidenceRequirements: typeof original.evidenceRequirements = original.evidenceRequirements,
    targetEvidenceRequired: readonly string[] | null = null,
  ) => {
    const verificationTaskRequirements = [{ taskId: 'TASK-001', requirementIds: [...requirementIds] }];
    const targetTaskFile = targetEvidenceRequired === null ? original.targetTaskFile : {
      ...original.targetTaskFile,
      tasks: original.targetTaskFile.tasks.map((task) => (
        task.id === 'TASK-001' ? { ...task, evidenceRequired: [...targetEvidenceRequired] } : task
      )),
    };
    return {
      ...original,
      evidenceRequirements: [...evidenceRequirements],
      evidenceRequirementsHash: hashStrictObject(evidenceRequirements),
      verificationTaskRequirements,
      verificationTaskRequirementsHash: hashStrictObject(verificationTaskRequirements),
      targetTaskFile,
      targetTasksHash: hashStrictObject(targetTaskFile),
    };
  };
  const mismatchRequirements = original.evidenceRequirements
    .map((requirement) => requirement.requirementId === 'task-behavior' ? taskContractRequirement : requirement)
    .sort((left, right) => left.requirementId < right.requirementId ? -1 : left.requirementId > right.requirementId ? 1 : 0);
  return [
    { label: 'missing-frozen-id', completionMutation: 'DROP_TASK_BEHAVIOR', terminal: withMapping([]) },
    {
      label: 'unknown-id', completionMutation: 'UNCHANGED',
      terminal: withMapping(
        ['task-behavior', 'zzz-unknown'], original.evidenceRequirements, ['task-behavior', 'zzz-unknown'],
      ),
    },
    {
      label: 'non-task-declared-id', completionMutation: 'UNCHANGED',
      terminal: withMapping(
        ['build', 'task-behavior'], original.evidenceRequirements, ['build', 'task-behavior'],
      ),
    },
    {
      label: 'target-task-mismatch', completionMutation: 'REPLACE_TASK_CONTRACT',
      terminal: withMapping(['task-contract'], mismatchRequirements),
    },
  ] as const;
}

function verifyCompletionContextWithMappingMutation(
  base: ReturnType<typeof positiveCompletionFixture>,
  mutation: ReturnType<typeof verifyMappingMutationFixtures>[number],
): unknown {
  const originalContract = base.context.manifest.authorityContract;
  let allowedDescendants: Array<Record<string, unknown>> = originalContract.allowedDescendants.map((row) => ({ ...row }));
  let descendants = [...base.context.descendants];
  if (mutation.completionMutation === 'DROP_TASK_BEHAVIOR') {
    allowedDescendants = allowedDescendants.filter((row) => descendantEvidenceRequirementId(row) !== 'task-behavior');
    descendants = descendants.filter((row) => descendantEvidenceRequirementId(row) !== 'task-behavior');
  }
  if (mutation.completionMutation === 'REPLACE_TASK_CONTRACT') {
    allowedDescendants = allowedDescendants.map((row) => {
      if (descendantEvidenceRequirementId(row) !== 'task-behavior') return row;
      const binding = requireTestJsonRecord(Reflect.get(row, 'binding'));
      return { ...row, binding: { ...binding, requirementId: 'task-contract' } };
    });
    descendants = descendants.map((row) => {
      if (descendantEvidenceRequirementId(row) !== 'task-behavior') return row;
      const oldEvidence = requireTestJsonRecord(Reflect.get(row, 'evidence'));
      const evidence = {
        ...oldEvidence,
        requirementId: 'task-contract',
        type: 'contract',
        summary: 'task-contract passed',
      };
      return {
        ...row,
        binding: { kind: 'EVIDENCE_REQUIREMENT', requirementId: 'task-contract', taskId: 'TASK-001' },
        evidence,
        evidenceRecordHash: hashStrictObject(evidence),
      };
    });
  }
  const authorityContract = {
    ...originalContract,
    allowedDescendants,
    terminal: mutation.terminal,
    terminalHash: hashStrictObject(mutation.terminal),
  };
  const manifest = {
    ...base.context.manifest,
    authorityContract,
    authorityContractHash: hashStrictObject(authorityContract),
  };
  descendants = descendants.map((row, index) => {
    const rawEvidence = Reflect.get(row, 'evidence');
    if (typeof rawEvidence !== 'object' || rawEvidence === null) return row;
    const evidence = requireTestJsonRecord(rawEvidence);
    const runBinding = requireTestJsonRecord(Reflect.get(evidence, 'runBinding'));
    const reboundEvidence = { ...evidence, runBinding: { ...runBinding, ordinal: index + 1 } };
    return { ...row, evidence: reboundEvidence, evidenceRecordHash: hashStrictObject(reboundEvidence) };
  });
  const chain = rechainTestDescendants(descendants, base.context.prepareReceiptEntryHash);
  return {
    ...base.context,
    manifest,
    descendants: chain.descendants,
    currentAuthorityHead: chain.currentAuthorityHead,
  };
}

function descendantEvidenceRequirementId(row: Record<string, unknown>): string | null {
  const binding = Reflect.get(row, 'binding');
  if (typeof binding !== 'object' || binding === null
    || Reflect.get(binding, 'kind') !== 'EVIDENCE_REQUIREMENT') return null;
  const requirementId = Reflect.get(binding, 'requirementId');
  return typeof requirementId === 'string' ? requirementId : null;
}

function qaFindingCoverageContext(
  base: ReturnType<typeof positiveCompletionFixture>,
  firstCheckRequirementIds: readonly string[],
  firstCheckEvidenceIds: readonly string[],
  findingEvidenceIds: readonly string[],
) {
  const originalTerminal = base.context.manifest.authorityContract.terminal;
  if (originalTerminal.kind !== 'QA_STAGE') assert.fail('QA coverage fixture 必须生成 QA terminal');
  const qaPolicy = {
    ...originalTerminal.qaPolicy,
    checks: originalTerminal.qaPolicy.checks.map((check, index) => (
      index === 0 ? { ...check, evidenceRequirementIds: [...firstCheckRequirementIds] } : check
    )),
  };
  const terminal = { ...originalTerminal, qaPolicy, qaPolicyHash: hashStrictObject(qaPolicy) };
  const authorityContract = {
    ...base.context.manifest.authorityContract,
    terminal,
    terminalHash: hashStrictObject(terminal),
  };
  const manifest = {
    ...base.context.manifest,
    authorityContract,
    authorityContractHash: hashStrictObject(authorityContract),
  };
  const draftContext = mutateAggregateDraftContext(
    base.context,
    'QA_DRAFT',
    'EVIDENCE_QA_IMPORT',
    (draft) => {
      const rawChecks = Reflect.get(draft, 'checks');
      if (!Array.isArray(rawChecks)) assert.fail('QA draft checks 必须是 array');
      const checks = rawChecks.map((rawCheck, index) => {
        const check = requireTestJsonRecord(rawCheck);
        return index === 0 ? { ...check, evidenceIds: [...firstCheckEvidenceIds] } : check;
      });
      return {
        ...draft,
        checks,
        findings: [{
          id: 'FINDING-001', checkId: 'product-acceptance', severity: 'MINOR', status: 'OPEN',
          summary: 'QA finding coverage probe', evidenceIds: [...findingEvidenceIds], waiverDecisionId: null,
        }],
      };
    },
  );
  return { ...draftContext, manifest };
}

function firstWorkTargetTaskFile(base: ReturnType<typeof positiveCompletionFixture>): TaskFile {
  const first = base.context.descendants.find((row) => row.kind === 'TASK_WORK');
  if (first === undefined) assert.fail('WORK positive fixture 缺少首个 TASK_WORK row');
  return taskFileSchema.parse(Reflect.get(first, 'targetTaskFile'));
}

function workCompletionWithSourceStatus(
  base: ReturnType<typeof positiveCompletionFixture>,
  status: 'RUNNING' | 'BLOCKED' | 'IMPLEMENTED',
): unknown {
  const originalTerminal = base.context.manifest.authorityContract.terminal;
  if (originalTerminal.kind !== 'WORK_STAGE') assert.fail('source status 变异必须使用 WORK terminal');
  const firstIndex = base.context.descendants.findIndex((row) => row.kind === 'TASK_WORK');
  if (firstIndex < 0) assert.fail('WORK positive fixture 缺少 TASK_WORK row');
  const targetTaskFile = taskFileSchema.parse(Reflect.get(base.context.descendants[firstIndex]!, 'targetTaskFile'));
  const sourceTaskFile = taskFileSchema.parse({
    ...targetTaskFile,
    tasks: targetTaskFile.tasks.map((task) => (
      task.id === originalTerminal.taskId ? { ...task, status } : task
    )),
  });
  const sourceTask = sourceTaskFile.tasks.find((task) => task.id === originalTerminal.taskId);
  if (sourceTask === undefined) assert.fail('WORK source Task 不存在');
  const sourceTasksHash = hashStrictObject(sourceTaskFile);
  const terminal = {
    ...originalTerminal,
    sourceTasksHash,
    sourceTaskHash: hashStrictObject(sourceTask),
  };
  const authorityContract = {
    ...base.context.manifest.authorityContract,
    terminal,
    terminalHash: hashStrictObject(terminal),
  };
  const manifest = {
    ...base.context.manifest,
    authorityContract,
    authorityContractHash: hashStrictObject(authorityContract),
  };
  const changedRows = base.context.descendants.map((row, index) => (
    index === firstIndex ? { ...row, sourceTasksHash } : row
  ));
  const chain = rechainTestDescendants(changedRows, base.context.prepareReceiptEntryHash);
  return {
    ...base.context,
    manifest,
    descendants: chain.descendants,
    currentAuthorityHead: chain.currentAuthorityHead,
  };
}

function workCompletionWithFirstTargetDrift(
  base: ReturnType<typeof positiveCompletionFixture>,
  firstTargetTaskFile: TaskFile,
): unknown {
  const firstIndex = base.context.descendants.findIndex((row) => row.kind === 'TASK_WORK');
  const secondIndex = base.context.descendants.findIndex((row, index) => index > firstIndex && row.kind === 'TASK_WORK');
  if (firstIndex < 0 || secondIndex < 0) assert.fail('WORK positive fixture 必须包含 START/IMPLEMENTED 两行');
  const targetTasksHash = hashStrictObject(firstTargetTaskFile);
  const changedRows = base.context.descendants.map((row, index) => {
    if (index === firstIndex) return { ...row, targetTaskFile: firstTargetTaskFile, targetTasksHash };
    if (index === secondIndex) return { ...row, sourceTasksHash: targetTasksHash };
    return row;
  });
  const chain = rechainTestDescendants(changedRows, base.context.prepareReceiptEntryHash);
  return {
    ...base.context,
    descendants: chain.descendants,
    currentAuthorityHead: chain.currentAuthorityHead,
  };
}

function mutateAggregateDraftContext(
  context: ReturnType<typeof positiveCompletionFixture>['context'],
  role: 'REVIEW_DRAFT' | 'QA_DRAFT',
  ownerKind: 'EVIDENCE_REVIEW_IMPORT' | 'EVIDENCE_QA_IMPORT',
  mutate: (draft: Record<string, unknown>) => Record<string, unknown>,
) {
  const capture = context.outputCaptures.find((candidate) => candidate.observation.role === role);
  if (capture?.kind !== 'FILE') assert.fail(`${role} positive fixture 缺少 FILE capture`);
  const decoded = Buffer.from(capture.bytes.rawBytesBase64, 'base64').toString('utf8');
  const bytes = frozenUtf8Blob(JSON.stringify(mutate(requireTestJsonRecord(JSON.parse(decoded)))));
  const outputCaptures = context.outputCaptures.map((candidate) => (
    candidate.observation.role === role && candidate.kind === 'FILE'
      ? {
        ...candidate,
        observation: { ...candidate.observation, rawBytesHash: bytes.rawBytesHash },
        bytes,
      }
      : candidate
  ));
  const changedRows = context.descendants.map((row) => (
    row.kind === 'EVIDENCE' && row.ownerKind === ownerKind
      ? { ...row, importedSourceHash: bytes.rawBytesHash, ownedOutputHash: bytes.rawBytesHash }
      : row
  ));
  const chain = rechainTestDescendants(changedRows, context.prepareReceiptEntryHash);
  return {
    ...context,
    outputCaptures,
    descendants: chain.descendants,
    currentAuthorityHead: chain.currentAuthorityHead,
  };
}

function mutateAggregateDraftRawContext(
  context: ReturnType<typeof positiveCompletionFixture>['context'],
  role: 'REVIEW_DRAFT' | 'QA_DRAFT',
  ownerKind: 'EVIDENCE_REVIEW_IMPORT' | 'EVIDENCE_QA_IMPORT',
  mutate: (raw: string) => string,
) {
  const capture = context.outputCaptures.find((candidate) => candidate.observation.role === role);
  if (capture?.kind !== 'FILE') assert.fail(`${role} positive fixture 缺少 FILE capture`);
  const original = Buffer.from(capture.bytes.rawBytesBase64, 'base64').toString('utf8');
  const changed = mutate(original);
  assert.notEqual(changed, original, `${role} duplicate mutation 必须改变原始字节`);
  const bytes = frozenUtf8Blob(changed);
  const outputCaptures = context.outputCaptures.map((candidate) => (
    candidate.observation.role === role && candidate.kind === 'FILE'
      ? {
        ...candidate,
        observation: { ...candidate.observation, rawBytesHash: bytes.rawBytesHash },
        bytes,
      }
      : candidate
  ));
  const changedRows = context.descendants.map((row) => (
    row.kind === 'EVIDENCE' && row.ownerKind === ownerKind
      ? { ...row, importedSourceHash: bytes.rawBytesHash, ownedOutputHash: bytes.rawBytesHash }
      : row
  ));
  const chain = rechainTestDescendants(changedRows, context.prepareReceiptEntryHash);
  return {
    ...context,
    outputCaptures,
    descendants: chain.descendants,
    currentAuthorityHead: chain.currentAuthorityHead,
  };
}

function requireTestJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    assert.fail('测试 fixture JSON 必须是 object');
  }
  return value as Record<string, unknown>;
}

function completionEvidenceId(
  context: ReturnType<typeof positiveCompletionFixture>['context'],
  requirementId: string,
): string {
  const row = context.descendants.find((candidate) => {
    const binding = Reflect.get(candidate, 'binding');
    return candidate.kind === 'EVIDENCE'
      && typeof binding === 'object' && binding !== null
      && Reflect.get(binding, 'kind') === 'EVIDENCE_REQUIREMENT'
      && Reflect.get(binding, 'requirementId') === requirementId;
  });
  if (row === undefined) {
    assert.fail(`positive fixture 缺少 ${requirementId} Evidence`);
  }
  const evidence = requireTestJsonRecord(Reflect.get(row, 'evidence'));
  const evidenceId = Reflect.get(evidence, 'id');
  if (typeof evidenceId !== 'string') assert.fail(`${requirementId} Evidence ID 不是字符串`);
  return evidenceId;
}

function workCompletionWithRepositoryPaths(
  base: ReturnType<typeof positiveCompletionFixture>,
  allowedRepositoryPaths: readonly string[],
  changedPaths: readonly string[],
): unknown {
  const originalTerminal = base.context.manifest.authorityContract.terminal;
  const originalResult = base.context.repositoryWorkResult;
  if (originalTerminal.kind !== 'WORK_STAGE' || originalResult === null) {
    assert.fail('repository path 压力 fixture 必须使用 WORK result');
  }
  const terminal = {
    ...originalTerminal,
    allowedRepositoryPaths: [...allowedRepositoryPaths],
    allowedRepositoryPathsHash: hashStrictObject(allowedRepositoryPaths),
  };
  const authorityContract = {
    ...base.context.manifest.authorityContract,
    terminal,
    terminalHash: hashStrictObject(terminal),
  };
  const manifest = {
    ...base.context.manifest,
    authorityContract,
    authorityContractHash: hashStrictObject(authorityContract),
  };
  const resultCore = {
    prepared: originalResult.prepared,
    completed: originalResult.completed,
    changedPaths: [...changedPaths],
  };
  const repositoryWorkResult = { ...resultCore, resultHash: hashStrictObject(resultCore) };
  return { ...base.context, manifest, repositoryWorkResult };
}

function rechainTestDescendants(
  rows: readonly Record<string, unknown>[],
  prepareReceiptEntryHash: string,
): { readonly descendants: readonly Record<string, unknown>[]; readonly currentAuthorityHead: string } {
  let predecessorEntryHash = prepareReceiptEntryHash;
  const descendants = rows.map((candidate, index) => {
    const row = Object.fromEntries(Object.entries(candidate).filter(([key]) => (
      key !== 'ordinal' && key !== 'predecessorEntryHash' && key !== 'entryHash'
    )));
    const ordinal = index + 1;
    const entryHash = hashStrictObject({ ordinal, predecessorEntryHash, row });
    const descendant = { ordinal, predecessorEntryHash, entryHash, ...row };
    predecessorEntryHash = entryHash;
    return descendant;
  });
  return { descendants, currentAuthorityHead: predecessorEntryHash };
}

function planAuthorityContract(terminal: ReturnType<typeof compileStageTerminal>) {
  const prepareOwner = {
    sequence: 2,
    owner: { kind: 'STAGE_PREPARE', id: 'RUN-000001' },
    operationRequestId: 'prepare-compiler-golden',
    requestDigest: SHA_C,
  } as const;
  return {
    schemaVersion: 3,
    changeId: 'CHG-0001',
    runId: 'RUN-000001',
    capability: 'plan',
    revision: 'REV-0001',
    preparedFromAuthorityHead: SHA_A,
    prepareOwner,
    authoredOutputBindings: [{
      kind: 'TASKFILE_DRAFT', role: 'TASKFILE_DRAFT',
      path: 'stage-outputs/RUN-000001/tasks.draft.yaml',
    }],
    allowedDescendants: [],
    terminal,
    terminalHash: hashStrictObject(terminal),
  } as const;
}

function frozenUtf8Blob(rawUtf8: string) {
  const bytes = Buffer.from(rawUtf8, 'utf8');
  return {
    encoding: 'BASE64',
    byteLength: bytes.byteLength,
    rawBytesBase64: bytes.toString('base64'),
    rawBytesHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  } as const;
}

// 背景：若测试调用 production ticket helper，helper 与 verifier 同时漏字段时测试仍会通过。
// 目的：测试侧逐字列出 ticket preimage，仅复用规范 HObject 原语；字段集合与 production 私有
// 构造器完全独立。上下文：writer 分配 CORE_TIME 属后续任务，本票据仍只冻结该唯一 allocation。
function literalCompletionTicket(
  current: StageAuthorityCatalogV1,
  request: unknown,
  context: {
    readonly projectWorkflowBinding: { readonly resourceBundleHash: string };
    readonly manifest: unknown;
  },
  normalizedResultHash: string,
) {
  return {
    schemaVersion: 1,
    authorityCatalogHash: hashStrictObject(current),
    resourceBundleHash: context.projectWorkflowBinding.resourceBundleHash,
    requestHash: hashStrictObject(request),
    manifestHash: hashStrictObject(context.manifest),
    contextHash: hashStrictObject(context),
    normalizedResultHash,
    requiredAllocations: ['CORE_TIME'],
  } as const;
}

// 背景：writer/context builder 属后续任务，Task 4 仍需要一个完全规范的纯值输入来证明
// compiler 自己完成认证与投影。目的：fixture 显式携带 manifest、workflow binding、
// metadata/Task CAS、progress 冻结字节和 PLAN draft，绝不借用 caller 预制 terminal result。
function planCompletionFixture(current: StageAuthorityCatalogV1) {
  const terminal = compileStageTerminal(planCompilerInput(current));
  const authorityContract = planAuthorityContract(terminal);
  const protocolBindings = [
    {
      id: 'common.authoritative-work', version: 1,
      relativePath: 'resources/protocols/common/authoritative-work.md', rawBytesHash: SHA_A,
    },
    {
      id: 'repository.plan', version: 1,
      relativePath: 'resources/protocols/repository/plan.md', rawBytesHash: SHA_B,
    },
  ] as const;
  const manifest = {
    schemaVersion: 3,
    workflowVersion: '0.3.0',
    authorityCatalogHash: hashStrictObject(current),
    runId: 'RUN-000001',
    changeId: 'CHG-0001',
    revision: 'REV-0001',
    capability: 'plan',
    preparedAt: '2026-08-24T00:05:00.000Z',
    prepareOwner: authorityContract.prepareOwner,
    prompt: {
      path: 'runs/RUN-000001/prompt.md', rendererId: 'prompt-render-v1', rendererHash: SHA_A,
      rawBytesHash: SHA_B, instructionHash: SHA_C, contextBindingsHash: SHA_A,
      protocolBindings, protocolBindingsHash: hashStrictObject(protocolBindings), renderInputHash: SHA_B,
    },
    authorityContract,
    authorityContractHash: hashStrictObject(authorityContract),
    disposition: 'PREPARED',
  } as const;
  const currentMetadata = {
    schemaVersion: 2,
    id: 'CHG-0001', slug: 'native-schema', title: 'Native Schema',
    scenario: 'small-feature', workMode: 'FEATURE', status: 'IN_PROGRESS',
    activeRevision: 'REV-0001', baseline: 'BL-0001', artifactVersions: {},
    risk: {
      level: 'P2',
      dimensions: {
        businessCriticality: 'MEDIUM', data: 'LOW', compatibility: 'LOW', reversibility: 'MEDIUM',
        security: 'LOW', operational: 'LOW',
      },
    },
    impact: {
      frontend: false, backend: true, apiContract: false, database: false,
      mq: false, remoteService: false, security: false, observability: false,
    },
    createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:04:00.000Z',
    readiness: {
      frame: 'READY', map: 'READY', research: 'READY', mitigation: 'NOT_APPLICABLE',
      triage: 'NOT_APPLICABLE', reproduction: 'NOT_APPLICABLE', diagnosis: 'NOT_APPLICABLE',
      domain: 'READY', spec: 'READY', design: 'READY', experiment: 'NOT_APPLICABLE',
      fix: 'NOT_APPLICABLE', plan: 'IN_PROGRESS', implementation: 'MISSING', review: 'MISSING',
      simplification: 'MISSING', verification: 'MISSING', qa: 'MISSING', release: 'NOT_APPLICABLE',
      canary: 'MISSING', learning: 'MISSING',
    },
  } as const;
  const targetTaskFile = structuredClone(SOURCE_TASK_FILE);
  const planDraftBytes = frozenUtf8Blob(`${JSON.stringify(targetTaskFile, null, 2)}\n`);
  const bindingWithoutHash = {
    schemaVersion: 1,
    workflowLockPath: '.omnai/workflow.lock.yaml',
    workflowLockRawBytesHash: SHA_A,
    workflowVersion: '0.3.0',
    authorityCatalogResourcePath: 'resources/authority/stage-authority-catalog.v1.yaml',
    authorityCatalogRawBytesHash: SHA_B,
    authorityCatalogHash: hashStrictObject(current),
    resourceMembers: [],
    resourceBundleHash: SHA_C,
  } as const;
  const emptyProgressBytes = frozenUtf8Blob('');
  const context = {
    projectWorkflowBinding: { ...bindingWithoutHash, bindingHash: hashStrictObject(bindingWithoutHash) },
    manifest,
    prepareReceiptEntryHash: SHA_B,
    currentAuthorityHead: SHA_B,
    descendants: [],
    currentMetadata,
    currentMetadataHash: hashStrictObject(currentMetadata),
    progress: {
      schemaVersion: 1, path: 'progress.jsonl', bytes: emptyProgressBytes,
      events: [], auditCursor: { eventCount: 0, prefixHash: emptyProgressBytes.rawBytesHash },
    },
    currentTaskFile: SOURCE_TASK_FILE,
    currentTasksHash: hashStrictObject(SOURCE_TASK_FILE),
    currentIssueState: null,
    currentIssueHash: null,
    currentRepositoryBasis: null,
    repositoryWorkResult: null,
    currentArchiveGateSnapshot: null,
    outputCaptures: [],
    planDraft: {
      path: 'stage-outputs/RUN-000001/tasks.draft.yaml', bytes: planDraftBytes,
      parsedTaskFile: targetTaskFile, targetTasksHash: hashStrictObject(targetTaskFile),
    },
  } as const;
  return {
    request: {
      runId: 'RUN-000001', expectedAuthorityHead: SHA_B,
      expectedTasksHash: context.planDraft.targetTasksHash,
    } as const,
    context,
  };
}

function directoryCompletionFixture(current: StageAuthorityCatalogV1) {
  const base = planCompletionFixture(current);
  const compiled = terminalCompilerFixture(current, 'experiment');
  const authorityContract = {
    ...base.context.manifest.authorityContract,
    capability: 'experiment',
    authoredOutputBindings: compiled.input.outputBindings,
    allowedDescendants: compileRunDescendants({
      runId: 'RUN-000001', terminal: compiled.terminal,
      evidenceRequirements: compiled.input.evidenceRequirements,
      humanGates: compiled.input.humanGates,
    }),
    terminal: compiled.terminal,
    terminalHash: hashStrictObject(compiled.terminal),
  } as const;
  const manifest = {
    ...base.context.manifest,
    capability: 'experiment', authorityContract,
    authorityContractHash: hashStrictObject(authorityContract),
  } as const;
  const bytes = frozenUtf8Blob('实验结果\n');
  const regularFiles = [{ path: 'experiments/result.md', rawBytesHash: bytes.rawBytesHash }] as const;
  const context = {
    ...base.context,
    manifest,
    outputCaptures: [{
      kind: 'DIRECTORY',
      observation: {
        kind: 'DIRECTORY', role: 'EXPERIMENTS', path: 'experiments',
        regularFileCount: 1, regularFiles,
        regularFilesTreeHash: hashStrictObject(regularFiles),
      },
      files: [{ path: 'experiments/result.md', bytes }],
    }],
    planDraft: null,
  } as const;
  return {
    request: { runId: 'RUN-000001', expectedAuthorityHead: SHA_B, expectedTasksHash: null } as const,
    context,
  };
}

function reviewStressCompletionFixture(current: StageAuthorityCatalogV1, count: number) {
  const base = planCompletionFixture(current);
  const compiled = terminalCompilerFixture(current, 'review');
  if (compiled.terminal.kind !== 'REVIEW_STAGE') assert.fail('压力 fixture 必须使用 Review terminal');
  const aggregateRequirement = compiled.input.evidenceRequirements.find(
    (requirement) => requirement.requirementId === 'repository-review',
  );
  if (aggregateRequirement === undefined) assert.fail('Review 压力 fixture 缺少 aggregate requirement');
  const requirements = [aggregateRequirement, ...Array.from({ length: count - 1 }, (_, index) => ({
    requirementId: `stress-${String(index + 1).padStart(4, '0')}`,
    producer: 'GENERIC_IMPORT',
    allowedTypes: ['manual'],
    allowedStatuses: ['FAIL', 'INCONCLUSIVE', 'PASS'],
    satisfyingStatus: 'PASS',
    outputPolicy: 'OWNED_OUTPUT_REQUIRED',
    sourceScope: 'RUN_BOUND',
    subjectPolicy: 'EXACT_RUN_SUBJECT',
    taskScope: { kind: 'NONE' },
    minimumRecords: 1,
  }))] as typeof compiled.input.evidenceRequirements;
  const terminal = {
    ...compiled.terminal,
    evidenceRequirements: requirements,
    evidenceRequirementsHash: hashStrictObject(requirements),
  };
  const allowedDescendants = compileRunDescendants({
    runId: 'RUN-000001', terminal, evidenceRequirements: requirements, humanGates: [],
  });
  const authorityContract = {
    ...base.context.manifest.authorityContract,
    capability: 'review',
    authoredOutputBindings: compiled.input.outputBindings,
    allowedDescendants,
    terminal,
    terminalHash: hashStrictObject(terminal),
  } as const;
  const manifest = {
    ...base.context.manifest,
    capability: 'review', authorityContract,
    authorityContractHash: hashStrictObject(authorityContract),
  } as const;
  const subject = { kind: 'REPOSITORY_BASIS', revision: 'REV-0001', basis: BASIS } as const;
  const subjectBinding = { subject, subjectHash: hashStrictObject(subject) } as const;
  let predecessorEntryHash: string = SHA_B;
  const descendants = requirements.map((requirement, index) => {
    const ordinal = index + 1;
    const evidenceId = `EVD-${String(ordinal).padStart(6, '0')}`;
    const aggregate = requirement.requirementId === 'repository-review';
    const evidence = {
      schemaVersion: 1,
      id: evidenceId,
      changeId: 'CHG-0001', revision: 'REV-0001',
      runBinding: { runId: 'RUN-000001', prepareOwner: authorityContract.prepareOwner, ordinal },
      requirementId: requirement.requirementId, gateId: null, taskId: null,
      type: aggregate ? 'review' : 'manual', status: 'PASS',
      producer: aggregate ? 'REVIEW_RESULT_IMPORT' : 'GENERIC_IMPORT', subjectBinding,
      summary: `Stress Evidence ${ordinal}`,
      verificationCommand: null,
      createdAt: '2026-08-24T00:05:00.000Z',
      outputFile: `evidence/outputs/${evidenceId}/output.bin`,
    } as const;
    const entryHash = hashStrictObject({ kind: 'STRESS_EVIDENCE', ordinal, predecessorEntryHash });
    const row = {
      ordinal, predecessorEntryHash, entryHash,
      kind: 'EVIDENCE', ownerKind: aggregate ? 'EVIDENCE_REVIEW_IMPORT' : 'EVIDENCE_GENERIC',
      binding: { kind: 'EVIDENCE_REQUIREMENT', requirementId: requirement.requirementId, taskId: null },
      evidence, evidenceRecordHash: hashStrictObject(evidence), subjectBinding,
      ownedOutputHash: SHA_A, importedSourceHash: SHA_B, windowClosedAt: null,
    } as const;
    predecessorEntryHash = entryHash;
    return row;
  });
  const context = {
    ...base.context,
    manifest,
    currentAuthorityHead: predecessorEntryHash,
    descendants,
    currentRepositoryBasis: BASIS,
    outputCaptures: [],
    planDraft: null,
  } as const;
  return {
    request: { runId: 'RUN-000001', expectedAuthorityHead: SHA_B, expectedTasksHash: null } as const,
    context,
  };
}

function positiveCompletionFixture(
  current: StageAuthorityCatalogV1,
  capability: 'triage' | 'reproduce' | 'debug' | 'work' | 'simplify' | 'review' | 'verify' | 'qa' | 'canary' | 'ship' | 'archive' | 'reconcile',
) {
  const base = planCompletionFixture(current);
  const compiled = terminalCompilerFixture(current, capability);
  const terminal = compiled.terminal;
  const allowedDescendants = compileRunDescendants({
    runId: 'RUN-000001', terminal,
    evidenceRequirements: compiled.input.evidenceRequirements,
    humanGates: compiled.input.humanGates,
  });
  const authorityContract = {
    ...base.context.manifest.authorityContract,
    capability,
    authoredOutputBindings: compiled.input.outputBindings,
    allowedDescendants,
    terminal,
    terminalHash: hashStrictObject(terminal),
  } as const;
  const manifest = {
    ...base.context.manifest,
    capability,
    authorityContract,
    authorityContractHash: hashStrictObject(authorityContract),
  } as const;

  const completedBasis = repositoryWorkBasisSchema.parse({ ...BASIS, workingPatchHash: SHA_C });
  const repositoryResultCore = { prepared: BASIS, completed: completedBasis, changedPaths: ['src/compiler.ts'] } as const;
  const repositoryWorkResult = capability === 'work' || capability === 'simplify'
    ? { ...repositoryResultCore, resultHash: hashStrictObject(repositoryResultCore) } : null;

  const requirements = 'evidenceRequirements' in terminal ? terminal.evidenceRequirements : [];
  const evidencePlans = requirements.flatMap((requirement) => completionRequirementTaskIds(requirement, terminal)
    .map((taskId) => ({ requirement, taskId })));
  const evidenceIdByRequirement = new Map<string, string[]>();
  for (const [index, plan] of evidencePlans.entries()) {
    const evidenceId = `EVD-${String(index + 1).padStart(6, '0')}`;
    const ids = evidenceIdByRequirement.get(plan.requirement.requirementId);
    if (ids === undefined) evidenceIdByRequirement.set(plan.requirement.requirementId, [evidenceId]);
    else ids.push(evidenceId);
  }

  const draftByRole = new Map<string, ReturnType<typeof frozenUtf8Blob>>();
  if (terminal.kind === 'REVIEW_STAGE') {
    const check = (value: string) => ({ check: value, status: 'PASS', evidenceIds: [], summary: `${value} passed` });
    const draft = {
      schemaVersion: 2, changeId: 'CHG-0001', revision: 'REV-0001', runId: 'RUN-000001', scope: terminal.reviewScope,
      axes: {
        specification: { status: 'PASS', checks: terminal.reviewPolicy.specification.map(check) },
        standards: { status: 'PASS', checks: terminal.reviewPolicy.standards.map(check) },
        riskProduction: { status: 'PASS', checks: terminal.reviewPolicy.riskProduction.map(check) },
      },
      findings: [], conclusion: 'PASS',
    };
    draftByRole.set('REVIEW_DRAFT', frozenUtf8Blob(JSON.stringify(draft)));
  }
  if (terminal.kind === 'QA_STAGE') {
    const draft = {
      schemaVersion: 1, changeId: 'CHG-0001', revision: 'REV-0001', runId: 'RUN-000001',
      testedBasisHash: hashStrictObject(terminal.testedBasis),
      checks: terminal.qaPolicy.checks.map((check) => ({
        checkId: check.checkId, status: 'PASS',
        evidenceIds: check.evidenceRequirementIds.flatMap((requirementId) => evidenceIdByRequirement.get(requirementId) ?? []).sort(),
        summary: `${check.checkId} passed`,
      })),
      findings: [], conclusion: 'PASS',
    };
    draftByRole.set('QA_DRAFT', frozenUtf8Blob(JSON.stringify(draft)));
  }
  if (terminal.kind === 'CANARY_STAGE') {
    const draft = {
      schemaVersion: 1, changeId: 'CHG-0001', revision: 'REV-0001', runId: 'RUN-000001',
      releaseSubjectHash: terminal.releaseSubjectBinding.subjectHash,
      windowOpenedAt: terminal.windowOpenedAt,
      observations: terminal.canaryPolicy.signals.map((signal) => ({
        signalId: signal.signalId,
        measurementEvidenceId: evidenceIdByRequirement.get(signal.measurementRequirementId)![0]!,
        summary: `${signal.signalId} passed`,
      })),
      decision: 'CONTINUE', summary: 'Canary passed',
    };
    draftByRole.set('CANARY_DRAFT', frozenUtf8Blob(JSON.stringify(draft)));
  }

  const outputCaptures = authorityContract.authoredOutputBindings.flatMap((binding) => {
    if (binding.kind === 'REPOSITORY_DIFF') return [];
    if (binding.kind === 'AUTHORED_DIRECTORY') assert.fail('通用 positive fixture 不处理 Artifact directory');
    const bytes = draftByRole.get(binding.role) ?? frozenUtf8Blob(`${binding.role} completed\n`);
    return [{
      kind: 'FILE',
      observation: { kind: 'FILE', role: binding.role, path: binding.path, rawBytesHash: bytes.rawBytesHash },
      bytes,
    }];
  });
  const captureHashByRole = new Map(outputCaptures.map((capture) => [capture.observation.role, capture.bytes.rawBytesHash]));

  let currentTaskFile: TaskFile = taskFileSchema.parse(SOURCE_TASK_FILE);
  let currentIssueState: null | {
    triageState: 'needs-info' | 'ready-for-debug' | 'ready-for-fix' | 'needs-experiment' | 'ready-for-human' | 'wontfix';
    reproduction: 'unknown' | 'confirmed' | 'not-reproducible' | 'instrumentation-required';
    rootCause: 'unknown' | 'suspected' | 'confirmed';
    fixStrategy: 'unknown' | 'ready' | 'needs-experiment';
  } = null;
  let currentRepositoryBasis: RepositoryWorkBasis | null = [
    'triage', 'reproduce', 'debug', 'review', 'verify', 'qa', 'ship',
  ].includes(capability)
    ? repositoryWorkBasisSchema.parse(BASIS) : null;
  let currentArchiveGateSnapshot: z.output<typeof archiveGateSnapshotSchema> | null = null;
  let currentMetadata: ChangeMetadata = changeMetadataSchema.parse(base.context.currentMetadata);
  const descendantRows: Array<Record<string, unknown>> = [];
  let predecessorEntryHash: string = SHA_B;
  const appendDescendant = (row: Record<string, unknown>): number => {
    const ordinal = descendantRows.length + 1;
    const entryHash = hashStrictObject({ ordinal, predecessorEntryHash, row });
    descendantRows.push({ ordinal, predecessorEntryHash, entryHash, ...row });
    predecessorEntryHash = entryHash;
    return ordinal;
  };

  if (terminal.kind === 'WORK_STAGE') {
    const sourceTaskFile = compiled.input.source.taskFile;
    const runningTaskFile = {
      ...sourceTaskFile,
      tasks: sourceTaskFile.tasks.map((task) => task.id === terminal.taskId ? { ...task, status: 'RUNNING' as const } : task),
    };
    appendDescendant({
      kind: 'TASK_WORK', binding: { kind: 'TASK_ID', taskId: terminal.taskId },
      action: { kind: 'START', taskId: terminal.taskId },
      sourceTasksHash: terminal.sourceTasksHash,
      targetTaskFile: runningTaskFile,
      targetTasksHash: hashStrictObject(runningTaskFile),
    });
    currentTaskFile = taskFileSchema.parse({
      ...runningTaskFile,
      tasks: runningTaskFile.tasks.map((task) => task.id === terminal.taskId ? { ...task, status: 'IMPLEMENTED' as const } : task),
    });
    currentRepositoryBasis = completedBasis;
  }
  if (terminal.kind === 'SIMPLIFY_STAGE') currentRepositoryBasis = completedBasis;
  if (terminal.kind === 'VERIFY_STAGE') {
    currentTaskFile = terminal.targetTaskFile;
    currentRepositoryBasis = terminal.verifiedBasis;
  }
  if (terminal.kind === 'ARCHIVE_STAGE') currentArchiveGateSnapshot = terminal.requiredGateSnapshot;
  if (terminal.kind === 'RECONCILE_STAGE') {
    currentMetadata = changeMetadataSchema.parse({ ...base.context.currentMetadata, activeRevision: 'REV-0002' });
    currentTaskFile = taskFileSchema.parse({ ...SOURCE_TASK_FILE, revision: 'REV-0002' });
  }

  for (const [index, plan] of evidencePlans.entries()) {
    const ordinal = descendantRows.length + 1;
    const evidenceId = `EVD-${String(index + 1).padStart(6, '0')}`;
    const subject = completionEvidenceSubject(terminal, plan.taskId, repositoryWorkResult);
    const subjectBinding = { subject, subjectHash: hashStrictObject(subject) };
    const producer = plan.requirement.producer;
    const ownerKind = {
      GENERIC_IMPORT: 'EVIDENCE_GENERIC',
      VERIFICATION_COMMAND: 'VERIFICATION_COMMAND',
      REVIEW_RESULT_IMPORT: 'EVIDENCE_REVIEW_IMPORT',
      QA_RESULT_IMPORT: 'EVIDENCE_QA_IMPORT',
      CANARY_MEASUREMENT_IMPORT: 'EVIDENCE_CANARY_MEASUREMENT',
      CANARY_RESULT_IMPORT: 'EVIDENCE_CANARY_IMPORT',
    }[producer];
    const aggregateRole = producer === 'REVIEW_RESULT_IMPORT' ? 'REVIEW_DRAFT'
      : producer === 'QA_RESULT_IMPORT' ? 'QA_DRAFT'
        : producer === 'CANARY_RESULT_IMPORT' ? 'CANARY_DRAFT' : null;
    const aggregateHash = aggregateRole === null ? null : captureHashByRole.get(aggregateRole)!;
    const evidence = {
      schemaVersion: 1, id: evidenceId, changeId: 'CHG-0001', revision: 'REV-0001',
      runBinding: { runId: 'RUN-000001', prepareOwner: authorityContract.prepareOwner, ordinal },
      requirementId: plan.requirement.requirementId, gateId: null, taskId: plan.taskId,
      type: plan.requirement.allowedTypes[0]!, status: 'PASS', producer, subjectBinding,
      summary: `${plan.requirement.requirementId} passed`,
      verificationCommand: producer === 'VERIFICATION_COMMAND'
        ? { executable: 'node', arguments: ['--version'], outcome: { kind: 'EXITED', exitCode: 0, signal: null } }
        : null,
      createdAt: '2026-08-24T00:06:00.000Z',
      outputFile: `evidence/outputs/${evidenceId}/output.bin`,
    };
    appendDescendant({
      kind: 'EVIDENCE', ownerKind,
      binding: { kind: 'EVIDENCE_REQUIREMENT', requirementId: plan.requirement.requirementId, taskId: plan.taskId },
      evidence, evidenceRecordHash: hashStrictObject(evidence), subjectBinding,
      ownedOutputHash: aggregateHash ?? SHA_A,
      importedSourceHash: producer === 'VERIFICATION_COMMAND' ? null : aggregateHash ?? SHA_B,
      windowClosedAt: producer === 'CANARY_RESULT_IMPORT' ? '2026-08-24T00:10:00.000Z' : null,
    });
  }

  for (const gate of compiled.input.humanGates) {
    const ordinal = descendantRows.length + 1;
    const evidenceId = `EVD-${String(evidencePlans.length + ordinal).padStart(6, '0')}`;
    const subject = completionEvidenceSubject(terminal, null, repositoryWorkResult);
    const subjectBinding = { subject, subjectHash: hashStrictObject(subject) };
    const evidence = {
      schemaVersion: 1, id: evidenceId, changeId: 'CHG-0001', revision: 'REV-0001',
      runBinding: { runId: 'RUN-000001', prepareOwner: authorityContract.prepareOwner, ordinal },
      requirementId: null, gateId: gate.gateId, taskId: null,
      type: 'manual', status: 'PASS', producer: 'HUMAN_APPROVAL', subjectBinding,
      summary: `${gate.gateId} approved`, verificationCommand: null,
      createdAt: '2026-08-24T00:06:00.000Z', outputFile: null,
    };
    const approvedCapture = gate.approvedArtifactRole === null ? undefined
      : outputCaptures.find((capture) => capture.observation.role === gate.approvedArtifactRole);
    appendDescendant({
      kind: 'HUMAN_APPROVAL', binding: { kind: 'HUMAN_GATE', gateId: gate.gateId },
      evidence, evidenceRecordHash: hashStrictObject(evidence),
      approvedArtifact: approvedCapture === undefined ? null : {
        role: approvedCapture.observation.role,
        path: approvedCapture.observation.path,
        rawBytesHash: approvedCapture.observation.rawBytesHash,
      },
    });
  }

  if (terminal.kind === 'WORK_STAGE') {
    const runningHash = hashStrictObject({
      ...currentTaskFile,
      tasks: currentTaskFile.tasks.map((task) => task.id === terminal.taskId ? { ...task, status: 'RUNNING' } : task),
    });
    appendDescendant({
      kind: 'TASK_WORK', binding: { kind: 'TASK_ID', taskId: terminal.taskId },
      action: { kind: 'IMPLEMENTED', taskId: terminal.taskId },
      sourceTasksHash: runningHash,
      targetTaskFile: currentTaskFile,
      targetTasksHash: hashStrictObject(currentTaskFile),
    });
  }
  if (terminal.kind === 'ISSUE_STAGE') {
    const action = capability === 'triage'
      ? { kind: 'TRIAGE_RESULT' as const, triageState: 'ready-for-debug' as const }
      : capability === 'reproduce'
        ? { kind: 'REPRODUCTION_RESULT' as const, reproduction: 'confirmed' as const }
        : { kind: 'DEBUG_RESULT' as const, fixStrategy: 'ready' as const };
    currentIssueState = {
      triageState: capability === 'debug' ? 'ready-for-fix' : 'ready-for-debug',
      reproduction: 'confirmed', rootCause: 'confirmed', fixStrategy: 'ready',
    };
    appendDescendant({
      kind: 'ISSUE_UPDATE', binding: { kind: 'RUN_ONLY' }, action,
      sourceIssueHash: terminal.sourceIssueHash,
      targetIssueState: currentIssueState,
      targetIssueHash: hashStrictObject(currentIssueState),
    });
  }
  if (terminal.kind === 'RECONCILE_STAGE') {
    appendDescendant({
      kind: 'FLOW_ASSESSMENT', binding: { kind: 'RUN_ONLY' },
      sourceRevision: terminal.sourceRevision, targetRevision: 'REV-0002',
    });
  }

  const context = {
    ...base.context,
    manifest,
    currentAuthorityHead: predecessorEntryHash,
    descendants: descendantRows,
    currentMetadata,
    currentMetadataHash: hashStrictObject(currentMetadata),
    currentTaskFile,
    currentTasksHash: hashStrictObject(currentTaskFile),
    currentIssueState,
    currentIssueHash: currentIssueState === null ? null : hashStrictObject(currentIssueState),
    currentRepositoryBasis,
    repositoryWorkResult,
    currentArchiveGateSnapshot,
    outputCaptures,
    planDraft: null,
  };
  return {
    request: { runId: 'RUN-000001', expectedAuthorityHead: SHA_B, expectedTasksHash: null } as const,
    context,
  };
}

function completionRequirementTaskIds(
  requirement: ReturnType<typeof terminalCompilerFixture>['input']['evidenceRequirements'][number],
  terminal: ReturnType<typeof compileStageTerminal>,
): Array<string | null> {
  if (requirement.taskScope.kind === 'NONE') return [null];
  if (requirement.taskScope.kind === 'SELECTED_TASK') {
    if (terminal.kind === 'WORK_STAGE') return [terminal.taskId];
    if (terminal.kind === 'REVIEW_STAGE' && terminal.reviewScope.kind === 'TASK') return [terminal.reviewScope.taskId];
    assert.fail('SELECTED_TASK positive fixture 缺少 Task');
  }
  if (terminal.kind !== 'VERIFY_STAGE') assert.fail('Task-declared Evidence 只能用于 Verify positive fixture');
  if (requirement.taskScope.kind === 'EACH_VERIFICATION_TASK') return [...terminal.verificationTaskIds];
  return terminal.verificationTaskRequirements.filter((binding) => binding.requirementIds.includes(requirement.requirementId))
    .map((binding) => binding.taskId);
}

function completionEvidenceSubject(
  terminal: ReturnType<typeof compileStageTerminal>,
  taskId: string | null,
  repositoryWorkResult: null | { readonly completed: RepositoryWorkBasis },
): unknown {
  if (terminal.kind === 'CANARY_STAGE') return { kind: 'RELEASE_SUBJECT', binding: terminal.releaseSubjectBinding };
  const basis = terminal.kind === 'ISSUE_STAGE' ? terminal.observedBasis
    : terminal.kind === 'WORK_STAGE' || terminal.kind === 'SIMPLIFY_STAGE' ? repositoryWorkResult!.completed
      : terminal.kind === 'REVIEW_STAGE' ? terminal.reviewedBasis
        : terminal.kind === 'VERIFY_STAGE' ? terminal.verifiedBasis
          : terminal.kind === 'QA_STAGE' ? terminal.testedBasis
            : terminal.kind === 'DELIVERY_STAGE' ? terminal.deliveryBasis : null;
  if (basis !== null) return taskId === null
    ? { kind: 'REPOSITORY_BASIS', revision: 'REV-0001', basis }
    : { kind: 'TASK_REPOSITORY_BASIS', revision: 'REV-0001', taskId, basis };
  return { kind: 'CHANGE_AUTHORITY', revision: 'REV-0001', authorityHead: SHA_A };
}

function terminalCompilerFixture(
  current: StageAuthorityCatalogV1,
  capability: StageAuthorityCatalogV1['capabilityTemplates'][number]['capability'],
) {
  const template = current.capabilityTemplates.find((row) => row.capability === capability)!;
  const scenarioId = capability === 'qa' || capability === 'canary' ? 'product-discovery' : 'small-feature';
  const scenario = current.scenarioProfiles.find((row) => row.id === scenarioId)!;
  const activeRoute = {
    schemaVersion: 1,
    scenarioId,
    requiredCapabilities: [capability],
    selectedOptionalCapabilities: [],
    activeCapabilities: [capability],
    implementationRequired: capability === 'plan' || capability === 'work' || capability === 'verify',
  } as const;
  const review = capability === 'review' ? compileReviewPolicy({
    scenario,
    risk: planCompilerInput(current).source.currentRisk,
    impact: planCompilerInput(current).source.currentImpact,
  }) : null;
  const qa = capability === 'qa' ? compileQaPolicyByScenario({
    scenarioId, policies: current.qaPoliciesByScenario,
  }) : null;
  const canary = capability === 'canary' ? compileCanaryPolicyByScenario({
    scenarioId, policies: current.canaryPoliciesByScenario,
    ship: completedShipAuthority(current), coreTime: '2026-08-24T00:05:00.000Z',
  }).policy : null;
  const verify = capability === 'verify' ? compileVerifyScenarioTaskEvidence({
    scenarioRequiredEvidence: scenario.requiredEvidence, taskFile: SOURCE_TASK_FILE,
    taskEvidenceRequirementIds: current.taskEvidenceRequirementIds,
    evidenceTemplates: current.evidenceTemplates, verifiedBasis: BASIS,
    activeRoute,
  }) : null;
  const delivery = capability === 'ship' ? compileDeliveryPolicy({
    mode: 'PREPARE',
    evidenceRequirementIds: template.baseEvidenceRequirementIds,
    humanGateIds: template.humanGateIds,
    evidenceTemplates: current.evidenceTemplates,
    humanGateTemplates: current.humanGateTemplates,
  }).fragment : null;
  const evidenceIds = capability === 'verify' ? verify!.evidenceRequirements.map((row) => row.requirementId)
    : capability === 'ship' ? delivery!.evidenceRequirements.map((row) => row.requirementId)
      : capability === 'qa' ? [...new Set([
        ...template.baseEvidenceRequirementIds,
        ...qa!.checks.flatMap((check) => check.evidenceRequirementIds),
      ])].sort()
        : capability === 'canary' ? [...new Set([
          ...template.baseEvidenceRequirementIds,
          ...canary!.signals.flatMap((signal) => [
            signal.measurementRequirementId, ...signal.sourceEvidenceRequirementIds,
          ]),
        ])].sort()
          : [...template.baseEvidenceRequirementIds];
  const evidenceRequirements = capability === 'verify' ? verify!.evidenceRequirements
    : capability === 'ship' ? delivery!.evidenceRequirements
      : evidenceIds.map((requirementId) => {
        const row = current.evidenceTemplates.find((candidate) => candidate.requirementId === requirementId)!;
        if (row.taskScopeFormula !== 'REVIEW_SCOPE') return instantiateEvidenceTemplate(row);
        return {
          requirementId: row.requirementId, producer: row.producer,
          allowedTypes: row.allowedTypes, allowedStatuses: row.allowedStatuses,
          satisfyingStatus: row.satisfyingStatus, outputPolicy: row.outputPolicy,
          sourceScope: row.sourceScope, subjectPolicy: row.subjectPolicy,
          taskScope: { kind: 'NONE' }, minimumRecords: row.minimumRecords,
        } as const;
      });
  const humanGates = template.humanGateIds.map((gateId) => current.humanGateTemplates.find(
    (candidate) => candidate.gateId === gateId,
  )!);
  const outputBindings = terminalOutputBindings(current, capability);
  const archiveRoute = {
    schemaVersion: 1, scenarioId: 'small-feature', requiredCapabilities: ['archive'],
    selectedOptionalCapabilities: [], activeCapabilities: ['archive'], implementationRequired: false,
  } as const;
  const archiveGateSnapshot = capability === 'archive' ? {
    schemaVersion: 1,
    scenarioId: 'small-feature', activeRoute: archiveRoute,
    activeRouteHash: hashStrictObject(archiveRoute), requiredReadiness: [],
    tasksHash: hashStrictObject(SOURCE_TASK_FILE), unfinishedTaskIds: [],
    blockingDecisionIds: [], nonterminalRunIds: [],
  } as const : null;
  const sourceTaskFile = capability === 'work' ? {
    ...SOURCE_TASK_FILE,
    tasks: SOURCE_TASK_FILE.tasks.map((task) => task.id === 'TASK-001' ? { ...task, status: 'READY' as const } : task),
  } : SOURCE_TASK_FILE;
  const sourceIssueState = ['triage', 'reproduce', 'debug'].includes(capability) ? {
    triageState: 'ready-for-debug' as const,
    reproduction: 'confirmed' as const,
    rootCause: 'confirmed' as const,
    fixStrategy: 'ready' as const,
  } : null;
  const input = {
    authorityCatalog: current,
    capability,
    changeTitle: 'Native Schema',
    sealedArtifactRenders: capability === 'frame'
      ? [{ entryId: 'frame:INTENT', renderedScaffoldHash: SHA_A }] : [],
    identity: { changeId: 'CHG-0001', revision: 'REV-0001', runId: 'RUN-000001' },
    source: {
      authorityHead: SHA_A, metadataHash: SHA_B,
      currentRisk: planCompilerInput(current).source.currentRisk,
      currentImpact: planCompilerInput(current).source.currentImpact,
      activeRoute, activeRouteHash: hashStrictObject(activeRoute),
      tasksHash: hashStrictObject(sourceTaskFile), taskFile: sourceTaskFile,
      issueHash: sourceIssueState === null ? null : hashStrictObject(sourceIssueState),
      issueState: sourceIssueState,
      repositoryBasis: [
        'triage', 'reproduce', 'debug', 'work', 'simplify', 'review', 'verify', 'qa', 'ship',
      ].includes(capability) ? BASIS : null,
      repositoryRetryState: null, repositoryRetryStartResult: null,
      archiveGateSnapshot,
    },
    selection: {
      taskId: capability === 'work' ? 'TASK-001' : null,
      retryRunId: null,
      reviewScope: capability === 'review' ? {
        kind: 'CHANGE', sourceAuthorityHead: SHA_A, repositoryWorkHash: hashStrictObject(BASIS),
      } : null,
    },
    outputBindings,
    evidenceRequirements,
    humanGates,
    policies: { review, qa, canary },
    verify,
    delivery,
    ship: capability === 'canary' ? completedShipAuthority(current) : null,
    coreTime: '2026-08-24T00:05:00.000Z',
  };
  return { input, terminal: compileStageTerminal(input) };
}

function terminalOutputBindings(
  current: StageAuthorityCatalogV1,
  capability: StageAuthorityCatalogV1['capabilityTemplates'][number]['capability'],
) {
  if (capability === 'plan') return [{
    kind: 'TASKFILE_DRAFT', role: 'TASKFILE_DRAFT', path: 'stage-outputs/RUN-000001/tasks.draft.yaml',
  }] as const;
  if (capability === 'work') return [{
    kind: 'REPOSITORY_DIFF', role: 'IMPLEMENTATION_DIFF', taskId: 'TASK-001', basis: BASIS,
  }] as const;
  if (capability === 'simplify') return [{
    kind: 'REPOSITORY_DIFF', role: 'SIMPLIFICATION_DIFF', taskId: null, basis: BASIS,
  }] as const;
  if (capability === 'review') return [{
    kind: 'REVIEW_DRAFT', role: 'REVIEW_DRAFT', path: 'stage-outputs/RUN-000001/review.draft.json',
    schemaIdentity: 'omnai.review-draft.v2',
  }] as const;
  if (capability === 'qa') return [{
    kind: 'QA_DRAFT', role: 'QA_DRAFT', path: 'stage-outputs/RUN-000001/qa.draft.json',
    schemaIdentity: 'omnai.qa-result-draft.v1',
  }] as const;
  if (capability === 'canary') return [{
    kind: 'CANARY_DRAFT', role: 'CANARY_DRAFT', path: 'stage-outputs/RUN-000001/canary.draft.json',
    schemaIdentity: 'omnai.canary-result-draft.v1',
  }] as const;
  if (capability === 'verify' || capability === 'archive' || capability === 'reconcile') return [] as const;
  const entries = current.artifactAuthority.entries.filter((entry) => entry.capability === capability
    && entry.activation.kind === 'ALWAYS');
  return entries.map((entry) => entry.kind === 'FILE' ? {
    kind: 'AUTHORED_FILE' as const,
    role: entry.role,
    path: entry.path,
    scaffoldBinding: entry.scaffold === null ? null : {
      templateId: entry.scaffold.templateId,
      templateHash: entry.scaffold.templateHash,
      renderInputs: entry.scaffold.renderInputs.kind === 'NONE' ? {} : {
        title: 'Native Schema', scenarioId: 'small-feature', workMode: 'FEATURE', risk: 'P2',
      },
      renderedScaffoldHash: entry.scaffold.renderInputs.kind === 'NONE'
        ? entry.scaffold.templateHash : SHA_A,
    },
  } : {
    kind: 'AUTHORED_DIRECTORY' as const, role: entry.role, path: entry.path,
    minimumRegularFiles: entry.minimumRegularFiles,
  });
}

// 该测试会在 renderer trim instruction、合并 LF、排序 caller arrays、容忍目录逃逸，
// 或用字符串比较替代 raw Buffer 比较时失败。fixture 是 Task 4 测试向量，不是 Task 9E 资源。
test('prompt-render 以 literal input/prompt/SHA 闭合 missing、目录、Flow 与 Decisions', async () => {
  const fixtureRoot = join(process.cwd(), 'src', 'authority', 'test', 'fixtures');
  const [inputBytes, expectedPromptBytes, expectedShaBytes] = await Promise.all([
    readFile(join(fixtureRoot, 'prompt-render-v1.input.json')),
    readFile(join(fixtureRoot, 'prompt-render-v1.prompt.md')),
    readFile(join(fixtureRoot, 'prompt-render-v1.sha256')),
  ]);
  const fatalDecoder = new TextDecoder('utf-8', { fatal: true });
  const input = JSON.parse(fatalDecoder.decode(inputBytes)) as Record<string, unknown>;
  const expectedShaText = fatalDecoder.decode(expectedShaBytes);
  assert.match(expectedShaText, /^sha256:[0-9a-f]{64}\n$/u);
  const expectedSha = expectedShaText.slice(0, -1);
  const independentSha = `sha256:${createHash('sha256').update(expectedPromptBytes).digest('hex')}`;
  assert.equal(independentSha, expectedSha);
  assert.throws(() => fatalDecoder.decode(Buffer.from([0xff])));

  const prompt = assertDeterministic(compilePromptRender, input);
  assert.deepEqual(Buffer.from(prompt.rawUtf8, 'utf8'), expectedPromptBytes);
  assert.equal(prompt.rawBytesHash, expectedSha);
  assert.equal(hashStrictObject(prompt), 'sha256:242813fd82b81ea3f181cf699d1a534e9ec56c7d50030399aa90c06faa9933fb');
  assert.equal((prompt.rawUtf8.match(/OMNAI_BLOCK_V1 /gu) ?? []).length, 12);
  assert.equal(prompt.rawUtf8.endsWith('OMNAI_END_BLOCK_V1\n'), true);

  const contexts = input.contexts as Array<Record<string, unknown>>;
  const directory = contexts[1]!;
  const missing = contexts[0]!;
  assert.throws(() => compilePromptRender({
    ...input,
    contexts: [{ ...missing, locator: { ...(missing.locator as Record<string, unknown>), kind: 'FILE' } }, directory],
  }));
  assert.throws(() => compilePromptRender({
    ...input,
    contexts: [contexts[0], { ...directory, entries: [...directory.entries as unknown[]].reverse() }],
  }));
  const decisions = input.decisionSnapshots as unknown[];
  assert.throws(() => compilePromptRender({ ...input, decisionSnapshots: [...decisions].reverse() }));
  assert.throws(() => compilePromptRender({ ...input, instruction: 'bad\rline' }));
  const escapedEntry = { path: 'outside.md', rawUtf8: 'X', rawBytesHash: hashUtf8('X') };
  assert.throws(() => compilePromptRender({
    ...input,
    contexts: [contexts[0], {
      ...directory,
      entries: [escapedEntry],
      inventoryHash: hashStrictObject([{ path: escapedEntry.path, rawBytesHash: escapedEntry.rawBytesHash }]),
    }],
  }));
});

// 该测试会在 renderer trim instruction、合并 LF、排序 caller arrays 或改变 block framing 时失败。
test('prompt-render 输出 exact OMNAI_PROMPT_V1 字节帧与所有相邻 hash', async () => {
  const current = await authorityCatalog();
  const terminal = compileStageTerminal(planCompilerInput(current));
  const authorityContract = planAuthorityContract(terminal);
  const input = {
    schemaVersion: 1,
    identity: { changeId: 'CHG-0001', revision: 'REV-0001', runId: 'RUN-000001', capability: 'plan' },
    instruction: '先验证契约\n再生成计划',
    protocols: [
      {
        id: 'common.authoritative-work', version: 1,
        relativePath: 'resources/protocols/common/authoritative-work.md',
        rawBytesHash: hashUtf8('共同协议\n'), rawUtf8: '共同协议\n',
      },
      {
        id: 'repository.plan', version: 1,
        relativePath: 'resources/protocols/repository/plan.md',
        rawBytesHash: hashUtf8('计划协议'), rawUtf8: '计划协议',
      },
    ],
    contexts: [{ locator: { scope: 'CHANGE', path: 'intent.md' }, kind: 'MISSING' }],
    flowSnapshot: { value: { flow: 'locked' }, canonicalHash: hashStrictObject({ flow: 'locked' }) },
    decisionSnapshots: [
      { decisionId: 'DEC-0001', value: { choice: 'A' }, canonicalHash: hashStrictObject({ choice: 'A' }) },
      { decisionId: 'DEC-0002', value: { choice: 'B' }, canonicalHash: hashStrictObject({ choice: 'B' }) },
    ],
    authorityContract,
  };
  const prompt = assertDeterministic(compilePromptRender, input);
  assert.equal(hashStrictObject(prompt), 'sha256:902c00ae4191efb02ecd82aa7bebb44585b7ca2c5ab572bc807d6561954b324b');
  assert.equal(prompt.path, 'runs/RUN-000001/prompt.md');
  assert.equal(prompt.rendererId, 'prompt-render-v1');
  assert.match(prompt.rawUtf8, /^OMNAI_PROMPT_V1\nOMNAI_BLOCK_V1 /u);
  assert.equal(prompt.rawUtf8.endsWith('OMNAI_END_BLOCK_V1\n'), true);
  assert.equal((prompt.rawUtf8.match(/OMNAI_BLOCK_V1 /gu) ?? []).length, 9);
  assert.equal(prompt.instructionHash, 'sha256:cf8b2f35822e9e5e3a7c081f93370b06a54d50468866bff349655cfd479f7bfa');
  assert.equal(prompt.contextBindingsHash, 'sha256:081f119f57d46ed3e20ec3db66421d485faf76e5f566ba9533eb76419584c6f2');
  assert.equal(prompt.protocolBindingsHash, 'sha256:b980ef1e1f7f7a889d8e9e673a4f7a13f07b050fa0a3769a4e5efc1aacdd841a');
  assert.equal(prompt.renderInputHash, 'sha256:7b19dc351763b90249f4317a8cd368be7fe2b9ea9d8572ea9540d81c936306b8');
  assert.equal(prompt.rawBytesHash, 'sha256:f0b50cadfaa2a4137cda3bc0dab3047d4587200488e9325e6ea5d4c279fd2434');
  assert.notEqual(
    prompt.rawBytesHash,
    compilePromptRender({ ...input, instruction: `${input.instruction}\n附加` }).rawBytesHash,
  );
  assert.throws(() => compilePromptRender({
    ...input,
    decisionSnapshots: [...input.decisionSnapshots].reverse(),
  }));
  assert.throws(() => compilePromptRender({ ...input, instruction: 'bad\rline' }));
});

// 该回归会在 DIRECTORY locator 不是带尾斜线的 strict union，或目录条目未参与帧字节时失败。
test('prompt-render 接受严格 experiments 目录并按顺序渲染两个文件', async () => {
  const current = await authorityCatalog();
  const terminal = compileStageTerminal(planCompilerInput(current));
  const authorityContract = planAuthorityContract(terminal);
  const entries = [
    { path: 'experiments/a.md', rawUtf8: 'A\n', rawBytesHash: hashUtf8('A\n') },
    { path: 'experiments/b.md', rawUtf8: 'B', rawBytesHash: hashUtf8('B') },
  ] as const;
  const result = compilePromptRender({
    schemaVersion: 1,
    identity: { changeId: 'CHG-0001', revision: 'REV-0001', runId: 'RUN-000001', capability: 'plan' },
    instruction: '验证\n计划',
    protocols: [
      {
        id: 'common.authoritative-work', version: 1,
        relativePath: 'resources/protocols/common/authoritative-work.md',
        rawBytesHash: hashUtf8('common\n'), rawUtf8: 'common\n',
      },
      {
        id: 'repository.plan', version: 1,
        relativePath: 'resources/protocols/repository/plan.md',
        rawBytesHash: hashUtf8('plan'), rawUtf8: 'plan',
      },
    ],
    contexts: [{
      locator: { scope: 'CHANGE', path: 'experiments/' },
      kind: 'DIRECTORY',
      entries,
      inventoryHash: hashStrictObject(entries.map(({ path, rawBytesHash }) => ({ path, rawBytesHash }))),
    }],
    flowSnapshot: { value: { flow: 'locked' }, canonicalHash: hashStrictObject({ flow: 'locked' }) },
    decisionSnapshots: [],
    authorityContract,
  });
  assert.match(result.rawUtf8, /CONTEXT_DIRECTORY/u);
  assert.match(result.rawUtf8, /CHANGE:experiments\/a\.md/u);
  assert.match(result.rawUtf8, /CHANGE:experiments\/b\.md/u);
});
