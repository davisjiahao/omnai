import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { pathExists } from '../src/core/files.js';
import { createChange } from '../src/core/store.js';
import { createTestRepository } from './helpers.js';

test('applies scenario risk and impact defaults when creating a change', async () => {
  const fixture = await createTestRepository();
  try {
    const change = await createChange(fixture.root, 'Move quote contract', 'cross-service-change');
    assert.equal(change.metadata.risk.level, 'P1');
    assert.equal(change.metadata.risk.dimensions.compatibility, 'HIGH');
    assert.equal(change.metadata.impact.backend, true);
    assert.equal(change.metadata.impact.apiContract, true);
    assert.equal(change.metadata.impact.remoteService, true);
  } finally {
    await fixture.cleanup();
  }
});

test('creates contract artifact only for contract-impacting scenarios', async () => {
  const fixture = await createTestRepository();
  try {
    const contractChange = await createChange(fixture.root, 'Change public event', 'cross-service-change');
    const contractPath = join(fixture.root, '.omnai', 'changes', contractChange.directoryName, 'contract.md');
    assert.equal(await pathExists(contractPath), true);

    const smallChange = await createChange(fixture.root, 'Rename local label', 'small-feature');
    const smallContractPath = join(fixture.root, '.omnai', 'changes', smallChange.directoryName, 'contract.md');
    assert.equal(await pathExists(smallContractPath), false);
  } finally {
    await fixture.cleanup();
  }
});
