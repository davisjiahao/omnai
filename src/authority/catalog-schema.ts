import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CAPABILITIES,
  READINESS_KEYS,
  RECONCILE_LEVELS,
  SCENARIO_IDS,
  changeArtifactDirectorySchema,
  changeArtifactPathSchema,
  guardStrictPersistentInput,
  nonemptySingleLineSchema,
  nonnegativeSafeIntegerSchema,
  persistedSha256Schema,
  requireCodeUnitSortedUnique,
} from '../domain/public.js';
import { scenarioProfileSchema } from '../domain/change.js';
import type { Sha256 } from '../domain/scalars.js';
import { canonicalizeStrictJson, type StrictJsonWorkLimits } from '../domain/strict-json-internal.js';

function freezeAuthorityRegistry<const Values extends readonly string[]>(values: Values): Values {
  return Object.freeze([...values]) as unknown as Values;
}

// 背景：authority catalog 会进入 WorkflowLock 的哈希边界，localeCompare 会让相同目录在不同
// locale/ICU 版本下得到不同顺序。目的：所有 set 语义一律按 JavaScript UTF-16 code-unit
// 顺序校验和规范化。上下文：routeOrder、stages、gates 等作者顺序字段不调用此比较器。
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireSortedUnique<T>(
  values: readonly T[],
  key: (value: T) => string,
  context: z.RefinementCtx,
  path: Array<string | number>,
): void {
  requireCodeUnitSortedUnique([...values], key, context, path);
}

function requireUnique<T>(
  values: readonly T[],
  key: (value: T) => string,
  context: z.RefinementCtx,
  path: Array<string | number>,
): void {
  if (new Set(values.map(key)).size !== values.length) {
    context.addIssue({ code: 'custom', path, message: 'AUTHORITY_CATALOG_MISMATCH: collection must be unique' });
  }
}

const sortedStringArraySchema = z.array(nonemptySingleLineSchema).superRefine((values, context) => {
  requireSortedUnique(values, (value) => value, context, []);
});
const changeContextPathSchema = z.union([changeArtifactPathSchema, changeArtifactDirectorySchema]);
const uniqueChangeContextPathArraySchema = z.array(changeContextPathSchema).superRefine((values, context) => {
  requireUnique(values, (value) => value, context, []);
});
const capabilitySchema = z.enum(CAPABILITIES);
const sha256Schema = persistedSha256Schema;

const STAGE_COMPILER_ARTIFACT_ID_VALUES = freezeAuthorityRegistry([
  'canary-policy-by-scenario-v1',
  'delivery-policy-v1',
  'prompt-render-v1',
  'qa-policy-by-scenario-v1',
  'review-policy-v1',
  'run-descendants-v1',
  'scenario-detection-v1',
  'stage-completion-v1',
  'stage-terminal-v1',
  'verify-scenario-task-evidence-v1',
] as const);
export const STAGE_COMPILER_ARTIFACT_IDS = freezeAuthorityRegistry(STAGE_COMPILER_ARTIFACT_ID_VALUES);

const compilerArtifactSchema = z.strictObject({
  compilerId: z.enum(STAGE_COMPILER_ARTIFACT_ID_VALUES),
  resourcePath: z.string().regex(/^resources\/authority\/compilers\/[a-z0-9-]+-v1\.fn\.js$/),
  format: z.literal('VM_FUNCTION_EXPRESSION_V1'),
  entryName: z.literal('compile'),
  contentHash: sha256Schema,
}).superRefine((artifact, context) => {
  const expected = `resources/authority/compilers/${artifact.compilerId}.fn.js`;
  if (artifact.resourcePath !== expected) {
    context.addIssue({ code: 'custom', path: ['resourcePath'], message: 'AUTHORITY_CATALOG_MISMATCH: compiler path must bind compilerId' });
  }
});

const compilerRuntimeSchema = z.strictObject({
  runtimeId: z.literal('compiler-runtime-v1'),
  resourcePath: z.literal('resources/authority/compilers/compiler-runtime-v1.mjs'),
  format: z.literal('HASH_VERIFIED_VM_RUNTIME_ESM'),
  allowedStaticImports: z.tuple([z.literal('node:vm')]),
  exportName: z.literal('invoke'),
  contentHash: sha256Schema,
});

const issueTerminalPredicateSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('TRIAGE_STATE_IN'),
    values: z.tuple([
      z.literal('needs-experiment'), z.literal('ready-for-debug'), z.literal('ready-for-fix'),
      z.literal('ready-for-human'), z.literal('wontfix'),
    ]),
  }),
  z.strictObject({
    kind: z.literal('REPRODUCTION_IN'),
    values: z.tuple([z.literal('confirmed'), z.literal('instrumentation-required')]),
  }),
  z.strictObject({ kind: z.literal('ROOT_CAUSE_IS'), value: z.literal('confirmed') }),
  z.strictObject({
    kind: z.literal('FIX_STRATEGY_IN'),
    values: z.tuple([z.literal('needs-experiment'), z.literal('ready')]),
  }),
]);

const runOutputTemplateSchema = z.union([
  z.strictObject({ kind: z.literal('ARTIFACT_AUTHORITY_SET'), selectionFormula: z.literal('CAPABILITY_AND_ACTIVE_SCENARIO') }),
  z.strictObject({ kind: z.literal('TASKFILE_DRAFT'), role: z.literal('TASKFILE_DRAFT'), pathTemplate: z.literal('stage-outputs/<RunId>/tasks.draft.yaml') }),
  z.strictObject({ kind: z.literal('REVIEW_DRAFT'), role: z.literal('REVIEW_DRAFT'), pathTemplate: z.literal('stage-outputs/<RunId>/review.draft.json'), schemaIdentity: z.literal('omnai.review-draft.v2') }),
  z.strictObject({ kind: z.literal('QA_DRAFT'), role: z.literal('QA_DRAFT'), pathTemplate: z.literal('stage-outputs/<RunId>/qa.draft.json'), schemaIdentity: z.literal('omnai.qa-result-draft.v1') }),
  z.strictObject({ kind: z.literal('CANARY_DRAFT'), role: z.literal('CANARY_DRAFT'), pathTemplate: z.literal('stage-outputs/<RunId>/canary.draft.json'), schemaIdentity: z.literal('omnai.canary-result-draft.v1') }),
  z.strictObject({ kind: z.literal('REPOSITORY_DIFF'), role: z.literal('IMPLEMENTATION_DIFF'), taskIdFormula: z.literal('SELECTED_TASK'), basisFormula: z.literal('PREPARED_REPOSITORY_BASIS') }),
  z.strictObject({ kind: z.literal('REPOSITORY_DIFF'), role: z.literal('SIMPLIFICATION_DIFF'), taskIdFormula: z.literal('NONE'), basisFormula: z.literal('PREPARED_REPOSITORY_BASIS') }),
]);

const policyBindingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('NONE') }),
  z.strictObject({ kind: z.literal('REVIEW_POLICY_COMPILER_V1'), compilerId: z.literal('review-policy-v1') }),
  z.strictObject({ kind: z.literal('QA_POLICY_BY_SCENARIO_V1'), compilerId: z.literal('qa-policy-by-scenario-v1') }),
  z.strictObject({ kind: z.literal('CANARY_POLICY_BY_SCENARIO_V1'), compilerId: z.literal('canary-policy-by-scenario-v1') }),
  z.strictObject({ kind: z.literal('VERIFY_SCENARIO_AND_TASK_EVIDENCE_V1'), compilerId: z.literal('verify-scenario-task-evidence-v1') }),
  z.strictObject({ kind: z.literal('DELIVERY_POLICY_V1'), compilerId: z.literal('delivery-policy-v1') }),
]);

export const capabilityTemplateSchema = z.strictObject({
  capability: capabilitySchema,
  readinessKey: z.enum(READINESS_KEYS).nullable(),
  terminalKind: z.enum([
    'ARTIFACT_STAGE', 'PLAN_STAGE', 'ISSUE_STAGE', 'WORK_STAGE', 'SIMPLIFY_STAGE',
    'REVIEW_STAGE', 'VERIFY_STAGE', 'QA_STAGE', 'DELIVERY_STAGE', 'CANARY_STAGE',
    'ARCHIVE_STAGE', 'RECONCILE_STAGE',
  ]),
  terminalCompilerId: z.literal('stage-terminal-v1'),
  descendantCompilerId: z.literal('run-descendants-v1'),
  contextPaths: uniqueChangeContextPathArraySchema,
  authoredOutputs: z.array(runOutputTemplateSchema),
  baseEvidenceRequirementIds: sortedStringArraySchema,
  humanGateIds: sortedStringArraySchema,
  issuePredicates: z.array(issueTerminalPredicateSchema).superRefine((values, context) => {
    requireSortedUnique(values, (value) => value.kind, context, []);
  }),
  policyBinding: policyBindingSchema,
});

const evidenceRecordTypeSchema = z.enum([
  'build', 'test', 'lint', 'typecheck', 'review', 'qa', 'security', 'migration',
  'runtime', 'manual', 'contract', 'data', 'rollback', 'reproduction',
]);
const evidenceProducerSchema = z.enum([
  'GENERIC_IMPORT', 'VERIFICATION_COMMAND', 'REVIEW_RESULT_IMPORT', 'QA_RESULT_IMPORT',
  'CANARY_MEASUREMENT_IMPORT', 'CANARY_RESULT_IMPORT',
]);
export const evidenceTemplateSchema = z.strictObject({
  requirementId: nonemptySingleLineSchema,
  producer: evidenceProducerSchema,
  allowedTypes: z.array(evidenceRecordTypeSchema).min(1).superRefine((values, context) => {
    requireSortedUnique(values, (value) => value, context, []);
  }),
  allowedStatuses: z.tuple([z.literal('FAIL'), z.literal('INCONCLUSIVE'), z.literal('PASS')]),
  satisfyingStatus: z.literal('PASS'),
  outputPolicy: z.literal('OWNED_OUTPUT_REQUIRED'),
  sourceScope: z.literal('RUN_BOUND'),
  subjectPolicy: z.literal('EXACT_RUN_SUBJECT'),
  taskScopeFormula: z.enum(['NONE', 'SELECTED_TASK', 'REVIEW_SCOPE', 'TASK_DECLARED', 'EACH_VERIFICATION_TASK']),
  minimumRecords: z.literal(1),
});

export const humanGateSchema = z.strictObject({
  gateId: nonemptySingleLineSchema,
  sourceScope: z.literal('RUN_BOUND'),
  approvedArtifactRole: nonemptySingleLineSchema.nullable(),
});

export const qaPolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  checks: z.tuple([z.strictObject({
    checkId: nonemptySingleLineSchema,
    evidenceRequirementIds: sortedStringArraySchema,
  })]).rest(z.strictObject({
    checkId: nonemptySingleLineSchema,
    evidenceRequirementIds: sortedStringArraySchema,
  })).superRefine((values, context) => requireSortedUnique(values, (value) => value.checkId, context, [])),
  findingVerdicts: z.strictObject({ CRITICAL: z.literal('FAIL'), IMPORTANT: z.literal('CONCERNS'), MINOR: z.literal('PASS') }),
});

const canarySignalSchema = z.strictObject({
  signalId: nonemptySingleLineSchema,
  unit: z.literal('normalized-pass'),
  threshold: z.strictObject({ kind: z.literal('GTE'), limit: z.literal(1) }),
  failureAction: z.enum(['PAUSE', 'ROLLBACK']),
  measurementRequirementId: nonemptySingleLineSchema,
  sourceEvidenceRequirementIds: z.tuple([nonemptySingleLineSchema]).rest(nonemptySingleLineSchema).superRefine((values, context) => {
    requireSortedUnique(values, (value) => value, context, []);
  }),
  aggregation: z.literal('EXACT_ONE'),
});
export const canaryPolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  minimumWindowSeconds: z.union([z.literal(300), z.literal(900)]),
  signals: z.tuple([canarySignalSchema]).rest(canarySignalSchema).superRefine((values, context) => {
    requireSortedUnique(values, (value) => value.signalId, context, []);
    requireSortedUnique(values, (value) => value.measurementRequirementId, context, []);
  }),
});

const artifactActivationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ALWAYS') }),
  z.strictObject({ kind: z.literal('SCENARIO_REQUIRES_ARTIFACT_OR_IMPACT'), path: z.literal('contract.md'), impactKey: z.literal('apiContract') }),
]);
const scaffoldResourcePathSchema = z.string().refine((value) => {
  const prefix = 'resources/scaffolds/';
  return value.startsWith(prefix) && changeArtifactPathSchema.safeParse(value.slice(prefix.length)).success;
}, 'AUTHORITY_CATALOG_MISMATCH: scaffold resource must be a normalized file below resources/scaffolds/');
const scaffoldSchema = z.strictObject({
  templateId: nonemptySingleLineSchema,
  resourcePath: scaffoldResourcePathSchema,
  templateHash: sha256Schema,
  renderInputs: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('NONE') }),
    z.strictObject({ kind: z.literal('CHANGE_TITLE_AND_SCENARIO'), fields: z.tuple([z.literal('title'), z.literal('scenarioId'), z.literal('workMode'), z.literal('risk')]) }),
  ]),
});
const artifactAuthorityEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('FILE'),
    entryId: nonemptySingleLineSchema,
    capability: capabilitySchema,
    role: nonemptySingleLineSchema,
    path: changeArtifactPathSchema,
    creationMode: z.literal('0644'),
    schemaIdentity: z.null(),
    activation: artifactActivationSchema,
    scaffold: scaffoldSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal('DIRECTORY'),
    entryId: nonemptySingleLineSchema,
    capability: capabilitySchema,
    role: nonemptySingleLineSchema,
    path: changeArtifactDirectorySchema,
    creationMode: z.literal('0755'),
    schemaIdentity: z.null(),
    activation: artifactActivationSchema,
    scaffold: z.null(),
    minimumRegularFiles: z.number().int().positive().safe(),
    sourceRefFiles: z.literal('RECURSIVE_REGULAR_FILES'),
  }),
]).superRefine((entry, context) => {
  if (entry.entryId !== `${entry.capability}:${entry.role}`) {
    context.addIssue({ code: 'custom', path: ['entryId'], message: 'AUTHORITY_CATALOG_MISMATCH: entryId must bind capability and role' });
  }
});
const artifactAuthoritySchema = z.strictObject({
  schemaVersion: z.literal(1),
  entries: z.array(artifactAuthorityEntrySchema).length(16).superRefine((values, context) => {
    requireSortedUnique(values, (value) => value.entryId, context, []);
  }),
});

