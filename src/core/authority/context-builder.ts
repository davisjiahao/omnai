import { isProxy } from 'node:util/types';
import { join } from 'node:path';
import YAML from 'yaml';
import {
  hashStrictObject,
  type StageAuthorityCatalogV1,
} from '../../authority/catalog-schema.js';
import { requireVerifiedAuthorityCatalog } from '../../authority/catalog-loader.js';
import {
  changeMetadataSchema,
  decisionRecordSchema,
  evidenceRecordSchema,
  flowPlanSchema,
  progressEventSchema,
  taskFileSchema,
  type ChangeMetadata,
  type DecisionRecordV2,
  type EvidenceRecord,
  type FlowPlanV2,
  type ProgressEventV1,
  type Task,
  type TaskFile,
} from '../../domain/change.js';
import { normalizedAbsoluteRealPathSchema } from '../../domain/public.js';
import { workflowLockSchema, type StrictWorkflowLockV2 } from '../../domain/project.js';
import { stageRunManifestSchema, type StageRunManifestV3 } from '../../domain/run.js';
import {
  parseChangeId,
  parseDecisionId,
  parseEvidenceId,
  parseRunId,
  type ChangeId,
  type DecisionId,
  type EvidenceId,
  type RevisionId,
  type RunId,
  type TaskId,
} from '../../domain/scalars.js';
import {
  AuthorityContextError,
  type AuthenticatedBaseContextStateV1,
  type BaseContextHandleV1,
  type BuildBaseContextRequestV1,
  type ChangeAuthorityContext,
  type SealedContextMachineStateV1,
} from './context.js';
import {
  archiveCacheKey,
  buildAuthorityIndexes,
} from './indexes.js';
import {
  buildAuthorityInventoryBase,
  buildAuthorityInventoryBaseFromDiscovery,
  closeAuthorityInventoryDiscovery,
  createAuthorityInventoryDiscovery,
  discoverAuthorityInventoryDirectory,
  finalizeAuthorityInventory,
  type AuthorityInventoryDiscoveryV1,
  type AuthorityInventoryBaseV1,
  type AuthorityLogicalKeyV1,
  type AuthorityLogicalInventoryEntryV1,
  type AuthorityLogicalTargetV1,
} from './inventory.js';
import { buildMachineAuthorityProjection } from './machine-seal.js';
import { createObservedIoRecorder, type ObservedIoRecorderV1 } from './observed-io.js';
import {
  captureStableBytes,
  observeStableDirectory,
  withBoundStableRootIdentity,
  withStableRootAnchor,
  type StableByteCaptureV1,
  type StableRootAnchorV1,
  type StableRootIdentityV1,
} from './stable-bytes.js';
import type { SourceCaptureSession } from '../source/types.js';

const WORKFLOW_LOCK_RELATIVE_PATH = 'workflow.lock.yaml';
const reflectApplyIntrinsic = Reflect.apply;
const objectFreezeIntrinsic = Object.freeze;
const arrayPushIntrinsic = Array.prototype.push;
const arrayIsArrayIntrinsic = Array.isArray;
const objectKeysIntrinsic = Object.keys;
const TextDecoderIntrinsic = TextDecoder;
const textDecoderDecodeIntrinsic = TextDecoder.prototype.decode;
const yamlParseIntrinsic = YAML.parse;
const jsonParseIntrinsic = JSON.parse;
const stringSplitIntrinsic = String.prototype.split;
const stringTrimIntrinsic = String.prototype.trim;
const stringStartsWithIntrinsic = String.prototype.startsWith;
const stringSliceIntrinsic = String.prototype.slice;
const regexpTestIntrinsic = RegExp.prototype.test;
const weakMapGetIntrinsic = WeakMap.prototype.get;
const weakMapSetIntrinsic = WeakMap.prototype.set;
const SetIntrinsic = Set;
const setAddIntrinsic = Set.prototype.add;
const setDeleteIntrinsic = Set.prototype.delete;
const setForEachIntrinsic = Set.prototype.forEach;
const setHasIntrinsic = Set.prototype.has;
const setSizeIntrinsic = Object.getOwnPropertyDescriptor(Set.prototype, 'size')!.get!;
const PromiseIntrinsic = Promise;
const promiseThenIntrinsic = Promise.prototype.then;

type MutableBaseState = {
  readonly authenticated: AuthenticatedBaseContextStateV1;
  phase: 'BASE_AUTHENTICATED' | 'REQUEST_CAPTURED' | 'SEALED';
  consumed: boolean;
};

type MutableSourceCaptureSessionState = {
  readonly authenticated: AuthenticatedBaseContextStateV1;
  readonly sourceRootAnchor: StableRootAnchorV1;
  readonly logicalIdentities: Set<string>;
  readonly pending: Set<Promise<unknown>>;
  hasOperationFailure: boolean;
  operationFailure: unknown;
  active: boolean;
};

export type AuthenticatedSourceCaptureAccessV1 = Readonly<{
  authenticated: AuthenticatedBaseContextStateV1;
  sourceRootAnchor: StableRootAnchorV1;
  claimLogicalIdentity(logicalIdentity: string): boolean;
}>;

const baseStates = new WeakMap<BaseContextHandleV1, MutableBaseState>();
const sealedStates = new WeakMap<ChangeAuthorityContext, SealedContextMachineStateV1>();
const sourceCaptureSessionStates = new WeakMap<SourceCaptureSession, MutableSourceCaptureSessionState>();

