import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { access, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createTestDirectory } from './helpers.js';
import { applyFlowAssessment } from '../src/core/flow-assessment.js';
import { listDecisions, openDecision, resolveDecision, supersedeDecision } from '../src/core/decisions.js';
import { appendJsonLine, readJsonLines, readYaml, writeTextAtomic, writeYaml } from '../src/core/files.js';
import { loadFlowPlan, migrateLegacyFlow, synchronizeFlowDecisions } from '../src/core/flow-store.js';
import {
  changeArtifactPath,
  changeDecisionPath,
  changeFlowPath,
  changeRevisionsRoot,
  changeRoot,
} from '../src/core/paths.js';
import { reconcileChange } from '../src/core/reconcile.js';
import { reclassifyChange } from '../src/core/reclassify.js';
import { archiveChange, createChange, markReadiness, resolveChange } from '../src/core/store.js';
import { flowAssessmentTransactionSchema } from '../src/core/flow-transaction.js';
import { hashDecisionRecord } from '../src/core/decision-transition.js';
import { semanticMutationTransactionSchema } from '../src/core/semantic-mutation-journal.js';
import {
  reconcileSignalSchema,
  type DecisionRecord,
  type FlowAssessmentProposal,
} from '../src/domain/types.js';
import { createTestRepository } from './helpers.js';

const packageRoot = process.cwd();
const cleanups: Array<() => Promise<void>> = [];
const sourceRefs = [{
  kind: 'artifact' as const,
  path: 'design.md',
  contentHash: `sha256:${'a'.repeat(64)}` as const,
}];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function installedPackageRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const fixture = await createTestDirectory('omnai-installed-package-');
  const nodeModules = join(fixture.root, 'node_modules');
  await mkdir(nodeModules, { recursive: true });
  await symlink(packageRoot, join(nodeModules, 'omnai'), 'junction');
  return fixture;
}

function runModule(cwd: string, source: string) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd,
    encoding: 'utf8',
  });
}

test('installed package declares only the canonical root API and package metadata', async () => {
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
    bin?: Record<string, string>;
    exports?: unknown;
  };

  assert.deepEqual(packageJson.exports, {
    '.': {
      types: './dist/src/index.d.ts',
      import: './dist/src/index.js',
    },
    './package.json': './package.json',
  });
  assert.deepEqual(packageJson.bin, { omnai: 'dist/src/main.js' });
  await access(join(packageRoot, 'dist/src/index.js'));
  await access(join(packageRoot, 'dist/src/index.d.ts'));
});

test('installed package root resolves the guarded runtime API and declaration root', async () => {
  const fixture = await installedPackageRoot();
  try {
    const runtime = runModule(fixture.root, `
      const omnai = await import('omnai');
      if (typeof omnai.createChange !== 'function') throw new Error('missing root createChange');
      if (typeof omnai.markReadiness !== 'function') throw new Error('missing guarded markReadiness');
      for (const name of [
        'synchronizeFlowDecisionsWithinChangeLock',
        'persistChangeMetadataWithinChangeLock',
        'markReadinessWithinChangeLock',
      ]) {
        if (name in omnai) throw new Error('leaked internal export: ' + name);
      }
    `);
    assert.equal(runtime.status, 0, runtime.stderr || runtime.stdout);

    const declaration = await readFile(join(packageRoot, 'dist/src/index.d.ts'), 'utf8');
    assert.match(declaration, /\.\/core\/store\.js/);
    assert.doesNotMatch(declaration, /WithinChangeLock/);
  } finally {
    await fixture.cleanup();
  }
});

for (const moduleName of [
  'flow-store-internal',
  'change-metadata-internal',
  'readiness-mutation-internal',
]) {
  test(`installed package rejects the ${moduleName} deep import as unexported`, async () => {
    await access(join(packageRoot, `dist/src/core/${moduleName}.js`));
    await access(join(packageRoot, `dist/src/core/${moduleName}.d.ts`));
    const fixture = await installedPackageRoot();
    try {
      const specifier = `omnai/dist/src/core/${moduleName}.js`;
      const runtime = runModule(fixture.root, `
        try {
          await import(${JSON.stringify(specifier)});
          throw new Error('deep import unexpectedly resolved');
        } catch (error) {
          if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
          process.stdout.write(error.code);
        }
      `);
      assert.equal(runtime.status, 0, runtime.stderr || runtime.stdout);
      assert.equal(runtime.stdout, 'ERR_PACKAGE_PATH_NOT_EXPORTED');
    } finally {
      await fixture.cleanup();
    }
  });
}

test('completed Flow lineage rejects a forged acceptedInputHash before archive side effects', async () => {
  const repo = await createTestRepository('round5-flow-accepted-input');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Bind accepted input', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  await applyFlowAssessment(repo.root, change, changedTopologyProposal(change, flow.assessment));
  const transactionPath = join(
    changeRevisionsRoot(repo.root, change.directoryName),
    'REV-0001.flow-transaction.yaml',
  );
  const transaction = await readYaml(transactionPath, flowAssessmentTransactionSchema);
  await writeYaml(transactionPath, {
    ...transaction,
    acceptedInputHash: `sha256:${'0'.repeat(64)}`,
  });
  const before = await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName));

  await assert.rejects(() => archiveChange(repo.root, change), /TRANSACTION_LINEAGE_INTEGRITY/);
  assert.deepEqual(await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName)), before);
});

