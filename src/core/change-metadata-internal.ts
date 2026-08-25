import { changeMetadataSchema, type ChangeMetadata } from '../domain/types.js';
import { writeYaml } from './files.js';
import { changeMetadataPath } from './paths.js';
import type { ChangeRef } from './store.js';

/** @internal Caller must hold the exact Change mutation lock and all required transaction fences. */
export async function persistChangeMetadataWithinChangeLock(
  repoRoot: string,
  change: ChangeRef,
  metadata: ChangeMetadata,
  updatedAt: string,
): Promise<ChangeMetadata> {
  const persisted = changeMetadataSchema.parse({ ...structuredClone(metadata), updatedAt });
  await writeYaml(changeMetadataPath(repoRoot, change.directoryName), persisted);
  change.metadata = persisted;
  return persisted;
}
