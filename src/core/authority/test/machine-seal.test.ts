import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import {
  clearInjectedAuthorityCatalogForTest,
  loadInjectedAuthorityCatalogForTest,
} from '../../../authority/catalog-loader.js';
import { hashStrictObject, stageAuthorityCatalogV1Schema } from '../../../authority/catalog-schema.js';
import { normalizedAbsoluteRealPathSchema } from '../../../domain/public.js';
import { parseChangeId, parseSha256 } from '../../../domain/scalars.js';
import { buildBaseContext } from '../context-builder.js';
import { sealForInspection } from '../context.js';
import {
  prepareCommitProjection,
  verifyCommitSeal,
  type MachineAuthorityRowV1,
} from '../machine-seal.js';

const SHA_B = `sha256:${'b'.repeat(64)}`;
const TIMESTAMP = '2026-08-27T00:00:00.000Z';

test('terminal verifier uses a second recorder and seals target while deriving untouched complement', async (t) => {
  const fixture = await machineFixture(t, 'authority-machine-seal-');
  const context = await sealForInspection(await buildBaseContext(fixture.request));
  const target = requireFileRow(context.machineProjection.rows, 'payload.txt');
  const replacement = 'replacement';
  const expected = { ...target, rawBytesHash: hashBytes(replacement) } as MachineAuthorityRowV1;
  const prepared = prepareCommitProjection(context, [{ kind: 'UPSERT', expectedFinal: expected }]);
  const preflightCounters = context.observedIo;
  await writeFile(join(fixture.root, 'payload.txt'), replacement);

  const verification = await verifyCommitSeal(context, prepared);
  assert.strictEqual(context.observedIo, preflightCounters);
  assert.equal(verification.seal.finalProjectionHash, prepared.expectedFinalProjectionHash);
  assert.ok(verification.seal.untouchedSetHash);
  assert.equal(verification.observedIo.fileOpens.get('payload.txt'), 1);
  for (const row of context.machineProjection.rows) {
    assert.equal(
      row.nodeType === 'FILE'
        ? verification.observedIo.fileOpens.get(row.relativePath)
        : verification.observedIo.directoryReads.get(row.relativePath),
      1,
      row.relativePath,
    );
  }
  await assert.rejects(verifyCommitSeal(context, prepared), /AUTHORITY_PREPARED_COMMIT_CONSUMED/);
});

test('target mode-only mismatch fails without repair and consumes prepared capability', async (t) => {
  const fixture = await machineFixture(t, 'authority-machine-mode-');
  const context = await sealForInspection(await buildBaseContext(fixture.request));
  const target = requireFileRow(context.machineProjection.rows, 'payload.txt');
  const prepared = prepareCommitProjection(context, [{ kind: 'UPSERT', expectedFinal: target }]);
  await chmod(join(fixture.root, 'payload.txt'), 0o600);

  await assert.rejects(verifyCommitSeal(context, prepared), /AUTHORITY_SEAL_MISMATCH/);
  assert.equal((await stat(join(fixture.root, 'payload.txt'))).mode & 0o7777, 0o600);
  await assert.rejects(verifyCommitSeal(context, prepared), /AUTHORITY_PREPARED_COMMIT_CONSUMED/);
});

for (const attack of ['bytes', 'missing', 'directory', 'symlink', 'fifo'] as const) {
  test(`target file ${attack} mismatch is normalized and the attack state remains`, async (t) => {
    const fixture = await machineFixture(t, `authority-machine-file-${attack}-`);
    const context = await sealForInspection(await buildBaseContext(fixture.request));
    const target = requireFileRow(context.machineProjection.rows, 'payload.txt');
    const prepared = prepareCommitProjection(context, [{ kind: 'UPSERT', expectedFinal: target }]);
    const path = join(fixture.root, 'payload.txt');

    if (attack === 'bytes') await writeFile(path, 'attacker');
    if (attack === 'missing') await rm(path);
    if (attack === 'directory') {
      await rm(path);
      await mkdir(path);
    }
    if (attack === 'symlink') {
      await rm(path);
      await symlink('change.yaml', path);
    }
    if (attack === 'fifo') {
      await rm(path);
      execFileSync('mkfifo', [path]);
    }

    await assert.rejects(verifyCommitSeal(context, prepared), /AUTHORITY_SEAL_MISMATCH/);
    if (attack === 'bytes') assert.equal(await readFile(path, 'utf8'), 'attacker');
    if (attack === 'missing') await assert.rejects(lstat(path), /ENOENT/);
    if (attack === 'directory') assert.equal((await lstat(path)).isDirectory(), true);
    if (attack === 'symlink') assert.equal((await lstat(path)).isSymbolicLink(), true);
    if (attack === 'fifo') assert.equal((await lstat(path)).isFIFO(), true);
  });
}

