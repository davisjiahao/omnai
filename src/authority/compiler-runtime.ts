import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalStrictJson,
  compareCodeUnits,
  evidenceTemplateSchema,
  type EvidenceRequirementTemplate,
} from './catalog-schema.js';
import {
  evidenceRequirementSchema,
  type RunTerminalContract,
  type EvidenceRequirementContract,
} from '../domain/run.js';
import type { Sha256, TaskId } from '../domain/scalars.js';
import {
  createStrictJsonWorkBudget,
  preflightStrictJsonValue,
  StrictJsonBoundaryError,
} from '../domain/strict-json-internal.js';

// 背景：Task 4 的十个 reference compiler 必须共享同一组无副作用的字节、排序和 strict parse
// 原语，否则每个文件会形成一份隐含权限算法。目的：这里只保留纯计算帮助函数；不读取环境、时钟、
// 文件、网络或 Git，也不维护 compilerId 注册表。上下文：Task 9E 会把等价逻辑固化为最终 VM bytes，
// 本文件不是最终 runtime resource，也不声称拥有 packaged catalog hash。
export function parseCompilerInput<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  maximumCanonicalNodes = 100_000,
): z.output<Schema> {
  // 背景：直接把 hostile object 交给 Zod 会在 strictObject 报错前执行 getter。
  // 目的：canonical descriptor walk 先拒绝 accessor、symbol、prototype、稀疏数组、循环和预算越界，
  // 然后 schema 只观察新的 plain JSON clone。上下文：这也保证 compiler 不可能修改 caller 的冻结对象。
  return schema.parse(preflightCompilerInput(value, maximumCanonicalNodes));
}

const COMPILER_INPUT_MAX_DEPTH = 512;
const COMPILER_INPUT_MAX_NODES = 500_000;
const COMPILER_INPUT_MAX_UTF8_BYTES = 256 * 1024 * 1024;
const COMPILER_INPUT_MAX_SINGLE_BLOB_BYTES = 32 * 1024 * 1024;
const COMPILER_INPUT_MAX_AGGREGATE_BLOB_BYTES = 128 * 1024 * 1024;

// 背景：compiler 输入中的路径、Task 和 requirement inventory 都可以是大集合；
// 单次 Set/Map 索引是线性的，但无上限的线性工作仍可阻塞纯编译边界。
// 目的：所有大集合 membership join 共用同一个可审计上限，以参与索引的行数之和
// 计费，绝不以笛卡尔积隐藏二次复杂度。60000 刚好容纳规范 30k+30k 压力向量。
export const COMPILER_LINEAR_MEMBERSHIP_WORK_BUDGET = 60_000;

export function requireLinearMembershipWorkBudget(
  collectionSizes: readonly number[],
  description: string,
): void {
  let remaining = COMPILER_LINEAR_MEMBERSHIP_WORK_BUDGET;
  for (const size of collectionSizes) {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new TypeError(`STATIC_INPUT_INVALID: ${description} has an invalid collection size`);
    }
    remaining -= size;
    if (remaining < 0) {
      throw new TypeError(
        `STATIC_INPUT_INVALID: ${description} exceeds the linear membership work budget of ${COMPILER_LINEAR_MEMBERSHIP_WORK_BUDGET}`,
      );
    }
  }
}

