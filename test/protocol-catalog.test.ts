import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import YAML from 'yaml';
import {
  clearInjectedAuthorityCatalogForTest,
  loadInjectedAuthorityCatalogForTest,
  requireVerifiedAuthorityCatalog,
} from '../src/authority/catalog-loader.js';
import { CAPABILITIES } from '../src/domain/types.js';
import {
  ProtocolError,
  getProtocolManifest,
  listProtocolIds,
  loadProtocol,
  loadProtocolBundle,
  parseProtocolId,
  protocolRelativePath,
  repositoryProtocolId,
  validateCanonicalProtocolInventory,
} from '../src/protocols/index.js';

let catalogLease: Awaited<ReturnType<typeof loadInjectedAuthorityCatalogForTest>> | undefined;

beforeEach(async () => {
  const text = await readFile(join(process.cwd(), 'src', 'authority', 'test', 'fixtures', 'stage-authority-catalog-v1.yaml'), 'utf8');
  catalogLease = await loadInjectedAuthorityCatalogForTest(YAML.parse(text));
});

afterEach(() => {
  if (catalogLease !== undefined) clearInjectedAuthorityCatalogForTest(catalogLease);
  catalogLease = undefined;
});

test('verified manifest is the sole closed protocol inventory', async () => {
  const ids = await listProtocolIds();
  const expectedIds = [
    'common.authoritative-work',
    ...CAPABILITIES.map((capability) => `repository.${capability}`),
    'interaction.brainstorm', 'interaction.grill', 'interaction.show-me',
    'workset.candidate-research', 'workset.project-change-binding',
    'workset.project-impact-decision', 'workset.project-workflow-handoff',
    'workset.reentry-apply', 'workset.reentry-classification',
    'workset.reentry-decision', 'workset.reentry-interaction',
    'workset.reentry-plan', 'workset.reentry-replan',
  ].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  assert.equal(ids.length, 38);
  assert.deepEqual(ids, expectedIds);
  assert.equal(ids.includes('repository.release' as never), false);
  assert.equal(ids.includes('repository.ship' as never), true);
  assert.equal(ids.includes('workset.reentry-finalize' as never), false);
  assert.equal(ids.some((id) => id.startsWith('execution.')), false);
  assert.deepEqual(
    ids.filter((id) => id.startsWith('repository.')),
    await Promise.all([...CAPABILITIES].sort((left, right) => left < right ? -1 : left > right ? 1 : 0).map(repositoryProtocolId)),
  );
});

test('protocol id and resource path are pure projections of the verified manifest', async () => {
  assert.equal(await protocolRelativePath('repository.design'), 'repository/design.md');
  assert.equal(await protocolRelativePath('interaction.grill'), 'interaction/grill.md');
  assert.equal(await protocolRelativePath('workset.reentry-replan'), 'workset/reentry-replan.md');
  assert.equal(await repositoryProtocolId('ship'), 'repository.ship');
  const manifest = await getProtocolManifest('workset.reentry-plan');
  assert.equal(manifest.kind, 'workset-action');
  if (manifest.kind === 'workset-action') assert.deepEqual(manifest.actions, ['reenter']);
});

test('unknown and removed protocol identities fail closed', async () => {
  for (const id of ['../../secrets', 'repository.release', 'workset.reentry-finalize']) {
    await assert.rejects(
      () => parseProtocolId(id),
      (error: unknown) => error instanceof ProtocolError && error.code === 'PROTOCOL_UNKNOWN',
      id,
    );
  }
});

test('loader binds exact frontmatter and raw bytes to each verified manifest', async () => {
  const design = await loadProtocol('repository.design');
  assert.equal(design.id, 'repository.design');
  assert.equal(design.kind, 'repository-capability');
  assert.match(design.hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(design.hash, (await getProtocolManifest('repository.design')).rawBytesHash);

  const inventory = await validateCanonicalProtocolInventory();
  assert.deepEqual(inventory.map((document) => document.id), await listProtocolIds());
});

test('loader 先对 exact raw bytes 校验哈希，hash mismatch 优先于 UTF-8/YAML 错误', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnai-protocol-hash-first-'));
  try {
    await mkdir(join(root, 'repository'), { recursive: true });
    await writeFile(join(root, 'repository', 'design.md'), Buffer.from([0xff, 0x2d, 0x2d, 0x2d, 0x0a]));
    await assert.rejects(
      () => loadProtocol('repository.design', root),
      (error: unknown) => error instanceof ProtocolError && error.code === 'PROTOCOL_HASH_MISMATCH',
    );

    await writeFile(join(root, 'repository', 'design.md'), '---\nid: [\n---\n');
    await assert.rejects(
      () => loadProtocol('repository.design', root),
      (error: unknown) => error instanceof ProtocolError && error.code === 'PROTOCOL_HASH_MISMATCH',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loader 在 raw hash 命中后使用 fatal UTF-8 decoder 拒绝无效字节', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnai-protocol-fatal-utf8-'));
  try {
    const rawBytes = Buffer.concat([
      Buffer.from('---\nschemaVersion: 1\nid: repository.design\nversion: 3\nkind: repository-capability\ncapability: design\n---\n'),
      Buffer.from([0xc3, 0x28]),
    ]);
    const expectedHash = `sha256:${createHash('sha256').update(rawBytes).digest('hex')}`;
    const catalog = JSON.parse(JSON.stringify(await requireVerifiedAuthorityCatalog())) as Record<string, unknown>;
    const manifests = catalog.protocolManifests as Array<Record<string, unknown>>;
    manifests.find((manifest) => manifest.id === 'repository.design')!.rawBytesHash = expectedHash;

    if (catalogLease !== undefined) clearInjectedAuthorityCatalogForTest(catalogLease);
    catalogLease = await loadInjectedAuthorityCatalogForTest(catalog);
    await mkdir(join(root, 'repository'), { recursive: true });
    await writeFile(join(root, 'repository', 'design.md'), rawBytes);
    await assert.rejects(
      () => loadProtocol('repository.design', root),
      (error: unknown) => error instanceof ProtocolError && error.code === 'PROTOCOL_METADATA_INVALID',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bundle prepends common once and preserves requested route order', async () => {
  const bundle = await loadProtocolBundle([
    await repositoryProtocolId('model'),
    await repositoryProtocolId('design'),
    await repositoryProtocolId('model'),
  ]);
  assert.deepEqual(bundle.protocols.map((document) => document.id), [
    'common.authoritative-work', 'repository.model', 'repository.design',
  ]);
  assert.match(bundle.rendered, /^<!-- protocol:common\.authoritative-work@1 -->/);
});
