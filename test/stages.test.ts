import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { createTestRepository } from './helpers.js';
import { createChange, resolveChange, saveChange } from '../src/core/store.js';
import { completeStage, prepareStage } from '../src/core/stages.js';
import { readText, writeTextAtomic } from '../src/core/files.js';
import { changeArtifactPath, changeMetadataPath } from '../src/core/paths.js';
import { openDecision, resolveDecision } from '../src/core/decisions.js';
import { reconcileChange } from '../src/core/reconcile.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

test('prepares a bounded prompt with authoritative artifact context', async () => {
  const fixture = await createTestRepository();
  cleanups.push(fixture.cleanup);
  const created = await createChange(fixture.root, 'Add customer lookup', 'small-feature');
  const change = await resolveChange(fixture.root, created.metadata.id);
  const prepared = await prepareStage(fixture.root, change, 'spec', 'Specify lookup by customer ID');
  const prompt = await readText(prepared.promptPath);

  assert.match(prompt, /Capability: spec/);
  assert.match(prompt, /SOURCE: \.omnai\/changes/);
  assert.match(prompt, /Added Requirements/);
  assert.equal(change.metadata.readiness.spec, 'IN_PROGRESS');
});

test('marks an authored canonical artifact ready after completion validation', async () => {
  const fixture = await createTestRepository();
  cleanups.push(fixture.cleanup);
  const created = await createChange(fixture.root, 'Add customer lookup', 'small-feature');
  const change = await resolveChange(fixture.root, created.metadata.id);
  await writeTextAtomic(
    changeArtifactPath(fixture.root, change.directoryName, 'spec.md'),
    '# Change Specification\n\n## Added Requirements\n\n- AC-001: lookup by customer ID returns the matching customer.\n\n## Non-goals\n\n- No fuzzy search.\n',
  );
  await completeStage(fixture.root, change, 'spec');
  assert.equal(change.metadata.readiness.spec, 'READY');
});

test('stage completion is fenced by a pending Decision-Reconcile transaction before any state change', async () => {
  const fixture = await createTestRepository('stage-complete-decision-fence');
  cleanups.push(fixture.cleanup);
  const change = await createChange(fixture.root, 'Fence stage completion', 'complex-domain-feature');
  await writeTextAtomic(
    changeArtifactPath(fixture.root, change.directoryName, 'spec.md'),
    '# Change Specification\n\n## Added Requirements\n\n- AC-001: preserve fenced authority.\n',
  );
  change.metadata.readiness.research = 'READY';
  change.metadata.readiness.domain = 'READY';
  change.metadata.readiness.spec = 'READY';
  await saveChange(fixture.root, change);
  const decision = await openDecision(fixture.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true,
    question: 'Who owns fenced completion?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs: [{ kind: 'artifact', path: 'domain.md', contentHash: `sha256:${'a'.repeat(64)}` }],
  });
  const resolution = {
    summary: 'Identity owns fenced completion',
    optionId: null,
    authority: 'HUMAN_CONFIRMED' as const,
    sourceRefs: [{ kind: 'artifact' as const, path: 'domain.md', contentHash: `sha256:${'a'.repeat(64)}` as const }],
  };
  assert.equal(
    crashDecisionAtStage(
      fixture.root,
      change.metadata.id,
      decision.id,
      resolution,
      'FLOW_RECONCILE_METADATA_SAVED',
    ),
    91,
  );
  const interrupted = await resolveChange(fixture.root, change.metadata.id);
  const before = await stageMutationSnapshot(fixture.root, change.directoryName);

  await assert.rejects(
    () => completeStage(fixture.root, interrupted, 'spec'),
    /DECISION_RECONCILE_TRANSACTION_PENDING/,
  );
  assert.deepEqual(await stageMutationSnapshot(fixture.root, change.directoryName), before);
});

test('stage completion uses active Revision and Baseline CAS instead of overwriting concurrent Reconcile metadata', async () => {
  const fixture = await createTestRepository('stage-complete-cas');
  cleanups.push(fixture.cleanup);
  const created = await createChange(fixture.root, 'CAS stage completion', 'small-feature');
  await writeTextAtomic(
    changeArtifactPath(fixture.root, created.directoryName, 'spec.md'),
    '# Change Specification\n\n## Added Requirements\n\n- AC-001: preserve the active revision.\n',
  );
  const stale = await resolveChange(fixture.root, created.metadata.id);
  const fresh = await resolveChange(fixture.root, created.metadata.id);
  await reconcileChange(fixture.root, fresh, {
    level: 'L0',
    type: 'IMPLEMENTATION_CHANGED',
    reason: 'Concurrent revision before stage completion',
  });
  const before = await stageMutationSnapshot(fixture.root, created.directoryName);

  await assert.rejects(
    () => completeStage(fixture.root, stale, 'spec'),
    /FLOW_STALE_REVISION|STAGE_STALE_REVISION/,
  );
  assert.deepEqual(await stageMutationSnapshot(fixture.root, created.directoryName), before);
});

async function stageMutationSnapshot(repoRoot: string, directoryName: string) {
  return {
    metadata: await readText(changeMetadataPath(repoRoot, directoryName)),
    progress: await readText(changeArtifactPath(repoRoot, directoryName, 'progress.jsonl')),
  };
}

function crashDecisionAtStage(
  repoRoot: string,
  changeId: string,
  decisionId: string,
  resolution: Parameters<typeof resolveDecision>[3],
  stage: 'FLOW_RECONCILE_METADATA_SAVED',
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
