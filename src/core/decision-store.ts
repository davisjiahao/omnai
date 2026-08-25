import {
  decisionRecordSchema,
  type DecisionRecord,
} from '../domain/types.js';
import { appendJsonLine, pathExists, readJsonLines, readYaml, writeYaml } from './files.js';
import { loadFlowPlan } from './flow-store.js';
import { synchronizeFlowDecisionsWithinChangeLock } from './flow-store-internal.js';
import {
  changeArtifactPath,
  changeDecisionPath,
} from './paths.js';
import type { ChangeRef } from './store.js';
import {
  assertDecisionCurrent,
  listDecisions,
  listPersistedDecisions,
  requireActiveDecisionChange,
  requireDecision,
} from './decision-inventory.js';
import { assertCanonicalDecisionTransition, hashDecisionRecord } from './decision-transition.js';

export {
  assertDecisionCurrent,
  listDecisions,
  listPersistedDecisions,
  requireActiveDecisionChange,
  requireDecision,
} from './decision-inventory.js';

export async function writeDecisionWithinChangeLock(
  repoRoot: string,
  change: ChangeRef,
  record: DecisionRecord,
  event: 'DECISION_OPENED' | 'DECISION_RESOLVED' | 'DECISION_SUPERSEDED',
  detail: string,
  data: Record<string, unknown>,
): Promise<void> {
  const parsed = decisionRecordSchema.parse(record);
  const active = await requireActiveDecisionChange(repoRoot, change);
  assertDecisionCurrent(parsed, active.id, active.activeRevision);
  await loadFlowPlan(repoRoot, change);
  const decisionPath = changeDecisionPath(repoRoot, change.directoryName, parsed.id);
  const before = await pathExists(decisionPath)
    ? await readYaml(decisionPath, decisionRecordSchema)
    : null;
  assertCanonicalDecisionTransition(event, before, parsed);
  await writeYaml(decisionPath, parsed);
  await synchronizeFlowDecisionsWithinChangeLock(repoRoot, change, await listDecisions(repoRoot, change));
  await appendJsonLine(changeArtifactPath(repoRoot, change.directoryName, 'progress.jsonl'), {
    timestamp: parsed.updatedAt,
    event,
    changeId: active.id,
    revision: active.activeRevision,
    detail,
    data: {
      ...data,
      baseline: active.baseline,
      ...(before ? { beforeHash: hashDecisionRecord(before) } : {}),
      afterHash: hashDecisionRecord(parsed),
      ...(before ? { beforeDecision: before } : {}),
      afterDecision: parsed,
    },
  });
}

/** @internal Rebinds still-live authority after a guarded Reconcile preserves its old snapshot. */
export async function rebindLiveDecisionsWithinChangeLock(
  repoRoot: string,
  change: ChangeRef,
  options: {
    fromRevision: string;
    decisions: readonly DecisionRecord[];
    reboundAt: string;
    correlationId: string;
    exceptDecisionId?: string;
    afterDecisionPersisted?: (decision: DecisionRecord) => void;
  },
): Promise<DecisionRecord[]> {
  const active = await requireActiveDecisionChange(repoRoot, change);
  const records = await listDecisions(repoRoot, change);
  if (records.length !== options.decisions.length) {
    throw new Error('DECISION_RECONCILE_TRANSACTION_STATE_CONFLICT');
  }
  for (let index = 0; index < records.length; index += 1) {
    const current = records[index]!;
    const source = options.decisions[index]!;
    if (current.id !== source.id) throw new Error('DECISION_RECONCILE_TRANSACTION_STATE_CONFLICT');
    if (current.id === options.exceptDecisionId) continue;
    if (source.status !== 'OPEN' && source.status !== 'BLOCKED') {
      if (JSON.stringify(current) !== JSON.stringify(source)) {
        throw new Error(`DECISION_RECONCILE_TRANSACTION_STATE_CONFLICT: ${current.id}`);
      }
      continue;
    }
    const target = decisionRecordSchema.parse({
      ...source,
      openedRevision: active.activeRevision,
      updatedAt: options.reboundAt,
    });
    let rebound: DecisionRecord;
    if (JSON.stringify(current) === JSON.stringify(source)) {
      rebound = target;
      await writeYaml(changeDecisionPath(repoRoot, change.directoryName, rebound.id), rebound);
      options.afterDecisionPersisted?.(rebound);
    } else if (JSON.stringify(current) === JSON.stringify(target)) {
      rebound = current;
    } else {
      throw new Error(`DECISION_RECONCILE_TRANSACTION_STATE_CONFLICT: ${current.id}`);
    }
    await completeDecisionReboundAudit(
      repoRoot,
      change,
      rebound,
      options.fromRevision,
      active.activeRevision,
      active.baseline,
      options.reboundAt,
      options.correlationId,
    );
  }
  return listDecisions(repoRoot, change);
}

async function completeDecisionReboundAudit(
  repoRoot: string,
  change: ChangeRef,
  record: DecisionRecord,
  fromRevision: string,
  toRevision: string,
  baseline: string,
  reboundAt: string,
  correlationId: string,
): Promise<void> {
  const progressPath = changeArtifactPath(repoRoot, change.directoryName, 'progress.jsonl');
  const events = await readJsonLines<{
    timestamp?: string;
    event?: string;
    changeId?: string;
    revision?: string;
    detail?: string;
    data?: {
      decisionId?: string;
      fromRevision?: string;
      toRevision?: string;
      baseline?: string;
      correlationId?: string;
    };
  }>(progressPath);
  const matching = events.filter((event) => (
    event.event === 'DECISION_REBOUND' &&
    event.data?.decisionId === record.id &&
    event.data?.fromRevision === fromRevision &&
    event.data?.toRevision === toRevision
  ));
  if (matching.length > 1) throw new Error('DECISION_RECONCILE_TRANSACTION_AUDIT_CONFLICT');
  const expected = {
    timestamp: reboundAt,
    event: 'DECISION_REBOUND',
    changeId: record.changeId,
    revision: toRevision,
    detail: `Rebound live decision ${record.id} from ${fromRevision} to ${toRevision}`,
    data: { decisionId: record.id, fromRevision, toRevision, baseline, correlationId },
  };
  if (matching.length === 1) {
    if (JSON.stringify(matching[0]) !== JSON.stringify(expected)) {
      throw new Error('DECISION_RECONCILE_TRANSACTION_AUDIT_CONFLICT');
    }
    return;
  }
  await appendJsonLine(progressPath, expected);
}
