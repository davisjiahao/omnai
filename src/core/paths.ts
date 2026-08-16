import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function findRepositoryRoot(startDirectory = process.cwd()): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: startDirectory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    let current = resolve(startDirectory);
    while (true) {
      if (existsSync(join(current, '.git'))) return current;
      const parent = dirname(current);
      if (parent === current) {
        throw new Error(`No Git repository found from ${startDirectory}`);
      }
      current = parent;
    }
  }
}

export function omnaiRoot(repoRoot: string): string {
  return join(repoRoot, '.omnai');
}

export function projectConfigPath(repoRoot: string): string {
  return join(omnaiRoot(repoRoot), 'config.yaml');
}

export function workflowLockPath(repoRoot: string): string {
  return join(omnaiRoot(repoRoot), 'workflow.lock.yaml');
}

export function changesRoot(repoRoot: string): string {
  return join(omnaiRoot(repoRoot), 'changes');
}

export function projectKnowledgeRoot(repoRoot: string): string {
  return join(omnaiRoot(repoRoot), 'project');
}

export function changeRoot(repoRoot: string, directoryName: string): string {
  return join(changesRoot(repoRoot), directoryName);
}

export function changeMetadataPath(repoRoot: string, directoryName: string): string {
  return join(changeRoot(repoRoot, directoryName), 'change.yaml');
}

export function changeArtifactPath(repoRoot: string, directoryName: string, artifact: string): string {
  return join(changeRoot(repoRoot, directoryName), artifact);
}

export function changeRunsRoot(repoRoot: string, directoryName: string): string {
  return join(changeRoot(repoRoot, directoryName), 'runs');
}

export function changeEvidenceRoot(repoRoot: string, directoryName: string): string {
  return join(changeRoot(repoRoot, directoryName), 'evidence');
}

export function changeRevisionsRoot(repoRoot: string, directoryName: string): string {
  return join(changeRoot(repoRoot, directoryName), 'revisions');
}
