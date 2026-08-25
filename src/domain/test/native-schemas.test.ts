import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  ARCHITECTURE_APPLICABILITIES,
  CAPABILITY_DISPOSITIONS,
  DECISION_AUTHORITIES,
  DECISION_KINDS,
  DECISION_OPTION_STATUSES,
  DECISION_OWNERS,
  DECISION_STATUSES,
  DELIVERY_SHAPES,
  EVIDENCE_PRODUCERS,
  EVIDENCE_RECORD_TYPES,
  EVIDENCE_STATUSES,
  FLOW_SCALES,
  FLOW_TOPOLOGIES,
  FLOW_UNCERTAINTY,
  SOURCE_REF_KINDS,
  changeMetadataSchema,
  decisionRecordSchema,
  evidenceRecordSchema,
  flowAssessmentProposalSchema,
  flowPlanSchema,
  progressEventSchema,
  projectConfigSchema,
  projectRegistrySchema,
  sourceRefCollectionSchema,
  sourceRefSchema,
  revisionSchema,
  repositoryRunLineageSchema,
  repositoryWorkResultSchema,
  runAuthorityContractSchema,
  type RunAuthorityContractConstructionInput,
  stageRunManifestSchema,
  stageTerminalResultSchema,
  taskFileSchema,
  type StageRunManifestConstructionInput,
  workflowLockSchema,
  type WorkflowLockConstructionInput,
  worksetReentrySchema,
  worksetSchema,
} from '../types.js';
import {
  CAPABILITIES,
  CHANGE_STATUSES,
  READINESS_KEYS,
  READINESS_STATUSES,
  RECONCILE_LEVELS,
  RISK_DIMENSION_LEVELS,
  RISK_LEVELS,
  RUN_LIFECYCLE_OWNER_KINDS,
  SCENARIO_IDS,
  TASK_STATUSES,
  WORK_MODES,
  changeArtifactDirectorySchema,
  frozenByteBlobSchema,
  hObject as productionHObject,
  projectAliasSchema,
  repositoryCodePathSchema,
  strictJsonValueSchema,
  strictWorksetBranchSchema,
  type ProjectAlias,
  type StrictJsonValue,
} from '../public.js';
import { scenarioProfileSchema, type ScenarioProfile } from '../change.js';
import {
  PROJECT_CONFIG_OPERATION_KINDS,
  PROJECT_TRANSACTION_KINDS,
} from '../project.js';
import {
  REENTRY_KINDS,
  WORKSET_MEMBER_STATUSES,
  WORKSET_OPERATION_KINDS,
  WORKSET_TARGET_OPERATION_KINDS,
  registeredProjectSchema,
  worksetMemberSchema,
} from '../workset.js';

const hash = (marker: string): string => `sha256:${Buffer.from(marker).toString('hex').padEnd(64, '0').slice(0, 64)}`;
const timestamp = '2026-08-23T01:02:03.004Z';
const laterTimestamp = '2026-08-23T01:02:04.004Z';
const readiness = {
  frame: 'READY',
  map: 'READY',
  research: 'READY',
  mitigation: 'NOT_APPLICABLE',
  triage: 'NOT_APPLICABLE',
  reproduction: 'NOT_APPLICABLE',
  diagnosis: 'NOT_APPLICABLE',
  domain: 'READY',
  spec: 'READY',
  design: 'READY',
  experiment: 'NOT_APPLICABLE',
  fix: 'NOT_APPLICABLE',
  plan: 'READY',
  implementation: 'IN_PROGRESS',
  review: 'MISSING',
  simplification: 'MISSING',
  verification: 'MISSING',
  qa: 'MISSING',
  release: 'NOT_APPLICABLE',
  canary: 'MISSING',
  learning: 'MISSING',
} as const;
const artifactSource = { kind: 'artifact', path: 'domain.md', contentHash: hash('a') } as const;
const decisionSource = { kind: 'decision', decisionId: 'DEC-0001', contentHash: hash('d') } as const;

function changeMetadataFixture(artifactVersions: Record<string, number>): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: 'CHG-0001',
    slug: 'native-schema',
    title: 'Native Schema',
    scenario: 'small-feature',
    workMode: 'FEATURE',
    status: 'IN_PROGRESS',
    activeRevision: 'REV-0001',
    baseline: 'BL-0001',
    artifactVersions,
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
    readiness,
  };
}

const openDecision = {
  schemaVersion: 2,
  id: 'DEC-0001',
  changeId: 'CHG-0001',
  openedRevision: 'REV-0001',
  resolvedRevision: null,
  kind: 'DOMAIN',
  owner: 'HUMAN',
  status: 'OPEN',
  blocking: true,
  question: 'Which aggregate owns durable consent?',
  options: [],
  resolution: null,
  supersededBy: null,
  affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] },
  sourceRefs: [artifactSource],
  createdAt: timestamp,
  updatedAt: timestamp,
} as const;

const assessment = {
  scale: 'CHANGE',
  uncertainty: { problem: 'CLEAR', domain: 'OPEN', solution: 'CLEAR', delivery: 'CLEAR' },
  topology: 'SINGLE_MODULE',
  architectureApplicability: 'FOCUSED',
  deliveryShape: 'STANDARD',
  decisionIds: ['DEC-0001'],
  sourceRefs: [decisionSource],
} as const;

const runOwner = {
  sequence: 2,
  owner: { kind: 'STAGE_PREPARE', id: 'RUN-000001' },
  operationRequestId: 'prepare-1',
  requestDigest: hash('r'),
} as const;

const runAuthority = {
  schemaVersion: 3,
  changeId: 'CHG-0001',
  runId: 'RUN-000001',
  capability: 'spec',
  revision: 'REV-0001',
  preparedFromAuthorityHead: hash('h'),
  prepareOwner: runOwner,
  authoredOutputBindings: [],
  allowedDescendants: [],
  terminal: { kind: 'ARTIFACT_STAGE', readinessKey: 'spec', requiredOutputRoles: [] },
  terminalHash: hObject({ kind: 'ARTIFACT_STAGE', readinessKey: 'spec', requiredOutputRoles: [] }),
} as const;

const prompt = {
  path: 'runs/RUN-000001/prompt.md',
  rendererId: 'prompt-render-v1',
  rendererHash: hash('r'),
  rawBytesHash: hash('b'),
  instructionHash: hash('i'),
  contextBindingsHash: hash('c'),
  protocolBindings: [
    { id: 'common', version: 1, relativePath: 'resources/protocols/common.md', rawBytesHash: hash('1') },
    { id: 'spec', version: 1, relativePath: 'resources/protocols/repository/spec.md', rawBytesHash: hash('2') },
  ],
  protocolBindingsHash: hObject([
    { id: 'common', version: 1, relativePath: 'resources/protocols/common.md', rawBytesHash: hash('1') },
    { id: 'spec', version: 1, relativePath: 'resources/protocols/repository/spec.md', rawBytesHash: hash('2') },
  ]),
  renderInputHash: hash('n'),
} as const;

const preparedManifest = {
  schemaVersion: 3,
  workflowVersion: '0.3.0',
  authorityCatalogHash: hash('a'),
  runId: 'RUN-000001',
  changeId: 'CHG-0001',
  revision: 'REV-0001',
  capability: 'spec',
  preparedAt: timestamp,
  prepareOwner: runOwner,
  prompt,
  authorityContract: runAuthority,
  authorityContractHash: hObject(runAuthority),
  disposition: 'PREPARED',
} as const;

const rejected = [
  ['workflow-lock-v1', workflowLockSchema, { schemaVersion: 1 }],
  ['project-config-v1', projectConfigSchema, { schemaVersion: 1 }],
  ['change-v1', changeMetadataSchema, { schemaVersion: 1 }],
  ['decision-v1', decisionRecordSchema, { schemaVersion: 1 }],
  ['flow-proposal-v1', flowAssessmentProposalSchema, { schemaVersion: 1 }],
  ['flow-v1', flowPlanSchema, { schemaVersion: 1 }],
  ['task-defaultable-v1', taskFileSchema, { schemaVersion: 1, revision: 'REV-0001', tasks: [] }],
  ['evidence-defaultable-v1', evidenceRecordSchema, { schemaVersion: 1 }],
  ['revision-defaultable-v1', revisionSchema, { schemaVersion: 1 }],
  ['progress-defaultable-v1', progressEventSchema, { event: 'CHANGE_CREATED' }],
  ['run-authority-v2', runAuthorityContractSchema, { schemaVersion: 2 }],
  ['run-v2', stageRunManifestSchema, { schemaVersion: 2 }],
  ['registry-v1', projectRegistrySchema, { schemaVersion: 1, projects: [] }],
  ['workset-v1', worksetSchema, { schemaVersion: 1 }],
  ['reentry-v1', worksetReentrySchema, { schemaVersion: 1 }],
] as const;

for (const [name, schema, value] of rejected) {
  test(`${name} has no compatibility reader`, () => {
    assert.equal(schema.safeParse(value).success, false);
  });
}

test('final public objects require exact fields and reject unknown properties', () => {
  const valid = workflowLockSchema.parse({
    schemaVersion: 2,
    workflowVersion: '0.3.0',
    authorityCatalogId: 'omnai.stage-authority.v1',
    authorityCatalogSchemaVersion: 1,
    authorityCatalogHash: hash('c'),
    resourceBundleHash: hash('b'),
  });
  assert.equal(valid.schemaVersion, 2);
  assert.equal(workflowLockSchema.safeParse({ ...valid, artifactSchemas: {} }).success, false);
});