test('untouched byte drift is distinguished and never repaired', async (t) => {
  const fixture = await machineFixture(t, 'authority-machine-untouched-');
  const context = await sealForInspection(await buildBaseContext(fixture.request));
  const target = requireFileRow(context.machineProjection.rows, 'payload.txt');
  const prepared = prepareCommitProjection(context, [{ kind: 'UPSERT', expectedFinal: target }]);
  await writeFile(join(fixture.root, 'change.yaml'), 'attacker');

  await assert.rejects(verifyCommitSeal(context, prepared), /AUTHORITY_TARGET_DRIFT/);
  assert.equal(await readFile(join(fixture.root, 'change.yaml'), 'utf8'), 'attacker');
});

test('directory typed inventory detects same-name node replacement', async (t) => {
  const fixture = await machineFixture(t, 'authority-machine-directory-');
  const context = await sealForInspection(await buildBaseContext(fixture.request));
  const directory = requireDirectoryRow(context.machineProjection.rows, 'owned');
  const prepared = prepareCommitProjection(context, [{ kind: 'UPSERT', expectedFinal: directory }]);
  await rm(join(fixture.root, 'owned', 'same-name'));
  await mkdir(join(fixture.root, 'owned', 'same-name'));

  await assert.rejects(verifyCommitSeal(context, prepared), /AUTHORITY_SEAL_MISMATCH/);
  const after = await stat(join(fixture.root, 'owned', 'same-name'));
  assert.equal(after.isDirectory(), true);
});

test('terminal directory seal distinguishes a from a leading-U+FEFF name after rename', async (t) => {
  // 回归说明：目录 entry decode 若吞掉 U+FEFF，rename 后 typed inventory 会被错误视为未变化。
  const fixture = await machineFixture(t, 'authority-machine-directory-feff-');
  await mkdir(join(fixture.root, 'bom-owned'));
  await writeFile(join(fixture.root, 'bom-owned', '\uFEFFa'), 'payload');
  const request = {
    ...fixture.request,
    logicalTargets: [
      ...fixture.request.logicalTargets,
      {
        key: { kind: 'TRANSACTION' as const, transactionId: 'bom-owned' },
        relativePath: 'bom-owned',
        nodeType: 'DIRECTORY' as const,
      },
    ],
  };
  const context = await sealForInspection(await buildBaseContext(request));
  const directory = requireDirectoryRow(context.machineProjection.rows, 'bom-owned');
  const prepared = prepareCommitProjection(context, [{ kind: 'UPSERT', expectedFinal: directory }]);
  await rename(join(fixture.root, 'bom-owned', '\uFEFFa'), join(fixture.root, 'bom-owned', 'a'));

  await assert.rejects(verifyCommitSeal(context, prepared), /AUTHORITY_SEAL_MISMATCH/);
});

