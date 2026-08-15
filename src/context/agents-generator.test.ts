import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkspaceRepositoryState, WorkspaceState } from '../domain/types';
import { AgentsGenerator } from './agents-generator';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function repository(
  workspacePath: string,
  id: string,
  displayName: string,
  baseRef: string,
  branch = 'feature/REQ-123'
): WorkspaceRepositoryState {
  const commit = '0123456789abcdef0123456789abcdef01234567';
  return {
    id,
    displayName,
    sourcePath: path.join(path.dirname(workspacePath), 'sources', id),
    worktreePath: path.join(workspacePath, id),
    remote: 'origin',
    baseRef,
    baseCommit: commit,
    branch,
    branchExistedBefore: false,
    branchCreatedByOperation: true,
    branchInitialCommit: commit,
    worktreeCreated: true
  };
}

function stateFor(workspacePath: string): WorkspaceState {
  return {
    version: 1,
    status: 'ready',
    requirement: { id: 'REQ-123', title: '车险报价流程优化' },
    workspacePath,
    branchName: 'feature/REQ-123',
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:01:00.000Z',
    openCodexOnNextActivation: true,
    repositories: [
      repository(workspacePath, 'quote', 'Quote Service', 'origin/main'),
      repository(workspacePath, 'web', 'Web App', 'origin/release')
    ]
  };
}

const expectedInstructions = `# Requirement REQ-123

车险报价流程优化

## Repositories

| Repository | Base | Requirement branch |
| --- | --- | --- |
| Quote Service (quote) | \`origin/main\` | \`feature/REQ-123\` |
| Web App (web) | \`origin/release\` | \`feature/REQ-123\` |

## Working rules

- This parent directory contains multiple independent Git repositories. Each child directory is an independent Git repository.
- Analyze cross-repository impact before editing public contracts.
- Follow any nested AGENTS.md files inside each repository.
- Run and report tests separately for every changed repository.
- Commit and push each repository independently; there is no atomic cross-repository commit.

## Communication rules

- Lead with the conclusion and explain concepts in plain language before introducing formal terminology.
- On first use of a specialized term or acronym, define it briefly and retain the canonical term so it remains searchable.
- Use short sentences, concrete nouns, and active voice. Explain alternatives through observable outcomes, trade-offs, and user impact.
- Match explanation depth to the user's demonstrated familiarity in the current domain; expertise in one domain does not imply expertise in another.
- Use the smallest useful visual when it materially improves understanding: tables for exact comparisons, and Mermaid for flows, hierarchy, state, or cross-repository relationships. Skip decorative visuals.
`;

describe('AgentsGenerator.render', () => {
  it('renders exact deterministic parent instructions in recorded repository order', () => {
    const workspacePath = path.resolve('/tmp/ai-workspaces/REQ-123');

    expect(new AgentsGenerator().render(stateFor(workspacePath))).toBe(expectedInstructions);
  });

  it('escapes table pipes, line breaks, HTML, and inline-code delimiters', () => {
    const workspacePath = path.resolve('/tmp/ai-workspaces/REQ-123');
    const state = stateFor(workspacePath);
    state.requirement = {
      id: 'REQ|123\n## forged heading',
      title: 'Title <unsafe>\r\n## forged title'
    };
    state.repositories = [repository(
      workspacePath,
      'quote|api\n| forged |',
      'Display|Name\n`purpose` <unsafe>',
      'origin/main|unsafe\rnext',
      '`feature|REQ`\nnext'
    )];

    const rendered = new AgentsGenerator().render(state);

    expect(rendered).toContain('# Requirement REQ\\|123<br>## forged heading');
    expect(rendered).toContain('Title &lt;unsafe&gt;<br>## forged title');
    expect(rendered).toContain(
      '| Display\\|Name<br>&#96;purpose&#96; &lt;unsafe&gt; (quote\\|api<br>\\| forged \\|) | '
      + '`origin/main\\|unsafe<br>next` | `` `feature\\|REQ`<br>next `` |'
    );
    expect(rendered).not.toContain('\n## forged heading');
    expect(rendered).not.toContain('\n## forged title');
    expect(rendered).not.toContain('Display|Name');
  });

  it('whitelists instruction fields and never serializes sensitive or diagnostic state', () => {
    const workspacePath = path.resolve('/tmp/ai-workspaces/REQ-123');
    const state = stateFor(workspacePath) as WorkspaceState & {
      cloneUrl: string;
      environment: Record<string, string>;
      gitOutput: string;
    };
    state.cloneUrl = 'https://token:clone-password@example.test/private.git';
    state.environment = { AI_WORKSPACE_SECRET: 'environment-secret-value' };
    state.gitOutput = 'fatal: git-output-secret-value';
    state.recovery = {
      operation: 'create',
      stage: 'rollback',
      message: 'recovery-message-secret-value'
    };
    Object.assign(state.repositories[0]!, {
      cloneUrl: 'https://bob:repository-password@example.test/private.git',
      environment: 'repository-environment-secret',
      gitOutput: 'repository-git-output-secret'
    });

    const rendered = new AgentsGenerator().render(state);

    for (const secret of [
      state.workspacePath,
      state.repositories[0]!.sourcePath,
      state.repositories[0]!.worktreePath,
      state.cloneUrl,
      'token',
      state.environment.AI_WORKSPACE_SECRET,
      state.gitOutput,
      state.recovery.message,
      'repository-password',
      'repository-environment-secret',
      'repository-git-output-secret'
    ]) {
      expect(rendered).not.toContain(secret);
    }
  });
});

