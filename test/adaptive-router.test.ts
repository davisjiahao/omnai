import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { rm, writeFile } from 'node:fs/promises';
import { withChangeMutationLock } from '../src/core/change-mutation-lock.js';
import { listDecisions, openDecision, resolveDecision } from '../src/core/decisions.js';
import { flowInputHash, hashFlowPlan } from '../src/core/flow.js';
import { loadFlowPlan } from '../src/core/flow-store.js';
import { synchronizeFlowDecisionsWithinChangeLock } from '../src/core/flow-store-internal.js';
import {
  createFlowAssessmentTransaction,
  writeFlowAssessmentTransaction,
} from '../src/core/flow-transaction.js';
import { writeYaml } from '../src/core/files.js';
import {
  changeArtifactPath,
  changeDecisionPath,
  changeFlowPath,
} from '../src/core/paths.js';
import { reconcileChange } from '../src/core/reconcile.js';
import { resolveRepositoryFlowSnapshot, resolveRepositoryRoute } from '../src/core/router.js';
import { createChange, saveChange } from '../src/core/store.js';
import { loadTasks, saveTasks } from '../src/core/tasks.js';
import {
  decisionRecordSchema,
  revisionIdSchema,
  sha256Schema,
  taskSchema,
  type DecisionRecord,
  type Task,
  type TaskFile,
} from '../src/domain/types.js';
import { createTestRepository } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const sourceRefs = [{
  kind: 'artifact' as const,
  path: 'domain.md',
  contentHash: `sha256:${'a'.repeat(64)}`,
}];

test('routing rejects a Change whose required final FlowPlan is absent', async () => {
  const repo = await createTestRepository('legacy-route');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Legacy feature', 'small-feature');
  await rm(changeFlowPath(repo.root, change.directoryName));

  await assert.rejects(
    () => resolveRepositoryRoute(repo.root, change),
    /FLOW_PLAN_REQUIRED/,
  );
});

test('a blocking human domain decision composes Grill with its owning capability', async () => {
  const repo = await createTestRepository('grill-route');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Consent ownership', 'complex-domain-feature');
  change.metadata.readiness.research = 'READY';
  await saveChange(repo.root, change);
  const decision = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN',
    owner: 'HUMAN',
    status: 'OPEN',
    blocking: true,
    question: 'Who owns consent?',
    options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs,
  });

  const route = await resolveRepositoryRoute(repo.root, change);

  assert.equal(route.capability, 'model');
  assert.equal(route.blocked, false);
  assert.deepEqual(route.protocolIds, ['interaction.grill', 'repository.model']);
  assert.deepEqual(route.decisionIds, [decision.id]);
});

test('two viable architecture options compose Brainstorm only after upstream blockers resolve', async () => {
  const repo = await createTestRepository('brainstorm-route');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Adapter boundary', 'architecture-governance');
  change.metadata.readiness.research = 'READY';
  change.metadata.readiness.domain = 'READY';
  await saveChange(repo.root, change);
  const viable = (id: string) => ({
    id,
    label: id,
    status: 'VIABLE' as const,
    consequences: [],
    sourceRefs,
  });
  const decision = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'ARCHITECTURE',
    owner: 'AGENT',
    status: 'OPEN',
    blocking: true,
    question: 'Which seam?',
    options: [viable('OPT-01'), viable('OPT-02')],
    affects: { capabilities: ['design'], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs,
  });

  const route = await resolveRepositoryRoute(repo.root, change);

  assert.equal(route.capability, 'design');
  assert.deepEqual(route.protocolIds, ['interaction.brainstorm', 'repository.design']);
  assert.deepEqual(route.decisionIds, [decision.id]);
});

test('an upstream human blocker routes before a downstream brainstorm decision', async () => {
  const repo = await createTestRepository('upstream-before-brainstorm');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Adapter ownership', 'architecture-governance');
  change.metadata.readiness.research = 'READY';
  await saveChange(repo.root, change);
  const upstream = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Who owns the adapter?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
  });
  const viable = (id: string) => ({ id, label: id, status: 'VIABLE' as const, consequences: [], sourceRefs });
  await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'ARCHITECTURE', owner: 'AGENT', status: 'OPEN', blocking: true, question: 'Which seam?',
    options: [viable('OPT-01'), viable('OPT-02')],
    affects: { capabilities: ['design'], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
  });

  const route = await resolveRepositoryRoute(repo.root, change);

  assert.equal(route.capability, 'model');
  assert.deepEqual(route.protocolIds, ['interaction.grill', 'repository.model']);
  assert.deepEqual(route.decisionIds, [upstream.id]);
});

