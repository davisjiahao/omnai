import { createHash } from 'node:crypto';
import { relative, sep } from 'node:path';
import { isProxy } from 'node:util/types';
import {
  type SourceRef,
} from '../../domain/change.js';
import {
  SCENARIO_IDS,
  normalizedAbsoluteRealPathSchema,
  sourceRefLogicalKey,
} from '../../domain/public.js';
import {
  changeIdSchema,
  decisionIdSchema,
  evidenceIdSchema,
  revisionIdSchema,
  taskIdSchema,
  parseSha256,
  type Sha256,
} from '../../domain/scalars.js';
import { canonicalizeStrictJsonBytes } from '../../domain/strict-json-internal.js';
import { runAuthenticatedSourceCapture } from '../authority/context-builder.js';
import {
  assertStableRootAnchorIdentity,
  captureStableBytesAtRoot,
  withStableRootAnchor,
  type StableRootAnchorV1,
} from '../authority/stable-bytes.js';
import { acquireGitProvider, runGit } from '../git-provider/provider.js';
import { requireSafeArtifactPath, requireSafeRepositoryCodePath } from './path-safety.js';
import {
  SourceResolutionError,
  type HistoricalInputObservation,
  type ResolvedCurrentSource,
  type SourceCaptureSession,
  type SourceLocator,
} from './types.js';

const objectFreezeIntrinsic = Object.freeze;
const Uint8ArrayIntrinsic = Uint8Array;
// callback 运行在同一 realm，冻结 catalog/locator 并不能保护 prototype 方法。
// 因此所有参与策略选择与摘要的 intrinsic 都在模块初始化阶段绑定，再经绑定的 Reflect.apply 调用。
const reflectApplyIntrinsic = Reflect.apply;
const arrayFindIntrinsic = Array.prototype.find;
const arrayIncludesIntrinsic = Array.prototype.includes;
const stringEndsWithIntrinsic = String.prototype.endsWith;
const stringIncludesIntrinsic = String.prototype.includes;
const stringSliceIntrinsic = String.prototype.slice;
const stringStartsWithIntrinsic = String.prototype.startsWith;
const hashUpdateIntrinsic = createHash('sha256').update;
const hashDigestIntrinsic = createHash('sha256').digest;

export async function resolveCurrentSource(
  session: SourceCaptureSession,
  rawLocator: unknown,
): Promise<ResolvedCurrentSource> {
  const kind = peekLocatorKind(rawLocator);
  if (kind === 'code') {
    // provider acquire 必须领先 session 私有 root、path validation 与任何 source I/O。
    const provider = acquireGitProvider();
    return runAuthenticatedSourceCapture(session, async (access) => (
      resolveAuthenticated(access, authenticateLocator(rawLocator), provider)
    ));
  }
  return runAuthenticatedSourceCapture(session, async (access) => (
    resolveAuthenticated(access, authenticateLocator(rawLocator))
  ));
}

// @internal Flow/public adapters 复用 resolver 的唯一 locator parser；这不是持久 schema，
// 也不授予 source capture 权限，真实读取仍必须持有 session capability。
export function parseSourceLocator(rawLocator: unknown): SourceLocator {
  return authenticateLocator(rawLocator);
}

type SourceCaptureAccess = Parameters<Parameters<typeof runAuthenticatedSourceCapture>[1]>[0];
type GitBinding = ReturnType<typeof acquireGitProvider>;

