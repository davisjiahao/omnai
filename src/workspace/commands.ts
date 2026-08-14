import { Command } from 'commander';
import {
  listRegisteredProjects,
  registerProject,
  requireRegisteredProject,
} from './project-registry.js';
import {
  listWorksetReentries,
  parseReentryKind,
  recordWorksetReentry,
  resolveWorksetReentry,
} from './reentry.js';
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

export function isPersonalWorkspaceCommand(value: string | undefined): boolean {
  return value === 'project' || value === 'workset';
}

export function createPersonalWorkspaceProgram(): Command {
  const program = new Command();
  program
    .name('omnai')
    .description('OmnAI personal multi-project workspace commands')
    .version('0.2.0')
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
    .command('activate-project')
    .argument('<project>', 'Researched project alias')
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

  const reentry = workset.command('reentry').description('Inspect and resolve Workset selective Re-entry records');
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
    .command('resolve')
    .argument('<reentry>', 'WRE identifier')
    .option('--workset <workset>', 'Workset ID or slug')
    .option('--json', 'Print machine-readable JSON')
    .action(async (reentryId: string, options: { workset?: string; json?: boolean }) => {
      const home = resolveOmnaiHome();
      const target = await resolveWorkset(home, options.workset);
      const record = await resolveWorksetReentry(home, target.id, reentryId);
      printResult(record, options.json, `Resolved ${record.id}.`);
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
    lines.push(`  ${member.project.padEnd(20)} ${member.status}${member.worktree ? ` ${member.worktree}` : ''}`);
  }
  return lines.join('\n');
}

function formatNext(next: WorksetRouteAction): string {
  if (next.action === 'reenter') {
    return `reenter ${next.capability}/${next.interaction} (${next.reentryId}) — ${next.reason}`;
  }
  if ('project' in next) {
    return `${next.action} ${next.project} — ${next.reason}`;
  }
  return `${next.action} — ${next.reason}`;
}
