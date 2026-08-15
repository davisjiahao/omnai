import { describe, expect, it } from 'vitest';
import {
  NodeCommandRunner,
  type CommandOptions,
  type CommandRunner
} from './command-runner';
import { GitClient, redactGitArgs, redactGitText } from './git-client';

describe('redactGitText', () => {
  it('redacts credentials embedded in URLs', () => {
    expect(redactGitText('https://alice:secret@example.com/team/repo.git'))
      .toBe('https://***@example.com/team/repo.git');
  });

  it('redacts userinfo for every URI scheme without changing SCP-like remotes', () => {
    const text = [
      'fetch HTTP://alice@example.com/team/one.git',
      'push git+ssh://bob:p%40ss@example.net/team/two.git',
      'mirror custom2.foo-bar://token@example.dev/team/three.git',
      'scp git@example.org:team/four.git',
      'mail mailto:user@example.org'
    ].join('\n');

    expect(redactGitText(text)).toBe([
      'fetch HTTP://***@example.com/team/one.git',
      'push git+ssh://***@example.net/team/two.git',
      'mirror custom2.foo-bar://***@example.dev/team/three.git',
      'scp git@example.org:team/four.git',
      'mail mailto:user@example.org'
    ].join('\n'));
  });
});

describe('redactGitArgs', () => {
  it('returns a new array and does not mutate caller-owned arguments', () => {
    const args = Object.freeze([
      'clone',
      'https://alice:secret@example.com/team/repo.git'
    ]);

    const redacted = redactGitArgs(args);

    expect(redacted).not.toBe(args);
    expect(redacted).toEqual(['clone', 'https://***@example.com/team/repo.git']);
    expect(args).toEqual(['clone', 'https://alice:secret@example.com/team/repo.git']);
  });
});

describe('GitClient', () => {
  it('turns a non-zero Git result into a typed, redacted error', async () => {
    const args = Object.freeze([
      'fetch',
      'https://alice:secret@example.com/team/repo.git'
    ]);
    const runner: CommandRunner = {
      run: async () => ({
        exitCode: 128,
        stdout: '',
        stderr: 'fatal: https://alice:secret@example.com/team/repo.git failed'
      })
    };

    await expect(new GitClient(runner).exec('/repo', args)).rejects.toMatchObject({
      code: 'GIT',
      message: 'fatal: https://***@example.com/team/repo.git failed',
      details: {
        cwd: '/repo',
        args: ['fetch', 'https://***@example.com/team/repo.git'],
        exitCode: 128
      }
    });
    expect(args).toEqual([
      'fetch',
      'https://alice:secret@example.com/team/repo.git'
    ]);
  });

  it('uses redacted stdout when stderr is empty', async () => {
    const runner: CommandRunner = {
      run: async () => ({
        exitCode: 1,
        stdout: 'remote https://token@example.com/repo.git rejected',
        stderr: ''
      })
    };

    await expect(new GitClient(runner).exec('/repo', ['push'])).rejects.toMatchObject({
      code: 'GIT',
      message: 'remote https://***@example.com/repo.git rejected'
    });
  });

  it('uses a safe fallback when Git emits no error text', async () => {
    const runner: CommandRunner = {
      run: async () => ({ exitCode: 1, stdout: '', stderr: '' })
    };

    await expect(new GitClient(runner).exec('/repo', ['status'])).rejects.toMatchObject({
      code: 'GIT',
      message: 'Git command failed'
    });
  });

  it('accepts explicitly allowed exit codes and passes only supported runner options', async () => {
    const calls: Array<{
      command: string;
      args: readonly string[];
      options: CommandOptions;
    }> = [];
    const runner: CommandRunner = {
      run: async (command, args, options) => {
        calls.push({ command, args, options });
        return { exitCode: 3, stdout: 'not found', stderr: '' };
      }
    };
    const controller = new AbortController();

    const result = await new GitClient(runner, 'custom-git').exec(
      '/repo',
      ['show-ref', '--verify', 'refs/heads/topic'],
      { signal: controller.signal, allowedExitCodes: [1, 3] }
    );

    expect(result).toEqual({ exitCode: 3, stdout: 'not found', stderr: '' });
    expect(calls).toEqual([{
      command: 'custom-git',
      args: ['show-ref', '--verify', 'refs/heads/topic'],
      options: { cwd: '/repo', signal: controller.signal }
    }]);
  });

  it('does not add undefined optional values to runner options', async () => {
    const seenOptions: CommandOptions[] = [];
    const runner: CommandRunner = {
      run: async (_command, _args, options) => {
        seenOptions.push(options);
        return { exitCode: 0, stdout: '', stderr: '' };
      }
    };

    await new GitClient(runner).exec('/repo', ['status']);

    expect(seenOptions).toEqual([{ cwd: '/repo' }]);
  });

  it('rejects signal termination even when exit code 1 is allowed', async () => {
    const client = new GitClient(new NodeCommandRunner(), process.execPath);

    await expect(client.exec(
      process.cwd(),
      ['-e', "process.kill(process.pid, 'SIGTERM')"],
      { allowedExitCodes: [1] }
    )).rejects.toMatchObject({
      code: 'GIT',
      message: 'Git process terminated unexpectedly'
    });
  });
});
