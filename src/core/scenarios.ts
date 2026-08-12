import type { ScenarioProfile } from '../domain/types.js';

export const SCENARIOS: readonly ScenarioProfile[] = [
  {
    id: 'system-query', label: 'Read-only system query',
    description: 'Answer where code, rules, ownership, or behavior live without creating a change or modifying source.',
    workMode: 'READ_ONLY_QUERY', stages: ['research'], optionalStages: ['learn'], requiredArtifacts: ['research.md'],
    gates: ['Read-only by default', 'Every load-bearing statement cites code or a formal artifact'],
    requiredEvidence: ['code-references'], signals: ['which service', 'where is', 'explain code', 'who owns', 'system query'], risk: 'P3',
  },
  {
    id: 'field-lineage', label: 'Field lineage investigation',
    description: 'Trace a field across UI, API, DTOs, transforms, persistence, events, and remote calls without changing behavior.',
    workMode: 'READ_ONLY_QUERY', stages: ['research'], optionalStages: ['learn'], requiredArtifacts: ['research.md'],
    gates: ['Read-only by default', 'Trace both producers and consumers', 'Unknown hops are reported rather than guessed'],
    requiredEvidence: ['field-lineage', 'code-references'], signals: ['field lineage', 'where does', 'field usage', 'field written', 'field read', 'premiumamount', 'column mapping'], risk: 'P3',
  },
  {
    id: 'business-flow', label: 'Business flow investigation',
    description: 'Recover an end-to-end business path including entry points, branches, persistence, events, remote calls, and failure paths.',
    workMode: 'READ_ONLY_QUERY', stages: ['research'], optionalStages: ['model', 'learn'], requiredArtifacts: ['research.md'],
    gates: ['Read-only by default', 'Happy path and meaningful failure branches are traced', 'Business terms are not inferred from names alone'],
    requiredEvidence: ['flow-trace', 'code-references'], signals: ['business flow', 'full flow', 'end to end flow', 'from api to database', 'process flow', '调用链', '业务流程'], risk: 'P2',
  },
  {
    id: 'bug-fix', label: 'Bug fix',
    description: 'Triage a defect, reproduce it, confirm root cause, optionally experiment, make one focused fix, and add a regression guard.',
    workMode: 'BUG_FIX', stages: ['triage', 'reproduce', 'debug', 'fix', 'plan', 'work', 'verify', 'review', 'learn'],
    optionalStages: ['research', 'experiment', 'design', 'reconcile'], requiredArtifacts: ['issue.md', 'issue.yaml', 'fix.md', 'tasks.yaml'],
    gates: ['No production fix before root-cause evidence', 'Regression evidence required', 'Uncertain fix strategies are tested one variable at a time'],
    requiredEvidence: ['reproduction', 'root-cause', 'regression-test', 'full-test-suite'], signals: ['bug', 'defect', 'exception', 'unexpected', 'failing test', 'regression'], risk: 'P2',
    defaultImpact: { backend: true },
  },
  {
    id: 'small-feature', label: 'Small, well-understood feature',
    description: 'Deliver a focused feature through lightweight specification, design, planning, implementation, and verification.',
    workMode: 'FEATURE', stages: ['spec', 'design', 'plan', 'work', 'verify', 'archive'], optionalStages: ['research', 'review', 'learn'],
    requiredArtifacts: ['spec.md', 'design.md', 'tasks.yaml'], gates: ['Acceptance criteria are observable', 'Each task is independently verifiable'],
    requiredEvidence: ['build', 'tests'], signals: ['add endpoint', 'small feature', 'clear requirement', 'single module'], risk: 'P3',
  },
  {
    id: 'complex-domain-feature', label: 'Complex domain feature',
    description: 'Recover current behavior and domain meaning before specifying and implementing a business capability.',
    workMode: 'FEATURE', stages: ['research', 'model', 'spec', 'design', 'plan', 'work', 'review', 'verify', 'learn', 'archive'], optionalStages: ['frame', 'reconcile'],
    requiredArtifacts: ['research.md', 'domain.md', 'spec.md', 'design.md', 'tasks.yaml'],
    gates: ['Blocking domain questions are resolved', 'Domain ownership or lifecycle changes require approval'], requiredEvidence: ['domain-decisions', 'behavior-tests', 'integration-tests'],
    signals: ['business rule', 'domain model', 'lifecycle', 'authorization', 'order state', 'insurance rule'], risk: 'P1', riskDimensions: { businessCriticality: 'HIGH' }, defaultImpact: { backend: true },
  },
  {
    id: 'cross-service-change', label: 'Cross-service change',
    description: 'Coordinate contracts, ownership, rollout, compatibility, and verification across multiple services.',
    workMode: 'ARCHITECTURE_CHANGE', stages: ['research', 'model', 'spec', 'design', 'plan', 'work', 'review', 'verify', 'ship', 'learn', 'archive'], optionalStages: ['map', 'reconcile', 'canary'],
    requiredArtifacts: ['research.md', 'domain.md', 'spec.md', 'design.md', 'contract.md', 'tasks.yaml', 'delivery.md'],
    gates: ['Consumer impact is known', 'Contracts are versioned or backward compatible', 'Rollout order is explicit'], requiredEvidence: ['contract-tests', 'integration-tests', 'consumer-impact', 'runtime-health'],
    signals: ['multiple services', 'cross service', 'api consumer', 'event schema', 'distributed transaction'], risk: 'P1', riskDimensions: { compatibility: 'HIGH', operational: 'HIGH' },
    defaultImpact: { backend: true, apiContract: true, remoteService: true },
  },
  {
    id: 'migration-program', label: 'Long-running migration program',
    description: 'Map a destination through decision frontiers, execute multiple bounded changes, preserve lineage, and retire old paths safely.',
    workMode: 'MIGRATION', stages: ['frame', 'map', 'research', 'model', 'spec', 'design', 'plan', 'work', 'review', 'verify', 'ship', 'learn', 'archive'], optionalStages: ['reconcile', 'canary'],
    requiredArtifacts: ['intent.md', 'research.md', 'domain.md', 'spec.md', 'design.md', 'contract.md', 'tasks.yaml', 'delivery.md'],
    gates: ['Destination and out-of-scope are explicit', 'Unknowns remain fog until specifiable', 'Historical lineage and retirement criteria exist'],
    requiredEvidence: ['dependency-map', 'historical-lineage', 'compatibility-checks', 'migration-reconciliation', 'retirement-proof'], signals: ['migration program', 'decommission', 'sunset', 'split monolith', 'move capability', 'multi-month'],
    risk: 'P0', riskDimensions: { businessCriticality: 'CRITICAL', compatibility: 'CRITICAL', operational: 'CRITICAL' }, defaultImpact: { backend: true, apiContract: true, database: true, remoteService: true, observability: true },
  },
  {
    id: 'data-migration', label: 'Data migration',
    description: 'Design expand-migrate-contract phases, checkpoints, reconciliation, rollback or forward-fix, and retirement.',
    workMode: 'MIGRATION', stages: ['research', 'model', 'spec', 'design', 'review', 'plan', 'work', 'verify', 'ship', 'learn', 'archive'], optionalStages: ['map', 'reconcile', 'canary'],
    requiredArtifacts: ['research.md', 'domain.md', 'spec.md', 'design.md', 'tasks.yaml', 'delivery.md'],
    gates: ['Compatibility window is explicit', 'Checkpoint and compensation strategy exist', 'Irreversible operations require approval'], requiredEvidence: ['migration-dry-run', 'data-reconciliation', 'rollback-or-forward-fix-test', 'post-migration-health'],
    signals: ['schema migration', 'backfill', 'data move', 'dual write', 'historical rows', 'database migration'], risk: 'P0', riskDimensions: { data: 'CRITICAL', reversibility: 'CRITICAL', operational: 'HIGH' },
    defaultImpact: { backend: true, database: true, observability: true },
  },
  {
    id: 'architecture-governance', label: 'Architecture governance and evolution',
    description: 'Research current seams and lineage, model boundaries, challenge the proposal, and evolve through reversible increments.',
    workMode: 'ARCHITECTURE_CHANGE', stages: ['research', 'model', 'design', 'review', 'plan', 'work', 'verify', 'learn', 'archive'], optionalStages: ['spec', 'map', 'reconcile'],
    requiredArtifacts: ['research.md', 'domain.md', 'design.md', 'tasks.yaml'], gates: ['Alternatives and trade-offs are documented', 'Historical lineage is checked', 'Non-trivial claims receive adversarial review'],
    requiredEvidence: ['historical-lineage', 'architecture-review', 'characterization-tests', 'operability-check'], signals: ['architecture governance', 'refactor architecture', 'module boundaries', 'ddd', 'decouple', 'replace framework', 'security change'],
    risk: 'P1', riskDimensions: { reversibility: 'HIGH', compatibility: 'HIGH' },
  },
  {
    id: 'performance-investigation', label: 'Performance investigation',
    description: 'Establish a measurable baseline, instrument boundaries, test one hypothesis at a time, and prove the improvement.',
    workMode: 'PERFORMANCE', stages: ['research', 'diagnose', 'design', 'plan', 'work', 'review', 'verify', 'learn'], optionalStages: ['experiment', 'reconcile', 'ship'],
    requiredArtifacts: ['research.md', 'design.md', 'tasks.yaml'], gates: ['No optimization without a baseline', 'One hypothesis per experiment', 'Correctness must remain intact'],
    requiredEvidence: ['baseline-benchmark', 'profile-or-trace', 'after-benchmark', 'regression-tests'], signals: ['p95 latency', 'throughput', 'timeout', 'cpu', 'memory', 'performance regression', 'slow'],
    risk: 'P1', riskDimensions: { operational: 'HIGH' }, defaultImpact: { observability: true },
  },
  {
    id: 'product-discovery', label: 'Product discovery',
    description: 'Challenge demand, identify the narrowest valuable wedge, define success, then move into product and engineering design.',
    workMode: 'PRODUCT_DISCOVERY', stages: ['frame', 'research', 'spec', 'design', 'plan', 'work', 'qa', 'review', 'verify', 'ship', 'canary', 'learn'], optionalStages: ['model', 'reconcile'],
    requiredArtifacts: ['intent.md', 'research.md', 'spec.md', 'design.md', 'tasks.yaml', 'delivery.md'], gates: ['Target user and status quo are concrete', 'Narrowest valuable wedge is explicit', 'Success signal is measurable'],
    requiredEvidence: ['user-or-market-evidence', 'product-acceptance', 'runtime-signal'], signals: ['new product', 'startup', 'mvp', 'is this worth building', 'product idea', 'product discovery'], risk: 'P2',
  },
  {
    id: 'ui-ux-feature', label: 'UI and UX feature',
    description: 'Align user intent and interaction design, implement accessible slices, and verify affected flows in a real browser.',
    workMode: 'FEATURE', stages: ['frame', 'spec', 'design', 'plan', 'work', 'qa', 'review', 'verify', 'learn', 'archive'], optionalStages: ['research', 'ship', 'canary'],
    requiredArtifacts: ['intent.md', 'spec.md', 'design.md', 'tasks.yaml'], gates: ['Interaction states are defined', 'Accessibility expectations are explicit', 'Browser evidence follows project policy rather than global magic thresholds'],
    requiredEvidence: ['component-tests', 'browser-qa', 'accessibility-check'], signals: ['ui', 'ux', 'page', 'component', 'frontend', 'react', 'browser'], risk: 'P2', defaultImpact: { frontend: true },
  },
  {
    id: 'quality-hardening', label: 'Quality hardening',
    description: 'Strengthen an existing implementation through targeted review, tests, QA, and evidence without inventing new product scope.',
    workMode: 'QUALITY', stages: ['research', 'review', 'verify', 'learn'], optionalStages: ['qa', 'plan', 'work', 'reconcile'], requiredArtifacts: ['research.md'],
    gates: ['Quality findings are tied to an explicit contract or observed behavior', 'Fixes remain within the hardening scope'], requiredEvidence: ['review', 'tests'],
    signals: ['quality hardening', 'hardening', 'test coverage', 'pre release review', 'stabilize'], risk: 'P2',
  },
  {
    id: 'shared-library', label: 'Shared SDK or library',
    description: 'Design public interfaces first, preserve compatibility, verify consumers, and publish a traceable artifact.',
    workMode: 'FEATURE', stages: ['research', 'spec', 'design', 'review', 'plan', 'work', 'verify', 'ship', 'learn', 'archive'], optionalStages: ['model', 'reconcile'],
    requiredArtifacts: ['research.md', 'spec.md', 'design.md', 'contract.md', 'tasks.yaml', 'delivery.md'], gates: ['Public API is explicit', 'Compatibility policy is defined', 'Consumer impact is verified'],
    requiredEvidence: ['api-compatibility', 'consumer-tests', 'package-build'], signals: ['sdk', 'library', 'package', 'public api', 'shared module'], risk: 'P1', riskDimensions: { compatibility: 'HIGH' }, defaultImpact: { apiContract: true },
  },
  {
    id: 'emergency-hotfix', label: 'Emergency hotfix',
    description: 'Use a reduced but explicit gate: triage, reproduce, confirm root cause, make the smallest reversible fix, verify, review waivers, and assess delivery readiness.',
    workMode: 'INCIDENT', stages: ['triage', 'reproduce', 'debug', 'fix', 'work', 'verify', 'review', 'ship', 'learn'], optionalStages: ['research', 'experiment', 'reconcile'],
    requiredArtifacts: ['issue.md', 'issue.yaml', 'fix.md', 'tasks.yaml', 'delivery.md'], gates: ['Scope is minimal', 'Waived checks are recorded', 'Post-release follow-up is mandatory'],
    requiredEvidence: ['reproduction', 'focused-regression', 'smoke-test', 'production-health'], signals: ['hotfix', 'urgent fix', 'emergency patch', 'production bug now'], risk: 'P0',
    riskDimensions: { businessCriticality: 'CRITICAL', operational: 'CRITICAL' }, defaultImpact: { backend: true, observability: true },
  },
  {
    id: 'incident-response', label: 'Production incident response',
    description: 'Mitigate customer impact first, preserve evidence, find root cause, apply a bounded correction, verify recovery, and require a postmortem.',
    workMode: 'INCIDENT', stages: ['mitigate', 'research', 'debug', 'fix', 'work', 'verify', 'review', 'ship', 'learn'], optionalStages: ['reconcile'],
    requiredArtifacts: ['issue.md', 'issue.yaml', 'research.md', 'fix.md', 'tasks.yaml', 'delivery.md'], gates: ['Mitigation and root-cause correction are recorded separately', 'Emergency changes require explicit delivery approval'],
    requiredEvidence: ['incident-timeline', 'recovery-check', 'production-health', 'postmortem'], signals: ['production outage', 'customer impact', 'incident', 'production down', 'outage', 'sev'], risk: 'P0',
    riskDimensions: { businessCriticality: 'CRITICAL', operational: 'CRITICAL' }, defaultImpact: { observability: true },
  },
  {
    id: 'release-failure', label: 'Release or deployment failure',
    description: 'Pause promotion, inspect delivery evidence, choose rollback or forward-fix, and verify environment health.',
    workMode: 'RELEASE', stages: ['mitigate', 'research', 'debug', 'reconcile', 'fix', 'work', 'verify', 'review', 'ship', 'learn'], optionalStages: [],
    requiredArtifacts: ['issue.md', 'issue.yaml', 'research.md', 'fix.md', 'tasks.yaml', 'delivery.md'], gates: ['Promotion is paused before investigation', 'Rollback capability is checked instead of assumed'],
    requiredEvidence: ['deployment-logs', 'rollback-or-forward-fix-result', 'environment-health'], signals: ['deployment failed', 'release failed', 'rollback', 'canary failed', 'ci/cd'], risk: 'P0',
    riskDimensions: { operational: 'CRITICAL', reversibility: 'HIGH' }, defaultImpact: { observability: true },
  },
  {
    id: 'technical-experiment', label: 'Technical experiment',
    description: 'Compare uncertain approaches with explicit candidates, one-variable trials, measurable evidence, cleanup, and a bounded conclusion.',
    workMode: 'EXPERIMENT', stages: ['research', 'design', 'experiment', 'review', 'verify', 'learn'], optionalStages: ['plan', 'work', 'reconcile'],
    requiredArtifacts: ['research.md', 'design.md'], gates: ['Question and success metrics are explicit', 'Candidates are compared under equivalent conditions', 'Experiment code does not silently become production code'],
    requiredEvidence: ['experiment-results', 'comparison', 'decision-rationale'], signals: ['technical experiment', 'compare queue versus polling', 'compare approaches', 'spike', 'proof of concept', 'poc'], risk: 'P2',
  },
];

