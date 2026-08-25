import { join } from 'node:path';
import {
  changeMetadataSchema,
  flowPlanSchema,
  revisionSchema,
  type Capability,
  type ChangeMetadata,
  type DecisionRecord,
  type FlowPlan,
  type ScenarioProfile,
  type SourceRef,
} from '../domain/types.js';
import { hashCanonicalArtifact } from './canonical-hash-internal.js';
import { persistChangeMetadataWithinChangeLock } from './change-metadata-internal.js';
import { appendJsonLine, readYaml, writeYaml } from './files.js';
import { compileFlowPlan, createInitialFlowAssessment, flowInputHash, hashFlowPlan } from './flow.js';
import {
  changeArtifactPath,
  changeFlowPath,
  changeMetadataPath,
  changeRevisionsRoot,
} from './paths.js';
import { getScenario } from './scenarios.js';
import type { ChangeRef } from './store.js';

const READINESS_FOR_CAPABILITY: Partial<Record<Capability, keyof ChangeMetadata['readiness']>> = {
  frame: 'frame', research: 'research', map: 'map', model: 'domain', spec: 'spec', design: 'design',
  plan: 'plan', triage: 'triage', reproduce: 'reproduction', debug: 'diagnosis', diagnose: 'diagnosis',
  experiment: 'experiment', fix: 'fix', mitigate: 'mitigation', work: 'implementation', review: 'review',
  verify: 'verification', qa: 'qa', ship: 'release', canary: 'canary', learn: 'learning',
};

export interface PreparedFlowMutation {
  active: ChangeMetadata;
  source: FlowPlan | null;
  target: FlowPlan | null;
}

/** @internal Read-only compiler for a journal owner; it never persists a target. */
export async function prepareInitialFlowMutationWithinChangeLock(
  repoRoot: string,
  change: ChangeRef,
  decisions: readonly DecisionRecord[],
  compiledAt: string,
): Promise<PreparedFlowMutation> {
  const active = await requireActiveChange(repoRoot, change);
  const source = await readStoredFlowPlan(repoRoot, change);
  if (source) {
    validateFlowPlan(source, active, getScenario(active.scenario), true);
    return { active, source, target: source };
  }
  return {
    active,
    source,
    target: compileInitialPlan(active, getScenario(active.scenario), decisions, compiledAt),
  };
}

/** @internal Read-only compiler for a journal owner; it never persists a target. */
export async function prepareSynchronizedFlowMutationWithinChangeLock(
  repoRoot: string,
  change: ChangeRef,
  decisions: readonly DecisionRecord[],
  compiledAt: string,
): Promise<PreparedFlowMutation> {
  const active = await requireActiveChange(repoRoot, change);
  const source = await readStoredFlowPlan(repoRoot, change);
  if (!source) return { active, source, target: null };
  validateFlowPlan(source, active, getScenario(active.scenario), true);
  return {
    active,
    source,
    target: compileFlowPlan(active, getScenario(active.scenario), source.assessment, decisions, compiledAt),
  };
}

/** @internal Read-only compiler for a journal owner; it never persists a target. */
export async function prepareReboundFlowMutationWithinChangeLock(
  repoRoot: string,
  change: ChangeRef,
  decisions: readonly DecisionRecord[],
  compiledAt: string,
): Promise<PreparedFlowMutation> {
  const active = await requireActiveChange(repoRoot, change);
  const source = await readStoredFlowPlan(repoRoot, change);
  if (!source) return { active, source, target: null };
  if (source.revision === active.activeRevision && source.baseline === active.baseline) {
    validateFlowPlan(source, active, getScenario(active.scenario), true);
  } else {
    const sourceScenario = scenarioFromStablePolicySource(source);
    if (!sourceScenario) throw new Error('FLOW_STALE_REVISION: prior FlowPlan was not preflighted');
    validateFlowPlan(
      source,
      { ...active, activeRevision: source.revision, baseline: source.baseline },
      sourceScenario,
      true,
    );
  }
  await assertRevisionLineage(repoRoot, change, source, active);
  return {
    active,
    source,
    target: compileFlowPlan(active, getScenario(active.scenario), source.assessment, decisions, compiledAt),
  };
}

