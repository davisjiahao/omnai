import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { CAPABILITIES, type Capability } from '../src/domain/types.js';
import {
  PROTOCOL_IDS,
  ProtocolError,
  loadProtocol,
  loadProtocolBundle,
  locateProtocolRoot,
  parseProtocolId,
  protocolRelativePath,
  repositoryProtocolId,
  validateCanonicalProtocolInventory,
  type ProtocolId,
} from '../src/protocols/index.js';
import { createTestDirectory } from './helpers.js';

const EXPECTED_PROTOCOL_IDS = [
  'common.authoritative-work',
  'repository.frame',
  'repository.research',
  'repository.map',
  'repository.model',
  'repository.spec',
  'repository.design',
  'repository.plan',
  'repository.triage',
  'repository.reproduce',
  'repository.debug',
  'repository.diagnose',
  'repository.experiment',
  'repository.fix',
  'repository.mitigate',
  'repository.work',
  'repository.simplify',
  'repository.review',
  'repository.verify',
  'repository.qa',
  'repository.ship',
  'repository.release',
  'repository.canary',
  'repository.learn',
  'repository.archive',
  'repository.reconcile',
  'interaction.grill',
  'interaction.brainstorm',
  'workset.candidate-research',
  'workset.project-impact-decision',
  'workset.project-change-binding',
  'workset.project-workflow-handoff',
  'workset.reentry-classification',
  'workset.reentry-interaction',
  'workset.reentry-plan',
  'workset.reentry-decision',
  'workset.reentry-apply',
  'workset.reentry-replan',
  'workset.reentry-finalize',
] as const;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

test('the closed catalog contains one repository protocol for every capability in deterministic order', () => {
  assert.deepEqual(PROTOCOL_IDS, EXPECTED_PROTOCOL_IDS);
  assert.deepEqual(
    PROTOCOL_IDS.filter((id) => id.startsWith('repository.')),
    CAPABILITIES.map(repositoryProtocolId),
  );
});

test('protocol IDs map only to canonical package-relative paths', () => {
  assert.equal(protocolRelativePath('repository.design'), 'repository/design.md');
  assert.equal(protocolRelativePath('interaction.grill'), 'interaction/grill.md');
  assert.equal(protocolRelativePath('workset.reentry-replan'), 'workset/reentry-replan.md');
  for (const id of PROTOCOL_IDS) {
    const path = protocolRelativePath(id);
    assert.equal(path.includes('..'), false, id);
    assert.equal(path.startsWith('/'), false, id);
  }
});

test('unknown protocol strings fail with PROTOCOL_UNKNOWN', () => {
  assert.throws(
    () => parseProtocolId('../../secrets'),
    (error: unknown) => error instanceof ProtocolError && error.code === 'PROTOCOL_UNKNOWN',
  );
});

test('valid protocol loads body without frontmatter and hashes the exact complete file bytes', async () => {
  const fixture = await createProtocolRoot(['common.authoritative-work']);
  const fullText = protocolText('common.authoritative-work', 'Canonical body.\n');
  await writeProtocolFile(fixture, 'common.authoritative-work', fullText);

  const document = await loadProtocol('common.authoritative-work', fixture);
  assert.equal(document.id, 'common.authoritative-work');
  assert.equal(document.kind, 'common');
  assert.equal(document.version, 1);
  assert.equal(document.content, 'Canonical body.\n');
  assert.equal(document.content.includes('schemaVersion'), false);
  assert.equal(document.hash, `sha256:${createHash('sha256').update(fullText).digest('hex')}`);
  assert.equal(document.sourcePath, join(fixture, 'common', 'authoritative-work.md'));
});

test('bundle prepends common once, preserves requested order, and removes duplicates', async () => {
  const fixture = await createProtocolRoot([
    'common.authoritative-work',
    'interaction.grill',
    'repository.model',
  ]);

  const bundle = await loadProtocolBundle(
    ['interaction.grill', 'repository.model', 'interaction.grill', 'common.authoritative-work'],
    fixture,
  );

  assert.deepEqual(bundle.protocols.map((item) => item.id), [
    'common.authoritative-work',
    'interaction.grill',
    'repository.model',
  ]);
  assert.equal(
    bundle.rendered,
    [
      '<!-- protocol:common.authoritative-work@1 -->\nBody for common.authoritative-work',
      '<!-- protocol:interaction.grill@1 -->\nBody for interaction.grill',
      '<!-- protocol:repository.model@1 -->\nBody for repository.model',
    ].join('\n\n---\n\n') + '\n',
  );
});

test('known missing resources fail with PROTOCOL_RESOURCE_MISSING', async () => {
  const directory = await createTestDirectory('protocol-root-');
  cleanups.push(directory.cleanup);
  await assert.rejects(
    () => loadProtocol('repository.design', directory.root),
    (error: unknown) => error instanceof ProtocolError && error.code === 'PROTOCOL_RESOURCE_MISSING',
  );
});

