import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { readText } from '../src/core/files.js';
import { selectReviewLenses } from '../src/core/policy.js';
import { detectScenario, getScenario } from '../src/core/scenarios.js';
import { outputContract, prepareStage } from '../src/core/stages.js';
import { createChange, resolveChange } from '../src/core/store.js';
import { designTemplate } from '../src/core/templates.js';
import { createTestRepository } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

test('internal layering language routes to the architecture scenario and scales the existing review lens', async () => {
  const fixture = await createTestRepository('module-boundary-routing');
  cleanups.push(fixture.cleanup);
  const architectureRequest = 'review a dependency cycle caused by a layering violation inside the monolith';
  const architecture = await createChange(
    fixture.root,
    'Resolve a layering violation inside the monolith',
    'architecture-governance',
  );
  const small = await createChange(fixture.root, 'Add a local label', 'small-feature');
  const architectureScenario = detectScenario(architectureRequest);
  const smallScenario = getScenario(small.metadata.scenario);

  assert.equal(architectureScenario.id, 'architecture-governance');
  assert.ok(selectReviewLenses(architectureScenario, architecture.metadata.risk, architecture.metadata.impact).includes('architecture'));
  assert.equal(selectReviewLenses(smallScenario, small.metadata.risk, small.metadata.impact).includes('architecture'), false);
});

test('specialized routes retain cross-service contracts and public shared SDK APIs', () => {
  assert.equal(
    detectScenario('coordinate a cross service contract for API consumers').id,
    'cross-service-change',
  );
  assert.equal(detectScenario('publish a public shared SDK API').id, 'shared-library');
});

test('small-feature design scaffold keeps not-applicable changes free of fictitious boundary IDs', async () => {
  const fixture = await createTestRepository('module-boundary-small-feature-scaffold');
  cleanups.push(fixture.cleanup);
  const change = await createChange(fixture.root, 'Handle a nullable nickname', 'small-feature');
  const scaffold = await readText(join(fixture.root, '.omnai', 'changes', change.directoryName, 'design.md'));

  assert.match(
    scaffold,
    /For `not-applicable`, provide only the short applicability rationale above; do not complete the focused\/full assessment or invent `MOD-\*`, `IF-\*`, `SEAM-\*`, or `ADP-\*` IDs\./,
  );
  for (const heading of [
    '## Module-Boundary Assessment (`focused`/`full` only)',
    '### Modules and Responsibilities (`focused`/`full` only)',
    '### Interface Semantics (`focused`/`full` only)',
    '### Seams, Adapters, and Dependency Direction (`focused`/`full` only)',
    '### Depth, Leverage, Locality, and Deletion Test (`focused`/`full` only)',
    '### Boundary Enforcement and Interface Test Surface (`focused`/`full` only)',
  ]) {
    assert.ok(scaffold.includes(heading), `generated design scaffold must include ${heading}`);
  }
  const exampleRows = scaffold.split('\n').filter((line) => /^\| (?:MOD|IF|SEAM)-001/.test(line));
  assert.equal(exampleRows.length, 4);
  assert.ok(exampleRows.every((line) => line.includes('focused/full example only')));
});

test('architecture design runs pin the versioned module-boundary protocol and exact prompt bytes', async () => {
  const fixture = await createTestRepository('module-boundary-design');
  cleanups.push(fixture.cleanup);
  const created = await createChange(
    fixture.root,
    'Break a dependency cycle across service boundaries',
    'architecture-governance',
  );
  const architecture = await resolveChange(fixture.root, created.metadata.id);
  const prepared = await prepareStage(fixture.root, architecture, 'design', 'Assess the target module boundary.');
  const prompt = await readText(prepared.promptPath);
  const designProtocol = prepared.manifest.protocols.find(({ id }) => id === 'repository.design');
  assert.equal(designProtocol?.id, 'repository.design');
  assert.equal(designProtocol?.version, 3);
  assert.match(designProtocol?.hash ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.equal(prepared.manifest.promptHash, sha256(prompt));
});

test('architecture design prompts carry the risk-scaled module-boundary method', async () => {
  const fixture = await createTestRepository('module-boundary-prompt');
  cleanups.push(fixture.cleanup);
  const created = await createChange(
    fixture.root,
    'Break a dependency cycle across service boundaries',
    'architecture-governance',
  );
  const architecture = await resolveChange(fixture.root, created.metadata.id);
  const prepared = await prepareStage(fixture.root, architecture, 'design', 'Assess the target module boundary.');
  const prompt = await readText(prepared.promptPath);

  assert.match(prompt, /not-applicable/);
  assert.match(prompt, /focused/);
  assert.match(prompt, /full/);
  assert.match(prompt, /interface semantics/i);
  assert.match(prompt, /seams?, adapters?/i);
  assert.match(prompt, /depth/i);
  assert.match(prompt, /leverage/i);
  assert.match(prompt, /locality/i);
  assert.match(prompt, /deletion test/i);
  assert.match(prompt, /boundary enforcement/i);
  assert.match(prompt, /interface test surface/i);
});

test('architecture design prompts retain the existing architecture-review evidence requirement', async () => {
  const fixture = await createTestRepository('module-boundary-policy');
  cleanups.push(fixture.cleanup);
  const created = await createChange(
    fixture.root,
    'Break a dependency cycle across service boundaries',
    'architecture-governance',
  );
  const architecture = await resolveChange(fixture.root, created.metadata.id);
  const prepared = await prepareStage(fixture.root, architecture, 'design', 'Assess the target module boundary.');
  const prompt = await readText(prepared.promptPath);

  assert.match(scenarioPolicy(prompt), /architecture-review/);
});

test('the design scaffold and output contract keep the assessment in design.md', () => {
  const contract = outputContract('design');

  assert.match(designTemplate, /## Architecture Applicability/);
  assert.match(designTemplate, /## Module-Boundary Assessment/);
  assert.match(designTemplate, /not-applicable[\s\S]*focused[\s\S]*full/);
  assert.match(contract, /design\.md/);
  assert.match(contract, /architecture applicability/i);
  assert.match(contract, /module-boundary assessment/i);
  assert.doesNotMatch(contract, /module-assessment\.md/i);
});

function sha256(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function scenarioPolicy(prompt: string): string {
  const match = /^Scenario policy:\n([\s\S]*?)\n\nAuthoritative context:/m.exec(prompt);
  assert.ok(match, 'prepared prompt must contain a Scenario policy section');
  return match?.[1] ?? '';
}
