import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import YAML from 'yaml';
import type { ContractCandidate } from '../src/execution/artifacts.js';
import { readJsonLines, readYaml, writeYaml } from '../src/core/files.js';
import { changeArtifactPath } from '../src/core/paths.js';
import {
  createChange,
  loadProjectConfig,
  resolveChange,
  saveProjectConfig,
} from '../src/core/store.js';
import { saveTasks } from '../src/core/tasks.js';
import {
  captureContractSources,
  createContractSnapshot,
  discoverContractCoordinationScopes,
  loadContractSnapshot,
  loadReadyContractSnapshot,
  loadReadyContractSnapshotsForTask,
  markContractReady,
  supersedeContractSnapshot,
  validateContractSnapshot,
  type ContractCoordinationScope,
  type ContractSource,
  type ContractStoreContext,
} from '../src/execution/contracts/store.js';
import {
  discoverContractValidators,
  runContractValidators,
  type ContractValidator,
} from '../src/execution/contracts/validators.js';
import { hashObject } from '../src/execution/hashing.js';
import { contractRoot, evidencePath } from '../src/execution/paths.js';
import { contractSnapshotManifestSchema } from '../src/execution/types.js';
import { verificationEvidenceSchema } from '../src/execution/artifacts.js';
import { createWorkset, saveWorkset } from '../src/workspace/worksets.js';
import type { Workset } from '../src/workspace/types.js';
import { createTestDirectory } from './helpers.js';

const NOW = '2026-08-16T00:00:00.000Z';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

interface ProjectDefinition {
  readonly consumes?: readonly string[];
  readonly produces?: readonly string[];
  readonly design?: string;
  readonly directoryName?: string;
  readonly testFiles?: readonly string[];
}

test('groups producer and consumers by logical contract key without task dependency edges', async () => {
  const fixture = await createScopeFixture({
    user: { produces: ['contract:authorization-v2'] },
    quote: { consumes: ['contract:authorization-v2'] },
    docs: {},
  });

  const scopes = await discoverContractCoordinationScopes(fixture.context);

  assert.deepEqual(scopes.map(({ key, projects }) => ({ key, projects })), [
    { key: 'authorization-v2', projects: ['quote', 'user'] },
  ]);
  assert.deepEqual(scopes[0]?.participants, [
    { project: 'quote', changeId: 'CHG-0001', revision: 'REV-0001', baseline: 'BL-0001', taskId: 'TASK-001', role: 'CONSUMER' },
    { project: 'user', changeId: 'CHG-0001', revision: 'REV-0001', baseline: 'BL-0001', taskId: 'TASK-001', role: 'PROVIDER' },
  ]);
  assert.equal(scopes[0]?.scopeHash, hashObject({
    key: 'authorization-v2',
    participants: scopes[0]?.participants,
  }));
});

test('one task participating in two contract keys remains in both sorted scopes', async () => {
  const fixture = await createScopeFixture({
    quote: { consumes: ['contract:pricing-v3', 'contract:authorization-v2'] },
    user: { produces: ['contract:authorization-v2'] },
    pricing: { produces: ['contract:pricing-v3'] },
  });

  const scopes = await discoverContractCoordinationScopes(fixture.context);

  assert.deepEqual(scopes.map((scope) => scope.key), ['authorization-v2', 'pricing-v3']);
  assert.deepEqual(scopes.map((scope) => scope.participants.map((participant) => participant.project)), [
    ['quote', 'user'],
    ['pricing', 'quote'],
  ]);
});

test('captures only deterministic source refs and hashes exact bytes', async () => {
  const fixture = await createScopeFixture({
    order: {
      produces: ['contract:authorization-v2'],
      design: '# Order design\nAuthorization contract is emitted by order.\n',
    },
    quote: {
      consumes: ['contract:authorization-v2'],
      design: '# Quote design\nAuthorization contract is consumed by quote.\n',
    },
  });
  await writeFile(join(fixture.projects.quote!, 'unreferenced.json'), '{"ignored":true}\n', 'utf8');
  const [scope] = await discoverContractCoordinationScopes(fixture.context);
  assert.ok(scope);

  const sources = await captureContractSources(fixture.context, scope);

  assert.deepEqual(sources.map(({ ref }) => ref), [
    'order/CHG-0001/REV-0001/design.md',
    'order/CHG-0001/REV-0001/intent.md',
    'quote/CHG-0001/REV-0001/design.md',
    'quote/CHG-0001/REV-0001/intent.md',
  ]);
  const quoteDesign = sources.find((source) => source.ref.endsWith('/design.md'));
  assert.ok(quoteDesign);
  const expected = createHash('sha256')
    .update('# Order design\nAuthorization contract is emitted by order.\n')
    .digest('hex');
  assert.equal(quoteDesign.contentHash, `sha256:${expected}`);
  assert.equal(sources.some((source) => source.ref.includes('unreferenced.json')), false);
});

test('captures existing configured contract tests without requiring future test outputs', async () => {
  const fixture = await createScopeFixture({
    order: {
      produces: ['contract:authorization-v2'],
      testFiles: ['test/authorization.contract.test.ts', 'test/future.contract.test.ts'],
    },
    quote: { consumes: ['contract:authorization-v2'] },
  });
  await mkdir(join(fixture.projects.order!, 'test'), { recursive: true });
  await writeFile(
    join(fixture.projects.order!, 'test', 'authorization.contract.test.ts'),
    'export const contractCase = true;\n',
    'utf8',
  );
  const [scope] = await discoverContractCoordinationScopes(fixture.context);
  assert.ok(scope);

  const sources = await captureContractSources(fixture.context, scope);

  assert.equal(sources.some((source) =>
    source.ref === 'order/CHG-0001/REV-0001/test/authorization.contract.test.ts'), true);
  assert.equal(sources.some((source) => source.ref.includes('future.contract.test.ts')), false);
});

