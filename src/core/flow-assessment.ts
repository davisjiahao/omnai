import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  changeMetadataSchema,
  flowAssessmentProposalSchema,
  flowPlanSchema,
  readinessSchema,
  reconcileSignalSchema,
  revisionSchema,
  type Capability,
  type ChangeMetadata,
  type DecisionRecord,
  type FlowAssessment,
  type FlowAssessmentProposal,
  type FlowPlan,
} from '../domain/types.js';
import { withChangeMutationLock } from './change-mutation-lock.js';
import { listDecisions } from './decisions.js';
import { rebindLiveDecisionsWithinChangeLock } from './decision-store.js';
import { assertDecisionReconcileTransactionFence } from './decision-reconcile-transaction.js';
import { appendJsonLine, pathExists, readJsonLines, readYaml, writeYaml } from './files.js';
import { compileFlowPlan, hashFlowPlan } from './flow.js';
import {
  ensureFlowArchiveWithinChangeLock,
  preflightFlowArchiveCompatibilityWithinChangeLock,
} from './flow-archive.js';
import { loadFlowPlan } from './flow-store.js';
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

const READINESS_FOR_CAPABILITY: Partial<Record<Capability, keyof ChangeMetadata['readiness']>> = {
  frame: 'frame', research: 'research', map: 'map', model: 'domain', spec: 'spec', design: 'design', plan: 'plan',
  triage: 'triage', reproduce: 'reproduction', debug: 'diagnosis', diagnose: 'diagnosis', experiment: 'experiment',
  fix: 'fix', mitigate: 'mitigation', work: 'implementation', review: 'review', verify: 'verification', qa: 'qa',
  ship: 'release', canary: 'canary', learn: 'learning',
};

const mutationChannel = channel('omnai:core:change-mutation');

export async function applyFlowAssessment(
  repoRoot: string,
  change: ChangeRef,
  proposal: FlowAssessmentProposal,
): Promise<{ flow: FlowPlan; reconcile: ReconcileResult | null }> {
  const parsed = flowAssessmentProposalSchema.parse(proposal);
  await assertSemanticMutationRequestPreflight(
    repoRoot,
    change,
    'FLOW',
    sourceReboundFlowRequest(parsed),
  );
  return withChangeMutationLock(
    repoRoot,
    change,
    () => applyFlowAssessmentWithinChangeLock(repoRoot, change, parsed),
  );
}

async function applyFlowAssessmentWithinChangeLock(
  repoRoot: string,
  change: ChangeRef,
  proposal: FlowAssessmentProposal,
): Promise<{ flow: FlowPlan; reconcile: ReconcileResult | null }> {
  await assertTransactionLineageIntegrity(repoRoot, change);
  await assertDecisionReconcileTransactionFence(repoRoot, change);
  await assertOrdinaryReconcileTransactionFence(repoRoot, change);
  const parsed = flowAssessmentProposalSchema.parse(proposal);
  const persisted = await readYaml(changeMetadataPath(repoRoot, change.directoryName), changeMetadataSchema);
  if (parsed.changeId !== change.metadata.id || persisted.id !== parsed.changeId) throw new Error('FLOW_STALE_CHANGE');
  const pending = await loadPendingFlowAssessmentTransaction(repoRoot, change);
  if (pending) {
    if (JSON.stringify(pending.proposal) !== JSON.stringify(parsed)) {
      throw new Error(`FLOW_TRANSACTION_PENDING: ${pending.correlationId}`);
    }
    return continuePendingFlowAssessment(repoRoot, change, pending, persisted);
  }
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

  const current = await loadFlowPlan(repoRoot, change);
  if (!current) throw new Error('FLOW_PLAN_REQUIRED');
  const decisions = await listDecisions(repoRoot, change);
  const createdAt = new Date().toISOString();
  const candidate = compileFlowPlan(
    persisted,
    getScenario(persisted.scenario),
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
  if (JSON.stringify(transaction.proposal) !== JSON.stringify(proposal)) throw new Error('FLOW_TRANSACTION_PROPOSAL_MISMATCH');
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
  const current = await loadFlowPlan(repoRoot, change);
  if (!current) throw new Error('FLOW_TRANSACTION_ACTIVE_PLAN_MISSING');
  const decisions = await listDecisions(repoRoot, change);
  if (
    hashFlowPlan(current) !== transaction.oldPlanHash
    || JSON.stringify(decisions) !== JSON.stringify(transaction.decisions)
  ) throw new Error('FLOW_TRANSACTION_STATE_CONFLICT');
  await ensureFlowArchiveWithinChangeLock(repoRoot, change, current);
  const oldPlan = await loadAndValidateArchivedPlan(repoRoot, change, transaction, active);
  const expected = compileFlowPlan(
    active,
    getScenario(active.scenario),
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
    getScenario(archivedMetadata.scenario),
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

  const current = await loadFlowPlan(repoRoot, change);
  if (!current) throw new Error('FLOW_TRANSACTION_ACTIVE_PLAN_MISSING');
  const decisions = await listDecisions(repoRoot, change);
  const expected = compileFlowPlan(
    active,
    getScenario(active.scenario),
    transaction.proposal.assessment,
    decisions,
    new Date().toISOString(),
  );
  if (
    JSON.stringify(current.assessment) !== JSON.stringify(expected.assessment) ||
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

  const current = await loadFlowPlan(repoRoot, change);
  if (!current) throw new Error('FLOW_TRANSACTION_ACTIVE_PLAN_MISSING');
  if (
    changedFlowAssessmentFields(current.assessment, transaction.proposal.assessment).length > 0 ||
    JSON.stringify(current.assessment.decisionIds) !== JSON.stringify(transaction.proposal.assessment.decisionIds)
  ) throw new Error('FLOW_TRANSACTION_STATE_CONFLICT');
  const decisions = await listDecisions(repoRoot, change);
  const expected = compileFlowPlan(
    active,
    getScenario(active.scenario),
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
    JSON.stringify(reconcileEvent.data?.affectedReadiness) !== JSON.stringify(reconcile.affectedReadiness) ||
    JSON.stringify(reconcileEvent.data?.affectedTasks) !== JSON.stringify(reconcile.affectedTasks) ||
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
    getScenario(active.scenario),
    oldPlan.assessment,
    decisions,
    new Date().toISOString(),
  );
  const candidate = compileFlowPlan(
    active,
    getScenario(active.scenario),
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
  const flow = await loadFlowPlan(repoRoot, change);
  if (JSON.stringify(flow) !== JSON.stringify(expectedFlow)) throw new Error('FLOW_STALE_PLAN_STATE');
  const decisions = await listDecisions(repoRoot, change);
  if (JSON.stringify(decisions) !== JSON.stringify(expectedDecisions)) throw new Error('FLOW_STALE_DECISION_STATE');
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
    if (candidate.operationRequestId === transaction.correlationId) signals.push(candidate);
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
    JSON.stringify(current.decisionIds) === JSON.stringify(next.decisionIds) &&
    JSON.stringify(current.sourceRefs) !== JSON.stringify(next.sourceRefs)
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
  const previouslyActive = new Set(previous.capabilities.filter(({ active }) => active).map(({ capability }) => capability));
  let changed = false;
  for (const capability of next.capabilities) {
    if (!capability.active || previouslyActive.has(capability.capability)) continue;
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
