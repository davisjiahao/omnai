#!/usr/bin/env node

import { Command } from 'commander';
import { join, relative } from 'node:path';
import type { Capability, ReconcileLevel, TaskStatus } from './domain/types.js';
import { CAPABILITIES, RECONCILE_LEVELS, TASK_STATUSES } from './domain/types.js';
import { findRepositoryRoot, changeArtifactPath, omnaiRoot } from './core/paths.js';
import {
  createChange,
  initializeProject,
  listChanges,
  loadProjectConfig,
  markReadiness,
  resolveChange,
  saveChange,
  selectChange,
} from './core/store.js';
import { detectScenario, getScenario, listScenarios } from './core/scenarios.js';
import { readinessTable, resolveNextAction } from './core/readiness.js';
import { completeStage, prepareStage, shortRunSummary } from './core/stages.js';
import {
  loadTasks,
  refreshTaskReadiness,
  requireTask,
  saveTasks,
  summarizeTasks,
  taskFrontier,
  transitionTask,
} from './core/tasks.js';
import { appendJsonLine, pathExists } from './core/files.js';
import { evidenceSummary, listEvidence, recordEvidence, runVerificationCommand } from './core/evidence.js';
import { reconcileChange } from './core/reconcile.js';
import { installHostSkills, type SupportedHost } from './core/host-skills.js';

const program = new Command();
program
  .name('omnai')
  .description('Repository-local native AI engineering workflow')
  .version('0.1.0')
  .showHelpAfterError();

program
  .command('init')
  .description('Initialize .omnai state in the current Git repository')
  .option('-H, --host <hosts...>', 'Install thin skills for claude, codex, or opencode')
  .action(async (options: { host?: string[] }) => {
    const repoRoot = findRepositoryRoot();
    const config = await initializeProject(repoRoot);
    const installed: string[] = [];
    for (const host of options.host ?? []) {
      assertHost(host);
      installed.push(...await installHostSkills(repoRoot, host));
    }
    console.log(`Initialized OmnAI for ${config.project} at ${relative(repoRoot, omnaiRoot(repoRoot))}`);
    if (installed.length > 0) console.log(`Installed ${installed.length} host skill directories.`);
  });

program
  .command('new')
  .description('Create a canonical change workspace')
  .argument('<title>', 'Change title')
  .option('-s, --scenario <id>', 'Scenario profile')
  .action(async (title: string, options: { scenario?: string }) => {
    const repoRoot = findRepositoryRoot();
    const change = await createChange(repoRoot, title, options.scenario);
    console.log(`Created ${change.metadata.id} (${change.metadata.scenario}) at .omnai/changes/${change.directoryName}`);
  });

program
  .command('use')
  .description('Select the active change')
  .argument('<change>', 'Change ID, slug, or directory')
  .action(async (reference: string) => {
    const repoRoot = findRepositoryRoot();
    const change = await selectChange(repoRoot, reference);
    console.log(`Active change: ${change.metadata.id} ${change.metadata.title}`);
  });

program
  .command('list')
  .description('List change workspaces')
  .action(async () => {
    const repoRoot = findRepositoryRoot();
    await initializeProject(repoRoot);
    const config = await loadProjectConfig(repoRoot);
    for (const change of await listChanges(repoRoot)) {
      const active = config.activeChange === change.metadata.id ? '*' : ' ';
      console.log(`${active} ${change.metadata.id}  ${change.metadata.status.padEnd(18)} ${change.metadata.scenario.padEnd(24)} ${change.metadata.title}`);
    }
  });

program
  .command('status')
  .description('Show the active change, readiness vector, task summary, and evidence summary')
  .argument('[change]', 'Change ID or slug')
  .action(async (reference?: string) => {
    const repoRoot = findRepositoryRoot();
    const change = await resolveChange(repoRoot, reference);
    const scenario = getScenario(change.metadata.scenario);
    const next = resolveNextAction(change.metadata, scenario);
    console.log(`${change.metadata.id}: ${change.metadata.title}`);
    console.log(`Scenario: ${scenario.id} | Status: ${change.metadata.status} | Revision: ${change.metadata.activeRevision}`);
    console.log('\nReadiness');
    for (const [key, value] of readinessTable(change.metadata)) console.log(`  ${key.padEnd(16)} ${value}`);
    const tasks = await loadTasks(changeArtifactPath(repoRoot, change.directoryName, 'tasks.yaml'));
    console.log(`\nTasks: ${JSON.stringify(summarizeTasks(tasks))}`);
    console.log(`Evidence: ${JSON.stringify(evidenceSummary(await listEvidence(repoRoot, change)))}`);
    console.log(`Next: ${next.capability ?? 'none'} — ${next.reason}`);
  });

