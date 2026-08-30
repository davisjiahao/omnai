import { isProxy } from 'node:util/types';
import { hashStrictObject } from '../../authority/catalog-schema.js';
import { parseSha256, type Sha256 } from '../../domain/scalars.js';
import {
  requireSealedContextMachineState,
  type ChangeAuthorityContext,
} from './context.js';
import type { AuthorityInventoryV1 } from './inventory.js';
import {
  createObservedIoRecorder,
  type ObservedDirectoryV1,
  type ObservedIoCountersV1,
} from './observed-io.js';
import {
  assertAuthorityRelativeToken,
  captureStableBytes,
  compareCodeUnits,
  observeStableDirectory,
  type StableByteCaptureV1,
} from './stable-bytes.js';

export type MachineAuthorityFileRowV1 = Readonly<{
  relativePath: string;
  nodeType: 'FILE';
  mode: number;
  rawBytesHash: Sha256;
}>;

export type MachineAuthorityDirectoryRowV1 = Readonly<{
  relativePath: string;
  nodeType: 'DIRECTORY';
  mode: number;
  inventoryHash: Sha256;
}>;

export type MachineAuthorityRowV1 = MachineAuthorityFileRowV1 | MachineAuthorityDirectoryRowV1;

export type MachineAuthorityProjectionV1 = Readonly<{
  schemaVersion: 1;
  kind: 'MACHINE_AUTHORITY_PROJECTION_V1';
  rows: readonly MachineAuthorityRowV1[];
  projectionHash: Sha256;
}>;

export type MachineAuthorityTargetMutationV1 =
  | Readonly<{ kind: 'UPSERT'; expectedFinal: MachineAuthorityRowV1 }>
  | Readonly<{ kind: 'REMOVE'; relativePath: string }>;

export type PreparedCommitProjectionV1 = Readonly<{
  schemaVersion: 1;
  kind: 'PREPARED_COMMIT_PROJECTION_V1';
  expectedFinalProjectionHash: Sha256;
}>;

export type MachineAuthoritySealV1 = Readonly<{
  schemaVersion: 1;
  kind: 'MACHINE_AUTHORITY_SEAL_V1';
  preflightProjectionHash: Sha256;
  targetSetHash: Sha256;
  untouchedSetHash: Sha256;
  finalProjectionHash: Sha256;
  observedMachineReadSet: readonly MachineAuthorityRowV1[];
  sealHash: Sha256;
}>;

export type CommitSealVerificationV1 = Readonly<{
  seal: MachineAuthoritySealV1;
  observedIo: ObservedIoCountersV1;
}>;

export class MachineAuthorityError extends Error {
  constructor(readonly code: string, detail: string, cause?: unknown) {
    super(`${code}: ${detail}`, cause === undefined ? undefined : { cause });
    this.name = 'MachineAuthorityError';
  }
}

type PreparedState = {
  readonly context: ChangeAuthorityContext;
  readonly containedRoot: string;
  readonly preflightProjectionHash: Sha256;
  readonly targetPaths: readonly string[];
  readonly targetSetHash: Sha256;
  readonly untouchedRows: readonly MachineAuthorityRowV1[];
  readonly untouchedSetHash: Sha256;
  readonly expectedRows: readonly MachineAuthorityRowV1[];
  readonly expectedFinalProjectionHash: Sha256;
  consumed: boolean;
};

type TargetToken =
  | Readonly<{ kind: 'UPSERT'; expectedFinal: MachineAuthorityRowV1 }>
  | Readonly<{ kind: 'REMOVE'; relativePath: string }>;

const preparedStates = new WeakMap<PreparedCommitProjectionV1, PreparedState>();
const reflectApplyIntrinsic = Reflect.apply;
const objectFreezeIntrinsic = Object.freeze;
const arrayPushIntrinsic = Array.prototype.push;
const arraySortIntrinsic = Array.prototype.sort;
const arrayIsArrayIntrinsic = Array.isArray;
const weakMapGetIntrinsic = WeakMap.prototype.get;
const weakMapSetIntrinsic = WeakMap.prototype.set;