// 背景：FrozenByteBlob 的 schema 会执行 Base64 decode/hash，而 canonical clone 会先复制全部
// 字符串；若只在二者之后计数，攻击者已让 compiler 分配了未授权内存。目的：用 descriptor-only
// 迭代遍历在任何 getter、stringify、decode 前累计深度、节点、UTF-8 与 blob 估算。上下文：
// 256 MiB 字符预算显式容纳四个 32 MiB blob 的约 171 MiB Base64，以及规范 context 元数据。
function preflightCompilerInput(root: unknown, maximumCanonicalNodes: number): unknown {
  if (!Number.isSafeInteger(maximumCanonicalNodes)
    || maximumCanonicalNodes < 1
    || maximumCanonicalNodes > COMPILER_INPUT_MAX_NODES) {
    throw new TypeError('STATIC_INPUT_INVALID: compiler input node budget is invalid');
  }
  let aggregateBlobBytes = 0;
  const budget = createStrictJsonWorkBudget({
    maximumDepth: COMPILER_INPUT_MAX_DEPTH,
    maximumNodes: maximumCanonicalNodes,
    maximumUtf8Bytes: COMPILER_INPUT_MAX_UTF8_BYTES,
    maximumCanonicalBytes: 512 * 1024 * 1024,
  });
  try {
    return preflightStrictJsonValue(root, budget, {
      onStringValue(value, fieldName) {
        if (fieldName !== 'rawBytesBase64') return;
        const estimatedBytes = estimatedBase64Bytes(value);
        if (estimatedBytes > COMPILER_INPUT_MAX_SINGLE_BLOB_BYTES) {
          throw new TypeError('STATIC_INPUT_INVALID: suspected Base64 blob exceeds 32 MiB');
        }
        aggregateBlobBytes += estimatedBytes;
        if (aggregateBlobBytes > COMPILER_INPUT_MAX_AGGREGATE_BLOB_BYTES) {
          throw new TypeError('STATIC_INPUT_INVALID: suspected Base64 blob aggregate exceeds 128 MiB');
        }
      },
    });
  } catch (error) {
    if (!(error instanceof StrictJsonBoundaryError)) throw error;
    const message = error.code === 'NODE_BUDGET' ? 'compiler input node budget exceeds 500000'
      : error.code === 'DEPTH_BUDGET' ? 'compiler input depth exceeds 512'
        : error.code === 'UTF8_BUDGET' ? 'compiler input UTF-8 budget exceeds 256 MiB'
          : error.code === 'CANONICAL_BUDGET' ? 'compiler input canonical-output budget exceeds 512 MiB'
            : `compiler input ${error.message}`;
    throw new TypeError(`STATIC_INPUT_INVALID: ${message}`);
  }
}

function estimatedBase64Bytes(value: string): number {
  if (value.length === 0) return 0;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.floor(value.length / 4) * 3 - padding;
}

export function cloneStrictJson<Value>(value: Value, maximumCanonicalNodes = 100_000): Value {
  if (!Number.isSafeInteger(maximumCanonicalNodes)
    || maximumCanonicalNodes < 1
    || maximumCanonicalNodes > COMPILER_INPUT_MAX_NODES) {
    throw new TypeError('AUTHORITY_CATALOG_MISMATCH: canonical JSON node budget is invalid');
  }
  try {
    const authenticated = preflightStrictJsonValue(value, createStrictJsonWorkBudget({
      maximumDepth: COMPILER_INPUT_MAX_DEPTH,
      maximumNodes: maximumCanonicalNodes,
      maximumUtf8Bytes: COMPILER_INPUT_MAX_UTF8_BYTES,
      maximumCanonicalBytes: 512 * 1024 * 1024,
    }));
    // 背景：compiler 的既有返回契约是普通 JSON object；把认证用 null-prototype graph 直接返回
    // 会改变 deepEqual/public consumer 行为。目的：只在 hostile graph 已关闭后，以 descriptor read
    // 与 defineProperty 物化 presentation clone；parseCompilerInput 绝不走这里，Zod 仍只读取唯一
    // null-prototype 认证克隆。上下文：这不是 canonicalizer，不排序、不哈希，也不读取原始 caller。
    return materializeCompilerOutput<Value>(authenticated);
  } catch (error) {
    if (!(error instanceof StrictJsonBoundaryError)) throw error;
    throw new TypeError(`AUTHORITY_CATALOG_MISMATCH: ${error.message}`);
  }
}

function materializeCompilerOutput<Value>(value: unknown): Value {
  if (value === null || typeof value !== 'object') return value as Value;
  if (Array.isArray(value)) {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (lengthDescriptor === undefined || !('value' in lengthDescriptor)) {
      throw new TypeError('AUTHORITY_CATALOG_MISMATCH: authenticated compiler array length is invalid');
    }
    const output = new Array<unknown>(lengthDescriptor.value);
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !('value' in descriptor)) {
        throw new TypeError('AUTHORITY_CATALOG_MISMATCH: authenticated compiler array entry is invalid');
      }
      Object.defineProperty(output, String(index), {
        configurable: true,
        enumerable: true,
        value: materializeCompilerOutput(descriptor.value),
        writable: true,
      });
    }
    return output as Value;
  }
  const output: Record<string, unknown> = {};
  const keys = Reflect.ownKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== 'string') {
      throw new TypeError('AUTHORITY_CATALOG_MISMATCH: authenticated compiler object key is invalid');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError('AUTHORITY_CATALOG_MISMATCH: authenticated compiler object field is invalid');
    }
    Object.defineProperty(output, key, {
      configurable: true,
      enumerable: true,
      value: materializeCompilerOutput(descriptor.value),
      writable: true,
    });
  }
  return output as Value;
}

