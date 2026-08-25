import { withChangeMutationLock } from './change-mutation-lock.js';
import {
  reconcileOrdinaryWithinChangeLock,
  type ReconcileInput,
  type ReconcileResult,
} from './ordinary-reconcile-orchestration.js';
import type { ChangeRef } from './store.js';

export type { ReconcileInput, ReconcileResult } from './ordinary-reconcile-orchestration.js';
export { incrementBaseline, incrementRevision } from './revision-ids.js';

export async function reconcileChange(
  repoRoot: string,
  change: ChangeRef,
  input: ReconcileInput,
): Promise<ReconcileResult> {
  return withChangeMutationLock(
    repoRoot,
    change,
    () => reconcileOrdinaryWithinChangeLock(repoRoot, change, input),
  );
}
