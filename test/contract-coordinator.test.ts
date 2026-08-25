import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterEach, test } from 'node:test';
import YAML from 'yaml';
import type { ContractCandidate, ProjectFinding } from '../src/execution/artifacts.js';
import type {
  AgentProbe,
  AgentProfile,
  AgentSessionAdapter,
  AgentSessionHooks,
  AgentSessionRequest,
} from '../src/execution/agents/types.js';
import {
  classifyFindings,
  coordinateContract,
  type ContractCoordinatorContext,
  type ContractCoordinationOptions,
} from '../src/execution/contracts/coordinator.js';
import {
  captureContractSources,
  discoverContractCoordinationScopes,
  type ContractCoordinationScope,
  type ContractSource,
} from '../src/execution/contracts/store.js';
import { hashObject } from '../src/execution/hashing.js';
import type { RunPacket } from '../src/execution/packets.js';
import { changeArtifactPath } from '../src/core/paths.js';
import { createChange, loadProjectConfig, saveProjectConfig } from '../src/core/store.js';
import { saveTasks } from '../src/core/tasks.js';
import { createWorkset, saveWorkset } from '../src/workspace/worksets.js';
import type { Workset } from '../src/workspace/types.js';
import { createTestDirectory } from './helpers.js';

const NOW = '2026-08-16T00:00:00.000Z';
const CONFORMANCE_HASH = hashObject('contract-coordinator-conformance');
const DECISION_QUESTION =
  'Should duplicate Authorization V2 requests return the original result or a conflict error?';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

test('runs one Planner then one isolated Critic per participant concurrently', async () => {
  const fixture = await createCoordinationFixture({
    projects: ['order', 'quote', 'user'],
    findings: ['ACCEPT', 'ACCEPT', 'ACCEPT'],
  });

  const result = await coordinateContract(fixture.context, fixture.scope, fixture.options);

  assert.equal(result.outcome, 'READY');
  assert.deepEqual(fixture.runKinds(), [
    'CONTRACT_PLANNER',
    'PROJECT_CRITIC',
    'PROJECT_CRITIC',
    'PROJECT_CRITIC',
  ]);
  assert.equal(fixture.peakCritics(), 3);
  assert.equal(new Set(fixture.sessionIds()).size, 4);
  assert.equal(fixture.allCoordinationSnapshotsReadOnly(), true);
  assert.equal(new Set(fixture.packets().map((packet) => packet.coordinationCycleId)).size, 1);
  assert.deepEqual(fixture.outputBasenames(), [
    'contract-candidate.yaml',
    'project-finding.yaml',
    'project-finding.yaml',
    'project-finding.yaml',
  ]);
});

test('non-conflicting corrections create a new Planner Run, not a reused session or Resolver', async () => {
  const fixture = await createCoordinationFixture({
    findings: ['CORRECTION', 'ACCEPT'],
    revisedFindings: ['ACCEPT', 'ACCEPT'],
  });

  const result = await coordinateContract(fixture.context, fixture.scope, fixture.options);

  assert.equal(result.outcome, 'READY');
  assert.deepEqual(fixture.runKinds(), [
    'CONTRACT_PLANNER',
    'PROJECT_CRITIC',
    'PROJECT_CRITIC',
    'CONTRACT_PLANNER',
    'PROJECT_CRITIC',
    'PROJECT_CRITIC',
  ]);
  assert.equal(new Set(fixture.sessionIds()).size, 6);
  assert.equal(fixture.runKinds().includes('CONTRACT_RESOLVER'), false);
});

test('Core rejects an Adapter that reuses one session identity across isolated Runs', async () => {
  const fixture = await createCoordinationFixture({
    findings: ['ACCEPT', 'ACCEPT'],
    reuseSessionId: true,
  });

  const result = await coordinateContract(fixture.context, fixture.scope, fixture.options);

  assert.equal(result.outcome, 'INVALID');
  assert.match(result.reason, /CONTRACT_COORDINATION_SESSION_REUSED/);
});

test('each isolated Run resolves one Adapter instance for both creation and dispatch', async () => {
  const fixture = await createCoordinationFixture({ findings: ['ACCEPT', 'ACCEPT'] });

  assert.equal((await coordinateContract(fixture.context, fixture.scope, fixture.options)).outcome, 'READY');
  assert.equal(fixture.adapterFactoryCalls(), fixture.packets().length);
});

