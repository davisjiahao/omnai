import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { evidenceRecordSchema, type EvidenceRecord } from '../domain/types.js';
import type { EvidenceRequirement } from './policy.js';
import { ensureDir, readYaml, writeTextAtomic, writeYaml } from './files.js';
import { changeEvidenceRoot } from './paths.js';
import type { ChangeRef } from './store.js';

export interface VerificationCommandResult {
  record: EvidenceRecord;
  stdout: string;
  stderr: string;
}

type EvidenceInput = Omit<EvidenceRecord, 'schemaVersion' | 'id' | 'changeId' | 'revision' | 'createdAt'>;

const RESERVED_REQUIREMENT_IDS = new Set(['human-approval']);

export async function recordEvidence(
  repoRoot: string,
  change: ChangeRef,
  input: EvidenceInput,
): Promise<EvidenceRecord> {
  if (input.requirementId && RESERVED_REQUIREMENT_IDS.has(input.requirementId)) {
    throw new Error(`Evidence requirement '${input.requirementId}' is reserved and cannot be recorded through generic evidence APIs. Use the dedicated approval path.`);
  }
  return persistEvidence(repoRoot, change, input);
}

export async function recordHumanApproval(
  repoRoot: string,
  change: ChangeRef,
  summary = 'Explicit human approval recorded for the active revision',
): Promise<EvidenceRecord> {
  return persistEvidence(repoRoot, change, {
    requirementId: 'human-approval',
    type: 'manual',
    status: 'PASS',
    summary,
  });
}

async function persistEvidence(
  repoRoot: string,
  change: ChangeRef,
  input: EvidenceInput,
): Promise<EvidenceRecord> {
  const root = changeEvidenceRoot(repoRoot, change.directoryName);
  await ensureDir(root);
  const id = `EVD-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const record = evidenceRecordSchema.parse({
    schemaVersion: 1,
    id,
    changeId: change.metadata.id,
    revision: change.metadata.activeRevision,
    createdAt: new Date().toISOString(),
    ...input,
  });
  await writeYaml(join(root, `${id}.yaml`), record);
  return record;
}

export async function runVerificationCommand(
  repoRoot: string,
  change: ChangeRef,
  command: string,
  type: EvidenceRecord['type'] = 'test',
  requirementId?: string,
  taskId?: string,
): Promise<VerificationCommandResult> {
  const execution = spawnSync(command, {
    cwd: repoRoot,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  const stdout = execution.stdout ?? '';
  const stderr = execution.stderr ?? '';
  const exitCode = execution.status ?? 1;
  const status = exitCode === 0 ? 'PASS' : 'FAIL';
  const outputRoot = changeEvidenceRoot(repoRoot, change.directoryName);
  await ensureDir(outputRoot);
  const outputPath = join(outputRoot, `command-${Date.now()}-${randomUUID().slice(0, 8)}.log`);
  await writeTextAtomic(outputPath, `$ ${command}\n\nSTDOUT\n${stdout}\n\nSTDERR\n${stderr}\n`);
  const optionalRequirement = requirementId ? { requirementId } : {};
  const optionalTask = taskId ? { taskId } : {};
  const record = await recordEvidence(repoRoot, change, {
    ...optionalRequirement,
    ...optionalTask,
    type,
    status,
    command,
    exitCode,
    summary: status === 'PASS' ? `Command passed: ${command}` : `Command failed with exit ${exitCode}: ${command}`,
    outputFile: relative(repoRoot, outputPath),
  });
  return { record, stdout, stderr };
}

export async function listEvidence(repoRoot: string, change: ChangeRef): Promise<EvidenceRecord[]> {
  const { readdir } = await import('node:fs/promises');
  const root = changeEvidenceRoot(repoRoot, change.directoryName);
  try {
    const files = (await readdir(root)).filter((name) => name.endsWith('.yaml')).sort();
    const records: EvidenceRecord[] = [];
    for (const file of files) records.push(await readYaml(join(root, file), evidenceRecordSchema));
    return records;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

export function evidenceSummary(records: EvidenceRecord[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const record of records) {
    const key = `${record.type}:${record.status}`;
    summary[key] = (summary[key] ?? 0) + 1;
  }
  return summary;
}

export function evidenceForRevision(records: EvidenceRecord[], activeRevision: string): EvidenceRecord[] {
  return records.filter((record) => record.revision === activeRevision);
}

export function findEvidenceGaps(
  matrix: EvidenceRequirement[],
  records: EvidenceRecord[],
  activeRevision: string,
): EvidenceRequirement[] {
  const passed = new Set(
    evidenceForRevision(records, activeRevision)
      .filter((record) => record.status === 'PASS' && record.requirementId)
      .map((record) => record.requirementId as string),
  );
  return matrix.filter((item) => item.required && !passed.has(item.id));
}