test('rejects an explicitly referenced contract source that escapes through a symlink', async () => {
  const fixture = await createScopeFixture({
    user: {
      produces: ['contract:authorization-v2'],
      design: '# User design\nSchema: schemas/authorization.json\n',
    },
    quote: { consumes: ['contract:authorization-v2'] },
  });
  const outside = join(fixture.root, 'outside.json');
  await writeFile(outside, '{"outside":true}\n', 'utf8');
  await mkdir(join(fixture.projects.user!, 'schemas'), { recursive: true });
  await symlink(outside, join(fixture.projects.user!, 'schemas', 'authorization.json'));
  const [scope] = await discoverContractCoordinationScopes(fixture.context);
  assert.ok(scope);

  await assert.rejects(
    () => captureContractSources(fixture.context, scope),
    /CONTRACT_SOURCE_ESCAPE/,
  );
});

test('source capture rejects a coordination scope whose participant baseline changed', async () => {
  const fixture = await createScopeFixture({
    user: { produces: ['contract:authorization-v2'] },
    quote: { consumes: ['contract:authorization-v2'] },
  });
  const [scope] = await discoverContractCoordinationScopes(fixture.context);
  assert.ok(scope);
  const change = await resolveChange(fixture.projects.user!, 'CHG-0001');
  const path = changeArtifactPath(fixture.projects.user!, change.directoryName, 'change.yaml');
  const document = YAML.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  await writeFile(path, YAML.stringify({ ...document, baseline: 'BL-0002' }), 'utf8');

  await assert.rejects(
    () => captureContractSources(fixture.context, scope),
    /CONTRACT_PARTICIPANT_STALE: user/,
  );
});

test('creates a content-addressed snapshot and identical retries append no second event', async () => {
  const fixture = await createScopeFixture({
    order: { produces: ['contract:authorization-v2'] },
    quote: { consumes: ['contract:authorization-v2'] },
  });
  const [scope] = await discoverContractCoordinationScopes(fixture.context);
  assert.ok(scope);
  const sources = await captureContractSources(fixture.context, scope);
  const candidate = candidateFor(scope, sources);

  const first = await createContractSnapshot(fixture.context, scope, candidate, sources);
  const retried = await createContractSnapshot(fixture.context, scope, candidate, sources);

  assert.equal(first.id, 'CTR-0001');
  assert.equal(first.status, 'VALIDATING');
  assert.deepEqual(retried, first);
  assert.equal(first.contentHash, hashObject({
    contractKey: 'authorization-v2',
    scopeHash: scope.scopeHash,
    contract: candidate.contract,
    scenarios: candidate.businessScenarios,
    fixtures: candidate.fixtures,
    traceability: candidate.traceability,
  }));
  assert.deepEqual(first.sources, sources.map(({ absolutePath: _absolutePath, ...source }) => source));
  assert.deepEqual(first.businessScenarios, ['SC-001', 'SC-002', 'SC-003', 'SC-004']);
  const events = await readJsonLines<{ type: string }>(join(
    contractRoot(fixture.context.home, fixture.context.worksetId, first.id),
    'events.jsonl',
  ));
  assert.deepEqual(events.map((event) => event.type), ['VALIDATE']);
});

test('never overwrites snapshot content when the same Planner Run retries with a changed candidate', async () => {
  const fixture = await createScopeFixture({
    order: { produces: ['contract:authorization-v2'] },
    quote: { consumes: ['contract:authorization-v2'] },
  });
  const [scope] = await discoverContractCoordinationScopes(fixture.context);
  assert.ok(scope);
  const sources = await captureContractSources(fixture.context, scope);
  const candidate = candidateFor(scope, sources);
  await createContractSnapshot(fixture.context, scope, candidate, sources);
  const changed: ContractCandidate = {
    ...candidate,
    contract: {
      ...candidate.contract,
      compatibilityPolicy: {
        mode: 'FULL',
        rules: ['Authorization responses must be readable by every participant.'],
      },
    },
  };

  await assert.rejects(
    () => createContractSnapshot(fixture.context, scope, changed, sources),
    /CONTRACT_SNAPSHOT_IMMUTABLE/,
  );
});

test('snapshot creation rejects a source path substituted outside the participant worktree', async () => {
  const fixture = await createScopeFixture({
    order: { produces: ['contract:authorization-v2'] },
    quote: { consumes: ['contract:authorization-v2'] },
  });
  const [scope] = await discoverContractCoordinationScopes(fixture.context);
  assert.ok(scope);
  const sources = await captureContractSources(fixture.context, scope);
  const index = sources.findIndex((source) => source.ref === 'order/CHG-0001/REV-0001/intent.md');
  assert.notEqual(index, -1);
  const outside = join(fixture.root, 'substituted-intent.md');
  await writeFile(outside, '# order intent\nImplement the shared authorization behavior.\n', 'utf8');
  const substituted = sources.map((source, sourceIndex) =>
    sourceIndex === index ? { ...source, absolutePath: outside } : source);

  await assert.rejects(
    () => createContractSnapshot(fixture.context, scope, candidateFor(scope, substituted), substituted),
    /CONTRACT_SOURCE_INVENTORY_MISMATCH/,
  );
});

