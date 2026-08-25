import { spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { writeYaml } from '../../core/files.js';
import { sha256 } from '../hashing.js';
import { contentHashSchema, type ContentHash } from '../types.js';

const gitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const projectSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

const coordinationSnapshotRequestSchema = z.strictObject({
  home: z.string().min(1),
  worksetId: z.string().regex(/^WKS-\d{4}$/),
  runId: z.string().regex(/^RUN-\d{4}$/),
  project: projectSchema,
  repoRoot: z.string().min(1),
  head: gitObjectIdSchema,
});

const reviewerSnapshotRequestSchema = z.strictObject({
  home: z.string().min(1),
  worksetId: z.string().regex(/^WKS-\d{4}$/),
  runId: z.string().regex(/^RUN-\d{4}$/),
  project: projectSchema,
  repoRoot: z.string().min(1),
  startingHead: gitObjectIdSchema,
  patch: z.string().min(1),
  diffHash: contentHashSchema,
});

export type CoordinationSnapshotRequest = z.infer<typeof coordinationSnapshotRequestSchema>;
export type ReviewerSnapshotRequest = z.infer<typeof reviewerSnapshotRequestSchema>;

export interface DisposableSnapshot {
  schemaVersion: 1;
  kind: 'COORDINATION' | 'REVIEWER';
  worksetId: string;
  runId: string;
  project: string;
  path: string;
  sourceRepoRoot: string;
  head: string;
  contentHash: ContentHash;
  readOnly: true;
}

export async function materializeCoordinationSnapshot(
  request: CoordinationSnapshotRequest,
): Promise<DisposableSnapshot> {
  const parsed = coordinationSnapshotRequestSchema.parse(request);
  const sourceRepoRoot = requireExistingDirectory(parsed.repoRoot, 'SNAPSHOT_SOURCE_REPOSITORY_INVALID');
  const home = requireExistingDirectory(parsed.home, 'SNAPSHOT_HOME_INVALID');
  const path = snapshotPath(home, parsed.worksetId, parsed.runId, parsed.project);
  if (existsSync(path)) throw new Error(`SNAPSHOT_ALREADY_EXISTS: ${path}`);
  await mkdir(dirname(path), { recursive: true });

  const head = (await runGitText(sourceRepoRoot, ['rev-parse', '--verify', `${parsed.head}^{commit}`])).trim();
  if (head !== parsed.head) throw new Error('SNAPSHOT_HEAD_MISMATCH');
  try {
    await runGit(sourceRepoRoot, ['worktree', 'add', '--detach', path, head]);
    await verifyDetachedHead(path, head);
    const treeInventory = await runGit(sourceRepoRoot, ['ls-tree', '-r', '--full-tree', head]);
    await makeReadOnly(path);
    return Object.freeze({
      schemaVersion: 1,
      kind: 'COORDINATION',
      worksetId: parsed.worksetId,
      runId: parsed.runId,
      project: parsed.project,
      path,
      sourceRepoRoot,
      head,
      contentHash: sha256(treeInventory),
      readOnly: true,
    });
  } catch (error) {
    await removeFailedWorktree(sourceRepoRoot, path);
    throw error;
  }
}

export async function materializeReviewerSnapshot(
  request: ReviewerSnapshotRequest,
): Promise<DisposableSnapshot> {
  const parsed = reviewerSnapshotRequestSchema.parse(request);
  const sourceRepoRoot = requireExistingDirectory(parsed.repoRoot, 'SNAPSHOT_SOURCE_REPOSITORY_INVALID');
  const home = requireExistingDirectory(parsed.home, 'SNAPSHOT_HOME_INVALID');
  const path = snapshotPath(home, parsed.worksetId, parsed.runId, parsed.project);
  if (existsSync(path)) throw new Error(`SNAPSHOT_ALREADY_EXISTS: ${path}`);
  await mkdir(dirname(path), { recursive: true });

  const head = (await runGitText(sourceRepoRoot, ['rev-parse', '--verify', `${parsed.startingHead}^{commit}`])).trim();
  if (head !== parsed.startingHead) throw new Error('SNAPSHOT_HEAD_MISMATCH');
  try {
    await runGit(sourceRepoRoot, ['worktree', 'add', '--detach', path, head]);
    await verifyDetachedHead(path, head);
    await runGit(path, ['apply', '--binary', '--whitespace=nowarn', '-'], Buffer.from(parsed.patch, 'utf8'));
    const reproducedDiff = await runGit(path, ['diff', '--binary', '--no-ext-diff']);
    const reproducedHash = sha256(reproducedDiff);
    if (reproducedHash !== parsed.diffHash) {
      throw new Error(`REVIEWER_DIFF_HASH_MISMATCH: expected ${parsed.diffHash}, received ${reproducedHash}`);
    }
    await makeReadOnly(path);
    return Object.freeze({
      schemaVersion: 1,
      kind: 'REVIEWER',
      worksetId: parsed.worksetId,
      runId: parsed.runId,
      project: parsed.project,
      path,
      sourceRepoRoot,
      head,
      contentHash: reproducedHash,
      readOnly: true,
    });
  } catch (error) {
    await removeFailedWorktree(sourceRepoRoot, path);
    throw error;
  }
}

export async function disposeSnapshot(snapshot: DisposableSnapshot): Promise<void> {
  if (!existsSync(snapshot.path)) {
    const registration = await findWorktreeRegistration(snapshot.sourceRepoRoot, snapshot.path);
    if (!registration) return;
    await recordAttention(snapshot, 'SNAPSHOT_PATH_MISSING', 'Registered worktree path no longer exists.');
    throw new Error('SNAPSHOT_OWNERSHIP_UNPROVEN: registered path is missing');
  }

  const registration = await findWorktreeRegistration(snapshot.sourceRepoRoot, snapshot.path);
  if (!registration || registration.head !== snapshot.head || !registration.detached) {
    await recordAttention(snapshot, 'SNAPSHOT_OWNERSHIP_UNPROVEN', 'Git registration does not match snapshot identity.');
    throw new Error('SNAPSHOT_OWNERSHIP_UNPROVEN: refusing to remove an unproven path');
  }

  try {
    await makeWritable(snapshot.path);
    await runGit(snapshot.sourceRepoRoot, ['worktree', 'remove', '--force', snapshot.path]);
  } catch (error) {
    if (existsSync(snapshot.path)) await makeReadOnly(snapshot.path).catch(() => undefined);
    await recordAttention(snapshot, 'SNAPSHOT_REMOVAL_FAILED', errorMessage(error));
    throw new Error('SNAPSHOT_REMOVAL_FAILED: disposable worktree was preserved', { cause: error });
  }
}

function snapshotPath(home: string, worksetId: string, runId: string, project: string): string {
  return join(home, 'worksets', worksetId, 'execution', 'runs', runId, 'snapshots', project);
}

function requireExistingDirectory(path: string, code: string): string {
  const absolute = resolve(path);
  if (absolute !== path || !existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new Error(`${code}: normalized existing directory required`);
  }
  try {
    return realpathSync.native(absolute);
  } catch (error) {
    throw new Error(`${code}: ${absolute}`, { cause: error });
  }
}

async function verifyDetachedHead(path: string, expectedHead: string): Promise<void> {
  const actualHead = (await runGitText(path, ['rev-parse', 'HEAD'])).trim();
  const branch = (await runGitText(path, ['branch', '--show-current'])).trim();
  if (actualHead !== expectedHead || branch.length > 0) throw new Error('SNAPSHOT_DETACHED_HEAD_REQUIRED');
}

async function makeReadOnly(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    for (const entry of await readdir(path)) await makeReadOnly(join(path, entry));
  }
  await chmod(path, metadata.mode & ~0o222);
}

