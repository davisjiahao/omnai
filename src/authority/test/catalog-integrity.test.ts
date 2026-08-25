import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import YAML from 'yaml';
import {
  STAGE_COMPILER_ARTIFACT_IDS,
  WORKSET_PROTOCOL_ACTIONS,
  canonicalStrictJson,
  compareCodeUnits,
  hashStrictObject,
  stageAuthorityCatalogV1Schema,
  type StageAuthorityCatalogV1,
} from '../catalog-schema.js';
import {
  clearInjectedAuthorityCatalogForTest,
  loadInjectedAuthorityCatalogForTest,
  requireVerifiedAuthorityCatalog,
} from '../catalog-loader.js';
import {
  PROTOCOL_ERROR_CODES,
  PROTOCOL_INTERACTIONS,
} from '../../protocols/catalog.js';

const FIXTURE_ROOT = join(process.cwd(), 'src', 'authority', 'test', 'fixtures');
const SPECIAL_EVIDENCE_REQUIREMENT_IDS = [
  'canary-business-health', 'canary-consumer-health', 'canary-data-integrity',
  'canary-experience-health', 'canary-migration-integrity', 'canary-result',
  'canary-technical-health', 'delivery-contract', 'delivery-rollback',
  'delivery-runtime', 'qa-result', 'repository-review', 'reproduction',
  'root-cause', 'simplify-regression', 'work-check',
] as const;

async function loadFixturePair(): Promise<{
  jsonBytes: Buffer;
  yamlValue: unknown;
  catalog: StageAuthorityCatalogV1;
}> {
  const [yamlText, jsonBytes] = await Promise.all([
    readFile(join(FIXTURE_ROOT, 'stage-authority-catalog-v1.yaml'), 'utf8'),
    readFile(join(FIXTURE_ROOT, 'stage-authority-catalog-v1.canonical.json')),
  ]);
  const yamlValue: unknown = YAML.parse(yamlText);
  return {
    yamlValue,
    jsonBytes,
    catalog: stageAuthorityCatalogV1Schema.parse(yamlValue),
  };
}

function cloneCatalog(catalog: StageAuthorityCatalogV1): Record<string, unknown> {
  return JSON.parse(JSON.stringify(catalog)) as Record<string, unknown>;
}

function renderMachineSegments(segments: readonly Record<string, unknown>[]): string {
  return segments.map((segment) => {
    if (segment.kind === 'LITERAL') return `L:${String(segment.value)}`;
    if (segment.kind === 'TOKEN') return `T:${String(segment.token)}`;
    return `D:${String(segment.prefix)}|${String(segment.token)}|${String(segment.tokenEncoding)}|${String(segment.suffix)}`;
  }).join('/');
}

function installSignalStressCatalog(value: Record<string, unknown>, signalCount: number): void {
  const policies = value.canaryPoliciesByScenario as Array<{
    policy: { signals: Array<Record<string, unknown>> };
  }>;
  const sourceSignal = policies[0]!.policy.signals[0]!;
  policies[0]!.policy.signals = Array.from({ length: signalCount }, (_, index) => ({
    ...sourceSignal,
    measurementRequirementId: `measurement-${String(index).padStart(4, '0')}`,
    signalId: `signal-${String(index).padStart(4, '0')}`,
  }));
}

function installSingleCodePointSignalCatalog(value: Record<string, unknown>, signalCount: number): void {
  const policies = value.canaryPoliciesByScenario as Array<{
    policy: { signals: Array<Record<string, unknown>> };
  }>;
  const signalIds = Array.from({ length: signalCount }, (_, index) => String.fromCodePoint(0x4e00 + index));
  for (const [policyIndex, row] of policies.entries()) {
    const sourceSignal = row.policy.signals[0]!;
    const selectedSignalIds = policyIndex === 0 ? signalIds : signalIds.slice(0, 1);
    row.policy.signals = selectedSignalIds.map((signalId, index) => ({
      ...sourceSignal,
      measurementRequirementId: `single-codepoint-${String(index).padStart(4, '0')}`,
      signalId,
    }));
  }
}

function replaceMachineWithSignalRules(
  value: Record<string, unknown>,
  segments: readonly Record<string, unknown>[],
): void {
  const authority = value.machineAuthority as Record<string, unknown>;
  authority.files = [];
  authority.ownedDirectories = [];
  authority.transientExclusions = [];
  authority.authoredRules = segments.map((segment, index) => ({
    ruleId: `stress-signal-${String(index).padStart(4, '0')}`,
    scope: 'PROJECT',
    nodeKind: 'FILE',
    pathSegments: [segment],
    policy: 'HISTORICAL_CAPTURE_ONLY',
  }));
}

test('规范 YAML 与 canonical JSON 是同一个严格权限对象', async () => {
  const { yamlValue, jsonBytes, catalog } = await loadFixturePair();
  assert.deepEqual(jsonBytes, Buffer.from(`${canonicalStrictJson(yamlValue)}\n`, 'utf8'));
  const jsonValue: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(jsonBytes));
  const parsedJson = stageAuthorityCatalogV1Schema.parse(jsonValue);
  assert.deepEqual(catalog, parsedJson);
  assert.deepEqual(yamlValue, jsonValue);
  assert.match(hashStrictObject(catalog), /^sha256:[0-9a-f]{64}$/);
});

test('invalid UTF-8 raw bytes 与合法 U+FFFD bytes 不等价且 canonical decoder fatal 拒绝替换碰撞', () => {
  const invalidRawBytes = Buffer.from([0xef, 0xbf]);
  const validReplacementBytes = Buffer.from('\ufffd', 'utf8');
  assert.notDeepEqual(invalidRawBytes, validReplacementBytes);
  assert.throws(
    () => new TextDecoder('utf-8', { fatal: true }).decode(invalidRawBytes),
    TypeError,
  );
  assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(validReplacementBytes), '\ufffd');
});

test('目录锁定 24/53/16/7/74 基数以及完整静态注册表', async () => {
  const { catalog } = await loadFixturePair();
  const scenarioRequirementIds = new Set(catalog.scenarioProfiles.flatMap((profile) => profile.requiredEvidence));
  const specialRequirementIds = new Set(SPECIAL_EVIDENCE_REQUIREMENT_IDS);
  const taskRequirementIds = new Set(catalog.taskEvidenceRequirementIds);
  assert.equal(catalog.capabilityTemplates.length, 24);
  assert.equal(scenarioRequirementIds.size, 53);
  assert.equal(specialRequirementIds.size, 16);
  assert.equal(taskRequirementIds.size, 7);
  assert.equal(catalog.evidenceTemplates.length, 74);
  assert.equal(catalog.artifactAuthority.entries.length, 16);
  assert.equal(catalog.scenarioProfiles.length, 19);
  assert.equal(catalog.worksetReentryPolicies.length, 8);
  assert.equal(catalog.compilerArtifacts.length, 10);
  assert.equal(catalog.protocolManifests.some((manifest) => manifest.id === 'repository.release'), false);
  assert.equal(catalog.protocolManifests.some((manifest) => manifest.id === 'repository.ship'), true);
});

test('目录拒绝删除、重排、重复、错误 mode、release、route reason 与未知字段 mutation', async () => {
  const { catalog } = await loadFixturePair();
  const mutations: Array<[string, (value: Record<string, unknown>) => void]> = [
    ['删除 capability', (value) => { (value.capabilityTemplates as unknown[]).splice(0, 1); }],
    ['重排 capability', (value) => { (value.capabilityTemplates as unknown[]).reverse(); }],
    ['重复 capability', (value) => { (value.capabilityTemplates as unknown[]).splice(1, 0, (value.capabilityTemplates as unknown[])[0]); }],
    ['FILE mode 改为 0755', (value) => {
      const authority = value.artifactAuthority as { entries: Array<Record<string, unknown>> };
      authority.entries.find((entry) => entry.kind === 'FILE')!.creationMode = '0755';
    }],
    ['DIRECTORY mode 改为 0644', (value) => {
      const authority = value.artifactAuthority as { entries: Array<Record<string, unknown>> };
      authority.entries.find((entry) => entry.kind === 'DIRECTORY')!.creationMode = '0644';
    }],
    ['重新引入 release', (value) => {
      const templates = value.capabilityTemplates as Array<Record<string, unknown>>;
      templates.push({ ...templates[0], capability: 'release' });
    }],
    ['修改 Reentry route reason', (value) => {
      const policies = value.worksetReentryPolicies as Array<{ route: { reason: string } }>;
      policies[0]!.route.reason += ' changed';
    }],
    ['加入未知字段', (value) => { value.legacyCompatibility = true; }],
  ];
  for (const [name, mutate] of mutations) {
    const value = cloneCatalog(catalog);
    mutate(value);
    assert.equal(stageAuthorityCatalogV1Schema.safeParse(value).success, false, name);
  }
});

