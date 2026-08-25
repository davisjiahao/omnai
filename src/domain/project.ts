import { z } from 'zod';
import {
  guardStrictPersistentInput,
  persistedChangeIdSchema as changeIdSchema,
  nonemptySingleLineSchema,
  nonnegativeSafeIntegerSchema,
  persistedSha256Schema as sha256Schema,
} from './public.js';
import { projectTransactionIdSchema } from './scalars.js';

function freezeProjectRegistry<const Values extends readonly string[]>(values: Values): Values {
  return Object.freeze([...values]) as unknown as Values;
}

const PROJECT_TRANSACTION_KIND_VALUES = freezeProjectRegistry([
  'CREATE_CHANGE', 'PROMOTE_INVESTIGATION', 'CREATE_INVESTIGATION', 'SELECT_CHANGE',
] as const);
export const PROJECT_TRANSACTION_KINDS = freezeProjectRegistry(PROJECT_TRANSACTION_KIND_VALUES);
const PROJECT_CONFIG_OPERATION_KIND_VALUES = freezeProjectRegistry([
  'CREATE_CHANGE', 'PROMOTE_INVESTIGATION', 'SELECT_CHANGE',
] as const);
export const PROJECT_CONFIG_OPERATION_KINDS = freezeProjectRegistry(PROJECT_CONFIG_OPERATION_KIND_VALUES);

export type ProjectTransactionKind = (typeof PROJECT_TRANSACTION_KINDS)[number];
export type ProjectConfigOperationKind = (typeof PROJECT_CONFIG_OPERATION_KINDS)[number];

const projectConfigOperationRawSchema = z.strictObject({
  transactionId: projectTransactionIdSchema,
  operationRequestId: nonemptySingleLineSchema,
  requestDigest: sha256Schema,
  kind: z.enum(PROJECT_CONFIG_OPERATION_KIND_VALUES),
});
export const projectConfigOperationSchema = guardStrictPersistentInput(projectConfigOperationRawSchema);

const projectConfigRawSchema = z.strictObject({
  schemaVersion: z.literal(2),
  project: nonemptySingleLineSchema,
  workflowBindingHash: sha256Schema,
  activeChange: changeIdSchema.nullable(),
  authorityGeneration: nonnegativeSafeIntegerSchema,
  lastProjectOperation: projectConfigOperationRawSchema.nullable(),
}).superRefine((project, context) => {
  const initial = project.authorityGeneration === 0;
  const empty = project.activeChange === null && project.lastProjectOperation === null;
  const complete = project.activeChange !== null && project.lastProjectOperation !== null;
  if ((initial && !empty) || (!initial && !complete)) {
    context.addIssue({
      code: 'custom',
      path: ['authorityGeneration'],
      message: 'NATIVE_SCHEMA_MISMATCH: generation zero is exactly the unselected initial Project state',
    });
  }
});
export const projectConfigSchema = guardStrictPersistentInput(projectConfigRawSchema);
export type ProjectConfigConstructionInput = z.input<typeof projectConfigSchema>;
export type StrictProjectConfig = z.output<typeof projectConfigSchema>;
export type ProjectConfig = StrictProjectConfig;

const workflowLockRawSchema = z.strictObject({
  schemaVersion: z.literal(2),
  workflowVersion: z.literal('0.3.0'),
  authorityCatalogId: z.literal('omnai.stage-authority.v1'),
  authorityCatalogSchemaVersion: z.literal(1),
  authorityCatalogHash: sha256Schema,
  resourceBundleHash: sha256Schema,
});
export const workflowLockSchema = guardStrictPersistentInput(workflowLockRawSchema);
export type WorkflowLockConstructionInput = z.input<typeof workflowLockSchema>;
export type StrictWorkflowLockV2 = z.output<typeof workflowLockSchema>;
export type WorkflowLock = StrictWorkflowLockV2;