test('Brainstorm waits when an unresolved problem or domain blocker owns the same capability', async () => {
  const repo = await createTestRepository('same-stage-before-brainstorm');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Boundary facts first', 'architecture-governance');
  change.metadata.readiness.research = 'READY';
  change.metadata.readiness.domain = 'READY';
  await saveChange(repo.root, change);
  const facts = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'AGENT', status: 'OPEN', blocking: true, question: 'Which module owns the data?', options: [],
    affects: { capabilities: ['design'], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
  });
  const viable = (id: string) => ({ id, label: id, status: 'VIABLE' as const, consequences: [], sourceRefs });
  await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'ARCHITECTURE', owner: 'AGENT', status: 'OPEN', blocking: true, question: 'Which seam?',
    options: [viable('OPT-01'), viable('OPT-02')],
    affects: { capabilities: ['design'], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
  });

  const route = await resolveRepositoryRoute(repo.root, change);

  assert.equal(route.capability, 'design');
  assert.deepEqual(route.protocolIds, ['repository.design']);
  assert.deepEqual(route.decisionIds, [facts.id]);
});

test('resolving the routed decision returns control to deterministic capability readiness', async () => {
  const repo = await createTestRepository('resolved-route');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Consent ownership', 'complex-domain-feature');
  change.metadata.readiness.research = 'READY';
  await saveChange(repo.root, change);
  const decision = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Who owns consent?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
  });
  await resolveDecision(repo.root, change, decision.id, { schemaVersion: 2,
    summary: 'User Center', optionId: null, authority: 'HUMAN_CONFIRMED', sourceRefs,
  });

  const route = await resolveRepositoryRoute(repo.root, change);

  assert.equal(route.capability, 'model');
  assert.deepEqual(route.protocolIds, ['repository.model']);
  assert.deepEqual(route.decisionIds, []);
});

test('ordinary Reconcile rebinds a blocking OPEN Decision before routing the active Revision', async () => {
  const repo = await createTestRepository('stale-open-decision');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Old unresolved authority', 'complex-domain-feature');
  change.metadata.readiness.research = 'READY';
  await saveChange(repo.root, change);
  const decision = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Who owned this before Reconcile?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
  });
  await reconcileChange(repo.root, change, {
    level: 'L1', type: 'DELIVERY_CHANGED', reason: 'Replan delivery without carrying executable authority forward',
  });

  const route = await resolveRepositoryRoute(repo.root, change);
  const rebound = (await listDecisions(repo.root, change)).find(({ id }) => id === decision.id);

  assert.equal(rebound?.openedRevision, 'REV-0002');
  assert.equal(route.capability, 'model');
  assert.deepEqual(route.protocolIds, ['interaction.grill', 'repository.model']);
  assert.deepEqual(route.decisionIds, [decision.id]);
  assert.equal(route.revision, 'REV-0002');
});

test('ordinary Reconcile rebinds a non-blocking OPEN Decision without making it own the route', async () => {
  const repo = await createTestRepository('stale-non-blocking-open');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Old non-blocking open decision', 'small-feature');
  const decision = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'AGENT', status: 'OPEN', blocking: false, question: 'Which module owns this fact?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
  });
  await reconcileChange(repo.root, change, {
    level: 'L1', type: 'DELIVERY_CHANGED', reason: 'Replan without carrying an executable old Decision forward',
  });

  const route = await resolveRepositoryRoute(repo.root, change);
  const rebound = (await listDecisions(repo.root, change)).find(({ id }) => id === decision.id);

  assert.equal(rebound?.openedRevision, 'REV-0002');
  assert.equal(route.capability, 'research');
  assert.deepEqual(route.protocolIds, ['repository.research']);
  assert.deepEqual(route.decisionIds, []);
  assert.equal(route.revision, 'REV-0002');
});