export async function buildBaseContext(
  rawRequest: BuildBaseContextRequestV1,
): Promise<BaseContextHandleV1> {
  const request = authenticateBuildRequest(rawRequest);
  return withStableRootAnchor(request.containedRoot, async (_anchor, sourceRootIdentity) => (
    buildAuthenticatedBaseContext(
      request,
      request.containedRoot,
      createObservedIoRecorder(),
      sourceRootIdentity,
    )
  ));
}

// 背景：真实仓库把 WorkflowLock 放在 project authority root，而 artifact/inventory 位于
// Change root；Task4 的同根 fixture 不能作为 public inspect/Flow 的布局权限。目的：本入口
// 自己持有 recorder，稳定发现唯一 Change 目录并构造已有 inventory request，不接受 caller
// 提供目录或 target 清单。上下文：这里只建立 Plan02 read-only context adapter，不创建 owner、
// envelope、全局链或任何持久 schema。
export async function buildChangeBaseContext(
  rawRepoRoot: string,
  rawChangeId: string,
): Promise<BaseContextHandleV1> {
  let repoRoot: string;
  let expectedChangeId: ChangeId;
  try {
    repoRoot = normalizedAbsoluteRealPathSchema.parse(rawRepoRoot);
    expectedChangeId = parseChangeId(rawChangeId);
  } catch (cause) {
    return invalidBuild('repository Change identity', cause);
  }
  const projectAuthorityRoot = join(repoRoot, '.omnai');
  const changesPath = join(projectAuthorityRoot, 'changes');
  const observedIoRecorder = createObservedIoRecorder();
  return withStableRootAnchor(projectAuthorityRoot, async () => (
    withStableRootAnchor(changesPath, async () => {
      const changes = await observeStableDirectory({
        containedRoot: projectAuthorityRoot,
        relativePath: 'changes',
        observedIo: observedIoRecorder,
      });
      const prefix = `${expectedChangeId}-`;
      const matching: typeof changes.typedEntries[number][] = [];
      for (let index = 0; index < changes.typedEntries.length; index += 1) {
        const entry = changes.typedEntries[index]!;
        if (reflectApplyIntrinsic(stringStartsWithIntrinsic, entry.name, [prefix])) {
          arrayPush(matching, entry);
        }
      }
      if (matching.length === 0) {
        throw new AuthorityContextError('AUTHORITY_CONTEXT_CHANGE_MISSING', expectedChangeId);
      }
      if (matching.length !== 1) {
        throw new AuthorityContextError('AUTHORITY_CONTEXT_CHANGE_AMBIGUOUS', expectedChangeId);
      }
      const match = matching[0]!;
      if (match.nodeType !== 'DIRECTORY') {
        throw new AuthorityContextError('AUTHORITY_CONTEXT_LAYOUT_MISMATCH', match.name);
      }
      const directoryName = match.name;
      const changeRoot = join(changesPath, directoryName);
      return withStableRootAnchor(changeRoot, async (_changeRootAnchor, sourceRootIdentity) => {
        const rootInventory = await observeStableDirectory({
          containedRoot: projectAuthorityRoot,
          relativePath: `changes/${directoryName}`,
          observedIo: observedIoRecorder,
        });
        const inventoryDiscovery = createAuthorityInventoryDiscovery(changeRoot, observedIoRecorder);
        try {
          const request = await discoverChangeBuildRequest(
            expectedChangeId,
            changeRoot,
            rootInventory.typedEntries,
            inventoryDiscovery,
          );
          return await buildAuthenticatedBaseContext(
            request,
            projectAuthorityRoot,
            observedIoRecorder,
            sourceRootIdentity,
            directoryName,
            inventoryDiscovery,
          );
        } catch (failure) {
          await closeAuthorityInventoryDiscovery(inventoryDiscovery);
          throw failure;
        }
      });
    })
  ));
}

// @internal Flow 在创建 Change lock owner 前只解析真实 canonical directory；此入口只读
// changes inventory，不读取 Change source，也不接受 caller directoryName。
export async function discoverCanonicalChangeDirectory(
  rawRepoRoot: string,
  rawChangeId: string,
): Promise<string> {
  let repoRoot: string;
  let expectedChangeId: ChangeId;
  try {
    repoRoot = normalizedAbsoluteRealPathSchema.parse(rawRepoRoot);
    expectedChangeId = parseChangeId(rawChangeId);
  } catch (cause) {
    return invalidBuild('repository Change identity', cause);
  }
  const projectAuthorityRoot = join(repoRoot, '.omnai');
  const recorder = createObservedIoRecorder();
  return withStableRootAnchor(projectAuthorityRoot, async () => {
    const changes = await observeStableDirectory({
      containedRoot: projectAuthorityRoot,
      relativePath: 'changes',
      observedIo: recorder,
    });
    const prefix = `${expectedChangeId}-`;
    let matching: typeof changes.typedEntries[number] | undefined;
    for (let index = 0; index < changes.typedEntries.length; index += 1) {
      const entry = changes.typedEntries[index]!;
      if (!reflectApplyIntrinsic(stringStartsWithIntrinsic, entry.name, [prefix])) continue;
      if (matching !== undefined) {
        throw new AuthorityContextError('AUTHORITY_CONTEXT_CHANGE_AMBIGUOUS', expectedChangeId);
      }
      matching = entry;
    }
    if (matching === undefined) {
      throw new AuthorityContextError('AUTHORITY_CONTEXT_CHANGE_MISSING', expectedChangeId);
    }
    if (matching.nodeType !== 'DIRECTORY') {
      throw new AuthorityContextError('AUTHORITY_CONTEXT_LAYOUT_MISMATCH', matching.name);
    }
    return matching.name;
  });
}

