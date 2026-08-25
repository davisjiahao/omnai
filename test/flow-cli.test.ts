import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import YAML from 'yaml';
import { createTestRepository } from './helpers.js';
import { openDecision } from '../src/core/decisions.js';
import { changeArtifactPath, changeRunsRoot, changeRevisionsRoot } from '../src/core/paths.js';
import { resolveChange, saveChange } from '../src/core/store.js';
import { loadTasks, saveTasks } from '../src/core/tasks.js';
import { taskSchema } from '../src/domain/types.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const sourceRef = {
  kind: 'artifact',
  path: 'domain.md',
  contentHash: `sha256:${'a'.repeat(64)}`,
};

function runCli(repoRoot: string, args: string[]) {
  return spawnSync(process.execPath, [resolve('dist/src/main.js'), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env },
  });
}

function runOk(repoRoot: string, args: string[]) {
  const result = runCli(repoRoot, args);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function runJson(repoRoot: string, args: string[]) {
  assert.equal(args.includes('--json'), false, 'runJson appends --json exactly once');
  const result = runCli(repoRoot, [...args, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout) as Record<string, any>;
}

async function createChange(scenario = 'complex-domain-feature') {
  const repo = await createTestRepository('flow-cli');
  cleanups.push(repo.cleanup);
  runOk(repo.root, ['init']);
  runOk(repo.root, ['new', 'Consent ownership', '--scenario', scenario]);
  const entries = await readdir(join(repo.root, '.omnai', 'changes'));
  const directoryName = entries.find((entry) => entry.startsWith('CHG-0001-'));
  assert.ok(directoryName);
  return { root: repo.root, directoryName };
}

function openDecisionInput(owner: 'HUMAN' | 'AGENT' = 'HUMAN', question = 'Who owns consent?') {
  return {
    kind: 'DOMAIN',
    owner,
    status: 'OPEN',
    blocking: true,
    question,
    options: [{
      id: 'OPT-01',
      label: 'User Center',
      status: 'VIABLE',
      consequences: ['User Center owns the consent lifecycle.'],
      sourceRefs: [sourceRef],
    }],
    affects: {
      capabilities: ['model'],
      artifacts: ['domain.md'],
      tasks: [],
      projects: [],
      contracts: [],
    },
    sourceRefs: [sourceRef],
  };
}

async function writeYaml(path: string, value: unknown): Promise<void> {
  await writeFile(path, YAML.stringify(value), 'utf8');
}

test('new Change exposes flow identity and enriched next JSON', async () => {
  const repo = await createChange();

  const flow = runJson(repo.root, ['flow', 'status']);
  assert.equal(flow.changeId, 'CHG-0001');
  assert.equal(flow.revision, 'REV-0001');
  assert.equal(flow.selectedInteraction, null);

  const next = runJson(repo.root, ['next']);
  assert.equal('legacy' in next, false);
  assert.equal(next.revision, 'REV-0001');
  assert.equal(next.baseline, 'BL-0001');
  assert.match(next.flowHash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(next.protocolIds, ['repository.research']);
});

test('repository status presents the adaptive route identity without replacing existing sections', async () => {
  const repo = await createChange();

  const status = runOk(repo.root, ['status']);
  assert.match(status.stdout, /Readiness/);
  assert.match(status.stdout, /Tasks:/);
  assert.match(status.stdout, /Flow hash: sha256:[0-9a-f]{64}/);
  assert.doesNotMatch(status.stdout, /Route mode:/);
  assert.match(status.stdout, /Decision causes: none/);
  assert.match(status.stdout, /Next: research/);
});

test('capability preparation prints the real PreparedStage prompt path', async () => {
  const repo = await createChange('small-feature');

  const prepared = runOk(repo.root, ['spec']);

  assert.match(prepared.stdout, /Read and execute: .*prompt\.md/);
  assert.doesNotMatch(prepared.stdout, /Read and execute: undefined/);
});

test('decision list, open, show, and human-confirmed resolve round-trip through strict files', async () => {
  const repo = await createChange();
  const openPath = join(repo.root, 'open.yaml');
  const resolutionPath = join(repo.root, 'resolution.json');
  await writeYaml(openPath, openDecisionInput());
  await writeFile(resolutionPath, JSON.stringify({
    optionId: 'OPT-01',
    summary: 'User Center owns consent.',
    authority: 'HUMAN_CONFIRMED',
    sourceRefs: [sourceRef],
  }), 'utf8');

  const opened = runJson(repo.root, ['decision', 'open', openPath]);
  assert.equal(opened.id, 'DEC-0001');
  assert.equal(runJson(repo.root, ['decision', 'show', 'DEC-0001']).status, 'OPEN');
  assert.deepEqual(
    (runJson(repo.root, ['decision', 'list']) as { id: string }[]).map(({ id }) => id),
    ['DEC-0001'],
  );

  const unconfirmed = runCli(repo.root, ['decision', 'resolve', 'DEC-0001', resolutionPath, '--json']);
  assert.notEqual(unconfirmed.status, 0);
  assert.match(unconfirmed.stderr, /HUMAN_CONFIRMATION_REQUIRED/);
  assert.equal(unconfirmed.stdout, '');

  const resolved = runJson(repo.root, [
    'decision', 'resolve', 'DEC-0001', resolutionPath, '--human-confirmed',
  ]);
  assert.equal(resolved.status, 'RESOLVED');
});

test('decision resolve rejects human-confirmed decoration for non-human authority', async () => {
  const repo = await createChange();
  const openPath = join(repo.root, 'agent-open.yaml');
  const resolutionPath = join(repo.root, 'agent-resolution.yaml');
  await writeYaml(openPath, openDecisionInput('AGENT', 'Which module owns consent?'));
  await writeYaml(resolutionPath, {
    optionId: 'OPT-01',
    summary: 'The evidence identifies User Center.',
    authority: 'AGENT_EVIDENCE',
    sourceRefs: [sourceRef],
  });
  runJson(repo.root, ['decision', 'open', openPath]);

  const decorated = runCli(repo.root, [
    'decision', 'resolve', 'DEC-0001', resolutionPath, '--human-confirmed', '--json',
  ]);
  assert.notEqual(decorated.status, 0);
  assert.match(decorated.stderr, /HUMAN_CONFIRMATION_NOT_APPLICABLE/);
  assert.equal(decorated.stdout, '');

  assert.equal(runJson(repo.root, [
    'decision', 'resolve', 'DEC-0001', resolutionPath,
  ]).status, 'RESOLVED');
});

test('decision supersede reads replacement evidence from a strict source file', async () => {
  const repo = await createChange();
  const firstPath = join(repo.root, 'first.yaml');
  const secondPath = join(repo.root, 'second.yaml');
  const sourcesPath = join(repo.root, 'sources.json');
  await writeYaml(firstPath, openDecisionInput('AGENT', 'Which module originally owned consent?'));
  await writeYaml(secondPath, openDecisionInput('AGENT', 'Which module now owns consent?'));
  await writeFile(sourcesPath, JSON.stringify([sourceRef]), 'utf8');
  runJson(repo.root, ['decision', 'open', firstPath]);
  runJson(repo.root, ['decision', 'open', secondPath]);

  const superseded = runJson(repo.root, [
    'decision', 'supersede', 'DEC-0001', 'DEC-0002',
    '--reason', 'The ownership evidence changed.', '--source', sourcesPath,
  ]);
  assert.equal(superseded.status, 'SUPERSEDED');
  assert.equal(superseded.supersededBy, 'DEC-0002');
});

test('mutating structured input is schema-strict and never treats inline JSON as a payload', async () => {
  const repo = await createChange();
  const invalidPath = join(repo.root, 'invalid-open.yaml');
  await writeYaml(invalidPath, { ...openDecisionInput(), inventedAuthority: true });

  const invalid = runCli(repo.root, ['decision', 'open', invalidPath, '--json']);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /unrecognized|inventedAuthority/i);
  assert.equal(invalid.stdout, '');

  const inline = runCli(repo.root, ['decision', 'open', JSON.stringify(openDecisionInput()), '--json']);
  assert.notEqual(inline.status, 0);
  assert.match(inline.stderr, /ENOENT|ENAMETOOLONG|no such file|name too long/i);
  assert.equal(inline.stdout, '');
  assert.deepEqual(runJson(repo.root, ['decision', 'list']), []);
});

test('flow assess rejects stale Revision and creates one new Revision for a current changed assessment', async () => {
  const repo = await createChange();
  const flowPath = join(repo.root, '.omnai', 'changes', repo.directoryName, 'flow.yaml');
  const flow = YAML.parse(await readFile(flowPath, 'utf8')) as Record<string, any>;
  const changedAssessment = { ...flow.assessment, topology: 'CROSS_MODULE' };
  const currentProposal = {
    schemaVersion: 1,
    changeId: flow.changeId,
    revision: flow.revision,
    baseline: flow.baseline,
    assessment: changedAssessment,
  };
  const staleProposalPath = join(repo.root, 'stale-assessment.yaml');
  const currentProposalPath = join(repo.root, 'current-assessment.yaml');
  await writeYaml(staleProposalPath, { ...currentProposal, revision: 'REV-0000' });
  await writeYaml(currentProposalPath, currentProposal);

  const stale = runCli(repo.root, ['flow', 'assess', staleProposalPath, '--json']);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /FLOW_STALE_REVISION/);
  assert.equal(stale.stdout, '');

  const accepted = runJson(repo.root, ['flow', 'assess', currentProposalPath]);
  assert.equal(accepted.flow.revision, 'REV-0002');
  assert.equal(accepted.reconcile.revision.id, 'REV-0002');
  const revisions = (await readdir(join(repo.root, '.omnai', 'changes', repo.directoryName, 'revisions')))
    .filter((entry) => /^REV-\d{4}\.yaml$/.test(entry));
  assert.deepEqual(revisions.sort(), ['REV-0001.yaml', 'REV-0002.yaml']);
});

test('real capability --complete CLI is fenced by a pending Decision transaction with zero state change', async () => {
  const repo = await createChange();
  const change = await resolveChange(repo.root, 'CHG-0001');
  await writeFile(
    changeArtifactPath(repo.root, change.directoryName, 'spec.md'),
    '# Change Specification\n\n## Added Requirements\n\n- AC-001: preserve transaction authority.\n',
    'utf8',
  );
  change.metadata.readiness.research = 'READY';
  change.metadata.readiness.domain = 'READY';
  change.metadata.readiness.spec = 'READY';
  await saveChange(repo.root, change);
  const decision = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true,
    question: 'Who owns guarded capability completion?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs: [{ kind: 'artifact', path: 'domain.md', contentHash: `sha256:${'a'.repeat(64)}` }],
  });
  assert.equal(
    crashDecisionCliAtStage(repo.root, change.metadata.id, decision.id, 'FLOW_RECONCILE_METADATA_SAVED'),
    91,
  );
  const before = await cliMutationSnapshot(repo.root, repo.directoryName);

  const result = runCli(repo.root, ['spec', '--complete']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DECISION_RECONCILE_TRANSACTION_PENDING/);
  assert.deepEqual(await cliMutationSnapshot(repo.root, repo.directoryName), before);
});