for (const attack of ['add', 'remove', 'rename', 'mode'] as const) {
  test(`target directory ${attack} drift is rejected without changing the attack state`, async (t) => {
    const fixture = await machineFixture(t, `authority-machine-directory-${attack}-`);
    const context = await sealForInspection(await buildBaseContext(fixture.request));
    const directory = requireDirectoryRow(context.machineProjection.rows, 'owned');
    const prepared = prepareCommitProjection(context, [{ kind: 'UPSERT', expectedFinal: directory }]);
    const child = join(fixture.root, 'owned', 'same-name');

    if (attack === 'add') await writeFile(join(fixture.root, 'owned', 'added'), 'added');
    if (attack === 'remove') await rm(child);
    if (attack === 'rename') await rename(child, join(fixture.root, 'owned', 'renamed'));
    if (attack === 'mode') await chmod(join(fixture.root, 'owned'), 0o700);

    await assert.rejects(verifyCommitSeal(context, prepared), /AUTHORITY_SEAL_MISMATCH/);
    if (attack === 'add') assert.equal(await readFile(join(fixture.root, 'owned', 'added'), 'utf8'), 'added');
    if (attack === 'remove') await assert.rejects(lstat(child), /ENOENT/);
    if (attack === 'rename') assert.equal((await lstat(join(fixture.root, 'owned', 'renamed'))).isFile(), true);
    if (attack === 'mode') assert.equal((await stat(join(fixture.root, 'owned'))).mode & 0o7777, 0o700);
  });
}

for (const attack of ['file-mode', 'directory-entry', 'directory-mode'] as const) {
  test(`untouched ${attack} drift is distinguished from a target mismatch`, async (t) => {
    const fixture = await machineFixture(t, `authority-machine-untouched-${attack}-`);
    const context = await sealForInspection(await buildBaseContext(fixture.request));
    const target = requireFileRow(context.machineProjection.rows, 'payload.txt');
    const prepared = prepareCommitProjection(context, [{ kind: 'UPSERT', expectedFinal: target }]);
    if (attack === 'file-mode') await chmod(join(fixture.root, 'change.yaml'), 0o600);
    if (attack === 'directory-entry') await writeFile(join(fixture.root, 'owned', 'added'), 'added');
    if (attack === 'directory-mode') await chmod(join(fixture.root, 'owned'), 0o700);
    await assert.rejects(verifyCommitSeal(context, prepared), /AUTHORITY_TARGET_DRIFT/);
  });
}

test('adding or removing a child requires its exact-owned parent directory target before I/O', async (t) => {
  const fixture = await machineFixture(t, 'authority-machine-parent-');
  const context = await sealForInspection(await buildBaseContext(fixture.request));
  const child = requireFileRow(context.machineProjection.rows, 'owned/same-name');
  assert.throws(
    () => prepareCommitProjection(context, [{ kind: 'REMOVE', relativePath: child.relativePath }]),
    /AUTHORITY_MACHINE_PARENT_TARGET_REQUIRED/,
  );
  assert.throws(
    () => prepareCommitProjection(context, [{
      kind: 'UPSERT',
      expectedFinal: {
        relativePath: 'owned/new-child',
        nodeType: 'FILE',
        mode: 0o644,
        rawBytesHash: child.rawBytesHash,
      },
    }]),
    /AUTHORITY_MACHINE_PARENT_TARGET_REQUIRED/,
  );
});

test('child add with the exact parent target seals parent and child once', async (t) => {
  const fixture = await machineFixture(t, 'authority-machine-parent-add-');
  const context = await sealForInspection(await buildBaseContext(fixture.request));
  const parent = requireDirectoryRow(context.machineProjection.rows, 'owned');
  const expectedParent: MachineAuthorityRowV1 = {
    ...parent,
    inventoryHash: hashDirectoryInventory([
      ['new-child', 'FILE'],
      ['same-name', 'FILE'],
    ]),
  };
  const expectedChild: MachineAuthorityRowV1 = {
    relativePath: 'owned/new-child',
    nodeType: 'FILE',
    mode: 0o644,
    rawBytesHash: hashBytes('new child'),
  };
  const prepared = prepareCommitProjection(context, [
    { kind: 'UPSERT', expectedFinal: expectedChild },
    { kind: 'UPSERT', expectedFinal: expectedParent },
  ]);
  await writeFile(join(fixture.root, 'owned', 'new-child'), 'new child');

  const verification = await verifyCommitSeal(context, prepared);
  assert.equal(verification.observedIo.directoryReads.get('owned'), 1);
  assert.equal(verification.observedIo.fileOpens.get('owned/new-child'), 1);
  assert.equal(verification.observedIo.fileOpens.get('owned/same-name'), 1);
});

