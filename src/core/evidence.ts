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

export async function recordEvidence(
  repoRoot: string,
  change: ChangeRef,
  input: Omit<EvidenceRecord, 'schemaVersion' | 'id' | 'changeId' | 'revision' | 'createdAt'>,
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
  const record = await recordEvidence(repoRoot, change, {
    ...optionalRequirement,
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

export function findEvidenceGaps(matrix: EvidenceRequirement[], records: EvidenceRecord[]): EvidenceRequirement[] {
  const passed = new Set(
    records
      .filter((record) => record.status === 'PASS' && record.requirementId)
      .map((record) => record.requirementId as string),
  );
  return matrix.filter((item) => item.required && !passed.has(item.id));
}
