import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  runAuthorityContractSchema,
  stageRunManifestSchema,
  type RunAuthorityContract,
  type StageRunManifest,
} from '../../domain/run.js';
import { runLifecycleOwnerRefSchema, sha256Schema } from '../../domain/types.js';
import { compileRunDescendants } from '../../authority/compilers/run-descendants.js';
import { assertPreparedRunIdentityV3 } from '../stages.js';

// 背景：规范明确禁止 separate compileRunAuthorityContract ABI；Task4 的 exact compiler 链是唯一
// contract 组装来源。目的：这里只验证该唯一产物进入 Run v3 schema 后的完整邻接哈希，以及 prepare
// 预像绑定 predecessor/owner 但绝不嵌入自身 entryHash。上下文：最终 VM bytes 和 receipt writer 属于 Task9E。
const timestamp = '2026-08-24T00:00:00.000Z';
const hash = (character: string) => `sha256:${character.repeat(64)}`;
const GOLDEN_TERMINAL_CANONICAL_BYTES = '{"kind":"ARTIFACT_STAGE","readinessKey":"spec","requiredOutputRoles":["SPEC"]}';
const GOLDEN_TERMINAL_HASH = 'sha256:39faec5ef34c4cda62c71635780dcd3b87b394e02f7e5d648238e2a38fc306cc';
const GOLDEN_PROTOCOL_BINDINGS_CANONICAL_BYTES = '[{"id":"common","rawBytesHash":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","relativePath":"resources/protocols/common.md","version":1},{"id":"repository.spec","rawBytesHash":"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","relativePath":"resources/protocols/repository/spec.md","version":1}]';
const GOLDEN_PROTOCOL_BINDINGS_HASH = 'sha256:dae2aa891964130d832c0f244895e3c0e4273a024a12367f3b3b0761482280ee';
const GOLDEN_RUN_AUTHORITY_HASH = 'sha256:be1adc9863b505f2fc8b6981e0d4168e442815868044ca2d603ec0d7f24aea12';
const GOLDEN_PREPARED_IDENTITY_CANONICAL_BYTES = '{"authorityContractHash":"sha256:be1adc9863b505f2fc8b6981e0d4168e442815868044ca2d603ec0d7f24aea12","prepareOwner":{"operationRequestId":"prepare-request-1","owner":{"id":"RUN-000001","kind":"STAGE_PREPARE"},"requestDigest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","sequence":7},"preparedFromAuthorityHead":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}';
const GOLDEN_PREPARED_IDENTITY_HASH = 'sha256:7a0a7b44b434c7063bf3f287d959007ef2d925d61728b996c643cdb5e9459dcf';

function sha256Literal(canonicalBytes: string): string {
  return `sha256:${createHash('sha256').update(Buffer.from(canonicalBytes, 'utf8')).digest('hex')}`;
}

// 背景：manifest schema 需要 coherent authorityContractHash 才能构造 predecessor/owner
// 单字段 mutation。目的：手写字段顺序的 byte template 只替换被测两个标量，不调用 hObject、
// assertor 或任何 production identity helper。上下文：base bytes 的固定 digest 在测试中另行锁定。
function runAuthorityCanonicalBytes(
  preparedFromAuthorityHead: string,
  operationRequestId: string,
): string {
  return '{"allowedDescendants":[],"authoredOutputBindings":[{"kind":"AUTHORED_FILE","path":"spec.md","role":"SPEC","scaffoldBinding":null}],"capability":"spec","changeId":"CHG-0001","prepareOwner":{"operationRequestId":"'
    + operationRequestId
    + '","owner":{"id":"RUN-000001","kind":"STAGE_PREPARE"},"requestDigest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","sequence":7},"preparedFromAuthorityHead":"'
    + preparedFromAuthorityHead
    + '","revision":"REV-0001","runId":"RUN-000001","schemaVersion":3,"terminal":{"kind":"ARTIFACT_STAGE","readinessKey":"spec","requiredOutputRoles":["SPEC"]},"terminalHash":"sha256:39faec5ef34c4cda62c71635780dcd3b87b394e02f7e5d648238e2a38fc306cc"}';
}

