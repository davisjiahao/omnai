import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import { join } from 'node:path';
import {
  flowPlanSchema,
  revisionSchema,
  taskSchema,
  type Capability,
  type DecisionRecord,
  type FlowAssessmentProposal,
  type Task,
  type TaskStatus,
} from '../src/domain/types.js';
import { decisionReconcileTransactionSchema } from '../src/core/decision-reconcile-transaction.js';
import { appendJsonLine, readJsonLines, readText, readYaml, writeTextAtomic, writeYaml } from '../src/core/files.js';
import { hashFlowPlan } from '../src/core/flow.js';
import { loadFlowPlan, synchronizeFlowDecisions } from '../src/core/flow-store.js';
import { changeArtifactPath, changeDecisionPath, changeMetadataPath, changeRevisionsRoot } from '../src/core/paths.js';
import { openDecision, listDecisions, requireDecision, resolveDecision, supersedeDecision } from '../src/core/decisions.js';
import { resolveRepositoryRoute } from '../src/core/router.js';
import { createChange, resolveChange, saveChange } from '../src/core/store.js';
import { loadTasks, saveTasks } from '../src/core/tasks.js';
import { applyFlowAssessment } from '../src/core/flow-assessment.js';
import { createTestRepository } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length > 0) await cleanups.pop()?.(); });
const hash = `sha256:${'a'.repeat(64)}` as const;
const sourceRefs = [{ kind: 'artifact' as const, path: 'domain.md', contentHash: hash }];

test('Reconcile depends on the lower Decision store without an orchestration import cycle', async () => {
  const reconcileSource = await readFile(join(process.cwd(), 'src/core/reconcile-internal.ts'), 'utf8');
  const storeSource = await readFile(join(process.cwd(), 'src/core/decision-store.ts'), 'utf8');
  assert.match(reconcileSource, /from '\.\/decision-store\.js'/);
  assert.doesNotMatch(reconcileSource, /from '\.\/decisions\.js'/);
  assert.doesNotMatch(storeSource, /from '\.\/reconcile(?:-internal)?\.js'/);
});

test('decision IDs are monotonic and records are sorted', async () => {
  const repo = await createTestRepository('decisions');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Consent ownership', 'complex-domain-feature');
  const base = { owner: 'HUMAN' as const, status: 'OPEN' as const, blocking: true, options: [], affects: { capabilities: ['model' as const], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs };
  assert.equal((await openDecision(repo.root, change, { schemaVersion: 2, ...base, kind: 'DOMAIN', question: 'Who owns consent?' })).id, 'DEC-0001');
  assert.equal((await openDecision(repo.root, change, { schemaVersion: 2, ...base, kind: 'PROBLEM', question: 'Which user outcome matters?' })).id, 'DEC-0002');
  assert.deepEqual((await listDecisions(repo.root, change)).map((item) => item.id), ['DEC-0001', 'DEC-0002']);
});

test('persisted decision filenames must match their record IDs', async () => {
  const repo = await createTestRepository('decision-filename-integrity');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Filename integrity', 'complex-domain-feature');
  const decision = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Who owns consent?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
  });
  await writeYaml(changeDecisionPath(repo.root, change.directoryName, 'DEC-9999'), decision);
  await assert.rejects(() => listDecisions(repo.root, change), /DECISION_FILENAME_MISMATCH/);
  await assert.rejects(() => requireDecision(repo.root, change, decision.id), /DECISION_FILENAME_MISMATCH/);
  await assert.rejects(() => openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Who owns consent next?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
  }), /DECISION_FILENAME_MISMATCH/);
});

test('malformed persisted decision records fail closed', async () => {
  const repo = await createTestRepository('decision-malformed');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Malformed decision', 'complex-domain-feature');
  await writeYaml(changeDecisionPath(repo.root, change.directoryName, 'DEC-0001'), { schemaVersion: 1 });
  const isSchemaFailure = (error: unknown): boolean => error instanceof Error && error.name === 'ZodError';
  await assert.rejects(() => listDecisions(repo.root, change), isSchemaFailure);
  await assert.rejects(() => requireDecision(repo.root, change, 'DEC-0001'), isSchemaFailure);
  await assert.rejects(() => openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Who owns consent?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
  }), isSchemaFailure);
});

test('stale ChangeRef identity revision and baseline each reject decision mutations', async () => {
  const cases = [
    { field: 'id', value: 'CHG-9999', error: /DECISION_STALE_CHANGE/ },
    { field: 'activeRevision', value: 'REV-0002', error: /DECISION_STALE_REVISION/ },
    { field: 'baseline', value: 'BL-0002', error: /DECISION_STALE_BASELINE/ },
  ] as const;
  for (const { field, value, error } of cases) {
    const repo = await createTestRepository(`decision-stale-${field}`);
    cleanups.push(repo.cleanup);
    const change = await createChange(repo.root, `Stale ${field}`, 'complex-domain-feature');
    await writeYaml(changeMetadataPath(repo.root, change.directoryName), { ...change.metadata, [field]: value });
    await assert.rejects(() => openDecision(repo.root, change, { schemaVersion: 2,
      kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Who owns consent?', options: [],
      affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
    }), error);
  }
});

test('human decisions require explicit human confirmation and exact active revision', async () => {
  const repo = await createTestRepository('decision-authority');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Consent ownership', 'complex-domain-feature');
  const decision = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Who owns consent?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
  });
  await assert.rejects(() => resolveDecision(repo.root, change, decision.id, { schemaVersion: 2, summary: 'User Center', optionId: null, authority: 'AGENT_EVIDENCE', sourceRefs }), /DECISION_AUTHORITY_MISMATCH/);
  const resolved = await resolveDecision(repo.root, change, decision.id, { schemaVersion: 2, summary: 'User Center', optionId: null, authority: 'HUMAN_CONFIRMED', sourceRefs });
  assert.equal(resolved.status, 'RESOLVED');
  assert.equal(resolved.resolvedRevision, change.metadata.activeRevision);
});

