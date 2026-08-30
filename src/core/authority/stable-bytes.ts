import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import {
  lstat,
  open,
  type FileHandle,
} from 'node:fs/promises';
import { isAbsolute, join, normalize, parse, sep } from 'node:path';
import { isProxy } from 'node:util/types';
import { parseSha256, type Sha256 } from '../../domain/scalars.js';
import {
  assertObservedIoRecorder,
  freezeObservedDirectory,
  freezeObservedFile,
  openObservedStableFile,
  readObservedDirectoryEntries,
  type ObservedDirectoryV1,
  type ObservedDirectoryEntryV1,
  type ObservedDirectoryNodeTypeV1,
  type ObservedFileV1,
  type ObservedIoRecorderV1,
} from './observed-io.js';

const DEFAULT_MAXIMUM_BYTES = 64 * 1024 * 1024;
const POSIX_TYPE_MASK = 0o170000n;
const reflectApplyIntrinsic = Reflect.apply;
const objectFreezeIntrinsic = Object.freeze;
const arrayPushIntrinsic = Array.prototype.push;
const arraySortIntrinsic = Array.prototype.sort;
const arrayIncludesIntrinsic = Array.prototype.includes;
const regexpTestIntrinsic = RegExp.prototype.test;
const stringEndsWithIntrinsic = String.prototype.endsWith;
const stringIncludesIntrinsic = String.prototype.includes;
const stringNormalizeIntrinsic = String.prototype.normalize;
const stringSplitIntrinsic = String.prototype.split;
const stringStartsWithIntrinsic = String.prototype.startsWith;
const TextDecoderIntrinsic = TextDecoder;
const textDecoderDecodeIntrinsic = TextDecoder.prototype.decode;
const hashUpdateIntrinsic = createHash('sha256').update;
const hashDigestIntrinsic = createHash('sha256').digest;
const weakMapGetIntrinsic = WeakMap.prototype.get;
const weakMapSetIntrinsic = WeakMap.prototype.set;
// 背景：globalThis.Uint8Array 可在 capture 返回后被替换。目的：模块初始化时绑定 intrinsic，
// copyBytes 只按索引复制，既不把 private backing 交给 helper，也不重新读取可变全局构造器。
const Uint8ArrayIntrinsic = Uint8Array;

export type AuthorityIoErrorCode =
  | 'AUTHORITY_IO_PATH_INVALID'
  | 'AUTHORITY_IO_REQUEST_INVALID'
  | 'AUTHORITY_IO_CONTAINMENT'
  | 'AUTHORITY_IO_NODE_TYPE'
  | 'AUTHORITY_IO_SIZE_LIMIT'
  | 'AUTHORITY_IO_RACE'
  | 'AUTHORITY_IO_DIRECTORY_ENTRY_INVALID';

export class AuthorityIoError extends Error {
  readonly code: AuthorityIoErrorCode;

  constructor(code: AuthorityIoErrorCode, detail: string, cause?: unknown) {
    super(`${code}: ${detail}`, cause === undefined ? undefined : { cause });
    this.name = 'AuthorityIoError';
    this.code = code;
  }
}

export type StableByteCaptureV1 = Readonly<{
  schemaVersion: 1;
  observation: ObservedFileV1;
  rawBytesHash: Sha256;
  byteLength: number;
  copyBytes(): Uint8Array;
}>;

export type StableReadRequestV1 = Readonly<{
  containedRoot: string;
  relativePath: string;
  observedIo: ObservedIoRecorderV1;
  maximumBytes?: number;
  /** @internal 物理相对路径与 recorder token 分离时使用。 */
  observedRelativePath?: string;
}>;

declare const stableRootAnchorBrand: unique symbol;
declare const stableRootIdentityBrand: unique symbol;

/** @internal 只在 callback 生命周期内有效的目录 descriptor capability。 */
export type StableRootAnchorV1 = Readonly<{
  readonly [stableRootAnchorBrand]: 'StableRootAnchorV1';
}>;

/** @internal 跨 phase 只保存已认证 inode 身份，不暴露 descriptor 或路径。 */
export type StableRootIdentityV1 = Readonly<{
  readonly [stableRootIdentityBrand]: 'StableRootIdentityV1';
}>;

type MutableStableRootAnchorState = {
  readonly rootPath: string;
  readonly handle: FileHandle;
  readonly before: BigIntStats;
  readonly identity: StableRootIdentityV1;
  active: boolean;
};

