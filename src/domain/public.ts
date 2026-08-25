import { createHash } from 'node:crypto';
import { isAbsolute, normalize, parse, sep } from 'node:path';
import { z } from 'zod';
import {
  changeIdSchema,
  decisionIdSchema,
  evidenceIdSchema,
  revisionIdSchema,
  runIdSchema,
  sha256Schema,
  taskIdSchema,
  timestampSchema,
  type Sha256,
} from './scalars.js';
import {
  assertSafeZodAssignmentEnvironment,
  authenticatedStrictJsonValuesEqual,
  canonicalizeStrictJsonBytes,
  preflightStrictJsonValue,
  StrictJsonBoundaryError,
} from './strict-json-internal.js';

// 背景：持久复合对象曾通过 transform 把严格标量的输出品牌擦除为普通 string。
// 目的：旧导入名继续指向同一个 final parser，但解析输出必须保留原始品牌。
// 上下文：构造侧的普通 JSON 字符串由每个复合 schema 的 z.input 类型单独表达。
export const persistedChangeIdSchema = changeIdSchema;
export const persistedDecisionIdSchema = decisionIdSchema;
export const persistedEvidenceIdSchema = evidenceIdSchema;
export const persistedRevisionIdSchema = revisionIdSchema;
export const persistedRunIdSchema = runIdSchema;
export const persistedSha256Schema = sha256Schema;
export const persistedTaskIdSchema = taskIdSchema;
export const persistedTimestampSchema = timestampSchema;

// 背景：final-v0.3 的多个持久文档共享相同枚举、路径和集合约束。
// 目的：让每个模块复用同一份严格原语，避免再次形成局部兼容 reader。
// 上下文：这里仅提供无状态 schema 组件；完整对象仍由各持久模块显式列出全部字段。
declare const domainBrand: unique symbol;
type DomainString<Name extends string> = string & { readonly [domainBrand]: Name };

export type ChangeArtifactPath = DomainString<'ChangeArtifactPath'>;
export type ChangeArtifactDirectory = DomainString<'ChangeArtifactDirectory'>;
export type RepositoryCodePath = DomainString<'RepositoryCodePath'>;
export type ProjectAlias = DomainString<'ProjectAlias'>;
export type WorksetId = DomainString<'WorksetId'>;
export type WorksetReentryId = DomainString<'WorksetReentryId'>;
export type WorksetOperationId = DomainString<'WorksetOperationId'>;
export type StrictWorksetSlug = DomainString<'StrictWorksetSlug'>;
export type StrictWorksetBranch = DomainString<'StrictWorksetBranch'>;
export type StrictChangeSlug = DomainString<'StrictChangeSlug'>;
export type NormalizedAbsoluteRealPath = DomainString<'NormalizedAbsoluteRealPath'>;

function freezeRegistry<const Values extends readonly string[]>(values: Values): Values {
  return Object.freeze([...values]) as unknown as Values;
}

