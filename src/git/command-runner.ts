import { spawn } from 'node:child_process';
import type { SpawnOptionsWithoutStdio } from 'node:child_process';
import { AiWorkspaceError } from '../domain/errors';

const FORCE_KILL_AFTER_MS = 1_000;

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export interface CommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: CommandOptions
  ): Promise<CommandResult>;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError'
    || (error as NodeJS.ErrnoException).code === 'ABORT_ERR';
}

function processError(command: string, error: unknown): AiWorkspaceError {
  if (isAbortError(error)) {
    return new AiWorkspaceError('CANCELLED', 'Operation cancelled');
  }
  return new AiWorkspaceError('GIT', 'Unable to start Git', { command });
}

function unexpectedTerminationError(
  command: string,
  signal: NodeJS.Signals | null
): AiWorkspaceError {
  const details: Record<string, unknown> = { command };
  if (signal !== null) details.signal = signal;
  return new AiWorkspaceError(
    'GIT',
    'Git process terminated unexpectedly',
    details
  );
}

export class NodeCommandRunner implements CommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: CommandOptions
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const spawnOptions: SpawnOptionsWithoutStdio = {
        cwd: options.cwd,
        shell: false,
        windowsHide: true
      };
      if (options.env !== undefined) spawnOptions.env = options.env;
      if (options.signal !== undefined) spawnOptions.signal = options.signal;

      let child;
      try {
        child = spawn(command, [...args], {
          ...spawnOptions,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (error) {
        reject(processError(command, error));
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;
      let cancellationRequested = false;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const recordCancellation = (): void => {
        cancellationRequested = true;
        forceKillTimer ??= setTimeout(() => {
          if (settled) return;
          try {
            child.kill('SIGKILL');
          } catch {
            // The close event remains the source of truth for process termination.
          }
        }, FORCE_KILL_AFTER_MS);
      };
      const abortListener = (): void => recordCancellation();
      const cleanup = (): void => {
        if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
        options.signal?.removeEventListener('abort', abortListener);
      };

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });

      child.once('error', error => {
        if (settled) return;
        if (isAbortError(error)) {
          recordCancellation();
          return;
        }
        settled = true;
        cleanup();
        reject(processError(command, error));
      });
      child.once('close', (exitCode, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (cancellationRequested) {
          reject(new AiWorkspaceError('CANCELLED', 'Operation cancelled'));
          return;
        }
        if (exitCode === null) {
          reject(unexpectedTerminationError(command, signal));
          return;
        }
        resolve({
          exitCode,
          stdout,
          stderr
        });
      });

      if (options.signal !== undefined) {
        options.signal.addEventListener('abort', abortListener, { once: true });
        if (options.signal.aborted) recordCancellation();
      }
    });
  }
}
