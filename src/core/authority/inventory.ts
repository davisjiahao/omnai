import { isProxy } from 'node:util/types';
import { join } from 'node:path';
import type {
  DecisionId,
  EvidenceId,
  RevisionId,
  RunId,
  Sha256,
} from '../../domain/scalars.js';
import {
  parseDecisionId,
  parseEvidenceId,
  parseRevisionId,
  parseRunId,
} from '../../domain/scalars.js';
import {
  assertObservedIoRecorder,
  freezeReadonlyMap,
  type ObservedDirectoryV1,
  type ObservedIoRecorderV1,
} from './observed-io.js';
import {
  assertAuthorityRelativeToken,
  assertContainedAuthorityRoot,
  captureStableBytes,
  captureStableBytesAtRootForObservation,
  closeStableRootAnchor,
  compareCodeUnits,
  openStableRootAnchor,
  observeStableDirectory,
  observeStableRootDirectory,
  type StableByteCaptureV1,
  type StableRootAnchorV1,
} from './stable-bytes.js';

export type AuthorityLogicalKeyV1 =
  | Readonly<{ kind: 'METADATA' }>
  | Readonly<{ kind: 'TASKS' }>
  | Readonly<{ kind: 'FLOW' }>
  | Readonly<{ kind: 'DECISION'; decisionId: DecisionId }>
  | Readonly<{ kind: 'EVIDENCE'; evidenceId: EvidenceId }>
  | Readonly<{ kind: 'RUN'; runId: RunId }>
  | Readonly<{ kind: 'TRANSACTION'; transactionId: string }>
  | Readonly<{ kind: 'PROGRESS' }>;

export type AuthorityArchiveKeyV1 = Readonly<{
  kind: 'ARCHIVE';
  revisionId: RevisionId;
  logicalKey: AuthorityLogicalKeyV1;
}>;

export type AuthorityAuxiliaryKeyV1 = Readonly<{
  kind: 'AUXILIARY';
  ownerKind: 'RUN' | 'EVIDENCE' | 'TRANSACTION';
  ownerId: string;
  role: string;
}>;

export type AuthorityInventoryNodeTypeV1 = 'FILE' | 'DIRECTORY';

export type AuthorityLogicalTargetV1 = Readonly<{
  key: AuthorityLogicalKeyV1;
  relativePath: string;
  nodeType: AuthorityInventoryNodeTypeV1;
}>;

export type AuthorityArchiveTargetV1 = Readonly<{
  key: AuthorityArchiveKeyV1;
  relativePath: string;
  nodeType: AuthorityInventoryNodeTypeV1;
}>;

export type AuthorityAuxiliaryTargetV1 = Readonly<{
  key: AuthorityAuxiliaryKeyV1;
  relativePath: string;
  nodeType: AuthorityInventoryNodeTypeV1;
}>;

export type VerifiedReceiptReferenceV1 = Readonly<{
  receiptId: string;
  targetKey: AuthorityAuxiliaryKeyV1;
  relativePath: string;
}>;

export type BuildAuthorityInventoryBaseRequestV1 = Readonly<{
  containedRoot: string;
  observedIo: ObservedIoRecorderV1;
  logicalTargets: readonly AuthorityLogicalTargetV1[];
  archiveTargets: readonly AuthorityArchiveTargetV1[];
  knownAuxiliaryTargets: readonly AuthorityAuxiliaryTargetV1[];
}>;

declare const authorityInventoryDiscoveryBrand: unique symbol;

// @internal recorder-owned layout discovery capability；真实目录 observation 只可由本模块登记，
// 后续 inventory build 不能接受 caller 手填 counter 或 directory row。
export interface AuthorityInventoryDiscoveryV1 {
  readonly phase: 'DISCOVERING';
  readonly [authorityInventoryDiscoveryBrand]: never;
}

export type FinalizeAuthorityInventoryRequestV1 = Readonly<{
  base: AuthorityInventoryBaseV1;
  verifiedReceiptReferences: readonly VerifiedReceiptReferenceV1[];
}>;

type AuthorityInventoryKeyV1 = AuthorityLogicalKeyV1 | AuthorityArchiveKeyV1 | AuthorityAuxiliaryKeyV1;

type AuthorityFileInventoryEntryV1<Key extends AuthorityInventoryKeyV1> = Readonly<{
  key: Key;
  keyToken: string;
  relativePath: string;
  nodeType: 'FILE';
  contentHash: Sha256;
  capture: StableByteCaptureV1;
}>;

type AuthorityDirectoryInventoryEntryV1<Key extends AuthorityInventoryKeyV1> = Readonly<{
  key: Key;
  keyToken: string;
  relativePath: string;
  nodeType: 'DIRECTORY';
  contentHash: Sha256;
  observation: ObservedDirectoryV1;
}>;

type AuthorityInventoryEntryForKeyV1<Key extends AuthorityInventoryKeyV1> =
  | AuthorityFileInventoryEntryV1<Key>
  | AuthorityDirectoryInventoryEntryV1<Key>;

export type AuthorityLogicalInventoryEntryV1 = AuthorityInventoryEntryForKeyV1<AuthorityLogicalKeyV1>;
export type AuthorityArchiveInventoryEntryV1 = AuthorityInventoryEntryForKeyV1<AuthorityArchiveKeyV1>;
export type AuthorityAuxiliaryInventoryEntryV1 = AuthorityInventoryEntryForKeyV1<AuthorityAuxiliaryKeyV1>;
export type AuthorityInventoryEntryV1 =
  | AuthorityLogicalInventoryEntryV1
  | AuthorityArchiveInventoryEntryV1
  | AuthorityAuxiliaryInventoryEntryV1;

