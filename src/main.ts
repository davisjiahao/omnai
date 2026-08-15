#!/usr/bin/env node

import { OMNAI_VERSION } from './version.js';
import {
  createUserLevelProgram,
  isUserLevelCommand,
} from './host/commands.js';
import {
  createPersonalWorkspaceProgram,
  isPersonalWorkspaceCommand,
} from './workspace/commands.js';

const command = process.argv[2];

if (command === '--version' || command === '-V') {
  console.log(OMNAI_VERSION);
} else if (isRemovedRepositoryHostInvocation(process.argv.slice(2))) {
  rejectRemovedRepositoryHostInvocation(command);
} else if (isUserLevelCommand(command)) {
  createUserLevelProgram().parseAsync(process.argv).catch(handleError);
} else if (isPersonalWorkspaceCommand(command)) {
  createPersonalWorkspaceProgram().parseAsync(process.argv).catch(handleError);
} else {
  await import('./cli.js');
}

function isRemovedRepositoryHostInvocation(args: string[]): boolean {
  const [requested] = args;
  if (requested === 'install') return true;
  if (requested !== 'init') return false;
  return args.some((value) => value === '--host' || value === '-H' || value.startsWith('--host='));
}

function rejectRemovedRepositoryHostInvocation(commandName: string | undefined): void {
  if (commandName === 'install') {
    console.error("error: unknown command 'install'");
  } else {
    console.error("error: unknown option '--host'");
  }
  process.exitCode = 1;
}

function handleError(error: unknown): void {
  console.error(`OmnAI error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