test('strict root 在 Zod 读取前拒绝 accessor、symbol 与自定义 prototype', async () => {
  const { catalog } = await loadFixturePair();
  let getterRead = false;
  const accessor = cloneCatalog(catalog);
  Object.defineProperty(accessor, 'catalogId', {
    enumerable: true,
    get() {
      getterRead = true;
      return 'omnai.stage-authority.v1';
    },
  });
  assert.equal(stageAuthorityCatalogV1Schema.clone().safeParse(accessor).success, false);
  assert.equal(getterRead, false);

  const symbol = cloneCatalog(catalog);
  Object.defineProperty(symbol, Symbol('legacy'), { enumerable: true, value: true });
  assert.equal(stageAuthorityCatalogV1Schema.safeParse(symbol).success, false);

  const inherited = Object.assign(Object.create({ legacy: true }) as Record<string, unknown>, cloneCatalog(catalog));
  assert.equal(stageAuthorityCatalogV1Schema.safeParse(inherited).success, false);
});

test('canonical JSON 保留 __proto__ 数据键并拒绝所有嵌套 hostile JSON 形状与预算越界', () => {
  const ownProto = JSON.parse('{"z":1,"__proto__":{"polluted":true},"a":2}') as unknown;
  assert.equal(
    canonicalStrictJson(ownProto),
    '{"__proto__":{"polluted":true},"a":2,"z":1}',
  );
  assert.notEqual(hashStrictObject(ownProto), hashStrictObject({ a: 2, z: 1 }));
  assert.equal(
    canonicalStrictJson(JSON.parse('{"outer":{"z":1,"__proto__":{"nested":true}}}') as unknown),
    '{"outer":{"__proto__":{"nested":true},"z":1}}',
  );

  let getterRead = false;
  const nestedAccessor: Record<string, unknown> = {};
  Object.defineProperty(nestedAccessor, 'secret', {
    enumerable: true,
    get() {
      getterRead = true;
      return 'forbidden';
    },
  });
  assert.throws(() => canonicalStrictJson({ outer: nestedAccessor }), /accessor/u);
  assert.equal(getterRead, false);

  const nestedSymbol: Record<string, unknown> = { value: true };
  Object.defineProperty(nestedSymbol, Symbol('hidden'), { enumerable: true, value: true });
  assert.throws(() => canonicalStrictJson({ outer: nestedSymbol }), /symbol/u);
  assert.throws(
    () => canonicalStrictJson({ outer: Object.assign(Object.create({ inherited: true }) as Record<string, unknown>, { value: true }) }),
    /strict JSON/u,
  );
  const sparse = new Array<unknown>(2);
  sparse[1] = true;
  assert.throws(() => canonicalStrictJson({ outer: sparse }), /sparse/u);

  let exactDepth: unknown = null;
  for (let index = 0; index < 512; index += 1) exactDepth = { next: exactDepth };
  assert.doesNotThrow(() => canonicalStrictJson(exactDepth));
  const tooDeep: unknown = { next: exactDepth };
  assert.throws(() => canonicalStrictJson(tooDeep), /depth exceeds limit/u);
  assert.doesNotThrow(() => canonicalStrictJson(Array.from({ length: 99_999 }, () => null)));
  assert.throws(
    () => canonicalStrictJson(Array.from({ length: 100_000 }, () => null)),
    /node budget exceeded/u,
  );
});

// 背景：旧 canonicalizer 虽只从 data descriptor 建图，最终仍把普通数组交给 JSON.stringify；
// JSON.stringify 会调用继承的 Array.prototype.toJSON，使数组权限前像被环境改写为任意 scalar。
// 目的：canonical bytes 必须由 descriptor-only encoder 直接产生，并保持干净输入的字节 `[1]`。
// 上下文：finally 恢复完整 descriptor，避免全局 prototype 污染后续 golden 与并发测试。
test('canonical/hash 不观察 Array.prototype.toJSON 且保持数组 golden bytes', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  let toJsonCalls = 0;
  let canonical: string | undefined;
  let arrayHash: string | undefined;
  Object.defineProperty(Array.prototype, 'toJSON', {
    configurable: true,
    value() {
      toJsonCalls += 1;
      return 'polluted';
    },
  });
  try {
    canonical = canonicalStrictJson([1]);
    arrayHash = hashStrictObject([1]);
  } finally {
    if (originalDescriptor === undefined) {
      Reflect.deleteProperty(Array.prototype, 'toJSON');
    } else {
      Object.defineProperty(Array.prototype, 'toJSON', originalDescriptor);
    }
  }

  assert.equal(canonical, '[1]');
  assert.notEqual(arrayHash, hashStrictObject('polluted'));
  assert.equal(toJsonCalls, 0);
});

// 背景：旧 preflight/output builder 使用普通数组 push；Array.prototype 上的数字 accessor setter
// 会在内部栈或输出数组首次写入时执行 caller code，即使输入自身是稠密 own-data 数组。目的：认证
// 与 canonical 编码都只能用不经继承赋值语义的数据结构。上下文：setter 用 defineProperty 保持
// 旧实现可继续运行，从而把副作用计数固定成真正的行为 RED，而不是偶然 TypeError。
test('canonical encoder 不观察 Array.prototype 数字 accessor 副作用', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, '0');
  let getterCalls = 0;
  let setterCalls = 0;
  let canonical: string | undefined;
  Object.defineProperty(Array.prototype, '0', {
    configurable: true,
    get() {
      getterCalls += 1;
      return undefined;
    },
    set(value: unknown) {
      setterCalls += 1;
      Object.defineProperty(this, '0', {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    },
  });
  try {
    canonical = canonicalStrictJson([1]);
  } finally {
    if (originalDescriptor === undefined) {
      Reflect.deleteProperty(Array.prototype, '0');
    } else {
      Object.defineProperty(Array.prototype, '0', originalDescriptor);
    }
  }

  assert.equal(canonical, '[1]');
  assert.equal(getterCalls, 0);
  assert.equal(setterCalls, 0);
});

// 背景：descriptor-only value walk 若仍调用 keys.sort 或 for-of，会把 key order 与控制流交给
// Array.prototype.sort/@@iterator 的可变环境状态。目的：对象 key canonicalization 使用自己的
// code-unit heap sort 与显式索引 descriptor walk，污染 hook 必须零调用且 golden bytes 不变。
// 上下文：finally 同时恢复两个完整 descriptor，避免影响 node:test 的结果收集数组。
test('canonical key 排序不观察 Array.prototype sort 或 iterator hook', () => {
  const originalSort = Object.getOwnPropertyDescriptor(Array.prototype, 'sort');
  const originalIterator = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
  let sortCalls = 0;
  let iteratorCalls = 0;
  let canonical: string | undefined;
  let thrown: unknown;
  Object.defineProperty(Array.prototype, 'sort', {
    configurable: true,
    value() {
      sortCalls += 1;
      throw new Error('HOSTILE_ARRAY_SORT');
    },
  });
  Object.defineProperty(Array.prototype, Symbol.iterator, {
    configurable: true,
    value() {
      iteratorCalls += 1;
      throw new Error('HOSTILE_ARRAY_ITERATOR');
    },
  });
  try {
    try {
      canonical = canonicalStrictJson({ z: 1, a: 2 });
    } catch (error) {
      thrown = error;
    }
  } finally {
    if (originalSort === undefined) Reflect.deleteProperty(Array.prototype, 'sort');
    else Object.defineProperty(Array.prototype, 'sort', originalSort);
    if (originalIterator === undefined) Reflect.deleteProperty(Array.prototype, Symbol.iterator);
    else Object.defineProperty(Array.prototype, Symbol.iterator, originalIterator);
  }

  assert.equal(thrown, undefined);
  assert.equal(canonical, '{"a":2,"z":1}');
  assert.equal(sortCalls, 0);
  assert.equal(iteratorCalls, 0);
});

// 背景：canonicalizer 虽改用 descriptor，却仍在 root/nested 节点先执行 Array.isArray、
// getPrototypeOf 与 ownKeys；Proxy 可据此执行 trap，透明 Proxy 甚至会被认证。目的：所有 Proxy
// 身份在任何反射前拒绝，hashStrictObject 复用同一边界。上下文：revoked Proxy 也必须得到稳定
// fail-closed，而不是依赖其第一个 trap 恰好抛错；普通 accessor 的零读取由相邻测试继续锁定。
test('canonical/hash 在零 trap 下拒绝 transparent、throwing、revoked root/nested Proxy', () => {
  const transparentRoot = new Proxy({ value: true }, {});
  const transparentNested = { outer: new Proxy({ value: true }, {}) };
  assert.throws(() => canonicalStrictJson(transparentRoot));
  assert.throws(() => canonicalStrictJson(transparentNested));
  assert.throws(() => hashStrictObject(transparentRoot));

  for (const nested of [false, true]) {
    let traps = 0;
    const proxy = new Proxy({ value: true }, {
      getPrototypeOf() { traps += 1; throw new Error('HOSTILE_CANONICAL_PROTOTYPE'); },
      ownKeys() { traps += 1; throw new Error('HOSTILE_CANONICAL_KEYS'); },
      getOwnPropertyDescriptor() { traps += 1; throw new Error('HOSTILE_CANONICAL_DESCRIPTOR'); },
      get() { traps += 1; throw new Error('HOSTILE_CANONICAL_GET'); },
    });
    assert.throws(() => canonicalStrictJson(nested ? { outer: proxy } : proxy));
    assert.equal(traps, 0, nested ? 'nested' : 'root');
  }

  const revoked = Proxy.revocable({ value: true }, {});
  revoked.revoke();
  assert.throws(() => canonicalStrictJson(revoked.proxy));
});

