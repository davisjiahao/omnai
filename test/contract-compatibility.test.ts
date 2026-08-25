import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashObject } from '../src/execution/hashing.js';
import { createRunPacket, persistRunPacket } from '../src/execution/packets.js';
import { ensureExecutionLayout, runPacketPath } from '../src/execution/paths.js';
import {
  classifyContractCompatibility,
  compareContractSnapshots,
  findContractReferences,
  revalidateContractChange,
  type CompatibilityDecision,
  type CompatibilityImpactInventory,
  type CompatibilityMutationReceipt,
  type ContractCompatibilityContext,
  type ContractReference,
  type RevalidationResult,
} from '../src/execution/contracts/compatibility.js';
import type { ContractCandidate } from '../src/execution/artifacts.js';
import type { ContractSnapshot } from '../src/execution/contracts/store.js';
import type { ContentHash, ScopedTaskRef, TestCaseRef } from '../src/execution/types.js';
import { createTestDirectory } from './helpers.js';

const NOW = '2026-08-23T00:00:00.000Z';
const SCOPE_HASH = hashObject('authorization-scope');
const OLD_CONTRACT_HASH = hashObject('authorization-contract-v1');
const NEW_CONTRACT_HASH = hashObject('authorization-contract-v2');
const TEST_CASE_HASH = hashObject('contract-case');
const PLAN_HASH = hashObject('verification-plan');
const ENVIRONMENT_INPUT_HASH = hashObject('environment-input');

function persistedCompatibilityEvidence(
  reference: ContractReference,
  previous: ContractSnapshot,
  current: ContractSnapshot,
  id: string,
  status: 'PASS' | 'FAIL' | 'INCONCLUSIVE' = 'PASS',
) {
  assert.ok(reference.commit);
  const caseRef: TestCaseRef = {
    id: 'TC-0999',
    scope: {
      kind: 'CONTRACT',
      worksetId: 'WKS-0001',
      contractKey: current.manifest.contractKey,
      scopeHash: current.manifest.scopeHash,
      contractSnapshot: { id: current.manifest.id, contentHash: current.manifest.contentHash },
      scenarioId: reference.usedScenarios[0] ?? 'SC-authorization',
    },
    contentHash: hashObject(`compatibility-case:${reference.project}`),
  };
  return {
    schemaVersion: 1 as const,
    runId: reference.runId,
    packetHash: hashObject(`packet:${reference.runId}`),
    id,
    status,
    verificationPlan: { id: 'VPL-0999', contentHash: hashObject('compatibility-plan') },
    testCaseRefs: [caseRef],
    caseOutcomes: status === 'PASS'
      ? [{ caseRef, status: 'PASS' as const }]
      : [{ caseRef, status, detail: 'compatibility outcome requires review' }],
    contractRefs: [
      { id: previous.manifest.id, contentHash: previous.manifest.contentHash },
      { id: current.manifest.id, contentHash: current.manifest.contentHash },
    ],
    command: { commandRef: 'compatibility:validate', contentHash: hashObject('compatibility-command') },
    exitCode: status === 'PASS' ? 0 : 1,
    outputHash: hashObject(`compatibility-output:${id}`),
    artifactHashes: [],
    startedAt: NOW,
    finishedAt: NOW,
    verifier: { kind: 'CORE' as const, id: 'core:contract-compatibility' },
    subject: {
      kind: 'COMPATIBILITY' as const,
      contractSnapshot: { id: current.manifest.id, contentHash: current.manifest.contentHash },
      project: reference.project,
      commit: reference.commit,
    },
  };
}

const quoteTask: ScopedTaskRef = {
  project: 'quote',
  changeId: 'CHG-0001',
  revision: 'REV-0001',
  baseline: 'BL-0001',
  taskId: 'TASK-001',
};

const orderTask: ScopedTaskRef = {
  project: 'order',
  changeId: 'CHG-0002',
  revision: 'REV-0002',
  baseline: 'BL-0002',
  taskId: 'TASK-002',
};

interface FixtureOptions {
  readonly delta:
    | 'OPTIONAL_FIELD_ADDED'
    | 'REQUIRED_FIELD_RENAMED'
    | 'AMBIGUOUS_BUSINESS_OUTCOME'
    | 'FAILURE_OUTCOME_CHANGED';
  readonly validators?: 'PASS';
  readonly usedBy?: readonly string[];
  readonly unusedBy?: readonly string[];
  readonly activeRun?: string;
  readonly activeUnrelatedProject?: string;
}

test('compatible additive change keeps commits and records fresh compatibility evidence', async () => {
  const fixture = createCompatibilityFixture({ delta: 'OPTIONAL_FIELD_ADDED', validators: 'PASS' });
  const before = fixture.commitShas();

  const result = await revalidateContractChange(fixture.context, fixture.oldId, fixture.newId);

  assert.deepEqual(result.compatibleProjects, ['order', 'quote']);
  assert.deepEqual(fixture.commitShas(), before);
  assert.equal(result.recoveryRuns.length, 0);
  assert.deepEqual(fixture.compatibilityEvidenceProjects(), ['order', 'quote']);
});

test('an identical retry replays the committed mutation result without duplicate writes', async () => {
  const fixture = createCompatibilityFixture({ delta: 'OPTIONAL_FIELD_ADDED' });

  const first = await revalidateContractChange(fixture.context, fixture.oldId, fixture.newId);
  const second = await revalidateContractChange(fixture.context, fixture.oldId, fixture.newId);

  assert.deepEqual(second, first);
  assert.deepEqual(fixture.compatibilityEvidenceProjects(), ['order', 'quote']);
});

test('a committed journal replays after an active reference later integrates', async () => {
  const fixture = createCompatibilityFixture({
    activeRun: 'quote',
    delta: 'OPTIONAL_FIELD_ADDED',
  });
  const first = await revalidateContractChange(fixture.context, fixture.oldId, fixture.newId);
  const evolved: ContractCompatibilityContext = {
    ...fixture.context,
    loadContractSnapshot: async (id) => id === fixture.oldId
      ? { ...fixture.oldSnapshot, manifest: { ...fixture.oldSnapshot.manifest, status: 'SUPERSEDED' } }
      : { ...fixture.newSnapshot, manifest: { ...fixture.newSnapshot.manifest, status: 'SUPERSEDED' } },
    listContractReferences: async () => fixture.references.map((reference) =>
      reference.runId === 'RUN-0001' ? { ...reference, commit: 'a'.repeat(40) } : reference),
    loadRunState: async (id) => {
      const state = await fixture.context.loadRunState!(id) as { status: string };
      return id === 'RUN-0001' ? { ...state, status: 'INTEGRATED' } : state;
    },
  };

  const replay = await revalidateContractChange(evolved, fixture.oldId, fixture.newId);

  assert.deepEqual(replay, first);
});

test('a coherently rehashed forged replay projection is rejected', async () => {
  const fixture = createCompatibilityFixture({ delta: 'OPTIONAL_FIELD_ADDED' });
  const valid = await revalidateContractChange(fixture.context, fixture.oldId, fixture.newId);
  const { contentHash: _oldHash, ...validIdentity } = valid;
  const forgedIdentity = { ...validIdentity, compatibleProjects: ['forged-project'] };
  const forged: RevalidationResult = {
    ...forgedIdentity,
    contentHash: hashObject(forgedIdentity),
  };
  const context: ContractCompatibilityContext = {
    ...fixture.context,
    loadCompatibilityMutationResult: async () => forged,
  };

  await assert.rejects(
    () => revalidateContractChange(context, fixture.oldId, fixture.newId),
    /COMPATIBILITY_MUTATION_REPLAY_INVALID/,
  );
});

test('an incompatible retry revalidates persisted patch and Recovery receipts without duplicate writes', async () => {
  const fixture = createCompatibilityFixture({
    activeRun: 'quote',
    delta: 'REQUIRED_FIELD_RENAMED',
    usedBy: ['quote'],
    unusedBy: ['order'],
  });

  const first = await revalidateContractChange(fixture.context, fixture.oldId, fixture.newId);
  const second = await revalidateContractChange(fixture.context, fixture.oldId, fixture.newId);

  assert.deepEqual(second, first);
  assert.equal(second.preservedPatches.length, 1);
  assert.equal(fixture.recoveryRuns().length, 1);
});

test('a coherently rehashed replay cannot omit required patch and Recovery receipts', async () => {
  const fixture = createCompatibilityFixture({
    activeRun: 'quote',
    delta: 'REQUIRED_FIELD_RENAMED',
    usedBy: ['quote'],
    unusedBy: ['order'],
  });
  const valid = await revalidateContractChange(fixture.context, fixture.oldId, fixture.newId);
  const { contentHash: _oldHash, ...validIdentity } = valid;
  const forgedIdentity = {
    ...validIdentity,
    recoveryRuns: [],
    preservedPatches: [],
    preservedPatchRefs: [],
  };
  const forged: RevalidationResult = {
    ...forgedIdentity,
    contentHash: hashObject(forgedIdentity),
  };
  const context: ContractCompatibilityContext = {
    ...fixture.context,
    loadCompatibilityMutationResult: async () => forged,
  };

  await assert.rejects(
    () => revalidateContractChange(context, fixture.oldId, fixture.newId),
    /COMPATIBILITY_MUTATION_REPLAY_INVALID/,
  );
});

test('the journal receipt rejects a coherently forged historical RunState and mutation plan', async () => {
  const fixture = createCompatibilityFixture({
    activeRun: 'quote',
    delta: 'REQUIRED_FIELD_RENAMED',
    usedBy: ['quote'],
    unusedBy: ['order'],
  });
  const valid = await revalidateContractChange(fixture.context, fixture.oldId, fixture.newId);
  const forgedRunStates = valid.readSet.runStates.map((entry) => {
    if (entry.id !== 'RUN-0001') return entry;
    const state = { ...entry.state, status: 'FAILED' as const };
    return { ...entry, state, contentHash: hashObject(state) };
  });
  const { contentHash: _oldReadSetHash, ...readSetIdentity } = valid.readSet;
  const forgedReadSetIdentity = { ...readSetIdentity, runStates: forgedRunStates };
  const forgedReadSet = {
    ...forgedReadSetIdentity,
    contentHash: hashObject(forgedReadSetIdentity),
  };
  const { contentHash: _oldPlanHash, ...planIdentity } = valid.mutationPlan;
  const forgedPlanIdentity = { ...planIdentity, patchRunIds: [], recoveries: [] };
  const forgedPlan = { ...forgedPlanIdentity, contentHash: hashObject(forgedPlanIdentity) };
  const { contentHash: _oldResultHash, ...validIdentity } = valid;
  const forgedIdentity = {
    ...validIdentity,
    mutationIdentity: {
      ...valid.mutationIdentity,
      readSetHash: forgedReadSet.contentHash,
    },
    readSet: forgedReadSet,
    mutationPlan: forgedPlan,
    recoveryRuns: [],
    preservedPatches: [],
    preservedPatchRefs: [],
  };
  const forged: RevalidationResult = {
    ...forgedIdentity,
    contentHash: hashObject(forgedIdentity),
  };
  const context: ContractCompatibilityContext = {
    ...fixture.context,
    loadCompatibilityMutationResult: async () => forged,
  };

  await assert.rejects(
    () => revalidateContractChange(context, fixture.oldId, fixture.newId),
    /COMPATIBILITY_MUTATION_REPLAY_INVALID/,
  );
});