test('resolving a decision against settled authority performs the guarded Reconcile transaction first', async () => {
  const repo = await createTestRepository('decision-settled-authority-transaction');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Changed consent ownership', 'complex-domain-feature');
  const tasksPath = changeArtifactPath(repo.root, change.directoryName, 'tasks.yaml');
  const taskFile = await loadTasks(tasksPath);
  taskFile.tasks = [
    decisionTask('TASK-001', 'Affected model task', [], 'DONE'),
    decisionTask('TASK-002', 'Dependent task', ['TASK-001'], 'RUNNING'),
    decisionTask('TASK-003', 'Unrelated task', [], 'DONE'),
  ];
  await saveTasks(tasksPath, taskFile);
  for (const key of ['research', 'domain', 'spec', 'design', 'plan'] as const) {
    change.metadata.readiness[key] = 'READY';
  }
  await saveChange(repo.root, change);
  const decision = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Who owns consent now?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: ['TASK-001'], projects: [], contracts: [] }, sourceRefs,
  });
  const oldFlow = (await loadFlowPlan(repo.root, change))!;
  assert.equal((await resolveRepositoryRoute(repo.root, change)).capability, 'reconcile');

  const resolved = await resolveDecision(repo.root, change, decision.id, { schemaVersion: 2,
    summary: 'Identity owns consent', optionId: null, authority: 'HUMAN_CONFIRMED', sourceRefs,
  });

  const active = await resolveChange(repo.root, change.metadata.id);
  const rebound = (await loadFlowPlan(repo.root, active))!;
  const revision = await readYaml(
    join(changeRevisionsRoot(repo.root, change.directoryName), 'REV-0002.yaml'),
    revisionSchema,
  );
  const archived = await readYaml(
    join(changeRevisionsRoot(repo.root, change.directoryName), 'REV-0001.flow.yaml'),
    flowPlanSchema,
  );
  assert.equal(active.metadata.activeRevision, 'REV-0002');
  assert.equal(active.metadata.baseline, 'BL-0002');
  assert.equal(resolved.resolvedRevision, 'REV-0002');
  assert.ok(revision.affectedReadiness.includes('domain'));
  assert.ok(revision.affectedReadiness.includes('spec'));
  assert.ok(revision.affectedReadiness.includes('design'));
  assert.ok(revision.affectedReadiness.includes('plan'));
  assert.deepEqual(revision.affectedTasks, ['TASK-001', 'TASK-002']);
  assert.equal(active.metadata.readiness.research, 'READY');
  assert.equal(active.metadata.readiness.domain, 'STALE');
  assert.equal(active.metadata.readiness.spec, 'STALE');
  assert.equal(active.metadata.readiness.design, 'INVALIDATED');
  assert.equal(active.metadata.readiness.plan, 'INVALIDATED');
  const updatedTasks = await loadTasks(tasksPath);
  assert.equal(updatedTasks.tasks[0]!.status, 'NEEDS_REVALIDATION');
  assert.equal(updatedTasks.tasks[1]!.status, 'INVALIDATED');
  assert.equal(updatedTasks.tasks[2]!.status, 'DONE');
  assert.equal(hashFlowPlan(archived), hashFlowPlan(oldFlow));
  assert.equal(rebound.revision, 'REV-0002');
  assert.equal(rebound.baseline, 'BL-0002');
  const next = await resolveRepositoryRoute(repo.root, active);
  assert.equal(next.capability, 'model');
  assert.deepEqual(next.decisionIds, []);
});

test('a guarded resolution rebinds remaining live decisions to the new Revision', async () => {
  const repo = await createTestRepository('decision-settled-authority-rebind');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Rebind remaining decisions', 'complex-domain-feature');
  change.metadata.readiness.research = 'READY';
  change.metadata.readiness.domain = 'READY';
  await saveChange(repo.root, change);
  const first = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Who owns consent?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
  });
  const second = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Who owns deletion?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
  });

  await resolveDecision(repo.root, change, first.id, { schemaVersion: 2,
    summary: 'Identity owns consent', optionId: null, authority: 'HUMAN_CONFIRMED', sourceRefs,
  });

  const active = await resolveChange(repo.root, change.metadata.id);
  const rebound = await requireDecision(repo.root, active, second.id);
  assert.equal(rebound.status, 'OPEN');
  assert.equal(rebound.openedRevision, 'REV-0002');
  const route = await resolveRepositoryRoute(repo.root, active);
  assert.equal(route.capability, 'reconcile');
  assert.deepEqual(route.decisionIds, [second.id]);
});

