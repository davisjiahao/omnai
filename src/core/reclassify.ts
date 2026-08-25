import { channel } from 'node:diagnostics_channel';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  changeMetadataSchema,
  type ChangeMetadata,
} from '../domain/types.js';
import { withChangeMutationLock } from './change-mutation-lock.js';
import { hashCanonicalArtifact } from './canonical-hash-internal.js';
import { assertDecisionReconcileTransactionFence } from './decision-reconcile-transaction.js';
import { ensureDir, pathExists, readText, readYaml, writeTextAtomic } from './files.js';
import { assertFlowTransactionFence } from './flow-transaction.js';
import {
  assertOrdinaryReconcileTransactionFence,
  loadOrdinaryReconcileTransactionForSourceRevision,
} from './ordinary-reconcile-transaction.js';
import { resultForCompletedTransaction } from './ordinary-reconcile-recovery.js';
import {
  reconcileOrdinaryWithinChangeLock,
  type ReconcileResult,
} from './ordinary-reconcile-orchestration.js';
import { changeArtifactPath, changeMetadataPath, changeRoot } from './paths.js';
import { incrementBaseline, incrementRevision } from './revision-ids.js';
import { getScenario } from './scenarios.js';
import {
  assertSemanticMutationFence,
  assertSemanticMutationRequestPreflight,
  completeSemanticMutationTransaction,
  ensureSemanticMutationAudits,
  loadCompletedSemanticMutationForSource,
  loadPendingSemanticMutation,
  nextSemanticMutationIdentity,
  semanticMutationTransactionSchema,
  writeSemanticMutationTransaction,
  type ScenarioSemanticMutation,
} from './semantic-mutation-journal.js';
import type { ChangeRef } from './store.js';
import { loadTasks } from './tasks.js';
import { assertTransactionLineageIntegrity } from './transaction-lineage-integrity.js';
import {
  scenarioArtifactSpecifications,
  scenarioReclassificationMetadata,
} from './scenario-reclassification-target.js';

export interface ReclassifyResult {
  change: ChangeRef;
  reconcile: ReconcileResult;
}

const mutationChannel = channel('omnai:core:change-mutation');

export async function reclassifyChange(
  repoRoot: string,
  change: ChangeRef,
  scenarioId: string,
  reason = 'Scenario profile reclassified',
): Promise<ReclassifyResult> {
  const request = { scenarioId, reason };
  await assertSemanticMutationRequestPreflight(repoRoot, change, 'SCENARIO_RECLASSIFY', request);
  const pending = await loadPendingSemanticMutation(repoRoot, change);
  if (!pending) {
    // Read-only fast fences preserve zero-side-effect rejection, including a stale crashed lock owner.
    await assertFlowTransactionFence(repoRoot, change);
    await assertDecisionReconcileTransactionFence(repoRoot, change);
    await assertOrdinaryReconcileTransactionFence(repoRoot, change);
  }
  return withChangeMutationLock(
    repoRoot,
    change,
    () => reclassifyWithinChangeLock(repoRoot, change, request),
  );
}