async function buildAuthenticatedBaseContext(
  request: AuthenticatedBuildRequest,
  workflowLockRoot: string,
  observedIoRecorder: ObservedIoRecorderV1,
  sourceRootIdentity: StableRootIdentityV1,
  expectedDirectoryName?: string,
  inventoryDiscovery?: AuthorityInventoryDiscoveryV1,
): Promise<BaseContextHandleV1> {
  const authorityCatalog = await requireVerifiedAuthorityCatalog();
  const authorityCatalogHash = hashStrictObject(authorityCatalog);

  const workflowLockCapture = await captureStableBytes({
    containedRoot: workflowLockRoot,
    relativePath: WORKFLOW_LOCK_RELATIVE_PATH,
    observedIo: observedIoRecorder,
  });
  const workflowLock = freezeJsonTree(parseYamlCapture(workflowLockCapture, workflowLockSchema));
  requireWorkflowBinding(workflowLock, authorityCatalogHash);

  const inventoryRequest = {
    containedRoot: request.containedRoot,
    observedIo: observedIoRecorder,
    logicalTargets: request.logicalTargets,
    archiveTargets: request.archiveTargets,
    knownAuxiliaryTargets: request.knownAuxiliaryTargets,
  };
  const inventoryBase = inventoryDiscovery === undefined
    ? await buildAuthorityInventoryBase(inventoryRequest)
    : await buildAuthorityInventoryBaseFromDiscovery(inventoryRequest, inventoryDiscovery);
  const parsedBase = parseBaseRecords(request.expectedChangeId, inventoryBase);
  if (expectedDirectoryName !== undefined
    && expectedDirectoryName !== `${parsedBase.metadata.id}-${parsedBase.metadata.slug}`) {
    throw new AuthorityContextError('AUTHORITY_CONTEXT_CHANGE_DIRECTORY_MISMATCH', expectedDirectoryName);
  }

  // 当前没有 final receipt/owner parser；只允许空认证引用并以 Task2 capability 完成 inventory。
  const inventory = await finalizeAuthorityInventory({
    base: inventoryBase,
    verifiedReceiptReferences: [],
  });
  const indexes = buildAuthorityIndexes({
    expectedChangeId: request.expectedChangeId,
    metadata: parsedBase.metadata,
    taskFile: parsedBase.taskFile,
    flow: parsedBase.flow,
    decisions: parsedBase.decisions,
    evidence: parsedBase.evidence,
    runs: parsedBase.runs,
    progress: parsedBase.progress,
    archiveEntries: inventory.archiveEntries,
    transactionEntries: inventory.logicalEntries,
  });
  const machineProjection = buildMachineAuthorityProjection(workflowLockCapture, inventory);
  const baseContextDigest = hashStrictObject(objectFreezeIntrinsic({
    schemaVersion: 1,
    kind: 'CHANGE_AUTHORITY_BASE_CONTEXT_V1',
    expectedChangeId: request.expectedChangeId,
    revisionId: indexes.metadata.activeRevision,
    authorityCatalogHash,
    workflowLockRawBytesHash: workflowLockCapture.rawBytesHash,
    machineProjectionHash: machineProjection.projectionHash,
  }));

  return createAuthenticatedBaseContextHandle(objectFreezeIntrinsic({
    containedRoot: request.containedRoot,
    sourceRootIdentity,
    observedIoRecorder,
    expectedChangeId: request.expectedChangeId,
    workflowLock,
    authorityCatalog,
    authorityCatalogHash,
    baseContextDigest,
    indexes,
    machineProjection,
  }));
}