export type AuthorityInventoryBaseV1 = Readonly<{
  schemaVersion: 1;
  phase: 'BASE';
  entries: readonly (AuthorityLogicalInventoryEntryV1 | AuthorityArchiveInventoryEntryV1)[];
  logicalEntries: readonly AuthorityLogicalInventoryEntryV1[];
  archiveEntries: readonly AuthorityArchiveInventoryEntryV1[];
  entriesByKey: ReadonlyMap<string, AuthorityLogicalInventoryEntryV1 | AuthorityArchiveInventoryEntryV1>;
  observedDirectories: ReadonlyMap<string, ObservedDirectoryV1>;
  getLogical(key: AuthorityLogicalKeyV1): AuthorityLogicalInventoryEntryV1 | undefined;
  getArchive(key: AuthorityArchiveKeyV1): AuthorityArchiveInventoryEntryV1 | undefined;
}>;

export type AuthorityInventoryV1 = Readonly<{
  schemaVersion: 1;
  phase: 'FINAL';
  entries: readonly AuthorityInventoryEntryV1[];
  logicalEntries: readonly AuthorityLogicalInventoryEntryV1[];
  archiveEntries: readonly AuthorityArchiveInventoryEntryV1[];
  auxiliaryEntries: readonly AuthorityAuxiliaryInventoryEntryV1[];
  entriesByKey: ReadonlyMap<string, AuthorityInventoryEntryV1>;
  observedDirectories: ReadonlyMap<string, ObservedDirectoryV1>;
  getLogical(key: AuthorityLogicalKeyV1): AuthorityLogicalInventoryEntryV1 | undefined;
  getArchive(key: AuthorityArchiveKeyV1): AuthorityArchiveInventoryEntryV1 | undefined;
  getAuxiliary(key: AuthorityAuxiliaryKeyV1): AuthorityAuxiliaryInventoryEntryV1 | undefined;
}>;

export type AuthorityInventoryErrorCode =
  | 'AUTHORITY_INVENTORY_INPUT_INVALID'
  | 'AUTHORITY_INVENTORY_BASE_INVALID'
  | 'AUTHORITY_INVENTORY_ALREADY_FINALIZED'
  | 'AUTHORITY_INVENTORY_LOGICAL_KEY_DUPLICATE'
  | 'AUTHORITY_INVENTORY_ARCHIVE_KEY_DUPLICATE'
  | 'AUTHORITY_INVENTORY_AUXILIARY_KEY_DUPLICATE'
  | 'AUTHORITY_INVENTORY_PATH_COLLISION'
  | 'AUTHORITY_INVENTORY_RECEIPT_UNKNOWN'
  | 'AUTHORITY_INVENTORY_RECEIPT_DUPLICATE'
  | 'AUTHORITY_INVENTORY_RECEIPT_CONFLICT'
  | 'AUTHORITY_INVENTORY_DIRECTORY_MISMATCH'
  | 'AUTHORITY_INVENTORY_IDENTITY_HASH_CONFLICT'
  | 'AUTHORITY_INVENTORY_IDENTITY_OBSERVATION_CONFLICT';

export class AuthorityInventoryError extends Error {
  readonly code: AuthorityInventoryErrorCode;

  constructor(code: AuthorityInventoryErrorCode, detail: string, cause?: unknown) {
    super(`${code}: ${detail}`, cause === undefined ? undefined : { cause });
    this.name = 'AuthorityInventoryError';
    this.code = code;
  }
}

type PreparedTarget = Readonly<{
  scope: 'LOGICAL' | 'ARCHIVE' | 'AUXILIARY';
  key: AuthorityInventoryKeyV1;
  keyToken: string;
  relativePath: string;
  nodeType: AuthorityInventoryNodeTypeV1;
}>;

type PreparedBaseBuildRequest = Readonly<{
  containedRoot: string;
  observedIo: ObservedIoRecorderV1;
  baseTargets: readonly PreparedTarget[];
  knownAuxiliaryTargets: readonly PreparedTarget[];
}>;

type IdentityObservation = Readonly<{ contentHash: Sha256; mode: number }>;
type MutableDirectoryObservation = {
  readonly relativePath: string;
  readonly observation: ObservedDirectoryV1;
};
type MutableIdentityObservation = {
  readonly identity: string;
  readonly observation: IdentityObservation;
};
type MutableAnchoredDirectory = {
  readonly relativePath: string;
  readonly anchor: StableRootAnchorV1;
};

type BaseInventoryState = {
  readonly containedRoot: string;
  readonly observedIo: ObservedIoRecorderV1;
  readonly baseTargets: readonly PreparedTarget[];
  readonly knownAuxiliaryTargets: readonly PreparedTarget[];
  readonly baseEntries: readonly (AuthorityLogicalInventoryEntryV1 | AuthorityArchiveInventoryEntryV1)[];
  readonly observedDirectories: MutableDirectoryObservation[];
  readonly identityObservations: MutableIdentityObservation[];
  finalized: boolean;
};

type InventoryDiscoveryState = {
  readonly containedRoot: string;
  readonly observedIo: ObservedIoRecorderV1;
  readonly observedDirectories: MutableDirectoryObservation[];
  readonly anchoredDirectories: MutableAnchoredDirectory[];
  consumed: boolean;
};

const baseInventoryStates = new WeakMap<AuthorityInventoryBaseV1, BaseInventoryState>();
const inventoryDiscoveryStates = new WeakMap<AuthorityInventoryDiscoveryV1, InventoryDiscoveryState>();
const reflectApplyIntrinsic = Reflect.apply;
const arrayPushIntrinsic = Array.prototype.push;
const SetIntrinsic = Set;
const setAddIntrinsic = Set.prototype.add;
const setHasIntrinsic = Set.prototype.has;
const setForEachIntrinsic = Set.prototype.forEach;
const stringLastIndexOfIntrinsic = String.prototype.lastIndexOf;
const stringSliceIntrinsic = String.prototype.slice;
const weakMapGetIntrinsic = WeakMap.prototype.get;
const weakMapSetIntrinsic = WeakMap.prototype.set;

