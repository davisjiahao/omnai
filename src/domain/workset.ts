import { z } from 'zod';
import {
  READINESS_KEYS,
  RECONCILE_LEVELS,
  gitObjectFormatSchema,
  gitObjectIdSchema,
  guardStrictPersistentInput,
  nonemptySingleLineSchema,
  normalizedAbsoluteRealPathSchema,
  positiveSafeIntegerSchema,
  persistedChangeIdSchema as changeIdSchema,
  persistedRevisionIdSchema as revisionIdSchema,
  persistedSha256Schema as sha256Schema,
  persistedTaskIdSchema as taskIdSchema,
  persistedTimestampSchema as timestampSchema,
  projectAliasSchema,
  requireCodeUnitSortedUnique,
  requireTimestampOrder,
  strictWorksetBranchSchema,
  strictWorksetSlugSchema,
  worksetIdSchema,
  worksetOperationIdSchema,
  worksetReentryIdSchema,
} from './public.js';
import { baselineIdSchema } from './scalars.js';

function freezeWorksetRegistry<const Values extends readonly string[]>(values: Values): Values {
  return Object.freeze([...values]) as unknown as Values;
}

const WORKSET_MEMBER_STATUS_VALUES = freezeWorksetRegistry(['CANDIDATE', 'RESEARCH_ONLY', 'OBSERVED_ONLY', 'ACTIVE', 'INACTIVE'] as const);
export const WORKSET_MEMBER_STATUSES = freezeWorksetRegistry(WORKSET_MEMBER_STATUS_VALUES);
const WORKSET_OPERATION_KIND_VALUES = freezeWorksetRegistry([
  'REGISTER_PROJECT', 'CREATE_WORKSET', 'ADD_CANDIDATE', 'BEGIN_RESEARCH', 'MARK_OBSERVED_ONLY',
  'ACTIVATE_PROJECT', 'MARK_INACTIVE', 'BIND_CHANGE', 'CREATE_AND_ACTIVATE_CHANGE', 'RECORD_REENTRY',
  'PLAN_REENTRY', 'DECIDE_REENTRY', 'APPLY_REENTRY', 'CONFIRM_REPLAN',
] as const);
export const WORKSET_OPERATION_KINDS = freezeWorksetRegistry(WORKSET_OPERATION_KIND_VALUES);
const WORKSET_TARGET_OPERATION_KIND_VALUES = freezeWorksetRegistry([
  'CREATE_WORKSET', 'ADD_CANDIDATE', 'BEGIN_RESEARCH', 'MARK_OBSERVED_ONLY',
  'ACTIVATE_PROJECT', 'MARK_INACTIVE', 'BIND_CHANGE', 'CREATE_AND_ACTIVATE_CHANGE', 'RECORD_REENTRY',
  'PLAN_REENTRY', 'DECIDE_REENTRY', 'APPLY_REENTRY', 'CONFIRM_REPLAN',
] as const);
export const WORKSET_TARGET_OPERATION_KINDS = freezeWorksetRegistry(WORKSET_TARGET_OPERATION_KIND_VALUES);
const REENTRY_KIND_VALUES = freezeWorksetRegistry([
  'REALITY_CHANGED', 'PRODUCT_CHANGED', 'DOMAIN_CHANGED', 'SCOPE_CHANGED', 'TECHNICAL_CONSTRAINT_CHANGED',
  'NEEDS_EXPERIMENT', 'PLAN_CHANGED', 'IMPLEMENTATION_DETAIL_CHANGED',
] as const);
export const REENTRY_KINDS = freezeWorksetRegistry(REENTRY_KIND_VALUES);

export type WorksetMemberStatus = (typeof WORKSET_MEMBER_STATUSES)[number];
export type WorksetOperationKind = (typeof WORKSET_OPERATION_KINDS)[number];
export type ReentryKindV2 = (typeof REENTRY_KINDS)[number];