async function reclassifyWithinChangeLock(
  repoRoot: string,
  change: ChangeRef,
  request: ScenarioSemanticMutation['request'],
): Promise<ReclassifyResult> {
  await assertTransactionLineageIntegrity(repoRoot, change);
  const pending = await loadPendingSemanticMutation(repoRoot, change);
  if (pending) {
    if (pending.kind !== 'SCENARIO_RECLASSIFY') {
      throw new Error(`SEMANTIC_MUTATION_PENDING: ${pending.id}`);
    }
    if (JSON.stringify(pending.request) !== JSON.stringify(request)) {
      throw new Error('SEMANTIC_MUTATION_REQUEST_MISMATCH');
    }
    return continueScenarioReclassification(repoRoot, change, pending);
  }
  await assertSemanticMutationFence(repoRoot, change);
  const completed = await loadCompletedSemanticMutationForSource(
    repoRoot,
    change,
    request,
    change.metadata.activeRevision,
    change.metadata.baseline,
  );
  if (completed?.kind === 'SCENARIO_RECLASSIFY') {
    return completedScenarioResult(repoRoot, change, completed);
  }
  await assertFlowTransactionFence(repoRoot, change);
  await assertDecisionReconcileTransactionFence(repoRoot, change);
  await assertOrdinaryReconcileTransactionFence(repoRoot, change);

  const active = await readYaml(
    changeMetadataPath(repoRoot, change.directoryName),
    changeMetadataSchema,
  );
  if (JSON.stringify(active) !== JSON.stringify(change.metadata)) {
    throw new Error('SCENARIO_RECLASSIFY_STALE_CHANGE_STATE');
  }
  if (active.status === 'ARCHIVED') throw new Error('Archived Changes cannot be reclassified.');
  const previousScenario = getScenario(active.scenario);
  const nextScenario = getScenario(request.scenarioId);
  if (nextScenario.workMode === 'READ_ONLY_QUERY') {
    throw new Error(`Scenario '${nextScenario.id}' is a read-only investigation and cannot classify an implementation Change.`);
  }
  if (nextScenario.id === previousScenario.id) {
    throw new Error(`Change ${active.id} already uses scenario '${nextScenario.id}'.`);
  }

  // Every deterministic input and target is parsed/frozen before the first write.
  const tasks = await loadTasks(changeArtifactPath(repoRoot, change.directoryName, 'tasks.yaml'));
  const proposedMetadata = scenarioReclassificationMetadata(active, nextScenario.id);
  const artifacts = await freezeScenarioArtifacts(repoRoot, change, proposedMetadata);
  const identity = await nextSemanticMutationIdentity(repoRoot, change);
  const createdAt = new Date().toISOString();
  const completedRevision = incrementRevision(active.activeRevision);
  const completedBaseline = incrementBaseline(active.baseline);
  const transaction = semanticMutationTransactionSchema.parse({
    schemaVersion: 1,
    status: 'PENDING',
    ...identity,
    kind: 'SCENARIO_RECLASSIFY',
    changeId: active.id,
    revision: active.activeRevision,
    baseline: active.baseline,
    createdAt,
    request,
    sourceMetadata: active,
    proposedMetadata,
    tasks,
    artifacts,
    ordinaryCorrelationId: `SCENARIO-${identity.id}`,
    completedRevision,
    completedBaseline,
    audit: {
      timestamp: createdAt,
      event: 'SCENARIO_RECLASSIFIED',
      changeId: active.id,
      revision: completedRevision,
      detail: `${previousScenario.id} -> ${nextScenario.id}`,
      data: {
        previousScenario: previousScenario.id,
        scenario: nextScenario.id,
        risk: proposedMetadata.risk,
        impact: proposedMetadata.impact,
        proposedMetadataHash: hashCanonicalArtifact(proposedMetadata),
        tasksHash: hashCanonicalArtifact(tasks),
        artifactTargetsHash: hashCanonicalArtifact(artifacts),
        ordinaryCorrelationId: `SCENARIO-${identity.id}`,
        completedBaseline,
        semanticMutationId: identity.id,
      },
    },
  });
  if (transaction.kind !== 'SCENARIO_RECLASSIFY') throw new Error('SEMANTIC_MUTATION_KIND_MISMATCH');
  await writeSemanticMutationTransaction(repoRoot, change, transaction);
  publish('SCENARIO_RECLASSIFY_INTENT_WRITTEN', transaction);
  return continueScenarioReclassification(repoRoot, change, transaction);
}

async function continueScenarioReclassification(
  repoRoot: string,
  change: ChangeRef,
  transaction: ScenarioSemanticMutation,
): Promise<ReclassifyResult> {
  await assertSemanticMutationFence(repoRoot, change, transaction.id);
  await ensureScenarioArtifacts(repoRoot, change, transaction);
  publish('SCENARIO_RECLASSIFY_ARTIFACTS_ENSURED', transaction);

  const ownedChange: ChangeRef = {
    directoryName: change.directoryName,
    metadata: structuredClone(transaction.proposedMetadata),
  };
  const affectedTasks = transaction.tasks.tasks.map(({ id }) => id);
  const reconcile = await reconcileOrdinaryWithinChangeLock(repoRoot, ownedChange, {
    level: 'L4',
    type: 'SCENARIO_RECLASSIFIED',
    reason: `${transaction.request.reason}. ${transaction.sourceMetadata.scenario} -> ${transaction.request.scenarioId}`,
    affectedTasks,
    correlationId: transaction.ordinaryCorrelationId,
  }, {
    semanticMutationId: transaction.id,
    createdAt: transaction.createdAt,
  });
  if (
    reconcile.revision.id !== transaction.completedRevision
    || reconcile.revision.baseline !== transaction.completedBaseline
  ) throw new Error('SCENARIO_RECLASSIFY_RECONCILE_MISMATCH');
  publish('SCENARIO_RECLASSIFY_RECONCILE_COMPLETED', transaction);

  change.metadata = await readYaml(
    changeMetadataPath(repoRoot, change.directoryName),
    changeMetadataSchema,
  );
  if (
    change.metadata.activeRevision !== transaction.completedRevision
    || change.metadata.baseline !== transaction.completedBaseline
    || change.metadata.scenario !== transaction.request.scenarioId
  ) throw new Error('SCENARIO_RECLASSIFY_TARGET_MISMATCH');
  await ensureSemanticMutationAudits(repoRoot, change, transaction.id, [transaction.audit]);
  if (transaction.status === 'PENDING') {
    await completeSemanticMutationTransaction(repoRoot, change, transaction);
  }
  return { change, reconcile };
}