export async function buildAuthorityInventoryBase(
  request: BuildAuthorityInventoryBaseRequestV1,
): Promise<AuthorityInventoryBaseV1> {
  return buildAuthorityInventoryBaseInternal(request, []);
}

export function createAuthorityInventoryDiscovery(
  containedRoot: string,
  observedIo: ObservedIoRecorderV1,
): AuthorityInventoryDiscoveryV1 {
  assertContainedAuthorityRoot(containedRoot);
  assertObservedIoRecorder(observedIo);
  const discovery = Object.freeze({ phase: 'DISCOVERING' as const }) as AuthorityInventoryDiscoveryV1;
  weakMapSet(inventoryDiscoveryStates, discovery, {
    containedRoot,
    observedIo,
    observedDirectories: [],
    anchoredDirectories: [],
    consumed: false,
  });
  return discovery;
}

export async function discoverAuthorityInventoryDirectory(
  discovery: AuthorityInventoryDiscoveryV1,
  relativePath: string,
  captureFlatFiles = false,
): Promise<ObservedDirectoryV1> {
  const state = requireInventoryDiscovery(discovery);
  if (state.consumed) {
    throw new AuthorityInventoryError('AUTHORITY_INVENTORY_BASE_INVALID', 'discovery consumed');
  }
  if (findObservedDirectory(state.observedDirectories, relativePath) !== undefined) {
    throw new AuthorityInventoryError('AUTHORITY_INVENTORY_DIRECTORY_MISMATCH', relativePath);
  }
  let observation: ObservedDirectoryV1;
  if (captureFlatFiles) {
    const anchor = await openStableRootAnchor(join(state.containedRoot, relativePath));
    try {
      observation = await observeStableRootDirectory(anchor, state.observedIo, relativePath);
      arrayPush(state.anchoredDirectories, Object.freeze({ relativePath, anchor }));
    } catch (failure) {
      await closeStableRootAnchor(anchor, true);
      throw failure;
    }
  } else {
    observation = await observeStableDirectory({
      containedRoot: state.containedRoot,
      relativePath,
      observedIo: state.observedIo,
    });
  }
  arrayPush(state.observedDirectories, Object.freeze({ relativePath, observation }));
  return observation;
}

export async function buildAuthorityInventoryBaseFromDiscovery(
  request: BuildAuthorityInventoryBaseRequestV1,
  discovery: AuthorityInventoryDiscoveryV1,
): Promise<AuthorityInventoryBaseV1> {
  const state = requireInventoryDiscovery(discovery);
  if (state.consumed) {
    throw new AuthorityInventoryError('AUTHORITY_INVENTORY_BASE_INVALID', 'discovery consumed');
  }
  const prepared = prepareBaseRequest(request);
  if (prepared.containedRoot !== state.containedRoot || prepared.observedIo !== state.observedIo) {
    throw new AuthorityInventoryError('AUTHORITY_INVENTORY_BASE_INVALID', 'discovery binding');
  }
  state.consumed = true;
  let hasPrimaryFailure = false;
  try {
    return await buildAuthorityInventoryBasePrepared(
      prepared,
      state.observedDirectories,
      state.anchoredDirectories,
    );
  } catch (failure) {
    hasPrimaryFailure = true;
    throw failure;
  } finally {
    await closeAnchoredDirectories(state.anchoredDirectories, hasPrimaryFailure);
  }
}

export async function closeAuthorityInventoryDiscovery(
  discovery: AuthorityInventoryDiscoveryV1,
): Promise<void> {
  const state = requireInventoryDiscovery(discovery);
  if (state.consumed) return;
  state.consumed = true;
  await closeAnchoredDirectories(state.anchoredDirectories, false);
}

async function buildAuthorityInventoryBaseInternal(
  request: BuildAuthorityInventoryBaseRequestV1,
  observedDirectories: MutableDirectoryObservation[],
): Promise<AuthorityInventoryBaseV1> {
  const prepared = prepareBaseRequest(request);
  return buildAuthorityInventoryBasePrepared(prepared, observedDirectories);
}

async function buildAuthorityInventoryBasePrepared(
  prepared: PreparedBaseBuildRequest,
  observedDirectories: MutableDirectoryObservation[],
  anchoredDirectories: readonly MutableAnchoredDirectory[] = [],
): Promise<AuthorityInventoryBaseV1> {
  assertObservedIoRecorder(prepared.observedIo);
  await observeMissingDirectories(
    prepared.containedRoot,
    prepared.observedIo,
    prepared.baseTargets,
    observedDirectories,
  );

  const identityObservations: MutableIdentityObservation[] = [];
  const entries = await captureTargets(
    prepared.containedRoot,
    prepared.observedIo,
    prepared.baseTargets,
    observedDirectories,
    identityObservations,
    anchoredDirectories,
  ) as readonly (AuthorityLogicalInventoryEntryV1 | AuthorityArchiveInventoryEntryV1)[];
  const base = freezeBaseInventory(entries, observedDirectories);
  weakMapSet(baseInventoryStates, base, {
    containedRoot: prepared.containedRoot,
    observedIo: prepared.observedIo,
    baseTargets: prepared.baseTargets,
    knownAuxiliaryTargets: prepared.knownAuxiliaryTargets,
    baseEntries: entries,
    observedDirectories,
    identityObservations,
    finalized: false,
  });
  return base;
}

function requireInventoryDiscovery(
  discovery: AuthorityInventoryDiscoveryV1,
): InventoryDiscoveryState {
  if (discovery === null || typeof discovery !== 'object' || isProxy(discovery)) {
    throw new AuthorityInventoryError('AUTHORITY_INVENTORY_BASE_INVALID', 'discovery');
  }
  const state = weakMapGet(inventoryDiscoveryStates, discovery);
  if (state === undefined) {
    throw new AuthorityInventoryError('AUTHORITY_INVENTORY_BASE_INVALID', 'discovery');
  }
  return state;
}