const registeredProjectRawSchema = z.strictObject({
  schemaVersion: z.literal(1),
  alias: projectAliasSchema,
  name: nonemptySingleLineSchema,
  repositoryPath: normalizedAbsoluteRealPathSchema,
  repositoryIdentityHash: sha256Schema,
  originProjectAuthorityInstanceHash: sha256Schema,
  objectFormat: gitObjectFormatSchema,
  registeredAt: timestampSchema,
});
export const registeredProjectSchema = guardStrictPersistentInput(registeredProjectRawSchema);
export type RegisteredProjectConstructionInput = z.input<typeof registeredProjectSchema>;
export type RegisteredProjectV1 = z.output<typeof registeredProjectSchema>;
export type RegisteredProject = RegisteredProjectV1;

const projectRegistryRawSchema = z.strictObject({
  schemaVersion: z.literal(2),
  projects: z.array(registeredProjectRawSchema),
}).superRefine((registry, context) => {
  requireCodeUnitSortedUnique(registry.projects, (project) => project.alias, context, ['projects']);
  requireCodeUnitSortedUnique([...registry.projects].sort((left, right) => left.repositoryPath < right.repositoryPath ? -1 : left.repositoryPath > right.repositoryPath ? 1 : 0), (project) => project.repositoryPath, context, ['projects']);
  if (new Set(registry.projects.map((project) => project.repositoryIdentityHash)).size !== registry.projects.length) {
    context.addIssue({ code: 'custom', path: ['projects'], message: 'NATIVE_SCHEMA_MISMATCH: repository identity must be unique' });
  }
  if (new Set(registry.projects.map((project) => project.originProjectAuthorityInstanceHash)).size !== registry.projects.length) {
    context.addIssue({ code: 'custom', path: ['projects'], message: 'NATIVE_SCHEMA_MISMATCH: origin Project authority instance must be unique' });
  }
});
export const projectRegistrySchema = guardStrictPersistentInput(projectRegistryRawSchema);
export type ProjectRegistryConstructionInput = z.input<typeof projectRegistrySchema>;
export type StrictProjectRegistryV2 = z.output<typeof projectRegistrySchema>;
export type ProjectRegistry = StrictProjectRegistryV2;

const changeBindingSchema = z.strictObject({
  changeId: changeIdSchema,
  repositoryIdentityHash: sha256Schema,
  projectAuthorityInstanceHash: sha256Schema,
  boundAuthorityHead: sha256Schema,
  boundRevision: revisionIdSchema,
});
const workspaceBindingSchema = z.strictObject({
  relativePath: z.string().regex(/^workspace\/[a-z0-9][a-z0-9-]*$/),
  mode: z.literal('0755'),
  branch: strictWorksetBranchSchema,
  objectFormat: gitObjectFormatSchema,
  baseCommit: gitObjectIdSchema,
  projectAuthorityInstanceHash: sha256Schema,
});