test('a coherently rehashed replay cannot omit a reference decision and its evidence', async () => {
  const fixture = createCompatibilityFixture({ delta: 'OPTIONAL_FIELD_ADDED' });
  const valid = await revalidateContractChange(fixture.context, fixture.oldId, fixture.newId);
  const { contentHash: _oldHash, ...validIdentity } = valid;
  const forgedDecisions = valid.decisions.filter((item) => item.project !== 'order');
  const forgedEvidence = valid.compatibilityEvidenceRefs.filter((id) => {
    const orderEvidence = valid.compatibilityEvidenceRefs[0];
    return id !== orderEvidence;
  });
  const forgedIdentity = {
    ...validIdentity,
    decisions: forgedDecisions,
    compatibleProjects: ['quote'],
    compatibilityEvidenceRefs: forgedEvidence,
  };
  const forged: RevalidationResult = {
    ...forgedIdentity,
    contentHash: hashObject(forgedIdentity),
  };
  const context: ContractCompatibilityContext = {
    ...fixture.context,
    loadCompatibilityMutationResult: async () => forged,
  };

  await assert.rejects(
    () => revalidateContractChange(context, fixture.oldId, fixture.newId),
    /COMPATIBILITY_MUTATION_REPLAY_INVALID/,
  );
});

test('a Run integrated before lock acquisition invalidates the read set and is reclassified after retry', async () => {
  const fixture = createCompatibilityFixture({
    activeRun: 'quote',
    delta: 'REQUIRED_FIELD_RENAMED',
    usedBy: ['quote'],
    unusedBy: ['order'],
  });
  let integrated = false;
  let transactionEntries = 0;
  const context: ContractCompatibilityContext = {
    ...fixture.context,
    withCompatibilityMutationTransaction: async (_identity, apply) => {
      transactionEntries += 1;
      return apply();
    },
    listContractReferences: async () => fixture.references.map((reference) =>
      integrated && reference.runId === 'RUN-0001'
        ? { ...reference, commit: 'a'.repeat(40) }
        : reference),
    loadRunState: async (id) => {
      const state = await fixture.context.loadRunState!(id) as { status: string };
      return integrated && id === 'RUN-0001' ? { ...state, status: 'INTEGRATED' } : state;
    },
    assertCompatibilityReadSetCurrent: async () => {
      if (!integrated) {
        integrated = true;
        return false;
      }
      return true;
    },
    captureUncommittedRunPatch: async () => {
      throw new Error('STALE_UNCOMMITTED_BRANCH_USED');
    },
  };

  const result = await revalidateContractChange(context, fixture.oldId, fixture.newId);

  assert.equal(transactionEntries, 2);
  assert.deepEqual(result.preservedPatchRefs, []);
  assert.deepEqual(result.recoveryRuns.map((run) => run.parentRunId), ['RUN-0001']);
});

test('a stale read-set retry reuses immutable Resolver classifications', async () => {
  const fixture = createCompatibilityFixture({ delta: 'AMBIGUOUS_BUSINESS_OUTCOME' });
  let readSetChecks = 0;
  let resolverCalls = 0;
  const evidenceStore = new Map<string, unknown>();
  const context: ContractCompatibilityContext = {
    ...fixture.context,
    assertCompatibilityReadSetCurrent: async () => {
      readSetChecks += 1;
      return readSetChecks > 1;
    },
    runCompatibilityValidators: async ({ previous, current, reference }) => {
      const evidence = persistedCompatibilityEvidence(
        reference,
        previous,
        current,
        reference.project === 'order' ? 'EVD-4101' : 'EVD-4102',
        'INCONCLUSIVE',
      );
      evidenceStore.set(evidence.id, evidence);
      return [{
        status: 'INCONCLUSIVE',
        evidenceRef: evidence.id,
        evidence,
        previous: { id: previous.manifest.id, contentHash: previous.manifest.contentHash },
        current: { id: current.manifest.id, contentHash: current.manifest.contentHash },
        project: reference.project,
        usedElements: reference.usedElements,
        usedScenarios: reference.usedScenarios,
      }];
    },
    loadVerificationEvidence: async (id) => evidenceStore.get(id),
    runCompatibilityResolver: async ({ evidence }) => {
      resolverCalls += 1;
      return { selectedEvidenceRefs: [evidence[0]!.evidenceRef] };
    },
  };

  await revalidateContractChange(context, fixture.oldId, fixture.newId);

  assert.equal(readSetChecks, 2);
  assert.equal(resolverCalls, fixture.references.length);
});

test('a retry after final-transaction interruption replays persisted Resolver classifications', async () => {
  const fixture = createCompatibilityFixture({ delta: 'AMBIGUOUS_BUSINESS_OUTCOME' });
  let resolverCalls = 0;
  const evidenceStore = new Map<string, unknown>();
  const classificationContext: ContractCompatibilityContext = {
    ...fixture.context,
    runCompatibilityValidators: async ({ previous, current, reference }) => {
      const evidence = persistedCompatibilityEvidence(
        reference,
        previous,
        current,
        reference.project === 'order' ? 'EVD-4201' : 'EVD-4202',
        'INCONCLUSIVE',
      );
      evidenceStore.set(evidence.id, evidence);
      return [{
        status: 'INCONCLUSIVE',
        evidenceRef: evidence.id,
        evidence,
        previous: { id: previous.manifest.id, contentHash: previous.manifest.contentHash },
        current: { id: current.manifest.id, contentHash: current.manifest.contentHash },
        project: reference.project,
        usedElements: reference.usedElements,
        usedScenarios: reference.usedScenarios,
      }];
    },
    loadVerificationEvidence: async (id) => evidenceStore.get(id),
    runCompatibilityResolver: async ({ evidence }) => {
      resolverCalls += 1;
      return { selectedEvidenceRefs: [evidence[0]!.evidenceRef] };
    },
  };
  const interrupted: ContractCompatibilityContext = {
    ...classificationContext,
    withCompatibilityMutationTransaction: async () => {
      throw new Error('SIMULATED_FINAL_TRANSACTION_INTERRUPTION');
    },
  };

  await assert.rejects(
    () => revalidateContractChange(interrupted, fixture.oldId, fixture.newId),
    /SIMULATED_FINAL_TRANSACTION_INTERRUPTION/,
  );
  await revalidateContractChange(classificationContext, fixture.oldId, fixture.newId);

  assert.equal(resolverCalls, fixture.references.length);
});

test('operation identities prevent duplicate Resolver Runs across a classification commit crash', async () => {
  const fixture = createCompatibilityFixture({ delta: 'AMBIGUOUS_BUSINESS_OUTCOME' });
  const validatorResults = new Map<string, readonly unknown[]>();
  const resolverResults = new Map<string, unknown>();
  const evidenceStore = new Map<string, unknown>();
  let resolverRuns = 0;
  let interruptNextClassificationCommit = true;
  const context: ContractCompatibilityContext = {
    ...fixture.context,
    runCompatibilityValidators: async ({ previous, current, reference, operationIdentity }) => {
      const replay = validatorResults.get(operationIdentity);
      if (replay !== undefined) return replay;
      const evidence = persistedCompatibilityEvidence(
        reference,
        previous,
        current,
        reference.project === 'order' ? 'EVD-4301' : 'EVD-4302',
        'INCONCLUSIVE',
      );
      evidenceStore.set(evidence.id, evidence);
      const result = [{
        status: 'INCONCLUSIVE' as const,
        evidenceRef: evidence.id,
        evidence,
        previous: { id: previous.manifest.id, contentHash: previous.manifest.contentHash },
        current: { id: current.manifest.id, contentHash: current.manifest.contentHash },
        project: reference.project,
        usedElements: reference.usedElements,
        usedScenarios: reference.usedScenarios,
      }];
      validatorResults.set(operationIdentity, result);
      return result;
    },
    loadVerificationEvidence: async (id) => evidenceStore.get(id),
    runCompatibilityResolver: async ({ evidence, operationIdentity }) => {
      const replay = resolverResults.get(operationIdentity);
      if (replay !== undefined) return replay;
      resolverRuns += 1;
      const result = { selectedEvidenceRefs: [evidence[0]!.evidenceRef] };
      resolverResults.set(operationIdentity, result);
      return result;
    },
    withCompatibilityClassificationTransaction: async (identity, apply) => {
      const replay = await fixture.context.loadCompatibilityClassificationResult!(identity);
      if (replay !== null) return replay;
      const result = await apply();
      if (interruptNextClassificationCommit) {
        interruptNextClassificationCommit = false;
        throw new Error('SIMULATED_CLASSIFICATION_COMMIT_CRASH');
      }
      return fixture.context.withCompatibilityClassificationTransaction!(identity, async () => result);
    },
  };

  await assert.rejects(
    () => revalidateContractChange(context, fixture.oldId, fixture.newId),
    /SIMULATED_CLASSIFICATION_COMMIT_CRASH/,
  );
  await revalidateContractChange(context, fixture.oldId, fixture.newId);

  assert.equal(resolverRuns, fixture.references.length);
});

test('incompatible change preserves the old commit and creates only affected repair Runs', async () => {
  const fixture = createCompatibilityFixture({
    delta: 'REQUIRED_FIELD_RENAMED',
    usedBy: ['quote'],
    unusedBy: ['order'],
  });
  const before = fixture.commitShas();

  const result = await revalidateContractChange(fixture.context, fixture.oldId, fixture.newId);

  assert.deepEqual(result.incompatibleProjects, ['quote']);
  assert.deepEqual(result.recoveryRuns.map((item) => item.project), ['quote']);
  assert.deepEqual(fixture.commitShas(), before);
  assert.equal(fixture.taskStatus('order'), 'DONE');
});