async function discoverChangeBuildRequest(
  expectedChangeId: ChangeId,
  containedRoot: string,
  rootEntries: readonly Readonly<{ name: string; nodeType: string }>[],
  inventoryDiscovery: AuthorityInventoryDiscoveryV1,
): Promise<AuthenticatedBuildRequest> {
  const logicalTargets: AuthorityLogicalTargetV1[] = [];
  const requiredMetadata = findLayoutEntry(rootEntries, 'change.yaml');
  if (requiredMetadata === undefined) {
    throw new AuthorityContextError('AUTHORITY_CONTEXT_REQUIRED_TARGET_MISSING', 'change.yaml');
  }
  if (requiredMetadata.nodeType !== 'FILE') {
    throw new AuthorityContextError('AUTHORITY_CONTEXT_LAYOUT_MISMATCH', 'change.yaml');
  }
  arrayPush(logicalTargets, objectFreezeIntrinsic({
    key: objectFreezeIntrinsic({ kind: 'METADATA' as const }),
    relativePath: 'change.yaml',
    nodeType: 'FILE' as const,
  }));

  for (const optional of [
    { name: 'tasks.yaml', kind: 'TASKS' as const },
    { name: 'flow.yaml', kind: 'FLOW' as const },
    { name: 'progress.jsonl', kind: 'PROGRESS' as const },
  ]) {
    const entry = findLayoutEntry(rootEntries, optional.name);
    if (entry === undefined) continue;
    if (entry.nodeType !== 'FILE') {
      throw new AuthorityContextError('AUTHORITY_CONTEXT_LAYOUT_MISMATCH', optional.name);
    }
    arrayPush(logicalTargets, objectFreezeIntrinsic({
      key: objectFreezeIntrinsic({ kind: optional.kind }),
      relativePath: optional.name,
      nodeType: 'FILE' as const,
    }));
  }

  const decisions = await discoverFlatCollection(
    rootEntries,
    inventoryDiscovery,
    'decisions',
    /^DEC-(?!0000$)\d{4}\.yaml$/,
  );
  for (let index = 0; index < decisions.length; index += 1) {
    const file = decisions[index]!;
    arrayPush(logicalTargets, objectFreezeIntrinsic({
      key: objectFreezeIntrinsic({
        kind: 'DECISION' as const,
        decisionId: parseDecisionId(reflectApplyIntrinsic(
          stringSliceIntrinsic,
          file,
          [0, -'.yaml'.length],
        ) as string),
      }),
      relativePath: `decisions/${file}`,
      nodeType: 'FILE' as const,
    }));
  }

  const evidence = await discoverFlatCollection(
    rootEntries,
    inventoryDiscovery,
    'evidence',
    /^EVD-(?!000000$)\d{6}\.yaml$/,
  );
  for (let index = 0; index < evidence.length; index += 1) {
    const file = evidence[index]!;
    arrayPush(logicalTargets, objectFreezeIntrinsic({
      key: objectFreezeIntrinsic({
        kind: 'EVIDENCE' as const,
        evidenceId: parseEvidenceId(reflectApplyIntrinsic(
          stringSliceIntrinsic,
          file,
          [0, -'.yaml'.length],
        ) as string),
      }),
      relativePath: `evidence/${file}`,
      nodeType: 'FILE' as const,
    }));
  }

  const runs = await discoverFlatCollection(
    rootEntries,
    inventoryDiscovery,
    'runs',
    /^RUN-(?!000000$)\d{6}\.yaml$/,
  );
  for (let index = 0; index < runs.length; index += 1) {
    const file = runs[index]!;
    arrayPush(logicalTargets, objectFreezeIntrinsic({
      key: objectFreezeIntrinsic({
        kind: 'RUN' as const,
        runId: parseRunId(reflectApplyIntrinsic(
          stringSliceIntrinsic,
          file,
          [0, -'.yaml'.length],
        ) as string),
      }),
      relativePath: `runs/${file}`,
      nodeType: 'FILE' as const,
    }));
  }
  await observeOptionalReservedCollection(
    rootEntries, inventoryDiscovery, 'revisions',
  );
  return objectFreezeIntrinsic({
    expectedChangeId,
    containedRoot,
    logicalTargets: objectFreezeIntrinsic(logicalTargets),
    archiveTargets: objectFreezeIntrinsic([]),
    knownAuxiliaryTargets: objectFreezeIntrinsic([]),
  });
}

async function discoverFlatCollection(
  rootEntries: readonly Readonly<{ name: string; nodeType: string }>[],
  inventoryDiscovery: AuthorityInventoryDiscoveryV1,
  name: string,
  filePattern: RegExp,
): Promise<readonly string[]> {
  const rootEntry = findLayoutEntry(rootEntries, name);
  if (rootEntry === undefined) return objectFreezeIntrinsic([]);
  if (rootEntry.nodeType !== 'DIRECTORY') {
    throw new AuthorityContextError('AUTHORITY_CONTEXT_LAYOUT_MISMATCH', name);
  }
  const directory = await discoverAuthorityInventoryDirectory(inventoryDiscovery, name, true);
  const files: string[] = [];
  for (let index = 0; index < directory.typedEntries.length; index += 1) {
    const entry = directory.typedEntries[index]!;
    if (entry.nodeType !== 'FILE'
      || !reflectApplyIntrinsic(regexpTestIntrinsic, filePattern, [entry.name])) {
      throw new AuthorityContextError(
        'AUTHORITY_CONTEXT_RECOGNIZED_TARGET_INVALID', `${name}/${entry.name}`,
      );
    }
    arrayPush(files, entry.name);
  }
  return objectFreezeIntrinsic(files);
}

async function observeOptionalReservedCollection(
  rootEntries: readonly Readonly<{ name: string; nodeType: string }>[],
  inventoryDiscovery: AuthorityInventoryDiscoveryV1,
  name: string,
): Promise<void> {
  const entry = findLayoutEntry(rootEntries, name);
  if (entry === undefined) return;
  if (entry.nodeType !== 'DIRECTORY') {
    throw new AuthorityContextError('AUTHORITY_CONTEXT_LAYOUT_MISMATCH', name);
  }
  await discoverAuthorityInventoryDirectory(inventoryDiscovery, name);
}

function findLayoutEntry(
  entries: readonly Readonly<{ name: string; nodeType: string }>[],
  name: string,
): Readonly<{ name: string; nodeType: string }> | undefined {
  for (let index = 0; index < entries.length; index += 1) {
    if (entries[index]!.name === name) return entries[index];
  }
  return undefined;
}