test('Decision Reconcile rejects an incompatible archive before creating its durable journal', async () => {
  const repo = await createTestRepository('decision-reconcile-archive-preflight');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Preflight Decision lineage', 'small-feature');
  change.metadata.readiness.design = 'READY';
  await saveChange(repo.root, change);
  const decision = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'ARCHITECTURE', owner: 'AGENT', status: 'OPEN', blocking: true,
    question: 'Which settled seam changes?', options: [],
    affects: { capabilities: ['design'], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs,
  });
  const flow = (await loadFlowPlan(repo.root, change))!;
  await writeYaml(
    join(changeRevisionsRoot(repo.root, change.directoryName), 'REV-0001.flow.yaml'),
    { ...flow, compiledAt: new Date(Date.parse(flow.compiledAt) + 1_000).toISOString() },
  );
  const before = await decisionStateSnapshot(repo.root, change.directoryName);

  await assert.rejects(
    () => resolveDecision(repo.root, change, decision.id, { schemaVersion: 2,
      summary: 'Move the seam', optionId: null, authority: 'AGENT_EVIDENCE', sourceRefs,
    }),
    /RECONCILE_FLOW_ARCHIVE_MISMATCH/,
  );

  assert.deepEqual(await decisionStateSnapshot(repo.root, change.directoryName), before);
  assert.equal(
    (await readdir(changeRevisionsRoot(repo.root, change.directoryName)))
      .some((file) => file.endsWith('.decision-transaction.yaml')),
    false,
  );
});

test('Decision journal precedes archive creation and recovers both pre-signal crash seams', async () => {
  for (const stage of ['DECISION_RECONCILE_INTENT_WRITTEN', 'FLOW_RECONCILE_ARCHIVE_ENSURED'] as const) {
    const repo = await createTestRepository(`decision-order-${stage.toLowerCase()}`);
    cleanups.push(repo.cleanup);
    const change = await createChange(repo.root, `Recover ${stage}`, 'small-feature');
    change.metadata.readiness.design = 'READY';
    await saveChange(repo.root, change);
    const decision = await openDecision(repo.root, change, { schemaVersion: 2,
      kind: 'ARCHITECTURE', owner: 'AGENT', status: 'OPEN', blocking: true,
      question: 'Which durable seam changes?', options: [],
      affects: { capabilities: ['design'], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] },
      sourceRefs,
    });
    const resolution = {
      schemaVersion: 2 as const,
      summary: `Recover ${stage}`,
      optionId: null,
      authority: 'AGENT_EVIDENCE' as const,
      sourceRefs,
    };

    assert.equal(
      crashDecisionResolutionAtStage(repo.root, change.metadata.id, decision.id, resolution, stage),
      91,
    );
    const revisionsRoot = changeRevisionsRoot(repo.root, change.directoryName);
    const files = (await readdir(revisionsRoot)).sort();
    assert.equal(files.includes(`REV-0001.${decision.id}.decision-transaction.yaml`), true);
    assert.equal(files.includes('REV-0001.flow.yaml'), stage === 'FLOW_RECONCILE_ARCHIVE_ENSURED');
    assert.equal(files.some((file) => file.endsWith('.signal.yaml')), false);
    const interrupted = await resolveChange(repo.root, change.metadata.id);
    const before = await decisionStateSnapshot(repo.root, change.directoryName);
    await assert.rejects(() => openDecision(repo.root, interrupted, { schemaVersion: 2,
      kind: 'ARCHITECTURE', owner: 'AGENT', status: 'OPEN', blocking: false,
      question: 'Must not enter while Decision recovery is pending', options: [],
      affects: { capabilities: ['design'], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] },
      sourceRefs,
    }), /DECISION_RECONCILE_TRANSACTION_PENDING/);
    assert.deepEqual(await decisionStateSnapshot(repo.root, change.directoryName), before);

    const resolved = await resolveDecision(repo.root, interrupted, decision.id, resolution);
    assert.equal(resolved.status, 'RESOLVED');
    assert.equal(resolved.resolvedRevision, 'REV-0002');
    const completedFiles = await readdir(revisionsRoot);
    assert.equal(completedFiles.filter((file) => /^REV-\d{4}\.yaml$/.test(file)).length, 2);
    assert.equal(completedFiles.filter((file) => file.endsWith('.signal.yaml')).length, 1);
  }
});

test('an interrupted settled-authority resolution stays fenced and recovers the same transaction', async () => {
  const repo = await createTestRepository('decision-settled-authority-recovery');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Recover changed consent ownership', 'complex-domain-feature');
  change.metadata.readiness.research = 'READY';
  change.metadata.readiness.domain = 'READY';
  await saveChange(repo.root, change);
  const decision = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Who owns consent after recovery?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
  });
  const resolution = {
      schemaVersion: 2 as const,
    summary: 'Identity owns recovered consent',
    optionId: null,
    authority: 'HUMAN_CONFIRMED' as const,
    sourceRefs,
  };

  assert.equal(
    crashDecisionResolutionAtStage(
      repo.root,
      change.metadata.id,
      decision.id,
      resolution,
      'FLOW_RECONCILE_METADATA_SAVED',
    ),
    91,
  );
  const interrupted = await resolveChange(repo.root, change.metadata.id);
  assert.equal(interrupted.metadata.activeRevision, 'REV-0002');
  assert.equal(interrupted.metadata.baseline, 'BL-0002');
  await assert.rejects(
    () => resolveRepositoryRoute(repo.root, interrupted),
    /DECISION_RECONCILE_TRANSACTION_PENDING/,
  );
  const interruptedDecisions = await listDecisions(repo.root, interrupted);
  await assert.rejects(
    () => synchronizeFlowDecisions(repo.root, interrupted, interruptedDecisions),
    /DECISION_RECONCILE_TRANSACTION_PENDING/,
  );

  const resolved = await resolveDecision(repo.root, interrupted, decision.id, resolution);
  assert.equal(resolved.status, 'RESOLVED');
  assert.equal(resolved.resolvedRevision, 'REV-0002');
  const transaction = await readYaml(
    join(
      changeRevisionsRoot(repo.root, change.directoryName),
      `REV-0001.${decision.id}.decision-transaction.yaml`,
    ),
    decisionReconcileTransactionSchema,
  );
  assert.equal(transaction.status, 'COMPLETED');
  assert.equal(transaction.resolvedRevision, 'REV-0002');
  assert.equal(transaction.resolvedBaseline, 'BL-0002');
  const files = await readdir(changeRevisionsRoot(repo.root, change.directoryName));
  assert.equal(files.filter((file) => file.endsWith('.signal.yaml')).length, 1);
  assert.equal(files.filter((file) => /^REV-\d{4}\.yaml$/.test(file)).length, 2);
  const events = await readJsonLines<{ event: string }>(
    changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl'),
  );
  assert.equal(events.filter(({ event }) => event === 'RECONCILE_APPLIED').length, 1);
  assert.equal(events.filter(({ event }) => event === 'DECISION_RESOLVED').length, 1);
  const route = await resolveRepositoryRoute(repo.root, interrupted);
  assert.equal(route.capability, 'model');
  assert.deepEqual(route.decisionIds, []);
});

