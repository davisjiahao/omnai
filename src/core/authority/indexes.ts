import { hashStrictObject } from '../../authority/catalog-schema.js';
import { isProxy } from 'node:util/types';
import type {
  ChangeMetadata,
  DecisionRecordV2,
  EvidenceRecord,
  FlowPlanV2,
  ProgressEventV1,
  Task,
  TaskFile,
} from '../../domain/change.js';
import type { StageRunManifestV3 } from '../../domain/run.js';
import type {
  ChangeId,
  DecisionId,
  EvidenceId,
  RevisionId,
  RunId,
  Sha256,
  TaskId,
} from '../../domain/scalars.js';
import {
  parseDecisionId,
  parseEvidenceId,
  parseRevisionId,
  parseRunId,
} from '../../domain/scalars.js';
import type {
  AuthorityArchiveInventoryEntryV1,
  AuthorityLogicalInventoryEntryV1,
  AuthorityLogicalKeyV1,
} from './inventory.js';

const reflectApplyIntrinsic = Reflect.apply;
const objectFreezeIntrinsic = Object.freeze;
const arrayPushIntrinsic = Array.prototype.push;
const arraySortIntrinsic = Array.prototype.sort;
const arrayIsArrayIntrinsic = Array.isArray;
const objectKeysIntrinsic = Object.keys;
const Uint8ArrayIntrinsic = Uint8Array;
const jsonStringifyIntrinsic = JSON.stringify;
const weakMapGetIntrinsic = WeakMap.prototype.get;
const weakMapSetIntrinsic = WeakMap.prototype.set;

export type AuthorityArchiveSnapshotV1 = Readonly<{
  revisionId: RevisionId;
  logicalKey: AuthorityLogicalKeyV1;
  keyToken: string;
  relativePath: string;
  nodeType: 'FILE' | 'DIRECTORY';
  contentHash: Sha256;
  copyBytes(): Uint8Array;
  directoryEntries: readonly Readonly<{ name: string; nodeType: string }>[];
}>;

export type AuthorityTransactionPhysicalCaptureV1 = Readonly<{
  transactionId: string;
  relativePath: string;
  nodeType: 'FILE' | 'DIRECTORY';
  contentHash: Sha256;
  copyBytes(): Uint8Array;
  directoryEntries: readonly Readonly<{ name: string; nodeType: string }>[];
}>;

export type AuthorityIndexesV1 = Readonly<{
  metadata: ChangeMetadata;
  taskFile: TaskFile | null;
  flow: FlowPlanV2 | null;
  decisions: readonly DecisionRecordV2[];
  evidence: readonly EvidenceRecord[];
  runs: readonly StageRunManifestV3[];
  progress: readonly ProgressEventV1[];
  decisionsById: ReadonlyMap<DecisionId, DecisionRecordV2>;
  evidenceById: ReadonlyMap<EvidenceId, EvidenceRecord>;
  tasksById: ReadonlyMap<TaskId, Task>;
  runsById: ReadonlyMap<RunId, StageRunManifestV3>;
  progressByEventKind: ReadonlyMap<ProgressEventV1['event'], readonly ProgressEventV1[]>;
  progressByOperationRequestId: ReadonlyMap<string, readonly ProgressEventV1[]>;
  archiveCache: ReadonlyMap<string, AuthorityArchiveSnapshotV1>;
  transactionPhysicalCaptures: ReadonlyMap<string, AuthorityTransactionPhysicalCaptureV1>;
}>;

export type BuildAuthorityIndexesInputV1 = Readonly<{
  expectedChangeId: ChangeId;
  metadata: ChangeMetadata;
  taskFile: TaskFile | null;
  flow: FlowPlanV2 | null;
  decisions: readonly DecisionRecordV2[];
  evidence: readonly EvidenceRecord[];
  runs: readonly StageRunManifestV3[];
  progress: readonly ProgressEventV1[];
  archiveEntries: readonly AuthorityArchiveInventoryEntryV1[];
  transactionEntries: readonly AuthorityLogicalInventoryEntryV1[];
}>;

export class AuthorityIndexError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'AuthorityIndexError';
  }
}

