import { z } from 'zod';
import { canonicalJson } from './hashing.js';
import {
  contentHashSchema,
  contractRefSchema,
  contractScenarioRefSchema,
  integrationEnvironmentInputSchema,
  scopedTaskRefSchema,
  testCaseRefKey,
  testCaseRefSchema,
  verificationPlanRefSchema,
  type ContentHash,
} from './types.js';

const runIdSchema = z.string().regex(/^RUN-\d{4}$/);
const evidenceIdSchema = z.string().regex(/^EVD-\d{4}$/);
const projectSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const taskIdSchema = z.string().regex(/^TASK-\d{3}$/);
const testCaseIdSchema = z.string().regex(/^TC-\d{4}$/);
const gitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const timestampSchema = z.string().datetime();

const artifactIdentity = {
  schemaVersion: z.literal(1),
  runId: runIdSchema,
  packetHash: contentHashSchema,
};

const contentAddressedRefSchema = z.strictObject({
  ref: z.string().min(1),
  contentHash: contentHashSchema,
});

const contractParticipantSchema = z.strictObject({
  project: projectSchema,
  role: z.enum(['PROVIDER', 'CONSUMER']),
  taskRefs: z.array(taskIdSchema).min(1).readonly(),
});

const contractElementSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  kind: z.enum(['ENDPOINT', 'MESSAGE', 'SCHEMA', 'EVENT', 'RULE']),
  name: z.string().min(1),
  ownerProject: projectSchema,
  definition: z.json(),
  sourceRefs: z.array(z.string().min(1)).min(1).readonly(),
});

const businessScenarioSchema = z.strictObject({
  id: z.string().regex(/^SC-[a-zA-Z0-9._-]+$/),
  class: z.enum(['NORMAL', 'BOUNDARY', 'FAILURE', 'RETRY', 'COMPATIBILITY']),
  title: z.string().min(1),
  participantProjects: z.array(projectSchema).min(2).readonly(),
  sourceRefs: z.array(z.string().min(1)).min(1).readonly(),
  contractElementRefs: z.array(z.string().min(1)).min(1).readonly(),
  fixtureRefs: z.array(z.string().min(1)).readonly(),
  executorRefs: z.array(z.string().min(1)).readonly(),
  expectedOutcome: z.string().min(1),
});

export const contractCandidateSchema = z.strictObject({
  ...artifactIdentity,
  contractKey: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  scopeHash: contentHashSchema,
  participants: z.array(contractParticipantSchema).min(2).readonly(),
  contract: z.strictObject({
    elements: z.array(contractElementSchema).min(1).readonly(),
    compatibilityPolicy: z.strictObject({
      mode: z.enum(['BACKWARD_COMPATIBLE', 'FORWARD_COMPATIBLE', 'FULL', 'BREAKING_ALLOWED']),
      rules: z.array(z.string().min(1)).readonly(),
    }),
  }),
  businessScenarios: z.array(businessScenarioSchema).min(1).readonly(),
  fixtures: z.array(z.strictObject({
    ref: z.string().min(1),
    ownerProject: projectSchema,
    contentHash: contentHashSchema,
  })).readonly(),
  traceability: z.array(z.strictObject({
    sourceRef: z.string().min(1),
    sourceHash: contentHashSchema,
    contractElementRefs: z.array(z.string().min(1)).min(1).readonly(),
    scenarioIds: z.array(z.string().regex(/^SC-[a-zA-Z0-9._-]+$/)).min(1).readonly(),
  })).min(1).readonly(),
  sourceHashes: z.array(contentAddressedRefSchema).min(1).readonly(),
  validatorRequests: z.array(z.strictObject({
    id: z.string().min(1),
    project: projectSchema,
    commandRef: z.string().min(1).optional(),
    required: z.boolean(),
    scenarioIds: z.array(z.string().regex(/^SC-[a-zA-Z0-9._-]+$/)).min(1).readonly(),
  })).readonly(),
  summary: z.string().min(1),
}).superRefine((candidate, context) => {
  requireSortedUnique(candidate.participants, (item) => `${item.project}\u0000${item.role}`, 'participants', context);
  for (let index = 0; index < candidate.participants.length; index += 1) {
    requireSortedUnique(candidate.participants[index]!.taskRefs, identity, `participants.${index}.taskRefs`, context);
  }
  requireSortedUnique(candidate.contract.elements, (item) => item.id, 'contract.elements', context);
  requireSortedUnique(candidate.businessScenarios, (item) => item.id, 'businessScenarios', context);
  requireSortedUnique(candidate.fixtures, (item) => item.ref, 'fixtures', context);
  requireSortedUnique(candidate.traceability, (item) => item.sourceRef, 'traceability', context);
  requireSortedUnique(candidate.sourceHashes, (item) => item.ref, 'sourceHashes', context);
  requireSortedUnique(candidate.validatorRequests, (item) => item.id, 'validatorRequests', context);
});
export type ContractCandidate = z.infer<typeof contractCandidateSchema>;

const candidateOptionSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  summary: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)).min(1).readonly(),
});

export const projectFindingSchema = z.strictObject({
  ...artifactIdentity,
  findingId: z.string().regex(/^FND-\d{4}$/),
  project: projectSchema,
  candidateHash: contentHashSchema,
  disposition: z.enum(['ACCEPT', 'CORRECTION', 'CONTRADICTION', 'NEEDS_DECISION']),
  resolution: z.enum(['NONE', 'EVIDENCE_BACKED', 'UNRESOLVED']),
  summary: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)).readonly(),
  candidateOptions: z.array(candidateOptionSchema).readonly(),
}).superRefine((finding, context) => {
  requireSortedUnique(finding.evidenceRefs, identity, 'evidenceRefs', context);
  requireSortedUnique(finding.candidateOptions, (item) => item.id, 'candidateOptions', context);
  if (finding.disposition === 'ACCEPT' && finding.resolution !== 'NONE') {
    context.addIssue({ code: 'custom', path: ['resolution'], message: 'ACCEPT_REQUIRES_NONE_RESOLUTION' });
  }
});
export type ProjectFinding = z.infer<typeof projectFindingSchema>;

export const contractResolutionSchema = z.strictObject({
  ...artifactIdentity,
  candidateHash: contentHashSchema,
  summary: z.string().min(1),
  resolutions: z.array(z.strictObject({
    findingId: z.string().regex(/^FND-\d{4}$/),
    selectedOptionId: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    candidateOptionIds: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]*$/)).min(1).readonly(),
    evidenceRefs: z.array(z.string().min(1)).min(1).readonly(),
  })).min(1).readonly(),
}).superRefine((resolution, context) => {
  requireSortedUnique(resolution.resolutions, (item) => item.findingId, 'resolutions', context);
  for (let index = 0; index < resolution.resolutions.length; index += 1) {
    const item = resolution.resolutions[index]!;
    requireSortedUnique(item.candidateOptionIds, identity, `resolutions.${index}.candidateOptionIds`, context);
    requireSortedUnique(item.evidenceRefs, identity, `resolutions.${index}.evidenceRefs`, context);
    if (!item.candidateOptionIds.includes(item.selectedOptionId)) {
      context.addIssue({
        code: 'custom',
        path: ['resolutions', index, 'selectedOptionId'],
        message: 'RESOLUTION_OPTION_NOT_CANDIDATE',
      });
    }
  }
});
export type ContractResolution = z.infer<typeof contractResolutionSchema>;

export function validateContractResolutionAgainstFindings(
  resolution: ContractResolution,
  findings: readonly ProjectFinding[],
): ContractResolution {
  const parsed = contractResolutionSchema.parse(resolution);
  const findingById = new Map(findings.map((finding) => [finding.findingId, projectFindingSchema.parse(finding)]));
  for (const item of parsed.resolutions) {
    const finding = findingById.get(item.findingId);
    if (!finding || finding.candidateHash !== parsed.candidateHash) {
      throw new Error(`CONTRACT_RESOLUTION_FINDING_MISMATCH: ${item.findingId}`);
    }
    const actualOptionIds = finding.candidateOptions.map((option) => option.id);
    if (canonicalJson(item.candidateOptionIds) !== canonicalJson(actualOptionIds) ||
        !actualOptionIds.includes(item.selectedOptionId)) {
      throw new Error(`RESOLUTION_OPTION_NOT_CANDIDATE: ${item.selectedOptionId}`);
    }
  }
  return parsed;
}

