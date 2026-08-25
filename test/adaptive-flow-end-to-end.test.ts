import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import YAML from 'yaml';
import { createTestDirectory, createTestRepository } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function runCli(repoRoot: string, args: string[], environment: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [resolve('dist/src/main.js'), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

function runOk(repoRoot: string, args: string[]) {
  const result = runCli(repoRoot, args);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result;
}

function runJson<T>(repoRoot: string, args: string[]): T {
  assert.equal(args.includes('--json'), false, 'runJson appends --json exactly once');
  return JSON.parse(runOk(repoRoot, [...args, '--json']).stdout) as T;
}

function runBlockedRouteJson<T>(repoRoot: string, args: string[]): T {
  const result = runCli(repoRoot, [...args, '--json']);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout) as T;
}

async function writeYaml(path: string, value: unknown): Promise<void> {
  await writeFile(path, YAML.stringify(value), 'utf8');
}

const sourceRef = {
  kind: 'artifact',
  path: 'research.md',
  contentHash: `sha256:${'a'.repeat(64)}`,
};

function decisionInput(input: {
  kind: 'DOMAIN' | 'ARCHITECTURE';
  owner: 'HUMAN' | 'AGENT';
  question: string;
  capability: 'model' | 'design';
  options: Array<{ id: 'OPT-01' | 'OPT-02'; label: string }>;
}) {
  return {
    kind: input.kind,
    owner: input.owner,
    status: 'OPEN',
    blocking: true,
    question: input.question,
    options: input.options.map((option) => ({
      ...option,
      status: 'VIABLE',
      consequences: [`${option.label} remains source-bound.`],
      sourceRefs: [sourceRef],
    })),
    affects: {
      capabilities: [input.capability],
      artifacts: [input.capability === 'model' ? 'domain.md' : 'design.md'],
      tasks: [],
      projects: [],
      contracts: [],
    },
    sourceRefs: [sourceRef],
  };
}

test('adaptive flow routes decisions and rejects prior-Revision evidence after reassessment', async () => {
  const repo = await createTestRepository('adaptive-flow-e2e');
  cleanups.push(repo.cleanup);
  runOk(repo.root, ['init']);
  runOk(repo.root, ['new', 'Consent ownership migration', '--scenario', 'complex-domain-feature']);

  const changeDirectory = (await readdir(join(repo.root, '.omnai', 'changes')))
    .find((entry) => entry.startsWith('CHG-0001-'));
  assert.ok(changeDirectory);
  const changeRoot = join(repo.root, '.omnai', 'changes', changeDirectory);

  const initialFlow = runJson<{
    changeId: string;
    revision: string;
    baseline: string;
    selectedInteraction: string | null;
  }>(repo.root, ['flow', 'status']);
  assert.deepEqual(
    {
      changeId: initialFlow.changeId,
      revision: initialFlow.revision,
      baseline: initialFlow.baseline,
      selectedInteraction: initialFlow.selectedInteraction,
    },
    {
      changeId: 'CHG-0001',
      revision: 'REV-0001',
      baseline: 'BL-0001',
      selectedInteraction: null,
    },
  );
  const initialRoute = runJson<{
    capability: string | null;
    protocolIds: string[];
    decisionIds: string[];
    revision: string;
    baseline: string;
    flowHash: string;
  }>(repo.root, ['next']);
  assert.deepEqual(routeProjection(initialRoute), {
    capability: 'research',
    protocolIds: ['repository.research'],
    decisionIds: [],
    revision: 'REV-0001',
    baseline: 'BL-0001',
  });
  assert.match(initialRoute.flowHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal('legacy' in initialRoute, false);

  await writeFile(
    join(changeRoot, 'research.md'),
    '# Current-State Report\n\n## Confirmed Facts\n\nConsent ownership is split across modules.\n\n## Evidence References\n\n- src/consent.ts:1-20\n',
    'utf8',
  );
  runOk(repo.root, ['research', '--complete']);

  const domainDecisionPath = join(repo.root, 'domain-decision.yaml');
  const domainResolutionPath = join(repo.root, 'domain-resolution.yaml');
  await writeYaml(domainDecisionPath, decisionInput({
    kind: 'DOMAIN',
    owner: 'HUMAN',
    question: 'Who owns the consent lifecycle?',
    capability: 'model',
    options: [{ id: 'OPT-01', label: 'Identity domain' }],
  }));
  await writeYaml(domainResolutionPath, {
    optionId: 'OPT-01',
    summary: 'Identity owns the consent lifecycle.',
    authority: 'HUMAN_CONFIRMED',
    sourceRefs: [sourceRef],
  });
  assert.equal(runJson<{ id: string }>(repo.root, ['decision', 'open', domainDecisionPath]).id, 'DEC-0001');
  assert.deepEqual(
    routeProjection(runJson(repo.root, ['next'])),
    {
      capability: 'model',
      protocolIds: ['interaction.grill', 'repository.model'],
      decisionIds: ['DEC-0001'],
      revision: 'REV-0001',
      baseline: 'BL-0001',
    },
  );
  assert.equal(runJson<{ status: string }>(repo.root, [
    'decision', 'resolve', 'DEC-0001', domainResolutionPath, '--human-confirmed',
  ]).status, 'RESOLVED');

  await writeFile(
    join(changeRoot, 'domain.md'),
    '# Domain Model\n\n## Ownership and Boundaries\n\nIdentity owns consent lifecycle transitions.\n',
    'utf8',
  );
  runOk(repo.root, ['model', '--complete']);
  await writeFile(
    join(changeRoot, 'spec.md'),
    '# Change Specification\n\n## Added Requirements\n\n- AC-001: consent ownership moves without changing observable authorization.\n',
    'utf8',
  );
  runOk(repo.root, ['spec', '--complete']);

  const architectureDecisionPath = join(repo.root, 'architecture-decision.yaml');
  const architectureResolutionPath = join(repo.root, 'architecture-resolution.yaml');
  await writeYaml(architectureDecisionPath, decisionInput({
    kind: 'ARCHITECTURE',
    owner: 'AGENT',
    question: 'Which viable ownership seam should carry consent?',
    capability: 'design',
    options: [
      { id: 'OPT-01', label: 'Adapter seam' },
      { id: 'OPT-02', label: 'Event seam' },
    ],
  }));
  await writeYaml(architectureResolutionPath, {
    optionId: 'OPT-01',
    summary: 'Repository evidence selects the adapter seam.',
    authority: 'AGENT_EVIDENCE',
    sourceRefs: [sourceRef],
  });
  assert.equal(runJson<{ id: string }>(repo.root, ['decision', 'open', architectureDecisionPath]).id, 'DEC-0002');
  assert.deepEqual(
    routeProjection(runJson(repo.root, ['next'])),
    {
      capability: 'design',
      protocolIds: ['interaction.brainstorm', 'repository.design'],
      decisionIds: ['DEC-0002'],
      revision: 'REV-0001',
      baseline: 'BL-0001',
    },
  );
  assert.equal(runJson<{ status: string }>(repo.root, [
    'decision', 'resolve', 'DEC-0002', architectureResolutionPath,
  ]).status, 'RESOLVED');

  runOk(repo.root, [
    'verify', '--record', 'test', '--requirement', 'behavior-tests', '--status', 'PASS',
    '--summary', 'REV-0001 behavior evidence',
  ]);

  const currentFlow = runJson<{
    changeId: string;
    revision: string;
    baseline: string;
    assessment: Record<string, unknown>;
  }>(repo.root, ['flow', 'status']);
  const assessmentPath = join(repo.root, 'cross-module-assessment.yaml');
  await writeYaml(assessmentPath, {
    schemaVersion: 1,
    changeId: currentFlow.changeId,
    revision: currentFlow.revision,
    baseline: currentFlow.baseline,
    assessment: {
      ...currentFlow.assessment,
      topology: 'CROSS_MODULE',
      architectureApplicability: 'FOCUSED',
    },
  });
  const assessed = runJson<{
    flow: {
      revision: string;
      baseline: string;
      assessment: { architectureApplicability: string };
    };
    reconcile: { revision: { id: string; baseline: string } };
  }>(repo.root, ['flow', 'assess', assessmentPath]);
  assert.deepEqual(
    {
      flowRevision: assessed.flow.revision,
      flowBaseline: assessed.flow.baseline,
      reconcileRevision: assessed.reconcile.revision.id,
      reconcileBaseline: assessed.reconcile.revision.baseline,
    },
    {
      flowRevision: 'REV-0002',
      flowBaseline: 'BL-0002',
      reconcileRevision: 'REV-0002',
      reconcileBaseline: 'BL-0002',
    },
  );
  assert.equal(assessed.flow.assessment.architectureApplicability, 'FOCUSED');
  const reassessedRoute = runBlockedRouteJson<{
    capability: string | null;
    protocolIds: string[];
    decisionIds: string[];
    revision: string;
    baseline: string;
  }>(repo.root, ['next']);
  assert.deepEqual(routeProjection(reassessedRoute), {
    capability: 'design',
    protocolIds: ['repository.design'],
    decisionIds: [],
    revision: 'REV-0002',
    baseline: 'BL-0002',
  });
  const designBundle = runJson<{
    protocols: Array<{ id: string }>;
    rendered: string;
  }>(repo.root, ['protocol', 'show', ...reassessedRoute.protocolIds]);
  assert.deepEqual(
    designBundle.protocols.map(({ id }) => id),
    ['common.authoritative-work', 'repository.design'],
  );
  assert.match(designBundle.rendered, /focused.*internal interface or module boundary/is);
  assert.match(designBundle.rendered, /dependency direction.*interface test surface.*migration/is);
  assert.ok(await readFile(join(changeRoot, 'revisions', 'REV-0001.flow.yaml'), 'utf8'));

  const matrix = runOk(repo.root, ['verify', '--matrix']).stdout;
  assert.match(matrix, /^MISSING behavior-tests\b/m);
  const evidenceRecords = await Promise.all(
    (await readdir(join(changeRoot, 'evidence')))
      .filter((entry) => entry.endsWith('.yaml'))
      .map(async (entry) => YAML.parse(await readFile(join(changeRoot, 'evidence', entry), 'utf8')) as { revision: string }),
  );
  assert.ok(evidenceRecords.some(({ revision }) => revision === 'REV-0001'));
  assert.equal(evidenceRecords.some(({ revision }) => revision === 'REV-0002'), false);
});

test('a migration program routes to Map immediately after Frame', async () => {
  const repo = await createTestRepository('adaptive-flow-program');
  cleanups.push(repo.cleanup);
  runOk(repo.root, ['init']);
  runOk(repo.root, ['new', 'Consent platform migration', '--scenario', 'migration-program']);
  const changeDirectory = (await readdir(join(repo.root, '.omnai', 'changes')))
    .find((entry) => entry.startsWith('CHG-0001-'));
  assert.ok(changeDirectory);

  assert.equal(runJson<{ capability: string }>(repo.root, ['next']).capability, 'frame');
  await writeFile(
    join(repo.root, '.omnai', 'changes', changeDirectory, 'intent.md'),
    '# Intent: Consent platform migration\n\n## Goal\n\nRetire the legacy consent owner.\n\n## Scope\n\nMap the bounded migration program.\n',
    'utf8',
  );
  runOk(repo.root, ['frame', '--complete']);

  assert.deepEqual(
    routeProjection(runJson(repo.root, ['next'])),
    {
      capability: 'map',
      protocolIds: ['repository.map'],
      decisionIds: [],
      revision: 'REV-0001',
      baseline: 'BL-0001',
    },
  );
});

test('an untouched small feature starts at Spec without an interaction overlay', async () => {
  const repo = await createTestRepository('adaptive-flow-fast-path');
  cleanups.push(repo.cleanup);
  runOk(repo.root, ['init']);
  runOk(repo.root, ['new', 'Expose consent status', '--scenario', 'small-feature']);

  const flow = runJson<{ selectedInteraction: string | null }>(repo.root, ['flow', 'status']);
  assert.equal(flow.selectedInteraction, null);
  assert.deepEqual(
    routeProjection(runJson(repo.root, ['next'])),
    {
      capability: 'spec',
      protocolIds: ['repository.spec'],
      decisionIds: [],
      revision: 'REV-0001',
      baseline: 'BL-0001',
    },
  );
});

test('removing final Flow fails closed without a migration reader', async () => {
  const repo = await createTestRepository('adaptive-flow-legacy');
  cleanups.push(repo.cleanup);
  runOk(repo.root, ['init']);
  runOk(repo.root, ['new', 'Expose consent status', '--scenario', 'small-feature']);
  const changeDirectory = (await readdir(join(repo.root, '.omnai', 'changes')))
    .find((entry) => entry.startsWith('CHG-0001-'));
  assert.ok(changeDirectory);

  await rm(join(repo.root, '.omnai', 'changes', changeDirectory, 'flow.yaml'));
  const next = runCli(repo.root, ['next', '--json']);
  assert.notEqual(next.status, 0);
  assert.match(next.stderr, /FLOW_PLAN_REQUIRED/);
  assert.equal(next.stdout, '');

  const unavailable = runCli(repo.root, ['flow', 'status', '--json']);
  assert.notEqual(unavailable.status, 0);
  assert.match(unavailable.stderr, /FLOW_PLAN_REQUIRED/);
  const migrate = runCli(repo.root, ['flow', 'migrate', '--json']);
  assert.notEqual(migrate.status, 0);
  assert.match(migrate.stderr, /Unknown flow command/);
  assert.equal(migrate.stdout, '');
});

test('compiled surfaces keep Tasks project-local and install exactly four Host Skills', async () => {
  const repo = await createTestRepository('adaptive-flow-surface');
  const omnaiHome = await createTestDirectory('adaptive-flow-home-');
  const userHome = await createTestDirectory('adaptive-flow-user-');
  cleanups.push(repo.cleanup, omnaiHome.cleanup, userHome.cleanup);
  runOk(repo.root, ['init']);
  runOk(repo.root, ['new', 'Expose consent status', '--scenario', 'small-feature']);
  const changeDirectory = (await readdir(join(repo.root, '.omnai', 'changes')))
    .find((entry) => entry.startsWith('CHG-0001-'));
  assert.ok(changeDirectory);

  const route = runJson<Record<string, unknown>>(repo.root, ['next']);
  assert.equal(Object.hasOwn(route, 'dependsOn'), false);
  const planProtocol = runJson<{ rendered: string }>(repo.root, ['protocol', 'show', 'repository.plan']);
  assert.match(planProtocol.rendered, /never.*cross-project task dependenc/i);

  const install = runCli(repo.root, ['host', 'install', 'codex', '--json'], {
    OMNAI_HOME: omnaiHome.root,
    HOME: userHome.root,
    USERPROFILE: userHome.root,
  });
  assert.equal(install.status, 0, install.stderr);
  const installedSkills = (await readdir(join(userHome.root, '.agents', 'skills'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(installedSkills, ['omnai', 'omnai-brainstorm', 'omnai-grill', 'omnai-reconcile']);

  await writeYaml(join(repo.root, '.omnai', 'changes', changeDirectory, 'tasks.yaml'), {
    schemaVersion: 1,
    revision: 'REV-0001',
    generatedFrom: ['spec:AC-001'],
    tasks: [{
      id: 'TASK-001',
      title: 'Illegal cross-project dependency',
      objective: 'This task must be rejected.',
      status: 'PENDING',
      dependsOn: ['other-project:TASK-001'],
      slice: 'VERTICAL',
      risk: 'MEDIUM',
      files: { create: [], modify: [], tests: [] },
      consumes: [],
      produces: [],
      steps: ['Do not execute'],
      evidenceRequired: ['test'],
      notes: [],
    }],
  });
  const invalidPlan = runCli(repo.root, ['plan', '--complete']);
  assert.notEqual(invalidPlan.status, 0);
  assert.match(invalidPlan.stderr, /CROSS_PROJECT_TASK_DEPENDENCY.*other-project:TASK-001/);
});

function routeProjection(value: unknown) {
  const route = value as {
    capability: string | null;
    protocolIds: string[];
    decisionIds: string[];
    revision: string;
    baseline: string;
  };
  return {
    capability: route.capability,
    protocolIds: route.protocolIds,
    decisionIds: route.decisionIds,
    revision: route.revision,
    baseline: route.baseline,
  };
}

function routeBehavior(value: Record<string, unknown>) {
  return {
    capability: value.capability,
    reason: value.reason,
    blocked: value.blocked,
    protocolIds: value.protocolIds,
    decisionIds: value.decisionIds,
    revision: value.revision,
    baseline: value.baseline,
  };
}