const worksetMemberRawSchema = z.strictObject({
  projectAlias: projectAliasSchema,
  status: z.enum(WORKSET_MEMBER_STATUS_VALUES),
  changeBinding: changeBindingSchema.nullable(),
  workspace: workspaceBindingSchema.nullable(),
  addedAt: timestampSchema,
  updatedAt: timestampSchema,
}).superRefine((member, context) => {
  requireTimestampOrder(member.addedAt, member.updatedAt, context, ['updatedAt']);
  const requiresNoBinding = member.status === 'CANDIDATE' || member.status === 'OBSERVED_ONLY';
  if (requiresNoBinding && (member.changeBinding !== null || member.workspace !== null)) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'NATIVE_SCHEMA_MISMATCH: unbound member state cannot carry bindings' });
  }
  if (member.status === 'RESEARCH_ONLY' && member.workspace !== null) {
    context.addIssue({ code: 'custom', path: ['workspace'], message: 'NATIVE_SCHEMA_MISMATCH: research member cannot carry a workspace' });
  }
  if ((member.status === 'ACTIVE' || member.status === 'INACTIVE') && (member.changeBinding === null || member.workspace === null)) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'NATIVE_SCHEMA_MISMATCH: active or inactive member requires both bindings' });
  }
  if (member.workspace !== null && member.workspace.relativePath !== `workspace/${member.projectAlias}`) {
    context.addIssue({ code: 'custom', path: ['workspace', 'relativePath'], message: 'NATIVE_SCHEMA_MISMATCH: workspace path must derive from Project alias' });
  }
  if (member.workspace !== null && member.changeBinding !== null && member.workspace.projectAuthorityInstanceHash !== member.changeBinding.projectAuthorityInstanceHash) {
    context.addIssue({ code: 'custom', path: ['workspace', 'projectAuthorityInstanceHash'], message: 'NATIVE_SCHEMA_MISMATCH: member Project instance bindings disagree' });
  }
  if (member.workspace !== null) {
    const expected = member.workspace.objectFormat === 'sha1' ? 40 : 64;
    if (member.workspace.baseCommit.length !== expected) {
      context.addIssue({ code: 'custom', path: ['workspace', 'baseCommit'], message: 'NATIVE_SCHEMA_MISMATCH: Git object width does not match objectFormat' });
    }
  }
});
export const worksetMemberSchema = guardStrictPersistentInput(worksetMemberRawSchema);
export type WorksetMemberConstructionInput = z.input<typeof worksetMemberSchema>;
export type WorksetMemberV2 = z.output<typeof worksetMemberSchema>;
export type WorksetMember = WorksetMemberV2;

const lastOperationSchema = z.strictObject({
  operationId: worksetOperationIdSchema,
  operationRequestId: nonemptySingleLineSchema,
  requestDigest: sha256Schema,
  kind: z.enum(WORKSET_TARGET_OPERATION_KIND_VALUES),
});

const worksetRawSchema = z.strictObject({
  schemaVersion: z.literal(2),
  id: worksetIdSchema,
  slug: strictWorksetSlugSchema,
  title: nonemptySingleLineSchema,
  status: z.literal('OPEN'),
  authorityGeneration: positiveSafeIntegerSchema,
  lastOperation: lastOperationSchema,
  members: z.array(worksetMemberRawSchema),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).superRefine((workset, context) => {
  if (workset.slug !== deriveWorksetSlug(workset.title)) {
    context.addIssue({ code: 'custom', path: ['slug'], message: 'NATIVE_SCHEMA_MISMATCH: Workset slug does not match title' });
  }
  requireCodeUnitSortedUnique(workset.members, (member) => member.projectAlias, context, ['members']);
  requireTimestampOrder(workset.createdAt, workset.updatedAt, context, ['updatedAt']);
  if (workset.authorityGeneration === 1 && workset.lastOperation.kind !== 'CREATE_WORKSET') {
    context.addIssue({ code: 'custom', path: ['lastOperation', 'kind'], message: 'NATIVE_SCHEMA_MISMATCH: Workset generation one belongs to CREATE_WORKSET' });
  }
  if (workset.authorityGeneration === 1 && (workset.members.length !== 0 || workset.createdAt !== workset.updatedAt)) {
    context.addIssue({ code: 'custom', path: ['authorityGeneration'], message: 'NATIVE_SCHEMA_MISMATCH: creation generation must be empty and share one timestamp' });
  }
  if (workset.authorityGeneration > 1 && workset.lastOperation.kind === 'CREATE_WORKSET') {
    context.addIssue({ code: 'custom', path: ['lastOperation', 'kind'], message: 'NATIVE_SCHEMA_MISMATCH: CREATE_WORKSET belongs only to generation one' });
  }
  const expectedBranch = `omnai/${workset.id}-${workset.slug}`;
  workset.members.forEach((member, index) => {
    if (member.workspace !== null && member.workspace.branch !== expectedBranch) {
      context.addIssue({ code: 'custom', path: ['members', index, 'workspace', 'branch'], message: 'NATIVE_SCHEMA_MISMATCH: Workset branch does not match Workset identity' });
    }
  });
});
export const worksetSchema = guardStrictPersistentInput(worksetRawSchema);
export type WorksetConstructionInput = z.input<typeof worksetSchema>;
export type StrictWorksetV2 = z.output<typeof worksetSchema>;
export type Workset = StrictWorksetV2;

const worksetReentryRouteRawSchema = z.strictObject({
  capability: z.enum(['research', 'frame', 'model', 'spec', 'design', 'experiment', 'plan', 'work']),
  interaction: z.enum(['grill', 'brainstorm', 'show-me']),
  reason: nonemptySingleLineSchema,
});
export const worksetReentryRouteSchema = guardStrictPersistentInput(worksetReentryRouteRawSchema);
export type WorksetReentryRouteV2 = z.output<typeof worksetReentryRouteSchema>;

const projectReconcileProposalRawSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ projectAlias: projectAliasSchema, outcome: z.literal('REQUIRED'), level: z.enum(RECONCILE_LEVELS), reopenFrom: z.enum(READINESS_KEYS), taskRoots: z.array(taskIdSchema).superRefine((values, context) => requireCodeUnitSortedUnique(values, (value) => value, context, [])) }),
  z.strictObject({ projectAlias: projectAliasSchema, outcome: z.literal('NOT_REQUIRED') }),
]);
export const projectReconcileProposalSchema = guardStrictPersistentInput(projectReconcileProposalRawSchema);
export type ProjectReconcileProposalV2 = z.output<typeof projectReconcileProposalSchema>;
export type ProjectReconcileProposal = ProjectReconcileProposalV2;