test('evidence-backed contradiction invokes one Resolver Run', async () => {
  const fixture = await createCoordinationFixture({
    findings: ['CONTRADICTION', 'ACCEPT'],
    contradictionResolution: 'EVIDENCE_BACKED',
  });

  const result = await coordinateContract(fixture.context, fixture.scope, fixture.options);

  assert.equal(result.outcome, 'READY');
  assert.equal(fixture.runKinds().filter((kind) => kind === 'CONTRACT_RESOLVER').length, 1);
  assert.deepEqual(fixture.runKinds(), [
    'CONTRACT_PLANNER',
    'PROJECT_CRITIC',
    'PROJECT_CRITIC',
    'CONTRACT_RESOLVER',
    'CONTRACT_PLANNER',
    'PROJECT_CRITIC',
    'PROJECT_CRITIC',
  ]);
  assert.equal(new Set(fixture.sessionIds()).size, fixture.sessionIds().length);
});

test('Resolver choices and non-conflicting corrections are materialized together by a new Planner', async () => {
  const fixture = await createCoordinationFixture({
    findings: ['CONTRADICTION', 'CORRECTION'],
    revisedFindings: ['ACCEPT', 'ACCEPT'],
  });

  const result = await coordinateContract(fixture.context, fixture.scope, fixture.options);

  assert.equal(result.outcome, 'READY');
  assert.equal(fixture.runKinds().filter((kind) => kind === 'CONTRACT_RESOLVER').length, 1);
  assert.equal(fixture.runKinds().filter((kind) => kind === 'CONTRACT_PLANNER').length, 2);
});

test('equally supported business choices create one precise decision and no write Wave', async () => {
  const fixture = await createCoordinationFixture({ findings: ['NEEDS_DECISION', 'ACCEPT'] });

  const result = await coordinateContract(fixture.context, fixture.scope, fixture.options);

  assert.equal(result.outcome, 'NEEDS_DECISION');
  assert.equal(result.attention.question, DECISION_QUESTION);
  assert.equal(result.attention.status, 'OPEN');
  assert.equal(fixture.writerRunCount(), 0);
});

test('identical decision options from multiple projects merge their distinct evidence', async () => {
  const fixture = await createCoordinationFixture({
    findings: ['NEEDS_DECISION', 'NEEDS_DECISION'],
  });

  const result = await coordinateContract(fixture.context, fixture.scope, fixture.options);

  assert.equal(result.outcome, 'NEEDS_DECISION');
  assert.deepEqual(result.attention.blockingProjects, ['order', 'quote']);
  assert.deepEqual(result.attention.options.map((option) => ({
    id: option.id,
    evidenceCount: option.evidenceRefs.length,
  })), [
    { id: 'conflict-error', evidenceCount: 2 },
    { id: 'original-result', evidenceCount: 2 },
  ]);
});

test('different unresolved questions cannot be collapsed into an imprecise Attention item', async () => {
  const fixture = await createCoordinationFixture({
    findings: ['NEEDS_DECISION', 'NEEDS_DECISION'],
    decisionQuestionByProject: {
      order: 'Should duplicate requests be idempotent?',
      quote: 'Should authorization failures be cached?',
    },
  });

  const result = await coordinateContract(fixture.context, fixture.scope, fixture.options);

  assert.equal(result.outcome, 'INVALID');
  assert.match(result.reason, /CONTRACT_DECISION_NOT_PRECISE/);
});

test('invalid validator evidence cannot be overridden by an ACCEPT finding', async () => {
  const fixture = await createCoordinationFixture({
    findings: ['ACCEPT', 'ACCEPT'],
    validatorStatus: 'FAIL',
  });

  const result = await coordinateContract(fixture.context, fixture.scope, fixture.options);

  assert.equal(result.outcome, 'INVALID');
  assert.match(result.reason, /CONTRACT_VALIDATOR_FAILED/);
});

test('a candidate with an unmappable required scenario cannot become READY', async () => {
  const fixture = await createCoordinationFixture({
    findings: ['ACCEPT', 'ACCEPT'],
    scenarioWithoutExpectedOutcome: 'SC-007',
  });

  const result = await coordinateContract(fixture.context, fixture.scope, fixture.options);

  assert.equal(result.outcome, 'INVALID');
  assert.match(result.reason, /TEST_CASE_MAPPING_INCOMPLETE/);
});

test('classifies only evidence-backed contradictions as automatically resolvable', () => {
  const findings = [
    findingFixture('FND-0001', 'CORRECTION', 'NONE'),
    findingFixture('FND-0002', 'CONTRADICTION', 'EVIDENCE_BACKED'),
    findingFixture('FND-0003', 'CONTRADICTION', 'UNRESOLVED'),
    findingFixture('FND-0004', 'NEEDS_DECISION', 'UNRESOLVED'),
    findingFixture('FND-0005', 'CONTRADICTION', 'NONE'),
  ];

  const result = classifyFindings(findings);

  assert.deepEqual(result.corrections.map((finding) => finding.findingId), ['FND-0001']);
  assert.deepEqual(result.resolvableContradictions.map((finding) => finding.findingId), ['FND-0002']);
  assert.deepEqual(result.unresolvedDecisions.map((finding) => finding.findingId), [
    'FND-0003', 'FND-0004', 'FND-0005',
  ]);
});

