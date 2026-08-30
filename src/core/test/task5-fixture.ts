import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import {
  clearInjectedAuthorityCatalogForTest,
  loadInjectedAuthorityCatalogForTest,
  type AuthorityCatalogTestLease,
} from '../../authority/catalog-loader.js';
import { hashStrictObject, stageAuthorityCatalogV1Schema } from '../../authority/catalog-schema.js';
import {
  changeMetadataSchema,
  decisionRecordSchema,
  evidenceRecordSchema,
  flowAssessmentSchema,
  taskFileSchema,
  type ChangeMetadata,
  type DecisionRecord,
  type FlowPlan,
} from '../../domain/change.js';
import { stageRunManifestSchema } from '../../domain/run.js';
import { hObject } from '../../domain/public.js';
import { compileRunDescendants } from '../../authority/compilers/run-descendants.js';
import { compileFlowPlan } from '../flow.js';

const SHA_B = `sha256:${'b'.repeat(64)}`;
export const TASK5_TIMESTAMP = '2026-08-27T00:00:00.000Z';

export type Task5Fixture = Readonly<{
  repoRoot: string;
  projectAuthorityRoot: string;
  changeRoot: string;
  change: { directoryName: string; metadata: ChangeMetadata };
  metadata: ChangeMetadata;
  decisions: readonly DecisionRecord[];
  flow: FlowPlan;
}>;