test('ordinary Reconcile rebinds a non-blocking BLOCKED Decision without routing it as authority', async () => {
  const repo = await createTestRepository('stale-non-blocking-blocked');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Old non-blocking blocked decision', 'small-feature');
  const decision = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'AGENT', status: 'BLOCKED', blocking: false, question: 'Which external fact is missing?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
  });
  await reconcileChange(repo.root, change, {
    level: 'L1', type: 'DELIVERY_CHANGED', reason: 'Replan without carrying an executable old Decision forward',
  });

  const route = await resolveRepositoryRoute(repo.root, change);
  const rebound = (await listDecisions(repo.root, change)).find(({ id }) => id === decision.id);

  assert.equal(rebound?.openedRevision, 'REV-0002');
  assert.equal(route.capability, 'model');
  assert.deepEqual(route.protocolIds, ['repository.model']);
  assert.deepEqual(route.decisionIds, []);
  assert.equal(route.revision, 'REV-0002');
});

test('historical resolved Decisions do not fail active-Revision routing after Reconcile', async () => {
  const repo = await createTestRepository('historical-resolved-decision');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Resolved authority history', 'complex-domain-feature');
  change.metadata.readiness.research = 'READY';
  await saveChange(repo.root, change);
  const decision = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Who owns consent?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
  });
  await resolveDecision(repo.root, change, decision.id, { schemaVersion: 2,
    summary: 'User Center', optionId: null, authority: 'HUMAN_CONFIRMED', sourceRefs,
  });
  await reconcileChange(repo.root, change, {
    level: 'L1', type: 'DELIVERY_CHANGED', reason: 'Replan delivery while retaining resolved authority history',
  });

  const route = await resolveRepositoryRoute(repo.root, change);

  assert.equal(route.capability, 'model');
  assert.deepEqual(route.decisionIds, []);
});

test('a new blocking decision against completed authority routes through Reconcile', async () => {
  const repo = await createTestRepository('decision-reconcile-route');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Changed ownership', 'complex-domain-feature');
  change.metadata.readiness.research = 'READY';
  change.metadata.readiness.domain = 'READY';
  await saveChange(repo.root, change);
  await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Has ownership changed?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
  });

  const route = await resolveRepositoryRoute(repo.root, change);

  assert.equal(route.capability, 'reconcile');
  assert.equal(route.blocked, true);
  assert.deepEqual(route.protocolIds, ['repository.reconcile']);
  assert.deepEqual(route.decisionIds, ['DEC-0001']);
});

test('Change status routes before malformed DecisionRecords are loaded', async () => {
  const repo = await createTestRepository('status-before-decisions');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Reconcile first', 'small-feature');
  change.metadata.status = 'NEEDS_RECONCILE';
  await saveChange(repo.root, change);
  await writeFile(changeDecisionPath(repo.root, change.directoryName, 'DEC-0001'), 'not: a decision\n', 'utf8');

  const route = await resolveRepositoryRoute(repo.root, change);

  assert.equal(route.capability, 'reconcile');
  assert.equal(route.blocked, true);
  assert.deepEqual(route.protocolIds, ['repository.reconcile']);
  assert.deepEqual(route.decisionIds, []);
});

test('an external blocker stops at its repository capability without a conversational overlay', async () => {
  const repo = await createTestRepository('external-route');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'External approval', 'complex-domain-feature');
  change.metadata.readiness.research = 'READY';
  await saveChange(repo.root, change);
  const decision = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'EXTERNAL', owner: 'EXTERNAL', status: 'BLOCKED', blocking: true, question: 'Has Legal approved?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
  });

  const route = await resolveRepositoryRoute(repo.root, change);

  assert.equal(route.capability, 'model');
  assert.equal(route.blocked, true);
  assert.deepEqual(route.protocolIds, ['repository.model']);
  assert.deepEqual(route.decisionIds, [decision.id]);
});

