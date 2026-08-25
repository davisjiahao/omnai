import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { flowPlanSchema, type FlowAssessment, type FlowAssessmentProposal } from '../src/domain/types.js';
import { appendJsonLine, pathExists, readJsonLines, readText, readYaml, writeTextAtomic, writeYaml } from '../src/core/files.js';
import { compileFlowPlan, flowInputHash, hashFlowPlan } from '../src/core/flow.js';
import {
  changeArtifactPath,
  changeDecisionPath,
  changeFlowPath,
  changeMetadataPath,
  changeRevisionsRoot,
  workflowLockPath,
} from '../src/core/paths.js';
import { applyFlowAssessment } from '../src/core/flow-assessment.js';
import { loadFlowPlan, migrateLegacyFlow, synchronizeFlowDecisions } from '../src/core/flow-store.js';
import { migrateLegacyFlowWithCurrentDecisions } from '../src/core/flow-migration.js';
import { listDecisions, openDecision, resolveDecision, supersedeDecision } from '../src/core/decisions.js';
import { reconcileChange } from '../src/core/reconcile.js';
import { resolveRepositoryRoute } from '../src/core/router.js';
import { withChangeMutationLock } from '../src/core/change-mutation-lock.js';
import { createChange, initializeProject, resolveChange, saveChange } from '../src/core/store.js';
import { getScenario } from '../src/core/scenarios.js';
import { createTestRepository } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length > 0) await cleanups.pop()?.(); });

const sourceRefs = [{ kind: 'artifact' as const, path: 'domain.md', contentHash: `sha256:${'a'.repeat(64)}` }];

test('new Changes receive one FlowPlan bound to the initial Revision and Baseline', async () => {
  const repo = await createTestRepository('flow-new');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Small feature', 'small-feature');
  const flow = await loadFlowPlan(repo.root, change);
  assert.equal(flow?.revision, 'REV-0001');
  assert.equal(flow?.baseline, 'BL-0001');
  assert.equal(flow?.changeId, change.metadata.id);
});

test('legacy Changes remain legacy until explicit migration and migration does not change readiness', async () => {
  const repo = await createTestRepository('flow-legacy');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Legacy feature', 'small-feature');
  await rm(changeFlowPath(repo.root, change.directoryName));
  const before = structuredClone(change.metadata.readiness);
  assert.equal(await loadFlowPlan(repo.root, change), null);
  const migrated = await migrateLegacyFlow(repo.root, change, []);
  assert.equal(migrated.revision, change.metadata.activeRevision);
  assert.deepEqual(change.metadata.readiness, before);
});

test('legacy migration is idempotent and appends its audit event only for the first write', async () => {
  const repo = await createTestRepository('flow-legacy-idempotent');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Legacy idempotence', 'small-feature');
  await rm(changeFlowPath(repo.root, change.directoryName));
  const first = await migrateLegacyFlow(repo.root, change, []);
  const second = await migrateLegacyFlow(repo.root, change, []);
  assert.deepEqual(second, first);
  const events = await readJsonLines<{ event: string }>(changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl'));
  assert.equal(events.filter(({ event }) => event === 'FLOW_MIGRATED').length, 1);
});

test('legacy migration snapshots Decisions only after acquiring the exact Change lock', async () => {
  const repo = await createTestRepository('flow-legacy-locked-inventory');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Locked legacy inventory', 'small-feature');
  await rm(changeFlowPath(repo.root, change.directoryName));
  const beforeReadiness = structuredClone(change.metadata.readiness);
  const now = new Date().toISOString();
  const decision = {
    schemaVersion: 1 as const,
    id: 'DEC-0001',
    changeId: change.metadata.id,
    openedRevision: change.metadata.activeRevision,
    resolvedRevision: null,
    kind: 'SOLUTION' as const,
    owner: 'HUMAN' as const,
    status: 'OPEN' as const,
    blocking: true,
    question: 'Which implementation owns this behavior?',
    options: [],
    resolution: null,
    supersededBy: null,
    affects: { capabilities: ['spec' as const], artifacts: ['spec.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs,
    createdAt: now,
    updatedAt: now,
  };
  let signalLockHeld: (() => void) | undefined;
  const lockHeld = new Promise<void>((resolve) => { signalLockHeld = resolve; });
  let allowDecisionWrite: (() => void) | undefined;
  const decisionWriteAllowed = new Promise<void>((resolve) => { allowDecisionWrite = resolve; });
  const writer = withChangeMutationLock(repo.root, change, async () => {
    signalLockHeld?.();
    await decisionWriteAllowed;
    await writeYaml(changeDecisionPath(repo.root, change.directoryName, decision.id), decision);
  });
  await lockHeld;

  const migrationPromise = migrateLegacyFlowWithCurrentDecisions(repo.root, change);
  const earlyState = await Promise.race([
    migrationPromise.then(() => 'SETTLED', () => 'SETTLED'),
    new Promise<'WAITING'>((resolve) => setTimeout(() => resolve('WAITING'), 500)),
  ]);
  allowDecisionWrite?.();
  await writer;
  const migrated = await migrationPromise;

  assert.equal(earlyState, 'WAITING');
  assert.deepEqual(migrated.decisionIds, ['DEC-0001']);
  assert.equal(migrated.revision, 'REV-0001');
  assert.equal(migrated.baseline, 'BL-0001');
  assert.deepEqual(change.metadata.readiness, beforeReadiness);
  const route = await resolveRepositoryRoute(repo.root, change);
  assert.deepEqual(route.protocolIds, ['interaction.grill', 'repository.spec']);
  assert.deepEqual(route.decisionIds, ['DEC-0001']);
});

test('decision sync promotes only capabilities newly activated after legacy migration', async () => {
  const repo = await createTestRepository('flow-legacy-decision-transition');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Legacy decision transition', 'small-feature');
  await rm(changeFlowPath(repo.root, change.directoryName));
  change.metadata.readiness.spec = 'NOT_APPLICABLE';
  await saveChange(repo.root, change);
  await migrateLegacyFlow(repo.root, change, []);

  await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Which domain owns it?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
  });

  assert.equal(change.metadata.readiness.spec, 'NOT_APPLICABLE');
  assert.equal(change.metadata.readiness.domain, 'MISSING');
});

test('unchanged-hash decision sync performs no FlowPlan or metadata write', async () => {
  const repo = await createTestRepository('flow-legacy-sync-noop');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Legacy no-op sync', 'small-feature');
  await rm(changeFlowPath(repo.root, change.directoryName));
  change.metadata.readiness.spec = 'NOT_APPLICABLE';
  await saveChange(repo.root, change);
  await migrateLegacyFlow(repo.root, change, []);
  const metadataPath = join(repo.root, '.omnai', 'changes', change.directoryName, 'change.yaml');
  const beforeMetadata = await readText(metadataPath);
  const beforeFlow = await readText(changeFlowPath(repo.root, change.directoryName));

  await synchronizeFlowDecisions(repo.root, change, []);

  assert.equal(await readText(metadataPath), beforeMetadata);
  assert.equal(await readText(changeFlowPath(repo.root, change.directoryName)), beforeFlow);
  assert.equal(change.metadata.readiness.spec, 'NOT_APPLICABLE');
});

test('reassessment promotes only newly active capabilities after legacy migration', async () => {
  const repo = await createTestRepository('flow-legacy-reassessment-transition');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Legacy reassessment transition', 'small-feature');
  await rm(changeFlowPath(repo.root, change.directoryName));
  change.metadata.readiness.spec = 'NOT_APPLICABLE';
  await saveChange(repo.root, change);
  const migrated = await migrateLegacyFlow(repo.root, change, []);

  await applyFlowAssessment(repo.root, change, {
    schemaVersion: 2,
    changeId: change.metadata.id,
    revision: change.metadata.activeRevision,
    baseline: change.metadata.baseline,
    assessment: { ...migrated.assessment, topology: 'CROSS_MODULE', architectureApplicability: 'FOCUSED' },
  });

  assert.equal(change.metadata.readiness.spec, 'NOT_APPLICABLE');
  assert.equal(change.metadata.readiness.review, 'MISSING');
});

test('stale assessment proposals fail without mutating Flow Revision or Baseline', async () => {
  const repo = await createTestRepository('flow-cas');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Flow CAS', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  await assert.rejects(() => applyFlowAssessment(repo.root, change, {
    schemaVersion: 2, changeId: change.metadata.id, revision: 'REV-9999', baseline: change.metadata.baseline,
    assessment: flow.assessment,
  }), /FLOW_STALE_REVISION/);
  const reloaded = await resolveChange(repo.root, change.metadata.id);
  assert.equal(reloaded.metadata.activeRevision, 'REV-0001');
  assert.equal(reloaded.metadata.baseline, 'BL-0001');
});

