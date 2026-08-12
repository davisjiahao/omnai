import { randomUUID } from 'node:crypto';
import { basename, join, relative } from 'node:path';
import type { Capability, StageRunManifest } from '../domain/types.js';
import { changeArtifactPath, changeRunsRoot, projectKnowledgeRoot } from './paths.js';
import { appendJsonLine, ensureDir, pathExists, readText, writeTextAtomic, writeYaml } from './files.js';
import type { ChangeRef } from './store.js';
import { markReadiness } from './store.js';
import { capabilityPrompt } from './prompts.js';
import { loadTasks } from './tasks.js';

interface StageDefinition {
  outputs: string[];
  readiness?: 'frame' | 'research' | 'domain' | 'spec' | 'design' | 'plan' | 'implementation' | 'verification' | 'release' | 'learning';
  context: string[];
  outputContract: string;
}

const STAGES: Record<Capability, StageDefinition> = {
  frame: {
    outputs: ['intent.md'], readiness: 'frame', context: [],
    outputContract: 'Update intent.md with target user, problem, demand evidence, narrowest wedge, success signals, scope, and non-goals.',
  },
  research: {
    outputs: ['research.md'], readiness: 'research', context: ['intent.md'],
    outputContract: 'Update research.md. Every load-bearing finding must cite repository paths and line ranges. Separate facts, assumptions, and open questions.',
  },
  map: {
    outputs: ['map.yaml'], context: ['intent.md', 'research.md'],
    outputContract: 'Write map.yaml with destination, decisions.resolved, decisions.frontier, decisions.blocked, fog, and outOfScope.',
  },
  model: {
    outputs: ['domain.md'], readiness: 'domain', context: ['intent.md', 'research.md'],
    outputContract: 'Update domain.md with canonical terms, actors, entities, lifecycle, boundaries, invariants, edge cases, resolved decisions, open decisions, and ADR candidates.',
  },
  spec: {
    outputs: ['spec.md'], readiness: 'spec', context: ['intent.md', 'research.md', 'domain.md'],
    outputContract: 'Update spec.md with added/modified/removed/preserved requirements, stable acceptance criteria, compatibility, migration expectations, non-goals, and open questions.',
  },
  design: {
    outputs: ['design.md'], readiness: 'design', context: ['intent.md', 'research.md', 'domain.md', 'spec.md'],
    outputContract: 'Update design.md with approaches, recommendation, components, contracts, data flow, state, failure handling, security, observability, tests, delivery, rollback, and risks.',
  },
  plan: {
    outputs: ['tasks.yaml'], readiness: 'plan', context: ['research.md', 'domain.md', 'spec.md', 'design.md'],
    outputContract: 'Update tasks.yaml using schemaVersion 1, the active revision, generatedFrom, and dependency-ordered tasks with IDs TASK-001 onward. Every task must be independently verifiable.',
  },
  reproduce: {
    outputs: ['research.md'], readiness: 'research', context: ['intent.md'],
    outputContract: 'Add a Reproduction section to research.md with exact conditions, steps, expected behavior, actual behavior, and evidence.',
  },
  diagnose: {
    outputs: ['research.md'], readiness: 'research', context: ['research.md'],
    outputContract: 'Add Root Cause Analysis to research.md with evidence, data-flow trace, hypotheses tested, and the identified source rather than only the symptom.',
  },
  mitigate: {
    outputs: ['research.md'], context: ['intent.md', 'research.md'],
    outputContract: 'Record mitigation actions, reversibility, side effects, remaining impact, and evidence in research.md.',
  },
  work: {
    outputs: ['progress.jsonl'], readiness: 'implementation', context: ['spec.md', 'design.md', 'tasks.yaml'],
    outputContract: 'Implement only the selected task and append execution status through the OmnAI CLI. Do not rewrite progress.jsonl manually.',
  },
  simplify: {
    outputs: ['progress.jsonl'], context: ['design.md', 'tasks.yaml'],
    outputContract: 'Simplify the selected diff without behavior change, then record verification evidence.',
  },
  review: {
    outputs: ['evidence/review.json'], context: ['spec.md', 'design.md', 'tasks.yaml'],
    outputContract: 'Create structured review evidence that separately reports specification compliance and code quality findings.',
  },
  verify: {
    outputs: ['evidence/'], readiness: 'verification', context: ['spec.md', 'design.md', 'tasks.yaml'],
    outputContract: 'Run fresh verification and record PASS, FAIL, or INCONCLUSIVE evidence using omnai verify.',
  },
  qa: {
    outputs: ['evidence/qa.json'], context: ['spec.md', 'design.md'],
    outputContract: 'Record browser or experience QA evidence, reproducible findings, affected flows, and ship-readiness.',
  },
  release: {
    outputs: ['evidence/release.json'], readiness: 'release', context: ['spec.md', 'design.md', 'tasks.yaml'],
    outputContract: 'Record artifact identity, environment, approval, strategy, rollout result, rollback capability, and runtime verification.',
  },
  canary: {
    outputs: ['evidence/canary.json'], context: ['spec.md', 'design.md'],
    outputContract: 'Record observation window, thresholds, technical metrics, business metrics, anomalies, and continue/pause/rollback decision.',
  },
  learn: {
    outputs: ['learning.md'], readiness: 'learning', context: ['research.md', 'domain.md', 'spec.md', 'design.md'],
    outputContract: 'Write learning.md for one validated learning with problem, context, root cause, solution, evidence, applicability, limitations, and invalidation conditions.',
  },
  archive: {
    outputs: ['change.yaml'], context: ['intent.md', 'research.md', 'domain.md', 'spec.md', 'design.md', 'tasks.yaml'],
    outputContract: 'Confirm the canonical artifacts and evidence agree before marking the change archived.',
  },
  reconcile: {
    outputs: ['revisions/'], context: ['intent.md', 'research.md', 'domain.md', 'spec.md', 'design.md', 'tasks.yaml'],
    outputContract: 'Create a revision through omnai reconcile. Do not silently overwrite the previous baseline.',
  },
};

