import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  changeMetadataSchema,
  decisionRecordSchema,
  flowPlanSchema,
  reconcileSignalSchema,
  revisionSchema,
  type DecisionRecord,
  type FlowAssessmentProposal,
  type FlowPlan,
} from '../domain/types.js';
import { listDecisions } from './decision-inventory.js';
import { readJsonLines, readYaml } from './files.js';
import { compileFlowPlan, hashFlowPlan } from './flow.js';
import { changeArtifactPath, changeFlowPath, changeMetadataPath, changeRevisionsRoot } from './paths.js';
import {
  changedFlowAssessmentFields,
  flowAssessmentReconcileReason,
  readinessClosureForReconcileLevel,
  reconcileLevelForFlowAssessmentChanges,
} from './reconcile-semantics.js';
import { getScenario } from './scenarios.js';
import type { ChangeRef } from './store.js';
import {
  assertLateDecisionTransitionHistory,
  type DecisionTransitionAudit,
} from './decision-transition.js';

export interface PendingAcceptedFlowAuthority {
  proposal: FlowAssessmentProposal;
  oldPlanHash: string;
  decisions: readonly DecisionRecord[];
  correlationId: string;
  acceptedRevision: string;
  acceptedBaseline: string;
  acceptedInputHash: string;
  acceptedPlanHash: string;
  acceptedPlan: FlowPlan;
}