test('Critic concurrency never exceeds the selected Agent proven session capacity', async () => {
  const fixture = await createCoordinationFixture({
    projects: ['order', 'quote', 'user'],
    findings: ['ACCEPT', 'ACCEPT', 'ACCEPT'],
    agentCapacity: 1,
  });

  assert.equal((await coordinateContract(fixture.context, fixture.scope, fixture.options)).outcome, 'READY');
  assert.equal(fixture.peakCritics(), 1);
});

test('concurrent independent contract scopes allocate distinct Runs in one Workset', async () => {
  const relations = ['contract:authorization-v2', 'contract:pricing-v3'];
  const base = await createScopeFixture({
    order: { produces: relations },
    quote: { consumes: relations },
  }, 'PASS');
  const scopes = await discoverContractCoordinationScopes(base.context);
  assert.equal(scopes.length, 2);
  const profile = coordinatorProfile();
  const probe = coordinatorProbe(profile);
  const adapters: CoordinationAdapter[] = [];
  const jobs = await Promise.all(scopes.map(async (scope) => {
    const sources = await captureContractSources(base.context, scope);
    const adapter = new CoordinationAdapter(scope, sources, { findings: ['ACCEPT', 'ACCEPT'] });
    adapters.push(adapter);
    const context: ContractCoordinatorContext = {
      ...base.context,
      agentProfiles: [profile],
      agentProbes: [probe],
      adapterFor: () => adapter,
    };
    return { context, scope };
  }));

  const results = await Promise.all(jobs.map((job) =>
    coordinateContract(job.context, job.scope, { criticCapacity: 2 })));

  assert.deepEqual(results.map((result) => result.outcome), ['READY', 'READY']);
  const runIds = adapters.flatMap((adapter) => adapter.seenPackets.map((packet) => packet.id));
  assert.equal(new Set(runIds).size, runIds.length);
});

test('three unchanged correction cycles exhaust the fixed Planner budget', async () => {
  const fixture = await createCoordinationFixture({ findings: ['CORRECTION', 'ACCEPT'] });

  const result = await coordinateContract(fixture.context, fixture.scope, fixture.options);

  assert.equal(result.outcome, 'INVALID');
  assert.match(result.reason, /CONTRACT_COORDINATION_BUDGET_EXHAUSTED/);
  assert.equal(fixture.runKinds().filter((kind) => kind === 'CONTRACT_PLANNER').length, 3);
  assert.equal(fixture.runKinds().filter((kind) => kind === 'CONTRACT_RESOLVER').length, 0);
  assert.equal(new Set(fixture.sessionIds()).size, 9);
});

test('an ACCEPT finding with a nonexistent citation is rejected by deterministic Core checks', async () => {
  const fixture = await createCoordinationFixture({
    findings: ['ACCEPT', 'ACCEPT'],
    invalidEvidenceProject: 'quote',
  });

  const result = await coordinateContract(fixture.context, fixture.scope, fixture.options);

  assert.equal(result.outcome, 'INVALID');
  assert.match(result.reason, /CRITIC_EVIDENCE_INVALID/);
});

test('a source changed after Planner completion is rejected before Critics receive mixed input', async () => {
  const fixture = await createCoordinationFixture({
    findings: ['ACCEPT', 'ACCEPT'],
    mutateSourceAfterPlanner: 'quote',
  });

  const result = await coordinateContract(fixture.context, fixture.scope, fixture.options);

  assert.equal(result.outcome, 'INVALID');
  assert.match(result.reason, /COORDINATION_SOURCE_STALE/);
  assert.deepEqual(fixture.runKinds(), ['CONTRACT_PLANNER']);
});

test('a source changed while Critics run returns INVALID instead of rejecting the coordination call', async () => {
  const fixture = await createCoordinationFixture({
    findings: ['ACCEPT', 'ACCEPT'],
    mutateSourceDuringCritics: 'quote',
  });

  const result = await coordinateContract(fixture.context, fixture.scope, fixture.options);

  assert.equal(result.outcome, 'INVALID');
  assert.match(result.reason, /CONTRACT_SOURCE_(?:INVENTORY_MISMATCH|STALE)/);
});

