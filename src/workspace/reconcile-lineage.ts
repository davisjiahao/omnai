import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readYaml } from '../core/files.js';
import { changeRevisionsRoot } from '../core/paths.js';
import { revisionSchema, type Revision } from '../domain/types.js';

export async function findCorrelatedRevision(
  repoRoot: string,
  directoryName: string,
  correlationId: string,
): Promise<Revision | null> {
  const root = changeRevisionsRoot(repoRoot, directoryName);
  const entries = await readdir(root, { withFileTypes: true });
  const matches: Revision[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^REV-\d{4}\.yaml$/.test(entry.name)) continue;
    const revision = await readYaml(join(root, entry.name), revisionSchema);
    if (revision.correlationId === correlationId) matches.push(revision);
  }
  if (matches.length > 1) {
    throw new Error(`Correlation '${correlationId}' appears in multiple Project Change revisions.`);
  }
  return matches[0] ?? null;
}
