import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isProxy } from 'node:util/types';
import { z } from 'zod';
import {
  ARCHITECTURE_APPLICABILITIES,
  DELIVERY_SHAPES,
  FLOW_SCALES,
  FLOW_TOPOLOGIES,
  FLOW_UNCERTAINTY,
  baselineIdSchema,
  changeIdSchema,
  changeMetadataSchema,
  decisionIdSchema,
  flowAssessmentProposalSchema,
  flowPlanSchema,
  readinessSchema,
  reconcileSignalSchema,
  revisionIdSchema,
  revisionSchema,
  type Capability,
  type ChangeMetadata,
  type DecisionRecord,
  type FlowAssessment,
  type FlowAssessmentProposal,
  type FlowPlan,
  type ScenarioProfile,
} from '../domain/types.js';
import {
  guardStrictPersistentInput,
  normalizedAbsoluteRealPathSchema,
  sourceRefLogicalKey,
} from '../domain/public.js';
import {
  buildChangeBaseContext,
  discoverCanonicalChangeDirectory,
  sealForNewMutation,
  type ChangeAuthorityContext,
} from './authority/context.js';
import { withChangeMutationLock } from './change-mutation-lock.js';
import { listDecisions } from './decisions.js';
import { rebindLiveDecisionsWithinChangeLock } from './decision-store.js';
import { assertDecisionReconcileTransactionFence } from './decision-reconcile-transaction.js';
import { appendJsonLine, pathExists, readJsonLines, readYaml, writeYaml } from './files.js';
import {
  assertExactAssessmentDecisionLinkage,
  compileFlowPlan,
  hashFlowPlan,
} from './flow.js';
import {
  ensureFlowArchiveWithinChangeLock,
  preflightFlowArchiveCompatibilityWithinChangeLock,
} from './flow-archive.js';
import { loadFlowPlanForTransactionRecoveryWithinChangeLock } from './flow-store-internal.js';
import {
  completeFlowAssessmentTransaction,
  createFlowAssessmentTransaction,
  flowAssessmentTransactionPath,
  loadFlowAssessmentTransaction,
  loadPendingFlowAssessmentTransaction,
  recordAcceptedFlowAssessmentTransaction,
  writeFlowAssessmentTransaction,
  type FlowAssessmentTransaction,
} from './flow-transaction.js';
import { changeArtifactPath, changeFlowPath, changeMetadataPath, changeRevisionsRoot } from './paths.js';
import { assertOrdinaryReconcileTransactionFence } from './ordinary-reconcile-transaction.js';
import {
  completeReconcileAuditWithinChangeLock,
  reconcileChangeWithinChangeLock,
} from './reconcile-internal.js';
import type { ReconcileResult } from './reconcile.js';
import { incrementBaseline, incrementRevision } from './revision-ids.js';
import {
  changedFlowAssessmentFields,
  flowAssessmentReconcileReason,
  reconcileLevelForFlowAssessmentChanges,
} from './reconcile-semantics.js';
import { getScenario } from './scenarios.js';
import type { ChangeRef } from './store.js';
import { persistChangeMetadataWithinChangeLock } from './change-metadata-internal.js';
import { assertTransactionLineageIntegrity } from './transaction-lineage-integrity.js';
import {
  beginFlowSemanticMutationWithinChangeLock,
  resumeFlowSemanticMutationWithinChangeLock,
  sourceReboundFlowRequest,
} from './flow-semantic-mutation.js';
import { assertSemanticMutationRequestPreflight } from './semantic-mutation-journal.js';
import { parseSourceLocator, resolveCurrentSource } from './source/resolver.js';
import {
  SourceResolutionError,
  type SourceLocator,
} from './source/types.js';

const READINESS_FOR_CAPABILITY: Partial<Record<Capability, keyof ChangeMetadata['readiness']>> = {
  frame: 'frame', research: 'research', map: 'map', model: 'domain', spec: 'spec', design: 'design', plan: 'plan',
  triage: 'triage', reproduce: 'reproduction', debug: 'diagnosis', diagnose: 'diagnosis', experiment: 'experiment',
  fix: 'fix', mitigate: 'mitigation', work: 'implementation', review: 'review', verify: 'verification', qa: 'qa',
  ship: 'release', canary: 'canary', learn: 'learning',
};

const mutationChannel = channel('omnai:core:change-mutation');
const reflectApplyIntrinsic = Reflect.apply;
const arrayPushIntrinsic = Array.prototype.push;
const jsonStringifyIntrinsic = JSON.stringify;
const SetIntrinsic = Set;
const setAddIntrinsic = Set.prototype.add;
const setHasIntrinsic = Set.prototype.has;

const flowAssessmentMutationClassificationSchema = z.strictObject({
  scale: z.enum(FLOW_SCALES),
  uncertainty: z.strictObject({
    problem: z.enum(FLOW_UNCERTAINTY),
    domain: z.enum(FLOW_UNCERTAINTY),
    solution: z.enum(FLOW_UNCERTAINTY),
    delivery: z.enum(FLOW_UNCERTAINTY),
  }),
  topology: z.enum(FLOW_TOPOLOGIES),
  architectureApplicability: z.enum(ARCHITECTURE_APPLICABILITIES),
  deliveryShape: z.enum(DELIVERY_SHAPES),
  decisionIds: z.array(decisionIdSchema),
});
const flowAssessmentMutationRequestSchema = guardStrictPersistentInput(z.strictObject({
  schemaVersion: z.literal(1),
  changeId: changeIdSchema,
  revision: revisionIdSchema,
  baseline: baselineIdSchema,
  assessment: flowAssessmentMutationClassificationSchema,
  sources: z.array(z.unknown()),
}));
type ParsedFlowAssessmentMutationRequestV1 = Omit<
  z.output<typeof flowAssessmentMutationRequestSchema>,
  'sources'