// 背景：authority/compiler/protocol registries 同时服务 schema 与公开 runtime；只冻结 Flow 的
// 派生顺序仍允许 caller 污染 compilerId、Workset action 或 protocol enum。目的：四类 mutation
// 对每个保留 registry 都失败，随后 catalog clone 的重复/并发 parse 保持 exact 10/9/3/6 基数。
// 上下文：finally 恢复仅服务 RED 基线，避免旧可变数组污染同一 node:test 进程。
test('authority 与 protocol runtime registries 隔离冻结且并发 parse 不受 mutation 污染', async () => {
  for (const registry of [
    STAGE_COMPILER_ARTIFACT_IDS,
    WORKSET_PROTOCOL_ACTIONS,
    PROTOCOL_INTERACTIONS,
    PROTOCOL_ERROR_CODES,
  ] as ReadonlyArray<readonly string[]>) {
    assertAuthorityRegistryMutationClosed(registry);
  }

  const { catalog } = await loadFixturePair();
  const parsed = await Promise.all(Array.from({ length: 8 }, () => (
    stageAuthorityCatalogV1Schema.parseAsync(cloneCatalog(catalog))
  )));
  assert.equal(parsed.every((value) => value.compilerArtifacts.length === 10), true);
  assert.equal(WORKSET_PROTOCOL_ACTIONS.length, 9);
  assert.equal(PROTOCOL_INTERACTIONS.length, 3);
  assert.equal(PROTOCOL_ERROR_CODES.length, 6);
});

test('set 数组只接受 UTF-16 code-unit 排序且不接受重复', async () => {
  const { catalog } = await loadFixturePair();
  assert.deepEqual([...catalog.taskEvidenceRequirementIds].sort(compareCodeUnits), catalog.taskEvidenceRequirementIds);
  const reordered = cloneCatalog(catalog);
  (reordered.taskEvidenceRequirementIds as string[]).reverse();
  assert.equal(stageAuthorityCatalogV1Schema.safeParse(reordered).success, false);
});

test('24 个 capability 行逐列匹配终态、输出、Evidence、gate、predicate 与 policy 权限', async () => {
  const { catalog } = await loadFixturePair();
  const expected = [
    ['frame', 'frame', 'ARTIFACT_STAGE', 'ARTIFACT_AUTHORITY_SET', '', '', '', 'NONE'],
    ['research', 'research', 'ARTIFACT_STAGE', 'ARTIFACT_AUTHORITY_SET', '', '', '', 'NONE'],
    ['map', 'map', 'ARTIFACT_STAGE', 'ARTIFACT_AUTHORITY_SET', '', '', '', 'NONE'],
    ['model', 'domain', 'ARTIFACT_STAGE', 'ARTIFACT_AUTHORITY_SET', '', '', '', 'NONE'],
    ['spec', 'spec', 'ARTIFACT_STAGE', 'ARTIFACT_AUTHORITY_SET', '', '', '', 'NONE'],
    ['design', 'design', 'ARTIFACT_STAGE', 'ARTIFACT_AUTHORITY_SET', '', '', '', 'NONE'],
    ['plan', 'plan', 'PLAN_STAGE', 'TASKFILE_DRAFT', '', '', '', 'NONE'],
    ['triage', 'triage', 'ISSUE_STAGE', 'ARTIFACT_AUTHORITY_SET', '', '', 'TRIAGE_STATE_IN', 'NONE'],
    ['reproduce', 'reproduction', 'ISSUE_STAGE', 'ARTIFACT_AUTHORITY_SET', 'reproduction', '', 'REPRODUCTION_IN', 'NONE'],
    ['debug', 'diagnosis', 'ISSUE_STAGE', 'ARTIFACT_AUTHORITY_SET', 'root-cause', '', 'FIX_STRATEGY_IN,ROOT_CAUSE_IS', 'NONE'],
    ['diagnose', 'diagnosis', 'ARTIFACT_STAGE', 'ARTIFACT_AUTHORITY_SET', '', '', '', 'NONE'],
    ['experiment', 'experiment', 'ARTIFACT_STAGE', 'ARTIFACT_AUTHORITY_SET', '', '', '', 'NONE'],
    ['fix', 'fix', 'ARTIFACT_STAGE', 'ARTIFACT_AUTHORITY_SET', '', '', '', 'NONE'],
    ['mitigate', 'mitigation', 'ARTIFACT_STAGE', 'ARTIFACT_AUTHORITY_SET', '', '', '', 'NONE'],
    ['work', 'implementation', 'WORK_STAGE', 'REPOSITORY_DIFF/IMPLEMENTATION_DIFF/SELECTED_TASK/PREPARED_REPOSITORY_BASIS', 'work-check', '', '', 'NONE'],
    ['simplify', 'simplification', 'SIMPLIFY_STAGE', 'REPOSITORY_DIFF/SIMPLIFICATION_DIFF/NONE/PREPARED_REPOSITORY_BASIS', 'simplify-regression', '', '', 'NONE'],
    ['review', 'review', 'REVIEW_STAGE', 'REVIEW_DRAFT', 'repository-review', '', '', 'REVIEW_POLICY_COMPILER_V1'],
    ['verify', 'verification', 'VERIFY_STAGE', '', '', '', '', 'VERIFY_SCENARIO_AND_TASK_EVIDENCE_V1'],
    ['qa', 'qa', 'QA_STAGE', 'QA_DRAFT', 'qa-result', '', '', 'QA_POLICY_BY_SCENARIO_V1'],
    ['ship', 'release', 'DELIVERY_STAGE', 'ARTIFACT_AUTHORITY_SET', 'delivery-contract,delivery-rollback,delivery-runtime', 'delivery-approval', '', 'DELIVERY_POLICY_V1'],
    ['canary', 'canary', 'CANARY_STAGE', 'CANARY_DRAFT', 'canary-result', '', '', 'CANARY_POLICY_BY_SCENARIO_V1'],
    ['learn', 'learning', 'ARTIFACT_STAGE', 'ARTIFACT_AUTHORITY_SET', '', '', '', 'NONE'],
    ['archive', null, 'ARCHIVE_STAGE', '', '', '', '', 'NONE'],
    ['reconcile', null, 'RECONCILE_STAGE', '', '', '', '', 'NONE'],
  ].sort((left, right) => compareCodeUnits(String(left[0]), String(right[0])));
  const actual = catalog.capabilityTemplates.map((row) => [
    row.capability,
    row.readinessKey,
    row.terminalKind,
    row.authoredOutputs.map((output) => output.kind === 'REPOSITORY_DIFF'
      ? [output.kind, output.role, output.taskIdFormula, output.basisFormula].join('/')
      : output.kind).join(','),
    row.baseEvidenceRequirementIds.join(','),
    row.humanGateIds.join(','),
    row.issuePredicates.map((predicate) => predicate.kind).join(','),
    row.policyBinding.kind,
  ]);
  assert.deepEqual(actual, expected);
});

test('24 个 capability contextPaths 精确锁定 ChangeRelativePath 且 scaffold 只接受规范资源路径', async () => {
  const { catalog } = await loadFixturePair();
  const expected: Record<string, readonly string[]> = {
    archive: ['intent.md', 'research.md', 'domain.md', 'spec.md', 'contract.md', 'design.md', 'tasks.yaml', 'delivery.md'],
    canary: ['spec.md', 'design.md', 'delivery.md'],
    debug: ['issue.md', 'issue.yaml', 'research.md'],
    design: ['intent.md', 'research.md', 'domain.md', 'spec.md', 'contract.md', 'design.md'],
    diagnose: ['research.md'],
    experiment: ['issue.md', 'issue.yaml', 'research.md', 'domain.md', 'spec.md', 'design.md'],
    fix: ['issue.md', 'issue.yaml', 'research.md', 'experiments/', 'fix.md'],
    frame: ['intent.md'],
    learn: ['research.md', 'domain.md', 'spec.md', 'design.md', 'fix.md', 'learning.md'],
    map: ['intent.md', 'research.md', 'map.yaml'],
    mitigate: ['intent.md', 'research.md'],
    model: ['intent.md', 'research.md', 'domain.md'],
    plan: ['research.md', 'domain.md', 'spec.md', 'contract.md', 'design.md', 'fix.md', 'tasks.yaml'],
    qa: ['spec.md', 'design.md'],
    reconcile: ['intent.md', 'research.md', 'domain.md', 'spec.md', 'contract.md', 'design.md', 'fix.md', 'tasks.yaml', 'delivery.md'],
    reproduce: ['intent.md', 'issue.md', 'issue.yaml'],
    research: ['intent.md', 'research.md'],
    review: ['intent.md', 'research.md', 'domain.md', 'spec.md', 'contract.md', 'design.md', 'fix.md', 'tasks.yaml'],
    ship: ['spec.md', 'contract.md', 'design.md', 'tasks.yaml', 'delivery.md'],
    simplify: ['design.md', 'tasks.yaml'],
    spec: ['intent.md', 'research.md', 'domain.md', 'contract.md', 'spec.md'],
    triage: ['intent.md', 'research.md', 'issue.md', 'issue.yaml'],
    verify: ['spec.md', 'contract.md', 'design.md', 'fix.md', 'tasks.yaml', 'delivery.md'],
    work: ['spec.md', 'contract.md', 'design.md', 'fix.md', 'tasks.yaml'],
  };
  assert.deepEqual(
    Object.fromEntries(catalog.capabilityTemplates.map((row) => [row.capability, row.contextPaths])),
    expected,
  );

  for (const invalidPath of ['../intent.md', 'a\\b', 'a//b', '.', '..', 'x\u0000.md', 'cafe\u0301.md', 'x%2fy.md']) {
    const value = cloneCatalog(catalog);
    (value.capabilityTemplates as Array<Record<string, unknown>>)[0]!.contextPaths = [invalidPath];
    assert.equal(stageAuthorityCatalogV1Schema.safeParse(value).success, false, `context ${JSON.stringify(invalidPath)}`);
  }
  for (const invalidPath of [
    'resources/scaffolds/', 'resources/scaffolds//intent.md', 'resources/scaffolds/./intent.md',
    'resources/scaffolds/../intent.md', 'resources/scaffolds/a\\intent.md',
    'resources/scaffolds/x\u0000.md', 'resources/scaffolds/cafe\u0301.md',
    'resources/scaffolds/x%2fintent.md', 'resources/other/intent.md',
  ]) {
    const value = cloneCatalog(catalog);
    const entries = (value.artifactAuthority as { entries: Array<Record<string, unknown>> }).entries;
    const entry = entries.find((candidate) => candidate.scaffold !== null)!;
    (entry.scaffold as Record<string, unknown>).resourcePath = invalidPath;
    assert.equal(stageAuthorityCatalogV1Schema.safeParse(value).success, false, `scaffold ${JSON.stringify(invalidPath)}`);
  }
});

