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
} from '../../../authority/catalog-loader.js';
import { hashStrictObject, stageAuthorityCatalogV1Schema } from '../../../authority/catalog-schema.js';
import { normalizedAbsoluteRealPathSchema } from '../../../domain/public.js';
import {
  parseChangeId,
  parseDecisionId,
  parseEvidenceId,
  parseRevisionId,
} from '../../../domain/scalars.js';
import type { BuildBaseContextRequestV1 } from '../../authority/context.js';

const SHA_A = `sha256:${'a'.repeat(64)}`;
const SHA_B = `sha256:${'b'.repeat(64)}`;
const TIMESTAMP = '2026-08-27T00:00:00.000Z';

export type SourceFixture = Readonly<{
  root: string;
  request: BuildBaseContextRequestV1;
  catalog: ReturnType<typeof stageAuthorityCatalogV1Schema.parse>;
  decision: Record<string, unknown>;
  evidence: Record<string, unknown>;
  task: Record<string, unknown>;
}>;

export async function sourceFixture(
  t: { after(callback: () => void | Promise<void>): void },
  prefix: string,
): Promise<SourceFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lease = await acquireCatalogLease();
  t.after(() => clearInjectedAuthorityCatalogForTest(lease));
  const catalogHash = hashStrictObject(lease.catalog);
  const decision = decisionRecord();
  const evidence = evidenceRecord();
  const task = taskRecord();

  execFileSync('/usr/bin/git', ['init', '--quiet'], { cwd: root, stdio: 'ignore' });
  await mkdir(join(root, 'decisions'));
  await mkdir(join(root, 'evidence'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'workflow.lock.yaml'), YAML.stringify({
    schemaVersion: 2,
    workflowVersion: '0.3.0',
    authorityCatalogId: 'omnai.stage-authority.v1',
    authorityCatalogSchemaVersion: 1,
    authorityCatalogHash: catalogHash,
    resourceBundleHash: SHA_B,
  }));
  await writeFile(join(root, 'change.yaml'), YAML.stringify(changeMetadata()));
  await writeFile(join(root, 'tasks.yaml'), YAML.stringify({
    schemaVersion: 1,
    revision: 'REV-0001',
    generatedFrom: [],
    tasks: [task],
  }));
  await writeFile(join(root, 'decisions', 'DEC-0001.yaml'), YAML.stringify(decision));
  await writeFile(join(root, 'evidence', 'EVD-000001.yaml'), YAML.stringify(evidence));
  await writeFile(join(root, 'domain.md'), 'artifact bytes\n');
  await writeFile(join(root, 'src', 'current.ts'), 'export const current = true;\n');

  const request: BuildBaseContextRequestV1 = {
      expectedChangeId: parseChangeId('CHG-0001'),
      containedRoot: normalizedAbsoluteRealPathSchema.parse(root),
      logicalTargets: [
        { key: { kind: 'METADATA' }, relativePath: 'change.yaml', nodeType: 'FILE' },
        { key: { kind: 'TASKS' }, relativePath: 'tasks.yaml', nodeType: 'FILE' },
        {
          key: { kind: 'DECISION', decisionId: parseDecisionId('DEC-0001') },
          relativePath: 'decisions/DEC-0001.yaml',
          nodeType: 'FILE',
        },
        {
          key: { kind: 'EVIDENCE', evidenceId: parseEvidenceId('EVD-000001') },
          relativePath: 'evidence/EVD-000001.yaml',
          nodeType: 'FILE',
        },
      ],
      archiveTargets: [],
      knownAuxiliaryTargets: [],
  };
  return Object.freeze({
    root,
    catalog: lease.catalog,
    decision,
    evidence,
    task,
    request,
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

function changeMetadata(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: 'CHG-0001',
    slug: 'source-resolution',
    title: 'Source Resolution',
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
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    readiness: {
      frame: 'READY', map: 'NOT_APPLICABLE', research: 'READY', mitigation: 'NOT_APPLICABLE',
      triage: 'NOT_APPLICABLE', reproduction: 'NOT_APPLICABLE', diagnosis: 'NOT_APPLICABLE',
      domain: 'READY', spec: 'READY', design: 'READY', experiment: 'NOT_APPLICABLE',
      fix: 'NOT_APPLICABLE', plan: 'READY', implementation: 'IN_PROGRESS', review: 'MISSING',
      simplification: 'MISSING', verification: 'MISSING', qa: 'MISSING', release: 'MISSING',
      canary: 'MISSING', learning: 'MISSING',
    },
  };
}

function taskRecord(): Record<string, unknown> {
  return {
    id: 'TASK-001',
    title: 'Resolve sources',
    objective: 'Bind current source authority',
    status: 'READY',
    dependsOn: [],
    slice: 'CONTRACT_FIRST',
    risk: 'HIGH',
    files: { create: [], modify: ['src/current.ts'], tests: [] },
    consumes: [],
    produces: ['SourceRef'],
    steps: ['Resolve current inputs'],
    evidenceRequired: [],
    notes: [],
  };
}

function decisionRecord(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: 'DEC-0001',
    changeId: 'CHG-0001',
    openedRevision: 'REV-0001',
    resolvedRevision: null,
    kind: 'DOMAIN',
    owner: 'HUMAN',
    status: 'OPEN',
    blocking: true,
    question: 'Which source owns the decision?',
    options: [],
    resolution: null,
    supersededBy: null,
    affects: { capabilities: ['model'], artifacts: [], tasks: [], projects: [], contracts: [] },
    sourceRefs: [],
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function evidenceRecord(): Record<string, unknown> {
  const subject = { kind: 'CHANGE_AUTHORITY', revision: 'REV-0001', authorityHead: SHA_A };
  return {
    schemaVersion: 1,
    id: 'EVD-000001',
    changeId: 'CHG-0001',
    revision: 'REV-0001',
    runBinding: null,
    requirementId: null,
    gateId: null,
    taskId: null,
    type: 'manual',
    status: 'PASS',
    producer: 'GENERIC_IMPORT',
    subjectBinding: { subject, subjectHash: hashStrictObject(subject) },
    summary: 'Current evidence',
    verificationCommand: null,
    createdAt: TIMESTAMP,
    outputFile: null,
  };
}
