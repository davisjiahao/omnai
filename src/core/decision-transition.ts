import { createHash } from 'node:crypto';
import { decisionRecordSchema, sha256Schema, type DecisionRecord, type Sha256 } from '../domain/types.js';

export interface DecisionTransitionAudit {
  timestamp?: string;
  event?: string;
  changeId?: string;
  revision?: string;
  data?: {
    decisionId?: string;
    baseline?: string;
    authority?: string;
    replacementId?: string;
    beforeHash?: string;
    afterHash?: string;
    beforeDecision?: DecisionRecord;
    afterDecision?: DecisionRecord;
  };
}

export function hashDecisionRecord(record: DecisionRecord): Sha256 {
  return sha256Schema.parse(`sha256:${createHash('sha256').update(JSON.stringify(sortJsonValue(record))).digest('hex')}`);
}

export function assertCanonicalDecisionTransition(
  event: 'DECISION_OPENED' | 'DECISION_RESOLVED' | 'DECISION_SUPERSEDED',
  before: DecisionRecord | null,
  after: DecisionRecord,
): void {
  if (event === 'DECISION_OPENED') {
    if (before !== null || (after.status !== 'OPEN' && after.status !== 'BLOCKED')) fail();
    return;
  }
  if (!before || before.id !== after.id || before.changeId !== after.changeId) fail();
  if (event === 'DECISION_RESOLVED') {
    if (
      (before.status !== 'OPEN' && before.status !== 'BLOCKED')
      || after.status !== 'RESOLVED'
      || after.resolvedRevision === null
      || after.resolution === null
      || after.supersededBy !== null
      || JSON.stringify(immutableDecision(before)) !== JSON.stringify(immutableDecision(after))
    ) fail();
    return;
  }
  if (
    !['OPEN', 'BLOCKED', 'RESOLVED'].includes(before.status)
    || after.status !== 'SUPERSEDED'
    || after.supersededBy === null
    || JSON.stringify(supersessionSource(before)) !== JSON.stringify(supersessionSource(after))
  ) fail();
}

export function assertLateDecisionTransitionHistory(
  accepted: readonly DecisionRecord[],
  current: readonly DecisionRecord[],
  events: readonly DecisionTransitionAudit[],
  changeId: string,
  revision: string,
  baseline: string,
): void {
  const records = new Map(accepted.map((decision) => [decision.id, decisionRecordSchema.parse(decision)]));
  let highestId = accepted.reduce((highest, decision) => Math.max(highest, decisionNumber(decision.id)), 0);
  for (const event of events) {
    const transitionEvent = event.event;
    if (
      transitionEvent !== 'DECISION_OPENED'
      && transitionEvent !== 'DECISION_RESOLVED'
      && transitionEvent !== 'DECISION_SUPERSEDED'
    ) continue;
    const decisionId = event.data?.decisionId;
    const afterHash = event.data?.afterHash;
    const after = decisionRecordSchema.parse(event.data?.afterDecision);
    if (
      !decisionId || !afterHash
      || event.changeId !== changeId
      || event.revision !== revision
      || event.data?.baseline !== baseline
      || after.id !== decisionId
      || after.changeId !== changeId
      || after.openedRevision !== revision
      || after.updatedAt !== event.timestamp
      || hashDecisionRecord(after) !== afterHash
    ) fail();
    if (transitionEvent === 'DECISION_OPENED') {
      const next = decisionNumber(decisionId);
      if (
        records.has(after.id)
        || next !== highestId + 1
        || after.createdAt !== event.timestamp
        || event.data?.beforeHash !== undefined
        || event.data?.beforeDecision !== undefined
      ) fail();
      assertCanonicalDecisionTransition('DECISION_OPENED', null, after);
      highestId = next;
      records.set(after.id, after);
      continue;
    }
    const beforeHash = event.data?.beforeHash;
    const before = decisionRecordSchema.parse(event.data?.beforeDecision);
    const current = records.get(after.id);
    if (
      !beforeHash
      || !current
      || JSON.stringify(current) !== JSON.stringify(before)
      || hashDecisionRecord(before) !== beforeHash
    ) fail();
    if (transitionEvent === 'DECISION_RESOLVED' && (
      !event.data?.authority
      || event.data.authority !== after.resolution?.authority
      || event.data.authority !== authorityForOwner(before.owner)
      || after.resolvedRevision !== revision
    )) fail();
    if (transitionEvent === 'DECISION_SUPERSEDED') {
      const replacement = after.supersededBy
        ? records.get(after.supersededBy)
        : undefined;
      if (
        !event.data?.replacementId
        || event.data.replacementId === decisionId
        || !replacement
        || (replacement.status !== 'OPEN' && replacement.status !== 'BLOCKED')
        || after.supersededBy !== event.data.replacementId
      ) fail();
    }
    assertCanonicalDecisionTransition(transitionEvent, before, after);
    records.set(after.id, after);
  }
  if (records.size !== current.length) fail();
  for (const decision of current) {
    if (JSON.stringify(records.get(decision.id)) !== JSON.stringify(decision)) fail();
  }
}

function authorityForOwner(owner: DecisionRecord['owner']): string {
  if (owner === 'HUMAN') return 'HUMAN_CONFIRMED';
  if (owner === 'AGENT') return 'AGENT_EVIDENCE';
  return 'EXTERNAL_CONFIRMED';
}

function immutableDecision(record: DecisionRecord): unknown {
  const {
    status: _status,
    resolvedRevision: _resolvedRevision,
    resolution: _resolution,
    supersededBy: _supersededBy,
    updatedAt: _updatedAt,
    ...immutable
  } = record;
  return immutable;
}

function supersessionSource(record: DecisionRecord): unknown {
  const {
    status: _status,
    resolvedRevision: _resolvedRevision,
    resolution: _resolution,
    supersededBy: _supersededBy,
    updatedAt: _updatedAt,
    ...source
  } = record;
  return source;
}

function decisionNumber(id: string): number {
  if (!/^DEC-\d{4}$/.test(id)) fail();
  return Number(id.slice(4));
}

function sortJsonValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortJsonValue);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, sortJsonValue(entry)]));
}

function fail(): never {
  throw new Error('DECISION_TRANSITION_INTEGRITY_MISMATCH');
}
