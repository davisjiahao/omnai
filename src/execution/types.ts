import { z } from 'zod';

export const RUN_KINDS = ['CONTRACT_PLANNER', 'PROJECT_CRITIC', 'CONTRACT_RESOLVER', 'PROJECT_WRITER', 'PROJECT_REVIEWER', 'RECOVERY_WRITER'] as const;
export const RUN_STATUSES = ['PREPARED', 'CLAIMED', 'STARTING', 'RUNNING', 'FINISHED', 'ACCEPTED', 'INTEGRATED', 'BLOCKED', 'SIGNALED', 'FAILED', 'STALE', 'CANCELLED', 'RECOVERING'] as const;
export const CONTRACT_STATUSES = ['GENERATING', 'VALIDATING', 'READY', 'SUPERSEDED', 'INVALID'] as const;
export const WAVE_STATUSES = ['PLANNED', 'RUNNING', 'COMPLETE', 'PARTIAL', 'SUPERSEDED'] as const;
export const CLAIM_PHASES = ['WRITING', 'REVIEWING', 'INTEGRATING', 'RECOVERING'] as const;
export const COMMITSET_STATUSES = ['OPEN', 'PARTIAL', 'COMPLETE', 'NEEDS_REVALIDATION'] as const;

export type RunKind = (typeof RUN_KINDS)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];
export type WaveStatus = (typeof WAVE_STATUSES)[number];
export type ClaimPhase = (typeof CLAIM_PHASES)[number];
export type CommitSetStatus = (typeof COMMITSET_STATUSES)[number];

const worksetIdSchema = z.string().regex(/^WKS-\d{4}$/);
const contractIdSchema = z.string().regex(/^CTR-\d{4}$/);
const waveIdSchema = z.string().regex(/^WAVE-\d{4}$/);
const runIdSchema = z.string().regex(/^RUN-\d{4}$/);
const commitsetIdSchema = z.string().regex(/^CST-\d{4}$/);
const evidenceIdSchema = z.string().regex(/^EVD-\d{4}$/);
const attentionIdSchema = z.string().regex(/^ATTN-\d{4}$/);
const changeIdSchema = z.string().regex(/^CHG-\d{4}$/);
const revisionIdSchema = z.string().regex(/^REV-\d{4}$/);
const baselineIdSchema = z.string().regex(/^BL-\d{4}$/);
const taskIdSchema = z.string().regex(/^TASK-\d{3}$/);
const gitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const timestampSchema = z.string().datetime();
const readonlyStringArraySchema = z.array(z.string().min(1)).readonly();

export const contentHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export type ContentHash = z.infer<typeof contentHashSchema>;

export const scopedTaskRefSchema = z.strictObject({
  project: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  changeId: changeIdSchema,
  revision: revisionIdSchema,
  baseline: baselineIdSchema,
  taskId: taskIdSchema,
});
export type ScopedTaskRef = z.infer<typeof scopedTaskRefSchema>;

export const contractRefSchema = z.strictObject({
  id: contractIdSchema,
  contentHash: contentHashSchema,
});
export type ContractRef = z.infer<typeof contractRefSchema>;

const lifecycleShape = {
  schemaVersion: z.literal(1),
  machineVersion: z.literal(1),
  lastEventSequence: z.number().int().nonnegative(),
  lastEventHash: contentHashSchema.nullable(),
};

const contractParticipantSchema = z.strictObject({
  project: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  changeId: changeIdSchema,
  revision: revisionIdSchema,
  taskId: taskIdSchema,
  role: z.enum(['PROVIDER', 'CONSUMER']),
});

const contractSourceSchema = z.strictObject({
  kind: z.enum(['intent', 'spec', 'design', 'contract', 'schema', 'test']),
  project: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  ref: z.string().min(1),
  contentHash: contentHashSchema,
});

