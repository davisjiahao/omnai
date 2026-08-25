import { baselineIdSchema, revisionIdSchema, type BaselineId, type RevisionId } from '../domain/types.js';

export function incrementRevision(revision: string): RevisionId {
  const match = /^REV-(\d{4})$/.exec(revision);
  if (!match?.[1]) throw new Error(`Invalid revision '${revision}'`);
  return revisionIdSchema.parse(`REV-${String(Number(match[1]) + 1).padStart(4, '0')}`);
}

export function incrementBaseline(baseline: string): BaselineId {
  const match = /^BL-(\d{4})$/.exec(baseline);
  if (!match?.[1]) throw new Error(`Invalid baseline '${baseline}'`);
  return baselineIdSchema.parse(`BL-${String(Number(match[1]) + 1).padStart(4, '0')}`);
}
