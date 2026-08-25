import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changeMetadataSchema, type DecisionRecord, type FlowAssessment, type FlowPlan } from '../src/domain/types.js';
import { compileFlowPlan, createInitialFlowAssessment, FLOW_CAPABILITY_ORDER, flowInputHash, hashFlowPlan } from '../src/core/flow.js';
import { getScenario } from '../src/core/scenarios.js';

const sourceRefs = [{ kind: 'policy' as const, scenarioId: 'small-feature' as const, contentHash: `sha256:${'1'.repeat(64)}` }];
const now = '2026-08-19T00:00:00.000Z';
const later = '2026-08-20T00:00:00.000Z';
const EXPECTED_CAPABILITY_ORDER = [
  'frame', 'mitigate', 'triage', 'reproduce', 'research', 'debug', 'diagnose',
  'map', 'model', 'spec', 'experiment', 'design', 'fix', 'plan', 'work',
  'simplify', 'review', 'verify', 'qa', 'ship', 'release', 'canary', 'learn',
  'archive', 'reconcile',
] as const;
const metadata = (scenario: string) => changeMetadataSchema.parse({
  schemaVersion: 1, id: 'CHG-0001', slug: 'flow', title: 'Flow', scenario,
  workMode: getScenario(scenario).workMode, status: 'DRAFT', activeRevision: 'REV-0001', baseline: 'BL-0001', artifactVersions: {},
  risk: { level: getScenario(scenario).risk, dimensions: getScenario(scenario).riskDimensions ?? {} },
  impact: getScenario(scenario).defaultImpact ?? {}, createdAt: now, updatedAt: now, readiness: {},
});

test('small-feature keeps every Scenario stage as an active required floor', () => {
  const change = metadata('small-feature');
  const scenario = getScenario('small-feature');
  const plan = compileFlowPlan(change, scenario, createInitialFlowAssessment(change, scenario, sourceRefs), [], now);
  for (const required of scenario.stages) {
    assert.equal(plan.capabilities.find((item) => item.capability === required)?.disposition, 'REQUIRED');
    assert.equal(plan.capabilities.find((item) => item.capability === required)?.active, true);
  }
});

test('program scale promotes map and open domain uncertainty promotes model', () => {
  const change = metadata('small-feature');
  const scenario = getScenario('small-feature');
  const assessment: FlowAssessment = {
    ...createInitialFlowAssessment(change, scenario, sourceRefs),
    scale: 'PROGRAM',
    uncertainty: { problem: 'CLEAR', domain: 'OPEN', solution: 'CLEAR', delivery: 'OPEN' },
  };
  const plan = compileFlowPlan(change, scenario, assessment, [], now);
  assert.equal(plan.capabilities.find((item) => item.capability === 'map')?.active, true);
  assert.equal(plan.capabilities.find((item) => item.capability === 'model')?.active, true);
});

test('cross-module assessment promotes design and policy-selected review without inventing a codebase-design Skill', () => {
  const change = metadata('bug-fix');
  const scenario = getScenario('bug-fix');
  const assessment: FlowAssessment = {
    ...createInitialFlowAssessment(change, scenario, sourceRefs),
    topology: 'CROSS_MODULE',
    architectureApplicability: 'FOCUSED',
  };
  const plan = compileFlowPlan(change, scenario, assessment, [], now);
  assert.equal(plan.capabilities.find((item) => item.capability === 'design')?.active, true);
  assert.equal(plan.capabilities.find((item) => item.capability === 'review')?.active, true);
});