export function hashUtf8(value: string): Sha256 {
  assertStrictUtf8Text(value, { allowLineFeed: true, requireNonWhitespace: false });
  return `sha256:${createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')}` as Sha256;
}

export function utf8ByteLength(value: string): number {
  assertStrictUtf8Text(value, { allowLineFeed: true, requireNonWhitespace: false });
  return Buffer.byteLength(value, 'utf8');
}

export function assertStrictUtf8Text(
  value: string,
  options: { readonly allowLineFeed: boolean; readonly requireNonWhitespace: boolean },
): void {
  if (options.requireNonWhitespace && value.trim().length === 0) {
    throw new TypeError('STATIC_INPUT_INVALID: text must contain a non-whitespace scalar');
  }
  if (value.includes('\r') || value.includes('\0') || value.startsWith('\ufeff')
    || (!options.allowLineFeed && value.includes('\n'))) {
    throw new TypeError('STATIC_INPUT_INVALID: forbidden text framing scalar');
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError('STATIC_INPUT_INVALID: lone Unicode surrogate');
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError('STATIC_INPUT_INVALID: lone Unicode surrogate');
    }
  }
}

export function requireSingleRow<Row>(
  rows: readonly Row[],
  predicate: (row: Row) => boolean,
  description: string,
): Row {
  const selected = rows.filter(predicate);
  if (selected.length !== 1) throw new TypeError(`POLICY_UNAVAILABLE: expected exactly one ${description}`);
  return selected[0]!;
}

export function requireCodeUnitOrder(values: readonly string[], description: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (compareCodeUnits(values[index - 1]!, values[index]!) >= 0) {
      throw new TypeError(`STATIC_INPUT_INVALID: ${description} must be code-unit sorted and unique`);
    }
  }
}

export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

