import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChange } from '../src/core/store.js';
import { completeStage } from '../src/core/stages.js';
import { selectReviewLenses } from '../src/core/policy.js';
import { getScenario } from '../src/core/scenarios.js';
import { changeArtifactPath } from '../src/core/paths.js';
import { writeTextAtomic } from '../src/core/files.js';
import { createTestRepository } from './helpers.js';

function reviewRecord(changeId: string, revision: string, lenses: string[], overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    changeId,
    revision,
    lenses,
    specCompliance: 'PASS',
    implementationQuality: 'PASS',
    conclusion: 'PASS',
    findings: [],
    ...overrides,
  }, null, 2);
}

test('review completion rejects arbitrary or stale review files', async () => {
  const fixture = await createTestRepository();
  try {
    const change = await createChange(fixture.root, 'Cross service contract', 'cross-service-change');
    const reviewPath = changeArtifactPath(fixture.root, change.directoryName, 'evidence/review.json');

    await writeTextAtomic(reviewPath, '{}');
    await assert.rejects(() => completeStage(fixture.root, change, 'review'), /review.*schema|invalid.*review/i);

    const lenses = selectReviewLenses(getScenario(change.metadata.scenario), change.metadata.risk, change.metadata.impact);
    await writeTextAtomic(reviewPath, reviewRecord(change.metadata.id, 'REV-9999', lenses));
    await assert.rejects(() => completeStage(fixture.root, change, 'review'), /active revision|stale review/i);
  } finally {
    await fixture.cleanup();
  }
});

test('review completion requires every risk-impact lens and no blocking findings', async () => {
  const fixture = await createTestRepository();
  try {
    const change = await createChange(fixture.root, 'Cross service contract', 'cross-service-change');
    const reviewPath = changeArtifactPath(fixture.root, change.directoryName, 'evidence/review.json');
    const lenses = selectReviewLenses(getScenario(change.metadata.scenario), change.metadata.risk, change.metadata.impact);

    await writeTextAtomic(reviewPath, reviewRecord(change.metadata.id, change.metadata.activeRevision, ['engineering']));
    await assert.rejects(() => completeStage(fixture.root, change, 'review'), /missing review lenses/i);

    await writeTextAtomic(reviewPath, reviewRecord(change.metadata.id, change.metadata.activeRevision, lenses, {
      conclusion: 'CONCERNS',
      findings: [{ lens: 'contract', severity: 'IMPORTANT', status: 'OPEN', summary: 'Consumer rollout order is unsafe.' }],
    }));
    await assert.rejects(() => completeStage(fixture.root, change, 'review'), /blocking review|review conclusion/i);

    await writeTextAtomic(reviewPath, reviewRecord(change.metadata.id, change.metadata.activeRevision, lenses));
    await completeStage(fixture.root, change, 'review');
    assert.equal(change.metadata.readiness.review, 'READY');
  } finally {
    await fixture.cleanup();
  }
});
