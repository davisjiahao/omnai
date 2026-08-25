import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decisionRecordSchema,
  flowAssessmentProposalSchema,
  flowPlanSchema,
  type DecisionRecordConstructionInput,
} from '../src/domain/types.js';
import { assertCanonicalDecisionTransition } from '../src/core/decision-transition.js';
import { changeDecisionPath, changeDecisionsRoot, changeFlowPath } from '../src/core/paths.js';

const hash = (value: string): `sha256:${string}` => `sha256:${value.padEnd(64, '0').slice(0, 64)}`;
const source = { kind: 'artifact' as const, path: 'domain.md', contentHash: hash('a') };
const decisionSource = { kind: 'decision' as const, decisionId: 'DEC-0001', contentHash: hash('d') };

function openDecision(): DecisionRecordConstructionInput {
  return {
    schemaVersion: 2,
    id: 'DEC-0001',
    changeId: 'CHG-0001',
    openedRevision: 'REV-0001',
    resolvedRevision: null,
    kind: 'DOMAIN',
    owner: 'HUMAN',
    status: 'OPEN',
    blocking: true,
    question: 'Which aggregate owns durable consent?',
    options: [],
    resolution: null,
    supersededBy: null,
    affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] },
    sourceRefs: [source],
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
  };
}

test('DecisionRecord accepts one unresolved blocking decision and rejects impossible resolution state', () => {
  assert.equal(decisionRecordSchema.parse(openDecision()).status, 'OPEN');
  assert.equal(decisionRecordSchema.safeParse({
    ...openDecision(),
    status: 'RESOLVED',
    resolvedRevision: null,
    resolution: null,
  }).success, false);
});

test('resolved Decision supersession clears the prior resolution under the canonical transition', () => {
  const before = decisionRecordSchema.parse({
    ...openDecision(),
    status: 'RESOLVED',
    resolvedRevision: 'REV-0001',
    resolution: { optionId: null, summary: 'Use the durable owner', authority: 'HUMAN_CONFIRMED', sourceRefs: [source] },
  });
  const after = decisionRecordSchema.parse({
    ...before,
    status: 'SUPERSEDED',
    resolution: null,
    supersededBy: 'DEC-0002',
    updatedAt: '2026-08-19T00:00:01.000Z',
  });
  assert.doesNotThrow(() => assertCanonicalDecisionTransition('DECISION_SUPERSEDED', before, after));
});

test('Brainstorm options are stable, source-backed, and uniquely identified', () => {
  const decision = openDecision();
  const option = { id: 'OPT-01', label: 'Adapter boundary', status: 'VIABLE' as const, consequences: ['Localizes protocol churn'], sourceRefs: [source] };
  assert.equal(decisionRecordSchema.parse({
    ...decision,
    kind: 'ARCHITECTURE',
    owner: 'AGENT',
    options: [option, { ...option, id: 'OPT-02', label: 'Domain service' }],
  }).options.length, 2);
  assert.equal(decisionRecordSchema.safeParse({ ...decision, options: [option, option] }).success, false);
});

test('Flow proposals bind exact Change Revision Baseline and source hashes', () => {
  const assessment = {
    scale: 'CHANGE',
    uncertainty: { problem: 'CLEAR', domain: 'OPEN', solution: 'OPEN', delivery: 'CLEAR' },
    topology: 'CROSS_MODULE',
    architectureApplicability: 'FOCUSED',
    deliveryShape: 'STANDARD',
    decisionIds: ['DEC-0001'],
    sourceRefs: [decisionSource],
  } as const;
  assert.equal(flowAssessmentProposalSchema.parse({
    schemaVersion: 2,
    changeId: 'CHG-0001',
    revision: 'REV-0001',
    baseline: 'BL-0001',
    assessment,
  }).assessment.topology, 'CROSS_MODULE');
});

test('FlowPlan rejects duplicate capabilities and stale identity shapes', () => {
  const capability = { capability: 'spec', disposition: 'REQUIRED', active: true, reason: 'Scenario floor', sourceRefs: [source] } as const;
  const plan = {
    schemaVersion: 2,
    changeId: 'CHG-0001',
    revision: 'REV-0001',
    baseline: 'BL-0001',
    assessment: flowAssessmentProposalSchema.parse({
      schemaVersion: 2,
      changeId: 'CHG-0001',
      revision: 'REV-0001',
      baseline: 'BL-0001',
      assessment: {
        scale: 'LOCAL',
        uncertainty: { problem: 'CLEAR', domain: 'CLEAR', solution: 'CLEAR', delivery: 'CLEAR' },
        topology: 'SINGLE_MODULE',
        architectureApplicability: 'NOT_APPLICABLE',
        deliveryShape: 'STANDARD',
        decisionIds: [],
        sourceRefs: [source],
      },
    }).assessment,
    capabilities: [capability, capability],
    decisionIds: [],
    decisionBindings: [],
    inputHash: hash('b'),
    compiledAt: '2026-08-19T00:00:00.000Z',
  };
  assert.equal(flowPlanSchema.safeParse(plan).success, false);
});

