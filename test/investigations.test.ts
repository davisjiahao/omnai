import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { createInvestigation, promoteInvestigation } from '../src/core/investigations.js';
import { listChanges } from '../src/core/store.js';
import { pathExists } from '../src/core/files.js';
import { createTestRepository } from './helpers.js';

test('read-only investigations do not create a change', async () => {
  const fixture = await createTestRepository();
  try {
    const investigation = await createInvestigation(fixture.root, 'field-lineage', 'Trace premiumAmount');
    assert.match(investigation.id, /^INV-\d{4}$/);
    assert.equal((await listChanges(fixture.root)).length, 0);
    assert.equal(await pathExists(join(investigation.directory, 'investigation.yaml')), true);
    assert.equal(await pathExists(join(investigation.directory, 'research.md')), true);
  } finally {
    await fixture.cleanup();
  }
});

test('an investigation is promoted to a change only on explicit request', async () => {
  const fixture = await createTestRepository();
  try {
    const investigation = await createInvestigation(fixture.root, 'business-flow', 'Trace quote purchase flow');
    const change = await promoteInvestigation(fixture.root, investigation.id, 'Change quote purchase flow', 'complex-domain-feature');
    assert.equal(change.metadata.scenario, 'complex-domain-feature');
    assert.equal((await listChanges(fixture.root)).length, 1);
  } finally {
    await fixture.cleanup();
  }
});
