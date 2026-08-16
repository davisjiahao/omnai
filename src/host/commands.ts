import { Command } from 'commander';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  loadProtocolBundle,
  parseProtocolId,
  type ProtocolBundle,
} from '../protocols/index.js';
import { OMNAI_VERSION } from '../version.js';
import {
  loadVisualCompanionDocument,
  startVisualCompanion,
  type VisualCompanionServer,
} from '../visual/index.js';
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
  return value === 'context' || value === 'host' || value === 'protocol' || value === 'visual';
}

export function createUserLevelProgram(): Command {
  const program = new Command();
  program
    .name('omnai')
    .description('OmnAI user-level Agent host, context, and protocol commands')
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

  const protocol = program
    .command('protocol')
    .description('Read canonical internal OmnAI protocol resources');

  protocol
    .command('show')
    .description('Render one ordered protocol bundle without mutating workflow state')
    .argument('<protocols...>', 'Canonical protocol IDs')
    .option('--json', 'Print machine-readable JSON')
    .action(async (values: string[], options: { json?: boolean }) => {
      const bundle = await loadProtocolBundle(values.map(parseProtocolId));
      if (options.json) {
        printJson(publicProtocolBundle(bundle));
        return;
      }
      process.stdout.write(bundle.rendered);
    });

  const visual = program
    .command('visual')
    .description('Validate and run the built-in loopback OmnAI Visual Companion');

  visual
    .command('validate')
    .description('Validate one declarative visual document without starting a server')
    .argument('<input>', 'Path to a visual companion JSON document')
    .option('--json', 'Print machine-readable JSON')
    .action(async (input: string, options: { json?: boolean }) => {
      const document = await loadVisualCompanionDocument(resolve(input));
      const result = {
        valid: true,
        schemaVersion: document.schemaVersion,
        kind: document.kind,
        title: document.title,
      };
      if (options.json) {
        printJson(result);
        return;
      }
      console.log(`VALID ${document.kind}: ${document.title}`);
    });

  visual
    .command('companion')
    .description('Serve one live visual document on a token-scoped loopback URL')
    .argument('<input>', 'Path to a visual companion JSON document')
    .option('--port <port>', 'Loopback port; 0 selects an available port', parsePort, 0)
    .option('--json', 'Print one machine-readable ready event')
    .action(async (input: string, options: { port: number; json?: boolean }) => {
      const companion = await startVisualCompanion(resolve(input), { port: options.port });
      const result = {
        schemaVersion: 1,
        status: 'ready',
        url: companion.url,
        inputPath: companion.inputPath,
        readOnly: true,
      } as const;
      if (options.json) printJson(result);
      else {
        console.log(`OmnAI Visual Companion: ${result.url}`);
        console.log('Read-only loopback session. Press Ctrl+C to stop.');
      }
      await waitForVisualCompanionShutdown(companion);
    });

  return program;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid visual companion port '${value}'. Expected 0 through 65535.`);
  }
  return port;
}

function waitForVisualCompanionShutdown(companion: VisualCompanionServer): Promise<void> {
  return new Promise((resolveShutdown, rejectShutdown) => {
    let stopping = false;
    const cleanup = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      companion.close().then(
        () => { cleanup(); resolveShutdown(); },
        (error) => { cleanup(); rejectShutdown(error); },
      );
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
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

function publicProtocolBundle(bundle: ProtocolBundle): {
  schemaVersion: 1;
  protocols: Array<{
    id: string;
    version: number;
    hash: string;
    kind: string;
    content: string;
  }>;
  rendered: string;
} {
  return {
    schemaVersion: 1,
    protocols: bundle.protocols.map(({ id, version, hash, kind, content }) => ({
      id,
      version,
      hash,
      kind,
      content,
    })),
    rendered: bundle.rendered,
  };
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