for (const transactionKind of ['ordinary', 'flow', 'decision'] as const) {
  test(`completed ${transactionKind} lineage rejects additional correlated signal evidence`, async () => {
    const repo = await createTestRepository(`round5-${transactionKind}-signal-evidence`);
    cleanups.push(repo.cleanup);
    const change = await createChange(repo.root, `Bind ${transactionKind} signal evidence`, 'small-feature');

    if (transactionKind === 'ordinary') {
      await reconcileChange(repo.root, change, {
        level: 'L0',
        type: 'IMPLEMENTATION_CHANGED',
        reason: 'Create ordinary signal authority',
        evidence: ['EVD-ORIGINAL'],
      });
    } else if (transactionKind === 'flow') {
      const flow = (await loadFlowPlan(repo.root, change))!;
      await applyFlowAssessment(repo.root, change, changedTopologyProposal(change, flow.assessment));
      const active = await resolveChange(repo.root, change.metadata.id);
      await reconcileChange(repo.root, active, {
        level: 'L0', type: 'IMPLEMENTATION_CHANGED', reason: 'Make Flow lineage historical',
      });
    } else {
      await markReadiness(repo.root, change, 'design', 'READY');
      const decision = await openDecision(repo.root, change, { schemaVersion: 2,
        kind: 'ARCHITECTURE', owner: 'AGENT', status: 'OPEN', blocking: true,
        question: 'Which settled seam owns the boundary?', options: [],
        affects: { capabilities: ['design'], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] },
        sourceRefs,
      });
      await resolveDecision(repo.root, change, decision.id, { schemaVersion: 2,
        summary: 'Use the adapter seam', optionId: null, authority: 'AGENT_EVIDENCE', sourceRefs,
      });
      const active = await resolveChange(repo.root, change.metadata.id);
      await reconcileChange(repo.root, active, {
        level: 'L0', type: 'IMPLEMENTATION_CHANGED', reason: 'Make Decision lineage historical',
      });
    }

    const revisionsRoot = changeRevisionsRoot(repo.root, change.directoryName);
    const signalFiles = (await readdir(revisionsRoot)).filter((file) => file.endsWith('.signal.yaml')).sort();
    const targetType = transactionKind === 'ordinary'
      ? 'IMPLEMENTATION_CHANGED'
      : transactionKind === 'flow'
        ? 'FLOW_ASSESSMENT_CHANGED'
        : 'DECISION_AUTHORITY_RESOLVED';
    let targetPath: string | undefined;
    for (const file of signalFiles) {
      const path = join(revisionsRoot, file);
      const signal = await readYaml(path, reconcileSignalSchema);
      if (signal.signalType === targetType) {
        targetPath = path;
        await writeYaml(path, { ...signal, evidenceIds: [...signal.evidenceIds, 'EVD-999999'] });
        break;
      }
    }
    assert.ok(targetPath, `missing ${targetType} signal`);
    const active = await resolveChange(repo.root, change.metadata.id);
    const before = await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName));

    await assert.rejects(() => archiveChange(repo.root, active), /TRANSACTION_LINEAGE_INTEGRITY/);
    assert.deepEqual(await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName)), before);
  });
}

test('current completed Decision-Reconcile rejects an immutable target Decision edit', async () => {
  const repo = await createTestRepository('round5-decision-current-target');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Bind Decision target', 'small-feature');
  await markReadiness(repo.root, change, 'design', 'READY');
  const decision = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'ARCHITECTURE', owner: 'AGENT', status: 'OPEN', blocking: true,
    question: 'Which immutable seam owns the boundary?', options: [],
    affects: { capabilities: ['design'], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs,
  });
  await resolveDecision(repo.root, change, decision.id, { schemaVersion: 2,
    summary: 'Use the adapter seam', optionId: null, authority: 'AGENT_EVIDENCE', sourceRefs,
  });
  const active = await resolveChange(repo.root, change.metadata.id);
  const persisted = (await listDecisions(repo.root, active))[0]!;
  await writeYaml(changeDecisionPath(repo.root, change.directoryName, persisted.id), {
    ...persisted,
    question: 'Forged immutable question',
  });
  const before = await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName));

  await assert.rejects(() => archiveChange(repo.root, active), /TRANSACTION_LINEAGE_INTEGRITY/);
  assert.deepEqual(await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName)), before);
});

for (const corruption of ['missing', 'forged', 'duplicate'] as const) {
  test(`historical completed lineage rejects a ${corruption} DECISION_REBOUND audit`, async () => {
    const repo = await createTestRepository(`round5-rebound-${corruption}`);
    cleanups.push(repo.cleanup);
    const change = await createChange(repo.root, `Bind historical rebound ${corruption}`, 'small-feature');
    const decision = await openDecision(repo.root, change, { schemaVersion: 2,
      kind: 'ARCHITECTURE', owner: 'AGENT', status: 'OPEN', blocking: false,
      question: 'Which live Decision must rebind?', options: [],
      affects: { capabilities: ['design'], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] },
      sourceRefs,
    });
    await reconcileChange(repo.root, change, {
      level: 'L0', type: 'IMPLEMENTATION_CHANGED', reason: 'Create first rebound authority',
    });
    const active = await resolveChange(repo.root, change.metadata.id);
    await reconcileChange(repo.root, active, {
      level: 'L0', type: 'IMPLEMENTATION_CHANGED', reason: 'Make first rebound historical',
    });

    const progressPath = changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl');
    const events = await readJsonLines<{
      event?: string;
      data?: { decisionId?: string; fromRevision?: string; baseline?: string };
    }>(progressPath);
    const index = events.findIndex((event) => (
      event.event === 'DECISION_REBOUND'
      && event.data?.decisionId === decision.id
      && event.data?.fromRevision === 'REV-0001'
    ));
    assert.notEqual(index, -1);
    if (corruption === 'missing') events.splice(index, 1);
    else if (corruption === 'forged') {
      events[index] = {
        ...events[index],
        data: { ...events[index]!.data, baseline: 'BL-9999' },
      };
    } else events.splice(index + 1, 0, structuredClone(events[index]!));
    await writeTextAtomic(progressPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
    const current = await resolveChange(repo.root, change.metadata.id);
    const before = await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName));

    await assert.rejects(() => archiveChange(repo.root, current), /TRANSACTION_LINEAGE_INTEGRITY/);
    assert.deepEqual(await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName)), before);
  });
}

for (const authority of ['current', 'historical'] as const) {
  test(`${authority} completed Decision semantic authority rejects a forged frozen target`, async () => {
    const repo = await createTestRepository(`round5-${authority}-decision-semantic-target`);
    cleanups.push(repo.cleanup);
    const change = await createChange(repo.root, `Bind ${authority} Decision semantic target`, 'small-feature');
    const decision = await openDecision(repo.root, change, decisionInput('Which frozen Decision target is authoritative?'));
    if (authority === 'historical') {
      await resolveDecision(repo.root, change, decision.id, { schemaVersion: 2,
        summary: 'Create a later semantic target', optionId: null, authority: 'AGENT_EVIDENCE', sourceRefs,
      });
    }
    const targetPath = await semanticTransactionPathForOperation(repo.root, change, 'DECISION_OPEN');
    const transaction = await readYaml(targetPath, semanticMutationTransactionSchema);
    assert.equal(transaction.kind, 'DECISION');
    if (transaction.kind !== 'DECISION') return;
    await writeYaml(targetPath, {
      ...transaction,
      targetDecisions: transaction.targetDecisions.map((target) => target.id === decision.id
        ? { ...target, question: 'Forged frozen Decision target' }
        : target),
    });
    const active = await resolveChange(repo.root, change.metadata.id);
    const before = await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName));

    await assert.rejects(() => archiveChange(repo.root, active), /TRANSACTION_LINEAGE_INTEGRITY/);
    assert.deepEqual(await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName)), before);
  });
}

