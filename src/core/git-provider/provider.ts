import { isAbsolute, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { hashStrictObject } from '../../authority/catalog-schema.js';
import {
  acquireNativeProvider,
  executeNativeProvider,
  freezeProvider,
} from './native-binding.js';
import {
  frozenGitProviderBindingBodySchema,
  frozenGitProviderBindingSchema,
  type FrozenGitProviderBindingV1,
  type GitCommandInputV1,
  type GitCommandResultV1,
} from './types-internal.js';

export class GitProviderError extends Error {
  readonly code = 'GIT_PROVIDER_UNAVAILABLE' as const;

  constructor(cause?: unknown) {
    super(
      'GIT_PROVIDER_UNAVAILABLE: verified Git provider is unavailable',
      cause === undefined ? undefined : { cause },
    );
    this.name = 'GitProviderError';
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
// source capture await 后仍会重新认证 provider input；这里绑定集合与字符串 intrinsic，避免
// 当前 realm prototype replacement 改写 descriptor-authenticated Git 调用。
const reflectApplyIntrinsic = Reflect.apply;
const arrayIncludesIntrinsic = Array.prototype.includes;
const arrayPushIntrinsic = Array.prototype.push;
const stringIncludesIntrinsic = String.prototype.includes;
const SetIntrinsic = Set;
const setAddIntrinsic = Set.prototype.add;
const setDeleteIntrinsic = Set.prototype.delete;
const setSizeIntrinsic = Object.getOwnPropertyDescriptor(Set.prototype, 'size')!.get!;
let activeBinding: FrozenGitProviderBindingV1 | null = null;

export function acquireGitProvider(): FrozenGitProviderBindingV1 {
  try {
    const binding = freezeProvider(acquireNativeProvider());
    activeBinding = binding;
    return binding;
  } catch (cause) {
    activeBinding = null;
    throw mapBeforeOwnerProviderFailure(cause);
  }
}

export function runGit(
  binding: FrozenGitProviderBindingV1,
  input: GitCommandInputV1,
): GitCommandResultV1 {
  try {
    const parsedBinding = validateBinding(binding);
    if (activeBinding === null || !sameBinding(parsedBinding, activeBinding)) {
      throw new Error('provider binding is not the active retained descriptor');
    }
    const parsedInput = validateInput(input);
    const native = executeNativeProvider(parsedInput);
    return Object.freeze({
      exitCode: native.exitCode,
      stdout: utf8.decode(native.stdout),
      stderr: utf8.decode(native.stderr),
    });
  } catch (cause) {
    throw mapBeforeOwnerProviderFailure(cause);
  }
}

export function mapBeforeOwnerProviderFailure(cause: unknown): GitProviderError {
  return cause instanceof GitProviderError ? cause : new GitProviderError(cause);
}

function validateBinding(value: unknown): FrozenGitProviderBindingV1 {
  if (
    typeof value !== 'object'
    || value === null
    || !hasExactOwnKeys(value, [
      'schemaVersion',
      'environmentProtocol',
      'executionProtocol',
      'executableCandidatePath',
      'executableRealPath',
      'executableRawBytesHash',
      'gitVersion',
      'bindingHash',
    ])
  ) {
    throw new Error('provider binding has unknown fields');
  }
  const parsed = frozenGitProviderBindingSchema.parse(value);
  const { bindingHash, ...bodyValue } = parsed;
  const body = frozenGitProviderBindingBodySchema.parse(bodyValue);
  if (bindingHash !== hashStrictObject(body)) {
    throw new Error('provider binding hash mismatch');
  }
  return Object.freeze({ ...body, bindingHash });
}

function validateInput(value: GitCommandInputV1): GitCommandInputV1 {
  if (
    typeof value !== 'object'
    || value === null
    || !hasExactOwnKeys(value, ['repositoryRoot', 'args'])
    || typeof value.repositoryRoot !== 'string'
    || stringIncludes(value.repositoryRoot, '\u0000')
    || !isAbsolute(value.repositoryRoot)
    || resolve(value.repositoryRoot) !== value.repositoryRoot
    || !Array.isArray(value.args)
    || value.args.length === 0
    || value.args.length > 128
    || !hasExactArrayKeys(value.args)
  ) {
    throw new Error('Git command input is invalid');
  }
  let totalBytes = Buffer.byteLength(value.repositoryRoot);
  if (totalBytes > 4096) throw new Error('Git repository root exceeds limit');
  const args: string[] = [];
  for (let index = 0; index < value.args.length; index += 1) {
    const argument = value.args[index]!;
    if (typeof argument !== 'string' || stringIncludes(argument, '\u0000')) {
      throw new Error('Git command argument is invalid');
    }
    totalBytes += Buffer.byteLength(argument);
    if (totalBytes > 1024 * 1024) throw new Error('Git command input exceeds limit');
    arrayPush(args, argument);
  }
  return Object.freeze({ repositoryRoot: value.repositoryRoot, args: Object.freeze(args) });
}

function hasExactOwnKeys(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length) return false;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    if (typeof key !== 'string' || !arrayIncludes(expected, key)) return false;
  }
  return true;
}

function hasExactArrayKeys(value: readonly unknown[]): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !arrayIncludes(keys, 'length')) return false;
  const expectedIndexes = new SetIntrinsic<string>();
  for (let index = 0; index < value.length; index += 1) setAdd(expectedIndexes, String(index));
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    if (key !== 'length' && (typeof key !== 'string' || !setDelete(expectedIndexes, key))) return false;
  }
  return setSize(expectedIndexes) === 0;
}

function arrayIncludes<Value>(array: readonly Value[], value: Value): boolean {
  return reflectApplyIntrinsic(arrayIncludesIntrinsic, array, [value]) as boolean;
}

function arrayPush<Value>(array: Value[], value: Value): void {
  reflectApplyIntrinsic(arrayPushIntrinsic, array, [value]);
}

function stringIncludes(value: string, search: string): boolean {
  return reflectApplyIntrinsic(stringIncludesIntrinsic, value, [search]) as boolean;
}

function setAdd<Value>(set: Set<Value>, value: Value): void {
  reflectApplyIntrinsic(setAddIntrinsic, set, [value]);
}

function setDelete<Value>(set: Set<Value>, value: Value): boolean {
  return reflectApplyIntrinsic(setDeleteIntrinsic, set, [value]) as boolean;
}

function setSize<Value>(set: Set<Value>): number {
  return reflectApplyIntrinsic(setSizeIntrinsic, set, []) as number;
}

function sameBinding(left: FrozenGitProviderBindingV1, right: FrozenGitProviderBindingV1): boolean {
  return left.bindingHash === right.bindingHash
    && left.schemaVersion === right.schemaVersion
    && left.environmentProtocol === right.environmentProtocol
    && left.executionProtocol === right.executionProtocol
    && left.executableCandidatePath === right.executableCandidatePath
    && left.executableRealPath === right.executableRealPath
    && left.executableRawBytesHash === right.executableRawBytesHash
    && left.gitVersion === right.gitVersion;
}