test('real work CLI commits task readiness and audit only through one guarded Core mutation', async () => {
  const repo = await createChange();
  const change = await resolveChange(repo.root, 'CHG-0001');
  const tasksPath = changeArtifactPath(repo.root, change.directoryName, 'tasks.yaml');
  const taskFile = await loadTasks(tasksPath);
  taskFile.tasks = [taskSchema.parse({
    id: 'TASK-001',
    title: 'Guarded task',
    objective: 'Prove task mutation is fenced',
    status: 'READY',
    dependsOn: [],
    slice: 'VERTICAL',
    risk: 'MEDIUM',
    files: { create: [], modify: [], tests: [] },
    consumes: [],
    produces: [],
    steps: ['implement'],
    evidenceRequired: ['test'],
    notes: [],
  })];
  await saveTasks(tasksPath, taskFile);
  change.metadata.readiness.research = 'READY';
  change.metadata.readiness.domain = 'READY';
  await saveChange(repo.root, change);
  const decision = await openDecision(repo.root, change, { schemaVersion: 2,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true,
    question: 'Who owns guarded task mutation?', options: [],
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs: [{ kind: 'artifact', path: 'domain.md', contentHash: `sha256:${'a'.repeat(64)}` }],
  });
  assert.equal(
    crashDecisionCliAtStage(repo.root, change.metadata.id, decision.id, 'FLOW_RECONCILE_METADATA_SAVED'),
    91,
  );
  const before = await cliMutationSnapshot(repo.root, repo.directoryName);

  const result = runCli(repo.root, ['work', 'TASK-001']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DECISION_RECONCILE_TRANSACTION_PENDING/);
  assert.deepEqual(await cliMutationSnapshot(repo.root, repo.directoryName), before);
});