test('final persistent parsers reject hostile raw object graphs before reading fields', () => {
  const lock = {
    schemaVersion: 2,
    workflowVersion: '0.3.0',
    authorityCatalogId: 'omnai.stage-authority.v1',
    authorityCatalogSchemaVersion: 1,
    authorityCatalogHash: hash('c'),
    resourceBundleHash: hash('b'),
  } as const;
  assert.equal(workflowLockSchema.safeParse(Object.create(lock)).success, false);
  assert.equal(workflowLockSchema.safeParse(Object.assign(Object.create(null), lock)).success, true);

  let rootGetterReads = 0;
  const rootAccessor = { ...lock } as Record<string, unknown>;
  Object.defineProperty(rootAccessor, 'resourceBundleHash', {
    enumerable: true,
    get() {
      rootGetterReads += 1;
      return hash('b');
    },
  });
  assert.equal(workflowLockSchema.safeParse(rootAccessor).success, false);
  assert.equal(rootGetterReads, 0);

  const rootSymbol = { ...lock } as Record<string | symbol, unknown>;
  rootSymbol[Symbol('hidden')] = true;
  assert.equal(workflowLockSchema.safeParse(rootSymbol).success, false);

  const accessorManifest = structuredClone(preparedManifest);
  let getterReads = 0;
  Object.defineProperty(accessorManifest.prompt, 'rendererId', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'prompt-render-v1';
    },
  });
  assert.equal(stageRunManifestSchema.safeParse(accessorManifest).success, false);
  assert.equal(getterReads, 0);

  const symbolManifest = structuredClone(preparedManifest);
  Object.defineProperty(symbolManifest.prompt, Symbol('hidden'), { enumerable: true, value: true });
  assert.equal(stageRunManifestSchema.safeParse(symbolManifest).success, false);

  const sparseManifest = structuredClone(preparedManifest);
  Object.defineProperty(sparseManifest.authorityContract, 'authoredOutputBindings', {
    enumerable: true,
    configurable: true,
    writable: true,
    value: new Array(1),
  });
  assert.equal(stageRunManifestSchema.safeParse(sparseManifest).success, false);

  const undefinedManifest = structuredClone(preparedManifest) as Record<string, unknown>;
  undefinedManifest.unexpected = undefined;
  assert.equal(stageRunManifestSchema.safeParse(undefinedManifest).success, false);

  const circularLock = { ...lock } as Record<string, unknown>;
  circularLock.resourceBundleHash = circularLock;
  assert.equal(workflowLockSchema.safeParse(circularLock).success, false);
});

// 背景：旧 guard 只认证 own descriptor，随后却把原始普通对象交回 Zod；因此攻击者可在
// Object.prototype 上补出缺失的 workflowVersion，让 strictObject 读取继承 getter 并接受一个
// 身份图中根本不存在的字段。目的：缺少 own 字段必须在认证克隆上稳定拒绝，且认证、Zod 两段
// 都不能观察继承 getter。上下文：finally 精确恢复全局 descriptor，避免原型探针污染其他测试。
test('WorkflowLock 缺少 own workflowVersion 时不读取 Object.prototype getter', () => {
  const input = {
    schemaVersion: 2,
    authorityCatalogId: 'omnai.stage-authority.v1',
    authorityCatalogSchemaVersion: 1,
    authorityCatalogHash: hash('catalog'),
    resourceBundleHash: hash('bundle'),
  };
  const originalDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'workflowVersion');
  let getterReads = 0;
  let result: ReturnType<typeof workflowLockSchema.safeParse> | undefined;
  Object.defineProperty(Object.prototype, 'workflowVersion', {
    configurable: true,
    get() {
      getterReads += 1;
      return '0.3.0';
    },
  });
  try {
    result = workflowLockSchema.safeParse(input);
  } finally {
    if (originalDescriptor === undefined) {
      Reflect.deleteProperty(Object.prototype, 'workflowVersion');
    } else {
      Object.defineProperty(Object.prototype, 'workflowVersion', originalDescriptor);
    }
  }

  assert.equal(result?.success, false);
  assert.equal(getterReads, 0);
});

// 背景：guard 已把 raw input 克隆为 null-prototype object，但 Zod v4 object parser
// 会用普通赋值构造输出；Object.prototype 上的 discard setter 因而会执行，
// 并让 required 字段在 success 输出中消失。目的：direct/clone/sync/async/八路并发
// 共享边界在进入 Zod assignment 前以 descriptor 检测危险环境，caller getter/setter
// 必须零调用；允许安全 fail-closed，但若成功则必须返回 own data field。上下文：
// finally 先恢复全局 descriptor，所有断言都在恢复后执行。
test('persistent guard 在 Object prototype discard setter 下不洗白 WorkflowLock 输出', async () => {
  const input: WorkflowLockConstructionInput = {
    schemaVersion: 2,
    workflowVersion: '0.3.0',
    authorityCatalogId: 'omnai.stage-authority.v1',
    authorityCatalogSchemaVersion: 1,
    authorityCatalogHash: hash('c'),
    resourceBundleHash: hash('b'),
  };
  const originalDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'workflowVersion');
  let getterReads = 0;
  let setterWrites = 0;
  const outcomes: Array<ReturnType<typeof workflowLockSchema.safeParse>> = [];
  let syncParsed: unknown;
  let syncRejected = false;
  let concurrent: Array<ReturnType<typeof workflowLockSchema.safeParse>> = [];
  Object.defineProperty(Object.prototype, 'workflowVersion', {
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
    outcomes.push(workflowLockSchema.safeParse(input));
    outcomes.push(workflowLockSchema.clone().safeParse(input));
    try {
      syncParsed = workflowLockSchema.parse(input);
    } catch {
      syncRejected = true;
    }
    outcomes.push(await workflowLockSchema.safeParseAsync(input));
    concurrent = await Promise.all(Array.from(
      { length: 8 },
      () => workflowLockSchema.clone().safeParseAsync(input),
    ));
  } finally {
    if (originalDescriptor === undefined) {
      Reflect.deleteProperty(Object.prototype, 'workflowVersion');
    } else {
      Object.defineProperty(Object.prototype, 'workflowVersion', originalDescriptor);
    }
  }

  assert.equal(getterReads, 0);
  assert.equal(setterWrites, 0);
  for (const outcome of [...outcomes, ...concurrent]) {
    if (!outcome.success) continue;
    assert.equal(Object.getPrototypeOf(outcome.data), null);
    assert.deepEqual(Object.getOwnPropertyDescriptor(outcome.data, 'workflowVersion'), {
      configurable: true,
      enumerable: true,
      value: '0.3.0',
      writable: true,
    });
  }
  if (!syncRejected) {
    assert.equal(typeof syncParsed, 'object');
    assert.notEqual(syncParsed, null);
    assert.equal(Object.getPrototypeOf(syncParsed), null);
    assert.equal(Object.hasOwn(syncParsed as object, 'workflowVersion'), true);
  }
});

// 背景：Zod array parser 会以普通 numeric assignment 构造结果，继承的
// Array.prototype[0] accessor 可执行 caller code，丢失 own index，甚至污染 Zod 的 JIT
// compiler 缓存。目的：真实 guarded z.array 在赋值前安全关闭，或返回 dense
// own-data array，全程 getter/setter 零调用。上下文：finally 恢复 descriptor 后才观察结果。
test('sourceRefCollection 在 Array prototype numeric discard setter 下零副作用', () => {
  const moduleUrl = new URL('../types.js', import.meta.url).href;
  const childSource = `
    import { sourceRefCollectionSchema } from ${JSON.stringify(moduleUrl)};
    const hash = 'sha256:' + Buffer.from('a').toString('hex').padEnd(64, '0').slice(0, 64);
    const input = [{ kind: 'artifact', path: 'domain.md', contentHash: hash }];
    const originalDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, '0');
    let getterReads = 0;
    let setterWrites = 0;
    let result;
    let thrown;
    Object.defineProperty(Array.prototype, '0', {
      configurable: true,
      get() { getterReads += 1; return undefined; },
      set(_value) { setterWrites += 1; },
    });
    try {
      try { result = sourceRefCollectionSchema.safeParse(input); }
      catch (error) { thrown = error; }
    } finally {
      if (originalDescriptor === undefined) Reflect.deleteProperty(Array.prototype, '0');
      else Object.defineProperty(Array.prototype, '0', originalDescriptor);
    }
    process.stdout.write(JSON.stringify({
      getterReads,
      setterWrites,
      thrown: thrown instanceof Error ? thrown.name + ':' + thrown.message : null,
      success: result?.success ?? null,
      length: result?.success ? result.data.length : null,
      own: result?.success ? Object.hasOwn(result.data, '0') : null,
      kind: result?.success ? Object.getOwnPropertyDescriptor(result.data, '0')?.value.kind : null,
    }));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', childSource], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout) as {
    getterReads: number;
    setterWrites: number;
    thrown: string | null;
    success: boolean | null;
    length: number | null;
    own: boolean | null;
    kind: string | null;
  };

  assert.equal(result.thrown, null);
  assert.equal(result.getterReads, 0);
  assert.equal(result.setterWrites, 0);
  if (result.success) {
    assert.equal(result.length, 1);
    assert.equal(result.own, true);
    assert.equal(result.kind, 'artifact');
  }
});

// 背景：Array.prototype 没有 own numeric descriptor 时，Zod issues array 的普通
// push 仍会沿继承链抵达 Object.prototype[0]；只扫描 Array.prototype 会在准备
// fail-closed issue 时执行 caller setter。目的：真实 guarded array 在完整
// Array→Object numeric descriptor 链污染下不抛出、getter/setter 都为零。上下文：
// 隔离子进程与 finally 同时避免 Zod JIT cache 和全局原型污染泄漏到其他测试。
test('persistent guard 在 Object prototype numeric discard setter 下安全写入 fail-closed issue', () => {
  const moduleUrl = new URL('../types.js', import.meta.url).href;
  const childSource = `
    import { sourceRefCollectionSchema } from ${JSON.stringify(moduleUrl)};
    const hash = 'sha256:' + Buffer.from('a').toString('hex').padEnd(64, '0').slice(0, 64);
    const input = [{ kind: 'artifact', path: 'domain.md', contentHash: hash }];
    const originalDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, '0');
    let getterReads = 0;
    let setterWrites = 0;
    let result;
    let thrown;
    Object.defineProperty(Object.prototype, '0', {
      configurable: true,
      get() { getterReads += 1; return undefined; },
      set(_value) { setterWrites += 1; },
    });
    try {
      try { result = sourceRefCollectionSchema.safeParse(input); }
      catch (error) { thrown = error; }
    } finally {
      if (originalDescriptor === undefined) Reflect.deleteProperty(Object.prototype, '0');
      else Object.defineProperty(Object.prototype, '0', originalDescriptor);
    }
    process.stdout.write(JSON.stringify({
      getterReads,
      setterWrites,
      thrown: thrown instanceof Error ? thrown.name + ':' + thrown.message : null,
      success: result?.success ?? null,
    }));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', childSource], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout) as {
    getterReads: number;
    setterWrites: number;
    thrown: string | null;
    success: boolean | null;
  };

  assert.equal(result.thrown, null);
  assert.equal(result.getterReads, 0);
  assert.equal(result.setterWrites, 0);
  assert.equal(result.success, false);
});