test('an old proposal after unrelated Reconcile is not mistaken for transaction recovery', async () => {
  const repo = await createTestRepository('flow-stale-recovery-candidate');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Stale recovery candidate', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const proposal = {
    schemaVersion: 2 as const,
    changeId: change.metadata.id,
    revision: change.metadata.activeRevision,
    baseline: change.metadata.baseline,
    assessment: flow.assessment,
  };
  await reconcileChange(repo.root, change, { level: 'L0', type: 'IMPLEMENTATION_CHANGED', reason: 'Unrelated edit' });

  await assert.rejects(() => applyFlowAssessment(repo.root, change, proposal), /FLOW_STALE_REVISION/);
  assert.equal(change.metadata.activeRevision, 'REV-0002');
  assert.equal((await loadFlowPlan(repo.root, change))?.revision, 'REV-0002');
});

test('a changed assessment creates one Reconcile revision and archives the prior flow', async () => {
  const repo = await createTestRepository('flow-reassess');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Cross-module feature', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const result = await applyFlowAssessment(repo.root, change, {
    schemaVersion: 2, changeId: change.metadata.id, revision: change.metadata.activeRevision, baseline: change.metadata.baseline,
    assessment: { ...flow.assessment, topology: 'CROSS_MODULE', architectureApplicability: 'FOCUSED' },
  });
  assert.equal(result.reconcile?.revision.id, 'REV-0002');
  assert.equal(result.reconcile?.revision.level, 'L2');
  assert.equal(result.flow.revision, 'REV-0002');
  assert.equal(result.flow.baseline, 'BL-0002');
  assert.equal(await pathExists(join(repo.root, '.omnai', 'changes', change.directoryName, 'revisions', 'REV-0001.flow.yaml')), true);
  assert.equal((await readdir(changeRevisionsRoot(repo.root, change.directoryName))).filter((file) => file === 'REV-0002.yaml').length, 1);
});

test('reassessment rejects a conflicting immutable Flow archive before journal or lineage side effects', async () => {
  const repo = await createTestRepository('flow-reassess-archive-conflict');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Immutable reassessment archive', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const conflictingDraft = {
    ...flow,
    assessment: {
      ...flow.assessment,
      sourceRefs: flow.assessment.sourceRefs.map((sourceRef) => ({
        ...sourceRef,
        contentHash: `sha256:${'f'.repeat(64)}` as const,
      })),
    },
  };
  const conflictingArchive = {
    ...conflictingDraft,
    inputHash: flowInputHash(conflictingDraft),
  };
  const archivePath = join(changeRevisionsRoot(repo.root, change.directoryName), 'REV-0001.flow.yaml');
  await writeYaml(archivePath, conflictingArchive);
  const before = await flowReassessmentMutationSnapshot(repo.root, change.directoryName);

  await assert.rejects(
    () => applyFlowAssessment(repo.root, change, changedTopologyProposal(change, flow.assessment)),
    /RECONCILE_FLOW_ARCHIVE_MISMATCH|FLOW_TRANSACTION_ARCHIVE_MISMATCH/,
  );

  const after = await flowReassessmentMutationSnapshot(repo.root, change.directoryName);
  assert.deepEqual(after, before);
  assert.equal(hashFlowPlan(await readYaml(archivePath, flowPlanSchema)), hashFlowPlan(conflictingArchive));
  assert.equal(after.revisionFiles.some((file) => file.endsWith('.flow-transaction.yaml')), false);
  assert.equal(after.revisionFiles.some((file) => file.endsWith('.signal.yaml')), false);
  assert.equal(after.revisionFiles.includes('REV-0002.yaml'), false);
});

test('completed reassessment retry preserves terminal journal history and newer same-Revision Decision state', async () => {
  const repo = await createTestRepository('flow-completed-terminal-history');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Completed terminal history', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const proposal = changedTopologyProposal(change, flow.assessment);
  await applyFlowAssessment(repo.root, change, proposal);

  const transactionPath = join(changeRevisionsRoot(repo.root, change.directoryName), 'REV-0001.flow-transaction.yaml');
  const progressPath = changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl');
  const journalBeforeDecision = await readText(transactionPath);
  const historicalEventsBefore = (await readJsonLines<{ event: string; data?: { correlationId?: string; newPlanHash?: string } }>(progressPath))
    .filter(({ event }) => event === 'RECONCILE_APPLIED' || event === 'FLOW_REASSESSED');

  await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Who owns terminal state?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
  });
  const afterDecision = (await loadFlowPlan(repo.root, change))!;
  const progressBeforeRetry = await readText(progressPath);
  const retried = await applyFlowAssessment(repo.root, change, proposal);

  assert.equal(await readText(transactionPath), journalBeforeDecision);
  assert.equal(await readText(progressPath), progressBeforeRetry);
  assert.deepEqual(retried.flow, afterDecision);
  assert.deepEqual(retried.flow.decisionIds, ['DEC-0001']);
  const historicalEventsAfter = (await readJsonLines<{ event: string; data?: { correlationId?: string; newPlanHash?: string } }>(progressPath))
    .filter(({ event }) => event === 'RECONCILE_APPLIED' || event === 'FLOW_REASSESSED');
  assert.deepEqual(historicalEventsAfter, historicalEventsBefore);
});

test('completed reassessment retry rejects terminal journal fields that disagree with success audit history', async () => {
  const repo = await createTestRepository('flow-completed-terminal-validation');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Completed terminal validation', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const proposal = changedTopologyProposal(change, flow.assessment);
  await applyFlowAssessment(repo.root, change, proposal);

  const transactionPath = join(changeRevisionsRoot(repo.root, change.directoryName), 'REV-0001.flow-transaction.yaml');
  const transaction = YAML.parse(await readText(transactionPath)) as Record<string, unknown>;
  await writeYaml(transactionPath, { ...transaction, newPlanHash: `sha256:${'0'.repeat(64)}` });
  const journalBeforeRetry = await readText(transactionPath);
  const progressPath = changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl');
  const progressBeforeRetry = await readText(progressPath);

  await assert.rejects(() => applyFlowAssessment(repo.root, change, proposal), /FLOW_TRANSACTION_COMPLETION_MISMATCH/);
  assert.equal(await readText(transactionPath), journalBeforeRetry);
  assert.equal(await readText(progressPath), progressBeforeRetry);
});

test('pending reassessment completes from its historical Flow audit without replacing newer Decision state', async () => {
  const repo = await createTestRepository('flow-pending-audit-history');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Pending audit history', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const proposal = changedTopologyProposal(change, flow.assessment);

  assert.equal(crashAssessmentAtStage(repo.root, change.metadata.id, proposal, 'FLOW_REASSESSED_AUDITED'), 91);

  const interrupted = await resolveChange(repo.root, change.metadata.id);
  const transactionPath = join(changeRevisionsRoot(repo.root, change.directoryName), 'REV-0001.flow-transaction.yaml');
  const pending = YAML.parse(await readText(transactionPath)) as { status: string; newPlanHash: string | null };
  assert.equal(pending.status, 'PENDING');
  assert.equal(pending.newPlanHash, null);
  const progressPath = changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl');
  const historicalFlowEvents = (await readJsonLines<{
    event: string;
    data?: { correlationId?: string; newPlanHash?: string };
  }>(progressPath)).filter(({ event }) => event === 'FLOW_REASSESSED');
  assert.equal(historicalFlowEvents.length, 1);
  const historicalHash = historicalFlowEvents[0]!.data?.newPlanHash;
  assert.match(historicalHash ?? '', /^sha256:[0-9a-f]{64}$/);

  await openDecision(repo.root, interrupted, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Who owns recovered history?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
  });
  const decisionFlow = (await loadFlowPlan(repo.root, interrupted))!;
  assert.deepEqual(decisionFlow.decisionIds, ['DEC-0001']);
  assert.notEqual(hashFlowPlan(decisionFlow), historicalHash);

  const recovered = await applyFlowAssessment(repo.root, interrupted, proposal);
  const completed = YAML.parse(await readText(transactionPath)) as { status: string; newPlanHash: string | null };
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.newPlanHash, historicalHash);
  assert.deepEqual(recovered.flow, decisionFlow);
  const events = await readJsonLines<{ event: string; data?: { correlationId?: string } }>(progressPath);
  assert.equal(events.filter(({ event }) => event === 'RECONCILE_APPLIED').length, 1);
  assert.equal(events.filter(({ event }) => event === 'FLOW_REASSESSED').length, 1);
});