test('identical unresolved business choices reuse one open Attention item across retries', async () => {
  const fixture = await createCoordinationFixture({ findings: ['NEEDS_DECISION', 'ACCEPT'] });

  const first = await coordinateContract(fixture.context, fixture.scope, fixture.options);
  const second = await coordinateContract(fixture.context, fixture.scope, fixture.options);

  assert.equal(first.outcome, 'NEEDS_DECISION');
  assert.equal(second.outcome, 'NEEDS_DECISION');
  assert.equal(second.attention.id, first.attention.id);
  assert.equal(second.contractId, first.contractId);
});

test('role inputs expose only the exact source inventory required by Planner, Critic, and Resolver', async () => {
  const fixture = await createCoordinationFixture({ findings: ['CONTRADICTION', 'ACCEPT'] });

  assert.equal((await coordinateContract(fixture.context, fixture.scope, fixture.options)).outcome, 'READY');
  const inputs = fixture.inputs();
  const planner = inputs.find((input) => input.kind === 'CONTRACT_PLANNER');
  const critics = inputs.filter((input) => input.kind === 'PROJECT_CRITIC');
  const resolver = inputs.find((input) => input.kind === 'CONTRACT_RESOLVER');
  assert.ok(planner);
  assert.ok(resolver);
  assert.deepEqual(recordArray(planner.snapshotRoots).map((item) => item.project), ['order', 'quote']);
  assert.deepEqual(recordArray(planner.sources).map((item) => item.project), [
    'order', 'order', 'quote', 'quote',
  ]);
  assert.equal(critics.length, 4);
  for (const critic of critics) {
    const participant = recordValue(critic.participant);
    assert.deepEqual(
      [...new Set(recordArray(critic.projectSources).map((item) => item.project))],
      [participant.project],
    );
    assert.deepEqual(recordArray(critic.snapshotRoots).map((item) => item.project), [participant.project]);
    assert.equal(recordArray(critic.sharedIntentExcerpts).length, 2);
  }
  for (const snapshot of recordArray(planner.snapshotRoots)) {
    assert.match(String(snapshot.head), /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
    assert.match(String(snapshot.contentHash), /^sha256:[0-9a-f]{64}$/);
  }
  assert.deepEqual(
    recordArray(resolver.contradictoryFindings).map((item) => item.disposition),
    ['CONTRADICTION'],
  );
  assert.deepEqual(
    [...new Set(recordArray(resolver.citedSources).map((item) => item.project))],
    ['order'],
  );
});

type FindingDisposition = ProjectFinding['disposition'];

interface CoordinationFixtureInput {
  readonly projects?: readonly string[];
  readonly findings: readonly FindingDisposition[];
  readonly revisedFindings?: readonly FindingDisposition[];
  readonly contradictionResolution?: 'EVIDENCE_BACKED';
  readonly validatorStatus?: 'PASS' | 'FAIL';
  readonly scenarioWithoutExpectedOutcome?: string;
  readonly invalidEvidenceProject?: string;
  readonly agentCapacity?: number;
  readonly mutateSourceAfterPlanner?: string;
  readonly mutateSourceDuringCritics?: string;
  readonly decisionQuestionByProject?: Readonly<Record<string, string>>;
  readonly reuseSessionId?: boolean;
}

interface ProjectDefinition {
  readonly consumes?: readonly string[];
  readonly produces?: readonly string[];
}

async function createCoordinationFixture(input: CoordinationFixtureInput): Promise<{
  context: ContractCoordinatorContext;
  scope: ContractCoordinationScope;
  options: ContractCoordinationOptions;
  packets(): readonly RunPacket[];
  inputs(): readonly Record<string, unknown>[];
  outputBasenames(): readonly string[];
  runKinds(): RunPacket['kind'][];
  sessionIds(): readonly string[];
  peakCritics(): number;
  adapterFactoryCalls(): number;
  allCoordinationSnapshotsReadOnly(): boolean;
  writerRunCount(): number;
}> {
  const projects = input.projects ?? ['order', 'quote'];
  const definitions: Record<string, ProjectDefinition> = {};
  for (let index = 0; index < projects.length; index += 1) {
    definitions[projects[index]!] = index === 0
      ? { produces: ['contract:authorization-v2'] }
      : { consumes: ['contract:authorization-v2'] };
  }
  const base = await createScopeFixture(definitions, input.validatorStatus ?? 'PASS');
  const [scope] = await discoverContractCoordinationScopes(base.context);
  assert.ok(scope);
  const sources = await captureContractSources(base.context, scope);
  const adapter = new CoordinationAdapter(scope, sources, input);
  const profile = coordinatorProfile(input.agentCapacity ?? 8);
  const probe = coordinatorProbe(profile);
  let adapterFactoryCalls = 0;
  const context: ContractCoordinatorContext = {
    ...base.context,
    agentProfiles: [profile],
    agentProbes: [probe],
    adapterFor: (selected) => {
      assert.equal(selected.agentId, profile.agentId);
      adapterFactoryCalls += 1;
      return adapter;
    },
  };
  return {
    context,
    scope,
    options: { criticCapacity: projects.length },
    packets: () => adapter.seenPackets,
    inputs: () => adapter.seenInputs,
    outputBasenames: () => adapter.seenOutputPaths.map((path) => basename(path)),
    runKinds: () => adapter.seenPackets.map((packet) => packet.kind),
    sessionIds: () => adapter.seenSessionIds,
    peakCritics: () => adapter.peakCriticCount,
    adapterFactoryCalls: () => adapterFactoryCalls,
    allCoordinationSnapshotsReadOnly: () => adapter.snapshotsReadOnly,
    writerRunCount: () => adapter.seenPackets.filter((packet) =>
      packet.kind === 'PROJECT_WRITER' || packet.kind === 'RECOVERY_WRITER').length,
  };
}

async function createScopeFixture(
  definitions: Record<string, ProjectDefinition>,
  validatorStatus: 'PASS' | 'FAIL',
): Promise<{
  context: { home: string; worksetId: string; now: () => string };
  workset: Workset;
}> {
  const sandbox = await createTestDirectory('omnai-contract-coordinator-');
  cleanups.push(sandbox.cleanup);
  const home = join(sandbox.root, 'home');
  const workset = await createWorkset(home, 'Authorization Coordination');

  for (const [project, definition] of Object.entries(definitions)) {
    const root = join(sandbox.root, 'projects', project);
    await mkdir(root, { recursive: true });
    const change = await createChange(root, `${project} contract change`, 'small-feature');
    await writeFile(
      changeArtifactPath(root, change.directoryName, 'intent.md'),
      `# ${project} intent\nImplement Authorization V2 for ${project}.\n`,
      'utf8',
    );
    await writeFile(
      changeArtifactPath(root, change.directoryName, 'design.md'),
      `# ${project} design\nAuthorization V2 uses a stable response schema.\n`,
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
        files: { create: [], modify: [], tests: [] },
        consumes: [...(definition.consumes ?? [])],
        produces: [...(definition.produces ?? [])],
        steps: ['coordinate contract'],
        evidenceRequired: ['contract'],
        notes: [],
      }],
    });
    if (validatorStatus === 'FAIL' && project === Object.keys(definitions)[0]) {
      const config = await loadProjectConfig(root);
      await saveProjectConfig(root, { ...config, verification: { commands: ['false'] } });
    }
    initializeRepository(root);
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
  return { context: { home, worksetId: workset.id, now: () => NOW }, workset };
}