const authorityPathTokenSchema = z.enum([
  '<DecisionId>', '<EvidenceId>', '<RevisionId>', '<RunId>', '<SignalId>',
  '<AuthoritySequence>', '<OwnerId>', '<ChangeId>', '<ProjectTransactionId>',
  '<TargetOrdinal>', '<StageNonce>', '<InvestigationDirectoryName>',
]);
function isMachinePathFragment(value: string, allowEmpty: boolean): boolean {
  if ((!allowEmpty && value.length === 0) || !hasOnlyUnicodeScalars(value) || value !== value.normalize('NFC')) return false;
  if (value === '.' || value === '..') return false;
  return !/[\u0000-\u001f\u007f-\u009f\\/<>%*?\[\]{}!]/u.test(value);
}

const machinePathSegmentSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('LITERAL'),
    value: z.string().refine((value) => isMachinePathFragment(value, false)),
  }),
  z.strictObject({ kind: z.literal('TOKEN'), token: authorityPathTokenSchema }),
  z.strictObject({
    kind: z.literal('DERIVED_FILENAME'),
    token: authorityPathTokenSchema,
    tokenEncoding: z.enum(['AS_IS', 'AUTHORITY_SEQUENCE_6_DIGITS']),
    prefix: z.string().refine((value) => isMachinePathFragment(value, true)),
    suffix: z.string().refine((value) => isMachinePathFragment(value, true)),
  }).superRefine((segment, context) => {
    const expectedEncoding = segment.token === '<AuthoritySequence>' ? 'AUTHORITY_SEQUENCE_6_DIGITS' : 'AS_IS';
    if (segment.tokenEncoding !== expectedEncoding) {
      context.addIssue({
        code: 'custom',
        path: ['tokenEncoding'],
        message: 'AUTHORITY_CATALOG_MISMATCH: derived filename token must use its canonical encoding',
      });
    }
  }),
]);
type MachinePathSegment = z.infer<typeof machinePathSegmentSchema>;
type MachineAuthorityComparableRule = {
  readonly ruleId: string;
  readonly scope: 'PROJECT' | 'CHANGE';
  readonly pathSegments: readonly MachinePathSegment[];
};
type MachineCharacterShape = readonly string[];
type CompiledMachineSegmentLanguage = {
  readonly shapes: readonly MachineCharacterShape[];
  readonly maximumUtf8Bytes: number;
};
type CompiledMachineAuthorityRule = {
  readonly rule: MachineAuthorityComparableRule;
  readonly segmentLanguages: readonly CompiledMachineSegmentLanguage[];
};

const ASCII_DECIMAL_CHARACTERS = '0123456789';
const ASCII_LOWER_HEX_CHARACTERS = '0123456789abcdef';
const MACHINE_SHAPE_CONSTRUCTION_BUDGET = 100_000;
const MACHINE_LANGUAGE_COMPARISON_BUDGET = 100_000;
const MACHINE_LANGUAGE_INTERSECTION_WORK_BUDGET = 100_000;

// 背景：Machine token 都是规范定义的有限长度 whole-segment 语言，不能用字符串化 pattern 的相等性
// 代替实例路径唯一性。目的：把固定前缀、有限枚举和定长字符位转换成保守 position shape；任一位置
// 无共同字符即可证明不相交，无法证明时一律按可能相交关闭。上下文：这里不解释 glob，也不扩展 token 语法。
function machineTokenShapes(token: z.infer<typeof authorityPathTokenSchema>, signalIds: readonly string[]): MachineCharacterShape[] {
  switch (token) {
    case '<DecisionId>': return [prefixedDecimalShape('DEC-', 4)];
    case '<EvidenceId>': return [prefixedDecimalShape('EVD-', 6)];
    case '<RevisionId>': return [prefixedDecimalShape('REV-', 4)];
    case '<RunId>': return [prefixedDecimalShape('RUN-', 6)];
    case '<SignalId>': return signalIds.map(exactMachineShape);
    case '<AuthoritySequence>': return [decimalShape(6)];
    case '<OwnerId>': return [prefixedDecimalShape('HIT-', 6), prefixedDecimalShape('WOP-', 6)];
    case '<ChangeId>': return [prefixedDecimalShape('CHG-', 4)];
    case '<ProjectTransactionId>': return [prefixedDecimalShape('PROJECT-', 6)];
    case '<TargetOrdinal>': return [decimalShape(6)];
    case '<StageNonce>': return [Array.from({ length: 32 }, () => ASCII_LOWER_HEX_CHARACTERS)];
    case '<InvestigationDirectoryName>': return [
      appendExactShape(prefixedDecimalShape('INV-', 4), '-system-query'),
      appendExactShape(prefixedDecimalShape('INV-', 4), '-field-lineage'),
      appendExactShape(prefixedDecimalShape('INV-', 4), '-business-flow'),
    ];
  }
}

function prefixedDecimalShape(prefix: string, digits: number): MachineCharacterShape {
  return [...exactMachineShape(prefix), ...decimalShape(digits)];
}

function decimalShape(digits: number): MachineCharacterShape {
  return Array.from({ length: digits }, () => ASCII_DECIMAL_CHARACTERS);
}

function exactMachineShape(value: string): MachineCharacterShape {
  return [...value];
}

function appendExactShape(shape: MachineCharacterShape, suffix: string): MachineCharacterShape {
  return [...shape, ...exactMachineShape(suffix)];
}

function machineSegmentShapes(segment: MachinePathSegment, signalIds: readonly string[]): MachineCharacterShape[] {
  if (segment.kind === 'LITERAL') return [exactMachineShape(segment.value)];
  const tokenShapes = machineTokenShapes(segment.token, signalIds);
  if (segment.kind === 'TOKEN') return tokenShapes;
  return tokenShapes.map((shape) => [
    ...exactMachineShape(segment.prefix),
    ...shape,
    ...exactMachineShape(segment.suffix),
  ]);
}

type MachineShapeConstructionMetrics = {
  readonly shapeCount: number;
  readonly positionCellCount: number;
};

function unicodeCodePointCount(value: string): number {
  let count = 0;
  for (const _character of value) count += 1;
  return count;
}

