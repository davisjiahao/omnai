#!/usr/bin/env node

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
  console.log('0.2.0');
} else if (isUserLevelCommand(command)) {
  createUserLevelProgram().parseAsync(process.argv).catch(handleError);
} else if (isPersonalWorkspaceCommand(command)) {
  createPersonalWorkspaceProgram().parseAsync(process.argv).catch(handleError);
} else {
  await import('./cli.js');
}

function handleError(error: unknown): void {
  console.error(`OmnAI error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
