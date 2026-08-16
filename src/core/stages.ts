import { createHash, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import type { Capability, ChangeMetadata, StageRunManifest } from '../domain/types.js';
import { loadProtocolBundle, repositoryProtocolId } from '../protocols/index.js';
import { changeArtifactPath, changeRunsRoot, projectKnowledgeRoot } from './paths.js';
import { appendJsonLine, ensureDir, pathExists, readText, writeTextAtomic, writeYaml } from './files.js';
import type { ChangeRef } from './store.js';
import { markReadiness } from './store.js';
import { capabilityPrompt } from './prompts.js';
import { loadTasks } from './tasks.js';
import { getScenario } from './scenarios.js';
import { buildEvidenceMatrix, selectReviewLenses } from './policy.js';
import { deliveryTemplate, designTemplate, domainTemplate, emptyTaskFile, fixTemplate, intentTemplate, issueTemplate, researchTemplate, specTemplate } from './templates.js';
import { validateReviewRecord } from './review.js';

interface StageDefinition {
  outputs: string[];
  readiness?: keyof ChangeMetadata['readiness'];
  context: string[];
  outputContract: string;
}

const STAGES: Record<Capability, StageDefinition> = {
  frame: { outputs: ['intent.md'], readiness: 'frame', context: ['intent.md'], outputContract: 'Update intent.md with target user, problem, demand evidence, narrowest wedge, success signals, scope, and non-goals.' },
  research: { outputs: ['research.md'], readiness: 'research', context: ['intent.md', 'research.md'], outputContract: 'Update research.md. Every load-bearing finding must cite repository paths and line ranges. Separate facts, assumptions, open questions, and historical lineage when the scenario requires it.' },
  map: { outputs: ['map.yaml'], readiness: 'map', context: ['intent.md', 'research.md', 'map.yaml'], outputContract: 'Write map.yaml with destination, decisions.resolved, decisions.frontier, decisions.blocked, fog, and outOfScope.' },
  model: { outputs: ['domain.md'], readiness: 'domain', context: ['intent.md', 'research.md', 'domain.md'], outputContract: 'Update domain.md with canonical terms, actors, entities, lifecycle, boundaries, invariants, edge cases, resolved decisions, open decisions, and ADR candidates.' },
  spec: { outputs: ['spec.md'], readiness: 'spec', context: ['intent.md', 'research.md', 'domain.md', 'contract.md', 'spec.md'], outputContract: 'Update spec.md with added/modified/removed/preserved requirements, stable acceptance criteria, compatibility, migration expectations, non-goals, and open questions.' },
  design: { outputs: ['design.md'], readiness: 'design', context: ['intent.md', 'research.md', 'domain.md', 'spec.md', 'contract.md', 'design.md'], outputContract: 'Update design.md with approaches, recommendation, components, contracts, data flow, state, failure handling, security, observability, tests, delivery, rollback, and risks. Keep contract.md aligned when a boundary changes.' },
  plan: { outputs: ['tasks.yaml'], readiness: 'plan', context: ['research.md', 'domain.md', 'spec.md', 'contract.md', 'design.md', 'fix.md', 'tasks.yaml'], outputContract: 'Update tasks.yaml using schemaVersion 1, the active revision, generatedFrom, and dependency-ordered tasks with IDs TASK-001 onward. Every task must be independently verifiable.' },
  triage: { outputs: ['issue.md'], readiness: 'triage', context: ['intent.md', 'research.md', 'issue.md', 'issue.yaml'], outputContract: 'Update issue.md and issue.yaml with triage state, missing information, severity, affected scope, expected versus actual behavior, reproduction status, and the justified next state. Do not edit production code.' },
  reproduce: { outputs: ['issue.md'], readiness: 'reproduction', context: ['intent.md', 'issue.md', 'issue.yaml'], outputContract: 'Update issue.md and issue.yaml with exact reproduction conditions, steps, expected behavior, actual behavior, and evidence, or a concrete instrumentation plan if deterministic reproduction is not yet possible.' },
  debug: { outputs: ['issue.md'], readiness: 'diagnosis', context: ['issue.md', 'issue.yaml', 'research.md'], outputContract: 'Update issue.md and issue.yaml with boundary trace, hypotheses tested, evidence, and a confirmed root cause. Do not propose or apply production edits until root cause is confirmed.' },
  diagnose: { outputs: ['research.md'], readiness: 'diagnosis', context: ['research.md'], outputContract: 'Add Root Cause Analysis to research.md with evidence, data-flow trace, hypotheses tested, and the identified source rather than only the symptom.' },
  experiment: { outputs: ['experiments/'], readiness: 'experiment', context: ['issue.md', 'issue.yaml', 'research.md', 'domain.md', 'spec.md', 'design.md'], outputContract: 'Create one experiment record per candidate with question, metric, setup, one-variable change, result, evidence, cleanup, and conclusion. Preserve failed attempts; do not silently promote experiment code.' },
  fix: { outputs: ['fix.md'], readiness: 'fix', context: ['issue.md', 'issue.yaml', 'research.md', 'experiments/', 'fix.md'], outputContract: 'Update fix.md with confirmed root cause, chosen minimal fix, rejected alternatives, regression guard, compatibility impact, scope, and rollback or recovery.' },
  mitigate: { outputs: ['research.md'], readiness: 'mitigation', context: ['intent.md', 'research.md'], outputContract: 'Record mitigation actions, reversibility, side effects, remaining impact, and evidence in research.md.' },
  work: { outputs: ['progress.jsonl'], readiness: 'implementation', context: ['spec.md', 'contract.md', 'design.md', 'fix.md', 'tasks.yaml'], outputContract: 'Implement only the selected task and append execution status through the OmnAI CLI. Do not rewrite progress.jsonl manually.' },
  simplify: { outputs: ['progress.jsonl'], context: ['design.md', 'tasks.yaml'], outputContract: 'Simplify the selected diff without behavior change, then record verification evidence.' },
  review: { outputs: ['evidence/review.json'], readiness: 'review', context: ['intent.md', 'research.md', 'domain.md', 'spec.md', 'contract.md', 'design.md', 'fix.md', 'tasks.yaml'], outputContract: 'Create structured independent review evidence. Separately report specification compliance and findings from only the review lenses selected for this change.' },
  verify: { outputs: ['evidence/'], readiness: 'verification', context: ['spec.md', 'contract.md', 'design.md', 'fix.md', 'tasks.yaml', 'delivery.md'], outputContract: 'Gather fresh evidence for every required Evidence Matrix item and record PASS, FAIL, or INCONCLUSIVE results using stable requirement IDs.' },
  qa: { outputs: ['evidence/qa.json'], readiness: 'qa', context: ['spec.md', 'design.md'], outputContract: 'Record browser or experience QA evidence only when UI impact or project policy requires it. Use project-defined viewports and budgets rather than global constants.' },
  ship: { outputs: ['delivery.md'], readiness: 'release', context: ['spec.md', 'contract.md', 'design.md', 'tasks.yaml', 'delivery.md'], outputContract: 'Update delivery.md with artifact identity, satisfied gates, rollout strategy, rollback/forward-fix capability, activation plan, post-release signals, and human approval. Return readiness; do not deploy directly.' },
  release: { outputs: ['evidence/release.json'], readiness: 'release', context: ['spec.md', 'design.md', 'tasks.yaml', 'delivery.md'], outputContract: 'Legacy release evidence: record artifact identity, environment, approval, strategy, rollout result, rollback capability, and runtime verification.' },
  canary: { outputs: ['evidence/canary.json'], readiness: 'canary', context: ['spec.md', 'design.md', 'delivery.md'], outputContract: 'Record observation window, thresholds, technical metrics, business metrics, anomalies, and continue/pause/rollback decision.' },
  learn: { outputs: ['learning.md'], readiness: 'learning', context: ['research.md', 'domain.md', 'spec.md', 'design.md', 'fix.md', 'learning.md'], outputContract: 'Write learning.md for one validated learning with problem, context, root cause, solution, evidence, applicability, limitations, source revision, and invalidation conditions.' },
  archive: { outputs: ['change.yaml'], context: ['intent.md', 'research.md', 'domain.md', 'spec.md', 'contract.md', 'design.md', 'tasks.yaml', 'delivery.md'], outputContract: 'Confirm the canonical artifacts and evidence agree before marking the change archived.' },
  reconcile: { outputs: ['revisions/'], context: ['intent.md', 'research.md', 'domain.md', 'spec.md', 'contract.md', 'design.md', 'fix.md', 'tasks.yaml', 'delivery.md'], outputContract: 'Create a revision through omnai reconcile. Preserve the previous revision and baseline; do not silently overwrite them.' },
};

export interface PreparedStage { manifest: StageRunManifest; runDirectory: string; promptPath: string; }
export interface PrepareStageOptions { protocolRoot?: string; }

export async function prepareStage(
  repoRoot: string,
  change: ChangeRef,
  capability: Capability,
  instruction: string,
  options: PrepareStageOptions = {},
): Promise<PreparedStage> {
  const definition = STAGES[capability];

  // Protocol and prompt preparation is deliberately mutation-free. A missing or
  // invalid protocol must not leave a partial run, progress event, or readiness change.
  const protocols = await loadProtocolBundle(
    [repositoryProtocolId(capability)],
    options.protocolRoot,
  );

  const contextEntries: Array<{ path: string; content: string }> = [];
  for (const artifact of definition.context) {
    if (artifact.endsWith('/')) continue;
    const path = changeArtifactPath(repoRoot, change.directoryName, artifact);
    if (await pathExists(path)) contextEntries.push({ path: relative(repoRoot, path), content: await readText(path) });
  }
  for (const projectFile of ['glossary.md', 'policies.md', 'learnings.md']) {
    const path = join(projectKnowledgeRoot(repoRoot), projectFile);
    if (await pathExists(path)) contextEntries.push({ path: relative(repoRoot, path), content: await readText(path) });
  }

  const scenario = getScenario(change.metadata.scenario);
  const policy = policyGuidance(capability, change, scenario);
  const outputPaths = definition.outputs.map((output) => relative(repoRoot, changeArtifactPath(repoRoot, change.directoryName, output)));
  const runId = `RUN-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const runDirectory = join(changeRunsRoot(repoRoot, change.directoryName), runId);
  const promptPath = join(runDirectory, 'prompt.md');
  const prompt = `${capabilityPrompt(capability, instruction, definition.outputContract, protocols)}\nScenario policy:\n${policy}\n\nAuthoritative context:\n${contextEntries
    .map((entry) => `\n---\nSOURCE: ${entry.path}\n${entry.content}`).join('\n')}\n\nCanonical outputs:\n${outputPaths.map((path) => `- ${path}`).join('\n')}\n`;
  const now = new Date().toISOString();
  const manifest: StageRunManifest = {
    schemaVersion: 2,
    id: runId,
    changeId: change.metadata.id,
    revision: change.metadata.activeRevision,
    capability,
    status: 'PREPARED',
    instruction,
    promptPath: relative(repoRoot, promptPath),
    promptHash: sha256(prompt),
    protocols: protocols.protocols.map(({ id, version, hash }) => ({ id, version, hash })),
    outputPaths,
    createdAt: now,
  };

  await ensureDir(runDirectory);
  await writeTextAtomic(promptPath, prompt);
  await writeYaml(join(runDirectory, 'run.yaml'), manifest);
  await appendJsonLine(changeArtifactPath(repoRoot, change.directoryName, 'progress.jsonl'), {
    timestamp: now,
    event: 'CAPABILITY_PREPARED',
    changeId: change.metadata.id,
    revision: change.metadata.activeRevision,
    runId,
    data: {
      capability,
      prompt: manifest.promptPath,
      promptHash: manifest.promptHash,
      protocols: manifest.protocols,
    },
  });
  if (definition.readiness) await markReadiness(repoRoot, change, definition.readiness, 'IN_PROGRESS');
  return { manifest, runDirectory, promptPath };
}

export async function completeStage(repoRoot: string, change: ChangeRef, capability: Capability): Promise<void> {
  const definition = STAGES[capability];
  const scenario = getScenario(change.metadata.scenario);
  for (const output of definition.outputs) {
    const path = changeArtifactPath(repoRoot, change.directoryName, output);
    if (output.endsWith('/')) {
      if (!(await pathExists(path))) throw new Error(`Required output '${output}' is missing`);
      const entries = await readdir(path, { withFileTypes: true });
      if (!entries.some((entry) => entry.isFile())) throw new Error(`Required ${capability} output directory '${output}' contains no experiment record`);
      continue;
    }
    if (!(await pathExists(path))) throw new Error(`Required output '${output}' is missing`);
    const content = await readText(path);
    if (!content.trim()) throw new Error(`Required output '${output}' is empty`);
    const scaffold = initialScaffold(output, change, scenario);
    if (scaffold !== null && content.trim() === scaffold.trim()) {
      throw new Error(`Required output '${output}' is still the unchanged scaffold and is incomplete`);
    }
    if (capability === 'review' && output === 'evidence/review.json') {
      validateReviewRecord(
        content,
        change.metadata.id,
        change.metadata.activeRevision,
        selectReviewLenses(scenario, change.metadata.risk, change.metadata.impact),
      );
    }
  }
  if (capability === 'plan') {
    const taskFile = await loadTasks(changeArtifactPath(repoRoot, change.directoryName, 'tasks.yaml'));
    if (scenario.stages.includes('work') && taskFile.tasks.length === 0) throw new Error('Plan is incomplete: no implementation tasks were defined');
  }
  if (definition.readiness) await markReadiness(repoRoot, change, definition.readiness, 'READY');
  await appendJsonLine(changeArtifactPath(repoRoot, change.directoryName, 'progress.jsonl'), {
    timestamp: new Date().toISOString(), event: 'CAPABILITY_COMPLETED', changeId: change.metadata.id,
    revision: change.metadata.activeRevision, detail: capability,
  });
}

function initialScaffold(output: string, change: ChangeRef, scenario: ReturnType<typeof getScenario>): string | null {
  switch (output) {
    case 'intent.md': return intentTemplate(change.metadata.title, scenario);
    case 'research.md': return researchTemplate;
    case 'domain.md': return domainTemplate;
    case 'spec.md': return specTemplate;
    case 'design.md': return designTemplate;
    case 'issue.md': return issueTemplate;
    case 'fix.md': return fixTemplate;
    case 'delivery.md': return deliveryTemplate;
    case 'tasks.yaml': return emptyTaskFile;
    default: return null;
  }
}

export function outputContract(capability: Capability): string { return STAGES[capability].outputContract; }
export function stageOutputs(capability: Capability): string[] { return [...STAGES[capability].outputs]; }
export function shortRunSummary(prepared: PreparedStage): string {
  return [`Run: ${prepared.manifest.id}`, `Capability: ${prepared.manifest.capability}`, `Prompt: ${prepared.manifest.promptPath}`, `Outputs: ${prepared.manifest.outputPaths.map((path) => basename(path)).join(', ')}`].join('\n');
}

function policyGuidance(capability: Capability, change: ChangeRef, scenario: ReturnType<typeof getScenario>): string {
  const base = [
    `Scenario: ${scenario.id}`,
    `Risk: ${change.metadata.risk.level}`,
    `Impact: ${JSON.stringify(change.metadata.impact)}`,
    `Human gates: ${scenario.gates.join(' | ')}`,
  ];
  if (capability === 'review') base.push(`Required review lenses: ${selectReviewLenses(scenario, change.metadata.risk, change.metadata.impact).join(', ')}`);
  if (capability === 'verify' || capability === 'ship') {
    const matrix = buildEvidenceMatrix(scenario, change.metadata.risk, change.metadata.impact);
    base.push('Evidence Matrix:');
    for (const item of matrix) base.push(`- ${item.id}: ${item.required ? 'REQUIRED' : 'OPTIONAL'} — ${item.because}`);
  }
  return base.join('\n');
}

function sha256(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}
