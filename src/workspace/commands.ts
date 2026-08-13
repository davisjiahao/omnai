import { Command } from 'commander';
import { resolveOmnaiHome } from './paths.js';
import { createWorkset, resolveWorkset } from './worksets.js';

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

  return program;
}

function printResult(value: unknown, json: boolean | undefined, human: string): void {
  if (json) console.log(JSON.stringify(value, null, 2));
  else console.log(human);
}

function formatWorkset(workset: Awaited<ReturnType<typeof resolveWorkset>>): string {
  const lines = [`${workset.id}: ${workset.title}`];
  for (const member of workset.members) {
    lines.push(`  ${member.project.padEnd(20)} ${member.status}${member.worktree ? ` ${member.worktree}` : ''}`);
  }
  return lines.join('\n');
}
