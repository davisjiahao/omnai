import nodePath from 'node:path';
import { AiWorkspaceError } from '../domain/errors';
import type {
  AddWorktreeInput,
  BranchInfo,
  RepositoryStatus,
  WorktreeInfo
} from '../domain/types';
import type { GitClient, GitExecOptions } from './git-client';

const EXACT_BRANCH_REF_EXIT_CODES = [0, 1] as const;
const NORMAL_REF_EXIT_CODES = [0, 1] as const;
const NO_UPSTREAM_EXIT_CODES = [0, 128] as const;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;

function validationError(message: string): AiWorkspaceError {
  return new AiWorkspaceError('VALIDATION', message);
}

function containsForbiddenRefCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x20 || codePoint === 0x7f)) {
      return true;
    }
    if ('~^:?*[\\'.includes(character)) return true;
  }
  return false;
}

function isLiteralBranchName(branch: string): boolean {
  if (branch.length === 0 || branch === '@' || branch === 'HEAD') return false;
  if (branch.startsWith('refs/')) return false;
  if (branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/')) return false;
  if (branch.endsWith('.') || branch.includes('//')) return false;
  if (branch.includes('..') || branch.includes('@{')) return false;
  if (containsForbiddenRefCharacter(branch)) return false;

  return branch.split('/').every(component => (
    component.length > 0
    && !component.startsWith('.')
    && !component.endsWith('.lock')
  ));
}

function assertLiteralBranch(branch: string): void {
  if (!isLiteralBranchName(branch)) {
    throw validationError('Branch must be a literal branch name');
  }
}

function assertRemoteName(remote: string): void {
  if (remote.length === 0 || remote.startsWith('-') || !isLiteralBranchName(`${remote}/remote-check`)) {
    throw validationError('Remote must be a literal remote name');
  }
}

function assertObjectId(oid: string, label: string): void {
  if (!OBJECT_ID.test(oid)) {
    throw validationError(`${label} must be a full Git object ID`);
  }
}

function signalOptions(signal: AbortSignal | undefined): GitExecOptions | undefined {
  return signal === undefined ? undefined : { signal };
}

function codeUnitCompare(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function parseQualifiedRemoteBranch(value: string, remote: string): string | undefined {
  const prefix = `${remote}/`;
  if (!value.startsWith(prefix)) return undefined;
  const branch = value.slice(prefix.length);
  if (!isLiteralBranchName(branch)) return undefined;
  return `${remote}/${branch}`;
}

function countDirtyEntries(stdout: string): number {
  return stdout.split(/\r?\n/u).filter(line => line.length > 0).length;
}

export function parseLsRemoteHead(output: string, remote: string): string | undefined {
  for (const line of output.split(/\r?\n/u)) {
    const match = /^ref: refs\/heads\/(.+)\tHEAD$/u.exec(line);
    if (match === null) continue;
    const branch = match[1];
    if (branch !== undefined && isLiteralBranchName(branch)) {
      return `${remote}/${branch}`;
    }
  }
  return undefined;
}

export function parseWorktreePorcelain(output: string): WorktreeInfo[] {
  const records: WorktreeInfo[] = [];
  let current: WorktreeInfo | undefined;

  for (const token of output.split('\0')) {
    if (token.startsWith('worktree ')) {
      current = {
        // This is host-platform lexical normalization only. It intentionally does not
        // resolve symlinks or case-fold aliases; canonical identity belongs upstream.
        path: nodePath.normalize(token.slice('worktree '.length)),
        bare: false,
        detached: false
      };
      records.push(current);
      continue;
    }
    if (current === undefined) continue;
    if (token.startsWith('HEAD ')) {
      current.head = token.slice('HEAD '.length);
    } else if (token.startsWith('branch ')) {
      current.branch = token.slice('branch '.length);
    } else if (token === 'bare') {
      current.bare = true;
    } else if (token === 'detached') {
      current.detached = true;
    }
  }

  return records;
}

export class RepositoryService {
  private readonly validatedBaseRefs = new Map<string, Set<string>>();

  constructor(private readonly git: Pick<GitClient, 'exec'>) {}

  async assertUsableRepository(sourcePath: string, remote: string): Promise<void> {
    assertRemoteName(remote);
    try {
      const inside = await this.git.exec(sourcePath, ['rev-parse', '--is-inside-work-tree']);
      if (inside.stdout.trim() !== 'true') {
        throw new Error('not a work tree');
      }

      await this.git.exec(sourcePath, ['remote', 'get-url', remote]);
      await this.git.exec(sourcePath, ['worktree', 'list', '--porcelain', '-z']);
      await this.git.exec(
        sourcePath,
        ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`],
        { allowedExitCodes: NORMAL_REF_EXIT_CODES }
      );
      await this.git.exec(
        sourcePath,
        ['check-ref-format', '--branch', 'ai-workspace-capability-check']
      );
    } catch {
      throw new AiWorkspaceError(
        'GIT',
        `Repository is not usable; verify the source path, remote, and Git worktree support`,
        { sourcePath, remote }
      );
    }
  }

  async detectRemoteTrunk(
    sourcePath: string,
    remote: string,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    assertRemoteName(remote);
    const options = signalOptions(signal);
    const localHead = await this.git.exec(
      sourcePath,
      ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`],
      options === undefined
        ? { allowedExitCodes: NORMAL_REF_EXIT_CODES }
        : { ...options, allowedExitCodes: NORMAL_REF_EXIT_CODES }
    );
    if (localHead.exitCode === 0) {
      const qualified = parseQualifiedRemoteBranch(localHead.stdout.trim(), remote);
      if (qualified !== undefined) return qualified;
    }

    const remoteHead = options === undefined
      ? await this.git.exec(sourcePath, ['ls-remote', '--symref', remote, 'HEAD'])
      : await this.git.exec(sourcePath, ['ls-remote', '--symref', remote, 'HEAD'], options);
    const parsedRemoteHead = parseLsRemoteHead(remoteHead.stdout, remote);
    if (parsedRemoteHead !== undefined) return parsedRemoteHead;

    for (const fallback of ['main', 'master'] as const) {
      const fallbackOptions: GitExecOptions = options === undefined
        ? { allowedExitCodes: NORMAL_REF_EXIT_CODES }
        : { ...options, allowedExitCodes: NORMAL_REF_EXIT_CODES };
      const probe = await this.git.exec(
        sourcePath,
        ['show-ref', '--verify', '--quiet', `refs/remotes/${remote}/${fallback}`],
        fallbackOptions
      );
      if (probe.exitCode === 0) return `${remote}/${fallback}`;
    }
    return undefined;
  }

  async listRemoteBranches(sourcePath: string, remote: string): Promise<string[]> {
    assertRemoteName(remote);
    const result = await this.git.exec(sourcePath, [
      'for-each-ref',
      '--format=%(refname:short)',
      `refs/remotes/${remote}`
    ]);
    const head = `${remote}/HEAD`;
    const branches = result.stdout
      .split(/\r?\n/u)
      .map(value => value.trim())
      .filter(value => value.length > 0 && value !== head)
      .filter(value => parseQualifiedRemoteBranch(value, remote) !== undefined);
    return [...new Set(branches)].sort(codeUnitCompare);
  }

  async fetch(sourcePath: string, remote: string, signal?: AbortSignal): Promise<void> {
    assertRemoteName(remote);
    const args = ['fetch', '--prune', remote] as const;
    const options = signalOptions(signal);
    if (options === undefined) {
      await this.git.exec(sourcePath, args);
    } else {
      await this.git.exec(sourcePath, args, options);
    }
  }

  async validateBaseRef(
    sourcePath: string,
    remote: string,
    baseRef: string
  ): Promise<void> {
    assertRemoteName(remote);
    if (baseRef.startsWith('-')) {
      throw validationError('Base ref must not look like an option');
    }
    const prefix = `${remote}/`;
    if (!baseRef.startsWith(prefix) || baseRef.length === prefix.length) {
      throw validationError('Base ref must belong to the configured remote');
    }

    const branch = baseRef.slice(prefix.length);
    await this.validateBranchName(sourcePath, branch);
    let refs = this.validatedBaseRefs.get(sourcePath);
    if (refs === undefined) {
      refs = new Set<string>();
      this.validatedBaseRefs.set(sourcePath, refs);
    }
    refs.add(baseRef);
  }

  async resolveCommit(sourcePath: string, ref: string): Promise<string> {
    if (!this.validatedBaseRefs.get(sourcePath)?.has(ref)) {
      throw validationError('Base ref must be validated before it is resolved');
    }
    const result = await this.git.exec(
      sourcePath,
      ['rev-parse', '--verify', `refs/remotes/${ref}^{commit}`]
    );
    const oid = result.stdout.trim();
    if (!OBJECT_ID.test(oid)) {
      throw new AiWorkspaceError('GIT', 'Git returned an invalid commit object ID', {
        sourcePath,
        ref
      });
    }
    return oid;
  }

  async validateBranchName(sourcePath: string, branch: string): Promise<void> {
    assertLiteralBranch(branch);
    const result = await this.git.exec(
      sourcePath,
      ['check-ref-format', '--branch', branch]
    );
    if (result.stdout.trim() !== branch) {
      throw validationError('Git did not preserve the literal branch name');
    }
  }

  async listWorktrees(sourcePath: string): Promise<WorktreeInfo[]> {
    const result = await this.git.exec(
      sourcePath,
      ['worktree', 'list', '--porcelain', '-z']
    );
    return parseWorktreePorcelain(result.stdout);
  }

  async getBranchInfo(sourcePath: string, branch: string): Promise<BranchInfo> {
    assertLiteralBranch(branch);
    const fullRef = `refs/heads/${branch}`;
    const result = await this.git.exec(
      sourcePath,
      ['rev-parse', '--verify', '--quiet', fullRef],
      { allowedExitCodes: EXACT_BRANCH_REF_EXIT_CODES }
    );
    if (result.exitCode !== 0) return { exists: false };

    const head = result.stdout.trim();
    if (!OBJECT_ID.test(head)) {
      throw new AiWorkspaceError('GIT', 'Git returned an invalid branch object ID', {
        sourcePath,
        branch
      });
    }
    const occupyingWorktree = (await this.listWorktrees(sourcePath))
      .find(worktree => worktree.branch === fullRef);
    if (occupyingWorktree === undefined) return { exists: true, head };
    return { exists: true, head, worktreePath: occupyingWorktree.path };
  }

  async addWorktree(input: AddWorktreeInput): Promise<void> {
    assertLiteralBranch(input.branch);
    if (input.createBranch) assertObjectId(input.baseCommit, 'Base commit');
    const args = input.createBranch
      ? [
          'worktree',
          'add',
          '-b',
          input.branch,
          input.targetPath,
          input.baseCommit
        ]
      : ['worktree', 'add', input.targetPath, input.branch];
    const options = signalOptions(input.signal);
    if (options === undefined) {
      await this.git.exec(input.sourcePath, args);
    } else {
      await this.git.exec(input.sourcePath, args, options);
    }
  }

  async removeWorktree(sourcePath: string, worktreePath: string): Promise<void> {
    await this.git.exec(sourcePath, ['worktree', 'remove', '--', worktreePath]);
  }

  async deleteBranchIfAt(
    sourcePath: string,
    branch: string,
    expectedOid: string
  ): Promise<boolean> {
    assertLiteralBranch(branch);
    assertObjectId(expectedOid, 'Expected branch commit');
    const fullRef = `refs/heads/${branch}`;
    const current = await this.git.exec(
      sourcePath,
      ['rev-parse', '--verify', '--quiet', fullRef],
      { allowedExitCodes: EXACT_BRANCH_REF_EXIT_CODES }
    );
    if (current.exitCode !== 0) return false;
    if (current.stdout.trim().toLowerCase() !== expectedOid.toLowerCase()) return false;

    const occupied = (await this.listWorktrees(sourcePath))
      .some(worktree => worktree.branch === fullRef);
    if (occupied) return false;

    // Git has no atomic operation spanning the worktree registry and refs. Keep the
    // occupancy check adjacent to the OID-CAS deletion to minimize that external race.
    await this.git.exec(sourcePath, ['update-ref', '-d', fullRef, expectedOid]);
    return true;
  }

  async getStatus(worktreePath: string): Promise<RepositoryStatus> {
    const status = await this.git.exec(worktreePath, ['status', '--porcelain=v1']);
    const dirtyFileCount = countDirtyEntries(status.stdout);
    const upstreamResult = await this.git.exec(
      worktreePath,
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      { allowedExitCodes: NO_UPSTREAM_EXIT_CODES }
    );
    const upstream = upstreamResult.exitCode === 0 ? upstreamResult.stdout.trim() : '';
    if (upstream.length === 0) {
      return {
        dirtyFileCount,
        ahead: 0,
        behind: 0,
        publication: 'no-upstream'
      };
    }

    const counts = await this.git.exec(
      worktreePath,
      ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']
    );
    const match = /^(\d+)\s+(\d+)$/u.exec(counts.stdout.trim());
    if (match === null) {
      throw new AiWorkspaceError('GIT', 'Git returned invalid ahead/behind counts', {
        worktreePath
      });
    }
    const ahead = Number(match[1]);
    const behind = Number(match[2]);
    return {
      dirtyFileCount,
      upstream,
      ahead,
      behind,
      publication: ahead > 0 ? 'ahead' : 'synced'
    };
  }

  async isClean(worktreePath: string): Promise<boolean> {
    const status = await this.git.exec(worktreePath, ['status', '--porcelain=v1']);
    return countDirtyEntries(status.stdout) === 0;
  }
}