test('snapshot creation recomputes the coordination scope hash instead of trusting the caller', async () => {
  const fixture = await createScopeFixture({
    order: { produces: ['contract:authorization-v2'] },
    quote: { consumes: ['contract:authorization-v2'] },
  });
  const [scope] = await discoverContractCoordinationScopes(fixture.context);
  assert.ok(scope);
  const sources = await captureContractSources(fixture.context, scope);
  const forged: ContractCoordinationScope = {
    ...scope,
    scopeHash: hashObject('caller-controlled-scope'),
  };

  await assert.rejects(
    () => createContractSnapshot(fixture.context, forged, candidateFor(forged, sources), sources),
    /CONTRACT_SCOPE_HASH_MISMATCH/,
  );
});

test('discovers Pact and Spring Cloud Contract only when their project configuration exists', async () => {
  const sandbox = await createTestDirectory('omnai-contract-validators-');
  cleanups.push(sandbox.cleanup);
  const pact = join(sandbox.root, 'pact');
  const spring = join(sandbox.root, 'spring');
  const plain = join(sandbox.root, 'plain');
  await mkdir(pact, { recursive: true });
  await mkdir(spring, { recursive: true });
  await mkdir(plain, { recursive: true });
  await writeFile(join(pact, 'package.json'), JSON.stringify({
    name: 'pact-project',
    scripts: { 'test:pact': 'pact verify' },
  }), 'utf8');
  await writeFile(join(spring, 'pom.xml'), [
    '<project>',
    '  <dependencies>',
    '    <dependency><artifactId>spring-cloud-starter-contract-verifier</artifactId></dependency>',
    '  </dependencies>',
    '</project>',
  ].join('\n'), 'utf8');

  assert.deepEqual((await discoverContractValidators(pact)).map((item) => item.kind), ['PACT']);
  assert.deepEqual(
    (await discoverContractValidators(spring)).map((item) => item.kind),
    ['SPRING_CLOUD_CONTRACT'],
  );
  assert.deepEqual(await discoverContractValidators(plain), []);
});

test('an explicitly configured shell string becomes a blocking diagnostic and is never executable', async () => {
  const fixture = await createScopeFixture({
    order: { produces: ['contract:authorization-v2'] },
    quote: { consumes: ['contract:authorization-v2'] },
  });
  const config = await loadProjectConfig(fixture.projects.quote!);
  await saveProjectConfig(fixture.projects.quote!, {
    ...config,
    verification: { commands: ['npm test && curl https://example.invalid'] },
  });

  const validators = await discoverContractValidators(fixture.projects.quote!);

  assert.equal(validators.length, 1);
  assert.equal(validators[0]?.kind, 'CONFIGURED');
  assert.equal(validators[0]?.required, true);
  assert.equal(validators[0]?.command, undefined);
  assert.match(validators[0]?.diagnostic ?? '', /CONTRACT_VALIDATOR_COMMAND_AMBIGUOUS/);
});

test('validator evidence binds the exact snapshot and scenario IDs without a future plan ref', async () => {
  const fixture = await createScopeFixture({
    order: { produces: ['contract:authorization-v2'] },
    quote: { consumes: ['contract:authorization-v2'] },
  });
  const [scope] = await discoverContractCoordinationScopes(fixture.context);
  assert.ok(scope);
  const sources = await captureContractSources(fixture.context, scope);
  const manifest = await createContractSnapshot(fixture.context, scope, candidateFor(scope, sources), sources);
  const snapshot = await loadContractSnapshot(fixture.context, manifest.id);
  const validator: ContractValidator = {
    id: 'quote:configured:node',
    kind: 'CONFIGURED',
    project: 'quote',
    required: true,
    command: {
      commandRef: 'contract:quote:node',
      executable: process.execPath,
      argv: ['-e', 'process.stdout.write("validator-pass")'],
      cwd: fixture.projects.quote!,
    },
  };

  const [evidence] = await runContractValidators(snapshot, [validator]);

  assert.ok(evidence);
  assert.equal(evidence.status, 'PASS');
  assert.equal(evidence.subject.kind, 'CONTRACT');
  if (evidence.subject.kind !== 'CONTRACT') assert.fail('expected CONTRACT evidence subject');
  assert.deepEqual(evidence.subject.contractSnapshot, { id: manifest.id, contentHash: manifest.contentHash });
  assert.deepEqual(evidence.subject.scenarioIds, ['SC-001', 'SC-002', 'SC-003', 'SC-004']);
  assert.equal('verificationPlan' in evidence, false);
  assert.deepEqual(evidence.artifactHashes.map((artifact) => artifact.ref), [
    'evidence/EVD-0001.stderr.txt',
    'evidence/EVD-0001.stdout.txt',
  ]);
  assert.deepEqual(
    await readYaml(evidencePath(fixture.context.home, fixture.context.worksetId, 'EVD-0001'), verificationEvidenceSchema),
    evidence,
  );
});

test('validator execution rejects a cwd outside the validator participant worktree', async () => {
  const fixture = await createScopeFixture({
    order: { produces: ['contract:authorization-v2'] },
    quote: { consumes: ['contract:authorization-v2'] },
  });
  const [scope] = await discoverContractCoordinationScopes(fixture.context);
  assert.ok(scope);
  const sources = await captureContractSources(fixture.context, scope);
  const manifest = await createContractSnapshot(fixture.context, scope, candidateFor(scope, sources), sources);
  const snapshot = await loadContractSnapshot(fixture.context, manifest.id);

  await assert.rejects(
    () => runContractValidators(snapshot, [{
      id: 'quote:configured:outside',
      kind: 'CONFIGURED',
      project: 'quote',
      required: true,
      command: {
        commandRef: 'contract:quote:outside',
        executable: process.execPath,
        argv: ['-e', 'process.exit(0)'],
        cwd: fixture.root,
      },
    }]),
    /CONTRACT_VALIDATOR_CWD_MISMATCH/,
  );
});

