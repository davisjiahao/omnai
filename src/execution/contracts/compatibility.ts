import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { pathExists, readYaml } from '../../core/files.js';
import { changeArtifactPath } from '../../core/paths.js';
import { resolveChange } from '../../core/store.js';
import { loadTasks } from '../../core/tasks.js';
import { resolveWorkset } from '../../workspace/worksets.js';
import {
  verificationEvidenceSchema,
  type ContractCandidate,
  type VerificationEvidence,
} from '../artifacts.js';
import { hashObject } from '../hashing.js';
import { loadRunPacket, runPacketSchema, type RunPacket } from '../packets.js';
import {
  commitsetPath,
  commitsetsRoot,
  integrationEnvironmentInputPath,
  integrationEnvironmentRunsRoot,
  runPacketPath,
  runStatePath,
  runsRoot,
  verificationPlanPath,
  verificationPlansRoot,
  verificationPlanTestCasesPath,
  wavePath,
  wavesRoot,
} from '../paths.js';
import {
  commitSetSchema,
  contentAddressedSourceRefSchema,
  contentHashSchema,
  contractRefSchema,
  integrationEnvironmentInputSchema,
  runStateSchema,
  scopedTaskRefSchema,
  testCaseSchema,
  testCaseRefSchema,
  testCaseRefKey,
  verificationPlanRefSchema,
  verificationPlanSchema,
  waveSchema,
  type CommitSet,
  type ContentAddressedSourceRef,
  type ContentHash,
  type ContractRef,
  type IntegrationEnvironmentInput,
  type RunState,
  type ScopedTaskRef,
  type TestCase,
  type TestCaseRef,
  type VerificationPlan,
  type VerificationPlanRef,
  type Wave,
} from '../types.js';
import {
  compileImpactClosure,
  impactClosureSchema,
  invalidationActionFor,
  type ImpactClosure,
  type ImpactGraphEdge,
  type ImpactGraphNode,
} from '../verification/impact.js';
import {
  loadContractSnapshot,
  loadReadyContractSnapshot as loadPersistedReadyContractSnapshot,
  type ContractSnapshot,
  type ContractStoreContext,
} from './store.js';

export type CompatibilityDisposition = 'COMPATIBLE' | 'INCOMPATIBLE' | 'UNRESOLVED';
export type ContractChangeKind = 'ADDED' | 'REMOVED' | 'CHANGED';
export type ContractChangeCompatibility = 'ADDITIVE' | 'BREAKING' | 'AMBIGUOUS';

export interface ContractDeltaEntry {
  readonly id: string;
  readonly kind: ContractChangeKind;
  readonly compatibility: ContractChangeCompatibility;
  readonly previousContentHash: ContentHash | null;
  readonly currentContentHash: ContentHash | null;
  readonly changedPaths: readonly string[];
}

export interface ContractDelta {
  readonly contractKey: string;
  readonly scopeHash: ContentHash;
  readonly previous: ContractRef;
  readonly current: ContractRef;
  readonly elements: readonly ContractDeltaEntry[];
  readonly scenarios: readonly ContractDeltaEntry[];
  readonly fixtures: readonly ContractDeltaEntry[];
  readonly compatibilityPolicyChanged: boolean;
  readonly contentHash: ContentHash;
}

export interface ContractReference extends ScopedTaskRef {
  readonly runId: string;
  readonly runKind?: RunState['kind'];
  readonly commit?: string;
  readonly contract: ContractRef;
  readonly usedElements: readonly string[];
  readonly usedScenarios: readonly string[];
}

export interface CompatibilityValidatorEvidence {
  readonly status: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  readonly evidenceRef: string;
  readonly evidence: VerificationEvidence;
  readonly previous: ContractRef;
  readonly current: ContractRef;
  readonly project: string;
  readonly usedElements: readonly string[];
  readonly usedScenarios: readonly string[];
}

export interface CompatibilityDecision {
  readonly disposition: CompatibilityDisposition;
  readonly project: string;
  readonly reference: ContractReference;
  readonly affectedElements: readonly string[];
  readonly affectedScenarios: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly deltaHash: ContentHash;
  readonly fingerprint: ContentHash;
}

export interface CompatibilityImpactInventory {
  readonly sources: readonly {
    readonly ref: string;
    readonly contentHash: ContentHash;
  }[];
  readonly tasks: readonly {
    readonly scopedTask: ScopedTaskRef;
    readonly contentHash: ContentHash;
    readonly sourceRefs: readonly ContentAddressedSourceRef[];
    readonly contractRefs: readonly ContractRef[];
  }[];
  readonly testCases: readonly {
    readonly ref: TestCaseRef;
    readonly contentHash: ContentHash;
    readonly sourceRefs: readonly ContentAddressedSourceRef[];
    readonly scopedTasks: readonly ScopedTaskRef[];
    readonly contractRefs: readonly ContractRef[];
    readonly elementUses: readonly { readonly snapshot: ContractRef; readonly id: string }[];
    readonly scenarioUses: readonly { readonly snapshot: ContractRef; readonly id: string }[];
  }[];
  readonly verificationPlans: readonly {
    readonly id: string;
    readonly contentHash: ContentHash;
    readonly contractRefs: readonly ContractRef[];
    readonly testCaseRefs: readonly TestCaseRef[];
  }[];
  readonly waveMembers: readonly {
    readonly ref: string;
    readonly contentHash: ContentHash;
    readonly scopedTask: ScopedTaskRef;
    readonly verificationPlan?: VerificationPlanRef;
    readonly testCaseRefs: readonly TestCaseRef[];
    readonly contractRefs: readonly ContractRef[];
  }[];
  readonly runs: readonly {
    readonly id: string;
    readonly contentHash: ContentHash;
    readonly memberRef?: string;
    readonly scopedTask?: ScopedTaskRef;
    readonly verificationPlan?: VerificationPlanRef;
    readonly testCaseRefs: readonly TestCaseRef[];
    readonly contractRefs: readonly ContractRef[];
  }[];
  readonly environmentInputs: readonly {
    readonly id: string;
    readonly contentHash: ContentHash;
    readonly verificationPlan: VerificationPlanRef;
    readonly testCaseRefs: readonly TestCaseRef[];
    readonly contractRefs: readonly ContractRef[];
  }[];
  readonly commitSets: readonly {
    readonly id: string;
    readonly contentHash: ContentHash;
    readonly verificationPlan?: VerificationPlanRef;
    readonly memberRunIds: readonly string[];
    readonly environmentInputRefs: readonly { readonly id: string; readonly contentHash: ContentHash }[];
    readonly contractRefs: readonly ContractRef[];
  }[];
}

export interface CompatibilityReadSet {
  readonly previous: ContractRef;
  readonly current: ContractRef;
  readonly previousStatus: ContractSnapshot['manifest']['status'];
  readonly currentStatus: ContractSnapshot['manifest']['status'];
  readonly references: readonly ContractReference[];
  readonly referencesHash: ContentHash;
  readonly inventoryHash: ContentHash;
  readonly runStates: readonly {
    readonly id: string;
    readonly state: RunState;
    readonly contentHash: ContentHash;
  }[];
  readonly contentHash: ContentHash;
}

export interface CompatibilityMutationReceipt {
  readonly previousId: string;
  readonly currentId: string;
  readonly readSetHash: ContentHash;
  readonly resultContentHash: ContentHash;
  readonly contentHash: ContentHash;
}

export interface CompatibilityMutationPlan {
  readonly evidenceDecisionFingerprints: readonly ContentHash[];
  readonly patchRunIds: readonly string[];
  readonly recoveries: readonly {
    readonly project: string;
    readonly parentRunId: string;
    readonly scopedTask: ScopedTaskRef;
    readonly decisionFingerprint: ContentHash;
  }[];
  readonly attentionDecisionFingerprints: readonly ContentHash[];
  readonly contentHash: ContentHash;
}

export interface CompatibilityClassificationIdentity {
  readonly previous: ContractRef;
  readonly current: ContractRef;
  readonly deltaHash: ContentHash;
  readonly reference: ContractReference;
  readonly contentHash: ContentHash;
}

export interface ContractCompatibilityContext extends ContractStoreContext {
  /** 测试或远端存储适配器可替换读取；默认仍从 Core 的不可变快照目录读取。 */
  readonly loadContractSnapshot?: (id: string) => Promise<ContractSnapshot>;
  /** 重验证专用的 READY 权威读取；生产缺省实现会复核磁盘上的验证证据。 */
  readonly loadReadyContractSnapshot?: (id: string) => Promise<ContractSnapshot>;
  /** 返回 Core 解码后的引用事实，而不是 Agent 自述；缺省时扫描 Packet 与 CommitSet。 */
  readonly listContractReferences?: (contractId: string) => Promise<readonly ContractReference[]>;
  /** 返回完整的 Core 记录清单。兼容模块自己建图，调用方不能传入预制 closure。 */
  readonly loadCompatibilityImpactInventory?: () => Promise<CompatibilityImpactInventory>;
  /** 自定义存储适配器必须用独立 Core 枚举证明引用与影响清单无遗漏。 */
  readonly assertCompleteCompatibilityInventory?: (input: {
    readonly previous: ContractSnapshot;
    readonly current: ContractSnapshot;
    readonly references: readonly ContractReference[];
    readonly inventory: CompatibilityImpactInventory;
  }) => Promise<void>;
  /** 在已持有 Workset lock 时独立重读全部可变事实；不得再入同一 mutation lock。 */
  readonly assertCompatibilityReadSetCurrent?: (input: {
    readonly previous: ContractSnapshot;
    readonly current: ContractSnapshot;
    readonly references: readonly ContractReference[];
    readonly inventory: CompatibilityImpactInventory;
    readonly readSet: CompatibilityReadSet;
  }) => Promise<boolean>;
  /** 必须按 operationIdentity 自带持久化幂等 journal；不得依赖外层 classification transaction。 */
  readonly runCompatibilityValidators?: (input: {
    readonly previous: ContractSnapshot;
    readonly current: ContractSnapshot;
    readonly delta: ContractDelta;
    readonly reference: ContractReference;
    readonly classificationIdentity: CompatibilityClassificationIdentity;
    readonly operationIdentity: ContentHash;
  }) => Promise<readonly unknown[]>;
  /** 从 Core 权威 store 读取并复核 artifact/output hash；适配器对象必须逐字一致。 */
  readonly loadVerificationEvidence?: (id: string) => Promise<unknown>;
  /** 返回 schema 校验后的权威 Run state；缺省时读取 Core state.yaml。 */
  readonly loadRunState?: (id: string) => Promise<unknown>;
  /** 必须按 operationIdentity 复用同一 Resolver Run/结果，覆盖 apply 后、decision 提交前的崩溃。 */
  readonly runCompatibilityResolver?: (input: {
    readonly previous: ContractSnapshot;
    readonly current: ContractSnapshot;
    readonly delta: ContractDelta;
    readonly reference: ContractReference;
    readonly evidence: readonly CompatibilityValidatorEvidence[];
    readonly classificationIdentity: CompatibilityClassificationIdentity;
    readonly operationIdentity: ContentHash;
  }) => Promise<unknown>;
  /** Validator/Resolver 的独立持久化 journal；用于最终 mutation 之前的崩溃与读集重试。 */
  readonly loadCompatibilityClassificationResult?: (
    identity: CompatibilityClassificationIdentity,
  ) => Promise<CompatibilityDecision | null>;
  /** 按 identity 原子提交 decision；只能持独立 classification lock，不得持 Workset mutation lock。 */
  readonly withCompatibilityClassificationTransaction?: (
    identity: CompatibilityClassificationIdentity,
    apply: () => Promise<CompatibilityDecision>,
  ) => Promise<CompatibilityDecision>;
  readonly recordCompatibilityEvidence?: (input: CompatibilityMutationInput) => Promise<unknown>;
  readonly captureUncommittedRunPatch?: (input: CompatibilityMutationInput) => Promise<unknown>;
  /** 受限重读 patch，必须校验路径 containment 与正文 sha256。 */
  readonly loadCapturedRunPatch?: (receipt: CapturedPatchRef) => Promise<unknown>;
  readonly markRunStale?: (input: CompatibilityMutationInput) => Promise<void>;
  readonly markCommittedWorkNeedsRevalidation?: (input: CompatibilityMutationInput) => Promise<void>;
  readonly createRecoveryRun?: (input: CompatibilityMutationInput) => Promise<unknown>;
  /** 从 Core store 重读 Recovery Packet，并验证 packet hash/不可变性。 */
  readonly loadRecoveryRunPacket?: (id: string) => Promise<unknown>;
  /** 重读 Core 持久化的 Recovery decision linkage，不从 Packet objective 推测。 */
  readonly loadRecoveryRunLinkage?: (id: string) => Promise<unknown>;
  readonly createCompatibilityAttention?: (
    input: CompatibilityMutationInput & { readonly fingerprint: ContentHash },
  ) => Promise<unknown>;
  readonly loadCompatibilityAttention?: (id: string) => Promise<unknown>;
  readonly invalidateTestCase?: (ref: string, delta: ContractDelta) => Promise<void>;
  readonly invalidateVerificationPlan?: (id: string, delta: ContractDelta) => Promise<void>;
  readonly invalidateEnvironmentEvidence?: (id: string, delta: ContractDelta) => Promise<void>;
  readonly markWaveMemberBlocked?: (ref: string, delta: ContractDelta) => Promise<void>;
  readonly markImpactRunStale?: (id: string, delta: ContractDelta) => Promise<void>;
  readonly markCommitSetNeedsRevalidation?: (id: string, delta: ContractDelta) => Promise<void>;
  /** 仅可使用当前 compatibility transaction 已绑定的无锁写接口；不得重入 Workset lock。 */
  readonly supersedeContractSnapshot?: (previousId: string, currentId: string) => Promise<void>;
  /** 在读取当前 snapshot 状态前查询已提交 journal，支持 SUPERSEDED 后的同身份重放。 */
  readonly loadCompatibilityMutationResult?: (
    previousId: string,
    currentId: string,
  ) => Promise<RevalidationResult | null>;
  /** 从 Core hash-chain journal 重读提交回执；它认证历史 read-set 与结果，而非实时可变引用。 */
  readonly loadCompatibilityMutationReceipt?: (
    previousId: string,
    currentId: string,
  ) => Promise<CompatibilityMutationReceipt | null>;
  /** Core 必须在同一 Workset mutation journal/lock 中原子化并幂等执行全部写入。 */
  readonly withCompatibilityMutationTransaction?: (
    identity: {
      readonly previousId: string;
      readonly currentId: string;
      readonly readSetHash: ContentHash;
    },
    apply: () => Promise<RevalidationResult>,
  ) => Promise<RevalidationResult>;
}

export interface CompatibilityMutationInput {
  readonly previous: ContractSnapshot;
  readonly current: ContractSnapshot;
  readonly delta: ContractDelta;
  readonly reference: ContractReference;
  readonly decision: CompatibilityDecision;
}

export interface RecoveryRunRef {
  readonly runId: string;
  readonly project: string;
  readonly kind: 'RECOVERY_WRITER';
  readonly parentRunId: string;
  readonly scopedTask: ScopedTaskRef;
  readonly decisionFingerprint: ContentHash;
  readonly packetHash: ContentHash;
}

export interface CompatibilityAttentionRef {
  readonly id: string;
  readonly project: string;
  readonly fingerprint: ContentHash;
  readonly previous: ContractRef;
  readonly current: ContractRef;
  readonly deltaHash: ContentHash;
  readonly reference: ContractReference;
}

export interface CapturedPatchRef {
  readonly runId: string;
  readonly patchRef: string;
  readonly contentHash: ContentHash;
}

export interface RevalidationResult {
  readonly mutationIdentity: {
    readonly previous: ContractRef;
    readonly current: ContractRef;
    readonly readSetHash: ContentHash;
    readonly deltaHash: ContentHash;
    readonly impactClosureHash: ContentHash;
  };
  readonly readSet: CompatibilityReadSet;
  readonly mutationPlan: CompatibilityMutationPlan;
  readonly delta: ContractDelta;
  readonly impactClosure: ImpactClosure;
  readonly decisions: readonly CompatibilityDecision[];
  readonly compatibleProjects: readonly string[];
  readonly incompatibleProjects: readonly string[];
  readonly unresolvedProjects: readonly string[];
  readonly compatibilityEvidenceRefs: readonly string[];
  readonly recoveryRuns: readonly RecoveryRunRef[];
  readonly attentionItems: readonly CompatibilityAttentionRef[];
  readonly preservedPatches: readonly CapturedPatchRef[];
  readonly preservedPatchRefs: readonly string[];
  readonly invalidatedTestCases: readonly string[];
  readonly invalidatedVerificationPlans: readonly string[];
  readonly invalidatedEnvironmentInputs: readonly string[];
  readonly contentHash: ContentHash;
}

const testCaseInventorySchema = z.strictObject({
  schemaVersion: z.literal(1),
  testCases: z.array(testCaseSchema).readonly(),
});