/** @internal Derives the exact metadata side of a frozen Flow target. */
export function metadataForPreparedFlowMutation(
  source: ChangeMetadata,
  previous: FlowPlan | null,
  next: FlowPlan | null,
  mode: 'ACTIVE' | 'NEWLY_ACTIVE' | 'NONE',
  updatedAt: string,
): ChangeMetadata {
  if (!next || mode === 'NONE') return source;
  const target = structuredClone(source);
  const previousActive = new Set(
    mode === 'ACTIVE' || !previous
      ? []
      : previous.capabilities.filter(({ active }) => active).map(({ capability }) => capability),
  );
  let changed = false;
  for (const capability of next.capabilities) {
    if (!capability.active || previousActive.has(capability.capability)) continue;
    const readiness = READINESS_FOR_CAPABILITY[capability.capability];
    if (readiness && target.readiness[readiness] === 'NOT_APPLICABLE') {
      target.readiness[readiness] = 'MISSING';
      changed = true;
    }
  }
  return changed ? changeMetadataSchema.parse({ ...target, updatedAt }) : source;
}

/** @internal Read-only load used by the guarded public facade and transaction owners. */
export async function loadFlowPlanInternal(repoRoot: string, change: ChangeRef): Promise<FlowPlan | null> {
  const active = await requireActiveChange(repoRoot, change);
  const plan = await readStoredFlowPlan(repoRoot, change);
  if (!plan) return null;
  validateFlowPlan(plan, active, getScenario(active.scenario), true);
  return plan;
}

/** @internal Caller owns the exact Change lock and all three transaction fences. */
export async function createInitialFlowPlanWithinChangeLock(
  repoRoot: string,
  change: ChangeRef,
  decisions: readonly DecisionRecord[],
): Promise<FlowPlan> {
  const active = await requireActiveChange(repoRoot, change);
  const existing = await readStoredFlowPlan(repoRoot, change);
  if (existing) {
    validateFlowPlan(existing, active, getScenario(active.scenario), true);
    return existing;
  }
  const scenario = getScenario(active.scenario);
  const plan = compileInitialPlan(active, scenario, decisions, new Date().toISOString());
  change.metadata = active;
  if (enableActiveReadiness(change, plan)) await persistChangeMetadata(repoRoot, change);
  await persistFlowPlan(repoRoot, change, plan);
  return plan;
}

/** @internal Caller owns the exact Change lock and a terminal-authorized Decision transition. */
export async function synchronizeFlowDecisionsWithinChangeLock(
  repoRoot: string,
  change: ChangeRef,
  decisions: readonly DecisionRecord[],
): Promise<FlowPlan | null> {
  const active = await requireActiveChange(repoRoot, change);
  const current = await readStoredFlowPlan(repoRoot, change);
  if (!current) return null;
  const scenario = getScenario(active.scenario);
  validateFlowPlan(current, active, scenario, true);
  const candidate = compileFlowPlan(active, scenario, current.assessment, decisions, new Date().toISOString());
  if (candidate.inputHash === current.inputHash) return current;
  change.metadata = active;
  if (enableNewlyActiveReadiness(change, current, candidate)) await persistChangeMetadata(repoRoot, change);
  await persistFlowPlan(repoRoot, change, candidate);
  await appendFlowEvent(repoRoot, change, 'FLOW_DECISIONS_SYNCHRONIZED', 'Synchronized FlowPlan decision inputs', {
    baseline: active.baseline,
    previousInputHash: current.inputHash,
    inputHash: candidate.inputHash,
    decisionIds: candidate.decisionIds,
  });
  return candidate;
}

/** @internal Caller owns the exact Change lock and all three transaction fences. */
export async function rebindFlowPlanForRevisionWithinChangeLock(
  repoRoot: string,
  change: ChangeRef,
  decisions: readonly DecisionRecord[],
): Promise<FlowPlan | null> {
  const active = await requireActiveChange(repoRoot, change);
  const stored = await readStoredFlowPlan(repoRoot, change);
  if (!stored) return null;
  if (stored.revision === active.activeRevision && stored.baseline === active.baseline) {
    validateFlowPlan(stored, active, getScenario(active.scenario), true);
  } else {
    const storedScenario = scenarioFromStablePolicySource(stored);
    if (!storedScenario) throw new Error('FLOW_STALE_REVISION: prior FlowPlan was not preflighted');
    validateFlowPlan(
      stored,
      { ...active, activeRevision: stored.revision, baseline: stored.baseline },
      storedScenario,
      true,
    );
  }
  return compileAndPersistRebound(repoRoot, change, decisions, stored, active);
}