const proposedTestCaseSchema = z.strictObject({
  id: testCaseIdSchema,
  level: z.enum(['UNIT', 'COMPONENT', 'CONTRACT_PROVIDER', 'CONTRACT_CONSUMER', 'INTEGRATION', 'E2E']),
  title: z.string().min(1),
  required: z.boolean(),
  sourceRefs: z.array(contentAddressedRefSchema).min(1).readonly(),
  scopedTasks: z.array(scopedTaskRefSchema).min(1).readonly(),
  acceptanceCriteriaRefs: z.array(contentAddressedRefSchema).min(1).readonly(),
  contractRefs: z.array(contractRefSchema).readonly(),
  scenarioRefs: z.array(contractScenarioRefSchema).readonly(),
  commandRefs: z.array(z.string().min(1)).min(1).readonly(),
  ownerProjects: z.array(projectSchema).min(1).readonly(),
  testPaths: z.array(z.string().min(1)).readonly(),
  evidenceRequired: z.array(z.string().min(1)).readonly(),
  expectedOutcome: z.string().min(1),
});

const proposedCommandDefinitionSchema = z.strictObject({
  commandRef: z.string().min(1),
  executable: z.string().min(1),
  argv: z.array(z.string()).readonly(),
  cwd: z.string().min(1),
  network: z.enum(['ALLOW', 'DENY']),
  timeoutMs: z.number().int().positive(),
  outputLimit: z.number().int().positive(),
  caseRefs: z.array(testCaseIdSchema).min(1).readonly(),
});

export const projectTestPlanCandidateSchema = z.strictObject({
  ...artifactIdentity,
  project: projectSchema,
  sourceSnapshot: z.strictObject({
    head: gitObjectIdSchema,
    tree: gitObjectIdSchema,
    contentHash: contentHashSchema,
  }),
  scopedTasks: z.array(scopedTaskRefSchema).min(1).readonly(),
  testCases: z.array(proposedTestCaseSchema).readonly(),
  commandDefinitions: z.array(proposedCommandDefinitionSchema).readonly(),
  summary: z.string().min(1),
}).superRefine((candidate, context) => {
  requireSortedUnique(candidate.scopedTasks, scopedTaskKey, 'scopedTasks', context);
  requireSortedUnique(candidate.testCases, (item) => item.id, 'testCases', context);
  requireSortedUnique(candidate.commandDefinitions, (item) => item.commandRef, 'commandDefinitions', context);
  const scopedTaskKeys = new Set(candidate.scopedTasks.map(scopedTaskKey));
  const testCaseIds = new Set(candidate.testCases.map((item) => item.id));
  const commandRefs = new Set(candidate.commandDefinitions.map((item) => item.commandRef));
  for (let index = 0; index < candidate.scopedTasks.length; index += 1) {
    if (candidate.scopedTasks[index]!.project !== candidate.project) {
      context.addIssue({ code: 'custom', path: ['scopedTasks', index], message: 'PROJECT_TEST_PLAN_SCOPE_MISMATCH' });
    }
  }
  for (let index = 0; index < candidate.testCases.length; index += 1) {
    const testCase = candidate.testCases[index]!;
    if (testCase.scopedTasks.some((task) => !scopedTaskKeys.has(scopedTaskKey(task)))) {
      context.addIssue({ code: 'custom', path: ['testCases', index, 'scopedTasks'], message: 'PROJECT_TEST_PLAN_TASK_NOT_IN_PACKET_SCOPE' });
    }
    if (testCase.commandRefs.some((commandRef) => !commandRefs.has(commandRef))) {
      context.addIssue({ code: 'custom', path: ['testCases', index, 'commandRefs'], message: 'PROJECT_TEST_PLAN_COMMAND_UNDEFINED' });
    }
    const contractRefs = new Set(testCase.contractRefs.map((ref) => `${ref.id}\0${ref.contentHash}`));
    if (testCase.contractRefs.length > 0 && testCase.scenarioRefs.length === 0) {
      context.addIssue({ code: 'custom', path: ['testCases', index, 'scenarioRefs'], message: 'PROJECT_TEST_PLAN_CONTRACT_SCENARIO_REQUIRED' });
    }
    if (testCase.scenarioRefs.some((ref) => !contractRefs.has(`${ref.snapshot.id}\0${ref.snapshot.contentHash}`))) {
      context.addIssue({ code: 'custom', path: ['testCases', index, 'scenarioRefs'], message: 'PROJECT_TEST_PLAN_SCENARIO_CONTRACT_UNBOUND' });
    }
  }
  for (let index = 0; index < candidate.commandDefinitions.length; index += 1) {
    if (candidate.commandDefinitions[index]!.caseRefs.some((caseRef) => !testCaseIds.has(caseRef))) {
      context.addIssue({ code: 'custom', path: ['commandDefinitions', index, 'caseRefs'], message: 'PROJECT_TEST_PLAN_CASE_UNDEFINED' });
    }
  }
});
export type ProjectTestPlanCandidate = z.infer<typeof projectTestPlanCandidateSchema>;