test('an external blocker suppresses Human overlays and is the only route cause in either file order', async () => {
  for (const order of ['HUMAN_FIRST', 'EXTERNAL_FIRST'] as const) {
    const repo = await createTestRepository(`external-priority-${order.toLowerCase()}`);
    cleanups.push(repo.cleanup);
    const change = await createChange(repo.root, `External priority ${order}`, 'complex-domain-feature');
    change.metadata.readiness.research = 'READY';
    await saveChange(repo.root, change);
    const openHuman = () => openDecision(repo.root, change, { schemaVersion: 2,
      kind: 'DOMAIN' as const, owner: 'HUMAN' as const, status: 'OPEN' as const, blocking: true,
      question: 'Which person owns consent?', options: [],
      affects: { capabilities: ['model' as const], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
    });
    const openExternal = () => openDecision(repo.root, change, { schemaVersion: 2,
      kind: 'EXTERNAL' as const, owner: 'EXTERNAL' as const, status: 'BLOCKED' as const, blocking: true,
      question: 'Has the regulator approved?', options: [],
      affects: { capabilities: ['model' as const], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
    });
    let external;
    if (order === 'HUMAN_FIRST') {
      await openHuman();
      external = await openExternal();
    } else {
      external = await openExternal();
      await openHuman();
    }

    const route = await resolveRepositoryRoute(repo.root, change);

    assert.equal(route.capability, 'model', order);
    assert.equal(route.blocked, true, order);
    assert.deepEqual(route.protocolIds, ['repository.model'], order);
    assert.deepEqual(route.decisionIds, [external.id], order);
  }
});

test('an agent fact decision keeps the owning repository capability without an interaction overlay', async () => {
  const repo = await createTestRepository('agent-fact-route');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Ownership evidence', 'complex-domain-feature');
  change.metadata.readiness.research = 'READY';
  await saveChange(repo.root, change);
  const decision = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'AGENT', status: 'OPEN', blocking: true, question: 'Where is ownership enforced?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
  });

  const route = await resolveRepositoryRoute(repo.root, change);

  assert.equal(route.capability, 'model');
  assert.equal(route.blocked, false);
  assert.deepEqual(route.protocolIds, ['repository.model']);
  assert.deepEqual(route.decisionIds, [decision.id]);
});

test('an active capability treats NOT_APPLICABLE readiness as pending', async () => {
  const repo = await createTestRepository('migrated-not-applicable');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Migrated feature', 'small-feature');
  change.metadata.readiness.spec = 'NOT_APPLICABLE';
  await saveChange(repo.root, change);

  const route = await resolveRepositoryRoute(repo.root, change);

  assert.equal(route.capability, 'spec');
  assert.match(route.reason, /not been completed/);
  assert.deepEqual(route.protocolIds, ['repository.spec']);
});

test('work exposes the lowest deterministic frontier Task without changing task state', async () => {
  const repo = await createTestRepository('work-frontier');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Work frontier', 'small-feature');
  change.metadata.readiness.spec = 'READY';
  change.metadata.readiness.design = 'READY';
  change.metadata.readiness.plan = 'READY';
  await saveChange(repo.root, change);
  const taskFile: TaskFile = {
    schemaVersion: 1,
    revision: change.metadata.activeRevision,
    generatedFrom: ['spec@1'],
    tasks: [task('TASK-002'), task('TASK-001')],
  };
  const tasksPath = changeArtifactPath(repo.root, change.directoryName, 'tasks.yaml');
  await saveTasks(tasksPath, taskFile);
  const before = await loadTasks(tasksPath);

  const route = await resolveRepositoryRoute(repo.root, change);

  assert.equal(route.capability, 'work');
  assert.equal(route.taskId, 'TASK-001');
  assert.deepEqual(await loadTasks(tasksPath), before);
});

test('adaptive routes return the validated Flow hash and reject stale Flow identity', async () => {
  const repo = await createTestRepository('flow-identity');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Flow identity', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const route = await resolveRepositoryRoute(repo.root, change);
  assert.equal(route.flowHash, hashFlowPlan(flow));
  assert.equal('legacy' in route, false);

  const stale = { ...flow, revision: revisionIdSchema.parse('REV-9999') };
  stale.inputHash = sha256Schema.parse(flowInputHash(stale));
  await writeYaml(changeFlowPath(repo.root, change.directoryName), stale);

  await assert.rejects(
    () => resolveRepositoryRoute(repo.root, change),
    /FLOW_STALE_REVISION/,
  );
});

test('routing fails closed while a Flow assessment transaction is PENDING', async () => {
  const repo = await createTestRepository('pending-flow-route');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Pending flow route', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const transaction = createFlowAssessmentTransaction(
    {
      schemaVersion: 2,
      changeId: change.metadata.id,
      revision: change.metadata.activeRevision,
      baseline: change.metadata.baseline,
      assessment: flow.assessment,
    },
    flow,
    await listDecisions(repo.root, change),
    'flow-route-pending',
    new Date().toISOString(),
  );
  await writeFlowAssessmentTransaction(repo.root, change, transaction);

  await assert.rejects(
    () => resolveRepositoryRoute(repo.root, change),
    /FLOW_TRANSACTION_PENDING: flow-route-pending/,
  );
});