export async function finalizeAuthorityInventory(
  request: FinalizeAuthorityInventoryRequestV1,
): Promise<AuthorityInventoryV1> {
  const object = readExactDataObject(request, ['base', 'verifiedReceiptReferences']);
  const rawBase = object.base;
  if (rawBase === null || typeof rawBase !== 'object' || isProxy(rawBase)) {
    throw new AuthorityInventoryError('AUTHORITY_INVENTORY_BASE_INVALID', 'base');
  }
  const state = weakMapGet(baseInventoryStates, rawBase as AuthorityInventoryBaseV1);
  if (state === undefined) {
    throw new AuthorityInventoryError('AUTHORITY_INVENTORY_BASE_INVALID', 'base');
  }
  if (state.finalized) {
    throw new AuthorityInventoryError('AUTHORITY_INVENTORY_ALREADY_FINALIZED', 'base');
  }
  state.finalized = true;

  const selectedAuxiliary = selectVerifiedAuxiliaryTargets(
    object.verifiedReceiptReferences,
    state.knownAuxiliaryTargets,
  );
  requireUniquePaths([...state.baseTargets, ...selectedAuxiliary]);
  await observeMissingDirectories(
    state.containedRoot,
    state.observedIo,
    selectedAuxiliary,
    state.observedDirectories,
  );
  const auxiliaryEntries = await captureTargets(
    state.containedRoot,
    state.observedIo,
    selectedAuxiliary,
    state.observedDirectories,
    state.identityObservations,
  ) as readonly AuthorityAuxiliaryInventoryEntryV1[];
  return freezeInventory(
    [...state.baseEntries, ...auxiliaryEntries],
    state.observedDirectories,
  );
}

function prepareBaseRequest(request: BuildAuthorityInventoryBaseRequestV1): PreparedBaseBuildRequest {
  const object = requireBaseRequestShape(request);
  const logical = readDenseDataArray(object.logicalTargets, 'logicalTargets')
    .map((target) => prepareLogicalTarget(target));
  const archives = readDenseDataArray(object.archiveTargets, 'archiveTargets')
    .map((target) => prepareArchiveTarget(target));
  const knownAuxiliary = readDenseDataArray(object.knownAuxiliaryTargets, 'knownAuxiliaryTargets')
    .map((target) => prepareAuxiliaryTarget(target));

  requireUniqueKey(logical, 'AUTHORITY_INVENTORY_LOGICAL_KEY_DUPLICATE');
  requireUniqueKey(archives, 'AUTHORITY_INVENTORY_ARCHIVE_KEY_DUPLICATE');
  requireUniqueKey(knownAuxiliary, 'AUTHORITY_INVENTORY_AUXILIARY_KEY_DUPLICATE');
  requireUniquePaths([...logical, ...archives]);
  requireUniquePaths(knownAuxiliary);
  if (typeof object.containedRoot !== 'string') invalidInput('request.containedRoot');
  assertContainedAuthorityRoot(object.containedRoot);
  return Object.freeze({
    containedRoot: object.containedRoot,
    observedIo: object.observedIo as ObservedIoRecorderV1,
    baseTargets: Object.freeze([...logical, ...archives].sort((left, right) => (
      compareCodeUnits(left.relativePath, right.relativePath)
        || compareCodeUnits(left.keyToken, right.keyToken)
    ))),
    knownAuxiliaryTargets: Object.freeze(knownAuxiliary),
  });
}

function selectVerifiedAuxiliaryTargets(
  rawReferences: unknown,
  knownAuxiliaryTargets: readonly PreparedTarget[],
): readonly PreparedTarget[] {
  const exactReferences = createSet<string>();
  const selectedKeys = createSet<string>();
  const selected: PreparedTarget[] = [];
  for (const rawReference of readDenseDataArray(rawReferences, 'verifiedReceiptReferences')) {
    const reference = prepareReceiptReference(rawReference);
    const exactToken = `${frame(reference.receiptId)}:${frame(reference.targetKeyToken)}:${frame(reference.relativePath)}`;
    if (setHas(exactReferences, exactToken)) {
      throw new AuthorityInventoryError('AUTHORITY_INVENTORY_RECEIPT_DUPLICATE', exactToken);
    }
    setAdd(exactReferences, exactToken);
    const known = findTargetByKey(knownAuxiliaryTargets, reference.targetKeyToken);
    if (known === undefined) {
      throw new AuthorityInventoryError('AUTHORITY_INVENTORY_RECEIPT_UNKNOWN', reference.targetKeyToken);
    }
    if (known.relativePath !== reference.relativePath) {
      throw new AuthorityInventoryError('AUTHORITY_INVENTORY_RECEIPT_CONFLICT', reference.receiptId);
    }
    if (!setHas(selectedKeys, known.keyToken)) {
      setAdd(selectedKeys, known.keyToken);
      arrayPush(selected, known);
    }
  }
  return Object.freeze(selected.sort((left, right) => (
    compareCodeUnits(left.relativePath, right.relativePath)
      || compareCodeUnits(left.keyToken, right.keyToken)
  )));
}

function findTargetByKey(
  targets: readonly PreparedTarget[],
  keyToken: string,
): PreparedTarget | undefined {
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index]!;
    if (target.keyToken === keyToken) return target;
  }
  return undefined;
}

function prepareLogicalTarget(target: unknown): PreparedTarget {
  const object = readExactDataObject(target, ['key', 'relativePath', 'nodeType']);
  const key = freezeLogicalKey(object.key);
  return freezePreparedTarget(
    'LOGICAL',
    key,
    `LOGICAL:${logicalKeyToken(key)}`,
    object.relativePath,
    object.nodeType,
  );
}

function prepareArchiveTarget(target: unknown): PreparedTarget {
  const object = readExactDataObject(target, ['key', 'relativePath', 'nodeType']);
  const key = freezeArchiveKey(object.key);
  return freezePreparedTarget(
    'ARCHIVE',
    key,
    `ARCHIVE:${archiveKeyToken(key)}`,
    object.relativePath,
    object.nodeType,
  );
}