for (const authority of ['current', 'historical'] as const) {
  test(`${authority} completed Flow semantic authority rejects a forged frozen target hash`, async () => {
    const repo = await createTestRepository(`round5-${authority}-flow-semantic-target`);
    cleanups.push(repo.cleanup);
    const change = await createChange(repo.root, `Bind ${authority} Flow semantic target`, 'small-feature');
    await rm(changeFlowPath(repo.root, change.directoryName));
    await migrateLegacyFlow(repo.root, change, []);
    if (authority === 'historical') {
      const flow = (await loadFlowPlan(repo.root, change))!;
      await applyFlowAssessment(repo.root, change, {
        schemaVersion: 2,
        changeId: change.metadata.id,
        revision: change.metadata.activeRevision,
        baseline: change.metadata.baseline,
        assessment: {
          ...flow.assessment,
          sourceRefs: flow.assessment.sourceRefs.map((source) => ({
            ...source,
            contentHash: `sha256:${'c'.repeat(64)}` as const,
          })),
        },
      });
    }
    const targetPath = await semanticTransactionPathForOperation(repo.root, change, 'FLOW_MIGRATE');
    const transaction = await readYaml(targetPath, semanticMutationTransactionSchema);
    assert.equal(transaction.kind, 'FLOW');
    if (transaction.kind !== 'FLOW' || !transaction.targetFlow) return;
    await writeYaml(targetPath, {
      ...transaction,
      targetFlow: { ...transaction.targetFlow, compiledAt: '2026-01-01T00:00:00.000Z' },
    });
    const active = await resolveChange(repo.root, change.metadata.id);
    const before = await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName));

    await assert.rejects(() => archiveChange(repo.root, active), /TRANSACTION_LINEAGE_INTEGRITY/);
    assert.deepEqual(await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName)), before);
  });
}

test('completed Scenario semantic authority rejects forged proposed metadata', async () => {
  const repo = await createTestRepository('round5-scenario-semantic-target');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Bind Scenario semantic target', 'small-feature');
  await reclassifyChange(repo.root, change, 'bug-fix', 'Bind the exact reclassification target');
  const targetPath = await semanticTransactionPathForKind(repo.root, change, 'SCENARIO_RECLASSIFY');
  const transaction = await readYaml(targetPath, semanticMutationTransactionSchema);
  assert.equal(transaction.kind, 'SCENARIO_RECLASSIFY');
  if (transaction.kind !== 'SCENARIO_RECLASSIFY') return;
  await writeYaml(targetPath, {
    ...transaction,
    proposedMetadata: {
      ...transaction.proposedMetadata,
      readiness: { ...transaction.proposedMetadata.readiness, diagnosis: 'READY' },
    },
  });
  const active = await resolveChange(repo.root, change.metadata.id);
  const before = await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName));

  await assert.rejects(() => archiveChange(repo.root, active), /TRANSACTION_LINEAGE_INTEGRITY/);
  assert.deepEqual(await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName)), before);
});

for (const corruption of ['resolve-authority', 'supersede-reason-and-sources'] as const) {
  test(`completed Decision semantic authority rejects forged ${corruption} audit fields`, async () => {
    const repo = await createTestRepository(`round5-decision-audit-${corruption}`);
    cleanups.push(repo.cleanup);
    const change = await createChange(repo.root, `Bind Decision ${corruption} audit`, 'small-feature');
    const original = await openDecision(repo.root, change, decisionInput(`Which ${corruption} audit is exact?`));
    const operation = corruption === 'resolve-authority' ? 'DECISION_RESOLVE' : 'DECISION_SUPERSEDE';
    if (corruption === 'resolve-authority') {
      await resolveDecision(repo.root, change, original.id, { schemaVersion: 2,
        summary: 'Use exact agent evidence', optionId: null, authority: 'AGENT_EVIDENCE', sourceRefs,
      });
    } else {
      const replacement = await openDecision(repo.root, change, decisionInput('Which exact replacement remains live?'));
      await supersedeDecision(
        repo.root,
        change,
        original.id,
        replacement.id,
        'Use the exact replacement reason',
        sourceRefs,
      );
    }
    const targetPath = await semanticTransactionPathForOperation(repo.root, change, operation);
    const transaction = await readYaml(targetPath, semanticMutationTransactionSchema);
    assert.equal(transaction.kind, 'DECISION');
    if (transaction.kind !== 'DECISION') return;
    const targetEvent = corruption === 'resolve-authority' ? 'DECISION_RESOLVED' : 'DECISION_SUPERSEDED';
    const forgedAudits = transaction.audits.map((audit) => audit.event === targetEvent
      ? corruption === 'resolve-authority'
        ? { ...audit, data: { ...audit.data, authority: 'EXTERNAL_CONFIRMED' } }
        : {
            ...audit,
            detail: `Superseded decision ${original.id}: forged reason`,
            data: {
              ...audit.data,
              sourceRefs: [{ ...sourceRefs[0]!, contentHash: `sha256:${'f'.repeat(64)}` }],
            },
          }
      : audit);
    await writeYaml(targetPath, { ...transaction, audits: forgedAudits });
    const progressPath = changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl');
    const events = await readJsonLines<{ event?: string; data?: Record<string, unknown> }>(progressPath);
    const forgedEvent = forgedAudits.find(({ event }) => event === targetEvent)!;
    await writeTextAtomic(progressPath, `${events.map((event) => (
      event.event === targetEvent && event.data?.semanticMutationId === transaction.id
        ? JSON.stringify(forgedEvent)
        : JSON.stringify(event)
    )).join('\n')}\n`);
    const active = await resolveChange(repo.root, change.metadata.id);
    const before = await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName));

    await assert.rejects(() => archiveChange(repo.root, active), /TRANSACTION_LINEAGE_INTEGRITY/);
    assert.deepEqual(await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName)), before);
  });
}

test('completed Flow semantic authority rejects a coherently forged migration audit', async () => {
  const repo = await createTestRepository('round5-flow-audit-target');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Bind exact Flow migration audit', 'small-feature');
  await rm(changeFlowPath(repo.root, change.directoryName));
  await migrateLegacyFlow(repo.root, change, []);
  const targetPath = await semanticTransactionPathForOperation(repo.root, change, 'FLOW_MIGRATE');
  const transaction = await readYaml(targetPath, semanticMutationTransactionSchema);
  assert.equal(transaction.kind, 'FLOW');
  if (transaction.kind !== 'FLOW') return;
  const forgedAudits = transaction.audits.map((audit) => audit.event === 'FLOW_MIGRATED'
    ? { ...audit, data: { ...audit.data, inputHash: `sha256:${'0'.repeat(64)}` } }
    : audit);
  await writeYaml(targetPath, { ...transaction, audits: forgedAudits });
  const progressPath = changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl');
  const events = await readJsonLines<{ event?: string; data?: Record<string, unknown> }>(progressPath);
  const forgedEvent = forgedAudits.find(({ event }) => event === 'FLOW_MIGRATED')!;
  await writeTextAtomic(progressPath, `${events.map((event) => (
    event.event === 'FLOW_MIGRATED' && event.data?.semanticMutationId === transaction.id
      ? JSON.stringify(forgedEvent)
      : JSON.stringify(event)
  )).join('\n')}\n`);
  const active = await resolveChange(repo.root, change.metadata.id);
  const before = await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName));

  await assert.rejects(() => archiveChange(repo.root, active), /TRANSACTION_LINEAGE_INTEGRITY/);
  assert.deepEqual(await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName)), before);
});