> & Readonly<{ sources: readonly SourceLocator[] }>;

// 非持久 mutation request：只携带 current locator，不接受 contentHash。
export type FlowAssessmentMutationRequestV1 = ParsedFlowAssessmentMutationRequestV1;

export async function applyFlowAssessment(
  repoRoot: string,
  change: ChangeRef,
  rawRequest: unknown,
): Promise<{ flow: FlowPlan; reconcile: ReconcileResult | null }> {
  const authenticatedRepoRoot = authenticateFlowRepositoryRoot(repoRoot);
  const authenticatedChange = authenticateFlowChangeRef(change);
  const request = parseFlowAssessmentMutationRequest(rawRequest);
  if (request.changeId !== authenticatedChange.metadata.id) throw new Error('FLOW_STALE_CHANGE');
  const directoryName = await discoverCanonicalChangeDirectory(
    authenticatedRepoRoot,
    request.changeId,
  );
  if (directoryName !== authenticatedChange.directoryName) {
    throw new Error('FLOW_CHANGE_REF_INVALID: canonical Change directory mismatch');
  }
  const canonicalChange: ChangeRef = {
    directoryName,
    metadata: authenticatedChange.metadata,
  };
  // PENDING identity 与 current source capture 必须属于同一个既有 Change lock 临界区；
  // 否则并发 writer 可在首次查询后发布 PENDING，使本次请求仍读取新 source。
  return withChangeMutationLock(
    authenticatedRepoRoot,
    canonicalChange,
    () => applyFlowAssessmentRequestWithinChangeLock(
      authenticatedRepoRoot,
      canonicalChange,
      request,
    ),
  );
}

async function applyFlowAssessmentRequestWithinChangeLock(
  repoRoot: string,
  change: ChangeRef,
  request: ParsedFlowAssessmentMutationRequestV1,
): Promise<{ flow: FlowPlan; reconcile: ReconcileResult | null }> {
  const pending = await loadPendingFlowAssessmentTransaction(repoRoot, change);
  if (pending !== null) {
    assertExactFrozenRetry(request, pending.proposal);
    await assertSemanticMutationRequestPreflight(
      repoRoot,
      change,
      'FLOW',
      sourceReboundFlowRequest(pending.proposal),
    );
    return applyFlowAssessmentWithinChangeLock(repoRoot, change, pending.proposal, null);
  }

  const resolved = await resolveFlowAssessmentRequest(repoRoot, request);
  if (resolved.context.revisionId !== request.revision) throw new Error('FLOW_STALE_REVISION');
  if (resolved.context.metadata.baseline !== request.baseline) throw new Error('FLOW_STALE_BASELINE');
  await assertSemanticMutationRequestPreflight(
    repoRoot,
    change,
    'FLOW',
    sourceReboundFlowRequest(resolved.proposal),
  );
  const current = resolved.context.flow;
  if (current !== null) {
    const candidate = compileFlowPlan(
      resolved.context.metadata,
      requireContextScenario(resolved.context, resolved.context.metadata.scenario),
      resolved.proposal.assessment,
      resolved.context.decisions,
      new Date().toISOString(),
    );
    if (candidate.inputHash === current.inputHash) return { flow: current, reconcile: null };
  }
  return applyFlowAssessmentWithinChangeLock(
    repoRoot,
    change,
    resolved.proposal,
    resolved.context,
  );
}

function parseFlowAssessmentMutationRequest(
  rawRequest: unknown,
): ParsedFlowAssessmentMutationRequestV1 {
  try {
    const parsed = flowAssessmentMutationRequestSchema.parse(rawRequest);
    requireCodeUnitSortedUniqueStrings(parsed.assessment.decisionIds);
    const sources: SourceLocator[] = [];
    const sourceKeys: string[] = [];
    for (let index = 0; index < parsed.sources.length; index += 1) {
      const source = parseSourceLocator(parsed.sources[index]);
      if (source.changeId !== parsed.changeId || source.revisionId !== parsed.revision) {
        throw new TypeError('FLOW_ASSESSMENT_SOURCE_CONTEXT_MISMATCH');
      }
      arrayPush(sources, source);
      arrayPush(sourceKeys, sourceRefLogicalKey(source));
    }
    requireCodeUnitSortedUniqueStrings(sourceKeys);
    return Object.freeze({
      ...parsed,
      sources: Object.freeze(sources),
    });
  } catch (cause) {
    throw new Error('FLOW_ASSESSMENT_REQUEST_INVALID', { cause });
  }
}

function authenticateFlowRepositoryRoot(rawRepoRoot: unknown): string {
  try {
    return normalizedAbsoluteRealPathSchema.parse(rawRepoRoot);
  } catch (cause) {
    throw new Error('FLOW_REPOSITORY_ROOT_INVALID', { cause });
  }
}