export function buildAuthorityIndexes(input: BuildAuthorityIndexesInputV1): AuthorityIndexesV1 {
  const metadata = freezeJsonTree(input.metadata);
  if (metadata.id !== input.expectedChangeId) fail('AUTHORITY_INDEX_CHANGE_MISMATCH', metadata.id);

  const taskFile = input.taskFile === null ? null : freezeJsonTree(input.taskFile);
  if (taskFile !== null && taskFile.revision !== metadata.activeRevision) {
    fail('AUTHORITY_INDEX_REVISION_MISMATCH', 'tasks');
  }
  const flow = input.flow === null ? null : freezeJsonTree(input.flow);
  if (flow !== null && (
    flow.changeId !== metadata.id
    || flow.revision !== metadata.activeRevision
    || flow.baseline !== metadata.baseline
  )) fail('AUTHORITY_INDEX_REVISION_MISMATCH', 'flow');

  const decisions = freezeOrderedValues(input.decisions, (decision) => decision.id);
  const evidence = freezeOrderedValues(input.evidence, (record) => record.id);
  const runs = freezeOrderedValues(input.runs, (run) => run.runId);
  const progress = freezeValues(input.progress);

  const decisionPairs: Array<readonly [DecisionId, DecisionRecordV2]> = [];
  for (let index = 0; index < decisions.length; index += 1) {
    const decision = decisions[index]!;
    if (decision.changeId !== metadata.id) fail('AUTHORITY_INDEX_CHANGE_MISMATCH', decision.id);
    requireAbsent(decisionPairs, decision.id, 'AUTHORITY_INDEX_DECISION_DUPLICATE');
    arrayPush(decisionPairs, objectFreezeIntrinsic([decision.id, decision]));
  }

  const evidencePairs: Array<readonly [EvidenceId, EvidenceRecord]> = [];
  for (let index = 0; index < evidence.length; index += 1) {
    const record = evidence[index]!;
    if (record.changeId !== metadata.id) fail('AUTHORITY_INDEX_CHANGE_MISMATCH', record.id);
    requireAbsent(evidencePairs, record.id, 'AUTHORITY_INDEX_EVIDENCE_DUPLICATE');
    arrayPush(evidencePairs, objectFreezeIntrinsic([record.id, record]));
  }

  const taskPairs: Array<readonly [TaskId, Task]> = [];
  const tasks = taskFile?.tasks ?? objectFreezeIntrinsic([]);
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index]!;
    requireAbsent(taskPairs, task.id, 'AUTHORITY_INDEX_TASK_DUPLICATE');
    arrayPush(taskPairs, objectFreezeIntrinsic([task.id, task]));
  }

  const runPairs: Array<readonly [RunId, StageRunManifestV3]> = [];
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index]!;
    if (run.changeId !== metadata.id) fail('AUTHORITY_INDEX_CHANGE_MISMATCH', run.runId);
    requireAbsent(runPairs, run.runId, 'AUTHORITY_INDEX_RUN_DUPLICATE');
    arrayPush(runPairs, objectFreezeIntrinsic([run.runId, run]));
  }

  const eventsByKind = groupProgress(progress, (event) => event.event);
  const eventsByRequest = groupProgress(progress, (event) => event.operationRequestId);
  const seenEventRows: string[] = [];
  for (let index = 0; index < progress.length; index += 1) {
    const event = progress[index]!;
    if (event.changeId !== metadata.id) fail('AUTHORITY_INDEX_CHANGE_MISMATCH', event.event);
    const eventKey = hashStrictObject(event);
    if (containsString(seenEventRows, eventKey)) fail('AUTHORITY_INDEX_EVENT_DUPLICATE', eventKey);
    arrayPush(seenEventRows, eventKey);
  }

  const archivePairs: Array<readonly [string, AuthorityArchiveSnapshotV1]> = [];
  for (let index = 0; index < input.archiveEntries.length; index += 1) {
    const entry = input.archiveEntries[index]!;
    const key = archiveCacheKey(entry.key.revisionId, entry.key.logicalKey);
    requireAbsent(archivePairs, key, 'AUTHORITY_INDEX_ARCHIVE_DUPLICATE');
    arrayPush(archivePairs, objectFreezeIntrinsic([key, freezeArchiveSnapshot(entry)]));
  }

  const transactionPairs: Array<readonly [string, AuthorityTransactionPhysicalCaptureV1]> = [];
  for (let index = 0; index < input.transactionEntries.length; index += 1) {
    const entry = input.transactionEntries[index]!;
    if (entry.key.kind !== 'TRANSACTION') continue;
    requireAbsent(transactionPairs, entry.key.transactionId, 'AUTHORITY_INDEX_TRANSACTION_DUPLICATE');
    arrayPush(transactionPairs, objectFreezeIntrinsic([
      entry.key.transactionId,
      freezeTransactionCapture(entry.key.transactionId, entry),
    ]));
  }

  return objectFreezeIntrinsic({
    metadata,
    taskFile,
    flow,
    decisions,
    evidence,
    runs,
    progress,
    decisionsById: freezeReadonlyMap(decisionPairs),
    evidenceById: freezeReadonlyMap(evidencePairs),
    tasksById: freezeReadonlyMap(taskPairs),
    runsById: freezeReadonlyMap(runPairs),
    progressByEventKind: eventsByKind,
    progressByOperationRequestId: eventsByRequest,
    archiveCache: freezeReadonlyMap(archivePairs),
    transactionPhysicalCaptures: freezeReadonlyMap(transactionPairs),
  });
}