test('semantic validation persists parser evidence and marks a complete snapshot READY', async () => {
  const fixture = await createScopeFixture({
    order: { produces: ['contract:authorization-v2'] },
    quote: { consumes: ['contract:authorization-v2'] },
  });
  const [scope] = await discoverContractCoordinationScopes(fixture.context);
  assert.ok(scope);
  const sources = await captureContractSources(fixture.context, scope);
  const created = await createContractSnapshot(fixture.context, scope, candidateFor(scope, sources), sources);

  const result = await validateContractSnapshot(fixture.context, created.id);
  const loaded = await loadReadyContractSnapshot(fixture.context, created.id);

  assert.equal(result.valid, true);
  assert.equal(result.manifest.status, 'READY');
  assert.deepEqual(result.codes, []);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0]?.status, 'PASS');
  assert.equal(loaded.manifest.id, created.id);
  assert.deepEqual(loaded.manifest.validationEvidence, ['EVD-0001']);
});

test('untraceable scenarios persist failing evidence and transition the snapshot to INVALID', async () => {
  const fixture = await createScopeFixture({
    order: { produces: ['contract:authorization-v2'] },
    quote: { consumes: ['contract:authorization-v2'] },
  });
  const [scope] = await discoverContractCoordinationScopes(fixture.context);
  assert.ok(scope);
  const sources = await captureContractSources(fixture.context, scope);
  const candidate = candidateFor(scope, sources);
  const untraceable: ContractCandidate = {
    ...candidate,
    traceability: candidate.traceability.map((item) => ({
      ...item,
      scenarioIds: item.scenarioIds.filter((id) => id !== 'SC-004'),
    })),
  };
  const created = await createContractSnapshot(fixture.context, scope, untraceable, sources);

  const result = await validateContractSnapshot(fixture.context, created.id);

  assert.equal(result.valid, false);
  assert.equal(result.manifest.status, 'INVALID');
  assert.match(result.codes.join(','), /SCENARIO_TRACEABILITY_MISSING/);
  assert.equal(result.evidence.some((item) => item.status === 'FAIL'), true);
  assert.deepEqual(result.manifest.validationEvidence, result.evidence.map((item) => item.id));
});

test('a malformed referenced schema is parser evidence and cannot become READY', async () => {
  const fixture = await createScopeFixture({
    order: {
      produces: ['contract:authorization-v2'],
      design: '# Order design\nSchema: schemas/authorization.json\n',
    },
    quote: { consumes: ['contract:authorization-v2'] },
  });
  await mkdir(join(fixture.projects.order!, 'schemas'), { recursive: true });
  await writeFile(join(fixture.projects.order!, 'schemas', 'authorization.json'), '{not-json', 'utf8');
  const [scope] = await discoverContractCoordinationScopes(fixture.context);
  assert.ok(scope);
  const sources = await captureContractSources(fixture.context, scope);
  const created = await createContractSnapshot(fixture.context, scope, candidateFor(scope, sources), sources);

  const result = await validateContractSnapshot(fixture.context, created.id);

  assert.equal(result.valid, false);
  assert.equal(result.manifest.status, 'INVALID');
  assert.match(result.codes.join(','), /CONTRACT_SOURCE_PARSE_FAILED/);
});

test('a parsable JSON array cannot masquerade as a contract schema', async () => {
  const fixture = await createScopeFixture({
    order: {
      produces: ['contract:authorization-v2'],
      design: '# Order design\nSchema: schemas/authorization.json\n',
    },
    quote: { consumes: ['contract:authorization-v2'] },
  });
  await mkdir(join(fixture.projects.order!, 'schemas'), { recursive: true });
  await writeFile(join(fixture.projects.order!, 'schemas', 'authorization.json'), '[]\n', 'utf8');
  const [scope] = await discoverContractCoordinationScopes(fixture.context);
  assert.ok(scope);
  const sources = await captureContractSources(fixture.context, scope);
  const created = await createContractSnapshot(fixture.context, scope, candidateFor(scope, sources), sources);

  const result = await validateContractSnapshot(fixture.context, created.id);

  assert.equal(result.valid, false);
  assert.match(result.codes.join(','), /CONTRACT_SCHEMA_STRUCTURE_INVALID/);
});

test('a required configured validator failure blocks READY', async () => {
  const fixture = await createScopeFixture({
    order: { produces: ['contract:authorization-v2'] },
    quote: { consumes: ['contract:authorization-v2'] },
  });
  const config = await loadProjectConfig(fixture.projects.quote!);
  await saveProjectConfig(fixture.projects.quote!, {
    ...config,
    verification: { commands: ['false'] },
  });
  const [scope] = await discoverContractCoordinationScopes(fixture.context);
  assert.ok(scope);
  const sources = await captureContractSources(fixture.context, scope);
  const created = await createContractSnapshot(fixture.context, scope, candidateFor(scope, sources), sources);

  const result = await validateContractSnapshot(fixture.context, created.id);

  assert.equal(result.valid, false);
  assert.equal(result.manifest.status, 'INVALID');
  assert.match(result.codes.join(','), /CONTRACT_VALIDATOR_FAILED/);
  assert.equal(result.evidence.some((item) => item.verifier.id.includes(':configured:') && item.status === 'FAIL'), true);
});