test('child remove with the exact parent target seals absence through one parent read', async (t) => {
  const fixture = await machineFixture(t, 'authority-machine-parent-remove-');
  const context = await sealForInspection(await buildBaseContext(fixture.request));
  const parent = requireDirectoryRow(context.machineProjection.rows, 'owned');
  const expectedParent: MachineAuthorityRowV1 = {
    ...parent,
    inventoryHash: hashDirectoryInventory([]),
  };
  const prepared = prepareCommitProjection(context, [
    { kind: 'REMOVE', relativePath: 'owned/same-name' },
    { kind: 'UPSERT', expectedFinal: expectedParent },
  ]);
  await rm(join(fixture.root, 'owned', 'same-name'));

  const verification = await verifyCommitSeal(context, prepared);
  assert.equal(verification.observedIo.directoryReads.get('owned'), 1);
  assert.equal(verification.observedIo.fileOpens.get('owned/same-name'), undefined);
});

test('child node-type change with the exact parent target seals parent and child once', async (t) => {
  const fixture = await machineFixture(t, 'authority-machine-parent-type-');
  const context = await sealForInspection(await buildBaseContext(fixture.request));
  const parent = requireDirectoryRow(context.machineProjection.rows, 'owned');
  const expectedParent: MachineAuthorityRowV1 = {
    ...parent,
    inventoryHash: hashDirectoryInventory([['same-name', 'DIRECTORY']]),
  };
  const expectedChild: MachineAuthorityRowV1 = {
    relativePath: 'owned/same-name',
    nodeType: 'DIRECTORY',
    mode: 0o755,
    inventoryHash: hashDirectoryInventory([]),
  };
  const prepared = prepareCommitProjection(context, [
    { kind: 'UPSERT', expectedFinal: expectedParent },
    { kind: 'UPSERT', expectedFinal: expectedChild },
  ]);
  await rm(join(fixture.root, 'owned', 'same-name'));
  await mkdir(join(fixture.root, 'owned', 'same-name'));

  const verification = await verifyCommitSeal(context, prepared);
  assert.equal(verification.observedIo.directoryReads.get('owned'), 1);
  assert.equal(verification.observedIo.directoryReads.get('owned/same-name'), 1);
});

test('target set hash is canonical across caller mutation order', async (t) => {
  const fixture = await machineFixture(t, 'authority-machine-target-order-');
  const context = await sealForInspection(await buildBaseContext(fixture.request));
  const change = requireFileRow(context.machineProjection.rows, 'change.yaml');
  const payload = requireFileRow(context.machineProjection.rows, 'payload.txt');
  const forward = prepareCommitProjection(context, [
    { kind: 'UPSERT', expectedFinal: change },
    { kind: 'UPSERT', expectedFinal: payload },
  ]);
  const reverse = prepareCommitProjection(context, [
    { kind: 'UPSERT', expectedFinal: payload },
    { kind: 'UPSERT', expectedFinal: change },
  ]);

  const first = await verifyCommitSeal(context, forward);
  const second = await verifyCommitSeal(context, reverse);
  assert.equal(first.seal.targetSetHash, second.seal.targetSetHash);
});

test('prepared state does not expose private arrays to a replaced Object.freeze', { concurrency: false }, async (t) => {
  // 回归说明：prepare 若实时查找 freeze，hook 可取得 targetPaths/untouchedRows 并改写 terminal read set。
  const fixture = await machineFixture(t, 'authority-machine-freeze-');
  const context = await sealForInspection(await buildBaseContext(fixture.request));
  const target = requireFileRow(context.machineProjection.rows, 'payload.txt');
  const descriptor = Object.getOwnPropertyDescriptor(Object, 'freeze');
  assert.ok(descriptor);
  const intercepted: unknown[] = [];
  let prepared;
  try {
    Object.defineProperty(Object, 'freeze', {
      ...descriptor,
      value(value: unknown) {
        intercepted.push(value);
        return value;
      },
    });
    prepared = prepareCommitProjection(context, [{ kind: 'UPSERT', expectedFinal: target }]);
  } finally {
    Object.defineProperty(Object, 'freeze', descriptor);
  }
  assert.equal(intercepted.length, 0);
  assert.equal(Object.isFrozen(prepared), true);
  const verification = await verifyCommitSeal(context, prepared);
  assert.equal(verification.observedIo.fileOpens.get('payload.txt'), 1);
});