test('FlowPlan keeps required capabilities active', () => {
  const assessment = flowAssessmentProposalSchema.parse({
    schemaVersion: 2,
    changeId: 'CHG-0001',
    revision: 'REV-0001',
    baseline: 'BL-0001',
    assessment: {
      scale: 'LOCAL',
      uncertainty: { problem: 'CLEAR', domain: 'CLEAR', solution: 'CLEAR', delivery: 'CLEAR' },
      topology: 'SINGLE_MODULE',
      architectureApplicability: 'NOT_APPLICABLE',
      deliveryShape: 'STANDARD',
      decisionIds: [],
      sourceRefs: [source],
    },
  }).assessment;
  assert.equal(flowPlanSchema.safeParse({
    schemaVersion: 2,
    changeId: 'CHG-0001',
    revision: 'REV-0001',
    baseline: 'BL-0001',
    assessment,
    capabilities: [{ capability: 'spec', disposition: 'REQUIRED', active: false, reason: 'Incorrectly deactivated scenario floor', sourceRefs: [source] }],
    decisionIds: [],
    decisionBindings: [],
    inputHash: hash('c'),
    compiledAt: '2026-08-19T00:00:00.000Z',
  }).success, false);
});

test('DecisionRecord rejects duplicate content-addressed source references', () => {
  assert.equal(decisionRecordSchema.safeParse({
    ...openDecision(),
    sourceRefs: [source, { kind: 'artifact', path: 'domain.md', contentHash: hash('a') }],
  }).success, false);
});

test('Flow assessment rejects duplicate decision identities', () => {
  assert.equal(flowAssessmentProposalSchema.safeParse({
    schemaVersion: 2,
    changeId: 'CHG-0001',
    revision: 'REV-0001',
    baseline: 'BL-0001',
    assessment: {
      scale: 'CHANGE',
      uncertainty: { problem: 'CLEAR', domain: 'OPEN', solution: 'OPEN', delivery: 'CLEAR' },
      topology: 'CROSS_MODULE',
      architectureApplicability: 'FOCUSED',
      deliveryShape: 'STANDARD',
      decisionIds: ['DEC-0001', 'DEC-0001'],
      sourceRefs: [source],
    },
  }).success, false);
});

test('FlowPlan rejects duplicate decision identities', () => {
  assert.equal(flowPlanSchema.safeParse({
    schemaVersion: 2,
    changeId: 'CHG-0001',
    revision: 'REV-0001',
    baseline: 'BL-0001',
    assessment: {
      scale: 'LOCAL',
      uncertainty: { problem: 'CLEAR', domain: 'CLEAR', solution: 'CLEAR', delivery: 'CLEAR' },
      topology: 'SINGLE_MODULE',
      architectureApplicability: 'NOT_APPLICABLE',
      deliveryShape: 'STANDARD',
      decisionIds: [],
      sourceRefs: [source],
    },
    capabilities: [{ capability: 'spec', disposition: 'REQUIRED', active: true, reason: 'Scenario floor', sourceRefs: [source] }],
    decisionIds: ['DEC-0001', 'DEC-0001'],
    decisionBindings: [{ id: 'DEC-0001', contentHash: hash('e') }, { id: 'DEC-0001', contentHash: hash('e') }],
    inputHash: hash('d'),
    compiledAt: '2026-08-19T00:00:00.000Z',
  }).success, false);
});

test('Decision resolution rejects an option absent from its decision', () => {
  const resolved = {
    ...openDecision(),
    status: 'RESOLVED' as const,
    resolvedRevision: 'REV-0002',
    resolution: { optionId: 'OPT-01', summary: 'Choose the durable owner', authority: 'HUMAN_CONFIRMED' as const, sourceRefs: [source] },
  };
  assert.equal(decisionRecordSchema.safeParse({
    ...resolved,
    resolution: { ...resolved.resolution, optionId: 'OPT-02' },
    options: [{ id: 'OPT-01', label: 'Adapter boundary', status: 'VIABLE', consequences: [], sourceRefs: [source] }],
  }).success, false);
});

test('Decision resolution rejects an option already rejected during brainstorming', () => {
  const resolved = {
    ...openDecision(),
    status: 'RESOLVED' as const,
    resolvedRevision: 'REV-0002',
    resolution: { optionId: 'OPT-01', summary: 'Choose the durable owner', authority: 'HUMAN_CONFIRMED' as const, sourceRefs: [source] },
  };
  assert.equal(decisionRecordSchema.safeParse({
    ...resolved,
    options: [{ id: 'OPT-01', label: 'Adapter boundary', status: 'REJECTED', consequences: [], sourceRefs: [source] }],
  }).success, false);
});

test('flow and decision paths remain inside one Change', () => {
  assert.equal(changeDecisionsRoot('/repo', 'CHG-0001-test'), '/repo/.omnai/changes/CHG-0001-test/decisions');
  assert.equal(changeDecisionPath('/repo', 'CHG-0001-test', 'DEC-0001'), '/repo/.omnai/changes/CHG-0001-test/decisions/DEC-0001.yaml');
  assert.equal(changeFlowPath('/repo', 'CHG-0001-test'), '/repo/.omnai/changes/CHG-0001-test/flow.yaml');
});
