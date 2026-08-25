import { join } from 'node:path';

export { findRepositoryRoot } from './repository-root.js';

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

export function changeDecisionsRoot(repoRoot: string, directoryName: string): string {
  return join(changeRoot(repoRoot, directoryName), 'decisions');
}

export function changeDecisionPath(repoRoot: string, directoryName: string, decisionId: string): string {
  return join(changeDecisionsRoot(repoRoot, directoryName), `${decisionId}.yaml`);
}

export function changeFlowPath(repoRoot: string, directoryName: string): string {
  return join(changeRoot(repoRoot, directoryName), 'flow.yaml');
}

export function changeMutationLockPath(repoRoot: string, directoryName: string): string {
  return join(changeRoot(repoRoot, directoryName), '.core-mutation.lock');
}