// 背景：export const 只冻结变量绑定，不冻结数组；caller 的 pop/splice/set 曾能改变后续 schema
// enum 与编译结果。目的：每个 registry 保留 private frozen canonical truth，并导出另一份 frozen
// observation copy。上下文：这是运行时 immutability，不引入 legacy alias 或可写兼容表。
const CHANGE_STATUS_VALUES = freezeRegistry([
  'DRAFT', 'READY', 'IN_PROGRESS', 'BLOCKED', 'VERIFYING', 'READY_TO_ARCHIVE', 'ARCHIVED', 'NEEDS_RECONCILE',
] as const);
export const CHANGE_STATUSES = freezeRegistry(CHANGE_STATUS_VALUES);
const READINESS_STATUS_VALUES = freezeRegistry([
  'MISSING', 'IN_PROGRESS', 'READY', 'CONCERNS', 'STALE', 'NEEDS_REVALIDATION', 'INVALIDATED', 'NOT_APPLICABLE',
] as const);
export const READINESS_STATUSES = freezeRegistry(READINESS_STATUS_VALUES);
const TASK_STATUS_VALUES = freezeRegistry([
  'PENDING', 'READY', 'RUNNING', 'BLOCKED', 'IMPLEMENTED', 'VERIFYING', 'VERIFIED', 'DONE',
  'STALE', 'NEEDS_REVALIDATION', 'INVALIDATED', 'SUPERSEDED', 'CANCELLED',
] as const);
export const TASK_STATUSES = freezeRegistry(TASK_STATUS_VALUES);
const RECONCILE_LEVEL_VALUES = freezeRegistry(['L0', 'L1', 'L2', 'L3', 'L4', 'L5'] as const);
export const RECONCILE_LEVELS = freezeRegistry(RECONCILE_LEVEL_VALUES);
const RISK_LEVEL_VALUES = freezeRegistry(['P0', 'P1', 'P2', 'P3'] as const);
export const RISK_LEVELS = freezeRegistry(RISK_LEVEL_VALUES);
const RISK_DIMENSION_LEVEL_VALUES = freezeRegistry(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const);
export const RISK_DIMENSION_LEVELS = freezeRegistry(RISK_DIMENSION_LEVEL_VALUES);
const WORK_MODE_VALUES = freezeRegistry([
  'READ_ONLY_QUERY', 'BUG_FIX', 'INCIDENT', 'FEATURE', 'PRODUCT_DISCOVERY', 'ARCHITECTURE_CHANGE',
  'MIGRATION', 'PERFORMANCE', 'RELEASE', 'EXPERIMENT', 'QUALITY',
] as const);
export const WORK_MODES = freezeRegistry(WORK_MODE_VALUES);
const CAPABILITY_VALUES = freezeRegistry([
  'frame', 'research', 'map', 'model', 'spec', 'design', 'plan',
  'triage', 'reproduce', 'debug', 'diagnose', 'experiment', 'fix', 'mitigate',
  'work', 'simplify', 'review', 'verify', 'qa', 'ship', 'canary', 'learn', 'archive', 'reconcile',
] as const);
export const CAPABILITIES = freezeRegistry(CAPABILITY_VALUES);
const READINESS_KEY_VALUES = freezeRegistry([
  'frame', 'map', 'research', 'mitigation', 'triage', 'reproduction', 'diagnosis', 'domain', 'spec', 'design',
  'experiment', 'fix', 'plan', 'implementation', 'review', 'simplification', 'verification', 'qa', 'release',
  'canary', 'learning',
] as const);
export const READINESS_KEYS = freezeRegistry(READINESS_KEY_VALUES);
const SCENARIO_ID_VALUES = freezeRegistry([
  'system-query', 'field-lineage', 'business-flow', 'bug-fix', 'small-feature', 'complex-domain-feature',
  'cross-service-change', 'migration-program', 'data-migration', 'architecture-governance',
  'performance-investigation', 'product-discovery', 'ui-ux-feature', 'quality-hardening', 'shared-library',
  'emergency-hotfix', 'incident-response', 'release-failure', 'technical-experiment',
] as const);
export const SCENARIO_IDS = freezeRegistry(SCENARIO_ID_VALUES);

export type ChangeStatus = (typeof CHANGE_STATUSES)[number];
export type ReadinessStatus = (typeof READINESS_STATUSES)[number];
export type ReadinessKey = (typeof READINESS_KEYS)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type ReconcileLevel = (typeof RECONCILE_LEVELS)[number];
export type RiskLevel = (typeof RISK_LEVELS)[number];
export type RiskDimensionLevel = (typeof RISK_DIMENSION_LEVELS)[number];
export type WorkMode = (typeof WORK_MODES)[number];
export type Capability = (typeof CAPABILITIES)[number];
export type ScenarioId = (typeof SCENARIO_IDS)[number];

export const nonemptySingleLineSchema = z.string().min(1).refine(
  (value) => !/[\r\n\u2028\u2029]/u.test(value) && hasOnlyUnicodeScalars(value),
  'NATIVE_SCHEMA_MISMATCH: expected a nonempty single-line Unicode scalar string',
);
export const nonnegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
export const positiveSafeIntegerSchema = z.number().int().positive().safe();
export const finiteNumberSchema = z.number().finite().refine((value) => !Object.is(value, -0));

const commonRelativePathSchema = z.string().min(1).max(1024).refine(
  (value) => isNormalizedRelativePath(value, false),
  'NATIVE_SCHEMA_MISMATCH: path is not a normalized relative POSIX file path',
);

export const changeArtifactPathSchema = commonRelativePathSchema
  .transform((value): ChangeArtifactPath => value as ChangeArtifactPath);