const compatibilityImpactInventorySchema = z.strictObject({
  sources: z.array(z.strictObject({
    ref: z.string().min(1),
    contentHash: contentHashSchema,
  })).readonly(),
  tasks: z.array(z.strictObject({
    scopedTask: scopedTaskRefSchema,
    contentHash: contentHashSchema,
    sourceRefs: z.array(contentAddressedSourceRefSchema).readonly(),
    contractRefs: z.array(contractRefSchema).readonly(),
  })).readonly(),
  testCases: z.array(z.strictObject({
    ref: testCaseRefSchema,
    contentHash: contentHashSchema,
    sourceRefs: z.array(contentAddressedSourceRefSchema).readonly(),
    scopedTasks: z.array(scopedTaskRefSchema).readonly(),
    contractRefs: z.array(contractRefSchema).readonly(),
    elementUses: z.array(z.strictObject({
      snapshot: contractRefSchema,
      id: z.string().min(1),
    })).readonly(),
    scenarioUses: z.array(z.strictObject({
      snapshot: contractRefSchema,
      id: z.string().regex(/^SC-[a-zA-Z0-9._-]+$/),
    })).readonly(),
  })).readonly(),
  verificationPlans: z.array(z.strictObject({
    id: z.string().regex(/^VPL-\d{4}$/),
    contentHash: contentHashSchema,
    contractRefs: z.array(contractRefSchema).readonly(),
    testCaseRefs: z.array(testCaseRefSchema).readonly(),
  })).readonly(),
  waveMembers: z.array(z.strictObject({
    ref: z.string().min(1),
    contentHash: contentHashSchema,
    scopedTask: scopedTaskRefSchema,
    verificationPlan: verificationPlanRefSchema.optional(),
    testCaseRefs: z.array(testCaseRefSchema).readonly(),
    contractRefs: z.array(contractRefSchema).readonly(),
  })).readonly(),
  runs: z.array(z.strictObject({
    id: z.string().regex(/^RUN-\d{4}$/),
    contentHash: contentHashSchema,
    memberRef: z.string().min(1).optional(),
    scopedTask: scopedTaskRefSchema.optional(),
    verificationPlan: verificationPlanRefSchema.optional(),
    testCaseRefs: z.array(testCaseRefSchema).readonly(),
    contractRefs: z.array(contractRefSchema).readonly(),
  })).readonly(),
  environmentInputs: z.array(z.strictObject({
    id: z.string().regex(/^IER-\d{4}$/),
    contentHash: contentHashSchema,
    verificationPlan: verificationPlanRefSchema,
    testCaseRefs: z.array(testCaseRefSchema).readonly(),
    contractRefs: z.array(contractRefSchema).readonly(),
  })).readonly(),
  commitSets: z.array(z.strictObject({
    id: z.string().regex(/^CST-\d{4}$/),
    contentHash: contentHashSchema,
    verificationPlan: verificationPlanRefSchema.optional(),
    memberRunIds: z.array(z.string().regex(/^RUN-\d{4}$/)).readonly(),
    environmentInputRefs: z.array(z.strictObject({
      id: z.string().regex(/^IER-\d{4}$/),
      contentHash: contentHashSchema,
    })).readonly(),
    contractRefs: z.array(contractRefSchema).readonly(),
  })).readonly(),
});

const compatibilityValidatorEvidenceSchema = z.strictObject({
  status: z.enum(['PASS', 'FAIL', 'INCONCLUSIVE']),
  evidenceRef: z.string().regex(/^EVD-\d{4}$/),
  evidence: verificationEvidenceSchema,
  previous: contractRefSchema,
  current: contractRefSchema,
  project: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  usedElements: z.array(z.string().min(1)).readonly(),
  usedScenarios: z.array(z.string().regex(/^SC-[a-zA-Z0-9._-]+$/)).readonly(),
});

const compatibilityResolverResultSchema = z.strictObject({
  selectedEvidenceRefs: z.array(z.string().regex(/^EVD-\d{4}$/)).min(1).readonly(),
});

const contractDeltaEntrySchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(['ADDED', 'REMOVED', 'CHANGED']),
  compatibility: z.enum(['ADDITIVE', 'BREAKING', 'AMBIGUOUS']),
  previousContentHash: contentHashSchema.nullable(),
  currentContentHash: contentHashSchema.nullable(),
  changedPaths: z.array(z.string()).readonly(),
});

const contractDeltaSchema = z.strictObject({
  contractKey: z.string().min(1),
  scopeHash: contentHashSchema,
  previous: contractRefSchema,
  current: contractRefSchema,
  elements: z.array(contractDeltaEntrySchema).readonly(),
  scenarios: z.array(contractDeltaEntrySchema).readonly(),
  fixtures: z.array(contractDeltaEntrySchema).readonly(),
  compatibilityPolicyChanged: z.boolean(),
  contentHash: contentHashSchema,
});

const contractReferenceSchema = z.strictObject({
  ...scopedTaskRefSchema.shape,
  runId: z.string().regex(/^RUN-\d{4}$/),
  runKind: runStateSchema.shape.kind.optional(),
  commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).optional(),
  contract: contractRefSchema,
  usedElements: z.array(z.string().min(1)).readonly(),
  usedScenarios: z.array(z.string().regex(/^SC-[a-zA-Z0-9._-]+$/)).readonly(),
});

const compatibilityDecisionSchema = z.strictObject({
  disposition: z.enum(['COMPATIBLE', 'INCOMPATIBLE', 'UNRESOLVED']),
  project: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  reference: contractReferenceSchema,
  affectedElements: z.array(z.string().min(1)).readonly(),
  affectedScenarios: z.array(z.string().regex(/^SC-[a-zA-Z0-9._-]+$/)).readonly(),
  evidenceRefs: z.array(z.string().min(1)).readonly(),
  deltaHash: contentHashSchema,
  fingerprint: contentHashSchema,
});

const capturedPatchSchema: z.ZodType<CapturedPatchRef> = z.strictObject({
  runId: z.string().regex(/^RUN-\d{4}$/),
  patchRef: z.string().min(1),
  contentHash: contentHashSchema,
}).superRefine((receipt, context) => {
  const prefix = `runs/${receipt.runId}/evidence/`;
  if (!receipt.patchRef.startsWith(prefix) || !receipt.patchRef.endsWith('.patch') ||
      receipt.patchRef.includes('..') || receipt.patchRef.includes('\\')) {
    context.addIssue({ code: 'custom', path: ['patchRef'], message: 'CAPTURED_PATCH_REF_OUTSIDE_RUN_EVIDENCE' });
  }
});

const recoveryRunRefSchema = z.strictObject({
  runId: z.string().regex(/^RUN-\d{4}$/),
  project: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  kind: z.literal('RECOVERY_WRITER'),
  parentRunId: z.string().regex(/^RUN-\d{4}$/),
  scopedTask: scopedTaskRefSchema,
  decisionFingerprint: contentHashSchema,
  packetHash: contentHashSchema,
});

const compatibilityAttentionRefSchema = z.strictObject({
  id: z.string().regex(/^ATTN-\d{4}$/),
  project: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  fingerprint: contentHashSchema,
  previous: contractRefSchema,
  current: contractRefSchema,
  deltaHash: contentHashSchema,
  reference: contractReferenceSchema,
});

const compatibilityReadSetSchema = z.strictObject({
  previous: contractRefSchema,
  current: contractRefSchema,
  previousStatus: z.enum(['GENERATING', 'VALIDATING', 'READY', 'SUPERSEDED', 'INVALID']),
  currentStatus: z.enum(['GENERATING', 'VALIDATING', 'READY', 'SUPERSEDED', 'INVALID']),
  references: z.array(contractReferenceSchema).readonly(),
  referencesHash: contentHashSchema,
  inventoryHash: contentHashSchema,
  runStates: z.array(z.strictObject({
    id: z.string().regex(/^RUN-\d{4}$/),
    state: runStateSchema,
    contentHash: contentHashSchema,
  })).readonly(),
  contentHash: contentHashSchema,
});

const compatibilityMutationReceiptSchema = z.strictObject({
  previousId: z.string().regex(/^CTR-\d{4}$/),
  currentId: z.string().regex(/^CTR-\d{4}$/),
  readSetHash: contentHashSchema,
  resultContentHash: contentHashSchema,
  contentHash: contentHashSchema,
});

const compatibilityMutationPlanSchema = z.strictObject({
  evidenceDecisionFingerprints: z.array(contentHashSchema).readonly(),
  patchRunIds: z.array(z.string().regex(/^RUN-\d{4}$/)).readonly(),
  recoveries: z.array(z.strictObject({
    project: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    parentRunId: z.string().regex(/^RUN-\d{4}$/),
    scopedTask: scopedTaskRefSchema,
    decisionFingerprint: contentHashSchema,
  })).readonly(),
  attentionDecisionFingerprints: z.array(contentHashSchema).readonly(),
  contentHash: contentHashSchema,
});

const revalidationResultSchema = z.strictObject({
  mutationIdentity: z.strictObject({
    previous: contractRefSchema,
    current: contractRefSchema,
    readSetHash: contentHashSchema,
    deltaHash: contentHashSchema,
    impactClosureHash: contentHashSchema,
  }),
  readSet: compatibilityReadSetSchema,
  mutationPlan: compatibilityMutationPlanSchema,
  delta: contractDeltaSchema,
  impactClosure: impactClosureSchema,
  decisions: z.array(compatibilityDecisionSchema).readonly(),
  compatibleProjects: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/)).readonly(),
  incompatibleProjects: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/)).readonly(),
  unresolvedProjects: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/)).readonly(),
  compatibilityEvidenceRefs: z.array(z.string().regex(/^EVD-\d{4}$/)).readonly(),
  recoveryRuns: z.array(recoveryRunRefSchema).readonly(),
  attentionItems: z.array(compatibilityAttentionRefSchema).readonly(),
  preservedPatches: z.array(capturedPatchSchema).readonly(),
  preservedPatchRefs: z.array(z.string().min(1)).readonly(),
  invalidatedTestCases: z.array(z.string().min(1)).readonly(),
  invalidatedVerificationPlans: z.array(z.string().regex(/^VPL-\d{4}$/)).readonly(),
  invalidatedEnvironmentInputs: z.array(z.string().regex(/^IER-\d{4}$/)).readonly(),
  contentHash: contentHashSchema,
});

/**
 * 对两个不可变 ContractSnapshot 做纯语义比较。
 *
 * 对象顺序、展示摘要和运行身份不参与兼容判断；元素、场景、fixture 与策略
 * 分别按稳定 ID/Ref 对齐并绑定各自旧新哈希，供后续证据精确引用。
 */
export function compareContractSnapshots(
  previous: ContractSnapshot,
  current: ContractSnapshot,
): ContractDelta {
  assertComparableSnapshots(previous, current);
  const elements = compareByIdentity(
    previous.candidate.contract.elements,
    current.candidate.contract.elements,
    (item) => item.id,
    classifyElementChange,
  );
  const scenarios = compareByIdentity(
    previous.candidate.businessScenarios,
    current.candidate.businessScenarios,
    (item) => item.id,
    classifyScenarioChange,
  );
  const fixtures = compareByIdentity(
    previous.candidate.fixtures,
    current.candidate.fixtures,
    (item) => item.ref,
    () => ({ compatibility: 'BREAKING' as const, changedPaths: ['contentHash'] }),
  );
  const identity = {
    contractKey: current.manifest.contractKey,
    scopeHash: current.manifest.scopeHash,
    previous: contractRef(previous),
    current: contractRef(current),
    elements,
    scenarios,
    fixtures,
    compatibilityPolicyChanged:
      stableJson(previous.candidate.contract.compatibilityPolicy) !==
      stableJson(current.candidate.contract.compatibilityPolicy),
  };
  return { ...identity, contentHash: hashObject(identity) };
}

/** 从 Packet/CommitSet 的不可变字段发现引用；绝不解析 Agent prose。 */
export async function findContractReferences(
  context: ContractCompatibilityContext,
  id: string,
): Promise<ContractReference[]> {
  const snapshot = await readSnapshot(context, id);
  const supplied = context.listContractReferences === undefined
    ? await scanContractReferences(context, snapshot)
    : await context.listContractReferences(id);
  return canonicalReferences(supplied, contractRef(snapshot));
}

/** 按计划规定的闭合顺序执行无交集、精确 PASS、破坏、Resolver、未决分类。 */
export async function classifyContractCompatibility(
  context: ContractCompatibilityContext,
  delta: ContractDelta,
  reference: ContractReference,
): Promise<CompatibilityDecision> {
  const classificationIdentity = compatibilityClassificationIdentity(delta, reference);
  const validatorOperationIdentity = hashObject({
    classificationIdentity: classificationIdentity.contentHash,
    operation: 'VALIDATORS',
  });
  const previous = await readSnapshot(context, delta.previous.id);
  const current = await readSnapshot(context, delta.current.id);
  const affectedElements = intersection(
    delta.elements.map((item) => item.id),
    reference.usedElements,
  );
  const affectedScenarios = intersection(
    delta.scenarios.map((item) => item.id),
    reference.usedScenarios,
  );
  const usedFixtures = canonicalStrings(
    [...previous.candidate.businessScenarios, ...current.candidate.businessScenarios]
      .filter((scenario) => reference.usedScenarios.includes(scenario.id))
      .flatMap((scenario) => scenario.fixtureRefs),
  );
  const affectedFixtures = intersection(
    delta.fixtures.map((item) => item.id),
    usedFixtures,
  );
  const noIntersection = affectedElements.length === 0 && affectedScenarios.length === 0 &&
    affectedFixtures.length === 0 && !delta.compatibilityPolicyChanged;
  if (noIntersection) {
    return decision('COMPATIBLE', reference, affectedElements, affectedScenarios, [
      `structural:no-intersection:${delta.contentHash}`,
    ], delta);
  }

  const validatorEvidence = await canonicalValidatorEvidence(
    context,
    await context.runCompatibilityValidators?.({
      previous,
      current,
      delta,
      reference,
      classificationIdentity,
      operationIdentity: validatorOperationIdentity,
    }) ?? [],
    delta,
    reference,
    previous,
    current,
  );
  const passing = validatorEvidence.filter((item) => item.status === 'PASS');
  if (passing.length > 0) {
    return decision(
      'COMPATIBLE',
      reference,
      affectedElements,
      affectedScenarios,
      passing.map((item) => item.evidenceRef),
      delta,
    );
  }

  const affectedChanges = [
    ...delta.elements.filter((item) => affectedElements.includes(item.id)),
    ...delta.scenarios.filter((item) => affectedScenarios.includes(item.id)),
    ...delta.fixtures.filter((item) => affectedFixtures.includes(item.id)),
  ];
  if (affectedChanges.some((item) => item.compatibility === 'BREAKING')) {
    return decision('INCOMPATIBLE', reference, affectedElements, affectedScenarios, [
      `structural:breaking:${delta.contentHash}`,
      ...validatorEvidence.map((item) => item.evidenceRef),
    ], delta);
  }

  const hasConflict = validatorEvidence.some((item) => item.status !== 'PASS') ||
    delta.compatibilityPolicyChanged ||
    affectedChanges.some((item) => item.compatibility === 'AMBIGUOUS');
  if (hasConflict && context.runCompatibilityResolver !== undefined) {
    const rawResolved = await context.runCompatibilityResolver({
      previous,
      current,
      delta,
      reference,
      evidence: validatorEvidence,
      classificationIdentity,
      operationIdentity: hashObject({
        classificationIdentity: classificationIdentity.contentHash,
        operation: 'RESOLVER',
        evidenceRefs: validatorEvidence.map((item) => item.evidenceRef),
      }),
    });
    const parsed = compatibilityResolverResultSchema.safeParse(rawResolved);
    if (!parsed.success) throw new Error('COMPATIBILITY_RESOLVER_RESULT_INVALID');
    const availableEvidence = new Set(validatorEvidence.map((item) => item.evidenceRef));
    if (parsed.data.selectedEvidenceRefs.some((ref) => !availableEvidence.has(ref))) {
      throw new Error('COMPATIBILITY_RESOLVER_EVIDENCE_UNSUPPORTED');
    }
    const selectedEvidence = validatorEvidence.filter((item) =>
      parsed.data.selectedEvidenceRefs.includes(item.evidenceRef));
    const resolvedDisposition: CompatibilityDisposition = selectedEvidence.every((item) => item.status === 'PASS')
      ? 'COMPATIBLE'
      : selectedEvidence.some((item) => item.status === 'FAIL')
        ? 'INCOMPATIBLE'
        : 'UNRESOLVED';
    return decision(
      resolvedDisposition,
      reference,
      affectedElements,
      affectedScenarios,
      canonicalStrings(parsed.data.selectedEvidenceRefs),
      delta,
      );
  }

  if (!hasConflict) {
    return decision('COMPATIBLE', reference, affectedElements, affectedScenarios, [
      `structural:additive:${delta.contentHash}`,
    ], delta);
  }
  return decision(
    'UNRESOLVED',
    reference,
    affectedElements,
    affectedScenarios,
    canonicalStrings([
      `structural:ambiguous:${delta.contentHash}`,
      ...validatorEvidence.map((item) => item.evidenceRef),
    ]),
    delta,
  );
}

