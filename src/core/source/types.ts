import type { SourceRef } from '../../domain/change.js';
import type {
  ChangeArtifactPath,
  RepositoryCodePath,
  ScenarioId,
} from '../../domain/public.js';
import type {
  ChangeId,
  DecisionId,
  EvidenceId,
  RevisionId,
  Sha256,
  TaskId,
} from '../../domain/scalars.js';
import type { ObservedFileV1 } from '../authority/observed-io.js';

declare const sourceCaptureSessionBrand: unique symbol;

// 背景：current source 只能存在于 base-authenticated 到 SEALED 之间的短生命周期。
// 目的：类型品牌阻止普通调用方在编译期伪造，运行期仍由 context-builder WeakMap 认证。
// 上下文：同一 session 可按调用方顺序解析多个不同逻辑身份，并在 callback 结束后失效。
export interface SourceCaptureSession {
  readonly phase: 'REQUEST_CAPTURED';
  readonly [sourceCaptureSessionBrand]: never;
}

type SourceLocatorContext = Readonly<{
  changeId: ChangeId;
  revisionId: RevisionId;
}>;

export type SourceLocator = SourceLocatorContext & (
  | Readonly<{ kind: 'artifact'; path: ChangeArtifactPath }>
  | Readonly<{ kind: 'policy'; scenarioId: ScenarioId }>
  | Readonly<{ kind: 'evidence'; evidenceId: EvidenceId }>
  | Readonly<{ kind: 'decision'; decisionId: DecisionId }>
  | Readonly<{ kind: 'task'; taskId: TaskId }>
  | Readonly<{ kind: 'code'; path: RepositoryCodePath }>
);

export type SourceInspectLocator = SourceLocator | (SourceLocatorContext & Readonly<{
  kind: 'contract';
  contractId: string;
}>);

type ObservationBase = Readonly<{
  schemaVersion: 1;
  changeId: ChangeId;
  revisionId: RevisionId;
  logicalIdentity: string;
  byteLength: number;
}>;

// @internal provider binding 只进入 code observation；SourceRef 与 inspection projection 均不含它。
export type HistoricalInputObservation =
  | (ObservationBase & Readonly<{
    kind: 'artifact';
    observedFile: ObservedFileV1;
  }>)
  | (ObservationBase & Readonly<{
    kind: 'policy' | 'evidence' | 'decision' | 'task';
    canonicalObjectHash: Sha256;
  }>)
  | (ObservationBase & Readonly<{
    kind: 'code';
    repositoryRoot: string;
    observedFile: ObservedFileV1;
    providerBindingHash: Sha256;
  }>);

export type ResolvedCurrentSource = Readonly<{
  sourceRef: SourceRef;
  observation: HistoricalInputObservation;
  byteLength: number;
  copyCanonicalBytes(): Uint8Array;
}>;

export type InspectedCurrentSource = Readonly<{
  sourceRef: SourceRef;
  byteLength: number;
  copyCanonicalBytes(): Uint8Array;
}>;

export type SourceResolutionErrorCode =
  | 'SOURCE_LOCATOR_INVALID'
  | 'SOURCE_CONTEXT_MISMATCH'
  | 'SOURCE_IDENTITY_MISSING'
  | 'SOURCE_LOGICAL_IDENTITY_DUPLICATE'
  | 'SOURCE_KIND_UNAVAILABLE'
  | 'SOURCE_REPOSITORY_UNAVAILABLE';

export class SourceResolutionError extends Error {
  constructor(readonly code: SourceResolutionErrorCode, detail: string, cause?: unknown) {
    super(`${code}: ${detail}`, cause === undefined ? undefined : { cause });
    this.name = 'SourceResolutionError';
  }
}