// 背景：公开 persistent parser 的最终结果仍是 Zod 创建的普通 object/array，
// 后续 HObject 会再次读取该环境中的 prototype 语义。目的：正常环境下的成功
// 输出也必须是 descriptor-authenticated graph：object 为 null prototype，array 为
// dense own-data，嵌套 object 不保留 Zod ordinary prototype。上下文：这是输出合同而不是实现形状断言。
test('persistent parser 成功输出是最终 descriptor-authenticated graph', () => {
  const workflow = workflowLockSchema.parse({
    schemaVersion: 2,
    workflowVersion: '0.3.0',
    authorityCatalogId: 'omnai.stage-authority.v1',
    authorityCatalogSchemaVersion: 1,
    authorityCatalogHash: hash('c'),
    resourceBundleHash: hash('b'),
  });
  const sources = sourceRefCollectionSchema.parse([artifactSource]);

  assert.equal(Object.getPrototypeOf(workflow), null);
  assert.equal(Object.hasOwn(workflow, 'workflowVersion'), true);
  assert.equal(Array.isArray(sources), true);
  assert.equal(Object.hasOwn(sources, '0'), true);
  assert.equal(Object.getPrototypeOf(sources[0]), null);
});

test('guarded persistent parsers retain protection after clone and across asynchronous parses', async () => {
  const input: WorkflowLockConstructionInput = {
    schemaVersion: 2,
    workflowVersion: '0.3.0',
    authorityCatalogId: 'omnai.stage-authority.v1',
    authorityCatalogSchemaVersion: 1,
    authorityCatalogHash: hash('c'),
    resourceBundleHash: hash('b'),
  };
  type IsUnknown<Value> = unknown extends Value ? true : false;
  const constructionInputIsUnknown: IsUnknown<WorkflowLockConstructionInput> = false;
  assert.equal(constructionInputIsUnknown, false);

  const clone = workflowLockSchema.clone();
  assert.equal(clone.safeParse(Object.create(input)).success, false);

  let cloneGetterReads = 0;
  const cloneAccessor = { ...input };
  Object.defineProperty(cloneAccessor, 'workflowVersion', {
    enumerable: true,
    get() {
      cloneGetterReads += 1;
      return '0.3.0';
    },
  });
  assert.equal(clone.safeParse(cloneAccessor).success, false);
  assert.equal(cloneGetterReads, 0);
  assert.equal((await workflowLockSchema.safeParseAsync(cloneAccessor)).success, false);
  assert.equal(cloneGetterReads, 0);

  const concurrent = Array.from({ length: 8 }, () => {
    let getterReads = 0;
    const value = { ...input };
    Object.defineProperty(value, 'workflowVersion', {
      enumerable: true,
      get() {
        getterReads += 1;
        return '0.3.0';
      },
    });
    return { value, getterReads: () => getterReads };
  });
  const settled = await Promise.allSettled(concurrent.map(({ value }) => workflowLockSchema.parseAsync(value)));
  assert.equal(settled.every((result) => result.status === 'rejected'), true);
  assert.equal(concurrent.every(({ getterReads }) => getterReads() === 0), true);
});

// 背景：descriptor guard 过去先调用 getPrototypeOf/Object.keys；透明 Proxy 因而被当作普通数据，
// throwing Proxy 则在 fail-closed 前执行 caller trap。目的：同一个 persistent schema 在原实例、
// clone、sync、async 与并发调用中都先以无 trap 的 Proxy 身份检查拒绝 root/nested/revoked 图。
// 上下文：合法 plain/null-prototype 数据仍由既有正例覆盖，本测试不以 mock 替代真实 Zod pipeline。
test('共享 raw guard 在 clone/sync/async/concurrent 中零 trap 拒绝 root 与 nested Proxy', async () => {
  const input: WorkflowLockConstructionInput = {
    schemaVersion: 2,
    workflowVersion: '0.3.0',
    authorityCatalogId: 'omnai.stage-authority.v1',
    authorityCatalogSchemaVersion: 1,
    authorityCatalogHash: hash('c'),
    resourceBundleHash: hash('b'),
  };

  const transparentRoot = new Proxy(structuredClone(input), {});
  const transparentNested = structuredClone(preparedManifest);
  Object.defineProperty(transparentNested, 'prompt', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: new Proxy(structuredClone(transparentNested.prompt), {}),
  });
  assert.equal(workflowLockSchema.safeParse(transparentRoot).success, false);
  assert.equal(workflowLockSchema.clone().safeParse(transparentRoot).success, false);
  assert.equal(stageRunManifestSchema.safeParse(transparentNested).success, false);

  const probes = Array.from({ length: 8 }, (_, index) => {
    let traps = 0;
    const target = index % 2 === 0 ? structuredClone(input) : { value: hash('c') };
    const proxy = new Proxy(target, {
      getPrototypeOf() { traps += 1; throw new Error('HOSTILE_RAW_PROXY_PROTOTYPE'); },
      ownKeys() { traps += 1; throw new Error('HOSTILE_RAW_PROXY_KEYS'); },
      getOwnPropertyDescriptor() { traps += 1; throw new Error('HOSTILE_RAW_PROXY_DESCRIPTOR'); },
      get() { traps += 1; throw new Error('HOSTILE_RAW_PROXY_GET'); },
    });
    const value = index % 2 === 0 ? proxy : { ...structuredClone(input), authorityCatalogHash: proxy };
    return { value, traps: () => traps };
  });
  assert.equal(workflowLockSchema.safeParse(probes[0]!.value).success, false);
  assert.equal((await workflowLockSchema.safeParseAsync(probes[1]!.value)).success, false);
  const settled = await Promise.allSettled(probes.slice(2).map(({ value }) => (
    workflowLockSchema.clone().parseAsync(value)
  )));
  assert.equal(settled.every(({ status }) => status === 'rejected'), true);
  assert.equal(probes.every(({ traps }) => traps() === 0), true);

  const revoked = Proxy.revocable(structuredClone(input), {});
  revoked.revoke();
  assert.equal(workflowLockSchema.safeParse(revoked.proxy).success, false);
});

// 背景：final registries 既是公开 runtime 值，又被多个 schema/compiler 作为 enum 真值；caller
// pop/splice/set/defineProperty 会污染后续 parse。目的：逐一覆盖 Plan01 保留的 domain registry，
// 四种 mutation 都必须失败，之后重复及并发 parse 仍使用原始成员与顺序。上下文：测试在 finally
// 中只为 RED 基线恢复尚未冻结的旧数组，避免一次预期失败污染同进程其他权限 oracle。
test('全部 domain runtime registry 隔离冻结且 mutation 不污染重复并发 parse', async () => {
  const registries: ReadonlyArray<readonly string[]> = [
    CHANGE_STATUSES, READINESS_STATUSES, TASK_STATUSES, RECONCILE_LEVELS, RISK_LEVELS,
    RISK_DIMENSION_LEVELS, WORK_MODES, CAPABILITIES, READINESS_KEYS, SCENARIO_IDS,
    RUN_LIFECYCLE_OWNER_KINDS, SOURCE_REF_KINDS, DECISION_KINDS, DECISION_OWNERS,
    DECISION_STATUSES, DECISION_OPTION_STATUSES, DECISION_AUTHORITIES, FLOW_SCALES,
    FLOW_UNCERTAINTY, FLOW_TOPOLOGIES, ARCHITECTURE_APPLICABILITIES, DELIVERY_SHAPES,
    CAPABILITY_DISPOSITIONS, EVIDENCE_RECORD_TYPES, EVIDENCE_STATUSES, EVIDENCE_PRODUCERS,
    PROJECT_TRANSACTION_KINDS, PROJECT_CONFIG_OPERATION_KINDS, WORKSET_MEMBER_STATUSES,
    WORKSET_OPERATION_KINDS, WORKSET_TARGET_OPERATION_KINDS, REENTRY_KINDS,
  ];
  for (const registry of registries) assertRegistryMutationClosed(registry);

  const valid: WorkflowLockConstructionInput = {
    schemaVersion: 2,
    workflowVersion: '0.3.0',
    authorityCatalogId: 'omnai.stage-authority.v1',
    authorityCatalogSchemaVersion: 1,
    authorityCatalogHash: hash('c'),
    resourceBundleHash: hash('b'),
  };
  const results = await Promise.all(Array.from({ length: 12 }, () => workflowLockSchema.parseAsync(valid)));
  assert.equal(results.every((result) => result.workflowVersion === '0.3.0'), true);
  assert.equal(CAPABILITIES.length, 24);
});

