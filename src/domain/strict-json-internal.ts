import { isProxy } from 'node:util/types';

export type StrictJsonBoundaryCode =
  | 'PROXY'
  | 'DEPTH_BUDGET'
  | 'NODE_BUDGET'
  | 'UTF8_BUDGET'
  | 'CANONICAL_BUDGET'
  | 'CYCLE'
  | 'INVALID_VALUE'
  | 'INVALID_UNICODE'
  | 'CUSTOM_PROTOTYPE'
  | 'SYMBOL_KEY'
  | 'ACCESSOR'
  | 'NON_ENUMERABLE'
  | 'SPARSE_ARRAY'
  | 'UNSAFE_ASSIGNMENT_ENVIRONMENT';

export class StrictJsonBoundaryError extends TypeError {
  constructor(
    readonly code: StrictJsonBoundaryCode,
    message: string,
  ) {
    super(message);
    this.name = 'StrictJsonBoundaryError';
  }
}

export interface StrictJsonWorkLimits {
  readonly maximumDepth: number;
  readonly maximumNodes: number;
  readonly maximumUtf8Bytes: number;
  readonly maximumCanonicalBytes: number;
}

export interface StrictJsonWorkBudget {
  readonly limits: StrictJsonWorkLimits;
  nodes: number;
  utf8Bytes: number;
  canonicalBytes: number;
}

export interface StrictJsonPreflightOptions {
  readonly onStringValue?: (value: string, fieldName: string | null) => void;
}

export const DEFAULT_STRICT_JSON_LIMITS: StrictJsonWorkLimits = Object.freeze({
  maximumDepth: 512,
  maximumNodes: 100_000,
  maximumUtf8Bytes: 256 * 1024 * 1024,
  maximumCanonicalBytes: 512 * 1024 * 1024,
});

interface PendingNode {
  readonly value: unknown;
  readonly depth: number;
  readonly fieldName: string | null;
  readonly exit: boolean;
  readonly destination: object | null;
  readonly destinationKey: string | null;
  readonly next: PendingNode | undefined;
}