test('validator discovery preserves the Workset alias when repository directory names differ', async () => {
  const fixture = await createScopeFixture({
    order: { directoryName: 'order-center', produces: ['contract:authorization-v2'] },
    quote: { directoryName: 'quote-center', consumes: ['contract:authorization-v2'] },
  });
  const config = await loadProjectConfig(fixture.projects.quote!);
  await saveProjectConfig(fixture.projects.quote!, {
    ...config,
    verification: { commands: [`${process.execPath} --version`] },
  });
  const [scope] = await discoverContractCoordinationScopes(fixture.context);
  assert.ok(scope);
  const sources = await captureContractSources(fixture.context, scope);
  const created = await createContractSnapshot(fixture.context, scope, candidateFor(scope, sources), sources);

  const result = await validateContractSnapshot(fixture.context, created.id);

  assert.equal(result.valid, true);
  assert.equal(result.manifest.status, 'READY');
  assert.equal(result.evidence.some((item) => item.verifier.id.startsWith('quote:configured:')), true);
});

test('validator evidence claims only the scenario subset bound by its candidate request', async () => {
  const fixture = await createScopeFixture({
    order: { produces: ['contract:authorization-v2'] },
    quote: { consumes: ['contract:authorization-v2'] },
  });
  const commandText = `${process.execPath} --version`;
  const suffix = hashObject(commandText).slice('sha256:'.length, 'sha256:'.length + 12);
  const commandRef = `contract:quote:configured:${suffix}`;
  const config = await loadProjectConfig(fixture.projects.quote!);
  await saveProjectConfig(fixture.projects.quote!, {
    ...config,
    verification: { commands: [commandText] },
  });
  const [scope] = await discoverContractCoordinationScopes(fixture.context);
  assert.ok(scope);
  const sources = await captureContractSources(fixture.context, scope);
  const base = candidateFor(scope, sources);
  const candidate: ContractCandidate = {
    ...base,
    validatorRequests: [{
      id: 'quote-scenario-validator',
      project: 'quote',
      commandRef,
      required: true,
      scenarioIds: ['SC-001', 'SC-004'],
    }],
  };
  const created = await createContractSnapshot(fixture.context, scope, candidate, sources);

  const result = await validateContractSnapshot(fixture.context, created.id);
  const commandEvidence = result.evidence.find((item) => item.command.commandRef === commandRef);

  assert.equal(result.valid, true);
  assert.ok(commandEvidence);
  assert.equal(commandEvidence.subject.kind, 'CONTRACT');
  if (commandEvidence.subject.kind !== 'CONTRACT') assert.fail('expected CONTRACT evidence');
  assert.deepEqual(commandEvidence.subject.scenarioIds, ['SC-001', 'SC-004']);
});

test('READY evidence is stale when a detected Pact command definition changes behind stable argv', async () => {
  const fixture = await createScopeFixture({
    order: { produces: ['contract:authorization-v2'] },
    quote: { consumes: ['contract:authorization-v2'] },
  });
  const packagePath = join(fixture.projects.quote!, 'package.json');
  await writeFile(packagePath, JSON.stringify({
    name: 'quote-contracts',
    scripts: { 'test:pact': 'node -e "process.exit(0)"' },
  }), 'utf8');
  const [scope] = await discoverContractCoordinationScopes(fixture.context);
  assert.ok(scope);
  const sources = await captureContractSources(fixture.context, scope);
  const created = await createContractSnapshot(fixture.context, scope, candidateFor(scope, sources), sources);
  const result = await validateContractSnapshot(fixture.context, created.id);
  assert.equal(result.valid, true);
  await writeFile(packagePath, JSON.stringify({
    name: 'quote-contracts',
    scripts: { 'test:pact': 'node -e "process.stdout.write(\'changed\')"' },
  }), 'utf8');

  await assert.rejects(
    () => loadReadyContractSnapshot(fixture.context, created.id),
    /CONTRACT_VALIDATOR_COMMAND_BINDING_MISMATCH/,
  );
});

test('markContractReady cannot omit a configured required validator', async () => {
  const fixture = await createScopeFixture({
    order: { produces: ['contract:authorization-v2'] },
    quote: { consumes: ['contract:authorization-v2'] },
  });
  const config = await loadProjectConfig(fixture.projects.quote!);
  await saveProjectConfig(fixture.projects.quote!, {
    ...config,
    verification: { commands: ['false'] },
  });
  const [scope] = await discoverContractCoordinationScopes(fixture.context);
  assert.ok(scope);
  const sources = await captureContractSources(fixture.context, scope);
  const created = await createContractSnapshot(fixture.context, scope, candidateFor(scope, sources), sources);
  const snapshot = await loadContractSnapshot(fixture.context, created.id);
  const parserEvidence = await runContractValidators(snapshot, [{
    id: `core:contract-parser:${created.id}`,
    kind: 'PARSER',
    project: 'core',
    required: true,
  }]);

  await assert.rejects(
    () => markContractReady(fixture.context, created.id, parserEvidence),
    /CONTRACT_REQUIRED_VALIDATOR_EVIDENCE_MISSING/,
  );
});