test('incompatible references create one repair Run for every affected task in the same project', async () => {
  const fixture = createCompatibilityFixture({
    delta: 'REQUIRED_FIELD_RENAMED',
    usedBy: ['quote'],
    unusedBy: ['order'],
  });
  const quote = fixture.references.find((item) => item.project === 'quote')!;
  const secondQuote: ContractReference = {
    ...quote,
    taskId: 'TASK-003',
    runId: 'RUN-0003',
    commit: 'c'.repeat(40),
  };
  const context: ContractCompatibilityContext = {
    ...fixture.context,
    listContractReferences: async () => [...fixture.references, secondQuote],
    loadCompatibilityImpactInventory: async () => {
      const inventory = impactInventory(fixture.oldId);
      return {
        ...inventory,
        tasks: [...inventory.tasks, {
          scopedTask: {
            project: secondQuote.project,
            changeId: secondQuote.changeId,
            revision: secondQuote.revision,
            baseline: secondQuote.baseline,
            taskId: secondQuote.taskId,
          },
          contentHash: hashObject({
            project: secondQuote.project,
            changeId: secondQuote.changeId,
            revision: secondQuote.revision,
            baseline: secondQuote.baseline,
            taskId: secondQuote.taskId,
          }),
          sourceRefs: [],
          contractRefs: [{ id: fixture.oldId, contentHash: OLD_CONTRACT_HASH }],
        }],
        runs: [...inventory.runs, {
          id: secondQuote.runId,
          contentHash: hashObject('second-quote-run'),
          scopedTask: {
            project: secondQuote.project,
            changeId: secondQuote.changeId,
            revision: secondQuote.revision,
            baseline: secondQuote.baseline,
            taskId: secondQuote.taskId,
          },
          testCaseRefs: [],
          contractRefs: [{ id: fixture.oldId, contentHash: OLD_CONTRACT_HASH }],
        }],
        commitSets: [...inventory.commitSets, {
          id: 'CST-0003',
          contentHash: hashObject('second-quote-commit-set'),
          memberRunIds: [secondQuote.runId],
          environmentInputRefs: [],
          contractRefs: [{ id: fixture.oldId, contentHash: OLD_CONTRACT_HASH }],
        }],
      };
    },
  };

  const result = await revalidateContractChange(context, fixture.oldId, fixture.newId);

  assert.equal(result.decisions.filter((item) => item.project === 'quote').length, 2);
  assert.deepEqual(result.recoveryRuns.map((item) => item.project), ['quote', 'quote']);
  assert.deepEqual(result.recoveryRuns.map((item) => [
    item.kind,
    item.scopedTask.taskId,
    item.parentRunId,
  ]), [
    ['RECOVERY_WRITER', 'TASK-001', 'RUN-0001'],
    ['RECOVERY_WRITER', 'TASK-003', 'RUN-0003'],
  ]);
});

test('a Recovery receipt linked to a different task is rejected', async () => {
  const fixture = createCompatibilityFixture({
    delta: 'REQUIRED_FIELD_RENAMED',
    usedBy: ['quote'],
    unusedBy: ['order'],
  });
  const context: ContractCompatibilityContext = {
    ...fixture.context,
    createRecoveryRun: async (input) => {
      const receipt = await fixture.context.createRecoveryRun!(input) as {
        runId: string;
        project: string;
        kind: 'RECOVERY_WRITER';
        parentRunId: string;
        scopedTask: ScopedTaskRef;
        decisionFingerprint: ContentHash;
        packetHash: ContentHash;
      };
      return { ...receipt, scopedTask: { ...receipt.scopedTask, taskId: 'TASK-999' } };
    },
  };

  await assert.rejects(
    () => revalidateContractChange(context, fixture.oldId, fixture.newId),
    /RECOVERY_RUN_LINKAGE_MISMATCH:TASK-001/,
  );
});

test('unresolved business semantics creates one decision while unrelated workers continue', async () => {
  const fixture = createCompatibilityFixture({
    delta: 'AMBIGUOUS_BUSINESS_OUTCOME',
    usedBy: ['quote'],
    unusedBy: ['order'],
    activeUnrelatedProject: 'user',
  });

  const result = await revalidateContractChange(fixture.context, fixture.oldId, fixture.newId);

  assert.deepEqual(result.unresolvedProjects, ['quote']);
  assert.equal(result.attentionItems.length, 1);
  assert.equal(fixture.workerStillRunning('user'), true);
});

test('an unresolved Attention must be read back from the Core store', async () => {
  const fixture = createCompatibilityFixture({
    delta: 'AMBIGUOUS_BUSINESS_OUTCOME',
    usedBy: ['quote'],
    unusedBy: ['order'],
  });
  const context: ContractCompatibilityContext = {
    ...fixture.context,
    loadCompatibilityAttention: async () => undefined,
  };

  await assert.rejects(
    () => revalidateContractChange(context, fixture.oldId, fixture.newId),
    /invalid_type|COMPATIBILITY_ATTENTION/,
  );
});

test('an active Run packet remains bound to its old hash and becomes STALE rather than mutated', async () => {
  const fixture = createCompatibilityFixture({
    activeRun: 'quote',
    delta: 'REQUIRED_FIELD_RENAMED',
    usedBy: ['quote'],
    unusedBy: ['order'],
  });
  const packetBefore = fixture.packet('quote');

  await revalidateContractChange(fixture.context, fixture.oldId, fixture.newId);

  assert.deepEqual(fixture.packet('quote'), packetBefore);
  assert.equal(fixture.runStatus('quote'), 'STALE');
});

test('an incompatible uncommitted Run captures its patch before stale and recovery mutations', async () => {
  const fixture = createCompatibilityFixture({
    activeRun: 'quote',
    delta: 'REQUIRED_FIELD_RENAMED',
    usedBy: ['quote'],
    unusedBy: ['order'],
  });
  const quote = fixture.references.find((item) => item.project === 'quote')!;
  const { commit: _withoutCommit, ...uncommittedQuote } = quote;
  const order = fixture.references.find((item) => item.project === 'order')!;
  const operations: string[] = [];
  const context: ContractCompatibilityContext = {
    ...fixture.context,
    listContractReferences: async () => [uncommittedQuote, order],
    captureUncommittedRunPatch: async ({ reference }) => {
      operations.push(`capture:${reference.runId}`);
      return {
        runId: reference.runId,
        patchRef: `runs/${reference.runId}/evidence/pre-revalidation.patch`,
        contentHash: hashObject('quote-uncommitted-patch'),
      };
    },
    loadCapturedRunPatch: async (receipt) => receipt,
    markRunStale: async (input) => {
      operations.push(`stale:${input.reference.runId}`);
      await fixture.context.markRunStale!(input);
    },
    createRecoveryRun: async (input) => {
      operations.push(`recovery:${input.reference.runId}`);
      return fixture.context.createRecoveryRun!(input);
    },
  };

  const result = await revalidateContractChange(context, fixture.oldId, fixture.newId);

  assert.deepEqual(operations, ['capture:RUN-0001', 'stale:RUN-0001', 'recovery:RUN-0001']);
  assert.deepEqual(result.preservedPatchRefs, ['runs/RUN-0001/evidence/pre-revalidation.patch']);
});

test('an escaped patch receipt is rejected before stale or recovery mutation', async () => {
  const fixture = createCompatibilityFixture({
    activeRun: 'quote',
    delta: 'REQUIRED_FIELD_RENAMED',
    usedBy: ['quote'],
    unusedBy: ['order'],
  });
  const quote = fixture.references.find((item) => item.project === 'quote')!;
  const { commit: _withoutCommit, ...uncommittedQuote } = quote;
  const order = fixture.references.find((item) => item.project === 'order')!;
  const context: ContractCompatibilityContext = {
    ...fixture.context,
    listContractReferences: async () => [uncommittedQuote, order],
    captureUncommittedRunPatch: async ({ reference }) => ({
      runId: reference.runId,
      patchRef: `runs/${reference.runId}/evidence/../escape.patch`,
      contentHash: hashObject('escaped-patch'),
    }),
  };

  await assert.rejects(
    () => revalidateContractChange(context, fixture.oldId, fixture.newId),
    /CAPTURED_PATCH_REF_OUTSIDE_RUN_EVIDENCE/,
  );
  assert.equal(fixture.runStatus('quote'), 'RUNNING');
  assert.deepEqual(fixture.recoveryRuns(), []);
});

test('an incompatible read-only Planner reference never captures a patch or creates Recovery work', async () => {
  const fixture = createCompatibilityFixture({
    delta: 'REQUIRED_FIELD_RENAMED',
    usedBy: ['quote'],
    unusedBy: ['order'],
  });
  const quote = fixture.references.find((item) => item.project === 'quote')!;
  const { commit: _withoutCommit, ...uncommitted } = quote;
  const planner: ContractReference = { ...uncommitted, runKind: 'PROJECT_TEST_PLANNER' };
  const order = fixture.references.find((item) => item.project === 'order')!;
  const { captureUncommittedRunPatch: _withoutPatchAuthority, ...base } = fixture.context;
  let plannerStaled = false;
  const context: ContractCompatibilityContext = {
    ...base,
    listContractReferences: async () => [planner, order],
    loadCompatibilityImpactInventory: async () => {
      const inventory = impactInventory(fixture.oldId);
      return {
        ...inventory,
        runs: inventory.runs.map((run) => run.id === planner.runId
          ? {
              id: run.id,
              contentHash: run.contentHash,
              testCaseRefs: run.testCaseRefs,
              contractRefs: run.contractRefs,
            }
          : run),
        commitSets: inventory.commitSets.filter((commitSet) =>
          !commitSet.memberRunIds.includes(planner.runId)),
      };
    },
    loadRunState: async (id) => id === planner.runId
      ? {
          schemaVersion: 1,
          machineVersion: 1,
          lastEventSequence: 0,
          lastEventHash: null,
          id,
          kind: 'PROJECT_TEST_PLANNER',
          worksetId: 'WKS-0001',
          status: 'FINISHED',
          packetHash: hashObject('quote-run'),
          evidenceRefs: [],
          createdAt: NOW,
          updatedAt: NOW,
        }
      : fixture.context.loadRunState!(id),
    markRunStale: async (input) => {
      if (input.reference.runId === planner.runId) plannerStaled = true;
      await fixture.context.markRunStale!(input);
    },
  };

  const result = await revalidateContractChange(context, fixture.oldId, fixture.newId);

  assert.deepEqual(result.incompatibleProjects, ['quote']);
  assert.deepEqual(result.preservedPatchRefs, []);
  assert.deepEqual(result.recoveryRuns, []);
  assert.equal(plannerStaled, true);
});

test('contract scenario change supersedes affected plans and exact-tuple environment evidence only', async () => {
  const fixture = createCompatibilityFixture({
    delta: 'FAILURE_OUTCOME_CHANGED',
    usedBy: ['quote'],
    unusedBy: ['order'],
  });

  const result = await revalidateContractChange(fixture.context, fixture.oldId, fixture.newId);

  assert.deepEqual(result.invalidatedVerificationPlans, ['VPL-0001']);
  assert.equal(result.invalidatedTestCases.length, 1);
  assert.match(result.invalidatedTestCases[0] ?? '', /TC-0001/);
  assert.equal(fixture.environmentEvidenceAuthoritative('IER-0001'), false);
  assert.equal(fixture.unrelatedProjectEvidencePreserved(), true);
});

