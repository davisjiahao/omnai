import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathExists } from '../src/core/files.js';
import { listScenarios } from '../src/core/scenarios.js';

const REQUIRED_SKILLS = [
  'omnai', 'omnai-investigate', 'omnai-frame', 'omnai-research', 'omnai-model', 'omnai-map', 'omnai-spec',
  'omnai-design', 'omnai-plan', 'omnai-triage', 'omnai-reproduce', 'omnai-debug', 'omnai-experiment', 'omnai-fix',
  'omnai-work', 'omnai-simplify', 'omnai-review', 'omnai-verify', 'omnai-qa', 'omnai-mitigate', 'omnai-ship',
  'omnai-canary', 'omnai-learn', 'omnai-reconcile', 'omnai-archive',
] as const;

test('ships a scenario page for every canonical scenario', async () => {
  for (const scenario of listScenarios()) {
    assert.equal(await pathExists(join(process.cwd(), 'docs', 'scenarios', `${scenario.id}.md`)), true, scenario.id);
  }
});

test('ships the required native host skill surface', async () => {
  for (const skill of REQUIRED_SKILLS) {
    assert.equal(await pathExists(join(process.cwd(), 'skills', skill, 'SKILL.md')), true, skill);
  }
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
