import { z } from 'zod';
import { REENTRY_KINDS } from '../domain/types.js';
import {
  guardStrictPersistentInput,
  nonemptySingleLineSchema,
  projectAliasSchema,
  requireCodeUnitSortedUnique,
} from '../domain/public.js';

const sortedProjectAliasesSchema = z.array(projectAliasSchema).superRefine((values, context) => {
  requireCodeUnitSortedUnique(values, (value) => value, context, []);
});

const worksetReentryInputRawSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.enum(REENTRY_KINDS),
  reason: nonemptySingleLineSchema,
  affectedProjects: sortedProjectAliasesSchema,
  candidateProjects: sortedProjectAliasesSchema,
}).superRefine((input, context) => {
  const affected = new Set(input.affectedProjects);
  if (input.candidateProjects.some((alias) => affected.has(alias))) {
    context.addIssue({ code: 'custom', path: ['candidateProjects'], message: 'NATIVE_SCHEMA_MISMATCH: affected and candidate Projects must be disjoint' });
  }
});
export const worksetReentryInputSchema = guardStrictPersistentInput(worksetReentryInputRawSchema);

export type WorksetReentryInput = z.input<typeof worksetReentryInputSchema>;
