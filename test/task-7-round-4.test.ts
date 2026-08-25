import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTestRepository } from './helpers.js';
import { appendJsonLine, readJsonLines, readText, readYaml, writeYaml } from '../src/core/files.js';
import { changeArtifactPath, changeDecisionPath, changeRevisionsRoot } from '../src/core/paths.js';
import { archiveChange, createChange, resolveChange, saveChange } from '../src/core/store.js';
import { reconcileChange } from '../src/core/reconcile.js';
import { loadTasks, saveTasks } from '../src/core/tasks.js';
import { listDecisions, openDecision, resolveDecision } from '../src/core/decisions.js';
import {
  loadFlowPlan,
  rebindFlowPlanForRevision,
  synchronizeFlowDecisions,
} from '../src/core/flow-store.js';
import { reconcileSignalSchema, revisionSchema, type DecisionRecord, type FlowAssessmentProposal } from '../src/domain/types.js';
import { ordinaryReconcileTransactionSchema } from '../src/core/ordinary-reconcile-transaction.js';
import { flowAssessmentTransactionSchema } from '../src/core/flow-transaction.js';
import { decisionReconcileTransactionSchema } from '../src/core/decision-reconcile-transaction.js';
import { applyFlowAssessment } from '../src/core/flow-assessment.js';
import { hashDecisionRecord } from '../src/core/decision-transition.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length > 0) await cleanups.pop()?.(); });

test('public saveChange and real archive --force are fenced by an ordinary transaction', async () => {
  const repo = await createTestRepository('round4-save-archive-fence');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Fence public metadata mutations', 'small-feature');
  const request = {
    level: 'L0' as const,
    type: 'IMPLEMENTATION_CHANGED',
    reason: 'Crash after the durable ordinary intent',
  };
  assert.equal(crashOrdinaryReconcileAtIntent(repo.root, change.metadata.id, request), 91);
  const interrupted = await resolveChange(repo.root, change.metadata.id);
  const before = await durableChangeSnapshot(repo.root, change.directoryName);

  interrupted.metadata.status = 'ARCHIVED';
  await assert.rejects(
    () => saveChange(repo.root, interrupted),
    /ORDINARY_RECONCILE_TRANSACTION_PENDING/,
  );
  assert.deepEqual(await durableChangeSnapshot(repo.root, change.directoryName), before);

  const archived = spawnSync(
    process.execPath,
    [join(process.cwd(), 'dist/src/main.js'), 'archive', '--force'],
    { cwd: repo.root, encoding: 'utf8' },
  );
  assert.notEqual(archived.status, 0, archived.stdout);
  assert.match(archived.stderr, /ORDINARY_RECONCILE_TRANSACTION_PENDING/);
  assert.deepEqual(await durableChangeSnapshot(repo.root, change.directoryName), before);

  await reconcileChange(repo.root, interrupted, request);
});

test('package archiveChange owns status and exactly one CHANGE_ARCHIVED audit', async () => {
  const repo = await createTestRepository('round4-archive-api');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Archive atomically', 'small-feature');
  const packageApi = await import('../src/index.js') as typeof import('../src/index.js') & {
    archiveChange?: (repoRoot: string, changeRef: typeof change) => Promise<void>;
  };
  assert.equal(typeof packageApi.archiveChange, 'function');

  await packageApi.archiveChange!(repo.root, change);
  await packageApi.archiveChange!(repo.root, change);
  const persisted = await resolveChange(repo.root, change.metadata.id);
  const events = await readJsonLines<{ event?: string }>(
    changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl'),
  );
  assert.equal(persisted.metadata.status, 'ARCHIVED');
  assert.equal(events.filter(({ event }) => event === 'CHANGE_ARCHIVED').length, 1);
});

test('public saveChange rejects a stale same-Revision metadata handle', async () => {
  const repo = await createTestRepository('round4-save-cas');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'CAS public metadata', 'small-feature');
  const stale = await resolveChange(repo.root, change.metadata.id);
  const fresh = await resolveChange(repo.root, change.metadata.id);
  fresh.metadata.readiness.spec = 'READY';
  await saveChange(repo.root, fresh);
  const before = await durableChangeSnapshot(repo.root, change.directoryName);

  stale.metadata.status = 'READY_TO_ARCHIVE';
  await assert.rejects(() => saveChange(repo.root, stale), /CHANGE_METADATA_CAS_MISMATCH/);
  assert.deepEqual(await durableChangeSnapshot(repo.root, change.directoryName), before);
});