test('current semantic Decision authority rejects an unaudited same-ID record edit', async () => {
  const repo = await createTestRepository('round5-current-decision-record-target');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Bind current Decision record target', 'small-feature');
  const decision = await openDecision(repo.root, change, decisionInput('Which current question is immutable?'));
  await writeYaml(changeDecisionPath(repo.root, change.directoryName, decision.id), {
    ...decision,
    question: 'Forged current question without an intent',
  });
  const before = await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName));

  await assert.rejects(() => archiveChange(repo.root, change), /TRANSACTION_LINEAGE_INTEGRITY/);
  assert.deepEqual(await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName)), before);
});

test('current semantic Flow authority rejects an unaudited compiledAt edit', async () => {
  const repo = await createTestRepository('round5-current-flow-record-target');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Bind current Flow record target', 'small-feature');
  await rm(changeFlowPath(repo.root, change.directoryName));
  const flow = await migrateLegacyFlow(repo.root, change, []);
  await writeYaml(changeFlowPath(repo.root, change.directoryName), {
    ...flow,
    compiledAt: '2026-01-01T00:00:00.000Z',
  });
  const before = await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName));

  await assert.rejects(() => archiveChange(repo.root, change), /TRANSACTION_LINEAGE_INTEGRITY/);
  assert.deepEqual(await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName)), before);
});

test('completed semantic lineage rejects an orphan audit after its journal is removed', async () => {
  const repo = await createTestRepository('round5-orphan-semantic-audit');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Bind semantic audit owner', 'small-feature');
  await openDecision(repo.root, change, decisionInput('Which semantic owner must remain durable?'));
  const targetPath = await semanticTransactionPathForOperation(repo.root, change, 'DECISION_OPEN');
  await rm(targetPath);
  const before = await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName));

  await assert.rejects(() => archiveChange(repo.root, change), /TRANSACTION_LINEAGE_INTEGRITY/);
  assert.deepEqual(await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName)), before);
});

for (const corruption of ['owner-authority', 'resolved-revision', 'opened-created-at'] as const) {
  test(`Decision replay rejects the semantically illegal ${corruption} transition`, async () => {
    const fixture = await completedFlowTerminal(`round5-decision-${corruption}`);
    const active = await resolveChange(fixture.repo.root, fixture.change.metadata.id);
    const decision = await openDecision(fixture.repo.root, active, { schemaVersion: 2,
      kind: 'ARCHITECTURE', owner: 'HUMAN', status: 'OPEN', blocking: false,
      question: `Which ${corruption} authority is legal?`, options: [],
      affects: { capabilities: ['design'], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] },
      sourceRefs,
    });
    let target: DecisionRecord;
    if (corruption === 'opened-created-at') {
      target = { ...decision, createdAt: '2026-01-01T00:00:00.000Z' };
    } else {
      const resolved = await resolveDecision(fixture.repo.root, active, decision.id, { schemaVersion: 2,
        summary: 'Human confirmed the boundary', optionId: null, authority: 'HUMAN_CONFIRMED', sourceRefs,
      });
      target = corruption === 'owner-authority'
        ? {
            ...resolved,
            resolution: { ...resolved.resolution!, authority: 'AGENT_EVIDENCE' },
          }
        : { ...resolved, resolvedRevision: 'REV-9999' };
    }
    await writeYaml(
      changeDecisionPath(fixture.repo.root, fixture.change.directoryName, decision.id),
      target,
    );
    const progressPath = changeArtifactPath(fixture.repo.root, fixture.change.directoryName, 'progress.jsonl');
    const events = await readJsonLines<{ event?: string; data?: Record<string, unknown> }>(progressPath);
    const eventName = corruption === 'opened-created-at' ? 'DECISION_OPENED' : 'DECISION_RESOLVED';
    const corrupted = events.map((event) => (
      event.event === eventName && event.data?.decisionId === decision.id
        ? {
            ...event,
            data: {
              ...event.data,
              ...(corruption === 'owner-authority' ? { authority: 'AGENT_EVIDENCE' } : {}),
              afterHash: hashDecisionRecord(target),
              afterDecision: target,
            },
          }
        : event
    ));
    await writeTextAtomic(progressPath, `${corrupted.map((event) => JSON.stringify(event)).join('\n')}\n`);
    const before = await durableDirectorySnapshot(
      changeRoot(fixture.repo.root, fixture.change.directoryName),
    );

    await assert.rejects(() => archiveChange(fixture.repo.root, active), /TRANSACTION_LINEAGE_INTEGRITY/);
    assert.deepEqual(
      await durableDirectorySnapshot(changeRoot(fixture.repo.root, fixture.change.directoryName)),
      before,
    );
  });
}

test('Decision replay requires a live replacement at the supersession event', async () => {
  const fixture = await completedFlowTerminal('round5-decision-dead-replacement');
  const active = await resolveChange(fixture.repo.root, fixture.change.metadata.id);
  const input = {
    kind: 'ARCHITECTURE' as const,
    owner: 'AGENT' as const,
    status: 'OPEN' as const,
    blocking: false,
    options: [],
    affects: { capabilities: ['design' as const], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs,
  };
  const original = await openDecision(fixture.repo.root, active, { schemaVersion: 2,
    ...input,
    question: 'Which original seam is obsolete?',
  });
  const replacement = await openDecision(fixture.repo.root, active, { schemaVersion: 2,
    ...input,
    question: 'Which replacement seam is live?',
  });
  await resolveDecision(fixture.repo.root, active, replacement.id, { schemaVersion: 2,
    summary: 'The replacement is already terminal', optionId: null, authority: 'AGENT_EVIDENCE', sourceRefs,
  });
  const updatedAt = new Date(Date.now() + 1_000).toISOString();
  const superseded = {
    ...original,
    status: 'SUPERSEDED' as const,
    supersededBy: replacement.id,
    updatedAt,
  };
  await writeYaml(
    changeDecisionPath(fixture.repo.root, fixture.change.directoryName, original.id),
    superseded,
  );
  await appendJsonLine(
    changeArtifactPath(fixture.repo.root, fixture.change.directoryName, 'progress.jsonl'),
    {
      timestamp: updatedAt,
      event: 'DECISION_SUPERSEDED',
      changeId: active.metadata.id,
      revision: active.metadata.activeRevision,
      detail: `Superseded decision ${original.id}: forged replacement`,
      data: {
        decisionId: original.id,
        replacementId: replacement.id,
        baseline: active.metadata.baseline,
        sourceRefs,
        beforeHash: hashDecisionRecord(original),
        afterHash: hashDecisionRecord(superseded),
        beforeDecision: original,
        afterDecision: superseded,
      },
    },
  );
  const before = await durableDirectorySnapshot(changeRoot(fixture.repo.root, fixture.change.directoryName));

  await assert.rejects(() => archiveChange(fixture.repo.root, active), /TRANSACTION_LINEAGE_INTEGRITY/);
  assert.deepEqual(
    await durableDirectorySnapshot(changeRoot(fixture.repo.root, fixture.change.directoryName)),
    before,
  );
});

test('real scenario select is zero-side-effect while an ordinary Reconcile owns the Change', async () => {
  const repo = await createTestRepository('round5-real-scenario-fence');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Fence real scenario select', 'small-feature');
  assert.equal(crashOrdinaryAtIntent(repo.root, change.metadata.id), 91);
  const before = await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName));

  const result = spawnSync(
    process.execPath,
    [join(packageRoot, 'dist/src/main.js'), 'scenario', 'select', 'bug-fix', '-r', 'Reclassify after recovery'],
    { cwd: repo.root, encoding: 'utf8' },
  );

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /ORDINARY_RECONCILE_TRANSACTION_(?:PENDING|REQUEST_MISMATCH)/);
  assert.deepEqual(await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName)), before);
});

