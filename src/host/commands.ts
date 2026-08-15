import { Command } from 'commander';
import { resolveOmnaiHome } from '../workspace/paths.js';
import { resolveOmnaiContext, type OmnaiContext } from './context.js';

export function isUserLevelCommand(value: string | undefined): boolean {
  return value === 'context';
}

export function createUserLevelProgram(): Command {
  const program = new Command();
  program
    .name('omnai')
    .description('OmnAI user-level Agent host and context commands')
    .version('0.2.0')
    .showHelpAfterError();

  program
    .command('context')
    .description('Resolve the current Workset, Workset project, repository, or none context without mutation')
    .option('--path <path>', 'Filesystem path to inspect', process.cwd())
    .option('--json', 'Print machine-readable JSON')
    .action(async (options: { path: string; json?: boolean }) => {
      const context = await resolveOmnaiContext(resolveOmnaiHome(), options.path);
      if (options.json) {
        console.log(JSON.stringify(context, null, 2));
        return;
      }
      console.log(formatContext(context));
    });

  return program;
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
