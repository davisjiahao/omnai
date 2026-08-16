import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createTestRepository } from './helpers.js';
import { createChange, resolveChange } from '../src/core/store.js';
import { completeStage, prepareStage } from '../src/core/stages.js';
import { readText, writeTextAtomic } from '../src/core/files.js';
import { changeArtifactPath } from '../src/core/paths.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

test('prepares a bounded prompt with authoritative artifact context', async () => {
  const fixture = await createTestRepository();
  cleanups.push(fixture.cleanup);
  const created = await createChange(fixture.root, 'Add customer lookup', 'small-feature');
  const change = await resolveChange(fixture.root, created.metadata.id);
  const prepared = await prepareStage(fixture.root, change, 'spec', 'Specify lookup by customer ID');
  const prompt = await readText(prepared.promptPath);

  assert.match(prompt, /Capability: spec/);
  assert.match(prompt, /SOURCE: \.omnai\/changes/);
  assert.match(prompt, /Added Requirements/);
  assert.equal(change.metadata.readiness.spec, 'IN_PROGRESS');
});

test('marks an authored canonical artifact ready after completion validation', async () => {
  const fixture = await createTestRepository();
  cleanups.push(fixture.cleanup);
  const created = await createChange(fixture.root, 'Add customer lookup', 'small-feature');
  const change = await resolveChange(fixture.root, created.metadata.id);
  await writeTextAtomic(
    changeArtifactPath(fixture.root, change.directoryName, 'spec.md'),
    '# Change Specification\n\n## Added Requirements\n\n- AC-001: lookup by customer ID returns the matching customer.\n\n## Non-goals\n\n- No fuzzy search.\n',
  );
  await completeStage(fixture.root, change, 'spec');
  assert.equal(change.metadata.readiness.spec, 'READY');
});