test('relevant decisions are sorted and promote their affected capabilities without persisting an interaction overlay', () => {
  const change = metadata('complex-domain-feature');
  const scenario = getScenario('complex-domain-feature');
  const assessment = createInitialFlowAssessment(change, scenario, sourceRefs);
  const decision = (id: string, kind: DecisionRecord['kind'], owner: DecisionRecord['owner'], options: DecisionRecord['options'] = []): DecisionRecord => ({
    schemaVersion: 2, id, changeId: change.id, openedRevision: change.activeRevision, resolvedRevision: null,
    kind, owner, status: 'OPEN', blocking: true, question: id, options, resolution: null, supersededBy: null,
    affects: { capabilities: [kind === 'DOMAIN' ? 'model' : 'design'], artifacts: [], tasks: [], projects: [], contracts: [] },
    sourceRefs, createdAt: now, updatedAt: now,
  });
  const viable = (id: string) => ({ id, label: id, status: 'VIABLE' as const, consequences: [], sourceRefs });
  const plan = compileFlowPlan(change, scenario, assessment, [
    decision('DEC-0002', 'ARCHITECTURE', 'AGENT', [viable('OPT-01'), viable('OPT-02')]),
    decision('DEC-0001', 'DOMAIN', 'HUMAN'),
  ], now);
  assert.deepEqual(plan.decisionIds, ['DEC-0001', 'DEC-0002']);
  assert.equal(plan.capabilities.find((item) => item.capability === 'model')?.active, true);
  assert.equal('interaction' in plan, false);
});

test('flow compilation is order-stable and uses one canonical capability order', () => {
  assert.deepEqual(FLOW_CAPABILITY_ORDER, EXPECTED_CAPABILITY_ORDER);
  const change = metadata('small-feature');
  const scenario = getScenario('small-feature');
  const assessment = { ...createInitialFlowAssessment(change, scenario, sourceRefs), decisionIds: ['DEC-0002', 'DEC-0001'] };
  const first = compileFlowPlan(change, scenario, assessment, [], now);
  const second = compileFlowPlan(change, scenario, { ...assessment, decisionIds: ['DEC-0001', 'DEC-0002'] }, [], now);
  assert.deepEqual(first.capabilities.map(({ capability }) => capability), EXPECTED_CAPABILITY_ORDER);
  assert.equal(hashFlowPlan(first), hashFlowPlan(second));
});

test('exact duplicate DecisionRecords compile to one deterministic plan reference', () => {
  const change = metadata('small-feature');
  const scenario = getScenario('small-feature');
  const decision: DecisionRecord = {
    schemaVersion: 2, id: 'DEC-0001', changeId: change.id, openedRevision: change.activeRevision, resolvedRevision: null,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Who owns this rule?', options: [],
    resolution: null, supersededBy: null,
    affects: { capabilities: ['model'], artifacts: [], tasks: [], projects: [], contracts: [] },
    sourceRefs, createdAt: now, updatedAt: now,
  };
  const plan = compileFlowPlan(
    change,
    scenario,
    createInitialFlowAssessment(change, scenario, sourceRefs),
    [decision, structuredClone(decision)],
    now,
  );

  assert.deepEqual(plan.decisionIds, ['DEC-0001']);
});

test('duplicate caller source references normalize before strict assessment validation', () => {
  const change = metadata('small-feature');
  const scenario = getScenario('small-feature');
  const assessment = createInitialFlowAssessment(change, scenario, [
    sourceRefs[0]!,
    structuredClone(sourceRefs[0]!),
  ]);
  const plan = compileFlowPlan(change, scenario, {
    ...assessment,
    sourceRefs: [sourceRefs[0]!, structuredClone(sourceRefs[0]!)],
  }, [], now);

  assert.deepEqual(assessment.sourceRefs, sourceRefs);
  assert.deepEqual(plan.assessment.sourceRefs, sourceRefs);
});

test('duplicate caller assessment decision IDs normalize before strict plan validation', () => {
  const change = metadata('small-feature');
  const scenario = getScenario('small-feature');
  const assessment: FlowAssessment = {
    ...createInitialFlowAssessment(change, scenario, sourceRefs),
    decisionIds: ['DEC-0002', 'DEC-0001', 'DEC-0002'],
  };
  const plan = compileFlowPlan(change, scenario, assessment, [], now);

  assert.deepEqual(plan.assessment.decisionIds, ['DEC-0001', 'DEC-0002']);
});

