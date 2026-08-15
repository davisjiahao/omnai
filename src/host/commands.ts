import { Command } from 'commander';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { OMNAI_VERSION } from '../version.js';
import { resolveOmnaiHome } from '../workspace/paths.js';
import { resolveOmnaiContext, type OmnaiContext } from './context.js';
import {
  USER_HOSTS,
  installUserHostSkills,
  listUserHostSkillStatuses,
  type UserHost,
  type UserHostInstallResult,
  type UserHostStatus,
} from './user-host-skills.js';

export function isUserLevelCommand(value: string | undefined): boolean {
  return value === 'context' || value === 'host';
}

export function createUserLevelProgram(): Command {
  const program = new Command();
  program
    .name('omnai')
    .description('OmnAI user-level Agent host and context commands')
    .version(OMNAI_VERSION)
    .showHelpAfterError();

  program
    .command('context')
    .description('Resolve the current Workset, Workset project, repository, or none context without mutation')
    .option('--path <path>', 'Filesystem path to inspect', process.cwd())
    .option('--json', 'Print machine-readable JSON')
    .action(async (options: { path: string; json?: boolean }) => {
      const context = await resolveOmnaiContext(resolveOmnaiHome(), options.path);
      if (options.json) {
        printJson(context);
        return;
      }
      console.log(formatContext(context));
    });

  const host = program
    .command('host')
    .description('Manage user-level Codex, Claude Code, and OpenCode integration');

  host
    .command('install')
    .argument('<host>', 'claude, codex, opencode, or all')
    .option('--json', 'Print machine-readable JSON')
    .action(async (value: string, options: { json?: boolean }) => {
      const results = await installUserHostSkills(
        resolveOmnaiHome(),
        resolveUserHome(),
        parseHostSelection(value),
      );
      if (options.json) {
        printJson(results);
        return;
      }
      printInstallResults(results);
    });

  host
    .command('status')
    .argument('[host]', 'claude, codex, opencode, or all', 'all')
    .option('--json', 'Print machine-readable JSON')
    .action(async (value: string, options: { json?: boolean }) => {
      const statuses = await listUserHostSkillStatuses(
        resolveOmnaiHome(),
        resolveUserHome(),
        parseHostSelection(value),
      );
      if (options.json) {
        printJson(statuses);
        return;
      }
      printStatuses(statuses);
    });

  return program;
}

function parseHostSelection(value: string | undefined): UserHost[] {
  if (!value || value === 'all') return [...USER_HOSTS];
  if (!(USER_HOSTS as readonly string[]).includes(value)) {
    throw new Error(`Unsupported Host '${value}'. Expected claude, codex, opencode, or all.`);
  }
  return [value as UserHost];
}

function resolveUserHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.HOME ?? env.USERPROFILE ?? homedir());
}

function printInstallResults(results: UserHostInstallResult[]): void {
  for (const result of results) {
    console.log(`${result.host.padEnd(8)} ${result.action.padEnd(9)} ${result.destination}`);
  }
}

function printStatuses(statuses: UserHostStatus[]): void {
  for (const status of statuses) {
    const detail = status.details.length > 0 ? ` — ${status.details.join('; ')}` : '';
    console.log(`${status.host.padEnd(8)} ${status.status.padEnd(13)} ${status.destination}${detail}`);
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function formatContext(context: OmnaiContext): string {
  if (context.scope === 'workset') {
    return `workset ${context.worksetId} at ${context.workspaceRoot}`;
  }
  if (context.scope === 'workset-project') {
    return `workset-project ${context.worksetId}/${context.project} ${context.memberStatus} ${context.changeId ?? 'no-change'} at ${context.repoRoot}`;
  }
  if (context.scope === 'repository') {
    return `repository ${context.initialized ? 'initialized' : 'uninitialized'} ${context.changeId ?? 'no-change'} at ${context.repoRoot}`;
  }
  return `none at ${context.cwd}`;
}
