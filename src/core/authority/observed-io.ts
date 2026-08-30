import type { Dirent } from 'node:fs';
import { open, readdir, type FileHandle } from 'node:fs/promises';
import type { Sha256 } from '../../domain/scalars.js';

export type ObservedIoCountersV1 = Readonly<{
  fileOpens: ReadonlyMap<string, number>;
  directoryReads: ReadonlyMap<string, number>;
  stableCaptures: ReadonlyMap<string, number>;
}>;

export type ObservedFileV1 = Readonly<{
  schemaVersion: 1;
  relativePath: string;
  nodeType: 'FILE';
  device: bigint;
  inode: bigint;
  mode: number;
  byteLength: number;
  modifiedAtNanoseconds: bigint;
  changedAtNanoseconds: bigint;
}>;

export type ObservedDirectoryNodeTypeV1 =
  | 'FILE'
  | 'DIRECTORY'
  | 'SYMBOLIC_LINK'
  | 'FIFO'
  | 'SOCKET'
  | 'BLOCK_DEVICE'
  | 'CHARACTER_DEVICE'
  | 'UNKNOWN';

export type ObservedDirectoryEntryV1 = Readonly<{
  name: string;
  nodeType: ObservedDirectoryNodeTypeV1;
}>;

export type ObservedDirectoryV1 = Readonly<{
  schemaVersion: 1;
  relativePath: string;
  nodeType: 'DIRECTORY';
  device: bigint;
  inode: bigint;
  mode: number;
  entries: readonly string[];
  typedEntries: readonly ObservedDirectoryEntryV1[];
  inventoryHash: Sha256;
  modifiedAtNanoseconds: bigint;
  changedAtNanoseconds: bigint;
}>;

export type ObservedIoRecorderV1 = Readonly<{
  snapshot(): ObservedIoCountersV1;
}>;

type MutableCounterEntry = {
  readonly relativePath: string;
  count: number;
};

type MutableObservedIo = {
  readonly fileOpens: MutableCounterEntry[];
  readonly directoryReads: MutableCounterEntry[];
  readonly stableCaptures: MutableCounterEntry[];
};

const recorderStates = new WeakMap<ObservedIoRecorderV1, MutableObservedIo>();
const reflectApplyIntrinsic = Reflect.apply;
const objectFreezeIntrinsic = Object.freeze;
const arrayPushIntrinsic = Array.prototype.push;
const weakMapGetIntrinsic = WeakMap.prototype.get;
const weakMapSetIntrinsic = WeakMap.prototype.set;

// 背景：Object.freeze(new Map()) 仍允许 set/delete/clear 改写内部槽，而且运行期替换
// Map.prototype 方法可取得或篡改 backing Map。目的：只保存冻结 entries，并以索引读取；任何
// iterator 都只得到新 pair。上下文：该容器只承载已冻结值或标量。
class FrozenReadonlyMap<K, V> implements ReadonlyMap<K, V> {
  readonly #entries: readonly (readonly [K, V])[];

  constructor(entries: Iterable<readonly [K, V]>) {
    const copied: Array<readonly [K, V]> = [];
    for (const [key, value] of entries) {
      let replaced = false;
      for (let index = 0; index < copied.length; index += 1) {
        if (sameValueZero(copied[index]![0], key)) {
          copied[index] = objectFreezeIntrinsic([key, value]);
          replaced = true;
          break;
        }
      }
      if (!replaced) arrayPush(copied, objectFreezeIntrinsic([key, value]));
    }
    this.#entries = objectFreezeIntrinsic(copied);
    objectFreezeIntrinsic(this);
  }

  get size(): number {
    return this.#entries.length;
  }

  get(key: K): V | undefined {
    for (let index = 0; index < this.#entries.length; index += 1) {
      const pair = this.#entries[index]!;
      if (sameValueZero(pair[0], key)) return pair[1];
    }
    return undefined;
  }