test('explicit task closures are canonical before any ordinary intent or archive write', async (t) => {
  const cases = [
    { name: 'unknown root', roots: ['TASK-999'], closure: ['TASK-999'] },
    { name: 'missing root', roots: ['TASK-001'], closure: ['TASK-002'] },
    { name: 'missing dependent', roots: ['TASK-001'], closure: ['TASK-001'] },
    { name: 'extra unrelated task', roots: ['TASK-001'], closure: ['TASK-001', 'TASK-002', 'TASK-003'] },
    { name: 'non-canonical order', roots: ['TASK-001'], closure: ['TASK-002', 'TASK-001'] },
    { name: 'non-canonical root order', roots: ['TASK-002', 'TASK-001'], closure: ['TASK-001', 'TASK-002'] },
    { name: 'duplicate closure member', roots: ['TASK-001'], closure: ['TASK-001', 'TASK-002', 'TASK-002'] },
  ];
  for (const current of cases) {
    await t.test(current.name, async () => {
      const repo = await createTestRepository(`round4-closure-${current.name.replaceAll(' ', '-')}`);
      cleanups.push(repo.cleanup);
      const change = await createChange(repo.root, `Reject ${current.name}`, 'small-feature');
      const tasksPath = changeArtifactPath(repo.root, change.directoryName, 'tasks.yaml');
      const tasks = await loadTasks(tasksPath);
      tasks.tasks = [
        task('TASK-001', []),
        task('TASK-002', ['TASK-001']),
        task('TASK-003', []),
      ];
      await saveTasks(tasksPath, tasks);
      const before = await durableChangeSnapshot(repo.root, change.directoryName);

      await assert.rejects(() => reconcileChange(repo.root, change, {
        level: 'L0',
        type: 'WORKSET_REENTRY',
        reason: `Reject ${current.name}`,
        affectedTasks: current.roots,
        affectedTaskClosure: current.closure,
        correlationId: `WRE-0001/${current.name.replaceAll(' ', '-')}`,
      }), /RECONCILE_TASK_CLOSURE_INVALID/);
      assert.deepEqual(await durableChangeSnapshot(repo.root, change.directoryName), before);
    });
  }
});

test('package Flow wrappers reject all three owning transaction fences with zero side effects', async (t) => {
  const kinds = ['flow', 'decision', 'ordinary'] as const;
  for (const kind of kinds) {
    await t.test(kind, async () => {
      const repo = await createTestRepository(`round4-flow-wrapper-${kind}`);
      cleanups.push(repo.cleanup);
      const change = await createChange(repo.root, `Fence Flow wrapper during ${kind}`, 'small-feature');
      if (kind === 'flow') {
        const flow = (await loadFlowPlan(repo.root, change))!;
        const proposal = changedTopologyProposal(change, flow.assessment);
        assert.equal(crashFlowAssessmentAtIntent(repo.root, change.metadata.id, proposal), 91);
      } else if (kind === 'decision') {
        change.metadata.readiness.design = 'READY';
        await saveChange(repo.root, change);
        const decision = await openDecision(repo.root, change, { schemaVersion: 2,
          kind: 'ARCHITECTURE', owner: 'AGENT', status: 'OPEN', blocking: true,
          question: 'Which settled seam changes?', options: [],
          affects: { capabilities: ['design'], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] },
          sourceRefs: [{ kind: 'artifact', path: 'design.md', contentHash: `sha256:${'a'.repeat(64)}` }],
        });
        assert.equal(crashDecisionReconcileAtIntent(repo.root, change.metadata.id, decision.id), 91);
      } else {
        assert.equal(crashOrdinaryReconcileAtIntent(repo.root, change.metadata.id, {
          level: 'L0', type: 'IMPLEMENTATION_CHANGED', reason: 'Pending ordinary wrapper fence',
        }), 91);
      }
      const interrupted = await resolveChange(repo.root, change.metadata.id);
      const decisions = await listDecisions(repo.root, interrupted);
      for (const wrapper of [synchronizeFlowDecisions, rebindFlowPlanForRevision]) {
        const before = await durableChangeSnapshot(repo.root, change.directoryName);
        await assert.rejects(
          () => wrapper(repo.root, interrupted, decisions),
          /(?:FLOW|DECISION_RECONCILE|ORDINARY_RECONCILE)_TRANSACTION_PENDING/,
        );
        assert.deepEqual(await durableChangeSnapshot(repo.root, change.directoryName), before);
      }
    });
  }
});

test('package Flow wrappers reject a caller-stale Decision inventory without writes', async (t) => {
  for (const wrapper of [synchronizeFlowDecisions, rebindFlowPlanForRevision]) {
    await t.test(wrapper.name, async () => {
      const repo = await createTestRepository(`round4-${wrapper.name}`);
      cleanups.push(repo.cleanup);
      const change = await createChange(repo.root, `Reject stale inventory in ${wrapper.name}`, 'small-feature');
      await openDecision(repo.root, change, { schemaVersion: 2,
        kind: 'DOMAIN', owner: 'AGENT', status: 'OPEN', blocking: false,
        question: 'Which domain owns the boundary?', options: [],
        affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] },
        sourceRefs: [{ kind: 'artifact', path: 'domain.md', contentHash: `sha256:${'b'.repeat(64)}` }],
      });
      const before = await durableChangeSnapshot(repo.root, change.directoryName);

      await assert.rejects(() => wrapper(repo.root, change, []), /FLOW_STALE_DECISION_STATE/);
      assert.deepEqual(await durableChangeSnapshot(repo.root, change.directoryName), before);
    });
  }
});