test('same-named element and scenario uses from another contract do not invalidate a multi-contract TestCase', async () => {
  for (const delta of ['REQUIRED_FIELD_RENAMED', 'FAILURE_OUTCOME_CHANGED'] as const) {
  const fixture = createCompatibilityFixture({
    delta,
    usedBy: ['quote'],
    unusedBy: ['order'],
  });
  const otherContract = { id: 'CTR-9999', contentHash: hashObject('other-contract') };
  const extraCaseRef: TestCaseRef = {
    id: 'TC-0003',
    scope: {
      kind: 'CONTRACT',
      worksetId: 'WKS-0001',
      contractKey: 'multi-contract-check',
      scopeHash: hashObject('multi-contract-scope'),
      contractSnapshot: { id: fixture.oldId, contentHash: OLD_CONTRACT_HASH },
      scenarioId: 'SC-audit',
    },
    contentHash: hashObject('multi-contract-case'),
  };
  const context: ContractCompatibilityContext = {
    ...fixture.context,
    loadCompatibilityImpactInventory: async () => {
      const inventory = impactInventory(fixture.oldId);
      return {
        ...inventory,
        testCases: [...inventory.testCases, {
          ref: extraCaseRef,
          contentHash: extraCaseRef.contentHash,
          sourceRefs: [],
          scopedTasks: [orderTask],
          contractRefs: [
            { id: fixture.oldId, contentHash: OLD_CONTRACT_HASH },
            otherContract,
          ],
          elementUses: [
            { snapshot: { id: fixture.oldId, contentHash: OLD_CONTRACT_HASH }, id: 'audit-event' },
            { snapshot: otherContract, id: 'authorization-request' },
          ],
          scenarioUses: [
            { snapshot: { id: fixture.oldId, contentHash: OLD_CONTRACT_HASH }, id: 'SC-audit' },
            { snapshot: otherContract, id: 'SC-authorization' },
          ],
        }],
        verificationPlans: [...inventory.verificationPlans, {
          id: 'VPL-0003',
          contentHash: hashObject('multi-contract-plan'),
          contractRefs: [
            { id: fixture.oldId, contentHash: OLD_CONTRACT_HASH },
            otherContract,
          ],
          testCaseRefs: [extraCaseRef],
        }],
      };
    },
  };

  const result = await revalidateContractChange(context, fixture.oldId, fixture.newId);

  assert.equal(result.invalidatedTestCases.some((ref) => ref.includes('TC-0003')), false);
  assert.equal(result.invalidatedVerificationPlans.includes('VPL-0003'), false);
  }
});

test('semantic delta distinguishes optional additions from required-field replacement', () => {
  const additive = createCompatibilityFixture({ delta: 'OPTIONAL_FIELD_ADDED' });
  const breaking = createCompatibilityFixture({ delta: 'REQUIRED_FIELD_RENAMED' });

  const additiveDelta = compareContractSnapshots(additive.oldSnapshot, additive.newSnapshot);
  const breakingDelta = compareContractSnapshots(breaking.oldSnapshot, breaking.newSnapshot);

  assert.deepEqual(additiveDelta.elements.map((item) => [item.id, item.compatibility]), [
    ['authorization-request', 'ADDITIVE'],
  ]);
  assert.deepEqual(breakingDelta.elements.map((item) => [item.id, item.compatibility]), [
    ['authorization-request', 'BREAKING'],
  ]);
  assert.match(breakingDelta.elements[0]?.changedPaths.join(',') ?? '', /customerId|clientId|required/);
  assert.notEqual(additiveDelta.previous.contentHash, additiveDelta.current.contentHash);
});

test('semantic delta treats enum and numeric constraint narrowing as breaking', () => {
  const previous = snapshot('CTR-0001', null, OLD_CONTRACT_HASH, candidate({
    elements: [element('authorization-request', {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['ALLOW', 'DENY'] },
        retries: { type: 'number', minimum: 0, maximum: 5 },
      },
      required: ['mode'],
    })],
    expectedOutcome: 'authorization denial is returned without retry',
    scenarioClass: 'NORMAL',
  }));
  const current = snapshot('CTR-0002', 'CTR-0001', NEW_CONTRACT_HASH, candidate({
    elements: [element('authorization-request', {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['ALLOW'] },
        retries: { type: 'number', minimum: 1, maximum: 3 },
      },
      required: ['mode'],
    })],
    expectedOutcome: 'authorization denial is returned without retry',
    scenarioClass: 'NORMAL',
  }));

  const delta = compareContractSnapshots(previous, current);

  assert.equal(delta.elements[0]?.compatibility, 'BREAKING');
  assert.match(delta.elements[0]?.changedPaths.join(',') ?? '', /enum|minimum|maximum/);
});

test('semantic delta treats removal of enum and numeric bounds as additive widening', () => {
  const previous = snapshot('CTR-0001', null, OLD_CONTRACT_HASH, candidate({
    elements: [element('authorization-request', {
      type: 'string',
      enum: ['ALLOW'],
      minLength: 3,
      maxLength: 8,
    })],
    expectedOutcome: 'authorization denial is returned without retry',
    scenarioClass: 'NORMAL',
  }));
  const current = snapshot('CTR-0002', 'CTR-0001', NEW_CONTRACT_HASH, candidate({
    elements: [element('authorization-request', { type: 'string' })],
    expectedOutcome: 'authorization denial is returned without retry',
    scenarioClass: 'NORMAL',
  }));

  const delta = compareContractSnapshots(previous, current);

  assert.equal(delta.elements[0]?.compatibility, 'ADDITIVE');
});

test('order-only changes in required and enum sets do not create a semantic delta', () => {
  const previous = snapshot('CTR-0001', null, OLD_CONTRACT_HASH, candidate({
    elements: [element('authorization-request', {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['ALLOW', 'DENY'] } },
      required: ['mode', 'requestId'],
    })],
    expectedOutcome: 'authorization denial is returned without retry',
    scenarioClass: 'NORMAL',
  }));
  const current = snapshot('CTR-0002', 'CTR-0001', NEW_CONTRACT_HASH, candidate({
    elements: [element('authorization-request', {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['DENY', 'ALLOW'] } },
      required: ['requestId', 'mode'],
    })],
    expectedOutcome: 'authorization denial is returned without retry',
    scenarioClass: 'NORMAL',
  }));

  assert.deepEqual(compareContractSnapshots(previous, current).elements, []);
});

test('a changed fixture used by the reference is incompatible and targets its TestCase', async () => {
  const fixture = createCompatibilityFixture({ delta: 'OPTIONAL_FIELD_ADDED' });
  const previousCandidate = candidateWithFixture(oldCandidate(), hashObject('fixture-v1'));
  const currentCandidate = candidateWithFixture(oldCandidate(), hashObject('fixture-v2'));
  const previous = snapshot(fixture.oldId, null, OLD_CONTRACT_HASH, previousCandidate);
  const current = snapshot(fixture.newId, fixture.oldId, NEW_CONTRACT_HASH, currentCandidate);
  const context: ContractCompatibilityContext = {
    ...fixture.context,
    loadContractSnapshot: async (id) => id === fixture.oldId ? previous : current,
    loadReadyContractSnapshot: async (id) => id === fixture.oldId ? previous : current,
  };

  const result = await revalidateContractChange(context, fixture.oldId, fixture.newId);

  assert.deepEqual(result.incompatibleProjects, ['order', 'quote']);
  assert.equal(result.invalidatedTestCases.length, 1);
  assert.match(result.invalidatedTestCases[0] ?? '', /TC-0001/);
});

test('a compatibility policy change requires evidence or an explicit semantic decision', async () => {
  const fixture = createCompatibilityFixture({ delta: 'OPTIONAL_FIELD_ADDED' });
  const currentCandidate: ContractCandidate = {
    ...fixture.oldSnapshot.candidate,
    contract: {
      ...fixture.oldSnapshot.candidate.contract,
      compatibilityPolicy: {
        mode: 'BREAKING_ALLOWED',
        rules: ['new callers may omit authorization outcomes'],
      },
    },
  };
  const current = snapshot(fixture.newId, fixture.oldId, NEW_CONTRACT_HASH, currentCandidate);
  const context: ContractCompatibilityContext = {
    ...fixture.context,
    loadContractSnapshot: async (id) => id === fixture.oldId ? fixture.oldSnapshot : current,
  };
  const delta = compareContractSnapshots(fixture.oldSnapshot, current);

  const decision = await classifyContractCompatibility(context, delta, fixture.references[0]!);

  assert.equal(decision.disposition, 'UNRESOLVED');
});

test('reference discovery merges Core records and rejects a generic PASS without exact hash linkage', async () => {
  const fixture = createCompatibilityFixture({
    delta: 'REQUIRED_FIELD_RENAMED',
    usedBy: ['quote'],
    unusedBy: ['order'],
  });
  const quote = fixture.references.find((item) => item.project === 'quote')!;
  const { commit: _commit, ...quoteWithoutCommit } = quote;
  const context: ContractCompatibilityContext = {
    ...fixture.context,
    listContractReferences: async () => [{
      ...quoteWithoutCommit,
      usedElements: [],
      usedScenarios: ['SC-authorization'],
    }, {
      ...quote,
      usedElements: ['authorization-request'],
      usedScenarios: [],
    }],
    runCompatibilityValidators: async ({ previous, current, reference }) => {
      const evidence = persistedCompatibilityEvidence(reference, previous, current, 'EVD-3001');
      return [{
        status: 'PASS',
        evidenceRef: evidence.id,
        evidence,
        previous: { id: previous.manifest.id, contentHash: previous.manifest.contentHash },
        current: { id: fixture.newId, contentHash: hashObject('wrong-current-hash') },
        project: reference.project,
        usedElements: reference.usedElements,
        usedScenarios: reference.usedScenarios,
      }];
    },
  };

  const references = await findContractReferences(context, fixture.oldId);
  const delta = compareContractSnapshots(fixture.oldSnapshot, fixture.newSnapshot);
  const decision = await classifyContractCompatibility(context, delta, references[0]!);

  assert.equal(references.length, 1);
  assert.equal(references[0]?.commit, 'a'.repeat(40));
  assert.deepEqual(references[0]?.usedElements, ['authorization-request']);
  assert.deepEqual(references[0]?.usedScenarios, ['SC-authorization']);
  assert.equal(decision.disposition, 'INCOMPATIBLE');
  assert.equal(decision.evidenceRefs.includes('EVD-3001'), false);
});

test('custom reference discovery rejects hostile records before classification', async () => {
  const fixture = createCompatibilityFixture({ delta: 'OPTIONAL_FIELD_ADDED' });
  const hostile = {
    ...fixture.references[0]!,
    project: 'Quote',
    injectedAuthority: true,
  };
  const context: ContractCompatibilityContext = {
    ...fixture.context,
    listContractReferences: async () => [hostile as unknown as ContractReference],
  };

  await assert.rejects(
    () => findContractReferences(context, fixture.oldId),
    /CONTRACT_REFERENCE_INVALID/,
  );
});