/** @internal Reconcile passes the exact FlowPlan validated by its owning transaction. */
export async function rebindPreflightedFlowPlanForRevisionWithinChangeLock(
  repoRoot: string,
  change: ChangeRef,
  decisions: readonly DecisionRecord[],
  preflightPlan: FlowPlan | null,
  compiledAt = new Date().toISOString(),
): Promise<FlowPlan | null> {
  const active = await requireActiveChange(repoRoot, change);
  const stored = await readStoredFlowPlan(repoRoot, change);
  if (!preflightPlan) {
    if (stored) throw new Error('FLOW_INTEGRITY_MISMATCH: legacy preflight gained a FlowPlan');
    return null;
  }
  if (!stored) throw new Error('FLOW_INTEGRITY_MISMATCH: preflight FlowPlan disappeared');
  if (hashFlowPlan(stored) !== hashFlowPlan(preflightPlan)) {
    throw new Error('FLOW_INTEGRITY_MISMATCH: FlowPlan changed after Reconcile preflight');
  }
  assertInputIntegrity(stored);
  return compileAndPersistRebound(repoRoot, change, decisions, stored, active, compiledAt);
}

/** @internal Accepts only the owning transaction's archived plan or its valid active rebound. */
export async function loadFlowPlanForTransactionRecoveryWithinChangeLock(
  repoRoot: string,
  change: ChangeRef,
  active: ChangeMetadata,
  oldPlan: FlowPlan,
): Promise<FlowPlan> {
  const stored = await readStoredFlowPlan(repoRoot, change);
  if (!stored) throw new Error('FLOW_TRANSACTION_ACTIVE_PLAN_MISSING');
  const scenario = getScenario(active.scenario);
  if (stored.revision === oldPlan.revision && stored.baseline === oldPlan.baseline) {
    validateFlowPlan(
      stored,
      { ...active, activeRevision: oldPlan.revision, baseline: oldPlan.baseline },
      scenario,
      true,
    );
    if (hashFlowPlan(stored) !== hashFlowPlan(oldPlan)) throw new Error('FLOW_TRANSACTION_OLD_PLAN_MISMATCH');
    return stored;
  }
  validateFlowPlan(stored, active, scenario, true);
  return stored;
}

async function compileAndPersistRebound(
  repoRoot: string,
  change: ChangeRef,
  decisions: readonly DecisionRecord[],
  stored: FlowPlan,
  active: ChangeMetadata,
  compiledAt = new Date().toISOString(),
): Promise<FlowPlan> {
  await assertRevisionLineage(repoRoot, change, stored, active);
  const candidate = compileFlowPlan(active, getScenario(active.scenario), stored.assessment, decisions, compiledAt);
  if (candidate.inputHash === stored.inputHash) return stored;
  await persistFlowPlan(repoRoot, change, candidate);
  return candidate;
}

function compileInitialPlan(
  metadata: ChangeMetadata,
  scenario: ScenarioProfile,
  decisions: readonly DecisionRecord[],
  compiledAt: string,
): FlowPlan {
  const assessment = createInitialFlowAssessment(metadata, scenario, [scenarioSourceRef(metadata, scenario)]);
  return compileFlowPlan(metadata, scenario, assessment, decisions, compiledAt);
}

/** @internal Pure replay helper for completed semantic-mutation lineage. */
export function compileInitialFlowPlanForMutation(
  metadata: ChangeMetadata,
  decisions: readonly DecisionRecord[],
  compiledAt: string,
): FlowPlan {
  const scenario = getScenario(metadata.scenario);
  return compileInitialPlan(metadata, scenario, decisions, compiledAt);
}

function scenarioSourceRef(metadata: ChangeMetadata, scenario: ScenarioProfile): SourceRef {
  return {
    kind: 'policy',
    scenarioId: scenario.id,
    contentHash: hashCanonicalArtifact({
      scenario: metadata.scenario,
      workMode: metadata.workMode,
      risk: metadata.risk,
      impact: metadata.impact,
    }),
  };
}