const stableRootAnchorStates = new WeakMap<StableRootAnchorV1, MutableStableRootAnchorState>();
const stableRootIdentityStates = new WeakMap<StableRootIdentityV1, Readonly<{
  rootPath: string;
  before: BigIntStats;
}>>();

export async function withStableRootAnchor<Output>(
  containedRoot: string,
  operation: (anchor: StableRootAnchorV1, identity: StableRootIdentityV1) => Promise<Output>,
): Promise<Output> {
  if (typeof operation !== 'function') return invalidRequest('root anchor operation');
  const anchor = await openStableRootAnchor(containedRoot);
  const state = requireStableRootAnchor(anchor);
  let hasPrimaryFailure = false;
  try {
    return await operation(anchor, state.identity);
  } catch (failure) {
    hasPrimaryFailure = true;
    throw failure;
  } finally {
    await closeStableRootAnchor(anchor, hasPrimaryFailure);
  }
}

/** @internal inventory discovery 的 descriptor lease；必须在 finally 调用 close。 */
export async function openStableRootAnchor(containedRoot: string): Promise<StableRootAnchorV1> {
  assertContainedAuthorityRoot(containedRoot);
  const handle = await openContainedNode(containedRoot, directoryOpenFlags(), containedRoot);
  try {
    const before = await handle.stat({ bigint: true });
    requireNodeType(before, 'DIRECTORY', containedRoot);
    const identity = objectFreezeIntrinsic({}) as StableRootIdentityV1;
    reflectApplyIntrinsic(weakMapSetIntrinsic, stableRootIdentityStates, [identity, objectFreezeIntrinsic({
      rootPath: containedRoot,
      before,
    })]);
    const anchor = objectFreezeIntrinsic({}) as StableRootAnchorV1;
    reflectApplyIntrinsic(weakMapSetIntrinsic, stableRootAnchorStates, [anchor, {
      rootPath: containedRoot,
      handle,
      before,
      identity,
      active: true,
    }]);
    return anchor;
  } catch (failure) {
    await closeHandle(handle, true);
    throw failure;
  }
}

/** @internal 复核 path/descriptor 身份后关闭 inventory-private lease。 */
export async function closeStableRootAnchor(
  anchor: StableRootAnchorV1,
  preservePrimaryFailure = false,
): Promise<void> {
  const state = requireStableRootAnchor(anchor);
  try {
    await requireStableRootAnchorState(state);
  } catch (failure) {
    state.active = false;
    await closeHandle(state.handle, true);
    if (!preservePrimaryFailure) throw failure;
    return;
  }
  state.active = false;
  await closeHandle(state.handle, preservePrimaryFailure);
}

export async function assertStableRootAnchorIdentity(anchor: StableRootAnchorV1): Promise<void> {
  await requireStableRootAnchorState(requireStableRootAnchor(anchor));
}

export async function withBoundStableRootIdentity<Output>(
  identity: StableRootIdentityV1,
  operation: (anchor: StableRootAnchorV1) => Promise<Output>,
): Promise<Output> {
  const expected = requireStableRootIdentity(identity);
  return withStableRootAnchor(expected.rootPath, async (anchor) => {
    const actual = requireStableRootAnchor(anchor).before;
    requireStableDescriptor(expected.before, actual, expected.rootPath);
    return operation(anchor);
  });
}

export type StableAnchoredReadRequestV1 = Readonly<{
  relativePath: string;
  observedIo: ObservedIoRecorderV1;
  maximumBytes?: number;
}>;

export async function captureStableBytesAtRoot(
  anchor: StableRootAnchorV1,
  request: StableAnchoredReadRequestV1,
): Promise<StableByteCaptureV1> {
  const root = requireStableRootAnchor(anchor);
  const authenticated = authenticateAnchoredStableReadRequest(request, root.rootPath);
  return captureStableBytesAuthenticated(authenticated, root);
}

export type StableAnchoredObservedReadRequestV1 = StableAnchoredReadRequestV1 & Readonly<{
  observedRelativePath: string;
}>;

// @internal collection discovery 用物理 child token 相对 descriptor 读取，同时沿用 Change-root
// recorder token；两个 token 都先完成 strict path authentication。
export async function captureStableBytesAtRootForObservation(
  anchor: StableRootAnchorV1,
  request: StableAnchoredObservedReadRequestV1,
): Promise<StableByteCaptureV1> {
  const root = requireStableRootAnchor(anchor);
  const authenticated = authenticateAnchoredObservedReadRequest(request, root.rootPath);
  return captureStableBytesAuthenticated(authenticated, root);
}