function authenticateFlowChangeRef(rawChange: unknown): ChangeRef {
  try {
    if (rawChange === null || typeof rawChange !== 'object' || isProxy(rawChange)) {
      throw new TypeError('ChangeRef object');
    }
    const prototype = Object.getPrototypeOf(rawChange);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('ChangeRef prototype');
    }
    const keys = Reflect.ownKeys(rawChange);
    if (keys.length !== 2 || !keys.includes('directoryName') || !keys.includes('metadata')) {
      throw new TypeError('ChangeRef own keys');
    }
    const directoryDescriptor = Object.getOwnPropertyDescriptor(rawChange, 'directoryName');
    const metadataDescriptor = Object.getOwnPropertyDescriptor(rawChange, 'metadata');
    if (directoryDescriptor === undefined || !('value' in directoryDescriptor)
      || directoryDescriptor.enumerable !== true
      || metadataDescriptor === undefined || !('value' in metadataDescriptor)
      || metadataDescriptor.enumerable !== true
      || typeof directoryDescriptor.value !== 'string') {
      throw new TypeError('ChangeRef data descriptors');
    }
    const metadata = changeMetadataSchema.parse(metadataDescriptor.value);
    const directoryName = directoryDescriptor.value;
    if (directoryName !== `${metadata.id}-${metadata.slug}`) {
      throw new TypeError('ChangeRef canonical directory');
    }
    return { directoryName, metadata };
  } catch (cause) {
    throw new Error('FLOW_CHANGE_REF_INVALID', { cause });
  }
}

async function resolveFlowAssessmentRequest(
  repoRoot: string,
  request: ParsedFlowAssessmentMutationRequestV1,
): Promise<Readonly<{
  context: ChangeAuthorityContext;
  proposal: FlowAssessmentProposal;
}>> {
  const sourceRefs: FlowAssessment['sourceRefs'][number][] = [];
  let context: ChangeAuthorityContext;
  try {
    const base = await buildChangeBaseContext(repoRoot, request.changeId);
    context = await sealForNewMutation(base, async (session) => {
      for (let index = 0; index < request.sources.length; index += 1) {
        const resolved = await resolveCurrentSource(session, request.sources[index]!);
        arrayPush(sourceRefs, resolved.sourceRef);
      }
    });
  } catch (cause) {
    if (cause instanceof SourceResolutionError
      && cause.code === 'SOURCE_IDENTITY_MISSING'
      && hasDecisionSource(request.sources)) {
      throw new Error('FLOW_ASSESSMENT_DECISION_LINKAGE_MISMATCH', { cause });
    }
    throw cause;
  }

  let proposal: FlowAssessmentProposal;
  try {
    proposal = flowAssessmentProposalSchema.parse({
      schemaVersion: 2,
      changeId: request.changeId,
      revision: request.revision,
      baseline: request.baseline,
      assessment: { ...request.assessment, sourceRefs },
    });
    assertExactAssessmentDecisionLinkage(proposal.assessment, context.decisions);
  } catch (cause) {
    throw new Error('FLOW_ASSESSMENT_DECISION_LINKAGE_MISMATCH', { cause });
  }
  return Object.freeze({ context, proposal });
}

function assertExactFrozenRetry(
  request: ParsedFlowAssessmentMutationRequestV1,
  frozen: FlowAssessmentProposal,
): void {
  const frozenClassification = {
    scale: frozen.assessment.scale,
    uncertainty: frozen.assessment.uncertainty,
    topology: frozen.assessment.topology,
    architectureApplicability: frozen.assessment.architectureApplicability,
    deliveryShape: frozen.assessment.deliveryShape,
    decisionIds: frozen.assessment.decisionIds,
  };
  const requestLocators = sourceLogicalKeys(request.sources);
  const frozenLocators = sourceLogicalKeys(frozen.assessment.sourceRefs);
  if (request.schemaVersion !== 1
    || frozen.schemaVersion !== 2
    || request.changeId !== frozen.changeId
    || request.revision !== frozen.revision
    || request.baseline !== frozen.baseline
    || stringifyJson(request.assessment) !== stringifyJson(frozenClassification)
    || stringifyJson(requestLocators) !== stringifyJson(frozenLocators)) {
    throw new Error('FLOW_TRANSACTION_PENDING: proposal mismatch');
  }
}

function requireCodeUnitSortedUniqueStrings(values: readonly string[]): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) {
      throw new TypeError('FLOW_ASSESSMENT_REQUEST_ORDER_INVALID');
    }
  }
}

function requireContextScenario(
  context: ChangeAuthorityContext,
  scenarioId: string,
): ScenarioProfile {
  for (let index = 0; index < context.authorityCatalog.scenarioProfiles.length; index += 1) {
    const candidate = context.authorityCatalog.scenarioProfiles[index]!;
    if (candidate.id === scenarioId) return candidate;
  }
  throw new Error('FLOW_SCENARIO_CONTEXT_MISMATCH');
}

function arrayPush<Value>(array: Value[], value: Value): void {
  reflectApplyIntrinsic(arrayPushIntrinsic, array, [value]);
}

function setAdd<Value>(set: Set<Value>, value: Value): void {
  reflectApplyIntrinsic(setAddIntrinsic, set, [value]);
}

function setHas<Value>(set: Set<Value>, value: Value): boolean {
  return reflectApplyIntrinsic(setHasIntrinsic, set, [value]) as boolean;
}

function sourceLogicalKeys(
  sources: readonly (SourceLocator | FlowAssessment['sourceRefs'][number])[],
): readonly string[] {
  const keys: string[] = [];
  for (let index = 0; index < sources.length; index += 1) {
    arrayPush(keys, sourceRefLogicalKey(sources[index]!));
  }
  return keys;
}

function hasDecisionSource(sources: readonly SourceLocator[]): boolean {
  for (let index = 0; index < sources.length; index += 1) {
    if (sources[index]!.kind === 'decision') return true;
  }
  return false;
}

function stringifyJson(value: unknown): string {
  return reflectApplyIntrinsic(jsonStringifyIntrinsic, JSON, [value]) as string;
}