test('53 个 Scenario requirements 与 16 special、7 task 行锁定 producer/type/scope', async () => {
  const { catalog } = await loadFixturePair();
  const expectedGroups: Record<string, readonly string[]> = {
    'VERIFICATION_COMMAND/build': ['build', 'package-build'],
    'VERIFICATION_COMMAND/test': ['behavior-tests', 'characterization-tests', 'component-tests', 'consumer-tests', 'focused-regression', 'full-test-suite', 'integration-tests', 'recovery-check', 'regression-test', 'regression-tests', 'rollback-or-forward-fix-test', 'smoke-test', 'tests'],
    'VERIFICATION_COMMAND/contract': ['api-compatibility', 'compatibility-checks', 'contract-tests'],
    'VERIFICATION_COMMAND/migration': ['migration-dry-run'],
    'VERIFICATION_COMMAND/runtime': ['after-benchmark', 'baseline-benchmark', 'operability-check'],
    'GENERIC_IMPORT/contract': ['architecture-review', 'code-references', 'comparison', 'consumer-impact', 'decision-rationale', 'dependency-map', 'domain-decisions', 'field-lineage', 'flow-trace', 'historical-lineage', 'incident-timeline', 'postmortem', 'retirement-proof', 'user-or-market-evidence'],
    'GENERIC_IMPORT/reproduction': ['reproduction', 'root-cause'],
    'GENERIC_IMPORT/data': ['data-reconciliation', 'migration-reconciliation'],
    'GENERIC_IMPORT/qa': ['accessibility-check', 'browser-qa', 'product-acceptance'],
    'GENERIC_IMPORT/review': ['review'],
    'GENERIC_IMPORT/runtime': ['deployment-logs', 'environment-health', 'experiment-results', 'post-migration-health', 'production-health', 'profile-or-trace', 'runtime-health', 'runtime-signal'],
    'GENERIC_IMPORT/rollback': ['rollback-or-forward-fix-result'],
  };
  const scenarioIds = new Set(catalog.scenarioProfiles.flatMap((profile) => profile.requiredEvidence));
  for (const [key, ids] of Object.entries(expectedGroups)) {
    const [producer, type] = key.split('/');
    for (const id of ids) {
      const row = catalog.evidenceTemplates.find((candidate) => candidate.requirementId === id)!;
      assert.equal(scenarioIds.has(id), true, id);
      assert.equal(row.producer, producer, id);
      assert.deepEqual(row.allowedTypes, [type], id);
      assert.equal(row.taskScopeFormula, 'NONE', id);
    }
  }
  const specialOverrides: Record<string, readonly [string, string, string]> = {
    'work-check': ['VERIFICATION_COMMAND', 'test', 'SELECTED_TASK'],
    'simplify-regression': ['VERIFICATION_COMMAND', 'test', 'NONE'],
    'repository-review': ['REVIEW_RESULT_IMPORT', 'review', 'REVIEW_SCOPE'],
    'qa-result': ['QA_RESULT_IMPORT', 'qa', 'NONE'],
    'canary-result': ['CANARY_RESULT_IMPORT', 'runtime', 'NONE'],
    'canary-business-health': ['CANARY_MEASUREMENT_IMPORT', 'runtime', 'NONE'],
    'canary-consumer-health': ['CANARY_MEASUREMENT_IMPORT', 'runtime', 'NONE'],
    'canary-data-integrity': ['CANARY_MEASUREMENT_IMPORT', 'runtime', 'NONE'],
    'canary-experience-health': ['CANARY_MEASUREMENT_IMPORT', 'runtime', 'NONE'],
    'canary-migration-integrity': ['CANARY_MEASUREMENT_IMPORT', 'runtime', 'NONE'],
    'canary-technical-health': ['CANARY_MEASUREMENT_IMPORT', 'runtime', 'NONE'],
    'delivery-contract': ['GENERIC_IMPORT', 'contract', 'NONE'],
    'delivery-rollback': ['GENERIC_IMPORT', 'rollback', 'NONE'],
    'delivery-runtime': ['GENERIC_IMPORT', 'runtime', 'NONE'],
  };
  for (const [id, [producer, type, scope]] of Object.entries(specialOverrides)) {
    const row = catalog.evidenceTemplates.find((candidate) => candidate.requirementId === id)!;
    assert.equal(row.producer, producer, id);
    assert.deepEqual(row.allowedTypes, [type], id);
    assert.equal(row.taskScopeFormula, scope, id);
  }
  for (const id of catalog.taskEvidenceRequirementIds) {
    assert.equal(catalog.evidenceTemplates.find((row) => row.requirementId === id)?.taskScopeFormula, 'TASK_DECLARED', id);
  }
});

test('Artifact 与当前可转录 Machine 非 writer 权限行逐项闭合', async () => {
  const { catalog } = await loadFixturePair();
  assert.deepEqual(catalog.artifactAuthority.entries.map((entry) => [entry.entryId, entry.kind, entry.path]), [
    ['debug:ISSUE_NARRATIVE', 'FILE', 'issue.md'],
    ['design:DESIGN', 'FILE', 'design.md'],
    ['diagnose:RESEARCH', 'FILE', 'research.md'],
    ['experiment:EXPERIMENTS', 'DIRECTORY', 'experiments/'],
    ['fix:FIX', 'FILE', 'fix.md'],
    ['frame:INTENT', 'FILE', 'intent.md'],
    ['learn:LEARNING', 'FILE', 'learning.md'],
    ['map:MAP', 'FILE', 'map.yaml'],
    ['mitigate:RESEARCH', 'FILE', 'research.md'],
    ['model:DOMAIN', 'FILE', 'domain.md'],
    ['reproduce:ISSUE_NARRATIVE', 'FILE', 'issue.md'],
    ['research:RESEARCH', 'FILE', 'research.md'],
    ['ship:DELIVERY', 'FILE', 'delivery.md'],
    ['spec:CONTRACT', 'FILE', 'contract.md'],
    ['spec:SPEC', 'FILE', 'spec.md'],
    ['triage:ISSUE_NARRATIVE', 'FILE', 'issue.md'],
  ]);
  assert.deepEqual(catalog.machineAuthority.files.map((row) => row.ruleId), ['project-investigation-metadata-v1']);
  assert.deepEqual(catalog.machineAuthority.ownedDirectories.map((row) => row.ruleId), [
    'change-stage-outputs-root-v1', 'project-investigation-root-v1',
    'project-investigations-root-v1', 'project-knowledge-root-v1',
  ]);
  assert.deepEqual(catalog.machineAuthority.authoredRules.map((row) => row.ruleId), [
    'change-stage-output-run-v1', 'project-investigation-research-v1',
    'project-knowledge-glossary-v1', 'project-knowledge-learnings-v1',
    'project-knowledge-policies-v1',
  ]);
  assert.deepEqual(catalog.machineAuthority.transientExclusions.map((row) => row.ruleId), [
    'change-atomic-targets-v1', 'change-lock-v1', 'project-atomic-targets-v1',
    'project-bootstrap-v0.3', 'project-change-stage-v1',
  ]);
});