export function archiveCacheKey(
  revisionId: RevisionId,
  logicalKey: AuthorityLogicalKeyV1,
): string {
  if (typeof revisionId !== 'string') fail('AUTHORITY_INDEX_REVISION_ID_INVALID', 'revisionId');
  let parsedRevisionId: RevisionId;
  try {
    parsedRevisionId = parseRevisionId(revisionId);
  } catch {
    return fail('AUTHORITY_INDEX_REVISION_ID_INVALID', 'revisionId');
  }
  return `${frame(parsedRevisionId)}:${logicalKeyToken(logicalKey)}`;
}

type SemanticMutationTransactionViewRowV1 = Readonly<{
  id: string;
  status: 'PENDING' | 'COMPLETED';
  kind: string;
  audits?: readonly unknown[];
  audit?: unknown;
}>;

type SemanticMutationEventViewRowV1 = Readonly<{ data: unknown }>;

export type BuildSemanticMutationLineageViewInputV1 = Readonly<{
  transactions: readonly SemanticMutationTransactionViewRowV1[];
  events: readonly SemanticMutationEventViewRowV1[];
}>;

export type SemanticMutationLineageViewV1 = Readonly<{
  schemaVersion: 1;
  kind: 'SEMANTIC_MUTATION_LINEAGE_VIEW_V1';
  transactions: readonly SemanticMutationTransactionViewRowV1[];
  events: readonly SemanticMutationEventViewRowV1[];
  eventsByMutationId: ReadonlyMap<string, readonly SemanticMutationEventViewRowV1[]>;
}>;

type SemanticMutationLineageViewStateV1 = Readonly<{
  transactions: readonly Readonly<{
    id: string;
    status: 'PENDING' | 'COMPLETED';
    kind: string;
    audits?: readonly unknown[];
    audit?: unknown;
  }>[];
  events: readonly Readonly<{ data: unknown }>[];
  eventsByMutationId: ReadonlyMap<string, readonly Readonly<{ data: unknown }>[] >;
}>;

const semanticViewStates = new WeakMap<
  SemanticMutationLineageViewV1,
  SemanticMutationLineageViewStateV1
>();

/** 从一次捕获的 event 列表内部派生 correlation；caller Map 不是权限来源。 */
export function buildSemanticMutationLineageView(
  rawInput: BuildSemanticMutationLineageViewInputV1,
): SemanticMutationLineageViewV1 {
  const input = readSemanticExactObject(rawInput, ['transactions', 'events']);
  const transactions = cloneSemanticTransactions(input.transactions);
  const events = cloneSemanticEvents(input.events);
  const eventsByMutationId = deriveSemanticCorrelation(events);
  const view = objectFreezeIntrinsic({
    schemaVersion: 1 as const,
    kind: 'SEMANTIC_MUTATION_LINEAGE_VIEW_V1' as const,
    transactions,
    events,
    eventsByMutationId,
  });
  weakMapSet(semanticViewStates, view, objectFreezeIntrinsic({
    transactions,
    events,
    eventsByMutationId,
  }));
  return view;
}

