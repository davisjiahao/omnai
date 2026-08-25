import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import YAML from 'yaml';
import { ProtocolError, loadProtocol, protocolRelativePath, type ProtocolId } from '../src/protocols/index.js';
import { protocolIdsForWorksetRoute } from '../src/workspace/workset-protocols.js';

const RESOURCE_METADATA: Array<[
  ProtocolId,
  Record<string, unknown>,
]> = [
  ['interaction.grill', { kind: 'interaction', interaction: 'grill' }],
  ['interaction.brainstorm', { kind: 'interaction', interaction: 'brainstorm' }],
  ['workset.candidate-research', { kind: 'workset-action', actions: ['inspect-project'] }],
  ['workset.project-impact-decision', { kind: 'workset-action', actions: ['decide-project-impact'] }],
  ['workset.project-change-binding', { kind: 'workset-action', actions: ['bind-project-change'] }],
  ['workset.project-workflow-handoff', { kind: 'workset-action', actions: ['project-workflow'] }],
  ['workset.reentry-classification', { kind: 'workset-action', actions: ['record-reentry'] }],
  ['workset.reentry-interaction', { kind: 'workset-action', actions: ['reenter'] }],
  ['workset.reentry-plan', { kind: 'workset-action', actions: ['reenter'] }],
  ['workset.reentry-decision', { kind: 'workset-action', actions: ['decide-reentry'] }],
  ['workset.reentry-apply', { kind: 'workset-action', actions: ['apply-reentry'] }],
  ['workset.reentry-replan', { kind: 'workset-action', actions: ['replan-reentry'] }],
  ['workset.reentry-finalize', { kind: 'workset-action', actions: ['finalize-reentry'] }],
];

test('packaged interaction and Workset protocols have exact metadata bindings', async () => {
  for (const [id, expected] of RESOURCE_METADATA) {
    const document = await loadProtocol(id);
    assert.equal(document.id, id);
    const raw = await readFile(join(process.cwd(), 'resources', 'protocols', protocolRelativePath(id)), 'utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    assert.ok(match, id);
    const metadata = YAML.parse(match[1] ?? '') as Record<string, unknown>;
    assert.equal(metadata.schemaVersion, 1, id);
    assert.equal(metadata.id, id, id);
    const expectedVersion = id === 'interaction.grill' || id === 'interaction.brainstorm' ? 2 : 1;
    assert.equal(metadata.version, expectedVersion, id);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(metadata[key], value, `${id}:${key}`);
  }
});

test('Workset route mapping is deterministic and ordered', () => {
  assert.deepEqual(protocolIdsForWorksetRoute('inspect-project'), ['workset.candidate-research']);
  assert.deepEqual(protocolIdsForWorksetRoute('decide-project-impact'), ['workset.project-impact-decision']);
  assert.deepEqual(protocolIdsForWorksetRoute('reenter', 'model', 'grill'), [
    'workset.reentry-interaction',
    'interaction.grill',
    'repository.model',
    'workset.reentry-plan',
  ]);
  assert.deepEqual(protocolIdsForWorksetRoute('reenter', 'design', 'brainstorm'), [
    'workset.reentry-interaction',
    'interaction.brainstorm',
    'repository.design',
    'workset.reentry-plan',
  ]);
  assert.deepEqual(protocolIdsForWorksetRoute('reenter', 'research', 'none'), [
    'workset.reentry-interaction',
    'repository.research',
    'workset.reentry-plan',
  ]);
  assert.deepEqual(protocolIdsForWorksetRoute('decide-reentry'), ['workset.reentry-decision']);
  assert.deepEqual(protocolIdsForWorksetRoute('apply-reentry'), ['workset.reentry-apply']);
  assert.deepEqual(protocolIdsForWorksetRoute('replan-reentry'), ['workset.reentry-replan']);
  assert.deepEqual(protocolIdsForWorksetRoute('finalize-reentry'), ['workset.reentry-finalize']);
  assert.deepEqual(protocolIdsForWorksetRoute('project-workflow'), ['workset.project-workflow-handoff']);
  assert.deepEqual(protocolIdsForWorksetRoute('none'), []);
});

test('reenter mapping requires both capability and interaction', () => {
  assert.throws(
    () => protocolIdsForWorksetRoute('reenter'),
    (error: unknown) => error instanceof ProtocolError && error.code === 'PROTOCOL_MAPPING_MISSING',
  );
  assert.throws(
    () => protocolIdsForWorksetRoute('reenter', 'model'),
    (error: unknown) => error instanceof ProtocolError && error.code === 'PROTOCOL_MAPPING_MISSING',
  );
});

test('interaction and Workset protocols retain non-bypassable guards', async () => {
  const expected: Array<[ProtocolId, RegExp[]]> = [
    ['interaction.grill', [/Decision Frontier/i, /one .* question at a time/i, /preserve .* settled/i]],
    ['interaction.brainstorm', [/two or more materially distinct viable approaches/i, /Experiment/i, /route .* Grill/i]],
    ['workset.candidate-research', [/original repository.*read-only/i, /do not create .*Worktree.*Project Change/i]],
    ['workset.project-impact-decision', [/OBSERVED_ONLY/i, /explicit confirmation/i, /project-change-binding/i]],
    ['workset.project-change-binding', [/never .*activeChange automatically/i, /no silent rebind/i]],
    ['workset.project-workflow-handoff', [/bound ACTIVE Worktree/i, /INACTIVE.*not writable/i]],
    ['workset.reentry-classification', [/REALITY_CHANGED/i, /IMPLEMENTATION_DETAIL_CHANGED/i, /do not calculate .*closure/i]],
    ['workset.reentry-interaction', [/workset next.*precedence/i, /preserve unaffected/i]],
    ['workset.reentry-plan', [/reopenFrom/i, /Core calculates.*closure/i, /show .* plan before/i]],
    ['workset.reentry-decision', [/explicit user approval/i, /freeze.*Revision.*Baseline/i, /do not apply.*PENDING/i]],
    ['workset.reentry-apply', [/frozen exact scope/i, /partial success/i, /idempotent/i]],
    ['workset.reentry-replan', [/FAILED.*STALE_PRECONDITION/i, /preview.*read-only/i, /attemptHistory/i]],
    ['workset.reentry-finalize', [/APPLIED.*NOT_REQUIRED/i, /without another repository Reconcile/i, /RESOLVED/i]],
  ];

  for (const [id, patterns] of expected) {
    const content = (await loadProtocol(id)).content;
    for (const pattern of patterns) assert.match(content, pattern, id);
  }
});