program
  .command('next')
  .description('Resolve the next required capability from scenario and readiness')
  .argument('[change]', 'Change ID or slug')
  .action(async (reference?: string) => {
    const repoRoot = findRepositoryRoot();
    const change = await resolveChange(repoRoot, reference);
    const next = resolveNextAction(change.metadata, getScenario(change.metadata.scenario));
    console.log(next.capability ?? 'none');
    console.log(next.reason);
    if (next.blocked) process.exitCode = 2;
  });

const scenarioCommand = program.command('scenario').description('Inspect and select scenario profiles');
scenarioCommand.command('list').action(() => {
  for (const scenario of listScenarios()) {
    console.log(`${scenario.id.padEnd(28)} ${scenario.risk.padEnd(8)} ${scenario.label}`);
  }
});
scenarioCommand
  .command('show')
  .argument('<id>')
  .action((id: string) => console.log(formatScenario(getScenario(id))));
scenarioCommand
  .command('detect')
  .argument('<description>')
  .action((description: string) => console.log(formatScenario(detectScenario(description))));
scenarioCommand
  .command('select')
  .argument('<id>')
  .argument('[change]')
  .action(async (id: string, reference?: string) => {
    const repoRoot = findRepositoryRoot();
    const scenario = getScenario(id);
    const change = await resolveChange(repoRoot, reference);
    change.metadata.scenario = scenario.id;
    change.metadata.workMode = scenario.workMode;
    await saveChange(repoRoot, change);
    console.log(`Selected ${scenario.id} for ${change.metadata.id}`);
  });

for (const capability of CAPABILITIES.filter((item) => !['work', 'verify', 'archive', 'reconcile'].includes(item))) {
  program
    .command(capability)
    .description(`Prepare or complete the ${capability} capability`)
    .argument('[instruction]', 'Capability-specific instruction')
    .option('-C, --change <change>', 'Change ID or slug')
    .option('--complete', 'Validate canonical output and mark the capability ready')
    .action(async (instruction: string | undefined, options: { change?: string; complete?: boolean }) => {
      const repoRoot = findRepositoryRoot();
      const change = await resolveChange(repoRoot, options.change);
      if (options.complete) {
        await completeStage(repoRoot, change, capability);
        console.log(`Completed ${capability} for ${change.metadata.id}`);
        return;
      }
      const prepared = await prepareStage(repoRoot, change, capability, instruction ?? '');
      console.log(shortRunSummary(prepared));
      console.log(`Read and execute: ${prepared.manifest.promptPath}`);
    });
}

program
  .command('work')
  .description('Prepare, start, block, or complete an implementation task')
  .argument('[task]', 'Task ID; defaults to the first frontier task')
  .option('-C, --change <change>', 'Change ID or slug')
  .option('--done', 'Mark implementation complete and ready for verification')
  .option('--verified', 'Mark a verified task done')
  .option('--block <reason>', 'Block the task with a reason')
  .action(async (taskId: string | undefined, options: { change?: string; done?: boolean; verified?: boolean; block?: string }) => {
    const repoRoot = findRepositoryRoot();
    const change = await resolveChange(repoRoot, options.change);
    const tasksPath = changeArtifactPath(repoRoot, change.directoryName, 'tasks.yaml');
    const taskFile = refreshTaskReadiness(await loadTasks(tasksPath));
    const task = taskId ? requireTask(taskFile, taskId) : taskFrontier(taskFile)[0];
    if (!task) throw new Error('No ready task exists. Run omnai status or reconcile the task graph.');

    if (options.block) {
      if (task.status !== 'BLOCKED') transitionTask(taskFile, task.id, 'BLOCKED');
      task.notes.push(options.block);
      await saveTasks(tasksPath, taskFile);
      await appendTaskEvent(repoRoot, change, task.id, 'TASK_BLOCKED', options.block);
      console.log(`Blocked ${task.id}: ${options.block}`);
      return;
    }
    if (options.done) {
      if (task.status === 'RUNNING') transitionTask(taskFile, task.id, 'IMPLEMENTED');
      else if (task.status !== 'IMPLEMENTED') throw new Error(`${task.id} must be RUNNING before --done`);
      await saveTasks(tasksPath, taskFile);
      await markReadiness(repoRoot, change, 'implementation', 'CONCERNS');
      await appendTaskEvent(repoRoot, change, task.id, 'TASK_IMPLEMENTED');
      console.log(`${task.id} implemented; fresh verification is still required.`);
      return;
    }
    if (options.verified) {
      if (task.status === 'IMPLEMENTED') transitionTask(taskFile, task.id, 'VERIFYING');
      if (task.status === 'VERIFYING') transitionTask(taskFile, task.id, 'VERIFIED');
      if (task.status === 'VERIFIED') transitionTask(taskFile, task.id, 'DONE');
      if (task.status !== 'DONE') throw new Error(`${task.id} must be IMPLEMENTED or VERIFYING before --verified`);
      refreshTaskReadiness(taskFile);
      await saveTasks(tasksPath, taskFile);
      if (taskFile.tasks.every((item) => item.status === 'DONE')) await markReadiness(repoRoot, change, 'implementation', 'READY');
      await appendTaskEvent(repoRoot, change, task.id, 'TASK_DONE');
      console.log(`${task.id} marked DONE with verification.`);
      return;
    }

    if (task.status === 'READY') transitionTask(taskFile, task.id, 'RUNNING');
    if (task.status !== 'RUNNING') throw new Error(`${task.id} is ${task.status}, not READY or RUNNING`);
    await saveTasks(tasksPath, taskFile);
    await markReadiness(repoRoot, change, 'implementation', 'IN_PROGRESS');
    await appendTaskEvent(repoRoot, change, task.id, 'TASK_STARTED');
    const prepared = await prepareStage(repoRoot, change, 'work', `Implement ${task.id}: ${task.title}\n\n${task.objective}`);
    console.log(`${task.id}: ${task.title}`);
    console.log(shortRunSummary(prepared));
  });