test('an early pending Flow transaction fences every Decision mutation before a second journal or state write', async () => {
  const mutations = ['open', 'resolve', 'supersede'] as const;
  for (const mutation of mutations) {
    const repo = await createTestRepository(`decision-flow-pending-${mutation}`);
    cleanups.push(repo.cleanup);
    const change = await createChange(repo.root, `Flow pending ${mutation}`, 'complex-domain-feature');
    change.metadata.readiness.research = 'READY';
    change.metadata.readiness.domain = 'READY';
    await saveChange(repo.root, change);
    const first = await openDecision(repo.root, change, { schemaVersion: 2,
      kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true,
      question: `Who owns ${mutation} authority?`, options: [],
      affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] },
      sourceRefs,
    });
    const replacement = await openDecision(repo.root, change, { schemaVersion: 2,
      kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: false,
      question: `Which authority replaces ${mutation}?`, options: [],
      affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] },
      sourceRefs,
    });
    const flow = (await loadFlowPlan(repo.root, change))!;
    const proposal = changedFlowProposal(change, flow.assessment);
    assert.equal(
      crashFlowAssessmentAtStage(
        repo.root,
        change.metadata.id,
        proposal,
        'FLOW_RECONCILE_SIGNAL_WRITTEN',
      ),
      91,
    );
    const interrupted = await resolveChange(repo.root, change.metadata.id);
    const before = await decisionStateSnapshot(repo.root, change.directoryName);

    const action = mutation === 'open'
      ? () => openDecision(repo.root, interrupted, { schemaVersion: 2,
        kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: false,
        question: 'Must not open during an early Flow transaction', options: [],
        affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] },
        sourceRefs,
      })
      : mutation === 'resolve'
        ? () => resolveDecision(repo.root, interrupted, first.id, { schemaVersion: 2,
          summary: 'Must not resolve during an early Flow transaction',
          optionId: null,
          authority: 'HUMAN_CONFIRMED',
          sourceRefs,
        })
        : () => supersedeDecision(
          repo.root,
          interrupted,
          first.id,
          replacement.id,
          'Must not supersede during an early Flow transaction',
          sourceRefs,
        );

    await assert.rejects(action, /FLOW_TRANSACTION_PENDING/);
    assert.deepEqual(await decisionStateSnapshot(repo.root, change.directoryName), before);
    assert.equal(
      before.revisionFiles.some((file) => file.endsWith('.decision-transaction.yaml')),
      false,
    );

    const recovered = await applyFlowAssessment(repo.root, interrupted, proposal);
    assert.equal(recovered.flow.revision, 'REV-0002');
  }
});

test('a pending Decision transaction fences Flow journal creation and recovery releases the opposite transaction', async () => {
  const repo = await createTestRepository('decision-pending-flow-fence');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Decision pending Flow fence', 'complex-domain-feature');
  change.metadata.readiness.research = 'READY';
  change.metadata.readiness.domain = 'READY';
  await saveChange(repo.root, change);
  const decision = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true,
    question: 'Who owns the fenced Decision transaction?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs,
  });
  const resolution = {
      schemaVersion: 2 as const,
    summary: 'Identity owns the fenced Decision transaction',
    optionId: null,
    authority: 'HUMAN_CONFIRMED' as const,
    sourceRefs,
  };
  assert.equal(
    crashDecisionResolutionAtStage(
      repo.root,
      change.metadata.id,
      decision.id,
      resolution,
      'FLOW_RECONCILE_SIGNAL_WRITTEN',
    ),
    91,
  );
  const interrupted = await resolveChange(repo.root, change.metadata.id);
  const flow = (await loadFlowPlan(repo.root, interrupted))!;
  const proposal = changedFlowProposal(interrupted, flow.assessment);
  const before = await decisionStateSnapshot(repo.root, change.directoryName);

  await assert.rejects(
    () => applyFlowAssessment(repo.root, interrupted, proposal),
    /DECISION_RECONCILE_TRANSACTION_PENDING/,
  );
  assert.deepEqual(await decisionStateSnapshot(repo.root, change.directoryName), before);
  assert.equal(
    before.revisionFiles.some((file) => file.endsWith('.flow-transaction.yaml')),
    false,
  );

  await resolveDecision(repo.root, interrupted, decision.id, resolution);
  const active = await resolveChange(repo.root, change.metadata.id);
  const currentFlow = (await loadFlowPlan(repo.root, active))!;
  const assessed = await applyFlowAssessment(
    repo.root,
    active,
    changedFlowProposal(active, currentFlow.assessment),
  );
  assert.equal(assessed.flow.revision, 'REV-0003');
});