export const contractSnapshotManifestSchema = z.strictObject({
  ...lifecycleShape,
  id: contractIdSchema,
  worksetId: worksetIdSchema,
  status: z.enum(CONTRACT_STATUSES),
  contractKey: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  scopeHash: contentHashSchema,
  contentHash: contentHashSchema,
  previousSnapshot: contractIdSchema.nullable(),
  participants: z.array(contractParticipantSchema).min(2).readonly(),
  sources: z.array(contractSourceSchema).min(1).readonly(),
  businessScenarios: readonlyStringArraySchema,
  validationEvidence: z.array(evidenceIdSchema).readonly(),
  createdByRun: runIdSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).superRefine((manifest, context) => {
  requireLifecycleLinkage(manifest, context);
  requireSorted(manifest.participants, participantSortKey, 'participants', context);
  requireSorted(manifest.sources, sourceSortKey, 'sources', context);
  if (!manifest.participants.some((item) => item.role === 'PROVIDER')) {
    context.addIssue({ code: 'custom', path: ['participants'], message: 'participants require a PROVIDER' });
  }
  if (!manifest.participants.some((item) => item.role === 'CONSUMER')) {
    context.addIssue({ code: 'custom', path: ['participants'], message: 'participants require a CONSUMER' });
  }
  if (manifest.status === 'READY' && manifest.validationEvidence.length === 0) {
    context.addIssue({ code: 'custom', path: ['validationEvidence'], message: 'READY requires validation evidence' });
  }
});
export type ContractSnapshotManifest = z.infer<typeof contractSnapshotManifestSchema>;

const gitBindingSchema = z.strictObject({
  startingHead: gitObjectIdSchema,
  worktree: z.string().min(1),
  branch: z.string().min(1),
});

const packetAgentSchema = z.strictObject({
  agentId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  protocol: z.enum(['acp', 'native']),
  role: z.enum(['coordination-read-only', 'project-writer', 'project-reviewer']),
});

const executionLimitsSchema = z.strictObject({
  timeoutMs: z.number().int().positive(),
  maxOutputBytes: z.number().int().positive(),
});

const permissionPolicySchema = z.strictObject({
  filesystemRoots: z.array(z.string().min(1)).readonly(),
  terminal: z.boolean(),
  network: z.enum(['ALLOW', 'DENY']),
  denyGitCommit: z.literal(true),
  denyNestedOmnai: z.literal(true),
});

const packetCommonShape = {
  schemaVersion: z.literal(1),
  id: runIdSchema,
  worksetId: worksetIdSchema,
  parentRunId: runIdSchema.optional(),
  coordinationCycleId: z.string().regex(/^CCY-[a-zA-Z0-9._-]+$/).optional(),
  waveId: waveIdSchema.optional(),
  contracts: z.array(contractRefSchema).readonly(),
  objective: z.string().min(1),
  protocolIds: readonlyStringArraySchema,
  verificationCommands: readonlyStringArraySchema,
  evidenceRequired: readonlyStringArraySchema,
  stopConditions: readonlyStringArraySchema,
  agent: packetAgentSchema,
  limits: executionLimitsSchema,
  permissionPolicy: permissionPolicySchema,
  createdAt: timestampSchema,
  packetHash: contentHashSchema,
};

const coordinationPacketSchema = (kind: 'CONTRACT_PLANNER' | 'PROJECT_CRITIC' | 'CONTRACT_RESOLVER') => z.strictObject({
  ...packetCommonShape,
  kind: z.literal(kind),
  agent: packetAgentSchema.extend({ role: z.literal('coordination-read-only') }).strict(),
});

const projectPacketSchema = (
  kind: 'PROJECT_WRITER' | 'PROJECT_REVIEWER' | 'RECOVERY_WRITER',
  role: 'project-writer' | 'project-reviewer',
) => z.strictObject({
  ...packetCommonShape,
  kind: z.literal(kind),
  agent: packetAgentSchema.extend({ role: z.literal(role) }).strict(),
  scopedTask: scopedTaskRefSchema,
  git: gitBindingSchema,
  allowedPaths: readonlyStringArraySchema,
});

export const runPacketSchema = z.discriminatedUnion('kind', [
  coordinationPacketSchema('CONTRACT_PLANNER'),
  coordinationPacketSchema('PROJECT_CRITIC'),
  coordinationPacketSchema('CONTRACT_RESOLVER'),
  projectPacketSchema('PROJECT_WRITER', 'project-writer'),
  projectPacketSchema('PROJECT_REVIEWER', 'project-reviewer'),
  projectPacketSchema('RECOVERY_WRITER', 'project-writer'),
]);
export type RunPacket = z.infer<typeof runPacketSchema>;

export const runStateSchema = z.strictObject({
  ...lifecycleShape,
  id: runIdSchema,
  kind: z.enum(RUN_KINDS),
  worksetId: worksetIdSchema,
  status: z.enum(RUN_STATUSES),
  packetHash: contentHashSchema,
  waveId: waveIdSchema.optional(),
  parentRunId: runIdSchema.optional(),
  scopedTask: scopedTaskRefSchema.optional(),
  agentSessionId: z.string().min(1).optional(),
  resultHash: contentHashSchema.optional(),
  evidenceRefs: z.array(evidenceIdSchema).readonly(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).superRefine(requireLifecycleLinkage);
export type RunState = z.infer<typeof runStateSchema>;

export const agentSessionRecordSchema = z.strictObject({
  ...lifecycleShape,
  runId: runIdSchema,
  agentId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  protocol: z.enum(['acp', 'native']),
  sessionId: z.string().min(1),
  processId: z.number().int().positive().optional(),
  promptState: z.enum(['NOT_SENT', 'INTENDED', 'SENT', 'COMPLETED', 'OUTCOME_UNCERTAIN']),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).superRefine(requireLifecycleLinkage);
export type AgentSessionRecord = z.infer<typeof agentSessionRecordSchema>;

const waveMemberSchema = scopedTaskRefSchema.extend({
  contracts: z.array(contractRefSchema).readonly(),
  objective: z.string().min(1),
  allowedPaths: readonlyStringArraySchema,
  agentId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
}).strict();

const deferredWaveMemberSchema = scopedTaskRefSchema.extend({
  reasons: readonlyStringArraySchema,
}).strict();

export const waveSchema = z.strictObject({
  ...lifecycleShape,
  id: waveIdSchema,
  worksetId: worksetIdSchema,
  status: z.enum(WAVE_STATUSES),
  inputHash: contentHashSchema,
  members: z.array(waveMemberSchema).readonly(),
  deferred: z.array(deferredWaveMemberSchema).readonly(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).superRefine(requireLifecycleLinkage);
export type Wave = z.infer<typeof waveSchema>;

export const writerClaimSchema = z.strictObject({
  ...lifecycleShape,
  project: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  runId: runIdSchema,
  runKind: z.enum(['PROJECT_WRITER', 'RECOVERY_WRITER']),
  phase: z.enum(CLAIM_PHASES),
  worktree: z.string().min(1),
  branch: z.string().min(1),
  ownerProcess: z.number().int().positive(),
  agentProtocol: z.enum(['acp', 'native']),
  agentId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  agentSessionId: z.string().min(1).optional(),
  acquiredAt: timestampSchema,
  heartbeatAt: timestampSchema,
}).superRefine(requireLifecycleLinkage);
export type WriterClaim = z.infer<typeof writerClaimSchema>;

const commitSetMemberBaseShape = {
  ...scopedTaskRefSchema.shape,
  runId: runIdSchema,
  contracts: z.array(contractRefSchema).readonly(),
};

const pendingCommitSetMemberSchema = (status: 'PENDING' | 'RUNNING') => z.strictObject({
  ...commitSetMemberBaseShape,
  status: z.literal(status),
});

const integratedCommitSetMemberSchema = z.strictObject({
  ...commitSetMemberBaseShape,
  status: z.literal('INTEGRATED'),
  reviewRunId: runIdSchema,
  commit: gitObjectIdSchema,
  evidenceRefs: z.array(evidenceIdSchema).min(1).readonly(),
});

const failedCommitSetMemberSchema = z.strictObject({
  ...commitSetMemberBaseShape,
  status: z.literal('FAILED'),
  reviewRunId: runIdSchema.optional(),
  failureHash: contentHashSchema,
  evidenceRefs: z.array(evidenceIdSchema).readonly(),
});

const revalidationCommitSetMemberSchema = z.strictObject({
  ...commitSetMemberBaseShape,
  status: z.literal('NEEDS_REVALIDATION'),
  reviewRunId: runIdSchema,
  commit: gitObjectIdSchema,
  evidenceRefs: z.array(evidenceIdSchema).readonly(),
});

export const commitSetMemberSchema = z.discriminatedUnion('status', [
  pendingCommitSetMemberSchema('PENDING'),
  pendingCommitSetMemberSchema('RUNNING'),
  integratedCommitSetMemberSchema,
  failedCommitSetMemberSchema,
  revalidationCommitSetMemberSchema,
]);
export type CommitSetMember = z.infer<typeof commitSetMemberSchema>;

export const commitSetSchema = z.strictObject({
  ...lifecycleShape,
  id: commitsetIdSchema,
  worksetId: worksetIdSchema,
  status: z.enum(COMMITSET_STATUSES),
  scopeHash: contentHashSchema,
  contractSnapshots: z.array(contractRefSchema).readonly(),
  members: z.array(commitSetMemberSchema).min(1).readonly(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).superRefine(requireLifecycleLinkage);
export type CommitSet = z.infer<typeof commitSetSchema>;

export const executionEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  eventId: z.string().min(1),
  aggregateType: z.enum(['contract', 'wave', 'run', 'claim', 'commitset', 'attention']),
  aggregateId: z.string().min(1),
  machineVersion: z.literal(1),
  sequence: z.number().int().positive(),
  type: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  payload: z.record(z.string(), z.json()),
  previousHash: contentHashSchema.nullable(),
  timestamp: timestampSchema,
  hash: contentHashSchema,
}).superRefine((event, context) => {
  if ((event.sequence === 1 && event.previousHash !== null) ||
      (event.sequence > 1 && event.previousHash === null)) {
    context.addIssue({ code: 'custom', path: ['previousHash'], message: 'previousHash must link to the preceding event' });
  }
});
export type ExecutionEvent = z.infer<typeof executionEventSchema>;

const attentionOptionSchema = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  evidenceRefs: readonlyStringArraySchema,
});

const attentionItemShape = {
  ...lifecycleShape,
  id: attentionIdSchema,
  kind: z.enum(['NEEDS_DECISION', 'EXTERNAL_ACTION_REQUIRED', 'SAFETY_UNPROVEN']),
  scope: z.strictObject({
    worksetId: worksetIdSchema,
    contractId: contractIdSchema.optional(),
    runId: runIdSchema.optional(),
    project: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  }),
  question: z.string().min(1),
  options: z.array(attentionOptionSchema).readonly(),
  evidenceRefs: readonlyStringArraySchema,
  blockingProjects: readonlyStringArraySchema,
  createdByRuns: z.array(runIdSchema).readonly(),
  fingerprint: contentHashSchema,
  createdAt: timestampSchema,
};

export const attentionItemSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...attentionItemShape, status: z.literal('OPEN') }),
  z.strictObject({ ...attentionItemShape, status: z.literal('RESOLVED'), resolvedAt: timestampSchema }),
]).superRefine(requireLifecycleLinkage);
export type AttentionItem = z.infer<typeof attentionItemSchema>;

function participantSortKey(participant: z.infer<typeof contractParticipantSchema>): string {
  return [participant.project, participant.changeId, participant.revision, participant.taskId, participant.role].join('\0');
}

function sourceSortKey(source: z.infer<typeof contractSourceSchema>): string {
  return JSON.stringify([source.project, source.ref, source.kind, source.contentHash]);
}

function requireLifecycleLinkage(
  value: { lastEventSequence: number; lastEventHash: ContentHash | null },
  context: z.RefinementCtx,
): void {
  if ((value.lastEventSequence === 0 && value.lastEventHash !== null) ||
      (value.lastEventSequence > 0 && value.lastEventHash === null)) {
    context.addIssue({ code: 'custom', path: ['lastEventHash'], message: 'lastEventHash must match lastEventSequence' });
  }
}

function requireSorted<T>(
  items: readonly T[],
  key: (item: T) => string,
  field: string,
  context: z.RefinementCtx,
): void {
  for (let index = 1; index < items.length; index += 1) {
    if (key(items[index - 1]!) > key(items[index]!)) {
      context.addIssue({ code: 'custom', path: [field], message: `${field} must be sorted` });
      return;
    }
  }
}