test('StrictJson depth budget rejects overdeep objects and arrays', () => {
  let deepObject: StrictJsonValue = null;
  let deepArray: StrictJsonValue = null;
  for (let depth = 0; depth < 20_000; depth += 1) {
    deepObject = { child: deepObject };
    deepArray = [deepArray];
  }
  const results: Array<ReturnType<typeof strictJsonValueSchema.safeParse>> = [];
  assert.doesNotThrow(() => {
    results.push(strictJsonValueSchema.safeParse(deepObject));
    results.push(strictJsonValueSchema.safeParse(deepArray));
  });
  assert.deepEqual(results.map((result) => result.success), [false, false]);
});

test('HObject rejects overdeep objects and arrays without leaking RangeError', () => {
  let deepObject: StrictJsonValue = null;
  let deepArray: StrictJsonValue = null;
  for (let depth = 0; depth < 20_000; depth += 1) {
    deepObject = { child: deepObject };
    deepArray = [deepArray];
  }
  const errors = [deepObject, deepArray].map((value) => {
    try {
      productionHObject(value);
      return null;
    } catch (error) {
      return error;
    }
  });
  assert.equal(errors.length, 2);
  for (const error of errors) {
    if (!(error instanceof TypeError) || error instanceof RangeError) {
      assert.fail(`expected native TypeError, received ${error instanceof Error ? error.name : typeof error}`);
    }
    assert.match(error.message, /NATIVE_SCHEMA_MISMATCH/);
  }
});

test('StrictJson preserves near-budget canonical hashing and rejects oversized graphs', () => {
  let nearBudget: StrictJsonValue = null;
  for (let depth = 0; depth < 500; depth += 1) nearBudget = { child: nearBudget };
  assert.equal(strictJsonValueSchema.safeParse(nearBudget).success, true);
  let nearBudgetHash: string | undefined;
  assert.doesNotThrow(() => {
    nearBudgetHash = productionHObject(nearBudget);
  });
  assert.match(nearBudgetHash!, /^sha256:[0-9a-f]{64}$/);

  const oversizedGraph = Array.from({ length: 150_000 }, (_, index) => index);
  let oversizedResult: ReturnType<typeof strictJsonValueSchema.safeParse> | undefined;
  assert.doesNotThrow(() => {
    oversizedResult = strictJsonValueSchema.safeParse(oversizedGraph);
  });
  assert.equal(oversizedResult?.success, false);
});

test('StageRun manifest rejects overdeep render inputs before adjacent hashing', () => {
  const terminal: RunAuthorityContractConstructionInput['terminal'] = {
    kind: 'ARTIFACT_STAGE', readinessKey: 'spec', requiredOutputRoles: ['SPEC'],
  };
  const authorityContract: RunAuthorityContractConstructionInput = {
    schemaVersion: 3,
    changeId: 'CHG-0001',
    runId: 'RUN-000001',
    capability: 'spec',
    revision: 'REV-0001',
    preparedFromAuthorityHead: hash('h'),
    prepareOwner: {
      sequence: 2,
      owner: { kind: 'STAGE_PREPARE', id: 'RUN-000001' },
      operationRequestId: 'prepare-1',
      requestDigest: hash('r'),
    },
    authoredOutputBindings: [{
      kind: 'AUTHORED_FILE',
      role: 'SPEC',
      path: 'spec.md',
      scaffoldBinding: {
        templateId: 'spec-template-v1',
        templateHash: hash('template'),
        renderInputs: { title: 'Bounded input' },
        renderedScaffoldHash: hash('scaffold'),
      },
    }],
    allowedDescendants: [],
    terminal,
    terminalHash: hObject(terminal),
  };
  const manifest: StageRunManifestConstructionInput = {
    schemaVersion: 3,
    workflowVersion: '0.3.0',
    authorityCatalogHash: hash('a'),
    runId: 'RUN-000001',
    changeId: 'CHG-0001',
    revision: 'REV-0001',
    capability: 'spec',
    preparedAt: timestamp,
    prepareOwner: {
      sequence: 2,
      owner: { kind: 'STAGE_PREPARE', id: 'RUN-000001' },
      operationRequestId: 'prepare-1',
      requestDigest: hash('r'),
    },
    prompt: {
      path: 'runs/RUN-000001/prompt.md',
      rendererId: 'prompt-render-v1',
      rendererHash: hash('r'),
      rawBytesHash: hash('b'),
      instructionHash: hash('i'),
      contextBindingsHash: hash('c'),
      protocolBindings: [
        { id: 'common', version: 1, relativePath: 'resources/protocols/common.md', rawBytesHash: hash('1') },
        { id: 'spec', version: 1, relativePath: 'resources/protocols/repository/spec.md', rawBytesHash: hash('2') },
      ],
      protocolBindingsHash: hObject([
        { id: 'common', version: 1, relativePath: 'resources/protocols/common.md', rawBytesHash: hash('1') },
        { id: 'spec', version: 1, relativePath: 'resources/protocols/repository/spec.md', rawBytesHash: hash('2') },
      ]),
      renderInputHash: hash('n'),
    },
    authorityContract,
    authorityContractHash: hObject(authorityContract),
    disposition: 'PREPARED',
  };
  assert.equal(stageRunManifestSchema.safeParse(manifest).success, true);

  const overdeepManifest = structuredClone(manifest);
  const binding = overdeepManifest.authorityContract.authoredOutputBindings[0]!;
  if (binding.kind !== 'AUTHORED_FILE' || binding.scaffoldBinding === null) assert.fail('canonical fixture must carry a scaffold binding');
  let overdeepRenderInputs: StrictJsonValue = null;
  for (let depth = 0; depth < 20_000; depth += 1) overdeepRenderInputs = { child: overdeepRenderInputs };
  binding.scaffoldBinding.renderInputs = overdeepRenderInputs;
  let result: ReturnType<typeof stageRunManifestSchema.safeParse> | undefined;
  assert.doesNotThrow(() => {
    result = stageRunManifestSchema.safeParse(overdeepManifest);
  });
  assert.equal(result?.success, false);
});

test('ProjectConfig generation zero and later generations have exact operation bindings', () => {
  assert.equal(projectConfigSchema.safeParse({
    schemaVersion: 2,
    project: 'omnai',
    workflowBindingHash: hash('w'),
    activeChange: null,
    authorityGeneration: 0,
    lastProjectOperation: null,
  }).success, true);
  assert.equal(projectConfigSchema.safeParse({
    schemaVersion: 2,
    project: 'omnai',
    workflowBindingHash: hash('w'),
    activeChange: 'CHG-0001',
    authorityGeneration: 0,
    lastProjectOperation: null,
  }).success, false);
});

test('ChangeMetadata materializes exactly 21 readiness keys including simplification', () => {
  const value = changeMetadataFixture({ 'domain.md': 1 });
  assert.equal(changeMetadataSchema.safeParse(value).success, true);
  const { simplification: _simplification, ...withoutSimplification } = readiness;
  assert.equal(changeMetadataSchema.safeParse({ ...value, readiness: withoutSimplification }).success, false);
});

// 背景：Zod record 会特别跳过 own `__proto__`，因此合法 artifact version 被静默
// 删除，非法负值也根本未进入 value schema，导致 authenticated input 与持久输出
// HObject 分裂。目的：唯一动态 record 使用项目自有 descriptor-safe validator，
// 合法 `__proto__` 作为 own data key 保留，非法值按原 path 拒绝。上下文：这不是
// key blacklist；输出语义与 authenticated input 必须完全相同。
test('ChangeMetadata artifactVersions 保留合法 own __proto__ 并拒绝非法值', () => {
  const validVersions = Object.create(null) as Record<string, number>;
  Object.defineProperty(validVersions, '__proto__', {
    configurable: true,
    enumerable: true,
    value: 2,
    writable: true,
  });
  Object.defineProperty(validVersions, 'domain.md', {
    configurable: true,
    enumerable: true,
    value: 1,
    writable: true,
  });
  const valid = changeMetadataSchema.safeParse(changeMetadataFixture(validVersions));

  assert.equal(valid.success, true);
  if (!valid.success) throw new Error('预期合法 artifactVersions 通过');
  assert.equal(Object.getPrototypeOf(valid.data), null);
  assert.equal(Object.getPrototypeOf(valid.data.artifactVersions), null);
  assert.deepEqual(Object.getOwnPropertyDescriptor(valid.data.artifactVersions, '__proto__'), {
    configurable: true,
    enumerable: true,
    value: 2,
    writable: true,
  });
  assert.equal(productionHObject(valid.data.artifactVersions), productionHObject(validVersions));

  const invalidVersions = Object.create(null) as Record<string, number>;
  Object.defineProperty(invalidVersions, '__proto__', {
    configurable: true,
    enumerable: true,
    value: -1,
    writable: true,
  });
  const invalid = changeMetadataSchema.safeParse(changeMetadataFixture(invalidVersions));
  assert.equal(invalid.success, false);
  if (invalid.success) throw new Error('预期非法 artifactVersions 被拒绝');
  assert.deepEqual(invalid.error.issues[0]?.path, ['artifactVersions', '__proto__']);
});

// 背景：Zod strictObject 也会在 unknown-key 收集前跳过 own `__proto__`，使本应
// 拒绝的顶层/嵌套扩展字段变成 success。目的：shared boundary 不默认修复或删字段；
// raw Zod 输出与 authenticated input 不一致时必须 fail-closed。上下文：合法动态
// artifactVersions `__proto__` 由上一测试独立证明，这里只锁定 strict extra 语义。
test('strictObject 拒绝顶层和嵌套的额外 own __proto__', () => {
  const workflow = {
    schemaVersion: 2,
    workflowVersion: '0.3.0',
    authorityCatalogId: 'omnai.stage-authority.v1',
    authorityCatalogSchemaVersion: 1,
    authorityCatalogHash: hash('c'),
    resourceBundleHash: hash('b'),
  };
  Object.defineProperty(workflow, '__proto__', {
    configurable: true,
    enumerable: true,
    value: { admin: true },
    writable: true,
  });
  const nested = structuredClone([artifactSource]);
  Object.defineProperty(nested[0], '__proto__', {
    configurable: true,
    enumerable: true,
    value: { admin: true },
    writable: true,
  });

  assert.equal(workflowLockSchema.safeParse(workflow).success, false);
  assert.equal(sourceRefCollectionSchema.safeParse(nested).success, false);
});