export interface PreparedStage {
  manifest: StageRunManifest;
  runDirectory: string;
  promptPath: string;
}

export async function prepareStage(
  repoRoot: string,
  change: ChangeRef,
  capability: Capability,
  instruction: string,
): Promise<PreparedStage> {
  const definition = STAGES[capability];
  const runId = `RUN-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const runDirectory = join(changeRunsRoot(repoRoot, change.directoryName), runId);
  await ensureDir(runDirectory);

  const contextEntries: Array<{ path: string; content: string }> = [];
  for (const artifact of definition.context) {
    const path = changeArtifactPath(repoRoot, change.directoryName, artifact);
    if (await pathExists(path)) contextEntries.push({ path: relative(repoRoot, path), content: await readText(path) });
  }

  for (const projectFile of ['glossary.md', 'policies.md', 'learnings.md']) {
    const path = join(projectKnowledgeRoot(repoRoot), projectFile);
    if (await pathExists(path)) contextEntries.push({ path: relative(repoRoot, path), content: await readText(path) });
  }

  const outputPaths = definition.outputs.map((output) => relative(repoRoot, changeArtifactPath(repoRoot, change.directoryName, output)));
  const promptPath = join(runDirectory, 'prompt.md');
  const prompt = `${capabilityPrompt(capability, instruction, definition.outputContract)}\nAuthoritative context:\n${contextEntries
    .map((entry) => `\n---\nSOURCE: ${entry.path}\n${entry.content}`)
    .join('\n')}\n\nCanonical outputs:\n${outputPaths.map((path) => `- ${path}`).join('\n')}\n`;
  await writeTextAtomic(promptPath, prompt);

  const now = new Date().toISOString();
  const manifest: StageRunManifest = {
    schemaVersion: 1,
    id: runId,
    changeId: change.metadata.id,
    revision: change.metadata.activeRevision,
    capability,
    status: 'PREPARED',
    instruction,
    promptPath: relative(repoRoot, promptPath),
    outputPaths,
    createdAt: now,
  };
  await writeYaml(join(runDirectory, 'run.yaml'), manifest);
  await appendJsonLine(changeArtifactPath(repoRoot, change.directoryName, 'progress.jsonl'), {
    timestamp: now,
    event: 'CAPABILITY_PREPARED',
    changeId: change.metadata.id,
    revision: change.metadata.activeRevision,
    runId,
    data: { capability, prompt: manifest.promptPath },
  });
  if (definition.readiness) await markReadiness(repoRoot, change, definition.readiness, 'IN_PROGRESS');

  return { manifest, runDirectory, promptPath };
}

export async function completeStage(
  repoRoot: string,
  change: ChangeRef,
  capability: Capability,
): Promise<void> {
  const definition = STAGES[capability];
  for (const output of definition.outputs) {
    if (output.endsWith('/')) continue;
    const path = changeArtifactPath(repoRoot, change.directoryName, output);
    if (!(await pathExists(path))) throw new Error(`Required output '${output}' is missing`);
    const content = await readText(path);
    if (!content.trim()) throw new Error(`Required output '${output}' is empty`);
  }

  if (capability === 'plan') {
    await loadTasks(changeArtifactPath(repoRoot, change.directoryName, 'tasks.yaml'));
  }
  if (definition.readiness) await markReadiness(repoRoot, change, definition.readiness, 'READY');
  await appendJsonLine(changeArtifactPath(repoRoot, change.directoryName, 'progress.jsonl'), {
    timestamp: new Date().toISOString(),
    event: 'CAPABILITY_COMPLETED',
    changeId: change.metadata.id,
    revision: change.metadata.activeRevision,
    detail: capability,
  });
}

export function outputContract(capability: Capability): string {
  return STAGES[capability].outputContract;
}

export function stageOutputs(capability: Capability): string[] {
  return [...STAGES[capability].outputs];
}

export function shortRunSummary(prepared: PreparedStage): string {
  return [
    `Run: ${prepared.manifest.id}`,
    `Capability: ${prepared.manifest.capability}`,
    `Prompt: ${prepared.manifest.promptPath}`,
    `Outputs: ${prepared.manifest.outputPaths.map((path) => basename(path)).join(', ')}`,
  ].join('\n');
}