test('an optional validator failure remains auditable without blocking READY', async () => {
  const fixture = await createScopeFixture({
    order: { produces: ['contract:authorization-v2'] },
    quote: { consumes: ['contract:authorization-v2'] },
  });
  const [scope] = await discoverContractCoordinationScopes(fixture.context);
  assert.ok(scope);
  const sources = await captureContractSources(fixture.context, scope);
  const created = await createContractSnapshot(fixture.context, scope, candidateFor(scope, sources), sources);
  const snapshot = await loadContractSnapshot(fixture.context, created.id);
  const evidence = await runContractValidators(snapshot, [{
    id: `core:contract-parser:${created.id}`,
    kind: 'PARSER',
    project: 'core',
    required: true,
  }, {
    id: 'quote:optional:false',
    kind: 'CONFIGURED',
    project: 'quote',
    required: false,
    command: {
      commandRef: 'contract:quote:optional:false',
      executable: 'false',
      argv: [],
      cwd: fixture.projects.quote!,
    },
  }]);

  assert.equal(evidence.some((item) => item.verifier.id === 'quote:optional:false' && item.status === 'FAIL'), true);
  assert.equal((await markContractReady(fixture.context, created.id, evidence)).status, 'READY');
});

test('READY loading rechecks exact source bytes and rejects a stale participant source', async () => {
  const fixture = await createScopeFixture({
    order: { produces: ['contract:authorization-v2'] },
    quote: { consumes: ['contract:authorization-v2'] },
  });
  const [scope] = await discoverContractCoordinationScopes(fixture.context);
  assert.ok(scope);
  const sources = await captureContractSources(fixture.context, scope);
  const created = await createContractSnapshot(fixture.context, scope, candidateFor(scope, sources), sources);
  await validateContractSnapshot(fixture.context, created.id);
  const quoteIntent = sources.find((source) => source.ref === 'quote/CHG-0001/REV-0001/intent.md');
  assert.ok(quoteIntent);
  await writeFile(quoteIntent.absolutePath, '# changed after READY\n', 'utf8');

  await assert.rejects(
    () => loadReadyContractSnapshot(fixture.context, created.id),
    /CONTRACT_SOURCE_STALE/,
  );
});

test('a historical READY snapshot without participant baselines stays readable but requires re-coordination', async () => {
  const fixture = await createScopeFixture({
    order: { produces: ['contract:authorization-v2'] },
    quote: { consumes: ['contract:authorization-v2'] },
  });
  const [scope] = await discoverContractCoordinationScopes(fixture.context);
  assert.ok(scope);
  const sources = await captureContractSources(fixture.context, scope);
  const created = await createContractSnapshot(fixture.context, scope, candidateFor(scope, sources), sources);
  await validateContractSnapshot(fixture.context, created.id);
  const root = contractRoot(fixture.context.home, fixture.context.worksetId, created.id);
  const manifestPath = join(root, 'manifest.yaml');
  const creationPath = join(root, 'creation.yaml');
  const manifest = contractSnapshotManifestSchema.parse(YAML.parse(await readFile(manifestPath, 'utf8')));
  const creation = YAML.parse(await readFile(creationPath, 'utf8')) as Record<string, unknown>;
  const initialManifest = contractSnapshotManifestSchema.parse(creation.initialManifest);
  const participants = manifest.participants.map(({ baseline: _baseline, ...participant }) => participant);
  const initialParticipants = initialManifest.participants.map(({ baseline: _baseline, ...participant }) => participant);
  await writeYaml(creationPath, {
    ...creation,
    initialManifest: { ...initialManifest, participants: initialParticipants },
  });
  await writeYaml(manifestPath, { ...manifest, participants });

  const readable = await loadContractSnapshot(fixture.context, created.id);
  assert.equal(readable.manifest.participants.every((participant) => participant.baseline === undefined), true);
  await assert.rejects(
    () => loadReadyContractSnapshot(fixture.context, created.id),
    /CONTRACT_BASELINE_IDENTITY_MISSING_REQUIRES_RECOORDINATION/,
  );
});

test('READY loading rejects validator output that no longer matches its evidence hash', async () => {
  const fixture = await createScopeFixture({
    order: { produces: ['contract:authorization-v2'] },
    quote: { consumes: ['contract:authorization-v2'] },
  });
  const [scope] = await discoverContractCoordinationScopes(fixture.context);
  assert.ok(scope);
  const sources = await captureContractSources(fixture.context, scope);
  const created = await createContractSnapshot(fixture.context, scope, candidateFor(scope, sources), sources);
  const result = await validateContractSnapshot(fixture.context, created.id);
  const artifactRef = result.evidence[0]?.artifactHashes.find((artifact) => artifact.ref.endsWith('.stdout.txt'))?.ref;
  assert.ok(artifactRef);
  await writeFile(join(contractRoot(fixture.context.home, fixture.context.worksetId, created.id), artifactRef), 'tampered', 'utf8');

  await assert.rejects(
    () => loadReadyContractSnapshot(fixture.context, created.id),
    /CONTRACT_EVIDENCE_STALE/,
  );
});

test('READY loading recomputes the validator output hash from exact stdout and stderr artifacts', async () => {
  const fixture = await createScopeFixture({
    order: { produces: ['contract:authorization-v2'] },
    quote: { consumes: ['contract:authorization-v2'] },
  });
  const [scope] = await discoverContractCoordinationScopes(fixture.context);
  assert.ok(scope);
  const sources = await captureContractSources(fixture.context, scope);
  const created = await createContractSnapshot(fixture.context, scope, candidateFor(scope, sources), sources);
  const result = await validateContractSnapshot(fixture.context, created.id);
  const evidence = result.evidence[0];
  assert.ok(evidence);
  await writeYaml(evidencePath(fixture.context.home, fixture.context.worksetId, evidence.id), {
    ...evidence,
    outputHash: hashObject('tampered-output-summary'),
  });

  await assert.rejects(
    () => loadReadyContractSnapshot(fixture.context, created.id),
    /CONTRACT_EVIDENCE_OUTPUT_HASH_MISMATCH/,
  );
});

