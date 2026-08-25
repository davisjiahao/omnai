import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  changeMetadataSchema,
  decisionBindingSchema,
  decisionRecordSchema,
  flowAssessmentSchema,
  flowPlanSchema,
  scenarioProfileSchema,
  sha256Schema,
  type DecisionRecord,
} from '../../domain/types.js';
import {
  assertDecisionFlowIdentityV2,
  compileFlowPlan,
  createInitialFlowAssessment,
  decisionBinding,
  FLOW_CAPABILITY_ORDER,
  flowInputHash,
  hashFlowPlan,
} from '../flow.js';
import { loadFlowPlan } from '../flow-store.js';
import { resolveRepositoryRoute } from '../router.js';
import { completeStage, prepareStage } from '../stages.js';
import type { ChangeRef } from '../store.js';
import { hObject } from '../../domain/public.js';

// 背景：Decision ID 本身不是内容身份；若 Flow 只保存 ID，正文、嵌套 option、影响集合或时间均可
// 在不改变路由引用的情况下漂移。目的：按规范 20.1 的每一类字段做独立合法 mutation，并要求
// DecisionBinding、Flow inputHash 与完整 Flow hash 三层同时变化。上下文：authority envelope 的持久
// 认证由 Plans 02–03 接入，本测试同时固定 Task 5 提供的纯 mismatch oracle，不伪造持久 writer。
const timestamp = '2026-08-24T00:00:00.000Z';
const laterTimestamp = '2026-08-24T01:00:00.000Z';
const hash = (character: string) => `sha256:${character.repeat(64)}`;
const cleanupDirectories: string[] = [];

