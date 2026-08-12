#!/usr/bin/env node

import { Command } from 'commander';
import { relative } from 'node:path';
import type { Capability, EvidenceRecord, ReconcileLevel } from './domain/types.js';
import { CAPABILITIES, RECONCILE_LEVELS } from './domain/types.js';
import { changeArtifactPath, findRepositoryRoot, omnaiRoot } from './core/paths.js';
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
import { evidenceSummary, findEvidenceGaps, listEvidence, recordEvidence, recordHumanApproval, runVerificationCommand } from './core/evidence.js';
import { reconcileChange } from './core/reconcile.js';
import { installHostSkills, type SupportedHost } from './core/host-skills.js';
import { createInvestigation, promoteInvestigation, type InvestigationKind } from './core/investigations.js';
import { loadIssueState, saveIssueState, transitionIssue, ISSUE_TRIAGE_STATES } from './core/issues.js';
import { buildEvidenceMatrix, selectReviewLenses } from './core/policy.js';
import { evaluateGuard } from './core/guards.js';

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
  .description('Show readiness, policy, tasks, evidence, and next action')
  .argument('[change]', 'Change ID or slug')
  .action(async (reference?: string) => {
    const repoRoot = findRepositoryRoot();
    const change = await resolveChange(repoRoot, reference);
    const scenario = getScenario(change.metadata.scenario);
    const next = resolveNextAction(change.metadata, scenario);
    const evidence = await listEvidence(repoRoot, change);
    const matrix = buildEvidenceMatrix(scenario, change.metadata.risk, change.metadata.impact);
    const gaps = findEvidenceGaps(matrix, evidence);
    console.log(`${change.metadata.id}: ${change.metadata.title}`);
    console.log(`Scenario: ${scenario.id} | Status: ${change.metadata.status} | Revision: ${change.metadata.activeRevision} | Baseline: ${change.metadata.baseline}`);
    console.log(`Risk: ${change.metadata.risk.level} | Impact: ${JSON.stringify(change.metadata.impact)}`);
    console.log('\nReadiness');
    for (const [key, value] of readinessTable(change.metadata)) console.log(`  ${key.padEnd(16)} ${value}`);
    const tasks = await loadTasks(changeArtifactPath(repoRoot, change.directoryName, 'tasks.yaml'));
    console.log(`\nTasks: ${JSON.stringify(summarizeTasks(tasks))}`);
    console.log(`Evidence: ${JSON.stringify(evidenceSummary(evidence))}`);
    console.log(`Evidence gaps: ${gaps.map((item) => item.id).join(', ') || 'none'}`);
    console.log(`Review lenses: ${selectReviewLenses(scenario, change.metadata.risk, change.metadata.impact).join(', ')}`);
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

const investigationCommand = program.command('investigate').description('Run a read-only investigation outside Change state');
investigationCommand
  .command('create')
  .argument('<kind>', 'system-query, field-lineage, or business-flow')
  .argument('<query>', 'Question to research')
  .action(async (kind: string, query: string) => {
    assertInvestigationKind(kind);
    const repoRoot = findRepositoryRoot();
    const investigation = await createInvestigation(repoRoot, kind, query);
    console.log(`Created ${investigation.id} (${investigation.kind})`);
    console.log(`Research artifact: ${relative(repoRoot, changeArtifactPathForInvestigation(investigation.directory))}`);
    console.log('Read-only contract: no source edits and no Change creation until explicit promotion.');
  });
investigationCommand
  .command('promote')
  .argument('<investigation>', 'Investigation ID')
  .argument('<title>', 'New Change title')
  .option('-s, --scenario <id>', 'Scenario profile', 'small-feature')
  .action(async (investigation: string, title: string, options: { scenario: string }) => {
    const repoRoot = findRepositoryRoot();
    const change = await promoteInvestigation(repoRoot, investigation, title, options.scenario);
    console.log(`Promoted ${investigation} to ${change.metadata.id} (${change.metadata.scenario})`);
  });

const issueCommand = program.command('issue').description('Inspect or update the bug triage state machine');
issueCommand
  .command('show')
  .option('-C, --change <change>', 'Change ID or slug')
  .action(async (options: { change?: string }) => {
    const repoRoot = findRepositoryRoot();
    const change = await resolveChange(repoRoot, options.change);
    assertIssueScenario(change.metadata.scenario);
    const state = await loadIssueState(changeArtifactPath(repoRoot, change.directoryName, 'issue.yaml'));
    console.log(JSON.stringify(state, null, 2));
  });
issueCommand
  .command('set')
  .option('-C, --change <change>', 'Change ID or slug')
  .option('--triage <state>', ISSUE_TRIAGE_STATES.join(', '))
  .option('--reproduction <state>', 'unknown, confirmed, not-reproducible, instrumentation-required')
  .option('--root-cause <state>', 'unknown, suspected, confirmed')
  .option('--fix-strategy <state>', 'unknown, ready, needs-experiment')
  .action(async (options: { change?: string; triage?: string; reproduction?: string; rootCause?: string; fixStrategy?: string }) => {
    const repoRoot = findRepositoryRoot();
    const change = await resolveChange(repoRoot, options.change);
    assertIssueScenario(change.metadata.scenario);
    const path = changeArtifactPath(repoRoot, change.directoryName, 'issue.yaml');
    const state = await loadIssueState(path);
    if (options.reproduction) {
      if (!['unknown', 'confirmed', 'not-reproducible', 'instrumentation-required'].includes(options.reproduction)) throw new Error(`Invalid reproduction '${options.reproduction}'`);
      state.reproduction = options.reproduction as typeof state.reproduction;
    }
    if (options.rootCause) {
      if (!['unknown', 'suspected', 'confirmed'].includes(options.rootCause)) throw new Error(`Invalid root cause '${options.rootCause}'`);
      state.rootCause = options.rootCause as typeof state.rootCause;
    }
    if (options.fixStrategy) {
      if (!['unknown', 'ready', 'needs-experiment'].includes(options.fixStrategy)) throw new Error(`Invalid fix strategy '${options.fixStrategy}'`);
      state.fixStrategy = options.fixStrategy as typeof state.fixStrategy;
    }
    if (options.triage) {
      if (!ISSUE_TRIAGE_STATES.includes(options.triage as (typeof ISSUE_TRIAGE_STATES)[number])) throw new Error(`Invalid triage state '${options.triage}'`);
      transitionIssue(state, options.triage as (typeof ISSUE_TRIAGE_STATES)[number]);
    }
    await saveIssueState(path, state);
    console.log(JSON.stringify(state, null, 2));
  });

const scenarioCommand = program.command('scenario').description('Inspect and select scenario profiles');
scenarioCommand.command('list').action(() => {
  for (const scenario of listScenarios()) console.log(`${scenario.id.padEnd(28)} ${scenario.risk.padEnd(8)} ${scenario.label}`);
});
scenarioCommand.command('show').argument('<id>').action((id: string) => console.log(formatScenario(getScenario(id))));
scenarioCommand.command('detect').argument('<description>').action((description: string) => console.log(formatScenario(detectScenario(description))));
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
    console.log(`Selected ${scenario.id} for ${change.metadata.id}. Re-run status and reconcile readiness before execution.`);
  });

