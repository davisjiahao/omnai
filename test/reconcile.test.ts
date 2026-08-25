import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { join } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { createTestRepository } from './helpers.js';
import { createChange, markReadiness, resolveChange, saveChange } from '../src/core/store.js';
import { loadTasks, saveTasks } from '../src/core/tasks.js';
import { changeArtifactPath, changeRevisionsRoot } from '../src/core/paths.js';
import { reconcileChange } from '../src/core/reconcile.js';
import { pathExists, readJsonLines, readText, readYaml, writeYaml } from '../src/core/files.js';
import { flowPlanSchema, type FlowAssessmentProposal } from '../src/domain/types.js';
import { hashFlowPlan } from '../src/core/flow.js';
import {
  createInitialFlowPlan,
  loadFlowPlan,
  migrateLegacyFlow,
  rebindFlowPlanForRevision,
  synchronizeFlowDecisions,
} from '../src/core/flow-store.js';
import { migrateLegacyFlowWithCurrentDecisions } from '../src/core/flow-migration.js';
import { listDecisions, openDecision, resolveDecision, supersedeDecision } from '../src/core/decisions.js';
import { resolveRepositoryRoute } from '../src/core/router.js';
import { prepareStage } from '../src/core/stages.js';
import { completeStage } from '../src/core/stages.js';
import { mutateImplementationTask } from '../src/core/task-mutations.js';
import { applyFlowAssessment } from '../src/core/flow-assessment.js';
import { createOrdinaryReconcileTransaction } from '../src/core/ordinary-reconcile-transaction.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

test('ordinary Reconcile keeps public entry, orchestration, and recovery dependency direction acyclic', async () => {
  const entry = await readFile(join(process.cwd(), 'src/core/reconcile.ts'), 'utf8');
  const orchestration = await readFile(
    join(process.cwd(), 'src/core/ordinary-reconcile-orchestration.ts'),
    'utf8',
  );
  const recovery = await readFile(join(process.cwd(), 'src/core/ordinary-reconcile-recovery.ts'), 'utf8');
  assert.match(entry, /from '\.\/ordinary-reconcile-orchestration\.js'/);
  assert.match(orchestration, /from '\.\/ordinary-reconcile-recovery\.js'/);
  assert.match(recovery, /import type \{ ReconcileResult \} from '\.\/ordinary-reconcile-orchestration\.js'/);
  assert.doesNotMatch(recovery, /import \{[^}]*\} from '\.\/ordinary-reconcile-orchestration\.js'/s);
  assert.ok(entry.split('\n').length < 40);
});