async function applyFlowAssessmentWithinChangeLock(
  repoRoot: string,
  change: ChangeRef,
  proposal: FlowAssessmentProposal,
  context: ChangeAuthorityContext | null,
): Promise<{ flow: FlowPlan; reconcile: ReconcileResult | null }> {
  await assertTransactionLineageIntegrity(repoRoot, change);
  await assertDecisionReconcileTransactionFence(repoRoot, change);
  await assertOrdinaryReconcileTransactionFence(repoRoot, change);
  const parsed = flowAssessmentProposalSchema.parse(proposal);
  const persisted = await readYaml(changeMetadataPath(repoRoot, change.directoryName), changeMetadataSchema);
  if (parsed.changeId !== change.metadata.id || persisted.id !== parsed.changeId) throw new Error('FLOW_STALE_CHANGE');
  const pending = await loadPendingFlowAssessmentTransaction(repoRoot, change);
  if (pending) {
    if (stringifyJson(pending.proposal) !== stringifyJson(parsed)) {
      throw new Error(`FLOW_TRANSACTION_PENDING: ${pending.correlationId}`);
    }
    return continuePendingFlowAssessment(repoRoot, change, pending, persisted);
  }
  if (context === null) throw new Error('FLOW_AUTHORITY_CONTEXT_REQUIRED');
  if (persisted.activeRevision !== parsed.revision || persisted.baseline !== parsed.baseline) {
    if (persisted.activeRevision === parsed.revision) throw new Error('FLOW_STALE_BASELINE');
    if (persisted.baseline === parsed.baseline) throw new Error('FLOW_STALE_REVISION');
    return recoverFlowAssessment(repoRoot, change, parsed, persisted);
  }
  if (change.metadata.activeRevision !== parsed.revision) throw new Error('FLOW_STALE_REVISION');
  if (change.metadata.baseline !== parsed.baseline) throw new Error('FLOW_STALE_BASELINE');
  change.metadata = persisted;
  const semanticRequest = sourceReboundFlowRequest(parsed);
  const semanticRecovery = await resumeFlowSemanticMutationWithinChangeLock(
    repoRoot,
    change,
    semanticRequest,
  );
  if (semanticRecovery.handled) {
    if (!semanticRecovery.flow) throw new Error('FLOW_PLAN_REQUIRED');
    return { flow: semanticRecovery.flow, reconcile: null };
  }

  const current = context.flow;
  if (!current) throw new Error('FLOW_PLAN_REQUIRED');
  const decisions = context.decisions;
  const createdAt = new Date().toISOString();
  const candidate = compileFlowPlan(
    persisted,
    requireContextScenario(context, persisted.scenario),
    parsed.assessment,
    decisions,
    createdAt,
  );
  if (candidate.inputHash === current.inputHash) return { flow: current, reconcile: null };

  const changedFields = changedFlowAssessmentFields(current.assessment, candidate.assessment);
  if (changedFields.length === 0) {
    if (!isSourceOnlyAssessmentChange(current.assessment, candidate.assessment)) {
      throw new Error('FLOW_SOURCE_REBOUND_INVALID: only source references may change without Reconcile');
    }
    await assertSameRevisionInputs(repoRoot, change, parsed, current, decisions);
    publishStage('FLOW_SOURCE_BEFORE_WRITE', change);
    const target = await beginFlowSemanticMutationWithinChangeLock(
      repoRoot,
      change,
      semanticRequest,
      persisted,
      persisted,
      decisions,
      current,
      candidate,
      createdAt,
    );
    if (!target) throw new Error('FLOW_PLAN_REQUIRED');
    return { flow: target, reconcile: null };
  }

  await assertSameRevisionInputs(repoRoot, change, parsed, current, decisions);
  await preflightFlowArchiveCompatibilityWithinChangeLock(repoRoot, change, current);
  const transaction = createFlowAssessmentTransaction(
    parsed,
    current,
    decisions,
    `FLOW-${randomUUID()}`,
    new Date().toISOString(),
  );
  await writeFlowAssessmentTransaction(repoRoot, change, transaction);
  publishTransactionStage('FLOW_TRANSACTION_INTENT_WRITTEN', change, transaction.correlationId);
  await ensureFlowArchiveWithinChangeLock(repoRoot, change, current);
  return reconcilePendingFlowAssessment(repoRoot, change, transaction, current, current, decisions);
}

async function recoverFlowAssessment(
  repoRoot: string,
  change: ChangeRef,
  proposal: FlowAssessmentProposal,
  active: ChangeMetadata,
  knownTransaction?: FlowAssessmentTransaction,
): Promise<{ flow: FlowPlan; reconcile: ReconcileResult }> {
  if (active.activeRevision !== incrementRevision(proposal.revision)) throw new Error('FLOW_STALE_REVISION');
  if (active.baseline !== incrementBaseline(proposal.baseline)) throw new Error('FLOW_STALE_BASELINE');
  const durableTransactionPath = flowAssessmentTransactionPath(repoRoot, change, proposal.revision);
  if (!await pathExists(durableTransactionPath)) throw new Error('FLOW_STALE_REVISION');
  const transaction = knownTransaction ?? await loadFlowAssessmentTransaction(repoRoot, change, proposal.revision);
  if (stringifyJson(transaction.proposal) !== stringifyJson(proposal)) throw new Error('FLOW_TRANSACTION_PROPOSAL_MISMATCH');
  const oldPlan = await loadAndValidateArchivedPlan(repoRoot, change, transaction, active);
  change.metadata = active;
  const reconcile = await loadTransactionReconcileResult(repoRoot, change, transaction, active);
  if (transaction.status === 'COMPLETED') {
    return validateCompletedFlowAssessment(repoRoot, change, transaction, oldPlan, active, reconcile);
  }
  if (transaction.acceptedRevision === null) {
    await rebindLiveDecisionsWithinChangeLock(repoRoot, change, {
      fromRevision: transaction.proposal.revision,
      decisions: transaction.decisions,
      reboundAt: reconcile.revision.createdAt,
      correlationId: transaction.correlationId,
    });
  }
  let acceptedTransaction = transaction;
  const acceptedFlow = transaction.acceptedRevision === null
    ? await finalizeAcceptedState(repoRoot, change, transaction, oldPlan)
    : await validatePendingAcceptedState(repoRoot, change, transaction, active, reconcile);
  if (transaction.acceptedRevision === null) {
    acceptedTransaction = await recordAcceptedFlowAssessmentTransaction(repoRoot, change, transaction, acceptedFlow);
  }
  await completeReconcileAuditWithinChangeLock(repoRoot, change, reconcile);
  const changedFields = changedFlowAssessmentFields(oldPlan.assessment, transaction.proposal.assessment);
  await completeFlowAudit(repoRoot, change, acceptedTransaction, oldPlan, reconcile, changedFields);
  await completeFlowAssessmentTransaction(repoRoot, change, acceptedTransaction);
  return { flow: acceptedFlow, reconcile };
}

