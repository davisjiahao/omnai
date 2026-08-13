import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function createTestDirectory(prefix = 'omnai-dir-'): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export async function createTestRepository(name?: string): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const parent = await mkdtemp(join(tmpdir(), 'omnai-test-'));
  const root = name ? join(parent, name) : parent;
  if (name) await mkdir(root, { recursive: true });
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'OmnAI Test'], { cwd: root });
  await writeFile(join(root, 'README.md'), '# Test Repository\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'test: initialize fixture'], { cwd: root, stdio: 'ignore' });
  return {
    root,
    cleanup: () => rm(parent, { recursive: true, force: true }),
  };
}
