import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AiWorkspaceError } from '../domain/errors';
import { GitClient } from './git-client';
import type { GitExecOptions, GitResult } from './git-client';
import {
  parseLsRemoteHead,
  parseWorktreePorcelain,
  RepositoryService
} from './repository-service';

interface GitCall {
  cwd: string;
  args: readonly string[];
  options: GitExecOptions | undefined;
}

type QueuedResult = GitResult | Error;

function result(
  stdout = '',
  exitCode = 0,
  stderr = ''
): GitResult {
  return { exitCode, stdout, stderr };
}

function queueGit(...queued: QueuedResult[]) {
  const calls: GitCall[] = [];
  const exec = vi.fn(async (
    cwd: string,
    args: readonly string[],
    options?: GitExecOptions
  ): Promise<GitResult> => {
    calls.push({ cwd, args: [...args], options });
    const next = queued.shift();
    if (next === undefined) {
      throw new Error(`Unexpected Git call: ${args.join(' ')}`);
    }
    if (next instanceof Error) throw next;
    return next;
  });
  return { calls, exec };
}

describe('parseLsRemoteHead', () => {
  it('parses the HEAD symref and qualifies it with the configured remote', () => {
    expect(parseLsRemoteHead(
      'ref: refs/heads/main\tHEAD\nabc\tHEAD\n',
      'origin'
    )).toBe('origin/main');
  });

  it('ignores symrefs that are not the remote HEAD', () => {
    expect(parseLsRemoteHead(
      'ref: refs/heads/main\trefs/heads/alias\nabc\tHEAD\n',
      'origin'
    )).toBeUndefined();
  });
});

describe('parseWorktreePorcelain', () => {
  it('parses NUL-delimited worktrees and maps branches to occupied paths', () => {
    const records = parseWorktreePorcelain(
      'worktree /code/main\0HEAD aaa\0branch refs/heads/main\0\0' +
      'worktree /work/REQ-1\0HEAD bbb\0branch refs/heads/feature/REQ-1\0\0'
    );

    expect(records).toEqual([
      {
        path: path.normalize('/code/main'),
        head: 'aaa',
        branch: 'refs/heads/main',
        bare: false,
        detached: false
      },
      {
        path: path.normalize('/work/REQ-1'),
        head: 'bbb',
        branch: 'refs/heads/feature/REQ-1',
        bare: false,
        detached: false
      }
    ]);
  });

  it('preserves unusual paths and parses standalone bare/detached flags', () => {
    const records = parseWorktreePorcelain(
      'worktree /work/line\nbreak\0HEAD ccc\0detached\0\0' +
      'worktree /repo.git\0bare\0\0'
    );

    expect(records).toEqual([
      {
        path: path.normalize('/work/line\nbreak'),
        head: 'ccc',
        bare: false,
        detached: true
      },
      {
        path: path.normalize('/repo.git'),
        bare: true,
        detached: false
      }
    ]);
  });

  it('normalizes worktree paths lexically for the current platform', () => {
    const rawPath = [path.sep, 'work', path.sep, 'team', path.sep, '..', path.sep, 'REQ-1']
      .join('');

    expect(parseWorktreePorcelain(`worktree ${rawPath}\0bare\0`)[0]?.path)
      .toBe(path.normalize(rawPath));
  });
});

describe('RepositoryService repository inspection', () => {
  it('preflights repository, remote, and required read-only capabilities', async () => {
    const git = queueGit(
      result('true\n'),
      result('git@example.com:team/repo.git\n'),
      result('worktree /repo\0bare\0'),
      result(''),
      result('ai-workspace-capability-check\n')
    );

    await expect(new RepositoryService(git).assertUsableRepository('/repo', 'origin'))
      .resolves.toBeUndefined();

    expect(git.calls).toEqual([
      { cwd: '/repo', args: ['rev-parse', '--is-inside-work-tree'], options: undefined },
      { cwd: '/repo', args: ['remote', 'get-url', 'origin'], options: undefined },
      { cwd: '/repo', args: ['worktree', 'list', '--porcelain', '-z'], options: undefined },
      {
        cwd: '/repo',
        args: ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
        options: { allowedExitCodes: [0, 1] }
      },
      {
        cwd: '/repo',
        args: ['check-ref-format', '--branch', 'ai-workspace-capability-check'],
        options: undefined
      }
    ]);
  });

  it('reports one actionable Git error when the path is not a work tree', async () => {
    const git = queueGit(result('false\n'));

    await expect(new RepositoryService(git).assertUsableRepository('/not-a-repo', 'origin'))
      .rejects.toMatchObject({
        code: 'GIT',
        details: { sourcePath: '/not-a-repo', remote: 'origin' }
      });
    expect(git.calls).toHaveLength(1);
  });

  it('rejects an option-like remote before invoking Git', async () => {
    const git = queueGit();

    await expect(new RepositoryService(git).assertUsableRepository('/repo', '--upload-pack=bad'))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    expect(git.calls).toHaveLength(0);
  });
});