/** @internal builder 把固定 WorkflowLock capture 与最终 inventory 投影为 preflight 物理事实。 */
export function buildMachineAuthorityProjection(
  workflowLockCapture: StableByteCaptureV1,
  inventory: AuthorityInventoryV1,
): MachineAuthorityProjectionV1 {
  const rows: MachineAuthorityRowV1[] = [];
  addUniqueRow(rows, rowFromFileCapture(workflowLockCapture));
  for (let index = 0; index < inventory.entries.length; index += 1) {
    const entry = inventory.entries[index]!;
    addUniqueRow(rows, entry.nodeType === 'FILE'
      ? rowFromFileCapture(entry.capture)
      : rowFromDirectory(entry.observation));
  }
  const directories = inventory.observedDirectories.values();
  for (let next = directories.next(); !next.done; next = directories.next()) {
    addUniqueRow(rows, rowFromDirectory(next.value));
  }
  return freezeProjection(rows);
}

export function prepareCommitProjection(
  context: ChangeAuthorityContext,
  rawMutations: readonly MachineAuthorityTargetMutationV1[],
): PreparedCommitProjectionV1 {
  const contextState = requireSealedContextMachineState(context);
  const mutations = readMutations(rawMutations);
  const preflightRows = contextState.machineProjection.rows;
  const targetPaths: string[] = [];
  const upserts: MachineAuthorityRowV1[] = [];
  const targetTokens: TargetToken[] = [];

  for (let index = 0; index < mutations.length; index += 1) {
    const mutation = mutations[index]!;
    const relativePath = mutation.kind === 'UPSERT'
      ? mutation.expectedFinal.relativePath
      : mutation.relativePath;
    if (containsString(targetPaths, relativePath)) fail('AUTHORITY_MACHINE_TARGET_DUPLICATE', relativePath);
    arrayPush(targetPaths, relativePath);
    const prior = findRow(preflightRows, relativePath);
    if (mutation.kind === 'UPSERT') {
      const expected = freezeMachineRow(mutation.expectedFinal);
      if (prior === undefined && findParentDirectory(preflightRows, relativePath) === undefined) {
        fail('AUTHORITY_MACHINE_TARGET_UNKNOWN', relativePath);
      }
      arrayPush(upserts, expected);
      arrayPush(targetTokens, objectFreezeIntrinsic({ kind: 'UPSERT', expectedFinal: expected }));
    } else {
      if (prior === undefined) fail('AUTHORITY_MACHINE_TARGET_UNKNOWN', relativePath);
      arrayPush(targetTokens, objectFreezeIntrinsic({ kind: 'REMOVE', relativePath }));
    }
  }

  for (let index = 0; index < mutations.length; index += 1) {
    const mutation = mutations[index]!;
    const relativePath = mutation.kind === 'UPSERT'
      ? mutation.expectedFinal.relativePath
      : mutation.relativePath;
    const prior = findRow(preflightRows, relativePath);
    const topologyChanges = mutation.kind === 'REMOVE'
      || prior === undefined
      || prior.nodeType !== mutation.expectedFinal.nodeType;
    if (!topologyChanges) continue;
    const parentPath = parentRelativePath(relativePath);
    const parentTarget = parentPath === undefined ? undefined : findRow(upserts, parentPath);
    if (parentPath === undefined
      || parentTarget?.nodeType !== 'DIRECTORY'
      || !containsString(targetPaths, parentPath)) {
      fail('AUTHORITY_MACHINE_PARENT_TARGET_REQUIRED', relativePath);
    }
  }

  const untouchedRows: MachineAuthorityRowV1[] = [];
  for (let index = 0; index < preflightRows.length; index += 1) {
    const row = preflightRows[index]!;
    if (!containsString(targetPaths, row.relativePath)) arrayPush(untouchedRows, row);
  }
  const combinedRows: MachineAuthorityRowV1[] = [];
  appendRows(combinedRows, untouchedRows);
  appendRows(combinedRows, upserts);
  const expectedRows = freezeSortedRows(combinedRows);
  const expectedFinalProjectionHash = projectionHash(expectedRows);
  const canonicalTargetTokens = freezeSortedTargetTokens(targetTokens);
  const prepared = objectFreezeIntrinsic({
    schemaVersion: 1 as const,
    kind: 'PREPARED_COMMIT_PROJECTION_V1' as const,
    expectedFinalProjectionHash,
  });
  weakMapSet(preparedStates, prepared, {
    context,
    containedRoot: contextState.containedRoot,
    preflightProjectionHash: contextState.machineProjection.projectionHash,
    targetPaths: objectFreezeIntrinsic(targetPaths),
    targetSetHash: hashStrictObject(canonicalTargetTokens),
    untouchedRows: objectFreezeIntrinsic(untouchedRows),
    untouchedSetHash: hashStrictObject(objectFreezeIntrinsic(untouchedRows)),
    expectedRows,
    expectedFinalProjectionHash,
    consumed: false,
  });
  return prepared;
}