async function continuePendingFlowAssessment(
  repoRoot: string,
  change: ChangeRef,
  transaction: FlowAssessmentTransaction,
  active: ChangeMetadata,
): Promise<{ flow: FlowPlan; reconcile: ReconcileResult }> {
  if (active.activeRevision !== transaction.proposal.revision || active.baseline !== transaction.proposal.baseline) {
    return recoverFlowAssessment(repoRoot, change, transaction.proposal, active, transaction);
  }
  change.metadata = active;
  const current = await readStoredFlowPlanWithinLegacyWriter(repoRoot, change);
  if (!current) throw new Error('FLOW_TRANSACTION_ACTIVE_PLAN_MISSING');
  const decisions = await listDecisions(repoRoot, change);
  if (
    hashFlowPlan(current) !== transaction.oldPlanHash
    || stringifyJson(decisions) !== stringifyJson(transaction.decisions)
  ) throw new Error('FLOW_TRANSACTION_STATE_CONFLICT');
  await ensureFlowArchiveWithinChangeLock(repoRoot, change, current);
  const oldPlan = await loadAndValidateArchivedPlan(repoRoot, change, transaction, active);
  const expected = compileFlowPlan(
    active,
    await getScenario(active.scenario),
    oldPlan.assessment,
    decisions,
    new Date().toISOString(),
  );
  if (current.inputHash !== expected.inputHash) throw new Error('FLOW_TRANSACTION_STATE_CONFLICT');
  return reconcilePendingFlowAssessment(repoRoot, change, transaction, oldPlan, current, decisions);
}

async function reconcilePendingFlowAssessment(
  repoRoot: string,
  change: ChangeRef,
  transaction: FlowAssessmentTransaction,
  oldPlan: FlowPlan,
  preflightFlow: FlowPlan,
  decisions: readonly DecisionRecord[],
): Promise<{ flow: FlowPlan; reconcile: ReconcileResult }> {
  const changedFields = changedFlowAssessmentFields(oldPlan.assessment, transaction.proposal.assessment);
  if (changedFields.length === 0) throw new Error('FLOW_TRANSACTION_PROPOSAL_MISMATCH');
  let acceptedFlow: FlowPlan | null = null;
  let acceptedTransaction = transaction;
  const reconcile = await reconcileChangeWithinChangeLock(repoRoot, change, {
    level: reconcileLevelForFlowAssessmentChanges(changedFields),
    type: 'FLOW_ASSESSMENT_CHANGED',
    reason: flowAssessmentReconcileReason(changedFields),
    correlationId: transaction.correlationId,
  }, {
    expectedFlow: preflightFlow,
    expectedDecisions: decisions,
    flowTransactionCorrelationId: transaction.correlationId,
    finalize: async () => {
      acceptedFlow = await finalizeAcceptedState(repoRoot, change, transaction, oldPlan);
      acceptedTransaction = await recordAcceptedFlowAssessmentTransaction(repoRoot, change, transaction, acceptedFlow);
    },
  });

  if (!acceptedFlow) throw new Error('FLOW_FINALIZATION_INCOMPLETE');
  await completeFlowAudit(repoRoot, change, acceptedTransaction, oldPlan, reconcile, changedFields);
  await completeFlowAssessmentTransaction(repoRoot, change, acceptedTransaction);
  return { flow: acceptedFlow, reconcile };
}

async function loadAndValidateArchivedPlan(
  repoRoot: string,
  change: ChangeRef,
  transaction: FlowAssessmentTransaction,
  active: ChangeMetadata,
): Promise<FlowPlan> {
  const oldPlan = await readYaml(
    flowArchivePath(repoRoot, change, transaction.proposal.revision),
    flowPlanSchema,
  );
  if (hashFlowPlan(oldPlan) !== transaction.oldPlanHash) throw new Error('FLOW_TRANSACTION_ARCHIVE_MISMATCH');
  const archivedMetadata = {
    ...active,
    activeRevision: transaction.proposal.revision,
    baseline: transaction.proposal.baseline,
  };
  const expected = compileFlowPlan(
    archivedMetadata,
    await getScenario(archivedMetadata.scenario),
    oldPlan.assessment,
    transaction.decisions,
    new Date().toISOString(),
  );
  if (oldPlan.inputHash !== expected.inputHash) throw new Error('FLOW_TRANSACTION_ARCHIVE_MISMATCH');
  return oldPlan;
}