test('pending reassessment rejects a historical Flow audit with the wrong accepted hash', async () => {
  const repo = await createTestRepository('flow-pending-audit-mismatch');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Pending audit mismatch', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const proposal = changedTopologyProposal(change, flow.assessment);
  assert.equal(crashAssessmentAtStage(repo.root, change.metadata.id, proposal, 'FLOW_REASSESSED_AUDITED'), 91);

  const interrupted = await resolveChange(repo.root, change.metadata.id);
  const progressPath = changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl');
  const events = await readJsonLines<{
    event: string;
    data?: Record<string, unknown>;
  }>(progressPath);
  const flowEventIndex = events.findIndex(({ event }) => event === 'FLOW_REASSESSED');
  assert.notEqual(flowEventIndex, -1);
  const flowEvent = events[flowEventIndex]!;
  events[flowEventIndex] = {
    ...flowEvent,
    data: { ...flowEvent.data, newPlanHash: `sha256:${'0'.repeat(64)}` },
  };
  await writeTextAtomic(progressPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  const transactionPath = join(changeRevisionsRoot(repo.root, change.directoryName), 'REV-0001.flow-transaction.yaml');
  const journalBefore = await readText(transactionPath);
  const flowBefore = await readText(changeFlowPath(repo.root, change.directoryName));

  await assert.rejects(
    () => applyFlowAssessment(repo.root, interrupted, proposal),
    /FLOW_TRANSACTION_COMPLETION_MISMATCH/,
  );
  assert.equal(await readText(transactionPath), journalBefore);
  assert.equal(await readText(changeFlowPath(repo.root, change.directoryName)), flowBefore);
});

test('pending reassessment rejects duplicate correlated historical Flow audits', async () => {
  const repo = await createTestRepository('flow-pending-audit-duplicate');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Pending audit duplicate', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const proposal = changedTopologyProposal(change, flow.assessment);
  assert.equal(crashAssessmentAtStage(repo.root, change.metadata.id, proposal, 'FLOW_REASSESSED_AUDITED'), 91);

  const interrupted = await resolveChange(repo.root, change.metadata.id);
  const progressPath = changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl');
  const historical = (await readJsonLines<{ event: string }>(progressPath)).find(({ event }) => event === 'FLOW_REASSESSED');
  assert.ok(historical);
  await appendJsonLine(progressPath, historical);
  const transactionPath = join(changeRevisionsRoot(repo.root, change.directoryName), 'REV-0001.flow-transaction.yaml');
  const journalBefore = await readText(transactionPath);

  await assert.rejects(
    () => applyFlowAssessment(repo.root, interrupted, proposal),
    /FLOW_TRANSACTION_COMPLETION_MISMATCH/,
  );
  assert.equal(await readText(transactionPath), journalBefore);
});

test('reassessment resumes the exact correlated signal after a pre-metadata crash', async () => {
  const repo = await createTestRepository('flow-reconcile-signal-crash');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Recover signal crash', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const proposal = changedTopologyProposal(change, flow.assessment);
  assert.equal(crashAssessmentAtStage(repo.root, change.metadata.id, proposal, 'FLOW_RECONCILE_SIGNAL_WRITTEN'), 91);

  const revisionsRoot = changeRevisionsRoot(repo.root, change.directoryName);
  const filesBefore = await readdir(revisionsRoot);
  const signalFile = filesBefore.find((file) => file.endsWith('.signal.yaml'));
  assert.ok(signalFile);
  const signalBefore = await readText(join(revisionsRoot, signalFile));
  assert.equal(await pathExists(join(revisionsRoot, 'REV-0002.yaml')), false);
  const interrupted = await resolveChange(repo.root, change.metadata.id);
  assert.equal(interrupted.metadata.activeRevision, 'REV-0001');

  await applyFlowAssessment(repo.root, interrupted, proposal);

  const filesAfter = await readdir(revisionsRoot);
  assert.equal(filesAfter.filter((file) => file.endsWith('.signal.yaml')).length, 1);
  assert.equal(await readText(join(revisionsRoot, signalFile)), signalBefore);
  assert.equal(filesAfter.filter((file) => /^REV-\d{4}\.yaml$/.test(file)).length, 2);
  assert.equal(filesAfter.includes('REV-0003.yaml'), false);
  await assertCompletedReassessmentCardinality(repo.root, change.directoryName);
});

test('reassessment resumes the exact correlated Revision after a pre-metadata crash', async () => {
  const repo = await createTestRepository('flow-reconcile-revision-crash');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Recover Revision crash', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const proposal = changedTopologyProposal(change, flow.assessment);
  assert.equal(crashAssessmentAtStage(repo.root, change.metadata.id, proposal, 'FLOW_RECONCILE_REVISION_WRITTEN'), 91);

  const revisionsRoot = changeRevisionsRoot(repo.root, change.directoryName);
  const revisionPath = join(revisionsRoot, 'REV-0002.yaml');
  const revisionBefore = await readText(revisionPath);
  const filesBefore = await readdir(revisionsRoot);
  const signalFile = filesBefore.find((file) => file.endsWith('.signal.yaml'));
  assert.ok(signalFile);
  const signalBefore = await readText(join(revisionsRoot, signalFile));
  const interrupted = await resolveChange(repo.root, change.metadata.id);
  assert.equal(interrupted.metadata.activeRevision, 'REV-0001');

  await applyFlowAssessment(repo.root, interrupted, proposal);

  const filesAfter = await readdir(revisionsRoot);
  assert.equal(filesAfter.filter((file) => file.endsWith('.signal.yaml')).length, 1);
  assert.equal(await readText(join(revisionsRoot, signalFile)), signalBefore);
  assert.equal(await readText(revisionPath), revisionBefore);
  assert.equal(filesAfter.filter((file) => /^REV-\d{4}\.yaml$/.test(file)).length, 2);
  assert.equal(filesAfter.includes('REV-0003.yaml'), false);
  await assertCompletedReassessmentCardinality(repo.root, change.directoryName);
});

test('reassessment rejects contradictory duplicate correlated signals before metadata recovery', async () => {
  const repo = await createTestRepository('flow-reconcile-signal-conflict');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Reject duplicate signal recovery', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const proposal = changedTopologyProposal(change, flow.assessment);
  assert.equal(crashAssessmentAtStage(repo.root, change.metadata.id, proposal, 'FLOW_RECONCILE_SIGNAL_WRITTEN'), 91);

  const revisionsRoot = changeRevisionsRoot(repo.root, change.directoryName);
  const signalFile = (await readdir(revisionsRoot)).find((file) => file.endsWith('.signal.yaml'));
  assert.ok(signalFile);
  const signal = YAML.parse(await readText(join(revisionsRoot, signalFile))) as Record<string, unknown>;
  await writeYaml(join(revisionsRoot, 'SIG-CONTRADICTORY.signal.yaml'), { ...signal, id: 'SIG-CONTRADICTORY' });
  const interrupted = await resolveChange(repo.root, change.metadata.id);

  await assert.rejects(
    () => applyFlowAssessment(repo.root, interrupted, proposal),
    /FLOW_TRANSACTION_SIGNAL_CONFLICT/,
  );
  assert.equal(interrupted.metadata.activeRevision, 'REV-0001');
  assert.equal(await pathExists(join(revisionsRoot, 'REV-0002.yaml')), false);
});

test('interrupted accepted-flow finalization has no success audit and retries safely from durable transaction state', async () => {
  const repo = await createTestRepository('flow-reassess-recovery');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Recover reassessment', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const proposal = {
    schemaVersion: 2 as const,
    changeId: change.metadata.id,
    revision: change.metadata.activeRevision,
    baseline: change.metadata.baseline,
    assessment: { ...flow.assessment, topology: 'CROSS_MODULE' as const, architectureApplicability: 'FOCUSED' as const },
  };

  assert.equal(crashAssessmentAtStage(repo.root, change.metadata.id, proposal, 'FLOW_ACCEPTED_BEFORE_WRITE'), 91);

  const interrupted = await resolveChange(repo.root, change.metadata.id);
  assert.equal(interrupted.metadata.activeRevision, 'REV-0002');
  assert.equal(interrupted.metadata.readiness.review, 'MISSING');
  assert.equal((await loadFlowPlan(repo.root, interrupted))?.assessment.topology, 'SINGLE_MODULE');
  let events = await readJsonLines<{ event: string }>(changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl'));
  assert.equal(events.some(({ event }) => event === 'RECONCILE_APPLIED'), false);
  assert.equal(events.some(({ event }) => event === 'FLOW_REASSESSED'), false);

  const recovered = await applyFlowAssessment(repo.root, interrupted, proposal);
  assert.equal(recovered.reconcile?.revision.id, 'REV-0002');
  assert.equal(recovered.flow.assessment.topology, 'CROSS_MODULE');
  assert.equal(recovered.flow.revision, 'REV-0002');
  assert.equal(interrupted.metadata.readiness.review, 'MISSING');
  events = await readJsonLines<{ event: string }>(changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl'));
  assert.equal(events.filter(({ event }) => event === 'RECONCILE_APPLIED').length, 1);
  assert.equal(events.filter(({ event }) => event === 'FLOW_REASSESSED').length, 1);
});

test('reassessment recovers concurrently from a crash after metadata save before Flow rebind', async () => {
  const repo = await createTestRepository('flow-reassess-pre-rebind-crash');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Recover pre-rebind crash', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const proposal = changedTopologyProposal(change, flow.assessment);

  assert.equal(crashAssessmentAtStage(repo.root, change.metadata.id, proposal, 'FLOW_RECONCILE_METADATA_SAVED'), 91);

  const interrupted = await resolveChange(repo.root, change.metadata.id);
  assert.equal(interrupted.metadata.activeRevision, 'REV-0002');
  const oldRevisionFlow = await readYaml(changeFlowPath(repo.root, change.directoryName), flowPlanSchema);
  assert.equal(oldRevisionFlow.revision, 'REV-0001');
  const interruptedEvents = await readJsonLines<{ event: string }>(changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl'));
  assert.equal(interruptedEvents.some(({ event }) => event === 'RECONCILE_APPLIED'), false);
  assert.equal(interruptedEvents.some(({ event }) => event === 'FLOW_REASSESSED'), false);
  const left = await resolveChange(repo.root, change.metadata.id);
  const right = await resolveChange(repo.root, change.metadata.id);
  const [first, second] = await Promise.all([
    applyFlowAssessment(repo.root, left, proposal),
    applyFlowAssessment(repo.root, right, proposal),
  ]);

  assert.equal(first.flow.revision, 'REV-0002');
  assert.equal(second.flow.revision, 'REV-0002');
  assert.equal(first.flow.assessment.topology, 'CROSS_MODULE');
  assert.equal(second.flow.assessment.topology, 'CROSS_MODULE');
  const events = await readJsonLines<{ event: string }>(changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl'));
  assert.equal(events.filter(({ event }) => event === 'RECONCILE_APPLIED').length, 1);
  assert.equal(events.filter(({ event }) => event === 'FLOW_REASSESSED').length, 1);
});

test('reassessment recovers from a crash after mandatory Flow rebind', async () => {
  const repo = await createTestRepository('flow-reassess-during-rebind-crash');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Recover rebound crash', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const proposal = changedTopologyProposal(change, flow.assessment);

  assert.equal(crashAssessmentAtStage(repo.root, change.metadata.id, proposal, 'FLOW_RECONCILE_REBOUND'), 91);

  const interrupted = await resolveChange(repo.root, change.metadata.id);
  const rebound = (await loadFlowPlan(repo.root, interrupted))!;
  assert.equal(rebound.revision, 'REV-0002');
  assert.equal(rebound.assessment.topology, 'SINGLE_MODULE');
  const interruptedEvents = await readJsonLines<{ event: string }>(changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl'));
  assert.equal(interruptedEvents.some(({ event }) => event === 'RECONCILE_APPLIED'), false);
  assert.equal(interruptedEvents.some(({ event }) => event === 'FLOW_REASSESSED'), false);
  const recovered = await applyFlowAssessment(repo.root, interrupted, proposal);
  assert.equal(recovered.flow.revision, 'REV-0002');
  assert.equal(recovered.flow.assessment.topology, 'CROSS_MODULE');
});

test('reassessment recovery rejects an unrelated active-bound Flow state', async () => {
  const repo = await createTestRepository('flow-reassess-unrelated-recovery-state');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Reject unrelated recovery state', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const proposal = changedTopologyProposal(change, flow.assessment);
  assert.equal(crashAssessmentAtStage(repo.root, change.metadata.id, proposal, 'FLOW_RECONCILE_REBOUND'), 91);
  const interrupted = await resolveChange(repo.root, change.metadata.id);
  const rebound = (await loadFlowPlan(repo.root, interrupted))!;
  const unrelated = {
    ...rebound,
    assessment: {
      ...rebound.assessment,
      sourceRefs: rebound.assessment.sourceRefs.map((sourceRef) => ({
        ...sourceRef,
        contentHash: `sha256:${'d'.repeat(64)}`,
      })),
    },
  };
  await writeYaml(changeFlowPath(repo.root, change.directoryName), {
    ...unrelated,
    inputHash: flowInputHash(unrelated),
  });

  await assert.rejects(() => applyFlowAssessment(repo.root, interrupted, proposal), /FLOW_TRANSACTION_STATE_CONFLICT/);
  const events = await readJsonLines<{ event: string }>(changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl'));
  assert.equal(events.some(({ event }) => event === 'RECONCILE_APPLIED'), false);
  assert.equal(events.some(({ event }) => event === 'FLOW_REASSESSED'), false);
});

test('ordinary Reconcile is fenced while a strict pending Flow transaction exists', async () => {
  const repo = await createTestRepository('flow-pending-reconcile-fence');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Pending transaction fence', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const proposal = changedTopologyProposal(change, flow.assessment);
  assert.equal(crashAssessmentAtStage(repo.root, change.metadata.id, proposal, 'FLOW_RECONCILE_REBOUND'), 91);
  const interrupted = await resolveChange(repo.root, change.metadata.id);

  await assert.rejects(
    () => reconcileChange(repo.root, interrupted, { level: 'L0', type: 'UNRELATED', reason: 'Must not pass pending flow' }),
    /FLOW_TRANSACTION_PENDING/,
  );

  const persisted = await resolveChange(repo.root, change.metadata.id);
  assert.equal(persisted.metadata.activeRevision, 'REV-0002');
  assert.equal(await pathExists(join(changeRevisionsRoot(repo.root, change.directoryName), 'REV-0003.yaml')), false);
  await applyFlowAssessment(repo.root, persisted, proposal);
});

test('pending reassessment fences a different same-Revision source rebound before every write', async () => {
  const repo = await createTestRepository('flow-pending-source-fence');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Pending source fence', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const originalProposal = changedTopologyProposal(change, flow.assessment);
  assert.equal(crashAssessmentAtStage(repo.root, change.metadata.id, originalProposal, 'FLOW_RECONCILE_REBOUND'), 91);
  const interrupted = await resolveChange(repo.root, change.metadata.id);
  const rebound = (await loadFlowPlan(repo.root, interrupted))!;
  const flowBefore = await readText(changeFlowPath(repo.root, change.directoryName));
  const metadataBefore = await readText(changeMetadataPath(repo.root, change.directoryName));
  const progressPath = changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl');
  const progressBefore = await readText(progressPath);
  const revisionFilesBefore = (await readdir(changeRevisionsRoot(repo.root, change.directoryName))).sort();

  await assert.rejects(() => applyFlowAssessment(repo.root, interrupted, {
    schemaVersion: 2,
    changeId: interrupted.metadata.id,
    revision: interrupted.metadata.activeRevision,
    baseline: interrupted.metadata.baseline,
    assessment: {
      ...rebound.assessment,
      sourceRefs: rebound.assessment.sourceRefs.map((sourceRef) => ({
        ...sourceRef,
        contentHash: `sha256:${'e'.repeat(64)}`,
      })),
    },
  }), /FLOW_TRANSACTION_PENDING/);

  assert.equal(await readText(changeFlowPath(repo.root, change.directoryName)), flowBefore);
  assert.equal(await readText(changeMetadataPath(repo.root, change.directoryName)), metadataBefore);
  assert.equal(await readText(progressPath), progressBefore);
  assert.deepEqual((await readdir(changeRevisionsRoot(repo.root, change.directoryName))).sort(), revisionFilesBefore);
  const recovered = await applyFlowAssessment(repo.root, interrupted, originalProposal);
  assert.equal(recovered.flow.assessment.topology, 'CROSS_MODULE');
  const events = await readJsonLines<{ event: string }>(progressPath);
  assert.equal(events.filter(({ event }) => event === 'RECONCILE_APPLIED').length, 1);
  assert.equal(events.filter(({ event }) => event === 'FLOW_REASSESSED').length, 1);
});

test('pending reassessment fences a second classification proposal before creating another journal', async () => {
  const repo = await createTestRepository('flow-pending-classification-fence');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Pending classification fence', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const originalProposal = changedTopologyProposal(change, flow.assessment);
  assert.equal(crashAssessmentAtStage(repo.root, change.metadata.id, originalProposal, 'FLOW_RECONCILE_REBOUND'), 91);
  const interrupted = await resolveChange(repo.root, change.metadata.id);
  const rebound = (await loadFlowPlan(repo.root, interrupted))!;
  const flowBefore = await readText(changeFlowPath(repo.root, change.directoryName));
  const metadataBefore = await readText(changeMetadataPath(repo.root, change.directoryName));
  const progressPath = changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl');
  const progressBefore = await readText(progressPath);
  const revisionFilesBefore = (await readdir(changeRevisionsRoot(repo.root, change.directoryName))).sort();

  await assert.rejects(() => applyFlowAssessment(repo.root, interrupted, {
    schemaVersion: 2,
    changeId: interrupted.metadata.id,
    revision: interrupted.metadata.activeRevision,
    baseline: interrupted.metadata.baseline,
    assessment: { ...rebound.assessment, scale: 'PROGRAM' },
  }), /FLOW_TRANSACTION_PENDING/);

  assert.equal(await readText(changeFlowPath(repo.root, change.directoryName)), flowBefore);
  assert.equal(await readText(changeMetadataPath(repo.root, change.directoryName)), metadataBefore);
  assert.equal(await readText(progressPath), progressBefore);
  assert.deepEqual((await readdir(changeRevisionsRoot(repo.root, change.directoryName))).sort(), revisionFilesBefore);
  assert.equal(await pathExists(join(changeRevisionsRoot(repo.root, change.directoryName), 'REV-0002.flow-transaction.yaml')), false);
  const recovered = await applyFlowAssessment(repo.root, interrupted, originalProposal);
  assert.equal(recovered.flow.assessment.topology, 'CROSS_MODULE');
  const events = await readJsonLines<{ event: string }>(progressPath);
  assert.equal(events.filter(({ event }) => event === 'RECONCILE_APPLIED').length, 1);
  assert.equal(events.filter(({ event }) => event === 'FLOW_REASSESSED').length, 1);
});

test('an identical assessment is idempotent and does not create a Revision', async () => {
  const repo = await createTestRepository('flow-idempotent');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Stable flow', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const result = await applyFlowAssessment(repo.root, change, {
    schemaVersion: 2, changeId: change.metadata.id, revision: change.metadata.activeRevision, baseline: change.metadata.baseline,
    assessment: flow.assessment,
  });
  assert.equal(result.reconcile, null);
  assert.equal(change.metadata.activeRevision, 'REV-0001');
});

test('source hash rebound recompiles in the same Revision without Reconcile', async () => {
  const repo = await createTestRepository('flow-source-rebound');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Source rebound', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const result = await applyFlowAssessment(repo.root, change, {
    schemaVersion: 2,
    changeId: change.metadata.id,
    revision: change.metadata.activeRevision,
    baseline: change.metadata.baseline,
    assessment: {
      ...flow.assessment,
      sourceRefs: flow.assessment.sourceRefs.map((sourceRef) => ({ ...sourceRef, contentHash: `sha256:${'b'.repeat(64)}` })),
    },
  });
  assert.equal(result.reconcile, null);
  assert.equal(result.flow.revision, 'REV-0001');
  assert.notEqual(result.flow.inputHash, flow.inputHash);
  const events = await readJsonLines<{ event: string }>(changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl'));
  assert.equal(events.at(-1)?.event, 'FLOW_SOURCE_REBOUND');
});

test('source rebound rejects non-source assessment decision changes', async () => {
  const repo = await createTestRepository('flow-source-rebound-decision-invalid');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Invalid source rebound', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const beforeEvents = await readJsonLines(changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl'));

  await assert.rejects(() => applyFlowAssessment(repo.root, change, {
    schemaVersion: 2,
    changeId: change.metadata.id,
    revision: change.metadata.activeRevision,
    baseline: change.metadata.baseline,
    assessment: { ...flow.assessment, decisionIds: ['DEC-9999'] },
  }), /FLOW_SOURCE_REBOUND_INVALID/);

  assert.deepEqual(await loadFlowPlan(repo.root, change), flow);
  assert.deepEqual(
    await readJsonLines(changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl')),
    beforeEvents,
  );
});

test('Decision mutation attempted before accepted Flow write cannot be lost by reassessment', async () => {
  const repo = await createTestRepository('flow-reassessment-serialized-decision');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Serialized Decision reassessment', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const proposal = changedTopologyProposal(change, flow.assessment);
  const mutationChannel = channel('omnai:core:change-mutation');
  let decisionWrite: Promise<unknown> | undefined;
  const listener = (message: unknown): void => {
    const event = message as { stage?: string; changeId?: string };
    if (event.stage !== 'FLOW_ACCEPTED_BEFORE_WRITE' || event.changeId !== change.metadata.id || decisionWrite) return;
    decisionWrite = openDecision(repo.root, change, { schemaVersion: 2,
      kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Who owns serialized state?', options: [],
      affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
    });
  };
  mutationChannel.subscribe(listener);
  try {
    await applyFlowAssessment(repo.root, change, proposal);
  } finally {
    mutationChannel.unsubscribe(listener);
  }
  assert.ok(decisionWrite, 'the controlled mutation must start at the accepted-Flow write boundary');
  await decisionWrite;

  const persisted = await resolveChange(repo.root, change.metadata.id);
  const result = (await loadFlowPlan(repo.root, persisted))!;
  assert.equal(result.assessment.topology, 'CROSS_MODULE');
  assert.deepEqual(result.decisionIds, ['DEC-0001']);
  assert.equal(persisted.metadata.readiness.review, 'MISSING');
  assert.equal(persisted.metadata.readiness.domain, 'MISSING');
});

test('Decision mutation attempted before source rebound write preserves both source and Decision state', async () => {
  const repo = await createTestRepository('flow-source-serialized-decision');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Serialized source rebound', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const nextSourceRefs = flow.assessment.sourceRefs.map((sourceRef) => ({
    ...sourceRef,
    contentHash: `sha256:${'c'.repeat(64)}`,
  }));
  const mutationChannel = channel('omnai:core:change-mutation');
  let decisionWrite: Promise<unknown> | undefined;
  const listener = (message: unknown): void => {
    const event = message as { stage?: string; changeId?: string };
    if (event.stage !== 'FLOW_SOURCE_BEFORE_WRITE' || event.changeId !== change.metadata.id || decisionWrite) return;
    decisionWrite = openDecision(repo.root, change, { schemaVersion: 2,
      kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Who owns source state?', options: [],
      affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
    });
  };
  mutationChannel.subscribe(listener);
  try {
    await applyFlowAssessment(repo.root, change, {
      schemaVersion: 2,
      changeId: change.metadata.id,
      revision: change.metadata.activeRevision,
      baseline: change.metadata.baseline,
      assessment: { ...flow.assessment, sourceRefs: nextSourceRefs },
    });
  } finally {
    mutationChannel.unsubscribe(listener);
  }
  assert.ok(decisionWrite, 'the controlled mutation must start at the source-Flow write boundary');
  await decisionWrite;

  const persisted = await resolveChange(repo.root, change.metadata.id);
  const result = (await loadFlowPlan(repo.root, persisted))!;
  assert.deepEqual(result.assessment.sourceRefs, nextSourceRefs);
  assert.deepEqual(result.decisionIds, ['DEC-0001']);
  assert.equal(persisted.metadata.readiness.domain, 'MISSING');
});

