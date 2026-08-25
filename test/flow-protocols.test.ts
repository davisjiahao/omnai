import assert from 'node:assert/strict';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import YAML from 'yaml';
import { withChangeMutationLock } from '../src/core/change-mutation-lock.js';
import { listDecisions, openDecision } from '../src/core/decisions.js';
import { decisionResolutionInputSchema } from '../src/domain/types.js';
import { readText, writeYaml } from '../src/core/files.js';
import { compileFlowPlan } from '../src/core/flow.js';
import { loadFlowPlan } from '../src/core/flow-store.js';
import { readinessKeyForCapability } from '../src/core/readiness.js';
import {
  changeDecisionPath,
  changeFlowPath,
  changeMetadataPath,
  changeRunsRoot,
} from '../src/core/paths.js';
import { reconcileChangeWithinChangeLock } from '../src/core/reconcile-internal.js';
import { prepareStage } from '../src/core/stages.js';
import { createChange, resolveChange } from '../src/core/store.js';
import { getScenario } from '../src/core/scenarios.js';
import { loadProtocol } from '../src/protocols/loader.js';
import { minimumReconcileLevel } from '../src/workspace/reconcile-closure.js';
import { projectReconcileProposalSchema, REENTRY_KINDS } from '../src/workspace/reentry.js';
import { createTestRepository } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const sourceRefs = [{
  kind: 'artifact' as const,
  path: 'domain.md',
  contentHash: `sha256:${'a'.repeat(64)}` as const,
}];

test('Grill and Brainstorm resolve exactly one Core-routed DecisionRecord through Core', async () => {
  const grill = await loadProtocol('interaction.grill');
  const brainstorm = await loadProtocol('interaction.brainstorm');

  assert.equal(grill.version, 2);
  assert.match(grill.content, /first .*decisionIds|first Core-routed/i);
  assert.match(grill.content, /blocking.*HUMAN|HUMAN.*blocking/i);
  assert.match(grill.content, /one high-leverage question/i);
  assert.match(grill.content, /omnai decision resolve/i);
  assert.match(grill.content, /never edit (?:the )?FlowPlan/i);

  assert.equal(brainstorm.version, 2);
  assert.match(brainstorm.content, /one Core-routed|exactly one.*DecisionRecord/i);
  assert.match(brainstorm.content, /SOLUTION.*ARCHITECTURE|ARCHITECTURE.*SOLUTION/i);
  assert.match(brainstorm.content, /at least two.*VIABLE/i);
  assert.match(brainstorm.content, /same criteria/i);
  assert.match(brainstorm.content, /omnai decision resolve/i);
  assert.match(brainstorm.content, /second Spec/i);
});

test('Grill, Brainstorm, and Re-entry Plan provide Core-valid strict input examples', async () => {
  const [grill, brainstorm, reentryPlan] = await Promise.all([
    loadProtocol('interaction.grill'),
    loadProtocol('interaction.brainstorm'),
    loadProtocol('workset.reentry-plan'),
  ]);

  assert.deepEqual(
    decisionResolutionInputSchema.parse(YAML.parse(taggedYamlExample(grill.content, 'grill-decision-resolution-input'))),
    {
      optionId: 'OPT-01',
      summary: 'The domain owner confirmed consent records are owned by the consent service.',
      authority: 'HUMAN_CONFIRMED',
      sourceRefs: [{
        kind: 'artifact',
        path: 'domain.md#consent-ownership',
        contentHash: `sha256:${'a'.repeat(64)}`,
      }],
    },
  );
  assert.match(grill.content, /omnai decision resolve <decision> <resolution-file> --human-confirmed --json/);

  assert.deepEqual(
    decisionResolutionInputSchema.parse(YAML.parse(taggedYamlExample(brainstorm.content, 'brainstorm-decision-resolution-input'))),
    {
      optionId: 'OPT-01',
      summary: 'The evidence supports the staged migration approach for the selected option.',
      authority: 'AGENT_EVIDENCE',
      sourceRefs: [{
        kind: 'evidence',
        evidenceId: 'EVD-000001',
        contentHash: `sha256:${'b'.repeat(64)}`,
      }],
    },
  );
  assert.match(brainstorm.content, /omnai decision resolve <decision> <resolution-file> --json/);
  assert.doesNotMatch(brainstorm.content, /omnai decision resolve[^\n]*--authority/);
  assert.match(brainstorm.content, /Repository Decision mode\s+Produce one same-criteria comparison, one recommendation, one strict resolution, one fresh route/i);
  assert.match(brainstorm.content, /Workset Re-entry mode\s+Produce one same-criteria comparison, one recommendation, selection under the current WRE, one fresh Workset route/i);
  assert.match(brainstorm.content, /downstream Design artifact production is a separately routed action/i);

  const proposals = YAML.parse(taggedYamlExample(reentryPlan.content, 'workset-reconcile-proposals'));
  assert.ok(Array.isArray(proposals));
  assert.deepEqual(proposals.map((proposal) => projectReconcileProposalSchema.parse(proposal)), [
    {
      project: 'consent-service',
      outcome: 'REQUIRED',
      level: 'L2',
      reopenFrom: 'design',
      taskRoots: ['TASK-003'],
    },
    {
      project: 'audit-dashboard',
      outcome: 'NOT_REQUIRED',
    },
  ]);
  assert.match(reentryPlan.content, /evidence and explanation.*beside the strict file/i);
  assert.match(reentryPlan.content, /Core computes closures from semantic roots/i);

  const minimumLevels = YAML.parse(taggedYamlExample(reentryPlan.content, 'workset-reentry-minimum-levels'));
  assert.deepEqual(minimumLevels, Object.fromEntries(
    REENTRY_KINDS.map((kind) => [kind, minimumReconcileLevel(kind)]),
  ));
  assert.equal(minimumLevels.DOMAIN_CHANGED, 'L3');

  const routeCapabilities = ['research', 'frame', 'model', 'spec', 'design', 'experiment', 'plan', 'work'] as const;
  const readinessKeys = YAML.parse(taggedYamlExample(reentryPlan.content, 'workset-reentry-readiness-keys'));
  assert.deepEqual(readinessKeys, Object.fromEntries(
    routeCapabilities.map((capability) => [capability, readinessKeyForCapability(capability)]),
  ));
  assert.equal(readinessKeys.model, 'domain');
});