describe('AgentsGenerator.write', () => {
  it('rejects a state for another workspace before deriving or touching a file', async () => {
    const workspacePath = path.resolve('/tmp/ai-workspaces/REQ-123');
    const stateWorkspacePath = path.resolve('/tmp/ai-workspaces/REQ-OTHER');
    const fileSystemCalls: string[] = [];
    let randomIdCalls = 0;
    const generator = new AgentsGenerator({
      randomId: () => {
        randomIdCalls += 1;
        return 'must-not-be-used';
      },
      fileSystem: {
        open: async () => {
          fileSystemCalls.push('open');
          throw new Error('must not open');
        },
        rename: async () => { fileSystemCalls.push('rename'); },
        unlink: async () => { fileSystemCalls.push('unlink'); }
      }
    });

    await expect(generator.write(workspacePath, stateFor(stateWorkspacePath))).rejects.toMatchObject({
      code: 'VALIDATION',
      message: 'Workspace state path does not match AGENTS.md destination',
      details: {
        workspacePath,
        stateWorkspacePath
      }
    });
    expect(randomIdCalls).toBe(0);
    expect(fileSystemCalls).toEqual([]);
  });

  it('writes a complete same-directory temporary file, fsyncs it, then atomically renames it', async () => {
    const workspacePath = path.resolve('/tmp/ai-workspaces/REQ-123');
    const temporary = path.join(workspacePath, 'AGENTS.md.4242.fixed-id.tmp');
    const target = path.join(workspacePath, 'AGENTS.md');
    const events: string[] = [];
    const handle = {
      writeFile: async (contents: string, encoding: BufferEncoding) => {
        expect(contents).toBe(expectedInstructions);
        expect(encoding).toBe('utf8');
        events.push('write');
      },
      sync: async () => { events.push('sync'); },
      close: async () => { events.push('close'); }
    } as unknown as FileHandle;
    const generator = new AgentsGenerator({
      processId: 4242,
      randomId: () => 'fixed-id',
      fileSystem: {
        open: async (openedPath, flags, mode) => {
          expect(openedPath).toBe(temporary);
          expect(flags).toBe('wx');
          expect(mode).toBe(0o600);
          events.push('open');
          return handle;
        },
        rename: async (source, destination) => {
          expect(source).toBe(temporary);
          expect(destination).toBe(target);
          events.push('rename');
        },
        unlink: async () => { events.push('unlink'); }
      }
    });

    await generator.write(workspacePath, stateFor(workspacePath));

    expect(events).toEqual(['open', 'write', 'sync', 'close', 'rename']);
  });

  it('preserves the primary write error while closing and removing its temporary file', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-workspace-agents-'));
    roots.push(workspaceRoot);
    const workspacePath = path.join(workspaceRoot, 'REQ-123');
    await fs.mkdir(workspacePath);
    const primary = Object.assign(new Error('rename failed'), { code: 'EIO' });
    const cleanup = Object.assign(new Error('cleanup failed'), { code: 'EIO' });
    const generator = new AgentsGenerator({
      processId: 4242,
      randomId: () => 'fixed-id',
      fileSystem: {
        rename: async () => { throw primary; },
        unlink: async target => {
          await fs.unlink(target);
          throw cleanup;
        }
      }
    });

    await expect(generator.write(workspacePath, stateFor(workspacePath))).rejects.toBe(primary);
    expect((await fs.readdir(workspacePath)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    await expect(fs.stat(path.join(workspacePath, 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