test('only intended Flow and Reconcile operations are callable from public module surfaces', async () => {
  const flowAssessmentModule = await import('../src/core/flow-assessment.js');
  const reconcileModule = await import('../src/core/reconcile.js');
  const packageModule = await import('../src/index.js');

  assert.equal(typeof flowAssessmentModule.applyFlowAssessment, 'function');
  assert.equal('applyFlowAssessmentTransaction' in flowAssessmentModule, false);
  assert.equal('reconcileChangeWithFinalization' in reconcileModule, false);
  assert.equal('completeReconcileAudit' in reconcileModule, false);
  assert.equal('reconcileChangeWithFinalization' in packageModule, false);
  assert.equal('completeReconcileAudit' in packageModule, false);
  assert.equal('markReadinessWithinChangeLock' in packageModule, false);

  const indexDeclaration = await readFile(join(process.cwd(), 'dist/src/index.d.ts'), 'utf8');
  const storeDeclaration = await readFile(join(process.cwd(), 'dist/src/core/store.d.ts'), 'utf8');
  assert.doesNotMatch(indexDeclaration, /markReadinessWithinChangeLock/);
  assert.doesNotMatch(storeDeclaration, /markReadinessWithinChangeLock/);
});

test('decision mutations recompile same-Revision decision references without creating a Revision', async () => {
  const repo = await createTestRepository('flow-decision-sync');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Decision sync', 'complex-domain-feature');
  await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Who owns consent?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs,
  });
  const flow = (await loadFlowPlan(repo.root, change))!;
  assert.deepEqual(flow.decisionIds, ['DEC-0001']);
  assert.equal(flow.revision, 'REV-0001');
});