test('scenario reclassification rejects a stale ChangeRef before artifact or lineage writes', async () => {
  const repo = await createTestRepository('round5-scenario-stale');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Reject stale scenario select', 'small-feature');
  const stale = await resolveChange(repo.root, change.metadata.id);
  const fresh = await resolveChange(repo.root, change.metadata.id);
  await markReadiness(repo.root, fresh, 'spec', 'READY');
  const before = await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName));

  await assert.rejects(
    () => reclassifyChange(repo.root, stale, 'bug-fix', 'A stale caller cannot reclassify'),
    /STALE|CAS/,
  );
  assert.deepEqual(await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName)), before);
});

for (const taskState of ['missing', 'malformed'] as const) {
  test(`scenario reclassification rejects a ${taskState} TaskFile before artifacts`, async () => {
    const repo = await createTestRepository(`round5-scenario-task-${taskState}`);
    cleanups.push(repo.cleanup);
    const change = await createChange(repo.root, `Reject ${taskState} task state`, 'small-feature');
    const tasksPath = changeArtifactPath(repo.root, change.directoryName, 'tasks.yaml');
    if (taskState === 'missing') await rm(tasksPath);
    else await writeTextAtomic(tasksPath, 'not: a valid TaskFile\n');
    const before = await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName));

    await assert.rejects(
      () => reclassifyChange(repo.root, change, 'bug-fix', `Reject ${taskState} tasks`),
    );
    assert.deepEqual(await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName)), before);
  });
}

for (const stage of [
  'SCENARIO_RECLASSIFY_INTENT_WRITTEN',
  'SCENARIO_RECLASSIFY_ARTIFACTS_ENSURED',
  'SCENARIO_RECLASSIFY_RECONCILE_COMPLETED',
] as const) {
  test(`scenario reclassification recovers exactly after ${stage}`, async () => {
    const repo = await createTestRepository(`round5-${stage.toLowerCase()}`);
    cleanups.push(repo.cleanup);
    const change = await createChange(repo.root, `Recover ${stage}`, 'small-feature');
    const staleSource = structuredClone(change);
    const reason = `Recover ${stage}`;
    assert.equal(crashScenarioAtStage(repo.root, change.metadata.id, 'bug-fix', reason, stage), 91);
    const interrupted = await resolveChange(repo.root, change.metadata.id);

    const recovered = await reclassifyChange(repo.root, interrupted, 'bug-fix', reason);
    assert.equal(recovered.reconcile.revision.id, 'REV-0002');
    assert.equal(recovered.change.metadata.scenario, 'bug-fix');
    const afterRecovery = await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName));
    const repeated = await reclassifyChange(repo.root, staleSource, 'bug-fix', reason);
    assert.equal(repeated.reconcile.revision.id, 'REV-0002');
    assert.deepEqual(await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName)), afterRecovery);

    const files = await readdir(changeRevisionsRoot(repo.root, change.directoryName));
    assert.equal(files.filter((file) => /^REV-\d{4}\.yaml$/.test(file)).length, 2);
    const events = await readJsonLines<{ event?: string }>(
      changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl'),
    );
    assert.equal(events.filter(({ event }) => event === 'SCENARIO_RECLASSIFIED').length, 1);
  });
}

test('pending scenario reclassification fences different requests and unrelated mutations', async () => {
  const repo = await createTestRepository('round5-scenario-owner-fence');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Fence scenario owner', 'small-feature');
  assert.equal(crashScenarioAtStage(
    repo.root,
    change.metadata.id,
    'bug-fix',
    'The owning scenario request',
    'SCENARIO_RECLASSIFY_INTENT_WRITTEN',
  ), 91);
  const interrupted = await resolveChange(repo.root, change.metadata.id);
  const before = await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName));

  await assert.rejects(
    () => reclassifyChange(repo.root, interrupted, 'bug-fix', 'A different request'),
    /SEMANTIC_MUTATION_PENDING|SCENARIO_RECLASSIFY.*PENDING/,
  );
  assert.deepEqual(await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName)), before);
  await assert.rejects(
    () => openDecision(repo.root, interrupted, { schemaVersion: 2,
      kind: 'DOMAIN', owner: 'AGENT', status: 'OPEN', blocking: false,
      question: 'A non-owner mutation must be fenced', options: [],
      affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] },
      sourceRefs,
    }),
    /SEMANTIC_MUTATION_PENDING|SCENARIO_RECLASSIFY.*PENDING/,
  );
  assert.deepEqual(await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName)), before);
});

for (const stage of [
  'SEMANTIC_MUTATION_INTENT_WRITTEN',
  'DECISION_MUTATION_RECORD_WRITTEN',
  'DECISION_MUTATION_FLOW_WRITTEN',
  'DECISION_MUTATION_AUDITS_WRITTEN',
] as const) {
  test(`Decision open retry owns the selected ID and completes once after ${stage}`, async () => {
    const repo = await createTestRepository(`round5-open-${stage.toLowerCase()}`);
    cleanups.push(repo.cleanup);
    const change = await createChange(repo.root, `Recover open ${stage}`, 'small-feature');
    const input = decisionInput(`Recover open ${stage}`);
    const staleSource = structuredClone(change);
    assert.equal(crashDecisionOpenAtStage(repo.root, change.metadata.id, input, stage), 91);
    const interrupted = await resolveChange(repo.root, change.metadata.id);

    const recovered = await openDecision(repo.root, interrupted, input);
    assert.equal(recovered.id, 'DEC-0001');
    const afterRecovery = await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName));
    const repeated = await openDecision(repo.root, staleSource, input);
    assert.equal(repeated.id, 'DEC-0001');
    assert.deepEqual(await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName)), afterRecovery);

    const decisions = await listDecisions(repo.root, interrupted);
    assert.deepEqual(decisions.map(({ id }) => id), ['DEC-0001']);
    const events = await readJsonLines<{ event?: string; data?: { decisionId?: string } }>(
      changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl'),
    );
    assert.equal(events.filter((event) => (
      event.event === 'DECISION_OPENED' && event.data?.decisionId === recovered.id
    )).length, 1);
  });
}

