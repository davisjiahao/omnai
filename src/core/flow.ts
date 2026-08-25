import { isProxy } from 'node:util/types';
import { z } from 'zod';
import {
  CAPABILITIES,
  baselineIdSchema,
  changeIdSchema,
  changeMetadataSchema,
  decisionBindingSchema,
  decisionIdSchema,
  decisionRecordSchema,
  flowAssessmentSchema,
  flowCapabilitySchema,
  flowPlanSchema,
  revisionIdSchema,
  scenarioProfileSchema,
  sha256Schema,
  sourceRefCollectionSchema,
  timestampSchema,
  type Capability,
  type ChangeMetadata,
  type DecisionBindingV2,
  type DecisionRecord,
  type FlowAssessment,
  type FlowCapability,
  type FlowPlan,
  type ScenarioProfile,
  type Sha256,
  type SourceRef,
} from '../domain/types.js';
import {
  guardStrictPersistentInput,
  hObject,
  requireCodeUnitSortedUnique,
} from '../domain/public.js';
import {
  createStrictJsonWorkBudget,
  preflightStrictJsonValue,
  StrictJsonBoundaryError,
} from '../domain/strict-json-internal.js';

// 背景：FlowCapability 是集合语义，final-v0.3 schema 要求 exact24 且按 capability code-unit
// 排序；若内部 compiler 直接复用公开数组，caller 的 pop/splice/元素写会永久改变后续输出与预算。
// 目的：模块初始化只从 canonical CAPABILITIES 复制、排序并冻结 private 真值；公开符号是另一个
// 冻结副本，既保留观察接口又不能污染内部编译。上下文：实际 route 顺序仍来自认证 catalog，
// 本数组只定义 final Flow 对象的规范集合顺序。
const INTERNAL_FLOW_CAPABILITY_ORDER: readonly Capability[] = Object.freeze(
  [...CAPABILITIES].sort(compareCodeUnits),
);
if (INTERNAL_FLOW_CAPABILITY_ORDER.length !== 24) {
  throw new TypeError('NATIVE_SCHEMA_MISMATCH: canonical Flow capability inventory must contain exact 24 rows');
}
export const FLOW_CAPABILITY_ORDER: readonly Capability[] = Object.freeze([
  ...INTERNAL_FLOW_CAPABILITY_ORDER,
]);

const DOMAIN_UNCERTAIN_SCENARIOS = new Set([
  'complex-domain-feature',
  'architecture-governance',
  'migration-program',
  'data-migration',
]);

const SOLUTION_UNCERTAIN_SCENARIOS = new Set([
  'product-discovery',
  'architecture-governance',
  'migration-program',
  'data-migration',
  'cross-service-change',
]);

const CROSS_MODULE_SCENARIOS = new Set([
  'architecture-governance',
  'migration-program',
  'data-migration',
]);

// 背景：Flow 会把 assessment SourceRef 投影到固定 24 个 capability，并把每个未决
// Decision SourceRef 投影到受影响 capability；即使最终 locator 去重，无上限的输入仍可
// 消耗大量 Map lookup、数组分配、排序与 canonical hash 工作。目的：10,000 次投影刚好
// 容纳 416 个全局 assessment refs（9,984 次）和 16 个单 capability Decision refs，且
// 在 final strict JSON 十万节点总门之前保留 Flow inventory/binding 所需空间。上下文：预算
// 按实际投影尝试计费；跨 Decision 的重复 locator 不返还预算，只有同一 Decision 中
// affects.research 与 OPEN AGENT 隐式 research 的同一语义 target 会去重一次。
const FLOW_SOURCE_REF_PROJECTION_WORK_BUDGET = 10_000;

// 背景：zero-ref Decision 不消耗 projection work，单靠 SourceRef 预算可让任意多行进入
// own-key 枚举、row parse 与最终 sort。目的：Decision inventory 独立按每行至少 1 次工作计费，
// 上限与 final DecisionId 四位非零命名空间的最大 distinct 基数 9,999 一致。上下文：长度门
// 在 Reflect.ownKeys 前执行；每行仍逐项消费，避免未来加入不受 length 控制的入口时静默绕过。
const FLOW_DECISION_INVENTORY_WORK_BUDGET = 9_999;
const FLOW_DECISION_CUMULATIVE_NODE_BUDGET = 500_000;
const FLOW_DECISION_CUMULATIVE_UTF8_BUDGET = 8 * 1024 * 1024;
const FLOW_DECISION_CUMULATIVE_CANONICAL_BUDGET = 16 * 1024 * 1024;