/** 纯 completed consumer；只接受本模块登记的认证 view，绝不回退到 caller Map 或磁盘扫描。 */
export function assertCompletedSemanticMutationInventory(
  view: SemanticMutationLineageViewV1,
): void {
  if (view === null || typeof view !== 'object' || isProxy(view)) semanticViewInvalid('view');
  const inventory = weakMapGet(semanticViewStates, view);
  if (inventory === undefined) semanticViewInvalid('view');
  const transactionIds: string[] = [];
  for (let index = 0; index < inventory.transactions.length; index += 1) {
    arrayPush(transactionIds, inventory.transactions[index]!.id);
  }
  const mutationIds = inventory.eventsByMutationId.keys();
  for (let next = mutationIds.next(); !next.done; next = mutationIds.next()) {
    if (!containsString(transactionIds, next.value)) semanticFail('SEMANTIC_MUTATION_AUDIT_ORPHAN');
  }
  for (let transactionIndex = 0; transactionIndex < inventory.transactions.length; transactionIndex += 1) {
    const transaction = inventory.transactions[transactionIndex]!;
    const expectedAudits = transaction.kind === 'SCENARIO_RECLASSIFY'
      ? [transaction.audit]
      : transaction.audits ?? [];
    const mutationEvents = inventory.eventsByMutationId.get(transaction.id) ?? [];
    if (transaction.status === 'PENDING') {
      if (mutationEvents.length > expectedAudits.length) semanticFail('SEMANTIC_MUTATION_AUDIT_CARDINALITY');
      for (let index = 0; index < mutationEvents.length; index += 1) {
        if (jsonStringifyIntrinsic(mutationEvents[index]) !== jsonStringifyIntrinsic(expectedAudits[index])) {
          semanticFail('SEMANTIC_MUTATION_AUDIT_MISMATCH');
        }
      }
      continue;
    }
    if (mutationEvents.length !== expectedAudits.length) semanticFail('SEMANTIC_MUTATION_AUDIT_CARDINALITY');
    for (let expectedIndex = 0; expectedIndex < expectedAudits.length; expectedIndex += 1) {
      const expected = expectedAudits[expectedIndex];
      let matched = false;
      for (let index = 0; index < mutationEvents.length; index += 1) {
        if (jsonStringifyIntrinsic(mutationEvents[index]) === jsonStringifyIntrinsic(expected)) {
          matched = true;
          break;
        }
      }
      if (!matched) {
        semanticFail('SEMANTIC_MUTATION_AUDIT_MISMATCH');
      }
    }
  }
}

function cloneSemanticTransactions(value: unknown): readonly SemanticMutationTransactionViewRowV1[] {
  const source = readSemanticArray(value, 'transactions');
  const copied: SemanticMutationTransactionViewRowV1[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const transaction = readSemanticObject(source[index], `transactions[${index}]`);
    const id = readSemanticDataProperty(transaction, 'id', true);
    const status = readSemanticDataProperty(transaction, 'status', true);
    const kind = readSemanticDataProperty(transaction, 'kind', true);
    if (typeof id !== 'string' || id.length === 0) semanticViewInvalid(`transactions[${index}].id`);
    if (status !== 'PENDING' && status !== 'COMPLETED') {
      semanticViewInvalid(`transactions[${index}].status`);
    }
    if (typeof kind !== 'string' || kind.length === 0) semanticViewInvalid(`transactions[${index}].kind`);
    const audits = readSemanticDataProperty(transaction, 'audits', false);
    const audit = readSemanticDataProperty(transaction, 'audit', false);
    const row: {
      id: string;
      status: 'PENDING' | 'COMPLETED';
      kind: string;
      audits?: readonly unknown[];
      audit?: unknown;
    } = { id, status, kind };
    if (audits !== undefined) row.audits = cloneSemanticJsonArray(audits, `transactions[${index}].audits`);
    if (audit !== undefined) row.audit = cloneSemanticJsonValue(audit, `transactions[${index}].audit`);
    arrayPush(copied, objectFreezeIntrinsic(row));
  }
  return objectFreezeIntrinsic(copied);
}

