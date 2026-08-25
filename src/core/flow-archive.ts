import { join } from 'node:path';
import { flowPlanSchema, type FlowPlan } from '../domain/types.js';
import { pathExists, readYaml, writeYaml } from './files.js';
import { hashFlowPlan } from './flow.js';
import { changeRevisionsRoot } from './paths.js';
import type { ChangeRef } from './store.js';

/** @internal 调用方持有精确 Change 锁时，只读核对归档与当前 final Flow 是否同一对象。 */
export async function preflightFlowArchiveCompatibilityWithinChangeLock(
  repoRoot: string,
  change: ChangeRef,
  flow: FlowPlan,
): Promise<boolean> {
  const archivePath = join(changeRevisionsRoot(repoRoot, change.directoryName), `${flow.revision}.flow.yaml`);
  if (await pathExists(archivePath)) {
    const archived = await readYaml(archivePath, flowPlanSchema);
    if (hashFlowPlan(archived) !== hashFlowPlan(flow)) {
      throw new Error('RECONCILE_FLOW_ARCHIVE_MISMATCH');
    }
    return true;
  }
  return false;
}

/** @internal 持久事务意图落盘后幂等写入；调用方必须持有精确 Change 锁。 */
export async function ensureFlowArchiveWithinChangeLock(
  repoRoot: string,
  change: ChangeRef,
  flow: FlowPlan,
): Promise<void> {
  if (await preflightFlowArchiveCompatibilityWithinChangeLock(repoRoot, change, flow)) return;
  const archivePath = join(changeRevisionsRoot(repoRoot, change.directoryName), `${flow.revision}.flow.yaml`);
  await writeYaml(archivePath, flowPlanSchema.parse(flow));
  const archived = await readYaml(archivePath, flowPlanSchema);
  if (hashFlowPlan(archived) !== hashFlowPlan(flow)) {
    throw new Error('RECONCILE_FLOW_ARCHIVE_MISMATCH');
  }
}