test('SourceRef accepts exactly six locator discriminants and never free-form ref', () => {
  const sources = [
    artifactSource,
    { kind: 'policy', scenarioId: 'small-feature', contentHash: hash('p') },
    { kind: 'evidence', evidenceId: 'EVD-000001', contentHash: hash('e') },
    decisionSource,
    { kind: 'task', taskId: 'TASK-001', contentHash: hash('t') },
    { kind: 'code', path: 'src/index.ts', contentHash: hash('c') },
  ];
  assert.equal(sources.every((source) => sourceRefSchema.safeParse(source).success), true);
  assert.equal(sourceRefSchema.safeParse({ kind: 'artifact', ref: 'domain.md', contentHash: hash('a') }).success, false);
  assert.equal(sourceRefSchema.safeParse({ kind: 'contract', contractKey: 'api.v1', contentHash: hash('a') }).success, false);
});

test('Decision and Flow v2 enforce lifecycle, sorting, and one-to-one bindings', () => {
  assert.equal(decisionRecordSchema.safeParse(openDecision).success, true);
  assert.equal(decisionRecordSchema.safeParse({ ...openDecision, status: 'REJECTED' }).success, false);

  const plan = {
    schemaVersion: 2,
    changeId: 'CHG-0001',
    revision: 'REV-0001',
    baseline: 'BL-0001',
    assessment,
    capabilities: [{
      capability: 'spec', disposition: 'REQUIRED', active: true,
      reason: 'Scenario floor', sourceRefs: [decisionSource],
    }],
    decisionIds: ['DEC-0001'],
    decisionBindings: [{ id: 'DEC-0001', contentHash: hash('d') }],
    inputHash: hash('i'),
    compiledAt: timestamp,
  } as const;
  assert.equal(flowPlanSchema.safeParse(plan).success, true);
  assert.equal(flowPlanSchema.safeParse({ ...plan, decisionBindings: [] }).success, false);
  assert.equal(flowPlanSchema.safeParse({ ...plan, flowHash: hash('f') }).success, false);
});

test('TaskFile v1 is complete, topological, sorted, and default-free', () => {
  const task = {
    id: 'TASK-001', title: 'Define schema', objective: 'Freeze exact fields', status: 'READY',
    dependsOn: [], slice: 'CONTRACT_FIRST', risk: 'HIGH',
    files: { create: ['src/domain/change.ts'], modify: [], tests: ['src/domain/test/native-schemas.test.ts'] },
    consumes: [], produces: ['schema'], steps: ['Write types'], evidenceRequired: ['typecheck'], notes: [],
  } as const;
  assert.equal(taskFileSchema.safeParse({ schemaVersion: 1, revision: 'REV-0001', generatedFrom: ['spec'], tasks: [task] }).success, true);
  assert.equal(taskFileSchema.safeParse({ schemaVersion: 1, revision: 'REV-0001', tasks: [task] }).success, false);
});

test('Evidence, Revision, and Progress retain complete strict v1 shapes', () => {
  const evidenceSubject = { kind: 'CHANGE_AUTHORITY', revision: 'REV-0001', authorityHead: hash('h') } as const;
  const evidence = {
    schemaVersion: 1,
    id: 'EVD-000001',
    changeId: 'CHG-0001',
    revision: 'REV-0001',
    runBinding: null,
    requirementId: null,
    gateId: null,
    taskId: null,
    type: 'manual',
    status: 'PASS',
    producer: 'GENERIC_IMPORT',
    subjectBinding: {
      subject: evidenceSubject,
      subjectHash: hObject(evidenceSubject),
    },
    summary: 'Manual observation passed',
    verificationCommand: null,
    createdAt: timestamp,
    outputFile: null,
  } as const;
  assert.equal(evidenceRecordSchema.safeParse(evidence).success, true);

  assert.equal(revisionSchema.safeParse({
    schemaVersion: 1,
    id: 'REV-0002',
    changeId: 'CHG-0001',
    previousRevision: 'REV-0001',
    previousBaseline: 'BL-0001',
    baseline: 'BL-0002',
    reason: 'Reality changed',
    level: 'L2',
    affectedReadiness: ['spec'],
    affectedTasks: ['TASK-001'],
    operationRequestId: 'reconcile-1',
    createdAt: timestamp,
  }).success, true);

  assert.equal(progressEventSchema.safeParse({
    schemaVersion: 1,
    timestamp,
    event: 'CHANGE_CREATED',
    changeId: 'CHG-0001',
    revision: 'REV-0001',
    operationRequestId: 'create-1',
    runId: null,
    taskId: null,
    data: { metadataHash: hash('m'), flowHash: hash('f'), tasksHash: hash('t') },
  }).success, true);
});

test('Run authority and manifest are strict v3 only', () => {
  assert.equal(runAuthorityContractSchema.safeParse(runAuthority).success, true);
  assert.equal(stageRunManifestSchema.safeParse(preparedManifest).success, true);
});

test('Registry, Workset, and Reentry accept only strict v2 lifecycle states', () => {
  assert.equal(projectRegistrySchema.safeParse({
    schemaVersion: 2,
    projects: [{
      schemaVersion: 1,
      alias: 'core',
      name: 'Core',
      repositoryPath: '/repo/core',
      repositoryIdentityHash: hash('r'),
      originProjectAuthorityInstanceHash: hash('o'),
      objectFormat: 'sha1',
      registeredAt: timestamp,
    }],
  }).success, true);

  assert.equal(worksetSchema.safeParse({
    schemaVersion: 2,
    id: 'WKS-0001',
    slug: 'native-schema',
    title: 'Native Schema',
    status: 'OPEN',
    authorityGeneration: 1,
    lastOperation: {
      operationId: 'WOP-000001', operationRequestId: 'create-workset-1',
      requestDigest: hash('w'), kind: 'CREATE_WORKSET',
    },
    members: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  }).success, true);

  assert.equal(worksetReentrySchema.safeParse({
    schemaVersion: 2,
    id: 'WRE-0001',
    worksetId: 'WKS-0001',
    kind: 'REALITY_CHANGED',
    reason: 'Production behavior changed',
    route: { capability: 'research', interaction: 'grill', reason: 'Revalidate reality' },
    affectedProjects: ['core'],
    candidateProjects: [],
    status: 'PENDING',
    proposal: [],
    applications: [],
    rulesVersion: null,
    createdAt: timestamp,
    decidedAt: null,
    resolvedAt: null,
  }).success, true);
});

test('复合 parser 保留品牌标量输出，构造输入仍接受规范 JSON 字符串', () => {
  const aliasInput: string = '7-core';
  const alias: ProjectAlias = projectAliasSchema.parse(aliasInput);
  const registered = registeredProjectSchema.parse({
    schemaVersion: 1,
    alias: aliasInput,
    name: 'Core',
    repositoryPath: '/repo/core',
    repositoryIdentityHash: hash('repository'),
    originProjectAuthorityInstanceHash: hash('project'),
    objectFormat: 'sha1',
    registeredAt: timestamp,
  });
  const compositeAlias: ProjectAlias = registered.alias;
  assert.equal(alias, aliasInput);
  assert.equal(compositeAlias, aliasInput);
});

test('StrictJson 在读取属性前拒绝非普通对象、访问器、symbol、数组空洞和孤立代理项键', () => {
  let getterRead = false;
  const accessor = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(accessor, 'secret', {
    enumerable: true,
    get() {
      getterRead = true;
      throw new Error('不得读取访问器');
    },
  });
  const customPrototype = Object.create({ inherited: true }) as Record<string, unknown>;
  customPrototype.value = 1;
  const symbolObject = { value: 1 } as Record<string | symbol, unknown>;
  symbolObject[Symbol('hidden')] = 2;
  const sparse = [1, , 3];
  const surrogateKey = { ['bad\ud800']: 1 };

  assert.equal(strictJsonValueSchema.safeParse(customPrototype).success, false);
  assert.equal(strictJsonValueSchema.safeParse(accessor).success, false);
  assert.equal(getterRead, false);
  assert.equal(strictJsonValueSchema.safeParse(symbolObject).success, false);
  assert.equal(strictJsonValueSchema.safeParse(sparse).success, false);
  assert.equal(strictJsonValueSchema.safeParse(surrogateKey).success, false);
});

// 背景：认证层即使拒绝了输入空洞，如果用普通赋值构造数组，仍可触发
// Array.prototype 上的 numeric accessor；而把原数组交给 Zod 又会重新读取攻击者图。
// 目的：证明 guard pipeline 交给 Zod 的是具有 own dense index 的认证克隆，整段 parse
// 既不读也不写继承 numeric accessor。上下文：finally 在任何断言之前恢复全局原型。
test('StrictJson guard 交给 Zod 的 dense array 不观察继承 numeric accessor', () => {
  const input = [1];
  const originalDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, '0');
  let getterReads = 0;
  let setterWrites = 0;
  let parsed: StrictJsonValue | undefined;
  Object.defineProperty(Array.prototype, '0', {
    configurable: true,
    get() {
      getterReads += 1;
      return 999;
    },
    set(_value: unknown) {
      setterWrites += 1;
    },
  });
  try {
    parsed = strictJsonValueSchema.parse(input);
  } finally {
    if (originalDescriptor === undefined) {
      Reflect.deleteProperty(Array.prototype, '0');
    } else {
      Object.defineProperty(Array.prototype, '0', originalDescriptor);
    }
  }

  assert.equal(getterReads, 0);
  assert.equal(setterWrites, 0);
  assert.equal(Array.isArray(parsed), true);
  if (!Array.isArray(parsed)) throw new Error('预期认证结果为 dense array');
  assert.equal(Object.hasOwn(parsed, '0'), true);
  assert.equal(parsed[0], 1);
});