test('Machine 1/4/5/5 行锁定完整 scope、segment、node/mode、owner 与 child grammar tuple', async () => {
  const { catalog } = await loadFixturePair();
  const rows = [
    ...catalog.machineAuthority.files.map((row) => [
      'files', row.ruleId, row.scope, `FILE:${row.mode}:${row.schemaIdentity}`, renderMachineSegments(row.pathSegments),
      'RAW_BYTES',
    ]),
    ...catalog.machineAuthority.ownedDirectories.map((row) => [
      'ownedDirectories', row.ruleId, row.scope, `DIRECTORY:${row.mode}`, renderMachineSegments(row.pathSegments),
      `${row.entryPolicy}:${row.seal}`,
    ]),
    ...catalog.machineAuthority.authoredRules.map((row) => [
      'authoredRules', row.ruleId, row.scope, row.nodeKind, renderMachineSegments(row.pathSegments), row.policy,
    ]),
    ...catalog.machineAuthority.transientExclusions.map((row) => [
      'transientExclusions', row.ruleId, row.scope, `${row.kind}:${row.directoryMode}`,
      renderMachineSegments(row.pathSegments), `${row.ownerIdentity}:${canonicalStrictJson(row.childGrammar)}:${row.policy}`,
    ]),
  ];
  assert.deepEqual(rows, [
    ['files', 'project-investigation-metadata-v1', 'PROJECT', 'FILE:0644:omnai.investigation-metadata.v1', 'L:.omnai/L:investigations/T:<InvestigationDirectoryName>/L:investigation.yaml', 'RAW_BYTES'],
    ['ownedDirectories', 'change-stage-outputs-root-v1', 'CHANGE', 'DIRECTORY:0755', 'L:stage-outputs', 'EXACT_REGISTERED_CHILDREN:ENTRY_NAMES_AND_NODE_TYPES'],
    ['ownedDirectories', 'project-investigation-root-v1', 'PROJECT', 'DIRECTORY:0755', 'L:.omnai/L:investigations/T:<InvestigationDirectoryName>', 'EXACT_REGISTERED_CHILDREN:ENTRY_NAMES_AND_NODE_TYPES'],
    ['ownedDirectories', 'project-investigations-root-v1', 'PROJECT', 'DIRECTORY:0755', 'L:.omnai/L:investigations', 'EXACT_REGISTERED_CHILDREN:ENTRY_NAMES_AND_NODE_TYPES'],
    ['ownedDirectories', 'project-knowledge-root-v1', 'PROJECT', 'DIRECTORY:0755', 'L:.omnai/L:project', 'EXACT_REGISTERED_CHILDREN:ENTRY_NAMES_AND_NODE_TYPES'],
    ['authoredRules', 'change-stage-output-run-v1', 'CHANGE', 'DIRECTORY', 'L:stage-outputs/T:<RunId>', 'HISTORICAL_CAPTURE_ONLY'],
    ['authoredRules', 'project-investigation-research-v1', 'PROJECT', 'FILE', 'L:.omnai/L:investigations/T:<InvestigationDirectoryName>/L:research.md', 'HISTORICAL_CAPTURE_ONLY'],
    ['authoredRules', 'project-knowledge-glossary-v1', 'PROJECT', 'FILE', 'L:.omnai/L:project/L:glossary.md', 'HISTORICAL_CAPTURE_ONLY'],
    ['authoredRules', 'project-knowledge-learnings-v1', 'PROJECT', 'FILE', 'L:.omnai/L:project/L:learnings.md', 'HISTORICAL_CAPTURE_ONLY'],
    ['authoredRules', 'project-knowledge-policies-v1', 'PROJECT', 'FILE', 'L:.omnai/L:project/L:policies.md', 'HISTORICAL_CAPTURE_ONLY'],
    ['transientExclusions', 'change-atomic-targets-v1', 'CHANGE', 'OWNED_DIRECTORY:0700', 'L:runtime/L:transient/T:<AuthoritySequence>/T:<OwnerId>', 'CHANGE_AUTHORITY_OWNER:{"allowedTokens":["<TargetOrdinal>"],"kind":"ATOMIC_TARGETS_V1","relativePathPattern":"<TargetOrdinal>/target.tmp"}:OWNER_SCOPED_NO_DURABLE_REMAINS'],
    ['transientExclusions', 'change-lock-v1', 'PROJECT', 'OWNED_DIRECTORY:0700', 'L:.omnai/L:runtime/L:change-locks/T:<ChangeId>', 'CHANGE_LOCK:{"allowedRelativePaths":["owner.json","stage/owner.json"],"kind":"CHANGE_LOCK_V1"}:OWNER_SCOPED_NO_DURABLE_REMAINS'],
    ['transientExclusions', 'project-atomic-targets-v1', 'PROJECT', 'OWNED_DIRECTORY:0700', 'L:.omnai/L:runtime/L:project-atomic/T:<ProjectTransactionId>', 'PROJECT_TRANSACTION_OWNER:{"allowedTokens":["<TargetOrdinal>"],"kind":"ATOMIC_TARGETS_V1","relativePathPattern":"<TargetOrdinal>/target.tmp"}:OWNER_SCOPED_NO_DURABLE_REMAINS'],
    ['transientExclusions', 'project-bootstrap-v0.3', 'PROJECT', 'OWNED_DIRECTORY:0700', 'L:.omnai-bootstrap/L:v0.3.0', 'PROJECT_BOOTSTRAP_OWNER:{"allowedFixedNodes":["owner.pending","owner.json","tree"],"kind":"PROJECT_INITIALIZATION_STAGE_V1","treePolicy":"EXACT_NATIVE_PROJECT_PUBLICATION"}:OWNER_SCOPED_NO_DURABLE_REMAINS'],
    ['transientExclusions', 'project-change-stage-v1', 'PROJECT', 'OWNED_DIRECTORY:0700', 'L:.omnai/L:changes/L:.omnai-staging/T:<ProjectTransactionId>/T:<StageNonce>', 'PROJECT_TRANSACTION_OWNER:{"allowedFixedNodes":["owner.json","tree"],"kind":"PROJECT_CHANGE_STAGE_V1","treePolicy":"EXACT_TARGET_CHANGE_PUBLICATION"}:OWNER_SCOPED_NO_DURABLE_REMAINS'],
  ]);
});

test('Machine segment 拒绝 token 别名、控制/glob/percent/非 NFC/dot 并绑定 DERIVED encoding', async () => {
  const { catalog } = await loadFixturePair();
  for (const invalidLiteral of [
    '<RunId>', 'prefix<RunId>', '.', '..', 'a/b', 'a\\b', 'a\u0000b', 'a\u001fb',
    'a*b', 'a?b', 'a[b', 'a]b', 'a{b', 'a}b', 'a%b', 'cafe\u0301',
  ]) {
    const value = cloneCatalog(catalog);
    const authority = value.machineAuthority as { files: Array<{ pathSegments: Array<Record<string, unknown>> }> };
    authority.files[0]!.pathSegments[0] = { kind: 'LITERAL', value: invalidLiteral };
    assert.equal(stageAuthorityCatalogV1Schema.safeParse(value).success, false, `literal ${JSON.stringify(invalidLiteral)}`);
  }

  for (const segment of [
    { kind: 'DERIVED_FILENAME', token: '<RunId>', tokenEncoding: 'AS_IS', prefix: '', suffix: '.yaml' },
    { kind: 'DERIVED_FILENAME', token: '<AuthoritySequence>', tokenEncoding: 'AUTHORITY_SEQUENCE_6_DIGITS', prefix: 'run-', suffix: '.yaml' },
  ]) {
    const value = cloneCatalog(catalog);
    const authority = value.machineAuthority as { files: Array<{ pathSegments: Array<Record<string, unknown>> }> };
    authority.files[0]!.pathSegments[3] = segment;
    assert.equal(stageAuthorityCatalogV1Schema.safeParse(value).success, true, canonicalStrictJson(segment));
  }

  const derivedMutations = [
    { kind: 'DERIVED_FILENAME', token: '<RunId>', tokenEncoding: 'AUTHORITY_SEQUENCE_6_DIGITS', prefix: '', suffix: '.yaml' },
    { kind: 'DERIVED_FILENAME', token: '<AuthoritySequence>', tokenEncoding: 'AS_IS', prefix: '', suffix: '.yaml' },
    { kind: 'DERIVED_FILENAME', token: '<RunId>', tokenEncoding: 'AS_IS', prefix: '<raw>', suffix: '.yaml' },
    { kind: 'DERIVED_FILENAME', token: '<RunId>', tokenEncoding: 'AS_IS', prefix: '.', suffix: '.yaml' },
    { kind: 'DERIVED_FILENAME', token: '<RunId>', tokenEncoding: 'AS_IS', prefix: 'run*', suffix: '.yaml' },
    { kind: 'DERIVED_FILENAME', token: '<RunId>', tokenEncoding: 'AS_IS', prefix: 'run\u0000', suffix: '.yaml' },
    { kind: 'DERIVED_FILENAME', token: '<RunId>', tokenEncoding: 'AS_IS', prefix: '', suffix: 'a/b' },
    { kind: 'DERIVED_FILENAME', token: '<RunId>', tokenEncoding: 'AS_IS', prefix: '', suffix: 'a\\b' },
    { kind: 'DERIVED_FILENAME', token: '<RunId>', tokenEncoding: 'AS_IS', prefix: '', suffix: '%2eyaml' },
    { kind: 'DERIVED_FILENAME', token: '<RunId>', tokenEncoding: 'AS_IS', prefix: '', suffix: 'cafe\u0301' },
  ];
  for (const segment of derivedMutations) {
    const value = cloneCatalog(catalog);
    const authority = value.machineAuthority as { files: Array<{ pathSegments: Array<Record<string, unknown>> }> };
    authority.files[0]!.pathSegments[0] = segment;
    assert.equal(stageAuthorityCatalogV1Schema.safeParse(value).success, false, canonicalStrictJson(segment));
  }
});