program
  .command('verify')
  .description('Run configured verification commands or record explicit evidence')
  .option('-C, --change <change>', 'Change ID or slug')
  .option('-c, --command <commands...>', 'Commands to run instead of project defaults')
  .option('--record <type>', 'Record external evidence type without running a command')
  .option('--status <status>', 'PASS, FAIL, or INCONCLUSIVE for --record')
  .option('--summary <summary>', 'Evidence summary for --record')
  .action(async (options: { change?: string; command?: string[]; record?: string; status?: string; summary?: string }) => {
    const repoRoot = findRepositoryRoot();
    const change = await resolveChange(repoRoot, options.change);
    if (options.record) {
      const allowedTypes = ['build', 'test', 'lint', 'typecheck', 'review', 'qa', 'security', 'migration', 'runtime', 'manual'];
      if (!allowedTypes.includes(options.record)) throw new Error(`Unsupported evidence type '${options.record}'`);
      const status = options.status ?? 'INCONCLUSIVE';
      if (!['PASS', 'FAIL', 'INCONCLUSIVE'].includes(status)) throw new Error(`Unsupported evidence status '${status}'`);
      await recordEvidence(repoRoot, change, {
        type: options.record as 'manual',
        status: status as 'PASS',
        summary: options.summary ?? 'Externally recorded evidence',
      });
      console.log(`Recorded ${options.record}:${status}`);
      return;
    }

    const config = await loadProjectConfig(repoRoot);
    const commands = options.command ?? config.verification.commands;
    if (commands.length === 0) throw new Error('No verification commands configured. Add them to .omnai/config.yaml or pass --command.');
    await markReadiness(repoRoot, change, 'verification', 'IN_PROGRESS');
    let passed = true;
    for (const command of commands) {
      const result = await runVerificationCommand(repoRoot, change, command, inferEvidenceType(command));
      console.log(`${result.record.status} ${command}`);
      if (result.record.status !== 'PASS') passed = false;
    }
    await markReadiness(repoRoot, change, 'verification', passed ? 'READY' : 'CONCERNS');
    if (!passed) process.exitCode = 1;
  });

program
  .command('reconcile')
  .description('Create a revision and selectively invalidate affected artifacts and tasks')
  .requiredOption('-l, --level <level>', 'L0 through L5')
  .requiredOption('-t, --type <type>', 'Signal type')
  .requiredOption('-r, --reason <reason>', 'Why the active baseline is no longer sufficient')
  .option('-C, --change <change>', 'Change ID or slug')
  .option('--task <tasks...>', 'Root affected task IDs')
  .option('--evidence <evidence...>', 'Evidence references')
  .action(async (options: { level: string; type: string; reason: string; change?: string; task?: string[]; evidence?: string[] }) => {
    if (!RECONCILE_LEVELS.includes(options.level as ReconcileLevel)) throw new Error(`Invalid level '${options.level}'`);
    const repoRoot = findRepositoryRoot();
    const change = await resolveChange(repoRoot, options.change);
    const result = await reconcileChange(repoRoot, change, {
      level: options.level as ReconcileLevel,
      type: options.type,
      reason: options.reason,
      affectedTasks: options.task,
      evidence: options.evidence,
    });
    console.log(`Created ${result.revision.id} from ${result.revision.previousRevision}`);
    console.log(`Affected readiness: ${result.affectedReadiness.join(', ') || 'none'}`);
    console.log(`Affected tasks: ${result.affectedTasks.join(', ') || 'none'}`);
  });