const projectReconcileAttemptRawSchema = z.strictObject({
  status: z.literal('FAILED'),
  failureKind: z.enum(['STALE_PRECONDITION', 'MEMBER_NOT_WRITABLE', 'BOUND_CHANGE_MISMATCH', 'CORRELATION_CONFLICT', 'APPLY_ERROR']),
  level: z.enum(RECONCILE_LEVELS),
  reopenFrom: z.enum(READINESS_KEYS),
  readinessClosure: z.array(z.enum(READINESS_KEYS)).superRefine((values, context) => requireCodeUnitSortedUnique(values, (value) => value, context, [])),
  taskRoots: z.array(taskIdSchema).superRefine((values, context) => requireCodeUnitSortedUnique(values, (value) => value, context, [])),
  taskClosure: z.array(taskIdSchema).superRefine((values, context) => requireCodeUnitSortedUnique(values, (value) => value, context, [])),
  fromRevision: revisionIdSchema,
  fromBaseline: baselineIdSchema,
  toRevision: revisionIdSchema.nullable(),
  toBaseline: baselineIdSchema.nullable(),
  errorCode: nonemptySingleLineSchema,
  errorMessageHash: sha256Schema,
  appliedAt: timestampSchema.nullable(),
  replannedAt: timestampSchema,
});
export const projectReconcileAttemptSchema = guardStrictPersistentInput(projectReconcileAttemptRawSchema);
export type ProjectReconcileAttemptV2 = z.output<typeof projectReconcileAttemptSchema>;
export type ProjectReconcileAttempt = ProjectReconcileAttemptV2;

const requiredApplicationBaseShape = {
  projectAlias: projectAliasSchema,
  outcome: z.literal('REQUIRED'),
  changeId: changeIdSchema,
  level: z.enum(RECONCILE_LEVELS),
  reopenFrom: z.enum(READINESS_KEYS),
  readinessClosure: z.array(z.enum(READINESS_KEYS)).superRefine((values, context) => requireCodeUnitSortedUnique(values, (value) => value, context, [])),
  taskRoots: z.array(taskIdSchema).superRefine((values, context) => requireCodeUnitSortedUnique(values, (value) => value, context, [])),
  taskClosure: z.array(taskIdSchema).superRefine((values, context) => requireCodeUnitSortedUnique(values, (value) => value, context, [])),
  fromRevision: revisionIdSchema,
  fromBaseline: baselineIdSchema,
  sourceAuthorityHead: sha256Schema,
  attemptHistory: z.array(projectReconcileAttemptRawSchema),
} satisfies z.ZodRawShape;