function authorityFixture(): RunAuthorityContract {
  const terminal = {
    kind: 'ARTIFACT_STAGE' as const,
    readinessKey: 'spec' as const,
    requiredOutputRoles: ['SPEC'],
  };
  const allowedDescendants = compileRunDescendants({
    runId: 'RUN-000001',
    terminal,
    evidenceRequirements: [],
    humanGates: [],
  });
  return runAuthorityContractSchema.parse({
    schemaVersion: 3,
    changeId: 'CHG-0001',
    runId: 'RUN-000001',
    capability: 'spec',
    revision: 'REV-0001',
    preparedFromAuthorityHead: hash('a'),
    prepareOwner: {
      sequence: 7,
      owner: { kind: 'STAGE_PREPARE', id: 'RUN-000001' },
      operationRequestId: 'prepare-request-1',
      requestDigest: hash('b'),
    },
    authoredOutputBindings: [{
      kind: 'AUTHORED_FILE',
      role: 'SPEC',
      path: 'spec.md',
      scaffoldBinding: null,
    }],
    allowedDescendants,
    terminal,
    terminalHash: GOLDEN_TERMINAL_HASH,
  });
}

function manifestFixture(authorityContract = authorityFixture()): StageRunManifest {
  const protocolBindings = [
    { id: 'common', version: 1, relativePath: 'resources/protocols/common.md', rawBytesHash: hash('c') },
    { id: 'repository.spec', version: 1, relativePath: 'resources/protocols/repository/spec.md', rawBytesHash: hash('d') },
  ] as const;
  return stageRunManifestSchema.parse({
    schemaVersion: 3,
    workflowVersion: '0.3.0',
    authorityCatalogHash: hash('e'),
    runId: authorityContract.runId,
    changeId: authorityContract.changeId,
    revision: authorityContract.revision,
    capability: authorityContract.capability,
    preparedAt: timestamp,
    prepareOwner: authorityContract.prepareOwner,
    prompt: {
      path: 'runs/RUN-000001/prompt.md',
      rendererId: 'prompt-render-v1',
      rendererHash: hash('f'),
      rawBytesHash: hash('1'),
      instructionHash: hash('2'),
      contextBindingsHash: hash('3'),
      protocolBindings,
      protocolBindingsHash: GOLDEN_PROTOCOL_BINDINGS_HASH,
      renderInputHash: hash('4'),
    },
    authorityContract,
    authorityContractHash: sha256Literal(runAuthorityCanonicalBytes(
      authorityContract.preparedFromAuthorityHead,
      authorityContract.prepareOwner.operationRequestId,
    )),
    disposition: 'PREPARED',
  });
}

test('Task4 descendants 产物是 RunAuthorityContract v3 的唯一闭合 projection', () => {
  const authority = authorityFixture();
  assert.deepEqual(authority.allowedDescendants, []);
  assert.equal(runAuthorityContractSchema.safeParse(authority).success, true);

  assert.equal(runAuthorityContractSchema.safeParse({
    ...authority,
    allowedDescendants: [{
      kind: 'COUNTED', ownerKind: 'EVIDENCE_GENERIC',
      binding: { kind: 'RUN_ONLY' }, minimum: 0, maximum: 1,
    }],
  }).success, false);
});

