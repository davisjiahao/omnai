import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir } from '../core/files.js';
import { worksetRoot } from '../workspace/paths.js';

const EXECUTION_CHILDREN = [
  'contracts',
  'waves',
  'runs',
  'claims',
  'commitsets',
  'evidence',
  'attention',
  'snapshots',
] as const;

export function executionRoot(home: string, worksetId: string): string {
  return join(worksetRoot(home, worksetId), 'execution');
}

export function contractsRoot(home: string, worksetId: string): string {
  return join(executionRoot(home, worksetId), 'contracts');
}

export function contractRoot(home: string, worksetId: string, contractId: string): string {
  return join(contractsRoot(home, worksetId), contractId);
}

export function contractManifestPath(home: string, worksetId: string, contractId: string): string {
  return join(contractRoot(home, worksetId, contractId), 'manifest.yaml');
}

export function wavesRoot(home: string, worksetId: string): string {
  return join(executionRoot(home, worksetId), 'waves');
}

export function wavePath(home: string, worksetId: string, waveId: string): string {
  return join(wavesRoot(home, worksetId), `${waveId}.yaml`);
}

export function runsRoot(home: string, worksetId: string): string {
  return join(executionRoot(home, worksetId), 'runs');
}

export function runRoot(home: string, worksetId: string, runId: string): string {
  return join(runsRoot(home, worksetId), runId);
}

export function runPacketPath(home: string, worksetId: string, runId: string): string {
  return join(runRoot(home, worksetId, runId), 'packet.yaml');
}

export function runStatePath(home: string, worksetId: string, runId: string): string {
  return join(runRoot(home, worksetId, runId), 'state.yaml');
}

export function runEventsPath(home: string, worksetId: string, runId: string): string {
  return join(runRoot(home, worksetId, runId), 'events.jsonl');
}

export function runAgentSessionPath(home: string, worksetId: string, runId: string): string {
  return join(runRoot(home, worksetId, runId), 'agent-session.yaml');
}

export function runOutputsRoot(home: string, worksetId: string, runId: string): string {
  return join(runRoot(home, worksetId, runId), 'outputs');
}

export function runEvidenceRoot(home: string, worksetId: string, runId: string): string {
  return join(runRoot(home, worksetId, runId), 'evidence');
}

export function claimsRoot(home: string, worksetId: string): string {
  return join(executionRoot(home, worksetId), 'claims');
}

export function claimPath(home: string, worksetId: string, project: string): string {
  return join(claimsRoot(home, worksetId), `${project}.yaml`);
}

export function commitsetsRoot(home: string, worksetId: string): string {
  return join(executionRoot(home, worksetId), 'commitsets');
}

export function commitsetPath(home: string, worksetId: string, commitsetId: string): string {
  return join(commitsetsRoot(home, worksetId), `${commitsetId}.yaml`);
}

export function evidenceRoot(home: string, worksetId: string): string {
  return join(executionRoot(home, worksetId), 'evidence');
}

export function evidencePath(home: string, worksetId: string, evidenceId: string): string {
  return join(evidenceRoot(home, worksetId), `${evidenceId}.yaml`);
}

export function attentionRoot(home: string, worksetId: string): string {
  return join(executionRoot(home, worksetId), 'attention');
}

export function attentionPath(home: string, worksetId: string, attentionId: string): string {
  return join(attentionRoot(home, worksetId), `${attentionId}.yaml`);
}

export function snapshotsRoot(home: string, worksetId: string): string {
  return join(executionRoot(home, worksetId), 'snapshots');
}

export function executionProgressPath(home: string, worksetId: string): string {
  return join(executionRoot(home, worksetId), 'progress.jsonl');
}

export function worksetMutationLockPath(home: string, worksetId: string): string {
  return join(executionRoot(home, worksetId), '.mutation.lock');
}

export async function ensureExecutionLayout(home: string, worksetId: string): Promise<string> {
  const root = executionRoot(home, worksetId);
  for (const child of EXECUTION_CHILDREN) await ensureDir(join(root, child));
  await createIfMissing(executionProgressPath(home, worksetId), '');
  return root;
}

async function createIfMissing(path: string, content: string): Promise<void> {
  try {
    const handle = await open(path, 'wx');
    try {
      await handle.writeFile(content, 'utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
}