test('Machine segment 与完整相对路径按所有实例的 UTF-8 bytes 强制 255/1024 边界', async () => {
  const { catalog } = await loadFixturePair();
  const parseWithFileSegments = (segments: Array<Record<string, unknown>>) => {
    const value = cloneCatalog(catalog);
    const authority = value.machineAuthority as { files: Array<{ pathSegments: Array<Record<string, unknown>> }> };
    authority.files[0]!.pathSegments = segments;
    return stageAuthorityCatalogV1Schema.safeParse(value).success;
  };

  assert.equal(parseWithFileSegments([{ kind: 'LITERAL', value: 'x'.repeat(255) }]), true, '255-byte literal');
  assert.equal(parseWithFileSegments([{ kind: 'LITERAL', value: 'x'.repeat(256) }]), false, '256-byte literal');
  const multibyteLiteral256 = `${'界'.repeat(85)}a`;
  assert.equal(Buffer.byteLength(multibyteLiteral256, 'utf8'), 256);
  assert.equal(parseWithFileSegments([{ kind: 'LITERAL', value: multibyteLiteral256 }]), false, '256 UTF-8 bytes');
  assert.equal(parseWithFileSegments([{
    kind: 'DERIVED_FILENAME', token: '<RunId>', tokenEncoding: 'AS_IS', prefix: 'x'.repeat(245), suffix: '',
  }]), true, '255-byte derived instance');
  assert.equal(parseWithFileSegments([{
    kind: 'DERIVED_FILENAME', token: '<RunId>', tokenEncoding: 'AS_IS', prefix: 'x'.repeat(256), suffix: '',
  }]), false, '256-byte derived prefix');
  assert.equal(parseWithFileSegments([{
    kind: 'DERIVED_FILENAME', token: '<RunId>', tokenEncoding: 'AS_IS', prefix: '', suffix: 'x'.repeat(256),
  }]), false, '256-byte derived suffix');

  const path1024 = [255, 255, 255, 254, 1].map((length, index) => ({
    kind: 'LITERAL', value: String.fromCharCode(97 + index).repeat(length),
  }));
  const path1025 = [255, 255, 255, 255, 1].map((length, index) => ({
    kind: 'LITERAL', value: String.fromCharCode(97 + index).repeat(length),
  }));
  assert.equal(parseWithFileSegments(path1024), true, '1024-byte joined path');
  assert.equal(parseWithFileSegments(path1025), false, '1025-byte joined path');
  const multibytePath1025 = [
    ...Array.from({ length: 4 }, () => ({ kind: 'LITERAL', value: '界'.repeat(85) })),
    { kind: 'LITERAL', value: 'z' },
  ];
  assert.equal(
    multibytePath1025.reduce((total, segment) => total + Buffer.byteLength(segment.value, 'utf8'), 4),
    1025,
  );
  assert.equal(parseWithFileSegments(multibytePath1025), false, '1025 UTF-8 bytes with short JS strings');

  for (const token of [
    '<DecisionId>', '<EvidenceId>', '<RevisionId>', '<RunId>', '<SignalId>', '<AuthoritySequence>',
    '<OwnerId>', '<ChangeId>', '<ProjectTransactionId>', '<TargetOrdinal>', '<StageNonce>',
    '<InvestigationDirectoryName>',
  ]) {
    assert.equal(parseWithFileSegments([{ kind: 'TOKEN', token }]), true, token);
  }
});

test('Machine 四类规则按实例语言拒绝所有 segment 组合的保守交集', async () => {
  const { catalog } = await loadFixturePair();
  const collisions: ReadonlyArray<readonly [string, Record<string, unknown>, Record<string, unknown>]> = [
    ['TOKEN vs DERIVED same RunId',
      { kind: 'TOKEN', token: '<RunId>' },
      { kind: 'DERIVED_FILENAME', token: '<RunId>', tokenEncoding: 'AS_IS', prefix: '', suffix: '' }],
    ['TOKEN RunId vs concrete literal',
      { kind: 'TOKEN', token: '<RunId>' },
      { kind: 'LITERAL', value: 'RUN-000001' }],
    ['DERIVED RunId vs concrete literal',
      { kind: 'DERIVED_FILENAME', token: '<RunId>', tokenEncoding: 'AS_IS', prefix: '', suffix: '.yaml' },
      { kind: 'LITERAL', value: 'RUN-000001.yaml' }],
    ['TOKEN positive-six vs TOKEN positive-six',
      { kind: 'TOKEN', token: '<AuthoritySequence>' },
      { kind: 'TOKEN', token: '<TargetOrdinal>' }],
    ['TOKEN RunId vs DERIVED positive-six with RUN prefix',
      { kind: 'TOKEN', token: '<RunId>' },
      { kind: 'DERIVED_FILENAME', token: '<TargetOrdinal>', tokenEncoding: 'AS_IS', prefix: 'RUN-', suffix: '' }],
    ['DERIVED RunId vs DERIVED positive-six with RUN prefix',
      { kind: 'DERIVED_FILENAME', token: '<RunId>', tokenEncoding: 'AS_IS', prefix: '', suffix: '' },
      { kind: 'DERIVED_FILENAME', token: '<TargetOrdinal>', tokenEncoding: 'AS_IS', prefix: 'RUN-', suffix: '' }],
  ];
  for (const [name, left, right] of collisions) {
    const value = cloneCatalog(catalog);
    const authority = value.machineAuthority as {
      files: Array<{ scope: string; pathSegments: Array<Record<string, unknown>> }>;
      authoredRules: Array<{ scope: string; pathSegments: Array<Record<string, unknown>> }>;
    };
    authority.files[0]!.scope = 'CHANGE';
    authority.files[0]!.pathSegments = [left];
    authority.authoredRules[0]!.scope = 'CHANGE';
    authority.authoredRules[0]!.pathSegments = [right];
    assert.equal(stageAuthorityCatalogV1Schema.safeParse(value).success, false, name);
  }

  const distinctScopes = cloneCatalog(catalog);
  const authority = distinctScopes.machineAuthority as {
    files: Array<{ scope: string; pathSegments: Array<Record<string, unknown>> }>;
    authoredRules: Array<{ scope: string; pathSegments: Array<Record<string, unknown>> }>;
  };
  authority.files[0]!.scope = 'PROJECT';
  authority.files[0]!.pathSegments = [{ kind: 'TOKEN', token: '<RunId>' }];
  authority.authoredRules[0]!.scope = 'CHANGE';
  authority.authoredRules[0]!.pathSegments = [{ kind: 'TOKEN', token: '<RunId>' }];
  assert.equal(stageAuthorityCatalogV1Schema.safeParse(distinctScopes).success, true);

  const disjointLanguages = cloneCatalog(catalog);
  const disjointAuthority = disjointLanguages.machineAuthority as {
    files: Array<{ scope: string; pathSegments: Array<Record<string, unknown>> }>;
    authoredRules: Array<{ scope: string; pathSegments: Array<Record<string, unknown>> }>;
  };
  disjointAuthority.files[0]!.scope = 'CHANGE';
  disjointAuthority.files[0]!.pathSegments = [{ kind: 'TOKEN', token: '<RunId>' }];
  disjointAuthority.authoredRules[0]!.scope = 'CHANGE';
  disjointAuthority.authoredRules[0]!.pathSegments = [{ kind: 'TOKEN', token: '<EvidenceId>' }];
  assert.equal(stageAuthorityCatalogV1Schema.safeParse(disjointLanguages).success, true);
});

test('Machine 一千条同路径规则由候选总数粗门只报告单一 comparison-budget issue', async () => {
  const { catalog } = await loadFixturePair();
  const value = cloneCatalog(catalog);
  const authority = value.machineAuthority as Record<string, unknown>;
  authority.files = [];
  authority.ownedDirectories = [];
  authority.transientExclusions = [];
  authority.authoredRules = Array.from({ length: 1_000 }, (_, index) => ({
    ruleId: `stress-ambiguous-${String(index).padStart(4, '0')}`,
    scope: 'PROJECT',
    nodeKind: 'FILE',
    pathSegments: [{ kind: 'LITERAL', value: 'same-path' }],
    policy: 'HISTORICAL_CAPTURE_ONLY',
  }));
  const result = stageAuthorityCatalogV1Schema.safeParse(value);
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.issues.length, 1);
    assert.match(result.error.issues[0]!.message, /comparison budget/u);
  }
});