test('ordinary Decision resolve repairs record-before-audit crash exactly once', async () => {
  const repo = await createTestRepository('round5-resolve-record-crash');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Recover ordinary resolve', 'small-feature');
  const decision = await openDecision(repo.root, change, decisionInput('Which ordinary resolution is durable?'));
  const resolution = {
      schemaVersion: 2 as const,
    summary: 'Use the evidence-backed seam',
    optionId: null,
    authority: 'AGENT_EVIDENCE' as const,
    sourceRefs,
  };
  assert.equal(crashDecisionResolveAtStage(
    repo.root,
    change.metadata.id,
    decision.id,
    resolution,
    'DECISION_MUTATION_RECORD_WRITTEN',
  ), 91);
  const interrupted = await resolveChange(repo.root, change.metadata.id);

  const recovered = await resolveDecision(repo.root, interrupted, decision.id, resolution);
  assert.equal(recovered.status, 'RESOLVED');
  const afterRecovery = await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName));
  await resolveDecision(repo.root, interrupted, decision.id, resolution);
  assert.deepEqual(await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName)), afterRecovery);
});

test('Decision supersede repairs record-before-audit crash exactly once', async () => {
  const repo = await createTestRepository('round5-supersede-record-crash');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Recover ordinary supersede', 'small-feature');
  const first = await openDecision(repo.root, change, decisionInput('Which seam is obsolete?'));
  const replacement = await openDecision(repo.root, change, decisionInput('Which seam replaces it?'));
  assert.equal(crashDecisionSupersedeAtStage(
    repo.root,
    change.metadata.id,
    first.id,
    replacement.id,
    'A newer seam replaces it',
    'DECISION_MUTATION_RECORD_WRITTEN',
  ), 91);
  const interrupted = await resolveChange(repo.root, change.metadata.id);

  const recovered = await supersedeDecision(
    repo.root,
    interrupted,
    first.id,
    replacement.id,
    'A newer seam replaces it',
    sourceRefs,
  );
  assert.equal(recovered.status, 'SUPERSEDED');
  const afterRecovery = await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName));
  await supersedeDecision(
    repo.root,
    interrupted,
    first.id,
    replacement.id,
    'A newer seam replaces it',
    sourceRefs,
  );
  assert.deepEqual(await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName)), afterRecovery);
});

test('a pending Decision mutation fences a different request without allocating another ID', async () => {
  const repo = await createTestRepository('round5-decision-request-fence');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Fence Decision request', 'small-feature');
  const input = decisionInput('The owning Decision request');
  assert.equal(crashDecisionOpenAtStage(
    repo.root,
    change.metadata.id,
    input,
    'SEMANTIC_MUTATION_INTENT_WRITTEN',
  ), 91);
  const interrupted = await resolveChange(repo.root, change.metadata.id);
  const before = await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName));

  await assert.rejects(
    () => openDecision(repo.root, interrupted, decisionInput('A different Decision request')),
    /SEMANTIC_MUTATION_PENDING|MUTATION_REQUEST_MISMATCH/,
  );
  assert.deepEqual(await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName)), before);
});

test('Flow migration repairs target-before-audit crash exactly once', async () => {
  const repo = await createTestRepository('round5-flow-migrate-crash');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Recover Flow migration', 'small-feature');
  await rm(changeFlowPath(repo.root, change.directoryName));
  assert.equal(crashFlowMigrationAtStage(
    repo.root,
    change.metadata.id,
    'FLOW_MUTATION_TARGET_WRITTEN',
  ), 91);
  const interrupted = await resolveChange(repo.root, change.metadata.id);

  await migrateLegacyFlow(repo.root, interrupted, []);
  const afterRecovery = await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName));
  await migrateLegacyFlow(repo.root, interrupted, []);
  assert.deepEqual(await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName)), afterRecovery);
  const events = await readJsonLines<{ event?: string }>(
    changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl'),
  );
  assert.equal(events.filter(({ event }) => event === 'FLOW_MIGRATED').length, 1);
});

test('public Flow synchronize repairs target-before-audit crash exactly once for legacy history', async () => {
  const repo = await createTestRepository('round5-flow-synchronize-crash');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Recover public Flow synchronization', 'small-feature');
  const original = await openDecision(repo.root, change, decisionInput('Which legacy seam is superseded?'));
  const replacement = await openDecision(repo.root, change, {
    ...decisionInput('Which legacy seam replaces it?'),
    sourceRefs: [{ ...sourceRefs[0]!, contentHash: `sha256:${'d'.repeat(64)}` as const }],
  });
  const legacySource = (await loadFlowPlan(repo.root, change))!;
  await supersedeDecision(
    repo.root,
    change,
    original.id,
    replacement.id,
    'Model an installed pre-journal Decision transition',
    sourceRefs,
  );
  const synchronized = (await loadFlowPlan(repo.root, change))!;
  assert.notEqual(legacySource.inputHash, synchronized.inputHash);
  await writeYaml(changeFlowPath(repo.root, change.directoryName), legacySource);
  await downgradeDecisionSemanticHistoryToLegacy(repo.root, change);

  assert.equal(crashFlowSynchronizeAtStage(
    repo.root,
    change.metadata.id,
    'FLOW_MUTATION_TARGET_WRITTEN',
  ), 91);
  const interrupted = await resolveChange(repo.root, change.metadata.id);
  const decisions = await listDecisions(repo.root, interrupted);

  await synchronizeFlowDecisions(repo.root, interrupted, decisions);
  const afterRecovery = await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName));
  await synchronizeFlowDecisions(repo.root, interrupted, decisions);
  assert.deepEqual(await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName)), afterRecovery);
  const events = await readJsonLines<{ event?: string; data?: { semanticMutationId?: string } }>(
    changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl'),
  );
  assert.equal(events.filter(({ event, data }) => (
    event === 'FLOW_DECISIONS_SYNCHRONIZED' && data?.semanticMutationId !== undefined
  )).length, 1);
});

