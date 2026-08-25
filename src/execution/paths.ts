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
  'verification-plans',
  'integration-environments',
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

export function runAgentEventsPath(home: string, worksetId: string, runId: string): string {
  return join(runRoot(home, worksetId, runId), 'agent-events.jsonl');
}

export function runPromptResultPath(home: string, worksetId: string, runId: string): string {
  return join(runRoot(home, worksetId, runId), 'prompt-result.json');
}

export function runOutputsRoot(home: string, worksetId: string, runId: string): string {
  return join(runRoot(home, worksetId, runId), 'outputs');
}

export function runOutputPath(home: string, worksetId: string, runId: string): string {
  return join(runOutputsRoot(home, worksetId, runId), 'result.json');
}

export function runEvidenceRoot(home: string, worksetId: string, runId: string): string {
  return join(runRoot(home, worksetId, runId), 'evidence');
}

export function runAcceptedArtifactPath(home: string, worksetId: string, runId: string): string {
  return join(runEvidenceRoot(home, worksetId, runId), 'accepted.json');
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

export function verificationPlansRoot(home: string, worksetId: string): string {
  return join(executionRoot(home, worksetId), 'verification-plans');
}

export function verificationPlanRoot(home: string, worksetId: string, verificationPlanId: string): string {
  requireExecutionId(verificationPlanId, /^VPL-\d{4}$/, 'verificationPlanId');
  return join(verificationPlansRoot(home, worksetId), verificationPlanId);
}

export function verificationPlanPath(home: string, worksetId: string, verificationPlanId: string): string {
  return join(verificationPlanRoot(home, worksetId, verificationPlanId), 'plan.yaml');
}

export function verificationPlanTestCasesPath(home: string, worksetId: string, verificationPlanId: string): string {
  return join(verificationPlanRoot(home, worksetId, verificationPlanId), 'test-cases.yaml');
}

export function integrationEnvironmentsRoot(home: string, worksetId: string): string {
  return join(executionRoot(home, worksetId), 'integration-environments');
}

export function integrationEnvironmentProfilesRoot(home: string, worksetId: string): string {
  return join(integrationEnvironmentsRoot(home, worksetId), 'profiles');
}

export function integrationEnvironmentProfilePath(
  home: string,
  worksetId: string,
  profileId: string,
  contentHash: string,
): string {
  requireExecutionId(profileId, /^[a-z0-9][a-z0-9._-]*$/, 'profileId');
  const hash = /^sha256:([0-9a-f]{64})$/.exec(contentHash);
  if (!hash) throw new Error('INVALID_CONTENT_HASH_PATH_COMPONENT');
  return join(integrationEnvironmentProfilesRoot(home, worksetId), `${profileId}-sha256-${hash[1]}.yaml`);
}

export function integrationEnvironmentRunsRoot(home: string, worksetId: string): string {
  return join(integrationEnvironmentsRoot(home, worksetId), 'runs');
}

export function integrationEnvironmentRunRoot(home: string, worksetId: string, environmentRunId: string): string {
  requireExecutionId(environmentRunId, /^IER-\d{4}$/, 'environmentRunId');
  return join(integrationEnvironmentRunsRoot(home, worksetId), environmentRunId);
}

export function integrationEnvironmentInputPath(home: string, worksetId: string, environmentRunId: string): string {
  return join(integrationEnvironmentRunRoot(home, worksetId, environmentRunId), 'input.yaml');
}

export function integrationEnvironmentStatePath(home: string, worksetId: string, environmentRunId: string): string {
  return join(integrationEnvironmentRunRoot(home, worksetId, environmentRunId), 'state.yaml');
}

export function integrationEnvironmentEventsPath(home: string, worksetId: string, environmentRunId: string): string {
  return join(integrationEnvironmentRunRoot(home, worksetId, environmentRunId), 'events.jsonl');
}

export function integrationEnvironmentEvidenceRoot(home: string, worksetId: string, environmentRunId: string): string {
  return join(integrationEnvironmentRunRoot(home, worksetId, environmentRunId), 'evidence');
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
  await ensureDir(integrationEnvironmentProfilesRoot(home, worksetId));
  await ensureDir(integrationEnvironmentRunsRoot(home, worksetId));
  await createIfMissing(executionProgressPath(home, worksetId), '');
  return root;
}

function requireExecutionId(value: string, pattern: RegExp, field: string): void {
  if (!pattern.test(value)) throw new Error(`INVALID_EXECUTION_PATH_COMPONENT: ${field}`);
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
