import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findEvidenceGaps } from '../src/core/evidence.js';
import type { EvidenceRequirement } from '../src/core/policy.js';
import type { EvidenceRecord } from '../src/domain/types.js';

const matrix: EvidenceRequirement[] = [
  { id: 'tests', required: true, because: 'backend' },
  { id: 'contract-test', required: true, because: 'contract' },
  { id: 'human-approval', required: true, because: 'P1' },
];

function record(requirementId: string, status: EvidenceRecord['status']): EvidenceRecord {
  return {
    schemaVersion: 1,
    id: `EVD-${requirementId}`,
    changeId: 'CHG-0001',
    revision: 'REV-0001',
    requirementId,
    type: requirementId === 'contract-test' ? 'contract' : 'manual',
    status,
    summary: requirementId,
    createdAt: new Date().toISOString(),
  };
}

test('evidence matrix is satisfied only by PASS evidence for the same requirement id', () => {
  assert.deepEqual(findEvidenceGaps(matrix, [record('tests', 'PASS')]).map((item) => item.id), ['contract-test', 'human-approval']);
  assert.deepEqual(findEvidenceGaps(matrix, [record('tests', 'PASS'), record('contract-test', 'FAIL'), record('human-approval', 'PASS')]).map((item) => item.id), ['contract-test']);
  assert.deepEqual(findEvidenceGaps(matrix, matrix.map((item) => record(item.id, 'PASS'))), []);
});