export async function captureStableBytes(
  request: StableReadRequestV1,
): Promise<StableByteCaptureV1> {
  return captureStableBytesAuthenticated(authenticateStableReadRequest(request, true));
}

export async function observeStableDirectory(
  request: Omit<StableReadRequestV1, 'maximumBytes'>,
): Promise<ObservedDirectoryV1> {
  return observeStableDirectoryInternal(request);
}

export async function observeStableRootDirectory(
  anchor: StableRootAnchorV1,
  observedIo: ObservedIoRecorderV1,
  observedRelativePath: string,
): Promise<ObservedDirectoryV1> {
  const root = requireStableRootAnchor(anchor);
  assertObservedIoRecorder(observedIo);
  assertAuthorityRelativeToken(observedRelativePath);
  return observeDirectoryHandle(root.handle, observedIo, observedRelativePath, root.rootPath);
}

async function observeStableDirectoryInternal(
  request: Omit<StableReadRequestV1, 'maximumBytes'>,
): Promise<ObservedDirectoryV1> {
  const authenticated = authenticateStableReadRequest(request, false);

  return withAnchoredFinal(
    authenticated.containedRoot,
    authenticated.relativePath,
    async (anchoredPath) => {
      let handle: FileHandle | undefined;
      let hasPrimaryFailure = false;
      try {
        handle = await openContainedNode(
          anchoredPath,
          directoryOpenFlags(),
          authenticated.relativePath,
        );
        return await observeDirectoryHandle(
          handle,
          authenticated.observedIo,
          authenticated.relativePath,
          anchoredPath,
        );
      } catch (failure) {
        hasPrimaryFailure = true;
        throw failure;
      } finally {
        await closeHandle(handle, hasPrimaryFailure);
      }
    },
  );
}

async function observeDirectoryHandle(
  handle: FileHandle,
  observedIo: ObservedIoRecorderV1,
  observedRelativePath: string,
  anchoredPath: string,
): Promise<ObservedDirectoryV1> {
  const before = await handle.stat({ bigint: true });
  requireNodeType(before, 'DIRECTORY', observedRelativePath);
  const rawEntries = await readObservedDirectoryEntries(
    observedIo,
    observedRelativePath,
    procDescriptorPath(handle.fd),
  );
  // 目录名是身份 token；ignoreBOM=true 保留开头 U+FEFF，而不是按文本文件 BOM 吞掉。
  const decoder = new TextDecoderIntrinsic('utf-8', { fatal: true, ignoreBOM: true });
  const typedEntries: ObservedDirectoryEntryV1[] = [];
  for (let index = 0; index < rawEntries.length; index += 1) {
    const entry = rawEntries[index]!;
    let decoded: string;
    try {
      decoded = reflectApplyIntrinsic(textDecoderDecodeIntrinsic, decoder, [entry.name]) as string;
    } catch (cause) {
      throw new AuthorityIoError('AUTHORITY_IO_DIRECTORY_ENTRY_INVALID', observedRelativePath, cause);
    }
    assertCanonicalDirectoryEntry(decoded, observedRelativePath);
    arrayPush(typedEntries, objectFreezeIntrinsic({
      name: decoded,
      nodeType: directoryEntryNodeType(entry),
    }));
  }
  reflectApplyIntrinsic(arraySortIntrinsic, typedEntries, [(
    left: ObservedDirectoryEntryV1,
    right: ObservedDirectoryEntryV1,
  ) => compareCodeUnits(left.name, right.name)]);
  const entries: string[] = [];
  for (let index = 0; index < typedEntries.length; index += 1) {
    arrayPush(entries, typedEntries[index]!.name);
  }
  const after = await handle.stat({ bigint: true });
  requireStableDescriptor(before, after, observedRelativePath);
  await requireAnchoredIdentity(anchoredPath, after, observedRelativePath);
  return freezeObservedDirectory({
    relativePath: observedRelativePath,
    device: after.dev,
    inode: after.ino,
    mode: permissionMode(after.mode),
    entries,
    typedEntries,
    inventoryHash: hashDirectoryEntries(typedEntries),
    modifiedAtNanoseconds: after.mtimeNs,
    changedAtNanoseconds: after.ctimeNs,
  });
}