export async function verifyCommitSeal(
  context: ChangeAuthorityContext,
  prepared: PreparedCommitProjectionV1,
): Promise<CommitSealVerificationV1> {
  const state = consumePrepared(prepared);
  requireSealedContextMachineState(context);
  if (state.context !== context) fail('AUTHORITY_PREPARED_COMMIT_INVALID', 'prepared');
  const observedIo = createObservedIoRecorder();
  const actualRows: MachineAuthorityRowV1[] = [];

  for (let index = 0; index < state.expectedRows.length; index += 1) {
    const expected = state.expectedRows[index]!;
    const target = containsString(state.targetPaths, expected.relativePath);
    let actual: MachineAuthorityRowV1;
    try {
      actual = expected.nodeType === 'FILE'
        ? rowFromFileCapture(await captureStableBytes({
          containedRoot: state.containedRoot,
          relativePath: expected.relativePath,
          observedIo,
        }))
        : rowFromDirectory(await observeStableDirectory({
          containedRoot: state.containedRoot,
          relativePath: expected.relativePath,
          observedIo,
        }));
    } catch (cause) {
      mismatch(target, expected.relativePath, cause);
    }
    if (!sameRow(actual!, expected)) mismatch(target, expected.relativePath);
    arrayPush(actualRows, actual!);
  }

  const frozenActual = freezeSortedRows(actualRows);
  const finalProjectionHash = projectionHash(frozenActual);
  const sealWithoutHash = objectFreezeIntrinsic({
    schemaVersion: 1 as const,
    kind: 'MACHINE_AUTHORITY_SEAL_V1' as const,
    preflightProjectionHash: state.preflightProjectionHash,
    targetSetHash: state.targetSetHash,
    untouchedSetHash: state.untouchedSetHash,
    finalProjectionHash,
    observedMachineReadSet: frozenActual,
  });
  const seal = objectFreezeIntrinsic({ ...sealWithoutHash, sealHash: hashStrictObject(sealWithoutHash) });
  return objectFreezeIntrinsic({ seal, observedIo: observedIo.snapshot() });
}

function consumePrepared(prepared: PreparedCommitProjectionV1): PreparedState {
  if (prepared === null || typeof prepared !== 'object' || isProxy(prepared)) {
    fail('AUTHORITY_PREPARED_COMMIT_INVALID', 'prepared');
  }
  const state = weakMapGet(preparedStates, prepared);
  if (state === undefined) fail('AUTHORITY_PREPARED_COMMIT_INVALID', 'prepared');
  if (state.consumed) fail('AUTHORITY_PREPARED_COMMIT_CONSUMED', 'prepared');
  // WeakMap 确认真实性后立即消费；wrong-context 等后续失败也不能重用。
  state.consumed = true;
  return state;
}

function freezeSortedTargetTokens(tokens: readonly TargetToken[]): readonly TargetToken[] {
  const copied: TargetToken[] = [];
  for (let index = 0; index < tokens.length; index += 1) arrayPush(copied, tokens[index]!);
  reflectApplyIntrinsic(arraySortIntrinsic, copied, [(
    left: TargetToken,
    right: TargetToken,
  ) => compareCodeUnits(targetTokenPath(left), targetTokenPath(right))]);
  return objectFreezeIntrinsic(copied);
}

function targetTokenPath(token: TargetToken): string {
  return token.kind === 'UPSERT' ? token.expectedFinal.relativePath : token.relativePath;
}

function readMutations(value: unknown): readonly MachineAuthorityTargetMutationV1[] {
  if (value !== null && typeof value === 'object' && isProxy(value)) {
    fail('AUTHORITY_MACHINE_REQUEST_INVALID', 'proxy');
  }
  if (!arrayIsArrayIntrinsic(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail('AUTHORITY_MACHINE_REQUEST_INVALID', 'mutations');
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1 || !containsPropertyKey(ownKeys, 'length')) {
    fail('AUTHORITY_MACHINE_REQUEST_INVALID', 'mutations shape');
  }
  const copied: MachineAuthorityTargetMutationV1[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      fail('AUTHORITY_MACHINE_REQUEST_INVALID', `mutations[${index}]`);
    }
    arrayPush(copied, readMutation(descriptor.value));
  }
  return objectFreezeIntrinsic(copied);
}