test('runtime and declaration package surfaces expose only guarded Flow and metadata mutations', async () => {
  const packageApi = await import('../src/index.js') as Record<string, unknown>;
  for (const guarded of [
    'saveChange', 'archiveChange', 'synchronizeFlowDecisions', 'rebindFlowPlanForRevision',
  ]) assert.equal(typeof packageApi[guarded], 'function');
  for (const lower of [
    'persistChangeMetadataWithinChangeLock',
    'synchronizeFlowDecisionsWithinChangeLock',
    'rebindPreflightedFlowPlanForRevisionWithinChangeLock',
    'loadFlowPlanForTransactionRecoveryWithinChangeLock',
  ]) assert.equal(lower in packageApi, false);

  const indexDeclaration = await readText(join(process.cwd(), 'dist', 'src', 'index.d.ts'));
  const storeDeclaration = await readText(join(process.cwd(), 'dist', 'src', 'core', 'store.d.ts'));
  const flowDeclaration = await readText(join(process.cwd(), 'dist', 'src', 'core', 'flow-store.d.ts'));
  assert.doesNotMatch(indexDeclaration, /WithinChangeLock|persistChangeMetadata/);
  assert.doesNotMatch(storeDeclaration, /WithinChangeLock|persistChangeMetadata/);
  assert.doesNotMatch(flowDeclaration, /WithinChangeLock|Internal/);
});

test('ordinary Reconcile rejects callers made stale by Flow or Decision Reconcile', async (t) => {
  for (const kind of ['flow', 'decision'] as const) {
    await t.test(kind, async () => {
      const repo = await createTestRepository(`round4-stale-after-${kind}`);
      cleanups.push(repo.cleanup);
      const change = await createChange(repo.root, `Reject stale caller after ${kind}`, 'small-feature');
      if (kind === 'flow') {
        const stale = await resolveChange(repo.root, change.metadata.id);
        const flow = (await loadFlowPlan(repo.root, change))!;
        const proposal = changedTopologyProposal(change, flow.assessment);
        await import('../src/core/flow-assessment.js').then(({ applyFlowAssessment }) => (
          applyFlowAssessment(repo.root, change, proposal)
        ));
        const before = await durableChangeSnapshot(repo.root, change.directoryName);
        await assert.rejects(() => reconcileChange(repo.root, stale, {
          level: 'L0', type: 'IMPLEMENTATION_CHANGED', reason: 'Stale after Flow Reconcile',
        }), /RECONCILE_STALE_CHANGE_STATE/);
        assert.deepEqual(await durableChangeSnapshot(repo.root, change.directoryName), before);
      } else {
        change.metadata.readiness.design = 'READY';
        await saveChange(repo.root, change);
        const decision = await openDecision(repo.root, change, { schemaVersion: 2,
          kind: 'ARCHITECTURE', owner: 'AGENT', status: 'OPEN', blocking: true,
          question: 'Which settled seam changes?', options: [],
          affects: { capabilities: ['design'], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] },
          sourceRefs: [{ kind: 'artifact', path: 'design.md', contentHash: `sha256:${'c'.repeat(64)}` }],
        });
        const stale = await resolveChange(repo.root, change.metadata.id);
        await resolveDecision(repo.root, change, decision.id, { schemaVersion: 2,
          summary: 'Use the adapter boundary', optionId: null, authority: 'AGENT_EVIDENCE',
          sourceRefs: [{ kind: 'artifact', path: 'design.md', contentHash: `sha256:${'c'.repeat(64)}` }],
        });
        const before = await durableChangeSnapshot(repo.root, change.directoryName);
        await assert.rejects(() => reconcileChange(repo.root, stale, {
          level: 'L0', type: 'IMPLEMENTATION_CHANGED', reason: 'Stale after Decision Reconcile',
        }), /RECONCILE_STALE_CHANGE_STATE/);
        assert.deepEqual(await durableChangeSnapshot(repo.root, change.directoryName), before);
      }
    });
  }
});