// 背景：flowInputHash 旧签名虽标注 Pick<FlowPlan>，runtime 却直接读取并排序 caller 字段，
// 类型不能阻止 accessor、超大图、unknown key、错序/重复或 IDs/bindings 漂移。目的：公开 hash
// 边界复用 final domain components，并在任何 clone/sort/hash 前对完整 raw input 做一次根级 strict
// guard 与跨字段闭包。上下文：compiler 自己生成的 input 也走同一 parser，避免内部/外部双语义。
const flowCompileInputV2RawSchema = z.strictObject({
  changeId: changeIdSchema,
  revision: revisionIdSchema,
  baseline: baselineIdSchema,
  assessment: flowAssessmentSchema,
  capabilities: z.array(flowCapabilitySchema),
  decisionIds: z.array(decisionIdSchema),
  decisionBindings: z.array(decisionBindingSchema),
}).superRefine((input, context) => {
  if (input.capabilities.length !== INTERNAL_FLOW_CAPABILITY_ORDER.length
    || input.capabilities.some((row, index) => row.capability !== INTERNAL_FLOW_CAPABILITY_ORDER[index])) {
    context.addIssue({
      code: 'custom',
      path: ['capabilities'],
      message: 'NATIVE_SCHEMA_MISMATCH: Flow input capabilities must contain exact 24 canonical rows',
    });
  }
  requireCodeUnitSortedUnique(input.decisionIds, (id) => id, context, ['decisionIds']);
  requireCodeUnitSortedUnique(input.decisionBindings, (binding) => binding.id, context, ['decisionBindings']);
  if (input.decisionIds.length !== input.decisionBindings.length
    || input.decisionIds.some((id, index) => id !== input.decisionBindings[index]?.id)) {
    context.addIssue({
      code: 'custom',
      path: ['decisionBindings'],
      message: 'NATIVE_SCHEMA_MISMATCH: Flow input Decision IDs and bindings must match one-to-one',
    });
  }
  const inventory = new Set(input.decisionIds);
  if (input.assessment.decisionIds.some((id) => !inventory.has(id))) {
    context.addIssue({
      code: 'custom',
      path: ['assessment', 'decisionIds'],
      message: 'NATIVE_SCHEMA_MISMATCH: Flow input assessment Decisions must be an inventory subset',
    });
  }
});
const flowCompileInputV2Schema = guardStrictPersistentInput(flowCompileInputV2RawSchema);
export type FlowCompileInputV2 = z.output<typeof flowCompileInputV2Schema>;

// 背景：accepted identity 来自后续 sealed authority context，但 Task 5 的纯 assertor 仍必须把
// 它视为 hostile caller data。目的：根级 guard 在比较前拒绝 getter/unknown/超大图，并锁定
// binding 的 code-unit sorted unique 形态；不得以 hObject 直接观察未解析对象。
const flowAuthorityIdentityV2RawSchema = z.strictObject({
  decisionBindings: z.array(decisionBindingSchema),
  flowHash: sha256Schema,
}).superRefine((identity, context) => {
  requireCodeUnitSortedUnique(identity.decisionBindings, (binding) => binding.id, context, ['decisionBindings']);
});
const flowAuthorityIdentityV2Schema = guardStrictPersistentInput(flowAuthorityIdentityV2RawSchema);
export interface FlowAuthorityIdentityV2 {
  readonly decisionBindings: readonly DecisionBindingV2[];
  readonly flowHash: Sha256;
}