function readMutation(value: unknown): MachineAuthorityTargetMutationV1 {
  const kind = readDataProperty(value, 'kind');
  if (kind === 'UPSERT') {
    const object = readExactObject(value, ['kind', 'expectedFinal']);
    return objectFreezeIntrinsic({ kind, expectedFinal: freezeMachineRow(object.expectedFinal) });
  }
  if (kind === 'REMOVE') {
    const object = readExactObject(value, ['kind', 'relativePath']);
    if (typeof object.relativePath !== 'string') fail('AUTHORITY_MACHINE_REQUEST_INVALID', 'relativePath');
    assertAuthorityRelativeToken(object.relativePath);
    return objectFreezeIntrinsic({ kind, relativePath: object.relativePath });
  }
  return fail('AUTHORITY_MACHINE_REQUEST_INVALID', 'kind');
}

function freezeMachineRow(value: unknown): MachineAuthorityRowV1 {
  const nodeType = readDataProperty(value, 'nodeType');
  if (nodeType === 'FILE') {
    const row = readExactObject(value, ['relativePath', 'nodeType', 'mode', 'rawBytesHash']);
    if (typeof row.relativePath !== 'string') fail('AUTHORITY_MACHINE_REQUEST_INVALID', 'relativePath');
    assertAuthorityRelativeToken(row.relativePath);
    if (row.mode !== 0o644) fail('AUTHORITY_MACHINE_MODE_MISMATCH', row.relativePath);
    return objectFreezeIntrinsic({
      relativePath: row.relativePath,
      nodeType,
      mode: row.mode,
      rawBytesHash: parseSha256(row.rawBytesHash),
    });
  }
  if (nodeType === 'DIRECTORY') {
    const row = readExactObject(value, ['relativePath', 'nodeType', 'mode', 'inventoryHash']);
    if (typeof row.relativePath !== 'string') fail('AUTHORITY_MACHINE_REQUEST_INVALID', 'relativePath');
    assertAuthorityRelativeToken(row.relativePath);
    if (row.mode !== 0o755) fail('AUTHORITY_MACHINE_MODE_MISMATCH', row.relativePath);
    return objectFreezeIntrinsic({
      relativePath: row.relativePath,
      nodeType,
      mode: row.mode,
      inventoryHash: parseSha256(row.inventoryHash),
    });
  }
  return fail('AUTHORITY_MACHINE_REQUEST_INVALID', 'nodeType');
}

function rowFromFileCapture(capture: StableByteCaptureV1): MachineAuthorityFileRowV1 {
  if (capture.observation.mode !== 0o644) {
    fail('AUTHORITY_MACHINE_MODE_MISMATCH', capture.observation.relativePath);
  }
  return objectFreezeIntrinsic({
    relativePath: capture.observation.relativePath,
    nodeType: 'FILE',
    mode: capture.observation.mode,
    rawBytesHash: capture.rawBytesHash,
  });
}

function rowFromDirectory(observation: ObservedDirectoryV1): MachineAuthorityDirectoryRowV1 {
  if (observation.mode !== 0o755) fail('AUTHORITY_MACHINE_MODE_MISMATCH', observation.relativePath);
  for (let index = 0; index < observation.typedEntries.length; index += 1) {
    const entry = observation.typedEntries[index]!;
    if (entry.nodeType !== 'FILE' && entry.nodeType !== 'DIRECTORY') {
      fail('AUTHORITY_MACHINE_DIRECTORY_NODE_TYPE', `${observation.relativePath}/${entry.name}`);
    }
  }
  return objectFreezeIntrinsic({
    relativePath: observation.relativePath,
    nodeType: 'DIRECTORY',
    mode: observation.mode,
    inventoryHash: observation.inventoryHash,
  });
}

function freezeProjection(rows: readonly MachineAuthorityRowV1[]): MachineAuthorityProjectionV1 {
  const frozenRows = freezeSortedRows(rows);
  return objectFreezeIntrinsic({
    schemaVersion: 1,
    kind: 'MACHINE_AUTHORITY_PROJECTION_V1',
    rows: frozenRows,
    projectionHash: projectionHash(frozenRows),
  });
}