/**
 * 执行定向重验证。Packet、Git commit 和旧证据正文均视为不可变；本函数只
 * 通过 Core 授权回调追加兼容证据、状态迁移、Recovery Run 或 Attention。
 */
export async function revalidateContractChange(
  context: ContractCompatibilityContext,
  previousId: string,
  currentId: string,
): Promise<RevalidationResult> {
  const loadReplay = requireAuthority(
    context.loadCompatibilityMutationResult,
    'COMPATIBILITY_MUTATION_REPLAY_AUTHORITY_REQUIRED',
  );
  requireAuthority(
    context.loadCompatibilityMutationReceipt,
    'COMPATIBILITY_MUTATION_RECEIPT_AUTHORITY_REQUIRED',
  );
  const transaction = requireAuthority(
    context.withCompatibilityMutationTransaction,
    'COMPATIBILITY_MUTATION_TRANSACTION_AUTHORITY_REQUIRED',
  );
  const classificationCache = new Map<string, Promise<CompatibilityDecision>>();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const replay = await loadReplay(previousId, currentId);
    if (replay !== null) return assertRevalidationReplay(context, replay, previousId, currentId);
    const prepared = await prepareContractRevalidation(
      context,
      previousId,
      currentId,
      classificationCache,
    );
    try {
      return await transaction({
        previousId,
        currentId,
        readSetHash: prepared.readSet.contentHash,
      }, async () => {
        const lockedReplay = await loadReplay(previousId, currentId);
        if (lockedReplay !== null) {
          return assertRevalidationReplay(context, lockedReplay, previousId, currentId);
        }
        await assertCompatibilityReadSetCurrent(context, prepared);
        return applyPreparedContractRevalidation(context, previousId, currentId, prepared);
      });
    } catch (error) {
      if (!(error instanceof CompatibilityReadSetStaleError)) throw error;
    }
  }
  throw new Error(`COMPATIBILITY_READ_SET_RETRY_EXHAUSTED:${previousId}:${currentId}`);
}

interface PreparedContractRevalidation {
  readonly previous: ContractSnapshot;
  readonly current: ContractSnapshot;
  readonly delta: ContractDelta;
  readonly references: readonly ContractReference[];
  readonly inventory: CompatibilityImpactInventory;
  readonly runStates: ReadonlyMap<string, RunState>;
  readonly impactClosure: ImpactClosure;
  readonly canonical: readonly CompatibilityDecision[];
  readonly projectDecisions: ReadonlyMap<string, CompatibilityDecision>;
  readonly readSet: CompatibilityReadSet;
  readonly mutationPlan: CompatibilityMutationPlan;
}

class CompatibilityReadSetStaleError extends Error {
  constructor() {
    super('COMPATIBILITY_READ_SET_STALE');
    this.name = 'CompatibilityReadSetStaleError';
  }
}

async function prepareContractRevalidation(
  context: ContractCompatibilityContext,
  previousId: string,
  currentId: string,
  classificationCache: Map<string, Promise<CompatibilityDecision>>,
): Promise<PreparedContractRevalidation> {
  const previous = await readReadySnapshot(context, previousId);
  const current = await readReadySnapshot(context, currentId);
  const delta = compareContractSnapshots(previous, current);
  const references = await findContractReferences(context, previousId);
  const decisions = await Promise.all(references.map((reference) => {
    const identity = hashObject({ deltaHash: delta.contentHash, reference });
    const existing = classificationCache.get(identity);
    if (existing !== undefined) return existing;
    const classified = classifyContractCompatibilityIdempotently(context, delta, reference);
    classificationCache.set(identity, classified);
    return classified;
  }));
  const projectDecisions = reduceProjectDecisions(decisions);
  // 影响清单、图和语义 closure 都是 mutation 的前置证明。任何损坏、缺边或
  // 敌对输入必须在第一条 Evidence/Run/Attention 状态写入之前失败。
  const rawInventory = context.loadCompatibilityImpactInventory === undefined
    ? await loadFilesystemImpactInventory(context, previous, current)
    : await context.loadCompatibilityImpactInventory();
  const inventory = parseCompatibilityImpactInventory(rawInventory);
  assertCompleteCompatibilityImpactInventory(inventory, references, previous, current);
  if (context.loadCompatibilityImpactInventory !== undefined || context.listContractReferences !== undefined) {
    await requireAuthority(
      context.assertCompleteCompatibilityInventory,
      'COMPATIBILITY_INVENTORY_COMPLETENESS_AUTHORITY_REQUIRED',
    )({ previous, current, references, inventory });
  }
  const runStates = await loadImpactRunStates(context, inventory, references);
  const impactClosure = buildCompatibilityImpactClosure(context, previous, current, delta, inventory);
  const canonical = canonicalDecisions(decisions);
  preflightMutationAuthorities(context, canonical, impactClosure, runStates);
  const readSet = compatibilityReadSet(previous, current, references, inventory, runStates);
  const mutationPlan = compatibilityMutationPlan(canonical, runStates);
  return { previous, current, delta, references, inventory, runStates, impactClosure,
    canonical, projectDecisions, readSet, mutationPlan };
}

async function classifyContractCompatibilityIdempotently(
  context: ContractCompatibilityContext,
  delta: ContractDelta,
  reference: ContractReference,
): Promise<CompatibilityDecision> {
  const identity = compatibilityClassificationIdentity(delta, reference);
  const load = requireAuthority(
    context.loadCompatibilityClassificationResult,
    'COMPATIBILITY_CLASSIFICATION_REPLAY_AUTHORITY_REQUIRED',
  );
  const transaction = requireAuthority(
    context.withCompatibilityClassificationTransaction,
    'COMPATIBILITY_CLASSIFICATION_TRANSACTION_AUTHORITY_REQUIRED',
  );
  const replay = await load(identity);
  if (replay !== null) return assertCompatibilityClassificationReplay(replay, delta, reference);
  return transaction(identity, async () => {
    const lockedReplay = await load(identity);
    if (lockedReplay !== null) return assertCompatibilityClassificationReplay(lockedReplay, delta, reference);
    return classifyContractCompatibility(context, delta, reference);
  });
}

function compatibilityClassificationIdentity(
  delta: ContractDelta,
  reference: ContractReference,
): CompatibilityClassificationIdentity {
  const identity = {
    previous: delta.previous,
    current: delta.current,
    deltaHash: delta.contentHash,
    reference,
  };
  return { ...identity, contentHash: hashObject(identity) };
}

function assertCompatibilityClassificationReplay(
  value: unknown,
  delta: ContractDelta,
  reference: ContractReference,
): CompatibilityDecision {
  const parsed = compatibilityDecisionSchema.safeParse(value);
  if (!parsed.success) throw new Error('COMPATIBILITY_CLASSIFICATION_REPLAY_INVALID');
  const item = parsed.data as CompatibilityDecision;
  const affectedElements = intersection(delta.elements.map((change) => change.id), reference.usedElements);
  const affectedScenarios = intersection(delta.scenarios.map((change) => change.id), reference.usedScenarios);
  if (item.project !== reference.project || item.deltaHash !== delta.contentHash ||
      stableJson(item.reference) !== stableJson(reference) ||
      stableJson(item.affectedElements) !== stableJson(affectedElements) ||
      stableJson(item.affectedScenarios) !== stableJson(affectedScenarios) ||
      item.fingerprint !== decision(
        item.disposition,
        reference,
        affectedElements,
        affectedScenarios,
        item.evidenceRefs,
        delta,
      ).fingerprint) {
    throw new Error('COMPATIBILITY_CLASSIFICATION_REPLAY_INVALID');
  }
  return item;
}

async function applyPreparedContractRevalidation(
  context: ContractCompatibilityContext,
  previousId: string,
  currentId: string,
  prepared: PreparedContractRevalidation,
): Promise<RevalidationResult> {
    const { previous, current, delta, runStates, impactClosure, canonical, projectDecisions, mutationPlan } = prepared;
    const compatibilityEvidenceRefs: string[] = [];
    const preservedPatches: CapturedPatchRef[] = [];
    const preservedPatchRefs: string[] = [];
    const recoveryRuns: RecoveryRunRef[] = [];
    const recoveredTasks = new Set<string>();
    const directlyStaledRuns = new Set<string>();
    const attentionItems: CompatibilityAttentionRef[] = [];

    for (const selected of canonical) {
    const project = selected.project;
    const input = { previous, current, delta, reference: selected.reference, decision: selected };
    if (selected.disposition === 'COMPATIBLE') {
      if (selected.reference.commit === undefined) continue;
      const evidence = parseCompatibilityEvidenceReceipt(await requireAuthority(
        context.recordCompatibilityEvidence,
        'COMPATIBILITY_EVIDENCE_AUTHORITY_REQUIRED',
      )(input), input);
      const persistedEvidence = await readVerificationEvidence(context, evidence.id);
      if (stableJson(persistedEvidence) !== stableJson(evidence)) {
        throw new Error('COMPATIBILITY_EVIDENCE_RECEIPT_NOT_PERSISTED');
      }
      compatibilityEvidenceRefs.push(evidence.id);
      continue;
    }
    if (selected.disposition === 'INCOMPATIBLE') {
      const runState = requireRunState(runStates, selected.reference.runId);
      const active = isActiveRun(runState) && selected.reference.commit === undefined;
      const mutable = active && isMutableWriterRun(runState);
      const committed = selected.reference.commit !== undefined;
      if (mutable) {
        const captured = capturedPatchSchema.parse(await requireAuthority(
          context.captureUncommittedRunPatch,
          'UNCOMMITTED_PATCH_CAPTURE_AUTHORITY_REQUIRED',
        )(input));
        if (captured.runId !== selected.reference.runId) {
          throw new Error(`UNCOMMITTED_PATCH_RUN_MISMATCH:${selected.reference.runId}`);
        }
        const persistedPatch = capturedPatchSchema.parse(await requireAuthority(
          context.loadCapturedRunPatch,
          'UNCOMMITTED_PATCH_STORE_AUTHORITY_REQUIRED',
        )(captured));
        if (stableJson(persistedPatch) !== stableJson(captured)) {
          throw new Error(`UNCOMMITTED_PATCH_NOT_PERSISTED:${selected.reference.runId}`);
        }
        preservedPatches.push(captured);
        preservedPatchRefs.push(captured.patchRef);
      }
      if (active) {
        await requireAuthority(context.markRunStale, 'RUN_STALE_AUTHORITY_REQUIRED')(input);
        directlyStaledRuns.add(selected.reference.runId);
      }
      if (committed) {
        await requireAuthority(
          context.markCommittedWorkNeedsRevalidation,
          'COMMIT_REVALIDATION_AUTHORITY_REQUIRED',
        )(input);
      }
      const taskKey = scopedTaskKey(selected.reference);
      if ((mutable || committed) && !recoveredTasks.has(taskKey)) {
        const recovery = recoveryRunRefSchema.parse(await requireAuthority(
          context.createRecoveryRun,
          'RECOVERY_RUN_AUTHORITY_REQUIRED',
        )(input));
        await assertRecoveryRunReceipt(context, recovery, input);
        recoveryRuns.push(recovery);
        recoveredTasks.add(taskKey);
      }
      continue;
    }
    const item = compatibilityAttentionRefSchema.parse(await requireAuthority(
      context.createCompatibilityAttention,
      'COMPATIBILITY_ATTENTION_AUTHORITY_REQUIRED',
    )({ ...input, fingerprint: selected.fingerprint })) as CompatibilityAttentionRef;
    if (item.project !== project || item.fingerprint !== selected.fingerprint ||
        !sameContractRef(item.previous, delta.previous) || !sameContractRef(item.current, delta.current) ||
        item.deltaHash !== delta.contentHash || stableJson(item.reference) !== stableJson(selected.reference)) {
      throw new Error(`COMPATIBILITY_ATTENTION_IDENTITY_MISMATCH:${project}`);
    }
    const persistedAttention = compatibilityAttentionRefSchema.parse(await requireAuthority(
      context.loadCompatibilityAttention,
      'COMPATIBILITY_ATTENTION_STORE_AUTHORITY_REQUIRED',
    )(item.id));
    if (stableJson(persistedAttention) !== stableJson(item)) {
      throw new Error(`COMPATIBILITY_ATTENTION_NOT_PERSISTED:${item.id}`);
    }
    attentionItems.push(item);
    }

    const invalidatedTestCases: string[] = [];
    const invalidatedVerificationPlans: string[] = [];
    const invalidatedEnvironmentInputs: string[] = [];
    for (const affected of impactClosure.affected) {
      switch (invalidationActionFor(affected.kind)) {
        case 'RECOMPILE_PLAN':
          if (affected.kind === 'TEST_CASE') {
            await requireAuthority(
              context.invalidateTestCase,
              'TEST_CASE_INVALIDATION_AUTHORITY_REQUIRED',
            )(affected.ref, delta);
            invalidatedTestCases.push(affected.ref);
          } else {
            await requireAuthority(
              context.invalidateVerificationPlan,
              'VERIFICATION_PLAN_INVALIDATION_AUTHORITY_REQUIRED',
            )(affected.ref, delta);
            invalidatedVerificationPlans.push(affected.ref);
          }
          break;
        case 'BLOCK_OR_SUPERSEDE':
          await requireAuthority(
            context.markWaveMemberBlocked,
            'WAVE_MEMBER_INVALIDATION_AUTHORITY_REQUIRED',
          )(affected.ref, delta);
          break;
        case 'MARK_STALE':
          if (!directlyStaledRuns.has(affected.ref) &&
              isActiveRun(requireRunState(runStates, affected.ref))) {
            await requireAuthority(
              context.markImpactRunStale,
              'IMPACT_RUN_STALE_AUTHORITY_REQUIRED',
            )(affected.ref, delta);
          }
          break;
        case 'REQUIRE_RERUN':
          await requireAuthority(
            context.invalidateEnvironmentEvidence,
            'ENVIRONMENT_EVIDENCE_INVALIDATION_AUTHORITY_REQUIRED',
          )(affected.ref, delta);
          invalidatedEnvironmentInputs.push(affected.ref);
          break;
        case 'REQUIRE_REVALIDATION':
          await requireAuthority(
            context.markCommitSetNeedsRevalidation,
            'COMMITSET_REVALIDATION_AUTHORITY_REQUIRED',
          )(affected.ref, delta);
          break;
        case 'RECOMPUTE_CLOSURE':
          break;
      }
    }

    await requireAuthority(
      context.supersedeContractSnapshot,
      'CONTRACT_SUPERSEDE_TRANSACTION_AUTHORITY_REQUIRED',
    )(previousId, currentId);

    const result = {
      mutationIdentity: {
        previous: delta.previous,
        current: delta.current,
        readSetHash: prepared.readSet.contentHash,
        deltaHash: delta.contentHash,
        impactClosureHash: impactClosure.contentHash,
      },
      readSet: prepared.readSet,
      mutationPlan,
      delta,
      impactClosure,
      decisions: canonical,
      compatibleProjects: projectsWith(projectDecisions, 'COMPATIBLE'),
      incompatibleProjects: projectsWith(projectDecisions, 'INCOMPATIBLE'),
      unresolvedProjects: projectsWith(projectDecisions, 'UNRESOLVED'),
      compatibilityEvidenceRefs: canonicalStrings(compatibilityEvidenceRefs),
      recoveryRuns: [...recoveryRuns].sort((left, right) =>
        compare(recoveryRunSortKey(left), recoveryRunSortKey(right))),
      attentionItems: [...attentionItems].sort((left, right) => compare(left.fingerprint, right.fingerprint)),
      preservedPatches: [...preservedPatches].sort((left, right) => compare(left.runId, right.runId)),
      preservedPatchRefs: canonicalStrings(preservedPatchRefs),
      invalidatedTestCases: canonicalStrings(invalidatedTestCases),
      invalidatedVerificationPlans: canonicalStrings(invalidatedVerificationPlans),
      invalidatedEnvironmentInputs: canonicalStrings(invalidatedEnvironmentInputs),
    };
    return { ...result, contentHash: hashObject(result) };
}