// 背景：SignalId 是随 catalog 增长的有限语言；如果先建 position shape，再判断预算，许多不同
// DERIVED pattern 会在拒绝前分配 rules × signals × 字符位。目的：只用整数计算 token 的精确 shape
// 数与 position-cell 数，供全量预检使用。上下文：长度按 shape 实际使用的 Unicode code point 计数，
// prefix/suffix 会复制到 token 的每个有限候选中。
function machineTokenConstructionMetrics(
  token: z.infer<typeof authorityPathTokenSchema>,
  signalIds: readonly string[],
): MachineShapeConstructionMetrics {
  switch (token) {
    case '<DecisionId>': return { shapeCount: 1, positionCellCount: 8 };
    case '<EvidenceId>': return { shapeCount: 1, positionCellCount: 10 };
    case '<RevisionId>': return { shapeCount: 1, positionCellCount: 8 };
    case '<RunId>': return { shapeCount: 1, positionCellCount: 10 };
    case '<SignalId>': return {
      shapeCount: signalIds.length,
      positionCellCount: signalIds.reduce((total, signalId) => total + unicodeCodePointCount(signalId), 0),
    };
    case '<AuthoritySequence>': return { shapeCount: 1, positionCellCount: 6 };
    case '<OwnerId>': return { shapeCount: 2, positionCellCount: 20 };
    case '<ChangeId>': return { shapeCount: 1, positionCellCount: 8 };
    case '<ProjectTransactionId>': return { shapeCount: 1, positionCellCount: 14 };
    case '<TargetOrdinal>': return { shapeCount: 1, positionCellCount: 6 };
    case '<StageNonce>': return { shapeCount: 1, positionCellCount: 32 };
    case '<InvestigationDirectoryName>': return { shapeCount: 3, positionCellCount: 65 };
  }
}

function machineSegmentConstructionCellCount(
  segment: MachinePathSegment,
  signalIds: readonly string[],
): number {
  if (segment.kind === 'LITERAL') return unicodeCodePointCount(segment.value);
  const tokenMetrics = machineTokenConstructionMetrics(segment.token, signalIds);
  if (segment.kind === 'TOKEN') return tokenMetrics.positionCellCount;
  const fixedCellCount = unicodeCodePointCount(segment.prefix) + unicodeCodePointCount(segment.suffix);
  return tokenMetrics.positionCellCount + tokenMetrics.shapeCount * fixedCellCount;
}

function machinePatternKeyPart(value: string): string {
  return `${value.length}:${value}`;
}

// 背景：相同 pattern 在不同规则中必须共享一次编译结果。目的：使用带长度的无歧义字段编码作为
// intern key，避免分隔符或前后缀拼接产生别名。上下文：key 只描述 segment pattern，不包含 scope
// 或 ruleId；它们不改变该段实例语言。
function machineSegmentPatternKey(segment: MachinePathSegment): string {
  if (segment.kind === 'LITERAL') return `L${machinePatternKeyPart(segment.value)}`;
  if (segment.kind === 'TOKEN') return `T${machinePatternKeyPart(segment.token)}`;
  return `D${machinePatternKeyPart(segment.token)}${machinePatternKeyPart(segment.tokenEncoding)}`
    + `${machinePatternKeyPart(segment.prefix)}${machinePatternKeyPart(segment.suffix)}`;
}

function machineEligiblePairCount(rows: readonly MachineAuthorityComparableRule[]): number {
  const groupSizes = new Map<string, number>();
  for (const row of rows) {
    const groupKey = `${row.scope}:${row.pathSegments.length}`;
    groupSizes.set(groupKey, (groupSizes.get(groupKey) ?? 0) + 1);
  }
  let pairCount = 0;
  for (const groupSize of groupSizes.values()) {
    const groupPairCount = groupSize * (groupSize - 1) / 2;
    if (groupPairCount > MACHINE_LANGUAGE_COMPARISON_BUDGET - pairCount) {
      return MACHINE_LANGUAGE_COMPARISON_BUDGET + 1;
    }
    pairCount += groupPairCount;
  }
  return pairCount;
}

function maximumShapeUtf8Bytes(shapes: readonly MachineCharacterShape[]): number {
  return Math.max(...shapes.map((shape) => shape.reduce((total, characters) => (
    total + Math.max(...[...characters].map((character) => Buffer.byteLength(character, 'utf8')))
  ), 0)));
}

type MachineLanguageIntersectionResult = 'INTERSECTS' | 'DISJOINT' | 'BUDGET_EXCEEDED';
type MachineLanguageIntersectionBudget = { remaining: number };

function consumeMachineLanguageIntersectionWork(
  budget: MachineLanguageIntersectionBudget,
  amount = 1,
): boolean {
  if (amount > budget.remaining) return false;
  budget.remaining -= amount;
  return true;
}

// 背景：construction budget 只限制已编译 shape 的大小，同一批 shapes 仍可能在大量 rule pair 中反复
// 做笛卡尔积。目的：按实际控制流为 shape pair、长度判定、position 访问和字符相等比较各扣一个共享
// work unit，并把耗尽作为第三态逐层上返。上下文：字符集是有限 Unicode scalar 串；显式双循环保留
// 原 position-language 语义，也确保不把 String.includes 的内部扫描藏在预算之外。
function shapesMayIntersect(
  left: MachineCharacterShape,
  right: MachineCharacterShape,
  budget: MachineLanguageIntersectionBudget,
): MachineLanguageIntersectionResult {
  if (!consumeMachineLanguageIntersectionWork(budget)) return 'BUDGET_EXCEEDED';
  if (!consumeMachineLanguageIntersectionWork(budget)) return 'BUDGET_EXCEEDED';
  if (left.length !== right.length) return 'DISJOINT';
  for (let index = 0; index < left.length; index += 1) {
    if (!consumeMachineLanguageIntersectionWork(budget)) return 'BUDGET_EXCEEDED';
    let positionIntersects = false;
    characterSearch:
    for (const leftCharacter of left[index]!) {
      for (const rightCharacter of right[index]!) {
        if (!consumeMachineLanguageIntersectionWork(budget)) return 'BUDGET_EXCEEDED';
        if (leftCharacter === rightCharacter) {
          positionIntersects = true;
          break characterSearch;
        }
      }
    }
    if (!positionIntersects) return 'DISJOINT';
  }
  return 'INTERSECTS';
}

function machineShapeSetsMayIntersect(
  leftShapes: readonly MachineCharacterShape[],
  rightShapes: readonly MachineCharacterShape[],
  budget: MachineLanguageIntersectionBudget,
): MachineLanguageIntersectionResult {
  for (const leftShape of leftShapes) {
    for (const rightShape of rightShapes) {
      const result = shapesMayIntersect(leftShape, rightShape, budget);
      if (result !== 'DISJOINT') return result;
    }
  }
  return 'DISJOINT';
}