export function createInitialFlowAssessment(
  metadata: ChangeMetadata,
  scenario: ScenarioProfile,
  sourceRefs: readonly SourceRef[],
): FlowAssessment {
  const parsedMetadata = changeMetadataSchema.parse(metadata);
  const parsedScenario = scenarioProfileSchema.parse(scenario);
  const parsedSourceRefs = sourceRefCollectionSchema.parse(sourceRefs);
  assertScenarioAdjacency(parsedMetadata, parsedScenario);
  const topology = parsedScenario.id === 'cross-service-change'
    ? 'CROSS_PROJECT'
    : CROSS_MODULE_SCENARIOS.has(parsedScenario.id)
      ? 'CROSS_MODULE'
      : 'SINGLE_MODULE';
  const deliveryShape = parsedMetadata.workMode === 'MIGRATION'
    ? 'MIGRATION'
    : parsedMetadata.risk.level === 'P0' || parsedMetadata.risk.level === 'P1'
      ? 'HIGH_RISK'
      : 'STANDARD';

  return flowAssessmentSchema.parse({
    scale: parsedScenario.id === 'migration-program'
      ? 'PROGRAM'
      : parsedScenario.id === 'small-feature' || parsedScenario.id === 'bug-fix'
        ? 'LOCAL'
        : 'CHANGE',
    uncertainty: {
      problem: parsedScenario.id === 'product-discovery' ? 'OPEN' : 'CLEAR',
      domain: DOMAIN_UNCERTAIN_SCENARIOS.has(parsedScenario.id) ? 'OPEN' : 'CLEAR',
      solution: SOLUTION_UNCERTAIN_SCENARIOS.has(parsedScenario.id) ? 'OPEN' : 'CLEAR',
      delivery: parsedMetadata.workMode === 'MIGRATION'
        || parsedMetadata.workMode === 'RELEASE'
        || parsedMetadata.risk.level === 'P0'
        ? 'OPEN'
        : 'CLEAR',
    },
    topology,
    architectureApplicability: topology === 'CROSS_PROJECT'
      ? 'FULL'
      : topology === 'CROSS_MODULE'
        ? 'FOCUSED'
        : 'NOT_APPLICABLE',
    deliveryShape,
    decisionIds: [],
    // sourceRefCollectionSchema 已要求 caller 提供 code-unit sorted unique；这里绝不 repair。
    sourceRefs: parsedSourceRefs,
  });
}

export function compileFlowPlan(
  metadata: ChangeMetadata,
  scenario: ScenarioProfile,
  assessment: FlowAssessment,
  decisions: readonly DecisionRecord[],
  compiledAt: string,
): FlowPlan {
  // 五类 caller 输入先完成 strict parse；尤其 compiledAt 在 Decision inventory/budget 前解析，
  // 使无效时间戳不能迫使系统先处理巨大 inventory。
  const parsedMetadata = changeMetadataSchema.parse(metadata);
  const parsedScenario = scenarioProfileSchema.parse(scenario);
  const normalizedAssessment = flowAssessmentSchema.parse(assessment);
  const parsedCompiledAt = timestampSchema.parse(compiledAt);
  assertScenarioAdjacency(parsedMetadata, parsedScenario);
  const sortedDecisions = normalizeDecisionsWithinProjectionBudget(
    normalizedAssessment,
    decisions,
    parsedMetadata.id,
  );
  const required = new Set(parsedScenario.stages);
  const promotions = assessmentPromotions(parsedMetadata, normalizedAssessment);
  const projectedSources = initializeProjectedSources(normalizedAssessment.sourceRefs);

  for (const decision of sortedDecisions) {
    // 只有 OPEN/BLOCKED 是当前 Flow source；RESOLVED/REJECTED/SUPERSEDED 仍由完整
    // DecisionBinding 保留历史身份，但不得继续影响当前 capability source projection。
    if (decision.status === 'OPEN' || decision.status === 'BLOCKED') {
      for (const capability of decisionProjectionTargets(decision)) {
        promotions.add(capability);
        const bucket = projectedSources.get(capability)!;
        // 单次 Map 插入替代旧 `[...累计数组, ...新引用]`。相同 locator 保留先到值，
        // 与旧稳定 sort+unique 的 assessment 优先、Decision ID 顺序优先语义一致。
        for (const sourceRef of decision.sourceRefs) {
          const key = sourceRefKey(sourceRef);
          if (!bucket.has(key)) bucket.set(key, sourceRef);
        }
      }
    }
  }

  const capabilities = INTERNAL_FLOW_CAPABILITY_ORDER.map((capability): FlowCapability => {
    const isRequired = required.has(capability);
    const active = isRequired || promotions.has(capability);
    return {
      capability,
      disposition: isRequired ? 'REQUIRED' : 'CONDITIONAL',
      active,
      reason: isRequired
        ? `Scenario floor: ${parsedScenario.id}`
        : active
          ? 'Promoted by flow assessment or decision'
          : 'Not promoted by current flow inputs',
      // 每个 capability 在所有线性插入完成后只排序一次；没有循环内累计复制。
      sourceRefs: sortSourceRefs([...projectedSources.get(capability)!.values()]),
    };
  });
  const decisionIds = sortedDecisions.map((decision) => decision.id);
  const decisionBindings = sortedDecisions.map(decisionBinding);
  assertAssessmentDecisionBindingClosure(normalizedAssessment, decisionBindings);
  const input: FlowCompileInputV2 = {
    changeId: parsedMetadata.id,
    revision: parsedMetadata.activeRevision,
    baseline: parsedMetadata.baseline,
    assessment: normalizedAssessment,
    capabilities,
    decisionIds,
    decisionBindings,
  };

  return flowPlanSchema.parse({
    schemaVersion: 2,
    ...input,
    inputHash: flowInputHash(input),
    compiledAt: parsedCompiledAt,
  });
}