test('only an exact audited Flow terminal-recovery phase permits a newer ordinary Decision write', async () => {
  const corruptions = [
    'flow-missing',
    'flow-duplicate',
    'flow-conflict',
    'reconcile-missing',
    'reconcile-duplicate',
    'reconcile-conflict',
  ] as const;
  for (const corruption of corruptions) {
    const repo = await createTestRepository(`decision-flow-terminal-${corruption}`);
    cleanups.push(repo.cleanup);
    const change = await createChange(repo.root, `Flow terminal ${corruption}`, 'small-feature');
    const flow = (await loadFlowPlan(repo.root, change))!;
    const proposal = changedFlowProposal(change, flow.assessment);
    assert.equal(
      crashFlowAssessmentAtStage(repo.root, change.metadata.id, proposal, 'FLOW_REASSESSED_AUDITED'),
      91,
    );
    const interrupted = await resolveChange(repo.root, change.metadata.id);
    const progressPath = changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl');
    const events = await readJsonLines<Record<string, unknown>>(progressPath);
    const auditEvent = corruption.startsWith('flow-') ? 'FLOW_REASSESSED' : 'RECONCILE_APPLIED';
    const auditIndex = events.findIndex((event) => event.event === auditEvent);
    assert.notEqual(auditIndex, -1);
    const audit = events[auditIndex]!;
    if (corruption.endsWith('-missing')) {
      events.splice(auditIndex, 1);
      await writeTextAtomic(progressPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
    } else if (corruption.endsWith('-duplicate')) {
      await appendJsonLine(progressPath, audit);
    } else {
      const data = audit.data as Record<string, unknown>;
      events[auditIndex] = corruption === 'flow-conflict'
        ? { ...audit, data: { ...data, baseline: 'BL-9999' } }
        : { ...audit, detail: 'L0 conflicting reconcile audit binding' };
      await writeTextAtomic(progressPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
    }
    const before = await decisionStateSnapshot(repo.root, change.directoryName);

    await assert.rejects(
      () => openDecision(repo.root, interrupted, { schemaVersion: 2,
        kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: false,
        question: 'Must not pass an unproven terminal Flow phase', options: [],
        affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] },
        sourceRefs,
      }),
      /FLOW_TRANSACTION_PENDING|FLOW_TRANSACTION_COMPLETION_MISMATCH/,
    );
    assert.deepEqual(await decisionStateSnapshot(repo.root, change.directoryName), before);
  }
});

test('an exact terminal Flow recovery permits ordinary Decision writes but cannot start Decision Reconcile', async () => {
  const repo = await createTestRepository('decision-flow-terminal-modes');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Flow terminal Decision modes', 'complex-domain-feature');
  change.metadata.readiness.research = 'READY';
  change.metadata.readiness.domain = 'READY';
  await saveChange(repo.root, change);
  const flow = (await loadFlowPlan(repo.root, change))!;
  const proposal = changedFlowProposal(change, flow.assessment);
  assert.equal(
    crashFlowAssessmentAtStage(repo.root, change.metadata.id, proposal, 'FLOW_REASSESSED_AUDITED'),
    91,
  );
  const interrupted = await resolveChange(repo.root, change.metadata.id);

  const ordinary = await openDecision(repo.root, interrupted, { schemaVersion: 2,
    kind: 'DELIVERY', owner: 'AGENT', status: 'OPEN', blocking: false,
    question: 'May ordinary terminal recovery state be recorded?', options: [],
    affects: { capabilities: ['ship'], artifacts: ['delivery.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs,
  });
  const ordinaryResolved = await resolveDecision(repo.root, interrupted, ordinary.id, { schemaVersion: 2,
    summary: 'Ordinary same-revision authority is preserved',
    optionId: null,
    authority: 'AGENT_EVIDENCE',
    sourceRefs,
  });
  assert.equal(ordinaryResolved.status, 'RESOLVED');

  const blocking = await openDecision(repo.root, interrupted, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true,
    question: 'Who owns settled domain authority?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs,
  });
  const before = await decisionStateSnapshot(repo.root, change.directoryName);
  await assert.rejects(
    () => resolveDecision(repo.root, interrupted, blocking.id, { schemaVersion: 2,
      summary: 'Must wait for Flow journal completion before Decision Reconcile',
      optionId: null,
      authority: 'HUMAN_CONFIRMED',
      sourceRefs,
    }),
    /FLOW_TRANSACTION_PENDING/,
  );
  assert.deepEqual(await decisionStateSnapshot(repo.root, change.directoryName), before);
  assert.equal(
    before.revisionFiles.some((file) => file.endsWith('.decision-transaction.yaml')),
    false,
  );
});

test('task invalidation is exact across a crash after task save and repeated Decision recovery', async () => {
  const repo = await createTestRepository('decision-task-save-recovery');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Recover exact task invalidation', 'complex-domain-feature');
  const tasksPath = changeArtifactPath(repo.root, change.directoryName, 'tasks.yaml');
  const taskFile = await loadTasks(tasksPath);
  taskFile.tasks = [
    decisionTask('TASK-001', 'Completed affected task', [], 'DONE'),
    decisionTask('TASK-002', 'Running dependent task', ['TASK-001'], 'RUNNING'),
    decisionTask('TASK-003', 'Unrelated completed task', [], 'DONE'),
  ];
  await saveTasks(tasksPath, taskFile);
  change.metadata.readiness.research = 'READY';
  change.metadata.readiness.domain = 'READY';
  await saveChange(repo.root, change);
  const decision = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true,
    question: 'Who owns task invalidation?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: ['TASK-001'], projects: [], contracts: [] },
    sourceRefs,
  });
  const resolution = {
      schemaVersion: 2 as const,
    summary: 'Identity owns the exact invalidation',
    optionId: null,
    authority: 'HUMAN_CONFIRMED' as const,
    sourceRefs,
  };

  assert.equal(
    crashDecisionResolutionAtStage(
      repo.root,
      change.metadata.id,
      decision.id,
      resolution,
      'FLOW_RECONCILE_TASKS_SAVED',
    ),
    91,
  );
  const interrupted = await resolveChange(repo.root, change.metadata.id);
  assert.equal(interrupted.metadata.activeRevision, 'REV-0001');
  assert.deepEqual(
    (await loadTasks(tasksPath)).tasks.map(({ status }) => status),
    ['NEEDS_REVALIDATION', 'INVALIDATED', 'DONE'],
  );

  await resolveDecision(repo.root, interrupted, decision.id, resolution);
  const firstRecovery = await decisionStateSnapshot(repo.root, change.directoryName);
  assert.deepEqual(
    (await loadTasks(tasksPath)).tasks.map(({ status }) => status),
    ['NEEDS_REVALIDATION', 'INVALIDATED', 'DONE'],
  );
  const active = await resolveChange(repo.root, change.metadata.id);
  await resolveDecision(repo.root, active, decision.id, resolution);
  assert.deepEqual(await decisionStateSnapshot(repo.root, change.directoryName), firstRecovery);
});