// 背景：persistent schema、catalog canonicalizer 与 pure compiler 曾各自维护一份反射遍历，
// 且都可能在识别 Proxy 前触发 getPrototypeOf/ownKeys/descriptor trap。目的：所有 hostile raw
// data graph 统一通过这个 descriptor-only、iterative、budgeted preflight；每个 root/nested object
// 都先调用无 trap 的 isProxy，再进行任何 prototype/key/descriptor 操作。上下文：本函数返回唯一
// 认证深克隆，普通对象使用 null prototype，数组元素仅以 defineProperty 写入；budget 可跨多个
// Decision row 复用，shared object 按每次 JSON 语义出现计费，只有当前 ancestor 重入才视为循环。
export function preflightStrictJsonValue(
  root: unknown,
  budget: StrictJsonWorkBudget = createStrictJsonWorkBudget(),
  options: StrictJsonPreflightOptions = {},
): unknown {
  validateStrictJsonLimits(budget.limits);
  let pending: PendingNode | undefined = {
    value: root,
    depth: 0,
    fieldName: null,
    exit: false,
    destination: null,
    destinationKey: null,
    next: undefined,
  };
  const ancestors = new Set<object>();
  let authenticatedRoot: unknown;

  const schedule = (
    value: unknown,
    depth: number,
    fieldName: string | null,
    destination: object | null,
    destinationKey: string | null,
    exit = false,
  ): void => {
    pending = { value, depth, fieldName, exit, destination, destinationKey, next: pending };
  };
  const writeAuthenticatedValue = (node: PendingNode, value: unknown): void => {
    if (node.destination === null || node.destinationKey === null) {
      authenticatedRoot = value;
      return;
    }
    Object.defineProperty(node.destination, node.destinationKey, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  };

  while (pending !== undefined) {
    const node: PendingNode = pending;
    pending = node.next;
    if (node.exit) {
      if (typeof node.value === 'object' && node.value !== null) ancestors.delete(node.value);
      continue;
    }
    if (node.depth > budget.limits.maximumDepth) {
      throw new StrictJsonBoundaryError('DEPTH_BUDGET', 'strict JSON depth exceeds limit');
    }
    chargeBudget(budget, 'nodes', 1, 'NODE_BUDGET', 'strict JSON node budget exceeded');

    if (node.value === null) {
      chargeBudget(budget, 'canonicalBytes', 4, 'CANONICAL_BUDGET', 'strict JSON canonical-output budget exceeded');
      writeAuthenticatedValue(node, null);
      continue;
    }
    if (typeof node.value === 'boolean') {
      chargeBudget(
        budget,
        'canonicalBytes',
        node.value ? 4 : 5,
        'CANONICAL_BUDGET',
        'strict JSON canonical-output budget exceeded',
      );
      writeAuthenticatedValue(node, node.value);
      continue;
    }
    if (typeof node.value === 'string') {
      if (!hasOnlyUnicodeScalars(node.value)) {
        throw new StrictJsonBoundaryError('INVALID_UNICODE', 'strict JSON contains an invalid Unicode scalar string');
      }
      chargeBudget(
        budget,
        'utf8Bytes',
        Buffer.byteLength(node.value, 'utf8'),
        'UTF8_BUDGET',
        'strict JSON UTF-8 budget exceeded',
      );
      chargeBudget(
        budget,
        'canonicalBytes',
        jsonStringByteLength(node.value),
        'CANONICAL_BUDGET',
        'strict JSON canonical-output budget exceeded',
      );
      options.onStringValue?.(node.value, node.fieldName);
      writeAuthenticatedValue(node, node.value);
      continue;
    }
    if (typeof node.value === 'number') {
      if (!Number.isFinite(node.value) || Object.is(node.value, -0)) {
        throw new StrictJsonBoundaryError('INVALID_VALUE', 'strict JSON contains a non-finite or negative-zero number');
      }
      chargeBudget(
        budget,
        'canonicalBytes',
        Buffer.byteLength(String(node.value), 'utf8'),
        'CANONICAL_BUDGET',
        'strict JSON canonical-output budget exceeded',
      );
      writeAuthenticatedValue(node, node.value);
      continue;
    }
    if (typeof node.value !== 'object') {
      throw new StrictJsonBoundaryError('INVALID_VALUE', 'strict JSON contains a non-JSON value');
    }

    // isProxy 必须是每个 object node 的第一项身份操作；Array.isArray 对 revoked Proxy 也会抛错。
    if (isProxy(node.value)) {
      throw new StrictJsonBoundaryError('PROXY', 'strict JSON Proxy values are forbidden');
    }
    if (ancestors.has(node.value)) {
      throw new StrictJsonBoundaryError('CYCLE', 'strict JSON contains a cycle');
    }
    const array = Array.isArray(node.value);
    const prototype = Object.getPrototypeOf(node.value);
    if ((array && prototype !== Array.prototype)
      || (!array && prototype !== Object.prototype && prototype !== null)) {
      throw new StrictJsonBoundaryError('CUSTOM_PROTOTYPE', 'canonical input must be strict JSON without a custom prototype');
    }
    ancestors.add(node.value);
    schedule(node.value, node.depth, node.fieldName, null, null, true);

    if (array) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(node.value, 'length');
      if (lengthDescriptor === undefined || !('value' in lengthDescriptor)
        || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
        throw new StrictJsonBoundaryError('SPARSE_ARRAY', 'strict JSON array length descriptor is invalid');
      }
      const length = lengthDescriptor.value;
      if (length > budget.limits.maximumNodes - budget.nodes) {
        throw new StrictJsonBoundaryError('NODE_BUDGET', 'strict JSON node budget exceeded');
      }
      chargeBudget(
        budget,
        'canonicalBytes',
        2 + Math.max(0, length - 1),
        'CANONICAL_BUDGET',
        'strict JSON canonical-output budget exceeded',
      );
      const keys = Reflect.ownKeys(node.value);
      if (keys.length !== length + 1 || keys[length] !== 'length') {
        throw new StrictJsonBoundaryError('SPARSE_ARRAY', 'strict JSON array is sparse or extended');
      }
      for (let index = 0; index < length; index += 1) {
        if (keys[index] !== String(index)) {
          throw new StrictJsonBoundaryError('SPARSE_ARRAY', 'strict JSON array is sparse or extended');
        }
      }
      // new Array 只建立 own length；每个元素随后由 defineProperty 写入，绝不触发继承的数字 setter。
      const authenticatedArray = new Array<unknown>(length);
      writeAuthenticatedValue(node, authenticatedArray);
      for (let index = length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(node.value, String(index));
        if (descriptor === undefined || !descriptor.enumerable) {
          throw new StrictJsonBoundaryError('NON_ENUMERABLE', 'strict JSON array contains a non-enumerable entry');
        }
        if (!('value' in descriptor)) {
          throw new StrictJsonBoundaryError('ACCESSOR', 'strict JSON array contains an accessor entry');
        }
        schedule(descriptor.value, node.depth + 1, null, authenticatedArray, String(index));
      }
      continue;
    }

    const keys = Reflect.ownKeys(node.value);
    if (keys.length > budget.limits.maximumNodes - budget.nodes) {
      throw new StrictJsonBoundaryError('NODE_BUDGET', 'strict JSON node budget exceeded');
    }
    chargeBudget(
      budget,
      'canonicalBytes',
      2 + Math.max(0, keys.length - 1) + keys.length,
      'CANONICAL_BUDGET',
      'strict JSON canonical-output budget exceeded',
    );
    const authenticatedObject = Object.create(null) as Record<string, unknown>;
    writeAuthenticatedValue(node, authenticatedObject);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      if (typeof key !== 'string') {
        throw new StrictJsonBoundaryError('SYMBOL_KEY', 'strict JSON symbol key is forbidden');
      }
      if (!hasOnlyUnicodeScalars(key)) {
        throw new StrictJsonBoundaryError('INVALID_UNICODE', 'strict JSON object key is not Unicode scalar text');
      }
      chargeBudget(
        budget,
        'utf8Bytes',
        Buffer.byteLength(key, 'utf8'),
        'UTF8_BUDGET',
        'strict JSON UTF-8 budget exceeded',
      );
      chargeBudget(
        budget,
        'canonicalBytes',
        jsonStringByteLength(key),
        'CANONICAL_BUDGET',
        'strict JSON canonical-output budget exceeded',
      );
      const descriptor = Object.getOwnPropertyDescriptor(node.value, key);
      if (descriptor === undefined || !descriptor.enumerable) {
        throw new StrictJsonBoundaryError('NON_ENUMERABLE', 'strict JSON object contains a non-enumerable field');
      }
      if (!('value' in descriptor)) {
        throw new StrictJsonBoundaryError('ACCESSOR', 'strict JSON object contains an accessor field');
      }
      schedule(descriptor.value, node.depth + 1, key, authenticatedObject, key);
    }
  }

  return authenticatedRoot;
}