function cloneSemanticEvents(value: unknown): readonly SemanticMutationEventViewRowV1[] {
  const source = readSemanticArray(value, 'events');
  const copied: SemanticMutationEventViewRowV1[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const event = cloneSemanticJsonValue(source[index], `events[${index}]`);
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      semanticViewInvalid(`events[${index}]`);
    }
    readSemanticDataProperty(event, 'data', true);
    arrayPush(copied, event as SemanticMutationEventViewRowV1);
  }
  return objectFreezeIntrinsic(copied);
}

function deriveSemanticCorrelation(
  events: readonly SemanticMutationEventViewRowV1[],
): ReadonlyMap<string, readonly SemanticMutationEventViewRowV1[]> {
  const groups: Array<readonly [string, SemanticMutationEventViewRowV1[]]> = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const mutationId = semanticMutationId(event, index);
    if (mutationId === undefined) continue;
    let group: SemanticMutationEventViewRowV1[] | undefined;
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      if (groups[groupIndex]![0] === mutationId) group = groups[groupIndex]![1];
    }
    if (group === undefined) {
      group = [];
      arrayPush(groups, objectFreezeIntrinsic([mutationId, group]));
    }
    arrayPush(group, event);
  }
  const frozen: Array<readonly [string, readonly SemanticMutationEventViewRowV1[]]> = [];
  for (let index = 0; index < groups.length; index += 1) {
    const pair = groups[index]!;
    arrayPush(frozen, objectFreezeIntrinsic([pair[0], objectFreezeIntrinsic(pair[1])]));
  }
  return freezeReadonlyMap(frozen);
}

function semanticMutationId(
  event: SemanticMutationEventViewRowV1,
  index: number,
): string | undefined {
  const data = event.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const value = readSemanticDataProperty(data, 'semanticMutationId', false);
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) semanticViewInvalid(`events[${index}].semanticMutationId`);
  return value;
}

function cloneSemanticJsonArray(value: unknown, detail: string): readonly unknown[] {
  const source = readSemanticArray(value, detail);
  const copied: unknown[] = [];
  for (let index = 0; index < source.length; index += 1) {
    arrayPush(copied, cloneSemanticJsonValue(source[index], `${detail}[${index}]`));
  }
  return objectFreezeIntrinsic(copied);
}

function cloneSemanticJsonValue(value: unknown, detail: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value;
  if (Array.isArray(value)) return cloneSemanticJsonArray(value, detail);
  const source = readSemanticObject(value, detail);
  const copied: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const keys = Reflect.ownKeys(source);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== 'string') semanticViewInvalid(`${detail}.key`);
    const property = readSemanticDataProperty(source, key, true);
    Object.defineProperty(copied, key, {
      configurable: false,
      enumerable: true,
      value: cloneSemanticJsonValue(property, `${detail}.${key}`),
      writable: false,
    });
  }
  return objectFreezeIntrinsic(copied);
}

function readSemanticExactObject(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  const object = readSemanticObject(value, 'input');
  const keys = Reflect.ownKeys(object);
  if (keys.length !== expectedKeys.length) semanticViewInvalid('input keys');
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== 'string' || !containsString(expectedKeys, key)) semanticViewInvalid('input keys');
  }
  const copied: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (let index = 0; index < expectedKeys.length; index += 1) {
    const key = expectedKeys[index]!;
    copied[key] = readSemanticDataProperty(object, key, true);
  }
  return copied;
}

function readSemanticArray(value: unknown, detail: string): readonly unknown[] {
  if (value !== null && typeof value === 'object' && isProxy(value)) semanticViewInvalid(detail);
  if (!arrayIsArrayIntrinsic(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    semanticViewInvalid(detail);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !containsPropertyKey(keys, 'length')) semanticViewInvalid(detail);
  const copied: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    arrayPush(copied, readSemanticDataProperty(value, String(index), true));
  }
  return copied;
}