test('prepared capability is bound to exact context identity and cannot be cloned or forged', async (t) => {
  const first = await machineFixture(t, 'authority-machine-capability-a-');
  const second = await machineFixture(t, 'authority-machine-capability-b-');
  const context = await sealForInspection(await buildBaseContext(first.request));
  const otherContext = await sealForInspection(await buildBaseContext(second.request));
  const target = requireFileRow(context.machineProjection.rows, 'payload.txt');
  let traps = 0;
  const proxyMutations = new Proxy([{ kind: 'UPSERT' as const, expectedFinal: target }], {
    get(targetValue, key, receiver) {
      traps += 1;
      return Reflect.get(targetValue, key, receiver);
    },
    getOwnPropertyDescriptor(targetValue, key) {
      traps += 1;
      return Reflect.getOwnPropertyDescriptor(targetValue, key);
    },
  });
  assert.throws(
    () => prepareCommitProjection(context, proxyMutations),
    /AUTHORITY_MACHINE_REQUEST_INVALID/,
  );
  assert.equal(traps, 0);
  assert.throws(
    () => prepareCommitProjection(context, [
      { kind: 'UPSERT', expectedFinal: target },
      { kind: 'UPSERT', expectedFinal: target },
    ]),
    /AUTHORITY_MACHINE_TARGET_DUPLICATE/,
  );
  const prepared = prepareCommitProjection(context, [{ kind: 'UPSERT', expectedFinal: target }]);

  await assert.rejects(
    verifyCommitSeal(context, { ...prepared }),
    /AUTHORITY_PREPARED_COMMIT_INVALID/,
  );
  await assert.rejects(
    verifyCommitSeal(context, Object.freeze({
      schemaVersion: 1,
      kind: 'PREPARED_COMMIT_PROJECTION_V1',
      expectedFinalProjectionHash: prepared.expectedFinalProjectionHash,
    })),
    /AUTHORITY_PREPARED_COMMIT_INVALID/,
  );
  await assert.rejects(
    verifyCommitSeal(otherContext, prepared),
    /AUTHORITY_PREPARED_COMMIT_INVALID/,
  );
  const contextCounters = context.observedIo;
  const otherCounters = otherContext.observedIo;
  await assert.rejects(
    verifyCommitSeal(context, prepared),
    /AUTHORITY_PREPARED_COMMIT_CONSUMED/,
  );
  assert.strictEqual(context.observedIo, contextCounters);
  assert.strictEqual(otherContext.observedIo, otherCounters);
});

test('preflight rejects a wrong machine mode and a non-regular exact directory child', async (t) => {
  const wrongMode = await machineFixture(t, 'authority-machine-preflight-mode-');
  await chmod(join(wrongMode.root, 'payload.txt'), 0o600);
  await assert.rejects(buildBaseContext(wrongMode.request), /AUTHORITY_MACHINE_MODE_MISMATCH/);

  const unsafeChild = await machineFixture(t, 'authority-machine-preflight-child-');
  await rm(join(unsafeChild.root, 'owned', 'same-name'));
  await symlink('../change.yaml', join(unsafeChild.root, 'owned', 'same-name'));
  await assert.rejects(buildBaseContext(unsafeChild.request), /AUTHORITY_INVENTORY_DIRECTORY_MISMATCH|AUTHORITY_MACHINE_DIRECTORY_NODE_TYPE/);
});

test('machine-seal production source has no repair primitive', async () => {
  const source = await readFile(join(process.cwd(), 'src/core/authority/machine-seal.ts'), 'utf8');
  assert.doesNotMatch(source, /\b(?:chmod|writeFile|rename|unlink|mkdir)\b/u);
});

