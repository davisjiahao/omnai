import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { worksetReentrySchema, worksetSchema } from '../src/workspace/types.js';
import { worksetReentryInputSchema } from '../src/workspace/reentry-input.js';
import { projectRegistryPath, resolveOmnaiHome, worksetManifestPath } from '../src/workspace/paths.js';

test('resolves personal OmnAI home from OMNAI_HOME before user home', () => {
  assert.equal(resolveOmnaiHome({ OMNAI_HOME: '/tmp/omnai-home' }, '/Users/test'), '/tmp/omnai-home');
  assert.equal(resolveOmnaiHome({}, '/Users/test'), '/Users/test/.omnai');
});

test('derives stable personal workspace paths', () => {
  assert.equal(projectRegistryPath('/tmp/home'), join('/tmp/home', 'projects.yaml'));
  assert.equal(worksetManifestPath('/tmp/home', 'WKS-0001'), join('/tmp/home', 'worksets', 'WKS-0001', 'workset.yaml'));
});

test('validates the workset member lifecycle shape', () => {
  const parsed = worksetSchema.parse({
    schemaVersion: 2,
    id: 'WKS-0001',
    slug: 'authorization-migration',
    title: 'Authorization Migration',
    status: 'OPEN',
    authorityGeneration: 2,
    lastOperation: {
      operationId: 'WOP-000001',
      operationRequestId: 'create-workset-1',
      requestDigest: `sha256:${'a'.repeat(64)}`,
      kind: 'ADD_CANDIDATE',
    },
    members: [{
      projectAlias: 'user',
      status: 'CANDIDATE',
      changeBinding: null,
      workspace: null,
      addedAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z',
    }],
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
  });

  assert.equal(parsed.members[0]?.status, 'CANDIDATE');
});

test('workspace Reentry reader rejects every v1/defaultable persisted shape', () => {
  assert.equal(worksetReentrySchema.safeParse({
    schemaVersion: 1,
    id: 'WRE-0001',
    worksetId: 'WKS-0001',
    kind: 'REALITY_CHANGED',
    reason: 'Reality changed',
    route: { capability: 'research', interaction: 'none', reason: 'Legacy route' },
    status: 'PENDING',
    createdAt: '2026-08-14T00:00:00.000Z',
    resolvedAt: null,
  }).success, false);
});

test('workspace Reentry command input requires the exact strict v1 fields', () => {
  const input = {
    schemaVersion: 1,
    kind: 'REALITY_CHANGED',
    reason: 'Reality changed',
    affectedProjects: ['core'],
    candidateProjects: [],
  } as const;
  assert.equal(worksetReentryInputSchema.safeParse(input).success, true);
  const { affectedProjects: _affectedProjects, ...missingAffected } = input;
  assert.equal(worksetReentryInputSchema.safeParse(missingAffected).success, false);
  assert.equal(worksetReentryInputSchema.safeParse({ ...input, compatibility: true }).success, false);
});