test('supersession requires a distinct READY replacement and preserves the old snapshot', async () => {
  const fixture = await createScopeFixture({
    order: { produces: ['contract:authorization-v2'] },
    quote: { consumes: ['contract:authorization-v2'] },
  });
  const [scope] = await discoverContractCoordinationScopes(fixture.context);
  assert.ok(scope);
  const sources = await captureContractSources(fixture.context, scope);
  const firstCandidate = candidateFor(scope, sources);
  const first = await createContractSnapshot(fixture.context, scope, firstCandidate, sources);
  await validateContractSnapshot(fixture.context, first.id);
  const secondCandidate: ContractCandidate = {
    ...firstCandidate,
    runId: 'RUN-0002',
    contract: {
      ...firstCandidate.contract,
      compatibilityPolicy: {
        mode: 'FULL',
        rules: ['All participants must accept both old and new authorization responses.'],
      },
    },
  };
  const second = await createContractSnapshot(fixture.context, scope, secondCandidate, sources);
  await validateContractSnapshot(fixture.context, second.id);

  await assert.rejects(
    () => supersedeContractSnapshot(fixture.context, first.id, first.id),
    /CONTRACT_REPLACEMENT_MUST_BE_DISTINCT/,
  );
  await supersedeContractSnapshot(fixture.context, first.id, second.id);

  assert.equal((await loadContractSnapshot(fixture.context, first.id)).manifest.status, 'SUPERSEDED');
  assert.equal((await loadReadyContractSnapshot(fixture.context, second.id)).manifest.status, 'READY');
});

test('a stale READY snapshot can be superseded by its validated replacement', async () => {
  const fixture = await createScopeFixture({
    order: { produces: ['contract:authorization-v2'] },
    quote: { consumes: ['contract:authorization-v2'] },
  });
  const [scope] = await discoverContractCoordinationScopes(fixture.context);
  assert.ok(scope);
  const firstSources = await captureContractSources(fixture.context, scope);
  const first = await createContractSnapshot(fixture.context, scope, candidateFor(scope, firstSources), firstSources);
  await validateContractSnapshot(fixture.context, first.id);
  const quoteIntent = firstSources.find((source) => source.ref === 'quote/CHG-0001/REV-0001/intent.md');
  assert.ok(quoteIntent);
  await writeFile(quoteIntent.absolutePath, '# quote intent\nUse the revised authorization behavior.\n', 'utf8');
  const replacementSources = await captureContractSources(fixture.context, scope);
  const replacementCandidate: ContractCandidate = {
    ...candidateFor(scope, replacementSources),
    runId: 'RUN-0002',
  };
  const replacement = await createContractSnapshot(
    fixture.context,
    scope,
    replacementCandidate,
    replacementSources,
  );
  await validateContractSnapshot(fixture.context, replacement.id);

  await supersedeContractSnapshot(fixture.context, first.id, replacement.id);

  const oldManifest = await readYaml(
    join(contractRoot(fixture.context.home, fixture.context.worksetId, first.id), 'manifest.yaml'),
    contractSnapshotManifestSchema,
  );
  assert.equal(oldManifest.status, 'SUPERSEDED');
});

test('one task participating in two contract keys requires both exact READY snapshots', async () => {
  const fixture = await createScopeFixture({
    quote: { consumes: ['contract:authorization-v2', 'contract:pricing-v3'] },
    user: { produces: ['contract:authorization-v2'] },
    pricing: { produces: ['contract:pricing-v3'] },
  });
  const scopes = await discoverContractCoordinationScopes(fixture.context);
  const authorization = scopes.find((scope) => scope.key === 'authorization-v2');
  const pricing = scopes.find((scope) => scope.key === 'pricing-v3');
  assert.ok(authorization);
  assert.ok(pricing);
  const authorizationSources = await captureContractSources(fixture.context, authorization);
  const authorizationSnapshot = await createContractSnapshot(
    fixture.context,
    authorization,
    candidateFor(authorization, authorizationSources),
    authorizationSources,
  );
  await validateContractSnapshot(fixture.context, authorizationSnapshot.id);

  await assert.rejects(
    () => loadReadyContractSnapshotsForTask(fixture.context, 'quote', 'TASK-001'),
    /CONTRACT_NOT_READY: pricing-v3/,
  );

  const pricingSources = await captureContractSources(fixture.context, pricing);
  const pricingCandidate: ContractCandidate = {
    ...candidateFor(pricing, pricingSources),
    runId: 'RUN-0002',
  };
  const pricingSnapshot = await createContractSnapshot(
    fixture.context,
    pricing,
    pricingCandidate,
    pricingSources,
  );
  await validateContractSnapshot(fixture.context, pricingSnapshot.id);

  assert.deepEqual(
    (await loadReadyContractSnapshotsForTask(fixture.context, 'quote', 'TASK-001'))
      .map((snapshot) => snapshot.manifest.contractKey),
    ['authorization-v2', 'pricing-v3'],
  );
  await assert.rejects(
    () => loadReadyContractSnapshot(fixture.context),
    /CONTRACT_READY_SELECTION_REQUIRED/,
  );
});