function prepareAuxiliaryTarget(target: unknown): PreparedTarget {
  const object = readExactDataObject(target, ['key', 'relativePath', 'nodeType']);
  const key = freezeAuxiliaryKey(object.key);
  return freezePreparedTarget(
    'AUXILIARY',
    key,
    `AUXILIARY:${auxiliaryKeyToken(key)}`,
    object.relativePath,
    object.nodeType,
  );
}

function freezePreparedTarget(
  scope: PreparedTarget['scope'],
  key: AuthorityInventoryKeyV1,
  keyToken: string,
  rawRelativePath: unknown,
  rawNodeType: unknown,
): PreparedTarget {
  if (typeof rawRelativePath !== 'string') invalidInput('target.relativePath');
  assertAuthorityRelativeToken(rawRelativePath);
  if (rawNodeType !== 'FILE' && rawNodeType !== 'DIRECTORY') invalidInput('target.nodeType');
  return Object.freeze({
    scope,
    key,
    keyToken,
    relativePath: rawRelativePath,
    nodeType: rawNodeType,
  });
}

function prepareReceiptReference(reference: unknown): Readonly<{
  receiptId: string;
  targetKeyToken: string;
  relativePath: string;
}> {
  const object = readExactDataObject(reference, ['receiptId', 'targetKey', 'relativePath']);
  const receiptId = requireIdentifier(object.receiptId, 'receiptId');
  const key = freezeAuxiliaryKey(object.targetKey);
  if (typeof object.relativePath !== 'string') invalidInput('receipt.relativePath');
  assertAuthorityRelativeToken(object.relativePath);
  return Object.freeze({
    receiptId,
    targetKeyToken: `AUXILIARY:${auxiliaryKeyToken(key)}`,
    relativePath: object.relativePath,
  });
}

function collectObservedDirectoryPaths(targets: readonly PreparedTarget[]): readonly string[] {
  const paths = createSet<string>();
  for (const target of targets) {
    const segments = target.relativePath.split('/');
    const terminal = target.nodeType === 'DIRECTORY' ? segments.length : segments.length - 1;
    for (let length = 1; length <= terminal; length += 1) {
      setAdd(paths, segments.slice(0, length).join('/'));
    }
  }
  const copy: string[] = [];
  setForEach(paths, (value) => arrayPush(copy, value));
  return Object.freeze(copy.sort(compareCodeUnits));
}

async function observeMissingDirectories(
  containedRoot: string,
  observedIo: ObservedIoRecorderV1,
  targets: readonly PreparedTarget[],
  observedDirectories: MutableDirectoryObservation[],
): Promise<void> {
  const directoryPaths = collectObservedDirectoryPaths(targets);
  for (const relativePath of directoryPaths) {
    if (findObservedDirectory(observedDirectories, relativePath) !== undefined) continue;
    arrayPush(observedDirectories, Object.freeze({
      relativePath,
      observation: await observeStableDirectory({
        containedRoot,
        relativePath,
        observedIo,
      }),
    }));
  }
  requireObservedDirectoryHierarchy(directoryPaths, observedDirectories);
  requireTargetsPresentInObservedParents(targets, observedDirectories);
}

function requireObservedDirectoryHierarchy(
  directoryPaths: readonly string[],
  directories: readonly MutableDirectoryObservation[],
): void {
  for (const relativePath of directoryPaths) {
    const slash = stringLastIndexOf(relativePath, '/');
    if (slash < 0) continue;
    const parent = stringSlice(relativePath, 0, slash);
    const name = stringSlice(relativePath, slash + 1);
    const entry = findObservedDirectoryEntry(findObservedDirectory(directories, parent), name);
    if (entry?.nodeType !== 'DIRECTORY') {
      throw new AuthorityInventoryError('AUTHORITY_INVENTORY_DIRECTORY_MISMATCH', relativePath);
    }
  }
}

function requireTargetsPresentInObservedParents(
  targets: readonly PreparedTarget[],
  directories: readonly MutableDirectoryObservation[],
): void {
  for (const target of targets) {
    const slash = stringLastIndexOf(target.relativePath, '/');
    if (slash < 0) continue;
    const parent = stringSlice(target.relativePath, 0, slash);
    const name = stringSlice(target.relativePath, slash + 1);
    const entry = findObservedDirectoryEntry(findObservedDirectory(directories, parent), name);
    if (entry?.nodeType !== target.nodeType) {
      throw new AuthorityInventoryError('AUTHORITY_INVENTORY_DIRECTORY_MISMATCH', target.relativePath);
    }
  }
}

async function captureTargets(
  containedRoot: string,
  observedIo: ObservedIoRecorderV1,
  targets: readonly PreparedTarget[],
  observedDirectories: readonly MutableDirectoryObservation[],
  identityObservations: MutableIdentityObservation[],
  anchoredDirectories: readonly MutableAnchoredDirectory[] = [],
): Promise<readonly AuthorityInventoryEntryV1[]> {
  const entries: AuthorityInventoryEntryV1[] = [];
  for (const target of targets) {
    let entry: AuthorityInventoryEntryV1;
    if (target.nodeType === 'FILE') {
      const slash = stringLastIndexOf(target.relativePath, '/');
      const parent = slash < 0 ? undefined : stringSlice(target.relativePath, 0, slash);
      const anchored = parent === undefined
        ? undefined
        : findAnchoredDirectory(anchoredDirectories, parent);
      const capture = anchored === undefined
        ? await captureStableBytes({
            containedRoot,
            relativePath: target.relativePath,
            observedIo,
          })
        : await captureStableBytesAtRootForObservation(anchored, {
            relativePath: stringSlice(target.relativePath, slash + 1),
            observedRelativePath: target.relativePath,
            observedIo,
          });
      entry = freezeFileEntry(target, capture);
    } else {
      const observation = findObservedDirectory(observedDirectories, target.relativePath);
      if (observation === undefined) {
        throw new AuthorityInventoryError('AUTHORITY_INVENTORY_DIRECTORY_MISMATCH', target.relativePath);
      }
      entry = freezeDirectoryEntry(target, observation);
    }
    arrayPush(entries, entry);
    requireConsistentIdentity(entry, identityObservations);
  }
  return Object.freeze(entries);
}