afterEach(async () => {
  while (cleanupDirectories.length > 0) {
    const directory = cleanupDirectories.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

const metadata = changeMetadataSchema.parse({
  schemaVersion: 2,
  id: 'CHG-0001',
  slug: 'identity-matrix',
  title: 'Identity Matrix',
  scenario: 'small-feature',
  workMode: 'FEATURE',
  status: 'IN_PROGRESS',
  activeRevision: 'REV-0001',
  baseline: 'BL-0001',
  artifactVersions: {},
  risk: {
    level: 'P2',
    dimensions: {
      businessCriticality: 'MEDIUM', data: 'LOW', compatibility: 'LOW',
      reversibility: 'MEDIUM', security: 'LOW', operational: 'LOW',
    },
  },
  impact: {
    frontend: false, backend: true, apiContract: false, database: false,
    mq: false, remoteService: false, security: false, observability: false,
  },
  createdAt: timestamp,
  updatedAt: timestamp,
  readiness: {
    frame: 'READY', map: 'NOT_APPLICABLE', research: 'READY', mitigation: 'NOT_APPLICABLE',
    triage: 'NOT_APPLICABLE', reproduction: 'NOT_APPLICABLE', diagnosis: 'NOT_APPLICABLE',
    domain: 'READY', spec: 'READY', design: 'READY', experiment: 'NOT_APPLICABLE',
    fix: 'NOT_APPLICABLE', plan: 'READY', implementation: 'IN_PROGRESS', review: 'MISSING',
    simplification: 'MISSING', verification: 'MISSING', qa: 'MISSING', release: 'MISSING',
    canary: 'MISSING', learning: 'MISSING',
  },
});

const scenario = scenarioProfileSchema.parse({
  schemaVersion: 1,
  id: 'small-feature',
  detectionPriority: 1,
  label: 'Small feature',
  description: 'Identity fixture scenario',
  workMode: 'FEATURE',
  routeOrder: ['spec'],
  stages: ['spec'],
  optionalStages: [],
  requiredArtifacts: ['spec.md'],
  requiredMachineState: [],
  gates: [],
  requiredEvidence: [],
  signals: [],
  risk: 'P2',
  riskDimensions: {
    businessCriticality: 'MEDIUM', data: 'LOW', compatibility: 'LOW',
    reversibility: 'MEDIUM', security: 'LOW', operational: 'LOW',
  },
  defaultImpact: {
    frontend: false, backend: true, apiContract: false, database: false,
    mq: false, remoteService: false, security: false, observability: false,
  },
});

const assessment = flowAssessmentSchema.parse({
  scale: 'LOCAL',
  uncertainty: { problem: 'CLEAR', domain: 'CLEAR', solution: 'CLEAR', delivery: 'CLEAR' },
  topology: 'SINGLE_MODULE',
  architectureApplicability: 'NOT_APPLICABLE',
  deliveryShape: 'STANDARD',
  decisionIds: [],
  sourceRefs: [{ kind: 'policy', scenarioId: 'small-feature', contentHash: hash('1') }],
});

function decisionFixture(): DecisionRecord {
  return decisionRecordSchema.parse({
    schemaVersion: 2,
    id: 'DEC-0001',
    changeId: 'CHG-0001',
    openedRevision: 'REV-0001',
    resolvedRevision: null,
    kind: 'SOLUTION',
    owner: 'HUMAN',
    status: 'OPEN',
    blocking: true,
    question: 'Which implementation boundary is authoritative?',
    options: [{
      id: 'OPT-01',
      label: 'Keep the native boundary',
      status: 'VIABLE',
      consequences: ['One authenticated source'],
      sourceRefs: [{ kind: 'artifact', path: 'spec.md', contentHash: hash('2') }],
    }],
    resolution: null,
    supersededBy: null,
    affects: {
      capabilities: ['design'],
      artifacts: ['spec.md'],
      tasks: ['TASK-001'],
      projects: ['omnai'],
      contracts: ['IF-NATIVE'],
    },
    sourceRefs: [{ kind: 'artifact', path: 'spec.md', contentHash: hash('3') }],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function goldenDecisionFixture(): DecisionRecord {
  return decisionRecordSchema.parse({
    schemaVersion: 2,
    id: 'DEC-0001',
    changeId: 'CHG-0001',
    openedRevision: 'REV-0001',
    resolvedRevision: null,
    kind: 'SOLUTION',
    owner: 'HUMAN',
    status: 'OPEN',
    blocking: true,
    question: 'Which boundary is authoritative?',
    options: [],
    resolution: null,
    supersededBy: null,
    affects: { capabilities: ['design'], artifacts: [], tasks: [], projects: [], contracts: [] },
    sourceRefs: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

// 背景：旧 persistent guard 只检查 raw own descriptors，却把同一原对象交给 Zod；两个都缺少
// own question 的 Decision 可由 Object.prototype getter 按 receiver 得到不同问题，而 HObject 只看
// own 字段，因而产生“解析语义不同、身份相同”的分裂。目的：两行都必须在 getter 零读取下拒绝，
// 且测试保留相同 raw HObject 作为旧碰撞的独立身份证据。上下文：finally 恢复全局 descriptor。
test('Decision 缺少 own question 时继承语义不能与 HObject 身份分裂', () => {
  const first = structuredClone(goldenDecisionFixture()) as Record<string, unknown>;
  const second = structuredClone(goldenDecisionFixture()) as Record<string, unknown>;
  Reflect.deleteProperty(first, 'question');
  Reflect.deleteProperty(second, 'question');
  const inheritedQuestions = new WeakMap<object, string>([
    [first, 'Inherited question A'],
    [second, 'Inherited question B'],
  ]);
  const originalDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'question');
  let getterReads = 0;
  let firstResult: ReturnType<typeof decisionRecordSchema.safeParse> | undefined;
  let secondResult: ReturnType<typeof decisionRecordSchema.safeParse> | undefined;
  let firstRawHash: string | undefined;
  let secondRawHash: string | undefined;
  Object.defineProperty(Object.prototype, 'question', {
    configurable: true,
    get() {
      getterReads += 1;
      return inheritedQuestions.get(this);
    },
  });
  try {
    firstRawHash = hObject(first);
    secondRawHash = hObject(second);
    firstResult = decisionRecordSchema.safeParse(first);
    secondResult = decisionRecordSchema.safeParse(second);
  } finally {
    if (originalDescriptor === undefined) {
      Reflect.deleteProperty(Object.prototype, 'question');
    } else {
      Object.defineProperty(Object.prototype, 'question', originalDescriptor);
    }
  }

  assert.equal(firstRawHash, secondRawHash);
  assert.equal(firstResult?.success, false);
  assert.equal(secondResult?.success, false);
  assert.equal(getterReads, 0);
});

// 背景：input preflight 虽已关闭继承读，Zod object parser 仍会用普通赋值
// 构造 Decision output；Object.prototype.question 的 discard setter 会删掉 success
// output 的 required own field，从而使同一 clean Decision 在污染环境下获得不同
// binding HObject。目的：在 Zod assignment 前零调用关闭；若选择成功，则最终
// descriptor-authenticated output 必须保留 own question 且与 clean binding hash 完全相同。
// 上下文：finally 精确恢复全局 descriptor，不依赖清理全局原型的生产代码。
test('Decision output 在 question discard setter 下不丢字段或分裂 binding hash', () => {
  const input = structuredClone(goldenDecisionFixture());
  const clean = decisionRecordSchema.parse(input);
  const cleanHash = hObject(clean);
  const originalDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'question');
  let getterReads = 0;
  let setterWrites = 0;
  let polluted: ReturnType<typeof decisionRecordSchema.safeParse> | undefined;
  Object.defineProperty(Object.prototype, 'question', {
    configurable: true,
    get() {
      getterReads += 1;
      return 'polluted';
    },
    set(_value: unknown) {
      setterWrites += 1;
    },
  });
  try {
    polluted = decisionRecordSchema.safeParse(input);
  } finally {
    if (originalDescriptor === undefined) {
      Reflect.deleteProperty(Object.prototype, 'question');
    } else {
      Object.defineProperty(Object.prototype, 'question', originalDescriptor);
    }
  }

  assert.equal(getterReads, 0);
  assert.equal(setterWrites, 0);
  if (polluted?.success) {
    assert.equal(Object.getPrototypeOf(polluted.data), null);
    assert.equal(Object.hasOwn(polluted.data, 'question'), true);
    assert.equal(polluted.data.question, input.question);
    assert.equal(hObject(polluted.data), cleanHash);
  }
});

// 背景：accepted authority 若由 production identity helper 从同一对象重算，producer 与
// assertor 共享错误时测试仍会通过。目的：以下字节片段按 code-unit key 顺序手工固定，不调用
// production canonicalizer，也不把 producer 输出送回 expected 构造。上下文：node:crypto 只对
// 这些显式 UTF-8 canonical JSON bytes 做 SHA-256；固定 digest 同时防止手工 fixture 漂移。
const GOLDEN_DECISION_CANONICAL_BYTES = '{"affects":{"artifacts":[],"capabilities":["design"],"contracts":[],"projects":[],"tasks":[]},"blocking":true,"changeId":"CHG-0001","createdAt":"2026-08-24T00:00:00.000Z","id":"DEC-0001","kind":"SOLUTION","openedRevision":"REV-0001","options":[],"owner":"HUMAN","question":"Which boundary is authoritative?","resolution":null,"resolvedRevision":null,"schemaVersion":2,"sourceRefs":[],"status":"OPEN","supersededBy":null,"updatedAt":"2026-08-24T00:00:00.000Z"}';
const GOLDEN_DECISION_HASH = 'sha256:0e3ea6241e51457721609b14669599cf212da8d0189dc530fd1d1241d1a8982c';
const GOLDEN_FLOW_INPUT_HASH = 'sha256:1771e4c062072e5e228d96b0c19a1298a6050b1f8c36aad7d2ed4766263f62ee';
const GOLDEN_FLOW_HASH = 'sha256:a4bd1d0007d2caff2096ae10b9b111067767615d591333d4a0e7d8900e69edcf';
const GOLDEN_ASSESSMENT_CANONICAL_FIELD = '"assessment":{"architectureApplicability":"NOT_APPLICABLE","decisionIds":[],"deliveryShape":"STANDARD","scale":"LOCAL","sourceRefs":[],"topology":"SINGLE_MODULE","uncertainty":{"delivery":"CLEAR","domain":"CLEAR","problem":"CLEAR","solution":"CLEAR"}}';
const GOLDEN_CAPABILITY_CANONICAL_ROWS = [
  '{"active":false,"capability":"archive","disposition":"CONDITIONAL","reason":"Not promoted by current flow inputs","sourceRefs":[]}',
  '{"active":false,"capability":"canary","disposition":"CONDITIONAL","reason":"Not promoted by current flow inputs","sourceRefs":[]}',
  '{"active":false,"capability":"debug","disposition":"CONDITIONAL","reason":"Not promoted by current flow inputs","sourceRefs":[]}',
  '{"active":true,"capability":"design","disposition":"CONDITIONAL","reason":"Promoted by flow assessment or decision","sourceRefs":[]}',
  '{"active":false,"capability":"diagnose","disposition":"CONDITIONAL","reason":"Not promoted by current flow inputs","sourceRefs":[]}',
  '{"active":false,"capability":"experiment","disposition":"CONDITIONAL","reason":"Not promoted by current flow inputs","sourceRefs":[]}',
  '{"active":false,"capability":"fix","disposition":"CONDITIONAL","reason":"Not promoted by current flow inputs","sourceRefs":[]}',
  '{"active":false,"capability":"frame","disposition":"CONDITIONAL","reason":"Not promoted by current flow inputs","sourceRefs":[]}',
  '{"active":false,"capability":"learn","disposition":"CONDITIONAL","reason":"Not promoted by current flow inputs","sourceRefs":[]}',
  '{"active":false,"capability":"map","disposition":"CONDITIONAL","reason":"Not promoted by current flow inputs","sourceRefs":[]}',
  '{"active":false,"capability":"mitigate","disposition":"CONDITIONAL","reason":"Not promoted by current flow inputs","sourceRefs":[]}',
  '{"active":false,"capability":"model","disposition":"CONDITIONAL","reason":"Not promoted by current flow inputs","sourceRefs":[]}',
  '{"active":false,"capability":"plan","disposition":"CONDITIONAL","reason":"Not promoted by current flow inputs","sourceRefs":[]}',
  '{"active":false,"capability":"qa","disposition":"CONDITIONAL","reason":"Not promoted by current flow inputs","sourceRefs":[]}',
  '{"active":false,"capability":"reconcile","disposition":"CONDITIONAL","reason":"Not promoted by current flow inputs","sourceRefs":[]}',
  '{"active":false,"capability":"reproduce","disposition":"CONDITIONAL","reason":"Not promoted by current flow inputs","sourceRefs":[]}',
  '{"active":false,"capability":"research","disposition":"CONDITIONAL","reason":"Not promoted by current flow inputs","sourceRefs":[]}',
  '{"active":false,"capability":"review","disposition":"CONDITIONAL","reason":"Not promoted by current flow inputs","sourceRefs":[]}',
  '{"active":false,"capability":"ship","disposition":"CONDITIONAL","reason":"Not promoted by current flow inputs","sourceRefs":[]}',
  '{"active":false,"capability":"simplify","disposition":"CONDITIONAL","reason":"Not promoted by current flow inputs","sourceRefs":[]}',
  '{"active":true,"capability":"spec","disposition":"REQUIRED","reason":"Scenario floor: small-feature","sourceRefs":[]}',
  '{"active":false,"capability":"triage","disposition":"CONDITIONAL","reason":"Not promoted by current flow inputs","sourceRefs":[]}',
  '{"active":false,"capability":"verify","disposition":"CONDITIONAL","reason":"Not promoted by current flow inputs","sourceRefs":[]}',
  '{"active":false,"capability":"work","disposition":"CONDITIONAL","reason":"Not promoted by current flow inputs","sourceRefs":[]}',
] as const;
const GOLDEN_CAPABILITIES_CANONICAL_FIELD = `"capabilities":[${GOLDEN_CAPABILITY_CANONICAL_ROWS.join(',')}]`;
const GOLDEN_DECISION_BINDINGS_CANONICAL_FIELD = '"decisionBindings":[{"contentHash":"sha256:0e3ea6241e51457721609b14669599cf212da8d0189dc530fd1d1241d1a8982c","id":"DEC-0001"}]';
const GOLDEN_FLOW_INPUT_CANONICAL_BYTES = `{${[
  GOLDEN_ASSESSMENT_CANONICAL_FIELD,
  '"baseline":"BL-0001"',
  GOLDEN_CAPABILITIES_CANONICAL_FIELD,
  '"changeId":"CHG-0001"',
  GOLDEN_DECISION_BINDINGS_CANONICAL_FIELD,
  '"decisionIds":["DEC-0001"]',
  '"revision":"REV-0001"',
].join(',')}}`;
const GOLDEN_FLOW_CANONICAL_BYTES = `{${[
  GOLDEN_ASSESSMENT_CANONICAL_FIELD,
  '"baseline":"BL-0001"',
  GOLDEN_CAPABILITIES_CANONICAL_FIELD,
  '"changeId":"CHG-0001"',
  '"compiledAt":"2026-08-24T00:00:00.000Z"',
  GOLDEN_DECISION_BINDINGS_CANONICAL_FIELD,
  '"decisionIds":["DEC-0001"]',
  '"inputHash":"sha256:1771e4c062072e5e228d96b0c19a1298a6050b1f8c36aad7d2ed4766263f62ee"',
  '"revision":"REV-0001"',
  '"schemaVersion":2',
].join(',')}}`;

function sha256Literal(canonicalBytes: string): string {
  return `sha256:${createHash('sha256').update(Buffer.from(canonicalBytes, 'utf8')).digest('hex')}`;
}

function accessorFieldSentinel(
  source: object,
  field: string,
): { value: object; readCount: () => number } {
  let reads = 0;
  const value = { ...source };
  Object.defineProperty(value, field, {
    configurable: true,
    enumerable: true,
    get() {
      reads += 1;
      throw new Error(`HOSTILE_${field.toUpperCase()}_READ`);
    },
  });
  return { value, readCount: () => reads };
}

function accessorArraySentinel(): { value: readonly unknown[]; readCount: () => number } {
  let reads = 0;
  const value: unknown[] = [];
  Object.defineProperty(value, '0', {
    configurable: true,
    enumerable: true,
    get() {
      reads += 1;
      throw new Error('HOSTILE_ARRAY_READ');
    },
  });
  return { value, readCount: () => reads };
}

function ownKeysArraySentinel(
  length: number,
): { value: readonly unknown[]; ownKeysCount: () => number } {
  let ownKeysCalls = 0;
  const value = new Proxy<unknown[]>(new Array(length), {
    ownKeys() {
      ownKeysCalls += 1;
      throw new Error('HOSTILE_DECISION_OWN_KEYS');
    },
  });
  return { value, ownKeysCount: () => ownKeysCalls };
}

function decisionRowParseSentinel(
  source: DecisionRecord,
): { value: object; parseCount: () => number } {
  let parses = 0;
  const value = new Proxy(structuredClone(source), {
    getPrototypeOf() {
      parses += 1;
      throw new Error('HOSTILE_DECISION_ROW_PARSE');
    },
  });
  return { value, parseCount: () => parses };
}

function zeroRefDecisionInventory(length: number): object[] {
  const template = structuredClone(goldenDecisionFixture());
  return Array.from({ length }, (_, index) => ({
    ...template,
    id: `DEC-${String(index + 1).padStart(4, '0')}`,
  }));
}

function goldenFlowInputFixture() {
  const goldenAssessment = flowAssessmentSchema.parse({ ...assessment, sourceRefs: [] });
  const plan = compileFlowPlan(metadata, scenario, goldenAssessment, [goldenDecisionFixture()], timestamp);
  return {
    changeId: plan.changeId,
    revision: plan.revision,
    baseline: plan.baseline,
    assessment: plan.assessment,
    capabilities: plan.capabilities,
    decisionIds: plan.decisionIds,
    decisionBindings: plan.decisionBindings,
  };
}

function assessmentDecisionClosureFixtures() {
  const decision = goldenDecisionFixture();
  const contentHash = decisionBinding(decision).contentHash;
  const validAssessment = flowAssessmentSchema.parse({
    ...assessment,
    decisionIds: [decision.id],
    sourceRefs: [
      { kind: 'decision', decisionId: decision.id, contentHash },
      ...assessment.sourceRefs,
    ],
  });
  const fabricatedAssessment = flowAssessmentSchema.parse({
    ...validAssessment,
    sourceRefs: validAssessment.sourceRefs.map((sourceRef) => (
      sourceRef.kind === 'decision' ? { ...sourceRef, contentHash: hash('f') } : sourceRef
    )),
  });
  return { decision, validAssessment, fabricatedAssessment };
}

function mutateDecision(
  source: DecisionRecord,
  mutation: (record: DecisionRecord) => unknown,
): DecisionRecord {
  return decisionRecordSchema.parse(mutation(structuredClone(source)));
}

// 背景：旧 createInitialFlowAssessment 会先展开、sort、dedupe caller refs，再让 schema 看见
// 修复后的两项；一百万个错序重复项因而可先消耗资源后被接受。目的：strict collection boundary
// 必须在任何 repair/sort 前拒绝原始集合。上下文：共享对象不改变一百万个数组槽的真实输入规模。
test('createInitialFlowAssessment 在排序前拒绝一百万个错序重复 SourceRef', () => {
  const codeSource = { kind: 'code' as const, path: 'src/z.ts', contentHash: hash('8') };
  const artifactSource = { kind: 'artifact' as const, path: 'a.md', contentHash: hash('9') };
  const hostileInventory = Array.from(
    { length: 1_000_000 },
    (_, index) => index % 2 === 0 ? codeSource : artifactSource,
  );

  assert.throws(
    () => Reflect.apply(createInitialFlowAssessment, undefined, [metadata, scenario, hostileInventory]),
    /persistent input must be a strict raw data tree/u,
  );
});

test('createInitialFlowAssessment 的 SourceRef accessor 在 strict guard 前读取为零', () => {
  const sentinel = accessorArraySentinel();

  assert.throws(() => Reflect.apply(
    createInitialFlowAssessment,
    undefined,
    [metadata, scenario, sentinel.value],
  ));
  assert.equal(sentinel.readCount(), 0);
});

// 背景：flowInputHash 是公开身份边界，旧实现会读取字段、复制并排序 caller bindings，再交给
// HObject；这会把错序输入修复为合法身份，也让 accessor 在 raw guard 前执行。目的：完整 input
// 先通过 final components 与跨字段约束，hash 只观察 strict parsed value。
test('flowInputHash 在 clone、sort 与 hash 前拒绝超大集合和 accessor', () => {
  const input = goldenFlowInputFixture();
  const hugeInput = {
    ...input,
    capabilities: Array.from({ length: 100_001 }, () => input.capabilities[0]),
  };
  assert.throws(
    () => Reflect.apply(flowInputHash, undefined, [hugeInput]),
    /persistent input must be a strict raw data tree/u,
  );

  const sentinel = accessorFieldSentinel(input, 'decisionBindings');
  assert.throws(() => Reflect.apply(flowInputHash, undefined, [sentinel.value]));
  assert.equal(sentinel.readCount(), 0);
});

test('flowInputHash 拒绝错序重复集合及 IDs/bindings/assessment 非闭合输入', () => {
  const input = goldenFlowInputFixture();
  const firstBinding = input.decisionBindings[0]!;
  const secondBinding = decisionBindingSchema.parse({ id: 'DEC-0002', contentHash: hash('a') });
  const twoDecisionInput = {
    ...input,
    decisionIds: ['DEC-0001', 'DEC-0002'],
    decisionBindings: [firstBinding, secondBinding],
  };
  assert.doesNotThrow(() => Reflect.apply(flowInputHash, undefined, [twoDecisionInput]));

  const assessmentOutsideInventory = flowAssessmentSchema.parse({
    ...input.assessment,
    decisionIds: ['DEC-0002'],
    sourceRefs: [{ kind: 'decision', decisionId: 'DEC-0002', contentHash: hash('b') }],
  });
  const invalidInputs = [
    { ...input, capabilities: [...input.capabilities].reverse() },
    { ...input, capabilities: [input.capabilities[0], ...input.capabilities] },
    { ...twoDecisionInput, decisionIds: ['DEC-0002', 'DEC-0001'] },
    { ...twoDecisionInput, decisionIds: ['DEC-0001', 'DEC-0001'] },
    { ...twoDecisionInput, decisionBindings: [secondBinding, firstBinding] },
    { ...twoDecisionInput, decisionBindings: [firstBinding, firstBinding] },
    { ...input, decisionBindings: [] },
    { ...input, assessment: assessmentOutsideInventory },
  ];
  for (const invalid of invalidInputs) {
    assert.throws(() => Reflect.apply(flowInputHash, undefined, [invalid]));
  }
});

test('assertDecisionFlowIdentity 在比较前拒绝 accepted accessor 与 hostile Decision inventory', () => {
  const decision = goldenDecisionFixture();
  const goldenAssessment = flowAssessmentSchema.parse({ ...assessment, sourceRefs: [] });
  const plan = compileFlowPlan(metadata, scenario, goldenAssessment, [decision], timestamp);
  const accepted = { decisionBindings: plan.decisionBindings, flowHash: hashFlowPlan(plan) };
  const acceptedSentinel = accessorFieldSentinel(accepted, 'decisionBindings');

  assert.throws(() => Reflect.apply(
    assertDecisionFlowIdentityV2,
    undefined,
    [plan, [decision], acceptedSentinel.value],
  ));
  assert.equal(acceptedSentinel.readCount(), 0);

  const decisionsSentinel = accessorArraySentinel();
  assert.throws(() => Reflect.apply(
    assertDecisionFlowIdentityV2,
    undefined,
    [plan, decisionsSentinel.value, accepted],
  ));
  assert.equal(decisionsSentinel.readCount(), 0);
});

test('compileFlowPlan 的五类 caller 输入都在字段读取或投影工作前 strict parse', () => {
  const decision = goldenDecisionFixture();
  const metadataSentinel = accessorFieldSentinel(metadata, 'risk');
  const scenarioSentinel = accessorFieldSentinel(scenario, 'stages');
  const assessmentSentinel = accessorFieldSentinel(assessment, 'scale');
  const decisionSentinel = accessorFieldSentinel(decision, 'status');
  const inventorySentinel = accessorArraySentinel();
  const cases = [
    { sentinel: metadataSentinel, args: [metadataSentinel.value, scenario, assessment, [], timestamp] },
    { sentinel: scenarioSentinel, args: [metadata, scenarioSentinel.value, assessment, [], timestamp] },
    { sentinel: assessmentSentinel, args: [metadata, scenario, assessmentSentinel.value, [], timestamp] },
    { sentinel: decisionSentinel, args: [metadata, scenario, assessment, [decisionSentinel.value], timestamp] },
    { sentinel: inventorySentinel, args: [metadata, scenario, assessment, inventorySentinel.value, timestamp] },
  ];
  for (const { sentinel, args } of cases) {
    assert.throws(() => Reflect.apply(compileFlowPlan, undefined, args));
    assert.equal(sentinel.readCount(), 0);
  }

  // invalid compiledAt 必须在 Decision inventory 访问前失败；否则 caller 可用巨大/hostile
  // inventory 迫使系统先做 parse 与 projection work，再发现时间戳无效。
  const invalidTimestampInventory = accessorArraySentinel();
  assert.throws(() => Reflect.apply(compileFlowPlan, undefined, [
    metadata, scenario, assessment, invalidTimestampInventory.value, 'not-a-timestamp',
  ]));
  assert.equal(invalidTimestampInventory.readCount(), 0);
});

test('compileFlowPlan 拒绝 metadata、scenario、assessment、Decision 与 compiledAt 非法形状', () => {
  const decision = goldenDecisionFixture();
  const invalidCalls = [
    [{ ...metadata, unexpected: true }, scenario, assessment, [decision], timestamp],
    [metadata, { ...scenario, unexpected: true }, assessment, [decision], timestamp],
    [metadata, scenario, { ...assessment, unexpected: true }, [decision], timestamp],
    [metadata, scenario, assessment, [{ ...decision, unexpected: true }], timestamp],
    [metadata, scenario, assessment, [decision], 'not-a-timestamp'],
  ];
  for (const args of invalidCalls) {
    assert.throws(() => Reflect.apply(compileFlowPlan, undefined, args));
  }
});

// 背景：metadata 与 verified Scenario 分别 strict parse 仍不能证明两者描述同一 authority；
// Decision 自身也可携带 foreign ChangeId。目的：assessment 构造与完整 Flow constructor 都要求
// scenario/workMode 邻接，且每条 current Decision 必须属于 metadata.id。上下文：这些 mismatch
// 都是 schema-valid，因此不能靠 unknown-field 或 branded scalar 错误偶然拒绝。
test('Flow constructor 拒绝 metadata↔Scenario 与 Decision↔Change 邻接漂移', () => {
  const scenarioMismatch = changeMetadataSchema.parse({ ...metadata, scenario: 'bug-fix' });
  const workModeMismatch = changeMetadataSchema.parse({ ...metadata, workMode: 'BUG_FIX' });
  for (const mismatched of [scenarioMismatch, workModeMismatch]) {
    assert.throws(
      () => createInitialFlowAssessment(mismatched, scenario, []),
      /FLOW_SCENARIO_ADJACENCY_MISMATCH/u,
    );
    assert.throws(
      () => compileFlowPlan(mismatched, scenario, assessment, [], timestamp),
      /FLOW_SCENARIO_ADJACENCY_MISMATCH/u,
    );
  }

  const foreignDecision = mutateDecision(goldenDecisionFixture(), (record) => ({
    ...record,
    changeId: 'CHG-0002',
  }));
  assert.throws(
    () => compileFlowPlan(metadata, scenario, assessment, [foreignDecision], timestamp),
    /FLOW_DECISION_CHANGE_MISMATCH/u,
  );
});

// 背景：assessment 的 Decision SourceRef 只做 ID 集合闭合，任意格式正确的 contentHash 都能
// 制造新 Flow。目的：constructor 必须把每个 ref 精确闭合到 current Decision binding；合法 hash
// 控制继续产生 Flow。上下文：hash 来自完整 DecisionRecord，不允许 caller 自报或归一化。
test('Flow constructor 只接受 assessment Decision ref 的 current binding hash', () => {
  const { decision, validAssessment, fabricatedAssessment } = assessmentDecisionClosureFixtures();
  assert.doesNotThrow(() => compileFlowPlan(metadata, scenario, validAssessment, [decision], timestamp));
  assert.throws(
    () => compileFlowPlan(metadata, scenario, fabricatedAssessment, [decision], timestamp),
    /FLOW_ASSESSMENT_DECISION_BINDING_MISMATCH/u,
  );
});

// 背景：flowInputHash 是可独立调用的公开 identity boundary；只在 constructor 检查会让 caller
// 绕过 current Decision adjacency 直接得到 inputHash。目的：同一 closure 对 schema-valid fabricated
// hash fail-closed，合法控制不排序、不修复并保持可哈希。上下文：Decision bindings 使用真实完整记录。
test('flowInputHash 关闭 fabricated assessment Decision binding', () => {
  const { decision, validAssessment, fabricatedAssessment } = assessmentDecisionClosureFixtures();
  const plan = compileFlowPlan(metadata, scenario, validAssessment, [decision], timestamp);
  const input = {
    changeId: plan.changeId,
    revision: plan.revision,
    baseline: plan.baseline,
    assessment: plan.assessment,
    capabilities: plan.capabilities,
    decisionIds: plan.decisionIds,
    decisionBindings: plan.decisionBindings,
  };
  assert.doesNotThrow(() => flowInputHash(input));
  assert.throws(
    () => Reflect.apply(flowInputHash, undefined, [{ ...input, assessment: fabricatedAssessment }]),
    /FLOW_ASSESSMENT_DECISION_BINDING_MISMATCH/u,
  );
});

// 背景：完整 Flow hash 过去只复用 exact-24 validator，assessment 中 fabricated Decision hash 仍能
// 生成新 flowHash。目的：hashFlowPlan 的 projection 必须走同一个 adjacency closure；合法 Flow 的
// preimage 与既有 golden 不变。上下文：测试不回算非法 inputHash，避免用 production helper 制造 oracle。
test('hashFlowPlan 关闭 fabricated assessment Decision binding', () => {
  const { decision, validAssessment, fabricatedAssessment } = assessmentDecisionClosureFixtures();
  const plan = compileFlowPlan(metadata, scenario, validAssessment, [decision], timestamp);
  assert.doesNotThrow(() => hashFlowPlan(plan));
  assert.throws(
    () => Reflect.apply(hashFlowPlan, undefined, [{ ...plan, assessment: fabricatedAssessment }]),
    /FLOW_ASSESSMENT_DECISION_BINDING_MISMATCH/u,
  );
});

// 背景：accepted identity assertor 若只比较最终 hash，会以较晚的 mismatch 掩盖 assessment/Decision
// adjacency 缺失。目的：assertor 使用 current Decision inventory 的同一 closure，并在 accepted
// comparison 前拒绝 fabricated ref。上下文：accepted control 来自合法 Flow，仅作为已封存值模拟。
test('assertDecisionFlowIdentity 关闭 fabricated assessment Decision binding', () => {
  const { decision, validAssessment, fabricatedAssessment } = assessmentDecisionClosureFixtures();
  const plan = compileFlowPlan(metadata, scenario, validAssessment, [decision], timestamp);
  const accepted = { decisionBindings: plan.decisionBindings, flowHash: hashFlowPlan(plan) };
  assert.doesNotThrow(() => assertDecisionFlowIdentityV2(plan, [decision], accepted));
  assert.throws(
    () => Reflect.apply(assertDecisionFlowIdentityV2, undefined, [
      { ...plan, assessment: fabricatedAssessment }, [decision], accepted,
    ]),
    /FLOW_ASSESSMENT_DECISION_BINDING_MISMATCH/u,
  );
});

// 背景：Decision sourceRefs 可以为空，projection budget 因而不能限制 Decision 行数；旧 outer
// guard 会在 isProxy 前读取 length descriptor。目的：20k/100k/1m Proxy 都必须先按身份关闭，
// 不触发 ownKeys；plain array 的 9999/10000 预算仍由后续独立测试锁定。
test('Decision outer 在 length descriptor/ownKeys/row parse 前先拒绝 Proxy', () => {
  for (const length of [20_000, 100_000, 1_000_000]) {
    const sentinel = ownKeysArraySentinel(length);
    assert.throws(
      () => Reflect.apply(compileFlowPlan, undefined, [
        metadata, scenario, assessment, sentinel.value, timestamp,
      ]),
      /Decision inventory must be a strict dense array/u,
    );
    assert.equal(sentinel.ownKeysCount(), 0, String(length));
  }
});

// 背景：旧 outer 先读取 length descriptor，再调用 isProxy；throwing/revoked/transparent Proxy
// 因而可执行 caller trap，且 oversized Proxy 会以预算错误掩盖身份边界。目的：所有大小的 root
// Proxy 都在任何 descriptor 前统一拒绝。上下文：plain 9999/10000 inventory 边界由相邻测试继续
// 保留，不能因先拒绝 Proxy 而削弱真实数组的 distinct Decision 命名空间上限。
test('Decision outer 对 transparent、throwing、revoked Proxy 的 descriptor trap 始终为零', () => {
  const decision = goldenDecisionFixture();
  assert.throws(() => Reflect.apply(compileFlowPlan, undefined, [
    metadata, scenario, assessment, new Proxy([decision], {}), timestamp,
  ]), /Decision inventory must be a strict dense array/u);

  let descriptorTraps = 0;
  const throwing = new Proxy([decision], {
    getOwnPropertyDescriptor() {
      descriptorTraps += 1;
      throw new Error('HOSTILE_DECISION_LENGTH_DESCRIPTOR');
    },
  });
  assert.throws(() => Reflect.apply(compileFlowPlan, undefined, [
    metadata, scenario, assessment, throwing, timestamp,
  ]), /Decision inventory must be a strict dense array/u);
  assert.equal(descriptorTraps, 0);

  const revoked = Proxy.revocable([decision], {});
  revoked.revoke();
  assert.throws(() => Reflect.apply(compileFlowPlan, undefined, [
    metadata, scenario, assessment, revoked.proxy, timestamp,
  ]), /Decision inventory must be a strict dense array/u);
});

test('十万条重复 zero-ref Decision 不得逃逸 inventory budget 或开始 row parse', () => {
  const rowSentinel = decisionRowParseSentinel(goldenDecisionFixture());
  const repeated = new Array(100_000).fill(rowSentinel.value);

  assert.throws(
    () => Reflect.apply(compileFlowPlan, undefined, [metadata, scenario, assessment, repeated, timestamp]),
    /FLOW_DECISION_INVENTORY_BUDGET_EXCEEDED/u,
  );
  assert.equal(rowSentinel.parseCount(), 0);
});

// 背景：只在最终 sort 后查相邻 ID，会让明显重复的第二行之后仍可迫使 parser 读取剩余 rows。
// 目的：row 2 strict parse 完成后立即由 Set 拒绝，row 3 的 hostile prototype 不得被观察。
test('重复 Decision ID 在第二行即时拒绝且不解析第三行', () => {
  const first = goldenDecisionFixture();
  const third = decisionRowParseSentinel(first);
  const decisions = [first, structuredClone(first), third.value];

  assert.throws(
    () => Reflect.apply(compileFlowPlan, undefined, [metadata, scenario, assessment, decisions, timestamp]),
    /FLOW_DECISION_ID_CONFLICT: DEC-0001/u,
  );
  assert.equal(third.parseCount(), 0);
});

test('Decision inventory 精确接受 9999 个最小 distinct IDs 并在 10000 关闭', () => {
  const exact = zeroRefDecisionInventory(9_999);
  assert.doesNotThrow(() => Reflect.apply(
    compileFlowPlan,
    undefined,
    [metadata, scenario, assessment, exact, timestamp],
  ));

  const over = [...exact, { ...exact[0], id: 'DEC-0001' }];
  assert.throws(
    () => Reflect.apply(compileFlowPlan, undefined, [metadata, scenario, assessment, over, timestamp]),
    /FLOW_DECISION_INVENTORY_BUDGET_EXCEEDED/u,
  );
});

// 背景：每个 Decision 的 100000-node guard 会逐行重置；zero-ref inventory 因而可把近五十万
// structural nodes 推入 parse/hash。目的：400 条共享 999-contract row 作为最后合法压力控制，
// 500 条先耗尽累计结构预算并在后续 hostile row 前拒绝。上下文：sourceRefs 均为空，证明 projection
// 与 9999 inventory 两个现有预算不能替代完整 raw/canonical work accumulator。
test('Decision inventory 累计 structural node 预算在后续 hostile row 前关闭', () => {
  const contracts = Array.from({ length: 999 }, (_, index) => `CONTRACT-${String(index).padStart(4, '0')}`);
  const makeRows = (length: number) => zeroRefDecisionInventory(length).map((record) => ({
    ...record,
    affects: { ...Reflect.get(record, 'affects') as object, contracts },
  }));
  assert.doesNotThrow(() => Reflect.apply(compileFlowPlan, undefined, [
    metadata, scenario, assessment, makeRows(400), timestamp,
  ]));

  const later = decisionRowParseSentinel(goldenDecisionFixture());
  assert.throws(
    () => Reflect.apply(compileFlowPlan, undefined, [
      metadata, scenario, assessment, [...makeRows(500), later.value], timestamp,
    ]),
    /FLOW_DECISION_CUMULATIVE_NODE_BUDGET_EXCEEDED/u,
  );
  assert.equal(later.parseCount(), 0);
});

function sharedContractDecisionRows(contractCount: number): object[] {
  const contracts = Array.from(
    { length: contractCount },
    (_, index) => `CONTRACT-${String(index).padStart(6, '0')}`,
  );
  const sharedAffects: DecisionRecord['affects'] = {
    ...goldenDecisionFixture().affects,
    contracts,
  };
  return zeroRefDecisionInventory(8).map((record) => ({ ...record, affects: sharedAffects }));
}

// 背景：shared object identity 不是预算折扣；JSON 语义在八个 Decision 位置各出现一次，就必须
// 各自计费。目的：每个最小 Decision 固定 24 nodes，复用含 62,476 个 scalar 的 affects 后为
// 62,500 nodes，八行手算恰好 500,000，锁定累计 node 门的 inclusive exact 边界。上下文：每行
// 仍低于单行 100,000-node schema 门，字符串与 canonical bytes 也低于相邻累计预算。
test('Decision 累计 node 预算精确接受跨行重复出现的 shared affects reference', () => {
  assert.doesNotThrow(() => Reflect.apply(compileFlowPlan, undefined, [
    metadata,
    scenario,
    assessment,
    sharedContractDecisionRows(62_476),
    timestamp,
  ]));
});

// 背景：若 shared reference 只按对象 identity 计一次，八行可把同一巨大 authority 子图反复送进
// Zod 与 HObject。目的：在 exact fixture 的 shared contracts 增加一个 scalar，使累计节点成为
// 500,008，并要求在完整 parse/hash 前以唯一 cumulative node 错误关闭。上下文：这不是 cycle；
// 同一引用出现在不同 Decision JSON 位置，故每次语义出现都收费。
test('Decision 累计 node 预算拒绝超过一节点的 shared affects reference', () => {
  assert.throws(
    () => Reflect.apply(compileFlowPlan, undefined, [
      metadata,
      scenario,
      assessment,
      sharedContractDecisionRows(62_477),
      timestamp,
    ]),
    /FLOW_DECISION_CUMULATIVE_NODE_BUDGET_EXCEEDED/u,
  );
});

// 背景：旧累计 preflight 只计 own descriptor，而每行随后的 Zod 会读取 Object.prototype.question；
// 八个缺 own question 的 Decision 因而能共享一个 1 MiB 继承字符串，绕过 8 MiB 跨行 UTF-8 门。
// 目的：认证克隆必须先删除继承语义，令首行 schema fail-closed 且 getter 零读取。上下文：finally
// 恢复全局 descriptor；共享字符串本身用于证明攻击不是靠重复 source allocation 达成。
test('Decision 累计预算不接受继承的 shared 长 question', () => {
  const rows = zeroRefDecisionInventory(8);
  for (const row of rows) Reflect.deleteProperty(row, 'question');
  const inheritedQuestion = 'x'.repeat(1024 * 1024);
  const originalDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'question');
  let getterReads = 0;
  let thrown: unknown;
  Object.defineProperty(Object.prototype, 'question', {
    configurable: true,
    get() {
      getterReads += 1;
      return inheritedQuestion;
    },
  });
  try {
    try {
      Reflect.apply(compileFlowPlan, undefined, [metadata, scenario, assessment, rows, timestamp]);
    } catch (error) {
      thrown = error;
    }
  } finally {
    if (originalDescriptor === undefined) {
      Reflect.deleteProperty(Object.prototype, 'question');
    } else {
      Object.defineProperty(Object.prototype, 'question', originalDescriptor);
    }
  }

  assert.ok(thrown instanceof Error);
  assert.equal(getterReads, 0);
});

// 背景：node count 不计 scalar/key UTF-8；同一 1 MiB primitive string 可被 9999 行重复引用而
// 不增加 JS source allocation，却让后续 canonical/hash 重复处理。目的：七个共享块保持合法，
// 第八个块跨越累计 8 MiB raw UTF-8 门并在 hostile row 前失败。上下文：按每次语义出现计费，
// shared identity 不返还预算，且 zero refs 不消耗 projection work。
test('Decision inventory 累计 UTF-8 预算按共享长字符串的每次出现计费', () => {
  const shared = 'x'.repeat(1024 * 1024);
  const makeRows = (length: number) => zeroRefDecisionInventory(length).map((record) => ({
    ...record,
    question: shared,
  }));
  assert.doesNotThrow(() => Reflect.apply(compileFlowPlan, undefined, [
    metadata, scenario, assessment, makeRows(7), timestamp,
  ]));

  const later = decisionRowParseSentinel(goldenDecisionFixture());
  assert.throws(
    () => Reflect.apply(compileFlowPlan, undefined, [
      metadata, scenario, assessment, [...makeRows(8), later.value], timestamp,
    ]),
    /FLOW_DECISION_CUMULATIVE_UTF8_BUDGET_EXCEEDED/u,
  );
  assert.equal(later.parseCount(), 0);
});

// 背景：raw UTF-8 bytes 也低估 JSON escaping；一个 NUL 只占 1 byte，却在 canonical JSON 中
// 需要六个 ASCII bytes。目的：两个共享 1 MiB NUL scalar 继续可哈希，第三个跨越 16 MiB
// canonical-output work 门并在分配完整 canonical string/hash 前拒绝。上下文：该字符串仍满足当前
// strict scalar grammar，故失败只能来自新增累计 canonical 预算而非 Zod 文本校验。
test('Decision inventory 累计 canonical-output 预算覆盖 JSON escaping 放大', () => {
  const shared = '\0'.repeat(1024 * 1024);
  const makeRows = (length: number) => zeroRefDecisionInventory(length).map((record) => ({
    ...record,
    question: shared,
  }));
  assert.doesNotThrow(() => Reflect.apply(compileFlowPlan, undefined, [
    metadata, scenario, assessment, makeRows(2), timestamp,
  ]));

  const later = decisionRowParseSentinel(goldenDecisionFixture());
  assert.throws(
    () => Reflect.apply(compileFlowPlan, undefined, [
      metadata, scenario, assessment, [...makeRows(3), later.value], timestamp,
    ]),
    /FLOW_DECISION_CUMULATIVE_CANONICAL_BUDGET_EXCEEDED/u,
  );
  assert.equal(later.parseCount(), 0);
});

test('Decision outer 继续拒绝 sparse、accessor 与小 length 大量 enumerable extension', () => {
  const decision = goldenDecisionFixture();
  const sparse: unknown[] = new Array(2);
  sparse[0] = decision;
  assert.throws(() => Reflect.apply(
    compileFlowPlan,
    undefined,
    [metadata, scenario, assessment, sparse, timestamp],
  ));

  const accessor = accessorArraySentinel();
  assert.throws(() => Reflect.apply(
    compileFlowPlan,
    undefined,
    [metadata, scenario, assessment, accessor.value, timestamp],
  ));
  assert.equal(accessor.readCount(), 0);

  const extended: unknown[] = [decision];
  for (let index = 0; index < 20_000; index += 1) {
    Object.defineProperty(extended, `extra-${String(index).padStart(5, '0')}`, {
      configurable: true,
      enumerable: true,
      value: index,
    });
  }
  assert.throws(() => Reflect.apply(
    compileFlowPlan,
    undefined,
    [metadata, scenario, assessment, extended, timestamp],
  ));
});

// 背景：公开 capability 顺序与内部编译曾共享同一个 mutable array，caller 的 pop/splice/元素写
// 会永久改变后续 Flow 输出和 assessment 投影预算。目的：公开副本与 private canonical copy 都冻结，
// mutation 必须抛错/无效，随后两次 compile 仍产生 exact24 相同身份。
test('FLOW_CAPABILITY_ORDER 冻结且 caller mutation 不污染后续 compile', () => {
  const expected = [...FLOW_CAPABILITY_ORDER];
  assert.equal(Object.isFrozen(FLOW_CAPABILITY_ORDER), true);
  assert.throws(() => Reflect.apply(Array.prototype.pop, FLOW_CAPABILITY_ORDER, []));
  assert.throws(() => Reflect.apply(Array.prototype.splice, FLOW_CAPABILITY_ORDER, [0, 1]));
  assert.equal(Reflect.set(FLOW_CAPABILITY_ORDER, '0', 'work'), false);
  assert.throws(() => Object.defineProperty(FLOW_CAPABILITY_ORDER, '0', { value: 'work' }));

  const decision = goldenDecisionFixture();
  const goldenAssessment = flowAssessmentSchema.parse({ ...assessment, sourceRefs: [] });
  const first = compileFlowPlan(metadata, scenario, goldenAssessment, [decision], timestamp);
  const second = compileFlowPlan(metadata, scenario, goldenAssessment, [decision], timestamp);
  assert.deepEqual(first.capabilities.map(({ capability }) => capability), expected);
  assert.deepEqual(second, first);
  assert.equal(first.capabilities.length, 24);
});

test('FlowCompileInput 与 assertor 都要求 exact 24 capability rows', () => {
  const input = goldenFlowInputFixture();
  assert.throws(() => Reflect.apply(flowInputHash, undefined, [{
    ...input,
    capabilities: input.capabilities.slice(1),
  }]));
  assert.throws(() => Reflect.apply(flowInputHash, undefined, [{
    ...input,
    capabilities: [...input.capabilities, input.capabilities[0]],
  }]));

  const decision = goldenDecisionFixture();
  const goldenAssessment = flowAssessmentSchema.parse({ ...assessment, sourceRefs: [] });
  const plan = compileFlowPlan(metadata, scenario, goldenAssessment, [decision], timestamp);
  const accepted = { decisionBindings: plan.decisionBindings, flowHash: hashFlowPlan(plan) };
  assert.throws(() => Reflect.apply(assertDecisionFlowIdentityV2, undefined, [
    { ...plan, capabilities: plan.capabilities.slice(1) },
    [decision],
    accepted,
  ]));
});

// 背景：hashFlowPlan 过去只解析 final FlowPlan；该 domain schema 允许零行或缺少 canonical row，
// 因而完整 Flow 的公开 hash 边界比 flowInputHash/assertor 更宽。目的：0/23/25 三种 cardinality
// 都必须由同一 exact-24 input validator 拒绝。上下文：测试只构造非法 caller inventory，不排序、
// 去重或修复它；final 持久 domain schema 仍保持原样。
for (const [label, mutateCapabilities] of [
  ['zero', (capabilities: readonly unknown[]) => []],
  ['missing-one', (capabilities: readonly unknown[]) => capabilities.slice(1)],
  ['extra-one', (capabilities: readonly unknown[]) => [...capabilities, capabilities.at(-1)]],
] as const) {
  test(`hashFlowPlan 拒绝 ${label} capability inventory`, () => {
    const decision = goldenDecisionFixture();
    const goldenAssessment = flowAssessmentSchema.parse({ ...assessment, sourceRefs: [] });
    const plan = compileFlowPlan(metadata, scenario, goldenAssessment, [decision], timestamp);

    assert.throws(() => Reflect.apply(hashFlowPlan, undefined, [{
      ...plan,
      capabilities: mutateCapabilities(plan.capabilities),
    }]));
  });
}

test('规范 20.1 每个合法 Decision 内容 mutation 都改变 binding、inputHash 与 flowHash', () => {
  const baseDecision = decisionFixture();
  const basePlan = compileFlowPlan(metadata, scenario, assessment, [baseDecision], timestamp);
  const baseBinding = decisionBinding(baseDecision);

  const mutations: ReadonlyArray<readonly [string, (record: DecisionRecord) => unknown]> = [
    ['owner', (record) => ({ ...record, owner: 'AGENT' })],
    ['status-with-resolution', (record) => ({
      ...record,
      status: 'RESOLVED',
      resolvedRevision: 'REV-0001',
      resolution: {
        optionId: 'OPT-01', summary: 'The native boundary is accepted',
        authority: 'HUMAN_CONFIRMED', sourceRefs: record.sourceRefs,
      },
    })],
    ['blocking', (record) => ({ ...record, blocking: false })],
    ['kind', (record) => ({ ...record, kind: 'ARCHITECTURE' })],
    ['viable-option-count', (record) => ({
      ...record,
      options: [...record.options, {
        id: 'OPT-02', label: 'Split the boundary', status: 'VIABLE',
        consequences: ['Two authenticated sources'], sourceRefs: record.sourceRefs,
      }],
    })],
    ['viable-option-status', (record) => ({
      ...record,
      options: record.options.map((option) => ({ ...option, status: 'REJECTED' })),
    })],
    ['affects-capabilities', (record) => ({
      ...record, affects: { ...record.affects, capabilities: ['review'] },
    })],
    ['question', (record) => ({ ...record, question: 'Which reviewed boundary is authoritative?' })],
    ['source-refs', (record) => ({
      ...record, sourceRefs: [{ kind: 'code', path: 'src/core/flow.ts', contentHash: hash('4') }],
    })],
    ['option-consequences', (record) => ({
      ...record,
      options: record.options.map((option) => ({ ...option, consequences: ['One sealed source'] })),
    })],
    ['affects-artifacts', (record) => ({
      ...record, affects: { ...record.affects, artifacts: ['design.md'] },
    })],
    ['affects-tasks', (record) => ({
      ...record, affects: { ...record.affects, tasks: ['TASK-002'] },
    })],
    ['affects-projects', (record) => ({
      ...record, affects: { ...record.affects, projects: ['other'] },
    })],
    ['affects-contracts', (record) => ({
      ...record, affects: { ...record.affects, contracts: ['IF-SEALED'] },
    })],
    ['timestamps', (record) => ({ ...record, updatedAt: laterTimestamp })],
  ];

  for (const [name, mutation] of mutations) {
    const changedDecision = mutateDecision(baseDecision, mutation);
    const changedPlan = compileFlowPlan(metadata, scenario, assessment, [changedDecision], timestamp);
    assert.notEqual(decisionBinding(changedDecision).contentHash, baseBinding.contentHash, `${name}: binding`);
    assert.notEqual(changedPlan.inputHash, basePlan.inputHash, `${name}: inputHash`);
    assert.notEqual(hashFlowPlan(changedPlan), hashFlowPlan(basePlan), `${name}: flowHash`);
  }
});

test('独立 literal golden 认证 Decision、Flow input 与完整 Flow identity', () => {
  const expectedDecisionHash = sha256Schema.parse(sha256Literal(GOLDEN_DECISION_CANONICAL_BYTES));
  const expectedFlowInputHash = sha256Schema.parse(sha256Literal(GOLDEN_FLOW_INPUT_CANONICAL_BYTES));
  const expectedFlowHash = sha256Schema.parse(sha256Literal(GOLDEN_FLOW_CANONICAL_BYTES));
  assert.equal(expectedDecisionHash, GOLDEN_DECISION_HASH);
  assert.equal(expectedFlowInputHash, GOLDEN_FLOW_INPUT_HASH);
  assert.equal(expectedFlowHash, GOLDEN_FLOW_HASH);

  const acceptedDecision = goldenDecisionFixture();
  const goldenAssessment = flowAssessmentSchema.parse({ ...assessment, sourceRefs: [] });
  const acceptedFlow = compileFlowPlan(metadata, scenario, goldenAssessment, [acceptedDecision], timestamp);
  const acceptedIdentity = Object.freeze({
    decisionBindings: Object.freeze([decisionBindingSchema.parse({
      id: 'DEC-0001',
      contentHash: GOLDEN_DECISION_HASH,
    })]),
    flowHash: sha256Schema.parse(GOLDEN_FLOW_HASH),
  });

  assert.equal(decisionBinding(acceptedDecision).contentHash, expectedDecisionHash);
  assert.equal(acceptedFlow.inputHash, expectedFlowInputHash);
  assert.equal(hashFlowPlan(acceptedFlow), expectedFlowHash);
  assert.doesNotThrow(() => assertDecisionFlowIdentityV2(acceptedFlow, [acceptedDecision], acceptedIdentity));

  const changedDecision = mutateDecision(acceptedDecision, (record) => ({
    ...record,
    question: 'Can a coherent suffix rewrite replace the accepted identity?',
  }));
  const coherentlyRewrittenFlow = compileFlowPlan(
    metadata,
    scenario,
    goldenAssessment,
    [changedDecision],
    timestamp,
  );
  const changedCompiledAt = flowPlanSchema.parse({ ...acceptedFlow, compiledAt: laterTimestamp });

  assert.throws(
    () => assertDecisionFlowIdentityV2(acceptedFlow, [changedDecision], acceptedIdentity),
    /FLOW_DECISION_BINDING_MISMATCH/,
  );
  assert.throws(
    () => assertDecisionFlowIdentityV2(coherentlyRewrittenFlow, [changedDecision], acceptedIdentity),
    /FLOW_ACCEPTED_IDENTITY_MISMATCH/,
  );
  assert.throws(
    () => assertDecisionFlowIdentityV2(changedCompiledAt, [acceptedDecision], acceptedIdentity),
    /FLOW_ACCEPTED_IDENTITY_MISMATCH/,
  );
});

test('resolved Decision 只保留历史 binding，不再向当前 capability sourceRefs 投影', () => {
  const openDecision = decisionFixture();
  const resolvedDecision = mutateDecision(openDecision, (record) => ({
    ...record,
    status: 'RESOLVED',
    resolvedRevision: 'REV-0001',
    resolution: {
      optionId: 'OPT-01', summary: 'Historical source is sealed',
      authority: 'HUMAN_CONFIRMED', sourceRefs: record.sourceRefs,
    },
  }));
  const plan = compileFlowPlan(metadata, scenario, assessment, [resolvedDecision], timestamp);
  const design = plan.capabilities.find(({ capability }) => capability === 'design');

  assert.equal(plan.decisionBindings.length, 1);
  assert.deepEqual(design?.sourceRefs, assessment.sourceRefs);
});

// 背景：assessment SourceRef 会进入全部 24 个 capability；OPEN AGENT Decision 还会隐式
// 投影 research。目的：锁定 10,000 次实际投影的精确边界，并证明 affects 已含 research 时
// 隐式 research 不会被重复计费。上下文：这里断言的是输出集合与错误阶段，不使用机器耗时。
test('Flow SourceRef 投影预算精确接受 10000 且语义重复 research 只计一次', () => {
  const assessmentSourceRefs = Array.from({ length: 416 }, (_, index) => ({
    kind: 'code' as const,
    path: `src/assessment/${String(index).padStart(4, '0')}.ts`,
    contentHash: hash('4'),
  }));
  const decisionSourceRefs = Array.from({ length: 16 }, (_, index) => ({
    kind: 'code' as const,
    path: `src/decision/${String(index).padStart(4, '0')}.ts`,
    contentHash: hash('5'),
  }));
  const boundaryAssessment = flowAssessmentSchema.parse({
    ...assessment,
    sourceRefs: assessmentSourceRefs,
  });
  const agentDecision = mutateDecision(decisionFixture(), (record) => ({
    ...record,
    owner: 'AGENT',
    affects: { ...record.affects, capabilities: ['research'] },
    sourceRefs: decisionSourceRefs,
  }));
  const plan = compileFlowPlan(metadata, scenario, boundaryAssessment, [agentDecision], timestamp);

  assert.equal(plan.capabilities.reduce((total, capability) => total + capability.sourceRefs.length, 0), 10_000);
  assert.equal(plan.capabilities.find(({ capability }) => capability === 'research')?.sourceRefs.length, 432);
});

// 背景：旧实现对同一 capability 的每个 Decision 都执行 `[...旧数组, ...新引用]`，即使
// 5,001 个 Decision 只重复两个 locator、最终只留下两项，也会先完成累计重拷贝、sort 与 hash。
// 目的：重复 locator 仍按真实 lookup/投影尝试计费，10,002 次必须在任何投影数组扩展前稳定
// fail-closed；这既捕获旧二次 spread，也防止攻击者利用最终去重绕过资源边界。
test('Flow 重复 SourceRef 超过线性投影预算时在展开与 hash 前关闭', () => {
  const duplicateSourceRefs = [
    { kind: 'artifact' as const, path: 'duplicate.md', contentHash: hash('6') },
    { kind: 'code' as const, path: 'src/duplicate.ts', contentHash: hash('7') },
  ];
  const decisions = Array.from({ length: 5_001 }, (_, index) => mutateDecision(
    decisionFixture(),
    (record) => ({
      ...record,
      id: `DEC-${String(index + 1).padStart(4, '0')}`,
      sourceRefs: duplicateSourceRefs,
    }),
  ));

  assert.throws(
    () => compileFlowPlan(metadata, scenario, assessment, decisions, timestamp),
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /^FLOW_SOURCE_REF_PROJECTION_BUDGET_EXCEEDED:/u);
      return true;
    },
  );
});

test('公开 Flow、route 与 stage facade 在缺 marker 时先 fail-closed 且不读取 raw ChangeRef', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'omnai-task5-gate-missing-'));
  cleanupDirectories.push(repoRoot);
  const sentinel = rawChangeRefSentinel();

  await assert.rejects(loadFlowPlan(repoRoot, sentinel.change), /UNSUPPORTED_WORKFLOW_VERSION/);
  await assert.rejects(resolveRepositoryRoute(repoRoot, sentinel.change), /UNSUPPORTED_WORKFLOW_VERSION/);
  await assert.rejects(prepareStage(repoRoot, sentinel.change, 'spec', 'Must not read Change state.'), /UNSUPPORTED_WORKFLOW_VERSION/);
  await assert.rejects(completeStage(repoRoot, sentinel.change, 'spec'), /UNSUPPORTED_WORKFLOW_VERSION/);
  assert.equal(sentinel.readCount(), 0);
  await assert.rejects(readFile(join(repoRoot, '.omnai', 'workflow.lock.yaml'), 'utf8'), /ENOENT/);
});

test('仅有 minimal marker 时 raw ChangeRef 仍在 Change/protocol/write I/O 前关闭', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'omnai-task5-gate-unsealed-'));
  cleanupDirectories.push(repoRoot);
  const lockPath = join(repoRoot, '.omnai', 'workflow.lock.yaml');
  await mkdir(join(repoRoot, '.omnai'));
  await writeFile(lockPath, 'workflowVersion: 0.3.0\n', 'utf8');
  const sentinel = rawChangeRefSentinel();

  await assert.rejects(loadFlowPlan(repoRoot, sentinel.change), /NATIVE_CONTEXT_UNAVAILABLE/);
  await assert.rejects(resolveRepositoryRoute(repoRoot, sentinel.change), /NATIVE_CONTEXT_UNAVAILABLE/);
  await assert.rejects(prepareStage(repoRoot, sentinel.change, 'spec', 'Must not read Change state.'), /NATIVE_CONTEXT_UNAVAILABLE/);
  await assert.rejects(completeStage(repoRoot, sentinel.change, 'spec'), /NATIVE_CONTEXT_UNAVAILABLE/);
  assert.equal(sentinel.readCount(), 0);
  assert.equal(await readFile(lockPath, 'utf8'), 'workflowVersion: 0.3.0\n');
});

function rawChangeRefSentinel(): { change: ChangeRef; readCount: () => number } {
  let reads = 0;
  const target = Object.create(null) as ChangeRef;
  const change = new Proxy(target, {
    get() {
      reads += 1;
      throw new Error('RAW_CHANGE_REF_READ');
    },
  });
  return { change, readCount: () => reads };
}