async function makeWritable(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) return;
  await chmod(path, metadata.mode | 0o200);
  if (metadata.isDirectory()) {
    for (const entry of await readdir(path)) await makeWritable(join(path, entry));
  }
}

async function removeFailedWorktree(repoRoot: string, path: string): Promise<void> {
  try {
    if (existsSync(path)) await makeWritable(path);
    await runGit(repoRoot, ['worktree', 'remove', '--force', path]);
  } catch {
    // The original materialization error remains authoritative. A still-registered
    // path is intentionally not deleted outside Git's exact worktree ownership.
  }
}

interface WorktreeRegistration {
  path: string;
  head: string;
  detached: boolean;
}

async function findWorktreeRegistration(repoRoot: string, targetPath: string): Promise<WorktreeRegistration | null> {
  const text = await runGitText(repoRoot, ['worktree', 'list', '--porcelain']);
  const records = text.trim().length === 0 ? [] : text.trimEnd().split(/\n\n+/);
  for (const record of records) {
    const fields = record.split('\n');
    const pathLine = fields.find((line) => line.startsWith('worktree '));
    if (!pathLine || resolve(pathLine.slice('worktree '.length)) !== resolve(targetPath)) continue;
    const headLine = fields.find((line) => line.startsWith('HEAD '));
    return {
      path: pathLine.slice('worktree '.length),
      head: headLine?.slice('HEAD '.length) ?? '',
      detached: fields.includes('detached'),
    };
  }
  return null;
}

async function recordAttention(snapshot: DisposableSnapshot, code: string, detail: string): Promise<void> {
  await writeYaml(join(dirname(snapshot.path), `${snapshot.project}.attention.yaml`), {
    schemaVersion: 1,
    worksetId: snapshot.worksetId,
    runId: snapshot.runId,
    project: snapshot.project,
    snapshotPath: snapshot.path,
    sourceRepoRoot: snapshot.sourceRepoRoot,
    code,
    detail: detail.slice(0, 4096),
    createdAt: new Date().toISOString(),
  });
}

async function runGitText(cwd: string, args: readonly string[]): Promise<string> {
  return (await runGit(cwd, args)).toString('utf8');
}

async function runGit(cwd: string, args: readonly string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', [...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolvePromise(Buffer.concat(stdout));
        return;
      }
      const detail = Buffer.concat(stderr).toString('utf8').trim().slice(0, 8192);
      rejectPromise(new Error(`GIT_COMMAND_FAILED: git ${args.join(' ')} exited ${String(code ?? signal)}${detail ? `: ${detail}` : ''}`));
    });
    child.stdin.end(input);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