function findAnchoredDirectory(
  directories: readonly MutableAnchoredDirectory[],
  relativePath: string,
): StableRootAnchorV1 | undefined {
  for (let index = 0; index < directories.length; index += 1) {
    const entry = directories[index]!;
    if (entry.relativePath === relativePath) return entry.anchor;
  }
  return undefined;
}

async function closeAnchoredDirectories(
  directories: readonly MutableAnchoredDirectory[],
  preservePrimaryFailure: boolean,
): Promise<void> {
  let hasCloseFailure = false;
  let firstCloseFailure: unknown;
  for (let index = directories.length - 1; index >= 0; index -= 1) {
    try {
      await closeStableRootAnchor(directories[index]!.anchor, preservePrimaryFailure);
    } catch (failure) {
      if (!hasCloseFailure) firstCloseFailure = failure;
      hasCloseFailure = true;
    }
  }
  if (hasCloseFailure && !preservePrimaryFailure) throw firstCloseFailure;
}

function freezeFileEntry(
  target: PreparedTarget,
  capture: StableByteCaptureV1,
): AuthorityInventoryEntryV1 {
  return Object.freeze({
    key: target.key,
    keyToken: target.keyToken,
    relativePath: target.relativePath,
    nodeType: 'FILE',
    contentHash: capture.rawBytesHash,
    capture,
  }) as AuthorityInventoryEntryV1;
}

function freezeDirectoryEntry(
  target: PreparedTarget,
  observation: ObservedDirectoryV1,
): AuthorityInventoryEntryV1 {
  return Object.freeze({
    key: target.key,
    keyToken: target.keyToken,
    relativePath: target.relativePath,
    nodeType: 'DIRECTORY',
    contentHash: observation.inventoryHash,
    observation,
  }) as AuthorityInventoryEntryV1;
}

function requireConsistentIdentity(
  entry: AuthorityInventoryEntryV1,
  observed: MutableIdentityObservation[],
): void {
  const observation = entry.nodeType === 'FILE' ? entry.capture.observation : entry.observation;
  const identity = `${entry.nodeType}:${observation.device}:${observation.inode}`;
  const prior = findIdentityObservation(observed, identity);
  if (prior !== undefined && prior.contentHash !== entry.contentHash) {
    throw new AuthorityInventoryError('AUTHORITY_INVENTORY_IDENTITY_HASH_CONFLICT', identity);
  }
  if (prior !== undefined && prior.mode !== observation.mode) {
    throw new AuthorityInventoryError('AUTHORITY_INVENTORY_IDENTITY_OBSERVATION_CONFLICT', identity);
  }
  if (prior === undefined) {
    arrayPush(observed, Object.freeze({
      identity,
      observation: Object.freeze({ contentHash: entry.contentHash, mode: observation.mode }),
    }));
  }
}

function findObservedDirectory(
  directories: readonly MutableDirectoryObservation[],
  relativePath: string,
): ObservedDirectoryV1 | undefined {
  for (let index = 0; index < directories.length; index += 1) {
    const entry = directories[index]!;
    if (entry.relativePath === relativePath) return entry.observation;
  }
  return undefined;
}

function findObservedDirectoryEntry(
  directory: ObservedDirectoryV1 | undefined,
  name: string,
): ObservedDirectoryV1['typedEntries'][number] | undefined {
  if (directory === undefined) return undefined;
  for (let index = 0; index < directory.typedEntries.length; index += 1) {
    const entry = directory.typedEntries[index]!;
    if (entry.name === name) return entry;
  }
  return undefined;
}

function findIdentityObservation(
  observations: readonly MutableIdentityObservation[],
  identity: string,
): IdentityObservation | undefined {
  for (let index = 0; index < observations.length; index += 1) {
    const entry = observations[index]!;
    if (entry.identity === identity) return entry.observation;
  }
  return undefined;
}

function copyDirectoryEntries(
  directories: readonly MutableDirectoryObservation[],
): readonly (readonly [string, ObservedDirectoryV1])[] {
  const entries: Array<readonly [string, ObservedDirectoryV1]> = [];
  for (let index = 0; index < directories.length; index += 1) {
    const entry = directories[index]!;
    arrayPush(entries, Object.freeze([entry.relativePath, entry.observation]));
  }
  return Object.freeze(entries);
}

function freezeBaseInventory(
  mutableEntries: readonly (AuthorityLogicalInventoryEntryV1 | AuthorityArchiveInventoryEntryV1)[],
  mutableDirectories: readonly MutableDirectoryObservation[],
): AuthorityInventoryBaseV1 {
  const entries = Object.freeze([...mutableEntries]);
  const logicalEntries: AuthorityLogicalInventoryEntryV1[] = [];
  const archiveEntries: AuthorityArchiveInventoryEntryV1[] = [];
  const byKeyEntries: Array<readonly [string, AuthorityLogicalInventoryEntryV1 | AuthorityArchiveInventoryEntryV1]> = [];
  for (const entry of entries) {
    arrayPush(byKeyEntries, Object.freeze([entry.keyToken, entry]));
    if (entry.keyToken.startsWith('LOGICAL:')) {
      arrayPush(logicalEntries, entry as AuthorityLogicalInventoryEntryV1);
    } else {
      arrayPush(archiveEntries, entry as AuthorityArchiveInventoryEntryV1);
    }
  }
  const frozenLogical = Object.freeze(logicalEntries);
  const frozenArchive = Object.freeze(archiveEntries);
  const entriesByKey = freezeReadonlyMap(byKeyEntries);
  const observedDirectories = freezeReadonlyMap(copyDirectoryEntries(mutableDirectories));

  return Object.freeze({
    schemaVersion: 1,
    phase: 'BASE',
    entries,
    logicalEntries: frozenLogical,
    archiveEntries: frozenArchive,
    entriesByKey,
    observedDirectories,
    getLogical(key: AuthorityLogicalKeyV1): AuthorityLogicalInventoryEntryV1 | undefined {
      const frozen = freezeLogicalKey(key);
      return entriesByKey.get(`LOGICAL:${logicalKeyToken(frozen)}`) as AuthorityLogicalInventoryEntryV1 | undefined;
    },
    getArchive(key: AuthorityArchiveKeyV1): AuthorityArchiveInventoryEntryV1 | undefined {
      const frozen = freezeArchiveKey(key);
      return entriesByKey.get(`ARCHIVE:${archiveKeyToken(frozen)}`) as AuthorityArchiveInventoryEntryV1 | undefined;
    },
  });
}