async function validatePendingAcceptedState(
  repoRoot: string,
  change: ChangeRef,
  transaction: FlowAssessmentTransaction,
  active: ChangeMetadata,
  reconcile: ReconcileResult,
): Promise<FlowPlan> {
  const accepted = requireAcceptedTransactionBinding(transaction);
  if (
    accepted.revision !== active.activeRevision ||
    accepted.baseline !== active.baseline ||
    accepted.revision !== reconcile.revision.id ||
    accepted.baseline !== reconcile.revision.baseline
  ) throw new Error('FLOW_TRANSACTION_COMPLETION_MISMATCH');

  const current = await readStoredFlowPlanWithinLegacyWriter(repoRoot, change);
  if (!current) throw new Error('FLOW_TRANSACTION_ACTIVE_PLAN_MISSING');
  const decisions = await listDecisions(repoRoot, change);
  const expected = compileFlowPlan(
    active,
    await getScenario(active.scenario),
    transaction.proposal.assessment,
    decisions,
    new Date().toISOString(),
  );
  if (
    stringifyJson(current.assessment) !== stringifyJson(expected.assessment) ||
    current.inputHash !== expected.inputHash
  ) throw new Error('FLOW_TRANSACTION_STATE_CONFLICT');

  const retainsAcceptedPlan = hashFlowPlan(current) === accepted.planHash;
  const retainsAcceptedInput = current.inputHash === accepted.inputHash;
  if (retainsAcceptedPlan !== retainsAcceptedInput) throw new Error('FLOW_TRANSACTION_STATE_CONFLICT');
  return current;
}

async function validateCompletedFlowAssessment(
  repoRoot: string,
  change: ChangeRef,
  transaction: FlowAssessmentTransaction,
  oldPlan: FlowPlan,
  active: ChangeMetadata,
  reconcile: ReconcileResult,
): Promise<{ flow: FlowPlan; reconcile: ReconcileResult }> {
  const accepted = requireAcceptedTransactionBinding(transaction);
  const { completedRevision, completedBaseline, newPlanHash } = transaction;
  if (
    completedRevision === null || completedBaseline === null || newPlanHash === null ||
    completedRevision !== active.activeRevision || completedBaseline !== active.baseline ||
    completedRevision !== reconcile.revision.id || completedBaseline !== reconcile.revision.baseline ||
    completedRevision !== accepted.revision || completedBaseline !== accepted.baseline || newPlanHash !== accepted.planHash
  ) throw new Error('FLOW_TRANSACTION_COMPLETION_MISMATCH');
  await assertCompletedAuditHistory(repoRoot, change, transaction, oldPlan, reconcile);

  const current = await readStoredFlowPlanWithinLegacyWriter(repoRoot, change);
  if (!current) throw new Error('FLOW_TRANSACTION_ACTIVE_PLAN_MISSING');
  if (
    changedFlowAssessmentFields(current.assessment, transaction.proposal.assessment).length > 0 ||
    stringifyJson(current.assessment.decisionIds) !== stringifyJson(transaction.proposal.assessment.decisionIds)
  ) throw new Error('FLOW_TRANSACTION_STATE_CONFLICT');
  const decisions = await listDecisions(repoRoot, change);
  const expected = compileFlowPlan(
    active,
    await getScenario(active.scenario),
    current.assessment,
    decisions,
    new Date().toISOString(),
  );
  if (current.inputHash !== expected.inputHash) throw new Error('FLOW_STALE_DECISION_STATE');
  return { flow: current, reconcile };
}

async function assertCompletedAuditHistory(
  repoRoot: string,
  change: ChangeRef,
  transaction: FlowAssessmentTransaction,
  oldPlan: FlowPlan,
  reconcile: ReconcileResult,
): Promise<void> {
  const events = await readJsonLines<{
    timestamp?: string;
    event?: string;
    changeId?: string;
    revision?: string;
    data?: {
      correlationId?: string;
      previousRevision?: string;
      previousBaseline?: string;
      baseline?: string;
      oldPlanHash?: string;
      newPlanHash?: string;
      affectedReadiness?: unknown;
      affectedTasks?: unknown;
    };
  }>(changeArtifactPath(repoRoot, change.directoryName, 'progress.jsonl'));
  const correlated = events.filter(({ data }) => data?.correlationId === transaction.correlationId);
  const reconcileEvents = correlated.filter(({ event }) => event === 'RECONCILE_APPLIED');
  const flowEvents = correlated.filter(({ event }) => event === 'FLOW_REASSESSED');
  if (reconcileEvents.length !== 1 || flowEvents.length !== 1) {
    throw new Error('FLOW_TRANSACTION_COMPLETION_MISMATCH');
  }
  const reconcileEvent = reconcileEvents[0]!;
  const flowEvent = flowEvents[0]!;
  if (
    reconcileEvent.timestamp !== reconcile.revision.createdAt ||
    reconcileEvent.changeId !== transaction.proposal.changeId ||
    reconcileEvent.revision !== transaction.completedRevision ||
    reconcileEvent.data?.previousRevision !== transaction.proposal.revision ||
    reconcileEvent.data?.previousBaseline !== transaction.proposal.baseline ||
    reconcileEvent.data?.baseline !== transaction.completedBaseline ||
    stringifyJson(reconcileEvent.data?.affectedReadiness) !== stringifyJson(reconcile.affectedReadiness) ||
    stringifyJson(reconcileEvent.data?.affectedTasks) !== stringifyJson(reconcile.affectedTasks) ||
    flowEvent.changeId !== transaction.proposal.changeId ||
    flowEvent.revision !== transaction.completedRevision ||
    flowEvent.data?.previousRevision !== oldPlan.revision ||
    flowEvent.data?.previousBaseline !== oldPlan.baseline ||
    flowEvent.data?.baseline !== transaction.completedBaseline ||
    flowEvent.data?.oldPlanHash !== transaction.oldPlanHash ||
    flowEvent.data?.newPlanHash !== transaction.newPlanHash
  ) throw new Error('FLOW_TRANSACTION_COMPLETION_MISMATCH');
}