const nonemptyMachineSegmentsSchema = z.tuple([machinePathSegmentSchema]).rest(machinePathSegmentSchema);
const machineFileRuleSchema = z.strictObject({
  ruleId: nonemptySingleLineSchema,
  scope: z.enum(['PROJECT', 'CHANGE']),
  pathSegments: nonemptyMachineSegmentsSchema,
  mode: z.literal('0644'),
  schemaIdentity: nonemptySingleLineSchema.nullable(),
  seal: z.literal('RAW_BYTES'),
});
const machineDirectoryRuleSchema = z.strictObject({
  ruleId: nonemptySingleLineSchema,
  scope: z.enum(['PROJECT', 'CHANGE']),
  pathSegments: nonemptyMachineSegmentsSchema,
  mode: z.literal('0755'),
  entryPolicy: z.literal('EXACT_REGISTERED_CHILDREN'),
  seal: z.literal('ENTRY_NAMES_AND_NODE_TYPES'),
});
const machineAuthoredRuleSchema = z.strictObject({
  ruleId: nonemptySingleLineSchema,
  scope: z.enum(['PROJECT', 'CHANGE']),
  nodeKind: z.enum(['FILE', 'DIRECTORY']),
  pathSegments: nonemptyMachineSegmentsSchema,
  policy: z.literal('HISTORICAL_CAPTURE_ONLY'),
});
const transientExclusionSchema = z.strictObject({
  kind: z.literal('OWNED_DIRECTORY'),
  ruleId: nonemptySingleLineSchema,
  scope: z.enum(['PROJECT', 'CHANGE']),
  pathSegments: nonemptyMachineSegmentsSchema,
  directoryMode: z.literal('0700'),
  ownerIdentity: z.enum(['CHANGE_LOCK', 'CHANGE_AUTHORITY_OWNER', 'PROJECT_TRANSACTION_OWNER', 'PROJECT_BOOTSTRAP_OWNER']),
  childGrammar: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('CHANGE_LOCK_V1'), allowedRelativePaths: z.tuple([z.literal('owner.json'), z.literal('stage/owner.json')]) }),
    z.strictObject({ kind: z.literal('ATOMIC_TARGETS_V1'), relativePathPattern: z.literal('<TargetOrdinal>/target.tmp'), allowedTokens: z.tuple([z.literal('<TargetOrdinal>')]) }),
    z.strictObject({ kind: z.literal('PROJECT_CHANGE_STAGE_V1'), allowedFixedNodes: z.tuple([z.literal('owner.json'), z.literal('tree')]), treePolicy: z.literal('EXACT_TARGET_CHANGE_PUBLICATION') }),
    z.strictObject({ kind: z.literal('PROJECT_INITIALIZATION_STAGE_V1'), allowedFixedNodes: z.tuple([z.literal('owner.pending'), z.literal('owner.json'), z.literal('tree')]), treePolicy: z.literal('EXACT_NATIVE_PROJECT_PUBLICATION') }),
  ]),
  policy: z.literal('OWNER_SCOPED_NO_DURABLE_REMAINS'),
});
const machineAuthoritySchema = z.strictObject({
  schemaVersion: z.literal(1),
  files: z.array(machineFileRuleSchema).superRefine((values, context) => requireSortedUnique(values, (value) => value.ruleId, context, [])),
  ownedDirectories: z.array(machineDirectoryRuleSchema).superRefine((values, context) => requireSortedUnique(values, (value) => value.ruleId, context, [])),
  authoredRules: z.array(machineAuthoredRuleSchema).superRefine((values, context) => requireSortedUnique(values, (value) => value.ruleId, context, [])),
  transientExclusions: z.array(transientExclusionSchema).superRefine((values, context) => requireSortedUnique(values, (value) => value.ruleId, context, [])),
}).superRefine((authority, context) => {
  const rows = [...authority.files, ...authority.ownedDirectories, ...authority.authoredRules, ...authority.transientExclusions];
  const ruleIds = rows.map((row) => row.ruleId);
  if (new Set(ruleIds).size !== ruleIds.length) {
    context.addIssue({ code: 'custom', message: 'AUTHORITY_CATALOG_MISMATCH: MachineAuthority ruleId must be globally unique' });
  }
});