test('Flow source rebound repairs Flow-before-audit crash exactly once', async () => {
  const repo = await createTestRepository('round5-flow-source-crash');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Recover Flow source rebound', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const proposal: FlowAssessmentProposal = {
    schemaVersion: 2,
    changeId: change.metadata.id,
    revision: change.metadata.activeRevision,
    baseline: change.metadata.baseline,
    assessment: {
      ...flow.assessment,
      sourceRefs: flow.assessment.sourceRefs.map((source) => ({
        ...source,
        contentHash: `sha256:${'b'.repeat(64)}` as const,
      })),
    },
  };
  assert.equal(crashFlowSourceAtStage(
    repo.root,
    change.metadata.id,
    proposal,
    'FLOW_MUTATION_TARGET_WRITTEN',
  ), 91);
  const interrupted = await resolveChange(repo.root, change.metadata.id);

  await applyFlowAssessment(repo.root, interrupted, proposal);
  const afterRecovery = await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName));
  await applyFlowAssessment(repo.root, interrupted, proposal);
  assert.deepEqual(await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName)), afterRecovery);
  const events = await readJsonLines<{ event?: string }>(
    changeArtifactPath(repo.root, change.directoryName, 'progress.jsonl'),
  );
  assert.equal(events.filter(({ event }) => event === 'FLOW_SOURCE_REBOUND').length, 1);
});

test('a raw Decision record without an authorizing intent or audit fails closed', async () => {
  const repo = await createTestRepository('round5-raw-decision-target');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Reject raw Decision target', 'small-feature');
  const now = new Date().toISOString();
  const raw = {
    id: 'DEC-0001',
    changeId: change.metadata.id,
    openedRevision: change.metadata.activeRevision,
    resolvedRevision: null,
    ...decisionInput('An unaudited raw Decision'),
    schemaVersion: 1 as const,
    resolution: null,
    supersededBy: null,
    createdAt: now,
    updatedAt: now,
  };
  await writeYaml(changeDecisionPath(repo.root, change.directoryName, raw.id), raw);
  const before = await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName));

  await assert.rejects(
    () => openDecision(repo.root, change, decisionInput('Must not adopt raw state')),
    /DECISION_TRANSITION|SEMANTIC_MUTATION|LINEAGE/,
  );
  assert.deepEqual(await durableDirectorySnapshot(changeRoot(repo.root, change.directoryName)), before);
});

test('completed-lineage preflight builds one indexed inventory and caches each archive read', async () => {
  const repo = await createTestRepository('round5-lineage-linear-index');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Index completed lineage once', 'small-feature');
  for (let index = 0; index < 5; index += 1) {
    const active = await resolveChange(repo.root, change.metadata.id);
    await reconcileChange(repo.root, active, {
      level: 'L0',
      type: 'IMPLEMENTATION_CHANGED',
      reason: `Create indexed transaction ${index + 1}`,
    });
  }

  const instrumentation = channel('omnai:core:transaction-lineage');
  let metrics: {
    inventoryPasses?: number;
    correlationIndexBuilds?: number;
    fullArrayScans?: number;
    transactionCount?: number;
    archiveReads?: number;
    uniqueArchives?: number;
  } | undefined;
  const listener = (message: unknown): void => {
    const event = message as { stage?: string; metrics?: typeof metrics };
    if (event.stage === 'LINEAGE_VALIDATED') metrics = event.metrics;
  };
  instrumentation.subscribe(listener);
  try {
    const active = await resolveChange(repo.root, change.metadata.id);
    await markReadiness(repo.root, active, 'spec', active.metadata.readiness.spec);
  } finally {
    instrumentation.unsubscribe(listener);
  }

  assert.ok(metrics, 'lineage validation must publish deterministic structural metrics');
  assert.equal(metrics.inventoryPasses, 1);
  assert.equal(metrics.correlationIndexBuilds, 1);
  assert.equal(metrics.fullArrayScans, 0);
  assert.equal(metrics.transactionCount, 5);
  assert.ok((metrics.archiveReads ?? Infinity) <= (metrics.uniqueArchives ?? -1));
});

function changedTopologyProposal(
  change: Awaited<ReturnType<typeof createChange>>,
  assessment: NonNullable<Awaited<ReturnType<typeof loadFlowPlan>>>['assessment'],
): FlowAssessmentProposal {
  return {
    schemaVersion: 2,
    changeId: change.metadata.id,
    revision: change.metadata.activeRevision,
    baseline: change.metadata.baseline,
    assessment: { ...assessment, topology: 'CROSS_MODULE', architectureApplicability: 'FOCUSED' },
  };
}

async function completedFlowTerminal(name: string) {
  const repo = await createTestRepository(name);
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, `Terminal ${name}`, 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  await applyFlowAssessment(repo.root, change, changedTopologyProposal(change, flow.assessment));
  return { repo, change };
}

function decisionInput(question: string) {
  return {
    schemaVersion: 2 as const,
    kind: 'ARCHITECTURE' as const,
    owner: 'AGENT' as const,
    status: 'OPEN' as const,
    blocking: false,
    question,
    options: [],
    affects: { capabilities: ['design' as const], artifacts: ['design.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs,
  };
}

function crashDecisionOpenAtStage(
  repoRoot: string,
  changeId: string,
  input: Parameters<typeof openDecision>[2],
  stage:
    | 'SEMANTIC_MUTATION_INTENT_WRITTEN'
    | 'DECISION_MUTATION_RECORD_WRITTEN'
    | 'DECISION_MUTATION_FLOW_WRITTEN'
    | 'DECISION_MUTATION_AUDITS_WRITTEN',
): number | null {
  return crashSemanticScript(repoRoot, changeId, stage, [
    `const { openDecision } = await import(${JSON.stringify(new URL('../src/core/decisions.js', import.meta.url).href)});`,
    `await openDecision(${JSON.stringify(repoRoot)}, change, ${JSON.stringify(input)});`,
  ]);
}

function crashDecisionResolveAtStage(
  repoRoot: string,
  changeId: string,
  decisionId: string,
  input: Parameters<typeof resolveDecision>[3],
  stage: 'DECISION_MUTATION_RECORD_WRITTEN',
): number | null {
  return crashSemanticScript(repoRoot, changeId, stage, [
    `const { resolveDecision } = await import(${JSON.stringify(new URL('../src/core/decisions.js', import.meta.url).href)});`,
    `await resolveDecision(${JSON.stringify(repoRoot)}, change, ${JSON.stringify(decisionId)}, ${JSON.stringify(input)});`,
  ]);
}

function crashDecisionSupersedeAtStage(
  repoRoot: string,
  changeId: string,
  decisionId: string,
  replacementId: string,
  reason: string,
  stage: 'DECISION_MUTATION_RECORD_WRITTEN',
): number | null {
  return crashSemanticScript(repoRoot, changeId, stage, [
    `const { supersedeDecision } = await import(${JSON.stringify(new URL('../src/core/decisions.js', import.meta.url).href)});`,
    `await supersedeDecision(`,
    `  ${JSON.stringify(repoRoot)}, change, ${JSON.stringify(decisionId)},`,
    `  ${JSON.stringify(replacementId)}, ${JSON.stringify(reason)}, ${JSON.stringify(sourceRefs)},`,
    `);`,
  ]);
}

function crashFlowMigrationAtStage(
  repoRoot: string,
  changeId: string,
  stage: 'FLOW_MUTATION_TARGET_WRITTEN',
): number | null {
  return crashSemanticScript(repoRoot, changeId, stage, [
    `const { migrateLegacyFlow } = await import(${JSON.stringify(new URL('../src/core/flow-store.js', import.meta.url).href)});`,
    `await migrateLegacyFlow(${JSON.stringify(repoRoot)}, change, []);`,
  ]);
}

function crashFlowSynchronizeAtStage(
  repoRoot: string,
  changeId: string,
  stage: 'FLOW_MUTATION_TARGET_WRITTEN',
): number | null {
  return crashSemanticScript(repoRoot, changeId, stage, [
    `const { listDecisions } = await import(${JSON.stringify(new URL('../src/core/decisions.js', import.meta.url).href)});`,
    `const { synchronizeFlowDecisions } = await import(${JSON.stringify(new URL('../src/core/flow-store.js', import.meta.url).href)});`,
    `const decisions = await listDecisions(${JSON.stringify(repoRoot)}, change);`,
    `await synchronizeFlowDecisions(${JSON.stringify(repoRoot)}, change, decisions);`,
  ]);
}

function crashFlowSourceAtStage(
  repoRoot: string,
  changeId: string,
  proposal: FlowAssessmentProposal,
  stage: 'FLOW_MUTATION_TARGET_WRITTEN',
): number | null {
  return crashSemanticScript(repoRoot, changeId, stage, [
    `const { applyFlowAssessment } = await import(${JSON.stringify(new URL('../src/core/flow-assessment.js', import.meta.url).href)});`,
    `await applyFlowAssessment(${JSON.stringify(repoRoot)}, change, ${JSON.stringify(proposal)});`,
  ]);
}

function crashSemanticScript(
  repoRoot: string,
  changeId: string,
  stage: string,
  operation: readonly string[],
): number | null {
  const storeModule = new URL('../src/core/store.js', import.meta.url).href;
  const script = [
    `import { channel } from 'node:diagnostics_channel';`,
    `channel('omnai:core:change-mutation').subscribe((message) => {`,
    `  if (message.stage === ${JSON.stringify(stage)}) process.exit(91);`,
    `});`,
    `const { resolveChange } = await import(${JSON.stringify(storeModule)});`,
    `const change = await resolveChange(${JSON.stringify(repoRoot)}, ${JSON.stringify(changeId)});`,
    ...operation,
  ].join('\n');
  return spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'pipe'],
  }).status;
}