function initializeRepository(root: string): void {
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'OmnAI Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'test: initialize coordination project'], {
    cwd: root,
    stdio: 'ignore',
  });
}

class CoordinationAdapter implements AgentSessionAdapter {
  readonly seenPackets: RunPacket[] = [];
  readonly seenSessionIds: string[] = [];
  readonly seenInputs: Record<string, unknown>[] = [];
  readonly seenOutputPaths: string[] = [];
  peakCriticCount = 0;
  snapshotsReadOnly = true;
  private activeCritics = 0;
  private criticWaveWaiters: Array<() => void> = [];
  private plannerAttempt = 0;
  private resolutionApplied = false;
  private candidate: ContractCandidate | undefined;
  private readonly findings: ProjectFinding[] = [];

  constructor(
    private readonly scope: ContractCoordinationScope,
    private readonly sources: readonly ContractSource[],
    private readonly input: CoordinationFixtureInput,
  ) {}

  async probe(): Promise<AgentProbe> {
    return coordinatorProbe(coordinatorProfile(this.input.agentCapacity ?? 8));
  }

  async start(request: AgentSessionRequest, hooks: AgentSessionHooks) {
    const packet = request.packet;
    const sessionId = this.input.reuseSessionId ? 'shared-session' : `session-${packet.id}`;
    this.seenPackets.push(packet);
    this.seenSessionIds.push(sessionId);
    this.seenOutputPaths.push(request.outputPath);
    await this.captureInput(packet.objective);
    const record = {
      schemaVersion: 1 as const,
      machineVersion: 1 as const,
      lastEventSequence: 0,
      lastEventHash: null,
      runId: packet.id,
      agentId: request.profile.agentId,
      protocol: request.profile.protocol,
      sessionId,
      processId: process.pid,
      promptState: 'NOT_SENT' as const,
      createdAt: NOW,
      updatedAt: NOW,
    };
    await hooks.onSessionCreated(record);
    await hooks.onPromptIntent();
    await hooks.onEvent({
      schemaVersion: 1,
      runId: packet.id,
      sessionId,
      sequence: 1,
      kind: 'SESSION_UPDATE',
      payload: { status: 'working' },
      timestamp: NOW,
    });

    if (packet.kind === 'PROJECT_CRITIC') {
      this.activeCritics += 1;
      this.peakCriticCount = Math.max(this.peakCriticCount, this.activeCritics);
      await this.inspectSnapshotRoots(packet);
      await this.waitForCriticWave();
    } else if (packet.kind === 'CONTRACT_PLANNER' || packet.kind === 'CONTRACT_RESOLVER') {
      await this.inspectSnapshotRoots(packet);
    }

    const artifact = this.artifactFor(packet);
    const serialized = JSON.stringify(artifact);
    await writeFile(request.outputPath, serialized, 'utf8');
    if (packet.kind === 'CONTRACT_PLANNER' && this.plannerAttempt === 1 &&
        this.input.mutateSourceAfterPlanner !== undefined) {
      const source = this.sources.find((item) =>
        item.project === this.input.mutateSourceAfterPlanner && item.kind === 'intent');
      assert.ok(source);
      await writeFile(source.absolutePath, '# changed while contract coordination was active\n', 'utf8');
    }
    if (packet.kind === 'PROJECT_CRITIC' && this.plannerAttempt === 1 &&
        this.input.mutateSourceDuringCritics !== undefined) {
      const source = this.sources.find((item) =>
        item.project === this.input.mutateSourceDuringCritics && item.kind === 'design');
      assert.ok(source);
      await writeFile(source.absolutePath, '# changed while project Critics were active\n', 'utf8');
    }
    if (packet.kind === 'PROJECT_CRITIC') this.activeCritics -= 1;
    return {
      status: 'COMPLETED' as const,
      runId: packet.id,
      sessionId,
      stopReason: 'end_turn' as const,
      outputBytes: Buffer.byteLength(serialized),
    };
  }

