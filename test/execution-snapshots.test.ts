import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { evaluatePermission } from '../src/execution/agents/policy.js';
import {
  disposeSnapshot,
  materializeCoordinationSnapshot,
  materializeReviewerSnapshot,
} from '../src/execution/agents/snapshots.js';
import { sha256 } from '../src/execution/hashing.js';
import { createRunPacket, type RunPacketInput } from '../src/execution/packets.js';
import { createTestDirectory, createTestRepository } from './helpers.js';

const NOW = '2026-08-16T00:00:00.000Z';
const HASH = sha256('packet');

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function options() {
  return [
    { optionId: 'allow', name: 'Allow once', kind: 'allow_once' as const },
    { optionId: 'deny', name: 'Reject', kind: 'reject_once' as const },
  ];
}

function coordinationPacket(snapshotPath: string) {
  const input: Extract<RunPacketInput, { kind: 'CONTRACT_PLANNER' }> = {
    schemaVersion: 1,
    id: 'RUN-0001',
    kind: 'CONTRACT_PLANNER',
    worksetId: 'WKS-0001',
    contracts: [],
    objective: 'Plan the contract',
    protocolIds: ['execution.contract-planner'],
    verificationCommands: [],
    evidenceRequired: ['contract-candidate'],
    stopConditions: ['signal stale source'],
    agent: { agentId: 'codex', protocol: 'acp', role: 'coordination-read-only' },
    limits: { timeoutMs: 60_000, maxOutputBytes: 1_048_576 },
    permissionPolicy: {
      filesystemRoots: [snapshotPath], terminal: false, network: 'DENY',
      denyGitCommit: true, denyNestedOmnai: true,
    },
    createdAt: NOW,
  };
  return createRunPacket(input);
}

test('coordination snapshot is detached, read-only, disposable, and leaves source unchanged', async () => {
  const repo = await createTestRepository('source');
  const home = await createTestDirectory('omnai-snapshot-');
  try {
    const before = git(repo.root, ['status', '--porcelain=v1']);
    const head = git(repo.root, ['rev-parse', 'HEAD']).trim();
    const snapshot = await materializeCoordinationSnapshot({
      home: home.root,
      worksetId: 'WKS-0001',
      runId: 'RUN-0001',
      project: 'source',
      repoRoot: repo.root,
      head,
    });
    assert.notEqual(snapshot.path, repo.root);
    assert.equal(snapshot.readOnly, true);
    assert.equal(git(snapshot.path, ['rev-parse', 'HEAD']).trim(), head);
    assert.equal(git(snapshot.path, ['branch', '--show-current']), '');
    assert.equal((await stat(join(snapshot.path, 'README.md'))).mode & 0o222, 0);
    assert.equal(evaluatePermission(coordinationPacket(snapshot.path), {
      kind: 'write-file', path: join(snapshot.path, 'forbidden.txt'), options: options(),
    }).outcome, 'DENY');
    assert.equal(git(repo.root, ['status', '--porcelain=v1']), before);

    await disposeSnapshot(snapshot);
    await assert.rejects(() => stat(snapshot.path), /ENOENT/);
    assert.equal(git(repo.root, ['status', '--porcelain=v1']), before);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('reviewer snapshot reproduces the exact writer binary diff hash without mutating source', async () => {
  const repo = await createTestRepository('source');
  const home = await createTestDirectory('omnai-review-snapshot-');
  try {
    await mkdir(join(repo.root, 'src'), { recursive: true });
    const sourcePath = join(repo.root, 'src', 'auth.ts');
    await writeFile(sourcePath, 'export const version = 1;\n', 'utf8');
    git(repo.root, ['add', 'src/auth.ts']);
    git(repo.root, ['commit', '-m', 'test: add auth source']);
    const startingHead = git(repo.root, ['rev-parse', 'HEAD']).trim();
    await writeFile(sourcePath, 'export const version = 2;\n', 'utf8');
    const patch = git(repo.root, ['diff', '--binary', '--no-ext-diff']);
    const diffHash = sha256(patch);
    const sourceStatus = git(repo.root, ['status', '--porcelain=v1']);

    const snapshot = await materializeReviewerSnapshot({
      home: home.root,
      worksetId: 'WKS-0001',
      runId: 'RUN-0002',
      project: 'source',
      repoRoot: repo.root,
      startingHead,
      patch,
      diffHash,
    });
    assert.equal(snapshot.contentHash, diffHash);
    assert.equal(await readFile(join(snapshot.path, 'src', 'auth.ts'), 'utf8'), 'export const version = 2;\n');
    assert.equal((await stat(join(snapshot.path, 'src', 'auth.ts'))).mode & 0o222, 0);
    assert.equal(git(repo.root, ['status', '--porcelain=v1']), sourceStatus);

    await disposeSnapshot(snapshot);
    assert.equal(git(repo.root, ['status', '--porcelain=v1']), sourceStatus);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('reviewer snapshot rejects a mismatched diff hash and removes the failed worktree', async () => {
  const repo = await createTestRepository('source');
  const home = await createTestDirectory('omnai-review-mismatch-');
  try {
    const startingHead = git(repo.root, ['rev-parse', 'HEAD']).trim();
    await writeFile(join(repo.root, 'README.md'), '# Changed\n', 'utf8');
    const patch = git(repo.root, ['diff', '--binary', '--no-ext-diff']);
    await assert.rejects(() => materializeReviewerSnapshot({
      home: home.root,
      worksetId: 'WKS-0001',
      runId: 'RUN-0003',
      project: 'source',
      repoRoot: repo.root,
      startingHead,
      patch,
      diffHash: HASH,
    }), /REVIEWER_DIFF_HASH_MISMATCH/);
    assert.doesNotMatch(git(repo.root, ['worktree', 'list', '--porcelain']), /RUN-0003/);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('disposal preserves a snapshot and records attention when Git ownership is not proven', async () => {
  const repo = await createTestRepository('source');
  const home = await createTestDirectory('omnai-snapshot-ownership-');
  try {
    const head = git(repo.root, ['rev-parse', 'HEAD']).trim();
    const snapshot = await materializeCoordinationSnapshot({
      home: home.root,
      worksetId: 'WKS-0001',
      runId: 'RUN-0004',
      project: 'source',
      repoRoot: repo.root,
      head,
    });
    await assert.rejects(
      () => disposeSnapshot({ ...snapshot, head: 'f'.repeat(40) }),
      /SNAPSHOT_OWNERSHIP_UNPROVEN/,
    );
    assert.equal((await stat(snapshot.path)).isDirectory(), true);
    assert.match(
      await readFile(join(snapshot.path, '..', 'source.attention.yaml'), 'utf8'),
      /SNAPSHOT_OWNERSHIP_UNPROVEN/,
    );
    await disposeSnapshot(snapshot);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});