test('Decision recovery rejects readiness or task inventory changed outside the frozen transaction', async () => {
  for (const mutation of ['readiness', 'task'] as const) {
    const repo = await createTestRepository(`decision-frozen-${mutation}`);
    cleanups.push(repo.cleanup);
    const change = await createChange(repo.root, `Frozen ${mutation} inventory`, 'complex-domain-feature');
    const tasksPath = changeArtifactPath(repo.root, change.directoryName, 'tasks.yaml');
    const taskFile = await loadTasks(tasksPath);
    taskFile.tasks = [decisionTask('TASK-001', 'Frozen affected task', [], 'DONE')];
    await saveTasks(tasksPath, taskFile);
    change.metadata.readiness.research = 'READY';
    change.metadata.readiness.domain = 'READY';
    await saveChange(repo.root, change);
    const decision = await openDecision(repo.root, change, { schemaVersion: 2,
      kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true,
      question: `Who owns frozen ${mutation} state?`, options: [],
      affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: ['TASK-001'], projects: [], contracts: [] },
      sourceRefs,
    });
    const resolution = {
      schemaVersion: 2 as const,
      summary: `Resolve against frozen ${mutation} state`,
      optionId: null,
      authority: 'HUMAN_CONFIRMED' as const,
      sourceRefs,
    };
    assert.equal(
      crashDecisionResolutionAtStage(
        repo.root,
        change.metadata.id,
        decision.id,
        resolution,
        'FLOW_RECONCILE_METADATA_SAVED',
      ),
      91,
    );
    const interrupted = await resolveChange(repo.root, change.metadata.id);
    if (mutation === 'readiness') {
      interrupted.metadata.readiness.domain = 'READY';
      // Simulate out-of-band corruption: the public saveChange API is now correctly
      // fenced while the Decision transaction owns recovery.
      await writeYaml(
        changeMetadataPath(repo.root, change.directoryName),
        interrupted.metadata,
      );
    } else {
      const changedTasks = await loadTasks(tasksPath);
      changedTasks.tasks[0]!.status = 'DONE';
      await saveTasks(tasksPath, changedTasks);
    }
    const before = await decisionStateSnapshot(repo.root, change.directoryName);

    await assert.rejects(
      () => resolveDecision(repo.root, interrupted, decision.id, resolution),
      /DECISION_RECONCILE_TRANSACTION_STATE_CONFLICT/,
    );
    assert.deepEqual(await decisionStateSnapshot(repo.root, change.directoryName), before);
  }
});

test('Decision Reconcile level covers both semantic kind and the earliest affected readiness', async () => {
  const cases: Array<{
    kind: DecisionRecord['kind'];
    capability: Capability;
    expectedLevel: 'L3' | 'L4';
    expectedReadiness: 'research' | 'domain' | 'spec';
    expectedRoute: Capability;
  }> = [
    { kind: 'DOMAIN', capability: 'research', expectedLevel: 'L4', expectedReadiness: 'research', expectedRoute: 'research' },
    { kind: 'SOLUTION', capability: 'spec', expectedLevel: 'L3', expectedReadiness: 'spec', expectedRoute: 'model' },
    { kind: 'SOLUTION', capability: 'model', expectedLevel: 'L3', expectedReadiness: 'domain', expectedRoute: 'model' },
    { kind: 'ARCHITECTURE', capability: 'spec', expectedLevel: 'L3', expectedReadiness: 'spec', expectedRoute: 'model' },
    { kind: 'ARCHITECTURE', capability: 'model', expectedLevel: 'L3', expectedReadiness: 'domain', expectedRoute: 'model' },
  ];
  for (const current of cases) {
    const repo = await createTestRepository(`decision-level-${current.kind.toLowerCase()}-${current.capability}`);
    cleanups.push(repo.cleanup);
    const change = await createChange(repo.root, `Level ${current.kind} ${current.capability}`, 'complex-domain-feature');
    change.metadata.readiness.research = 'READY';
    change.metadata.readiness.domain = 'READY';
    change.metadata.readiness.spec = 'READY';
    await saveChange(repo.root, change);
    const decision = await openDecision(repo.root, change, { schemaVersion: 2,
      kind: current.kind,
      owner: 'AGENT',
      status: 'OPEN',
      blocking: true,
      question: `What changes at ${current.capability}?`,
      options: [],
      affects: {
        capabilities: [current.capability],
        artifacts: [],
        tasks: [],
        projects: [],
        contracts: [],
      },
      sourceRefs,
    });

    await resolveDecision(repo.root, change, decision.id, { schemaVersion: 2,
      summary: `Resolve ${current.kind} at ${current.capability}`,
      optionId: null,
      authority: 'AGENT_EVIDENCE',
      sourceRefs,
    });

    const active = await resolveChange(repo.root, change.metadata.id);
    const revision = await readYaml(
      join(changeRevisionsRoot(repo.root, change.directoryName), 'REV-0002.yaml'),
      revisionSchema,
    );
    assert.equal(revision.level, current.expectedLevel);
    assert.ok(revision.affectedReadiness.includes(current.expectedReadiness));
    assert.notEqual(active.metadata.readiness[current.expectedReadiness], 'READY');
    assert.equal((await resolveRepositoryRoute(repo.root, active)).capability, current.expectedRoute);
  }
});