test('decision synchronization promotes newly active readiness only from NOT_APPLICABLE to MISSING', async () => {
  const repo = await createTestRepository('flow-decision-readiness');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Decision readiness', 'small-feature');
  assert.equal(change.metadata.readiness.domain, 'NOT_APPLICABLE');
  await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Which domain owns it?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs,
  });
  assert.equal(change.metadata.readiness.domain, 'MISSING');
  assert.notEqual(change.metadata.readiness.domain, 'READY');
});

test('resolved decision history survives supersession while FlowPlan recompiles in place', async () => {
  const repo = await createTestRepository('flow-decision-history');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Decision history', 'architecture-governance');
  const input = {
    kind: 'ARCHITECTURE' as const, owner: 'AGENT' as const, status: 'OPEN' as const, blocking: true, options: [],
    affects: { capabilities: ['design' as const], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
  };
  const decision = await openDecision(repo.root, change, { schemaVersion: 2, ...input, question: 'Where is the seam?' });
  const replacement = await openDecision(repo.root, change, { schemaVersion: 2, ...input, question: 'Which seam replaces it?' });
  const resolved = await resolveDecision(repo.root, change, decision.id, { schemaVersion: 2,
    summary: 'Use an adapter', optionId: null, authority: 'AGENT_EVIDENCE', sourceRefs,
  });
  const superseded = await supersedeDecision(repo.root, change, decision.id, replacement.id, 'New evidence', sourceRefs);
  assert.deepEqual(superseded.resolution, resolved.resolution);
  assert.equal(superseded.resolvedRevision, resolved.resolvedRevision);
  assert.equal((await loadFlowPlan(repo.root, change))?.revision, 'REV-0001');
});

test('legacy Decision mutations do not implicitly create a FlowPlan', async () => {
  const repo = await createTestRepository('flow-legacy-decision');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Legacy decision', 'small-feature');
  await rm(changeFlowPath(repo.root, change.directoryName));
  await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Who owns this?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
  });
  assert.equal(await loadFlowPlan(repo.root, change), null);
});