/** @internal 由 context phase consumer 调用；真实 handle 只能由本模块完整 builder 流程登记。 */
function consumeAuthenticatedBaseContextHandle(
  base: BaseContextHandleV1,
): MutableBaseState {
  if (base === null || typeof base !== 'object' || isProxy(base)) {
    throw new AuthorityContextError('AUTHORITY_CONTEXT_BASE_INVALID', 'base');
  }
  const state = weakMapGet(baseStates, base);
  if (state === undefined) throw new AuthorityContextError('AUTHORITY_CONTEXT_BASE_INVALID', 'base');
  if (state.consumed) throw new AuthorityContextError('AUTHORITY_CONTEXT_BASE_CONSUMED', 'base');
  // 异步 current capture 前先消费；即使 capture 抛错，也不允许同一 base retry。
  state.consumed = true;
  return state;
}

function createAuthenticatedBaseContextHandle(
  authenticated: AuthenticatedBaseContextStateV1,
): BaseContextHandleV1 {
  const handle = objectFreezeIntrinsic({ phase: 'BASE_AUTHENTICATED' as const });
  weakMapSet(baseStates, handle, {
    authenticated,
    phase: 'BASE_AUTHENTICATED',
    consumed: false,
  });
  return handle;
}

export async function sealForInspection(
  base: BaseContextHandleV1,
): Promise<ChangeAuthorityContext> {
  const state = consumeAuthenticatedBaseContextHandle(base);
  return withBoundStableRootIdentity(state.authenticated.sourceRootIdentity, async () => {
    state.phase = 'SEALED';
    return freezeSealedContext(state.authenticated);
  });
}

export async function sealForNewMutation(
  base: BaseContextHandleV1,
  captureCurrentSource: (session: SourceCaptureSession) => Promise<void>,
): Promise<ChangeAuthorityContext> {
  const state = consumeAuthenticatedBaseContextHandle(base);
  if (typeof captureCurrentSource !== 'function') {
    throw new AuthorityContextError('AUTHORITY_CONTEXT_CAPTURE_INVALID', 'captureCurrentSource');
  }
  state.phase = 'REQUEST_CAPTURED';
  return withBoundStableRootIdentity(
    state.authenticated.sourceRootIdentity,
    async (sourceRootAnchor) => sealNewMutationAtBoundRoot(
      state,
      captureCurrentSource,
      sourceRootAnchor,
    ),
  );
}

async function sealNewMutationAtBoundRoot(
  state: MutableBaseState,
  captureCurrentSource: (session: SourceCaptureSession) => Promise<void>,
  sourceRootAnchor: StableRootAnchorV1,
): Promise<ChangeAuthorityContext> {
  const session = createSourceCaptureSession(state.authenticated, sourceRootAnchor);
  let callbackFailed = false;
  let callbackFailure: unknown;
  try {
    await captureCurrentSource(session);
  } catch (failure) {
    callbackFailed = true;
    callbackFailure = failure;
  }
  const sessionState = requireSourceCaptureSessionState(session);
  try {
    // callback 若遗漏 await，仍先等待已登记 current capture，确保 observedIo seal 不会漏读。
    while (setSize(sessionState.pending) > 0) {
      const pending: Promise<unknown>[] = [];
      setForEach(sessionState.pending, (operationPromise) => arrayPush(pending, operationPromise));
      for (let index = 0; index < pending.length; index += 1) {
        try {
          await pending[index];
        } catch (failure) {
          recordSourceCaptureFailure(sessionState, failure);
        }
      }
    }
  } finally {
    sessionState.active = false;
  }
  if (callbackFailed) throw callbackFailure;
  // registered capture 的失败是整个 REQUEST_CAPTURED phase 的失败；调用方丢弃或 catch
  // 单个 Promise 都不能把未完成的 source authority 封成 SEALED context。
  if (sessionState.hasOperationFailure) throw sessionState.operationFailure;
  state.phase = 'SEALED';
  return freezeSealedContext(state.authenticated);
}

/** @internal resolver 的唯一 session-state 入口；它同时登记异步 capture 供 seal 等待。 */
export function runAuthenticatedSourceCapture<Output>(
  session: SourceCaptureSession,
  operation: (access: AuthenticatedSourceCaptureAccessV1) => Promise<Output>,
): Promise<Output> {
  const state = requireSourceCaptureSessionState(session);
  let operationPromise: Promise<Output>;
  try {
    operationPromise = operation(objectFreezeIntrinsic({
      authenticated: state.authenticated,
      sourceRootAnchor: state.sourceRootAnchor,
      claimLogicalIdentity(logicalIdentity: string): boolean {
        if (setHas(state.logicalIdentities, logicalIdentity)) return false;
        setAdd(state.logicalIdentities, logicalIdentity);
        return true;
      },
    }));
  } catch (failure) {
    operationPromise = PromiseIntrinsic.reject(failure);
  }
  setAdd(state.pending, operationPromise);
  void reflectApplyIntrinsic(promiseThenIntrinsic, operationPromise, [
    () => setDelete(state.pending, operationPromise),
    (failure: unknown) => {
      recordSourceCaptureFailure(state, failure);
      setDelete(state.pending, operationPromise);
    },
  ]);
  return operationPromise;
}