test('ordinary intent createdAt deterministically binds recovery artifacts and Flow rebind', async () => {
  const repo = await createTestRepository('round4-ordinary-created-at');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Freeze ordinary transaction time', 'small-feature');
  const request = {
    level: 'L0' as const,
    type: 'IMPLEMENTATION_CHANGED',
    reason: 'Recover later without taking a new clock value',
  };
  assert.equal(crashOrdinaryReconcileAtIntent(repo.root, change.metadata.id, request), 91);
  const transaction = await readYaml(
    join(changeRevisionsRoot(repo.root, change.directoryName), 'REV-0001.reconcile-transaction.yaml'),
    ordinaryReconcileTransactionSchema,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  const interrupted = await resolveChange(repo.root, change.metadata.id);
  const result = await reconcileChange(repo.root, interrupted, request);
  const signal = await readYaml(
    join(changeRevisionsRoot(repo.root, change.directoryName), `${result.signal.id}.signal.yaml`),
    reconcileSignalSchema,
  );
  const revision = await readYaml(
    join(changeRevisionsRoot(repo.root, change.directoryName), `${result.revision.id}.yaml`),
    revisionSchema,
  );
  const flow = (await loadFlowPlan(repo.root, interrupted))!;
  const reconcileEvents = (await readJsonLines<{
    timestamp?: string; event?: string; data?: { correlationId?: string };
  }>(changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl'))).filter((event) => (
    event.event === 'RECONCILE_APPLIED' && event.data?.correlationId === transaction.correlationId
  ));

  assert.equal(signal.createdAt, transaction.createdAt);
  assert.equal(revision.createdAt, transaction.createdAt);
  assert.equal(flow.compiledAt, transaction.createdAt);
  assert.equal(reconcileEvents.length, 1);
  assert.equal(reconcileEvents[0]?.timestamp, transaction.createdAt);
});

test('completed Flow journal corruption blocks an unrelated Decision mutation without writes', async () => {
  const repo = await createTestRepository('round4-completed-flow-integrity');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Validate completed Flow lineage', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  await applyFlowAssessment(repo.root, change, changedTopologyProposal(change, flow.assessment));
  const transactionPath = join(
    changeRevisionsRoot(repo.root, change.directoryName),
    'REV-0001.flow-transaction.yaml',
  );
  const transaction = await readYaml(transactionPath, flowAssessmentTransactionSchema);
  await writeYaml(transactionPath, { ...transaction, newPlanHash: `sha256:${'0'.repeat(64)}` });
  const before = await durableChangeSnapshot(repo.root, change.directoryName);

  await assert.rejects(() => openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'AGENT', status: 'OPEN', blocking: false,
    question: 'This unrelated mutation must not pass corrupt lineage', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs: [{ kind: 'artifact', path: 'domain.md', contentHash: `sha256:${'d'.repeat(64)}` }],
  }), /TRANSACTION_LINEAGE_INTEGRITY/);
  assert.deepEqual(await durableChangeSnapshot(repo.root, change.directoryName), before);
});

test('completed Decision journal corruption blocks an unrelated Flow wrapper without writes', async () => {
  const repo = await createTestRepository('round4-completed-decision-integrity');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Validate completed Decision lineage', 'small-feature');
  change.metadata.readiness.design = 'READY';
  await saveChange(repo.root, change);
  const decision = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'ARCHITECTURE', owner: 'AGENT', status: 'OPEN', blocking: true,
    question: 'Which settled seam changes?', options: [],
    affects: { capabilities: ['design'], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs: [{ kind: 'artifact', path: 'design.md', contentHash: `sha256:${'e'.repeat(64)}` }],
  });
  await resolveDecision(repo.root, change, decision.id, { schemaVersion: 2,
    summary: 'Use the adapter', optionId: null, authority: 'AGENT_EVIDENCE',
    sourceRefs: [{ kind: 'artifact', path: 'design.md', contentHash: `sha256:${'e'.repeat(64)}` }],
  });
  const transactionPath = join(
    changeRevisionsRoot(repo.root, change.directoryName),
    `REV-0001.${decision.id}.decision-transaction.yaml`,
  );
  const transaction = await readYaml(transactionPath, decisionReconcileTransactionSchema);
  await writeYaml(transactionPath, { ...transaction, resolvedBaseline: 'BL-9999' });
  const before = await durableChangeSnapshot(repo.root, change.directoryName);
  const decisions = await listDecisions(repo.root, change);

  await assert.rejects(
    () => synchronizeFlowDecisions(repo.root, change, decisions),
    /TRANSACTION_LINEAGE_INTEGRITY/,
  );
  assert.deepEqual(await durableChangeSnapshot(repo.root, change.directoryName), before);
});