test('ordinary Reconcile intent owns immutable metadata, Flow, Decision, readiness, and task snapshots', async () => {
  const fixture = await createTestRepository('ordinary-reconcile-snapshot-alias');
  cleanups.push(fixture.cleanup);
  const change = await createChange(fixture.root, 'Freeze every ordinary transaction input', 'small-feature');
  await openDecision(fixture.root, change, { schemaVersion: 2,
    kind: 'ARCHITECTURE',
    owner: 'AGENT',
    status: 'OPEN',
    blocking: false,
    question: 'Which snapshot boundary is durable?',
    options: [],
    affects: { capabilities: ['design'], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs: [{ kind: 'artifact', path: 'design.md', contentHash: `sha256:${'9'.repeat(64)}` }],
  });
  const flow = (await loadFlowPlan(fixture.root, change))!;
  const decisions = await listDecisions(fixture.root, change);
  const tasks = await loadTasks(changeArtifactPath(fixture.root, change.directoryName, 'tasks.yaml'));
  tasks.tasks.push({
    id: 'TASK-001', title: 'Frozen task', objective: 'Prove task snapshot ownership', status: 'DONE', dependsOn: [],
    slice: 'VERTICAL', risk: 'LOW', files: { create: [], modify: [], tests: [] }, consumes: [], produces: [],
    steps: [], evidenceRequired: [], notes: [],
  });
  const affectedReadiness: Array<keyof typeof change.metadata.readiness> = ['implementation'];
  const taskRoots = ['TASK-001'];
  const affectedTasks = ['TASK-001'];
  const request = {
    level: 'L0' as const,
    type: 'IMPLEMENTATION_CHANGED',
    reason: 'Freeze all source values',
    affectedTasks: [...taskRoots],
    affectedTaskClosure: null,
    affectedReadiness: null,
    evidence: [],
    externalCorrelationId: null,
  };
  const transaction = createOrdinaryReconcileTransaction(
    change,
    request,
    { flow, decisions, tasks, affectedReadiness, taskRoots, affectedTasks },
    'ORDINARY-SNAPSHOT-TEST',
    new Date().toISOString(),
  );
  const frozen = structuredClone(transaction);

  change.metadata.scenario = 'migration-program';
  request.reason = 'Mutated request';
  flow.assessment.topology = 'CROSS_MODULE';
  decisions[0]!.question = 'Mutated Decision';
  tasks.tasks[0]!.status = 'RUNNING';
  affectedReadiness.push('review');
  taskRoots.push('TASK-999');
  affectedTasks.push('TASK-999');

  assert.deepEqual(transaction, frozen);
});

test('creates a new revision and baseline while invalidating only the affected task subtree', async () => {
  const fixture = await createTestRepository();
  cleanups.push(fixture.cleanup);
  const created = await createChange(fixture.root, 'Authorization migration', 'complex-domain-feature');
  const tasksPath = changeArtifactPath(fixture.root, created.directoryName, 'tasks.yaml');
  const taskFile = await loadTasks(tasksPath);
  taskFile.tasks = [
    {
      id: 'TASK-001', title: 'Logging', objective: 'Add neutral logging', status: 'DONE', dependsOn: [], slice: 'VERTICAL', risk: 'LOW',
      files: { create: [], modify: [], tests: [] }, consumes: [], produces: [], steps: ['test'], evidenceRequired: ['test'], notes: [],
    },
    {
      id: 'TASK-002', title: 'Authorization schema', objective: 'Create schema', status: 'DONE', dependsOn: [], slice: 'EXPAND', risk: 'HIGH',
      files: { create: [], modify: [], tests: [] }, consumes: [], produces: [], steps: ['test'], evidenceRequired: ['migration'], notes: [],
    },
    {
      id: 'TASK-003', title: 'Repository', objective: 'Use schema', status: 'RUNNING', dependsOn: ['TASK-002'], slice: 'MIGRATE', risk: 'HIGH',
      files: { create: [], modify: [], tests: [] }, consumes: [], produces: [], steps: ['test'], evidenceRequired: ['test'], notes: [],
    },
  ];
  await saveTasks(tasksPath, taskFile);

  const change = await resolveChange(fixture.root, created.metadata.id);
  change.metadata.readiness.domain = 'READY';
  change.metadata.readiness.spec = 'READY';
  change.metadata.readiness.design = 'READY';
  change.metadata.readiness.plan = 'READY';
  change.metadata.readiness.implementation = 'IN_PROGRESS';
  await saveChange(fixture.root, change);

  const result = await reconcileChange(fixture.root, change, {
    level: 'L3',
    type: 'DOMAIN_ASSUMPTION_INVALIDATED',
    reason: 'Authorization mixes durable consent and quote usage',
    affectedTasks: ['TASK-002'],
  });

  assert.equal(result.revision.id, 'REV-0002');
  assert.equal(result.revision.previousBaseline, 'BL-0001');
  assert.equal(result.revision.baseline, 'BL-0002');
  assert.equal(change.metadata.baseline, 'BL-0002');
  assert.deepEqual(result.affectedTasks, ['TASK-002', 'TASK-003']);
  const updated = await loadTasks(tasksPath);
  assert.equal(updated.tasks[0]!.status, 'DONE');
  assert.equal(updated.tasks[1]!.status, 'NEEDS_REVALIDATION');
  assert.equal(updated.tasks[2]!.status, 'INVALIDATED');
  assert.equal(change.metadata.readiness.domain, 'STALE');
  assert.equal(change.metadata.readiness.spec, 'STALE');
  assert.equal(change.metadata.readiness.design, 'INVALIDATED');
  assert.equal(change.metadata.readiness.plan, 'INVALIDATED');
  assert.equal(change.metadata.readiness.review, 'MISSING');
  assert.equal(await pathExists(join(fixture.root, '.omnai/changes', created.directoryName, 'revisions/REV-0002.yaml')), true);
});

test('explicit readiness scope invalidates only the frozen readiness closure', async () => {
  const fixture = await createTestRepository();
  cleanups.push(fixture.cleanup);
  const created = await createChange(fixture.root, 'Authorization migration', 'complex-domain-feature');
  const change = await resolveChange(fixture.root, created.metadata.id);
  for (const key of ['domain', 'spec', 'design', 'plan', 'implementation', 'review', 'verification'] as const) {
    change.metadata.readiness[key] = 'READY';
  }
  await saveChange(fixture.root, change);

  const result = await reconcileChange(fixture.root, change, {
    level: 'L3',
    type: 'DOMAIN_ASSUMPTION_INVALIDATED',
    reason: 'Only consumer specification and design are affected in this repository',
    affectedReadiness: ['spec', 'design'],
  });

  assert.deepEqual(result.affectedReadiness, ['spec', 'design']);
  assert.equal(change.metadata.readiness.domain, 'READY');
  assert.equal(change.metadata.readiness.spec, 'STALE');
  assert.equal(change.metadata.readiness.design, 'INVALIDATED');
  assert.equal(change.metadata.readiness.plan, 'READY');
  assert.equal(change.metadata.readiness.implementation, 'READY');
  assert.equal(change.metadata.readiness.review, 'READY');
  assert.equal(change.metadata.readiness.verification, 'READY');
});

test('persists an external correlation id in reconcile lineage for idempotent recovery', async () => {
  const fixture = await createTestRepository();
  cleanups.push(fixture.cleanup);
  const created = await createChange(fixture.root, 'Authorization migration', 'complex-domain-feature');
  const change = await resolveChange(fixture.root, created.metadata.id);

  const result = await reconcileChange(fixture.root, change, {
    level: 'L3',
    type: 'WORKSET_REENTRY',
    reason: 'WRE-0001 project reconciliation',
    affectedReadiness: ['spec'],
    correlationId: 'WRE-0001/user',
  });

  assert.equal(result.signal.operationRequestId, 'WRE-0001/user');
  assert.equal(result.revision.operationRequestId, 'WRE-0001/user');

  const signalText = await readFile(
    join(changeRevisionsRoot(fixture.root, created.directoryName), `${result.signal.id}.signal.yaml`),
    'utf8',
  );
  const revisionText = await readFile(
    join(changeRevisionsRoot(fixture.root, created.directoryName), `${result.revision.id}.yaml`),
    'utf8',
  );
  const progressText = await readFile(changeArtifactPath(fixture.root, created.directoryName, 'progress.jsonl'), 'utf8');
  assert.match(signalText, /correlationId:\s*WRE-0001\/user/);
  assert.match(revisionText, /correlationId:\s*WRE-0001\/user/);
  assert.match(progressText, /WRE-0001\/user/);
});

test('reconcile lineage attributes only tasks affected by the current operation', async () => {
  const fixture = await createTestRepository();
  cleanups.push(fixture.cleanup);
  const created = await createChange(fixture.root, 'Authorization migration', 'complex-domain-feature');
  const tasksPath = changeArtifactPath(fixture.root, created.directoryName, 'tasks.yaml');
  const taskFile = await loadTasks(tasksPath);
  taskFile.tasks = [
    {
      id: 'TASK-001', title: 'Previously stale', objective: 'Unrelated earlier work', status: 'STALE', dependsOn: [], slice: 'VERTICAL', risk: 'LOW',
      files: { create: [], modify: [], tests: [] }, consumes: [], produces: [], steps: [], evidenceRequired: [], notes: [],
    },
    {
      id: 'TASK-002', title: 'Current scope', objective: 'Current affected task', status: 'DONE', dependsOn: [], slice: 'VERTICAL', risk: 'MEDIUM',
      files: { create: [], modify: [], tests: [] }, consumes: [], produces: [], steps: [], evidenceRequired: [], notes: [],
    },
  ];
  await saveTasks(tasksPath, taskFile);
  const change = await resolveChange(fixture.root, created.metadata.id);

  const result = await reconcileChange(fixture.root, change, {
    level: 'L3',
    type: 'WORKSET_REENTRY',
    reason: 'Only TASK-002 belongs to this frozen application',
    affectedReadiness: ['spec'],
    affectedTasks: ['TASK-002'],
    affectedTaskClosure: ['TASK-002'],
    correlationId: 'WRE-0001/user',
  });

  assert.deepEqual(result.affectedTasks, ['TASK-002']);
  assert.deepEqual(result.revision.affectedTasks, ['TASK-002']);
  const after = await loadTasks(tasksPath);
  assert.equal(after.tasks.find((task) => task.id === 'TASK-001')?.status, 'STALE');
  assert.equal(after.tasks.find((task) => task.id === 'TASK-002')?.status, 'NEEDS_REVALIDATION');
});

test('ordinary Reconcile preserves fresher readiness from a stale same-Revision handle', async () => {
  const fixture = await createTestRepository('reconcile-stale-readiness');
  cleanups.push(fixture.cleanup);
  const created = await createChange(fixture.root, 'Concurrent readiness', 'small-feature');
  const stale = await resolveChange(fixture.root, created.metadata.id);
  const fresh = await resolveChange(fixture.root, created.metadata.id);
  fresh.metadata.readiness.spec = 'READY';
  await saveChange(fixture.root, fresh);

  await reconcileChange(fixture.root, stale, {
    level: 'L0',
    type: 'IMPLEMENTATION_CHANGED',
    reason: 'Implementation changed without affecting the accepted specification',
  });

  const persisted = await resolveChange(fixture.root, created.metadata.id);
  assert.equal(persisted.metadata.readiness.spec, 'READY');
  assert.equal(persisted.metadata.activeRevision, 'REV-0002');
});

test('ordinary Reconcile archives the exact prior FlowPlan before rebinding it', async () => {
  const fixture = await createTestRepository('ordinary-reconcile-flow-lineage');
  cleanups.push(fixture.cleanup);
  const change = await createChange(fixture.root, 'Preserve ordinary Flow lineage', 'complex-domain-feature');
  const prior = (await loadFlowPlan(fixture.root, change))!;

  await reconcileChange(fixture.root, change, {
    level: 'L3',
    type: 'DOMAIN_CHANGED',
    reason: 'Ownership changed',
    affectedReadiness: ['domain'],
  });

  const archived = await readYaml(
    join(changeRevisionsRoot(fixture.root, change.directoryName), 'REV-0001.flow.yaml'),
    flowPlanSchema,
  );
  const rebound = (await loadFlowPlan(fixture.root, change))!;
  assert.equal(hashFlowPlan(archived), hashFlowPlan(prior));
  assert.deepEqual(archived.assessment.sourceRefs, prior.assessment.sourceRefs);
  assert.equal(archived.inputHash, prior.inputHash);
  assert.equal(rebound.revision, 'REV-0002');
  assert.equal(rebound.baseline, 'BL-0002');
});

test('ordinary Reconcile rejects an incompatible archive before creating its durable intent', async () => {
  const fixture = await createTestRepository('ordinary-reconcile-archive-conflict');
  cleanups.push(fixture.cleanup);
  const change = await createChange(fixture.root, 'Reject ordinary archive conflict', 'small-feature');
  const flow = (await loadFlowPlan(fixture.root, change))!;
  const archivePath = join(changeRevisionsRoot(fixture.root, change.directoryName), 'REV-0001.flow.yaml');
  await writeYaml(archivePath, {
    ...flow,
    compiledAt: new Date(Date.parse(flow.compiledAt) + 1_000).toISOString(),
  });
  const before = await ordinaryMutationSnapshot(fixture.root, change.directoryName);

  await assert.rejects(() => reconcileChange(fixture.root, change, {
    level: 'L0', type: 'IMPLEMENTATION_CHANGED', reason: 'Must not overwrite immutable lineage',
  }), /RECONCILE_FLOW_ARCHIVE_MISMATCH/);

  assert.deepEqual(await ordinaryMutationSnapshot(fixture.root, change.directoryName), before);
  assert.equal(
    (await readdir(changeRevisionsRoot(fixture.root, change.directoryName)))
      .some((file) => file.endsWith('.reconcile-transaction.yaml')),
    false,
  );
});

test('ordinary Reconcile rebinds every live Decision before compiling Flow and repository re-entry', async () => {
  const fixture = await createTestRepository('ordinary-reconcile-decision-lineage');
  cleanups.push(fixture.cleanup);
  const change = await createChange(fixture.root, 'Preserve live Decision lineage', 'small-feature');
  const decisionInput = {
    kind: 'ARCHITECTURE' as const,
    owner: 'AGENT' as const,
    status: 'OPEN' as const,
    blocking: false,
    options: [],
    affects: {
      capabilities: ['design' as const],
      artifacts: ['design.md'],
      tasks: [],
      projects: [],
      contracts: [],
    },
    sourceRefs: [{ kind: 'artifact' as const, path: 'design.md', contentHash: `sha256:${'a'.repeat(64)}` }],
  };
  const resolvedLater = await openDecision(fixture.root, change, { schemaVersion: 2,
    ...decisionInput,
    question: 'Which adapter owns the boundary?',
  });
  const supersededLater = await openDecision(fixture.root, change, { schemaVersion: 2,
    ...decisionInput,
    status: 'BLOCKED' as const,
    question: 'Which legacy seam remains supported?',
  });
  const replacement = await openDecision(fixture.root, change, { schemaVersion: 2,
    ...decisionInput,
    question: 'Which replacement seam is executable?',
  });

  await reconcileChange(fixture.root, change, {
    level: 'L0',
    type: 'IMPLEMENTATION_CHANGED',
    reason: 'Implementation sources changed without settling the live design decisions',
  });

  const rebound = await listDecisions(fixture.root, change);
  assert.deepEqual(rebound.map(({ openedRevision }) => openedRevision), ['REV-0002', 'REV-0002', 'REV-0002']);
  const flow = (await loadFlowPlan(fixture.root, change))!;
  assert.equal(flow.revision, 'REV-0002');
  assert.deepEqual(flow.decisionIds, rebound.map(({ id }) => id));
  await resolveRepositoryRoute(fixture.root, change);
  await resolveDecision(fixture.root, change, resolvedLater.id, { schemaVersion: 2,
    summary: 'Use the repository adapter',
    optionId: null,
    authority: 'AGENT_EVIDENCE',
    sourceRefs: decisionInput.sourceRefs,
  });
  await supersedeDecision(
    fixture.root,
    change,
    supersededLater.id,
    replacement.id,
    'The replacement seam is now executable',
    decisionInput.sourceRefs,
  );
  const prepared = await prepareStage(fixture.root, change, 'design', 'Prepare the rebound boundary design.');
  assert.equal(prepared.manifest.revision, 'REV-0002');
});

test('a completed ordinary intent permits audited same-Revision work before a later Reconcile', async () => {
  const fixture = await createTestRepository('ordinary-reconcile-late-state');
  cleanups.push(fixture.cleanup);
  const change = await createChange(fixture.root, 'Continue after ordinary recovery', 'small-feature');
  const decisionInput = {
    kind: 'ARCHITECTURE' as const,
    owner: 'AGENT' as const,
    status: 'OPEN' as const,
    blocking: false,
    options: [],
    affects: { capabilities: ['design' as const], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs: [{ kind: 'artifact' as const, path: 'design.md', contentHash: `sha256:${'c'.repeat(64)}` }],
  };
  await openDecision(fixture.root, change, { schemaVersion: 2, ...decisionInput, question: 'Which original seam is live?' });
  await reconcileChange(fixture.root, change, {
    level: 'L0', type: 'IMPLEMENTATION_CHANGED', reason: 'First bounded ordinary Reconcile',
  });

  await markReadiness(fixture.root, change, 'spec', 'READY');
  await openDecision(fixture.root, change, { schemaVersion: 2, ...decisionInput, question: 'Which late seam is now live?' });
  const currentFlow = (await loadFlowPlan(fixture.root, change))!;
  await applyFlowAssessment(fixture.root, change, {
    schemaVersion: 2,
    changeId: change.metadata.id,
    revision: change.metadata.activeRevision,
    baseline: change.metadata.baseline,
    assessment: {
      ...currentFlow.assessment,
      sourceRefs: [{
        kind: 'artifact',
        path: 'intent.md',
        contentHash: `sha256:${'d'.repeat(64)}`,
      }],
    },
  });
  const second = await reconcileChange(fixture.root, change, {
    level: 'L1', type: 'PLAN_CHANGED', reason: 'Second bounded ordinary Reconcile',
  });

  assert.equal(second.revision.id, 'REV-0003');
  assert.deepEqual(
    (await listDecisions(fixture.root, change)).map(({ openedRevision }) => openedRevision),
    ['REV-0003', 'REV-0003'],
  );
});

test('completed ordinary intent binding and correlated Revision cardinality fail closed before another intent', async () => {
  for (const corruption of ['binding', 'duplicate-revision'] as const) {
    const fixture = await createTestRepository(`ordinary-completed-${corruption}`);
    cleanups.push(fixture.cleanup);
    const change = await createChange(fixture.root, `Reject ${corruption}`, 'small-feature');
    await reconcileChange(fixture.root, change, {
      level: 'L0', type: 'IMPLEMENTATION_CHANGED', reason: `Complete before ${corruption}`,
    });
    const revisionsRoot = changeRevisionsRoot(fixture.root, change.directoryName);
    const transactionPath = join(revisionsRoot, 'REV-0001.reconcile-transaction.yaml');
    const transaction = YAML.parse(await readText(transactionPath)) as Record<string, unknown>;
    if (corruption === 'binding') {
      await writeYaml(transactionPath, { ...transaction, completedRevision: 'REV-9999' });
    } else {
      const revision = YAML.parse(await readText(join(revisionsRoot, 'REV-0002.yaml'))) as Record<string, unknown>;
      await writeYaml(join(revisionsRoot, 'REV-0003.yaml'), { ...revision, id: 'REV-0003' });
    }
    const before = await ordinaryMutationSnapshot(fixture.root, change.directoryName);

    await assert.rejects(() => reconcileChange(fixture.root, change, {
      level: 'L1', type: 'PLAN_CHANGED', reason: `Must not pass ${corruption}`,
    }), /TRANSACTION_LINEAGE_INTEGRITY|ORDINARY_RECONCILE_TRANSACTION_COMPLETION_MISMATCH/);

    assert.deepEqual(await ordinaryMutationSnapshot(fixture.root, change.directoryName), before);
  }
});

test('ordinary Reconcile rejects reuse of historical external correlation before a new intent or archive', async () => {
  const fixture = await createTestRepository('ordinary-correlation-reuse');
  cleanups.push(fixture.cleanup);
  const change = await createChange(fixture.root, 'Reject historical correlation reuse', 'small-feature');
  await reconcileChange(fixture.root, change, {
    level: 'L0',
    type: 'WORKSET_REENTRY',
    reason: 'First correlated application',
    correlationId: 'WRE-0001/user',
  });
  const before = await ordinaryMutationSnapshot(fixture.root, change.directoryName);

  await assert.rejects(() => reconcileChange(fixture.root, change, {
    level: 'L1',
    type: 'WORKSET_REENTRY',
    reason: 'A second application cannot reuse the same correlation',
    correlationId: 'WRE-0001/user',
  }), /ORDINARY_RECONCILE_CORRELATION_CONFLICT/);

  assert.deepEqual(await ordinaryMutationSnapshot(fixture.root, change.directoryName), before);
});

test('ordinary Reconcile writes durable intent before archive and fences every public mutation until exact retry', async () => {
  const fixture = await createTestRepository('ordinary-reconcile-intent-fence');
  cleanups.push(fixture.cleanup);
  const change = await createChange(fixture.root, 'Fence ordinary recovery', 'small-feature');
  const decisionInput = {
    kind: 'ARCHITECTURE' as const,
    owner: 'AGENT' as const,
    status: 'OPEN' as const,
    blocking: false,
    options: [],
    affects: { capabilities: ['design' as const], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs: [{ kind: 'artifact' as const, path: 'design.md', contentHash: `sha256:${'a'.repeat(64)}` }],
  };
  const resolvable = await openDecision(fixture.root, change, { schemaVersion: 2, ...decisionInput, question: 'Which seam is stable?' });
  const supersedable = await openDecision(fixture.root, change, { schemaVersion: 2, ...decisionInput, question: 'Which seam is obsolete?' });
  const replacement = await openDecision(fixture.root, change, { schemaVersion: 2, ...decisionInput, question: 'Which seam replaces it?' });
  const flow = (await loadFlowPlan(fixture.root, change))!;
  const flowProposal: FlowAssessmentProposal = {
    schemaVersion: 2,
    changeId: change.metadata.id,
    revision: change.metadata.activeRevision,
    baseline: change.metadata.baseline,
    assessment: {
      ...flow.assessment,
      topology: 'CROSS_MODULE',
      architectureApplicability: 'FOCUSED',
    },
  };
  const input = {
    level: 'L0' as const,
    type: 'IMPLEMENTATION_CHANGED',
    reason: 'Recover the exact ordinary transaction',
  };

  assert.equal(
    crashOrdinaryReconcileAtStage(fixture.root, change.metadata.id, input, 'ORDINARY_RECONCILE_INTENT_WRITTEN'),
    91,
  );
  const revisionsRoot = changeRevisionsRoot(fixture.root, change.directoryName);
  const files = (await readdir(revisionsRoot)).sort();
  assert.equal(files.includes('REV-0001.reconcile-transaction.yaml'), true);
  assert.equal(files.includes('REV-0001.flow.yaml'), false);
  const interrupted = await resolveChange(fixture.root, change.metadata.id);
  const staleRetry = structuredClone(interrupted);
  const interruptedDecisions = await listDecisions(fixture.root, interrupted);
  const mutations: Array<() => Promise<unknown>> = [
    () => openDecision(fixture.root, interrupted, { schemaVersion: 2, ...decisionInput, question: 'Can another Decision enter?' }),
    () => resolveDecision(fixture.root, interrupted, resolvable.id, { schemaVersion: 2,
      summary: 'Resolve during pending ordinary Reconcile', optionId: null, authority: 'AGENT_EVIDENCE', sourceRefs: decisionInput.sourceRefs,
    }),
    () => supersedeDecision(
      fixture.root,
      interrupted,
      supersedable.id,
      replacement.id,
      'Supersede during pending ordinary Reconcile',
      decisionInput.sourceRefs,
    ),
    () => completeStage(fixture.root, interrupted, 'spec'),
    () => mutateImplementationTask(fixture.root, interrupted, { action: 'START' }),
    () => markReadiness(fixture.root, interrupted, 'spec', 'READY'),
    () => applyFlowAssessment(fixture.root, interrupted, flowProposal),
    () => createInitialFlowPlan(fixture.root, interrupted),
    () => migrateLegacyFlow(fixture.root, interrupted, interruptedDecisions),
    () => migrateLegacyFlowWithCurrentDecisions(fixture.root, interrupted),
    () => synchronizeFlowDecisions(fixture.root, interrupted, interruptedDecisions),
    () => rebindFlowPlanForRevision(fixture.root, interrupted, interruptedDecisions),
    () => resolveRepositoryRoute(fixture.root, interrupted),
  ];
  for (const mutate of mutations) {
    const before = await ordinaryMutationSnapshot(fixture.root, change.directoryName);
    await assert.rejects(mutate, /ORDINARY_RECONCILE_TRANSACTION_PENDING/);
    assert.deepEqual(await ordinaryMutationSnapshot(fixture.root, change.directoryName), before);
  }
  const beforeMismatch = await ordinaryMutationSnapshot(fixture.root, change.directoryName);
  await assert.rejects(
    () => reconcileChange(fixture.root, interrupted, { ...input, reason: 'A different request cannot steal recovery' }),
    /ORDINARY_RECONCILE_TRANSACTION_REQUEST_MISMATCH/,
  );
  assert.deepEqual(await ordinaryMutationSnapshot(fixture.root, change.directoryName), beforeMismatch);

  const recovered = await reconcileChange(fixture.root, interrupted, input);
  assert.equal(recovered.revision.id, 'REV-0002');
  const repeated = await reconcileChange(fixture.root, staleRetry, input);
  assert.equal(repeated.revision.id, 'REV-0002');
  await assertOrdinaryReconcileCardinality(fixture.root, change.directoryName, 3);
});

test('ordinary Reconcile distinguishes a stale-source retry from a fresh active request without external correlation', async () => {
  const fixture = await createTestRepository('ordinary-reconcile-caller-identity');
  cleanups.push(fixture.cleanup);
  const change = await createChange(fixture.root, 'Use caller identity for retry semantics', 'small-feature');
  const staleSource = structuredClone(change);
  const input = {
    level: 'L0' as const,
    type: 'IMPLEMENTATION_CHANGED',
    reason: 'The same content can be a retry or a new command',
  };

  const first = await reconcileChange(fixture.root, change, input);
  const exactRetry = await reconcileChange(fixture.root, staleSource, input);
  const freshActive = await resolveChange(fixture.root, change.metadata.id);
  const nextCommand = await reconcileChange(fixture.root, freshActive, input);

  assert.equal(first.revision.id, 'REV-0002');
  assert.equal(exactRetry.revision.id, 'REV-0002');
  assert.equal(nextCommand.revision.id, 'REV-0003');
});

test('ordinary Reconcile recovers from archive and partial Decision-rebind crash phases exactly once', async () => {
  for (const stage of ['FLOW_RECONCILE_ARCHIVE_ENSURED', 'FLOW_RECONCILE_DECISION_REBOUND'] as const) {
    const fixture = await createTestRepository(`ordinary-reconcile-${stage.toLowerCase()}`);
    cleanups.push(fixture.cleanup);
    const change = await createChange(fixture.root, `Recover ${stage}`, 'small-feature');
    for (const question of ['Which first seam is live?', 'Which second seam is live?']) {
      await openDecision(fixture.root, change, { schemaVersion: 2,
        kind: 'ARCHITECTURE', owner: 'AGENT', status: 'OPEN', blocking: false, question, options: [],
        affects: { capabilities: ['design'], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] },
        sourceRefs: [{ kind: 'artifact', path: 'design.md', contentHash: `sha256:${'b'.repeat(64)}` }],
      });
    }
    const input = { level: 'L0' as const, type: 'IMPLEMENTATION_CHANGED', reason: `Recover ${stage}` };
    assert.equal(crashOrdinaryReconcileAtStage(fixture.root, change.metadata.id, input, stage), 91);
    const interrupted = await resolveChange(fixture.root, change.metadata.id);
    if (stage === 'FLOW_RECONCILE_ARCHIVE_ENSURED') {
      assert.equal(interrupted.metadata.activeRevision, 'REV-0001');
      assert.equal(
        (await readdir(changeRevisionsRoot(fixture.root, change.directoryName)))
          .some((file) => file.endsWith('.signal.yaml')),
        false,
      );
    } else {
      assert.equal(interrupted.metadata.activeRevision, 'REV-0002');
      assert.deepEqual(
        (await listDecisions(fixture.root, interrupted)).map(({ openedRevision }) => openedRevision),
        ['REV-0002', 'REV-0001'],
      );
    }
    await reconcileChange(fixture.root, interrupted, input);
    assert.deepEqual(
      (await listDecisions(fixture.root, interrupted)).map(({ openedRevision }) => openedRevision),
      ['REV-0002', 'REV-0002'],
    );
    await assertOrdinaryReconcileCardinality(fixture.root, change.directoryName, 2);
  }
});

function crashOrdinaryReconcileAtStage(
  repoRoot: string,
  changeId: string,
  input: Parameters<typeof reconcileChange>[2],
  stage: 'ORDINARY_RECONCILE_INTENT_WRITTEN' | 'FLOW_RECONCILE_ARCHIVE_ENSURED' | 'FLOW_RECONCILE_DECISION_REBOUND',
): number | null {
  const storeModule = new URL('../src/core/store.js', import.meta.url).href;
  const reconcileModule = new URL('../src/core/reconcile.js', import.meta.url).href;
  const script = [
    `import { channel } from 'node:diagnostics_channel';`,
    `const mutationChannel = channel('omnai:core:change-mutation');`,
    `mutationChannel.subscribe((message) => {`,
    `  if (message.stage === ${JSON.stringify(stage)} && message.changeId === ${JSON.stringify(changeId)}) process.exit(91);`,
    `});`,
    `const { resolveChange } = await import(${JSON.stringify(storeModule)});`,
    `const { reconcileChange } = await import(${JSON.stringify(reconcileModule)});`,
    `const change = await resolveChange(${JSON.stringify(repoRoot)}, ${JSON.stringify(changeId)});`,
    `await reconcileChange(${JSON.stringify(repoRoot)}, change, ${JSON.stringify(input)});`,
  ].join('\n');
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'pipe'],
  }).status;
}