test('duplicate reference records cannot disagree on an immutable commit', async () => {
  const fixture = createCompatibilityFixture({ delta: 'OPTIONAL_FIELD_ADDED' });
  const reference = fixture.references[0]!;
  const context: ContractCompatibilityContext = {
    ...fixture.context,
    listContractReferences: async () => [reference, { ...reference, commit: 'c'.repeat(40) }],
  };

  await assert.rejects(
    () => findContractReferences(context, fixture.oldId),
    /CONTRACT_REFERENCE_CONFLICT:commit/,
  );
});

test('a copied exact tuple without persisted VerificationEvidence cannot authorize PASS', async () => {
  const fixture = createCompatibilityFixture({
    delta: 'REQUIRED_FIELD_RENAMED',
    usedBy: ['quote'],
    unusedBy: ['order'],
  });
  const reference = fixture.references.find((item) => item.project === 'quote')!;
  const context: ContractCompatibilityContext = {
    ...fixture.context,
    runCompatibilityValidators: async ({ previous, current }) => {
      const evidence = persistedCompatibilityEvidence(reference, previous, current, 'EVD-3999');
      return [{
        status: 'PASS',
        evidenceRef: evidence.id,
        evidence,
        previous: { id: previous.manifest.id, contentHash: previous.manifest.contentHash },
        current: { id: current.manifest.id, contentHash: current.manifest.contentHash },
        project: reference.project,
        usedElements: reference.usedElements,
        usedScenarios: reference.usedScenarios,
      }];
    },
    loadVerificationEvidence: async () => {
      throw new Error('EVIDENCE_NOT_FOUND');
    },
  };

  await assert.rejects(
    () => classifyContractCompatibility(
      context,
      compareContractSnapshots(fixture.oldSnapshot, fixture.newSnapshot),
      reference,
    ),
    /COMPATIBILITY_EVIDENCE_NOT_PERSISTED:EVD-3999/,
  );
});

test('a persisted PASS for an unrelated scenario cannot authorize the reference use', async () => {
  const fixture = createCompatibilityFixture({
    delta: 'REQUIRED_FIELD_RENAMED',
    usedBy: ['quote'],
    unusedBy: ['order'],
  });
  const reference = fixture.references.find((item) => item.project === 'quote')!;
  const base = persistedCompatibilityEvidence(
    reference,
    fixture.oldSnapshot,
    fixture.newSnapshot,
    'EVD-4000',
  );
  const unrelatedCase: TestCaseRef = {
    ...base.testCaseRefs[0]!,
    scope: {
      kind: 'CONTRACT',
      worksetId: 'WKS-0001',
      contractKey: 'authorization-v2',
      scopeHash: SCOPE_HASH,
      contractSnapshot: { id: fixture.newId, contentHash: NEW_CONTRACT_HASH },
      scenarioId: 'SC-audit',
    },
    contentHash: hashObject('unrelated-audit-case'),
  };
  const evidence = {
    ...base,
    testCaseRefs: [unrelatedCase],
    caseOutcomes: [{ caseRef: unrelatedCase, status: 'PASS' as const }],
  };
  const context: ContractCompatibilityContext = {
    ...fixture.context,
    runCompatibilityValidators: async () => [{
      status: 'PASS',
      evidenceRef: evidence.id,
      evidence,
      previous: { id: fixture.oldId, contentHash: OLD_CONTRACT_HASH },
      current: { id: fixture.newId, contentHash: NEW_CONTRACT_HASH },
      project: reference.project,
      usedElements: reference.usedElements,
      usedScenarios: reference.usedScenarios,
    }],
    loadVerificationEvidence: async () => evidence,
  };

  await assert.rejects(
    () => classifyContractCompatibility(
      context,
      compareContractSnapshots(fixture.oldSnapshot, fixture.newSnapshot),
      reference,
    ),
    /COMPATIBILITY_VALIDATOR_EVIDENCE_USE_MISMATCH/,
  );
});

test('Resolver cannot settle ambiguity with an unsupported evidence citation', async () => {
  const fixture = createCompatibilityFixture({
    delta: 'AMBIGUOUS_BUSINESS_OUTCOME',
    usedBy: ['quote'],
    unusedBy: ['order'],
  });
  const reference = fixture.references.find((item) => item.project === 'quote')!;
  let resolverEvidence: unknown;
  const context: ContractCompatibilityContext = {
    ...fixture.context,
    runCompatibilityValidators: async ({ previous, current }) => {
      const evidence = persistedCompatibilityEvidence(
        reference,
        previous,
        current,
        'EVD-4001',
        'INCONCLUSIVE',
      );
      resolverEvidence = evidence;
      return [{
        status: 'INCONCLUSIVE',
        evidenceRef: evidence.id,
        evidence,
        previous: { id: previous.manifest.id, contentHash: previous.manifest.contentHash },
        current: { id: current.manifest.id, contentHash: current.manifest.contentHash },
        project: reference.project,
        usedElements: reference.usedElements,
        usedScenarios: reference.usedScenarios,
      }];
    },
    loadVerificationEvidence: async () => resolverEvidence,
    runCompatibilityResolver: async () => ({
      selectedEvidenceRefs: ['EVD-4999'],
    }),
  };

  await assert.rejects(
    () => classifyContractCompatibility(
      context,
      compareContractSnapshots(fixture.oldSnapshot, fixture.newSnapshot),
      reference,
    ),
    /COMPATIBILITY_RESOLVER_EVIDENCE_UNSUPPORTED/,
  );
});

test('Resolver cannot turn cited INCONCLUSIVE evidence into compatibility', async () => {
  const fixture = createCompatibilityFixture({
    delta: 'AMBIGUOUS_BUSINESS_OUTCOME',
    usedBy: ['quote'],
    unusedBy: ['order'],
  });
  const reference = fixture.references.find((item) => item.project === 'quote')!;
  let resolverEvidence: unknown;
  const context: ContractCompatibilityContext = {
    ...fixture.context,
    runCompatibilityValidators: async ({ previous, current }) => {
      const evidence = persistedCompatibilityEvidence(
        reference,
        previous,
        current,
        'EVD-4002',
        'INCONCLUSIVE',
      );
      resolverEvidence = evidence;
      return [{
        status: 'INCONCLUSIVE',
        evidenceRef: evidence.id,
        evidence,
        previous: { id: previous.manifest.id, contentHash: previous.manifest.contentHash },
        current: { id: current.manifest.id, contentHash: current.manifest.contentHash },
        project: reference.project,
        usedElements: reference.usedElements,
        usedScenarios: reference.usedScenarios,
      }];
    },
    loadVerificationEvidence: async () => resolverEvidence,
    runCompatibilityResolver: async () => ({ selectedEvidenceRefs: ['EVD-4002'] }),
  };

  const decision = await classifyContractCompatibility(
    context,
    compareContractSnapshots(fixture.oldSnapshot, fixture.newSnapshot),
    reference,
  );

  assert.equal(decision.disposition, 'UNRESOLVED');
});

test('default reference discovery reads exact element and scenario uses from immutable Planner packets', async () => {
  const directory = await createTestDirectory('contract-reference-discovery-');
  try {
    await ensureExecutionLayout(directory.root, 'WKS-0001');
    const fixture = createCompatibilityFixture({ delta: 'OPTIONAL_FIELD_ADDED' });
    const sourcePath = `${directory.root}/quote-source`;
    const outputPath = `${directory.root}/candidate.json`;
    const packet = createRunPacket({
      schemaVersion: 1,
      id: 'RUN-0001',
      kind: 'PROJECT_TEST_PLANNER',
      worksetId: 'WKS-0001',
      contracts: [{ id: fixture.oldId, contentHash: OLD_CONTRACT_HASH }],
      objective: 'compile exact authorization contract cases',
      protocolIds: ['execution.project-test-planner'],
      verificationCommands: [],
      evidenceRequired: ['project-test-plan'],
      stopConditions: ['signal stale contract input'],
      agent: { agentId: 'codex', protocol: 'acp', role: 'coordination-read-only' },
      limits: { timeoutMs: 60_000, maxOutputBytes: 1_048_576 },
      permissionPolicy: {
        filesystemRoots: [sourcePath],
        terminal: false,
        network: 'DENY',
        denyGitCommit: true,
        denyNestedOmnai: true,
      },
      createdAt: NOW,
      project: quoteTask.project,
      scopedTasks: [quoteTask],
      sourceSnapshot: {
        path: sourcePath,
        head: 'a'.repeat(40),
        tree: 'b'.repeat(40),
        contentHash: hashObject('source-snapshot'),
        sourceRefs: [{ ref: 'spec.md#authorization', contentHash: hashObject('spec') }],
      },
      acceptanceCriteria: [{ ref: 'AC-001', contentHash: hashObject('acceptance-criterion') }],
      manifestRefs: [],
      contractScenarios: [{
        contractKey: 'authorization-v2',
        scopeHash: SCOPE_HASH,
        snapshot: { id: fixture.oldId, contentHash: OLD_CONTRACT_HASH },
        scenarioId: 'SC-authorization',
        scenarioClass: 'NORMAL',
        contentHash: hashObject('authorization-scenario'),
        title: 'authorize a quote',
        participantProjects: ['order', 'quote'],
        sourceRefs: [{ ref: 'spec.md#authorization', contentHash: hashObject('spec') }],
        contractElementRefs: [{ ref: 'authorization-request', contentHash: hashObject('authorization-element') }],
        fixtureRefs: [],
        executorRefs: ['quote:contract'],
        expectedOutcome: 'authorization denial is returned without retry',
      }],
      outputPath,
    });
    await persistRunPacket(runPacketPath(directory.root, 'WKS-0001', packet.id), packet);
    const context: ContractCompatibilityContext = {
      home: directory.root,
      worksetId: 'WKS-0001',
      loadContractSnapshot: async () => fixture.oldSnapshot,
    };

    const references = await findContractReferences(context, fixture.oldId);

    assert.equal(references.length, 1);
    assert.equal(references[0]?.project, 'quote');
    assert.deepEqual(references[0]?.usedElements, ['authorization-request']);
    assert.deepEqual(references[0]?.usedScenarios, ['SC-authorization']);
  } finally {
    await directory.cleanup();
  }
});

test('impact inventory and semantic closure are proven before any state mutation begins', async () => {
  const fixture = createCompatibilityFixture({ delta: 'OPTIONAL_FIELD_ADDED' });
  const context: ContractCompatibilityContext = {
    ...fixture.context,
    loadCompatibilityImpactInventory: async () => {
      throw new Error('IMPACT_INVENTORY_CORRUPT');
    },
  };

  await assert.rejects(
    () => revalidateContractChange(context, fixture.oldId, fixture.newId),
    /IMPACT_INVENTORY_CORRUPT/,
  );

  assert.deepEqual(fixture.compatibilityEvidenceProjects(), []);
  assert.deepEqual(fixture.recoveryRuns(), []);
  assert.deepEqual(fixture.attentionItems(), []);
});