describe('RepositoryService remote branch handling', () => {
  it('prefers the local remote HEAD over network and main/master fallbacks', async () => {
    const git = queueGit(result('origin/trunk\n'));
    const service = new RepositoryService(git);

    await expect(service.detectRemoteTrunk('/repo', 'origin')).resolves.toBe('origin/trunk');
    expect(git.calls).toEqual([{
      cwd: '/repo',
      args: ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
      options: { allowedExitCodes: [0, 1] }
    }]);
  });

  it('falls back to the remote HEAD symref', async () => {
    const git = queueGit(
      result('', 1),
      result('ref: refs/heads/develop\tHEAD\nabc\tHEAD\n')
    );

    await expect(new RepositoryService(git).detectRemoteTrunk('/repo', 'origin'))
      .resolves.toBe('origin/develop');
    expect(git.calls[1]).toEqual({
      cwd: '/repo',
      args: ['ls-remote', '--symref', 'origin', 'HEAD'],
      options: undefined
    });
  });

  it('falls back to origin/main and stops before checking master', async () => {
    const git = queueGit(result('', 1), result('abc\tHEAD\n'), result());

    await expect(new RepositoryService(git).detectRemoteTrunk('/repo', 'origin'))
      .resolves.toBe('origin/main');
    expect(git.calls.at(-1)).toEqual({
      cwd: '/repo',
      args: ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/main'],
      options: { allowedExitCodes: [0, 1] }
    });
    expect(git.calls).toHaveLength(3);
  });

  it('falls back from absent main to master, then returns undefined when both are absent', async () => {
    const masterGit = queueGit(
      result('', 1),
      result('abc\tHEAD\n'),
      result('', 1),
      result()
    );
    await expect(new RepositoryService(masterGit).detectRemoteTrunk('/repo', 'upstream'))
      .resolves.toBe('upstream/master');
    expect(masterGit.calls.at(-1)?.args).toEqual([
      'show-ref', '--verify', '--quiet', 'refs/remotes/upstream/master'
    ]);

    const absentGit = queueGit(
      result('', 1),
      result('abc\tHEAD\n'),
      result('', 1),
      result('', 1)
    );
    await expect(new RepositoryService(absentGit).detectRemoteTrunk('/repo', 'origin'))
      .resolves.toBeUndefined();
  });

  it('lists, filters, deduplicates, and code-unit sorts remote branches', async () => {
    const git = queueGit(result([
      'origin/zeta',
      'origin/HEAD',
      'origin/alpha',
      'origin/zeta',
      'origin/Beta',
      ''
    ].join('\n')));

    await expect(new RepositoryService(git).listRemoteBranches('/repo', 'origin'))
      .resolves.toEqual(['origin/Beta', 'origin/alpha', 'origin/zeta']);
    expect(git.calls[0]?.args).toEqual([
      'for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'
    ]);
  });

  it('fetches only the configured remote and forwards cancellation', async () => {
    const git = queueGit(result());
    const signal = new AbortController().signal;

    await new RepositoryService(git).fetch('/repo', 'origin', signal);

    expect(git.calls).toEqual([{
      cwd: '/repo',
      args: ['fetch', '--prune', 'origin'],
      options: { signal }
    }]);
  });
});