function preflightMutationAuthorities(
  context: ContractCompatibilityContext,
  decisions: readonly CompatibilityDecision[],
  impactClosure: ImpactClosure,
  runStates: ReadonlyMap<string, RunState>,
): void {
  requireAuthority(
    context.withCompatibilityMutationTransaction,
    'COMPATIBILITY_MUTATION_TRANSACTION_AUTHORITY_REQUIRED',
  );
  requireAuthority(
    context.supersedeContractSnapshot,
    'CONTRACT_SUPERSEDE_TRANSACTION_AUTHORITY_REQUIRED',
  );
  if (context.listContractReferences !== undefined ||
      context.loadCompatibilityImpactInventory !== undefined || context.loadRunState !== undefined) {
    requireAuthority(
      context.assertCompatibilityReadSetCurrent,
      'COMPATIBILITY_READ_SET_AUTHORITY_REQUIRED',
    );
  }
  for (const decision of decisions) {
    if (decision.disposition === 'COMPATIBLE') {
      if (decision.reference.commit !== undefined) {
        requireAuthority(context.recordCompatibilityEvidence, 'COMPATIBILITY_EVIDENCE_AUTHORITY_REQUIRED');
        requireAuthority(
          context.loadVerificationEvidence,
          'VERIFICATION_EVIDENCE_STORE_AUTHORITY_REQUIRED',
        );
      }
    } else if (decision.disposition === 'INCOMPATIBLE') {
      const runState = requireRunState(runStates, decision.reference.runId);
      const active = isActiveRun(runState) && decision.reference.commit === undefined;
      const mutable = active && isMutableWriterRun(runState);
      const committed = decision.reference.commit !== undefined;
      if (mutable) {
        requireAuthority(
          context.captureUncommittedRunPatch,
          'UNCOMMITTED_PATCH_CAPTURE_AUTHORITY_REQUIRED',
        );
        requireAuthority(context.loadCapturedRunPatch, 'UNCOMMITTED_PATCH_STORE_AUTHORITY_REQUIRED');
      }
      if (active) requireAuthority(context.markRunStale, 'RUN_STALE_AUTHORITY_REQUIRED');
      if (committed) {
        requireAuthority(
          context.markCommittedWorkNeedsRevalidation,
          'COMMIT_REVALIDATION_AUTHORITY_REQUIRED',
        );
      }
      if (mutable || committed) {
        requireAuthority(context.createRecoveryRun, 'RECOVERY_RUN_AUTHORITY_REQUIRED');
        requireAuthority(context.loadRecoveryRunPacket, 'RECOVERY_RUN_PACKET_STORE_AUTHORITY_REQUIRED');
        requireAuthority(context.loadRecoveryRunLinkage, 'RECOVERY_RUN_LINKAGE_STORE_AUTHORITY_REQUIRED');
      }
    } else {
      requireAuthority(
        context.createCompatibilityAttention,
        'COMPATIBILITY_ATTENTION_AUTHORITY_REQUIRED',
      );
      requireAuthority(
        context.loadCompatibilityAttention,
        'COMPATIBILITY_ATTENTION_STORE_AUTHORITY_REQUIRED',
      );
    }
  }
  const kinds = new Set(impactClosure.affected.map((item) => item.kind));
  if (kinds.has('TEST_CASE')) {
    requireAuthority(context.invalidateTestCase, 'TEST_CASE_INVALIDATION_AUTHORITY_REQUIRED');
  }
  if (kinds.has('WAVE_MEMBER')) {
    requireAuthority(context.markWaveMemberBlocked, 'WAVE_MEMBER_INVALIDATION_AUTHORITY_REQUIRED');
  }
  const directlyStaledRunIds = new Set(decisions
    .filter((decision) => decision.disposition === 'INCOMPATIBLE' &&
      decision.reference.commit === undefined && isActiveRun(requireRunState(runStates, decision.reference.runId)))
    .map((decision) => decision.reference.runId));
  if (kinds.has('RUN') && impactClosure.affected.some((item) =>
    item.kind === 'RUN' && !directlyStaledRunIds.has(item.ref) &&
    isActiveRun(requireRunState(runStates, item.ref)))) {
    requireAuthority(context.markImpactRunStale, 'IMPACT_RUN_STALE_AUTHORITY_REQUIRED');
  }
  if (kinds.has('COMMITSET')) {
    requireAuthority(context.markCommitSetNeedsRevalidation, 'COMMITSET_REVALIDATION_AUTHORITY_REQUIRED');
  }
  if (kinds.has('VERIFICATION_PLAN')) {
    requireAuthority(
      context.invalidateVerificationPlan,
      'VERIFICATION_PLAN_INVALIDATION_AUTHORITY_REQUIRED',
    );
  }
  if (kinds.has('ENVIRONMENT_INPUT')) {
    requireAuthority(
      context.invalidateEnvironmentEvidence,
      'ENVIRONMENT_EVIDENCE_INVALIDATION_AUTHORITY_REQUIRED',
    );
  }
}

function assertComparableSnapshots(previous: ContractSnapshot, current: ContractSnapshot): void {
  if (previous.manifest.id === current.manifest.id) throw new Error('CONTRACT_DELTA_IDENTICAL_SNAPSHOT');
  if (previous.manifest.contractKey !== current.manifest.contractKey ||
      previous.manifest.scopeHash !== current.manifest.scopeHash) {
    throw new Error('CONTRACT_DELTA_SCOPE_MISMATCH');
  }
  if (current.manifest.previousSnapshot !== previous.manifest.id) {
    throw new Error('CONTRACT_DELTA_LINEAGE_MISMATCH');
  }
}

function contractRef(snapshot: ContractSnapshot): ContractRef {
  return { id: snapshot.manifest.id, contentHash: snapshot.manifest.contentHash };
}

function compareByIdentity<T>(
  previous: readonly T[],
  current: readonly T[],
  identity: (item: T) => string,
  classify: (previous: T, current: T) => {
    readonly compatibility: ContractChangeCompatibility;
    readonly changedPaths: readonly string[];
  },
): ContractDeltaEntry[] {
  const previousById = new Map(previous.map((item) => [identity(item), item]));
  const currentById = new Map(current.map((item) => [identity(item), item]));
  const entries: ContractDeltaEntry[] = [];
  for (const id of canonicalStrings([...previousById.keys(), ...currentById.keys()])) {
    const oldValue = previousById.get(id);
    const newValue = currentById.get(id);
    if (oldValue === undefined) {
      entries.push({
        id,
        kind: 'ADDED',
        compatibility: 'ADDITIVE',
        previousContentHash: null,
        currentContentHash: hashObject(newValue),
        changedPaths: ['$'],
      });
      continue;
    }
    if (newValue === undefined) {
      entries.push({
        id,
        kind: 'REMOVED',
        compatibility: 'BREAKING',
        previousContentHash: hashObject(oldValue),
        currentContentHash: null,
        changedPaths: ['$'],
      });
      continue;
    }
    const previousContentHash = hashObject(oldValue);
    const currentContentHash = hashObject(newValue);
    if (previousContentHash === currentContentHash) continue;
    const classification = classify(oldValue, newValue);
    if (classification.changedPaths.length === 0) continue;
    entries.push({
      id,
      kind: 'CHANGED',
      compatibility: classification.compatibility,
      previousContentHash,
      currentContentHash,
      changedPaths: canonicalStrings(classification.changedPaths),
    });
  }
  return entries;
}

function classifyElementChange(
  previous: ContractCandidate['contract']['elements'][number],
  current: ContractCandidate['contract']['elements'][number],
): { compatibility: ContractChangeCompatibility; changedPaths: readonly string[] } {
  const paths: string[] = [];
  let compatibility: ContractChangeCompatibility = 'ADDITIVE';
  if (previous.kind !== current.kind || previous.ownerProject !== current.ownerProject) {
    compatibility = 'BREAKING';
    paths.push('kind-or-owner');
  } else if (previous.name !== current.name) {
    compatibility = 'AMBIGUOUS';
    paths.push('name');
  }
  const definition = classifyDefinition(previous.definition, current.definition, 'definition');
  compatibility = strongestCompatibility(compatibility, definition.compatibility);
  paths.push(...definition.changedPaths);
  if (stableJson(previous.sourceRefs) !== stableJson(current.sourceRefs)) paths.push('sourceRefs');
  return { compatibility, changedPaths: paths };
}

function classifyScenarioChange(
  previous: ContractCandidate['businessScenarios'][number],
  current: ContractCandidate['businessScenarios'][number],
): { compatibility: ContractChangeCompatibility; changedPaths: readonly string[] } {
  const paths = changedObjectKeys(previous, current);
  if (previous.expectedOutcome !== current.expectedOutcome &&
      (['FAILURE', 'RETRY'].includes(previous.class) || ['FAILURE', 'RETRY'].includes(current.class))) {
    return { compatibility: 'BREAKING', changedPaths: paths };
  }
  if (previous.class !== current.class ||
      stableJson(previous.contractElementRefs) !== stableJson(current.contractElementRefs) ||
      stableJson(previous.fixtureRefs) !== stableJson(current.fixtureRefs) ||
      stableJson(previous.executorRefs) !== stableJson(current.executorRefs)) {
    return { compatibility: 'BREAKING', changedPaths: paths };
  }
  if (previous.expectedOutcome !== current.expectedOutcome || previous.title !== current.title) {
    return { compatibility: 'AMBIGUOUS', changedPaths: paths };
  }
  return { compatibility: 'ADDITIVE', changedPaths: paths };
}

function classifyDefinition(
  previous: unknown,
  current: unknown,
  path: string,
): { compatibility: ContractChangeCompatibility; changedPaths: readonly string[] } {
  if (stableJson(previous) === stableJson(current)) return { compatibility: 'ADDITIVE', changedPaths: [] };
  if (!isRecord(previous) || !isRecord(current)) {
    return { compatibility: 'BREAKING', changedPaths: [path] };
  }
  let compatibility: ContractChangeCompatibility = 'ADDITIVE';
  const changedPaths: string[] = [];
  if (previous.type !== current.type) {
    compatibility = 'BREAKING';
    changedPaths.push(`${path}.type`);
  }
  const previousRequired = stringSet(previous.required);
  const currentRequired = stringSet(current.required);
  if ([...currentRequired].some((item) => !previousRequired.has(item))) {
    compatibility = 'BREAKING';
    changedPaths.push(`${path}.required`);
  } else if (stableJson([...previousRequired].sort()) !== stableJson([...currentRequired].sort())) {
    changedPaths.push(`${path}.required`);
  }
  const previousProperties = isRecord(previous.properties) ? previous.properties : {};
  const currentProperties = isRecord(current.properties) ? current.properties : {};
  for (const property of canonicalStrings([...Object.keys(previousProperties), ...Object.keys(currentProperties)])) {
    if (!(property in currentProperties)) {
      compatibility = 'BREAKING';
      changedPaths.push(`${path}.properties.${property}`);
      continue;
    }
    if (!(property in previousProperties)) {
      compatibility = strongestCompatibility(
        compatibility,
        currentRequired.has(property) ? 'BREAKING' : 'ADDITIVE',
      );
      changedPaths.push(`${path}.properties.${property}`);
      continue;
    }
    const nested = classifyDefinition(
      previousProperties[property],
      currentProperties[property],
      `${path}.properties.${property}`,
    );
    compatibility = strongestCompatibility(compatibility, nested.compatibility);
    changedPaths.push(...nested.changedPaths);
  }
  for (const semanticKey of ['errors', 'messageKey', 'delivery', 'order', 'retry', 'idempotency']) {
    if (stableJson(previous[semanticKey]) !== stableJson(current[semanticKey])) {
      compatibility = 'BREAKING';
      changedPaths.push(`${path}.${semanticKey}`);
    }
  }
  const enumClassification = classifyEnumConstraint(previous.enum, current.enum);
  if (enumClassification !== undefined) {
    compatibility = strongestCompatibility(compatibility, enumClassification);
    changedPaths.push(`${path}.enum`);
  }
  for (const key of ['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties'] as const) {
    const classification = classifyLowerBound(previous[key], current[key]);
    if (classification !== undefined) {
      compatibility = strongestCompatibility(compatibility, classification);
      changedPaths.push(`${path}.${key}`);
    }
  }
  for (const key of ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties'] as const) {
    const classification = classifyUpperBound(previous[key], current[key]);
    if (classification !== undefined) {
      compatibility = strongestCompatibility(compatibility, classification);
      changedPaths.push(`${path}.${key}`);
    }
  }
  for (const key of ['pattern', 'format', 'const', 'additionalProperties', 'nullable'] as const) {
    if (stableJson(previous[key]) !== stableJson(current[key])) {
      compatibility = strongestCompatibility(compatibility, 'BREAKING');
      changedPaths.push(`${path}.${key}`);
    }
  }
  const handled = new Set([
    'type', 'required', 'properties', 'errors', 'messageKey', 'delivery', 'order', 'retry', 'idempotency',
    'enum', 'minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties',
    'maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties',
    'pattern', 'format', 'const', 'additionalProperties', 'nullable',
  ]);
  const otherChanged = changedObjectKeys(previous, current).filter((key) => !handled.has(key));
  if (otherChanged.length > 0) {
    compatibility = strongestCompatibility(compatibility, 'AMBIGUOUS');
    changedPaths.push(...otherChanged.map((key) => `${path}.${key}`));
  }
  return { compatibility, changedPaths: canonicalStrings(changedPaths) };
}

function classifyEnumConstraint(
  previous: unknown,
  current: unknown,
): ContractChangeCompatibility | undefined {
  if (stableJson(previous) === stableJson(current)) return undefined;
  if (Array.isArray(previous) && current === undefined) return 'ADDITIVE';
  if (previous === undefined && Array.isArray(current)) return 'BREAKING';
  if (!Array.isArray(previous) || !Array.isArray(current)) return 'BREAKING';
  const previousValues = new Set(previous.map(stableJson));
  const currentValues = new Set(current.map(stableJson));
  if (previousValues.size === currentValues.size &&
      [...previousValues].every((value) => currentValues.has(value))) return undefined;
  return [...previousValues].every((value) => currentValues.has(value)) ? 'ADDITIVE' : 'BREAKING';
}

function classifyLowerBound(
  previous: unknown,
  current: unknown,
): ContractChangeCompatibility | undefined {
  if (previous === current) return undefined;
  if (typeof current !== 'number') return typeof previous === 'number' ? 'ADDITIVE' : 'BREAKING';
  if (typeof previous !== 'number') return 'BREAKING';
  return current <= previous ? 'ADDITIVE' : 'BREAKING';
}

function classifyUpperBound(
  previous: unknown,
  current: unknown,
): ContractChangeCompatibility | undefined {
  if (previous === current) return undefined;
  if (typeof current !== 'number') return typeof previous === 'number' ? 'ADDITIVE' : 'BREAKING';
  if (typeof previous !== 'number') return 'BREAKING';
  return current >= previous ? 'ADDITIVE' : 'BREAKING';
}

function strongestCompatibility(
  left: ContractChangeCompatibility,
  right: ContractChangeCompatibility,
): ContractChangeCompatibility {
  const weight: Record<ContractChangeCompatibility, number> = { ADDITIVE: 0, AMBIGUOUS: 1, BREAKING: 2 };
  return weight[left] >= weight[right] ? left : right;
}

function changedObjectKeys(previous: object, current: object): string[] {
  const left = previous as Record<string, unknown>;
  const right = current as Record<string, unknown>;
  return canonicalStrings([...Object.keys(left), ...Object.keys(right)])
    .filter((key) => stableJson(left[key]) !== stableJson(right[key]));
}

function decision(
  disposition: CompatibilityDisposition,
  reference: ContractReference,
  affectedElements: readonly string[],
  affectedScenarios: readonly string[],
  evidenceRefs: readonly string[],
  delta: ContractDelta,
): CompatibilityDecision {
  const identity = {
    disposition,
    project: reference.project,
    reference,
    affectedElements: canonicalStrings(affectedElements),
    affectedScenarios: canonicalStrings(affectedScenarios),
    evidenceRefs: canonicalStrings(evidenceRefs),
    deltaHash: delta.contentHash,
  };
  return { ...identity, fingerprint: hashObject(identity) };
}

async function canonicalValidatorEvidence(
  context: ContractCompatibilityContext,
  evidence: readonly unknown[],
  delta: ContractDelta,
  reference: ContractReference,
  previous: ContractSnapshot,
  current: ContractSnapshot,
): Promise<CompatibilityValidatorEvidence[]> {
  const parsed = evidence.map((item) => {
    const result = compatibilityValidatorEvidenceSchema.safeParse(item);
    if (!result.success) throw new Error('COMPATIBILITY_VALIDATOR_EVIDENCE_INVALID');
    return result.data as CompatibilityValidatorEvidence;
  });
  const valid = parsed.filter((item) =>
    sameContractRef(item.previous, delta.previous) &&
    sameContractRef(item.current, delta.current) &&
    item.project === reference.project &&
    stableJson(canonicalStrings(item.usedElements)) === stableJson(reference.usedElements) &&
    stableJson(canonicalStrings(item.usedScenarios)) === stableJson(reference.usedScenarios));
  for (const item of valid) {
    const persisted = await readVerificationEvidence(context, item.evidenceRef);
    if (stableJson(persisted) !== stableJson(item.evidence)) {
      throw new Error('COMPATIBILITY_VALIDATOR_EVIDENCE_NOT_PERSISTED');
    }
    assertPersistedCompatibilityEvidence(item, delta, reference, previous, current, true);
  }
  return uniqueBy(valid, (item) => item.evidenceRef);
}