export function assertAuthorityRelativeToken(relativePath: string): void {
  if (typeof relativePath !== 'string'
    || relativePath.length === 0
    || relativePath !== stringNormalize(relativePath, 'NFC')
    || !hasOnlyUnicodeScalars(relativePath)
    || stringIncludes(relativePath, '\\')
    || stringIncludes(relativePath, '\0')
    || regexpTest(/[\u0001-\u001f\u007f]/u, relativePath)
    || stringStartsWith(relativePath, '/')
    || stringEndsWith(relativePath, '/')
    || regexpTest(/^[A-Za-z]:[\\/]/u, relativePath)
    || stringIncludes(relativePath, '%')
    || Buffer.byteLength(relativePath, 'utf8') > 1024) {
    throw new AuthorityIoError('AUTHORITY_IO_PATH_INVALID', String(relativePath));
  }
  const segments = stringSplit(relativePath, '/');
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment.length === 0
      || segment === '.'
      || segment === '..'
      || Buffer.byteLength(segment, 'utf8') > 255) {
      throw new AuthorityIoError('AUTHORITY_IO_PATH_INVALID', relativePath);
    }
  }
}

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function captureStableBytesAuthenticated(
  authenticated: StableReadRequestV1,
  rootAnchor?: MutableStableRootAnchorState,
): Promise<StableByteCaptureV1> {
  const maximumBytes = authenticated.maximumBytes ?? DEFAULT_MAXIMUM_BYTES;
  const observedRelativePath = authenticated.observedRelativePath ?? authenticated.relativePath;

  return withAnchoredFinal(
    authenticated.containedRoot,
    authenticated.relativePath,
    async (anchoredPath) => {
      let handle: FileHandle | undefined;
      let hasPrimaryFailure = false;
      try {
        handle = await openObservedStableFileContained(
          authenticated.observedIo,
          observedRelativePath,
          anchoredPath,
        );
        const before = await handle.stat({ bigint: true });
        requireNodeType(before, 'FILE', authenticated.relativePath);
        if (before.size < 0n || before.size > BigInt(maximumBytes)) {
          throw new AuthorityIoError('AUTHORITY_IO_SIZE_LIMIT', authenticated.relativePath);
        }

        const expectedLength = Number(before.size);
        const allocationLength = expectedLength + 1;
        const bytes = Buffer.allocUnsafe(allocationLength);
        let total = 0;
        let reachedEof = false;
        while (total < allocationLength) {
          const result = await handle.read(bytes, total, allocationLength - total, total);
          if (result.bytesRead === 0) {
            reachedEof = true;
            break;
          }
          total += result.bytesRead;
        }

        const after = await handle.stat({ bigint: true });
        requireStableDescriptor(before, after, authenticated.relativePath);
        if (!reachedEof || total !== expectedLength) {
          throw new AuthorityIoError('AUTHORITY_IO_RACE', authenticated.relativePath);
        }
        await requireAnchoredIdentity(anchoredPath, after, authenticated.relativePath);

        const privateBytes = new Uint8ArrayIntrinsic(total);
        for (let index = 0; index < total; index += 1) privateBytes[index] = bytes[index]!;
        const observation = freezeObservedFile({
          relativePath: observedRelativePath,
          device: after.dev,
          inode: after.ino,
          mode: permissionMode(after.mode),
          byteLength: total,
          modifiedAtNanoseconds: after.mtimeNs,
          changedAtNanoseconds: after.ctimeNs,
        });
        return objectFreezeIntrinsic({
          schemaVersion: 1,
          observation,
          rawBytesHash: hashBytes(privateBytes),
          byteLength: total,
          copyBytes(): Uint8Array {
            const copy = new Uint8ArrayIntrinsic(total);
            for (let index = 0; index < total; index += 1) {
              copy[index] = privateBytes[index]!;
            }
            return copy;
          },
        });
      } catch (failure) {
        hasPrimaryFailure = true;
        throw failure;
      } finally {
        await closeHandle(handle, hasPrimaryFailure);
      }
    },
    rootAnchor,
  );
}