function readSemanticObject(value: unknown, detail: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || isProxy(value)) semanticViewInvalid(detail);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) semanticViewInvalid(detail);
  return value as Record<string, unknown>;
}

function readSemanticDataProperty(value: object, key: string, required: boolean): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) {
    if (!required) return undefined;
    return semanticViewInvalid(key);
  }
  if (!('value' in descriptor) || !descriptor.enumerable) semanticViewInvalid(key);
  return descriptor.value;
}

function freezeArchiveSnapshot(entry: AuthorityArchiveInventoryEntryV1): AuthorityArchiveSnapshotV1 {
  const copied = copyInventoryBytes(entry);
  const directoryEntries = copyDirectoryEntries(entry);
  return objectFreezeIntrinsic({
    revisionId: entry.key.revisionId,
    logicalKey: entry.key.logicalKey,
    keyToken: entry.keyToken,
    relativePath: entry.relativePath,
    nodeType: entry.nodeType,
    contentHash: entry.contentHash,
    copyBytes: copied.copyBytes,
    directoryEntries,
  });
}

function freezeTransactionCapture(
  transactionId: string,
  entry: AuthorityLogicalInventoryEntryV1,
): AuthorityTransactionPhysicalCaptureV1 {
  const copied = copyInventoryBytes(entry);
  return objectFreezeIntrinsic({
    transactionId,
    relativePath: entry.relativePath,
    nodeType: entry.nodeType,
    contentHash: entry.contentHash,
    copyBytes: copied.copyBytes,
    directoryEntries: copyDirectoryEntries(entry),
  });
}

function copyInventoryBytes(entry: AuthorityArchiveInventoryEntryV1 | AuthorityLogicalInventoryEntryV1) {
  const source = entry.nodeType === 'FILE' ? entry.capture.copyBytes() : new Uint8ArrayIntrinsic(0);
  const total = entry.nodeType === 'FILE' ? entry.capture.byteLength : 0;
  const privateBytes = new Uint8ArrayIntrinsic(total);
  for (let index = 0; index < total; index += 1) privateBytes[index] = source[index]!;
  return objectFreezeIntrinsic({
    copyBytes(): Uint8Array {
      const copy = new Uint8ArrayIntrinsic(total);
      for (let index = 0; index < total; index += 1) copy[index] = privateBytes[index]!;
      return copy;
    },
  });
}

function copyDirectoryEntries(
  entry: AuthorityArchiveInventoryEntryV1 | AuthorityLogicalInventoryEntryV1,
): readonly Readonly<{ name: string; nodeType: string }>[] {
  if (entry.nodeType === 'FILE') return objectFreezeIntrinsic([]);
  const copied: Array<Readonly<{ name: string; nodeType: string }>> = [];
  for (let index = 0; index < entry.observation.typedEntries.length; index += 1) {
    const item = entry.observation.typedEntries[index]!;
    arrayPush(copied, objectFreezeIntrinsic({ name: item.name, nodeType: item.nodeType }));
  }
  return objectFreezeIntrinsic(copied);
}

function freezeValues<Value>(values: readonly Value[]): readonly Value[] {
  const copied: Value[] = [];
  for (let index = 0; index < values.length; index += 1) {
    arrayPush(copied, freezeJsonTree(values[index]!));
  }
  return objectFreezeIntrinsic(copied);
}

function freezeOrderedValues<Value>(
  values: readonly Value[],
  key: (value: Value) => string,
): readonly Value[] {
  const copied: Value[] = [];
  for (let index = 0; index < values.length; index += 1) {
    arrayPush(copied, freezeJsonTree(values[index]!));
  }
  reflectApplyIntrinsic(arraySortIntrinsic, copied, [(
    left: Value,
    right: Value,
  ) => compareCodeUnits(key(left), key(right))]);
  return objectFreezeIntrinsic(copied);
}