test('a partial Core inventory that omits a referenced Run fails before mutation', async () => {
  const fixture = createCompatibilityFixture({ delta: 'OPTIONAL_FIELD_ADDED' });
  const inventory = impactInventory(fixture.oldId);
  const context: ContractCompatibilityContext = {
    ...fixture.context,
    loadCompatibilityImpactInventory: async () => ({ ...inventory, runs: [] }),
  };

  await assert.rejects(
    () => revalidateContractChange(context, fixture.oldId, fixture.newId),
    /IMPACT_REFERENCE_RUN_MISSING:RUN-000[12]/,
  );
  assert.deepEqual(fixture.compatibilityEvidenceProjects(), []);
});

test('a self-consistent custom inventory omission requires independent Core completeness proof', async () => {
  const fixture = createCompatibilityFixture({ delta: 'OPTIONAL_FIELD_ADDED' });
  const inventory = impactInventory(fixture.oldId);
  const context: ContractCompatibilityContext = {
    ...fixture.context,
    listContractReferences: async () => fixture.references.filter((reference) => reference.project === 'quote'),
    loadCompatibilityImpactInventory: async () => ({
      ...inventory,
      tasks: inventory.tasks.filter((item) => item.scopedTask.project === 'quote'),
      testCases: inventory.testCases.filter((item) => item.scopedTasks.some((task) => task.project === 'quote')),
      verificationPlans: inventory.verificationPlans.filter((item) => item.id === 'VPL-0001'),
      waveMembers: inventory.waveMembers.filter((item) => item.scopedTask.project === 'quote'),
      runs: inventory.runs.filter((item) => item.id === 'RUN-0001'),
      environmentInputs: inventory.environmentInputs.filter((item) => item.id === 'IER-0001'),
      commitSets: inventory.commitSets.filter((item) => item.id === 'CST-0001'),
    }),
    assertCompleteCompatibilityInventory: async ({ references, inventory: supplied }) => {
      if (references.length !== fixture.references.length || supplied.runs.length !== inventory.runs.length) {
        throw new Error('IMPACT_INVENTORY_COMPLETENESS_UNPROVEN');
      }
    },
  };

  await assert.rejects(
    () => revalidateContractChange(context, fixture.oldId, fixture.newId),
    /IMPACT_INVENTORY_COMPLETENESS_UNPROVEN/,
  );
  assert.deepEqual(fixture.compatibilityEvidenceProjects(), []);
});

test('Writer reference discovery fails closed when its immutable TestCase inventory is missing', async () => {
  const directory = await createTestDirectory('contract-reference-missing-inventory-');
  try {
    await ensureExecutionLayout(directory.root, 'WKS-0001');
    const fixture = createCompatibilityFixture({ delta: 'OPTIONAL_FIELD_ADDED' });
    const worktree = `${directory.root}/quote-worktree`;
    const packet = createRunPacket({
      schemaVersion: 1,
      id: 'RUN-0001',
      kind: 'PROJECT_WRITER',
      worksetId: 'WKS-0001',
      waveId: 'WAVE-0001',
      contracts: [{ id: fixture.oldId, contentHash: OLD_CONTRACT_HASH }],
      objective: 'implement quote authorization',
      protocolIds: ['execution.project-writer'],
      verificationCommands: ['npm test -- quote'],
      evidenceRequired: ['test-results'],
      stopConditions: ['signal stale contract input'],
      agent: { agentId: 'codex', protocol: 'acp', role: 'project-writer' },
      limits: { timeoutMs: 60_000, maxOutputBytes: 1_048_576 },
      permissionPolicy: {
        filesystemRoots: [worktree],
        terminal: true,
        network: 'DENY',
        denyGitCommit: true,
        denyNestedOmnai: true,
      },
      createdAt: NOW,
      scopedTask: quoteTask,
      git: { startingHead: 'a'.repeat(40), worktree, branch: 'omnai/WKS-0001-quote' },
      allowedPaths: ['src/**'],
      verificationPlan: { id: 'VPL-0001', contentHash: PLAN_HASH },
      testCaseRefs: [{
        id: 'TC-0001',
        scope: {
          kind: 'CONTRACT',
          worksetId: 'WKS-0001',
          contractKey: 'authorization-v2',
          scopeHash: SCOPE_HASH,
          contractSnapshot: { id: fixture.oldId, contentHash: OLD_CONTRACT_HASH },
          scenarioId: 'SC-authorization',
        },
        contentHash: TEST_CASE_HASH,
      }],
      commandRefs: ['quote:test'],
    });
    await persistRunPacket(runPacketPath(directory.root, 'WKS-0001', packet.id), packet);
    const context: ContractCompatibilityContext = {
      home: directory.root,
      worksetId: 'WKS-0001',
      loadContractSnapshot: async () => fixture.oldSnapshot,
    };

    await assert.rejects(
      () => findContractReferences(context, fixture.oldId),
      /CONTRACT_REFERENCE_TEST_CASE_INVENTORY_MISSING:VPL-0001/,
    );
  } finally {
    await directory.cleanup();
  }
});

test('missing downstream invalidation authority fails before compatibility evidence is written', async () => {
  const fixture = createCompatibilityFixture({ delta: 'OPTIONAL_FIELD_ADDED' });
  const { markWaveMemberBlocked: _withoutWaveAuthority, ...contextWithoutWaveAuthority } = fixture.context;
  const context: ContractCompatibilityContext = contextWithoutWaveAuthority;

  await assert.rejects(
    () => revalidateContractChange(context, fixture.oldId, fixture.newId),
    /WAVE_MEMBER_INVALIDATION_AUTHORITY_REQUIRED/,
  );
  assert.deepEqual(fixture.compatibilityEvidenceProjects(), []);
});

test('the compatibility transaction requires a lock-bound supersede authority', async () => {
  const fixture = createCompatibilityFixture({ delta: 'OPTIONAL_FIELD_ADDED' });
  const { supersedeContractSnapshot: _withoutSupersedeAuthority, ...unsafeContext } = fixture.context;
  const context: ContractCompatibilityContext = unsafeContext;

  await assert.rejects(
    () => revalidateContractChange(context, fixture.oldId, fixture.newId),
    /CONTRACT_SUPERSEDE_TRANSACTION_AUTHORITY_REQUIRED/,
  );
  assert.deepEqual(fixture.compatibilityEvidenceProjects(), []);
});

test('a non-READY replacement is rejected before any compatibility state is written', async () => {
  const fixture = createCompatibilityFixture({ delta: 'OPTIONAL_FIELD_ADDED' });
  const validating: ContractSnapshot = {
    ...fixture.newSnapshot,
    manifest: {
      ...fixture.newSnapshot.manifest,
      status: 'VALIDATING',
      validationEvidence: [],
    },
  };
  const context: ContractCompatibilityContext = {
    ...fixture.context,
    loadContractSnapshot: async (id) => id === fixture.oldId ? fixture.oldSnapshot : validating,
    loadReadyContractSnapshot: async (id) => id === fixture.oldId ? fixture.oldSnapshot : validating,
  };

  await assert.rejects(
    () => revalidateContractChange(context, fixture.oldId, fixture.newId),
    /CONTRACT_NOT_READY: CTR-0002:VALIDATING/,
  );
  assert.deepEqual(fixture.compatibilityEvidenceProjects(), []);
  assert.deepEqual(fixture.recoveryRuns(), []);
  assert.deepEqual(fixture.attentionItems(), []);
});