async function resolveAuthenticated(
  access: SourceCaptureAccess,
  locator: SourceLocator,
  provider?: GitBinding,
): Promise<ResolvedCurrentSource> {
  const authenticated = access.authenticated;
  if (locator.changeId !== authenticated.expectedChangeId
    || locator.revisionId !== authenticated.indexes.metadata.activeRevision) {
    throw new SourceResolutionError(
      'SOURCE_CONTEXT_MISMATCH',
      `${locator.changeId}/${locator.revisionId}`,
    );
  }
  const logicalIdentity = locatorLogicalIdentity(locator);
  if (!access.claimLogicalIdentity(logicalIdentity)) {
    throw new SourceResolutionError('SOURCE_LOGICAL_IDENTITY_DUPLICATE', logicalIdentity);
  }

  switch (locator.kind) {
    case 'artifact': {
      const capture = await captureStableBytesAtRoot(access.sourceRootAnchor, {
        relativePath: locator.path,
        observedIo: authenticated.observedIoRecorder,
      });
      return freezeResolved(
        { kind: 'artifact', path: locator.path, contentHash: capture.rawBytesHash },
        capture.copyBytes(),
        objectFreezeIntrinsic({
          schemaVersion: 1,
          kind: 'artifact',
          changeId: locator.changeId,
          revisionId: locator.revisionId,
          logicalIdentity,
          byteLength: capture.byteLength,
          observedFile: capture.observation,
        }),
      );
    }
    case 'policy': {
      const profile = reflectApplyIntrinsic(
        arrayFindIntrinsic,
        authenticated.authorityCatalog.scenarioProfiles,
        [({ id }: { id: string }) => id === locator.scenarioId],
      ) as (typeof authenticated.authorityCatalog.scenarioProfiles)[number] | undefined;
      // 即使 collection intrinsic 的返回契约被未来重构，也必须重新绑定 locator 身份。
      if (profile === undefined || profile.id !== locator.scenarioId) {
        return missing('policy', locator.scenarioId);
      }
      return freezeStructured(
        { kind: 'policy', scenarioId: locator.scenarioId },
        profile,
        locator,
        logicalIdentity,
      );
    }
    case 'evidence': {
      const record = authenticated.indexes.evidenceById.get(locator.evidenceId);
      if (record === undefined) return missing('evidence', locator.evidenceId);
      return freezeStructured(
        { kind: 'evidence', evidenceId: locator.evidenceId },
        record,
        locator,
        logicalIdentity,
      );
    }
    case 'decision': {
      const record = authenticated.indexes.decisionsById.get(locator.decisionId);
      if (record === undefined) return missing('decision', locator.decisionId);
      return freezeStructured(
        { kind: 'decision', decisionId: locator.decisionId },
        record,
        locator,
        logicalIdentity,
      );
    }
    case 'task': {
      const task = authenticated.indexes.tasksById.get(locator.taskId);
      if (task === undefined) return missing('task', locator.taskId);
      return freezeStructured(
        { kind: 'task', taskId: locator.taskId },
        task,
        locator,
        logicalIdentity,
      );
    }
    case 'code': {
      if (provider === undefined) throw new SourceResolutionError('SOURCE_REPOSITORY_UNAVAILABLE', 'provider');
      // 先锚定 context root，再做 Git discovery；discovery、repository root 打开、源码读取
      // 与结束复核共享目录 inode 身份，避免字符串路径在两步之间被整棵替换。
      const containedAnchor = access.sourceRootAnchor;
      const repositoryRoot = discoverSameWorktree(provider, authenticated.containedRoot);
      if (repositoryRoot === authenticated.containedRoot) {
        return captureCodeSource(containedAnchor, repositoryRoot, locator, logicalIdentity, access, provider);
      }
      return withStableRootAnchor(repositoryRoot, async (repositoryAnchor) => {
        await assertStableRootAnchorIdentity(containedAnchor);
        const confirmedRoot = discoverSameWorktree(provider, authenticated.containedRoot);
        if (confirmedRoot !== repositoryRoot) {
          throw new SourceResolutionError('SOURCE_REPOSITORY_UNAVAILABLE', 'worktree identity changed');
        }
        await assertStableRootAnchorIdentity(containedAnchor);
        await assertStableRootAnchorIdentity(repositoryAnchor);
        return captureCodeSource(
          repositoryAnchor,
          repositoryRoot,
          locator,
          logicalIdentity,
          access,
          provider,
        );
      });
    }
  }
}