async function semanticTransactionPathForOperation(
  repoRoot: string,
  change: Awaited<ReturnType<typeof createChange>>,
  operation: string,
): Promise<string> {
  const root = changeRevisionsRoot(repoRoot, change.directoryName);
  for (const file of (await readdir(root)).filter((name) => name.endsWith('.semantic-mutation.yaml')).sort()) {
    const path = join(root, file);
    const transaction = await readYaml(path, semanticMutationTransactionSchema);
    if ('operation' in transaction.request && transaction.request.operation === operation) return path;
  }
  throw new Error(`missing semantic transaction for ${operation}`);
}

async function semanticTransactionPathForKind(
  repoRoot: string,
  change: Awaited<ReturnType<typeof createChange>>,
  kind: 'SCENARIO_RECLASSIFY',
): Promise<string> {
  const root = changeRevisionsRoot(repoRoot, change.directoryName);
  for (const file of (await readdir(root)).filter((name) => name.endsWith('.semantic-mutation.yaml')).sort()) {
    const path = join(root, file);
    const transaction = await readYaml(path, semanticMutationTransactionSchema);
    if (transaction.kind === kind) return path;
  }
  throw new Error(`missing semantic transaction for ${kind}`);
}

async function downgradeDecisionSemanticHistoryToLegacy(
  repoRoot: string,
  change: Awaited<ReturnType<typeof createChange>>,
): Promise<void> {
  const revisionsRoot = changeRevisionsRoot(repoRoot, change.directoryName);
  const files = await readdir(revisionsRoot);
  for (const file of files) {
    if (file.endsWith('.semantic-mutation.yaml')) await rm(join(revisionsRoot, file));
  }
  const progressPath = changeArtifactPath(repoRoot, change.directoryName, 'progress.jsonl');
  const events = await readJsonLines<{ data?: Record<string, unknown> }>(progressPath);
  const legacyEvents = events.map((event) => {
    if (!event.data || !('semanticMutationId' in event.data)) return event;
    const data = { ...event.data };
    delete data.semanticMutationId;
    return { ...event, data };
  });
  await writeTextAtomic(progressPath, `${legacyEvents.map((event) => JSON.stringify(event)).join('\n')}\n`);
}

function crashOrdinaryAtIntent(repoRoot: string, changeId: string): number | null {
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
    `await reconcileChange(${JSON.stringify(repoRoot)}, change, {`,
    `  level: 'L0', type: 'IMPLEMENTATION_CHANGED', reason: 'Leave a durable ordinary owner',`,
    `});`,
  ].join('\n');
  return spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'pipe'],
  }).status;
}

function crashScenarioAtStage(
  repoRoot: string,
  changeId: string,
  scenario: string,
  reason: string,
  stage:
    | 'SCENARIO_RECLASSIFY_INTENT_WRITTEN'
    | 'SCENARIO_RECLASSIFY_ARTIFACTS_ENSURED'
    | 'SCENARIO_RECLASSIFY_RECONCILE_COMPLETED',
): number | null {
  const storeModule = new URL('../src/core/store.js', import.meta.url).href;
  const reclassifyModule = new URL('../src/core/reclassify.js', import.meta.url).href;
  const script = [
    `import { channel } from 'node:diagnostics_channel';`,
    `channel('omnai:core:change-mutation').subscribe((message) => {`,
    `  if (message.stage === ${JSON.stringify(stage)}) process.exit(91);`,
    `});`,
    `const { resolveChange } = await import(${JSON.stringify(storeModule)});`,
    `const { reclassifyChange } = await import(${JSON.stringify(reclassifyModule)});`,
    `const change = await resolveChange(${JSON.stringify(repoRoot)}, ${JSON.stringify(changeId)});`,
    `await reclassifyChange(`,
    `  ${JSON.stringify(repoRoot)}, change, ${JSON.stringify(scenario)}, ${JSON.stringify(reason)},`,
    `);`,
  ].join('\n');
  return spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'pipe'],
  }).status;
}

async function durableDirectorySnapshot(root: string): Promise<Array<{ path: string; bytes: string | null }>> {
  const snapshot: Array<{ path: string; bytes: string | null }> = [];
  async function visit(directory: string, relative: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const child = relative ? join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) {
        snapshot.push({ path: `${child}/`, bytes: null });
        await visit(path, child);
      } else {
        snapshot.push({ path: child, bytes: await readFile(path, 'utf8') });
      }
    }
  }
  await visit(root, '');
  return snapshot;
}