  async inspect(request: Parameters<AgentSessionAdapter['inspect']>[0]) {
    return {
      sessionId: request.record.sessionId,
      process: 'LIVE' as const,
      outcome: 'COMPLETED' as const,
      eventCount: request.events.length,
    };
  }

  async signal(): Promise<void> {}

  async collect(request: Parameters<AgentSessionAdapter['collect']>[0]) {
    return {
      sessionId: request.record.sessionId,
      status: 'COMPLETED' as const,
      stopReason: 'end_turn' as const,
      events: request.events,
      outputBytes: 1,
    };
  }

  async resume(request: Parameters<AgentSessionAdapter['resume']>[0]) {
    return {
      status: 'RESUMED' as const,
      runId: request.packet.id,
      sessionId: request.record.sessionId,
      stopReason: null,
      outputBytes: 0,
    };
  }

  private artifactFor(packet: RunPacket): unknown {
    if (packet.kind === 'CONTRACT_PLANNER') {
      this.plannerAttempt += 1;
      this.candidate = candidateFor(
        this.scope,
        this.sources,
        packet,
        this.input.scenarioWithoutExpectedOutcome,
        this.resolutionApplied,
      );
      if (this.input.scenarioWithoutExpectedOutcome !== undefined) {
        const raw = structuredClone(this.candidate) as unknown;
        const document = recordValue(raw);
        const scenario = recordArray(document.businessScenarios).find((item) =>
          item.id === this.input.scenarioWithoutExpectedOutcome);
        assert.ok(scenario);
        assert.equal(Reflect.deleteProperty(scenario, 'expectedOutcome'), true);
        return document;
      }
      return this.candidate;
    }
    if (packet.kind === 'PROJECT_CRITIC') {
      assert.ok(this.candidate);
      const match = /participant=([a-z0-9-]+);role=(PROVIDER|CONSUMER)/u.exec(packet.objective);
      assert.ok(match, `critic packet does not identify its participant: ${packet.objective}`);
      const project = match[1]!;
      const role = match[2]!;
      const index = this.scope.participants.findIndex((participant) =>
        participant.project === project && participant.role === role);
      assert.notEqual(index, -1);
      const dispositions = this.plannerAttempt === 1
        ? this.input.findings
        : (this.input.revisedFindings ?? (this.resolutionApplied
            ? this.input.findings.map((item) => item === 'CONTRADICTION' ? 'ACCEPT' : item)
            : this.input.findings));
      const disposition = dispositions[index] ?? 'ACCEPT';
      let finding = findingFor(packet, this.candidate, project, disposition, this.sources);
      if (this.input.invalidEvidenceProject === project) {
        finding = { ...finding, evidenceRefs: ['missing/source/ref'] };
      }
      const decisionQuestion = this.input.decisionQuestionByProject?.[project];
      if (decisionQuestion !== undefined && finding.disposition === 'NEEDS_DECISION') {
        finding = { ...finding, summary: decisionQuestion };
      }
      this.findings.push(finding);
      return finding;
    }
    if (packet.kind === 'CONTRACT_RESOLVER') {
      assert.ok(this.candidate);
      this.resolutionApplied = true;
      const contradictions = this.findings
        .filter((finding) => finding.candidateHash === hashObject(this.candidate) &&
          finding.disposition === 'CONTRADICTION')
        .sort((left, right) => left.findingId.localeCompare(right.findingId));
      return {
        schemaVersion: 1,
        runId: packet.id,
        packetHash: packet.packetHash,
        candidateHash: hashObject(this.candidate),
        summary: 'The cited project evidence supports retaining the original-result behavior.',
        resolutions: contradictions.map((finding) => ({
          findingId: finding.findingId,
          selectedOptionId: 'original-result',
          candidateOptionIds: ['conflict-error', 'original-result'],
          evidenceRefs: finding.evidenceRefs,
        })),
      };
    }
    throw new Error(`TEST_UNEXPECTED_RUN_KIND: ${packet.kind}`);
  }