function freezeInventory(
  mutableEntries: readonly AuthorityInventoryEntryV1[],
  mutableDirectories: readonly MutableDirectoryObservation[],
): AuthorityInventoryV1 {
  const entries = Object.freeze([...mutableEntries].sort((left, right) => (
    compareCodeUnits(left.relativePath, right.relativePath)
      || compareCodeUnits(left.keyToken, right.keyToken)
  )));
  const logicalEntries: AuthorityLogicalInventoryEntryV1[] = [];
  const archiveEntries: AuthorityArchiveInventoryEntryV1[] = [];
  const auxiliaryEntries: AuthorityAuxiliaryInventoryEntryV1[] = [];
  const byKeyEntries: Array<readonly [string, AuthorityInventoryEntryV1]> = [];
  for (const entry of entries) {
    arrayPush(byKeyEntries, Object.freeze([entry.keyToken, entry]));
    if (entry.keyToken.startsWith('LOGICAL:')) {
      arrayPush(logicalEntries, entry as AuthorityLogicalInventoryEntryV1);
    } else if (entry.keyToken.startsWith('ARCHIVE:')) {
      arrayPush(archiveEntries, entry as AuthorityArchiveInventoryEntryV1);
    } else {
      arrayPush(auxiliaryEntries, entry as AuthorityAuxiliaryInventoryEntryV1);
    }
  }
  const frozenLogical = Object.freeze(logicalEntries);
  const frozenArchive = Object.freeze(archiveEntries);
  const frozenAuxiliary = Object.freeze(auxiliaryEntries);
  const entriesByKey = freezeReadonlyMap(byKeyEntries);
  const observedDirectories = freezeReadonlyMap(copyDirectoryEntries(mutableDirectories));

  return Object.freeze({
    schemaVersion: 1,
    phase: 'FINAL',
    entries,
    logicalEntries: frozenLogical,
    archiveEntries: frozenArchive,
    auxiliaryEntries: frozenAuxiliary,
    entriesByKey,
    observedDirectories,
    getLogical(key: AuthorityLogicalKeyV1): AuthorityLogicalInventoryEntryV1 | undefined {
      const frozen = freezeLogicalKey(key);
      return entriesByKey.get(`LOGICAL:${logicalKeyToken(frozen)}`) as AuthorityLogicalInventoryEntryV1 | undefined;
    },
    getArchive(key: AuthorityArchiveKeyV1): AuthorityArchiveInventoryEntryV1 | undefined {
      const frozen = freezeArchiveKey(key);
      return entriesByKey.get(`ARCHIVE:${archiveKeyToken(frozen)}`) as AuthorityArchiveInventoryEntryV1 | undefined;
    },
    getAuxiliary(key: AuthorityAuxiliaryKeyV1): AuthorityAuxiliaryInventoryEntryV1 | undefined {
      const frozen = freezeAuxiliaryKey(key);
      return entriesByKey.get(`AUXILIARY:${auxiliaryKeyToken(frozen)}`) as AuthorityAuxiliaryInventoryEntryV1 | undefined;
    },
  });
}

function freezeLogicalKey(rawKey: unknown): AuthorityLogicalKeyV1 {
  const kind = readDataProperty(rawKey, 'kind');
  switch (kind) {
    case 'METADATA':
    case 'TASKS':
    case 'FLOW':
    case 'PROGRESS':
      readExactDataObject(rawKey, ['kind']);
      return Object.freeze({ kind });
    case 'DECISION': {
      const object = readExactDataObject(rawKey, ['kind', 'decisionId']);
      try {
        return Object.freeze({ kind, decisionId: parseDecisionId(object.decisionId) });
      } catch (cause) {
        invalidInput('logicalKey.decisionId', cause);
      }
    }
    case 'EVIDENCE': {
      const object = readExactDataObject(rawKey, ['kind', 'evidenceId']);
      try {
        return Object.freeze({ kind, evidenceId: parseEvidenceId(object.evidenceId) });
      } catch (cause) {
        invalidInput('logicalKey.evidenceId', cause);
      }
    }
    case 'RUN': {
      const object = readExactDataObject(rawKey, ['kind', 'runId']);
      try {
        return Object.freeze({ kind, runId: parseRunId(object.runId) });
      } catch (cause) {
        invalidInput('logicalKey.runId', cause);
      }
    }
    case 'TRANSACTION': {
      const object = readExactDataObject(rawKey, ['kind', 'transactionId']);
      return Object.freeze({
        kind,
        transactionId: requireIdentifier(object.transactionId, 'logicalKey.transactionId'),
      });
    }
    default:
      return invalidInput('logicalKey.kind');
  }
}