export async function task5Fixture(
  t: { after(callback: () => void | Promise<void>): void },
  prefix: string,
  decisionStatuses: readonly DecisionRecord['status'][] = ['OPEN'],
): Promise<Task5Fixture> {
  const repoRoot = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const lease = await acquireCatalogLease();
  t.after(() => clearInjectedAuthorityCatalogForTest(lease));

  execFileSync('/usr/bin/git', ['init', '--quiet'], { cwd: repoRoot, stdio: 'ignore' });
  const projectAuthorityRoot = join(repoRoot, '.omnai');
  const directoryName = 'CHG-0001-real-layout';
  const changeRoot = join(projectAuthorityRoot, 'changes', directoryName);
  await mkdir(join(changeRoot, 'decisions'), { recursive: true });
  await mkdir(join(changeRoot, 'evidence'));
  await mkdir(join(changeRoot, 'revisions'));
  await mkdir(join(changeRoot, 'runs'));
  await mkdir(join(repoRoot, 'src'));

  await writeFile(join(projectAuthorityRoot, 'workflow.lock.yaml'), YAML.stringify({
    schemaVersion: 2,
    workflowVersion: '0.3.0',
    authorityCatalogId: 'omnai.stage-authority.v1',
    authorityCatalogSchemaVersion: 1,
    authorityCatalogHash: hashStrictObject(lease.catalog),
    resourceBundleHash: SHA_B,
  }));

  const metadata = changeMetadataSchema.parse({
    schemaVersion: 2,
    id: 'CHG-0001',
    slug: 'real-layout',
    title: 'Real Layout',
    scenario: 'small-feature',
    workMode: 'FEATURE',
    status: 'IN_PROGRESS',
    activeRevision: 'REV-0001',
    baseline: 'BL-0001',
    artifactVersions: { 'domain.md': 1 },
    risk: {
      level: 'P2',
      dimensions: {
        businessCriticality: 'MEDIUM', data: 'LOW', compatibility: 'LOW',
        reversibility: 'MEDIUM', security: 'LOW', operational: 'LOW',
      },
    },
    impact: {
      frontend: false, backend: true, apiContract: false, database: false,
      mq: false, remoteService: false, security: false, observability: false,
    },
    createdAt: TASK5_TIMESTAMP,
    updatedAt: TASK5_TIMESTAMP,
    readiness: {
      frame: 'READY', map: 'NOT_APPLICABLE', research: 'READY', mitigation: 'NOT_APPLICABLE',
      triage: 'NOT_APPLICABLE', reproduction: 'NOT_APPLICABLE', diagnosis: 'NOT_APPLICABLE',
      domain: 'READY', spec: 'READY', design: 'READY', experiment: 'NOT_APPLICABLE',
      fix: 'NOT_APPLICABLE', plan: 'READY', implementation: 'IN_PROGRESS', review: 'MISSING',
      simplification: 'MISSING', verification: 'MISSING', qa: 'MISSING', release: 'MISSING',
      canary: 'MISSING', learning: 'MISSING',
    },
  });
  await writeFile(join(changeRoot, 'change.yaml'), YAML.stringify(metadata));

  const task = {
    id: 'TASK-001', title: 'Inspect source', objective: 'Use authenticated current source',
    status: 'READY', dependsOn: [], slice: 'CONTRACT_FIRST', risk: 'HIGH',
    files: { create: [], modify: ['src/current.ts'], tests: [] },
    consumes: [], produces: ['SourceRef'], steps: ['Inspect current source'],
    evidenceRequired: [], notes: [],
  };
  await writeFile(join(changeRoot, 'tasks.yaml'), YAML.stringify(taskFileSchema.parse({
    schemaVersion: 1,
    revision: 'REV-0001',
    generatedFrom: [],
    tasks: [task],
  })));
  await writeFile(join(changeRoot, 'progress.jsonl'), '');
  await writeFile(join(changeRoot, 'domain.md'), 'real artifact bytes\n');
  await writeFile(join(repoRoot, 'src', 'current.ts'), 'export const current = true;\n');

  const evidenceSubject = {
    kind: 'CHANGE_AUTHORITY' as const,
    revision: metadata.activeRevision,
    authorityHead: `sha256:${'a'.repeat(64)}`,
  };
  const evidence = evidenceRecordSchema.parse({
    schemaVersion: 1,
    id: 'EVD-000001',
    changeId: metadata.id,
    revision: metadata.activeRevision,
    runBinding: null,
    requirementId: null,
    gateId: null,
    taskId: null,
    type: 'manual',
    status: 'PASS',
    producer: 'GENERIC_IMPORT',
    subjectBinding: { subject: evidenceSubject, subjectHash: hashStrictObject(evidenceSubject) },
    summary: 'Current evidence',
    verificationCommand: null,
    createdAt: TASK5_TIMESTAMP,
    outputFile: null,
  });
  await writeFile(join(changeRoot, 'evidence', `${evidence.id}.yaml`), YAML.stringify(evidence));

  // 真实 Change inventory 可以包含已持久化 Run manifest；fixture 保留其 prompt/output
  // auxiliary 未落盘，以验证 Task5 builder 只认证已有 logical manifest，不猜测 receipt 所有权。
  const terminal = {
    kind: 'ARTIFACT_STAGE' as const,
    readinessKey: 'spec' as const,
    requiredOutputRoles: ['SPEC'],
  };
  const prepareOwner = {
    sequence: 1,
    owner: { kind: 'STAGE_PREPARE' as const, id: 'RUN-000001' },
    operationRequestId: 'task5-run-prepare',
    requestDigest: `sha256:${'c'.repeat(64)}`,
  };
  const authorityContract = {
    schemaVersion: 3 as const,
    changeId: metadata.id,
    runId: 'RUN-000001' as const,
    capability: 'spec' as const,
    revision: metadata.activeRevision,
    preparedFromAuthorityHead: `sha256:${'d'.repeat(64)}`,
    prepareOwner,
    authoredOutputBindings: [{
      kind: 'AUTHORED_FILE' as const,
      role: 'SPEC',
      path: 'spec.md',
      scaffoldBinding: null,
    }],
    allowedDescendants: compileRunDescendants({
      runId: 'RUN-000001',
      terminal,
      evidenceRequirements: [],
      humanGates: [],
    }),
    terminal,
    terminalHash: hObject(terminal),
  };
  const protocolBindings = [
    {
      id: 'common', version: 1, relativePath: 'resources/protocols/common.md',
      rawBytesHash: `sha256:${'e'.repeat(64)}`,
    },
    {
      id: 'repository.spec', version: 1, relativePath: 'resources/protocols/repository/spec.md',
      rawBytesHash: `sha256:${'f'.repeat(64)}`,
    },
  ];
  const run = stageRunManifestSchema.parse({
    schemaVersion: 3,
    workflowVersion: '0.3.0',
    authorityCatalogHash: hashStrictObject(lease.catalog),
    runId: 'RUN-000001',
    changeId: metadata.id,
    revision: metadata.activeRevision,
    capability: 'spec',
    preparedAt: TASK5_TIMESTAMP,
    prepareOwner,
    prompt: {
      path: 'runs/RUN-000001/prompt.md',
      rendererId: 'prompt-render-v1',
      rendererHash: `sha256:${'1'.repeat(64)}`,
      rawBytesHash: `sha256:${'2'.repeat(64)}`,
      instructionHash: `sha256:${'3'.repeat(64)}`,
      contextBindingsHash: `sha256:${'4'.repeat(64)}`,
      protocolBindings,
      protocolBindingsHash: hObject(protocolBindings),
      renderInputHash: `sha256:${'5'.repeat(64)}`,
    },
    authorityContract,
    authorityContractHash: hObject(authorityContract),
    disposition: 'PREPARED',
  });
  await writeFile(join(changeRoot, 'runs', `${run.runId}.yaml`), YAML.stringify(run));

  const decisions: DecisionRecord[] = [];
  for (let index = 0; index < decisionStatuses.length; index += 1) {
    const id = `DEC-${String(index + 1).padStart(4, '0')}`;
    const status = decisionStatuses[index]!;
    const terminal = status !== 'OPEN' && status !== 'BLOCKED';
    const record = decisionRecordSchema.parse({
      schemaVersion: 2,
      id,
      changeId: metadata.id,
      openedRevision: metadata.activeRevision,
      resolvedRevision: terminal ? metadata.activeRevision : null,
      kind: 'DOMAIN',
      owner: 'HUMAN',
      status,
      blocking: true,
      question: `Decision ${id}`,
      options: [],
      resolution: status === 'RESOLVED' || status === 'REJECTED'
        ? { optionId: null, summary: `Closed ${id}`, authority: 'HUMAN_CONFIRMED', sourceRefs: [] }
        : null,
      supersededBy: status === 'SUPERSEDED' ? 'DEC-9999' : null,
      affects: { capabilities: ['model'], artifacts: [], tasks: [], projects: [], contracts: [] },
      sourceRefs: [],
      createdAt: TASK5_TIMESTAMP,
      updatedAt: TASK5_TIMESTAMP,
    });
    decisions.push(record);
    await writeFile(join(changeRoot, 'decisions', `${id}.yaml`), YAML.stringify(record));
  }

  const activeDecisions = decisions.filter(({ status }) => status === 'OPEN' || status === 'BLOCKED');
  const assessment = flowAssessmentSchema.parse({
    scale: 'LOCAL',
    uncertainty: { problem: 'CLEAR', domain: 'CLEAR', solution: 'CLEAR', delivery: 'CLEAR' },
    topology: 'SINGLE_MODULE',
    architectureApplicability: 'NOT_APPLICABLE',
    deliveryShape: 'STANDARD',
    decisionIds: activeDecisions.map(({ id }) => id),
    sourceRefs: activeDecisions.map((decision) => ({
      kind: 'decision' as const,
      decisionId: decision.id,
      contentHash: hObject(decision),
    })),
  });
  const scenario = lease.catalog.scenarioProfiles.find(({ id }) => id === metadata.scenario);
  if (scenario === undefined) throw new Error('TASK5_FIXTURE_SCENARIO_MISSING');
  const flow = compileFlowPlan(metadata, scenario, assessment, decisions, TASK5_TIMESTAMP);
  await writeFile(join(changeRoot, 'flow.yaml'), YAML.stringify(flow));

  return Object.freeze({
    repoRoot,
    projectAuthorityRoot,
    changeRoot,
    metadata,
    decisions: Object.freeze(decisions),
    flow,
    change: { directoryName, metadata },
  });
}

let cachedCatalog: ReturnType<typeof stageAuthorityCatalogV1Schema.parse> | undefined;

async function acquireCatalogLease(): Promise<AuthorityCatalogTestLease> {
  if (cachedCatalog === undefined) {
    const raw = await readFile(join(
      process.cwd(), 'src', 'authority', 'test', 'fixtures', 'stage-authority-catalog-v1.yaml',
    ), 'utf8');
    cachedCatalog = stageAuthorityCatalogV1Schema.parse(YAML.parse(raw));
  }
  return loadInjectedAuthorityCatalogForTest(cachedCatalog);
}