  private async inspectSnapshotRoots(packet: RunPacket): Promise<void> {
    const roots = packet.permissionPolicy.filesystemRoots.filter((root) => root.includes('/snapshots/'));
    if (roots.length === 0) this.snapshotsReadOnly = false;
    for (const root of roots) {
      const metadata = await stat(root);
      if ((metadata.mode & 0o222) !== 0) this.snapshotsReadOnly = false;
    }
  }

  private async captureInput(objective: string): Promise<void> {
    const match = /;input=([^;]+);inputHash=(sha256:[0-9a-f]{64})$/u.exec(objective);
    assert.ok(match, `coordination input binding is missing: ${objective}`);
    const document = YAML.parse(await readFile(match[1]!, 'utf8')) as unknown;
    assert.ok(isRecord(document));
    assert.equal(hashObject(document), match[2]);
    this.seenInputs.push(document);
  }

  private async waitForCriticWave(): Promise<void> {
    const waveSize = Math.min(
      this.scope.participants.length,
      this.input.agentCapacity ?? this.scope.participants.length,
    );
    if (this.activeCritics === waveSize) {
      for (const release of this.criticWaveWaiters.splice(0)) release();
      if (waveSize === 1) await new Promise<void>((resolve) => setTimeout(resolve, 200));
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('TEST_CRITIC_WAVE_DID_NOT_RUN_CONCURRENTLY')),
        2_000,
      );
      this.criticWaveWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function coordinatorProfile(maxParallelSessions = 8): AgentProfile {
  return {
    schemaVersion: 1,
    agentId: 'coordinator-agent',
    protocol: 'acp',
    command: 'coordinator-agent',
    args: [],
    envRefs: {},
    protocolVersion: 1,
    priority: 1,
    costClass: 'LOW',
    maxParallelSessions,
    isolation: { mode: 'agent-sandbox', enforcedWorkspaceRoots: true },
    capabilities: {
      loadSession: true,
      resumeSession: true,
      closeSession: true,
      additionalDirectories: true,
      mcpStdio: true,
    },
    omnaiModes: ['coordination-read-only'],
    conformance: {
      suiteVersion: 1,
      passedAt: NOW,
      inputHash: CONFORMANCE_HASH,
      evidenceHash: hashObject('coordinator-agent-conformance-evidence'),
    },
  };
}

function coordinatorProbe(profile: AgentProfile): AgentProbe {
  return {
    schemaVersion: 1,
    agentId: profile.agentId,
    available: true,
    authenticated: true,
    protocolVersion: 1,
    health: 'HEALTHY',
    activeSessions: 0,
    capabilities: profile.capabilities,
    conformanceInputHash: CONFORMANCE_HASH,
  };
}

function candidateFor(
  scope: ContractCoordinationScope,
  sources: readonly ContractSource[],
  packet: Extract<RunPacket, { kind: 'CONTRACT_PLANNER' }>,
  scenarioWithoutExpectedOutcome?: string,
  resolutionApplied = false,
): ContractCandidate {
  const sourceRefs = sources.map((source) => source.ref);
  const provider = scope.participants.find((participant) => participant.role === 'PROVIDER');
  assert.ok(provider);
  const participants = new Map<string, {
    project: string;
    role: 'PROVIDER' | 'CONSUMER';
    taskRefs: string[];
  }>();
  for (const participant of scope.participants) {
    const key = `${participant.project}\0${participant.role}`;
    const current = participants.get(key) ?? {
      project: participant.project,
      role: participant.role,
      taskRefs: [],
    };
    if (!current.taskRefs.includes(participant.taskId)) current.taskRefs.push(participant.taskId);
    current.taskRefs.sort();
    participants.set(key, current);
  }
  const scenarios = [
    ['SC-001', 'NORMAL', 'authorization succeeds'],
    ['SC-002', 'BOUNDARY', 'authorization input is incomplete'],
    ['SC-003', 'FAILURE', 'authorization provider is unavailable'],
    ['SC-004', 'COMPATIBILITY', 'an existing consumer reads the response'],
  ] as const;
  const businessScenarios: ContractCandidate['businessScenarios'][number][] = scenarios.map(
    ([id, scenarioClass, title]) => ({
      id,
      class: scenarioClass,
      title,
      participantProjects: [...scope.projects],
      sourceRefs,
      contractElementRefs: ['authorization.response'],
      fixtureRefs: [],
      executorRefs: ['validator:parser'],
      expectedOutcome: `${title} has a deterministic outcome`,
    }),
  );
  if (scenarioWithoutExpectedOutcome !== undefined) {
    businessScenarios.push({
      id: scenarioWithoutExpectedOutcome,
      class: 'NORMAL',
      title: 'duplicate request behavior',
      participantProjects: [...scope.projects],
      sourceRefs,
      contractElementRefs: ['authorization.response'],
      fixtureRefs: [],
      executorRefs: ['validator:parser'],
      expectedOutcome: 'duplicate requests have a deterministic outcome',
    });
    businessScenarios.sort((left, right) => left.id.localeCompare(right.id));
  }
  const scenarioIds = businessScenarios.map((scenario) => scenario.id);
  return {
    schemaVersion: 1,
    runId: packet.id,
    packetHash: packet.packetHash,
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
        definition: {
          type: 'object',
          required: ['authorized'],
          ...(resolutionApplied ? { duplicateRequest: 'RETURN_ORIGINAL_RESULT' } : {}),
        },
        sourceRefs,
      }],
      compatibilityPolicy: {
        mode: 'BACKWARD_COMPATIBLE',
        rules: resolutionApplied
          ? [
              'Duplicate requests return the original result.',
              'Existing consumers continue to read the authorized field.',
            ]
          : ['Existing consumers continue to read the authorized field.'],
      },
    },
    businessScenarios,
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