test('FrozenByteBlob 只接受 canonical Base64、真实长度、32 MiB 上限和 HBytes', () => {
  const hello = Buffer.from('hello');
  const canonical = {
    encoding: 'BASE64',
    byteLength: hello.byteLength,
    rawBytesBase64: hello.toString('base64'),
    rawBytesHash: hBytes(hello),
  } as const;
  assert.equal(frozenByteBlobSchema.safeParse(canonical).success, true);
  assert.equal(frozenByteBlobSchema.safeParse({ ...canonical, rawBytesBase64: 'aGVsbG8' }).success, false);
  assert.equal(frozenByteBlobSchema.safeParse({ ...canonical, byteLength: 999 }).success, false);
  assert.equal(frozenByteBlobSchema.safeParse({ ...canonical, rawBytesHash: hash('wrong') }).success, false);

  const oversized = Buffer.alloc(32 * 1024 * 1024 + 1);
  assert.equal(frozenByteBlobSchema.safeParse({
    encoding: 'BASE64',
    byteLength: oversized.byteLength,
    rawBytesBase64: oversized.toString('base64'),
    rawBytesHash: hBytes(oversized),
  }).success, false);
});

test('路径品牌拒绝 drive、UNC、超字节目录和不规范 Workset 分支', () => {
  assert.equal(repositoryCodePathSchema.safeParse('C:/repo/file.ts').success, false);
  assert.equal(repositoryCodePathSchema.safeParse('//server/share/file.ts').success, false);
  assert.equal(changeArtifactDirectorySchema.safeParse(`${Array(5).fill('界'.repeat(68)).join('/')}/`).success, false);
  assert.equal(strictWorksetBranchSchema.safeParse('omnai/WKS-0000-schema').success, false);
  assert.equal(strictWorksetBranchSchema.safeParse('omnai/WKS-0001-native--schema').success, false);
  assert.equal(strictWorksetBranchSchema.safeParse('omnai/WKS-0001-native-schema').success, true);
  assert.equal(registeredProjectSchema.safeParse({
    schemaVersion: 1,
    alias: 'core',
    name: 'Core',
    repositoryPath: 'repo/core',
    repositoryIdentityHash: hash('repository'),
    originProjectAuthorityInstanceHash: hash('project'),
    objectFormat: 'sha1',
    registeredAt: timestamp,
  }).success, false);
});

test('ProjectConfig 的 generation 0 与后续状态都是全绑定或全为空', () => {
  const base = {
    schemaVersion: 2,
    project: 'omnai',
    workflowBindingHash: hash('workflow'),
  } as const;
  assert.equal(projectConfigSchema.safeParse({
    ...base,
    activeChange: null,
    authorityGeneration: 1,
    lastProjectOperation: {
      transactionId: 'PROJECT-000001',
      operationRequestId: 'select-1',
      requestDigest: hash('request'),
      kind: 'SELECT_CHANGE',
    },
  }).success, false);
  assert.equal(projectConfigSchema.safeParse({
    ...base,
    activeChange: 'CHG-0001',
    authorityGeneration: 1,
    lastProjectOperation: null,
  }).success, false);
  assert.equal(projectConfigSchema.safeParse({
    ...base,
    activeChange: 'CHG-0001',
    authorityGeneration: 1,
    lastProjectOperation: {
      transactionId: 'PROJECT-000001',
      operationRequestId: 'select-1',
      requestDigest: hash('request'),
      kind: 'SELECT_CHANGE',
    },
  }).success, true);
});

test('Workset 精确闭合 BIND_CHANGE、generation 和 Registry 身份不变量', () => {
  const researchBound = {
    projectAlias: 'core',
    status: 'RESEARCH_ONLY',
    changeBinding: {
      changeId: 'CHG-0001',
      repositoryIdentityHash: hash('repository'),
      projectAuthorityInstanceHash: hash('project'),
      boundAuthorityHead: hash('head'),
      boundRevision: 'REV-0001',
    },
    workspace: null,
    addedAt: timestamp,
    updatedAt: laterTimestamp,
  } as const;
  assert.equal(worksetMemberSchema.safeParse(researchBound).success, true);

  const generationOne = {
    schemaVersion: 2,
    id: 'WKS-0001',
    slug: 'native-schema',
    title: 'Native Schema',
    status: 'OPEN',
    authorityGeneration: 1,
    lastOperation: { operationId: 'WOP-000001', operationRequestId: 'create-1', requestDigest: hash('create'), kind: 'CREATE_WORKSET' },
    members: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  } as const;
  assert.equal(worksetSchema.safeParse({ ...generationOne, members: [researchBound] }).success, false);
  assert.equal(worksetSchema.safeParse({ ...generationOne, updatedAt: laterTimestamp }).success, false);
  assert.equal(worksetSchema.safeParse({ ...generationOne, authorityGeneration: 2 }).success, false);
  assert.equal(worksetSchema.safeParse({
    ...generationOne,
    authorityGeneration: 2,
    lastOperation: { ...generationOne.lastOperation, kind: 'REGISTER_PROJECT' },
    updatedAt: laterTimestamp,
  }).success, false);

  const registered = {
    schemaVersion: 1,
    name: 'Core',
    repositoryPath: '/repo/core',
    objectFormat: 'sha1',
    registeredAt: timestamp,
  } as const;
  assert.equal(projectRegistrySchema.safeParse({
    schemaVersion: 2,
    projects: [
      { ...registered, alias: 'api', repositoryIdentityHash: hash('api'), originProjectAuthorityInstanceHash: hash('origin') },
      { ...registered, alias: 'core', repositoryPath: '/repo/core-2', repositoryIdentityHash: hash('core'), originProjectAuthorityInstanceHash: hash('origin') },
    ],
  }).success, false);
});

test('Reentry 决策后 proposal/application 覆盖 affected∪candidate 且状态与历史完整', () => {
  const base = {
    schemaVersion: 2,
    id: 'WRE-0001',
    worksetId: 'WKS-0001',
    kind: 'REALITY_CHANGED',
    reason: 'Reality changed',
    route: { capability: 'research', interaction: 'grill', reason: 'Revalidate reality' },
    affectedProjects: ['api'],
    candidateProjects: ['core'],
    rulesVersion: 1,
    createdAt: timestamp,
    decidedAt: laterTimestamp,
  } as const;
  const proposal = [
    { projectAlias: 'api', outcome: 'NOT_REQUIRED' },
    { projectAlias: 'core', outcome: 'NOT_REQUIRED' },
  ] as const;
  const applications = [
    { projectAlias: 'api', outcome: 'NOT_REQUIRED', changeId: null, status: 'NOT_REQUIRED', attemptHistory: [] },
    { projectAlias: 'core', outcome: 'NOT_REQUIRED', changeId: null, status: 'NOT_REQUIRED', attemptHistory: [] },
  ] as const;
  assert.equal(worksetReentrySchema.safeParse({
    ...base,
    status: 'PENDING',
    proposal: [proposal[0]],
    applications: [],
    rulesVersion: null,
    decidedAt: null,
    resolvedAt: null,
  }).success, false);
  assert.equal(worksetReentrySchema.safeParse({
    ...base,
    status: 'RESOLVED',
    proposal,
    applications,
    resolvedAt: laterTimestamp,
  }).success, true);
  assert.equal(worksetReentrySchema.safeParse({
    ...base,
    status: 'RESOLVED',
    proposal: [],
    applications: [],
    resolvedAt: laterTimestamp,
  }).success, false);
  assert.equal(worksetReentrySchema.safeParse({
    ...base,
    status: 'RESOLVED',
    proposal,
    applications: [{ ...applications[0], attemptHistory: [{
      status: 'FAILED', failureKind: 'APPLY_ERROR', level: 'L1', reopenFrom: 'spec', readinessClosure: ['spec'],
      taskRoots: [], taskClosure: [], fromRevision: 'REV-0001', fromBaseline: 'BL-0001',
      toRevision: null, toBaseline: 'BL-0002', errorCode: 'APPLY_ERROR', errorMessageHash: hash('error'),
      appliedAt: null, replannedAt: laterTimestamp,
    }] }, applications[1]],
    resolvedAt: laterTimestamp,
  }).success, false);
});

test('ScenarioProfile 的 required/optional/route/stages 是精确集合与子序列', () => {
  const profile = scenarioFixture();
  const parsed: ScenarioProfile = scenarioProfileSchema.parse(profile);
  assert.deepEqual(parsed.routeOrder, ['frame', 'spec', 'experiment', 'plan', 'work']);
  assert.equal(scenarioProfileSchema.safeParse({ ...profile, optionalStages: ['experiment', 'spec'] }).success, false);
  assert.equal(scenarioProfileSchema.safeParse({ ...profile, routeOrder: ['frame', 'spec', 'plan', 'work'] }).success, false);
  assert.equal(scenarioProfileSchema.safeParse({ ...profile, routeOrder: ['spec', 'frame', 'experiment', 'plan', 'work'] }).success, false);
});

test('Decision supersede 以 locator 去重并清除旧 resolution', () => {
  const duplicateLocator = {
    ...openDecision,
    sourceRefs: [
      artifactSource,
      { ...artifactSource, contentHash: hash('new-content') },
    ],
  } as const;
  assert.equal(decisionRecordSchema.safeParse(duplicateLocator).success, false);
  assert.equal(decisionRecordSchema.safeParse({
    ...openDecision,
    status: 'SUPERSEDED',
    resolvedRevision: 'REV-0002',
    supersededBy: 'DEC-0002',
    resolution: { optionId: null, summary: 'Old resolution', authority: 'HUMAN_CONFIRMED', sourceRefs: [] },
  }).success, false);
});