function createCompatibilityFixture(options: FixtureOptions) {
  const oldId = 'CTR-0001';
  const newId = 'CTR-0002';
  const oldSnapshot = snapshot(oldId, null, OLD_CONTRACT_HASH, oldCandidate());
  const newSnapshot = snapshot(
    newId,
    oldId,
    NEW_CONTRACT_HASH,
    changedCandidate(options.delta),
  );
  const references = referenceFixtures(options, oldId);
  const commits = new Map([
    ['quote', 'a'.repeat(40)],
    ['order', 'b'.repeat(40)],
  ]);
  const taskStatuses = new Map([
    ['quote', 'DONE'],
    ['order', 'DONE'],
  ]);
  const runStatuses = new Map([
    ['quote', options.activeRun === 'quote' ? 'RUNNING' : 'SUCCEEDED'],
    ['order', 'SUCCEEDED'],
    ['user', options.activeUnrelatedProject === 'user' ? 'RUNNING' : 'SUCCEEDED'],
  ]);
  const packets = new Map([
    ['quote', Object.freeze({ contract: { id: oldId, contentHash: OLD_CONTRACT_HASH }, packetHash: hashObject('quote') })],
    ['order', Object.freeze({ contract: { id: oldId, contentHash: OLD_CONTRACT_HASH }, packetHash: hashObject('order') })],
  ]);
  const evidenceProjects: string[] = [];
  const environmentAuthority = new Map([
    ['IER-0001', true],
    ['IER-0002', true],
  ]);
  const invalidatedPlans: string[] = [];
  const invalidatedTestCases: string[] = [];
  const recoveryRuns: Array<{ runId: string; project: string }> = [];
  const attentionItems: Array<{ id: string; project: string; fingerprint: ContentHash }> = [];
  const persistedEvidence = new Map<string, unknown>();
  const capturedPatches = new Map<string, unknown>();
  const recoveryPackets = new Map<string, ReturnType<typeof createRunPacket>>();
  const recoveryLinkages = new Map<string, unknown>();
  const recoveryStates = new Map<string, unknown>();
  const persistedAttentions = new Map<string, unknown>();
  const classificationResults = new Map<string, CompatibilityDecision>();
  const mutationResults = new Map<string, RevalidationResult>();
  const mutationReceipts = new Map<string, CompatibilityMutationReceipt>();

  const context: ContractCompatibilityContext = {
    home: '/tmp/omnai-contract-compatibility-test',
    worksetId: 'WKS-0001',
    now: () => NOW,
    loadContractSnapshot: async (id) => id === oldId ? oldSnapshot : newSnapshot,
    loadReadyContractSnapshot: async (id) => id === oldId ? oldSnapshot : newSnapshot,
    listContractReferences: async () => references,
    loadCompatibilityImpactInventory: async () => impactInventory(oldId),
    assertCompleteCompatibilityInventory: async () => undefined,
    assertCompatibilityReadSetCurrent: async () => true,
    loadRunState: async (id) => {
      if (recoveryStates.has(id)) return recoveryStates.get(id);
      const project = id === 'RUN-0002' ? 'order' : 'quote';
      const scopedTask = project === 'order'
        ? orderTask
        : id === 'RUN-0003'
          ? { ...quoteTask, taskId: 'TASK-003' }
          : quoteTask;
      const packetHash = id === 'RUN-0001'
        ? hashObject('quote-run')
        : id === 'RUN-0002'
          ? hashObject('order-run')
          : hashObject('second-quote-run');
      return {
        schemaVersion: 1,
        machineVersion: 1,
        lastEventSequence: 0,
        lastEventHash: null,
        id,
        kind: 'PROJECT_WRITER',
        worksetId: 'WKS-0001',
        status: options.activeRun === project ? 'RUNNING' : 'INTEGRATED',
        packetHash,
        scopedTask,
        evidenceRefs: [],
        createdAt: NOW,
        updatedAt: NOW,
      };
    },
    runCompatibilityValidators: async ({ previous, current, reference }) => {
      if (options.validators !== 'PASS') return [];
      const evidence = persistedCompatibilityEvidence(
        reference,
        previous,
        current,
        reference.project === 'order' ? 'EVD-1101' : 'EVD-1102',
      );
      persistedEvidence.set(evidence.id, evidence);
      return [{
        status: 'PASS',
        evidenceRef: evidence.id,
        evidence,
        previous: { id: previous.manifest.id, contentHash: previous.manifest.contentHash },
        current: { id: current.manifest.id, contentHash: current.manifest.contentHash },
        project: reference.project,
        usedElements: reference.usedElements,
        usedScenarios: reference.usedScenarios,
      }];
    },
    loadVerificationEvidence: async (id) => {
      const evidence = persistedEvidence.get(id);
      if (evidence === undefined) throw new Error(`EVIDENCE_NOT_FOUND:${id}`);
      return evidence;
    },
    recordCompatibilityEvidence: async ({ reference, previous, current }) => {
      evidenceProjects.push(reference.project);
      const evidence = persistedCompatibilityEvidence(
        reference,
        previous,
        current,
        `EVD-${String(2000 + evidenceProjects.length).padStart(4, '0')}`,
      );
      persistedEvidence.set(evidence.id, evidence);
      return evidence;
    },
    captureUncommittedRunPatch: async ({ reference }) => {
      const receipt = {
        runId: reference.runId,
        patchRef: `runs/${reference.runId}/evidence/pre-revalidation.patch`,
        contentHash: hashObject(`patch:${reference.runId}`),
      };
      capturedPatches.set(reference.runId, receipt);
      return receipt;
    },
    loadCapturedRunPatch: async (receipt) => capturedPatches.get(receipt.runId),
    markRunStale: async ({ reference }) => {
      if (runStatuses.get(reference.project) === 'RUNNING') runStatuses.set(reference.project, 'STALE');
    },
    markCommittedWorkNeedsRevalidation: async ({ reference }) => {
      if (reference.commit !== undefined) taskStatuses.set(reference.project, 'NEEDS_REVALIDATION');
    },
    createRecoveryRun: async ({ reference, current, decision }) => {
      const runId = `RUN-${String(9000 + recoveryRuns.length).padStart(4, '0')}`;
      const worktree = `/tmp/omnai-contract-compatibility-test/${reference.project}-recovery`;
      const packet = createRunPacket({
        schemaVersion: 1,
        id: runId,
        kind: 'RECOVERY_WRITER',
        worksetId: 'WKS-0001',
        parentRunId: reference.runId,
        waveId: 'WAVE-0001',
        contracts: [{ id: current.manifest.id, contentHash: current.manifest.contentHash }],
        objective: `repair ${reference.taskId} for compatible contract lineage`,
        protocolIds: ['execution.recovery-writer'],
        verificationCommands: ['npm test'],
        evidenceRequired: ['recovery-test'],
        stopConditions: ['signal stale recovery input'],
        agent: { agentId: 'codex', protocol: 'acp', role: 'project-writer' },
        limits: { timeoutMs: 60_000, maxOutputBytes: 1_048_576 },
        permissionPolicy: {
          filesystemRoots: [worktree],
          terminal: true,
          network: 'DENY',
          denyGitCommit: true,
          denyNestedOmnai: true,
        },
        createdAt: NOW,
        scopedTask: {
          project: reference.project,
          changeId: reference.changeId,
          revision: reference.revision,
          baseline: reference.baseline,
          taskId: reference.taskId,
        },
        git: { startingHead: reference.commit ?? 'd'.repeat(40), worktree, branch: `omnai/recovery-${runId}` },
        allowedPaths: ['src/**'],
        verificationPlan: { id: 'VPL-0001', contentHash: PLAN_HASH },
        testCaseRefs: impactInventory(oldId).verificationPlans[0]!.testCaseRefs,
        commandRefs: ['recovery:test'],
      });
      recoveryPackets.set(runId, packet);
      recoveryStates.set(runId, {
        schemaVersion: 1,
        machineVersion: 1,
        lastEventSequence: 0,
        lastEventHash: null,
        id: runId,
        kind: 'RECOVERY_WRITER',
        worksetId: 'WKS-0001',
        status: 'PREPARED',
        packetHash: packet.packetHash,
        waveId: packet.waveId,
        parentRunId: reference.runId,
        scopedTask: packet.scopedTask,
        evidenceRefs: [],
        createdAt: NOW,
        updatedAt: NOW,
      });
      const run = {
        runId,
        project: reference.project,
        kind: 'RECOVERY_WRITER' as const,
        parentRunId: reference.runId,
        scopedTask: packet.scopedTask,
        decisionFingerprint: decision.fingerprint,
        packetHash: packet.packetHash,
      };
      recoveryRuns.push(run);
      recoveryLinkages.set(runId, run);
      return run;
    },
    loadRecoveryRunPacket: async (id) => recoveryPackets.get(id),
    loadRecoveryRunLinkage: async (id) => recoveryLinkages.get(id),
    createCompatibilityAttention: async ({ reference, fingerprint, previous, current, delta }) => {
      const item = {
        id: `ATTN-${String(attentionItems.length + 1).padStart(4, '0')}`,
        project: reference.project,
        fingerprint,
        previous: { id: previous.manifest.id, contentHash: previous.manifest.contentHash },
        current: { id: current.manifest.id, contentHash: current.manifest.contentHash },
        deltaHash: delta.contentHash,
        reference,
      };
      attentionItems.push(item);
      persistedAttentions.set(item.id, item);
      return item;
    },
    loadCompatibilityAttention: async (id) => persistedAttentions.get(id),
    loadCompatibilityClassificationResult: async (identity) =>
      classificationResults.get(identity.contentHash) ?? null,
    withCompatibilityClassificationTransaction: async (identity, apply) => {
      const existing = classificationResults.get(identity.contentHash);
      if (existing !== undefined) return existing;
      const result = await apply();
      classificationResults.set(identity.contentHash, result);
      return result;
    },
    invalidateVerificationPlan: async (id) => {
      invalidatedPlans.push(id);
    },
    invalidateTestCase: async (ref) => {
      invalidatedTestCases.push(ref);
    },
    invalidateEnvironmentEvidence: async (id) => {
      environmentAuthority.set(id, false);
    },
    markWaveMemberBlocked: async () => undefined,
    markImpactRunStale: async (id) => {
      if (id === 'RUN-0001' && runStatuses.get('quote') === 'RUNNING') runStatuses.set('quote', 'STALE');
    },
    markCommitSetNeedsRevalidation: async () => undefined,
    supersedeContractSnapshot: async () => undefined,
    loadCompatibilityMutationResult: async (previous, current) =>
      mutationResults.get(`${previous}:${current}`) ?? null,
    loadCompatibilityMutationReceipt: async (previous, current) =>
      mutationReceipts.get(`${previous}:${current}`) ?? null,
    withCompatibilityMutationTransaction: async (identity, apply) => {
      const key = `${identity.previousId}:${identity.currentId}`;
      const existing = mutationResults.get(key);
      if (existing !== undefined) return existing;
      const result = await apply();
      mutationResults.set(key, result);
      const receiptIdentity = {
        previousId: identity.previousId,
        currentId: identity.currentId,
        readSetHash: identity.readSetHash,
        resultContentHash: result.contentHash,
      };
      mutationReceipts.set(key, { ...receiptIdentity, contentHash: hashObject(receiptIdentity) });
      return result;
    },
  };

  return {
    context,
    oldId,
    newId,
    oldSnapshot,
    newSnapshot,
    references,
    commitShas: () => Object.fromEntries(commits),
    compatibilityEvidenceProjects: () => [...evidenceProjects].sort(),
    taskStatus: (project: string) => taskStatuses.get(project),
    workerStillRunning: (project: string) => runStatuses.get(project) === 'RUNNING',
    packet: (project: string) => packets.get(project),
    runStatus: (project: string) => runStatuses.get(project),
    environmentEvidenceAuthoritative: (id: string) => environmentAuthority.get(id),
    unrelatedProjectEvidencePreserved: () => environmentAuthority.get('IER-0002') === true,
    invalidatedPlans: () => [...invalidatedPlans],
    invalidatedTestCases: () => [...invalidatedTestCases],
    recoveryRuns: () => [...recoveryRuns],
    attentionItems: () => [...attentionItems],
  };
}

function referenceFixtures(options: FixtureOptions, oldId: string): ContractReference[] {
  const used = new Set(options.usedBy ?? ['order', 'quote']);
  const unused = new Set(options.unusedBy ?? []);
  return [quoteTask, orderTask].map((task, index) => ({
    ...task,
    runId: `RUN-${String(index + 1).padStart(4, '0')}`,
    ...(options.activeRun === task.project
      ? {}
      : { commit: task.project === 'quote' ? 'a'.repeat(40) : 'b'.repeat(40) }),
    contract: { id: oldId, contentHash: OLD_CONTRACT_HASH },
    usedElements: used.has(task.project) && !unused.has(task.project) ? ['authorization-request'] : ['audit-event'],
    usedScenarios: used.has(task.project) && !unused.has(task.project) ? ['SC-authorization'] : [],
  }));
}