function assertPersistedCompatibilityEvidence(
  item: CompatibilityValidatorEvidence,
  delta: ContractDelta,
  reference: ContractReference,
  previous?: ContractSnapshot,
  current?: ContractSnapshot,
  requireUseBinding = false,
): void {
  const evidence = item.evidence;
  if (evidence.id !== item.evidenceRef || evidence.status !== item.status) {
    throw new Error('COMPATIBILITY_VALIDATOR_EVIDENCE_IDENTITY_MISMATCH');
  }
  if (evidence.subject.kind !== 'COMPATIBILITY' ||
      evidence.runId !== reference.runId ||
      evidence.subject.project !== reference.project ||
      !sameContractRef(evidence.subject.contractSnapshot, delta.current) ||
      reference.commit === undefined || evidence.subject.commit !== reference.commit) {
    throw new Error('COMPATIBILITY_VALIDATOR_EVIDENCE_SUBJECT_MISMATCH');
  }
  if (stableJson(canonicalContractRefs(evidence.contractRefs)) !==
      stableJson(canonicalContractRefs([delta.previous, delta.current]))) {
    throw new Error('COMPATIBILITY_VALIDATOR_EVIDENCE_CONTRACT_MISMATCH');
  }
  if (requireUseBinding) {
    if (previous === undefined || current === undefined || !('testCaseRefs' in evidence)) {
      throw new Error('COMPATIBILITY_VALIDATOR_EVIDENCE_USE_MISMATCH');
    }
    const exactContracts = [delta.previous, delta.current];
    const scenarioIds = canonicalStrings(evidence.testCaseRefs.flatMap((testCase) => {
      const scope = testCase.scope;
      return scope.kind === 'CONTRACT' && exactContracts.some((ref) =>
        sameContractRef(scope.contractSnapshot, ref))
        ? [scope.scenarioId]
        : [];
    }));
    const scenarios = [...previous.candidate.businessScenarios, ...current.candidate.businessScenarios]
      .filter((scenario) => scenarioIds.includes(scenario.id));
    const elementIds = canonicalStrings(scenarios.flatMap((scenario) => scenario.contractElementRefs));
    if (stableJson(scenarioIds) !== stableJson(reference.usedScenarios) ||
        stableJson(elementIds) !== stableJson(reference.usedElements)) {
      throw new Error('COMPATIBILITY_VALIDATOR_EVIDENCE_USE_MISMATCH');
    }
  }
}

function parseCompatibilityEvidenceReceipt(
  value: unknown,
  input: CompatibilityMutationInput,
): VerificationEvidence {
  const parsed = verificationEvidenceSchema.safeParse(value);
  if (!parsed.success) throw new Error('COMPATIBILITY_EVIDENCE_RECEIPT_INVALID');
  assertPersistedCompatibilityEvidence({
    status: parsed.data.status,
    evidenceRef: parsed.data.id,
    evidence: parsed.data,
    previous: contractRef(input.previous),
    current: contractRef(input.current),
    project: input.reference.project,
    usedElements: input.reference.usedElements,
    usedScenarios: input.reference.usedScenarios,
  }, input.delta, input.reference);
  if (parsed.data.status !== 'PASS') throw new Error('COMPATIBILITY_EVIDENCE_NOT_PASS');
  return parsed.data;
}

async function readVerificationEvidence(
  context: ContractCompatibilityContext,
  id: string,
): Promise<VerificationEvidence> {
  let value: unknown;
  try {
    value = await requireAuthority(
      context.loadVerificationEvidence,
      'VERIFICATION_EVIDENCE_STORE_AUTHORITY_REQUIRED',
    )(id);
  } catch (error) {
    throw new Error(`COMPATIBILITY_EVIDENCE_NOT_PERSISTED:${id}`, { cause: error });
  }
  const parsed = verificationEvidenceSchema.safeParse(value);
  if (!parsed.success || parsed.data.id !== id) {
    throw new Error(`COMPATIBILITY_EVIDENCE_STORE_INVALID:${id}`);
  }
  return parsed.data;
}

function canonicalReferences(
  references: readonly ContractReference[],
  expectedContract: ContractRef,
): ContractReference[] {
  const merged = new Map<string, ContractReference>();
  for (const rawReference of references) {
    const parsed = contractReferenceSchema.safeParse(rawReference);
    if (!parsed.success) throw new Error('CONTRACT_REFERENCE_INVALID');
    const reference = parsed.data as ContractReference;
    if (!sameContractRef(reference.contract, expectedContract)) {
      throw new Error(`CONTRACT_REFERENCE_SNAPSHOT_MISMATCH:${reference.runId}`);
    }
    const key = contractReferenceKey(reference);
    const existing = merged.get(key);
    if (existing?.commit !== undefined && reference.commit !== undefined &&
        existing.commit !== reference.commit) {
      throw new Error(`CONTRACT_REFERENCE_CONFLICT:commit:${reference.runId}`);
    }
    if (existing?.runKind !== undefined && reference.runKind !== undefined &&
        existing.runKind !== reference.runKind) {
      throw new Error(`CONTRACT_REFERENCE_CONFLICT:runKind:${reference.runId}`);
    }
    merged.set(key, {
      ...reference,
      ...(reference.commit === undefined && existing?.commit !== undefined ? { commit: existing.commit } : {}),
      ...(reference.runKind === undefined && existing?.runKind !== undefined
        ? { runKind: existing.runKind }
        : {}),
      usedElements: canonicalStrings([...(existing?.usedElements ?? []), ...reference.usedElements]),
      usedScenarios: canonicalStrings([...(existing?.usedScenarios ?? []), ...reference.usedScenarios]),
    });
  }
  return [...merged.values()].sort((left, right) => compare(contractReferenceKey(left), contractReferenceKey(right)));
}

function contractReferenceKey(reference: ContractReference): string {
  return stableJson([
    reference.project,
    reference.changeId,
    reference.revision,
    reference.baseline,
    reference.taskId,
    reference.runId,
  ]);
}

async function scanContractReferences(
  context: ContractCompatibilityContext,
  snapshot: ContractSnapshot,
): Promise<ContractReference[]> {
  const references: ContractReference[] = [];
  const runEntries = await directoryEntries(runsRoot(context.home, context.worksetId));
  for (const entry of runEntries.filter((item) => item.isDirectory() && /^RUN-\d{4}$/u.test(item.name))) {
    const path = runPacketPath(context.home, context.worksetId, entry.name);
    if (!(await pathExists(path))) throw new Error(`CONTRACT_REFERENCE_RUN_PACKET_MISSING:${entry.name}`);
    const packet = await loadRunPacket(path);
    references.push(...await packetReferences(context, snapshot, packet));
  }
  const commitSetEntries = await directoryEntries(commitsetsRoot(context.home, context.worksetId));
  for (const entry of commitSetEntries.filter((item) => item.isFile() && /^CST-\d{4}\.yaml$/u.test(item.name))) {
    const id = entry.name.slice(0, -'.yaml'.length);
    const commitSet = await readYaml(commitsetPath(context.home, context.worksetId, id), commitSetSchema);
    for (const member of commitSet.members) {
      if (!member.contracts.some((ref) => sameContractRef(ref, contractRef(snapshot)))) continue;
      const uses = await resolveTestCaseUses(
        context,
        snapshot,
        member.verificationPlan,
        member.testCaseRefs ?? [],
      );
      references.push({
        project: member.project,
        changeId: member.changeId,
        revision: member.revision,
        baseline: member.baseline,
        taskId: member.taskId,
        runId: member.runId,
        runKind: (await readRunState(context, member.runId)).kind,
        ...(member.status === 'INTEGRATED' || member.status === 'NEEDS_REVALIDATION'
          ? { commit: member.commit }
          : {}),
        contract: contractRef(snapshot),
        usedElements: uses.usedElements,
        usedScenarios: uses.usedScenarios,
      });
    }
  }
  return references;
}

async function packetReferences(
  context: ContractCompatibilityContext,
  snapshot: ContractSnapshot,
  packet: RunPacket,
): Promise<ContractReference[]> {
  const expected = contractRef(snapshot);
  if (packet.kind === 'PROJECT_TEST_PLANNER') {
    const scenarios = packet.contractScenarios.filter((item) => sameContractRef(item.snapshot, expected));
    if (scenarios.length === 0) return [];
    const usedElements = canonicalStrings(scenarios.flatMap((item) => item.contractElementRefs.map((ref) => ref.ref)));
    const usedScenarios = canonicalStrings(scenarios.map((item) => item.scenarioId));
    return packet.scopedTasks.map((task) => ({
      ...task,
      runId: packet.id,
      runKind: packet.kind,
      contract: expected,
      usedElements,
      usedScenarios,
    }));
  }
  if (packet.kind !== 'PROJECT_WRITER' && packet.kind !== 'PROJECT_REVIEWER' && packet.kind !== 'RECOVERY_WRITER') {
    return [];
  }
  if (!packet.contracts.some((ref) => sameContractRef(ref, expected))) return [];
  const uses = await resolveTestCaseUses(context, snapshot, packet.verificationPlan, packet.testCaseRefs);
  return [{
    ...packet.scopedTask,
    runId: packet.id,
    runKind: packet.kind,
    contract: expected,
    usedElements: uses.usedElements,
    usedScenarios: uses.usedScenarios,
  }];
}

async function resolveTestCaseUses(
  context: ContractCompatibilityContext,
  snapshot: ContractSnapshot,
  planRef: VerificationPlanRef | undefined,
  refs: readonly TestCaseRef[],
): Promise<{ readonly usedElements: string[]; readonly usedScenarios: string[] }> {
  if (refs.length === 0) return { usedElements: [], usedScenarios: [] };
  if (planRef === undefined) throw new Error('CONTRACT_REFERENCE_VERIFICATION_PLAN_MISSING');
  const planPath = verificationPlanPath(context.home, context.worksetId, planRef.id);
  const inventoryPath = verificationPlanTestCasesPath(context.home, context.worksetId, planRef.id);
  if (!(await pathExists(planPath)) || !(await pathExists(inventoryPath))) {
    throw new Error(`CONTRACT_REFERENCE_TEST_CASE_INVENTORY_MISSING:${planRef.id}`);
  }
  const plan = await readYaml(planPath, verificationPlanSchema);
  if (plan.contentHash !== planRef.contentHash) {
    throw new Error(`CONTRACT_REFERENCE_VERIFICATION_PLAN_STALE:${planRef.id}`);
  }
  const inventory = await readYaml(inventoryPath, testCaseInventorySchema);
  const requested = new Set(refs.map(testCaseRefKey));
  const snapshotRef = contractRef(snapshot);
  const selected = inventory.testCases
    .map((testCase) => ({ testCase, key: testCaseRefKeyForInventory(refs, testCase) }))
    .filter((item) => requested.has(item.key));
  const matched = new Set(selected.map((item) => item.key));
  if (matched.size !== requested.size || [...requested].some((key) => !matched.has(key))) {
    throw new Error(`CONTRACT_REFERENCE_TEST_CASE_REF_MISMATCH:${planRef.id}`);
  }
  const usedScenarios = canonicalStrings(selected
    .map((item) => item.testCase)
    .flatMap((testCase) => testCase.scenarioRefs)
    .filter((scenario) => sameContractRef(scenario.snapshot, snapshotRef))
    .map((scenario) => scenario.scenarioId));
  const scenarios = new Map(snapshot.candidate.businessScenarios.map((scenario) => [scenario.id, scenario]));
  const usedElements = canonicalStrings(usedScenarios.flatMap((scenarioId) =>
    scenarios.get(scenarioId)?.contractElementRefs ?? []));
  return { usedElements, usedScenarios };
}

function testCaseRefKeyForInventory(refs: readonly TestCaseRef[], testCase: TestCase): string {
  const match = refs.find((ref) => ref.id === testCase.id && ref.contentHash === testCase.contentHash);
  return match === undefined ? '' : testCaseRefKey(match);
}