test('decision owners require their matching authority', async () => {
  const repo = await createTestRepository('decision-owner-authority');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Decision authorities', 'complex-domain-feature');
  const cases = [
    { owner: 'HUMAN' as const, authority: 'HUMAN_CONFIRMED' as const, mismatch: 'AGENT_EVIDENCE' as const },
    { owner: 'AGENT' as const, authority: 'AGENT_EVIDENCE' as const, mismatch: 'EXTERNAL_CONFIRMED' as const },
    { owner: 'EXTERNAL' as const, authority: 'EXTERNAL_CONFIRMED' as const, mismatch: 'HUMAN_CONFIRMED' as const },
  ];
  for (const { owner, authority, mismatch } of cases) {
    const decision = await openDecision(repo.root, change, { schemaVersion: 2,
      kind: 'DOMAIN', owner, status: 'OPEN', blocking: true, question: `Who owns consent for ${owner}?`, options: [],
      affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
    });
    await assert.rejects(() => resolveDecision(repo.root, change, decision.id, { schemaVersion: 2, summary: 'Wrong authority', optionId: null, authority: mismatch, sourceRefs }), /DECISION_AUTHORITY_MISMATCH/);
    assert.equal((await resolveDecision(repo.root, change, decision.id, { schemaVersion: 2, summary: 'Confirmed', optionId: null, authority, sourceRefs })).status, 'RESOLVED');
  }
});

test('decision mutations require source evidence', async () => {
  const repo = await createTestRepository('decision-source-evidence');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Decision evidence', 'complex-domain-feature');
  const isSchemaFailure = (error: unknown): boolean => error instanceof Error && error.name === 'ZodError';
  await assert.rejects(() => openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Who owns consent?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs: [],
  }), isSchemaFailure);
  const decision = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Who owns consent?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
  });
  const replacement = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Who owns consent next?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
  });
  await assert.rejects(() => resolveDecision(repo.root, change, decision.id, { schemaVersion: 2, summary: 'Unproven', optionId: null, authority: 'HUMAN_CONFIRMED', sourceRefs: [] }), isSchemaFailure);
  await assert.rejects(() => supersedeDecision(repo.root, change, decision.id, replacement.id, 'Unproven replacement', []), /DECISION_SOURCE_REFS_REQUIRED/);
});

test('resolved decisions cannot be silently reopened and supersession requires a live replacement', async () => {
  const repo = await createTestRepository('decision-supersession');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Adapter choice', 'architecture-governance');
  const input = { schemaVersion: 2 as const, kind: 'ARCHITECTURE' as const, owner: 'AGENT' as const, status: 'OPEN' as const, blocking: true, question: 'Where is the seam?', options: [], affects: { capabilities: ['design' as const], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] }, sourceRefs };
  const first = await openDecision(repo.root, change, input);
  const replacement = await openDecision(repo.root, change, { ...input, question: 'Which stable interface owns the seam?' });
  await resolveDecision(repo.root, change, first.id, { schemaVersion: 2, summary: 'Use an adapter', optionId: null, authority: 'AGENT_EVIDENCE', sourceRefs });
  await assert.rejects(() => resolveDecision(repo.root, change, first.id, { schemaVersion: 2, summary: 'Change it', optionId: null, authority: 'AGENT_EVIDENCE', sourceRefs }), /DECISION_NOT_OPEN/);
  const superseded = await supersedeDecision(repo.root, change, first.id, replacement.id, 'New architecture evidence', sourceRefs);
  assert.equal(superseded.status, 'SUPERSEDED');
});