function impactInventory(oldId: string): CompatibilityImpactInventory {
  const caseRef: TestCaseRef = {
    id: 'TC-0001',
    scope: {
      kind: 'CONTRACT',
      worksetId: 'WKS-0001',
      contractKey: 'authorization-v2',
      scopeHash: SCOPE_HASH,
      contractSnapshot: { id: oldId, contentHash: OLD_CONTRACT_HASH },
      scenarioId: 'SC-authorization',
    },
    contentHash: TEST_CASE_HASH,
  };
  const auditCaseRef: TestCaseRef = {
    id: 'TC-0002',
    scope: {
      kind: 'CONTRACT',
      worksetId: 'WKS-0001',
      contractKey: 'authorization-v2',
      scopeHash: SCOPE_HASH,
      contractSnapshot: { id: oldId, contentHash: OLD_CONTRACT_HASH },
      scenarioId: 'SC-audit',
    },
    contentHash: hashObject('audit-case'),
  };
  return {
    sources: [],
    tasks: [
      { scopedTask: quoteTask, contentHash: hashObject(quoteTask), sourceRefs: [], contractRefs: [{ id: oldId, contentHash: OLD_CONTRACT_HASH }] },
      { scopedTask: orderTask, contentHash: hashObject(orderTask), sourceRefs: [], contractRefs: [{ id: oldId, contentHash: OLD_CONTRACT_HASH }] },
    ],
    testCases: [{
      ref: caseRef,
      contentHash: TEST_CASE_HASH,
      sourceRefs: [],
      scopedTasks: [quoteTask],
      contractRefs: [{ id: oldId, contentHash: OLD_CONTRACT_HASH }],
      elementUses: [{
        snapshot: { id: oldId, contentHash: OLD_CONTRACT_HASH },
        id: 'authorization-request',
      }],
      scenarioUses: [{
        snapshot: { id: oldId, contentHash: OLD_CONTRACT_HASH },
        id: 'SC-authorization',
      }],
    }, {
      ref: auditCaseRef,
      contentHash: auditCaseRef.contentHash,
      sourceRefs: [],
      scopedTasks: [orderTask],
      contractRefs: [{ id: oldId, contentHash: OLD_CONTRACT_HASH }],
      elementUses: [{
        snapshot: { id: oldId, contentHash: OLD_CONTRACT_HASH },
        id: 'audit-event',
      }],
      scenarioUses: [{
        snapshot: { id: oldId, contentHash: OLD_CONTRACT_HASH },
        id: 'SC-audit',
      }],
    }],
    verificationPlans: [{
      id: 'VPL-0001',
      contentHash: PLAN_HASH,
      contractRefs: [{ id: oldId, contentHash: OLD_CONTRACT_HASH }],
      testCaseRefs: [caseRef],
    }, {
      id: 'VPL-0002',
      contentHash: hashObject('unrelated-plan'),
      contractRefs: [{ id: oldId, contentHash: OLD_CONTRACT_HASH }],
      testCaseRefs: [auditCaseRef],
    }],
    waveMembers: [{
      ref: 'WAVE-0001:quote',
      contentHash: hashObject('quote-wave-member'),
      scopedTask: quoteTask,
      verificationPlan: { id: 'VPL-0001', contentHash: PLAN_HASH },
      testCaseRefs: [caseRef],
      contractRefs: [{ id: oldId, contentHash: OLD_CONTRACT_HASH }],
    }, {
      ref: 'WAVE-0001:order',
      contentHash: hashObject('order-wave-member'),
      scopedTask: orderTask,
      verificationPlan: { id: 'VPL-0002', contentHash: hashObject('unrelated-plan') },
      testCaseRefs: [auditCaseRef],
      contractRefs: [{ id: oldId, contentHash: OLD_CONTRACT_HASH }],
    }],
    runs: [{
      id: 'RUN-0001',
      contentHash: hashObject('quote-run'),
      memberRef: 'WAVE-0001:quote',
      scopedTask: quoteTask,
      verificationPlan: { id: 'VPL-0001', contentHash: PLAN_HASH },
      testCaseRefs: [caseRef],
      contractRefs: [{ id: oldId, contentHash: OLD_CONTRACT_HASH }],
    }, {
      id: 'RUN-0002',
      contentHash: hashObject('order-run'),
      memberRef: 'WAVE-0001:order',
      scopedTask: orderTask,
      verificationPlan: { id: 'VPL-0002', contentHash: hashObject('unrelated-plan') },
      testCaseRefs: [auditCaseRef],
      contractRefs: [{ id: oldId, contentHash: OLD_CONTRACT_HASH }],
    }],
    environmentInputs: [{
      id: 'IER-0001',
      contentHash: ENVIRONMENT_INPUT_HASH,
      contractRefs: [{ id: oldId, contentHash: OLD_CONTRACT_HASH }],
      verificationPlan: { id: 'VPL-0001', contentHash: PLAN_HASH },
      testCaseRefs: [caseRef],
    }, {
      id: 'IER-0002',
      contentHash: hashObject('unrelated-environment'),
      contractRefs: [{ id: oldId, contentHash: OLD_CONTRACT_HASH }],
      verificationPlan: { id: 'VPL-0002', contentHash: hashObject('unrelated-plan') },
      testCaseRefs: [auditCaseRef],
    }],
    commitSets: [{
      id: 'CST-0001',
      contentHash: hashObject('quote-commit-set'),
      verificationPlan: { id: 'VPL-0001', contentHash: PLAN_HASH },
      memberRunIds: ['RUN-0001'],
      environmentInputRefs: [{ id: 'IER-0001', contentHash: ENVIRONMENT_INPUT_HASH }],
      contractRefs: [{ id: oldId, contentHash: OLD_CONTRACT_HASH }],
    }, {
      id: 'CST-0002',
      contentHash: hashObject('order-commit-set'),
      verificationPlan: { id: 'VPL-0002', contentHash: hashObject('unrelated-plan') },
      memberRunIds: ['RUN-0002'],
      environmentInputRefs: [{ id: 'IER-0002', contentHash: hashObject('unrelated-environment') }],
      contractRefs: [{ id: oldId, contentHash: OLD_CONTRACT_HASH }],
    }],
  };
}

function oldCandidate(): ContractCandidate {
  return candidate({
    elements: [
      element('audit-event', { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }),
      element('authorization-request', {
        type: 'object',
        properties: { customerId: { type: 'string' } },
        required: ['customerId'],
      }),
    ],
    expectedOutcome: 'authorization denial is returned without retry',
    scenarioClass: 'NORMAL',
  });
}

function changedCandidate(delta: FixtureOptions['delta']): ContractCandidate {
  if (delta === 'OPTIONAL_FIELD_ADDED') {
    return candidate({
      elements: [
        element('audit-event', { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }),
        element('authorization-request', {
          type: 'object',
          properties: { customerId: { type: 'string' }, note: { type: 'string' } },
          required: ['customerId'],
        }),
      ],
      expectedOutcome: 'authorization denial is returned without retry',
      scenarioClass: 'NORMAL',
    });
  }
  if (delta === 'REQUIRED_FIELD_RENAMED') {
    return candidate({
      elements: [
        element('audit-event', { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }),
        element('authorization-request', {
          type: 'object',
          properties: { clientId: { type: 'string' } },
          required: ['clientId'],
        }),
      ],
      expectedOutcome: 'authorization denial is returned without retry',
      scenarioClass: 'NORMAL',
    });
  }
  if (delta === 'FAILURE_OUTCOME_CHANGED') {
    return candidate({
      elements: oldCandidate().contract.elements,
      expectedOutcome: 'authorization denial is retried once before surfacing',
      scenarioClass: 'FAILURE',
    });
  }
  return candidate({
    elements: oldCandidate().contract.elements,
    expectedOutcome: 'authorization may be denied or deferred according to business preference',
    scenarioClass: 'NORMAL',
  });
}

function candidateWithFixture(base: ContractCandidate, contentHash: ContentHash): ContractCandidate {
  return {
    ...base,
    businessScenarios: base.businessScenarios.map((scenario) => scenario.id === 'SC-authorization'
      ? { ...scenario, fixtureRefs: ['FX-authorization'] }
      : scenario),
    fixtures: [{ ref: 'FX-authorization', ownerProject: 'order', contentHash }],
  };
}

function candidate(input: {
  readonly elements: ContractCandidate['contract']['elements'];
  readonly expectedOutcome: string;
  readonly scenarioClass: ContractCandidate['businessScenarios'][number]['class'];
}): ContractCandidate {
  return {
    schemaVersion: 1,
    runId: 'RUN-0100',
    packetHash: hashObject('contract-packet'),
    contractKey: 'authorization-v2',
    scopeHash: SCOPE_HASH,
    participants: [
      { project: 'order', role: 'PROVIDER', taskRefs: ['TASK-002'] },
      { project: 'quote', role: 'CONSUMER', taskRefs: ['TASK-001'] },
    ],
    contract: {
      elements: input.elements,
      compatibilityPolicy: { mode: 'BACKWARD_COMPATIBLE', rules: ['preserve authorization outcomes'] },
    },
    businessScenarios: [{
      id: 'SC-audit',
      class: 'NORMAL',
      title: 'record an authorization audit event',
      participantProjects: ['order', 'quote'],
      sourceRefs: ['spec.md#authorization'],
      contractElementRefs: ['audit-event'],
      fixtureRefs: [],
      executorRefs: ['order:audit'],
      expectedOutcome: 'one immutable audit event is recorded',
    }, {
      id: 'SC-authorization',
      class: input.scenarioClass,
      title: 'authorize a quote',
      participantProjects: ['order', 'quote'],
      sourceRefs: ['spec.md#authorization'],
      contractElementRefs: ['authorization-request'],
      fixtureRefs: [],
      executorRefs: ['quote:contract'],
      expectedOutcome: input.expectedOutcome,
    }],
    fixtures: [],
    traceability: [{
      sourceRef: 'spec.md#authorization',
      sourceHash: hashObject('spec'),
      contractElementRefs: ['authorization-request'],
      scenarioIds: ['SC-authorization'],
    }],
    sourceHashes: [{ ref: 'spec.md#authorization', contentHash: hashObject('spec') }],
    validatorRequests: [],
    summary: 'authorization boundary',
  };
}

function element(id: string, definition: Record<string, unknown>): ContractCandidate['contract']['elements'][number] {
  return {
    id,
    kind: 'SCHEMA',
    name: id,
    ownerProject: 'order',
    definition: definition as ContractCandidate['contract']['elements'][number]['definition'],
    sourceRefs: ['spec.md#authorization'],
  };
}

function snapshot(
  id: string,
  previousSnapshot: string | null,
  contentHash: ContentHash,
  contractCandidate: ContractCandidate,
): ContractSnapshot {
  return {
    context: { home: '/tmp/omnai-contract-compatibility-test', worksetId: 'WKS-0001' },
    root: `/tmp/omnai-contract-compatibility-test/${id}`,
    manifest: {
      schemaVersion: 1,
      machineVersion: 1,
      lastEventSequence: 0,
      lastEventHash: null,
      id,
      worksetId: 'WKS-0001',
      status: 'READY',
      contractKey: 'authorization-v2',
      scopeHash: SCOPE_HASH,
      contentHash,
      previousSnapshot,
      participants: [
        { ...orderTask, role: 'PROVIDER' },
        { ...quoteTask, role: 'CONSUMER' },
      ],
      sources: [{
        kind: 'spec',
        project: 'quote',
        ref: 'spec.md#authorization',
        contentHash: hashObject('spec'),
      }],
      businessScenarios: ['SC-audit', 'SC-authorization'],
      validationEvidence: ['EVD-0100'],
      createdByRun: 'RUN-0100',
      createdAt: NOW,
      updatedAt: NOW,
    },
    candidate: contractCandidate,
    sources: [],
  };
}