export function decisionBinding(record: DecisionRecord): DecisionBindingV2 {
  const parsed = decisionRecordSchema.parse(record);
  return { id: parsed.id, contentHash: hObject(parsed) };
}

export function flowInputHash(input: FlowCompileInputV2): Sha256 {
  // caller 必须已经提供 final canonical collection；hash 边界只 parse，不 repair/sort。
  const parsed = flowCompileInputV2Schema.parse(input);
  assertAssessmentDecisionBindingClosure(parsed.assessment, parsed.decisionBindings);
  return hObject(parsed);
}

function flowCompileInputFromPlan(plan: FlowPlan): FlowCompileInputV2 {
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

export function hashFlowPlan(plan: FlowPlan): Sha256 {
  const parsed = flowPlanSchema.parse(plan);
  // 背景：final FlowPlan domain schema 只锁定 capability 集合的排序与唯一性，不负责 exact24
  // 编译身份闭包，因而零行或缺少 canonical row 仍可到达 HObject。目的：完整 Flow 先安全解析，
  // 再把其 input projection 交给 flowInputHash 共用的唯一 validator；不得另写、排序或修复 caller。
  // 上下文：final 持久 schema 与公开 API 均不改变，只有 hash 边界在 HObject 前补齐既有闭包。
  flowInputHash(flowCompileInputFromPlan(parsed));
  return hObject(parsed);
}

// 背景：仅比较 caller 重算后的 Flow 会把“Decision 与 Flow 一起重写”误认为合法。
// 目的：先用当前完整 Decision inventory 重建绑定，再把候选 Flow 与已接受 authority payload
// 同时比较；body-only 与 coherent rewrite 因而分别在 binding 层和 accepted identity 层关闭。
// 上下文：本函数是 Plans 02–03 writer/context 接入前的纯 mismatch oracle，不读取或伪造 envelope。
export function assertDecisionFlowIdentityV2(
  plan: FlowPlan,
  decisions: readonly DecisionRecord[],
  accepted: FlowAuthorityIdentityV2,
): void {
  const parsed = flowPlanSchema.parse(plan);
  const parsedAccepted = flowAuthorityIdentityV2Schema.parse(accepted);
  const normalizedDecisions = normalizeDecisionsWithinProjectionBudget(
    parsed.assessment,
    decisions,
    parsed.changeId,
  );
  const expectedBindings = normalizedDecisions.map(decisionBinding);
  assertAssessmentDecisionBindingClosure(parsed.assessment, expectedBindings);
  const expectedIds = expectedBindings.map(({ id }) => id);
  if (hObject(parsed.decisionBindings) !== hObject(expectedBindings)
    || hObject(parsed.decisionIds) !== hObject(expectedIds)) {
    throw new Error('FLOW_DECISION_BINDING_MISMATCH');
  }
  if (parsed.inputHash !== flowInputHash(flowCompileInputFromPlan(parsed))) {
    throw new Error('FLOW_INPUT_HASH_MISMATCH');
  }
  if (hObject(parsed.decisionBindings) !== hObject(parsedAccepted.decisionBindings)
    || hObject(parsed) !== parsedAccepted.flowHash) {
    throw new Error('FLOW_ACCEPTED_IDENTITY_MISMATCH');
  }
}

function assertScenarioAdjacency(metadata: ChangeMetadata, scenario: ScenarioProfile): void {
  if (metadata.scenario !== scenario.id || metadata.workMode !== scenario.workMode) {
    throw new Error('FLOW_SCENARIO_ADJACENCY_MISMATCH');
  }
}

// 背景：FlowAssessment 已把 Decision ID 与 SourceRef locator 做集合闭合，但 contentHash 仍可由
// caller 自报。目的：constructor、input hash、完整 Flow hash 与 accepted assertor 共用一个
// binding adjacency oracle；每个 assessment Decision ref 必须命中当前完整 Decision binding。
// 上下文：这里只比较认证 preimage，不重算、排序或修复任何 caller-provided hash。
function assertAssessmentDecisionBindingClosure(
  assessment: FlowAssessment,
  decisionBindings: readonly DecisionBindingV2[],
): void {
  const bindingById = new Map(decisionBindings.map((binding) => [binding.id, binding.contentHash]));
  for (const sourceRef of assessment.sourceRefs) {
    if (sourceRef.kind === 'decision'
      && bindingById.get(sourceRef.decisionId) !== sourceRef.contentHash) {
      throw new Error('FLOW_ASSESSMENT_DECISION_BINDING_MISMATCH');
    }
  }
}

function assessmentPromotions(metadata: ChangeMetadata, assessment: FlowAssessment): Set<Capability> {
  const promotions = new Set<Capability>();
  if (assessment.scale === 'PROGRAM') promotions.add('map');
  if (assessment.uncertainty.problem !== 'CLEAR' || assessment.uncertainty.delivery !== 'CLEAR') promotions.add('research');
  if (assessment.uncertainty.domain !== 'CLEAR') {
    promotions.add('model');
    promotions.add('research');
  }
  if (assessment.uncertainty.solution !== 'CLEAR') promotions.add('design');
  if (
    assessment.topology === 'CROSS_MODULE' ||
    assessment.topology === 'CROSS_PROJECT' ||
    assessment.architectureApplicability === 'FOCUSED' ||
    assessment.architectureApplicability === 'FULL'
  ) {
    promotions.add('design');
    promotions.add('review');
  }
  if (assessment.topology === 'CROSS_PROJECT') {
    addPromotions(promotions, ['spec', 'design', 'review', 'verify', 'ship']);
  }
  if (assessment.deliveryShape === 'MIGRATION') {
    addPromotions(promotions, ['map', 'design', 'review', 'verify', 'ship']);
  }
  if (assessment.deliveryShape === 'HIGH_RISK') {
    addPromotions(promotions, ['review', 'verify', 'ship']);
  }
  if (metadata.risk.level === 'P0' || metadata.risk.level === 'P1') promotions.add('review');
  return promotions;
}

function addPromotions(target: Set<Capability>, capabilities: readonly Capability[]): void {
  for (const capability of capabilities) target.add(capability);
}

function sortSourceRefs(sourceRefs: readonly SourceRef[]): SourceRef[] {
  return [...sourceRefs].sort((left, right) => compareCodeUnits(sourceRefKey(left), sourceRefKey(right)));
}

function initializeProjectedSources(
  assessmentSourceRefs: readonly SourceRef[],
): Map<Capability, Map<string, SourceRef>> {
  const projected = new Map<Capability, Map<string, SourceRef>>();
  for (const capability of INTERNAL_FLOW_CAPABILITY_ORDER) {
    const bucket = new Map<string, SourceRef>();
    for (const sourceRef of assessmentSourceRefs) bucket.set(sourceRefKey(sourceRef), sourceRef);
    projected.set(capability, bucket);
  }
  return projected;
}

function decisionProjectionTargets(decision: DecisionRecord): Set<Capability> {
  const targets = new Set<Capability>(decision.affects.capabilities);
  if (decision.status === 'OPEN' && decision.owner === 'AGENT') targets.add('research');
  return targets;
}

function normalizeDecisionsWithinProjectionBudget(
  assessment: FlowAssessment,
  decisions: readonly DecisionRecord[],
  expectedChangeId?: string,
): DecisionRecord[] {
  const projectionBudget = { remaining: FLOW_SOURCE_REF_PROJECTION_WORK_BUDGET };
  const inventoryBudget = { remaining: FLOW_DECISION_INVENTORY_WORK_BUDGET };
  // 背景：逐行 domain guard 会把 raw/canonical 预算重置为零；共享大 scalar 或许多合法
  // structural rows 因而可在 9999 inventory 门内放大完整工作。目的：一个 accumulator 按每次
  // JSON 语义出现计费，并在观察下一 hostile row 前关闭。上下文：该门不替代 projection budget。
  const rawWorkBudget = createStrictJsonWorkBudget({
    maximumDepth: 512,
    maximumNodes: FLOW_DECISION_CUMULATIVE_NODE_BUDGET,
    maximumUtf8Bytes: FLOW_DECISION_CUMULATIVE_UTF8_BUDGET,
    maximumCanonicalBytes: FLOW_DECISION_CUMULATIVE_CANONICAL_BUDGET,
  });
  consumeProjectionWork(
    projectionBudget,
    assessment.sourceRefs.length,
    INTERNAL_FLOW_CAPABILITY_ORDER.length,
  );
  const normalized: DecisionRecord[] = [];
  const seenDecisionIds = new Set<string>();
  const decisionCount = strictDecisionInventoryLength(decisions);
  for (let index = 0; index < decisionCount; index += 1) {
    consumeDecisionInventoryWork(inventoryBudget);
    const rawDecision = strictDecisionInventoryValue(decisions, index);
    try {
      // 累计预算与后续 schema 必须观察同一份 own-data 认证投影；若这里只验证后仍传 rawDecision，
      // Object.prototype 的 inherited question 可在 Zod 阶段重新出现并逃逸跨行 UTF-8/canonical 计费。
      const authenticatedDecision = preflightStrictJsonValue(rawDecision, rawWorkBudget);
      const parsed = decisionRecordSchema.parse(authenticatedDecision);
      if (expectedChangeId !== undefined && parsed.changeId !== expectedChangeId) {
        throw new Error('FLOW_DECISION_CHANGE_MISMATCH');
      }
      if (seenDecisionIds.has(parsed.id)) {
        throw new Error(`FLOW_DECISION_ID_CONFLICT: ${parsed.id}`);
      }
      seenDecisionIds.add(parsed.id);
      if (parsed.status === 'OPEN' || parsed.status === 'BLOCKED') {
        consumeProjectionWork(
          projectionBudget,
          parsed.sourceRefs.length,
          decisionProjectionTargets(parsed).size,
        );
      }
      normalized.push(parsed);
    } catch (error) {
      if (!(error instanceof StrictJsonBoundaryError)) throw error;
      if (error.code === 'NODE_BUDGET') {
        throw new TypeError('FLOW_DECISION_CUMULATIVE_NODE_BUDGET_EXCEEDED');
      }
      if (error.code === 'UTF8_BUDGET') {
        throw new TypeError('FLOW_DECISION_CUMULATIVE_UTF8_BUDGET_EXCEEDED');
      }
      if (error.code === 'CANONICAL_BUDGET') {
        throw new TypeError('FLOW_DECISION_CUMULATIVE_CANONICAL_BUDGET_EXCEEDED');
      }
      throw new TypeError(`NATIVE_SCHEMA_MISMATCH: Decision row is not strict JSON: ${error.message}`);
    }
  }

  // 预算检查已经完成，之后只进行一次 Decision 排序；这里没有按累计前缀反复复制。
  normalized.sort((left, right) => compareCodeUnits(left.id, right.id));
  return normalized;
}

// 背景：对 Decision inventory 直接 for-of 会在任何 row schema 前读取 caller 的
// Symbol.iterator / index getter；但把整个多千行 inventory 交给十万节点 deep guard 又会在
// 10,002 次投影预算之前误伤 round 1 的合法压力模型。目的：这里只用 descriptors 验证外层是
// 普通、稠密、无扩展属性的数据数组，随后每一 row 复用 decisionRecordSchema 的完整 deep guard。
// 上下文：本函数只验证 outer container 并返回长度，不复制 caller 数组；每行随后从 data
// descriptor 取值并立即消费 projection budget，仍不执行 caller index getter。
function strictDecisionInventoryLength(
  decisions: readonly DecisionRecord[],
): number {
  // 背景：Array.isArray 对 revoked Proxy 会抛错，而 length descriptor 对 throwing Proxy 会执行
  // caller trap。目的：无 trap 的身份检测必须是 outer object 的第一项操作；所有 Proxy 不论大小
  // 都统一走 strict-dense mismatch，plain array 才进入 9999 长度门。
  if (isProxy(decisions) || !Array.isArray(decisions)) {
    throw new TypeError('NATIVE_SCHEMA_MISMATCH: Decision inventory must be a strict dense array');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(decisions, 'length');
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
    throw new TypeError('NATIVE_SCHEMA_MISMATCH: Decision inventory length is invalid');
  }
  const length = lengthDescriptor.value;

  if (length > FLOW_DECISION_INVENTORY_WORK_BUDGET) {
    throw new TypeError(
      `FLOW_DECISION_INVENTORY_BUDGET_EXCEEDED: maximum ${FLOW_DECISION_INVENTORY_WORK_BUDGET} Decision rows`,
    );
  }

  if (Object.getPrototypeOf(decisions) !== Array.prototype) {
    throw new TypeError('NATIVE_SCHEMA_MISMATCH: Decision inventory must be a strict dense array');
  }

  // Reflect.ownKeys 会一次性分配完整 key 列表。对于 length 很小却挂载大量 enumerable 扩展键
  // 的普通数组，先用惰性枚举核对恰好 0..length-1：遇到首个扩展/稀疏/继承键即关闭，不先物化
  // 全部 keys。普通 Array 的整数键枚举顺序由规范固定；Proxy 已拒绝，所以 caller 不能伪造顺序。
  let enumerableIndex = 0;
  for (const key in decisions) {
    if (key !== String(enumerableIndex) || enumerableIndex >= length) {
      throw new TypeError('NATIVE_SCHEMA_MISMATCH: Decision inventory must not be sparse or extended');
    }
    enumerableIndex += 1;
  }
  if (enumerableIndex !== length) {
    throw new TypeError('NATIVE_SCHEMA_MISMATCH: Decision inventory must not be sparse or extended');
  }

  // 惰性 enumerable 检查不覆盖 symbol/non-enumerable 扩展；在 length<=9999 的有界普通数组上
  // 最后执行一次 Reflect.ownKeys，锁定只含 dense indices 与不可枚举 length 的 exact outer 闭包。
  const ownKeys = Reflect.ownKeys(decisions);
  if (ownKeys.length !== length + 1
    || ownKeys[length] !== 'length'
    || ownKeys.slice(0, length).some((key, index) => key !== String(index))) {
    throw new TypeError('NATIVE_SCHEMA_MISMATCH: Decision inventory must not be sparse or extended');
  }

  return length;
}

function strictDecisionInventoryValue(
  decisions: readonly DecisionRecord[],
  index: number,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(decisions, String(index));
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    throw new TypeError('NATIVE_SCHEMA_MISMATCH: Decision inventory entries must be enumerable data properties');
  }
  return descriptor.value;
}