function projectionHash(rows: readonly MachineAuthorityRowV1[]): Sha256 {
  return hashStrictObject(objectFreezeIntrinsic({
    schemaVersion: 1,
    kind: 'MACHINE_AUTHORITY_PROJECTION_V1',
    rows,
  }));
}

function freezeSortedRows(rows: readonly MachineAuthorityRowV1[]): readonly MachineAuthorityRowV1[] {
  const copied: MachineAuthorityRowV1[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    addUniqueRow(copied, freezeMachineRow(rows[index]!));
  }
  reflectApplyIntrinsic(arraySortIntrinsic, copied, [(
    left: MachineAuthorityRowV1,
    right: MachineAuthorityRowV1,
  ) => compareCodeUnits(left.relativePath, right.relativePath)]);
  return objectFreezeIntrinsic(copied);
}

function addUniqueRow(rows: MachineAuthorityRowV1[], row: MachineAuthorityRowV1): void {
  const prior = findRow(rows, row.relativePath);
  if (prior !== undefined) {
    if (!sameRow(prior, row)) fail('AUTHORITY_MACHINE_PATH_CONFLICT', row.relativePath);
    return;
  }
  arrayPush(rows, row);
}

function findRow(
  rows: readonly MachineAuthorityRowV1[],
  relativePath: string,
): MachineAuthorityRowV1 | undefined {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.relativePath === relativePath) return row;
  }
  return undefined;
}

function findParentDirectory(
  rows: readonly MachineAuthorityRowV1[],
  relativePath: string,
): MachineAuthorityDirectoryRowV1 | undefined {
  const parent = parentRelativePath(relativePath);
  if (parent === undefined) return undefined;
  const row = findRow(rows, parent);
  return row?.nodeType === 'DIRECTORY' ? row : undefined;
}

function parentRelativePath(relativePath: string): string | undefined {
  const slash = relativePath.lastIndexOf('/');
  return slash < 0 ? undefined : relativePath.slice(0, slash);
}

function sameRow(left: MachineAuthorityRowV1, right: MachineAuthorityRowV1): boolean {
  return left.relativePath === right.relativePath
    && left.nodeType === right.nodeType
    && left.mode === right.mode
    && (left.nodeType === 'FILE' && right.nodeType === 'FILE'
      ? left.rawBytesHash === right.rawBytesHash
      : left.nodeType === 'DIRECTORY' && right.nodeType === 'DIRECTORY'
        && left.inventoryHash === right.inventoryHash);
}

function mismatch(target: boolean, relativePath: string, cause?: unknown): never {
  throw new MachineAuthorityError(
    target ? 'AUTHORITY_SEAL_MISMATCH' : 'AUTHORITY_TARGET_DRIFT',
    relativePath,
    cause,
  );
}

function readExactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || isProxy(value)) {
    return fail('AUTHORITY_MACHINE_REQUEST_INVALID', 'object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail('AUTHORITY_MACHINE_REQUEST_INVALID', 'prototype');
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || !samePropertyKeySet(ownKeys, keys)) {
    return fail('AUTHORITY_MACHINE_REQUEST_INVALID', 'own keys');
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      return fail('AUTHORITY_MACHINE_REQUEST_INVALID', key);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function readDataProperty(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || isProxy(value)) {
    return fail('AUTHORITY_MACHINE_REQUEST_INVALID', key);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
    return fail('AUTHORITY_MACHINE_REQUEST_INVALID', key);
  }
  return descriptor.value;
}

function fail(code: string, detail: string, cause?: unknown): never {
  throw new MachineAuthorityError(code, detail, cause);
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

function arrayPush<Value>(array: Value[], value: Value): void {
  reflectApplyIntrinsic(arrayPushIntrinsic, array, [value]);
}

function appendRows(target: MachineAuthorityRowV1[], rows: readonly MachineAuthorityRowV1[]): void {
  for (let index = 0; index < rows.length; index += 1) arrayPush(target, rows[index]!);
}

function containsString(values: readonly string[], expected: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === expected) return true;
  }
  return false;
}

function containsPropertyKey(values: readonly PropertyKey[], expected: PropertyKey): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === expected) return true;
  }
  return false;
}

function samePropertyKeySet(actual: readonly PropertyKey[], expected: readonly string[]): boolean {
  for (let index = 0; index < actual.length; index += 1) {
    const key = actual[index];
    if (typeof key !== 'string' || !containsString(expected, key)) return false;
  }
  return true;
}