// 背景：单条 schema 只能看到 token 名，SignalId 的封闭成员集和四类规则只有 catalog root 同时可见。
// 目的：在完整对象上先按唯一 pattern 预检十万个 position-cell 构造预算，通过后才展开并 intern，
// 规则只持共享语言引用；随后计算最大实例字节并做逐段语言交集判定。上下文：PROJECT/CHANGE 是
// 不同根；先按 scope+segment-count 分组，用组合数 O(n) 粗门限制十万个 eligible candidate pair，
// 通过后有限语言内层实际工作另限十万次。任一预算耗尽或首个歧义都立即单 issue fail-closed，既
// 限制构造、二次方 pair 和 shape 笛卡尔积放大，也不以规则总数代替真实工作预算。
function validateMachineAuthorityLanguages(
  authority: z.infer<typeof machineAuthoritySchema>,
  signalIds: readonly string[],
  context: z.RefinementCtx,
): void {
  const rows: MachineAuthorityComparableRule[] = [
    ...authority.files,
    ...authority.ownedDirectories,
    ...authority.authoredRules,
    ...authority.transientExclusions,
  ];
  const usesSignalId = rows.some((row) => row.pathSegments.some((segment) => (
    segment.kind !== 'LITERAL' && segment.token === '<SignalId>'
  )));
  if (usesSignalId && signalIds.some((signalId) => (
    !isMachinePathFragment(signalId, false) || Buffer.byteLength(signalId, 'utf8') > 255
  ))) {
    context.addIssue({
      code: 'custom',
      path: ['machineAuthority'],
      message: 'AUTHORITY_CATALOG_MISMATCH: Machine SignalId token contains a non-canonical path segment',
    });
  }
  if (machineEligiblePairCount(rows) > MACHINE_LANGUAGE_COMPARISON_BUDGET) {
    context.addIssue({
      code: 'custom',
      path: ['machineAuthority'],
      message: `AUTHORITY_CATALOG_MISMATCH: Machine path-language comparison budget ${MACHINE_LANGUAGE_COMPARISON_BUDGET} exceeded`,
    });
    return;
  }

  const uniqueSegments = new Map<string, MachinePathSegment>();
  for (const row of rows) {
    for (const segment of row.pathSegments) {
      const patternKey = machineSegmentPatternKey(segment);
      if (!uniqueSegments.has(patternKey)) uniqueSegments.set(patternKey, segment);
    }
  }
  let constructionCellCount = 0;
  for (const segment of uniqueSegments.values()) {
    const segmentCellCount = machineSegmentConstructionCellCount(segment, signalIds);
    if (segmentCellCount > MACHINE_SHAPE_CONSTRUCTION_BUDGET - constructionCellCount) {
      context.addIssue({
        code: 'custom',
        path: ['machineAuthority'],
        message: `AUTHORITY_CATALOG_MISMATCH: Machine shape-cell construction budget ${MACHINE_SHAPE_CONSTRUCTION_BUDGET} exceeded`,
      });
      return;
    }
    constructionCellCount += segmentCellCount;
  }

  const compiledSegments = new Map<string, CompiledMachineSegmentLanguage>();
  for (const [patternKey, segment] of uniqueSegments) {
    const shapes = machineSegmentShapes(segment, signalIds);
    compiledSegments.set(patternKey, { shapes, maximumUtf8Bytes: maximumShapeUtf8Bytes(shapes) });
  }
  const compiledRows: CompiledMachineAuthorityRule[] = rows.map((rule) => ({
    rule,
    segmentLanguages: rule.pathSegments.map((segment) => compiledSegments.get(machineSegmentPatternKey(segment))!),
  }));

  for (const { rule, segmentLanguages } of compiledRows) {
    if (segmentLanguages.some((language) => (
      language.maximumUtf8Bytes < 1 || language.maximumUtf8Bytes > 255
    ))) {
      context.addIssue({
        code: 'custom',
        path: ['machineAuthority'],
        message: `AUTHORITY_CATALOG_MISMATCH: Machine rule '${rule.ruleId}' has an instantiated segment outside 1..255 UTF-8 bytes`,
      });
    }
    const maximumPathBytes = segmentLanguages.reduce((total, language) => (
      total + language.maximumUtf8Bytes
    ), 0)
      + rule.pathSegments.length - 1;
    if (maximumPathBytes > 1024) {
      context.addIssue({
        code: 'custom',
        path: ['machineAuthority'],
        message: `AUTHORITY_CATALOG_MISMATCH: Machine rule '${rule.ruleId}' exceeds the 1024-byte relative-path boundary`,
      });
    }
  }

  const intersectionWorkBudget: MachineLanguageIntersectionBudget = {
    remaining: MACHINE_LANGUAGE_INTERSECTION_WORK_BUDGET,
  };
  for (let leftIndex = 0; leftIndex < compiledRows.length; leftIndex += 1) {
    const left = compiledRows[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < compiledRows.length; rightIndex += 1) {
      const right = compiledRows[rightIndex]!;
      if (left.rule.scope !== right.rule.scope
        || left.segmentLanguages.length !== right.segmentLanguages.length) continue;
      let ruleLanguagesIntersect = true;
      for (let index = 0; index < left.segmentLanguages.length; index += 1) {
        const result = machineShapeSetsMayIntersect(
          left.segmentLanguages[index]!.shapes,
          right.segmentLanguages[index]!.shapes,
          intersectionWorkBudget,
        );
        if (result === 'BUDGET_EXCEEDED') {
          context.addIssue({
            code: 'custom',
            path: ['machineAuthority'],
            message: `AUTHORITY_CATALOG_MISMATCH: Machine language intersection work budget ${MACHINE_LANGUAGE_INTERSECTION_WORK_BUDGET} exceeded`,
          });
          return;
        }
        if (result === 'DISJOINT') {
          ruleLanguagesIntersect = false;
          break;
        }
      }
      if (ruleLanguagesIntersect) {
        context.addIssue({
          code: 'custom',
          path: ['machineAuthority'],
          message: `AUTHORITY_CATALOG_MISMATCH: Machine rules '${left.rule.ruleId}' and '${right.rule.ruleId}' have intersecting path languages`,
        });
        return;
      }
    }
  }
}

const worksetReentryPolicySchema = z.discriminatedUnion('kind', [
  reentryPolicy('REALITY_CHANGED', 'L4', 'research', 'show-me', 'Current-system reality changed or is no longer trustworthy.'),
  reentryPolicy('PRODUCT_CHANGED', 'L4', 'frame', 'grill', 'Product goal or user outcome changed and requires a new decision.'),
  reentryPolicy('DOMAIN_CHANGED', 'L3', 'model', 'grill', 'Domain meaning, ownership, lifecycle, or invariant changed.'),
  reentryPolicy('SCOPE_CHANGED', 'L3', 'spec', 'grill', 'Scope, acceptance criteria, or non-goals changed.'),
  reentryPolicy('TECHNICAL_CONSTRAINT_CHANGED', 'L2', 'design', 'brainstorm', 'A technical constraint invalidated the selected implementation approach.'),
  reentryPolicy('NEEDS_EXPERIMENT', 'L2', 'experiment', 'show-me', 'The remaining implementation choice requires measured evidence.'),
  reentryPolicy('PLAN_CHANGED', 'L1', 'plan', 'brainstorm', 'Only task structure, dependency order, or delivery sequencing changed.'),
  reentryPolicy('IMPLEMENTATION_DETAIL_CHANGED', 'L0', 'work', 'show-me', 'The change is bounded to implementation detail and does not reopen upstream decisions.'),
]);

function reentryPolicy<
  Kind extends string,
  Level extends (typeof RECONCILE_LEVELS)[number],
  C extends (typeof CAPABILITIES)[number],
  Interaction extends 'grill' | 'brainstorm' | 'show-me',
  Reason extends string,
>(kind: Kind, level: Level, capability: C, interaction: Interaction, reason: Reason) {
  return z.strictObject({
    rulesVersion: z.literal(1),
    kind: z.literal(kind),
    minimumReconcileLevel: z.literal(level),
    route: z.strictObject({ capability: z.literal(capability), interaction: z.literal(interaction), reason: z.literal(reason) }),
  });
}

const WORKSET_PROTOCOL_ACTION_VALUES = freezeAuthorityRegistry([
  'apply-reentry', 'bind-project-change', 'decide-project-impact', 'decide-reentry',
  'inspect-project', 'project-workflow', 'record-reentry', 'reenter', 'replan-reentry',
] as const);
export const WORKSET_PROTOCOL_ACTIONS = freezeAuthorityRegistry(WORKSET_PROTOCOL_ACTION_VALUES);
const WORKSET_PROTOCOL_TOPOLOGY = {
  'workset.candidate-research': 'inspect-project',
  'workset.project-change-binding': 'bind-project-change',
  'workset.project-impact-decision': 'decide-project-impact',
  'workset.project-workflow-handoff': 'project-workflow',
  'workset.reentry-apply': 'apply-reentry',
  'workset.reentry-classification': 'record-reentry',
  'workset.reentry-decision': 'decide-reentry',
  'workset.reentry-interaction': 'reenter',
  'workset.reentry-plan': 'reenter',
  'workset.reentry-replan': 'replan-reentry',
} as const;
const protocolManifestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ schemaVersion: z.literal(1), id: nonemptySingleLineSchema, relativePath: z.string().regex(/^resources\/protocols\/[a-z0-9/-]+\.md$/), version: z.number().int().positive().safe(), rawBytesHash: sha256Schema, kind: z.literal('common') }),
  z.strictObject({ schemaVersion: z.literal(1), id: nonemptySingleLineSchema, relativePath: z.string().regex(/^resources\/protocols\/[a-z0-9/-]+\.md$/), version: z.number().int().positive().safe(), rawBytesHash: sha256Schema, kind: z.literal('repository-capability'), capability: capabilitySchema }),
  z.strictObject({ schemaVersion: z.literal(1), id: nonemptySingleLineSchema, relativePath: z.string().regex(/^resources\/protocols\/[a-z0-9/-]+\.md$/), version: z.number().int().positive().safe(), rawBytesHash: sha256Schema, kind: z.literal('interaction'), interaction: z.enum(['grill', 'brainstorm', 'show-me']) }),
  z.strictObject({ schemaVersion: z.literal(1), id: nonemptySingleLineSchema, relativePath: z.string().regex(/^resources\/protocols\/[a-z0-9/-]+\.md$/), version: z.number().int().positive().safe(), rawBytesHash: sha256Schema, kind: z.literal('workset-action'), actions: z.array(z.enum(WORKSET_PROTOCOL_ACTION_VALUES)).min(1).superRefine((values, context) => requireSortedUnique(values, (value) => value, context, [])) }),
]).superRefine((manifest, context) => {
  const expectedId = manifest.kind === 'common'
    ? 'common.authoritative-work'
    : manifest.kind === 'repository-capability'
      ? `repository.${manifest.capability}`
      : manifest.kind === 'interaction'
        ? `interaction.${manifest.interaction}`
        : manifest.id;
  if (manifest.id !== expectedId) {
    context.addIssue({ code: 'custom', path: ['id'], message: 'AUTHORITY_CATALOG_MISMATCH: protocol id does not match discriminant' });
  }
  if (manifest.relativePath !== `resources/protocols/${manifest.id.replace('.', '/')}.md`) {
    context.addIssue({ code: 'custom', path: ['relativePath'], message: 'AUTHORITY_CATALOG_MISMATCH: protocol path does not match id' });
  }
});