function freezeJsonTree<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object') return value;
  if (arrayIsArrayIntrinsic(value)) {
    for (let index = 0; index < value.length; index += 1) freezeJsonTree(value[index]);
    return objectFreezeIntrinsic(value);
  }
  const record = value as Record<string, unknown>;
  const keys = reflectApplyIntrinsic(objectKeysIntrinsic, Object, [record]) as string[];
  for (let index = 0; index < keys.length; index += 1) freezeJsonTree(record[keys[index]!]);
  return objectFreezeIntrinsic(value);
}

function groupProgress<Key extends string>(
  progress: readonly ProgressEventV1[],
  select: (event: ProgressEventV1) => Key,
): ReadonlyMap<Key, readonly ProgressEventV1[]> {
  const groups: Array<readonly [Key, ProgressEventV1[]]> = [];
  for (let eventIndex = 0; eventIndex < progress.length; eventIndex += 1) {
    const event = progress[eventIndex]!;
    const key = select(event);
    let group: ProgressEventV1[] | undefined;
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const pair = groups[groupIndex]!;
      if (pair[0] === key) group = pair[1];
    }
    if (group === undefined) {
      group = [];
      arrayPush(groups, objectFreezeIntrinsic([key, group]));
    }
    arrayPush(group, event);
  }
  const frozen: Array<readonly [Key, readonly ProgressEventV1[]]> = [];
  for (let index = 0; index < groups.length; index += 1) {
    const pair = groups[index]!;
    arrayPush(frozen, objectFreezeIntrinsic([pair[0], objectFreezeIntrinsic(pair[1])]));
  }
  return freezeReadonlyMap(frozen);
}

function requireAbsent<Key, Value>(
  pairs: readonly (readonly [Key, Value])[],
  key: Key,
  code: string,
): void {
  for (let index = 0; index < pairs.length; index += 1) {
    if (pairs[index]![0] === key) fail(code, String(key));
  }
}

function logicalKeyToken(key: AuthorityLogicalKeyV1): string {
  const kind = readLogicalKeyProperty(key, 'kind');
  switch (kind) {
    case 'METADATA':
    case 'TASKS':
    case 'FLOW':
    case 'PROGRESS':
      requireLogicalKeyShape(key, ['kind']);
      return kind;
    case 'DECISION': {
      requireLogicalKeyShape(key, ['kind', 'decisionId']);
      return `DECISION:${frame(parseDecisionId(readLogicalKeyProperty(key, 'decisionId')))}`;
    }
    case 'EVIDENCE': {
      requireLogicalKeyShape(key, ['kind', 'evidenceId']);
      return `EVIDENCE:${frame(parseEvidenceId(readLogicalKeyProperty(key, 'evidenceId')))}`;
    }
    case 'RUN': {
      requireLogicalKeyShape(key, ['kind', 'runId']);
      return `RUN:${frame(parseRunId(readLogicalKeyProperty(key, 'runId')))}`;
    }
    case 'TRANSACTION': {
      requireLogicalKeyShape(key, ['kind', 'transactionId']);
      const transactionId = readLogicalKeyProperty(key, 'transactionId');
      if (typeof transactionId !== 'string' || transactionId.length === 0) {
        fail('AUTHORITY_INDEX_LOGICAL_KEY_INVALID', 'transactionId');
      }
      return `TRANSACTION:${frame(transactionId)}`;
    }
    default: return fail('AUTHORITY_INDEX_LOGICAL_KEY_INVALID', 'kind');
  }
}

function frame(value: string): string {
  return `${value.length}:${value}`;
}

function fail(code: string, detail: string): never {
  throw new AuthorityIndexError(code, detail);
}

function semanticFail(detail: string): never {
  throw new Error(`SEMANTIC_MUTATION_LINEAGE: ${detail}`);
}

function semanticViewInvalid(detail: string): never {
  throw new AuthorityIndexError('AUTHORITY_SEMANTIC_VIEW_INVALID', detail);
}

class FrozenReadonlyMap<Key, Value> implements ReadonlyMap<Key, Value> {
  readonly #entries: readonly (readonly [Key, Value])[];