async function captureCodeSource(
  repositoryAnchor: StableRootAnchorV1,
  repositoryRoot: string,
  locator: Extract<SourceLocator, { kind: 'code' }>,
  logicalIdentity: string,
  access: SourceCaptureAccess,
  provider: GitBinding,
): Promise<ResolvedCurrentSource> {
  const capture = await captureStableBytesAtRoot(repositoryAnchor, {
    relativePath: locator.path,
    observedIo: access.authenticated.observedIoRecorder,
  });
  return freezeResolved(
    { kind: 'code', path: locator.path, contentHash: capture.rawBytesHash },
    capture.copyBytes(),
    objectFreezeIntrinsic({
      schemaVersion: 1,
      kind: 'code',
      changeId: locator.changeId,
      revisionId: locator.revisionId,
      logicalIdentity,
      byteLength: capture.byteLength,
      repositoryRoot,
      observedFile: capture.observation,
      providerBindingHash: provider.bindingHash,
    }),
  );
}

function freezeStructured(
  identity: StructuredSourceIdentity,
  value: unknown,
  locator: Extract<SourceLocator, { kind: 'policy' | 'evidence' | 'decision' | 'task' }>,
  logicalIdentity: string,
): ResolvedCurrentSource {
  const bytes = canonicalizeStrictJsonBytes(value);
  const contentHash = hashBytes(bytes);
  const sourceRef = objectFreezeIntrinsic({ ...identity, contentHash }) as SourceRef;
  return freezeResolved(sourceRef, bytes, objectFreezeIntrinsic({
    schemaVersion: 1,
    kind: locator.kind,
    changeId: locator.changeId,
    revisionId: locator.revisionId,
    logicalIdentity,
    byteLength: bytes.byteLength,
    canonicalObjectHash: contentHash,
  }));
}

type StructuredSourceIdentity =
  | Readonly<{ kind: 'policy'; scenarioId: Extract<SourceRef, { kind: 'policy' }>['scenarioId'] }>
  | Readonly<{ kind: 'evidence'; evidenceId: Extract<SourceRef, { kind: 'evidence' }>['evidenceId'] }>
  | Readonly<{ kind: 'decision'; decisionId: Extract<SourceRef, { kind: 'decision' }>['decisionId'] }>
  | Readonly<{ kind: 'task'; taskId: Extract<SourceRef, { kind: 'task' }>['taskId'] }>;

function freezeResolved(
  sourceRef: SourceRef,
  inputBytes: Uint8Array,
  observation: HistoricalInputObservation,
): ResolvedCurrentSource {
  const privateBytes = copyBytes(inputBytes);
  const frozenRef = objectFreezeIntrinsic({ ...sourceRef }) as SourceRef;
  return objectFreezeIntrinsic({
    sourceRef: frozenRef,
    observation,
    byteLength: privateBytes.byteLength,
    copyCanonicalBytes(): Uint8Array {
      return copyBytes(privateBytes);
    },
  });
}

function discoverSameWorktree(binding: GitBinding, containedRoot: string): string {
  const result = runGit(binding, {
    repositoryRoot: containedRoot,
    args: ['rev-parse', '--show-toplevel'],
  });
  if (result.exitCode !== 0
    || result.stderr !== ''
    || !stringEndsWith(result.stdout, '\n')) {
    throw new SourceResolutionError('SOURCE_REPOSITORY_UNAVAILABLE', 'worktree discovery');
  }
  const rawRoot = stringSlice(result.stdout, 0, -1);
  if (stringIncludes(rawRoot, '\n')) {
    throw new SourceResolutionError('SOURCE_REPOSITORY_UNAVAILABLE', 'worktree framing');
  }
  const parsed = normalizedAbsoluteRealPathSchema.safeParse(rawRoot);
  if (!parsed.success || !isContained(parsed.data, containedRoot)) {
    throw new SourceResolutionError('SOURCE_REPOSITORY_UNAVAILABLE', 'worktree containment');
  }
  return parsed.data;
}

function isContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (child !== '..'
    && !stringStartsWith(child, `..${sep}`)
    && !stringStartsWith(child, sep));
}

function stringEndsWith(value: string, search: string): boolean {
  return reflectApplyIntrinsic(stringEndsWithIntrinsic, value, [search]) as boolean;
}

function stringIncludes(value: string, search: string): boolean {
  return reflectApplyIntrinsic(stringIncludesIntrinsic, value, [search]) as boolean;
}