function createSourceCaptureSession(
  authenticated: AuthenticatedBaseContextStateV1,
  sourceRootAnchor: StableRootAnchorV1,
): SourceCaptureSession {
  const session = objectFreezeIntrinsic({ phase: 'REQUEST_CAPTURED' as const }) as SourceCaptureSession;
  weakMapSet(sourceCaptureSessionStates, session, {
    authenticated,
    sourceRootAnchor,
    logicalIdentities: new SetIntrinsic<string>(),
    pending: new SetIntrinsic<Promise<unknown>>(),
    hasOperationFailure: false,
    operationFailure: undefined,
    active: true,
  });
  return session;
}

function recordSourceCaptureFailure(
  state: MutableSourceCaptureSessionState,
  failure: unknown,
): void {
  if (state.hasOperationFailure) return;
  state.hasOperationFailure = true;
  state.operationFailure = failure;
}

function requireSourceCaptureSessionState(
  session: SourceCaptureSession,
): MutableSourceCaptureSessionState {
  if (session === null || typeof session !== 'object' || isProxy(session)) {
    throw new AuthorityContextError('AUTHORITY_SOURCE_SESSION_INVALID', 'session');
  }
  const state = weakMapGet(sourceCaptureSessionStates, session);
  if (state === undefined || !state.active) {
    throw new AuthorityContextError('AUTHORITY_SOURCE_SESSION_INVALID', 'session');
  }
  return state;
}

function setAdd<Value>(set: Set<Value>, value: Value): void {
  reflectApplyIntrinsic(setAddIntrinsic, set, [value]);
}

function setDelete<Value>(set: Set<Value>, value: Value): void {
  reflectApplyIntrinsic(setDeleteIntrinsic, set, [value]);
}

function setHas<Value>(set: Set<Value>, value: Value): boolean {
  return reflectApplyIntrinsic(setHasIntrinsic, set, [value]) as boolean;
}

function setForEach<Value>(set: Set<Value>, callback: (value: Value) => void): void {
  reflectApplyIntrinsic(setForEachIntrinsic, set, [callback]);
}

function setSize<Value>(set: Set<Value>): number {
  return reflectApplyIntrinsic(setSizeIntrinsic, set, []) as number;
}

/** @internal terminal verifier 只能读取由本模块登记的真实 SEALED context。 */
export function requireSealedContextMachineState(
  context: ChangeAuthorityContext,
): SealedContextMachineStateV1 {
  if (context === null || typeof context !== 'object' || isProxy(context)) {
    throw new AuthorityContextError('AUTHORITY_CONTEXT_INVALID', 'context');
  }
  const state = weakMapGet(sealedStates, context);
  if (state === undefined) throw new AuthorityContextError('AUTHORITY_CONTEXT_INVALID', 'context');
  return state;
}

function freezeSealedContext(
  authenticated: AuthenticatedBaseContextStateV1,
): ChangeAuthorityContext {
  const indexes = authenticated.indexes;
  const observedIo = authenticated.observedIoRecorder.snapshot();
  let context: ChangeAuthorityContext;
  context = objectFreezeIntrinsic({
    phase: 'SEALED' as const,
    changeId: authenticated.expectedChangeId,
    revisionId: indexes.metadata.activeRevision,
    workflowLock: authenticated.workflowLock,
    authorityCatalog: authenticated.authorityCatalog,
    authorityCatalogHash: authenticated.authorityCatalogHash,
    baseContextDigest: authenticated.baseContextDigest,
    metadata: indexes.metadata,
    taskFile: indexes.taskFile,
    flow: indexes.flow,
    decisions: indexes.decisions,
    evidence: indexes.evidence,
    runs: indexes.runs,
    progress: indexes.progress,
    machineProjection: authenticated.machineProjection,
    observedIo,
    requireDecision(id: DecisionId): DecisionRecordV2 {
      const found = indexes.decisionsById.get(id);
      if (found === undefined) missing('Decision', id);
      return found;
    },
    requireEvidence(id: EvidenceId): EvidenceRecord {
      const found = indexes.evidenceById.get(id);
      if (found === undefined) missing('Evidence', id);
      return found;
    },
    requireTask(id: TaskId): Task {
      const found = indexes.tasksById.get(id);
      if (found === undefined) missing('Task', id);
      return found;
    },
    requireRun(id: RunId): StageRunManifestV3 {
      const found = indexes.runsById.get(id);
      if (found === undefined) missing('Run', id);
      return found;
    },
    requireArchive(revisionId: RevisionId, logicalKey: AuthorityLogicalKeyV1) {
      const found = indexes.archiveCache.get(archiveCacheKey(revisionId, logicalKey));
      if (found === undefined) missing('Archive', `${revisionId}`);
      return found;
    },
    requireTransactionCapture(transactionId: string) {
      const found = indexes.transactionPhysicalCaptures.get(transactionId);
      if (found === undefined) missing('Transaction', transactionId);
      return found;
    },
    eventsForKind(kind: ProgressEventV1['event']): readonly ProgressEventV1[] {
      return indexes.progressByEventKind.get(kind) ?? objectFreezeIntrinsic([]);
    },
    eventsForOperationRequest(operationRequestId: string): readonly ProgressEventV1[] {
      return indexes.progressByOperationRequestId.get(operationRequestId) ?? objectFreezeIntrinsic([]);
    },
  });
  weakMapSet(sealedStates, context, objectFreezeIntrinsic({
    containedRoot: authenticated.containedRoot,
    machineProjection: authenticated.machineProjection,
  }));
  return context;
}

function missing(kind: string, identity: string): never {
  throw new AuthorityContextError('AUTHORITY_CONTEXT_RECORD_MISSING', `${kind}:${identity}`);
}

