import {
  changeMetadataSchema,
  decisionRecordSchema,
  taskFileSchema,
  type Readiness,
} from '../domain/types.js';
import { hashCanonicalArtifact } from './canonical-hash-internal.js';
import { hashDecisionRecord } from './decision-transition.js';
import { compileFlowPlan, hashFlowPlan } from './flow.js';
import { incrementBaseline, incrementRevision } from './revision-ids.js';
import { getScenario } from './scenarios.js';
import { invalidateExactTasks } from './tasks.js';
import type { OrdinaryReconcileTransaction } from './ordinary-reconcile-transaction.js';

export interface OrdinaryTerminalHashes {
  metadata: string;
  tasks: string;
  flow: string | null;
  decisions: Array<{ id: string; hash: string }>;
}

/** @internal Reconstructs immutable terminal targets solely from the frozen ordinary intent. */
export function ordinaryTerminalHashes(
  transaction: OrdinaryReconcileTransaction,
  revision = incrementRevision(transaction.sourceMetadata.activeRevision),
  baseline = incrementBaseline(transaction.sourceMetadata.baseline),
): OrdinaryTerminalHashes {
  const readiness = reconciledReadiness(
    transaction.sourceMetadata.readiness,
    transaction.affectedReadiness,
    transaction.request.level,
  );
  const metadata = changeMetadataSchema.parse({
    ...transaction.sourceMetadata,
    activeRevision: revision,
    baseline,
    status: 'IN_PROGRESS',
    readiness,
    updatedAt: transaction.createdAt,
  });
  const tasks = structuredClone(transaction.tasks);
  invalidateExactTasks(
    tasks,
    transaction.affectedTasks,
    ['L2', 'L3', 'L4'].includes(transaction.request.level),
  );
  const parsedTasks = taskFileSchema.parse(tasks);
  const decisions = transaction.decisions.map((source) => decisionRecordSchema.parse(
    source.status === 'OPEN' || source.status === 'BLOCKED'
      ? { ...source, openedRevision: revision, updatedAt: transaction.createdAt }
      : source,
  ));
  const flow = transaction.flow
    ? compileFlowPlan(
      metadata,
      getScenario(metadata.scenario),
      transaction.flow.assessment,
      decisions,
      transaction.createdAt,
    )
    : null;
  return {
    metadata: hashCanonicalArtifact(metadata),
    tasks: hashCanonicalArtifact(parsedTasks),
    flow: flow ? hashFlowPlan(flow) : null,
    decisions: decisions.map((decision) => ({ id: decision.id, hash: hashDecisionRecord(decision) })),
  };
}

function reconciledReadiness(
  source: Readiness,
  affected: readonly (keyof Readiness)[],
  level: OrdinaryReconcileTransaction['request']['level'],
): Readiness {
  const target = structuredClone(source);
  for (const key of affected) {
    const current = source[key];
    if (current === 'NOT_APPLICABLE') continue;
    if (key === 'implementation' && ['READY', 'CONCERNS'].includes(current)) {
      target[key] = 'NEEDS_REVALIDATION';
    } else if (['L2', 'L3', 'L4'].includes(level) && ['plan', 'design'].includes(key)) {
      target[key] = 'INVALIDATED';
    } else {
      target[key] = current === 'MISSING' ? 'MISSING' : 'STALE';
    }
  }
  return target;
}