function freezeArchiveKey(rawKey: unknown): AuthorityArchiveKeyV1 {
  const object = readExactDataObject(rawKey, ['kind', 'revisionId', 'logicalKey']);
  if (object.kind !== 'ARCHIVE') invalidInput('archiveKey.kind');
  let revisionId: RevisionId;
  try {
    revisionId = parseRevisionId(object.revisionId);
  } catch (cause) {
    return invalidInput('archiveKey.revisionId', cause);
  }
  return Object.freeze({
    kind: 'ARCHIVE',
    revisionId,
    logicalKey: freezeLogicalKey(object.logicalKey),
  });
}

function freezeAuxiliaryKey(rawKey: unknown): AuthorityAuxiliaryKeyV1 {
  const object = readExactDataObject(rawKey, ['kind', 'ownerKind', 'ownerId', 'role']);
  if (object.kind !== 'AUXILIARY') invalidInput('auxiliaryKey.kind');
  if (object.ownerKind !== 'RUN' && object.ownerKind !== 'EVIDENCE'
    && object.ownerKind !== 'TRANSACTION') invalidInput('auxiliaryKey.ownerKind');
  return Object.freeze({
    kind: 'AUXILIARY',
    ownerKind: object.ownerKind,
    ownerId: requireIdentifier(object.ownerId, 'auxiliaryKey.ownerId'),
    role: requireIdentifier(object.role, 'auxiliaryKey.role'),
  });
}

function logicalKeyToken(key: AuthorityLogicalKeyV1): string {
  switch (key.kind) {
    case 'METADATA':
    case 'TASKS':
    case 'FLOW':
    case 'PROGRESS':
      return key.kind;
    case 'DECISION':
      return `DECISION:${frame(key.decisionId)}`;
    case 'EVIDENCE':
      return `EVIDENCE:${frame(key.evidenceId)}`;
    case 'RUN':
      return `RUN:${frame(key.runId)}`;
    case 'TRANSACTION':
      return `TRANSACTION:${frame(key.transactionId)}`;
  }
}

function archiveKeyToken(key: AuthorityArchiveKeyV1): string {
  return `${frame(key.revisionId)}:${frame(logicalKeyToken(key.logicalKey))}`;
}

function auxiliaryKeyToken(key: AuthorityAuxiliaryKeyV1): string {
  return `${key.ownerKind}:${frame(key.ownerId)}:${frame(key.role)}`;
}

function frame(value: string): string {
  return `${value.length}:${value}`;
}

function requireUniqueKey(
  targets: readonly PreparedTarget[],
  code: Extract<AuthorityInventoryErrorCode,
  | 'AUTHORITY_INVENTORY_LOGICAL_KEY_DUPLICATE'
  | 'AUTHORITY_INVENTORY_ARCHIVE_KEY_DUPLICATE'
  | 'AUTHORITY_INVENTORY_AUXILIARY_KEY_DUPLICATE'>,
): void {
  const keys = createSet<string>();
  for (const target of targets) {
    if (setHas(keys, target.keyToken)) throw new AuthorityInventoryError(code, target.keyToken);
    setAdd(keys, target.keyToken);
  }
}

function requireUniquePaths(targets: readonly PreparedTarget[]): void {
  const paths = createSet<string>();
  for (const target of targets) {
    if (setHas(paths, target.relativePath)) {
      throw new AuthorityInventoryError('AUTHORITY_INVENTORY_PATH_COLLISION', target.relativePath);
    }
    setAdd(paths, target.relativePath);
  }
}

function requireBaseRequestShape(
  request: BuildAuthorityInventoryBaseRequestV1,
): Record<string, unknown> {
  const object = readExactDataObject(request, [
    'containedRoot',
    'observedIo',
    'logicalTargets',
    'archiveTargets',
    'knownAuxiliaryTargets',
  ]);
  if (typeof object.containedRoot !== 'string') invalidInput('request');
  return object;
}

function readDenseDataArray(value: unknown, label: string): readonly unknown[] {
  if (value !== null && typeof value === 'object' && isProxy(value)) {
    return invalidInput(`${label} proxy`);
  }
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return invalidInput(label);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1 || !ownKeys.includes('length')) {
    return invalidInput(label);
  }
  const copy: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      return invalidInput(`${label}[${key}]`);
    }
    arrayPush(copy, descriptor.value);
  }
  return Object.freeze(copy);
}

function readExactDataObject(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object') return invalidInput('object');
  if (isProxy(value)) return invalidInput('proxy');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalidInput('prototype');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))) {
    return invalidInput('own keys');
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      return invalidInput(`data property ${key}`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function readDataProperty(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return invalidInput(key);
  if (isProxy(value)) return invalidInput(`${key} proxy`);
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
    return invalidInput(key);
  }
  return descriptor.value;
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 255
    || value !== value.normalize('NFC')
    || value.includes('\0')
    || /[\u0001-\u001f\u007f\r\n\u2028\u2029]/u.test(value)
    || !hasOnlyUnicodeScalars(value)) return invalidInput(label);
  return value;
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

function invalidInput(detail: string, cause?: unknown): never {
  throw new AuthorityInventoryError('AUTHORITY_INVENTORY_INPUT_INVALID', detail, cause);
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

function createSet<Value>(): Set<Value> {
  return new SetIntrinsic<Value>();
}

function setAdd<Value>(set: Set<Value>, value: Value): void {
  reflectApplyIntrinsic(setAddIntrinsic, set, [value]);
}

function setHas<Value>(set: Set<Value>, value: Value): boolean {
  return reflectApplyIntrinsic(setHasIntrinsic, set, [value]) as boolean;
}

function setForEach<Value>(set: Set<Value>, callback: (value: Value) => void): void {
  reflectApplyIntrinsic(setForEachIntrinsic, set, [callback]);
}

function stringLastIndexOf(value: string, search: string): number {
  return reflectApplyIntrinsic(stringLastIndexOfIntrinsic, value, [search]) as number;
}

function stringSlice(value: string, start: number, end?: number): string {
  return reflectApplyIntrinsic(stringSliceIntrinsic, value, [start, end]) as string;
}