async function createScopeFixture(definitions: Record<string, ProjectDefinition>): Promise<{
  root: string;
  context: ContractStoreContext;
  workset: Workset;
  projects: Record<string, string>;
}> {
  const sandbox = await createTestDirectory('omnai-contract-scope-');
  cleanups.push(sandbox.cleanup);
  const home = join(sandbox.root, 'home');
  const workset = await createWorkset(home, 'Authorization Migration');
  const projects: Record<string, string> = {};

  for (const [project, definition] of Object.entries(definitions)) {
    const root = join(sandbox.root, 'projects', definition.directoryName ?? project);
    await mkdir(root, { recursive: true });
    const change = await createChange(root, `${project} contract change`, 'small-feature');
    projects[project] = root;
    await writeFile(
      changeArtifactPath(root, change.directoryName, 'intent.md'),
      `# ${project} intent\nImplement the shared authorization behavior.\n`,
      'utf8',
    );
    await writeFile(
      changeArtifactPath(root, change.directoryName, 'design.md'),
      definition.design ?? `# ${project} design\nNo additional schema file.\n`,
      'utf8',
    );
    await unlink(changeArtifactPath(root, change.directoryName, 'spec.md'));
    await saveTasks(changeArtifactPath(root, change.directoryName, 'tasks.yaml'), {
      schemaVersion: 1,
      revision: 'REV-0001',
      generatedFrom: ['intent.md', 'design.md'],
      tasks: [{
        id: 'TASK-001',
        title: `${project} contract task`,
        objective: 'Implement the shared contract.',
        status: 'READY',
        dependsOn: [],
        slice: 'CONTRACT_FIRST',
        risk: 'HIGH',
        files: { create: [], modify: [], tests: [...(definition.testFiles ?? [])] },
        consumes: [...(definition.consumes ?? [])],
        produces: [...(definition.produces ?? [])],
        steps: ['coordinate contract'],
        evidenceRequired: ['contract'],
        notes: [],
      }],
    });
    workset.members.push({
      project,
      status: 'ACTIVE',
      changeId: change.metadata.id,
      worktree: root,
      branch: `omnai/${workset.id}-${project}`,
      addedAt: NOW,
      updatedAt: NOW,
    });
  }
  workset.members.sort((left, right) => left.project.localeCompare(right.project));
  workset.updatedAt = NOW;
  await saveWorkset(home, workset);
  return {
    root: sandbox.root,
    context: { home, worksetId: workset.id, now: () => NOW },
    workset,
    projects,
  };
}

function candidateFor(
  scope: ContractCoordinationScope,
  sources: readonly ContractSource[],
): ContractCandidate {
  const scenarioIds = ['SC-001', 'SC-002', 'SC-003', 'SC-004'];
  const sourceRefs = sources.map((source) => source.ref);
  const provider = scope.participants.find((participant) => participant.role === 'PROVIDER');
  assert.ok(provider);
  const participantProjects = [...scope.projects];
  const participants = new Map<string, { project: string; role: 'PROVIDER' | 'CONSUMER'; taskRefs: string[] }>();
  for (const participant of scope.participants) {
    const key = `${participant.project}\0${participant.role}`;
    const current = participants.get(key) ?? {
      project: participant.project,
      role: participant.role,
      taskRefs: [],
    };
    current.taskRefs.push(participant.taskId);
    current.taskRefs.sort();
    participants.set(key, current);
  }
  const packetHash = hashObject('contract-planner-packet');
  return {
    schemaVersion: 1,
    runId: 'RUN-0001',
    packetHash,
    contractKey: scope.key,
    scopeHash: scope.scopeHash,
    participants: [...participants.values()].sort((left, right) =>
      `${left.project}\0${left.role}`.localeCompare(`${right.project}\0${right.role}`)),
    contract: {
      elements: [{
        id: 'authorization.response',
        kind: 'SCHEMA',
        name: 'Authorization response',
        ownerProject: provider.project,
        definition: { type: 'object', required: ['authorized'] },
        sourceRefs,
      }],
      compatibilityPolicy: {
        mode: 'BACKWARD_COMPATIBLE',
        rules: ['Existing consumers continue to read the authorized field.'],
      },
    },
    businessScenarios: [
      ['SC-001', 'NORMAL', 'authorization succeeds'],
      ['SC-002', 'BOUNDARY', 'authorization input is incomplete'],
      ['SC-003', 'FAILURE', 'authorization provider is unavailable'],
      ['SC-004', 'COMPATIBILITY', 'an existing consumer reads the response'],
    ].map(([id, scenarioClass, title]) => ({
      id: id!,
      class: scenarioClass as 'NORMAL' | 'BOUNDARY' | 'FAILURE' | 'COMPATIBILITY',
      title: title!,
      participantProjects,
      sourceRefs,
      contractElementRefs: ['authorization.response'],
      fixtureRefs: [],
      executorRefs: ['validator:parser'],
      expectedOutcome: `${title} has a deterministic outcome`,
    })),
    fixtures: [],
    traceability: sources.map((source) => ({
      sourceRef: source.ref,
      sourceHash: source.contentHash,
      contractElementRefs: ['authorization.response'],
      scenarioIds,
    })),
    sourceHashes: sources.map((source) => ({ ref: source.ref, contentHash: source.contentHash })),
    validatorRequests: [],
    summary: 'Authorization V2 contract candidate.',
  };
}
