import { randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import * as nodeFs from 'node:fs/promises';
import path from 'node:path';
import { AiWorkspaceError } from '../domain/errors';
import type { WorkspaceState } from '../domain/types';

const AGENTS_FILE = 'AGENTS.md';

export interface AgentsGeneratorFileSystem {
  open(target: string, flags: string, mode?: number): Promise<FileHandle>;
  rename(source: string, target: string): Promise<void>;
  unlink(target: string): Promise<void>;
}

export interface AgentsGeneratorOptions {
  processId?: number;
  randomId?: () => string;
  fileSystem?: Partial<AgentsGeneratorFileSystem>;
}

const DEFAULT_FILE_SYSTEM: AgentsGeneratorFileSystem = {
  open: (target, flags, mode) => nodeFs.open(target, flags, mode),
  rename: (source, target) => nodeFs.rename(source, target),
  unlink: target => nodeFs.unlink(target)
};

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

function escapeMarkdown(value: string, escapeBackticks: boolean): string {
  const escaped = value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r\n|\r|\n/g, '<br>');
  return escapeBackticks ? escaped.replace(/`/g, '&#96;') : escaped;
}

function inlineCode(value: string): string {
  const escaped = escapeMarkdown(value, false);
  const runs = escaped.match(/`+/g) ?? [];
  const longestRun = runs.reduce((longest, run) => Math.max(longest, run.length), 0);
  const fence = '`'.repeat(longestRun + 1);
  const needsPadding = escaped.startsWith('`') || escaped.endsWith('`');
  const contents = needsPadding ? ` ${escaped} ` : escaped;
  return `${fence}${contents}${fence}`;
}

export class AgentsGenerator {
  private readonly processId: number;
  private readonly randomId: () => string;
  private readonly fs: AgentsGeneratorFileSystem;

  constructor(options: AgentsGeneratorOptions = {}) {
    this.processId = options.processId ?? process.pid;
    this.randomId = options.randomId ?? randomUUID;
    this.fs = { ...DEFAULT_FILE_SYSTEM, ...options.fileSystem };
  }

  render(state: WorkspaceState): string {
    const rows = state.repositories.map(repository => [
      '| ',
      escapeMarkdown(repository.displayName, true),
      ' (',
      escapeMarkdown(repository.id, true),
      ')',
      ' | ',
      inlineCode(repository.baseRef),
      ' | ',
      inlineCode(repository.branch),
      ' |'
    ].join(''));

    return [
      `# Requirement ${escapeMarkdown(state.requirement.id, true)}`,
      '',
      escapeMarkdown(state.requirement.title, true),
      '',
      '## Repositories',
      '',
      '| Repository | Base | Requirement branch |',
      '| --- | --- | --- |',
      ...rows,
      '',
      '## Working rules',
      '',
      '- This parent directory contains multiple independent Git repositories. Each child directory is an independent Git repository.',
      '- Analyze cross-repository impact before editing public contracts.',
      '- Follow any nested AGENTS.md files inside each repository.',
      '- Run and report tests separately for every changed repository.',
      '- Commit and push each repository independently; there is no atomic cross-repository commit.',
      '',
      '## Communication rules',
      '',
      '- Lead with the conclusion and explain concepts in plain language before introducing formal terminology.',
      '- On first use of a specialized term or acronym, define it briefly and retain the canonical term so it remains searchable.',
      '- Use short sentences, concrete nouns, and active voice. Explain alternatives through observable outcomes, trade-offs, and user impact.',
      "- Match explanation depth to the user's demonstrated familiarity in the current domain; expertise in one domain does not imply expertise in another.",
      '- Use the smallest useful visual when it materially improves understanding: tables for exact comparisons, and Mermaid for flows, hierarchy, state, or cross-repository relationships. Skip decorative visuals.',
      ''
    ].join('\n');
  }

  async write(workspacePath: string, state: WorkspaceState): Promise<void> {
    const directory = path.resolve(workspacePath);
    const stateDirectory = path.resolve(state.workspacePath);
    if (directory !== stateDirectory) {
      throw new AiWorkspaceError(
        'VALIDATION',
        'Workspace state path does not match AGENTS.md destination',
        { workspacePath: directory, stateWorkspacePath: stateDirectory }
      );
    }
    const target = path.join(directory, AGENTS_FILE);
    const temporary = path.join(
      directory,
      `${AGENTS_FILE}.${this.processId}.${this.randomId()}.tmp`
    );
    let handle: FileHandle | undefined;
    let temporaryExists = false;
    let primaryError: unknown;

    try {
      handle = await this.fs.open(temporary, 'wx', 0o600);
      temporaryExists = true;
      await handle.writeFile(this.render(state), 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.fs.rename(temporary, target);
      temporaryExists = false;
    } catch (error) {
      primaryError = error;
    }

    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (error) {
        primaryError ??= error;
      }
    }
    if (temporaryExists) {
      try {
        await this.fs.unlink(temporary);
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) primaryError ??= error;
      }
    }
    if (primaryError !== undefined) throw primaryError;
  }
}