program
  .command('archive')
  .description('Archive a verified change without deleting its history')
  .argument('[change]', 'Change ID or slug')
  .option('--force', 'Archive despite incomplete evidence')
  .action(async (reference: string | undefined, options: { force?: boolean }) => {
    const repoRoot = findRepositoryRoot();
    const change = await resolveChange(repoRoot, reference);
    const tasks = await loadTasks(changeArtifactPath(repoRoot, change.directoryName, 'tasks.yaml'));
    const evidence = await listEvidence(repoRoot, change);
    const unfinished = tasks.tasks.filter((task) => !['DONE', 'CANCELLED', 'SUPERSEDED'].includes(task.status));
    const hasPassingEvidence = evidence.some((record) => record.status === 'PASS');
    if (!options.force && (unfinished.length > 0 || !hasPassingEvidence || change.metadata.readiness.verification !== 'READY')) {
      throw new Error(`Archive gate failed: unfinished=${unfinished.length}, passingEvidence=${hasPassingEvidence}, verification=${change.metadata.readiness.verification}`);
    }
    change.metadata.status = 'ARCHIVED';
    await saveChange(repoRoot, change);
    await appendTaskEvent(repoRoot, change, undefined, 'CHANGE_ARCHIVED');
    console.log(`Archived ${change.metadata.id}. History remains under .omnai/changes/${change.directoryName}`);
  });

program
  .command('install')
  .description('Install project-local thin skills for an agent host')
  .requiredOption('-H, --host <host>', 'claude, codex, or opencode')
  .action(async (options: { host: string }) => {
    assertHost(options.host);
    const repoRoot = findRepositoryRoot();
    await initializeProject(repoRoot);
    const paths = await installHostSkills(repoRoot, options.host);
    console.log(`Installed ${paths.length} OmnAI skills for ${options.host}`);
  });

program
  .command('doctor')
  .description('Validate repository-local OmnAI configuration and canonical artifacts')
  .action(async () => {
    const repoRoot = findRepositoryRoot();
    await initializeProject(repoRoot);
    const config = await loadProjectConfig(repoRoot);
    const changes = await listChanges(repoRoot);
    let failures = 0;
    console.log(`PASS git repository: ${repoRoot}`);
    console.log(`PASS config: ${config.project}`);
    for (const change of changes) {
      try {
        await loadTasks(changeArtifactPath(repoRoot, change.directoryName, 'tasks.yaml'));
        console.log(`PASS ${change.metadata.id} task graph`);
      } catch (error) {
        failures += 1;
        console.log(`FAIL ${change.metadata.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures > 0) process.exitCode = 1;
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(`OmnAI error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

function assertHost(value: string): asserts value is SupportedHost {
  if (!['claude', 'codex', 'opencode'].includes(value)) {
    throw new Error(`Unsupported host '${value}'`);
  }
}

function formatScenario(scenario: ReturnType<typeof getScenario>): string {
  return [
    `${scenario.id} — ${scenario.label}`,
    scenario.description,
    `Work mode: ${scenario.workMode}`,
    `Risk: ${scenario.risk}`,
    `Stages: ${scenario.stages.join(' -> ')}`,
    `Optional: ${scenario.optionalStages.join(', ') || 'none'}`,
    `Artifacts: ${scenario.requiredArtifacts.join(', ')}`,
    `Gates:\n${scenario.gates.map((gate) => `  - ${gate}`).join('\n')}`,
    `Evidence:\n${scenario.requiredEvidence.map((item) => `  - ${item}`).join('\n')}`,
  ].join('\n');
}

async function appendTaskEvent(
  repoRoot: string,
  change: Awaited<ReturnType<typeof resolveChange>>,
  taskId: string | undefined,
  event: string,
  detail?: string,
): Promise<void> {
  await appendJsonLine(changeArtifactPath(repoRoot, change.directoryName, 'progress.jsonl'), {
    timestamp: new Date().toISOString(),
    event,
    changeId: change.metadata.id,
    revision: change.metadata.activeRevision,
    taskId,
    detail,
  });
}

function inferEvidenceType(command: string): 'build' | 'test' | 'lint' | 'typecheck' {
  const normalized = command.toLowerCase();
  if (normalized.includes('lint')) return 'lint';
  if (normalized.includes('typecheck') || normalized.includes('tsc')) return 'typecheck';
  if (normalized.includes('build') || normalized.includes('package')) return 'build';
  return 'test';
}