type AuthenticatedBuildRequest = Readonly<{
  expectedChangeId: ChangeId;
  containedRoot: string;
  logicalTargets: BuildBaseContextRequestV1['logicalTargets'];
  archiveTargets: BuildBaseContextRequestV1['archiveTargets'];
  knownAuxiliaryTargets: BuildBaseContextRequestV1['knownAuxiliaryTargets'];
}>;

type ParsedBaseRecords = Readonly<{
  metadata: ChangeMetadata;
  taskFile: TaskFile | null;
  flow: FlowPlanV2 | null;
  decisions: readonly DecisionRecordV2[];
  evidence: readonly EvidenceRecord[];
  runs: readonly StageRunManifestV3[];
  progress: readonly ProgressEventV1[];
}>;

function authenticateBuildRequest(value: unknown): AuthenticatedBuildRequest {
  const object = readExactObject(value, [
    'expectedChangeId',
    'containedRoot',
    'logicalTargets',
    'archiveTargets',
    'knownAuxiliaryTargets',
  ]);
  let expectedChangeId: ChangeId;
  try {
    expectedChangeId = parseChangeId(object.expectedChangeId);
  } catch (cause) {
    return invalidBuild('expectedChangeId', cause);
  }
  let containedRoot: string;
  try {
    containedRoot = normalizedAbsoluteRealPathSchema.parse(object.containedRoot);
  } catch (cause) {
    return invalidBuild('containedRoot', cause);
  }
  const logicalTargets = cloneStrictDataArray(object.logicalTargets);
  const archiveTargets = cloneStrictDataArray(object.archiveTargets);
  const knownAuxiliaryTargets = cloneStrictDataArray(object.knownAuxiliaryTargets);
  rejectWorkflowLockCollision(logicalTargets);
  rejectWorkflowLockCollision(archiveTargets);
  rejectWorkflowLockCollision(knownAuxiliaryTargets);
  return objectFreezeIntrinsic({
    expectedChangeId,
    containedRoot,
    logicalTargets: logicalTargets as BuildBaseContextRequestV1['logicalTargets'],
    archiveTargets: archiveTargets as BuildBaseContextRequestV1['archiveTargets'],
    knownAuxiliaryTargets: knownAuxiliaryTargets as BuildBaseContextRequestV1['knownAuxiliaryTargets'],
  });
}

function rejectWorkflowLockCollision(targets: readonly unknown[]): void {
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const relativePath = readDataProperty(target, 'relativePath');
    if (relativePath === WORKFLOW_LOCK_RELATIVE_PATH) {
      return invalidBuild('workflow lock path collision');
    }
  }
}

function parseBaseRecords(
  expectedChangeId: ChangeId,
  base: AuthorityInventoryBaseV1,
): ParsedBaseRecords {
  let metadata: ChangeMetadata | undefined;
  let taskFile: TaskFile | null = null;
  let flow: FlowPlanV2 | null = null;
  const decisions: DecisionRecordV2[] = [];
  const evidence: EvidenceRecord[] = [];
  const runs: StageRunManifestV3[] = [];
  let progress: readonly ProgressEventV1[] = objectFreezeIntrinsic([]);

  for (let index = 0; index < base.logicalEntries.length; index += 1) {
    const entry = base.logicalEntries[index]!;
    switch (entry.key.kind) {
      case 'METADATA':
        metadata = parseRequiredFile(entry, changeMetadataSchema, 'metadata');
        break;
      case 'TASKS':
        taskFile = parseRequiredFile(entry, taskFileSchema, 'tasks');
        break;
      case 'FLOW':
        flow = parseRequiredFile(entry, flowPlanSchema, 'flow');
        break;
      case 'DECISION': {
        const decision = parseRequiredFile(entry, decisionRecordSchema, 'Decision');
        if (decision.id !== entry.key.decisionId) invalidRecord('Decision key binding');
        arrayPush(decisions, decision);
        break;
      }
      case 'EVIDENCE': {
        const record = parseRequiredFile(entry, evidenceRecordSchema, 'Evidence');
        if (record.id !== entry.key.evidenceId) invalidRecord('Evidence key binding');
        arrayPush(evidence, record);
        break;
      }
      case 'RUN': {
        const run = parseRequiredFile(entry, stageRunManifestSchema, 'Run');
        if (run.runId !== entry.key.runId) invalidRecord('Run key binding');
        arrayPush(runs, run);
        break;
      }
      case 'PROGRESS':
        progress = parseProgress(entry);
        break;
      case 'TRANSACTION':
        // 尚无 final owner Schema；只在 indexes 中保留绑定 inventory hash 的物理 capture。
        break;
    }
  }
  if (metadata === undefined) invalidRecord('metadata missing');
  if (metadata.id !== expectedChangeId) invalidRecord('metadata Change binding');
  return objectFreezeIntrinsic({
    metadata,
    taskFile,
    flow,
    decisions: objectFreezeIntrinsic(decisions),
    evidence: objectFreezeIntrinsic(evidence),
    runs: objectFreezeIntrinsic(runs),
    progress,
  });
}

function parseRequiredFile<Output>(
  entry: AuthorityLogicalInventoryEntryV1,
  schema: { parse(value: unknown): Output },
  label: string,
): Output {
  if (entry.nodeType !== 'FILE') return invalidRecord(`${label} node type`);
  return freezeJsonTree(parseYamlCapture(entry.capture, schema));
}