test('Machine 无冲突候选总数超过十万预算时以单一 comparison-budget issue fail-closed', async () => {
  const { catalog } = await loadFixturePair();
  const value = cloneCatalog(catalog);
  const authority = value.machineAuthority as Record<string, unknown>;
  authority.files = [];
  authority.ownedDirectories = [];
  authority.transientExclusions = [];
  authority.authoredRules = Array.from({ length: 449 }, (_, index) => ({
    ruleId: `stress-budget-${String(index).padStart(4, '0')}`,
    scope: 'PROJECT',
    nodeKind: 'FILE',
    pathSegments: [{ kind: 'LITERAL', value: `path-${String(index).padStart(6, '0')}` }],
    policy: 'HISTORICAL_CAPTURE_ONLY',
  }));
  const result = stageAuthorityCatalogV1Schema.safeParse(value);
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.issues.length, 1);
    assert.match(result.error.issues[0]!.message, /comparison budget/u);
  }
});

test('Machine candidate-pair 粗门允许精确 100000 并在 100001 单 issue 拒绝', async () => {
  const { catalog } = await loadFixturePair();
  const makeCandidateCatalog = (groupSizes: readonly number[]): Record<string, unknown> => {
    const value = cloneCatalog(catalog);
    const authority = value.machineAuthority as Record<string, unknown>;
    authority.files = [];
    authority.ownedDirectories = [];
    authority.transientExclusions = [];
    authority.authoredRules = groupSizes.flatMap((groupSize, groupIndex) => (
      Array.from({ length: groupSize }, (_, ruleIndex) => ({
        ruleId: `candidate-${String(groupIndex).padStart(2, '0')}-${String(ruleIndex).padStart(4, '0')}`,
        scope: 'PROJECT',
        nodeKind: 'FILE',
        pathSegments: Array.from({ length: groupIndex + 1 }, (_, segmentIndex) => ({
          kind: 'LITERAL',
          value: `g${groupIndex}-r${String(ruleIndex).padStart(4, '0')}-s${segmentIndex}`,
        })),
        policy: 'HISTORICAL_CAPTURE_ONLY',
      }))
    ));
    return value;
  };

  const exactResult = stageAuthorityCatalogV1Schema.safeParse(makeCandidateCatalog([2, 58, 444]));
  assert.equal(exactResult.success, false);
  if (!exactResult.success) {
    assert.equal(exactResult.error.issues.length, 1);
    assert.doesNotMatch(exactResult.error.issues[0]!.message, /comparison budget/u);
    assert.match(exactResult.error.issues[0]!.message, /intersection work budget/u);
  }

  const overResult = stageAuthorityCatalogV1Schema.safeParse(makeCandidateCatalog([10, 110, 434]));
  assert.equal(overResult.success, false);
  if (!overResult.success) {
    assert.equal(overResult.error.issues.length, 1);
    assert.match(overResult.error.issues[0]!.message, /comparison budget/u);
  }
});

test('Machine 重复 TOKEN pattern 先过 candidate 粗门并在门内复用 intern language', async () => {
  const { catalog } = await loadFixturePair();
  const value = cloneCatalog(catalog);
  installSignalStressCatalog(value, 1_000);
  replaceMachineWithSignalRules(
    value,
    Array.from({ length: 1_000 }, () => ({ kind: 'TOKEN', token: '<SignalId>' })),
  );
  const result = stageAuthorityCatalogV1Schema.safeParse(value);
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.issues.length, 1);
    assert.match(result.error.issues[0]!.message, /comparison budget/u);
  }

  const withinCandidateBudget = cloneCatalog(catalog);
  installSignalStressCatalog(withinCandidateBudget, 1_000);
  replaceMachineWithSignalRules(
    withinCandidateBudget,
    Array.from({ length: 447 }, () => ({ kind: 'TOKEN', token: '<SignalId>' })),
  );
  const withinResult = stageAuthorityCatalogV1Schema.safeParse(withinCandidateBudget);
  assert.equal(withinResult.success, false);
  if (!withinResult.success) {
    assert.equal(withinResult.error.issues.length, 1);
    assert.match(withinResult.error.issues[0]!.message, /intersecting path languages/u);
  }
});

test('Machine unique DERIVED SignalId patterns 超 shape-cell construction budget 时单 issue fail-closed', async () => {
  const { catalog } = await loadFixturePair();
  const value = cloneCatalog(catalog);
  installSignalStressCatalog(value, 1_000);
  replaceMachineWithSignalRules(
    value,
    Array.from({ length: 20 }, (_, index) => ({
      kind: 'DERIVED_FILENAME',
      token: '<SignalId>',
      tokenEncoding: 'AS_IS',
      prefix: `p${String(index).padStart(4, '0')}-`,
      suffix: '.yaml',
    })),
  );
  const result = stageAuthorityCatalogV1Schema.safeParse(value);
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.issues.length, 1);
    assert.match(result.error.issues[0]!.message, /construction budget/u);
  }
});

test('Machine 500 个单字符 SignalId 与 50 个 DERIVED rules 由 intersection-work budget 单 issue 关闭', async () => {
  const { catalog } = await loadFixturePair();
  const value = cloneCatalog(catalog);
  installSingleCodePointSignalCatalog(value, 500);
  replaceMachineWithSignalRules(
    value,
    Array.from({ length: 50 }, (_, index) => ({
      kind: 'DERIVED_FILENAME',
      token: '<SignalId>',
      tokenEncoding: 'AS_IS',
      prefix: String.fromCodePoint(0x6000 + index),
      suffix: '',
    })),
  );
  const result = stageAuthorityCatalogV1Schema.safeParse(value);
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.issues.length, 1);
    assert.match(result.error.issues[0]!.message, /intersection work budget/u);
  }
});

test('Machine intersection-work budget 精确接受 100000 并在 100001 单 issue 拒绝', async () => {
  const { catalog } = await loadFixturePair();
  const makeBoundaryCatalog = (overBudget: boolean): Record<string, unknown> => {
    const value = cloneCatalog(catalog);
    installSingleCodePointSignalCatalog(value, 158);
    const authority = value.machineAuthority as Record<string, unknown>;
    authority.files = [];
    authority.ownedDirectories = [];
    authority.transientExclusions = [];
    const exactChangeSegments = [
      { kind: 'LITERAL', value: `${'a'.repeat(70)}x` },
      { kind: 'LITERAL', value: `${'a'.repeat(70)}y` },
    ];
    const overBudgetChangeSegments = [
      [
        ...Array.from({ length: 23 }, () => ({ kind: 'LITERAL', value: 'a' })),
        { kind: 'TOKEN', token: '<RunId>' },
        { kind: 'TOKEN', token: '<RunId>' },
      ],
      [
        ...Array.from({ length: 23 }, () => ({ kind: 'LITERAL', value: 'a' })),
        { kind: 'LITERAL', value: 'RUN-000000' },
        { kind: 'LITERAL', value: 'RUN-00000x' },
      ],
    ];
    authority.authoredRules = [
      {
        ruleId: 'boundary-change-left',
        scope: 'CHANGE',
        nodeKind: 'FILE',
        pathSegments: overBudget ? overBudgetChangeSegments[0] : [exactChangeSegments[0]],
        policy: 'HISTORICAL_CAPTURE_ONLY',
      },
      {
        ruleId: 'boundary-change-right',
        scope: 'CHANGE',
        nodeKind: 'FILE',
        pathSegments: overBudget ? overBudgetChangeSegments[1] : [exactChangeSegments[1]],
        policy: 'HISTORICAL_CAPTURE_ONLY',
      },
      ...['a', 'b'].map((prefix, index) => ({
        ruleId: `boundary-project-${index === 0 ? 'left' : 'right'}`,
        scope: 'PROJECT',
        nodeKind: 'FILE',
        pathSegments: [{
          kind: 'DERIVED_FILENAME',
          token: '<SignalId>',
          tokenEncoding: 'AS_IS',
          prefix,
          suffix: '',
        }],
        policy: 'HISTORICAL_CAPTURE_ONLY',
      })),
    ];
    return value;
  };

  assert.equal(stageAuthorityCatalogV1Schema.safeParse(makeBoundaryCatalog(false)).success, true);
  const overBudgetResult = stageAuthorityCatalogV1Schema.safeParse(makeBoundaryCatalog(true));
  assert.equal(overBudgetResult.success, false);
  if (!overBudgetResult.success) {
    assert.equal(overBudgetResult.error.issues.length, 1);
    assert.match(overBudgetResult.error.issues[0]!.message, /intersection work budget/u);
  }
});

test('Machine 四类按 canonical scope 与 segments 拒绝跨类别同一路径权限歧义', async () => {
  const { catalog } = await loadFixturePair();
  const value = cloneCatalog(catalog);
  const authority = value.machineAuthority as {
    files: Array<{ scope: string; pathSegments: Array<Record<string, unknown>> }>;
    authoredRules: Array<{ scope: string; pathSegments: Array<Record<string, unknown>> }>;
  };
  authority.authoredRules[0]!.scope = authority.files[0]!.scope;
  authority.authoredRules[0]!.pathSegments = authority.files[0]!.pathSegments;
  assert.equal(stageAuthorityCatalogV1Schema.safeParse(value).success, false);
});