export function createStrictJsonWorkBudget(
  limits: StrictJsonWorkLimits = DEFAULT_STRICT_JSON_LIMITS,
): StrictJsonWorkBudget {
  validateStrictJsonLimits(limits);
  return { limits, nodes: 0, utf8Bytes: 0, canonicalBytes: 0 };
}

export function isStrictJsonValue(value: unknown): boolean {
  try {
    preflightStrictJsonValue(value);
    return true;
  } catch (error) {
    if (error instanceof StrictJsonBoundaryError) return false;
    throw error;
  }
}

interface PendingAuthenticatedPair {
  readonly left: unknown;
  readonly right: unknown;
  readonly next: PendingAuthenticatedPair | undefined;
}

// 背景：Zod 对 authenticated input 校验成功后仍可静默删除 `__proto__`、空洞
// 数组项或其他 JSON 值；只再做一次 preflight 不能发现语义已改变。目的：
// 以 descriptor-only 的迭代 pair walk 比较两个已认证 graph，object key 忽略插入
// 顺序，array 保留 exact ordinal。上下文：该函数不读 caller raw graph，调用方必须
// 先使用 preflightStrictJsonValue 产生两个 getter/trap-free clone。
export function authenticatedStrictJsonValuesEqual(left: unknown, right: unknown): boolean {
  let pending: PendingAuthenticatedPair | undefined = { left, right, next: undefined };
  const schedule = (pairLeft: unknown, pairRight: unknown): void => {
    pending = { left: pairLeft, right: pairRight, next: pending };
  };

  while (pending !== undefined) {
    const pair: PendingAuthenticatedPair = pending;
    pending = pair.next;
    if (pair.left === null || pair.right === null
      || typeof pair.left !== 'object' || typeof pair.right !== 'object') {
      if (!Object.is(pair.left, pair.right)) return false;
      continue;
    }
    if (isProxy(pair.left) || isProxy(pair.right)) return false;
    const leftArray = Array.isArray(pair.left);
    if (leftArray !== Array.isArray(pair.right)) return false;

    if (leftArray) {
      const leftLength = authenticatedArrayLength(pair.left);
      const rightLength = authenticatedArrayLength(pair.right);
      if (leftLength !== rightLength) return false;
      for (let index = leftLength - 1; index >= 0; index -= 1) {
        const leftDescriptor = Object.getOwnPropertyDescriptor(pair.left, String(index));
        const rightDescriptor = Object.getOwnPropertyDescriptor(pair.right, String(index));
        if (leftDescriptor === undefined || rightDescriptor === undefined
          || !('value' in leftDescriptor) || !('value' in rightDescriptor)) return false;
        schedule(leftDescriptor.value, rightDescriptor.value);
      }
      continue;
    }

    const leftKeys = Reflect.ownKeys(pair.left);
    const rightKeys = Reflect.ownKeys(pair.right);
    if (leftKeys.length !== rightKeys.length) return false;
    sortAuthenticatedStringKeys(leftKeys);
    sortAuthenticatedStringKeys(rightKeys);
    for (let index = leftKeys.length - 1; index >= 0; index -= 1) {
      const leftKey = authenticatedStringKeyAt(leftKeys, index);
      const rightKey = authenticatedStringKeyAt(rightKeys, index);
      if (leftKey !== rightKey) return false;
      const leftDescriptor = Object.getOwnPropertyDescriptor(pair.left, leftKey);
      const rightDescriptor = Object.getOwnPropertyDescriptor(pair.right, rightKey);
      if (leftDescriptor === undefined || rightDescriptor === undefined
        || !('value' in leftDescriptor) || !('value' in rightDescriptor)) return false;
      schedule(leftDescriptor.value, rightDescriptor.value);
    }
  }
  return true;
}