  constructor(entries: readonly (readonly [Key, Value])[]) {
    const copied: Array<readonly [Key, Value]> = [];
    for (let index = 0; index < entries.length; index += 1) {
      const pair = entries[index]!;
      arrayPush(copied, objectFreezeIntrinsic([pair[0], pair[1]]));
    }
    this.#entries = objectFreezeIntrinsic(copied);
    objectFreezeIntrinsic(this);
  }

  get size(): number { return this.#entries.length; }
  get(key: Key): Value | undefined {
    for (let index = 0; index < this.#entries.length; index += 1) {
      const pair = this.#entries[index]!;
      if (pair[0] === key) return pair[1];
    }
    return undefined;
  }
  has(key: Key): boolean { return this.get(key) !== undefined; }
  entries(): MapIterator<[Key, Value]> { return createIterator(this.#entries, 'ENTRY'); }
  keys(): MapIterator<Key> { return createIterator(this.#entries, 'KEY'); }
  values(): MapIterator<Value> { return createIterator(this.#entries, 'VALUE'); }
  forEach(callbackfn: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void, thisArg?: unknown): void {
    for (let index = 0; index < this.#entries.length; index += 1) {
      const pair = this.#entries[index]!;
      reflectApplyIntrinsic(callbackfn, thisArg, [pair[1], pair[0], this]);
    }
  }
  [Symbol.iterator](): MapIterator<[Key, Value]> { return this.entries(); }
  get [Symbol.toStringTag](): string { return 'FrozenReadonlyMap'; }
}
objectFreezeIntrinsic(FrozenReadonlyMap.prototype);

function freezeReadonlyMap<Key, Value>(
  entries: readonly (readonly [Key, Value])[],
): ReadonlyMap<Key, Value> {
  return new FrozenReadonlyMap(entries);
}

function createIterator<Key, Value>(
  entries: readonly (readonly [Key, Value])[],
  kind: 'ENTRY',
): MapIterator<[Key, Value]>;
function createIterator<Key, Value>(
  entries: readonly (readonly [Key, Value])[],
  kind: 'KEY',
): MapIterator<Key>;
function createIterator<Key, Value>(
  entries: readonly (readonly [Key, Value])[],
  kind: 'VALUE',
): MapIterator<Value>;
function createIterator<Key, Value>(
  entries: readonly (readonly [Key, Value])[],
  kind: 'ENTRY' | 'KEY' | 'VALUE',
): MapIterator<[Key, Value]> | MapIterator<Key> | MapIterator<Value> {
  let index = 0;
  return objectFreezeIntrinsic({
    next(): IteratorResult<[Key, Value] | Key | Value> {
      if (index >= entries.length) return objectFreezeIntrinsic({ done: true, value: undefined });
      const pair = entries[index++]!;
      const value = kind === 'ENTRY' ? [pair[0], pair[1]] as [Key, Value]
        : kind === 'KEY' ? pair[0] : pair[1];
      return objectFreezeIntrinsic({ done: false, value });
    },
    [Symbol.iterator]() { return this; },
    [Symbol.dispose]() { index = entries.length; },
  }) as MapIterator<[Key, Value]> | MapIterator<Key> | MapIterator<Value>;
}

function arrayPush<Value>(array: Value[], value: Value): void {
  reflectApplyIntrinsic(arrayPushIntrinsic, array, [value]);
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

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireLogicalKeyShape(value: object, expectedKeys: readonly string[]): void {
  if (isProxy(value)) fail('AUTHORITY_INDEX_LOGICAL_KEY_INVALID', 'proxy');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('AUTHORITY_INDEX_LOGICAL_KEY_INVALID', 'prototype');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length) fail('AUTHORITY_INDEX_LOGICAL_KEY_INVALID', 'keys');
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== 'string' || !containsString(expectedKeys, key)) {
      fail('AUTHORITY_INDEX_LOGICAL_KEY_INVALID', 'keys');
    }
  }
}

function readLogicalKeyProperty(value: object, key: string): unknown {
  if (isProxy(value)) fail('AUTHORITY_INDEX_LOGICAL_KEY_INVALID', 'proxy');
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
    fail('AUTHORITY_INDEX_LOGICAL_KEY_INVALID', key);
  }
  return descriptor.value;
}