  has(key: K): boolean {
    for (let index = 0; index < this.#entries.length; index += 1) {
      if (sameValueZero(this.#entries[index]![0], key)) return true;
    }
    return false;
  }

  entries(): MapIterator<[K, V]> {
    return createReadonlyMapIterator(this.#entries, 'ENTRY');
  }

  keys(): MapIterator<K> {
    return createReadonlyMapIterator(this.#entries, 'KEY');
  }

  values(): MapIterator<V> {
    return createReadonlyMapIterator(this.#entries, 'VALUE');
  }

  forEach(
    callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
    thisArg?: unknown,
  ): void {
    for (let index = 0; index < this.#entries.length; index += 1) {
      const pair = this.#entries[index]!;
      reflectApplyIntrinsic(callbackfn, thisArg, [pair[1], pair[0], this]);
    }
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return 'FrozenReadonlyMap';
  }
}

objectFreezeIntrinsic(FrozenReadonlyMap.prototype);

function sameValueZero(left: unknown, right: unknown): boolean {
  return left === right || (left !== left && right !== right);
}

function createReadonlyMapIterator<K, V>(
  entries: readonly (readonly [K, V])[],
  kind: 'ENTRY',
): MapIterator<[K, V]>;
function createReadonlyMapIterator<K, V>(
  entries: readonly (readonly [K, V])[],
  kind: 'KEY',
): MapIterator<K>;
function createReadonlyMapIterator<K, V>(
  entries: readonly (readonly [K, V])[],
  kind: 'VALUE',
): MapIterator<V>;
function createReadonlyMapIterator<K, V>(
  entries: readonly (readonly [K, V])[],
  kind: 'ENTRY' | 'KEY' | 'VALUE',
): MapIterator<[K, V]> | MapIterator<K> | MapIterator<V> {
  let index = 0;
  const iterator = {
    next(): IteratorResult<[K, V] | K | V> {
      if (index >= entries.length) return objectFreezeIntrinsic({ done: true, value: undefined });
      const pair = entries[index++]!;
      const value = kind === 'ENTRY' ? [pair[0], pair[1]] as [K, V]
        : kind === 'KEY' ? pair[0] : pair[1];
      return objectFreezeIntrinsic({ done: false, value });
    },
    [Symbol.iterator]() {
      return this;
    },
    [Symbol.dispose]() {
      index = entries.length;
    },
  };
  return objectFreezeIntrinsic(iterator) as MapIterator<[K, V]> | MapIterator<K> | MapIterator<V>;
}

export function freezeReadonlyMap<K, V>(
  entries: Iterable<readonly [K, V]>,
): ReadonlyMap<K, V> {
  return new FrozenReadonlyMap(entries);
}

export function createObservedIoRecorder(): ObservedIoRecorderV1 {
  const state: MutableObservedIo = {
    fileOpens: [],
    directoryReads: [],
    stableCaptures: [],
  };
  let recorder: ObservedIoRecorderV1;
  recorder = objectFreezeIntrinsic({
    snapshot(): ObservedIoCountersV1 {
      requireRecorderState(recorder);
      return objectFreezeIntrinsic({
        fileOpens: freezeReadonlyMap(copyCounterEntries(state.fileOpens)),
        directoryReads: freezeReadonlyMap(copyCounterEntries(state.directoryReads)),
        stableCaptures: freezeReadonlyMap(copyCounterEntries(state.stableCaptures)),
      });
    },
  });
  weakMapSet(recorderStates, recorder, state);
  return recorder;
}

/** @internal 唯一会增加 file/stable counter 的入口，同时执行真实 final open。 */
export async function openObservedStableFile(
  recorder: ObservedIoRecorderV1,
  relativePath: string,
  path: string,
  flags: number,
): Promise<FileHandle> {
  const state = requireRecorderState(recorder);
  incrementCounter(state.stableCaptures, relativePath);
  incrementCounter(state.fileOpens, relativePath);
  return open(path, flags);
}

/** @internal 唯一会增加 directory counter 的入口，同时执行真实 descriptor readdir。 */
export async function readObservedDirectoryEntries(
  recorder: ObservedIoRecorderV1,
  relativePath: string,
  descriptorPath: string,
): Promise<Dirent<Buffer>[]> {
  const state = requireRecorderState(recorder);
  incrementCounter(state.directoryReads, relativePath);
  return readdir(descriptorPath, { encoding: 'buffer', withFileTypes: true });
}

/** @internal 让零目标 inventory 也不能绕过真实 recorder capability。 */
export function assertObservedIoRecorder(
  recorder: ObservedIoRecorderV1,
): void {
  requireRecorderState(recorder);
}

/** @internal 由稳定 descriptor 读取器在完整比较通过后构造。 */
export function freezeObservedFile(
  value: Omit<ObservedFileV1, 'schemaVersion' | 'nodeType'>,
): ObservedFileV1 {
  return objectFreezeIntrinsic({ ...value, schemaVersion: 1, nodeType: 'FILE' });
}

/** @internal 由稳定目录读取器在完整比较通过后构造。 */
export function freezeObservedDirectory(
  value: Omit<ObservedDirectoryV1, 'schemaVersion' | 'nodeType' | 'entries' | 'typedEntries'> & {
    entries: readonly string[];
    typedEntries: readonly ObservedDirectoryEntryV1[];
  },
): ObservedDirectoryV1 {
  const entries: string[] = [];
  for (let index = 0; index < value.entries.length; index += 1) {
    arrayPush(entries, value.entries[index]!);
  }
  const typedEntries: ObservedDirectoryEntryV1[] = [];
  for (let index = 0; index < value.typedEntries.length; index += 1) {
    const entry = value.typedEntries[index]!;
    arrayPush(typedEntries, objectFreezeIntrinsic({ name: entry.name, nodeType: entry.nodeType }));
  }
  return objectFreezeIntrinsic({
    ...value,
    schemaVersion: 1,
    nodeType: 'DIRECTORY',
    entries: objectFreezeIntrinsic(entries),
    typedEntries: objectFreezeIntrinsic(typedEntries),
  });
}

function requireRecorderState(recorder: ObservedIoRecorderV1): MutableObservedIo {
  const state = weakMapGet(recorderStates, recorder);
  if (state === undefined) throw new TypeError('AUTHORITY_IO_RECORDER_INVALID');
  return state;
}

function weakMapGet<Key extends object, Value>(
  map: WeakMap<Key, Value>,
  key: Key,
): Value | undefined {
  return reflectApplyIntrinsic(weakMapGetIntrinsic, map, [key]) as Value | undefined;
}

function weakMapSet<Key extends object, Value>(
  map: WeakMap<Key, Value>,
  key: Key,
  value: Value,
): void {
  reflectApplyIntrinsic(weakMapSetIntrinsic, map, [key, value]);
}

function incrementCounter(counter: MutableCounterEntry[], relativePath: string): void {
  for (let index = 0; index < counter.length; index += 1) {
    const entry = counter[index]!;
    if (entry.relativePath === relativePath) {
      entry.count += 1;
      return;
    }
  }
  arrayPush(counter, { relativePath, count: 1 });
}

function copyCounterEntries(
  counter: readonly MutableCounterEntry[],
): readonly (readonly [string, number])[] {
  const copied: Array<readonly [string, number]> = [];
  for (let index = 0; index < counter.length; index += 1) {
    const entry = counter[index]!;
    arrayPush(copied, objectFreezeIntrinsic([entry.relativePath, entry.count]));
  }
  return objectFreezeIntrinsic(copied);
}

function arrayPush<Value>(array: Value[], value: Value): void {
  reflectApplyIntrinsic(arrayPushIntrinsic, array, [value]);
}