function parseCompatibilityImpactInventory(value: unknown): CompatibilityImpactInventory {
  const parsed = compatibilityImpactInventorySchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`IMPACT_INVENTORY_INVALID:${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }
  return parsed.data as CompatibilityImpactInventory;
}

function assertCompleteCompatibilityImpactInventory(
  inventory: CompatibilityImpactInventory,
  references: readonly ContractReference[],
  previous: ContractSnapshot,
  current: ContractSnapshot,
): void {
  const sources = uniqueInventoryIndex(inventory.sources, sourceRefKey, 'SOURCE');
  const tasks = uniqueInventoryIndex(inventory.tasks, (item) => scopedTaskKey(item.scopedTask), 'TASK');
  const testCases = uniqueInventoryIndex(inventory.testCases, (item) => testCaseRefKey(item.ref), 'TEST_CASE');
  const plans = uniqueInventoryIndex(inventory.verificationPlans, planRefKey, 'VERIFICATION_PLAN');
  const waveMembers = uniqueInventoryIndex(inventory.waveMembers, (item) => item.ref, 'WAVE_MEMBER');
  const runs = uniqueInventoryIndex(inventory.runs, (item) => item.id, 'RUN');
  const environments = uniqueInventoryIndex(inventory.environmentInputs, environmentRefKey, 'ENVIRONMENT_INPUT');
  const commitSets = uniqueInventoryIndex(inventory.commitSets, (item) => item.id, 'COMMITSET');
  const previousRef = contractRef(previous);
  const currentRef = contractRef(current);
  const bindsKnownSnapshot = (refs: readonly ContractRef[]) => refs.some((ref) =>
    sameContractRef(ref, previousRef) || sameContractRef(ref, currentRef));

  for (const reference of references) {
    if (!tasks.has(scopedTaskKey(reference))) {
      throw new Error(`IMPACT_REFERENCE_TASK_MISSING:${reference.taskId}`);
    }
    const run = runs.get(reference.runId);
    if (run === undefined) throw new Error(`IMPACT_REFERENCE_RUN_MISSING:${reference.runId}`);
    if (run.scopedTask !== undefined && scopedTaskKey(run.scopedTask) !== scopedTaskKey(reference)) {
      throw new Error(`IMPACT_REFERENCE_RUN_TASK_MISMATCH:${reference.runId}`);
    }
    if (!run.contractRefs.some((ref) => sameContractRef(ref, reference.contract))) {
      throw new Error(`IMPACT_REFERENCE_RUN_CONTRACT_MISMATCH:${reference.runId}`);
    }
    if (reference.commit !== undefined && ![...commitSets.values()].some((item) =>
      item.memberRunIds.includes(reference.runId))) {
      throw new Error(`IMPACT_REFERENCE_COMMITSET_MISSING:${reference.runId}`);
    }
  }

  for (const item of inventory.tasks) {
    requireInventoryRefs(item.sourceRefs, sources, sourceRefKey, 'TASK_SOURCE');
  }
  for (const item of inventory.testCases) {
    if (item.contentHash !== item.ref.contentHash) {
      throw new Error(`IMPACT_TEST_CASE_HASH_MISMATCH:${item.ref.id}`);
    }
    requireInventoryRefs(item.sourceRefs, sources, sourceRefKey, 'TEST_CASE_SOURCE');
    requireInventoryRefs(item.scopedTasks, tasks, scopedTaskKey, 'TEST_CASE_TASK');
    if (!bindsKnownSnapshot(item.contractRefs)) continue;
    if (item.elementUses.length === 0 && item.scenarioUses.length === 0) {
      throw new Error(`IMPACT_TEST_CASE_USE_MISSING:${item.ref.id}`);
    }
  }
  for (const item of inventory.verificationPlans) {
    requireInventoryRefs(item.testCaseRefs, testCases, testCaseRefKey, 'VERIFICATION_PLAN_TEST_CASE');
    if (bindsKnownSnapshot(item.contractRefs) && item.testCaseRefs.length === 0) {
      throw new Error(`IMPACT_VERIFICATION_PLAN_USE_MISSING:${item.id}`);
    }
  }
  for (const item of inventory.waveMembers) {
    requireInventoryRef(item.scopedTask, tasks, scopedTaskKey, 'WAVE_MEMBER_TASK');
    if (item.verificationPlan !== undefined) {
      requireInventoryRef(item.verificationPlan, plans, planRefKey, 'WAVE_MEMBER_PLAN');
    }
    requireInventoryRefs(item.testCaseRefs, testCases, testCaseRefKey, 'WAVE_MEMBER_TEST_CASE');
  }
  for (const item of inventory.runs) {
    if (item.memberRef !== undefined && !waveMembers.has(item.memberRef)) {
      throw new Error(`IMPACT_RUN_WAVE_MEMBER_MISSING:${item.id}`);
    }
    if (item.scopedTask !== undefined) requireInventoryRef(item.scopedTask, tasks, scopedTaskKey, 'RUN_TASK');
    if (item.verificationPlan !== undefined) {
      requireInventoryRef(item.verificationPlan, plans, planRefKey, 'RUN_PLAN');
    }
    requireInventoryRefs(item.testCaseRefs, testCases, testCaseRefKey, 'RUN_TEST_CASE');
  }
  for (const item of inventory.environmentInputs) {
    requireInventoryRef(item.verificationPlan, plans, planRefKey, 'ENVIRONMENT_PLAN');
    requireInventoryRefs(item.testCaseRefs, testCases, testCaseRefKey, 'ENVIRONMENT_TEST_CASE');
  }
  for (const item of inventory.commitSets) {
    if (item.verificationPlan !== undefined) {
      requireInventoryRef(item.verificationPlan, plans, planRefKey, 'COMMITSET_PLAN');
    }
    requireInventoryRefs(item.memberRunIds, runs, (id) => id, 'COMMITSET_RUN');
    requireInventoryRefs(item.environmentInputRefs, environments, environmentRefKey, 'COMMITSET_ENVIRONMENT');
  }
}

function uniqueInventoryIndex<T>(
  items: readonly T[],
  key: (item: T) => string,
  kind: string,
): Map<string, T> {
  const indexed = new Map<string, T>();
  for (const item of items) {
    const identity = key(item);
    if (indexed.has(identity)) throw new Error(`IMPACT_INVENTORY_DUPLICATE:${kind}:${identity}`);
    indexed.set(identity, item);
  }
  return indexed;
}

function requireInventoryRef<T, R>(
  ref: R,
  indexed: ReadonlyMap<string, T>,
  key: (ref: R) => string,
  relation: string,
): void {
  const identity = key(ref);
  if (!indexed.has(identity)) throw new Error(`IMPACT_INVENTORY_EDGE_MISSING:${relation}:${identity}`);
}

function requireInventoryRefs<T, R>(
  refs: readonly R[],
  indexed: ReadonlyMap<string, T>,
  key: (ref: R) => string,
  relation: string,
): void {
  refs.forEach((ref) => requireInventoryRef(ref, indexed, key, relation));
}

async function loadImpactRunStates(
  context: ContractCompatibilityContext,
  inventory: CompatibilityImpactInventory,
  references: readonly ContractReference[],
): Promise<Map<string, RunState>> {
  const states = new Map<string, RunState>();
  for (const run of inventory.runs) {
    const state = await readRunState(context, run.id);
    if (state.packetHash !== run.contentHash) {
      throw new Error(`IMPACT_RUN_STATE_PACKET_MISMATCH:${run.id}`);
    }
    if (run.scopedTask !== undefined &&
        (state.scopedTask === undefined || scopedTaskKey(state.scopedTask) !== scopedTaskKey(run.scopedTask))) {
      throw new Error(`IMPACT_RUN_STATE_TASK_MISMATCH:${run.id}`);
    }
    states.set(run.id, state);
  }
  for (const reference of references) {
    const state = requireRunState(states, reference.runId);
    if (reference.runKind !== undefined && reference.runKind !== state.kind) {
      throw new Error(`CONTRACT_REFERENCE_RUN_KIND_MISMATCH:${reference.runId}`);
    }
    if ((state.kind === 'PROJECT_WRITER' || state.kind === 'RECOVERY_WRITER') &&
        (state.scopedTask === undefined || scopedTaskKey(state.scopedTask) !== scopedTaskKey(reference))) {
      throw new Error(`CONTRACT_REFERENCE_RUN_TASK_MISMATCH:${reference.runId}`);
    }
    if (reference.commit === undefined && state.status === 'INTEGRATED') {
      throw new Error(`CONTRACT_REFERENCE_COMMIT_MISSING:${reference.runId}`);
    }
    if (reference.commit !== undefined && state.status !== 'INTEGRATED') {
      throw new Error(`CONTRACT_REFERENCE_COMMIT_STATE_MISMATCH:${reference.runId}`);
    }
  }
  return states;
}

function requireRunState(states: ReadonlyMap<string, RunState>, id: string): RunState {
  const state = states.get(id);
  if (state === undefined) throw new Error(`IMPACT_RUN_STATE_MISSING:${id}`);
  return state;
}

function compatibilityReadSet(
  previous: ContractSnapshot,
  current: ContractSnapshot,
  references: readonly ContractReference[],
  inventory: CompatibilityImpactInventory,
  runStates: ReadonlyMap<string, RunState>,
): CompatibilityReadSet {
  const identity = {
    previous: contractRef(previous),
    current: contractRef(current),
    previousStatus: previous.manifest.status,
    currentStatus: current.manifest.status,
    references,
    referencesHash: hashObject(references),
    inventoryHash: hashObject(inventory),
    runStates: [...runStates].sort(([left], [right]) => compare(left, right)).map(([id, state]) => ({
      id,
      state,
      contentHash: hashObject(state),
    })),
  };
  return { ...identity, contentHash: hashObject(identity) };
}

function compatibilityMutationPlan(
  decisions: readonly CompatibilityDecision[],
  runStates: ReadonlyMap<string, RunState>,
): CompatibilityMutationPlan {
  const evidenceDecisionFingerprints: ContentHash[] = [];
  const patchRunIds: string[] = [];
  const recoveries: Array<CompatibilityMutationPlan['recoveries'][number]> = [];
  const attentionDecisionFingerprints: ContentHash[] = [];
  const recoveredTasks = new Set<string>();
  for (const item of canonicalDecisions(decisions)) {
    if (item.disposition === 'COMPATIBLE') {
      if (item.reference.commit !== undefined) evidenceDecisionFingerprints.push(item.fingerprint);
      continue;
    }
    if (item.disposition === 'UNRESOLVED') {
      attentionDecisionFingerprints.push(item.fingerprint);
      continue;
    }
    const state = requireRunState(runStates, item.reference.runId);
    const active = isActiveRun(state) && item.reference.commit === undefined;
    const mutable = active && isMutableWriterRun(state);
    const committed = item.reference.commit !== undefined;
    if (mutable) patchRunIds.push(item.reference.runId);
    const taskKey = scopedTaskKey(item.reference);
    if ((mutable || committed) && !recoveredTasks.has(taskKey)) {
      recoveries.push({
        project: item.project,
        parentRunId: item.reference.runId,
        scopedTask: {
          project: item.reference.project,
          changeId: item.reference.changeId,
          revision: item.reference.revision,
          baseline: item.reference.baseline,
          taskId: item.reference.taskId,
        },
        decisionFingerprint: item.fingerprint,
      });
      recoveredTasks.add(taskKey);
    }
  }
  const identity = {
    evidenceDecisionFingerprints: canonicalStrings(evidenceDecisionFingerprints),
    patchRunIds: canonicalStrings(patchRunIds),
    recoveries: [...recoveries].sort((left, right) => compare(
      recoveryObligationKey(left),
      recoveryObligationKey(right),
    )),
    attentionDecisionFingerprints: canonicalStrings(attentionDecisionFingerprints),
  };
  return { ...identity, contentHash: hashObject(identity) };
}

async function assertCompatibilityReadSetCurrent(
  context: ContractCompatibilityContext,
  prepared: PreparedContractRevalidation,
): Promise<void> {
  const usesCustomStore = context.listContractReferences !== undefined ||
    context.loadCompatibilityImpactInventory !== undefined || context.loadRunState !== undefined;
  if (usesCustomStore) {
    const current = await requireAuthority(
      context.assertCompatibilityReadSetCurrent,
      'COMPATIBILITY_READ_SET_AUTHORITY_REQUIRED',
    )({
      previous: prepared.previous,
      current: prepared.current,
      references: prepared.references,
      inventory: prepared.inventory,
      readSet: prepared.readSet,
    });
    if (!current) throw new CompatibilityReadSetStaleError();
    return;
  }
  const previous = await readSnapshot(context, prepared.previous.manifest.id);
  const current = await readSnapshot(context, prepared.current.manifest.id);
  const references = await findContractReferences(context, previous.manifest.id);
  const inventory = parseCompatibilityImpactInventory(
    await loadFilesystemImpactInventory(context, previous, current),
  );
  assertCompleteCompatibilityImpactInventory(inventory, references, previous, current);
  const runStates = await loadImpactRunStates(context, inventory, references);
  const actual = compatibilityReadSet(previous, current, references, inventory, runStates);
  if (stableJson(actual) !== stableJson(prepared.readSet)) {
    throw new CompatibilityReadSetStaleError();
  }
}

function isActiveRun(state: RunState): boolean {
  return state.status === 'RUNNING' || state.status === 'FINISHED';
}

function isMutableWriterRun(state: RunState): boolean {
  return state.kind === 'PROJECT_WRITER' || state.kind === 'RECOVERY_WRITER';
}

async function assertRecoveryRunReceipt(
  context: ContractCompatibilityContext,
  receipt: RecoveryRunRef,
  input: CompatibilityMutationInput,
  requirePrepared = true,
): Promise<void> {
  if (receipt.project !== input.reference.project ||
      receipt.parentRunId !== input.reference.runId ||
      scopedTaskKey(receipt.scopedTask) !== scopedTaskKey(input.reference) ||
      receipt.decisionFingerprint !== input.decision.fingerprint) {
    throw new Error(`RECOVERY_RUN_LINKAGE_MISMATCH:${input.reference.taskId}`);
  }
  const persistedLinkage = recoveryRunRefSchema.parse(await requireAuthority(
    context.loadRecoveryRunLinkage,
    'RECOVERY_RUN_LINKAGE_STORE_AUTHORITY_REQUIRED',
  )(receipt.runId));
  if (stableJson(persistedLinkage) !== stableJson(receipt)) {
    throw new Error(`RECOVERY_RUN_LINKAGE_NOT_PERSISTED:${receipt.runId}`);
  }
  const rawPacket = await requireAuthority(
    context.loadRecoveryRunPacket,
    'RECOVERY_RUN_PACKET_STORE_AUTHORITY_REQUIRED',
  )(receipt.runId);
  const packet = runPacketSchema.parse(rawPacket);
  if (packet.kind !== 'RECOVERY_WRITER' || packet.id !== receipt.runId ||
      packet.packetHash !== receipt.packetHash || packet.parentRunId !== input.reference.runId ||
      scopedTaskKey(packet.scopedTask) !== scopedTaskKey(input.reference) ||
      !packet.contracts.some((ref) => sameContractRef(ref, input.delta.current)) ||
      packet.contracts.some((ref) => sameContractRef(ref, input.delta.previous))) {
    throw new Error(`RECOVERY_RUN_PACKET_MISMATCH:${receipt.runId}`);
  }
  const state = await readRunState(context, receipt.runId);
  if (state.kind !== 'RECOVERY_WRITER' || (requirePrepared && state.status !== 'PREPARED') ||
      state.parentRunId !== input.reference.runId ||
      state.packetHash !== receipt.packetHash || state.scopedTask === undefined ||
      scopedTaskKey(state.scopedTask) !== scopedTaskKey(input.reference)) {
    throw new Error(`RECOVERY_RUN_STATE_MISMATCH:${receipt.runId}`);
  }
}

function buildCompatibilityImpactClosure(
  context: ContractCompatibilityContext,
  previous: ContractSnapshot,
  current: ContractSnapshot,
  delta: ContractDelta,
  inventory: CompatibilityImpactInventory,
): ImpactClosure {
  const graph = buildImpactGraph(previous, current, delta, inventory);
  const root = contractNode(current);
  const closure = compileImpactClosure({
    worksetId: context.worksetId,
    scopeHash: current.manifest.scopeHash,
    roots: [{ node: root, previousContentHash: previous.manifest.contentHash }],
    nodes: graph.nodes,
    edges: graph.edges,
  });
  return impactClosureSchema.parse(closure);
}

function buildImpactGraph(
  previous: ContractSnapshot,
  current: ContractSnapshot,
  delta: ContractDelta,
  inventory: CompatibilityImpactInventory,
): { readonly nodes: ImpactGraphNode[]; readonly edges: ImpactGraphEdge[] } {
  const nodes: ImpactGraphNode[] = [contractNode(current)];
  const edges: ImpactGraphEdge[] = [];
  const root = contractNode(current);
  const oldRef = contractRef(previous);
  const newRef = contractRef(current);
  const addNode = (node: ImpactGraphNode) => nodes.push(node);
  const addDependency = (
    dependencies: readonly ImpactGraphNode[],
    target: ImpactGraphNode,
  ) => dependencies.forEach((from) => edges.push({ from, to: target }));
  const bindsChangedContract = (refs: readonly ContractRef[]) => refs.some((ref) =>
    sameContractRef(ref, oldRef) || sameContractRef(ref, newRef));

  const sources = inventory.sources.map((item) => node('SOURCE', item.ref, item.contentHash));
  sources.forEach(addNode);
  const sourceByKey = new Map(inventory.sources.map((item, index) => [sourceRefKey(item), sources[index]!]));
  const tasks = inventory.tasks.map((item) => node('TASK', scopedTaskKey(item.scopedTask), item.contentHash));
  tasks.forEach(addNode);
  const taskByKey = new Map(inventory.tasks.map((item, index) => [scopedTaskKey(item.scopedTask), tasks[index]!]));
  inventory.tasks.forEach((item, index) => addDependency(
    item.sourceRefs.map((ref) => sourceByKey.get(sourceRefKey(ref))).filter(isDefined),
    tasks[index]!,
  ));

  const testCases = inventory.testCases.map((item) => node('TEST_CASE', testCaseRefKey(item.ref), item.contentHash));
  testCases.forEach(addNode);
  const testCaseByKey = new Map(inventory.testCases.map((item, index) => [testCaseRefKey(item.ref), testCases[index]!]));
  const changedElementIds = new Set(delta.elements.map((item) => item.id));
  const changedScenarioIds = new Set(delta.scenarios.map((item) => item.id));
  const changedFixtureIds = new Set(delta.fixtures.map((item) => item.id));
  const fixtureAffectedScenarioUses = new Set([
    ...previous.candidate.businessScenarios
      .filter((scenario) => scenario.fixtureRefs.some((ref) => changedFixtureIds.has(ref)))
      .map((scenario) => contractUseKey(oldRef, scenario.id)),
    ...current.candidate.businessScenarios
      .filter((scenario) => scenario.fixtureRefs.some((ref) => changedFixtureIds.has(ref)))
      .map((scenario) => contractUseKey(newRef, scenario.id)),
  ]);
  inventory.testCases.forEach((item, index) => addDependency([
    ...item.sourceRefs.map((ref) => sourceByKey.get(sourceRefKey(ref))).filter(isDefined),
    ...item.scopedTasks.map((task) => taskByKey.get(scopedTaskKey(task))).filter(isDefined),
    ...(bindsChangedContract(item.contractRefs) && (
      delta.compatibilityPolicyChanged ||
      item.elementUses.some((use) =>
        (sameContractRef(use.snapshot, oldRef) || sameContractRef(use.snapshot, newRef)) &&
        changedElementIds.has(use.id)) ||
      item.scenarioUses.some((use) =>
        ((sameContractRef(use.snapshot, oldRef) || sameContractRef(use.snapshot, newRef)) &&
          changedScenarioIds.has(use.id)) || fixtureAffectedScenarioUses.has(contractUseKey(use.snapshot, use.id)))
    ) ? [root] : []),
  ], testCases[index]!));

  const plans = inventory.verificationPlans.map((item) => node('VERIFICATION_PLAN', item.id, item.contentHash));
  plans.forEach(addNode);
  const planByKey = new Map(inventory.verificationPlans.map((item, index) => [planRefKey(item), plans[index]!]));
  inventory.verificationPlans.forEach((item, index) => addDependency([
    ...item.testCaseRefs.map((ref) => testCaseByKey.get(testCaseRefKey(ref))).filter(isDefined),
    ...(bindsChangedContract(item.contractRefs) && item.testCaseRefs.length === 0 ? [root] : []),
  ], plans[index]!));

  const waveMembers = inventory.waveMembers.map((item) => node('WAVE_MEMBER', item.ref, item.contentHash));
  waveMembers.forEach(addNode);
  const waveByRef = new Map(inventory.waveMembers.map((item, index) => [item.ref, waveMembers[index]!]));
  inventory.waveMembers.forEach((item, index) => addDependency([
    taskByKey.get(scopedTaskKey(item.scopedTask)),
    item.verificationPlan === undefined ? undefined : planByKey.get(planRefKey(item.verificationPlan)),
    ...item.testCaseRefs.map((ref) => testCaseByKey.get(testCaseRefKey(ref))),
    ...(bindsChangedContract(item.contractRefs) && item.verificationPlan === undefined &&
      item.testCaseRefs.length === 0 ? [root] : []),
  ].filter(isDefined), waveMembers[index]!));

  const runs = inventory.runs.map((item) => node('RUN', item.id, item.contentHash));
  runs.forEach(addNode);
  const runById = new Map(inventory.runs.map((item, index) => [item.id, runs[index]!]));
  inventory.runs.forEach((item, index) => addDependency([
    item.memberRef === undefined ? undefined : waveByRef.get(item.memberRef),
    item.scopedTask === undefined ? undefined : taskByKey.get(scopedTaskKey(item.scopedTask)),
    item.verificationPlan === undefined ? undefined : planByKey.get(planRefKey(item.verificationPlan)),
    ...item.testCaseRefs.map((ref) => testCaseByKey.get(testCaseRefKey(ref))),
    ...(bindsChangedContract(item.contractRefs) && item.memberRef === undefined &&
      item.verificationPlan === undefined && item.testCaseRefs.length === 0 ? [root] : []),
  ].filter(isDefined), runs[index]!));

  const environments = inventory.environmentInputs.map((item) =>
    node('ENVIRONMENT_INPUT', item.id, item.contentHash));
  environments.forEach(addNode);
  const environmentByKey = new Map(inventory.environmentInputs.map((item, index) => [
    environmentRefKey(item), environments[index]!,
  ]));
  inventory.environmentInputs.forEach((item, index) => addDependency([
    planByKey.get(planRefKey(item.verificationPlan)),
    ...item.testCaseRefs.map((ref) => testCaseByKey.get(testCaseRefKey(ref))),
  ].filter(isDefined), environments[index]!));

  const commitSets = inventory.commitSets.map((item) => node('COMMITSET', item.id, item.contentHash));
  commitSets.forEach(addNode);
  inventory.commitSets.forEach((item, index) => addDependency([
    item.verificationPlan === undefined ? undefined : planByKey.get(planRefKey(item.verificationPlan)),
    ...item.memberRunIds.map((runId) => runById.get(runId)),
    ...item.environmentInputRefs.map((ref) => environmentByKey.get(environmentRefKey(ref))),
  ].filter(isDefined), commitSets[index]!));

  return {
    nodes: uniqueBy(nodes, impactGraphNodeKey),
    edges: uniqueBy(edges, (edge) => `${impactGraphNodeKey(edge.from)}\0${impactGraphNodeKey(edge.to)}`),
  };
}

async function loadFilesystemImpactInventory(
  context: ContractCompatibilityContext,
  previous: ContractSnapshot,
  current: ContractSnapshot,
): Promise<CompatibilityImpactInventory> {
  const snapshotSources = uniqueBy(
    [...previous.sources, ...current.sources].map((source) => ({ ref: source.ref, contentHash: source.contentHash })),
    sourceRefKey,
  );
  const taskMap = await loadCoreImpactTasks(context, previous, current);
  const plans: VerificationPlan[] = [];
  const testCases: TestCase[] = [];
  const planEntries = await directoryEntries(verificationPlansRoot(context.home, context.worksetId));
  for (const entry of planEntries.filter((item) => item.isDirectory() && /^VPL-\d{4}$/u.test(item.name))) {
    const planFile = verificationPlanPath(context.home, context.worksetId, entry.name);
    const inventoryFile = verificationPlanTestCasesPath(context.home, context.worksetId, entry.name);
    if (!(await pathExists(planFile)) || !(await pathExists(inventoryFile))) {
      throw new Error(`IMPACT_VERIFICATION_PLAN_INVENTORY_MISSING:${entry.name}`);
    }
    plans.push(await readYaml(planFile, verificationPlanSchema));
    testCases.push(...(await readYaml(inventoryFile, testCaseInventorySchema)).testCases);
  }
  const testCaseRecords = uniqueBy(testCases, (item) => `${item.id}\0${item.contentHash}`).map((testCase) => ({
    ref: inferInventoryTestCaseRef(plans, testCase),
    contentHash: testCase.contentHash,
    sourceRefs: testCase.sourceRefs,
    scopedTasks: testCase.scopedTasks,
    contractRefs: testCase.contractRefs,
    elementUses: uniqueBy(testCase.scenarioRefs.flatMap((scenarioRef) => {
      const snapshot = sameContractRef(scenarioRef.snapshot, contractRef(previous))
        ? previous
        : sameContractRef(scenarioRef.snapshot, contractRef(current))
          ? current
          : undefined;
      const scenario = snapshot?.candidate.businessScenarios.find((candidate) =>
        candidate.id === scenarioRef.scenarioId);
      return (scenario?.contractElementRefs ?? []).map((id) => ({ snapshot: scenarioRef.snapshot, id }));
    }), (use) => contractUseKey(use.snapshot, use.id)),
    scenarioUses: uniqueBy(testCase.scenarioRefs.map((scenario) => ({
      snapshot: scenario.snapshot,
      id: scenario.scenarioId,
    })), (use) => contractUseKey(use.snapshot, use.id)),
  }));
  const sources = uniqueBy([
    ...snapshotSources,
    ...testCaseRecords.flatMap((testCase) => testCase.sourceRefs),
  ], sourceRefKey);
  const verificationPlanRecords = plans.map((plan) => ({
    id: plan.id,
    contentHash: plan.contentHash,
    contractRefs: plan.contractSnapshots.map((binding) => binding.snapshot),
    testCaseRefs: plan.testCases,
  }));
  const waves = await loadWaves(context);
  const waveMembers = waves.flatMap((wave) => wave.members.map((member) => ({
    ref: waveMemberRef(wave.id, member),
    contentHash: hashObject(member),
    scopedTask: member,
    ...(member.verificationPlan === undefined ? {} : { verificationPlan: member.verificationPlan }),
    testCaseRefs: member.testCaseRefs ?? [],
    contractRefs: member.contracts,
  })));
  const runPackets = await loadRunPackets(context);
  const environmentInputs = await loadEnvironmentInputs(context);
  const commitSets = await loadCommitSets(context);
  for (const wave of waves) {
    for (const member of wave.members) {
      assertCoreImpactTask(taskMap, member, member.contracts, previous, current);
    }
  }
  for (const packet of runPackets) {
    if ('scopedTask' in packet) {
      assertCoreImpactTask(taskMap, packet.scopedTask, packet.contracts, previous, current);
    }
    if ('scopedTasks' in packet) {
      packet.scopedTasks.forEach((task) =>
        assertCoreImpactTask(taskMap, task, packet.contracts, previous, current));
    }
  }
  for (const commitSet of commitSets) {
    for (const member of commitSet.members) {
      assertCoreImpactTask(taskMap, member, member.contracts, previous, current);
    }
  }
  const packetRuns = runPackets.map((packet) => ({
    id: packet.id,
    contentHash: packet.packetHash,
    ...('scopedTask' in packet ? { scopedTask: packet.scopedTask } : {}),
    ...(packet.waveId !== undefined && 'scopedTask' in packet
      ? { memberRef: waveMemberRef(packet.waveId, packet.scopedTask) }
      : {}),
    ...('verificationPlan' in packet && packet.verificationPlan !== undefined
      ? { verificationPlan: packet.verificationPlan }
      : {}),
    testCaseRefs: 'testCaseRefs' in packet ? packet.testCaseRefs ?? [] : [],
    contractRefs: packet.contracts,
  }));
  const packetRunIds = new Set(packetRuns.map((run) => run.id));
  const committedRuns: CompatibilityImpactInventory['runs'][number][] = [];
  for (const member of commitSets.flatMap((commitSet) => commitSet.members)) {
    if (packetRunIds.has(member.runId)) continue;
    const state = await readRunState(context, member.runId);
    const scopedTask = scopedTaskFrom(member);
    if (state.scopedTask === undefined || scopedTaskKey(state.scopedTask) !== scopedTaskKey(scopedTask)) {
      throw new Error(`IMPACT_COMMITSET_RUN_STATE_TASK_MISMATCH:${member.runId}`);
    }
    committedRuns.push({
      id: member.runId,
      contentHash: state.packetHash,
      scopedTask,
      ...(member.verificationPlan === undefined ? {} : { verificationPlan: member.verificationPlan }),
      testCaseRefs: member.testCaseRefs ?? [],
      contractRefs: member.contracts,
    });
  }
  const runs = uniqueBy([...packetRuns, ...committedRuns], (run) => run.id);
  return {
    sources,
    tasks: [...taskMap.values()],
    testCases: testCaseRecords,
    verificationPlans: verificationPlanRecords,
    waveMembers,
    runs,
    environmentInputs: environmentInputs.map(({ id, input }) => ({
      id,
      contentHash: input.inputHash,
      verificationPlan: input.verificationPlan,
      testCaseRefs: input.testCaseRefs,
      contractRefs: input.contractSnapshots.map((binding) => binding.snapshot),
    })),
    commitSets: commitSets.map((commitSet) => ({
      id: commitSet.id,
      contentHash: hashObject(commitSet),
      ...(commitSet.verificationPlan === undefined ? {} : { verificationPlan: commitSet.verificationPlan }),
      memberRunIds: commitSet.members.map((member) => member.runId),
      environmentInputRefs: commitSet.integrationGateRefs.map((gate) => ({ id: gate.id, contentHash: gate.inputHash })),
      contractRefs: commitSet.contractSnapshots.map((binding) => binding.snapshot),
    })),
  };
}

function inferInventoryTestCaseRef(plans: readonly VerificationPlan[], testCase: TestCase): TestCaseRef {
  const matches = uniqueBy(
    plans.flatMap((plan) => plan.testCases)
      .filter((ref) => ref.id === testCase.id && ref.contentHash === testCase.contentHash),
    testCaseRefKey,
  );
  if (matches.length !== 1) throw new Error(`IMPACT_TEST_CASE_REF_AMBIGUOUS:${testCase.id}`);
  return matches[0]!;
}

function scopedTaskFrom(task: ScopedTaskRef): ScopedTaskRef {
  return {
    project: task.project,
    changeId: task.changeId,
    revision: task.revision,
    baseline: task.baseline,
    taskId: task.taskId,
  };
}

async function loadCoreImpactTasks(
  context: ContractCompatibilityContext,
  previous: ContractSnapshot,
  current: ContractSnapshot,
): Promise<Map<string, CompatibilityImpactInventory['tasks'][number]>> {
  const workset = await resolveWorkset(context.home, context.worksetId);
  const tasks = new Map<string, CompatibilityImpactInventory['tasks'][number]>();
  const logicalContractRef = `contract:${previous.manifest.contractKey}`;
  for (const member of workset.members) {
    if (member.worktree === undefined || member.changeId === undefined) continue;
    const change = await resolveChange(member.worktree, member.changeId);
    const taskFile = await loadTasks(
      changeArtifactPath(member.worktree, change.directoryName, 'tasks.yaml'),
    );
    if (taskFile.revision !== change.metadata.activeRevision) {
      throw new Error(`IMPACT_CORE_TASK_REVISION_MISMATCH:${member.project}`);
    }
    for (const task of taskFile.tasks) {
      const scopedTask = scopedTaskRefSchema.parse({
        project: member.project,
        changeId: change.metadata.id,
        revision: change.metadata.activeRevision,
        baseline: change.metadata.baseline,
        taskId: task.id,
      });
      const key = scopedTaskKey(scopedTask);
      if (tasks.has(key)) throw new Error(`IMPACT_CORE_TASK_DUPLICATE:${task.id}`);
      const bindsContract = [...task.consumes, ...task.produces].includes(logicalContractRef);
      tasks.set(key, {
        scopedTask,
        contentHash: hashObject(task),
        sourceRefs: [],
        contractRefs: bindsContract
          ? uniqueBy([contractRef(previous), contractRef(current)], (ref) => stableJson([ref.id, ref.contentHash]))
          : [],
      });
    }
  }
  for (const snapshot of [previous, current]) {
    const expectedContract = contractRef(snapshot);
    for (const participant of snapshot.manifest.participants) {
      if (participant.baseline === undefined) {
        throw new Error(`IMPACT_CONTRACT_PARTICIPANT_BASELINE_MISSING:${participant.project}:${participant.taskId}`);
      }
      const key = scopedTaskKey({ ...participant, baseline: participant.baseline });
      const task = tasks.get(key);
      if (task === undefined) {
        throw new Error(`IMPACT_CONTRACT_PARTICIPANT_TASK_MISSING:${participant.project}:${participant.taskId}`);
      }
      if (!task.contractRefs.some((ref) => sameContractRef(ref, expectedContract))) {
        throw new Error(`IMPACT_CONTRACT_PARTICIPANT_RELATION_MISSING:${participant.project}:${participant.taskId}`);
      }
    }
  }
  return tasks;
}

function assertCoreImpactTask(
  tasks: Map<string, CompatibilityImpactInventory['tasks'][number]>,
  task: ScopedTaskRef,
  contractRefs: readonly ContractRef[],
  previous: ContractSnapshot,
  current: ContractSnapshot,
): void {
  const key = scopedTaskKey(task);
  const existing = tasks.get(key);
  if (existing === undefined) throw new Error(`IMPACT_CORE_TASK_MISSING:${task.taskId}`);
  const knownContractKeys = new Set(existing.contractRefs.map((ref) => stableJson([ref.id, ref.contentHash])));
  const relevantContractIds = new Set([previous.manifest.id, current.manifest.id]);
  if (contractRefs.some((ref) => relevantContractIds.has(ref.id) &&
      !knownContractKeys.has(stableJson([ref.id, ref.contentHash])))) {
    throw new Error(`IMPACT_CORE_TASK_CONTRACT_MISMATCH:${task.taskId}`);
  }
}

async function loadWaves(context: ContractCompatibilityContext): Promise<Wave[]> {
  const values: Wave[] = [];
  for (const entry of (await directoryEntries(wavesRoot(context.home, context.worksetId)))
    .filter((item) => item.isFile() && /^WAVE-\d{4}\.yaml$/u.test(item.name))) {
    const id = entry.name.slice(0, -'.yaml'.length);
    values.push(await readYaml(wavePath(context.home, context.worksetId, id), waveSchema));
  }
  return values;
}

async function loadRunPackets(context: ContractCompatibilityContext): Promise<RunPacket[]> {
  const values: RunPacket[] = [];
  for (const entry of (await directoryEntries(runsRoot(context.home, context.worksetId)))
    .filter((item) => item.isDirectory() && /^RUN-\d{4}$/u.test(item.name))) {
    const path = runPacketPath(context.home, context.worksetId, entry.name);
    if (!(await pathExists(path))) throw new Error(`IMPACT_RUN_PACKET_MISSING:${entry.name}`);
    const packet = await loadRunPacket(path);
    const state = await readRunState(context, entry.name);
    if (state.packetHash !== packet.packetHash || state.kind !== packet.kind) {
      throw new Error(`IMPACT_RUN_PACKET_STATE_MISMATCH:${entry.name}`);
    }
    values.push(packet);
  }
  return values;
}

async function loadEnvironmentInputs(context: ContractCompatibilityContext): Promise<Array<{
  readonly id: string;
  readonly input: IntegrationEnvironmentInput;
}>> {
  const values: Array<{ id: string; input: IntegrationEnvironmentInput }> = [];
  for (const entry of (await directoryEntries(integrationEnvironmentRunsRoot(context.home, context.worksetId)))
    .filter((item) => item.isDirectory() && /^IER-\d{4}$/u.test(item.name))) {
    const path = integrationEnvironmentInputPath(context.home, context.worksetId, entry.name);
    if (!(await pathExists(path))) throw new Error(`IMPACT_ENVIRONMENT_INPUT_MISSING:${entry.name}`);
    values.push({ id: entry.name, input: await readYaml(path, integrationEnvironmentInputSchema) });
  }
  return values;
}

async function loadCommitSets(context: ContractCompatibilityContext): Promise<CommitSet[]> {
  const values: CommitSet[] = [];
  for (const entry of (await directoryEntries(commitsetsRoot(context.home, context.worksetId)))
    .filter((item) => item.isFile() && /^CST-\d{4}\.yaml$/u.test(item.name))) {
    const id = entry.name.slice(0, -'.yaml'.length);
    values.push(await readYaml(commitsetPath(context.home, context.worksetId, id), commitSetSchema));
  }
  return values;
}

async function readSnapshot(context: ContractCompatibilityContext, id: string): Promise<ContractSnapshot> {
  return context.loadContractSnapshot?.(id) ?? loadContractSnapshot(context, id);
}

async function readRunState(context: ContractCompatibilityContext, id: string): Promise<RunState> {
  const value = context.loadRunState === undefined
    ? await readYaml(runStatePath(context.home, context.worksetId, id), runStateSchema)
    : await context.loadRunState(id);
  const parsed = runStateSchema.safeParse(value);
  if (!parsed.success || parsed.data.id !== id || parsed.data.worksetId !== context.worksetId) {
    throw new Error(`COMPATIBILITY_RUN_STATE_INVALID:${id}`);
  }
  return parsed.data;
}

async function readReadySnapshot(
  context: ContractCompatibilityContext,
  id: string,
): Promise<ContractSnapshot> {
  const snapshot = context.loadReadyContractSnapshot === undefined
    ? await loadPersistedReadyContractSnapshot(context, id)
    : await context.loadReadyContractSnapshot(id);
  if (snapshot.manifest.status !== 'READY') {
    throw new Error(`CONTRACT_NOT_READY: ${id}:${snapshot.manifest.status}`);
  }
  if (snapshot.manifest.validationEvidence.length === 0) {
    throw new Error(`CONTRACT_READY_EVIDENCE_MISSING: ${id}`);
  }
  return snapshot;
}

async function assertRevalidationReplay(
  context: ContractCompatibilityContext,
  replay: RevalidationResult,
  previousId: string,
  currentId: string,
): Promise<RevalidationResult> {
  const parsed = revalidationResultSchema.safeParse(replay);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`COMPATIBILITY_MUTATION_REPLAY_INVALID:${previousId}:${currentId}:${
      issue?.path.join('.') ?? 'unknown'}:${issue?.message ?? 'unknown'}`);
  }
  const result = parsed.data as RevalidationResult;
  const { contentHash, ...resultIdentity } = result;
  const { contentHash: readSetHash, ...readSetIdentity } = result.readSet;
  const receipt = compatibilityMutationReceiptSchema.parse(await requireAuthority(
    context.loadCompatibilityMutationReceipt,
    'COMPATIBILITY_MUTATION_RECEIPT_AUTHORITY_REQUIRED',
  )(previousId, currentId));
  const { contentHash: receiptHash, ...receiptIdentity } = receipt;
  const previous = await readSnapshot(context, previousId);
  const current = await readSnapshot(context, currentId);
  const actualDelta = compareContractSnapshots(previous, current);
  const expectedRoot = contractNode(current);
  const root = result.impactClosure.roots[0];
  const canonical = canonicalDecisions(result.decisions);
  const replayRunStates = new Map(result.readSet.runStates.map((entry) => [entry.id, entry.state]));
  let expectedMutationPlan: CompatibilityMutationPlan;
  let canonicalReplayReferences: ContractReference[];
  try {
    expectedMutationPlan = compatibilityMutationPlan(canonical, replayRunStates);
    canonicalReplayReferences = canonicalReferences(
      canonical.map((item) => item.reference),
      actualDelta.previous,
    );
  } catch (error) {
    throw new Error(`COMPATIBILITY_MUTATION_REPLAY_INVALID:${previousId}:${currentId}`, { cause: error });
  }
  const projectDecisions = reduceProjectDecisions(canonical);
  const invalidatedTestCases = canonicalStrings(result.impactClosure.affected
    .filter((item) => item.kind === 'TEST_CASE').map((item) => item.ref));
  const invalidatedPlans = canonicalStrings(result.impactClosure.affected
    .filter((item) => item.kind === 'VERIFICATION_PLAN').map((item) => item.ref));
  const invalidatedEnvironments = canonicalStrings(result.impactClosure.affected
    .filter((item) => item.kind === 'ENVIRONMENT_INPUT').map((item) => item.ref));
  const replayInvalid = hashObject(resultIdentity) !== contentHash ||
    receipt.previousId !== previousId || receipt.currentId !== currentId ||
    receipt.readSetHash !== readSetHash || receipt.resultContentHash !== contentHash ||
    hashObject(receiptIdentity) !== receiptHash ||
    (current.manifest.status !== 'READY' && current.manifest.status !== 'SUPERSEDED') ||
    stableJson(result.delta) !== stableJson(actualDelta) ||
    !sameContractRef(result.mutationIdentity.previous, actualDelta.previous) ||
    !sameContractRef(result.mutationIdentity.current, actualDelta.current) ||
    result.mutationIdentity.readSetHash !== readSetHash || hashObject(readSetIdentity) !== readSetHash ||
    result.readSet.referencesHash !== hashObject(result.readSet.references) ||
    canonical.length !== result.readSet.references.length ||
    stableJson(canonicalReplayReferences) !== stableJson(result.readSet.references) ||
    result.readSet.runStates.length !== replayRunStates.size ||
    stableJson(result.readSet.runStates) !== stableJson([...result.readSet.runStates]
      .sort((left, right) => compare(left.id, right.id))) ||
    result.readSet.runStates.some((entry) => entry.id !== entry.state.id ||
      entry.state.worksetId !== context.worksetId || entry.contentHash !== hashObject(entry.state)) ||
    result.mutationPlan.contentHash !== hashObject((({ contentHash: _planHash, ...identity }) => identity)(
      result.mutationPlan,
    )) ||
    stableJson(result.mutationPlan) !== stableJson(expectedMutationPlan) ||
    !sameContractRef(result.readSet.previous, actualDelta.previous) ||
    !sameContractRef(result.readSet.current, actualDelta.current) ||
    result.readSet.previousStatus !== 'READY' || result.readSet.currentStatus !== 'READY' ||
    result.mutationIdentity.deltaHash !== actualDelta.contentHash ||
    result.mutationIdentity.impactClosureHash !== result.impactClosure.contentHash ||
    result.impactClosure.worksetId !== context.worksetId ||
    result.impactClosure.scopeHash !== current.manifest.scopeHash ||
    result.impactClosure.roots.length !== 1 || root === undefined ||
    stableJson(root.node) !== stableJson(expectedRoot) ||
    root.previousContentHash !== previous.manifest.contentHash ||
    stableJson(result.decisions) !== stableJson(canonical) ||
    result.decisions.some((item) => item.project !== item.reference.project ||
      item.deltaHash !== actualDelta.contentHash ||
      !sameContractRef(item.reference.contract, actualDelta.previous) ||
      stableJson(item.affectedElements) !== stableJson(intersection(
        actualDelta.elements.map((change) => change.id), item.reference.usedElements)) ||
      stableJson(item.affectedScenarios) !== stableJson(intersection(
        actualDelta.scenarios.map((change) => change.id), item.reference.usedScenarios)) ||
      item.fingerprint !== decision(
        item.disposition,
        item.reference,
        item.affectedElements,
        item.affectedScenarios,
        item.evidenceRefs,
        actualDelta,
      ).fingerprint) ||
    stableJson(result.compatibleProjects) !== stableJson(projectsWith(projectDecisions, 'COMPATIBLE')) ||
    stableJson(result.incompatibleProjects) !== stableJson(projectsWith(projectDecisions, 'INCOMPATIBLE')) ||
    stableJson(result.unresolvedProjects) !== stableJson(projectsWith(projectDecisions, 'UNRESOLVED')) ||
    stableJson(result.invalidatedTestCases) !== stableJson(invalidatedTestCases) ||
    stableJson(result.invalidatedVerificationPlans) !== stableJson(invalidatedPlans) ||
    stableJson(result.invalidatedEnvironmentInputs) !== stableJson(invalidatedEnvironments) ||
    !isCanonicalStringArray(result.compatibilityEvidenceRefs) ||
    result.compatibilityEvidenceRefs.length !== result.mutationPlan.evidenceDecisionFingerprints.length ||
    !isCanonicalStringArray(result.preservedPatchRefs) ||
    stableJson(result.preservedPatchRefs) !== stableJson(canonicalStrings(
      result.preservedPatches.map((receipt) => receipt.patchRef))) ||
    stableJson(result.preservedPatches) !== stableJson([...result.preservedPatches]
      .sort((left, right) => compare(left.runId, right.runId))) ||
    result.preservedPatches.length !== result.mutationPlan.patchRunIds.length ||
    stableJson(canonicalStrings(result.preservedPatches.map((receipt) => receipt.runId))) !==
      stableJson(result.mutationPlan.patchRunIds) ||
    stableJson(result.recoveryRuns) !== stableJson([...result.recoveryRuns].sort((left, right) =>
      compare(recoveryRunSortKey(left), recoveryRunSortKey(right)))) ||
    result.recoveryRuns.length !== result.mutationPlan.recoveries.length ||
    stableJson(result.recoveryRuns.map((receipt) => ({
      project: receipt.project,
      parentRunId: receipt.parentRunId,
      scopedTask: receipt.scopedTask,
      decisionFingerprint: receipt.decisionFingerprint,
    })).sort((left, right) => compare(recoveryObligationKey(left), recoveryObligationKey(right)))) !==
      stableJson(result.mutationPlan.recoveries) ||
    result.attentionItems.length !== result.mutationPlan.attentionDecisionFingerprints.length ||
    stableJson(result.attentionItems) !== stableJson([...result.attentionItems]
      .sort((left, right) => compare(left.fingerprint, right.fingerprint))) ||
    stableJson(canonicalStrings(result.attentionItems.map((receipt) => receipt.fingerprint))) !==
      stableJson(result.mutationPlan.attentionDecisionFingerprints) ||
    result.recoveryRuns.some((receipt) => !canonical.some((item) =>
      item.disposition === 'INCOMPATIBLE' && item.fingerprint === receipt.decisionFingerprint &&
      item.reference.runId === receipt.parentRunId && scopedTaskKey(item.reference) === scopedTaskKey(receipt.scopedTask))) ||
    result.attentionItems.some((receipt) => receipt.project !== receipt.reference.project ||
      !sameContractRef(receipt.previous, actualDelta.previous) ||
      !sameContractRef(receipt.current, actualDelta.current) || receipt.deltaHash !== actualDelta.contentHash ||
      !canonical.some((item) => item.disposition === 'UNRESOLVED' &&
        item.fingerprint === receipt.fingerprint && stableJson(item.reference) === stableJson(receipt.reference)));
  if (replayInvalid) {
    throw new Error(`COMPATIBILITY_MUTATION_REPLAY_INVALID:${previousId}:${currentId}`);
  }
  const replayEvidenceFingerprints: ContentHash[] = [];
  for (const evidenceId of result.compatibilityEvidenceRefs) {
    const evidence = await readVerificationEvidence(context, evidenceId);
    if (evidence.status !== 'PASS') {
      throw new Error(`COMPATIBILITY_MUTATION_REPLAY_EVIDENCE_INVALID:${evidenceId}`);
    }
    const matches = canonical.filter((item) => item.disposition === 'COMPATIBLE' &&
      item.reference.commit !== undefined && evidence.subject.kind === 'COMPATIBILITY' &&
      evidence.runId === item.reference.runId && evidence.subject.project === item.project &&
      evidence.subject.commit === item.reference.commit);
    const matching = matches[0];
    if (matches.length !== 1 || matching === undefined) {
      throw new Error(`COMPATIBILITY_MUTATION_REPLAY_EVIDENCE_INVALID:${evidenceId}`);
    }
    assertPersistedCompatibilityEvidence({
      status: evidence.status,
      evidenceRef: evidence.id,
      evidence,
      previous: actualDelta.previous,
      current: actualDelta.current,
      project: matching.project,
      usedElements: matching.reference.usedElements,
      usedScenarios: matching.reference.usedScenarios,
    }, actualDelta, matching.reference);
    replayEvidenceFingerprints.push(matching.fingerprint);
  }
  if (stableJson(canonicalStrings(replayEvidenceFingerprints)) !==
      stableJson(result.mutationPlan.evidenceDecisionFingerprints)) {
    throw new Error(`COMPATIBILITY_MUTATION_REPLAY_EVIDENCE_INVALID:${previousId}:${currentId}`);
  }
  for (const attention of result.attentionItems) {
    const persisted = compatibilityAttentionRefSchema.parse(await requireAuthority(
      context.loadCompatibilityAttention,
      'COMPATIBILITY_ATTENTION_STORE_AUTHORITY_REQUIRED',
    )(attention.id));
    if (stableJson(persisted) !== stableJson(attention)) {
      throw new Error(`COMPATIBILITY_MUTATION_REPLAY_ATTENTION_INVALID:${attention.id}`);
    }
  }
  for (const recovery of result.recoveryRuns) {
    const matching = canonical.find((item) => item.disposition === 'INCOMPATIBLE' &&
      item.fingerprint === recovery.decisionFingerprint && item.reference.runId === recovery.parentRunId &&
      scopedTaskKey(item.reference) === scopedTaskKey(recovery.scopedTask));
    if (matching === undefined) {
      throw new Error(`COMPATIBILITY_MUTATION_REPLAY_RECOVERY_INVALID:${recovery.runId}`);
    }
    await assertRecoveryRunReceipt(context, recovery, {
      previous,
      current,
      delta: actualDelta,
      reference: matching.reference,
      decision: matching,
    }, false);
  }
  for (const patch of result.preservedPatches) {
    const persisted = capturedPatchSchema.parse(await requireAuthority(
      context.loadCapturedRunPatch,
      'UNCOMMITTED_PATCH_STORE_AUTHORITY_REQUIRED',
    )(patch));
    if (stableJson(persisted) !== stableJson(patch)) {
      throw new Error(`COMPATIBILITY_MUTATION_REPLAY_PATCH_INVALID:${patch.runId}`);
    }
  }
  return result;
}

function reduceProjectDecisions(
  decisions: readonly CompatibilityDecision[],
): Map<string, CompatibilityDecision> {
  const weight: Record<CompatibilityDisposition, number> = {
    COMPATIBLE: 0,
    UNRESOLVED: 1,
    INCOMPATIBLE: 2,
  };
  const selected = new Map<string, CompatibilityDecision>();
  for (const candidate of canonicalDecisions(decisions)) {
    const current = selected.get(candidate.project);
    if (current === undefined || weight[candidate.disposition] > weight[current.disposition]) {
      selected.set(candidate.project, candidate);
    }
  }
  return new Map([...selected].sort(([left], [right]) => compare(left, right)));
}

function projectsWith(
  decisions: ReadonlyMap<string, CompatibilityDecision>,
  disposition: CompatibilityDisposition,
): string[] {
  return [...decisions]
    .filter(([, item]) => item.disposition === disposition)
    .map(([project]) => project)
    .sort(compare);
}

function canonicalDecisions(decisions: readonly CompatibilityDecision[]): CompatibilityDecision[] {
  return uniqueBy(decisions, (item) => `${item.project}\0${contractReferenceKey(item.reference)}\0${item.fingerprint}`);
}

function node(kind: ImpactGraphNode['kind'], ref: string, contentHash: ContentHash): ImpactGraphNode {
  return { kind, ref, contentHash };
}

function contractNode(snapshot: ContractSnapshot): ImpactGraphNode {
  return node('CONTRACT_SNAPSHOT', snapshot.manifest.id, snapshot.manifest.contentHash);
}

function impactGraphNodeKey(value: ImpactGraphNode): string {
  return stableJson([value.kind, value.ref, value.contentHash]);
}

function scopedTaskKey(task: ScopedTaskRef): string {
  return stableJson([task.project, task.changeId, task.revision, task.baseline, task.taskId]);
}

function waveMemberRef(waveId: string, task: ScopedTaskRef): string {
  return `${waveId}:${scopedTaskKey(task)}`;
}

function sourceRefKey(ref: { readonly ref: string; readonly contentHash: ContentHash }): string {
  return stableJson([ref.ref, ref.contentHash]);
}

function planRefKey(ref: { readonly id: string; readonly contentHash: ContentHash }): string {
  return stableJson([ref.id, ref.contentHash]);
}

function environmentRefKey(ref: { readonly id: string; readonly contentHash: ContentHash }): string {
  return stableJson([ref.id, ref.contentHash]);
}

function sameContractRef(left: ContractRef, right: ContractRef): boolean {
  return left.id === right.id && left.contentHash === right.contentHash;
}

function contractUseKey(snapshot: ContractRef, id: string): string {
  return stableJson([snapshot.id, snapshot.contentHash, id]);
}

function recoveryRunSortKey(run: RecoveryRunRef): string {
  return stableJson([run.project, scopedTaskKey(run.scopedTask), run.parentRunId, run.runId]);
}

function recoveryObligationKey(run: {
  readonly project: string;
  readonly parentRunId: string;
  readonly scopedTask: ScopedTaskRef;
  readonly decisionFingerprint: ContentHash;
}): string {
  return stableJson([
    run.project,
    scopedTaskKey(run.scopedTask),
    run.parentRunId,
    run.decisionFingerprint,
  ]);
}

function intersection(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return canonicalStrings(left.filter((item) => rightSet.has(item)));
}

function canonicalStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compare);
}

function isCanonicalStringArray(values: readonly string[]): boolean {
  return stableJson(values) === stableJson(canonicalStrings(values));
}

function canonicalContractRefs(values: readonly ContractRef[]): ContractRef[] {
  return uniqueBy(values, (ref) => stableJson([ref.id, ref.contentHash]));
}

function uniqueBy<T>(values: readonly T[], identity: (value: T) => string): T[] {
  const byIdentity = new Map<string, T>();
  for (const value of values) {
    const key = identity(value);
    if (!byIdentity.has(key)) byIdentity.set(key, value);
  }
  return [...byIdentity.values()].sort((left, right) => compare(identity(left), identity(right)));
}

function stringSet(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_, nested) => isRecord(nested)
    ? Object.fromEntries(Object.entries(nested).sort(([left], [right]) => compare(left, right)))
    : nested);
}

function requireAuthority<T extends (...args: never[]) => unknown>(
  authority: T | undefined,
  code: string,
): T {
  if (authority === undefined) throw new Error(code);
  return authority;
}

async function directoryEntries(path: string) {
  if (!(await pathExists(path))) return [];
  return readdir(path, { withFileTypes: true });
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