async function ordinaryMutationSnapshot(repoRoot: string, directoryName: string) {
  const revisionsRoot = changeRevisionsRoot(repoRoot, directoryName);
  const decisionsRoot = join(repoRoot, '.omnai', 'changes', directoryName, 'decisions');
  const revisionFiles = (await readdir(revisionsRoot)).sort();
  const decisionFiles = (await readdir(decisionsRoot)).sort();
  return {
    metadata: await readText(changeArtifactPath(repoRoot, directoryName, 'change.yaml')),
    flow: await readText(changeArtifactPath(repoRoot, directoryName, 'flow.yaml')),
    tasks: await readText(changeArtifactPath(repoRoot, directoryName, 'tasks.yaml')),
    progress: await readText(changeArtifactPath(repoRoot, directoryName, 'progress.jsonl')),
    revisionFiles,
    revisionBytes: await Promise.all(revisionFiles.map((file) => readText(join(revisionsRoot, file)))),
    decisionFiles,
    decisionBytes: await Promise.all(decisionFiles.map((file) => readText(join(decisionsRoot, file)))),
  };
}

async function assertOrdinaryReconcileCardinality(
  repoRoot: string,
  directoryName: string,
  decisionCount: number,
): Promise<void> {
  const revisionsRoot = changeRevisionsRoot(repoRoot, directoryName);
  const files = (await readdir(revisionsRoot)).sort();
  assert.equal(files.filter((file) => /^REV-\d{4}\.yaml$/.test(file)).length, 2);
  assert.equal(files.filter((file) => file.endsWith('.signal.yaml')).length, 1);
  assert.equal(files.filter((file) => file.endsWith('.reconcile-transaction.yaml')).length, 1);
  const transaction = YAML.parse(await readText(
    join(revisionsRoot, 'REV-0001.reconcile-transaction.yaml'),
  )) as { status: string; completedRevision: string };
  assert.equal(transaction.status, 'COMPLETED');
  assert.equal(transaction.completedRevision, 'REV-0002');
  const events = await readJsonLines<{ event?: string }>(changeArtifactPath(repoRoot, directoryName, 'progress.jsonl'));
  assert.equal(events.filter(({ event }) => event === 'RECONCILE_APPLIED').length, 1);
  assert.equal(events.filter(({ event }) => event === 'DECISION_REBOUND').length, decisionCount);
}