function stringSlice(value: string, start: number, end?: number): string {
  return reflectApplyIntrinsic(stringSliceIntrinsic, value, [start, end]) as string;
}

function stringStartsWith(value: string, search: string): boolean {
  return reflectApplyIntrinsic(stringStartsWithIntrinsic, value, [search]) as boolean;
}

function authenticateLocator(raw: unknown): SourceLocator {
  const kind = peekLocatorKind(raw);
  const identityKey = kind === 'artifact' || kind === 'code' ? 'path'
    : kind === 'policy' ? 'scenarioId'
      : kind === 'evidence' ? 'evidenceId'
        : kind === 'decision' ? 'decisionId'
          : kind === 'task' ? 'taskId' : invalidLocator();
  const values = readExactDataObject(raw, ['changeId', 'revisionId', 'kind', identityKey]);
  try {
    const changeId = changeIdSchema.parse(values.changeId);
    const revisionId = revisionIdSchema.parse(values.revisionId);
    switch (kind) {
      case 'artifact':
        return objectFreezeIntrinsic({ changeId, revisionId, kind, path: requireSafeArtifactPath(values.path) });
      case 'policy': {
        if (typeof values.scenarioId !== 'string'
          || !arrayIncludes(SCENARIO_IDS, values.scenarioId as never)) {
          return invalidLocator();
        }
        return objectFreezeIntrinsic({ changeId, revisionId, kind, scenarioId: values.scenarioId }) as SourceLocator;
      }
      case 'evidence':
        return objectFreezeIntrinsic({ changeId, revisionId, kind, evidenceId: evidenceIdSchema.parse(values.evidenceId) });
      case 'decision':
        return objectFreezeIntrinsic({ changeId, revisionId, kind, decisionId: decisionIdSchema.parse(values.decisionId) });
      case 'task':
        return objectFreezeIntrinsic({ changeId, revisionId, kind, taskId: taskIdSchema.parse(values.taskId) });
      case 'code':
        return objectFreezeIntrinsic({ changeId, revisionId, kind, path: requireSafeRepositoryCodePath(values.path) });
      default:
        return invalidLocator();
    }
  } catch (error) {
    if (error instanceof SourceResolutionError) throw error;
    return invalidLocator();
  }
}

function peekLocatorKind(raw: unknown): string {
  if (raw === null || typeof raw !== 'object' || isProxy(raw)) return invalidLocator();
  const descriptor = Object.getOwnPropertyDescriptor(raw, 'kind');
  if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'string') {
    return invalidLocator();
  }
  return descriptor.value;
}

function readExactDataObject(raw: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || isProxy(raw)) return invalidLocator();
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) return invalidLocator();
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== 'string' || !arrayIncludes(expectedKeys, key))) {
    return invalidLocator();
  }
  const values = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      return invalidLocator();
    }
    Object.defineProperty(values, key, {
      configurable: true,
      enumerable: true,
      value: descriptor.value,
      writable: true,
    });
  }
  return values;
}

function locatorLogicalIdentity(locator: SourceLocator): string {
  return sourceRefLogicalKey(locator);
}

function missing(kind: string, identity: string): never {
  throw new SourceResolutionError('SOURCE_IDENTITY_MISSING', `${kind}:${identity}`);
}

function invalidLocator(): never {
  throw new SourceResolutionError('SOURCE_LOCATOR_INVALID', 'locator');
}

function hashBytes(bytes: Uint8Array): Sha256 {
  const hash = createHash('sha256');
  reflectApplyIntrinsic(hashUpdateIntrinsic, hash, [bytes]);
  const digest = reflectApplyIntrinsic(hashDigestIntrinsic, hash, ['hex']) as string;
  return parseSha256(`sha256:${digest}`);
}

function arrayIncludes<Value>(values: readonly Value[], value: Value): boolean {
  return reflectApplyIntrinsic(arrayIncludesIntrinsic, values, [value]) as boolean;
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8ArrayIntrinsic(bytes.byteLength);
  for (let index = 0; index < bytes.byteLength; index += 1) copy[index] = bytes[index]!;
  return copy;
}