const projectReconcileApplicationRawSchema = z.union([
  z.strictObject({
    projectAlias: projectAliasSchema,
    outcome: z.literal('NOT_REQUIRED'),
    changeId: changeIdSchema.nullable(),
    status: z.literal('NOT_REQUIRED'),
    attemptHistory: z.array(projectReconcileAttemptRawSchema),
  }),
  z.strictObject({ ...requiredApplicationBaseShape, status: z.literal('PENDING'), failureKind: z.null(), toRevision: z.null(), toBaseline: z.null(), targetAuthorityHead: z.null(), errorCode: z.null(), errorMessageHash: z.null(), appliedAt: z.null() }),
  z.strictObject({ ...requiredApplicationBaseShape, status: z.literal('APPLIED'), failureKind: z.null(), toRevision: revisionIdSchema, toBaseline: baselineIdSchema, targetAuthorityHead: sha256Schema, errorCode: z.null(), errorMessageHash: z.null(), appliedAt: timestampSchema }),
  z.strictObject({ ...requiredApplicationBaseShape, status: z.literal('FAILED'), failureKind: z.enum(['STALE_PRECONDITION', 'MEMBER_NOT_WRITABLE', 'BOUND_CHANGE_MISMATCH', 'CORRELATION_CONFLICT', 'APPLY_ERROR']), toRevision: z.null(), toBaseline: z.null(), targetAuthorityHead: z.null(), errorCode: nonemptySingleLineSchema, errorMessageHash: sha256Schema, appliedAt: z.null() }),
]).superRefine((application, context) => {
  let priorReplannedAt: string | null = null;
  application.attemptHistory.forEach((attempt, index) => {
    const targetComplete = attempt.toRevision !== null && attempt.toBaseline !== null && attempt.appliedAt !== null;
    const targetEmpty = attempt.toRevision === null && attempt.toBaseline === null && attempt.appliedAt === null;
    if (!targetComplete && !targetEmpty) {
      context.addIssue({ code: 'custom', path: ['attemptHistory', index], message: 'NATIVE_SCHEMA_MISMATCH: failed attempt target fields must be all present or all null' });
    }
    if (attempt.appliedAt !== null) requireTimestampOrder(attempt.appliedAt, attempt.replannedAt, context, ['attemptHistory', index, 'replannedAt']);
    if (priorReplannedAt !== null && priorReplannedAt >= attempt.replannedAt) {
      context.addIssue({ code: 'custom', path: ['attemptHistory', index, 'replannedAt'], message: 'NATIVE_SCHEMA_MISMATCH: attempt history must preserve strict time order' });
    }
    priorReplannedAt = attempt.replannedAt;
  });
  if (application.outcome === 'NOT_REQUIRED' && application.attemptHistory.length !== 0) {
    context.addIssue({ code: 'custom', path: ['attemptHistory'], message: 'NATIVE_SCHEMA_MISMATCH: NOT_REQUIRED application cannot carry failed attempts' });
  }
});
export const projectReconcileApplicationSchema = guardStrictPersistentInput(projectReconcileApplicationRawSchema);
export type ProjectReconcileApplicationV2 = z.output<typeof projectReconcileApplicationSchema>;
export type ProjectReconcileApplication = ProjectReconcileApplicationV2;