test('repository protocols bind durable decisions to DEC references and keep Tasks project-local', async () => {
  const [map, model, design, plan, reconcile] = await Promise.all([
    loadProtocol('repository.map'),
    loadProtocol('repository.model'),
    loadProtocol('repository.design'),
    loadProtocol('repository.plan'),
    loadProtocol('repository.reconcile'),
  ]);

  assert.equal(map.version, 2);
  assert.match(map.content, /DEC-/);
  assert.match(map.content, /resolved.*frontier.*blocked/is);
  assert.match(map.content, /fog.*(?:not|never).*(?:Decision|Task)/is);

  assert.equal(model.version, 2);
  assert.match(model.content, /domain\.md.*DEC-|DEC-.*domain\.md/is);
  assert.match(model.content, /status.*ownership.*DecisionRecord|DecisionRecord.*status.*ownership/is);

  assert.equal(design.version, 3);
  assert.match(design.content, /selected.*rejected.*DEC-|DEC-.*selected.*rejected/is);
  assert.match(design.content, /not-applicable/);
  assert.match(design.content, /focused/);
  assert.match(design.content, /full/);

  assert.equal(plan.version, 3);
  assert.match(plan.content, /unresolved DecisionRecord|unresolved decision/i);
  assert.match(plan.content, /project-local/i);
  assert.match(plan.content, /never.*cross-project task dependenc/i);
  assert.match(plan.content, /contract-only|only.*contract/i);

  assert.equal(reconcile.version, 3);
  assert.match(reconcile.content, /DecisionRecord.*FlowAssessment|FlowAssessment.*DecisionRecord/i);
  assert.match(reconcile.content, /FlowPlan.*lineage|lineage.*FlowPlan/i);
  assert.match(reconcile.content, /new Revision.*Core route|Core route.*new Revision/i);
});