function parseYamlCapture<Output>(
  capture: StableByteCaptureV1,
  schema: { parse(value: unknown): Output },
): Output {
  let text: string;
  try {
    const decoder = new TextDecoderIntrinsic('utf-8', { fatal: true });
    text = reflectApplyIntrinsic(textDecoderDecodeIntrinsic, decoder, [capture.copyBytes()]) as string;
  } catch (cause) {
    return invalidRecord('UTF-8', cause);
  }
  try {
    return schema.parse(reflectApplyIntrinsic(yamlParseIntrinsic, YAML, [text]));
  } catch (cause) {
    return invalidRecord(capture.observation.relativePath, cause);
  }
}

function parseProgress(entry: AuthorityLogicalInventoryEntryV1): readonly ProgressEventV1[] {
  if (entry.nodeType !== 'FILE') return invalidRecord('progress node type');
  let text: string;
  try {
    const decoder = new TextDecoderIntrinsic('utf-8', { fatal: true });
    text = reflectApplyIntrinsic(textDecoderDecodeIntrinsic, decoder, [entry.capture.copyBytes()]) as string;
  } catch (cause) {
    return invalidRecord('progress UTF-8', cause);
  }
  const events: ProgressEventV1[] = [];
  const lines = reflectApplyIntrinsic(stringSplitIntrinsic, text, ['\n']) as string[];
  for (let index = 0; index < lines.length; index += 1) {
    const line = reflectApplyIntrinsic(stringTrimIntrinsic, lines[index]!, []) as string;
    if (line.length === 0) continue;
    try {
      arrayPush(events, freezeJsonTree(progressEventSchema.parse(jsonParseIntrinsic(line))));
    } catch (cause) {
      return invalidRecord(`progress line ${index + 1}`, cause);
    }
  }
  return objectFreezeIntrinsic(events);
}

function requireWorkflowBinding(
  workflowLock: StrictWorkflowLockV2,
  authorityCatalogHash: string,
): void {
  if (workflowLock.authorityCatalogHash !== authorityCatalogHash) {
    throw new AuthorityContextError('AUTHORITY_CONTEXT_WORKFLOW_MISMATCH', 'authorityCatalogHash');
  }
}

function freezeJsonTree<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (arrayIsArrayIntrinsic(value)) {
    for (let index = 0; index < value.length; index += 1) freezeJsonTree(value[index]);
  } else {
    const record = value as Record<string, unknown>;
    const keys = reflectApplyIntrinsic(objectKeysIntrinsic, Object, [record]) as string[];
    for (let index = 0; index < keys.length; index += 1) freezeJsonTree(record[keys[index]!]);
  }
  return objectFreezeIntrinsic(value);
}

function cloneStrictDataArray(value: unknown): readonly unknown[] {
  if (value !== null && typeof value === 'object' && isProxy(value)) invalidBuild('array proxy');
  if (!arrayIsArrayIntrinsic(value) || Object.getPrototypeOf(value) !== Array.prototype) invalidBuild('array');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !containsPropertyKey(keys, 'length')) invalidBuild('array shape');
  const copied: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      invalidBuild(`array[${index}]`);
    }
    arrayPush(copied, cloneStrictDataValue(descriptor.value));
  }
  return objectFreezeIntrinsic(copied);
}

function cloneStrictDataValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value;
  if (arrayIsArrayIntrinsic(value)) return cloneStrictDataArray(value);
  if (typeof value !== 'object' || isProxy(value)) return invalidBuild('strict data');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalidBuild('strict data prototype');
  const clone: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const keys = Reflect.ownKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    if (typeof key !== 'string') return invalidBuild('strict data key');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      return invalidBuild(`strict data ${key}`);
    }
    Object.defineProperty(clone, key, {
      configurable: false,
      enumerable: true,
      value: cloneStrictDataValue(descriptor.value),
      writable: false,
    });
  }
  return objectFreezeIntrinsic(clone);
}

function readExactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || isProxy(value)) return invalidBuild('object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalidBuild('prototype');
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || !sameStringKeySet(ownKeys, keys)) {
    return invalidBuild('own keys');
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      return invalidBuild(key);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function readDataProperty(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || isProxy(value)) return invalidBuild(key);
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
    return invalidBuild(key);
  }
  return descriptor.value;
}

function invalidBuild(detail: string, cause?: unknown): never {
  throw new AuthorityContextError('AUTHORITY_CONTEXT_REQUEST_INVALID', detail, cause);
}

function invalidRecord(detail: string, cause?: unknown): never {
  throw new AuthorityContextError('AUTHORITY_CONTEXT_RECORD_INVALID', detail, cause);
}

function arrayPush<Value>(array: Value[], value: Value): void {
  reflectApplyIntrinsic(arrayPushIntrinsic, array, [value]);
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

function containsPropertyKey(values: readonly PropertyKey[], expected: PropertyKey): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === expected) return true;
  }
  return false;
}

function containsString(values: readonly string[], expected: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === expected) return true;
  }
  return false;
}

function sameStringKeySet(actual: readonly PropertyKey[], expected: readonly string[]): boolean {
  for (let index = 0; index < actual.length; index += 1) {
    const key = actual[index];
    if (typeof key !== 'string' || !containsString(expected, key)) return false;
  }
  return true;
}
