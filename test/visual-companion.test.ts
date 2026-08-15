import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  loadVisualCompanionDocument,
  startVisualCompanion,
  visualCompanionDocumentSchema,
  type VisualCompanionServer,
} from '../src/visual/index.js';
import { createTestDirectory } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

test('validates the three closed visual document kinds and their hard limits', () => {
  assert.equal(visualCompanionDocumentSchema.safeParse(directionsDocument()).success, true);
  assert.equal(visualCompanionDocumentSchema.safeParse({
    schemaVersion: 1,
    kind: 'flow',
    title: 'Request lifecycle',
    summary: 'A request crosses three bounded stages.',
    nodes: [
      { id: 'request', label: 'Request', description: 'Input arrives.' },
      { id: 'decision', label: 'Decision', description: 'Policy selects a route.' },
    ],
    edges: [{ from: 'request', to: 'decision', label: 'validated' }],
  }).success, true);
  assert.equal(visualCompanionDocumentSchema.safeParse({
    schemaVersion: 1,
    kind: 'step-through',
    title: 'Re-entry',
    summary: 'One state changes at a time.',
    overview: 'The active revision remains authoritative.',
    steps: [
      { id: 'detect', title: 'Detect', description: 'Find the conflicting fact.', changes: ['Reconcile becomes pending.'] },
      { id: 'apply', title: 'Apply', description: 'Apply the approved closure.', changes: ['Only affected work reopens.'] },
    ],
  }).success, true);

  const tooFewDirections = directionsDocument();
  tooFewDirections.directions = tooFewDirections.directions.slice(0, 1);
  assert.equal(visualCompanionDocumentSchema.safeParse(tooFewDirections).success, false);

  const danglingEdge = {
    schemaVersion: 1,
    kind: 'flow',
    title: 'Broken flow',
    summary: 'One edge points outside the document.',
    nodes: [{ id: 'known', label: 'Known', description: 'Present node.' }],
    edges: [{ from: 'known', to: 'missing' }],
  };
  assert.equal(visualCompanionDocumentSchema.safeParse(danglingEdge).success, false);
});

test('serves a token-scoped loopback companion with no writable HTTP surface', async () => {
  const fixture = await createTestDirectory('visual-companion-');
  cleanups.push(fixture.cleanup);
  const inputPath = join(fixture.root, 'directions.json');
  const originalBytes = JSON.stringify(directionsDocument());
  await writeFile(inputPath, originalBytes, 'utf8');
  const entriesBefore = await readdir(fixture.root);

  const server = await startVisualCompanion(inputPath);
  registerServerCleanup(server);
  const url = new URL(server.url);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/[a-f0-9]{48}\/$/);

  const shell = await fetch(server.url);
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  assert.match(await shell.text(), /id="omnai-visual-companion"/);

  const documentResponse = await fetch(new URL('document', server.url));
  assert.equal(documentResponse.status, 200);
  assert.deepEqual(await documentResponse.json(), directionsDocument());

  const scriptResponse = await fetch(new URL('app.js', server.url));
  const script = await scriptResponse.text();
  assert.equal(scriptResponse.status, 200);
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /innerHTML|eval\(|new Function/);

  const health = await fetch(new URL('health', server.url));
  assert.deepEqual(await health.json(), { status: 'ok', schemaVersion: 1 });

  const rejectedWrite = await fetch(new URL('document', server.url), { method: 'POST', body: '{}' });
  assert.equal(rejectedWrite.status, 405);
  const missingToken = await fetch(`${url.origin}/document`);
  assert.equal(missingToken.status, 404);
  assert.deepEqual(await readdir(fixture.root), entriesBefore);
  assert.equal(await readFile(inputPath, 'utf8'), originalBytes);
});

test('reloads validated Host-owned input without creating companion state', async () => {
  const fixture = await createTestDirectory('visual-companion-reload-');
  cleanups.push(fixture.cleanup);
  const inputPath = join(fixture.root, 'directions.json');
  const first = directionsDocument();
  await writeFile(inputPath, JSON.stringify(first), 'utf8');

  const server = await startVisualCompanion(inputPath);
  registerServerCleanup(server);
  const second = directionsDocument();
  second.summary = 'The same session now explains the revised choice.';
  await writeFile(inputPath, JSON.stringify(second), 'utf8');

  const loaded = await loadVisualCompanionDocument(inputPath);
  assert.equal(loaded.summary, second.summary);
  const response = await fetch(new URL('document', server.url));
  assert.equal((await response.json() as { summary: string }).summary, second.summary);
});

function registerServerCleanup(server: VisualCompanionServer): void {
  cleanups.push(() => server.close());
}

function directionsDocument() {
  return {
    schemaVersion: 1 as const,
    kind: 'directions' as const,
    title: 'Authorization UI directions',
    summary: 'Compare two structures at equal fidelity.',
    directions: [
      {
        id: 'guided',
        name: 'Guided path',
        emphasis: 'One decision at a time',
        userImpact: 'Lower cognitive load for occasional users.',
        tradeoff: 'Experts need more clicks.',
        details: ['Progressive disclosure', 'Visible next action'],
      },
      {
        id: 'overview',
        name: 'Operational overview',
        emphasis: 'All controls remain visible',
        userImpact: 'Experts scan and act faster.',
        tradeoff: 'New users see more information at once.',
        details: ['Dense comparison', 'Fewer transitions'],
      },
    ],
  };
}