test('Run v3 交叉绑定 capability、owner、terminal、时间和相邻哈希', () => {
  assert.equal(runAuthorityContractSchema.safeParse({ ...runAuthority, capability: 'plan' }).success, false);
  assert.equal(runAuthorityContractSchema.safeParse({ ...runAuthority, prepareOwner: { ...runOwner, owner: { kind: 'STAGE_PREPARE', id: 'RUN-000002' } } }).success, false);
  assert.equal(runAuthorityContractSchema.safeParse({ ...runAuthority, terminalHash: hash('wrong') }).success, false);
  assert.equal(stageRunManifestSchema.safeParse({ ...preparedManifest, prepareOwner: { ...runOwner, sequence: 3 } }).success, false);

  const terminalResult = {
    kind: 'ARTIFACT_STAGE',
    terminalHash: runAuthority.terminalHash,
    descendantEntryHashes: [],
    descendantEntryHashesHash: hObject([]),
    satisfaction: { evidence: [], gates: [] },
    satisfactionHash: hObject({ evidence: [], gates: [] }),
    outputObservations: [],
    outputObservationsHash: hObject([]),
  } as const;
  const completed = {
    ...preparedManifest,
    disposition: 'COMPLETED',
    completedAt: laterTimestamp,
    completionOwner: { ...runOwner, sequence: 3, owner: { kind: 'STAGE_COMPLETE', id: 'RUN-000001' } },
    terminalResult,
    terminalResultHash: hObject(terminalResult),
  } as const;
  assert.equal(stageRunManifestSchema.safeParse(completed).success, true);
  assert.equal(stageRunManifestSchema.safeParse({ ...completed, completedAt: '2026-08-23T01:02:02.004Z' }).success, false);
  assert.equal(stageRunManifestSchema.safeParse({
    ...completed,
    terminalResult: {
      ...terminalResult,
      kind: 'PLAN_STAGE',
      draftRawBytesHash: hash('draft'),
      sourceTasksHash: hash('source-tasks'),
      targetTasksHash: hash('target-tasks'),
    },
  }).success, false);

  const ordinalHashes = [hash('z'), hash('a')];
  assert.equal(stageTerminalResultSchema.safeParse({
    ...terminalResult,
    descendantEntryHashes: ordinalHashes,
    descendantEntryHashesHash: hObject(ordinalHashes),
  }).success, true);
  assert.equal(stageTerminalResultSchema.safeParse({
    ...terminalResult,
    descendantEntryHashes: ordinalHashes,
    descendantEntryHashesHash: hash('wrong'),
  }).success, false);
});

test('Run v3 重算仓库结果、Review 保留契约和目录输出的全部局部闭包', () => {
  const basis = {
    objectFormat: 'sha1',
    headCommit: '1'.repeat(40),
    indexTreeHash: '2'.repeat(40),
    workingPatchHash: hash('patch'),
    eligibleUntrackedInventoryHash: hash('untracked'),
  } as const;
  const changedBasis = { ...basis, workingPatchHash: hash('changed') };
  const resultPreimage = { prepared: basis, completed: changedBasis, changedPaths: ['src/a.ts'] } as const;
  const repositoryResult = { ...resultPreimage, resultHash: hObject(resultPreimage) } as const;
  assert.equal(repositoryWorkResultSchema.safeParse(repositoryResult).success, true);
  assert.equal(repositoryWorkResultSchema.safeParse({ ...repositoryResult, resultHash: hash('wrong') }).success, false);
  assert.equal(repositoryRunLineageSchema.safeParse({
    kind: 'RETRY',
    rootRunId: 'RUN-000001',
    retryOfRunId: 'RUN-000002',
    rootPreparedBasis: basis,
    rootPreparedBasisHash: hash('wrong'),
    retryStartBasis: changedBasis,
    retryStartBasisHash: hObject(changedBasis),
    retryStartResult: repositoryResult,
  }).success, false);

  const reviewRequirement = {
    requirementId: 'repository-review',
    producer: 'REVIEW_RESULT_IMPORT',
    allowedTypes: ['review'],
    allowedStatuses: ['FAIL', 'INCONCLUSIVE', 'PASS'],
    satisfyingStatus: 'PASS',
    outputPolicy: 'OWNED_OUTPUT_REQUIRED',
    sourceScope: 'RUN_BOUND',
    subjectPolicy: 'EXACT_RUN_SUBJECT',
    taskScope: { kind: 'NONE' },
    minimumRecords: 1,
  } as const;
  const reviewScope = { kind: 'CHANGE', sourceAuthorityHead: hash('h'), repositoryWorkHash: hObject(basis) } as const;
  const reviewPolicy = { schemaVersion: 1, specification: [], standards: [], riskProduction: [] } as const;
  const reviewTerminal = {
    kind: 'REVIEW_STAGE',
    evidenceRequirements: [reviewRequirement],
    evidenceRequirementsHash: hObject([reviewRequirement]),
    reviewedBasis: basis,
    reviewScope,
    reviewScopeHash: hObject(reviewScope),
    reviewPolicy,
    reviewPolicyHash: hObject(reviewPolicy),
    requiredHumanGates: [],
  } as const;
  const reviewDescendant = {
    kind: 'COUNTED', ownerKind: 'EVIDENCE_REVIEW_IMPORT',
    binding: { kind: 'EVIDENCE_REQUIREMENT', requirementId: 'repository-review', taskId: null },
    minimum: 1, maximum: 1,
  } as const;
  const reviewAuthority = {
    ...runAuthority,
    capability: 'review',
    authoredOutputBindings: [{
      kind: 'REVIEW_DRAFT', role: 'REVIEW_DRAFT',
      path: 'stage-outputs/RUN-000001/review.draft.json',
      schemaIdentity: 'omnai.review-draft.v2',
    }],
    allowedDescendants: [reviewDescendant],
    terminal: reviewTerminal,
    terminalHash: hObject(reviewTerminal),
  } as const;
  assert.equal(runAuthorityContractSchema.safeParse(reviewAuthority).success, true);
  const wrongReviewScope = { ...reviewScope, repositoryWorkHash: hash('wrong') };
  const wrongReviewTerminal = { ...reviewTerminal, reviewScope: wrongReviewScope, reviewScopeHash: hObject(wrongReviewScope) };
  assert.equal(runAuthorityContractSchema.safeParse({
    ...reviewAuthority,
    terminal: wrongReviewTerminal,
    terminalHash: hObject(wrongReviewTerminal),
  }).success, false);

  const requiredHumanGates = [
    { gateId: 'gate-a', sourceScope: 'RUN_BOUND', approvedArtifactRole: null },
    { gateId: 'gate-b', sourceScope: 'RUN_BOUND', approvedArtifactRole: null },
  ] as const;
  const gatedTerminal = { ...reviewTerminal, requiredHumanGates } as const;
  const gatedAuthority = {
    ...reviewAuthority,
    allowedDescendants: [
      reviewDescendant,
      { kind: 'COUNTED', ownerKind: 'HUMAN_APPROVAL', binding: { kind: 'HUMAN_GATE', gateId: 'gate-a' }, minimum: 1, maximum: 1 },
      { kind: 'COUNTED', ownerKind: 'HUMAN_APPROVAL', binding: { kind: 'HUMAN_GATE', gateId: 'gate-b' }, minimum: 1, maximum: 1 },
    ],
    terminal: gatedTerminal,
    terminalHash: hObject(gatedTerminal),
  } as const;
  const gatedSatisfaction = {
    evidence: [{ requirementId: 'repository-review', taskId: null, evidenceIds: ['EVD-000001'] }],
    gates: [
      { gateId: 'gate-a', evidenceId: 'EVD-000002' },
      { gateId: 'gate-b', evidenceId: 'EVD-000003' },
    ],
  } as const;
  const gatedResult = {
    kind: 'REVIEW_STAGE',
    terminalHash: gatedAuthority.terminalHash,
    descendantEntryHashes: [hash('a'), hash('m'), hash('z')],
    descendantEntryHashesHash: hObject([hash('a'), hash('m'), hash('z')]),
    satisfaction: gatedSatisfaction,
    satisfactionHash: hObject(gatedSatisfaction),
    outputObservations: [{
      kind: 'FILE', role: 'REVIEW_DRAFT', path: 'stage-outputs/RUN-000001/review.draft.json', rawBytesHash: hash('review-draft'),
    }],
    outputObservationsHash: hObject([{
      kind: 'FILE', role: 'REVIEW_DRAFT', path: 'stage-outputs/RUN-000001/review.draft.json', rawBytesHash: hash('review-draft'),
    }]),
    reviewedBasisHash: hObject(basis),
    aggregateEvidenceId: 'EVD-000001',
    aggregateEvidenceRecordHash: hash('review-evidence'),
  } as const;
  const gatedCompleted = {
    ...preparedManifest,
    capability: 'review',
    authorityContract: gatedAuthority,
    authorityContractHash: hObject(gatedAuthority),
    disposition: 'COMPLETED',
    completedAt: laterTimestamp,
    completionOwner: { ...runOwner, sequence: 3, owner: { kind: 'STAGE_COMPLETE', id: 'RUN-000001' } },
    terminalResult: gatedResult,
    terminalResultHash: hObject(gatedResult),
  } as const;
  assert.equal(stageRunManifestSchema.safeParse(gatedCompleted).success, true);
  const crossReusedSatisfaction = {
    ...gatedSatisfaction,
    gates: [{ gateId: 'gate-a', evidenceId: 'EVD-000001' }, gatedSatisfaction.gates[1]],
  } as const;
  const crossReusedResult = {
    ...gatedResult,
    satisfaction: crossReusedSatisfaction,
    satisfactionHash: hObject(crossReusedSatisfaction),
  } as const;
  assert.equal(stageTerminalResultSchema.safeParse(crossReusedResult).success, false);
  assert.equal(stageRunManifestSchema.safeParse({
    ...gatedCompleted,
    terminalResult: crossReusedResult,
    terminalResultHash: hObject(crossReusedResult),
  }).success, false);
  const gateReusedSatisfaction = {
    ...gatedSatisfaction,
    gates: [gatedSatisfaction.gates[0], { gateId: 'gate-b', evidenceId: 'EVD-000002' }],
  } as const;
  const gateReusedResult = {
    ...gatedResult,
    satisfaction: gateReusedSatisfaction,
    satisfactionHash: hObject(gateReusedSatisfaction),
  } as const;
  assert.equal(stageTerminalResultSchema.safeParse(gateReusedResult).success, false);
  assert.equal(stageRunManifestSchema.safeParse({
    ...gatedCompleted,
    terminalResult: gateReusedResult,
    terminalResultHash: hObject(gateReusedResult),
  }).success, false);
  const extraResult = { ...reviewRequirement, requirementId: 'qa-result', producer: 'QA_RESULT_IMPORT', allowedTypes: ['qa'] } as const;
  const extraTerminal = {
    ...reviewTerminal,
    evidenceRequirements: [extraResult, reviewRequirement],
    evidenceRequirementsHash: hObject([extraResult, reviewRequirement]),
  } as const;
  assert.equal(runAuthorityContractSchema.safeParse({
    ...reviewAuthority,
    allowedDescendants: [{ ...reviewDescendant, ownerKind: 'EVIDENCE_QA_IMPORT', binding: { ...reviewDescendant.binding, requirementId: 'qa-result' } }, reviewDescendant],
    terminal: extraTerminal,
    terminalHash: hObject(extraTerminal),
  }).success, false);

  const directoryTerminal = { kind: 'ARTIFACT_STAGE', readinessKey: 'spec', requiredOutputRoles: ['SPEC_TREE'] } as const;
  const directoryAuthority = {
    ...runAuthority,
    authoredOutputBindings: [{ kind: 'AUTHORED_DIRECTORY', role: 'SPEC_TREE', path: 'specs/', minimumRegularFiles: 1 }],
    terminal: directoryTerminal,
    terminalHash: hObject(directoryTerminal),
  } as const;
  const directoryObservation = { kind: 'DIRECTORY', role: 'SPEC_TREE', path: 'specs', regularFileCount: 0, regularFiles: [], regularFilesTreeHash: hObject([]) } as const;
  const directoryResult = {
    kind: 'ARTIFACT_STAGE', terminalHash: directoryAuthority.terminalHash,
    descendantEntryHashes: [], descendantEntryHashesHash: hObject([]),
    satisfaction: { evidence: [], gates: [] }, satisfactionHash: hObject({ evidence: [], gates: [] }),
    outputObservations: [directoryObservation], outputObservationsHash: hObject([directoryObservation]),
  } as const;
  assert.equal(stageRunManifestSchema.safeParse({
    ...preparedManifest,
    authorityContract: directoryAuthority,
    authorityContractHash: hObject(directoryAuthority),
    disposition: 'COMPLETED', completedAt: laterTimestamp,
    completionOwner: { ...runOwner, sequence: 3, owner: { kind: 'STAGE_COMPLETE', id: 'RUN-000001' } },
    terminalResult: directoryResult,
    terminalResultHash: hObject(directoryResult),
  }).success, false);
});