test('completed Decision audit target hash corruption blocks an unrelated Flow wrapper without writes', async () => {
  const repo = await createTestRepository('round4-completed-decision-audit-hash');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Validate completed Decision target hash', 'small-feature');
  change.metadata.readiness.design = 'READY';
  await saveChange(repo.root, change);
  const decision = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'ARCHITECTURE', owner: 'AGENT', status: 'OPEN', blocking: true,
    question: 'Which completed transition target is authoritative?', options: [],
    affects: { capabilities: ['design'], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs: [{ kind: 'artifact', path: 'design.md', contentHash: `sha256:${'e'.repeat(64)}` }],
  });
  await resolveDecision(repo.root, change, decision.id, { schemaVersion: 2,
    summary: 'Use the adapter', optionId: null, authority: 'AGENT_EVIDENCE',
    sourceRefs: [{ kind: 'artifact', path: 'design.md', contentHash: `sha256:${'e'.repeat(64)}` }],
  });
  const progressPath = changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl');
  const events = await readJsonLines<{
    event?: string; data?: Record<string, unknown>;
  }>(progressPath);
  const corrupted = events.map((event) => (
    event.event === 'DECISION_RESOLVED' && event.data?.decisionId === decision.id
      ? { ...event, data: { ...event.data, afterHash: `sha256:${'0'.repeat(64)}` } }
      : event
  ));
  await writeFile(progressPath, `${corrupted.map((event) => JSON.stringify(event)).join('\n')}\n`);
  const before = await durableChangeSnapshot(repo.root, change.directoryName);
  const decisions = await listDecisions(repo.root, change);

  await assert.rejects(
    () => synchronizeFlowDecisions(repo.root, change, decisions),
    /TRANSACTION_LINEAGE_INTEGRITY/,
  );
  assert.deepEqual(await durableChangeSnapshot(repo.root, change.directoryName), before);
});

test('completed ordinary journal corruption blocks archive without writes', async () => {
  const repo = await createTestRepository('round4-completed-ordinary-integrity');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Validate completed ordinary lineage', 'small-feature');
  await reconcileChange(repo.root, change, {
    level: 'L0', type: 'IMPLEMENTATION_CHANGED', reason: 'Create completed ordinary lineage',
  });
  const transactionPath = join(
    changeRevisionsRoot(repo.root, change.directoryName),
    'REV-0001.reconcile-transaction.yaml',
  );
  const transaction = await readYaml(transactionPath, ordinaryReconcileTransactionSchema);
  await writeYaml(transactionPath, { ...transaction, correlationId: 'ORDINARY-CORRUPTED' });
  const before = await durableChangeSnapshot(repo.root, change.directoryName);

  await assert.rejects(() => archiveChange(repo.root, change), /TRANSACTION_LINEAGE_INTEGRITY/);
  assert.deepEqual(await durableChangeSnapshot(repo.root, change.directoryName), before);
});

test('a malformed ordinary journal filename blocks archive without writes', async () => {
  const repo = await createTestRepository('round4-ordinary-filename-integrity');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Validate ordinary journal filenames', 'small-feature');
  await reconcileChange(repo.root, change, {
    level: 'L0', type: 'IMPLEMENTATION_CHANGED', reason: 'Create completed ordinary lineage',
  });
  const revisionsRoot = changeRevisionsRoot(repo.root, change.directoryName);
  await rename(
    join(revisionsRoot, 'REV-0001.reconcile-transaction.yaml'),
    join(revisionsRoot, 'corrupted.reconcile-transaction.yaml'),
  );
  const before = await durableChangeSnapshot(repo.root, change.directoryName);

  await assert.rejects(() => archiveChange(repo.root, change), /TRANSACTION_LINEAGE_INTEGRITY/);
  assert.deepEqual(await durableChangeSnapshot(repo.root, change.directoryName), before);
});

test('completed ordinary journal binds deterministic terminal artifact hashes', async () => {
  const repo = await createTestRepository('round4-ordinary-terminal-hashes');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Bind ordinary terminal artifacts', 'small-feature');
  await reconcileChange(repo.root, change, {
    level: 'L0', type: 'IMPLEMENTATION_CHANGED', reason: 'Bind deterministic targets',
  });
  const transactionPath = join(
    changeRevisionsRoot(repo.root, change.directoryName),
    'REV-0001.reconcile-transaction.yaml',
  );
  const transaction = await readYaml(transactionPath, ordinaryReconcileTransactionSchema) as (
    ReturnType<typeof ordinaryReconcileTransactionSchema.parse> & {
      terminalHashes?: { metadata: string; tasks: string; flow: string | null; decisions: Array<{ id: string; hash: string }> };
    }
  );
  assert.ok(transaction.terminalHashes);
  await writeYaml(transactionPath, {
    ...transaction,
    terminalHashes: { ...transaction.terminalHashes, tasks: `sha256:${'0'.repeat(64)}` },
  });
  const before = await durableChangeSnapshot(repo.root, change.directoryName);

  await assert.rejects(() => archiveChange(repo.root, change), /TRANSACTION_LINEAGE_INTEGRITY/);
  assert.deepEqual(await durableChangeSnapshot(repo.root, change.directoryName), before);
});