interface PendingAssignmentNode {
  readonly value: object;
  readonly next: PendingAssignmentNode | undefined;
}

// 背景：Zod v4 object/array parser 以 ordinary assignment 物化输出；若原型链上
// 存在 accessor 或 non-writable data descriptor，赋值会执行 caller code、丢字段或报错。
// 目的：在进入任何 raw Zod object/array parser 前，只通过 prototype/key/descriptor 反射
// 证明当前 assignment environment 安全，不试写、不调用 getter/setter。上下文：
// `__proto__` 不走 ordinary assignment；Zod strictObject 会跳过它，动态 record 由项目
// descriptor helper 以 defineProperty 物化，最终 input/output identity check 会关闭静默删除。
export function assertSafeZodAssignmentEnvironment(authenticatedRoot: unknown): void {
  if (isProxy(Object.prototype) || isProxy(Array.prototype)
    || Object.getPrototypeOf(Object.prototype) !== null
    || Object.getPrototypeOf(Array.prototype) !== Object.prototype) {
    throw new StrictJsonBoundaryError(
      'UNSAFE_ASSIGNMENT_ENVIRONMENT',
      'persistent parser assignment prototype chain is unsafe',
    );
  }
  const objectPrototypeKeys = Reflect.ownKeys(Object.prototype);
  for (let index = 0; index < objectPrototypeKeys.length; index += 1) {
    const key = authenticatedKeyAt(objectPrototypeKeys, index);
    // `__proto__` 是 ordinary Object.prototype 的既有 accessor；Zod strictObject 会跳过
    // 这个 input key，项目动态 record 则只用 defineProperty，因此它不属于 assignment
    // 入口。其他 caller 新增 accessor/non-writable descriptor 即使对应 required missing
    // 字段，也必须在 raw parser 尝试写 undefined/issue output 前关闭。
    if (key !== '__proto__'
      && !isSafeInheritedAssignmentDescriptor(Object.getOwnPropertyDescriptor(Object.prototype, key))) {
      throw new StrictJsonBoundaryError(
        'UNSAFE_ASSIGNMENT_ENVIRONMENT',
        'persistent parser Object prototype assignment is unsafe',
      );
    }
  }
  const arrayPrototypeKeys = Reflect.ownKeys(Array.prototype);
  for (let index = 0; index < arrayPrototypeKeys.length; index += 1) {
    const key = authenticatedKeyAt(arrayPrototypeKeys, index);
    if (typeof key === 'string' && isCanonicalArrayIndex(key)
      && !isSafeInheritedAssignmentDescriptor(Object.getOwnPropertyDescriptor(Array.prototype, key))) {
      throw new StrictJsonBoundaryError(
        'UNSAFE_ASSIGNMENT_ENVIRONMENT',
        'persistent parser Array prototype numeric assignment is unsafe',
      );
    }
  }
  if (authenticatedRoot === null || typeof authenticatedRoot !== 'object') return;
  let pending: PendingAssignmentNode | undefined = { value: authenticatedRoot, next: undefined };
  const schedule = (value: unknown): void => {
    if (value !== null && typeof value === 'object') pending = { value, next: pending };
  };
  while (pending !== undefined) {
    const node: PendingAssignmentNode = pending;
    pending = node.next;
    const array = Array.isArray(node.value);
    const keys = Reflect.ownKeys(node.value);
    const keyLimit = array ? authenticatedArrayLength(node.value) : keys.length;
    for (let index = 0; index < keyLimit; index += 1) {
      const key = array ? String(index) : authenticatedKeyAt(keys, index);
      if (typeof key !== 'string') {
        throw new StrictJsonBoundaryError('SYMBOL_KEY', 'persistent parser input contains a symbol key');
      }
      const descriptor = Object.getOwnPropertyDescriptor(node.value, key);
      if (descriptor === undefined || !('value' in descriptor)) {
        throw new StrictJsonBoundaryError('ACCESSOR', 'persistent parser input contains an accessor');
      }
      if (key !== '__proto__') assertSafeAssignmentKey(array, key);
      schedule(descriptor.value);
    }
  }
}