test('invalid YAML frontmatter fails with PROTOCOL_METADATA_INVALID', async () => {
  const directory = await createTestDirectory('protocol-root-');
  cleanups.push(directory.cleanup);
  const path = join(directory.root, protocolRelativePath('common.authoritative-work'));
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, '---\nschemaVersion: [\n---\nBody\n', 'utf8');

  await assert.rejects(
    () => loadProtocol('common.authoritative-work', directory.root),
    (error: unknown) => error instanceof ProtocolError && error.code === 'PROTOCOL_METADATA_INVALID',
  );
});

test('frontmatter id and path mismatch fails with PROTOCOL_METADATA_INVALID', async () => {
  const directory = await createTestDirectory('protocol-root-');
  cleanups.push(directory.cleanup);
  await writeProtocolFile(
    directory.root,
    'repository.design',
    protocolText('repository.spec', 'Wrong id.\n'),
  );

  await assert.rejects(
    () => loadProtocol('repository.design', directory.root),
    (error: unknown) => error instanceof ProtocolError && error.code === 'PROTOCOL_METADATA_INVALID',
  );
});

test('repository capability metadata must match the repository protocol id', async () => {
  const directory = await createTestDirectory('protocol-root-');
  cleanups.push(directory.cleanup);
  const text = [
    '---',
    'schemaVersion: 1',
    'id: repository.design',
    'version: 1',
    'kind: repository-capability',
    'capability: spec',
    '---',
    'Wrong capability.',
    '',
  ].join('\n');
  await writeProtocolFile(directory.root, 'repository.design', text);

  await assert.rejects(
    () => loadProtocol('repository.design', directory.root),
    (error: unknown) => error instanceof ProtocolError && error.code === 'PROTOCOL_METADATA_INVALID',
  );
});

test('locator fails explicitly when no candidate contains the common protocol', async () => {
  const first = await createTestDirectory('protocol-root-a-');
  const second = await createTestDirectory('protocol-root-b-');
  cleanups.push(second.cleanup, first.cleanup);

  assert.throws(
    () => locateProtocolRoot([first.root, second.root]),
    (error: unknown) => error instanceof ProtocolError && error.code === 'PROTOCOL_PACKAGE_ROOT_NOT_FOUND',
  );
});

test('canonical inventory validation loads every closed protocol', async () => {
  const fixture = await createProtocolRoot([...PROTOCOL_IDS]);
  const documents = await validateCanonicalProtocolInventory(fixture);
  assert.deepEqual(documents.map((item) => item.id), [...PROTOCOL_IDS]);
});

async function createProtocolRoot(ids: ProtocolId[]): Promise<string> {
  const directory = await createTestDirectory('protocol-root-');
  cleanups.push(directory.cleanup);
  for (const id of ids) {
    await writeProtocolFile(directory.root, id, protocolText(id, `Body for ${id}.\n`));
  }
  return directory.root;
}

async function writeProtocolFile(root: string, id: ProtocolId, content: string): Promise<void> {
  const path = join(root, protocolRelativePath(id));
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
}

function protocolText(id: ProtocolId, body: string): string {
  if (id === 'common.authoritative-work') {
    return ['---', 'schemaVersion: 1', `id: ${id}`, 'version: 1', 'kind: common', '---', body].join('\n');
  }
  if (id.startsWith('repository.')) {
    const capability = id.slice('repository.'.length) as Capability;
    return [
      '---',
      'schemaVersion: 1',
      `id: ${id}`,
      'version: 1',
      'kind: repository-capability',
      `capability: ${capability}`,
      '---',
      body,
    ].join('\n');
  }
  if (id.startsWith('interaction.')) {
    const interaction = id.slice('interaction.'.length);
    return [
      '---',
      'schemaVersion: 1',
      `id: ${id}`,
      'version: 1',
      'kind: interaction',
      `interaction: ${interaction}`,
      '---',
      body,
    ].join('\n');
  }
  return [
    '---',
    'schemaVersion: 1',
    `id: ${id}`,
    'version: 1',
    'kind: workset-action',
    'actions:',
    `  - ${worksetActionFor(id)}`,
    '---',
    body,
  ].join('\n');
}

function worksetActionFor(id: ProtocolId): string {
  const mapping: Partial<Record<ProtocolId, string>> = {
    'workset.candidate-research': 'inspect-project',
    'workset.project-impact-decision': 'decide-project-impact',
    'workset.project-change-binding': 'bind-project-change',
    'workset.project-workflow-handoff': 'project-workflow',
    'workset.reentry-classification': 'record-reentry',
    'workset.reentry-interaction': 'reenter',
    'workset.reentry-plan': 'reenter',
    'workset.reentry-decision': 'decide-reentry',
    'workset.reentry-apply': 'apply-reentry',
    'workset.reentry-replan': 'replan-reentry',
    'workset.reentry-finalize': 'finalize-reentry',
  };
  const action = mapping[id];
  assert.ok(action, id);
  return action;
}