async function readStoredFlowPlan(repoRoot: string, change: ChangeRef): Promise<FlowPlan | null> {
  try {
    return await readYaml(changeFlowPath(repoRoot, change.directoryName), flowPlanSchema);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function validateFlowPlan(
  plan: FlowPlan,
  active: ChangeMetadata,
  scenario: ScenarioProfile,
  requireActiveBinding: boolean,
): void {
  if (plan.changeId !== active.id) throw new Error(`FLOW_CHANGE_MISMATCH: ${plan.changeId}`);
  if (requireActiveBinding && plan.revision !== active.activeRevision) {
    throw new Error(`FLOW_STALE_REVISION: expected ${active.activeRevision}, received ${plan.revision}`);
  }
  if (requireActiveBinding && plan.baseline !== active.baseline) {
    throw new Error(`FLOW_STALE_BASELINE: expected ${active.baseline}, received ${plan.baseline}`);
  }
  assertInputIntegrity(plan);
  assertScenarioFloor(plan, scenario);
}

function assertInputIntegrity(plan: FlowPlan): void {
  if (flowInputHash(plan) !== plan.inputHash) throw new Error('FLOW_INTEGRITY_MISMATCH: inputHash');
}

function assertScenarioFloor(plan: FlowPlan, scenario: ScenarioProfile): void {
  const capabilities = new Map(plan.capabilities.map((entry) => [entry.capability, entry]));
  for (const required of scenario.stages) {
    const capability = capabilities.get(required);
    if (!capability || capability.disposition !== 'REQUIRED' || !capability.active) {
      throw new Error(`FLOW_SCENARIO_FLOOR_VIOLATION: ${required}`);
    }
  }
}

async function requireActiveChange(repoRoot: string, change: ChangeRef): Promise<ChangeMetadata> {
  const active = await readYaml(changeMetadataPath(repoRoot, change.directoryName), changeMetadataSchema);
  if (active.id !== change.metadata.id) throw new Error('FLOW_STALE_CHANGE');
  if (active.activeRevision !== change.metadata.activeRevision) throw new Error('FLOW_STALE_REVISION');
  if (active.baseline !== change.metadata.baseline) throw new Error('FLOW_STALE_BASELINE');
  return active;
}

async function assertRevisionLineage(
  repoRoot: string,
  change: ChangeRef,
  stored: FlowPlan,
  active: ChangeMetadata,
): Promise<void> {
  if (stored.revision === active.activeRevision && stored.baseline === active.baseline) return;
  const revision = await readYaml(
    join(changeRevisionsRoot(repoRoot, change.directoryName), `${active.activeRevision}.yaml`),
    revisionSchema,
  );
  if (revision.changeId !== active.id || revision.previousRevision !== stored.revision) {
    throw new Error('FLOW_STALE_REVISION: FlowPlan is not the immediate revision predecessor');
  }
  if (revision.previousBaseline !== stored.baseline || revision.baseline !== active.baseline) {
    throw new Error('FLOW_STALE_BASELINE: FlowPlan is not the immediate baseline predecessor');
  }
}

function enableActiveReadiness(change: ChangeRef, plan: FlowPlan): boolean {
  let changed = false;
  for (const capability of plan.capabilities) {
    if (!capability.active) continue;
    const readiness = READINESS_FOR_CAPABILITY[capability.capability];
    if (readiness && change.metadata.readiness[readiness] === 'NOT_APPLICABLE') {
      change.metadata.readiness[readiness] = 'MISSING';
      changed = true;
    }
  }
  return changed;
}

function enableNewlyActiveReadiness(change: ChangeRef, previous: FlowPlan, next: FlowPlan): boolean {
  const previouslyActive = new Set(
    previous.capabilities.filter(({ active }) => active).map(({ capability }) => capability),
  );
  let changed = false;
  for (const capability of next.capabilities) {
    if (!capability.active || previouslyActive.has(capability.capability)) continue;
    const readiness = READINESS_FOR_CAPABILITY[capability.capability];
    if (readiness && change.metadata.readiness[readiness] === 'NOT_APPLICABLE') {
      change.metadata.readiness[readiness] = 'MISSING';
      changed = true;
    }
  }
  return changed;
}

async function persistChangeMetadata(repoRoot: string, change: ChangeRef): Promise<void> {
  await persistChangeMetadataWithinChangeLock(repoRoot, change, change.metadata, new Date().toISOString());
}

async function persistFlowPlan(repoRoot: string, change: ChangeRef, plan: FlowPlan): Promise<void> {
  await writeYaml(changeFlowPath(repoRoot, change.directoryName), flowPlanSchema.parse(plan));
}

async function appendFlowEvent(
  repoRoot: string,
  change: ChangeRef,
  event: 'FLOW_DECISIONS_SYNCHRONIZED',
  detail: string,
  data: Record<string, unknown>,
): Promise<void> {
  await appendJsonLine(changeArtifactPath(repoRoot, change.directoryName, 'progress.jsonl'), {
    timestamp: new Date().toISOString(),
    event,
    changeId: change.metadata.id,
    revision: change.metadata.activeRevision,
    detail,
    data,
  });
}

function scenarioFromStablePolicySource(plan: FlowPlan): ScenarioProfile | null {
  const policy = plan.assessment.sourceRefs.find((sourceRef) => sourceRef.kind === 'policy');
  if (!policy) return null;
  try {
    return getScenario(policy.scenarioId);
  } catch {
    return null;
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
