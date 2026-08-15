import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathExists } from '../src/core/files.js';
import { listScenarios } from '../src/core/scenarios.js';

const REQUIRED_SKILLS = [
  'omnai',
  'omnai-brainstorm',
  'omnai-grill',
  'omnai-reconcile',
] as const;

test('ships a scenario page for every canonical scenario', async () => {
  for (const scenario of listScenarios()) {
    assert.equal(await pathExists(join(process.cwd(), 'docs', 'scenarios', `${scenario.id}.md`)), true, scenario.id);
  }
});

test('ships exactly four canonical user-level Host Skills', async () => {
  const root = join(process.cwd(), 'skills');
  const entries = await readdir(root, { withFileTypes: true });
  const actual: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await pathExists(join(root, entry.name, 'SKILL.md'))) actual.push(entry.name);
  }
  actual.sort();
  assert.deepEqual(actual, [...REQUIRED_SKILLS]);
  assert.equal(new Set<string>(actual).has('omnai-run'), false);
});

test('ships the authorization migration golden example with revision and evidence', async () => {
  const root = join(process.cwd(), 'examples', 'golden', 'java-authorization-migration');
  for (const path of [
    'README.md',
    '.omnai/changes/CHG-0001-authorization-migration/change.yaml',
    '.omnai/changes/CHG-0001-authorization-migration/research.md',
    '.omnai/changes/CHG-0001-authorization-migration/domain.md',
    '.omnai/changes/CHG-0001-authorization-migration/spec.md',
    '.omnai/changes/CHG-0001-authorization-migration/contract.md',
    '.omnai/changes/CHG-0001-authorization-migration/design.md',
    '.omnai/changes/CHG-0001-authorization-migration/tasks.yaml',
    '.omnai/changes/CHG-0001-authorization-migration/revisions/REV-0002.yaml',
    '.omnai/changes/CHG-0001-authorization-migration/evidence/EVD-002.yaml',
    '.omnai/changes/CHG-0001-authorization-migration/delivery.md',
  ]) {
    assert.equal(await pathExists(join(root, path)), true, path);
  }
});