async function finalizeAcceptedState(
  repoRoot: string,
  change: ChangeRef,
  transaction: FlowAssessmentTransaction,
  oldPlan: FlowPlan,
): Promise<FlowPlan> {
  const active = await readYaml(changeMetadataPath(repoRoot, change.directoryName), changeMetadataSchema);
  change.metadata = active;
  const current = await loadFlowPlanForTransactionRecoveryWithinChangeLock(repoRoot, change, active, oldPlan);
  const decisions = await listDecisions(repoRoot, change);
  const rebound = compileFlowPlan(
    active,
    await getScenario(active.scenario),
    oldPlan.assessment,
    decisions,
    new Date().toISOString(),
  );
  const candidate = compileFlowPlan(
    active,
    await getScenario(active.scenario),
    transaction.proposal.assessment,
    decisions,
    new Date().toISOString(),
  );
  const oldBinding = current.revision === oldPlan.revision && current.baseline === oldPlan.baseline;
  if (!oldBinding && current.inputHash !== rebound.inputHash && current.inputHash !== candidate.inputHash) {
    throw new Error('FLOW_TRANSACTION_STATE_CONFLICT');
  }

  if (enableNewlyActiveReadiness(change, oldPlan, candidate)) await persistChangeMetadata(repoRoot, change);
  if (current.inputHash === candidate.inputHash) return current;
  publishStage('FLOW_ACCEPTED_BEFORE_WRITE', change);
  await writeYaml(changeFlowPath(repoRoot, change.directoryName), flowPlanSchema.parse(candidate));
  return candidate;
}

async function assertSameRevisionInputs(
  repoRoot: string,
  change: ChangeRef,
  proposal: FlowAssessmentProposal,
  expectedFlow: FlowPlan,
  expectedDecisions: readonly DecisionRecord[],
): Promise<void> {
  const active = await readYaml(changeMetadataPath(repoRoot, change.directoryName), changeMetadataSchema);
  if (active.id !== proposal.changeId) throw new Error('FLOW_STALE_CHANGE');
  if (active.activeRevision !== proposal.revision) throw new Error('FLOW_STALE_REVISION');
  if (active.baseline !== proposal.baseline) throw new Error('FLOW_STALE_BASELINE');
  change.metadata = active;
  const flow = await readStoredFlowPlanWithinLegacyWriter(repoRoot, change);
  if (stringifyJson(flow) !== stringifyJson(expectedFlow)) throw new Error('FLOW_STALE_PLAN_STATE');
  const decisions = await listDecisions(repoRoot, change);
  if (stringifyJson(decisions) !== stringifyJson(expectedDecisions)) throw new Error('FLOW_STALE_DECISION_STATE');
}

async function loadTransactionReconcileResult(
  repoRoot: string,
  change: ChangeRef,
  transaction: FlowAssessmentTransaction,
  active: ChangeMetadata,
): Promise<ReconcileResult> {
  const revision = await readYaml(
    join(changeRevisionsRoot(repoRoot, change.directoryName), `${active.activeRevision}.yaml`),
    revisionSchema,
  );
  if (
    revision.id !== active.activeRevision ||
    revision.changeId !== transaction.proposal.changeId ||
    revision.operationRequestId !== transaction.correlationId ||
    revision.previousRevision !== transaction.proposal.revision ||
    revision.previousBaseline !== transaction.proposal.baseline ||
    revision.baseline !== active.baseline
  ) throw new Error('FLOW_TRANSACTION_REVISION_MISMATCH');
  const files = (await readdir(changeRevisionsRoot(repoRoot, change.directoryName)))
    .filter((file) => file.endsWith('.signal.yaml'));
  const signals: Array<z.infer<typeof reconcileSignalSchema>> = [];
  for (const file of files) {
    const candidate = await readYaml(join(changeRevisionsRoot(repoRoot, change.directoryName), file), reconcileSignalSchema);
    if (candidate.operationRequestId === transaction.correlationId) arrayPush(signals, candidate);
  }
  const signal = signals[0];
  if (
    signals.length !== 1 || !signal ||
    signal.signalType !== 'FLOW_ASSESSMENT_CHANGED' ||
    signal.changeId !== transaction.proposal.changeId ||
    signal.revision !== transaction.proposal.revision ||
    signal.level !== revision.level ||
    signal.reason !== revision.reason ||
    signal.createdAt !== revision.createdAt
  ) throw new Error('FLOW_TRANSACTION_SIGNAL_MISSING');
  return {
    signal,
    revision,
    affectedReadiness: revision.affectedReadiness,
    affectedTasks: revision.affectedTasks,
  };
}