export const workerResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    ...artifactIdentity,
    outcome: z.literal('FINISH'),
    summary: z.string().min(1),
    changedPaths: z.array(z.string()).readonly(),
    evidenceRefs: z.array(z.string()).readonly(),
    logs: z.array(z.string()).readonly(),
  }),
  z.strictObject({
    ...artifactIdentity,
    outcome: z.literal('BLOCK'),
    blockerCode: z.string().min(1),
    blocker: z.string().min(1),
    recoverableWork: z.boolean(),
    changedPaths: z.array(z.string()).readonly(),
    logs: z.array(z.string()).readonly(),
  }),
  z.strictObject({
    ...artifactIdentity,
    outcome: z.literal('SIGNAL'),
    signalKind: z.enum([
      'CONTRACT_STALE', 'REVISION_STALE', 'ASSUMPTION_INVALID', 'POLICY_BOUNDARY', 'TDD_PROOF_UNAVAILABLE',
    ]),
    detail: z.string().min(1),
    changedPaths: z.array(z.string()).readonly(),
    logs: z.array(z.string()).readonly(),
  }),
]);
export type WorkerResult = z.infer<typeof workerResultSchema>;

export const reviewFindingSchema = z.strictObject({
  ...artifactIdentity,
  outcome: z.enum(['APPROVE', 'REQUEST_CHANGES', 'BLOCK']),
  summary: z.string().min(1),
  findings: z.array(z.strictObject({
    id: z.string().regex(/^RF-\d{4}$/),
    severity: z.enum(['INFO', 'NON_BLOCKING', 'BLOCKING']),
    category: z.enum(['BEHAVIOR', 'CONTRACT', 'SCOPE', 'TEST', 'SAFETY', 'EVIDENCE']),
    path: z.string().min(1).optional(),
    detail: z.string().min(1),
    evidenceRefs: z.array(z.string().min(1)).readonly(),
  })).readonly(),
  evidenceRefs: z.array(z.string().min(1)).readonly(),
  logs: z.array(z.string()).readonly(),
}).superRefine((review, context) => {
  requireSortedUnique(review.findings, (item) => item.id, 'findings', context);
  requireSortedUnique(review.evidenceRefs, identity, 'evidenceRefs', context);
  if (review.outcome === 'APPROVE' && review.findings.some((item) => item.severity === 'BLOCKING')) {
    context.addIssue({ code: 'custom', path: ['outcome'], message: 'APPROVE_CANNOT_HAVE_BLOCKING_FINDING' });
  }
});
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

const caseOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({ caseRef: testCaseRefSchema, status: z.literal('PASS') }),
  z.strictObject({ caseRef: testCaseRefSchema, status: z.literal('FAIL'), detail: z.string().min(1) }),
  z.strictObject({ caseRef: testCaseRefSchema, status: z.literal('INCONCLUSIVE'), detail: z.string().min(1) }),
  z.strictObject({
    caseRef: testCaseRefSchema,
    status: z.literal('SKIPPED'),
    reason: z.string().min(1),
    notApplicableDecision: contentAddressedRefSchema,
  }),
]);

const evidenceSubjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('PROJECT'),
    project: projectSchema,
    commit: gitObjectIdSchema,
    commitTree: gitObjectIdSchema,
    verifiedTree: gitObjectIdSchema,
    metadataDeltaHash: contentHashSchema,
  }),
  z.strictObject({
    kind: z.literal('ENVIRONMENT'),
    environmentRunId: z.string().regex(/^IER-\d{4}$/),
    input: integrationEnvironmentInputSchema,
  }),
  z.strictObject({
    kind: z.literal('COMPATIBILITY'),
    contractSnapshot: contractRefSchema,
    project: projectSchema,
    commit: gitObjectIdSchema,
  }),
]);

const caseAddressedVerificationEvidenceSchema = z.strictObject({
  ...artifactIdentity,
  id: evidenceIdSchema,
  status: z.enum(['PASS', 'FAIL', 'INCONCLUSIVE']),
  verificationPlan: verificationPlanRefSchema,
  testCaseRefs: z.array(testCaseRefSchema).min(1).readonly(),
  caseOutcomes: z.array(caseOutcomeSchema).min(1).readonly(),
  contractRefs: z.array(contractRefSchema).readonly(),
  command: z.strictObject({
    commandRef: z.string().min(1),
    contentHash: contentHashSchema,
  }),
  exitCode: z.number().int().nullable(),
  outputHash: contentHashSchema,
  artifactHashes: z.array(contentAddressedRefSchema).readonly(),
  startedAt: timestampSchema,
  finishedAt: timestampSchema,
  verifier: z.strictObject({
    kind: z.enum(['CORE', 'ADAPTER']),
    id: z.string().min(1),
  }),
  subject: evidenceSubjectSchema,
}).superRefine((evidence, context) => {
  requireSortedUnique(evidence.testCaseRefs, testCaseRefKey, 'testCaseRefs', context);
  requireSortedUnique(evidence.caseOutcomes, (item) => testCaseRefKey(item.caseRef), 'caseOutcomes', context);
  requireSortedUnique(evidence.contractRefs, contractRefKey, 'contractRefs', context);
  requireSortedUnique(evidence.artifactHashes, (item) => item.ref, 'artifactHashes', context);

  const expectedCases = evidence.testCaseRefs.map(testCaseRefKey);
  const actualCases = evidence.caseOutcomes.map((item) => testCaseRefKey(item.caseRef));
  if (canonicalJson(expectedCases) !== canonicalJson(actualCases)) {
    context.addIssue({ code: 'custom', path: ['caseOutcomes'], message: 'VERIFICATION_CASE_OUTCOME_MISMATCH' });
  }
  if (evidence.status === 'PASS' && evidence.caseOutcomes.some(
    (item) => item.status === 'FAIL' || item.status === 'INCONCLUSIVE',
  )) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'VERIFICATION_PASS_HAS_UNSATISFIED_CASE' });
  }
  if (evidence.status === 'PASS' && evidence.exitCode !== 0) {
    context.addIssue({ code: 'custom', path: ['exitCode'], message: 'VERIFICATION_PASS_REQUIRES_ZERO_EXIT' });
  }
  if (Date.parse(evidence.finishedAt) < Date.parse(evidence.startedAt)) {
    context.addIssue({ code: 'custom', path: ['finishedAt'], message: 'VERIFICATION_TIME_ORDER_INVALID' });
  }
  if (evidence.subject.kind === 'ENVIRONMENT') {
    const input = evidence.subject.input;
    const inputContracts = input.contractSnapshots
      .map((item) => item.snapshot)
      .slice()
      .sort((left, right) => compare(contractRefKey(left), contractRefKey(right)));
    if (canonicalJson(evidence.verificationPlan) !== canonicalJson(input.verificationPlan) ||
        canonicalJson(evidence.testCaseRefs) !== canonicalJson(input.testCaseRefs) ||
        canonicalJson(evidence.contractRefs) !== canonicalJson(inputContracts)) {
      context.addIssue({ code: 'custom', path: ['subject'], message: 'VERIFICATION_INPUT_MISMATCH' });
    }
  }
});