const scenarioMap = new Map(SCENARIOS.map((scenario) => [scenario.id, scenario]));

const LEGACY_ALIASES: Readonly<Record<string, string>> = {
  'read-only-query': 'system-query',
  'production-incident': 'incident-response',
  'domain-feature': 'complex-domain-feature',
  'architecture-evolution': 'architecture-governance',
  'frontend-feature': 'ui-ux-feature',
  'new-product': 'product-discovery',
  'sdk-library': 'shared-library',
  'security-change': 'architecture-governance',
};

export function getScenario(id: string): ScenarioProfile {
  const canonicalId = LEGACY_ALIASES[id] ?? id;
  const scenario = scenarioMap.get(canonicalId);
  if (!scenario) throw new Error(`Unknown scenario '${id}'. Run 'omnai scenario list' to see available profiles.`);
  return scenario;
}

export function detectScenario(input: string): ScenarioProfile {
  const normalized = input.toLowerCase();
  const scored = SCENARIOS.map((scenario) => ({
    scenario,
    score: scenario.signals.reduce((total, signal) => total + (normalized.includes(signal.toLowerCase()) ? signal.length : 0), 0),
  })).sort((left, right) => right.score - left.score);
  const best = scored[0];
  return best && best.score > 0 ? best.scenario : getScenario('small-feature');
}

export function listScenarios(): readonly ScenarioProfile[] {
  return SCENARIOS;
}