async function completeFlowAudit(
  repoRoot: string,
  change: ChangeRef,
  transaction: FlowAssessmentTransaction,
  oldPlan: FlowPlan,
  reconcile: ReconcileResult,
  changedFields: readonly string[],
): Promise<void> {
  const accepted = requireAcceptedTransactionBinding(transaction);
  const progressPath = changeArtifactPath(repoRoot, change.directoryName, 'progress.jsonl');
  const events = await readJsonLines<FlowAuditEvent>(progressPath);
  const correlated = events.filter((event) => (
    event.event === 'FLOW_REASSESSED' && event.data?.correlationId === transaction.correlationId
  ));
  if (correlated.length > 1) throw new Error('FLOW_TRANSACTION_COMPLETION_MISMATCH');
  if (correlated.length === 1) {
    assertFlowAuditMatches(correlated[0]!, transaction, oldPlan, accepted);
    return;
  }
  if (reconcile.signal.operationRequestId !== transaction.correlationId) {
    throw new Error('FLOW_TRANSACTION_COMPLETION_MISMATCH');
  }
  await appendJsonLine(progressPath, {
    timestamp: new Date().toISOString(),
    event: 'FLOW_REASSESSED',
    changeId: transaction.proposal.changeId,
    revision: accepted.revision,
    detail: `Accepted FlowPlan assessment changes: ${changedFields.join(', ')}`,
    data: {
      previousRevision: oldPlan.revision,
      previousBaseline: oldPlan.baseline,
      baseline: accepted.baseline,
      oldPlanHash: transaction.oldPlanHash,
      newPlanHash: accepted.planHash,
      correlationId: transaction.correlationId,
    },
  });
  publishStage('FLOW_REASSESSED_AUDITED', change);
}

interface FlowAuditEvent {
  event?: string;
  changeId?: string;
  revision?: string;
  data?: {
    correlationId?: string;
    previousRevision?: string;
    previousBaseline?: string;
    baseline?: string;
    oldPlanHash?: string;
    newPlanHash?: string;
  };
}

interface AcceptedTransactionBinding {
  revision: string;
  baseline: string;
  inputHash: string;
  planHash: string;
}

function requireAcceptedTransactionBinding(transaction: FlowAssessmentTransaction): AcceptedTransactionBinding {
  if (
    transaction.acceptedRevision === null ||
    transaction.acceptedBaseline === null ||
    transaction.acceptedInputHash === null ||
    transaction.acceptedPlanHash === null
  ) throw new Error('FLOW_TRANSACTION_ACCEPTED_INCOMPLETE');
  return {
    revision: transaction.acceptedRevision,
    baseline: transaction.acceptedBaseline,
    inputHash: transaction.acceptedInputHash,
    planHash: transaction.acceptedPlanHash,
  };
}

function assertFlowAuditMatches(
  event: FlowAuditEvent,
  transaction: FlowAssessmentTransaction,
  oldPlan: FlowPlan,
  accepted: AcceptedTransactionBinding,
): void {
  if (
    event.changeId !== transaction.proposal.changeId ||
    event.revision !== accepted.revision ||
    event.data?.correlationId !== transaction.correlationId ||
    event.data?.previousRevision !== oldPlan.revision ||
    event.data?.previousBaseline !== oldPlan.baseline ||
    event.data?.baseline !== accepted.baseline ||
    event.data?.oldPlanHash !== transaction.oldPlanHash ||
    event.data?.newPlanHash !== accepted.planHash
  ) throw new Error('FLOW_TRANSACTION_COMPLETION_MISMATCH');
}

function flowArchivePath(repoRoot: string, change: ChangeRef, revision: string): string {
  return join(changeRevisionsRoot(repoRoot, change.directoryName), `${revision}.flow.yaml`);
}

function isSourceOnlyAssessmentChange(current: FlowAssessment, next: FlowAssessment): boolean {
  return (
    changedFlowAssessmentFields(current, next).length === 0 &&
    stringifyJson(current.decisionIds) === stringifyJson(next.decisionIds) &&
    stringifyJson(current.sourceRefs) !== stringifyJson(next.sourceRefs)
  );
}

function publishStage(
  stage: 'FLOW_SOURCE_BEFORE_WRITE' | 'FLOW_ACCEPTED_BEFORE_WRITE' | 'FLOW_REASSESSED_AUDITED',
  change: ChangeRef,
): void {
  mutationChannel.publish({ stage, changeId: change.metadata.id });
}

function publishTransactionStage(stage: string, change: ChangeRef, correlationId: string): void {
  mutationChannel.publish({ stage, changeId: change.metadata.id, correlationId });
}

function enableNewlyActiveReadiness(change: ChangeRef, previous: FlowPlan, next: FlowPlan): boolean {
  const previouslyActive = new SetIntrinsic<Capability>();
  for (let index = 0; index < previous.capabilities.length; index += 1) {
    const row = previous.capabilities[index]!;
    if (row.active) setAdd(previouslyActive, row.capability);
  }
  let changed = false;
  for (const capability of next.capabilities) {
    if (!capability.active || setHas(previouslyActive, capability.capability)) continue;
    const readiness = READINESS_FOR_CAPABILITY[capability.capability];
    if (readiness && change.metadata.readiness[readiness] === 'NOT_APPLICABLE') {
      change.metadata.readiness[readiness] = 'MISSING';
      changed = true;
    }
  }
  return changed;
}

async function persistChangeMetadata(repoRoot: string, change: ChangeRef): Promise<void> {
  await persistChangeMetadataWithinChangeLock(
    repoRoot,
    change,
    change.metadata,
    new Date().toISOString(),
  );
}

// Plan04 WriterFence 前，flow-assessment.ts 仍是批准的 durable writer；这里仅替换已关闭的
// public Flow reader，不创建新的 writer/owner/closure。
async function readStoredFlowPlanWithinLegacyWriter(
  repoRoot: string,
  change: ChangeRef,
): Promise<FlowPlan | null> {
  const path = changeFlowPath(repoRoot, change.directoryName);
  return await pathExists(path) ? readYaml(path, flowPlanSchema) : null;
}