function assertSafeAssignmentKey(array: boolean, key: string): void {
  if (array) {
    const arrayDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, key);
    if (arrayDescriptor !== undefined) {
      if (!isSafeInheritedAssignmentDescriptor(arrayDescriptor)) {
        throw new StrictJsonBoundaryError(
          'UNSAFE_ASSIGNMENT_ENVIRONMENT',
          'persistent parser Array assignment is unsafe',
        );
      }
      return;
    }
  }
  const objectDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, key);
  if (!isSafeInheritedAssignmentDescriptor(objectDescriptor)) {
    throw new StrictJsonBoundaryError(
      'UNSAFE_ASSIGNMENT_ENVIRONMENT',
      'persistent parser Object assignment is unsafe',
    );
  }
}

function isSafeInheritedAssignmentDescriptor(descriptor: PropertyDescriptor | undefined): boolean {
  return descriptor === undefined || ('value' in descriptor && descriptor.writable === true);
}

function isCanonicalArrayIndex(value: string): boolean {
  if (value === '') return false;
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 && numeric < 0xffff_ffff && String(numeric) === value;
}

// 背景：先通过预算再 JSON.stringify 普通数组仍会调用 Array.prototype.toJSON，内部 push 也会触发
// 数字 accessor setter。目的：preflight 一次性产生认证克隆，随后 descriptor-only encoder 直接产出
// JSON bytes；object key 按 code-unit 排序、array order 原样保留，绝不调用 JSON.stringify/toJSON。
// 上下文：preflight 已在完整输出分配/hash 前精确计费 canonical bytes；这里不再读取 caller 原图。
export function canonicalizeStrictJson(
  value: unknown,
  limits: StrictJsonWorkLimits = DEFAULT_STRICT_JSON_LIMITS,
): string {
  return canonicalizeStrictJsonBytes(value, limits).toString('utf8');
}

// 背景：旧 direct encoder 虽不观察 prototype hook，却通过每 code unit `output +=`
// 形成巨大 rope，8 MiB 合法 scalar 就能耗尽 128 MiB old-space。目的：利用
// preflight 已精确计算的 canonicalBytes 一次分配 Buffer，descriptor-only writer
// 直接填充 UTF-8；不产生按字符累积的中间字符串。上下文：公开 string API
// 只在最后 decode 一次，HObject 可直接 hash 这份唯一 canonical byte allocation。
export function canonicalizeStrictJsonBytes(
  value: unknown,
  limits: StrictJsonWorkLimits = DEFAULT_STRICT_JSON_LIMITS,
): Buffer {
  const budget = createStrictJsonWorkBudget(limits);
  const authenticated = preflightStrictJsonValue(value, budget);
  const output = Buffer.allocUnsafe(budget.canonicalBytes);
  const written = writeAuthenticatedStrictJson(authenticated, output, 0);
  if (written !== output.byteLength) {
    throw new StrictJsonBoundaryError('CANONICAL_BUDGET', 'canonical byte writer length mismatch');
  }
  return output;
}