test('missing final Flow fails closed without exposing a migration reader', async () => {
  const repo = await createChange('small-feature');
  const root = join(repo.root, '.omnai', 'changes', repo.directoryName);
  const flowPath = join(root, 'flow.yaml');
  await rm(flowPath);

  const next = runCli(repo.root, ['next', '--json']);
  assert.notEqual(next.status, 0);
  assert.match(next.stderr, /FLOW_PLAN_REQUIRED/);
  assert.equal(next.stdout, '');

  const status = runCli(repo.root, ['flow', 'status', '--json']);
  assert.notEqual(status.status, 0);
  assert.match(status.stderr, /FLOW_PLAN_REQUIRED/);
  assert.equal(status.stdout, '');

  const migrate = runCli(repo.root, ['flow', 'migrate', '--json']);
  assert.notEqual(migrate.status, 0);
  assert.match(migrate.stderr, /Unknown flow command/);
  assert.equal(migrate.stdout, '');
});

function crashDecisionCliAtStage(
  repoRoot: string,
  changeId: string,
  decisionId: string,
  stage: 'FLOW_RECONCILE_METADATA_SAVED',
): number | null {
  const storeModule = new URL('../src/core/store.js', import.meta.url).href;
  const decisionModule = new URL('../src/core/decisions.js', import.meta.url).href;
  const resolution = {
    optionId: null,
    summary: 'Identity owns the guarded mutation',
    authority: 'HUMAN_CONFIRMED',
    sourceRefs: [sourceRef],
  };
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

async function cliMutationSnapshot(repoRoot: string, directoryName: string) {
  const root = join(repoRoot, '.omnai', 'changes', directoryName);
  const revisionRoot = changeRevisionsRoot(repoRoot, directoryName);
  const revisionFiles = (await readdir(revisionRoot)).sort();
  return {
    metadata: await readFile(join(root, 'change.yaml'), 'utf8'),
    flow: await readFile(join(root, 'flow.yaml'), 'utf8'),
    tasks: await readFile(join(root, 'tasks.yaml'), 'utf8'),
    progress: await readFile(join(root, 'progress.jsonl'), 'utf8'),
    runs: (await readdir(changeRunsRoot(repoRoot, directoryName))).sort(),
    revisionFiles,
    revisions: await Promise.all(revisionFiles.map((file) => readFile(join(revisionRoot, file), 'utf8'))),
  };
}
