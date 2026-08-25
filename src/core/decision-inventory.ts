import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  changeMetadataSchema,
  decisionRecordSchema,
  type DecisionRecord,
} from '../domain/types.js';
import { readYaml } from './files.js';
import {
  changeDecisionsRoot,
  changeMetadataPath,
} from './paths.js';
import type { ChangeRef } from './store.js';

const DECISION_FILE = /^DEC-\d{4}\.yaml$/;

export async function listDecisions(repoRoot: string, change: ChangeRef): Promise<DecisionRecord[]> {
  const records = await listPersistedDecisions(repoRoot, change);
  return records.map(({ record }) => record);
}

export async function listPersistedDecisions(
  repoRoot: string,
  change: ChangeRef,
): Promise<Array<{ file: string; record: DecisionRecord }>> {
  const root = changeDecisionsRoot(repoRoot, change.directoryName);
  let files: string[];
  try {
    files = (await readdir(root)).filter((name) => DECISION_FILE.test(name)).sort();
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const records = await Promise.all(files.map(async (file) => ({
    file,
    record: await readYaml(join(root, file), decisionRecordSchema),
  })));
  for (const { file, record } of records) {
    if (record.id !== file.slice(0, -'.yaml'.length)) {
      throw new Error(`DECISION_FILENAME_MISMATCH: ${file}`);
    }
    if (record.changeId !== change.metadata.id) {
      throw new Error(`DECISION_CHANGE_MISMATCH: ${record.id}`);
    }
  }
  return records.sort((left, right) => left.record.id.localeCompare(right.record.id));
}

export async function requireDecision(
  repoRoot: string,
  change: ChangeRef,
  decisionId: string,
): Promise<DecisionRecord> {
  const record = (await listDecisions(repoRoot, change)).find((candidate) => candidate.id === decisionId);
  if (!record) throw new Error(`DECISION_NOT_FOUND: ${decisionId}`);
  return record;
}

export async function requireActiveDecisionChange(
  repoRoot: string,
  change: ChangeRef,
): Promise<ChangeRef['metadata']> {
  const current = await readYaml(
    changeMetadataPath(repoRoot, change.directoryName),
    changeMetadataSchema,
  );
  if (current.id !== change.metadata.id) throw new Error('DECISION_STALE_CHANGE');
  if (current.activeRevision !== change.metadata.activeRevision) throw new Error('DECISION_STALE_REVISION');
  if (current.baseline !== change.metadata.baseline) throw new Error('DECISION_STALE_BASELINE');
  return current;
}

export function assertDecisionCurrent(
  record: DecisionRecord,
  changeId: string,
  activeRevision: string,
): void {
  if (record.changeId !== changeId) throw new Error(`DECISION_CHANGE_MISMATCH: ${record.id}`);
  const revision = record.resolvedRevision ?? record.openedRevision;
  if (revision !== activeRevision) throw new Error(`DECISION_STALE_REVISION: ${record.id}`);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
