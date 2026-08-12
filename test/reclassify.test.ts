import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { createChange } from '../src/core/store.js';
import { reclassifyChange } from '../src/core/reclassify.js';
import { pathExists } from '../src/core/files.js';
import { createTestRepository } from './helpers.js';

test('reclassifying a Change is an L4 revision that materializes new gates and never weakens risk', async () => {
  const fixture = await createTestRepository();
  try {
    const change = await createChange(fixture.root, 'Move authorization ownership', 'small-feature');
    assert.equal(change.metadata.risk.level, 'P3');
    assert.equal(change.metadata.activeRevision, 'REV-0001');

    const first = await reclassifyChange(fixture.root, change, 'migration-program', 'Scope expanded into a multi-phase migration');
    assert.equal(first.change.metadata.scenario, 'migration-program');
    assert.equal(first.change.metadata.risk.level, 'P0');
    assert.equal(first.change.metadata.activeRevision, 'REV-0002');
    assert.equal(first.change.metadata.baseline, 'BL-0002');
    assert.equal(first.change.metadata.readiness.map, 'MISSING');
    assert.equal(first.reconcile.revision.level, 'L4');
    assert.equal(await pathExists(join(fixture.root, '.omnai/changes', change.directoryName, 'delivery.md')), true);

    const second = await reclassifyChange(fixture.root, change, 'small-feature', 'Program was narrowed after architecture review');
    assert.equal(second.change.metadata.scenario, 'small-feature');
    assert.equal(second.change.metadata.risk.level, 'P0', 'automatic reclassification must never downgrade established risk');
    assert.equal(second.change.metadata.activeRevision, 'REV-0003');
    assert.equal(second.change.metadata.baseline, 'BL-0003');
  } finally {
    await fixture.cleanup();
  }
});

test('implementation Changes cannot be reclassified into read-only investigation profiles', async () => {
  const fixture = await createTestRepository();
  try {
    const change = await createChange(fixture.root, 'Customer lookup', 'small-feature');
    await assert.rejects(
      () => reclassifyChange(fixture.root, change, 'system-query', 'This is only a question'),
      /read-only investigation/i,
    );
  } finally {
    await fixture.cleanup();
  }
});