async function withAnchoredFinal<T>(
  containedRoot: string,
  relativePath: string,
  operation: (anchoredPath: string) => Promise<T>,
  rootAnchor?: MutableStableRootAnchorState,
): Promise<T> {
  const handles: FileHandle[] = [];
  const anchors: Array<Readonly<{
    handle: FileHandle;
    anchoredPath: string;
    before: BigIntStats;
  }>> = [];
  let hasPrimaryFailure = false;
  try {
    const rootHandle = rootAnchor?.handle
      ?? await openContainedNode(containedRoot, directoryOpenFlags(), containedRoot);
    if (rootAnchor === undefined) arrayPush(handles, rootHandle);
    const rootStats = rootAnchor?.before ?? await rootHandle.stat({ bigint: true });
    requireNodeType(rootStats, 'DIRECTORY', containedRoot);
    arrayPush(anchors, objectFreezeIntrinsic({
      handle: rootHandle,
      anchoredPath: containedRoot,
      before: rootStats,
    }));

    const segments = stringSplit(relativePath, '/');
    let parent = rootHandle;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const component = segments[index]!;
      const child = await openContainedNode(
        join(procDescriptorPath(parent.fd), component),
        directoryOpenFlags(),
        relativePath,
      );
      arrayPush(handles, child);
      const childStats = await child.stat({ bigint: true });
      requireNodeType(childStats, 'DIRECTORY', relativePath);
      arrayPush(anchors, objectFreezeIntrinsic({
        handle: child,
        anchoredPath: join(procDescriptorPath(parent.fd), component),
        before: childStats,
      }));
      parent = child;
    }
    const result = await operation(join(procDescriptorPath(parent.fd), segments[segments.length - 1]!));
    for (const anchor of anchors) {
      const after = await anchor.handle.stat({ bigint: true });
      requireStableDescriptor(anchor.before, after, relativePath);
      await requireAnchoredIdentity(anchor.anchoredPath, after, relativePath);
    }
    return result;
  } catch (failure) {
    hasPrimaryFailure = true;
    throw failure;
  } finally {
    await closeAllHandles(handles, hasPrimaryFailure);
  }
}

function requireStableRootAnchor(anchor: StableRootAnchorV1): MutableStableRootAnchorState {
  if (anchor === null || typeof anchor !== 'object' || isProxy(anchor)) {
    throw new AuthorityIoError('AUTHORITY_IO_REQUEST_INVALID', 'root anchor');
  }
  const state = reflectApplyIntrinsic(
    weakMapGetIntrinsic,
    stableRootAnchorStates,
    [anchor],
  ) as MutableStableRootAnchorState | undefined;
  if (state === undefined || !state.active) {
    throw new AuthorityIoError('AUTHORITY_IO_REQUEST_INVALID', 'root anchor');
  }
  return state;
}

function requireStableRootIdentity(identity: StableRootIdentityV1): Readonly<{
  rootPath: string;
  before: BigIntStats;
}> {
  if (identity === null || typeof identity !== 'object' || isProxy(identity)) {
    return invalidRequest('root identity');
  }
  const state = reflectApplyIntrinsic(
    weakMapGetIntrinsic,
    stableRootIdentityStates,
    [identity],
  ) as ReturnType<typeof requireStableRootIdentity> | undefined;
  if (state === undefined) return invalidRequest('root identity');
  return state;
}

async function requireStableRootAnchorState(state: MutableStableRootAnchorState): Promise<void> {
  const after = await state.handle.stat({ bigint: true });
  requireStableDescriptor(state.before, after, state.rootPath);
  await requireAnchoredIdentity(state.rootPath, after, state.rootPath);
}

async function openContainedNode(path: string, flags: number, detail: string): Promise<FileHandle> {
  try {
    return await open(path, flags);
  } catch (cause) {
    throw new AuthorityIoError('AUTHORITY_IO_CONTAINMENT', detail, cause);
  }
}

async function openObservedStableFileContained(
  recorder: ObservedIoRecorderV1,
  relativePath: string,
  path: string,
): Promise<FileHandle> {
  try {
    return await openObservedStableFile(recorder, relativePath, path, fileOpenFlags());
  } catch (cause) {
    throw new AuthorityIoError('AUTHORITY_IO_CONTAINMENT', relativePath, cause);
  }
}

function fileOpenFlags(): number {
  return constants.O_RDONLY
    | requireLinuxOpenFlag('O_NOFOLLOW')
    | requireLinuxOpenFlag('O_NONBLOCK');
}

function directoryOpenFlags(): number {
  return fileOpenFlags() | requireLinuxOpenFlag('O_DIRECTORY');
}