test('routing waits for the Change mutation lock and never observes an intermediate Decision state', async () => {
  const repo = await createTestRepository('route-snapshot-lock');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Consistent decision snapshot', 'complex-domain-feature');
  change.metadata.readiness.research = 'READY';
  await saveChange(repo.root, change);
  const human = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Who owns consent?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] }, sourceRefs,
  });
  let signalMutationStarted: (() => void) | undefined;
  const mutationStarted = new Promise<void>((resolve) => { signalMutationStarted = resolve; });
  let releaseMutation: (() => void) | undefined;
  const mutationReleased = new Promise<void>((resolve) => { releaseMutation = resolve; });
  const mutation = withChangeMutationLock(repo.root, change, async () => {
    await writeYaml(changeDecisionPath(repo.root, change.directoryName, human.id), {
      ...human,
      kind: 'EXTERNAL',
      owner: 'EXTERNAL',
      status: 'BLOCKED',
      question: 'Intermediate uncommitted authority',
    });
    signalMutationStarted?.();
    await mutationReleased;
    await writeYaml(changeDecisionPath(repo.root, change.directoryName, human.id), human);
  });
  await mutationStarted;

  const routePromise = resolveRepositoryRoute(repo.root, change);
  const earlyState = await Promise.race([
    routePromise.then(() => 'SETTLED', () => 'SETTLED'),
    delay(500).then(() => 'WAITING'),
  ]);
  releaseMutation?.();
  await mutation;
  const route = await routePromise;

  assert.equal(earlyState, 'WAITING');
  assert.equal(route.blocked, false);
  assert.deepEqual(route.protocolIds, ['interaction.grill', 'repository.model']);
  assert.deepEqual(route.decisionIds, [human.id]);
});

test('Flow status snapshot returns one lock-consistent Flow and route after an interleaved Decision update', async () => {
  const repo = await createTestRepository('flow-route-snapshot');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Atomic Flow status', 'complex-domain-feature');
  change.metadata.readiness.research = 'READY';
  await saveChange(repo.root, change);
  const now = new Date().toISOString();
  const decision: DecisionRecord = decisionRecordSchema.parse({
    schemaVersion: 2,
    id: 'DEC-0001',
    changeId: change.metadata.id,
    openedRevision: change.metadata.activeRevision,
    resolvedRevision: null,
    kind: 'DOMAIN',
    owner: 'HUMAN',
    status: 'OPEN',
    blocking: true,
    question: 'Who owns the atomic snapshot?',
    options: [],
    resolution: null,
    supersededBy: null,
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs,
    createdAt: now,
    updatedAt: now,
  });
  let signalIntermediateState: (() => void) | undefined;
  const intermediateState = new Promise<void>((resolve) => { signalIntermediateState = resolve; });
  let releaseMutation: (() => void) | undefined;
  const mutationReleased = new Promise<void>((resolve) => { releaseMutation = resolve; });
  const mutation = withChangeMutationLock(repo.root, change, async () => {
    await writeYaml(changeDecisionPath(repo.root, change.directoryName, decision.id), decision);
    signalIntermediateState?.();
    await mutationReleased;
    await synchronizeFlowDecisionsWithinChangeLock(repo.root, change, [decision]);
  });
  await intermediateState;

  const snapshotPromise = resolveRepositoryFlowSnapshot(repo.root, change);
  const earlyState = await Promise.race([
    snapshotPromise.then(() => 'SETTLED', () => 'SETTLED'),
    delay(500).then(() => 'WAITING'),
  ]);
  releaseMutation?.();
  await mutation;
  const snapshot = await snapshotPromise;

  assert.equal(earlyState, 'WAITING');
  assert.deepEqual(snapshot.flow.decisionIds, ['DEC-0001']);
  assert.equal(snapshot.route.flowHash, hashFlowPlan(snapshot.flow));
  assert.deepEqual(snapshot.route.protocolIds, ['interaction.grill', 'repository.model']);
  assert.deepEqual(snapshot.route.decisionIds, ['DEC-0001']);
});

function task(id: string): Task {
  return taskSchema.parse({
    id,
    title: id,
    objective: `Deliver ${id}`,
    status: 'PENDING',
    dependsOn: [],
    slice: 'VERTICAL',
    risk: 'MEDIUM',
    files: { create: [], modify: [], tests: [] },
    consumes: [],
    produces: [],
    steps: ['Implement the slice'],
    evidenceRequired: ['test'],
    notes: [],
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