test('QA 与 Canary policy 只覆盖有路由的 3/5 个 Scenario 且支持 requirement 精确', async () => {
  const { catalog } = await loadFixturePair();
  assert.deepEqual(catalog.qaPoliciesByScenario.map((row) => [
    row.scenarioId,
    row.policy.checks.map((check) => `${check.checkId}:${check.evidenceRequirementIds.join(',')}`),
  ]), [
    ['product-discovery', ['product-acceptance:product-acceptance', 'runtime-readiness:runtime-signal']],
    ['quality-hardening', ['independent-quality:review', 'regression-confidence:tests']],
    ['ui-ux-feature', ['accessibility:accessibility-check', 'browser-critical-flow:browser-qa']],
  ]);
  assert.deepEqual(catalog.canaryPoliciesByScenario.map((row) => [
    row.scenarioId,
    row.policy.minimumWindowSeconds,
    row.policy.signals.map((signal) => [
      signal.signalId, signal.measurementRequirementId,
      signal.sourceEvidenceRequirementIds.join(','), signal.failureAction,
    ].join(':')),
  ]), [
    ['cross-service-change', 900, ['consumer-health:canary-consumer-health:consumer-impact:PAUSE', 'technical-health:canary-technical-health:runtime-health:ROLLBACK']],
    ['data-migration', 900, ['data-integrity:canary-data-integrity:data-reconciliation:PAUSE', 'technical-health:canary-technical-health:post-migration-health:ROLLBACK']],
    ['migration-program', 900, ['migration-integrity:canary-migration-integrity:migration-reconciliation:PAUSE', 'technical-health:canary-technical-health:runtime-health:ROLLBACK']],
    ['product-discovery', 300, ['business-health:canary-business-health:product-acceptance:PAUSE', 'technical-health:canary-technical-health:runtime-signal:ROLLBACK']],
    ['ui-ux-feature', 300, ['experience-health:canary-experience-health:browser-qa:PAUSE', 'technical-health:canary-technical-health:runtime-signal:ROLLBACK']],
  ]);
});

test('QA/Canary policy 与 Scenario route 总集相等且不存在 policy orphan', async () => {
  const { catalog } = await loadFixturePair();
  const routed = (capability: 'qa' | 'canary') => catalog.scenarioProfiles
    .filter((profile) => [...profile.stages, ...profile.optionalStages].includes(capability))
    .map((profile) => profile.id)
    .sort(compareCodeUnits);
  assert.deepEqual(catalog.qaPoliciesByScenario.map((row) => row.scenarioId), routed('qa'));
  assert.deepEqual(catalog.canaryPoliciesByScenario.map((row) => row.scenarioId), routed('canary'));

  for (const [collection, orphan] of [
    ['qaPoliciesByScenario', 'small-feature'],
    ['canaryPoliciesByScenario', 'bug-fix'],
  ] as const) {
    const value = cloneCatalog(catalog);
    const policies = value[collection] as Array<Record<string, unknown>>;
    policies[0]!.scenarioId = orphan;
    policies.sort((left, right) => compareCodeUnits(String(left.scenarioId), String(right.scenarioId)));
    assert.equal(stageAuthorityCatalogV1Schema.safeParse(value).success, false, `${collection}:${orphan}`);
  }
});

test('protocol topology 锁定 1 common、3 interaction、10 Workset 与 24 repository 的完整映射', async () => {
  const { catalog } = await loadFixturePair();
  const manifests = catalog.protocolManifests;
  assert.deepEqual(manifests.filter((row) => row.kind === 'common').map((row) => row.id), [
    'common.authoritative-work',
  ]);
  assert.deepEqual(manifests.filter((row) => row.kind === 'interaction').map((row) => [row.id, row.interaction]), [
    ['interaction.brainstorm', 'brainstorm'],
    ['interaction.grill', 'grill'],
    ['interaction.show-me', 'show-me'],
  ]);
  assert.deepEqual(manifests.filter((row) => row.kind === 'workset-action').map((row) => [row.id, row.relativePath, row.actions]), [
    ['workset.candidate-research', 'resources/protocols/workset/candidate-research.md', ['inspect-project']],
    ['workset.project-change-binding', 'resources/protocols/workset/project-change-binding.md', ['bind-project-change']],
    ['workset.project-impact-decision', 'resources/protocols/workset/project-impact-decision.md', ['decide-project-impact']],
    ['workset.project-workflow-handoff', 'resources/protocols/workset/project-workflow-handoff.md', ['project-workflow']],
    ['workset.reentry-apply', 'resources/protocols/workset/reentry-apply.md', ['apply-reentry']],
    ['workset.reentry-classification', 'resources/protocols/workset/reentry-classification.md', ['record-reentry']],
    ['workset.reentry-decision', 'resources/protocols/workset/reentry-decision.md', ['decide-reentry']],
    ['workset.reentry-interaction', 'resources/protocols/workset/reentry-interaction.md', ['reenter']],
    ['workset.reentry-plan', 'resources/protocols/workset/reentry-plan.md', ['reenter']],
    ['workset.reentry-replan', 'resources/protocols/workset/reentry-replan.md', ['replan-reentry']],
  ]);
  assert.equal(manifests.filter((row) => row.kind === 'repository-capability').length, 24);

  const topologyDrift = cloneCatalog(catalog);
  const topologyManifests = topologyDrift.protocolManifests as Array<Record<string, unknown>>;
  const removedInteraction = topologyManifests.find((row) => row.id === 'interaction.show-me')!;
  Object.assign(removedInteraction, {
    id: 'workset.rogue', kind: 'workset-action', relativePath: 'resources/protocols/workset/rogue.md', actions: ['reenter'],
  });
  delete removedInteraction.interaction;
  topologyManifests.sort((left, right) => compareCodeUnits(String(left.id), String(right.id)));
  assert.equal(stageAuthorityCatalogV1Schema.safeParse(topologyDrift).success, false, '2 interaction + 11 Workset');

  const actionDrift = cloneCatalog(catalog);
  const actionManifests = actionDrift.protocolManifests as Array<Record<string, unknown>>;
  actionManifests.find((row) => row.id === 'workset.candidate-research')!.actions = ['reenter'];
  assert.equal(stageAuthorityCatalogV1Schema.safeParse(actionDrift).success, false, 'Workset action mapping drift');
});

test('生产加载器无注入时关闭，测试注入 lease 仅由持有者释放并阻止不同 catalog 并发覆盖', async () => {
  await assert.rejects(() => requireVerifiedAuthorityCatalog(), /AUTHORITY_CATALOG_UNAVAILABLE/);
  const { yamlValue, catalog } = await loadFixturePair();
  const [firstLease, secondLease] = await Promise.all([
    loadInjectedAuthorityCatalogForTest(yamlValue),
    loadInjectedAuthorityCatalogForTest(yamlValue),
  ]);
  assert.deepEqual(firstLease.catalog, catalog);
  assert.equal(await requireVerifiedAuthorityCatalog(), firstLease.catalog);
  assert.equal(secondLease.catalog, firstLease.catalog);
  assert.equal(Object.isFrozen(firstLease.catalog), true);

  const differentCatalog = cloneCatalog(catalog);
  const manifests = differentCatalog.protocolManifests as Array<Record<string, unknown>>;
  manifests.find((manifest) => manifest.id === 'repository.design')!.rawBytesHash = `sha256:${'1'.repeat(64)}`;
  await assert.rejects(
    () => loadInjectedAuthorityCatalogForTest(differentCatalog),
    /AUTHORITY_CATALOG_TEST_CONFLICT/u,
  );
  clearInjectedAuthorityCatalogForTest(firstLease);
  assert.equal(await requireVerifiedAuthorityCatalog(), secondLease.catalog);
  clearInjectedAuthorityCatalogForTest(firstLease);
  assert.equal(await requireVerifiedAuthorityCatalog(), secondLease.catalog);
  clearInjectedAuthorityCatalogForTest(secondLease);
  await assert.rejects(() => requireVerifiedAuthorityCatalog(), /AUTHORITY_CATALOG_UNAVAILABLE/);
  const replacementLease = await loadInjectedAuthorityCatalogForTest(differentCatalog);
  clearInjectedAuthorityCatalogForTest(firstLease);
  assert.equal(await requireVerifiedAuthorityCatalog(), replacementLease.catalog);
  clearInjectedAuthorityCatalogForTest(replacementLease);
});

test('test-only injection 不从 package root 导出且生产 loader 不读取 fixture', async () => {
  const [packageRoot, loaderSource, scenarioSource, protocolSource] = await Promise.all([
    readFile(join(process.cwd(), 'src', 'index.ts'), 'utf8'),
    readFile(join(process.cwd(), 'src', 'authority', 'catalog-loader.ts'), 'utf8'),
    readFile(join(process.cwd(), 'src', 'core', 'scenarios.ts'), 'utf8'),
    readFile(join(process.cwd(), 'src', 'protocols', 'catalog.ts'), 'utf8'),
  ]);
  assert.doesNotMatch(packageRoot, /authority\/catalog-loader|loadInjectedAuthorityCatalogForTest/u);
  for (const source of [loaderSource, scenarioSource, protocolSource]) {
    assert.doesNotMatch(source, /from ['"]node:fs|readFile\(|stage-authority-catalog-v1\.yaml/u);
  }
});

function assertAuthorityRegistryMutationClosed(registry: readonly string[]): void {
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