function findingFor(
  packet: Extract<RunPacket, { kind: 'PROJECT_CRITIC' }>,
  candidate: ContractCandidate,
  project: string,
  disposition: FindingDisposition,
  sources: readonly ContractSource[],
): ProjectFinding {
  const evidenceRef = sources.find((source) => source.project === project)?.ref;
  assert.ok(evidenceRef);
  const needsOptions = disposition === 'CONTRADICTION' || disposition === 'NEEDS_DECISION';
  return {
    schemaVersion: 1,
    runId: packet.id,
    packetHash: packet.packetHash,
    findingId: `FND-${packet.id.slice('RUN-'.length)}`,
    project,
    candidateHash: hashObject(candidate),
    disposition,
    resolution: disposition === 'CONTRADICTION'
      ? 'EVIDENCE_BACKED'
      : disposition === 'NEEDS_DECISION'
        ? 'UNRESOLVED'
        : 'NONE',
    summary: disposition === 'NEEDS_DECISION'
      ? DECISION_QUESTION
      : `${project} ${disposition.toLowerCase()} finding`,
    evidenceRefs: [evidenceRef],
    candidateOptions: needsOptions
      ? [{
          id: 'conflict-error',
          summary: 'Return a conflict error for duplicate requests.',
          evidenceRefs: [evidenceRef],
        }, {
          id: 'original-result',
          summary: 'Return the original result for duplicate requests.',
          evidenceRefs: [evidenceRef],
        }]
      : [],
  };
}

function findingFixture(
  findingId: string,
  disposition: ProjectFinding['disposition'],
  resolution: ProjectFinding['resolution'],
): ProjectFinding {
  return {
    schemaVersion: 1,
    runId: `RUN-${findingId.slice('FND-'.length)}`,
    packetHash: hashObject(`packet-${findingId}`),
    findingId,
    project: 'quote',
    candidateHash: hashObject('candidate'),
    disposition,
    resolution,
    summary: `${disposition} finding`,
    evidenceRefs: ['quote/CHG-0001/REV-0001/intent.md'],
    candidateOptions: disposition === 'CONTRADICTION' || disposition === 'NEEDS_DECISION'
      ? [{
          id: 'option-a',
          summary: 'Option A',
          evidenceRefs: ['quote/CHG-0001/REV-0001/intent.md'],
        }]
      : [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  for (const item of value) assert.ok(isRecord(item));
  return value as Record<string, unknown>[];
}