test('same-ID DecisionRecords with conflicting bodies fail closed', () => {
  const change = metadata('small-feature');
  const scenario = getScenario('small-feature');
  const decision: DecisionRecord = {
    schemaVersion: 2, id: 'DEC-0001', changeId: change.id, openedRevision: change.activeRevision, resolvedRevision: null,
    kind: 'DOMAIN', owner: 'HUMAN', status: 'OPEN', blocking: true, question: 'Who owns this rule?', options: [],
    resolution: null, supersededBy: null,
    affects: { capabilities: ['model'], artifacts: [], tasks: [], projects: [], contracts: [] },
    sourceRefs, createdAt: now, updatedAt: now,
  };

  assert.throws(() => compileFlowPlan(
    change,
    scenario,
    createInitialFlowAssessment(change, scenario, sourceRefs),
    [decision, { ...decision, question: 'Which owner is authoritative?' }],
    now,
  ), /FLOW_DECISION_ID_CONFLICT: DEC-0001/);
});

test('inputHash binds every authoritative field independently', () => {
  type FlowHashInput = Pick<FlowPlan, 'changeId' | 'revision' | 'baseline' | 'assessment' | 'capabilities' | 'decisionIds'>;
  const input: FlowHashInput = {
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
      sourceRefs,
    },
    capabilities: [{ capability: 'spec', disposition: 'REQUIRED', active: true, reason: 'Scenario floor', sourceRefs }],
    decisionIds: [],
  };
  const base = flowInputHash(input);
  assert.equal(base, 'sha256:e9bf773b5c2177df1be5a8ff4ea7fe2c2073f872b4fbaad318a570ef4a6b61fe');
  const variants: Array<[string, FlowHashInput, string]> = [
    ['changeId', { ...input, changeId: 'CHG-0002' }, 'sha256:78e04ce0c9e644c8b0d99fa72f7b1b7596ee86f8b23cdaee387f08c758bb62eb'],
    ['revision', { ...input, revision: 'REV-0002' }, 'sha256:4e7ecd2eb550c92a5d7b9f4f128171c9bf37e2b328051266ac6ebeb3e2c41e7f'],
    ['baseline', { ...input, baseline: 'BL-0002' }, 'sha256:1c53fa144e89d094a7d8402ad3345ec23b13f64d9b6e26cdfd71aa70ebdeafa9'],
    ['assessment', { ...input, assessment: { ...input.assessment, scale: 'CHANGE' } }, 'sha256:a5bc2f75dd5ab43c9ad5d269424c235d4d923e676cd104c3215f2da6a530370e'],
    ['capabilities', { ...input, capabilities: [{ ...input.capabilities[0]!, reason: 'Assessment promotion' }] }, 'sha256:8ef2ee7463dbc24548a4d9b8e4865689ddfb74261a700553475745ec9864f1df'],
    ['decisionIds', { ...input, decisionIds: ['DEC-0001'] }, 'sha256:f12848a3fcd8dacd905fb886716e15e90e1c5cf9da27ffbfeddc72884aa81989'],
  ];

  for (const [field, variant, expectedHash] of variants) {
    assert.equal(flowInputHash(variant), expectedHash, `${field} must affect inputHash`);
    assert.notEqual(expectedHash, base, `${field} fixture must differ from the base hash`);
  }
});

test('compiledAt changes whole-plan identity but not authoritative input identity', () => {
  const change = metadata('small-feature');
  const scenario = getScenario('small-feature');
  const assessment = createInitialFlowAssessment(change, scenario, sourceRefs);
  const first = compileFlowPlan(change, scenario, assessment, [], now);
  const second = compileFlowPlan(change, scenario, assessment, [], later);

  assert.equal(first.inputHash, second.inputHash);
  assert.notEqual(hashFlowPlan(first), hashFlowPlan(second));
});

for (const { name, assessment, expected } of [
  {
    name: 'cross-project topology',
    assessment: { topology: 'CROSS_PROJECT' as const, architectureApplicability: 'FULL' as const },
    expected: ['spec', 'design', 'review', 'verify', 'ship'] as const,
  },
  {
    name: 'migration delivery',
    assessment: { deliveryShape: 'MIGRATION' as const },
    expected: ['map', 'design', 'review', 'verify', 'ship'] as const,
  },
  {
    name: 'high-risk delivery',
    assessment: { deliveryShape: 'HIGH_RISK' as const },
    expected: ['review', 'verify', 'ship'] as const,
  },
]) {
  test(`${name} promotes its complete capability set`, () => {
    const change = metadata('system-query');
    const scenario = getScenario('system-query');
    const initial = createInitialFlowAssessment(change, scenario, sourceRefs);
    const plan = compileFlowPlan(change, scenario, { ...initial, ...assessment }, [], now);

    for (const capability of expected) {
      assert.equal(plan.capabilities.find((item) => item.capability === capability)?.active, true, capability);
    }
  });
}