function consumeDecisionInventoryWork(budget: { remaining: number }): void {
  // length 前门已确保当前入口不超过 9,999；仍逐行扣费，使以后复用本循环的新入口不能因
  // zero-ref row 不消耗 projection work 而绕过独立 inventory 上限。
  if (budget.remaining < 1) {
    throw new TypeError(
      `FLOW_DECISION_INVENTORY_BUDGET_EXCEEDED: maximum ${FLOW_DECISION_INVENTORY_WORK_BUDGET} Decision rows`,
    );
  }
  budget.remaining -= 1;
}

function consumeProjectionWork(
  budget: { remaining: number },
  sourceRefCount: number,
  targetCount: number,
): void {
  // 两个长度都来自已 strict parse 的真实数组；用除法先判界，避免乘法溢出后再比较。
  if (!Number.isSafeInteger(sourceRefCount) || !Number.isSafeInteger(targetCount)
    || sourceRefCount < 0 || targetCount < 0
    || (targetCount > 0 && sourceRefCount > Math.floor(budget.remaining / targetCount))) {
    throw new TypeError(
      `FLOW_SOURCE_REF_PROJECTION_BUDGET_EXCEEDED: maximum ${FLOW_SOURCE_REF_PROJECTION_WORK_BUDGET} projected SourceRefs`,
    );
  }
  budget.remaining -= sourceRefCount * targetCount;
}

function sourceRefKey(sourceRef: SourceRef): string {
  const locator = sourceRef.kind === 'artifact' || sourceRef.kind === 'code' ? sourceRef.path
    : sourceRef.kind === 'policy' ? sourceRef.scenarioId
      : sourceRef.kind === 'evidence' ? sourceRef.evidenceId
        : sourceRef.kind === 'decision' ? sourceRef.decisionId
          : sourceRef.taskId;
  return `${sourceRef.kind}\u0000${locator}`;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
