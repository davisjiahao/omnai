import { Command } from 'commander';
import {
  listRegisteredProjects,
  registerProject,
  requireRegisteredProject,
} from './project-registry.js';
import { resolveOmnaiHome } from './paths.js';
import {
  activateWorksetProject,
  addWorksetCandidate,
  beginProjectResearch,
  createWorkset,
  markProjectObservedOnly,
  resolveWorkset,
  worksetNext,
} from './worksets.js';
import { syncVsCodeWorkspace } from './vscode-workspace.js';

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
      const current = await resolveWorkset(resolveOmnaiHome(), reference);
      const next = worksetNext(current);
      printResult(next, options.json, `${next.action}${next.project ? ` ${next.project}` : ''} — ${next.reason}`);
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
    .command('sync-workspace')
    .argument('[workset]', 'Workset ID or slug')
    .option('--json', 'Print machine-readable JSON')
    .action(async (reference: string | undefined, options: { json?: boolean }) => {
      const home = resolveOmnaiHome();
      const current = await resolveWorkset(home, reference);
      const path = await syncVsCodeWorkspace(home, current);
      printResult({ workset: current.id, path }, options.json, path);
    });

  return program;
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