test('独立 literal golden 认证 prepare predecessor、owner 与 contract preimage', () => {
  const expectedTerminalHash = sha256Schema.parse(sha256Literal(GOLDEN_TERMINAL_CANONICAL_BYTES));
  const expectedProtocolBindingsHash = sha256Schema.parse(sha256Literal(GOLDEN_PROTOCOL_BINDINGS_CANONICAL_BYTES));
  const expectedAuthorityHash = sha256Schema.parse(sha256Literal(runAuthorityCanonicalBytes(
    hash('a'),
    'prepare-request-1',
  )));
  const expectedPreparedIdentityHash = sha256Schema.parse(sha256Literal(GOLDEN_PREPARED_IDENTITY_CANONICAL_BYTES));
  assert.equal(expectedTerminalHash, GOLDEN_TERMINAL_HASH);
  assert.equal(expectedProtocolBindingsHash, GOLDEN_PROTOCOL_BINDINGS_HASH);
  assert.equal(expectedAuthorityHash, GOLDEN_RUN_AUTHORITY_HASH);
  assert.equal(expectedPreparedIdentityHash, GOLDEN_PREPARED_IDENTITY_HASH);

  const authority = authorityFixture();
  const manifest = manifestFixture(authority);
  const acceptedIdentity = Object.freeze({
    preparedFromAuthorityHead: sha256Schema.parse(hash('a')),
    prepareOwner: runLifecycleOwnerRefSchema.parse({
      sequence: 7,
      owner: { kind: 'STAGE_PREPARE', id: 'RUN-000001' },
      operationRequestId: 'prepare-request-1',
      requestDigest: hash('b'),
    }),
    authorityContractHash: sha256Schema.parse(GOLDEN_RUN_AUTHORITY_HASH),
  });
  const changedPredecessor = {
    ...authority,
    preparedFromAuthorityHead: hash('9'),
  };
  const changedOwner = {
    ...authority,
    prepareOwner: { ...authority.prepareOwner, operationRequestId: 'prepare-request-2' },
  };

  assert.equal(authority.terminalHash, expectedTerminalHash);
  assert.equal(manifest.prompt.protocolBindingsHash, expectedProtocolBindingsHash);
  assert.equal(manifest.authorityContractHash, expectedAuthorityHash);
  assert.notEqual(sha256Literal(runAuthorityCanonicalBytes(hash('9'), 'prepare-request-1')), expectedAuthorityHash);
  assert.notEqual(sha256Literal(runAuthorityCanonicalBytes(hash('a'), 'prepare-request-2')), expectedAuthorityHash);
  assert.doesNotThrow(() => assertPreparedRunIdentityV3(manifest, acceptedIdentity));
  assert.throws(
    () => assertPreparedRunIdentityV3(manifestFixture(runAuthorityContractSchema.parse({
      ...changedPredecessor,
      terminalHash: authority.terminalHash,
    })), acceptedIdentity),
    /RUN_ACCEPTED_IDENTITY_MISMATCH/,
  );
  assert.throws(
    () => assertPreparedRunIdentityV3(manifestFixture(runAuthorityContractSchema.parse({
      ...changedOwner,
      terminalHash: authority.terminalHash,
    })), acceptedIdentity),
    /RUN_ACCEPTED_IDENTITY_MISMATCH/,
  );
  assert.throws(
    () => assertPreparedRunIdentityV3(manifest, {
      ...acceptedIdentity,
      authorityContractHash: sha256Schema.parse(hash('0')),
    }),
    /RUN_ACCEPTED_IDENTITY_MISMATCH/,
  );
  assert.equal('entryHash' in authority, false);
  assert.equal('entryHash' in authority.prepareOwner, false);
  assert.equal(runAuthorityContractSchema.safeParse({ ...authority, entryHash: hash('8') }).success, false);
  assert.equal(runAuthorityContractSchema.safeParse({
    ...authority,
    prepareOwner: { ...authority.prepareOwner, entryHash: hash('8') },
  }).success, false);
});

test('manifest 只能存 strict v3 contract，caller 不能 splice hash、owner 或旧字段', () => {
  const manifest = manifestFixture();
  assert.equal(stageRunManifestSchema.safeParse(manifest).success, true);
  assert.equal(stageRunManifestSchema.safeParse({ ...manifest, schemaVersion: 2 }).success, false);
  assert.equal(stageRunManifestSchema.safeParse({ ...manifest, authorityContractHash: hash('0') }).success, false);
  assert.equal(stageRunManifestSchema.safeParse({
    ...manifest,
    prepareOwner: { ...manifest.prepareOwner, operationRequestId: 'caller-splice' },
  }).success, false);
  assert.equal(stageRunManifestSchema.safeParse({ ...manifest, status: 'PREPARED' }).success, false);
});