test('Decision audits form a canonical opened-resolved-superseded hash chain', async () => {
  const repo = await createTestRepository('round4-decision-hash-chain');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Hash canonical Decision transitions', 'architecture-governance');
  const input = {
    kind: 'ARCHITECTURE' as const,
    owner: 'AGENT' as const,
    status: 'OPEN' as const,
    blocking: false,
    options: [],
    affects: { capabilities: ['design' as const], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs: [{ kind: 'artifact' as const, path: 'design.md', contentHash: `sha256:${'f'.repeat(64)}` }],
  };
  const decision = await openDecision(repo.root, change, { schemaVersion: 2, ...input, question: 'Which seam owns the boundary?' });
  const replacement = await openDecision(repo.root, change, { schemaVersion: 2, ...input, question: 'Which seam replaces it?' });
  await resolveDecision(repo.root, change, decision.id, { schemaVersion: 2,
    summary: 'Use the adapter', optionId: null, authority: 'AGENT_EVIDENCE', sourceRefs: input.sourceRefs,
  });
  await import('../src/core/decisions.js').then(({ supersedeDecision }) => supersedeDecision(
    repo.root,
    change,
    decision.id,
    replacement.id,
    'New evidence selects the replacement',
    input.sourceRefs,
  ));
  const transitions = (await readJsonLines<{
    event?: string; data?: { decisionId?: string; beforeHash?: string; afterHash?: string };
  }>(changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl'))).filter((event) => (
    event.data?.decisionId === decision.id && event.event?.startsWith('DECISION_')
  ));

  assert.deepEqual(transitions.map(({ event }) => event), [
    'DECISION_OPENED', 'DECISION_RESOLVED', 'DECISION_SUPERSEDED',
  ]);
  assert.match(transitions[0]?.data?.afterHash ?? '', /^sha256:[0-9a-f]{64}$/);
  assert.equal(transitions[0]?.data?.beforeHash, undefined);
  assert.equal(transitions[1]?.data?.beforeHash, transitions[0]?.data?.afterHash);
  assert.match(transitions[1]?.data?.afterHash ?? '', /^sha256:[0-9a-f]{64}$/);
  assert.equal(transitions[2]?.data?.beforeHash, transitions[1]?.data?.afterHash);
  assert.match(transitions[2]?.data?.afterHash ?? '', /^sha256:[0-9a-f]{64}$/);
});

test('terminal late Decision replay rejects immutable record edits', async (t) => {
  const mutations: Array<{ name: string; mutate: (decision: DecisionRecord) => DecisionRecord }> = [
    { name: 'question', mutate: (decision) => ({ ...decision, question: 'Edited question after audit' }) },
    { name: 'owner', mutate: (decision) => ({ ...decision, owner: 'HUMAN' }) },
    { name: 'options', mutate: (decision) => ({ ...decision, options: [{
      id: 'OPT-01', label: 'Edited option', status: 'VIABLE', consequences: [], sourceRefs: decision.sourceRefs,
    }] }) },
    { name: 'affects', mutate: (decision) => ({
      ...decision,
      affects: { ...decision.affects, artifacts: ['edited.md'] },
    }) },
    { name: 'sourceRefs', mutate: (decision) => ({
      ...decision,
      sourceRefs: decision.sourceRefs.map((source) => ({ ...source, contentHash: `sha256:${'1'.repeat(64)}` })),
    }) },
  ];
  for (const current of mutations) {
    await t.test(current.name, async () => {
      const fixture = await createTerminalPendingAssessment(`round4-late-edit-${current.name}`);
      const active = await resolveChange(fixture.repo.root, fixture.change.metadata.id);
      const late = await openDecision(fixture.repo.root, active, lateDecisionInput(`Late ${current.name}`));
      await writeYaml(
        changeDecisionPath(fixture.repo.root, fixture.change.directoryName, late.id),
        current.mutate(late),
      );
      const before = await durableChangeSnapshot(fixture.repo.root, fixture.change.directoryName);

      await assert.rejects(
        () => openDecision(fixture.repo.root, active, lateDecisionInput(`After edited ${current.name}`)),
        /FLOW_TRANSACTION_COMPLETION_MISMATCH/,
      );
      assert.deepEqual(await durableChangeSnapshot(fixture.repo.root, fixture.change.directoryName), before);
    });
  }
});

test('terminal late Decision replay rejects duplicate transition audits', async () => {
  const fixture = await createTerminalPendingAssessment('round4-late-duplicate-audit');
  const active = await resolveChange(fixture.repo.root, fixture.change.metadata.id);
  const late = await openDecision(fixture.repo.root, active, lateDecisionInput('Late duplicate audit'));
  const progressPath = changeArtifactPath(fixture.repo.root, fixture.change.directoryName, 'progress.jsonl');
  const events = await readJsonLines<{
    event?: string; data?: { decisionId?: string };
  }>(progressPath);
  const opened = events.find((event) => event.event === 'DECISION_OPENED' && event.data?.decisionId === late.id)!;
  await appendJsonLine(progressPath, opened);
  const before = await durableChangeSnapshot(fixture.repo.root, fixture.change.directoryName);

  await assert.rejects(
    () => openDecision(fixture.repo.root, active, lateDecisionInput('After duplicate audit')),
    /FLOW_TRANSACTION_COMPLETION_MISMATCH/,
  );
  assert.deepEqual(await durableChangeSnapshot(fixture.repo.root, fixture.change.directoryName), before);
});

test('terminal late Decision replay rejects an OPEN audit rebound to an illegal resolved target', async () => {
  const fixture = await createTerminalPendingAssessment('round4-late-illegal-status');
  const active = await resolveChange(fixture.repo.root, fixture.change.metadata.id);
  const late = await openDecision(fixture.repo.root, active, lateDecisionInput('Late illegal status'));
  const illegal = {
    ...late,
    status: 'RESOLVED' as const,
    resolvedRevision: active.metadata.activeRevision,
    resolution: {
      summary: 'Unaudited resolution', optionId: null, authority: 'AGENT_EVIDENCE' as const,
      sourceRefs: late.sourceRefs,
    },
  };
  await writeYaml(changeDecisionPath(fixture.repo.root, fixture.change.directoryName, late.id), illegal);
  const progressPath = changeArtifactPath(fixture.repo.root, fixture.change.directoryName, 'progress.jsonl');
  const events = await readJsonLines<{ event?: string; data?: Record<string, unknown> }>(progressPath);
  await writeFile(progressPath, `${events.map((event) => JSON.stringify(
    event.event === 'DECISION_OPENED' && event.data?.decisionId === late.id
      ? { ...event, data: { ...event.data, afterHash: hashDecisionRecord(illegal) } }
      : event,
  )).join('\n')}\n`);
  const before = await durableChangeSnapshot(fixture.repo.root, fixture.change.directoryName);

  await assert.rejects(
    () => openDecision(fixture.repo.root, active, lateDecisionInput('After illegal status')),
    /FLOW_TRANSACTION_COMPLETION_MISMATCH/,
  );
  assert.deepEqual(await durableChangeSnapshot(fixture.repo.root, fixture.change.directoryName), before);
});

test('terminal late Decision replay rejects a forged hash for an edited OPEN record', async () => {
  const fixture = await createTerminalPendingAssessment('round4-late-forged-open-hash');
  const active = await resolveChange(fixture.repo.root, fixture.change.metadata.id);
  const late = await openDecision(fixture.repo.root, active, lateDecisionInput('Original canonical question'));
  const edited = { ...late, question: 'Forged unaudited question' };
  await writeYaml(changeDecisionPath(fixture.repo.root, fixture.change.directoryName, late.id), edited);
  const progressPath = changeArtifactPath(fixture.repo.root, fixture.change.directoryName, 'progress.jsonl');
  const events = await readJsonLines<{ event?: string; data?: Record<string, unknown> }>(progressPath);
  await writeFile(progressPath, `${events.map((event) => JSON.stringify(
    event.event === 'DECISION_OPENED' && event.data?.decisionId === late.id
      ? { ...event, data: { ...event.data, afterHash: hashDecisionRecord(edited) } }
      : event,
  )).join('\n')}\n`);
  const before = await durableChangeSnapshot(fixture.repo.root, fixture.change.directoryName);

  await assert.rejects(
    () => openDecision(fixture.repo.root, active, lateDecisionInput('After forged hash')),
    /FLOW_TRANSACTION_COMPLETION_MISMATCH/,
  );
  assert.deepEqual(await durableChangeSnapshot(fixture.repo.root, fixture.change.directoryName), before);
});

test('completed Flow terminal authority still replays late Decision transitions', async () => {
  const repo = await createTestRepository('round4-completed-flow-late-decision');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Replay completed Flow terminal decisions', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  await applyFlowAssessment(repo.root, change, changedTopologyProposal(change, flow.assessment));
  const active = await resolveChange(repo.root, change.metadata.id);
  const late = await openDecision(repo.root, active, lateDecisionInput('Late after completed Flow'));
  await writeYaml(changeDecisionPath(repo.root, change.directoryName, late.id), {
    ...late,
    question: 'Unaudited edit after completed Flow',
  });
  const before = await durableChangeSnapshot(repo.root, change.directoryName);

  await assert.rejects(
    () => openDecision(repo.root, active, lateDecisionInput('Must be rejected')),
    /TRANSACTION_LINEAGE_INTEGRITY/,
  );
  assert.deepEqual(await durableChangeSnapshot(repo.root, change.directoryName), before);
});

test('completed ordinary terminal authority replays late Decision transitions', async () => {
  const repo = await createTestRepository('round4-completed-ordinary-late-decision');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Replay completed ordinary terminal decisions', 'small-feature');
  await reconcileChange(repo.root, change, {
    level: 'L0', type: 'IMPLEMENTATION_CHANGED', reason: 'Create terminal ordinary authority',
  });
  const active = await resolveChange(repo.root, change.metadata.id);
  const late = await openDecision(repo.root, active, lateDecisionInput('Late after completed ordinary'));
  await writeYaml(changeDecisionPath(repo.root, change.directoryName, late.id), {
    ...late,
    options: [{
      id: 'OPT-01', label: 'Unaudited option', status: 'VIABLE', consequences: [], sourceRefs: late.sourceRefs,
    }],
  });
  const before = await durableChangeSnapshot(repo.root, change.directoryName);

  await assert.rejects(() => archiveChange(repo.root, active), /TRANSACTION_LINEAGE_INTEGRITY/);
  assert.deepEqual(await durableChangeSnapshot(repo.root, change.directoryName), before);
});

function crashOrdinaryReconcileAtIntent(
  repoRoot: string,
  changeId: string,
  input: Parameters<typeof reconcileChange>[2],
): number | null {
  const storeModule = new URL('../src/core/store.js', import.meta.url).href;
  const reconcileModule = new URL('../src/core/reconcile.js', import.meta.url).href;
  const script = [
    `import { channel } from 'node:diagnostics_channel';`,
    `channel('omnai:core:change-mutation').subscribe((message) => {`,
    `  if (message.stage === 'ORDINARY_RECONCILE_INTENT_WRITTEN') process.exit(91);`,
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

function changedTopologyProposal(
  change: Awaited<ReturnType<typeof resolveChange>>,
  assessment: FlowAssessmentProposal['assessment'],
): FlowAssessmentProposal {
  return {
    schemaVersion: 2,
    changeId: change.metadata.id,
    revision: change.metadata.activeRevision,
    baseline: change.metadata.baseline,
    assessment: { ...assessment, topology: 'CROSS_MODULE', architectureApplicability: 'FOCUSED' },
  };
}

function crashFlowAssessmentAtIntent(
  repoRoot: string,
  changeId: string,
  proposal: FlowAssessmentProposal,
): number | null {
  const storeModule = new URL('../src/core/store.js', import.meta.url).href;
  const assessmentModule = new URL('../src/core/flow-assessment.js', import.meta.url).href;
  const script = [
    `import { channel } from 'node:diagnostics_channel';`,
    `channel('omnai:core:change-mutation').subscribe((message) => {`,
    `  if (message.stage === 'FLOW_TRANSACTION_INTENT_WRITTEN') process.exit(91);`,
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
  const change = await createChange(repo.root, `Terminal ${name}`, 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const proposal = changedTopologyProposal(change, flow.assessment);
  assert.equal(crashFlowAssessmentAtStage(
    repo.root,
    change.metadata.id,
    proposal,
    'FLOW_REASSESSED_AUDITED',
  ), 91);
  return { repo, change, proposal };
}

function crashFlowAssessmentAtStage(
  repoRoot: string,
  changeId: string,
  proposal: FlowAssessmentProposal,
  stage: 'FLOW_TRANSACTION_INTENT_WRITTEN' | 'FLOW_REASSESSED_AUDITED',
): number | null {
  const storeModule = new URL('../src/core/store.js', import.meta.url).href;
  const assessmentModule = new URL('../src/core/flow-assessment.js', import.meta.url).href;
  const script = [
    `import { channel } from 'node:diagnostics_channel';`,
    `channel('omnai:core:change-mutation').subscribe((message) => {`,
    `  if (message.stage === ${JSON.stringify(stage)}) process.exit(91);`,
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

function lateDecisionInput(question: string) {
  return {
    schemaVersion: 2 as const,
    kind: 'ARCHITECTURE' as const,
    owner: 'AGENT' as const,
    status: 'OPEN' as const,
    blocking: false,
    question,
    options: [],
    affects: { capabilities: ['design' as const], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs: [{ kind: 'artifact' as const, path: 'design.md', contentHash: `sha256:${'2'.repeat(64)}` }],
  };
}

function crashDecisionReconcileAtIntent(
  repoRoot: string,
  changeId: string,
  decisionId: string,
): number | null {
  const storeModule = new URL('../src/core/store.js', import.meta.url).href;
  const decisionModule = new URL('../src/core/decisions.js', import.meta.url).href;
  const resolution = {
    summary: 'Use the adapter boundary',
    optionId: null,
    authority: 'AGENT_EVIDENCE',
    sourceRefs: [{ kind: 'artifact', path: 'design.md', contentHash: `sha256:${'a'.repeat(64)}` }],
  };
  const script = [
    `import { channel } from 'node:diagnostics_channel';`,
    `channel('omnai:core:change-mutation').subscribe((message) => {`,
    `  if (message.stage === 'DECISION_RECONCILE_INTENT_WRITTEN') process.exit(91);`,
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

async function durableChangeSnapshot(repoRoot: string, directoryName: string) {
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

function task(id: string, dependsOn: string[]) {
  return {
    id,
    title: id,
    objective: id,
    status: 'DONE' as const,
    dependsOn,
    slice: 'VERTICAL' as const,
    risk: 'LOW' as const,
    files: { create: [], modify: [], tests: [] },
    consumes: [],
    produces: [],
    steps: [],
    evidenceRequired: [],
    notes: [],
  };
}