for (const capability of CAPABILITIES.filter((item) => !['work', 'verify', 'ship', 'archive', 'reconcile'].includes(item))) {
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
  .option('--verified', 'Mark a task done only when its required evidence exists')
  .option('--block <reason>', 'Block the task with a reason')
  .action(async (taskId: string | undefined, options: { change?: string; done?: boolean; verified?: boolean; block?: string }) => {
    const repoRoot = findRepositoryRoot();
    const change = await resolveChange(repoRoot, options.change);
    const tasksPath = changeArtifactPath(repoRoot, change.directoryName, 'tasks.yaml');
    const taskFile = refreshTaskReadiness(await loadTasks(tasksPath));
    const task = taskId ? requireTask(taskFile, taskId) : taskFrontier(taskFile)[0];
    if (!task) throw new Error('No ready task exists. Run omnai status or reconcile the task graph.');

    if (!options.block && !options.done && !options.verified) {
      const issuePath = changeArtifactPath(repoRoot, change.directoryName, 'issue.yaml');
      if (await pathExists(issuePath)) {
        const issue = await loadIssueState(issuePath);
        const decision = evaluateGuard({ action: 'edit', scenario: change.metadata.scenario, riskLevel: change.metadata.risk.level, issue });
        if (!decision.allowed) throw new Error(`${decision.code}: ${decision.reason}`);
      }
    }

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
      const evidence = await listEvidence(repoRoot, change);
      const missing = task.evidenceRequired.filter((requirement) => !evidence.some((record) => record.status === 'PASS' && record.requirementId === requirement && (!record.taskId || record.taskId === task.id)));
      if (missing.length > 0) throw new Error(`${task.id} is missing PASS evidence for: ${missing.join(', ')}`);
      if (task.status === 'IMPLEMENTED') transitionTask(taskFile, task.id, 'VERIFYING');
      if (task.status === 'VERIFYING') transitionTask(taskFile, task.id, 'VERIFIED');
      if (task.status === 'VERIFIED') transitionTask(taskFile, task.id, 'DONE');
      if (task.status !== 'DONE') throw new Error(`${task.id} must be IMPLEMENTED or VERIFYING before --verified`);
      refreshTaskReadiness(taskFile);
      await saveTasks(tasksPath, taskFile);
      if (taskFile.tasks.every((item) => item.status === 'DONE')) await markReadiness(repoRoot, change, 'implementation', 'READY');
      await appendTaskEvent(repoRoot, change, task.id, 'TASK_DONE');
      console.log(`${task.id} marked DONE with matching evidence.`);
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
  .description('Run configured verification or record evidence against the dynamic Evidence Matrix')
  .option('-C, --change <change>', 'Change ID or slug')
  .option('-c, --command <commands...>', 'Commands to run instead of project defaults')
  .option('--record <type>', 'Record external evidence type without running a command')
  .option('--requirement <id>', 'Evidence Matrix requirement ID')
  .option('--task <task>', 'Task ID for task-scoped evidence')
  .option('--status <status>', 'PASS, FAIL, or INCONCLUSIVE for --record')
  .option('--summary <summary>', 'Evidence summary for --record')
  .option('--matrix', 'Print required evidence and current gaps without running commands')
  .action(async (options: { change?: string; command?: string[]; record?: string; requirement?: string; task?: string; status?: string; summary?: string; matrix?: boolean }) => {
    const repoRoot = findRepositoryRoot();
    const change = await resolveChange(repoRoot, options.change);
    const scenario = getScenario(change.metadata.scenario);
    const matrix = buildEvidenceMatrix(scenario, change.metadata.risk, change.metadata.impact);
    if (options.matrix) {
      const evidence = await listEvidence(repoRoot, change);
      const gaps = new Set(findEvidenceGaps(matrix, evidence).map((item) => item.id));
      for (const item of matrix) console.log(`${gaps.has(item.id) ? 'MISSING' : 'SATISFIED'} ${item.id} — ${item.because}`);
      return;
    }

    if (options.record) {
      const allowedTypes: EvidenceRecord['type'][] = ['build', 'test', 'lint', 'typecheck', 'review', 'qa', 'security', 'migration', 'runtime', 'manual', 'contract', 'data', 'rollback', 'reproduction'];
      if (!allowedTypes.includes(options.record as EvidenceRecord['type'])) throw new Error(`Unsupported evidence type '${options.record}'`);
      const status = options.status ?? 'INCONCLUSIVE';
      if (!['PASS', 'FAIL', 'INCONCLUSIVE'].includes(status)) throw new Error(`Unsupported evidence status '${status}'`);
      const type = options.record as EvidenceRecord['type'];
      const optionalRequirement = options.requirement ? { requirementId: options.requirement } : { requirementId: defaultRequirementForEvidenceType(type) };
      const optionalTask = options.task ? { taskId: options.task } : {};
      await recordEvidence(repoRoot, change, {
        ...optionalRequirement,
        ...optionalTask,
        type,
        status: status as EvidenceRecord['status'],
        summary: options.summary ?? 'Externally recorded evidence',
      });
      console.log(`Recorded ${options.record}:${status}`);
      return;
    }

    const config = await loadProjectConfig(repoRoot);
    const commands = options.command ?? config.verification.commands;
    if (commands.length === 0) throw new Error('No verification commands configured. Add them to .omnai/config.yaml or pass --command.');
    await markReadiness(repoRoot, change, 'verification', 'IN_PROGRESS');
    let commandsPassed = true;
    for (const command of commands) {
      const type = inferEvidenceType(command);
      const result = await runVerificationCommand(repoRoot, change, command, type, defaultRequirementForEvidenceType(type));
      console.log(`${result.record.status} ${command}`);
      if (result.record.status !== 'PASS') commandsPassed = false;
    }
    const evidence = await listEvidence(repoRoot, change);
    const gaps = findEvidenceGaps(matrix, evidence);
    const ready = commandsPassed && gaps.length === 0;
    await markReadiness(repoRoot, change, 'verification', ready ? 'READY' : 'CONCERNS');
    if (gaps.length > 0) console.log(`Evidence gaps: ${gaps.map((item) => item.id).join(', ')}`);
    if (!ready) process.exitCode = 1;
  });

program
  .command('ship')
  .description('Assess delivery readiness; OmnAI does not deploy the artifact')
  .argument('[instruction]', 'Delivery/readiness instruction')
  .option('-C, --change <change>', 'Change ID or slug')
  .option('--approve', 'Record explicit human approval for this revision')
  .option('--complete', 'Apply ship guard and mark delivery readiness READY')
  .action(async (instruction: string | undefined, options: { change?: string; approve?: boolean; complete?: boolean }) => {
    const repoRoot = findRepositoryRoot();
    const change = await resolveChange(repoRoot, options.change);
    const scenario = getScenario(change.metadata.scenario);
    if (options.approve) {
      await recordHumanApproval(repoRoot, change, 'Explicit human approval recorded by omnai ship --approve');
    }
    if (!options.complete) {
      const prepared = await prepareStage(repoRoot, change, 'ship', instruction ?? 'Assess delivery readiness.');
      console.log(shortRunSummary(prepared));
      return;
    }
    const evidence = await listEvidence(repoRoot, change);
    const matrix = buildEvidenceMatrix(scenario, change.metadata.risk, change.metadata.impact);
    const gaps = findEvidenceGaps(matrix, evidence);
    const decision = evaluateGuard({
      action: 'ship',
      scenario: scenario.id,
      riskLevel: change.metadata.risk.level,
      verificationReady: change.metadata.readiness.verification === 'READY',
      reviewReady: !scenario.stages.includes('review') || change.metadata.readiness.review === 'READY',
      evidenceSatisfied: gaps.length === 0,
      humanApproval: evidence.some((record) => record.requirementId === 'human-approval' && record.status === 'PASS'),
    });
    if (!decision.allowed) throw new Error(`${decision.code}: ${decision.reason}${gaps.length > 0 ? ` Missing: ${gaps.map((item) => item.id).join(', ')}` : ''}`);
    await completeStage(repoRoot, change, 'ship');
    console.log(`READY ${change.metadata.id}: delivery gates satisfied. Deployment remains external to OmnAI.`);
  });

program
  .command('guard')
  .description('Evaluate a host-independent hard guard')
  .argument('<action>', 'edit, complete, or ship')
  .option('-C, --change <change>', 'Change ID or slug')
  .action(async (action: string, options: { change?: string }) => {
    if (!['edit', 'complete', 'ship'].includes(action)) throw new Error(`Unknown guard action '${action}'`);
    const repoRoot = findRepositoryRoot();
    const change = await resolveChange(repoRoot, options.change);
    const scenario = getScenario(change.metadata.scenario);
    const evidence = await listEvidence(repoRoot, change);
    const gaps = findEvidenceGaps(buildEvidenceMatrix(scenario, change.metadata.risk, change.metadata.impact), evidence);
    const issuePath = changeArtifactPath(repoRoot, change.directoryName, 'issue.yaml');
    const issue = await pathExists(issuePath) ? await loadIssueState(issuePath) : undefined;
    const decision = evaluateGuard({
      action: action as 'edit' | 'complete' | 'ship',
      scenario: scenario.id,
      riskLevel: change.metadata.risk.level,
      ...(issue ? { issue } : {}),
      verificationReady: change.metadata.readiness.verification === 'READY',
      reviewReady: !scenario.stages.includes('review') || change.metadata.readiness.review === 'READY',
      evidenceSatisfied: gaps.length === 0,
      humanApproval: evidence.some((record) => record.requirementId === 'human-approval' && record.status === 'PASS'),
    });
    console.log(JSON.stringify(decision, null, 2));
    if (!decision.allowed) process.exitCode = 2;
  });

program
  .command('reconcile')
  .description('Create a revision/baseline and selectively invalidate affected artifacts and tasks')
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
    const optionalTasks = options.task ? { affectedTasks: options.task } : {};
    const optionalEvidence = options.evidence ? { evidence: options.evidence } : {};
    const result = await reconcileChange(repoRoot, change, {
      level: options.level as ReconcileLevel,
      type: options.type,
      reason: options.reason,
      ...optionalTasks,
      ...optionalEvidence,
    });
    console.log(`Created ${result.revision.id} / ${change.metadata.baseline} from ${result.revision.previousRevision}`);
    console.log(`Affected readiness: ${result.affectedReadiness.join(', ') || 'none'}`);
    console.log(`Affected tasks: ${result.affectedTasks.join(', ') || 'none'}`);
  });

program
  .command('archive')
  .description('Archive only when tasks, evidence, review, verification and delivery gates agree')
  .argument('[change]', 'Change ID or slug')
  .option('--force', 'Archive despite incomplete evidence')
  .action(async (reference: string | undefined, options: { force?: boolean }) => {
    const repoRoot = findRepositoryRoot();
    const change = await resolveChange(repoRoot, reference);
    const scenario = getScenario(change.metadata.scenario);
    const tasks = await loadTasks(changeArtifactPath(repoRoot, change.directoryName, 'tasks.yaml'));
    const evidence = await listEvidence(repoRoot, change);
    const gaps = findEvidenceGaps(buildEvidenceMatrix(scenario, change.metadata.risk, change.metadata.impact), evidence);
    const unfinished = tasks.tasks.filter((task) => !['DONE', 'CANCELLED', 'SUPERSEDED'].includes(task.status));
    const reviewReady = !scenario.stages.includes('review') || change.metadata.readiness.review === 'READY';
    const releaseReady = !scenario.stages.some((stage) => stage === 'ship' || stage === 'release') || change.metadata.readiness.release === 'READY';
    if (!options.force && (unfinished.length > 0 || gaps.length > 0 || change.metadata.readiness.verification !== 'READY' || !reviewReady || !releaseReady)) {
      throw new Error(`Archive gate failed: unfinished=${unfinished.length}, evidenceGaps=${gaps.map((item) => item.id).join(',') || 'none'}, verification=${change.metadata.readiness.verification}, review=${change.metadata.readiness.review}, release=${change.metadata.readiness.release}`);
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
  if (!['claude', 'codex', 'opencode'].includes(value)) throw new Error(`Unsupported host '${value}'`);
}

function assertInvestigationKind(value: string): asserts value is InvestigationKind {
  if (!['system-query', 'field-lineage', 'business-flow'].includes(value)) throw new Error(`Unsupported investigation kind '${value}'`);
}

function assertIssueScenario(scenario: string): void {
  if (!['bug-fix', 'emergency-hotfix', 'incident-response', 'release-failure'].includes(scenario)) throw new Error(`Scenario '${scenario}' does not use issue.yaml triage state.`);
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
    timestamp: new Date().toISOString(), event, changeId: change.metadata.id, revision: change.metadata.activeRevision,
    ...(taskId ? { taskId } : {}), ...(detail ? { detail } : {}),
  });
}

function inferEvidenceType(command: string): 'build' | 'test' | 'lint' | 'typecheck' {
  const normalized = command.toLowerCase();
  if (normalized.includes('lint')) return 'lint';
  if (normalized.includes('typecheck') || normalized.includes('tsc')) return 'typecheck';
  if (normalized.includes('build') || normalized.includes('package')) return 'build';
  return 'test';
}

function defaultRequirementForEvidenceType(type: EvidenceRecord['type']): string {
  if (type === 'test') return 'tests';
  if (type === 'contract') return 'contract-test';
  if (type === 'data') return 'data-reconciliation';
  if (type === 'rollback') return 'rollback-plan';
  if (type === 'runtime') return 'runtime-health';
  if (type === 'security') return 'security-review';
  if (type === 'qa') return 'browser-qa';
  if (type === 'reproduction') return 'reproduction';
  return type;
}

function changeArtifactPathForInvestigation(directory: string): string {
  return `${directory}/research.md`;
}