export const repositoryCodePathSchema = commonRelativePathSchema.refine(
  (value) => !value.split('/').some((segment) => segment === '.git' || segment === '.omnai'),
  'NATIVE_SCHEMA_MISMATCH: repository code path enters a reserved directory',
).transform((value): RepositoryCodePath => value as RepositoryCodePath);
export const changeArtifactDirectorySchema = z.string().min(2).max(1024).refine(
  (value) => value.endsWith('/')
    && Buffer.byteLength(value, 'utf8') <= 1024
    && isNormalizedRelativePath(value.slice(0, -1), false),
  'NATIVE_SCHEMA_MISMATCH: artifact directory requires one terminal slash',
).transform((value): ChangeArtifactDirectory => value as ChangeArtifactDirectory);

export const projectAliasSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/)
  .transform((value): ProjectAlias => value as ProjectAlias);
export const worksetIdSchema = z.string().regex(/^WKS-(?!0000$)\d{4}$/)
  .transform((value): WorksetId => value as WorksetId);
export const worksetReentryIdSchema = z.string().regex(/^WRE-(?!0000$)\d{4}$/)
  .transform((value): WorksetReentryId => value as WorksetReentryId);
export const worksetOperationIdSchema = z.string().regex(/^WOP-(?!000000$)\d{6}$/)
  .transform((value): WorksetOperationId => value as WorksetOperationId);