export const scenarioDetectionPolicySchema = z.strictObject({
  normalization: z.literal('JAVASCRIPT_TO_LOWER_CASE'),
  scoring: z.literal('SUM_EACH_MATCHED_SIGNAL_UTF16_LENGTH_ONCE'),
  fallbackScenarioId: z.literal('small-feature'),
  primaryOrder: z.literal('SCORE_DESC_THEN_LOWER_DETECTION_PRIORITY'),
  overrides: z.tuple([z.strictObject({
    whenBestScenarioId: z.literal('architecture-governance'),
    candidates: z.tuple([z.literal('cross-service-change'), z.literal('shared-library')]),
    select: z.literal('HIGHEST_POSITIVE_SCORE_THEN_LOWER_DETECTION_PRIORITY'),
  })]),
});

const SPECIAL_EVIDENCE_IDS = [
  'canary-business-health', 'canary-consumer-health', 'canary-data-integrity',
  'canary-experience-health', 'canary-migration-integrity', 'canary-result',
  'canary-technical-health', 'delivery-contract', 'delivery-rollback', 'delivery-runtime',
  'qa-result', 'repository-review', 'reproduction', 'root-cause',
  'simplify-regression', 'work-check',
] as const;
const TASK_EVIDENCE_IDS = [
  'task-behavior', 'task-characterization', 'task-contract', 'task-deletion',
  'task-integration', 'task-migration', 'task-operability',
] as const;