function writeAuthenticatedStrictJson(value: unknown, output: Buffer, offset: number): number {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') {
    if (value === null) return writeAsciiLiteral(output, offset, 'null');
    if (typeof value === 'boolean') return writeAsciiLiteral(output, offset, value ? 'true' : 'false');
    if (typeof value === 'string') return writeJsonString(value, output, offset);
    return writeAsciiLiteral(output, offset, String(value));
  }
  if (typeof value !== 'object' || isProxy(value)) {
    throw new StrictJsonBoundaryError('PROXY', 'strict JSON Proxy values are forbidden');
  }
  if (Array.isArray(value)) {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (lengthDescriptor === undefined || !('value' in lengthDescriptor)) {
      throw new StrictJsonBoundaryError('SPARSE_ARRAY', 'strict JSON array length descriptor is invalid');
    }
    output[offset] = 0x5b;
    offset += 1;
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !('value' in descriptor)) {
        throw new StrictJsonBoundaryError('ACCESSOR', 'strict JSON array contains an accessor entry');
      }
      if (index > 0) {
        output[offset] = 0x2c;
        offset += 1;
      }
      offset = writeAuthenticatedStrictJson(descriptor.value, output, offset);
    }
    output[offset] = 0x5d;
    return offset + 1;
  }
  const keys = Reflect.ownKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = authenticatedKeyAt(keys, index);
    if (typeof key !== 'string') {
      throw new StrictJsonBoundaryError('SYMBOL_KEY', 'strict JSON symbol key is forbidden');
    }
  }
  sortAuthenticatedStringKeys(keys);
  output[offset] = 0x7b;
  offset += 1;
  for (let index = 0; index < keys.length; index += 1) {
    const key = authenticatedKeyAt(keys, index);
    if (typeof key !== 'string') {
      throw new StrictJsonBoundaryError('SYMBOL_KEY', 'strict JSON symbol key is forbidden');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new StrictJsonBoundaryError('ACCESSOR', 'strict JSON object contains an accessor field');
    }
    if (index > 0) {
      output[offset] = 0x2c;
      offset += 1;
    }
    offset = writeJsonString(key, output, offset);
    output[offset] = 0x3a;
    offset = writeAuthenticatedStrictJson(descriptor.value, output, offset + 1);
  }
  output[offset] = 0x7d;
  return offset + 1;
}

// 背景：即使 Reflect.ownKeys 返回稠密 own-data array，调用 keys.sort 或 for-of 仍把排序/迭代
// 权限交给可变的 Array.prototype。目的：用 descriptor read/write 的原地 heap sort 固定 O(n log n)
// code-unit 排序；所有 numeric 写都走 defineProperty，故 prototype sort/iterator/accessor 均无入口。
function sortAuthenticatedStringKeys(keys: PropertyKey[]): void {
  for (let start = Math.floor(keys.length / 2) - 1; start >= 0; start -= 1) {
    siftDownAuthenticatedStringKeys(keys, start, keys.length);
  }
  for (let end = keys.length - 1; end > 0; end -= 1) {
    swapAuthenticatedKeys(keys, 0, end);
    siftDownAuthenticatedStringKeys(keys, 0, end);
  }
}

function siftDownAuthenticatedStringKeys(keys: PropertyKey[], start: number, end: number): void {
  let root = start;
  while (root * 2 + 1 < end) {
    let child = root * 2 + 1;
    const left = authenticatedStringKeyAt(keys, child);
    if (child + 1 < end && compareCodeUnits(left, authenticatedStringKeyAt(keys, child + 1)) < 0) {
      child += 1;
    }
    if (compareCodeUnits(authenticatedStringKeyAt(keys, root), authenticatedStringKeyAt(keys, child)) >= 0) {
      return;
    }
    swapAuthenticatedKeys(keys, root, child);
    root = child;
  }
}

function authenticatedKeyAt(keys: PropertyKey[], index: number): PropertyKey {
  const descriptor = Object.getOwnPropertyDescriptor(keys, String(index));
  if (descriptor === undefined || !('value' in descriptor)) {
    throw new StrictJsonBoundaryError('ACCESSOR', 'canonical key inventory is not an own-data array');
  }
  return descriptor.value as PropertyKey;
}

function authenticatedStringKeyAt(keys: PropertyKey[], index: number): string {
  const key = authenticatedKeyAt(keys, index);
  if (typeof key !== 'string') {
    throw new StrictJsonBoundaryError('SYMBOL_KEY', 'strict JSON symbol key is forbidden');
  }
  return key;
}