test('decision mutations append active-revision audit events', async () => {
  const repo = await createTestRepository('decision-audit');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Consent decision', 'complex-domain-feature');
  await openDecision(repo.root, change, { schemaVersion: 2, kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Who owns consent?', options: [], affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs });
  const events = await readJsonLines<{ event: string; revision: string }>(changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl'));
  assert.equal(events.at(-1)?.event, 'DECISION_OPENED');
  assert.equal(events.at(-1)?.revision, change.metadata.activeRevision);
});

test('resolution preserves creation time, advances update time, and appends its audit event', async () => {
  const repo = await createTestRepository('decision-resolution-audit');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Resolution audit', 'complex-domain-feature');
  const decision = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Who owns consent?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const resolved = await resolveDecision(repo.root, change, decision.id, { schemaVersion: 2, summary: 'User Center', optionId: null, authority: 'HUMAN_CONFIRMED', sourceRefs });
  assert.equal(resolved.createdAt, decision.createdAt);
  assert.ok(Date.parse(resolved.updatedAt) > Date.parse(decision.updatedAt));
  const events = await readJsonLines<{ event: string; revision: string }>(changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl'));
  assert.equal(events.at(-1)?.event, 'DECISION_RESOLVED');
  assert.equal(events.at(-1)?.revision, change.metadata.activeRevision);
});

test('supersession appends its audit event and failed validation appends none', async () => {
  const repo = await createTestRepository('decision-supersession-audit');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Supersession audit', 'architecture-governance');
  const input = {
    kind: 'ARCHITECTURE' as const, owner: 'AGENT' as const, status: 'OPEN' as const, blocking: true, options: [],
    affects: { capabilities: ['design' as const], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
  };
  const decision = await openDecision(repo.root, change, { schemaVersion: 2, ...input, question: 'Where is the seam?' });
  const replacement = await openDecision(repo.root, change, { schemaVersion: 2, ...input, question: 'Which seam replaces it?' });
  const beforeFailure = await readJsonLines(changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl'));
  await assert.rejects(() => resolveDecision(repo.root, change, decision.id, { schemaVersion: 2, summary: 'Wrong authority', optionId: null, authority: 'HUMAN_CONFIRMED', sourceRefs }), /DECISION_AUTHORITY_MISMATCH/);
  assert.equal((await readJsonLines(changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl')).then((events) => events.length)), beforeFailure.length);
  await supersedeDecision(repo.root, change, decision.id, replacement.id, 'New architecture evidence', sourceRefs);
  const events = await readJsonLines<{ event: string; revision: string }>(changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl'));
  assert.equal(events.at(-1)?.event, 'DECISION_SUPERSEDED');
  assert.equal(events.at(-1)?.revision, change.metadata.activeRevision);
});

function decisionTask(
  id: string,
  title: string,
  dependsOn: string[],
  status: TaskStatus,
): Task {
  return taskSchema.parse({
    id,
    title,
    objective: title,
    status,
    dependsOn,
    slice: 'VERTICAL',
    risk: 'MEDIUM',
    files: { create: [], modify: [], tests: [] },
    consumes: [],
    produces: [],
    steps: ['verify'],
    evidenceRequired: ['test'],
    notes: [],
  });
}

function crashDecisionResolutionAtStage(
  repoRoot: string,
  changeId: string,
  decisionId: string,
  resolution: Parameters<typeof resolveDecision>[3],
  stage:
    | 'DECISION_RECONCILE_INTENT_WRITTEN'
    | 'FLOW_RECONCILE_ARCHIVE_ENSURED'
    | 'FLOW_RECONCILE_TASKS_SAVED'
    | 'FLOW_RECONCILE_SIGNAL_WRITTEN'
    | 'FLOW_RECONCILE_REVISION_WRITTEN'
    | 'FLOW_RECONCILE_METADATA_SAVED'
    | 'FLOW_RECONCILE_REBOUND',
): number | null {
  const storeModule = new URL('../src/core/store.js', import.meta.url).href;
  const decisionModule = new URL('../src/core/decisions.js', import.meta.url).href;
  const script = [
    `import { channel } from 'node:diagnostics_channel';`,
    `const mutationChannel = channel('omnai:core:change-mutation');`,
    `mutationChannel.subscribe((message) => {`,
    `  if (message.stage === ${JSON.stringify(stage)} && message.changeId === ${JSON.stringify(changeId)}) process.exit(91);`,
    `});`,
    `const { resolveChange } = await import(${JSON.stringify(storeModule)});`,
    `const { resolveDecision } = await import(${JSON.stringify(decisionModule)});`,
    `const change = await resolveChange(${JSON.stringify(repoRoot)}, ${JSON.stringify(changeId)});`,
    `await resolveDecision(${JSON.stringify(repoRoot)}, change, ${JSON.stringify(decisionId)}, ${JSON.stringify(resolution)});`,
  ].join('\n');
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'pipe'],
  }).status;
}

function changedFlowProposal(
  change: Awaited<ReturnType<typeof resolveChange>>,
  assessment: FlowAssessmentProposal['assessment'],
): FlowAssessmentProposal {
  return {
    schemaVersion: 2,
    changeId: change.metadata.id,
    revision: change.metadata.activeRevision,
    baseline: change.metadata.baseline,
    assessment: {
      ...assessment,
      topology: 'CROSS_MODULE',
      architectureApplicability: 'FOCUSED',
    },
  };
}

function crashFlowAssessmentAtStage(
  repoRoot: string,
  changeId: string,
  proposal: FlowAssessmentProposal,
  stage: 'FLOW_RECONCILE_SIGNAL_WRITTEN' | 'FLOW_REASSESSED_AUDITED',
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

async function decisionStateSnapshot(repoRoot: string, directoryName: string) {
  const decisionsRoot = join(repoRoot, '.omnai', 'changes', directoryName, 'decisions');
  const revisionsRoot = changeRevisionsRoot(repoRoot, directoryName);
  const decisionFiles = (await readdir(decisionsRoot)).sort();
  const revisionFiles = (await readdir(revisionsRoot)).sort();
  return {
    metadata: await readText(changeMetadataPath(repoRoot, directoryName)),
    flow: await readText(join(repoRoot, '.omnai', 'changes', directoryName, 'flow.yaml')),
    tasks: await readText(changeArtifactPath(repoRoot, directoryName, 'tasks.yaml')),
    progress: await readText(changeArtifactPath(repoRoot, directoryName, 'progress.jsonl')),
    decisionFiles,
    decisions: await Promise.all(decisionFiles.map((file) => readText(join(decisionsRoot, file)))),
    revisionFiles,
    revisions: await Promise.all(revisionFiles.map((file) => readText(join(revisionsRoot, file)))),
  };
}
