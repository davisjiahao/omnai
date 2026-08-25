import { Command } from 'commander';
import YAML from 'yaml';
import { z } from 'zod';
import { OMNAI_VERSION } from '../version.js';
import { readText } from '../core/files.js';
import {
  bindWorksetProjectChange,
  createAndActivateWorksetProjectChange,
  listProjectChangeCandidates,
} from './change-bindings.js';
import {
  listRegisteredProjects,
  registerProject,
  requireRegisteredProject,
} from './project-registry.js';
import {
  listWorksetReentries,
  parseReentryKind,
  projectReconcileProposalSchema,
  recordWorksetReentry,
  resolveWorksetReentry,
} from './reentry.js';
import { applyWorksetReentry, reentryApplicationStatus } from './reconcile-apply.js';
import { decideWorksetReentry, planWorksetReentry } from './reconcile-plan.js';
import {
  confirmFailedWorksetReentryApplicationReplan,
  previewFailedWorksetReentryApplicationReplan,
} from './reconcile-replan.js';
import { resolveOmnaiHome, worksetWorkspaceRoot } from './paths.js';
import { resolveWorksetNext, type WorksetRouteAction } from './workset-router.js';
import {
  activateWorksetProject,
  addWorksetCandidate,
  beginProjectResearch,
  createWorkset,
  markProjectObservedOnly,
  markWorksetProjectInactive,
  resolveWorkset,
} from './worksets.js';

const projectReconcileProposalListSchema = z.array(projectReconcileProposalSchema);

export function isPersonalWorkspaceCommand(value: string | undefined): boolean {
  return value === 'project' || value === 'workset';
}