function requireLinuxOpenFlag(name: 'O_NOFOLLOW' | 'O_NONBLOCK' | 'O_DIRECTORY'): number {
  const value = constants[name];
  if (typeof value !== 'number') {
    throw new AuthorityIoError('AUTHORITY_IO_CONTAINMENT', `Linux ${name} is unavailable`);
  }
  return value;
}

function authenticateStableReadRequest(
  request: unknown,
  allowMaximumBytes: boolean,
): StableReadRequestV1 {
  if (request === null || typeof request !== 'object') return invalidRequest('object');
  if (isProxy(request)) return invalidRequest('proxy');
  const prototype = Object.getPrototypeOf(request);
  if (prototype !== Object.prototype && prototype !== null) return invalidRequest('prototype');
  const requiredKeys = ['containedRoot', 'relativePath', 'observedIo'] as const;
  const allowedKeys = allowMaximumBytes ? [...requiredKeys, 'maximumBytes'] : [...requiredKeys];
  const ownKeys = Reflect.ownKeys(request);
  if (ownKeys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))) {
    return invalidRequest('own keys');
  }
  for (const required of requiredKeys) {
    if (!ownKeys.includes(required)) return invalidRequest(required);
  }

  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of ownKeys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(request, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      return invalidRequest(key);
    }
    values[key] = descriptor.value;
  }
  if (typeof values.containedRoot !== 'string') return invalidRequest('containedRoot');
  if (typeof values.relativePath !== 'string') return invalidRequest('relativePath');
  assertContainedAuthorityRoot(values.containedRoot);
  assertAuthorityRelativeToken(values.relativePath);
  assertObservedIoRecorder(values.observedIo as ObservedIoRecorderV1);

  if (ownKeys.includes('maximumBytes')) {
    const maximumBytes = requireMaximumBytes(values.maximumBytes as number | undefined);
    return objectFreezeIntrinsic({
      containedRoot: values.containedRoot,
      relativePath: values.relativePath,
      observedIo: values.observedIo as ObservedIoRecorderV1,
      maximumBytes,
    });
  }
  return objectFreezeIntrinsic({
    containedRoot: values.containedRoot,
    relativePath: values.relativePath,
    observedIo: values.observedIo as ObservedIoRecorderV1,
  });
}

function authenticateAnchoredStableReadRequest(
  request: unknown,
  containedRoot: string,
): StableReadRequestV1 {
  if (request === null || typeof request !== 'object') return invalidRequest('object');
  if (isProxy(request)) return invalidRequest('proxy');
  const prototype = Object.getPrototypeOf(request);
  if (prototype !== Object.prototype && prototype !== null) return invalidRequest('prototype');
  const ownKeys = Reflect.ownKeys(request);
  if (ownKeys.some((key) => typeof key !== 'string'
    || (key !== 'relativePath' && key !== 'observedIo' && key !== 'maximumBytes'))
    || !arrayIncludes(ownKeys, 'relativePath')
    || !arrayIncludes(ownKeys, 'observedIo')) {
    return invalidRequest('own keys');
  }
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of ownKeys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(request, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      return invalidRequest(key);
    }
    values[key] = descriptor.value;
  }
  if (typeof values.relativePath !== 'string') return invalidRequest('relativePath');
  assertAuthorityRelativeToken(values.relativePath);
  assertObservedIoRecorder(values.observedIo as ObservedIoRecorderV1);
  if (arrayIncludes(ownKeys, 'maximumBytes')) {
    return objectFreezeIntrinsic({
      containedRoot,
      relativePath: values.relativePath,
      observedIo: values.observedIo as ObservedIoRecorderV1,
      maximumBytes: requireMaximumBytes(values.maximumBytes as number | undefined),
    });
  }
  return objectFreezeIntrinsic({
    containedRoot,
    relativePath: values.relativePath,
    observedIo: values.observedIo as ObservedIoRecorderV1,
  });
}

