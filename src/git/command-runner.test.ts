import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeCommandRunner } from './command-runner';

async function waitForFile(filePath: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await access(filePath);
      return;
    } catch {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${path.basename(filePath)}`);
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

describe('NodeCommandRunner', () => {
  it('passes arguments literally without shell expansion', async () => {
    const result = await new NodeCommandRunner().run(
      process.execPath,
      ['-e', 'process.stdout.write(process.argv[1])', '$HOME && touch never'],
      { cwd: process.cwd() }
    );

    expect(result).toEqual({
      exitCode: 0,
      stdout: '$HOME && touch never',
      stderr: ''
    });
  });

  it('collects UTF-8 output from stdout and stderr', async () => {
    const result = await new NodeCommandRunner().run(
      process.execPath,
      [
        '-e',
        "process.stdout.write('工作区'); process.stderr.write('错误')"
      ],
      { cwd: process.cwd() }
    );

    expect(result).toEqual({
      exitCode: 0,
      stdout: '工作区',
      stderr: '错误'
    });
  });

  it('resolves a numeric non-zero exit code', async () => {
    const result = await new NodeCommandRunner().run(
      process.execPath,
      ['-e', 'process.exit(7)'],
      { cwd: process.cwd() }
    );

    expect(result.exitCode).toBe(7);
  });

  it('turns an aborted process into a cancellation error', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(new NodeCommandRunner().run(
      process.execPath,
      ['-e', 'setInterval(() => undefined, 1_000)'],
      { cwd: process.cwd(), signal: controller.signal }
    )).rejects.toMatchObject({
      code: 'CANCELLED',
      message: 'Operation cancelled'
    });
  });

  it('cancels a process that is already running', async () => {
    const controller = new AbortController();
    const pending = new NodeCommandRunner().run(
      process.execPath,
      ['-e', 'setInterval(() => undefined, 1_000)'],
      { cwd: process.cwd(), signal: controller.signal }
    );

    setTimeout(() => controller.abort(), 25);

    await expect(pending).rejects.toMatchObject({
      code: 'CANCELLED',
      message: 'Operation cancelled'
    });
  });

  it('waits for a cancelled process to close before rejecting', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-workspace-cancel-'));
    const readyPath = path.join(root, 'ready');
    const exitPath = path.join(root, 'exited');
    const controller = new AbortController();
    const script = `
      const { writeFileSync } = require('node:fs');
      const [readyPath, exitPath] = process.argv.slice(1);
      process.on('SIGTERM', () => {
        setTimeout(() => {
          writeFileSync(exitPath, 'closed');
          process.exit(0);
        }, 100);
      });
      writeFileSync(readyPath, 'ready');
      setInterval(() => undefined, 1_000);
    `;

    try {
      const pending = new NodeCommandRunner().run(
        process.execPath,
        ['-e', script, readyPath, exitPath],
        { cwd: root, signal: controller.signal }
      );
      await waitForFile(readyPath);

      controller.abort();
      let caught: unknown;
      try {
        await pending;
      } catch (error) {
        caught = error;
      }
      const markerAtSettlement = await readFile(exitPath, 'utf8').catch(() => undefined);

      await waitForFile(exitPath);
      expect(caught).toMatchObject({
        code: 'CANCELLED',
        message: 'Operation cancelled'
      });
      expect(markerAtSettlement).toBe('closed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('force-closes a cancelled process that does not promptly handle SIGTERM', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-workspace-cancel-'));
    const readyPath = path.join(root, 'ready');
    const controller = new AbortController();
    const script = `
      const { writeFileSync } = require('node:fs');
      process.on('SIGTERM', () => {
        setTimeout(() => process.exit(0), 2_200);
      });
      writeFileSync(process.argv[1], 'ready');
      setInterval(() => undefined, 1_000);
    `;

    try {
      const pending = new NodeCommandRunner().run(
        process.execPath,
        ['-e', script, readyPath],
        { cwd: root, signal: controller.signal }
      );
      await waitForFile(readyPath);

      const abortedAt = Date.now();
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
      const elapsedMs = Date.now() - abortedAt;

      expect(elapsedMs).toBeGreaterThanOrEqual(500);
      expect(elapsedMs).toBeLessThan(2_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('turns spawn failures into a Git error without exposing the environment', async () => {
    const command = `definitely-missing-ai-workspace-command-${process.pid}`;
    const secret = 'do-not-expose-this-value';

    let caught: unknown;
    try {
      await new NodeCommandRunner().run(command, [], {
        cwd: process.cwd(),
        env: { TASK_THREE_SECRET: secret }
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: 'GIT',
      message: 'Unable to start Git',
      details: { command }
    });
    expect(String((caught as Error).message)).not.toContain(secret);
    expect(JSON.stringify((caught as { details: unknown }).details)).not.toContain(secret);
    expect((caught as { details: Record<string, unknown> }).details).not.toHaveProperty('env');
  });
});
