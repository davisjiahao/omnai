import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { worksetSchema } from '../src/workspace/types.js';
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
    schemaVersion: 1,
    id: 'WKS-0001',
    slug: 'authorization-migration',
    title: 'Authorization Migration',
    status: 'OPEN',
    members: [{
      project: 'user',
      status: 'CANDIDATE',
      addedAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z',
    }],
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
  });

  assert.equal(parsed.members[0]?.status, 'CANDIDATE');
});
