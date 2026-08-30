import type { StageAuthorityCatalogV1 } from '../../authority/catalog-schema.js';
import type {
  ChangeMetadata,
  DecisionRecordV2,
  EvidenceRecord,
  FlowPlanV2,
  ProgressEventV1,
  Task,
  TaskFile,
} from '../../domain/change.js';
import type { NormalizedAbsoluteRealPath } from '../../domain/public.js';
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
import type { StrictWorkflowLockV2 } from '../../domain/project.js';
import type {
  AuthorityArchiveTargetV1,
  AuthorityAuxiliaryTargetV1,
  AuthorityLogicalKeyV1,
  AuthorityLogicalTargetV1,
} from './inventory.js';
import {
  type AuthorityArchiveSnapshotV1,
  type AuthorityIndexesV1,
  type AuthorityTransactionPhysicalCaptureV1,
} from './indexes.js';
import type {
  MachineAuthorityProjectionV1,
} from './machine-seal.js';
import type { ObservedIoCountersV1, ObservedIoRecorderV1 } from './observed-io.js';
import type { StableRootIdentityV1 } from './stable-bytes.js';

export type ContextPhase =
  | 'BASE_LOADING'
  | 'BASE_AUTHENTICATED'
  | 'REQUEST_CAPTURED'
  | 'SEALED';

export type BuildBaseContextRequestV1 = Readonly<{
  expectedChangeId: ChangeId;
  containedRoot: NormalizedAbsoluteRealPath;
  logicalTargets: readonly AuthorityLogicalTargetV1[];
  archiveTargets: readonly AuthorityArchiveTargetV1[];
  knownAuxiliaryTargets: readonly AuthorityAuxiliaryTargetV1[];
}>;

export interface BaseContextHandleV1 {
  readonly phase: 'BASE_AUTHENTICATED';
}

export interface ChangeAuthorityContext {
  readonly phase: 'SEALED';
  readonly changeId: ChangeId;
  readonly revisionId: RevisionId;
  readonly workflowLock: StrictWorkflowLockV2;
  readonly authorityCatalog: StageAuthorityCatalogV1;
  readonly authorityCatalogHash: Sha256;
  readonly baseContextDigest: Sha256;
  readonly metadata: ChangeMetadata;
  readonly taskFile: TaskFile | null;
  readonly flow: FlowPlanV2 | null;
  readonly decisions: readonly DecisionRecordV2[];
  readonly evidence: readonly EvidenceRecord[];
  readonly runs: readonly StageRunManifestV3[];
  readonly progress: readonly ProgressEventV1[];
  readonly machineProjection: MachineAuthorityProjectionV1;
  readonly observedIo: ObservedIoCountersV1;
  requireDecision(id: DecisionId): DecisionRecordV2;
  requireEvidence(id: EvidenceId): EvidenceRecord;
  requireTask(id: TaskId): Task;
  requireRun(id: RunId): StageRunManifestV3;
  requireArchive(revisionId: RevisionId, logicalKey: AuthorityLogicalKeyV1): AuthorityArchiveSnapshotV1;
  requireTransactionCapture(transactionId: string): AuthorityTransactionPhysicalCaptureV1;
  eventsForKind(kind: ProgressEventV1['event']): readonly ProgressEventV1[];
  eventsForOperationRequest(operationRequestId: string): readonly ProgressEventV1[];
}

export class AuthorityContextError extends Error {
  constructor(readonly code: string, detail: string, cause?: unknown) {
    super(`${code}: ${detail}`, cause === undefined ? undefined : { cause });
    this.name = 'AuthorityContextError';
  }
}

export type AuthenticatedBaseContextStateV1 = Readonly<{
  containedRoot: string;
  sourceRootIdentity: StableRootIdentityV1;
  observedIoRecorder: ObservedIoRecorderV1;
  expectedChangeId: ChangeId;
  workflowLock: StrictWorkflowLockV2;
  authorityCatalog: StageAuthorityCatalogV1;
  authorityCatalogHash: Sha256;
  baseContextDigest: Sha256;
  indexes: AuthorityIndexesV1;
  machineProjection: MachineAuthorityProjectionV1;
}>;

export type SealedContextMachineStateV1 = Readonly<{
  containedRoot: string;
  machineProjection: MachineAuthorityProjectionV1;
}>;

// runtime lifecycle 与唯一 builder 共置；本 facade 不暴露任何 authenticated-base mint。
export {
  buildChangeBaseContext,
  discoverCanonicalChangeDirectory,
  requireSealedContextMachineState,
  sealForInspection,
  sealForNewMutation,
} from './context-builder.js';