async function completedScenarioResult(
  repoRoot: string,
  change: ChangeRef,
  transaction: ScenarioSemanticMutation,
): Promise<ReclassifyResult> {
  const active = await readYaml(
    changeMetadataPath(repoRoot, change.directoryName),
    changeMetadataSchema,
  );
  if (
    active.activeRevision !== transaction.completedRevision
    || active.baseline !== transaction.completedBaseline
    || active.scenario !== transaction.request.scenarioId
  ) throw new Error('SCENARIO_RECLASSIFY_COMPLETED_TARGET_MISMATCH');
  const ordinary = await loadOrdinaryReconcileTransactionForSourceRevision(
    repoRoot,
    change,
    transaction.revision,
  );
  if (
    ordinary?.status !== 'COMPLETED'
    || ordinary.correlationId !== transaction.ordinaryCorrelationId
    || ordinary.completedRevision !== transaction.completedRevision
    || ordinary.completedBaseline !== transaction.completedBaseline
  ) throw new Error('SCENARIO_RECLASSIFY_RECONCILE_MISMATCH');
  change.metadata = active;
  return { change, reconcile: await resultForCompletedTransaction(repoRoot, change, ordinary) };
}

async function freezeScenarioArtifacts(
  repoRoot: string,
  change: ChangeRef,
  metadata: ChangeMetadata,
): Promise<ScenarioSemanticMutation['artifacts']> {
  type Artifact = ScenarioSemanticMutation['artifacts'][number];
  const targets: Artifact[] = [];
  for (const specification of scenarioArtifactSpecifications(metadata)) {
    const absolute = specification.kind === 'DIRECTORY'
      ? join(changeRoot(repoRoot, change.directoryName), specification.path)
      : changeArtifactPath(repoRoot, change.directoryName, specification.path);
    if (await pathExists(absolute)) {
      const persisted = await stat(absolute);
      if (
        (specification.kind === 'FILE' && !persisted.isFile())
        || (specification.kind === 'DIRECTORY' && !persisted.isDirectory())
      ) throw new Error(`SCENARIO_RECLASSIFY_ARTIFACT_TYPE_MISMATCH: ${specification.path}`);
      targets.push({
        path: specification.path,
        kind: specification.kind,
        content: specification.kind === 'FILE' ? await readText(absolute) : null,
      });
    } else {
      targets.push({
        path: specification.path,
        kind: specification.kind,
        content: specification.fallback,
      });
    }
  }
  return targets;
}

async function ensureScenarioArtifacts(
  repoRoot: string,
  change: ChangeRef,
  transaction: ScenarioSemanticMutation,
): Promise<void> {
  for (const artifact of transaction.artifacts) {
    const path = artifact.kind === 'DIRECTORY'
      ? join(changeRoot(repoRoot, change.directoryName), artifact.path)
      : changeArtifactPath(repoRoot, change.directoryName, artifact.path);
    if (artifact.kind === 'DIRECTORY') {
      if (await pathExists(path) && !(await stat(path)).isDirectory()) {
        throw new Error(`SCENARIO_RECLASSIFY_ARTIFACT_CONFLICT: ${artifact.path}`);
      }
      await ensureDir(path);
      continue;
    }
    if (artifact.content === null) throw new Error('SCENARIO_RECLASSIFY_ARTIFACT_TARGET_MISSING');
    if (await pathExists(path)) {
      if (!(await stat(path)).isFile() || await readText(path) !== artifact.content) {
        throw new Error(`SCENARIO_RECLASSIFY_ARTIFACT_CONFLICT: ${artifact.path}`);
      }
    } else {
      await writeTextAtomic(path, artifact.content);
    }
  }
}

function publish(stage: string, transaction: ScenarioSemanticMutation): void {
  mutationChannel.publish({ stage, changeId: transaction.changeId, semanticMutationId: transaction.id });
}