const stageAuthorityCatalogRawSchema = z.strictObject({
  schemaVersion: z.literal(1),
  catalogId: z.literal('omnai.stage-authority.v1'),
  compilerRuntime: compilerRuntimeSchema,
  compilerArtifacts: z.array(compilerArtifactSchema).length(10).superRefine((values, context) => requireSortedUnique(values, (value) => value.compilerId, context, [])),
  capabilityTemplates: z.array(capabilityTemplateSchema).length(24).superRefine((values, context) => requireSortedUnique(values, (value) => value.capability, context, [])),
  evidenceTemplates: z.array(evidenceTemplateSchema).length(74).superRefine((values, context) => requireSortedUnique(values, (value) => value.requirementId, context, [])),
  taskEvidenceRequirementIds: z.tuple(TASK_EVIDENCE_IDS.map((value) => z.literal(value)) as [z.ZodLiteral<'task-behavior'>, z.ZodLiteral<'task-characterization'>, z.ZodLiteral<'task-contract'>, z.ZodLiteral<'task-deletion'>, z.ZodLiteral<'task-integration'>, z.ZodLiteral<'task-migration'>, z.ZodLiteral<'task-operability'>]),
  humanGateTemplates: z.tuple([humanGateSchema]),
  qaPoliciesByScenario: z.array(z.strictObject({ scenarioId: z.enum(SCENARIO_IDS), policy: qaPolicySchema })).length(3).superRefine((values, context) => requireSortedUnique(values, (value) => value.scenarioId, context, [])),
  canaryPoliciesByScenario: z.array(z.strictObject({ scenarioId: z.enum(SCENARIO_IDS), policy: canaryPolicySchema })).length(5).superRefine((values, context) => requireSortedUnique(values, (value) => value.scenarioId, context, [])),
  commonPromptContext: z.strictObject({
    projectKnowledgePaths: z.tuple([z.literal('glossary.md'), z.literal('policies.md'), z.literal('learnings.md')]),
    includeFlowSnapshot: z.literal(true),
    includeDecisionSnapshots: z.literal(true),
  }),
  verificationCommandExecution: z.strictObject({
    shell: z.literal('DISABLED'),
    repositoryView: z.literal('DISPOSABLE_BASIS_OVERLAY'),
    filesystemWrites: z.literal('OVERLAY_ONLY'),
    network: z.literal('DENY'),
    environment: z.literal('FIXED_MINIMAL'),
    timeoutSeconds: z.literal(1800),
    maximumCombinedOutputBytes: z.literal(33554432),
  }),
  artifactAuthority: artifactAuthoritySchema,
  machineAuthority: machineAuthoritySchema,
  scenarioProfiles: z.array(scenarioProfileSchema).length(19).superRefine((values, context) => requireSortedUnique(values, (value) => value.id, context, [])),
  scenarioDetectionCompilerId: z.literal('scenario-detection-v1'),
  scenarioDetectionPolicy: scenarioDetectionPolicySchema,
  worksetReentryPolicies: z.array(worksetReentryPolicySchema).length(8).superRefine((values, context) => requireSortedUnique(values, (value) => value.kind, context, [])),
  promptRendererId: z.literal('prompt-render-v1'),
  protocolManifests: z.array(protocolManifestSchema).length(38).superRefine((values, context) => requireSortedUnique(values, (value) => value.id, context, [])),
}).superRefine((catalog, context) => {
  const capabilityKeys = catalog.capabilityTemplates.map((row) => row.capability);
  if (new Set(capabilityKeys).size !== CAPABILITIES.length || CAPABILITIES.some((capability) => !capabilityKeys.includes(capability))) {
    context.addIssue({ code: 'custom', path: ['capabilityTemplates'], message: 'AUTHORITY_CATALOG_MISMATCH: capability coverage must be exact' });
  }
  const priorities = catalog.scenarioProfiles.map((profile) => profile.detectionPriority).sort((left, right) => left - right);
  if (priorities.some((priority, index) => priority !== index)) {
    context.addIssue({ code: 'custom', path: ['scenarioProfiles'], message: 'AUTHORITY_CATALOG_MISMATCH: detection priorities must cover 0..18' });
  }
  const scenarioIds = new Set(catalog.scenarioProfiles.flatMap((profile) => profile.requiredEvidence));
  if (scenarioIds.size !== 53) {
    context.addIssue({ code: 'custom', path: ['scenarioProfiles'], message: 'AUTHORITY_CATALOG_MISMATCH: Scenario evidence partition must contain 53 ids' });
  }
  const expectedEvidenceIds = new Set<string>([...scenarioIds, ...SPECIAL_EVIDENCE_IDS, ...TASK_EVIDENCE_IDS]);
  const actualEvidenceIds = catalog.evidenceTemplates.map((row) => row.requirementId);
  if (expectedEvidenceIds.size !== 74 || actualEvidenceIds.some((id) => !expectedEvidenceIds.has(id))) {
    context.addIssue({ code: 'custom', path: ['evidenceTemplates'], message: 'AUTHORITY_CATALOG_MISMATCH: evidence registry must be the exact 74-id union' });
  }
  const signalIds = [...new Set(catalog.canaryPoliciesByScenario.flatMap((row) => (
    row.policy.signals.map((signal) => signal.signalId)
  )))].sort(compareCodeUnits);
  validateMachineAuthorityLanguages(catalog.machineAuthority, signalIds, context);
  for (const [capability, policies] of [
    ['qa', catalog.qaPoliciesByScenario],
    ['canary', catalog.canaryPoliciesByScenario],
  ] as const) {
    const routedScenarioIds = catalog.scenarioProfiles
      .filter((profile) => [...profile.stages, ...profile.optionalStages].includes(capability))
      .map((profile) => profile.id)
      .sort(compareCodeUnits);
    const policyScenarioIds = policies.map((row) => row.scenarioId);
    if (routedScenarioIds.length !== policyScenarioIds.length
      || routedScenarioIds.some((scenarioId, index) => scenarioId !== policyScenarioIds[index])) {
      context.addIssue({
        code: 'custom',
        path: [capability === 'qa' ? 'qaPoliciesByScenario' : 'canaryPoliciesByScenario'],
        message: `AUTHORITY_CATALOG_MISMATCH: ${capability} policies must exactly cover routed scenarios`,
      });
    }
  }
  const manifestCapabilities = catalog.protocolManifests
    .filter((manifest) => manifest.kind === 'repository-capability')
    .map((manifest) => manifest.capability);
  if (manifestCapabilities.length !== 24 || CAPABILITIES.some((capability) => !manifestCapabilities.includes(capability))) {
    context.addIssue({ code: 'custom', path: ['protocolManifests'], message: 'AUTHORITY_CATALOG_MISMATCH: repository protocols must cover all capabilities' });
  }
  if (catalog.protocolManifests.some((manifest) => manifest.id === 'repository.release')) {
    context.addIssue({ code: 'custom', path: ['protocolManifests'], message: 'AUTHORITY_CATALOG_MISMATCH: repository.release is obsolete' });
  }
  const commonIds = catalog.protocolManifests.filter((manifest) => manifest.kind === 'common').map((manifest) => manifest.id);
  const interactionIds = catalog.protocolManifests.filter((manifest) => manifest.kind === 'interaction').map((manifest) => manifest.id);
  const worksetManifests = catalog.protocolManifests.filter((manifest) => manifest.kind === 'workset-action');
  if (commonIds.length !== 1 || commonIds[0] !== 'common.authoritative-work'
    || interactionIds.length !== 3
    || interactionIds.some((id, index) => id !== ['interaction.brainstorm', 'interaction.grill', 'interaction.show-me'][index])
    || worksetManifests.length !== 10) {
    context.addIssue({
      code: 'custom',
      path: ['protocolManifests'],
      message: 'AUTHORITY_CATALOG_MISMATCH: protocol topology must be 1 common, 3 interaction, 10 Workset and 24 repository manifests',
    });
  }
  for (const manifest of worksetManifests) {
    const action = WORKSET_PROTOCOL_TOPOLOGY[manifest.id as keyof typeof WORKSET_PROTOCOL_TOPOLOGY];
    if (action === undefined || manifest.actions.length !== 1 || manifest.actions[0] !== action) {
      context.addIssue({
        code: 'custom',
        path: ['protocolManifests'],
        message: `AUTHORITY_CATALOG_MISMATCH: Workset protocol '${manifest.id}' does not match the canonical action mapping`,
      });
    }
  }
});

export const stageAuthorityCatalogV1Schema = guardStrictPersistentInput(stageAuthorityCatalogRawSchema);
export type StageAuthorityCatalogV1 = z.output<typeof stageAuthorityCatalogV1Schema>;
export type StageCapabilityTemplate = z.output<typeof capabilityTemplateSchema>;
export type EvidenceRequirementTemplate = z.output<typeof evidenceTemplateSchema>;
export type HumanGateTemplate = z.output<typeof humanGateSchema>;
export type QaPolicySnapshot = z.output<typeof qaPolicySchema>;
export type CanaryPolicySnapshot = z.output<typeof canaryPolicySchema>;
export type ScenarioDetectionPolicyV1 = z.output<typeof scenarioDetectionPolicySchema>;

// 背景：目录哈希只覆盖对象语义，YAML 字节、对象键插入顺序和本地 locale 都不是权限。
// 目的：递归排序对象键但保留数组顺序，因为 registry 已在 schema 边界区分 set 与作者顺序。
// 上下文：调用方必须先通过 strict catalog schema；此函数拒绝非 plain JSON，而不是修复输入。
export function canonicalStrictJson(value: unknown, maximumNodes = 100_000): string {
  if (!Number.isSafeInteger(maximumNodes) || maximumNodes < 1 || maximumNodes > 500_000) {
    throw new TypeError('AUTHORITY_CATALOG_MISMATCH: canonical JSON node budget is invalid');
  }
  // 背景：catalog hash 与 pure compiler clone 过去各自反射 hostile graph。目的：统一先做
  // descriptor-only preflight，再分配 canonical 输出；Proxy（含 nested/revoked）在任何 trap
  // 前失败。上下文：500000 仅供显式选择该预算的 completion 输入，公开默认仍是 100000。
  const limits: StrictJsonWorkLimits = {
    maximumDepth: 512,
    maximumNodes,
    maximumUtf8Bytes: 256 * 1024 * 1024,
    maximumCanonicalBytes: 512 * 1024 * 1024,
  };
  try {
    return canonicalizeStrictJson(value, limits);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'strict JSON validation failed';
    throw new TypeError(`AUTHORITY_CATALOG_MISMATCH: ${message}`);
  }
}

function hasOnlyUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function hashStrictObject(value: unknown): Sha256 {
  return sha256Schema.parse(`sha256:${createHash('sha256').update(canonicalStrictJson(value)).digest('hex')}`);
}
