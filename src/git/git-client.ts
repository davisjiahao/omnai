import { AiWorkspaceError } from '../domain/errors';
import {
  NodeCommandRunner,
  type CommandOptions,
  type CommandRunner
} from './command-runner';

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitExecOptions {
  signal?: AbortSignal;
  allowedExitCodes?: readonly number[];
}

export function redactGitText(text: string): string {
  return text.replace(
    /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi,
    '$1***@'
  );
}

export function redactGitArgs(args: readonly string[]): string[] {
  return args.map(argument => redactGitText(argument));
}

export class GitClient {
  constructor(
    private readonly runner: CommandRunner = new NodeCommandRunner(),
    private readonly executable = 'git'
  ) {}

  async exec(
    cwd: string,
    args: readonly string[],
    options: GitExecOptions = {}
  ): Promise<GitResult> {
    const commandOptions: CommandOptions = { cwd };
    if (options.signal !== undefined) commandOptions.signal = options.signal;

    const result = await this.runner.run(this.executable, args, commandOptions);
    if (result.exitCode === 0 || options.allowedExitCodes?.includes(result.exitCode)) {
      return result;
    }

    throw new AiWorkspaceError(
      'GIT',
      redactGitText(result.stderr || result.stdout || 'Git command failed'),
      {
        cwd,
        args: redactGitArgs(args),
        exitCode: result.exitCode
      }
    );
  }
}
