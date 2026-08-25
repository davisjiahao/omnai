import { type ReadinessStatus } from '../domain/types.js';
import { persistChangeMetadataWithinChangeLock } from './change-metadata-internal.js';
import type { ChangeRef } from './store.js';

/** @internal Caller must hold the exact Change mutation lock and every transaction fence. */
export async function markReadinessWithinChangeLock(
  repoRoot: string,
  change: ChangeRef,
  key: keyof ChangeRef['metadata']['readiness'],
  value: ReadinessStatus,
): Promise<void> {
  change.metadata.readiness[key] = value;
  if (change.metadata.status === 'DRAFT' && value === 'IN_PROGRESS') change.metadata.status = 'IN_PROGRESS';
  await persistChangeMetadataWithinChangeLock(
    repoRoot,
    change,
    change.metadata,
    new Date().toISOString(),
  );
}