const contractValidatorEvidenceSchema = z.strictObject({
  ...artifactIdentity,
  id: evidenceIdSchema,
  status: z.enum(['PASS', 'FAIL', 'INCONCLUSIVE']),
  contractRefs: z.array(contractRefSchema).length(1).readonly(),
  command: z.strictObject({
    commandRef: z.string().min(1),
    contentHash: contentHashSchema,
  }),
  exitCode: z.number().int().nullable(),
  outputHash: contentHashSchema,
  artifactHashes: z.array(contentAddressedRefSchema).readonly(),
  diagnostics: z.array(z.string().min(1)).readonly(),
  startedAt: timestampSchema,
  finishedAt: timestampSchema,
  verifier: z.strictObject({
    kind: z.enum(['CORE', 'ADAPTER']),
    id: z.string().min(1),
  }),
  subject: z.strictObject({
    kind: z.literal('CONTRACT'),
    worksetId: z.string().regex(/^WKS-\d{4}$/),
    contractKey: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    scopeHash: contentHashSchema,
    contractSnapshot: contractRefSchema,
    scenarioIds: z.array(z.string().regex(/^SC-[a-zA-Z0-9._-]+$/)).min(1).readonly(),
  }),
}).superRefine((evidence, context) => {
  requireSortedUnique(evidence.contractRefs, contractRefKey, 'contractRefs', context);
  requireSortedUnique(evidence.artifactHashes, (item) => item.ref, 'artifactHashes', context);
  requireSortedUnique(evidence.diagnostics, identity, 'diagnostics', context);
  requireSortedUnique(evidence.subject.scenarioIds, identity, 'subject.scenarioIds', context);
  if (canonicalJson(evidence.contractRefs) !== canonicalJson([evidence.subject.contractSnapshot])) {
    context.addIssue({ code: 'custom', path: ['contractRefs'], message: 'CONTRACT_EVIDENCE_SNAPSHOT_MISMATCH' });
  }
  if (evidence.status === 'PASS' && evidence.exitCode !== 0) {
    context.addIssue({ code: 'custom', path: ['exitCode'], message: 'VERIFICATION_PASS_REQUIRES_ZERO_EXIT' });
  }
  if (Date.parse(evidence.finishedAt) < Date.parse(evidence.startedAt)) {
    context.addIssue({ code: 'custom', path: ['finishedAt'], message: 'VERIFICATION_TIME_ORDER_INVALID' });
  }
});

export const verificationEvidenceSchema = z.union([
  caseAddressedVerificationEvidenceSchema,
  contractValidatorEvidenceSchema,
]);
export type VerificationEvidence = z.infer<typeof verificationEvidenceSchema>;

export function parseArtifactForPacket<T>(
  packet: { readonly id: string; readonly packetHash: ContentHash },
  schema: z.ZodType<T>,
  value: unknown,
): T {
  const parsed = schema.parse(value);
  const identityValue = parsed as { runId?: unknown; packetHash?: unknown };
  if (identityValue.runId !== packet.id) {
    throw new Error(`ARTIFACT_IDENTITY_MISMATCH: runId '${String(identityValue.runId)}' does not match '${packet.id}'`);
  }
  if (identityValue.packetHash !== packet.packetHash) {
    throw new Error('ARTIFACT_IDENTITY_MISMATCH: packetHash does not match the immutable Run Packet');
  }
  return parsed;
}

function requireSortedUnique<T>(
  values: readonly T[],
  key: (value: T) => string,
  path: string,
  context: z.RefinementCtx,
): void {
  let previous: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const current = key(values[index]!);
    if (previous !== undefined && compare(previous, current) >= 0) {
      context.addIssue({
        code: 'custom',
        path: path.split('.').concat(String(index)),
        message: `${path} must be SORTED_UNIQUE`,
      });
      return;
    }
    previous = current;
  }
}

function scopedTaskKey(task: z.infer<typeof scopedTaskRefSchema>): string {
  return [task.project, task.changeId, task.revision, task.baseline, task.taskId].join('\u0000');
}

function contractRefKey(ref: z.infer<typeof contractRefSchema>): string {
  return `${ref.id}\u0000${ref.contentHash}`;
}

function identity(value: string): string {
  return value;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
