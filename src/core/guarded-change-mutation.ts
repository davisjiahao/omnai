import { changeMetadataSchema, type ChangeMetadata } from '../domain/types.js';
import { withChangeMutationLock } from './change-mutation-lock.js';
import { assertDecisionReconcileTransactionFence } from './decision-reconcile-transaction.js';
import { readYaml } from './files.js';
import { assertFlowTransactionFence } from './flow-transaction.js';
import { assertOrdinaryReconcileTransactionFence } from './ordinary-reconcile-transaction.js';
import { changeMetadataPath } from './paths.js';
import type { ChangeRef } from './store.js';
import { assertTransactionLineageIntegrity } from './transaction-lineage-integrity.js';
import { assertSemanticMutationFence } from './semantic-mutation-journal.js';

export async function withGuardedChangeMutation<T>(
  repoRoot: string,
  change: ChangeRef,
  action: (active: ChangeMetadata) => Promise<T>,
): Promise<T> {
  return withChangeMutationLock(repoRoot, change, async () => {
    await assertTransactionLineageIntegrity(repoRoot, change);
    await assertFlowTransactionFence(repoRoot, change);
    await assertDecisionReconcileTransactionFence(repoRoot, change);
    await assertOrdinaryReconcileTransactionFence(repoRoot, change);
    await assertSemanticMutationFence(repoRoot, change);
    const active = await readYaml(
      changeMetadataPath(repoRoot, change.directoryName),
      changeMetadataSchema,
    );
    assertExactChangeBinding(change, active);
    change.metadata = active;
    return action(active);
  });
}

export function assertExactChangeBinding(change: ChangeRef, active: ChangeMetadata): void {
  if (active.id !== change.metadata.id) throw new Error('FLOW_STALE_CHANGE');
  if (active.activeRevision !== change.metadata.activeRevision) throw new Error('FLOW_STALE_REVISION');
  if (active.baseline !== change.metadata.baseline) throw new Error('FLOW_STALE_BASELINE');
}