function authenticateAnchoredObservedReadRequest(
  request: unknown,
  containedRoot: string,
): StableReadRequestV1 {
  if (request === null || typeof request !== 'object' || isProxy(request)) {
    return invalidRequest('anchored observed request');
  }
  const prototype = Object.getPrototypeOf(request);
  if (prototype !== Object.prototype && prototype !== null) return invalidRequest('prototype');
  const ownKeys = Reflect.ownKeys(request);
  const expectedKeys = ['relativePath', 'observedIo', 'observedRelativePath'] as const;
  if (ownKeys.length !== expectedKeys.length
    || ownKeys.some((key) => typeof key !== 'string' || !arrayIncludes(expectedKeys, key))) {
    return invalidRequest('own keys');
  }
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (let index = 0; index < expectedKeys.length; index += 1) {
    const key = expectedKeys[index]!;
    const descriptor = Object.getOwnPropertyDescriptor(request, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      return invalidRequest(key);
    }
    values[key] = descriptor.value;
  }
  if (typeof values.relativePath !== 'string'
    || typeof values.observedRelativePath !== 'string') return invalidRequest('relative paths');
  assertAuthorityRelativeToken(values.relativePath);
  assertAuthorityRelativeToken(values.observedRelativePath);
  assertObservedIoRecorder(values.observedIo as ObservedIoRecorderV1);
  return objectFreezeIntrinsic({
    containedRoot,
    relativePath: values.relativePath,
    observedRelativePath: values.observedRelativePath,
    observedIo: values.observedIo as ObservedIoRecorderV1,
  });
}

function invalidRequest(detail: string): never {
  throw new AuthorityIoError('AUTHORITY_IO_REQUEST_INVALID', detail);
}

export function assertContainedAuthorityRoot(containedRoot: string): void {
  const parsedRoot = typeof containedRoot === 'string' ? parse(containedRoot).root : '';
  if (typeof containedRoot !== 'string'
    || !isAbsolute(containedRoot)
    || normalize(containedRoot) !== containedRoot
    || stringIncludes(containedRoot, '\0')
    || containedRoot !== stringNormalize(containedRoot, 'NFC')
    || !hasOnlyUnicodeScalars(containedRoot)
    || regexpTest(/[\u0001-\u001f\u007f]/u, containedRoot)
    || (containedRoot !== parsedRoot && stringEndsWith(containedRoot, sep))) {
    throw new AuthorityIoError('AUTHORITY_IO_PATH_INVALID', String(containedRoot));
  }
}

function requireMaximumBytes(value: number | undefined): number {
  const maximumBytes = value ?? DEFAULT_MAXIMUM_BYTES;
  if (!Number.isSafeInteger(maximumBytes)
    || maximumBytes < 0
    || maximumBytes > DEFAULT_MAXIMUM_BYTES) {
    throw new AuthorityIoError('AUTHORITY_IO_SIZE_LIMIT', String(maximumBytes));
  }
  return maximumBytes;
}

function requireNodeType(
  stats: BigIntStats,
  expected: 'FILE' | 'DIRECTORY',
  relativePath: string,
): void {
  const matches = expected === 'FILE' ? stats.isFile() : stats.isDirectory();
  if (!matches) throw new AuthorityIoError('AUTHORITY_IO_NODE_TYPE', relativePath);
}

function requireStableDescriptor(before: BigIntStats, after: BigIntStats, detail: string): void {
  if (before.dev !== after.dev
    || before.ino !== after.ino
    || (before.mode & POSIX_TYPE_MASK) !== (after.mode & POSIX_TYPE_MASK)
    || before.mode !== after.mode
    || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs
    || before.ctimeNs !== after.ctimeNs) {
    throw new AuthorityIoError('AUTHORITY_IO_RACE', detail);
  }
}

async function requireAnchoredIdentity(
  anchoredPath: string,
  descriptorStats: BigIntStats,
  detail: string,
): Promise<void> {
  let pathStats: BigIntStats;
  try {
    pathStats = await lstat(anchoredPath, { bigint: true });
  } catch (cause) {
    throw new AuthorityIoError('AUTHORITY_IO_RACE', detail, cause);
  }
  requireStableDescriptor(descriptorStats, pathStats, detail);
}

function assertCanonicalDirectoryEntry(entry: string, directory: string): void {
  try {
    assertAuthorityRelativeToken(entry);
  } catch (cause) {
    throw new AuthorityIoError('AUTHORITY_IO_DIRECTORY_ENTRY_INVALID', directory, cause);
  }
  if (stringIncludes(entry, '/')) {
    throw new AuthorityIoError('AUTHORITY_IO_DIRECTORY_ENTRY_INVALID', directory);
  }
}

function permissionMode(mode: bigint): number {
  return Number(mode & 0o7777n);
}