/** @internal Read-only proof for the narrow audited-terminal Decision compatibility window. */
export async function assertTerminalFlowAuthority(
  repoRoot: string,
  change: ChangeRef,
  transaction: PendingAcceptedFlowAuthority,
): Promise<void> {
  try {
    const active = await readYaml(changeMetadataPath(repoRoot, change.directoryName), changeMetadataSchema);
    if (
      active.id !== transaction.proposal.changeId
      || active.activeRevision !== transaction.acceptedRevision
      || active.baseline !== transaction.acceptedBaseline
    ) fail();

    const revisionsRoot = changeRevisionsRoot(repoRoot, change.directoryName);
    const revisionFiles = (await readdir(revisionsRoot))
      .filter((file) => /^REV-\d{4}\.yaml$/.test(file))
      .sort();
    const correlatedRevisions = [];
    for (const file of revisionFiles) {
      const revision = await readYaml(join(revisionsRoot, file), revisionSchema);
      if (`${revision.id}.yaml` !== file) fail();
      if (revision.operationRequestId === transaction.correlationId) correlatedRevisions.push(revision);
    }
    if (correlatedRevisions.length !== 1) fail();
    const revision = correlatedRevisions[0]!;
    const oldPlan = await readYaml(
      join(revisionsRoot, `${transaction.proposal.revision}.flow.yaml`),
      flowPlanSchema,
    );
    if (
      oldPlan.changeId !== transaction.proposal.changeId
      || oldPlan.revision !== transaction.proposal.revision
      || oldPlan.baseline !== transaction.proposal.baseline
      || hashFlowPlan(oldPlan) !== transaction.oldPlanHash
    ) fail();
    const changedFields = changedFlowAssessmentFields(oldPlan.assessment, transaction.proposal.assessment);
    const level = reconcileLevelForFlowAssessmentChanges(changedFields);
    const reason = flowAssessmentReconcileReason(changedFields);
    const readiness = readinessClosureForReconcileLevel(level);
    if (
      revision.id !== transaction.acceptedRevision
      || revision.changeId !== transaction.proposal.changeId
      || revision.previousRevision !== transaction.proposal.revision
      || revision.previousBaseline !== transaction.proposal.baseline
      || revision.baseline !== transaction.acceptedBaseline
      || revision.operationRequestId !== transaction.correlationId
      || revision.level !== level
      || revision.reason !== reason
      || JSON.stringify(revision.affectedReadiness) !== JSON.stringify(readiness)
      || JSON.stringify(revision.affectedTasks) !== JSON.stringify([])
    ) fail();

    const signalFiles = (await readdir(revisionsRoot))
      .filter((file) => file.endsWith('.signal.yaml'))
      .sort();
    const correlatedSignals = [];
    for (const file of signalFiles) {
      const signal = await readYaml(join(revisionsRoot, file), reconcileSignalSchema);
      if (`${signal.id}.signal.yaml` !== file) fail();
      if (signal.operationRequestId === transaction.correlationId) correlatedSignals.push(signal);
    }
    if (correlatedSignals.length !== 1) fail();
    const signal = correlatedSignals[0]!;
    if (
      signal.changeId !== transaction.proposal.changeId
      || signal.revision !== transaction.proposal.revision
      || signal.signalType !== 'FLOW_ASSESSMENT_CHANGED'
      || signal.level !== level
      || signal.reason !== reason
      || JSON.stringify(signal.affectedTasks) !== JSON.stringify([])
      || JSON.stringify(signal.evidenceIds) !== JSON.stringify([])
      || signal.createdAt !== revision.createdAt
    ) fail();

    const currentDecisions = await listDecisions(repoRoot, { ...change, metadata: active });
    const expectedAcceptedDecisions = transaction.decisions.map((decision) => decisionRecordSchema.parse(
      decision.status === 'OPEN' || decision.status === 'BLOCKED'
        ? { ...decision, openedRevision: transaction.acceptedRevision, updatedAt: revision.createdAt }
        : decision
    ));
    const canonicalAcceptedFlow = compileFlowPlan(
      active,
      getScenario(active.scenario),
      transaction.proposal.assessment,
      expectedAcceptedDecisions,
      transaction.acceptedPlan.compiledAt,
    );
    if (
      transaction.acceptedPlan.changeId !== transaction.proposal.changeId
      || transaction.acceptedPlan.revision !== transaction.acceptedRevision
      || transaction.acceptedPlan.baseline !== transaction.acceptedBaseline
      || transaction.acceptedPlan.inputHash !== transaction.acceptedInputHash
      || hashFlowPlan(transaction.acceptedPlan) !== transaction.acceptedPlanHash
      || JSON.stringify(transaction.acceptedPlan) !== JSON.stringify(canonicalAcceptedFlow)
    ) fail();
    const hasLateDecisionState = JSON.stringify(currentDecisions) !== JSON.stringify(expectedAcceptedDecisions);
    const activeFlow = await readYaml(changeFlowPath(repoRoot, change.directoryName), flowPlanSchema);
    const canonicalFlow = compileFlowPlan(
      active,
      getScenario(active.scenario),
      transaction.proposal.assessment,
      currentDecisions,
      activeFlow.compiledAt,
    );
    if (
      activeFlow.changeId !== active.id
      || activeFlow.revision !== active.activeRevision
      || activeFlow.baseline !== active.baseline
      || JSON.stringify(activeFlow.assessment) !== JSON.stringify(transaction.proposal.assessment)
      || JSON.stringify(activeFlow.decisionIds) !== JSON.stringify(currentDecisions.map(({ id }) => id))
      || JSON.stringify(activeFlow) !== JSON.stringify(canonicalFlow)
    ) fail();
    if (!hasLateDecisionState && JSON.stringify(activeFlow) !== JSON.stringify(transaction.acceptedPlan)) fail();
    if (hasLateDecisionState) {
      await assertLateDecisionHistory(repoRoot, change, transaction, expectedAcceptedDecisions, currentDecisions);
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'FLOW_TRANSACTION_COMPLETION_MISMATCH') throw error;
    throw new Error('FLOW_TRANSACTION_COMPLETION_MISMATCH', { cause: error });
  }
}

async function assertLateDecisionHistory(
  repoRoot: string,
  change: ChangeRef,
  transaction: PendingAcceptedFlowAuthority,
  accepted: readonly DecisionRecord[],
  current: readonly DecisionRecord[],
): Promise<void> {
  const events = await readJsonLines<DecisionTransitionAudit & {
    data?: DecisionTransitionAudit['data'] & { correlationId?: string };
  }>(changeArtifactPath(repoRoot, change.directoryName, 'progress.jsonl'));
  const terminalIndex = events.findIndex((event) => (
    event.event === 'FLOW_REASSESSED' && event.data?.correlationId === transaction.correlationId
  ));
  if (terminalIndex < 0) fail();
  const lateEvents = events.slice(terminalIndex + 1);
  assertLateDecisionTransitionHistory(
    accepted,
    current,
    lateEvents,
    transaction.proposal.changeId,
    transaction.acceptedRevision,
    transaction.acceptedBaseline,
  );
}

function fail(): never {
  throw new Error('FLOW_TRANSACTION_COMPLETION_MISMATCH');
}