test('prepared capability context appends validated Flow and sorted Decisions as read-only Core state', async () => {
  const repo = await createTestRepository('flow-stage-context');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Consent ownership', 'complex-domain-feature');
  await openDecision(repo.root, change, decisionInput('Who owns consent?'));
  await openDecision(repo.root, change, decisionInput('Who owns deletion?'));

  assert.deepEqual((await listDecisions(repo.root, change)).map(({ id }) => id), ['DEC-0001', 'DEC-0002']);
  const prepared = await prepareStage(repo.root, change, 'model', 'Recover the domain model.');
  const prompt = await readFile(prepared.promptPath, 'utf8');

  const ordinaryContext = prompt.indexOf('SOURCE: .omnai/project/learnings.md');
  const routingNotice = prompt.indexOf('Core-owned routing state. Read for identity and status; mutate only through omnai flow/decision commands.');
  const flow = prompt.indexOf(`SOURCE: .omnai/changes/${change.directoryName}/flow.yaml`);
  const first = prompt.indexOf(`SOURCE: .omnai/changes/${change.directoryName}/decisions/DEC-0001.yaml`);
  const second = prompt.indexOf(`SOURCE: .omnai/changes/${change.directoryName}/decisions/DEC-0002.yaml`);
  assert.ok(ordinaryContext >= 0 && ordinaryContext < routingNotice);
  assert.ok(routingNotice < flow && flow < first && first < second);
  assert.deepEqual(prepared.manifest.outputPaths, [`.omnai/changes/${change.directoryName}/domain.md`]);
  assert.doesNotMatch(prepared.manifest.outputPaths.join('\n'), /flow\.yaml|decisions\//i);
});

test('a legacy Change without Flow remains valid while sorted Decisions still enter prepared context', async () => {
  const repo = await createTestRepository('legacy-stage-context');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Legacy consent ownership', 'complex-domain-feature');
  await rm(changeFlowPath(repo.root, change.directoryName));
  await openDecision(repo.root, change, decisionInput('Who owns legacy consent?'));

  const prepared = await prepareStage(repo.root, change, 'model', 'Recover the legacy domain model.');
  const prompt = await readText(prepared.promptPath);

  assert.doesNotMatch(prompt, /SOURCE: .*flow\.yaml/);
  assert.match(prompt, /SOURCE: .*decisions\/DEC-0001\.yaml/);
  assert.match(prompt, /Core-owned routing state/);
});

test('invalid Flow fails before a run, progress event, or readiness mutation', async () => {
  const repo = await createTestRepository('invalid-flow-stage-context');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Invalid Flow context', 'complex-domain-feature');
  await writeYaml(changeFlowPath(repo.root, change.directoryName), { schemaVersion: 1 });
  const before = await mutationSnapshot(repo.root, change.directoryName);

  await assert.rejects(
    () => prepareStage(repo.root, change, 'model', 'Must fail closed.'),
    isSchemaFailure,
  );

  assert.deepEqual(await mutationSnapshot(repo.root, change.directoryName), before);
});

test('invalid Decision fails before a run, progress event, or readiness mutation', async () => {
  const repo = await createTestRepository('invalid-decision-stage-context');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Invalid Decision context', 'complex-domain-feature');
  await writeYaml(changeDecisionPath(repo.root, change.directoryName, 'DEC-0001'), { schemaVersion: 1 });
  const before = await mutationSnapshot(repo.root, change.directoryName);

  await assert.rejects(
    () => prepareStage(repo.root, change, 'model', 'Must fail closed.'),
    isSchemaFailure,
  );

  assert.deepEqual(await mutationSnapshot(repo.root, change.directoryName), before);
});

test('Flow Decision inventory mismatch fails before any stage side effect', async () => {
  const repo = await createTestRepository('stage-flow-decision-inventory');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Mismatched routing inventory', 'complex-domain-feature');
  await openDecision(repo.root, change, decisionInput('Who owns the inventory?'));
  const current = (await loadFlowPlan(repo.root, change))!;
  const withoutDecision = compileFlowPlan(
    change.metadata,
    getScenario(change.metadata.scenario),
    current.assessment,
    [],
    new Date().toISOString(),
  );
  await writeYaml(changeFlowPath(repo.root, change.directoryName), withoutDecision);
  const before = await mutationSnapshot(repo.root, change.directoryName);

  await assert.rejects(
    () => prepareStage(repo.root, change, 'model', 'Must reject split routing inventory.'),
    /FLOW_DECISION_INVENTORY_MISMATCH/,
  );

  assert.deepEqual(await mutationSnapshot(repo.root, change.directoryName), before);
});

test('a live Decision bound to a stale Revision fails before any stage side effect', async () => {
  const repo = await createTestRepository('stage-stale-live-decision');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Stale live routing decision', 'complex-domain-feature');
  const decision = await openDecision(repo.root, change, decisionInput('Who owns stale authority?'));
  await writeYaml(changeDecisionPath(repo.root, change.directoryName, decision.id), {
    ...decision,
    openedRevision: 'REV-0000',
  });
  const before = await mutationSnapshot(repo.root, change.directoryName);

  await assert.rejects(
    () => prepareStage(repo.root, change, 'model', 'Must reject stale live authority.'),
    /DECISION_STALE_REVISION: DEC-0001/,
  );

  assert.deepEqual(await mutationSnapshot(repo.root, change.directoryName), before);
});

test('stage preparation waits for the exact Change lock and cannot overwrite a concurrent Reconcile', async () => {
  const repo = await createTestRepository('stage-concurrent-reconcile');
  cleanups.push(repo.cleanup);
  const created = await createChange(repo.root, 'Concurrent stage preparation', 'complex-domain-feature');
  const stale = await resolveChange(repo.root, created.metadata.id);
  const reconciling = await resolveChange(repo.root, created.metadata.id);
  let signalReconciled: (() => void) | undefined;
  const reconciled = new Promise<void>((resolve) => { signalReconciled = resolve; });
  let releaseLock: (() => void) | undefined;
  const lockReleased = new Promise<void>((resolve) => { releaseLock = resolve; });
  let afterReconcile: Awaited<ReturnType<typeof mutationSnapshot>> | undefined;
  const mutation = withChangeMutationLock(repo.root, reconciling, async () => {
    await reconcileChangeWithinChangeLock(repo.root, reconciling, {
      level: 'L3',
      type: 'DOMAIN_CHANGED',
      reason: 'Concurrent ownership change',
      affectedReadiness: ['domain'],
    });
    afterReconcile = await mutationSnapshot(repo.root, reconciling.directoryName);
    signalReconciled?.();
    await lockReleased;
  });
  await reconciled;

  const preparation = prepareStage(repo.root, stale, 'model', 'Must observe the reconciled revision.');
  const earlyState = await Promise.race([
    preparation.then(() => 'SETTLED', () => 'SETTLED'),
    delay(100).then(() => 'WAITING'),
  ]);
  releaseLock?.();
  await mutation;
  assert.equal(earlyState, 'WAITING');
  await assert.rejects(() => preparation, /FLOW_STALE_REVISION/);
  assert.deepEqual(await mutationSnapshot(repo.root, stale.directoryName), afterReconcile);
});

test('all four Host Skills use one fresh exact route snapshot before Core mutations', async () => {
  const skillRoot = join(process.cwd(), 'skills');
  const entries = (await readdir(skillRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => name)
    .sort();
  assert.deepEqual(entries, ['omnai', 'omnai-brainstorm', 'omnai-grill', 'omnai-reconcile']);

  const bodies = new Map<string, string>();
  for (const name of entries) {
    const body = await readFile(join(skillRoot, name, 'SKILL.md'), 'utf8');
    bodies.set(name, body);
    assert.match(body, /fresh[^\n]*next --json|run[^\n]*next --json[^\n]*fresh/i, name);
    assert.match(body, /decisionIds/, name);
    assert.match(body, /ordered[^\n]*protocolIds|protocolIds[^\n]*ordered/i, name);
    assert.match(body, /Revision/, name);
    assert.match(body, /Baseline/, name);
    assert.match(body, /flowHash|Flow hash/, name);
    assert.match(body, /before[^\n]*(?:mutat|write|resolve)[^\n]*fresh|fresh[^\n]*before[^\n]*(?:mutat|write|resolve)/i, name);
    assert.match(body, /exact(?:ly)? compare|compare[^\n]*exact/i, name);
    assert.match(body, /one bounded action/i, name);
  }
  assert.match(bodies.get('omnai-grill') ?? '', /omnai decision resolve/i);
  assert.match(bodies.get('omnai-brainstorm') ?? '', /omnai decision resolve/i);
  assert.match(bodies.get('omnai') ?? '', /guarded Decision-Reconcile transaction/i);
  assert.match(bodies.get('omnai-reconcile') ?? '', /guarded Decision-Reconcile transaction/i);
  assert.match(bodies.get('omnai-reconcile') ?? '', /omnai decision resolve/i);
  assert.doesNotMatch(bodies.get('omnai-reconcile') ?? '', /use `omnai decision resolve` for a routed decision/i);
  assert.match(
    bodies.get('omnai-reconcile') ?? '',
    /existing `reentryId`.*exactly and only.*ordered `protocolIds`/is,
  );
  assert.match(
    bodies.get('omnai-reconcile') ?? '',
    /new signal.*no current routed `reentryId`.*workset\.reentry-classification.*immediately before.*`omnai workset change`.*fresh Workset routing/is,
  );
});

function decisionInput(question: string) {
  return {
    schemaVersion: 2 as const,
    kind: 'DOMAIN' as const,
    owner: 'HUMAN' as const,
    status: 'OPEN' as const,
    blocking: true,
    question,
    options: [],
    affects: {
      capabilities: ['model' as const],
      artifacts: ['domain.md'],
      tasks: [],
      projects: [],
      contracts: [],
    },
    sourceRefs,
  };
}

function taggedYamlExample(content: string, tag: string): string {
  const match = new RegExp(`<!-- ${tag} -->\\r?\\n` + '```yaml\\r?\\n([\\s\\S]*?)\\r?\\n```').exec(content);
  assert.ok(match, `missing tagged YAML example: ${tag}`);
  return match[1] ?? '';
}

async function mutationSnapshot(repoRoot: string, directoryName: string) {
  return {
    runs: await readdir(changeRunsRoot(repoRoot, directoryName)),
    progress: await readText(join(repoRoot, '.omnai', 'changes', directoryName, 'progress.jsonl')),
    metadata: await readText(changeMetadataPath(repoRoot, directoryName)),
  };
}

function isSchemaFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'ZodError';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