export function createPersonalWorkspaceProgram(): Command {
  const program = new Command();
  program
    .name('omnai')
    .description('OmnAI personal multi-project workspace commands')
    .version(OMNAI_VERSION)
    .showHelpAfterError();

  const project = program.command('project').description('Manage the personal Project Registry');
  project
    .command('register')
    .argument('<path>', 'Git repository path')
    .option('--alias <alias>', 'Stable project alias')
    .option('--json', 'Print machine-readable JSON')
    .action(async (path: string, options: { alias?: string; json?: boolean }) => {
      const registered = await registerProject(resolveOmnaiHome(), path, options.alias);
      printResult(registered, options.json, `Registered ${registered.alias}: ${registered.path}`);
    });

  project
    .command('list')
    .option('--json', 'Print machine-readable JSON')
    .action(async (options: { json?: boolean }) => {
      const projects = await listRegisteredProjects(resolveOmnaiHome());
      if (options.json) {
        printJson(projects);
        return;
      }
      for (const item of projects) console.log(`${item.alias.padEnd(20)} ${item.path}`);
    });

  project
    .command('inspect')
    .argument('<alias>', 'Registered project alias')
    .option('--json', 'Print machine-readable JSON')
    .action(async (alias: string, options: { json?: boolean }) => {
      const registered = await requireRegisteredProject(resolveOmnaiHome(), alias);
      printResult(registered, options.json, `${registered.alias}: ${registered.path}`);
    });

  const workset = program.command('workset').description('Manage one multi-project engineering objective');
  workset
    .command('new')
    .argument('<title>', 'Workset title')
    .option('--json', 'Print machine-readable JSON')
    .action(async (title: string, options: { json?: boolean }) => {
      const created = await createWorkset(resolveOmnaiHome(), title);
      printResult(created, options.json, `Created ${created.id}: ${created.title}`);
    });

  workset
    .command('status')
    .argument('[workset]', 'Workset ID or slug')
    .option('--json', 'Print machine-readable JSON')
    .action(async (reference: string | undefined, options: { json?: boolean }) => {
      const current = await resolveWorkset(resolveOmnaiHome(), reference);
      printResult(current, options.json, formatWorkset(current));
    });

  workset
    .command('next')
    .argument('[workset]', 'Workset ID or slug')
    .option('--json', 'Print machine-readable JSON')
    .action(async (reference: string | undefined, options: { json?: boolean }) => {
      const next = await resolveWorksetNext(resolveOmnaiHome(), reference);
      printResult(next, options.json, formatNext(next));
    });

  workset
    .command('add-candidate')
    .argument('<project>', 'Registered project alias')
    .option('--workset <workset>', 'Workset ID or slug')
    .option('--json', 'Print machine-readable JSON')
    .action(async (projectAlias: string, options: { workset?: string; json?: boolean }) => {
      const home = resolveOmnaiHome();
      const target = await resolveWorkset(home, options.workset);
      const updated = await addWorksetCandidate(home, target.id, projectAlias);
      printResult(updated, options.json, `Added ${projectAlias} to ${updated.id} as CANDIDATE.`);
    });

  workset
    .command('inspect-project')
    .argument('<project>', 'Workset project alias')
    .option('--workset <workset>', 'Workset ID or slug')
    .option('--result <result>', 'Research result: observed-only')
    .option('--json', 'Print machine-readable JSON')
    .action(async (projectAlias: string, options: { workset?: string; result?: string; json?: boolean }) => {
      const home = resolveOmnaiHome();
      const target = await resolveWorkset(home, options.workset);
      if (options.result) {
        if (options.result !== 'observed-only') throw new Error(`Unsupported research result '${options.result}'.`);
        const updated = await markProjectObservedOnly(home, target.id, projectAlias);
        const member = updated.members.find((item) => item.project === projectAlias);
        printResult(member, options.json, `${projectAlias} is OBSERVED_ONLY; no writable Worktree was created.`);
        return;
      }

      const updated = await beginProjectResearch(home, target.id, projectAlias);
      const registered = await requireRegisteredProject(home, projectAlias);
      const member = updated.members.find((item) => item.project === projectAlias);
      const result = {
        project: projectAlias,
        path: registered.path,
        readOnly: true,
        status: member?.status,
      };
      printResult(result, options.json, `Research ${projectAlias} read-only at ${registered.path}`);
    });

  workset
    .command('change-bindings')
    .argument('<project>', 'Researched Workset project alias')
    .option('--workset <workset>', 'Workset ID or slug')
    .option('--json', 'Print machine-readable JSON')
    .action(async (projectAlias: string, options: { workset?: string; json?: boolean }) => {
      const home = resolveOmnaiHome();
      const target = await resolveWorkset(home, options.workset);
      const candidates = await listProjectChangeCandidates(home, target.id, projectAlias);
      if (options.json) {
        printJson(candidates);
        return;
      }
      if (candidates.length === 0) {
        console.log(`No existing Project Changes found for ${projectAlias}.`);
        return;
      }
      for (const candidate of candidates) {
        const head = candidate.committedAtHead ? 'HEAD' : 'UNCOMMITTED';
        console.log(`${candidate.id} ${candidate.status.padEnd(12)} ${head.padEnd(11)} ${candidate.title}`);
      }
    });

  workset
    .command('bind-change')
    .argument('<project>', 'Researched Workset project alias')
    .argument('<change>', 'Project Change ID')
    .option('--workset <workset>', 'Workset ID or slug')
    .option('--json', 'Print machine-readable JSON')
    .action(async (projectAlias: string, changeId: string, options: { workset?: string; json?: boolean }) => {
      const home = resolveOmnaiHome();
      const target = await resolveWorkset(home, options.workset);
      const updated = await bindWorksetProjectChange(home, target.id, projectAlias, changeId);
      const member = updated.members.find((item) => item.project === projectAlias);
      printResult(member, options.json, `Bound ${projectAlias} to Project Change ${changeId}.`);
    });

  workset
    .command('create-change')
    .argument('<project>', 'Researched Workset project alias')
    .argument('<title>', 'Project Change title')
    .requiredOption('--scenario <scenario>', 'Project Change scenario')
    .option('--workset <workset>', 'Workset ID or slug')
    .option('--json', 'Print machine-readable JSON')
    .action(async (projectAlias: string, title: string, options: { scenario: string; workset?: string; json?: boolean }) => {
      const home = resolveOmnaiHome();
      const target = await resolveWorkset(home, options.workset);
      const created = await createAndActivateWorksetProjectChange(home, target.id, projectAlias, title, options.scenario);
      const member = created.workset.members.find((item) => item.project === projectAlias);
      const result = { member, change: created.change.metadata };
      printResult(result, options.json, `Created ${created.change.metadata.id} in ${projectAlias}'s Worktree and activated the project.`);
    });

  workset
    .command('activate-project')
    .argument('<project>', 'Researched project alias with a bound committed Project Change')
    .option('--workset <workset>', 'Workset ID or slug')
    .option('--json', 'Print machine-readable JSON')
    .action(async (projectAlias: string, options: { workset?: string; json?: boolean }) => {
      const home = resolveOmnaiHome();
      const target = await resolveWorkset(home, options.workset);
      const updated = await activateWorksetProject(home, target.id, projectAlias);
      const member = updated.members.find((item) => item.project === projectAlias);
      printResult(member, options.json, `Activated ${projectAlias} in ${member?.worktree}`);
    });

  workset
    .command('mark-inactive')
    .argument('<project>', 'Active project alias')
    .option('--workset <workset>', 'Workset ID or slug')
    .option('--json', 'Print machine-readable JSON')
    .action(async (projectAlias: string, options: { workset?: string; json?: boolean }) => {
      const home = resolveOmnaiHome();
      const target = await resolveWorkset(home, options.workset);
      const updated = await markWorksetProjectInactive(home, target.id, projectAlias);
      const member = updated.members.find((item) => item.project === projectAlias);
      printResult(member, options.json, `Marked ${projectAlias} INACTIVE; its Worktree is retained.`);
    });

  workset
    .command('path')
    .argument('[workset]', 'Workset ID or slug')
    .option('--json', 'Print machine-readable JSON')
    .action(async (reference: string | undefined, options: { json?: boolean }) => {
      const home = resolveOmnaiHome();
      const current = await resolveWorkset(home, reference);
      const path = worksetWorkspaceRoot(home, current.id);
      printResult({ workset: current.id, path }, options.json, path);
    });

  workset
    .command('change')
    .requiredOption('--kind <kind>', 'Structured mid-flight change kind')
    .requiredOption('--reason <reason>', 'Why the active assumptions changed')
    .option('--project <alias>', 'Existing affected Workset project', collect, [])
    .option('--candidate <alias>', 'Newly suspected registered project', collect, [])
    .option('--workset <workset>', 'Workset ID or slug')
    .option('--json', 'Print machine-readable JSON')
    .action(async (options: {
      kind: string;
      reason: string;
      project: string[];
      candidate: string[];
      workset?: string;
      json?: boolean;
    }) => {
      const home = resolveOmnaiHome();
      const target = await resolveWorkset(home, options.workset);
      const record = await recordWorksetReentry(home, target.id, {
        kind: parseReentryKind(options.kind),
        reason: options.reason,
        affectedProjects: options.project,
        candidateProjects: options.candidate,
      });
      printResult(record, options.json, `${record.id}: ${record.kind} -> ${record.route.capability}/${record.route.interaction}`);
    });

  const reentry = workset.command('reentry').description('Plan, apply, and inspect Workset selective Re-entry records');
  reentry
    .command('list')
    .argument('[workset]', 'Workset ID or slug')
    .option('--json', 'Print machine-readable JSON')
    .action(async (reference: string | undefined, options: { json?: boolean }) => {
      const home = resolveOmnaiHome();
      const target = await resolveWorkset(home, reference);
      const records = await listWorksetReentries(home, target.id);
      if (options.json) {
        printJson(records);
        return;
      }
      if (records.length === 0) {
        console.log('No Workset Re-entry records.');
        return;
      }
      for (const record of records) {
        console.log(`${record.id} ${record.status.padEnd(8)} ${record.kind} -> ${record.route.capability}/${record.route.interaction}`);
      }
    });

  reentry
    .command('plan')
    .argument('<reentry>', 'WRE identifier')
    .requiredOption('--file <path>', 'YAML file containing per-project Reconcile proposals')
    .option('--workset <workset>', 'Workset ID or slug')
    .option('--json', 'Print machine-readable JSON')
    .action(async (reentryId: string, options: { file: string; workset?: string; json?: boolean }) => {
      const home = resolveOmnaiHome();
      const target = await resolveWorkset(home, options.workset);
      const raw = await readText(options.file);
      const proposal = projectReconcileProposalListSchema.parse(YAML.parse(raw));
      const planned = await planWorksetReentry(home, target.id, reentryId, proposal);
      printResult(planned, options.json, `Planned ${reentryId}; review the calculated closure before deciding.`);
    });

  reentry
    .command('decide')
    .argument('<reentry>', 'WRE identifier')
    .option('--workset <workset>', 'Workset ID or slug')
    .option('--json', 'Print machine-readable JSON')
    .action(async (reentryId: string, options: { workset?: string; json?: boolean }) => {
      const home = resolveOmnaiHome();
      const target = await resolveWorkset(home, options.workset);
      const decided = await decideWorksetReentry(home, target.id, reentryId);
      printResult(decided, options.json, `Decided ${reentryId}; project Reconcile applications are frozen.`);
    });

  reentry
    .command('apply')
    .argument('<reentry>', 'WRE identifier')
    .option('--project <alias>', 'Apply or retry only one project application')
    .option('--workset <workset>', 'Workset ID or slug')
    .option('--json', 'Print machine-readable JSON')
    .action(async (reentryId: string, options: { project?: string; workset?: string; json?: boolean }) => {
      const home = resolveOmnaiHome();
      const target = await resolveWorkset(home, options.workset);
      const applied = await applyWorksetReentry(home, target.id, reentryId, options.project);
      printResult(applied, options.json, `${reentryId} is ${applied.status}.`);
    });

  reentry
    .command('replan')
    .argument('<reentry>', 'DECIDED WRE identifier with a stale failed project application')
    .requiredOption('--project <alias>', 'FAILED project application to preview or confirm')
    .option('--workset <workset>', 'Workset ID or slug')
    .option('--confirm', 'Persist the recalculated frozen application and archive the failed attempt')
    .option('--json', 'Print machine-readable JSON')
    .action(async (reentryId: string, options: { project: string; workset?: string; confirm?: boolean; json?: boolean }) => {
      const home = resolveOmnaiHome();
      const target = await resolveWorkset(home, options.workset);
      if (options.confirm) {
        const record = await confirmFailedWorksetReentryApplicationReplan(home, target.id, reentryId, options.project);
        const result = { mode: 'confirmed', record };
        printResult(result, options.json, `Replanned ${reentryId}/${options.project}; failed attempt archived and application reset to PENDING.`);
        return;
      }
      const preview = await previewFailedWorksetReentryApplicationReplan(home, target.id, reentryId, options.project);
      const result = { mode: 'preview', preview };
      printResult(result, options.json, `Preview ${reentryId}/${options.project}: ${preview.fromRevision}/${preview.fromBaseline}. No state was changed.`);
    });

  reentry
    .command('status')
    .argument('<reentry>', 'WRE identifier')
    .option('--workset <workset>', 'Workset ID or slug')
    .option('--json', 'Print machine-readable JSON')
    .action(async (reentryId: string, options: { workset?: string; json?: boolean }) => {
      const home = resolveOmnaiHome();
      const target = await resolveWorkset(home, options.workset);
      const status = await reentryApplicationStatus(home, target.id, reentryId);
      printResult(status, options.json, formatReentryStatus(status));
    });

  reentry
    .command('resolve')
    .argument('<reentry>', 'Legacy schema v1 WRE identifier')
    .option('--workset <workset>', 'Workset ID or slug')
    .option('--json', 'Print machine-readable JSON')
    .action(async (reentryId: string, options: { workset?: string; json?: boolean }) => {
      const home = resolveOmnaiHome();
      const target = await resolveWorkset(home, options.workset);
      const record = await resolveWorksetReentry(home, target.id, reentryId);
      printResult(record, options.json, `Resolved legacy ${record.id}.`);
    });

  return program;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function printResult(value: unknown, json: boolean | undefined, human: string): void {
  if (json) printJson(value);
  else console.log(human);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function formatWorkset(workset: Awaited<ReturnType<typeof resolveWorkset>>): string {
  const lines = [`${workset.id}: ${workset.title}`];
  for (const member of workset.members) {
    lines.push(`  ${member.project.padEnd(20)} ${member.status}${member.changeId ? ` ${member.changeId}` : ''}${member.worktree ? ` ${member.worktree}` : ''}`);
  }
  return lines.join('\n');
}

function formatNext(next: WorksetRouteAction): string {
  if (next.action === 'reenter') {
    return `reenter ${next.capability}/${next.interaction} (${next.reentryId}) — ${next.reason}`;
  }
  if (next.action === 'apply-reentry') {
    return `apply-reentry ${next.project} (${next.reentryId}, ${next.applicationStatus}) — ${next.reason}`;
  }
  if (next.action === 'replan-reentry') {
    return `replan-reentry ${next.project} (${next.reentryId}) — ${next.reason}`;
  }
  if ('project' in next) {
    return `${next.action} ${next.project} — ${next.reason}`;
  }
  return `${next.action} — ${next.reason}`;
}

function formatReentryStatus(record: Awaited<ReturnType<typeof reentryApplicationStatus>>): string {
  const lines = [`${record.id}: ${record.status} ${record.kind}`];
  for (const application of record.applications) {
    lines.push(`  ${application.project.padEnd(20)} ${application.status}${application.failureKind ? ` ${application.failureKind}` : ''}${application.changeId ? ` ${application.changeId}` : ''}`);
  }
  return lines.join('\n');
}