function swapAuthenticatedKeys(keys: PropertyKey[], left: number, right: number): void {
  const leftValue = authenticatedKeyAt(keys, left);
  const rightValue = authenticatedKeyAt(keys, right);
  defineAuthenticatedKey(keys, left, rightValue);
  defineAuthenticatedKey(keys, right, leftValue);
}

function defineAuthenticatedKey(keys: PropertyKey[], index: number, value: PropertyKey): void {
  Object.defineProperty(keys, String(index), {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function authenticatedArrayLength(value: object): number {
  const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (descriptor === undefined || !('value' in descriptor) || !Number.isSafeInteger(descriptor.value)) {
    throw new StrictJsonBoundaryError('SPARSE_ARRAY', 'strict JSON array length descriptor is invalid');
  }
  return descriptor.value;
}

function writeAsciiLiteral(output: Buffer, offset: number, value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    output[offset] = value.charCodeAt(index);
    offset += 1;
  }
  return offset;
}

function writeJsonString(value: string, output: Buffer, offset: number): number {
  output[offset] = 0x22;
  offset += 1;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      output[offset] = 0x5c;
      output[offset + 1] = code;
      offset += 2;
    } else if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      output[offset] = 0x5c;
      output[offset + 1] = escapedControlByte(code);
      offset += 2;
    } else if (code <= 0x1f) {
      output[offset] = 0x5c;
      output[offset + 1] = 0x75;
      output[offset + 2] = 0x30;
      output[offset + 3] = 0x30;
      output[offset + 4] = hexadecimalByte(code >>> 4);
      output[offset + 5] = hexadecimalByte(code & 0x0f);
      offset += 6;
    } else if (code <= 0x7f) {
      output[offset] = code;
      offset += 1;
    } else if (code <= 0x7ff) {
      output[offset] = 0xc0 | (code >>> 6);
      output[offset + 1] = 0x80 | (code & 0x3f);
      offset += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      const scalar = 0x1_0000 + ((code - 0xd800) << 10) + (next - 0xdc00);
      output[offset] = 0xf0 | (scalar >>> 18);
      output[offset + 1] = 0x80 | ((scalar >>> 12) & 0x3f);
      output[offset + 2] = 0x80 | ((scalar >>> 6) & 0x3f);
      output[offset + 3] = 0x80 | (scalar & 0x3f);
      offset += 4;
      index += 1;
    } else {
      output[offset] = 0xe0 | (code >>> 12);
      output[offset + 1] = 0x80 | ((code >>> 6) & 0x3f);
      output[offset + 2] = 0x80 | (code & 0x3f);
      offset += 3;
    }
  }
  output[offset] = 0x22;
  return offset + 1;
}

function escapedControlByte(code: number): number {
  if (code === 0x08) return 0x62;
  if (code === 0x09) return 0x74;
  if (code === 0x0a) return 0x6e;
  if (code === 0x0c) return 0x66;
  return 0x72;
}

function hexadecimalByte(value: number): number {
  return value < 10 ? 0x30 + value : 0x61 + value - 10;
}

function chargeBudget(
  budget: StrictJsonWorkBudget,
  field: 'nodes' | 'utf8Bytes' | 'canonicalBytes',
  amount: number,
  code: Extract<StrictJsonBoundaryCode, 'NODE_BUDGET' | 'UTF8_BUDGET' | 'CANONICAL_BUDGET'>,
  message: string,
): void {
  const maximum = field === 'nodes' ? budget.limits.maximumNodes
    : field === 'utf8Bytes' ? budget.limits.maximumUtf8Bytes
      : budget.limits.maximumCanonicalBytes;
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > maximum - budget[field]) {
    throw new StrictJsonBoundaryError(code, message);
  }
  budget[field] += amount;
}

function jsonStringByteLength(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes += code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
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

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateStrictJsonLimits(limits: StrictJsonWorkLimits): void {
  validateStrictJsonLimit('maximumDepth', limits.maximumDepth);
  validateStrictJsonLimit('maximumNodes', limits.maximumNodes);
  validateStrictJsonLimit('maximumUtf8Bytes', limits.maximumUtf8Bytes);
  validateStrictJsonLimit('maximumCanonicalBytes', limits.maximumCanonicalBytes);
}

function validateStrictJsonLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`strict JSON limit '${name}' must be a positive safe integer`);
  }
}