test('ordinary Reconcile rebinds a present FlowPlan to the new Revision and Baseline', async () => {
  const repo = await createTestRepository('flow-reconcile-rebind');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Requirement change', 'small-feature');
  await reconcileChange(repo.root, change, { level: 'L3', type: 'DOMAIN_CHANGED', reason: 'Ownership changed' });
  const flow = (await loadFlowPlan(repo.root, change))!;
  assert.equal(flow.revision, 'REV-0002');
  assert.equal(flow.baseline, 'BL-0002');
});

test('Flow reassessment rebinds live Decisions before compiling the accepted FlowPlan', async () => {
  const repo = await createTestRepository('flow-reassess-decision-lineage');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Reassess with live Decisions', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const first = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'ARCHITECTURE', owner: 'AGENT', status: 'OPEN', blocking: false,
    question: 'Which stable interface owns the change?', options: [],
    affects: { capabilities: ['design'], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs,
  });
  const second = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'SOLUTION', owner: 'AGENT', status: 'BLOCKED', blocking: false,
    question: 'Which solution remains viable?', options: [],
    affects: { capabilities: ['design'], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs,
  });
  const replacement = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'SOLUTION', owner: 'AGENT', status: 'OPEN', blocking: false,
    question: 'Which executable solution replaces the blocked option?', options: [],
    affects: { capabilities: ['design'], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs,
  });
  const current = (await loadFlowPlan(repo.root, change))!;

  const assessed = await applyFlowAssessment(repo.root, change, changedTopologyProposal(change, current.assessment));
  const rebound = await listDecisions(repo.root, change);
  assert.deepEqual(rebound.map(({ openedRevision }) => openedRevision), ['REV-0002', 'REV-0002', 'REV-0002']);
  assert.equal(assessed.flow.revision, 'REV-0002');
  assert.deepEqual(assessed.flow.decisionIds, [first.id, second.id, replacement.id]);
  await resolveRepositoryRoute(repo.root, change);
  await resolveDecision(repo.root, change, first.id, { schemaVersion: 2,
    summary: 'Use the stable adapter interface', optionId: null, authority: 'AGENT_EVIDENCE', sourceRefs,
  });
  await supersedeDecision(
    repo.root,
    change,
    second.id,
    replacement.id,
    'The executable replacement is now current',
    sourceRefs,
  );
  const prepared = await import('../src/core/stages.js').then(({ prepareStage }) => (
    prepareStage(repo.root, change, 'design', 'Prepare the accepted design.')
  ));
  assert.equal(prepared.manifest.revision, 'REV-0002');
  assert.notEqual(flow.revision, assessed.flow.revision);
});

test('Flow reassessment retries an exact partial live-Decision rebind and emits one bound audit per Decision', async () => {
  const repo = await createTestRepository('flow-partial-decision-rebind');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Recover partial Decision lineage', 'small-feature');
  for (const [status, question] of [
    ['OPEN', 'Which interface owns the boundary?'],
    ['BLOCKED', 'Which legacy path remains supported?'],
  ] as const) {
    await openDecision(repo.root, change, { schemaVersion: 2,
      kind: 'ARCHITECTURE', owner: 'AGENT', status, blocking: false, question, options: [],
      affects: { capabilities: ['design'], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] },
      sourceRefs,
    });
  }
  const flow = (await loadFlowPlan(repo.root, change))!;
  const proposal = changedTopologyProposal(change, flow.assessment);

  assert.equal(
    crashAssessmentAtStage(repo.root, change.metadata.id, proposal, 'FLOW_RECONCILE_DECISION_REBOUND'),
    91,
  );
  const interrupted = await resolveChange(repo.root, change.metadata.id);
  assert.equal(interrupted.metadata.activeRevision, 'REV-0002');
  assert.deepEqual(
    (await listDecisions(repo.root, interrupted)).map(({ openedRevision }) => openedRevision),
    ['REV-0002', 'REV-0001'],
  );

  const recovered = await applyFlowAssessment(repo.root, interrupted, proposal);
  assert.equal(recovered.flow.revision, 'REV-0002');
  const decisions = await listDecisions(repo.root, interrupted);
  assert.deepEqual(decisions.map(({ openedRevision }) => openedRevision), ['REV-0002', 'REV-0002']);
  const revision = YAML.parse(await readText(
    join(changeRevisionsRoot(repo.root, change.directoryName), 'REV-0002.yaml'),
  )) as { createdAt: string };
  const events = await readJsonLines<{
    timestamp?: string;
    event?: string;
    revision?: string;
    detail?: string;
    data?: Record<string, unknown>;
  }>(changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl'));
  const reboundEvents = events.filter(({ event }) => event === 'DECISION_REBOUND');
  assert.equal(reboundEvents.length, 2);
  for (const decision of decisions) {
    const matching = reboundEvents.filter(({ data }) => data?.decisionId === decision.id);
    assert.equal(matching.length, 1);
    assert.deepEqual(matching[0], {
      timestamp: revision.createdAt,
      event: 'DECISION_REBOUND',
      changeId: change.metadata.id,
      revision: 'REV-0002',
      detail: `Rebound live decision ${decision.id} from REV-0001 to REV-0002`,
      data: {
        decisionId: decision.id,
        fromRevision: 'REV-0001',
        toRevision: 'REV-0002',
        baseline: 'BL-0002',
        correlationId: recovered.reconcile!.signal.operationRequestId,
      },
    });
  }
  const replacement = await openDecision(repo.root, interrupted, { schemaVersion: 2,
    kind: 'SOLUTION', owner: 'AGENT', status: 'OPEN', blocking: false,
    question: 'Which recovery seam replaces the blocked one?', options: [],
    affects: { capabilities: ['design'], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs,
  });
  await resolveRepositoryRoute(repo.root, interrupted);
  await resolveDecision(repo.root, interrupted, decisions[0]!.id, { schemaVersion: 2,
    summary: 'Use the recovered stable interface', optionId: null, authority: 'AGENT_EVIDENCE', sourceRefs,
  });
  await supersedeDecision(
    repo.root,
    interrupted,
    decisions[1]!.id,
    replacement.id,
    'The recovered replacement is executable',
    sourceRefs,
  );
  const prepared = await import('../src/core/stages.js').then(({ prepareStage }) => (
    prepareStage(repo.root, interrupted, 'design', 'Prepare the recovered design.')
  ));
  assert.equal(prepared.manifest.revision, 'REV-0002');
});

test('Flow journal precedes archive creation and fences mutation across both pre-signal crash seams', async () => {
  for (const stage of ['FLOW_TRANSACTION_INTENT_WRITTEN', 'FLOW_RECONCILE_ARCHIVE_ENSURED'] as const) {
    const repo = await createTestRepository(`flow-order-${stage.toLowerCase()}`);
    cleanups.push(repo.cleanup);
    const change = await createChange(repo.root, `Recover ${stage}`, 'small-feature');
    const flow = (await loadFlowPlan(repo.root, change))!;
    const proposal = changedTopologyProposal(change, flow.assessment);
    assert.equal(crashAssessmentAtStage(repo.root, change.metadata.id, proposal, stage), 91);

    const revisionsRoot = changeRevisionsRoot(repo.root, change.directoryName);
    const files = (await readdir(revisionsRoot)).sort();
    assert.equal(files.includes('REV-0001.flow-transaction.yaml'), true);
    assert.equal(files.includes('REV-0001.flow.yaml'), stage === 'FLOW_RECONCILE_ARCHIVE_ENSURED');
    assert.equal(files.some((file) => file.endsWith('.signal.yaml')), false);
    const before = await flowPendingMutationSnapshot(repo.root, change.directoryName);
    await assert.rejects(() => openDecision(repo.root, change, { schemaVersion: 2,
      kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true,
      question: 'Must the pending Flow remain exclusive?', options: [],
      affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] },
      sourceRefs,
    }), /FLOW_TRANSACTION_PENDING/);
    assert.deepEqual(await flowPendingMutationSnapshot(repo.root, change.directoryName), before);

    await applyFlowAssessment(repo.root, await resolveChange(repo.root, change.metadata.id), proposal);
    await assertCompletedReassessmentCardinality(repo.root, change.directoryName);
  }
});

