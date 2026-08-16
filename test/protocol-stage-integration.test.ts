import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import YAML from 'yaml';
import { pathExists, readText } from '../src/core/files.js';
import { changeArtifactPath, changeRunsRoot } from '../src/core/paths.js';
import { prepareStage, type PreparedStage } from '../src/core/stages.js';
import { createChange, resolveChange, type ChangeRef } from '../src/core/store.js';
import { createTestDirectory, createTestRepository } from './helpers.js';

interface AuditedManifest {
  schemaVersion: number;
  promptHash: string;
  protocols: Array<{ id: string; version: number; hash: string }>;
}

interface TestPrepareStageOptions {
  protocolRoot?: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

test('prepared repository runs use canonical protocols and record exact audit hashes', async () => {
  const fixture = await createTestRepository('protocol-stage-audit');
  cleanups.push(fixture.cleanup);
  const created = await createChange(fixture.root, 'Compare authorization designs', 'small-feature');
  const change = await resolveChange(fixture.root, created.metadata.id);

  const prepared = await prepareStage(
    fixture.root,
    change,
    'design',
    'Compare options.',
  );
  const prompt = await readText(prepared.promptPath);
  const manifest = prepared.manifest as unknown as AuditedManifest;
  const writtenManifest = YAML.parse(
    await readText(join(prepared.runDirectory, 'run.yaml')),
  ) as AuditedManifest;

  assert.match(prompt, /protocol:common\.authoritative-work@1/);
  assert.match(prompt, /protocol:repository\.design@1/);
  assert.match(prompt, /Explore 2-3 viable approaches/);
  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(manifest.protocols.map((item) => item.id), [
    'common.authoritative-work',
    'repository.design',
  ]);
  assert.equal(manifest.promptHash, sha256(prompt));
  assert.deepEqual(writtenManifest, prepared.manifest);
});

test('protocol preflight failure leaves runs, progress, and readiness unchanged', async () => {
  const fixture = await createTestRepository('protocol-stage-preflight');
  const protocolFixture = await createTestDirectory('protocol-stage-root-');
  cleanups.push(protocolFixture.cleanup, fixture.cleanup);
  const created = await createChange(fixture.root, 'Compare authorization designs', 'small-feature');
  const change = await resolveChange(fixture.root, created.metadata.id);
  await writeCommonProtocol(protocolFixture.root);

  const runsRoot = changeRunsRoot(fixture.root, change.directoryName);
  const progressPath = changeArtifactPath(fixture.root, change.directoryName, 'progress.jsonl');
  const metadataPath = changeArtifactPath(fixture.root, change.directoryName, 'change.yaml');
  const before = {
    runs: await readdir(runsRoot),
    progress: await readText(progressPath),
    readiness: change.metadata.readiness.design,
    metadata: await readText(metadataPath),
  };

  const invoke = prepareStage as unknown as (
    repoRoot: string,
    change: ChangeRef,
    capability: 'design',
    instruction: string,
    options: TestPrepareStageOptions,
  ) => Promise<PreparedStage>;

  await assert.rejects(
    () => invoke(
      fixture.root,
      change,
      'design',
      'Compare options.',
      { protocolRoot: protocolFixture.root },
    ),
    /PROTOCOL_RESOURCE_MISSING/,
  );

  const reloaded = await resolveChange(fixture.root, created.metadata.id);
  assert.deepEqual(await readdir(runsRoot), before.runs);
  assert.equal(await readText(progressPath), before.progress);
  assert.equal(reloaded.metadata.readiness.design, before.readiness);
  assert.equal(await readText(metadataPath), before.metadata);
  assert.equal(await pathExists(join(runsRoot, 'prompt.md')), false);
});

async function writeCommonProtocol(root: string): Promise<void> {
  const path = join(root, 'common', 'authoritative-work.md');
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, [
    '---',
    'schemaVersion: 1',
    'id: common.authoritative-work',
    'version: 1',
    'kind: common',
    '---',
    '',
    '# Test common protocol',
    '',
    'Read-only test content.',
    '',
  ].join('\n'), 'utf8');
}

function sha256(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}