// 背景：Verify terminal 同时冻结 verificationTaskIds、Task→requirement 映射、target TaskFile
// 与 Evidence contract；只比较 TaskId 集合会允许调用者把四份权限投影一起篡改成一个自洽但非
// TaskFile 授权的集合。目的：在 run-descendants 与 stage-completion 的共同信任边界上，一次
// 线性建立 requirement→Task 索引，并验证每个 selected Task 的 evidenceRequired、每个
// TASK_DECLARED contract 与反向覆盖完全闭合。上下文：该函数不生成新的权限，只认证 terminal
// 已冻结的四个视图，因此两个 compiler 不会再各自维护一份不完整的映射算法。
export function validateAndIndexVerifyTaskRequirementClosure(
  terminal: Extract<RunTerminalContract, { readonly kind: 'VERIFY_STAGE' }>,
  description: string,
): ReadonlyMap<string, readonly TaskId[]> {
  const mappedRequirementCount = terminal.verificationTaskRequirements.reduce(
    (total, binding) => total + binding.requirementIds.length,
    0,
  );
  const targetRequirementCount = terminal.targetTaskFile.tasks.reduce(
    (total, task) => total + task.evidenceRequired.length,
    0,
  );
  requireLinearMembershipWorkBudget(
    [
      terminal.verificationTaskIds.length,
      terminal.verificationTaskRequirements.length,
      terminal.targetTaskFile.tasks.length,
      terminal.evidenceRequirements.length,
      mappedRequirementCount,
      targetRequirementCount,
    ],
    `${description} Verify Task/requirement exact closure`,
  );

  const requirementById = new Map<string, EvidenceRequirementContract>();
  for (const requirement of terminal.evidenceRequirements) {
    if (requirementById.has(requirement.requirementId)) {
      throw new TypeError(`STATIC_INPUT_INVALID: ${description} has duplicate Evidence requirement contracts`);
    }
    requirementById.set(requirement.requirementId, requirement);
  }
  const taskById = new Map<TaskId, typeof terminal.targetTaskFile.tasks[number]>();
  for (const task of terminal.targetTaskFile.tasks) {
    if (taskById.has(task.id)) {
      throw new TypeError(`STATIC_INPUT_INVALID: ${description} has duplicate target Task rows`);
    }
    taskById.set(task.id, task);
  }

  const verificationTaskIdSet = new Set(terminal.verificationTaskIds);
  const mappedTaskIds = new Set<TaskId>();
  const coveredTaskDeclaredRequirementIds = new Set<string>();
  const taskIdsByRequirement = new Map<string, TaskId[]>();
  for (const binding of terminal.verificationTaskRequirements) {
    if (!verificationTaskIdSet.has(binding.taskId) || mappedTaskIds.has(binding.taskId)) {
      throw new TypeError(`STATIC_INPUT_INVALID: ${description} has a duplicate or foreign Verify Task binding`);
    }
    mappedTaskIds.add(binding.taskId);
    const task = taskById.get(binding.taskId);
    if (task === undefined) {
      throw new TypeError(`STATIC_INPUT_INVALID: ${description} Verify Task is absent from target TaskFile`);
    }
    requireCodeUnitOrder(binding.requirementIds, `${description} mapped requirement IDs`);
    requireCodeUnitOrder(task.evidenceRequired, `${description} target Task evidenceRequired`);
    if (binding.requirementIds.length !== task.evidenceRequired.length
      || binding.requirementIds.some((requirementId, index) => requirementId !== task.evidenceRequired[index])) {
      throw new TypeError(`STATIC_INPUT_INVALID: ${description} Verify mapping does not equal target Task evidenceRequired`);
    }
    for (const requirementId of binding.requirementIds) {
      const requirement = requirementById.get(requirementId);
      if (requirement?.taskScope.kind !== 'TASK_DECLARED') {
        throw new TypeError(`STATIC_INPUT_INVALID: ${description} Verify mapping names a missing or non-TASK_DECLARED requirement`);
      }
      coveredTaskDeclaredRequirementIds.add(requirementId);
      const taskIds = taskIdsByRequirement.get(requirementId);
      if (taskIds === undefined) taskIdsByRequirement.set(requirementId, [binding.taskId]);
      else taskIds.push(binding.taskId);
    }
  }
  if (mappedTaskIds.size !== verificationTaskIdSet.size) {
    throw new TypeError(`STATIC_INPUT_INVALID: ${description} Verify Task binding set is not exhaustive`);
  }
  for (const requirement of terminal.evidenceRequirements) {
    if (requirement.taskScope.kind === 'TASK_DECLARED'
      && !coveredTaskDeclaredRequirementIds.has(requirement.requirementId)) {
      throw new TypeError(`STATIC_INPUT_INVALID: ${description} has an uncovered TASK_DECLARED Evidence contract`);
    }
  }
  return taskIdsByRequirement;
}

export function instantiateEvidenceTemplate(
  value: EvidenceRequirementTemplate,
  formula: EvidenceRequirementTemplate['taskScopeFormula'] = value.taskScopeFormula,
): EvidenceRequirementContract {
  const template = evidenceTemplateSchema.parse(value);
  const base = {
    requirementId: template.requirementId,
    producer: template.producer,
    allowedTypes: [...template.allowedTypes],
    allowedStatuses: [...template.allowedStatuses],
    satisfyingStatus: template.satisfyingStatus,
    outputPolicy: template.outputPolicy,
    sourceScope: template.sourceScope,
    subjectPolicy: template.subjectPolicy,
  } as const;
  switch (formula) {
    case 'NONE':
      return evidenceRequirementSchema.parse({
        ...base,
        taskScope: { kind: 'NONE' },
        minimumRecords: template.minimumRecords,
      });
    case 'SELECTED_TASK':
    case 'TASK_DECLARED':
    case 'EACH_VERIFICATION_TASK':
      return evidenceRequirementSchema.parse({
        ...base,
        taskScope: { kind: formula },
        minimumRecordsPerTask: template.minimumRecords,
      });
    case 'REVIEW_SCOPE':
      throw new TypeError('STATIC_INPUT_INVALID: REVIEW_SCOPE requires an explicit frozen ReviewScope');
  }
}

export function assertNever(value: never, context: string): never {
  throw new TypeError(`STATIC_INPUT_INVALID: unreachable ${context}: ${canonicalStrictJson(value)}`);
}