const worksetReentryRawSchema = z.strictObject({
  schemaVersion: z.literal(2),
  id: worksetReentryIdSchema,
  worksetId: worksetIdSchema,
  kind: z.enum(REENTRY_KIND_VALUES),
  reason: nonemptySingleLineSchema,
  route: worksetReentryRouteRawSchema,
  affectedProjects: z.array(projectAliasSchema),
  candidateProjects: z.array(projectAliasSchema),
  status: z.enum(['PENDING', 'DECIDED', 'RESOLVED']),
  proposal: z.array(projectReconcileProposalRawSchema),
  applications: z.array(projectReconcileApplicationRawSchema),
  rulesVersion: z.literal(1).nullable(),
  createdAt: timestampSchema,
  decidedAt: timestampSchema.nullable(),
  resolvedAt: timestampSchema.nullable(),
}).superRefine((reentry, context) => {
  requireCodeUnitSortedUnique(reentry.affectedProjects, (alias) => alias, context, ['affectedProjects']);
  requireCodeUnitSortedUnique(reentry.candidateProjects, (alias) => alias, context, ['candidateProjects']);
  requireCodeUnitSortedUnique(reentry.proposal, (row) => row.projectAlias, context, ['proposal']);
  requireCodeUnitSortedUnique(reentry.applications, (row) => row.projectAlias, context, ['applications']);
  const affected = new Set(reentry.affectedProjects);
  if (reentry.candidateProjects.some((alias) => affected.has(alias))) {
    context.addIssue({ code: 'custom', path: ['candidateProjects'], message: 'NATIVE_SCHEMA_MISMATCH: affected and candidate Projects must be disjoint' });
  }
  const expectedAliases = [...reentry.affectedProjects, ...reentry.candidateProjects]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const proposalAliases = reentry.proposal.map((row) => row.projectAlias);
  const applicationAliases = reentry.applications.map((row) => row.projectAlias);
  const proposalHasExactCoverage = proposalAliases.length === expectedAliases.length
    && proposalAliases.every((alias, index) => alias === expectedAliases[index]);
  const applicationsHaveExactCoverage = applicationAliases.length === expectedAliases.length
    && applicationAliases.every((alias, index) => alias === expectedAliases[index]);
  if (reentry.status === 'PENDING') {
    if (reentry.rulesVersion !== null || reentry.decidedAt !== null || reentry.resolvedAt !== null || reentry.applications.length !== 0) invalidReentry(context);
    if (reentry.proposal.length !== 0 && !proposalHasExactCoverage) invalidReentry(context);
  } else {
    if (reentry.rulesVersion !== 1 || reentry.decidedAt === null) invalidReentry(context);
    if (!proposalHasExactCoverage || !applicationsHaveExactCoverage) invalidReentry(context);
    if (reentry.proposal.some((proposal, index) => proposal.outcome !== reentry.applications[index]?.outcome)) invalidReentry(context);
    const allTerminal = reentry.applications.every((application) => application.status === 'APPLIED' || application.status === 'NOT_REQUIRED');
    if (reentry.status === 'DECIDED' && (reentry.resolvedAt !== null || allTerminal || !reentry.applications.some((application) => application.outcome === 'REQUIRED' && (application.status === 'PENDING' || application.status === 'FAILED')))) invalidReentry(context);
    if (reentry.status === 'RESOLVED' && (reentry.resolvedAt === null || !allTerminal)) invalidReentry(context);
  }
  if (reentry.decidedAt !== null) requireTimestampOrder(reentry.createdAt, reentry.decidedAt, context, ['decidedAt']);
  if (reentry.decidedAt !== null && reentry.resolvedAt !== null) requireTimestampOrder(reentry.decidedAt, reentry.resolvedAt, context, ['resolvedAt']);
});
export const worksetReentrySchema = guardStrictPersistentInput(worksetReentryRawSchema);
export type WorksetReentryConstructionInput = z.input<typeof worksetReentrySchema>;
export type WorksetReentryV2 = z.output<typeof worksetReentrySchema>;
export type WorksetReentry = WorksetReentryV2;

export function deriveWorksetSlug(title: string): string {
  const normalized = title.normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return [...normalized].slice(0, 64).join('').replace(/-+$/gu, '');
}

function invalidReentry(context: z.RefinementCtx): void {
  context.addIssue({ code: 'custom', path: ['status'], message: 'NATIVE_SCHEMA_MISMATCH: Reentry lifecycle fields do not match status' });
}