export const strictWorksetSlugSchema = z.string().min(1).refine(
  (value) => value === value.toLowerCase()
    && countUnicodeScalars(value) <= 64
    && /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(value),
).transform((value): StrictWorksetSlug => value as StrictWorksetSlug);
export const strictWorksetBranchSchema = z.string().refine((value) => {
  const match = /^omnai\/(WKS-(?!0000-)\d{4})-([\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*)$/u.exec(value);
  return match !== null
    && match[2] === match[2]?.toLowerCase()
    && countUnicodeScalars(match[2] ?? '') <= 64;
}, 'NATIVE_SCHEMA_MISMATCH: Workset branch must contain one exact Workset ID and strict slug')
  .transform((value): StrictWorksetBranch => value as StrictWorksetBranch);

// 背景：RegisteredProject 保存的是锁内解析后的真实绝对根，不能重新接纳调用方相对拼写。
// 目的：持久 reader 在无文件系统访问时仍拒绝相对、未归一化、尾分隔符和非 Unicode 标量路径。
// 上下文：symlink 消解由获取 realpath 的锁内 writer 完成；这里校验其可持久化词法结果。
export const normalizedAbsoluteRealPathSchema = z.string().min(1).refine((value) => {
  if (!hasOnlyUnicodeScalars(value) || value !== value.normalize('NFC')) return false;
  if (!isAbsolute(value) || normalize(value) !== value || value.includes('\0') || /[\u0001-\u001f\u007f]/u.test(value)) return false;
  const root = parse(value).root;
  return value === root || !value.endsWith(sep);
}, 'NATIVE_SCHEMA_MISMATCH: expected a normalized absolute real path')
  .transform((value): NormalizedAbsoluteRealPath => value as NormalizedAbsoluteRealPath);

export type ChangeArtifactPathConstructionInput = z.input<typeof changeArtifactPathSchema>;
export type ChangeArtifactDirectoryConstructionInput = z.input<typeof changeArtifactDirectorySchema>;
export type RepositoryCodePathConstructionInput = z.input<typeof repositoryCodePathSchema>;
export type ProjectAliasConstructionInput = z.input<typeof projectAliasSchema>;
export type WorksetIdConstructionInput = z.input<typeof worksetIdSchema>;
export type WorksetReentryIdConstructionInput = z.input<typeof worksetReentryIdSchema>;
export type WorksetOperationIdConstructionInput = z.input<typeof worksetOperationIdSchema>;
export type StrictWorksetSlugConstructionInput = z.input<typeof strictWorksetSlugSchema>;
export type StrictWorksetBranchConstructionInput = z.input<typeof strictWorksetBranchSchema>;
export type NormalizedAbsoluteRealPathConstructionInput = z.input<typeof normalizedAbsoluteRealPathSchema>;

export const gitObjectFormatSchema = z.enum(['sha1', 'sha256']);
export type GitObjectFormat = z.infer<typeof gitObjectFormatSchema>;
export const gitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

// 背景：只用 z.custom 验证后把原始对象交给 Zod，会让 Object.prototype 上的继承字段在第二段
// 重新出现，造成 schema 语义与 HObject own-descriptor 身份分裂。目的：公开 pipeline 的第一段必须
// 返回 descriptor-authenticated 深克隆，raw schema 只观察该克隆。上下文：transform 的输入泛型仍
// 等于 raw schema construction input，故 clone/sync/async 不依赖 Zod 私有字段也不擦除 z.input。
export function guardStrictPersistentInput<Output, Input>(
  rawSchema: z.ZodType<Output, Input>,
): z.ZodType<Output, Input> {
  const guarded = z.custom<Input>(() => true).transform((value, context): Output => {
    try {
      const authenticatedInput = preflightStrictJsonValue(value) as Input;
      assertSafeZodAssignmentEnvironment(authenticatedInput);
      const parsed = rawSchema.safeParse(authenticatedInput);
      if (!parsed.success) {
        // 背景：把 raw schema 藏进 shared transform 后，直接换成一个 custom issue 会擦掉
        // 原字段 path、union 分支与 refinement 诊断。目的：逐项转发 Zod 公开 error.issues，
        // 使既有字段约束与 superRefine 的可观察错误保持不变。上下文：环境检查已证明
        // Array ordinary assignment 安全，因此这里调用公开 addIssue 不会触发继承 numeric setter。
        for (let index = 0; index < parsed.error.issues.length; index += 1) {
          context.addIssue({ ...parsed.error.issues[index]! });
        }
        return z.NEVER;
      }
      const authenticatedOutput = preflightStrictJsonValue(parsed.data) as Output;
      if (!authenticatedStrictJsonValuesEqual(authenticatedInput, authenticatedOutput)) {
        context.addIssue({
          code: 'custom',
          message: 'NATIVE_SCHEMA_MISMATCH: persistent schema changed authenticated JSON semantics',
        });
        return z.NEVER;
      }
      return authenticatedOutput;
    } catch (error) {
      if (!(error instanceof StrictJsonBoundaryError)) throw error;
      addPersistentBoundaryIssue(context, value, hasUnsafeNumericIssueAssignment());
      return z.NEVER;
    }
  });
  // Zod 的 transform 类型会对完全泛型 Input 应用 Awaited；persistent JSON input 从不允许
  // Promise，这里只恢复同一个 construction input 泛型。raw schema 在 transform 的局部变量中
  // 同步运行，因此 clone/async/并发调用没有可共享的 authenticated graph 状态。
  return guarded as z.ZodType<Output, Input>;
}

function hasUnsafeNumericIssueAssignment(): boolean {
  const arrayKeys = Reflect.ownKeys(Array.prototype);
  for (let index = 0; index < arrayKeys.length; index += 1) {
    const keyDescriptor = Object.getOwnPropertyDescriptor(arrayKeys, String(index));
    if (keyDescriptor === undefined || !('value' in keyDescriptor)
      || !isCanonicalNumericAssignmentKey(keyDescriptor.value)) continue;
    const inherited = Object.getOwnPropertyDescriptor(Array.prototype, keyDescriptor.value);
    if (inherited !== undefined && (!('value' in inherited) || inherited.writable !== true)) return true;
  }
  const objectKeys = Reflect.ownKeys(Object.prototype);
  for (let index = 0; index < objectKeys.length; index += 1) {
    const keyDescriptor = Object.getOwnPropertyDescriptor(objectKeys, String(index));
    if (keyDescriptor === undefined || !('value' in keyDescriptor)
      || !isCanonicalNumericAssignmentKey(keyDescriptor.value)) continue;
    // Array.prototype 的 own writable data descriptor 会先命中并安全遮蔽
    // Object.prototype；只有未被遮蔽的 Object numeric descriptor 才能截获 issues push。
    if (Object.getOwnPropertyDescriptor(Array.prototype, keyDescriptor.value) !== undefined) continue;
    const inherited = Object.getOwnPropertyDescriptor(Object.prototype, keyDescriptor.value);
    if (inherited !== undefined && (!('value' in inherited) || inherited.writable !== true)) return true;
  }
  return false;
}

function isCanonicalNumericAssignmentKey(value: unknown): value is string {
  if (typeof value !== 'string' || value === '') return false;
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 && numeric < 0xffff_ffff && String(numeric) === value;
}

export type StrictJsonValue = null | boolean | string | number | StrictJsonValue[] | { [key: string]: StrictJsonValue };
// 背景：StrictJsonValue 的 raw schema 没有字段约束，它的完整运行时合同就是 descriptor
// preflight；若仍送入通用 Zod-assignment 环境检查，Array.prototype numeric accessor 下会
// 无谓拒绝一个本来只由 defineProperty 物化的安全 dense clone。目的：该唯一 identity-only
// schema 直接返回认证 clone；其他 60 个包含 object/array parser 的 schema 仍走 shared guard
// 并在 ordinary output 构造前 fail-closed。上下文：这不是兼容 reader，也不跳过任何字段规则，
// 因为 StrictJsonValue 除 strict raw data tree 外没有第二套语义约束。
const strictJsonValueGuard = z.custom<StrictJsonValue>(() => true).transform((value, context): StrictJsonValue => {
  try {
    return preflightStrictJsonValue(value) as StrictJsonValue;
  } catch (error) {
    if (!(error instanceof StrictJsonBoundaryError)) throw error;
    addPersistentBoundaryIssue(context, value, hasUnsafeNumericIssueAssignment());
    return z.NEVER;
  }
});
export const strictJsonValueSchema = strictJsonValueGuard as z.ZodType<StrictJsonValue, StrictJsonValue>;

function addPersistentBoundaryIssue(
  context: z.RefinementCtx,
  input: unknown,
  requiresDescriptorWrite: boolean,
): void {
  const issue = {
    code: 'custom',
    message: 'NATIVE_SCHEMA_MISMATCH: persistent input must be a strict raw data tree',
  } as const;
  if (requiresDescriptorWrite) {
    // 背景：Array.prototype[0] accessor 存在时，连 Zod addIssue 内部对空 issues
    // array 的 push 都会执行 caller setter。目的：只在这个已判定不安全、必须
    // fail-closed 的分支，以公开 RefinementCtx.issues 和 defineProperty 写入同一
    // raw issue；不执行 getter/setter，也不接触 Zod 私有运行时字段。上下文：正常
    // 环境与 Object prototype 污染仍走标准 addIssue，保持 Zod 诊断行为。
    Object.defineProperty(context.issues, String(context.issues.length), {
      configurable: true,
      enumerable: true,
      value: { ...issue, input, path: [] },
      writable: true,
    });
    return;
  }
  context.addIssue(issue);
}

const frozenByteBlobRawSchema = z.strictObject({
  encoding: z.literal('BASE64'),
  byteLength: nonnegativeSafeIntegerSchema,
  rawBytesBase64: z.string().max(Math.ceil((32 * 1024 * 1024) / 3) * 4),
  rawBytesHash: persistedSha256Schema,
}).superRefine((blob, context) => {
  const decoded = Buffer.from(blob.rawBytesBase64, 'base64');
  if (decoded.toString('base64') !== blob.rawBytesBase64) {
    context.addIssue({ code: 'custom', path: ['rawBytesBase64'], message: 'NATIVE_SCHEMA_MISMATCH: Base64 is not canonical RFC 4648 padded form' });
  }
  if (decoded.byteLength !== blob.byteLength || decoded.byteLength > 32 * 1024 * 1024) {
    context.addIssue({ code: 'custom', path: ['byteLength'], message: 'NATIVE_SCHEMA_MISMATCH: decoded byte length is invalid' });
  }
  if (hBytes(decoded) !== blob.rawBytesHash) {
    context.addIssue({ code: 'custom', path: ['rawBytesHash'], message: 'NATIVE_SCHEMA_MISMATCH: raw byte hash does not authenticate decoded bytes' });
  }
});
export const frozenByteBlobSchema = guardStrictPersistentInput(frozenByteBlobRawSchema);
export type FrozenByteBlobConstructionInput = z.input<typeof frozenByteBlobSchema>;
export type FrozenByteBlob = z.output<typeof frozenByteBlobSchema>;

const RUN_LIFECYCLE_OWNER_KIND_VALUES = freezeRegistry([
  'GENESIS', 'DECISION_SEMANTIC', 'DECISION_RECONCILE', 'FLOW_ASSESSMENT', 'ORDINARY_RECONCILE',
  'SCENARIO_RECLASSIFICATION', 'EVIDENCE_GENERIC', 'EVIDENCE_REVIEW_IMPORT', 'EVIDENCE_QA_IMPORT',
  'EVIDENCE_CANARY_MEASUREMENT', 'EVIDENCE_CANARY_IMPORT', 'HUMAN_APPROVAL', 'VERIFICATION_COMMAND',
  'TASK_WORK', 'ISSUE_UPDATE', 'STAGE_PREPARE', 'STAGE_COMPLETE',
] as const);
export const RUN_LIFECYCLE_OWNER_KINDS = freezeRegistry(RUN_LIFECYCLE_OWNER_KIND_VALUES);

const runLifecycleOwnerRefRawSchema = z.strictObject({
  sequence: positiveSafeIntegerSchema,
  owner: z.strictObject({
    kind: z.enum(RUN_LIFECYCLE_OWNER_KIND_VALUES),
    id: nonemptySingleLineSchema,
  }),
  operationRequestId: nonemptySingleLineSchema,
  requestDigest: persistedSha256Schema,
});
export const runLifecycleOwnerRefSchema = guardStrictPersistentInput(runLifecycleOwnerRefRawSchema);
export type RunLifecycleOwnerRefConstructionInput = z.input<typeof runLifecycleOwnerRefSchema>;
export type RunLifecycleOwnerRef = z.output<typeof runLifecycleOwnerRefSchema>;

const runBindingRawSchema = z.strictObject({
  runId: persistedRunIdSchema,
  prepareOwner: runLifecycleOwnerRefRawSchema.refine((owner) => owner.owner.kind === 'STAGE_PREPARE'),
  ordinal: positiveSafeIntegerSchema,
});
export const runBindingSchema = guardStrictPersistentInput(runBindingRawSchema);
export type RunBindingConstructionInput = z.input<typeof runBindingSchema>;
export type RunBinding = z.output<typeof runBindingSchema>;

export function requireCodeUnitSortedUnique<T>(
  values: readonly T[],
  key: (value: T) => string,
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  for (let index = 0; index < values.length; index += 1) {
    const current = key(values[index]!);
    if (index > 0 && key(values[index - 1]!) >= current) {
      context.addIssue({ code: 'custom', path: [...path, index], message: 'NATIVE_SCHEMA_MISMATCH: collection must be code-unit sorted and unique' });
      return;
    }
  }
}

export function requireTimestampOrder(
  earlier: string,
  later: string,
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  if (earlier > later) context.addIssue({ code: 'custom', path, message: 'NATIVE_SCHEMA_MISMATCH: timestamp order is invalid' });
}

export function sourceRefLogicalKey(value: {
  kind: string;
  path?: string;
  scenarioId?: string;
  evidenceId?: string;
  decisionId?: string;
  taskId?: string;
}): string {
  return `${value.kind}\u0000${value.path ?? value.scenarioId ?? value.evidenceId ?? value.decisionId ?? value.taskId ?? ''}`;
}

export {
  changeIdSchema,
  decisionIdSchema,
  evidenceIdSchema,
  revisionIdSchema,
  runIdSchema,
  sha256Schema,
  taskIdSchema,
  timestampSchema,
};

function hasOnlyUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function countUnicodeScalars(value: string): number {
  return [...value].length;
}

function isNormalizedRelativePath(value: string, allowTerminalSlash: boolean): boolean {
  if (!hasOnlyUnicodeScalars(value) || value !== value.normalize('NFC')) return false;
  if (value.includes('\\') || value.includes('\0') || /[\u0001-\u001f\u007f]/u.test(value)) return false;
  if (value.startsWith('/') || value.startsWith('//') || /^[A-Za-z]:[\\/]/u.test(value)
    || (!allowTerminalSlash && value.endsWith('/')) || value.includes('%')) return false;
  if (Buffer.byteLength(value, 'utf8') > 1024) return false;
  const segments = value.split('/');
  return segments.every((segment) => (
    segment !== '' && segment !== '.' && segment !== '..' && Buffer.byteLength(segment, 'utf8') <= 255
  ));
}

export function hObject(value: unknown): Sha256 {
  let canonical: Buffer;
  try {
    canonical = canonicalizeStrictJsonBytes(value);
  } catch {
    throw new TypeError('NATIVE_SCHEMA_MISMATCH: HObject input is not strict JSON');
  }
  return sha256Schema.parse(`sha256:${createHash('sha256').update(canonical).digest('hex')}`);
}

function hBytes(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