test('terminal Flow authority rejects duplicate correlated Revisions before a Decision write', async () => {
  const fixture = await createTerminalPendingAssessment('terminal-duplicate-revision');
  const revisionsRoot = changeRevisionsRoot(fixture.repo.root, fixture.change.directoryName);
  const revision = YAML.parse(await readText(join(revisionsRoot, 'REV-0002.yaml'))) as Record<string, unknown>;
  await writeYaml(join(revisionsRoot, 'REV-0003.yaml'), { ...revision, id: 'REV-0003' });
  await assertTerminalDecisionWriteRejectedWithoutMutation(fixture.repo.root, fixture.change.directoryName);
});

test('terminal Flow authority requires the active FlowPlan and its exact accepted plan before late Decisions', async () => {
  for (const mutation of ['missing', 'plan-hash', 'inventory', 'assessment'] as const) {
    const fixture = await createTerminalPendingAssessment(`terminal-active-flow-${mutation}`);
    const flowPath = changeFlowPath(fixture.repo.root, fixture.change.directoryName);
    const activeFlow = await readYaml(flowPath, flowPlanSchema);
    if (mutation === 'missing') {
      await rm(flowPath);
    } else if (mutation === 'plan-hash') {
      await writeYaml(flowPath, {
        ...activeFlow,
        compiledAt: new Date(Date.parse(activeFlow.compiledAt) + 1_000).toISOString(),
      });
    } else if (mutation === 'inventory') {
      const inconsistent = {
        ...activeFlow,
        assessment: { ...activeFlow.assessment, decisionIds: ['DEC-9999'] },
        decisionIds: ['DEC-9999'],
      };
      await writeYaml(flowPath, { ...inconsistent, inputHash: flowInputHash(inconsistent) });
    } else {
      const inconsistent = {
        ...activeFlow,
        assessment: {
          ...activeFlow.assessment,
          sourceRefs: activeFlow.assessment.sourceRefs.map((sourceRef) => ({
            ...sourceRef,
            contentHash: `sha256:${'b'.repeat(64)}`,
          })),
        },
      };
      await writeYaml(flowPath, { ...inconsistent, inputHash: flowInputHash(inconsistent) });
    }
    await assertTerminalDecisionWriteRejectedWithoutMutation(fixture.repo.root, fixture.change.directoryName);
  }
});

test('terminal Flow authority rejects deletion of accepted Decision lineage despite a canonical active Flow', async () => {
  const repo = await createTestRepository('terminal-deleted-decision');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Reject deleted accepted Decision', 'small-feature');
  const decision = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'ARCHITECTURE', owner: 'AGENT', status: 'OPEN', blocking: false,
    question: 'Which accepted interface must retain lineage?', options: [],
    affects: { capabilities: ['design'], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs,
  });
  const flow = (await loadFlowPlan(repo.root, change))!;
  const proposal = changedTopologyProposal(change, flow.assessment);
  assert.equal(crashAssessmentAtStage(repo.root, change.metadata.id, proposal, 'FLOW_REASSESSED_AUDITED'), 91);
  const active = await resolveChange(repo.root, change.metadata.id);
  await rm(changeDecisionPath(repo.root, change.directoryName, decision.id));
  const activeFlow = (await loadFlowPlan(repo.root, active))!;
  await writeYaml(
    changeFlowPath(repo.root, change.directoryName),
    compileFlowPlan(
      active.metadata,
      getScenario(active.metadata.scenario),
      activeFlow.assessment,
      [],
      activeFlow.compiledAt,
    ),
  );

  await assertTerminalDecisionWriteRejectedWithoutMutation(repo.root, change.directoryName);
});

test('terminal Flow authority derives canonical level and readiness closure from changed assessment fields', async () => {
  const fixture = await createTerminalPendingAssessment('terminal-canonical-level');
  const revisionsRoot = changeRevisionsRoot(fixture.repo.root, fixture.change.directoryName);
  const transaction = YAML.parse(await readText(join(revisionsRoot, 'REV-0001.flow-transaction.yaml'))) as {
    correlationId: string;
  };
  const revisionPath = join(revisionsRoot, 'REV-0002.yaml');
  const revision = YAML.parse(await readText(revisionPath)) as Record<string, unknown>;
  const l0Readiness = ['implementation', 'review', 'verification', 'qa', 'release', 'canary', 'learning'];
  await writeYaml(revisionPath, { ...revision, level: 'L0', affectedArtifacts: l0Readiness });
  const signalFile = (await readdir(revisionsRoot)).find((file) => file.endsWith('.signal.yaml'))!;
  const signalPath = join(revisionsRoot, signalFile);
  const signal = YAML.parse(await readText(signalPath)) as Record<string, unknown>;
  await writeYaml(signalPath, { ...signal, level: 'L0' });
  const progressPath = changeArtifactPath(fixture.repo.root, fixture.change.directoryName, 'progress.jsonl');
  const events = await readJsonLines<{
    event?: string;
    detail?: string;
    data?: { correlationId?: string; affectedReadiness?: unknown };
  }>(progressPath);
  const forged = events.map((event) => (
    event.event === 'RECONCILE_APPLIED' && event.data?.correlationId === transaction.correlationId
      ? { ...event, detail: event.detail?.replace(/^L2 /, 'L0 '), data: { ...event.data, affectedReadiness: l0Readiness } }
      : event
  ));
  await writeTextAtomic(progressPath, `${forged.map((event) => JSON.stringify(event)).join('\n')}\n`);
  await assertTerminalDecisionWriteRejectedWithoutMutation(fixture.repo.root, fixture.change.directoryName);
});

test('ordinary Reconcile uses its validated preflight plan when reassessment sources omit the initial policy source', async () => {
  const repo = await createTestRepository('flow-reconcile-preflight');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Rebound requirement change', 'small-feature');
  const initial = (await loadFlowPlan(repo.root, change))!;
  await applyFlowAssessment(repo.root, change, {
    schemaVersion: 2,
    changeId: change.metadata.id,
    revision: change.metadata.activeRevision,
    baseline: change.metadata.baseline,
    assessment: {
      ...initial.assessment,
      topology: 'CROSS_MODULE',
      architectureApplicability: 'FOCUSED',
      sourceRefs,
    },
  });
  await reconcileChange(repo.root, change, { level: 'L3', type: 'DOMAIN_CHANGED', reason: 'Ownership changed' });
  const rebound = (await loadFlowPlan(repo.root, change))!;
  assert.equal(rebound.revision, 'REV-0003');
  assert.equal(rebound.baseline, 'BL-0003');
  assert.deepEqual(rebound.assessment.sourceRefs, sourceRefs);
});

test('manual input hash edits fail closed before Reconcile or Decision mutation', async () => {
  const repo = await createTestRepository('flow-integrity-preflight');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Integrity preflight', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  await writeYaml(changeFlowPath(repo.root, change.directoryName), { ...flow, inputHash: `sha256:${'0'.repeat(64)}` });
  const beforeEvents = await readJsonLines(changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl'));
  await assert.rejects(
    () => reconcileChange(repo.root, change, { level: 'L3', type: 'DOMAIN_CHANGED', reason: 'Ownership changed' }),
    /FLOW_INTEGRITY_MISMATCH/,
  );
  await assert.rejects(() => openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Who owns it?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
  }), /FLOW_INTEGRITY_MISMATCH/);
  assert.equal((await resolveChange(repo.root, change.metadata.id)).metadata.activeRevision, 'REV-0001');
  assert.equal(await pathExists(join(changeRevisionsRoot(repo.root, change.directoryName), 'REV-0002.yaml')), false);
  assert.equal(await pathExists(changeDecisionPath(repo.root, change.directoryName, 'DEC-0001')), false);
  assert.deepEqual(await readJsonLines(changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl')), beforeEvents);
});

test('scenario stage floors reject a recomputed manual downgrade', async () => {
  const repo = await createTestRepository('flow-scenario-floor');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Scenario floor', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const capabilities = flow.capabilities.map((entry) => entry.capability === 'spec'
    ? { ...entry, disposition: 'CONDITIONAL' as const }
    : entry);
  const downgraded = { ...flow, capabilities };
  await writeYaml(changeFlowPath(repo.root, change.directoryName), {
    ...downgraded,
    inputHash: flowInputHash(downgraded),
  });
  await assert.rejects(() => loadFlowPlan(repo.root, change), /FLOW_SCENARIO_FLOOR_VIOLATION/);
});