function hashBytes(bytes: Uint8Array): Sha256 {
  const hash = createHash('sha256');
  reflectApplyIntrinsic(hashUpdateIntrinsic, hash, [bytes]);
  const digest = reflectApplyIntrinsic(hashDigestIntrinsic, hash, ['hex']) as string;
  return parseSha256(`sha256:${digest}`);
}

function hashDirectoryEntries(entries: readonly ObservedDirectoryEntryV1[]): Sha256 {
  const hash = createHash('sha256');
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const bytes = Buffer.from(entry.name, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.byteLength);
    reflectApplyIntrinsic(hashUpdateIntrinsic, hash, [length]);
    reflectApplyIntrinsic(hashUpdateIntrinsic, hash, [bytes]);
    reflectApplyIntrinsic(hashUpdateIntrinsic, hash, [
      Buffer.from([directoryNodeTypeToken(entry.nodeType)]),
    ]);
  }
  const digest = reflectApplyIntrinsic(hashDigestIntrinsic, hash, ['hex']) as string;
  return parseSha256(`sha256:${digest}`);
}

function directoryEntryNodeType(entry: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
}): ObservedDirectoryNodeTypeV1 {
  if (entry.isFile()) return 'FILE';
  if (entry.isDirectory()) return 'DIRECTORY';
  if (entry.isSymbolicLink()) return 'SYMBOLIC_LINK';
  if (entry.isFIFO()) return 'FIFO';
  if (entry.isSocket()) return 'SOCKET';
  if (entry.isBlockDevice()) return 'BLOCK_DEVICE';
  if (entry.isCharacterDevice()) return 'CHARACTER_DEVICE';
  return 'UNKNOWN';
}

function directoryNodeTypeToken(nodeType: ObservedDirectoryNodeTypeV1): number {
  switch (nodeType) {
    case 'FILE': return 1;
    case 'DIRECTORY': return 2;
    case 'SYMBOLIC_LINK': return 3;
    case 'FIFO': return 4;
    case 'SOCKET': return 5;
    case 'BLOCK_DEVICE': return 6;
    case 'CHARACTER_DEVICE': return 7;
    case 'UNKNOWN': return 255;
  }
}

function procDescriptorPath(descriptor: number): string {
  return `/proc/self/fd/${descriptor}`;
}

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

async function closeHandle(
  handle: FileHandle | undefined,
  preservePrimaryFailure: boolean,
): Promise<void> {
  if (handle === undefined) return;
  try {
    await handle.close();
  } catch (failure) {
    if (!preservePrimaryFailure) throw failure;
  }
}

async function closeAllHandles(
  handles: readonly FileHandle[],
  preservePrimaryFailure: boolean,
): Promise<void> {
  let hasCloseFailure = false;
  let firstFailure: unknown;
  for (let index = handles.length - 1; index >= 0; index -= 1) {
    try {
      await handles[index]!.close();
    } catch (failure) {
      if (!hasCloseFailure) firstFailure = failure;
      hasCloseFailure = true;
    }
  }
  if (hasCloseFailure && !preservePrimaryFailure) throw firstFailure;
}

function arrayPush<Value>(array: Value[], value: Value): void {
  reflectApplyIntrinsic(arrayPushIntrinsic, array, [value]);
}

function arrayIncludes<Value>(array: readonly Value[], value: Value): boolean {
  return reflectApplyIntrinsic(arrayIncludesIntrinsic, array, [value]) as boolean;
}

function regexpTest(expression: RegExp, value: string): boolean {
  return reflectApplyIntrinsic(regexpTestIntrinsic, expression, [value]) as boolean;
}

function stringEndsWith(value: string, search: string): boolean {
  return reflectApplyIntrinsic(stringEndsWithIntrinsic, value, [search]) as boolean;
}

function stringIncludes(value: string, search: string): boolean {
  return reflectApplyIntrinsic(stringIncludesIntrinsic, value, [search]) as boolean;
}

function stringNormalize(value: string, form: 'NFC'): string {
  return reflectApplyIntrinsic(stringNormalizeIntrinsic, value, [form]) as string;
}

function stringSplit(value: string, separator: string): string[] {
  return reflectApplyIntrinsic(stringSplitIntrinsic, value, [separator]) as string[];
}

function stringStartsWith(value: string, search: string): boolean {
  return reflectApplyIntrinsic(stringStartsWithIntrinsic, value, [search]) as boolean;
}
