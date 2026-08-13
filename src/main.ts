#!/usr/bin/env node

import {
  createPersonalWorkspaceProgram,
  isPersonalWorkspaceCommand,
} from './workspace/commands.js';

const command = process.argv[2];

if (isPersonalWorkspaceCommand(command)) {
  createPersonalWorkspaceProgram().parseAsync(process.argv).catch((error: unknown) => {
    console.error(`OmnAI error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
} else {
  await import('./cli.js');
}