test('Evidence producer 固定矩阵闭合 gate、requirement、Run 与 subject', () => {
  const subject = {
    kind: 'REPOSITORY_BASIS',
    revision: 'REV-0001',
    basis: {
      objectFormat: 'sha1',
      headCommit: '1'.repeat(40),
      indexTreeHash: '2'.repeat(40),
      workingPatchHash: hash('patch'),
      eligibleUntrackedInventoryHash: hash('untracked'),
    },
  } as const;
  const base = {
    schemaVersion: 1,
    id: 'EVD-000001',
    changeId: 'CHG-0001',
    revision: 'REV-0001',
    runBinding: { runId: 'RUN-000001', prepareOwner: runOwner, ordinal: 1 },
    requirementId: 'repository-review',
    gateId: null,
    taskId: null,
    type: 'review',
    status: 'PASS',
    producer: 'REVIEW_RESULT_IMPORT',
    subjectBinding: { subject, subjectHash: hObject(subject) },
    summary: 'Review passed',
    verificationCommand: null,
    createdAt: timestamp,
    outputFile: 'evidence/outputs/EVD-000001/output.bin',
  } as const;
  assert.equal(evidenceRecordSchema.safeParse(base).success, true);
  assert.equal(evidenceRecordSchema.safeParse({ ...base, requirementId: 'qa-result' }).success, false);
  assert.equal(evidenceRecordSchema.safeParse({ ...base, type: 'qa' }).success, false);
  assert.equal(evidenceRecordSchema.safeParse({ ...base, gateId: 'approval' }).success, false);
  assert.equal(evidenceRecordSchema.safeParse({ ...base, runBinding: null }).success, false);
  assert.equal(evidenceRecordSchema.safeParse({ ...base, subjectBinding: { subject: { ...subject, revision: 'REV-0002' }, subjectHash: hObject({ ...subject, revision: 'REV-0002' }) } }).success, false);

  assert.equal(evidenceRecordSchema.safeParse({
    ...base,
    requirementId: null,
    gateId: 'delivery-approval',
    type: 'manual',
    status: 'PASS',
    producer: 'HUMAN_APPROVAL',
    outputFile: null,
  }).success, true);
  assert.equal(evidenceRecordSchema.safeParse({
    ...base,
    requirementId: null,
    gateId: 'delivery-approval',
    type: 'manual',
    status: 'FAIL',
    producer: 'HUMAN_APPROVAL',
    outputFile: null,
  }).success, false);

  assert.equal(evidenceRecordSchema.safeParse({
    ...base,
    producer: 'GENERIC_IMPORT',
    outputFile: null,
  }).success, false);

  const artifactIdentity = {
    schemaVersion: 1,
    workflowVersion: '0.3.0',
    authorityCatalogHash: hash('catalog'),
    changeId: 'CHG-0001',
    revision: 'REV-0001',
    repositoryBasis: subject.basis,
    repositoryBasisHash: hObject(subject.basis),
    delivery: { artifactAuthorityEntryId: 'ship:DELIVERY', role: 'DELIVERY', path: 'delivery.md', rawBytesHash: hash('delivery') },
  } as const;
  const releaseSubject = {
    schemaVersion: 1,
    kind: 'DELIVERY_STAGE_COMPLETION',
    changeId: 'CHG-0001',
    revision: 'REV-0001',
    shipRunId: 'RUN-000002',
    shipCompletion: { sequence: 8, ownerKind: 'STAGE_COMPLETE', ownerId: 'RUN-000002', entryHash: hash('ship-entry'), completedAt: timestamp },
    artifactIdentity,
    artifactIdentityHash: hObject(artifactIdentity),
  } as const;
  const releaseBinding = { subject: releaseSubject, subjectHash: hObject(releaseSubject) } as const;
  const releaseEvidenceSubject = { kind: 'RELEASE_SUBJECT', binding: releaseBinding } as const;
  const canaryMeasurement = {
    ...base,
    requirementId: 'error-rate',
    taskId: null,
    type: 'runtime',
    producer: 'CANARY_MEASUREMENT_IMPORT',
    subjectBinding: { subject: releaseEvidenceSubject, subjectHash: hObject(releaseEvidenceSubject) },
    summary: 'Canary measurement passed',
  } as const;
  assert.equal(evidenceRecordSchema.safeParse(canaryMeasurement).success, true);
  const wrongArtifactIdentity = { ...artifactIdentity, repositoryBasisHash: hash('wrong') };
  const wrongRelease = { ...releaseSubject, artifactIdentity: wrongArtifactIdentity, artifactIdentityHash: hObject(wrongArtifactIdentity) };
  const wrongReleaseSubject = { kind: 'RELEASE_SUBJECT', binding: { subject: wrongRelease, subjectHash: hObject(wrongRelease) } } as const;
  assert.equal(evidenceRecordSchema.safeParse({
    ...canaryMeasurement,
    subjectBinding: { subject: wrongReleaseSubject, subjectHash: hObject(wrongReleaseSubject) },
  }).success, false);
});

function assertRegistryMutationClosed(registry: readonly string[]): void {
  const snapshot = [...registry];
  const restore = (): void => {
    if (!Object.isFrozen(registry)) {
      Reflect.apply(Array.prototype.splice, registry, [0, registry.length, ...snapshot]);
    }
  };
  try {
    assert.throws(() => Reflect.apply(Array.prototype.pop, registry, []));
  } finally {
    restore();
  }
  try {
    assert.throws(() => Reflect.apply(Array.prototype.splice, registry, [0, 1]));
  } finally {
    restore();
  }
  try {
    assert.equal(Reflect.set(registry, '0', '__污染__'), false);
  } finally {
    restore();
  }
  try {
    assert.throws(() => Object.defineProperty(registry, '0', {
      configurable: true,
      enumerable: true,
      value: '__污染__',
      writable: true,
    }));
  } finally {
    restore();
  }
  assert.equal(Object.isFrozen(registry), true);
  assert.deepEqual(registry, snapshot);
}

function scenarioFixture() {
  return {
    schemaVersion: 1,
    id: 'small-feature',
    detectionPriority: 1,
    label: 'Small feature',
    description: 'A bounded feature',
    workMode: 'FEATURE',
    routeOrder: ['frame', 'spec', 'experiment', 'plan', 'work'],
    stages: ['frame', 'spec', 'plan', 'work'],
    optionalStages: ['experiment'],
    requiredArtifacts: [],
    requiredMachineState: ['TASKFILE'],
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
  } as const;
}

function hObject(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(sortJson(value))).digest('hex')}`;
}

function hBytes(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sortJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortJson);
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => [key, sortJson(entry)]));
}