async function machineFixture(t: test.TestContext, prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rawCatalog = await readFile(join(
    process.cwd(), 'src', 'authority', 'test', 'fixtures', 'stage-authority-catalog-v1.yaml',
  ), 'utf8');
  const catalog = stageAuthorityCatalogV1Schema.parse(YAML.parse(rawCatalog));
  const lease = await loadInjectedAuthorityCatalogForTest(catalog);
  t.after(() => clearInjectedAuthorityCatalogForTest(lease));

  await mkdir(join(root, 'owned'));
  await writeFile(join(root, 'owned', 'same-name'), 'child');
  await writeFile(join(root, 'payload.txt'), 'payload');
  await writeFile(join(root, 'change.yaml'), YAML.stringify(changeMetadata()));
  await writeFile(join(root, 'workflow.lock.yaml'), YAML.stringify({
    schemaVersion: 2,
    workflowVersion: '0.3.0',
    authorityCatalogId: 'omnai.stage-authority.v1',
    authorityCatalogSchemaVersion: 1,
    authorityCatalogHash: hashStrictObject(catalog),
    resourceBundleHash: SHA_B,
  }));

  return {
    root,
    request: {
      expectedChangeId: parseChangeId('CHG-0001'),
      containedRoot: normalizedAbsoluteRealPathSchema.parse(root),
      logicalTargets: [
        { key: { kind: 'METADATA' as const }, relativePath: 'change.yaml', nodeType: 'FILE' as const },
        { key: { kind: 'TRANSACTION' as const, transactionId: 'payload' }, relativePath: 'payload.txt', nodeType: 'FILE' as const },
        { key: { kind: 'TRANSACTION' as const, transactionId: 'owned' }, relativePath: 'owned', nodeType: 'DIRECTORY' as const },
        { key: { kind: 'TRANSACTION' as const, transactionId: 'child' }, relativePath: 'owned/same-name', nodeType: 'FILE' as const },
      ],
      archiveTargets: [],
      knownAuxiliaryTargets: [],
    },
  };
}

function requireFileRow(rows: readonly MachineAuthorityRowV1[], relativePath: string) {
  const row = rows.find((candidate) => candidate.relativePath === relativePath);
  assert.ok(row?.nodeType === 'FILE');
  return row;
}

function requireDirectoryRow(rows: readonly MachineAuthorityRowV1[], relativePath: string) {
  const row = rows.find((candidate) => candidate.relativePath === relativePath);
  assert.ok(row?.nodeType === 'DIRECTORY');
  return row;
}

function hashBytes(value: string) {
  return parseSha256(`sha256:${createHash('sha256').update(value).digest('hex')}`);
}

function hashDirectoryInventory(
  entries: readonly (readonly [string, 'FILE' | 'DIRECTORY'])[],
) {
  const hash = createHash('sha256');
  const ordered = [...entries].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  for (const [name, nodeType] of ordered) {
    const bytes = Buffer.from(name, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.byteLength);
    hash.update(length);
    hash.update(bytes);
    hash.update(Buffer.from([nodeType === 'FILE' ? 1 : 2]));
  }
  return parseSha256(`sha256:${hash.digest('hex')}`);
}

function changeMetadata(): Record<string, unknown> {
  return {
    schemaVersion: 2, id: 'CHG-0001', slug: 'machine-seal', title: 'Machine Seal',
    scenario: 'small-feature', workMode: 'FEATURE', status: 'IN_PROGRESS',
    activeRevision: 'REV-0001', baseline: 'BL-0001', artifactVersions: {},
    risk: { level: 'P2', dimensions: { businessCriticality: 'MEDIUM', data: 'LOW', compatibility: 'LOW', reversibility: 'MEDIUM', security: 'LOW', operational: 'LOW' } },
    impact: { frontend: false, backend: true, apiContract: false, database: false, mq: false, remoteService: false, security: false, observability: false },
    createdAt: TIMESTAMP, updatedAt: TIMESTAMP,
    readiness: {
      frame: 'READY', map: 'NOT_APPLICABLE', research: 'READY', mitigation: 'NOT_APPLICABLE', triage: 'NOT_APPLICABLE', reproduction: 'NOT_APPLICABLE', diagnosis: 'NOT_APPLICABLE', domain: 'READY', spec: 'READY', design: 'READY', experiment: 'NOT_APPLICABLE', fix: 'NOT_APPLICABLE', plan: 'READY', implementation: 'IN_PROGRESS', review: 'MISSING', simplification: 'MISSING', verification: 'MISSING', qa: 'MISSING', release: 'MISSING', canary: 'MISSING', learning: 'MISSING',
    },
  };
}