for (const risk of ['P0', 'P1'] as const) {
  test(`${risk} risk promotes review independently of delivery assessment`, () => {
    const original = metadata('small-feature');
    const change = changeMetadataSchema.parse({ ...original, risk: { ...original.risk, level: risk } });
    const scenario = getScenario('small-feature');
    const assessment: FlowAssessment = {
      ...createInitialFlowAssessment(change, scenario, sourceRefs),
      deliveryShape: 'STANDARD',
      uncertainty: { problem: 'CLEAR', domain: 'CLEAR', solution: 'CLEAR', delivery: 'CLEAR' },
    };
    const plan = compileFlowPlan(change, scenario, assessment, [], now);

    assert.equal(plan.capabilities.find((item) => item.capability === 'review')?.active, true);
  });
}

for (const { axis, capability } of [
  { axis: 'problem' as const, capability: 'research' as const },
  { axis: 'solution' as const, capability: 'design' as const },
]) {
  test(`open ${axis} uncertainty promotes ${capability}`, () => {
    const change = metadata('bug-fix');
    const scenario = getScenario('bug-fix');
    const initial = createInitialFlowAssessment(change, scenario, sourceRefs);
    const assessment: FlowAssessment = {
      ...initial,
      uncertainty: { ...initial.uncertainty, [axis]: 'OPEN' },
    };
    const plan = compileFlowPlan(change, scenario, assessment, [], now);

    assert.equal(plan.capabilities.find((item) => item.capability === capability)?.active, true);
  });
}

test('open AGENT decisions promote fact recovery while rejected and superseded decisions do not promote', () => {
  const change = metadata('small-feature');
  const scenario = getScenario('small-feature');
  const makeDecision = (id: string, status: DecisionRecord['status'], capability: 'map' | 'model'): DecisionRecord => ({
    schemaVersion: 2, id, changeId: change.id, openedRevision: change.activeRevision, resolvedRevision: null,
    kind: 'DOMAIN', owner: status === 'OPEN' ? 'AGENT' : 'HUMAN', status, blocking: true, question: id,
    options: [], resolution: null, supersededBy: status === 'SUPERSEDED' ? 'DEC-9999' : null,
    affects: { capabilities: [capability], artifacts: [], tasks: [], projects: [], contracts: [] },
    sourceRefs, createdAt: now, updatedAt: now,
  });
  const plan = compileFlowPlan(change, scenario, createInitialFlowAssessment(change, scenario, sourceRefs), [
    makeDecision('DEC-0001', 'OPEN', 'map'),
    makeDecision('DEC-0002', 'REJECTED', 'model'),
    makeDecision('DEC-0003', 'SUPERSEDED', 'model'),
  ], now);

  assert.equal(plan.capabilities.find((item) => item.capability === 'map')?.active, true);
  assert.equal(plan.capabilities.find((item) => item.capability === 'research')?.active, true);
  assert.equal(plan.capabilities.find((item) => item.capability === 'model')?.active, false);
  assert.deepEqual(plan.decisionIds, ['DEC-0001', 'DEC-0002', 'DEC-0003']);
});

test('assessment promotions leave reconcile event-driven', () => {
  const change = metadata('small-feature');
  const scenario = getScenario('small-feature');
  const assessment: FlowAssessment = {
    ...createInitialFlowAssessment(change, scenario, sourceRefs),
    scale: 'PROGRAM',
    uncertainty: { problem: 'OPEN', domain: 'OPEN', solution: 'OPEN', delivery: 'OPEN' },
    topology: 'CROSS_PROJECT',
    architectureApplicability: 'FULL',
    deliveryShape: 'MIGRATION',
  };
  const plan = compileFlowPlan(change, scenario, assessment, [], now);

  assert.equal(plan.capabilities.find((item) => item.capability === 'reconcile')?.active, false);
});