describe('RepositoryService ref validation and resolution', () => {
  it('rejects a base outside the configured remote and option-like input without Git', async () => {
    const git = queueGit();
    const service = new RepositoryService(git);

    await expect(service.validateBaseRef('/repo', 'origin', 'upstream/main'))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(service.validateBaseRef('/repo', 'origin', '--upload-pack=bad'))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(service.validateBaseRef('/repo', 'origin', 'origin/-bad'))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    expect(git.calls).toHaveLength(0);
  });

  it('validates the branch suffix and resolves only a previously validated remote ref', async () => {
    const oid = 'a'.repeat(40);
    const git = queueGit(result('release/v2\n'), result(`${oid}\n`));
    const service = new RepositoryService(git);

    await service.validateBaseRef('/repo', 'origin', 'origin/release/v2');
    await expect(service.resolveCommit('/repo', 'origin/release/v2')).resolves.toBe(oid);

    expect(git.calls).toEqual([
      {
        cwd: '/repo',
        args: ['check-ref-format', '--branch', 'release/v2'],
        options: undefined
      },
      {
        cwd: '/repo',
        args: ['rev-parse', '--verify', 'refs/remotes/origin/release/v2^{commit}'],
        options: undefined
      }
    ]);
  });

  it('does not accept an arbitrary revision expression in resolveCommit', async () => {
    const git = queueGit();
    const service = new RepositoryService(git);

    await expect(service.resolveCommit('/repo', 'origin/main~0'))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(service.resolveCommit('/repo', 'origin/main'))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    expect(git.calls).toHaveLength(0);
  });

  it.each(['@{-1}', 'main~0', 'main^{commit}', '@', 'refs/heads/main'])(
    'rejects revision shorthand %s as a literal branch name',
    async branch => {
      const git = queueGit();

      await expect(new RepositoryService(git).validateBranchName('/repo', branch))
        .rejects.toMatchObject({ code: 'VALIDATION' });
      expect(git.calls).toHaveLength(0);
    }
  );

  it('rejects check-ref-format output that Git normalized to another branch', async () => {
    const git = queueGit(result('main\n'));

    await expect(new RepositoryService(git).validateBranchName('/repo', 'topic'))
      .rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('RepositoryService branch and worktree management', () => {
  it('finds an existing branch and its occupying worktree path', async () => {
    const oid = 'b'.repeat(40);
    const git = queueGit(
      result(`${oid}\n`),
      result(
        `worktree /repo\0HEAD ${'a'.repeat(40)}\0branch refs/heads/main\0\0` +
        `worktree /work/REQ-1\0HEAD ${oid}\0branch refs/heads/feature/REQ-1\0\0`
      )
    );

    await expect(new RepositoryService(git).getBranchInfo('/repo', 'feature/REQ-1'))
      .resolves.toEqual({
        exists: true,
        head: oid,
        worktreePath: path.normalize('/work/REQ-1')
      });
    expect(git.calls).toEqual([
      {
        cwd: '/repo',
        args: ['rev-parse', '--verify', '--quiet', 'refs/heads/feature/REQ-1'],
        options: { allowedExitCodes: [0, 1] }
      },
      {
        cwd: '/repo',
        args: ['worktree', 'list', '--porcelain', '-z'],
        options: undefined
      }
    ]);
  });

  it('treats only exact-ref exit code 1 as a missing branch', async () => {
    const git = queueGit(result('', 1));

    await expect(new RepositoryService(git).getBranchInfo('/repo', 'feature/REQ-1'))
      .resolves.toEqual({ exists: false });
    expect(git.calls).toHaveLength(1);
    expect(git.calls[0]?.options).toEqual({ allowedExitCodes: [0, 1] });
  });

  it('uses exact argument arrays for new and existing branch worktrees', async () => {
    const signal = new AbortController().signal;
    const git = queueGit(result(), result());
    const service = new RepositoryService(git);

    await service.addWorktree({
      sourcePath: '/repo',
      targetPath: '/work/REQ-1/repo',
      branch: 'feature/REQ-1',
      baseCommit: 'a'.repeat(40),
      createBranch: true,
      signal
    });
    await service.addWorktree({
      sourcePath: '/repo',
      targetPath: '/work/REQ-1/repo',
      branch: 'feature/REQ-1',
      baseCommit: 'a'.repeat(40),
      createBranch: false,
      signal
    });

    expect(git.calls).toEqual([
      {
        cwd: '/repo',
        args: [
          'worktree', 'add', '-b', 'feature/REQ-1',
          '/work/REQ-1/repo', 'a'.repeat(40)
        ],
        options: { signal }
      },
      {
        cwd: '/repo',
        args: ['worktree', 'add', '/work/REQ-1/repo', 'feature/REQ-1'],
        options: { signal }
      }
    ]);
  });

  it('removes a worktree without force and terminates option parsing', async () => {
    const git = queueGit(result());

    await new RepositoryService(git).removeWorktree('/repo', '-odd-path');

    expect(git.calls[0]).toEqual({
      cwd: '/repo',
      args: ['worktree', 'remove', '--', '-odd-path'],
      options: undefined
    });
  });

  it('uses update-ref with an expected OID when deleting a transaction-created branch', async () => {
    const oid = 'c'.repeat(40);
    const git = queueGit(
      result(`${oid}\n`),
      result(`worktree /repo\0HEAD ${oid}\0branch refs/heads/main\0\0`),
      result()
    );

    await expect(new RepositoryService(git).deleteBranchIfAt('/repo', 'feature/REQ-1', oid))
      .resolves.toBe(true);
    expect(git.calls[2]).toEqual({
      cwd: '/repo',
      args: ['update-ref', '-d', 'refs/heads/feature/REQ-1', oid],
      options: undefined
    });
  });

  it('does not delete a branch occupied by an exact worktree record', async () => {
    const oid = 'c'.repeat(40);
    const git = queueGit(
      result(`${oid}\n`),
      result(
        `worktree /work/REQ-1\0HEAD ${oid}\0` +
        'branch refs/heads/feature/REQ-1\0\0'
      )
    );

    await expect(new RepositoryService(git).deleteBranchIfAt('/repo', 'feature/REQ-1', oid))
      .resolves.toBe(false);
    expect(git.calls).toEqual([
      {
        cwd: '/repo',
        args: ['rev-parse', '--verify', '--quiet', 'refs/heads/feature/REQ-1'],
        options: { allowedExitCodes: [0, 1] }
      },
      {
        cwd: '/repo',
        args: ['worktree', 'list', '--porcelain', '-z'],
        options: undefined
      }
    ]);
  });

  it('does not delete an absent or advanced branch', async () => {
    const expected = 'd'.repeat(40);
    const absentGit = queueGit(result('', 1));
    await expect(new RepositoryService(absentGit).deleteBranchIfAt(
      '/repo', 'feature/REQ-1', expected
    )).resolves.toBe(false);
    expect(absentGit.calls).toHaveLength(1);

    const advancedGit = queueGit(result(`${'e'.repeat(40)}\n`));
    await expect(new RepositoryService(advancedGit).deleteBranchIfAt(
      '/repo', 'feature/REQ-1', expected
    )).resolves.toBe(false);
    expect(advancedGit.calls).toHaveLength(1);
  });

  it('propagates exit 128 Git errors for branch lookup and deletion', async () => {
    const lookupGit = queueGit(new AiWorkspaceError(
      'GIT',
      'fatal: not a git repository',
      { exitCode: 128 }
    ));
    await expect(new RepositoryService(lookupGit).getBranchInfo('/broken', 'feature/REQ-1'))
      .rejects.toMatchObject({ code: 'GIT', details: { exitCode: 128 } });

    const deleteGit = queueGit(new AiWorkspaceError(
      'GIT',
      'fatal: not a git repository',
      { exitCode: 128 }
    ));
    await expect(new RepositoryService(deleteGit).deleteBranchIfAt(
      '/broken', 'feature/REQ-1', 'a'.repeat(40)
    )).rejects.toMatchObject({ code: 'GIT', details: { exitCode: 128 } });
  });

  it.each(['@{-1}', 'topic~0', 'topic^{commit}', '@', 'refs/tags/v1'])(
    'blocks branch consumer input %s before any Git mutation or lookup',
    async branch => {
      const git = queueGit();
      const service = new RepositoryService(git);

      await expect(service.getBranchInfo('/repo', branch))
        .rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(service.addWorktree({
        sourcePath: '/repo',
        targetPath: '/work/repo',
        branch,
        baseCommit: 'a'.repeat(40),
        createBranch: false
      })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(service.deleteBranchIfAt('/repo', branch, 'a'.repeat(40)))
        .rejects.toMatchObject({ code: 'VALIDATION' });
      expect(git.calls).toHaveLength(0);
    }
  );
});

describe('RepositoryService real Git regressions', () => {
  it('keeps a branch that is checked out in a linked worktree', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-workspace-occupied-'));
    const sourcePath = path.join(root, 'source');
    const worktreePath = path.join(root, 'linked');
    const git = new GitClient();
    try {
      await mkdir(sourcePath);
      await git.exec(sourcePath, ['init']);
      await git.exec(sourcePath, [
        '-c', 'user.name=AI Workspace Test',
        '-c', 'user.email=ai-workspace@example.invalid',
        'commit', '--allow-empty', '-m', 'initial'
      ]);
      await git.exec(sourcePath, [
        'worktree', 'add', '-b', 'feature/REQ-1', worktreePath, 'HEAD'
      ]);
      const oid = (await git.exec(sourcePath, [
        'rev-parse', '--verify', '--quiet', 'refs/heads/feature/REQ-1'
      ])).stdout.trim();

      await expect(new RepositoryService(git).deleteBranchIfAt(
        sourcePath,
        'feature/REQ-1',
        oid
      )).resolves.toBe(false);
      await expect(git.exec(sourcePath, [
        'rev-parse', '--verify', '--quiet', 'refs/heads/feature/REQ-1'
      ], { allowedExitCodes: [0, 1] })).resolves.toMatchObject({ exitCode: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('distinguishes a missing exact branch from a real exit 128 repository error', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-workspace-ref-errors-'));
    const sourcePath = path.join(root, 'source');
    const notRepositoryPath = path.join(root, 'not-a-repository');
    const git = new GitClient();
    try {
      await mkdir(sourcePath);
      await mkdir(notRepositoryPath);
      await git.exec(sourcePath, ['init']);
      const service = new RepositoryService(git);

      await expect(service.getBranchInfo(sourcePath, 'feature/missing'))
        .resolves.toEqual({ exists: false });
      await expect(service.deleteBranchIfAt(
        sourcePath,
        'feature/missing',
        'a'.repeat(40)
      )).resolves.toBe(false);
      await expect(service.getBranchInfo(notRepositoryPath, 'feature/missing'))
        .rejects.toMatchObject({ code: 'GIT', details: { exitCode: 128 } });
      await expect(service.deleteBranchIfAt(
        notRepositoryPath,
        'feature/missing',
        'a'.repeat(40)
      )).rejects.toMatchObject({ code: 'GIT', details: { exitCode: 128 } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('RepositoryService status', () => {
  it('counts dirty entries and reports no upstream from Git exit 128', async () => {
    const git = queueGit(
      result(' M src/a.ts\n?? src/b.ts\n\n'),
      result('', 128, 'fatal: no upstream configured')
    );

    await expect(new RepositoryService(git).getStatus('/work/repo')).resolves.toEqual({
      dirtyFileCount: 2,
      ahead: 0,
      behind: 0,
      publication: 'no-upstream'
    });
    expect(git.calls[1]).toEqual({
      cwd: '/work/repo',
      args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      options: { allowedExitCodes: [0, 128] }
    });
  });

  it('parses ahead/behind and classifies unpublished commits as ahead', async () => {
    const git = queueGit(
      result(''),
      result('origin/feature/REQ-1\n'),
      result('2\t3\n')
    );

    await expect(new RepositoryService(git).getStatus('/work/repo')).resolves.toEqual({
      dirtyFileCount: 0,
      upstream: 'origin/feature/REQ-1',
      ahead: 2,
      behind: 3,
      publication: 'ahead'
    });
    expect(git.calls[2]?.args).toEqual([
      'rev-list', '--left-right', '--count', 'HEAD...@{upstream}'
    ]);
  });

  it('reports synced when HEAD has no commits absent from upstream', async () => {
    const git = queueGit(result(''), result('origin/main\n'), result('0 4\n'));

    await expect(new RepositoryService(git).getStatus('/work/repo')).resolves.toMatchObject({
      ahead: 0,
      behind: 4,
      publication: 'synced'
    });
  });

  it('checks cleanliness without querying publication state', async () => {
    const cleanGit = queueGit(result(''));
    await expect(new RepositoryService(cleanGit).isClean('/work/repo')).resolves.toBe(true);
    expect(cleanGit.calls).toHaveLength(1);
    expect(cleanGit.calls[0]?.args).toEqual(['status', '--porcelain=v1']);

    const dirtyGit = queueGit(result('?? file.txt\n'));
    await expect(new RepositoryService(dirtyGit).isClean('/work/repo')).resolves.toBe(false);
  });

  it('rejects malformed ahead/behind output instead of treating it as safe', async () => {
    const git = queueGit(result(''), result('origin/main\n'), result('not-a-count\n'));

    await expect(new RepositoryService(git).getStatus('/work/repo'))
      .rejects.toBeInstanceOf(AiWorkspaceError);
  });
});