test('existing workflow locks preserve custom schemas while gaining decision and flow schemas', async () => {
  const repo = await createTestRepository('flow-lock-migration');
  cleanups.push(repo.cleanup);
  await initializeProject(repo.root);
  await writeYaml(workflowLockPath(repo.root), {
    schemaVersion: 1,
    workflowVersion: '0.1.0',
    artifactSchemas: { project: 7, custom: 3 },
  });
  await initializeProject(repo.root);
  const lock = YAML.parse(await readText(workflowLockPath(repo.root))) as { artifactSchemas: Record<string, number> };
  assert.deepEqual(lock.artifactSchemas, { project: 7, custom: 3, decision: 1, flow: 1 });
});

test('assessment classification changes choose the earliest affected Reconcile level', async () => {
  const cases = [
    { name: 'problem', expected: 'L4', mutate: (assessment: FlowAssessment) => ({ ...assessment, uncertainty: { ...assessment.uncertainty, problem: 'OPEN' as const } }) },
    { name: 'domain', expected: 'L3', mutate: (assessment: FlowAssessment) => ({ ...assessment, uncertainty: { ...assessment.uncertainty, domain: 'OPEN' as const } }) },
    { name: 'solution', expected: 'L2', mutate: (assessment: FlowAssessment) => ({ ...assessment, uncertainty: { ...assessment.uncertainty, solution: 'OPEN' as const } }) },
  ] as const;
  for (const { name, expected, mutate } of cases) {
    const repo = await createTestRepository(`flow-level-${name}`);
    cleanups.push(repo.cleanup);
    const change = await createChange(repo.root, `Flow level ${name}`, 'small-feature');
    const flow = (await loadFlowPlan(repo.root, change))!;
    const result = await applyFlowAssessment(repo.root, change, {
      schemaVersion: 2,
      changeId: change.metadata.id,
      revision: change.metadata.activeRevision,
      baseline: change.metadata.baseline,
      assessment: mutate(flow.assessment),
    });
    assert.equal(result.reconcile?.revision.level, expected);
  }
});

function changedTopologyProposal(
  change: Awaited<ReturnType<typeof resolveChange>>,
  assessment: FlowAssessment,
): FlowAssessmentProposal {
  return {
    schemaVersion: 2,
    changeId: change.metadata.id,
    revision: change.metadata.activeRevision,
    baseline: change.metadata.baseline,
    assessment: { ...assessment, topology: 'CROSS_MODULE', architectureApplicability: 'FOCUSED' },
  };
}

function crashAssessmentAtStage(
  repoRoot: string,
  changeId: string,
  proposal: FlowAssessmentProposal,
  stage:
    | 'FLOW_RECONCILE_SIGNAL_WRITTEN'
    | 'FLOW_RECONCILE_REVISION_WRITTEN'
    | 'FLOW_RECONCILE_METADATA_SAVED'
    | 'FLOW_RECONCILE_DECISION_REBOUND'
    | 'FLOW_RECONCILE_REBOUND'
    | 'FLOW_TRANSACTION_INTENT_WRITTEN'
    | 'FLOW_RECONCILE_ARCHIVE_ENSURED'
    | 'FLOW_ACCEPTED_BEFORE_WRITE'
    | 'FLOW_REASSESSED_AUDITED',
): number | null {
  const storeModule = new URL('../src/core/store.js', import.meta.url).href;
  const assessmentModule = new URL('../src/core/flow-assessment.js', import.meta.url).href;
  const script = [
    `import { channel } from 'node:diagnostics_channel';`,
    `const mutationChannel = channel('omnai:core:change-mutation');`,
    `mutationChannel.subscribe((message) => {`,
    `  if (message.stage === ${JSON.stringify(stage)} && message.changeId === ${JSON.stringify(changeId)}) process.exit(91);`,
    `});`,
    `const { resolveChange } = await import(${JSON.stringify(storeModule)});`,
    `const { applyFlowAssessment } = await import(${JSON.stringify(assessmentModule)});`,
    `const change = await resolveChange(${JSON.stringify(repoRoot)}, ${JSON.stringify(changeId)});`,
    `await applyFlowAssessment(${JSON.stringify(repoRoot)}, change, ${JSON.stringify(proposal)});`,
  ].join('\n');
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'pipe'],
  }).status;
}

async function createTerminalPendingAssessment(name: string) {
  const repo = await createTestRepository(name);
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, `Recover ${name}`, 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const proposal = changedTopologyProposal(change, flow.assessment);
  assert.equal(crashAssessmentAtStage(repo.root, change.metadata.id, proposal, 'FLOW_REASSESSED_AUDITED'), 91);
  return { repo, change, proposal };
}

async function assertTerminalDecisionWriteRejectedWithoutMutation(repoRoot: string, directoryName: string) {
  const before = await flowPendingMutationSnapshot(repoRoot, directoryName);
  const change = await resolveChange(repoRoot, before.changeId);
  await assert.rejects(() => openDecision(repoRoot, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: false,
    question: 'Can terminal authority admit this ordinary Decision?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs,
  }), /FLOW_TRANSACTION_COMPLETION_MISMATCH/);
  assert.deepEqual(await flowPendingMutationSnapshot(repoRoot, directoryName), before);
}

async function flowPendingMutationSnapshot(repoRoot: string, directoryName: string) {
  const revisionsRoot = changeRevisionsRoot(repoRoot, directoryName);
  const decisionsRoot = join(repoRoot, '.omnai', 'changes', directoryName, 'decisions');
  const revisionFiles = (await readdir(revisionsRoot)).sort();
  const decisionFiles = (await readdir(decisionsRoot)).sort();
  const metadata = YAML.parse(await readText(changeMetadataPath(repoRoot, directoryName))) as { id: string };
  return {
    changeId: metadata.id,
    metadata: await readText(changeMetadataPath(repoRoot, directoryName)),
    flow: await pathExists(changeFlowPath(repoRoot, directoryName))
      ? await readText(changeFlowPath(repoRoot, directoryName))
      : null,
    tasks: await readText(changeArtifactPath(repoRoot, directoryName, 'tasks.yaml')),
    progress: await readText(changeArtifactPath(repoRoot, directoryName, 'progress.jsonl')),
    revisionFiles,
    revisionBytes: await Promise.all(revisionFiles.map((file) => readText(join(revisionsRoot, file)))),
    decisionFiles,
    decisionBytes: await Promise.all(decisionFiles.map((file) => readText(join(decisionsRoot, file)))),
  };
}

async function assertCompletedReassessmentCardinality(repoRoot: string, directoryName: string): Promise<void> {
  const revisionsRoot = changeRevisionsRoot(repoRoot, directoryName);
  const revisionFiles = await readdir(revisionsRoot);
  assert.equal(revisionFiles.filter((file) => file.endsWith('.signal.yaml')).length, 1);
  assert.equal(revisionFiles.filter((file) => /^REV-\d{4}\.yaml$/.test(file)).length, 2);
  assert.equal(revisionFiles.filter((file) => file.endsWith('.flow-transaction.yaml')).length, 1);
  const transactionPath = join(revisionsRoot, 'REV-0001.flow-transaction.yaml');
  const transaction = YAML.parse(await readText(transactionPath)) as { status: string };
  assert.equal(transaction.status, 'COMPLETED');
  const events = await readJsonLines<{ event: string }>(changeArtifactPath(repoRoot, directoryName, 'progress.jsonl'));
  assert.equal(events.filter(({ event }) => event === 'RECONCILE_APPLIED').length, 1);
  assert.equal(events.filter(({ event }) => event === 'FLOW_REASSESSED').length, 1);
}

async function flowReassessmentMutationSnapshot(repoRoot: string, directoryName: string) {
  const revisionsRoot = changeRevisionsRoot(repoRoot, directoryName);
  const revisionFiles = (await readdir(revisionsRoot)).sort();
  return {
    metadata: await readText(changeMetadataPath(repoRoot, directoryName)),
    flow: await readText(changeFlowPath(repoRoot, directoryName)),
    progress: await readText(changeArtifactPath(repoRoot, directoryName, 'progress.jsonl')),
    revisionFiles,
    revisionBytes: await Promise.all(revisionFiles.map((file) => readText(join(revisionsRoot, file)))),
    currentFlowHash: hashFlowPlan(await readYaml(changeFlowPath(repoRoot, directoryName), flowPlanSchema)),
    archiveHash: hashFlowPlan(await readYaml(join(revisionsRoot, 'REV-0001.flow.yaml'), flowPlanSchema)),
  };
}
