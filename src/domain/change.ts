import { z } from 'zod';
import {
  baselineIdSchema,
} from './scalars.js';
import {
  CAPABILITIES,
  CHANGE_STATUSES,
  READINESS_KEYS,
  READINESS_STATUSES,
  RECONCILE_LEVELS,
  RISK_DIMENSION_LEVELS,
  RISK_LEVELS,
  SCENARIO_IDS,
  TASK_STATUSES,
  WORK_MODES,
  changeArtifactPathSchema,
  finiteNumberSchema,
  hObject,
  gitObjectFormatSchema,
  gitObjectIdSchema,
  guardStrictPersistentInput,
  nonemptySingleLineSchema,
  nonnegativeSafeIntegerSchema,
  projectAliasSchema,
  persistedChangeIdSchema as changeIdSchema,
  persistedDecisionIdSchema as decisionIdSchema,
  persistedEvidenceIdSchema as evidenceIdSchema,
  persistedRevisionIdSchema as revisionIdSchema,
  persistedRunIdSchema as runIdSchema,
  persistedSha256Schema as sha256Schema,
  persistedTaskIdSchema as taskIdSchema,
  persistedTimestampSchema as timestampSchema,
  repositoryCodePathSchema,
  requireCodeUnitSortedUnique,
  requireTimestampOrder,
  runBindingSchema,
  sourceRefLogicalKey,
  type Capability,
  type ReadinessKey,
  type StrictChangeSlug,
} from './public.js';

export { CAPABILITIES, CHANGE_STATUSES, READINESS_KEYS, READINESS_STATUSES, RECONCILE_LEVELS, RISK_LEVELS, TASK_STATUSES, WORK_MODES };
export type {
  Capability,
  ChangeStatus,
  ReadinessKey,
  ReadinessStatus,
  ReconcileLevel,
  RiskDimensionLevel,
  RiskLevel,
  TaskStatus,
  WorkMode,
} from './public.js';

function freezeDomainRegistry<const Values extends readonly string[]>(values: Values): Values {
  return Object.freeze([...values]) as unknown as Values;
}

const sortedStringArray = z.array(nonemptySingleLineSchema).superRefine((values, context) => {
  requireCodeUnitSortedUnique(values, (value) => value, context, []);
});
const uniqueStringArray = z.array(nonemptySingleLineSchema).superRefine((values, context) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: 'custom', message: 'NATIVE_SCHEMA_MISMATCH: collection must be unique' });
  }
});
const sortedTaskIdArray = z.array(taskIdSchema).superRefine((values, context) => {
  requireCodeUnitSortedUnique(values, (value) => value, context, []);
});
const sortedDecisionIdArray = z.array(decisionIdSchema).superRefine((values, context) => {
  requireCodeUnitSortedUnique(values, (value) => value, context, []);
});
const sortedEvidenceIdArray = z.array(evidenceIdSchema).superRefine((values, context) => {
  requireCodeUnitSortedUnique(values, (value) => value, context, []);
});
const sortedCapabilityArray = z.array(z.enum(CAPABILITIES)).superRefine((values, context) => {
  requireCodeUnitSortedUnique(values, (value) => value, context, []);
});
const sortedReadinessArray = z.array(z.enum(READINESS_KEYS)).superRefine((values, context) => {
  requireCodeUnitSortedUnique(values, (value) => value, context, []);
});
export const readinessKeySchema = z.enum(READINESS_KEYS);

const readinessRawSchema = z.strictObject({
  frame: z.enum(READINESS_STATUSES),
  map: z.enum(READINESS_STATUSES),
  research: z.enum(READINESS_STATUSES),
  mitigation: z.enum(READINESS_STATUSES),
  triage: z.enum(READINESS_STATUSES),
  reproduction: z.enum(READINESS_STATUSES),
  diagnosis: z.enum(READINESS_STATUSES),
  domain: z.enum(READINESS_STATUSES),
  spec: z.enum(READINESS_STATUSES),
  design: z.enum(READINESS_STATUSES),
  experiment: z.enum(READINESS_STATUSES),
  fix: z.enum(READINESS_STATUSES),
  plan: z.enum(READINESS_STATUSES),
  implementation: z.enum(READINESS_STATUSES),
  review: z.enum(READINESS_STATUSES),
  simplification: z.enum(READINESS_STATUSES),
  verification: z.enum(READINESS_STATUSES),
  qa: z.enum(READINESS_STATUSES),
  release: z.enum(READINESS_STATUSES),
  canary: z.enum(READINESS_STATUSES),
  learning: z.enum(READINESS_STATUSES),
});
export const readinessSchema = guardStrictPersistentInput(readinessRawSchema);
export type ReadinessConstructionInput = z.input<typeof readinessSchema>;
export type StrictReadinessV2 = z.output<typeof readinessSchema>;
export type Readiness = StrictReadinessV2;

const riskDimensionsRawSchema = z.strictObject({
  businessCriticality: z.enum(RISK_DIMENSION_LEVELS),
  data: z.enum(RISK_DIMENSION_LEVELS),
  compatibility: z.enum(RISK_DIMENSION_LEVELS),
  reversibility: z.enum(RISK_DIMENSION_LEVELS),
  security: z.enum(RISK_DIMENSION_LEVELS),
  operational: z.enum(RISK_DIMENSION_LEVELS),
});
export const riskDimensionsSchema = guardStrictPersistentInput(riskDimensionsRawSchema);
const riskModelRawSchema = z.strictObject({
  level: z.enum(RISK_LEVELS),
  dimensions: riskDimensionsRawSchema,
});
export const riskModelSchema = guardStrictPersistentInput(riskModelRawSchema);
export type RiskModelConstructionInput = z.input<typeof riskModelSchema>;
export type StrictRiskModel = z.output<typeof riskModelSchema>;
export type RiskModel = StrictRiskModel;

const impactModelRawSchema = z.strictObject({
  frontend: z.boolean(),
  backend: z.boolean(),
  apiContract: z.boolean(),
  database: z.boolean(),
  mq: z.boolean(),
  remoteService: z.boolean(),
  security: z.boolean(),
  observability: z.boolean(),
});
export const impactModelSchema = guardStrictPersistentInput(impactModelRawSchema);
export type ImpactModelConstructionInput = z.input<typeof impactModelSchema>;
export type StrictImpactModel = z.output<typeof impactModelSchema>;
export type ImpactModel = StrictImpactModel;

const scenarioProfileRawSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.enum(SCENARIO_IDS),
  detectionPriority: nonnegativeSafeIntegerSchema,
  label: nonemptySingleLineSchema,
  description: nonemptySingleLineSchema,
  workMode: z.enum(WORK_MODES),
  routeOrder: z.tuple([z.enum(CAPABILITIES)]).rest(z.enum(CAPABILITIES)),
  stages: z.tuple([z.enum(CAPABILITIES)]).rest(z.enum(CAPABILITIES)),
  optionalStages: sortedCapabilityArray,
  requiredArtifacts: z.array(changeArtifactPathSchema).superRefine((values, context) => {
    requireCodeUnitSortedUnique(values, (value) => value, context, []);
  }),
  requiredMachineState: z.array(z.enum(['ISSUE_STATE', 'TASKFILE'])).superRefine((values, context) => {
    requireCodeUnitSortedUnique(values, (value) => value, context, []);
  }),
  gates: uniqueStringArray,
  requiredEvidence: sortedStringArray,
  signals: sortedStringArray,
  risk: z.enum(RISK_LEVELS),
  riskDimensions: riskDimensionsRawSchema,
  defaultImpact: impactModelRawSchema,
}).superRefine((profile, context) => {
  if (new Set(profile.routeOrder).size !== profile.routeOrder.length) {
    context.addIssue({ code: 'custom', path: ['routeOrder'], message: 'NATIVE_SCHEMA_MISMATCH: routeOrder must be unique' });
  }
  if (new Set(profile.stages).size !== profile.stages.length) {
    context.addIssue({ code: 'custom', path: ['stages'], message: 'NATIVE_SCHEMA_MISMATCH: stages must be unique' });
  }
  const required = new Set(profile.stages);
  const optional = new Set(profile.optionalStages);
  if (profile.optionalStages.some((capability) => required.has(capability))) {
    context.addIssue({ code: 'custom', path: ['optionalStages'], message: 'NATIVE_SCHEMA_MISMATCH: optional stages must be disjoint from required stages' });
  }
  const union = new Set([...profile.stages, ...profile.optionalStages]);
  if (profile.routeOrder.length !== union.size || profile.routeOrder.some((capability) => !union.has(capability))) {
    context.addIssue({ code: 'custom', path: ['routeOrder'], message: 'NATIVE_SCHEMA_MISMATCH: routeOrder must equal required and optional stage union' });
  }
  let requiredIndex = 0;
  for (const capability of profile.routeOrder) {
    if (capability === profile.stages[requiredIndex]) requiredIndex += 1;
  }
  if (requiredIndex !== profile.stages.length) {
    context.addIssue({ code: 'custom', path: ['stages'], message: 'NATIVE_SCHEMA_MISMATCH: required stages must be a routeOrder subsequence' });
  }
});
export const scenarioProfileSchema = guardStrictPersistentInput(scenarioProfileRawSchema);
export type ScenarioProfileConstructionInput = z.input<typeof scenarioProfileSchema>;
export type StrictScenarioProfile = z.output<typeof scenarioProfileSchema>;
export type ScenarioProfile = StrictScenarioProfile;

export const strictChangeSlugSchema = z.string().min(1).refine((value) => (
  [...value].length <= 64 && /^[a-z0-9\u4e00-\u9fff]+(?:-[a-z0-9\u4e00-\u9fff]+)*$/u.test(value)
)).transform((value): StrictChangeSlug => value as StrictChangeSlug);
export type StrictChangeSlugConstructionInput = z.input<typeof strictChangeSlugSchema>;

// 背景：Zod record 会把 own `__proto__` 当作特殊键跳过，合法版本号被删除，非法
// 版本号也绕过 value schema。目的：当前唯一动态持久 record 逐个读取 authenticated
// own-data descriptor，以公开 key/value schema 校验，并用 defineProperty 物化 null-prototype
// identity output。上下文：shared guard 已在 raw Zod 前完成 descriptor preflight；这里仍不
// 使用 `record[key]`、Object.assign 或普通赋值，确保 `__proto__` 与其他字符串键同等处理。
const artifactVersionsRawSchema = z.custom<Record<string, number>>(
  (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  'NATIVE_SCHEMA_MISMATCH: artifactVersions must be a strict JSON object',
).transform((record, context): Record<string, number> => {
  const output = Object.create(null) as Record<string, number>;
  const keys = Reflect.ownKeys(record);
  for (let index = 0; index < keys.length; index += 1) {
    const keyDescriptor = Object.getOwnPropertyDescriptor(keys, String(index));
    if (keyDescriptor === undefined || !('value' in keyDescriptor)
      || typeof keyDescriptor.value !== 'string') {
      context.addIssue({
        code: 'custom',
        message: 'NATIVE_SCHEMA_MISMATCH: artifactVersions key inventory is invalid',
      });
      continue;
    }
    const key = keyDescriptor.value;
    const valueDescriptor = Object.getOwnPropertyDescriptor(record, key);
    if (valueDescriptor === undefined || !('value' in valueDescriptor)) {
      context.addIssue({
        code: 'custom',
        path: [key],
        message: 'NATIVE_SCHEMA_MISMATCH: artifactVersions value is not own data',
      });
      continue;
    }
    const parsedKey = nonemptySingleLineSchema.safeParse(key);
    const parsedValue = nonnegativeSafeIntegerSchema.safeParse(valueDescriptor.value);
    if (!parsedKey.success) {
      forwardArtifactVersionIssues(parsedKey.error.issues, key, context);
    }
    if (!parsedValue.success) {
      forwardArtifactVersionIssues(parsedValue.error.issues, key, context);
    }
    if (!parsedKey.success || !parsedValue.success) continue;
    Object.defineProperty(output, key, {
      configurable: true,
      enumerable: true,
      value: parsedValue.data,
      writable: true,
    });
  }
  return output;
});

function forwardArtifactVersionIssues(
  issues: readonly z.core.$ZodIssue[],
  key: string,
  context: z.RefinementCtx<Record<string, number>>,
): void {
  for (let issueIndex = 0; issueIndex < issues.length; issueIndex += 1) {
    const issue = issues[issueIndex]!;
    const path = new Array<PropertyKey>(issue.path.length + 1);
    Object.defineProperty(path, '0', {
      configurable: true,
      enumerable: true,
      value: key,
      writable: true,
    });
    for (let pathIndex = 0; pathIndex < issue.path.length; pathIndex += 1) {
      const pathDescriptor = Object.getOwnPropertyDescriptor(issue.path, String(pathIndex));
      if (pathDescriptor === undefined || !('value' in pathDescriptor)) continue;
      Object.defineProperty(path, String(pathIndex + 1), {
        configurable: true,
        enumerable: true,
        value: pathDescriptor.value,
        writable: true,
      });
    }
    context.addIssue({ ...issue, path });
  }
}

const changeMetadataRawSchema = z.strictObject({
  schemaVersion: z.literal(2),
  id: changeIdSchema,
  slug: strictChangeSlugSchema,
  title: nonemptySingleLineSchema,
  scenario: z.enum(SCENARIO_IDS),
  workMode: z.enum(WORK_MODES),
  status: z.enum(CHANGE_STATUSES),
  activeRevision: revisionIdSchema,
  baseline: baselineIdSchema,
  artifactVersions: artifactVersionsRawSchema,
  risk: riskModelRawSchema,
  impact: impactModelRawSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  readiness: readinessRawSchema,
}).superRefine((change, context) => {
  if (change.slug !== deriveChangeSlug(change.title)) {
    context.addIssue({ code: 'custom', path: ['slug'], message: 'NATIVE_SCHEMA_MISMATCH: slug does not match title' });
  }
  requireCodeUnitSortedUnique(Object.keys(change.artifactVersions), (value) => value, context, ['artifactVersions']);
  requireTimestampOrder(change.createdAt, change.updatedAt, context, ['updatedAt']);
});
export const changeMetadataSchema = guardStrictPersistentInput(changeMetadataRawSchema);
export type ChangeMetadataConstructionInput = z.input<typeof changeMetadataSchema>;
export type ChangeMetadata = z.output<typeof changeMetadataSchema>;

const taskRawSchema = z.strictObject({
  id: taskIdSchema,
  title: nonemptySingleLineSchema,
  objective: nonemptySingleLineSchema,
  status: z.enum(TASK_STATUSES),
  dependsOn: sortedTaskIdArray,
  slice: z.enum(['VERTICAL', 'CONTRACT_FIRST', 'RISK_FIRST', 'EXPAND', 'MIGRATE', 'CONTRACT']),
  risk: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  files: z.strictObject({
    create: z.array(repositoryCodePathSchema).superRefine((values, context) => requireCodeUnitSortedUnique(values, (value) => value, context, [])),
    modify: z.array(repositoryCodePathSchema).superRefine((values, context) => requireCodeUnitSortedUnique(values, (value) => value, context, [])),
    tests: z.array(repositoryCodePathSchema).superRefine((values, context) => requireCodeUnitSortedUnique(values, (value) => value, context, [])),
  }),
  consumes: sortedStringArray,
  produces: sortedStringArray,
  steps: z.array(nonemptySingleLineSchema),
  evidenceRequired: sortedStringArray,
  notes: z.array(nonemptySingleLineSchema),
});
export const taskSchema = guardStrictPersistentInput(taskRawSchema);
export type TaskConstructionInput = z.input<typeof taskSchema>;
export type StrictTask = z.output<typeof taskSchema>;
export type Task = StrictTask;

const taskFileRawSchema = z.strictObject({
  schemaVersion: z.literal(1),
  revision: revisionIdSchema,
  generatedFrom: sortedStringArray,
  tasks: z.array(taskRawSchema),
}).superRefine((taskFile, context) => {
  const earlier = new Set<string>();
  taskFile.tasks.forEach((task, index) => {
    const expected = `TASK-${String(index + 1).padStart(3, '0')}`;
    if (task.id !== expected) {
      context.addIssue({ code: 'custom', path: ['tasks', index, 'id'], message: 'NATIVE_SCHEMA_MISMATCH: Task IDs must be contiguous and ordered' });
    }
    for (const dependency of task.dependsOn) {
      if (!earlier.has(dependency)) {
        context.addIssue({ code: 'custom', path: ['tasks', index, 'dependsOn'], message: 'NATIVE_SCHEMA_MISMATCH: dependency must name an earlier Task' });
      }
    }
    earlier.add(task.id);
  });
});
export const taskFileSchema = guardStrictPersistentInput(taskFileRawSchema);
export type TaskFileConstructionInput = z.input<typeof taskFileSchema>;
export type StrictTaskFile = z.output<typeof taskFileSchema>;
export type TaskFile = StrictTaskFile;

const sourceRefVariants = [
  z.strictObject({ kind: z.literal('artifact'), path: changeArtifactPathSchema, contentHash: sha256Schema }),
  z.strictObject({ kind: z.literal('policy'), scenarioId: z.enum(SCENARIO_IDS), contentHash: sha256Schema }),
  z.strictObject({ kind: z.literal('evidence'), evidenceId: evidenceIdSchema, contentHash: sha256Schema }),
  z.strictObject({ kind: z.literal('decision'), decisionId: decisionIdSchema, contentHash: sha256Schema }),
  z.strictObject({ kind: z.literal('task'), taskId: taskIdSchema, contentHash: sha256Schema }),
  z.strictObject({ kind: z.literal('code'), path: repositoryCodePathSchema, contentHash: sha256Schema }),
] as const;
const SOURCE_REF_KIND_VALUES = freezeDomainRegistry(['artifact', 'policy', 'evidence', 'decision', 'task', 'code'] as const);
export const SOURCE_REF_KINDS = freezeDomainRegistry(SOURCE_REF_KIND_VALUES);
const sourceRefRawSchema = z.discriminatedUnion('kind', sourceRefVariants);
export const sourceRefSchema = guardStrictPersistentInput(sourceRefRawSchema);
export type SourceRefConstructionInput = z.input<typeof sourceRefSchema>;
export type SourceRef = z.output<typeof sourceRefSchema>;

const sourceRefCollectionRawSchema = z.array(sourceRefRawSchema).superRefine((values, context) => {
  requireCodeUnitSortedUnique(values, sourceRefLogicalKey, context, []);
});
export const sourceRefCollectionSchema = guardStrictPersistentInput(sourceRefCollectionRawSchema);
export const nonemptySourceRefCollectionSchema = guardStrictPersistentInput(sourceRefCollectionRawSchema.min(1));
export type SourceRefCollectionConstructionInput = z.input<typeof sourceRefCollectionSchema>;

const DECISION_KIND_VALUES = freezeDomainRegistry(['PROBLEM', 'DOMAIN', 'SOLUTION', 'ARCHITECTURE', 'CONTRACT', 'DELIVERY', 'EXTERNAL'] as const);
export const DECISION_KINDS = freezeDomainRegistry(DECISION_KIND_VALUES);
const DECISION_OWNER_VALUES = freezeDomainRegistry(['HUMAN', 'AGENT', 'EXTERNAL'] as const);
export const DECISION_OWNERS = freezeDomainRegistry(DECISION_OWNER_VALUES);
const DECISION_STATUS_VALUES = freezeDomainRegistry(['OPEN', 'BLOCKED', 'RESOLVED', 'REJECTED', 'SUPERSEDED'] as const);
export const DECISION_STATUSES = freezeDomainRegistry(DECISION_STATUS_VALUES);
const DECISION_OPTION_STATUS_VALUES = freezeDomainRegistry(['VIABLE', 'REJECTED'] as const);
export const DECISION_OPTION_STATUSES = freezeDomainRegistry(DECISION_OPTION_STATUS_VALUES);
const DECISION_AUTHORITY_VALUES = freezeDomainRegistry(['HUMAN_CONFIRMED', 'AGENT_EVIDENCE', 'EXTERNAL_CONFIRMED'] as const);
export const DECISION_AUTHORITIES = freezeDomainRegistry(DECISION_AUTHORITY_VALUES);
const FLOW_SCALE_VALUES = freezeDomainRegistry(['LOCAL', 'CHANGE', 'PROGRAM'] as const);
export const FLOW_SCALES = freezeDomainRegistry(FLOW_SCALE_VALUES);
const FLOW_UNCERTAINTY_VALUES = freezeDomainRegistry(['CLEAR', 'OPEN', 'BLOCKED'] as const);
export const FLOW_UNCERTAINTY = freezeDomainRegistry(FLOW_UNCERTAINTY_VALUES);
const FLOW_TOPOLOGY_VALUES = freezeDomainRegistry(['SINGLE_MODULE', 'CROSS_MODULE', 'CROSS_PROJECT'] as const);
export const FLOW_TOPOLOGIES = freezeDomainRegistry(FLOW_TOPOLOGY_VALUES);
const ARCHITECTURE_APPLICABILITY_VALUES = freezeDomainRegistry(['NOT_APPLICABLE', 'FOCUSED', 'FULL'] as const);
export const ARCHITECTURE_APPLICABILITIES = freezeDomainRegistry(ARCHITECTURE_APPLICABILITY_VALUES);
const DELIVERY_SHAPE_VALUES = freezeDomainRegistry(['STANDARD', 'MIGRATION', 'HIGH_RISK'] as const);
export const DELIVERY_SHAPES = freezeDomainRegistry(DELIVERY_SHAPE_VALUES);
const CAPABILITY_DISPOSITION_VALUES = freezeDomainRegistry(['REQUIRED', 'CONDITIONAL', 'NOT_APPLICABLE'] as const);
export const CAPABILITY_DISPOSITIONS = freezeDomainRegistry(CAPABILITY_DISPOSITION_VALUES);

const decisionAffectsRawSchema = z.strictObject({
  capabilities: sortedCapabilityArray,
  artifacts: z.array(changeArtifactPathSchema).superRefine((values, context) => requireCodeUnitSortedUnique(values, (value) => value, context, [])),
  tasks: sortedTaskIdArray,
  projects: z.array(projectAliasSchema).superRefine((values, context) => requireCodeUnitSortedUnique(values, (value) => value, context, [])),
  contracts: sortedStringArray,
});
export const decisionAffectsSchema = guardStrictPersistentInput(decisionAffectsRawSchema);
export type DecisionAffectsV2 = z.output<typeof decisionAffectsSchema>;

const decisionOptionRawSchema = z.strictObject({
  id: z.string().regex(/^OPT-\d{2}$/),
  label: nonemptySingleLineSchema,
  status: z.enum(DECISION_OPTION_STATUS_VALUES),
  consequences: z.array(nonemptySingleLineSchema),
  sourceRefs: sourceRefCollectionRawSchema,
});
export const decisionOptionSchema = guardStrictPersistentInput(decisionOptionRawSchema);
export type DecisionOptionV2 = z.output<typeof decisionOptionSchema>;
export type DecisionOption = DecisionOptionV2;

const decisionResolutionRawSchema = z.strictObject({
  optionId: z.string().regex(/^OPT-\d{2}$/).nullable(),
  summary: nonemptySingleLineSchema,
  authority: z.enum(DECISION_AUTHORITY_VALUES),
  sourceRefs: sourceRefCollectionRawSchema,
});
export const decisionResolutionSchema = guardStrictPersistentInput(decisionResolutionRawSchema);
export type DecisionResolutionV2 = z.output<typeof decisionResolutionSchema>;

const decisionRecordRawSchema = z.strictObject({
  schemaVersion: z.literal(2),
  id: decisionIdSchema,
  changeId: changeIdSchema,
  openedRevision: revisionIdSchema,
  resolvedRevision: revisionIdSchema.nullable(),
  kind: z.enum(DECISION_KIND_VALUES),
  owner: z.enum(DECISION_OWNER_VALUES),
  status: z.enum(DECISION_STATUS_VALUES),
  blocking: z.boolean(),
  question: nonemptySingleLineSchema,
  options: z.array(decisionOptionRawSchema),
  resolution: decisionResolutionRawSchema.nullable(),
  supersededBy: decisionIdSchema.nullable(),
  affects: decisionAffectsRawSchema,
  sourceRefs: sourceRefCollectionRawSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).superRefine((record, context) => {
  requireCodeUnitSortedUnique(record.options, (option) => option.id, context, ['options']);
  requireTimestampOrder(record.createdAt, record.updatedAt, context, ['updatedAt']);
  const unsettled = record.status === 'OPEN' || record.status === 'BLOCKED';
  const resolved = record.status === 'RESOLVED';
  const rejected = record.status === 'REJECTED';
  const superseded = record.status === 'SUPERSEDED';
  if (unsettled && (record.resolution !== null || record.resolvedRevision !== null || record.supersededBy !== null)) invalidDecision(context);
  if (resolved && (record.resolution === null || record.resolvedRevision === null || record.supersededBy !== null)) invalidDecision(context);
  if (rejected && (record.resolution === null || record.resolution.optionId !== null || record.resolvedRevision === null || record.supersededBy !== null)) invalidDecision(context);
  if (superseded && (record.supersededBy === null || record.resolvedRevision === null || record.resolution !== null)) invalidDecision(context);
  if (record.supersededBy === record.id) {
    context.addIssue({ code: 'custom', path: ['supersededBy'], message: 'NATIVE_SCHEMA_MISMATCH: Decision cannot supersede itself' });
  }
  if (record.resolution?.optionId !== null && record.resolution !== null) {
    const selected = record.options.find((option) => option.id === record.resolution?.optionId);
    if (selected?.status !== 'VIABLE') {
      context.addIssue({ code: 'custom', path: ['resolution', 'optionId'], message: 'NATIVE_SCHEMA_MISMATCH: resolution must select a VIABLE option' });
    }
  }
});
export const decisionRecordSchema = guardStrictPersistentInput(decisionRecordRawSchema);
export type DecisionRecordConstructionInput = z.input<typeof decisionRecordSchema>;
export type DecisionRecordV2 = z.output<typeof decisionRecordSchema>;
export type DecisionRecord = DecisionRecordV2;

const openDecisionInputRawSchema = z.strictObject({
  schemaVersion: z.literal(2),
  kind: z.enum(DECISION_KIND_VALUES),
  owner: z.enum(DECISION_OWNER_VALUES),
  status: z.enum(['OPEN', 'BLOCKED']),
  blocking: z.boolean(),
  question: nonemptySingleLineSchema,
  options: z.array(decisionOptionRawSchema).superRefine((values, context) => requireCodeUnitSortedUnique(values, (value) => value.id, context, [])),
  affects: decisionAffectsRawSchema,
  sourceRefs: sourceRefCollectionRawSchema,
});
export const openDecisionInputSchema = guardStrictPersistentInput(openDecisionInputRawSchema);
export type OpenDecisionInputConstructionInput = z.input<typeof openDecisionInputSchema>;
export type OpenDecisionInputV2 = z.output<typeof openDecisionInputSchema>;
export type OpenDecisionInput = OpenDecisionInputV2;

const decisionResolutionInputRawSchema = z.strictObject({
  schemaVersion: z.literal(2),
  optionId: z.string().regex(/^OPT-\d{2}$/).nullable(),
  summary: nonemptySingleLineSchema,
  authority: z.enum(DECISION_AUTHORITY_VALUES),
  sourceRefs: sourceRefCollectionRawSchema,
});
export const decisionResolutionInputSchema = guardStrictPersistentInput(decisionResolutionInputRawSchema);
export type DecisionResolutionInputConstructionInput = z.input<typeof decisionResolutionInputSchema>;
export type DecisionResolutionInputV2 = z.output<typeof decisionResolutionInputSchema>;
export type DecisionResolutionInput = DecisionResolutionInputV2;

const flowUncertaintyRawSchema = z.strictObject({
  problem: z.enum(FLOW_UNCERTAINTY_VALUES),
  domain: z.enum(FLOW_UNCERTAINTY_VALUES),
  solution: z.enum(FLOW_UNCERTAINTY_VALUES),
  delivery: z.enum(FLOW_UNCERTAINTY_VALUES),
});
export const flowUncertaintySchema = guardStrictPersistentInput(flowUncertaintyRawSchema);
const flowAssessmentRawSchema = z.strictObject({
  scale: z.enum(FLOW_SCALE_VALUES),
  uncertainty: flowUncertaintyRawSchema,
  topology: z.enum(FLOW_TOPOLOGY_VALUES),
  architectureApplicability: z.enum(ARCHITECTURE_APPLICABILITY_VALUES),
  deliveryShape: z.enum(DELIVERY_SHAPE_VALUES),
  decisionIds: sortedDecisionIdArray,
  sourceRefs: sourceRefCollectionRawSchema,
}).superRefine((assessment, context) => {
  const decisionRefs = assessment.sourceRefs.filter((source) => source.kind === 'decision').map((source) => source.decisionId);
  if (assessment.decisionIds.length !== decisionRefs.length || assessment.decisionIds.some((id, index) => id !== decisionRefs[index])) {
    context.addIssue({ code: 'custom', path: ['decisionIds'], message: 'NATIVE_SCHEMA_MISMATCH: assessment Decision IDs and Decision SourceRefs must match' });
  }
});
export const flowAssessmentSchema = guardStrictPersistentInput(flowAssessmentRawSchema);
export type FlowAssessmentV2 = z.output<typeof flowAssessmentSchema>;
export type FlowAssessment = FlowAssessmentV2;

const flowAssessmentProposalRawSchema = z.strictObject({
  schemaVersion: z.literal(2),
  changeId: changeIdSchema,
  revision: revisionIdSchema,
  baseline: baselineIdSchema,
  assessment: flowAssessmentRawSchema,
});
export const flowAssessmentProposalSchema = guardStrictPersistentInput(flowAssessmentProposalRawSchema);
export type FlowAssessmentProposalConstructionInput = z.input<typeof flowAssessmentProposalSchema>;
export type FlowAssessmentProposalV2 = z.output<typeof flowAssessmentProposalSchema>;
export type FlowAssessmentProposal = FlowAssessmentProposalV2;

const flowCapabilityRawSchema = z.strictObject({
  capability: z.enum(CAPABILITIES),
  disposition: z.enum(CAPABILITY_DISPOSITION_VALUES),
  active: z.boolean(),
  reason: nonemptySingleLineSchema,
  sourceRefs: sourceRefCollectionRawSchema,
}).superRefine((capability, context) => {
  if (capability.disposition === 'REQUIRED' && !capability.active) {
    context.addIssue({ code: 'custom', path: ['active'], message: 'NATIVE_SCHEMA_MISMATCH: REQUIRED capability must be active' });
  }
});
export const flowCapabilitySchema = guardStrictPersistentInput(flowCapabilityRawSchema);
export type FlowCapabilityV2 = z.output<typeof flowCapabilitySchema>;
export type FlowCapability = FlowCapabilityV2;

const decisionBindingRawSchema = z.strictObject({ id: decisionIdSchema, contentHash: sha256Schema });
export const decisionBindingSchema = guardStrictPersistentInput(decisionBindingRawSchema);
export type DecisionBindingV2 = z.output<typeof decisionBindingSchema>;
export type DecisionBinding = DecisionBindingV2;

const flowPlanRawSchema = z.strictObject({
  schemaVersion: z.literal(2),
  changeId: changeIdSchema,
  revision: revisionIdSchema,
  baseline: baselineIdSchema,
  assessment: flowAssessmentRawSchema,
  capabilities: z.array(flowCapabilityRawSchema),
  decisionIds: sortedDecisionIdArray,
  decisionBindings: z.array(decisionBindingRawSchema),
  inputHash: sha256Schema,
  compiledAt: timestampSchema,
}).superRefine((plan, context) => {
  requireCodeUnitSortedUnique(plan.capabilities, (capability) => capability.capability, context, ['capabilities']);
  requireCodeUnitSortedUnique(plan.decisionBindings, (binding) => binding.id, context, ['decisionBindings']);
  if (plan.decisionIds.length !== plan.decisionBindings.length || plan.decisionIds.some((id, index) => id !== plan.decisionBindings[index]?.id)) {
    context.addIssue({ code: 'custom', path: ['decisionBindings'], message: 'NATIVE_SCHEMA_MISMATCH: Decision inventory and bindings must match one-to-one' });
  }
  const inventory = new Set(plan.decisionIds);
  if (plan.assessment.decisionIds.some((id) => !inventory.has(id))) {
    context.addIssue({ code: 'custom', path: ['assessment', 'decisionIds'], message: 'NATIVE_SCHEMA_MISMATCH: assessment Decisions must be a Flow inventory subset' });
  }
});
export const flowPlanSchema = guardStrictPersistentInput(flowPlanRawSchema);
export type FlowPlanConstructionInput = z.input<typeof flowPlanSchema>;
export type FlowPlanV2 = z.output<typeof flowPlanSchema>;
export type FlowPlan = FlowPlanV2;

const repositoryWorkBasisRawSchema = z.strictObject({
  objectFormat: gitObjectFormatSchema,
  headCommit: gitObjectIdSchema,
  indexTreeHash: gitObjectIdSchema,
  workingPatchHash: sha256Schema,
  eligibleUntrackedInventoryHash: sha256Schema,
}).superRefine((basis, context) => {
  const expectedLength = basis.objectFormat === 'sha1' ? 40 : 64;
  if (basis.headCommit.length !== expectedLength) context.addIssue({ code: 'custom', path: ['headCommit'], message: 'NATIVE_SCHEMA_MISMATCH: Git object width does not match objectFormat' });
  if (basis.indexTreeHash.length !== expectedLength) context.addIssue({ code: 'custom', path: ['indexTreeHash'], message: 'NATIVE_SCHEMA_MISMATCH: Git object width does not match objectFormat' });
});
export const repositoryWorkBasisSchema = guardStrictPersistentInput(repositoryWorkBasisRawSchema);
export type RepositoryWorkBasis = z.output<typeof repositoryWorkBasisSchema>;

export const releaseArtifactIdentitySchema = z.strictObject({
  schemaVersion: z.literal(1),
  workflowVersion: z.literal('0.3.0'),
  authorityCatalogHash: sha256Schema,
  changeId: changeIdSchema,
  revision: revisionIdSchema,
  repositoryBasis: repositoryWorkBasisRawSchema,
  repositoryBasisHash: sha256Schema,
  delivery: z.strictObject({
    artifactAuthorityEntryId: z.literal('ship:DELIVERY'),
    role: z.literal('DELIVERY'),
    path: z.literal('delivery.md'),
    rawBytesHash: sha256Schema,
  }),
}).superRefine((identity, context) => {
  if (identity.repositoryBasisHash !== hObject(identity.repositoryBasis)) {
    context.addIssue({ code: 'custom', path: ['repositoryBasisHash'], message: 'NATIVE_SCHEMA_MISMATCH: release repository basis hash is invalid' });
  }
});
export type ReleaseArtifactIdentityV1 = z.output<typeof releaseArtifactIdentitySchema>;

// 背景：Canary 的上游不是一个 Revision/时间便捷投影，而是已认证的
// DELIVERY_STAGE 完成权限记录。目的：在进入任何 compiler 前一次性闭合 Change、Revision、
// ship Run、全局完成入口与交付产物身份。上下文：后续 ReleaseSubject 只能从此完整
// 记录纯派生，不接受 caller 填写的 subject/hash。
const completedShipAuthorityRawSchema = z.strictObject({
  schemaVersion: z.literal(1),
  changeId: changeIdSchema,
  revision: revisionIdSchema,
  capability: z.literal('ship'),
  terminalKind: z.literal('DELIVERY_STAGE'),
  disposition: z.literal('COMPLETED'),
  shipRunId: runIdSchema,
  completionSequence: z.number().int().positive().safe(),
  completionEntryHash: sha256Schema,
  completedAt: timestampSchema,
  artifactIdentity: releaseArtifactIdentitySchema,
  artifactIdentityHash: sha256Schema,
}).superRefine((ship, context) => {
  if (ship.artifactIdentityHash !== hObject(ship.artifactIdentity)
    || ship.artifactIdentity.changeId !== ship.changeId
    || ship.artifactIdentity.revision !== ship.revision) {
    context.addIssue({
      code: 'custom',
      path: ['artifactIdentity'],
      message: 'NATIVE_SCHEMA_MISMATCH: completed ship artifact identity is not adjacent to the completed authority',
    });
  }
});
export const completedShipAuthoritySchema = guardStrictPersistentInput(completedShipAuthorityRawSchema);
export type CompletedShipAuthorityV1 = z.output<typeof completedShipAuthoritySchema>;

export const releaseSubjectBindingSchema = z.strictObject({
  subject: z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal('DELIVERY_STAGE_COMPLETION'),
    changeId: changeIdSchema,
    revision: revisionIdSchema,
    shipRunId: runIdSchema,
    shipCompletion: z.strictObject({
      sequence: z.number().int().positive().safe(),
      ownerKind: z.literal('STAGE_COMPLETE'),
      ownerId: runIdSchema,
      entryHash: sha256Schema,
      completedAt: timestampSchema,
    }),
    artifactIdentity: releaseArtifactIdentitySchema,
    artifactIdentityHash: sha256Schema,
  }),
  subjectHash: sha256Schema,
}).superRefine((binding, context) => {
  const subject = binding.subject;
  if (binding.subjectHash !== hObject(subject)
    || subject.artifactIdentityHash !== hObject(subject.artifactIdentity)
    || subject.shipCompletion.ownerId !== subject.shipRunId
    || subject.artifactIdentity.changeId !== subject.changeId
    || subject.artifactIdentity.revision !== subject.revision) {
    context.addIssue({ code: 'custom', message: 'NATIVE_SCHEMA_MISMATCH: release subject binding is invalid' });
  }
});
export type ReleaseSubjectBindingV1 = z.output<typeof releaseSubjectBindingSchema>;

const evidenceSubjectRawSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('CHANGE_AUTHORITY'), revision: revisionIdSchema, authorityHead: sha256Schema }),
  z.strictObject({ kind: z.literal('REPOSITORY_BASIS'), revision: revisionIdSchema, basis: repositoryWorkBasisRawSchema }),
  z.strictObject({ kind: z.literal('TASK_REPOSITORY_BASIS'), revision: revisionIdSchema, taskId: taskIdSchema, basis: repositoryWorkBasisRawSchema }),
  z.strictObject({ kind: z.literal('RELEASE_SUBJECT'), binding: releaseSubjectBindingSchema }),
]);
export const evidenceSubjectSchema = guardStrictPersistentInput(evidenceSubjectRawSchema);
const evidenceSubjectBindingRawSchema = z.strictObject({ subject: evidenceSubjectRawSchema, subjectHash: sha256Schema });
export const evidenceSubjectBindingSchema = guardStrictPersistentInput(evidenceSubjectBindingRawSchema);

const EVIDENCE_RECORD_TYPE_VALUES = freezeDomainRegistry([
  'build', 'test', 'lint', 'typecheck', 'review', 'qa', 'security', 'migration', 'runtime', 'manual',
  'contract', 'data', 'rollback', 'reproduction',
] as const);
export const EVIDENCE_RECORD_TYPES = freezeDomainRegistry(EVIDENCE_RECORD_TYPE_VALUES);
const EVIDENCE_STATUS_VALUES = freezeDomainRegistry(['PASS', 'FAIL', 'INCONCLUSIVE'] as const);
export const EVIDENCE_STATUSES = freezeDomainRegistry(EVIDENCE_STATUS_VALUES);
const EVIDENCE_PRODUCER_VALUES = freezeDomainRegistry([
  'GENERIC_IMPORT', 'VERIFICATION_COMMAND', 'REVIEW_RESULT_IMPORT', 'QA_RESULT_IMPORT',
  'CANARY_MEASUREMENT_IMPORT', 'CANARY_RESULT_IMPORT', 'HUMAN_APPROVAL',
] as const);
export const EVIDENCE_PRODUCERS = freezeDomainRegistry(EVIDENCE_PRODUCER_VALUES);

const verificationCommandOutcomeRawSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('EXITED'), exitCode: z.number().int().min(0).max(255), signal: z.null() }),
  z.strictObject({ kind: z.literal('TIMED_OUT'), exitCode: z.null(), signal: z.null() }),
  z.strictObject({ kind: z.literal('SIGNALED'), exitCode: z.null(), signal: nonemptySingleLineSchema }),
]);
export const verificationCommandOutcomeSchema = guardStrictPersistentInput(verificationCommandOutcomeRawSchema);

const evidenceRecordRawSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: evidenceIdSchema,
  changeId: changeIdSchema,
  revision: revisionIdSchema,
  runBinding: runBindingSchema.nullable(),
  requirementId: nonemptySingleLineSchema.nullable(),
  gateId: nonemptySingleLineSchema.nullable(),
  taskId: taskIdSchema.nullable(),
  type: z.enum(EVIDENCE_RECORD_TYPE_VALUES),
  status: z.enum(EVIDENCE_STATUS_VALUES),
  producer: z.enum(EVIDENCE_PRODUCER_VALUES),
  subjectBinding: evidenceSubjectBindingRawSchema,
  summary: nonemptySingleLineSchema,
  verificationCommand: z.strictObject({
    executable: nonemptySingleLineSchema,
    arguments: z.array(nonemptySingleLineSchema),
    outcome: verificationCommandOutcomeRawSchema,
  }).nullable(),
  createdAt: timestampSchema,
  outputFile: z.string().regex(/^evidence\/outputs\/EVD-(?!000000$)\d{6}\/output\.bin$/).nullable(),
}).superRefine((record, context) => {
  const human = record.producer === 'HUMAN_APPROVAL';
  if (human !== (record.gateId !== null && record.requirementId === null)) {
    context.addIssue({ code: 'custom', path: ['gateId'], message: 'NATIVE_SCHEMA_MISMATCH: Human approval gate binding is invalid' });
  }
  if (!human && record.gateId !== null) {
    context.addIssue({ code: 'custom', path: ['gateId'], message: 'NATIVE_SCHEMA_MISMATCH: non-human Evidence cannot bind a gate' });
  }
  const command = record.producer === 'VERIFICATION_COMMAND';
  if (command !== (record.verificationCommand !== null)) {
    context.addIssue({ code: 'custom', path: ['verificationCommand'], message: 'NATIVE_SCHEMA_MISMATCH: verification command binding is invalid' });
  }
  const specialized = !['GENERIC_IMPORT', 'VERIFICATION_COMMAND'].includes(record.producer);
  if (specialized && record.runBinding === null) {
    context.addIssue({ code: 'custom', path: ['runBinding'], message: 'NATIVE_SCHEMA_MISMATCH: Run producer requires runBinding' });
  }
  if (record.runBinding !== null && record.runBinding.prepareOwner.owner.id !== record.runBinding.runId) {
    context.addIssue({ code: 'custom', path: ['runBinding', 'prepareOwner', 'owner', 'id'], message: 'NATIVE_SCHEMA_MISMATCH: Run binding owner must name its Run' });
  }
  if (!human && ((record.runBinding === null) !== (record.requirementId === null))) {
    context.addIssue({ code: 'custom', path: ['requirementId'], message: 'NATIVE_SCHEMA_MISMATCH: requirement binding must match Run scope' });
  }
  if (record.outputFile !== null && record.outputFile !== `evidence/outputs/${record.id}/output.bin`) {
    context.addIssue({ code: 'custom', path: ['outputFile'], message: 'NATIVE_SCHEMA_MISMATCH: Evidence output path must derive from Evidence ID' });
  }
  const alwaysOwnsOutput = command || ['REVIEW_RESULT_IMPORT', 'QA_RESULT_IMPORT', 'CANARY_MEASUREMENT_IMPORT', 'CANARY_RESULT_IMPORT'].includes(record.producer);
  if (alwaysOwnsOutput && record.outputFile === null) {
    context.addIssue({ code: 'custom', path: ['outputFile'], message: 'NATIVE_SCHEMA_MISMATCH: producer requires owned output' });
  }
  if (human && record.outputFile !== null) {
    context.addIssue({ code: 'custom', path: ['outputFile'], message: 'NATIVE_SCHEMA_MISMATCH: human approval cannot own output bytes' });
  }
  if (record.subjectBinding.subjectHash !== hObject(record.subjectBinding.subject)) {
    context.addIssue({ code: 'custom', path: ['subjectBinding', 'subjectHash'], message: 'NATIVE_SCHEMA_MISMATCH: Evidence subject hash is invalid' });
  }
  const subject = record.subjectBinding.subject;
  const subjectRevision = subject.kind === 'RELEASE_SUBJECT' ? subject.binding.subject.revision : subject.revision;
  if (subjectRevision !== record.revision) {
    context.addIssue({ code: 'custom', path: ['subjectBinding', 'subject', 'revision'], message: 'NATIVE_SCHEMA_MISMATCH: Evidence subject Revision is invalid' });
  }
  if (subject.kind === 'TASK_REPOSITORY_BASIS' && subject.taskId !== record.taskId) {
    context.addIssue({ code: 'custom', path: ['taskId'], message: 'NATIVE_SCHEMA_MISMATCH: Evidence Task and subject Task disagree' });
  }
  if (subject.kind !== 'TASK_REPOSITORY_BASIS' && record.taskId !== null && record.producer !== 'REVIEW_RESULT_IMPORT') {
    context.addIssue({ code: 'custom', path: ['taskId'], message: 'NATIVE_SCHEMA_MISMATCH: task-scoped Evidence requires a Task repository subject' });
  }
  if (subject.kind === 'RELEASE_SUBJECT') {
    const release = subject.binding.subject;
    if (subject.binding.subjectHash !== hObject(release)
      || release.changeId !== record.changeId
      || release.revision !== record.revision
      || record.runBinding === null) {
      context.addIssue({ code: 'custom', path: ['subjectBinding', 'subject'], message: 'NATIVE_SCHEMA_MISMATCH: release subject binding is invalid' });
    }
  }

  const fixedProducer = {
    REVIEW_RESULT_IMPORT: { requirementId: 'repository-review', type: 'review', subjectKinds: ['REPOSITORY_BASIS', 'TASK_REPOSITORY_BASIS'] },
    QA_RESULT_IMPORT: { requirementId: 'qa-result', type: 'qa', subjectKinds: ['REPOSITORY_BASIS'] },
    CANARY_RESULT_IMPORT: { requirementId: 'canary-result', type: 'runtime', subjectKinds: ['RELEASE_SUBJECT'] },
  } as const;
  if (record.producer in fixedProducer) {
    const binding = fixedProducer[record.producer as keyof typeof fixedProducer];
    if (record.requirementId !== binding.requirementId || record.type !== binding.type
      || !binding.subjectKinds.includes(subject.kind as never)) {
      context.addIssue({ code: 'custom', path: ['producer'], message: 'NATIVE_SCHEMA_MISMATCH: specialized Evidence producer matrix is invalid' });
    }
  }
  const reservedProducer = record.requirementId === 'repository-review' ? 'REVIEW_RESULT_IMPORT'
    : record.requirementId === 'qa-result' ? 'QA_RESULT_IMPORT'
      : record.requirementId === 'canary-result' ? 'CANARY_RESULT_IMPORT'
        : null;
  if (reservedProducer !== null && record.producer !== reservedProducer) {
    context.addIssue({ code: 'custom', path: ['producer'], message: 'NATIVE_SCHEMA_MISMATCH: reserved aggregate requirement has the wrong producer' });
  }
  if (record.producer === 'CANARY_MEASUREMENT_IMPORT' && (
    record.type !== 'runtime'
    || record.status !== 'PASS'
    || record.taskId !== null
    || subject.kind !== 'RELEASE_SUBJECT'
  )) {
    context.addIssue({ code: 'custom', path: ['producer'], message: 'NATIVE_SCHEMA_MISMATCH: Canary measurement Evidence is invalid' });
  }
  if (human && (record.type !== 'manual' || record.status !== 'PASS' || record.taskId !== null || record.runBinding === null)) {
    context.addIssue({ code: 'custom', path: ['producer'], message: 'NATIVE_SCHEMA_MISMATCH: human approval Evidence is invalid' });
  }
});
export const evidenceRecordSchema = guardStrictPersistentInput(evidenceRecordRawSchema);
export type EvidenceRecordConstructionInput = z.input<typeof evidenceRecordSchema>;
export type StrictEvidenceRecord = z.output<typeof evidenceRecordSchema>;
export type EvidenceRecord = StrictEvidenceRecord;
export type EvidenceRecordType = StrictEvidenceRecord['type'];
export type EvidenceStatus = StrictEvidenceRecord['status'];
export type EvidenceRecordProducerV1 = StrictEvidenceRecord['producer'];

const revisionRawSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: revisionIdSchema,
  changeId: changeIdSchema,
  previousRevision: revisionIdSchema,
  previousBaseline: baselineIdSchema,
  baseline: baselineIdSchema,
  reason: nonemptySingleLineSchema,
  level: z.enum(RECONCILE_LEVELS),
  affectedReadiness: sortedReadinessArray,
  affectedTasks: sortedTaskIdArray,
  operationRequestId: nonemptySingleLineSchema,
  createdAt: timestampSchema,
});
export const revisionSchema = guardStrictPersistentInput(revisionRawSchema);
export type RevisionConstructionInput = z.input<typeof revisionSchema>;
export type StrictRevisionRecordV1 = z.output<typeof revisionSchema>;
export type Revision = StrictRevisionRecordV1;

const reconcileSignalRawSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: nonemptySingleLineSchema,
  changeId: changeIdSchema,
  revision: revisionIdSchema,
  level: z.enum(RECONCILE_LEVELS),
  signalType: nonemptySingleLineSchema,
  reason: nonemptySingleLineSchema,
  taskRoots: sortedTaskIdArray,
  affectedTasks: sortedTaskIdArray,
  evidenceIds: sortedEvidenceIdArray,
  operationRequestId: nonemptySingleLineSchema,
  createdAt: timestampSchema,
});
export const reconcileSignalSchema = guardStrictPersistentInput(reconcileSignalRawSchema);
export type ReconcileSignalConstructionInput = z.input<typeof reconcileSignalSchema>;
export type StrictReconcileSignalV1 = z.output<typeof reconcileSignalSchema>;
export type ReconcileSignal = StrictReconcileSignalV1;

const progressBase = z.strictObject({
  schemaVersion: z.literal(1),
  timestamp: timestampSchema,
  changeId: changeIdSchema,
  revision: revisionIdSchema,
  operationRequestId: nonemptySingleLineSchema,
  runId: runIdSchema.nullable(),
  taskId: taskIdSchema.nullable(),
});
const progressVariant = <K extends string, S extends z.ZodRawShape>(event: K, data: S) => progressBase.extend({
  event: z.literal(event),
  data: z.strictObject(data),
});
const progressEventRawSchema = z.discriminatedUnion('event', [
  progressVariant('CHANGE_CREATED', { metadataHash: sha256Schema, flowHash: sha256Schema, tasksHash: sha256Schema }),
  progressVariant('DECISION_CHANGED', { action: z.enum(['OPENED', 'RESOLVED', 'REJECTED', 'SUPERSEDED', 'REBOUND']), decisionId: decisionIdSchema, decisionHash: sha256Schema, flowHash: sha256Schema }),
  progressVariant('FLOW_CHANGED', { action: z.enum(['REASSESSED', 'SOURCE_REBOUND']), sourceFlowHash: sha256Schema, targetFlowHash: sha256Schema }),
  progressVariant('RECONCILE_APPLIED', { level: z.enum(RECONCILE_LEVELS), sourceRevision: revisionIdSchema, targetRevision: revisionIdSchema, targetMetadataHash: sha256Schema, targetTasksHash: sha256Schema }),
  progressVariant('SCENARIO_RECLASSIFIED', { sourceScenarioId: z.enum(SCENARIO_IDS), targetScenarioId: z.enum(SCENARIO_IDS), targetMetadataHash: sha256Schema }),
  progressVariant('EVIDENCE_RECORDED', { evidenceId: evidenceIdSchema, producer: z.enum(EVIDENCE_PRODUCER_VALUES), requirementId: nonemptySingleLineSchema.nullable(), gateId: nonemptySingleLineSchema.nullable(), status: z.enum(EVIDENCE_STATUS_VALUES), evidenceRecordHash: sha256Schema }),
  progressVariant('TASK_STATUS_CHANGED', { sourceStatus: z.enum(TASK_STATUSES), targetStatus: z.enum(TASK_STATUSES), tasksHash: sha256Schema, reasonHash: sha256Schema.nullable() }),
  progressVariant('ISSUE_STATE_CHANGED', { action: z.enum(['TRIAGE_RESULT', 'REPRODUCTION_RESULT', 'DEBUG_RESULT']), sourceIssueHash: sha256Schema, targetIssueHash: sha256Schema }),
  progressVariant('READINESS_CHANGED', { readinessKey: z.enum(READINESS_KEYS), sourceStatus: z.enum(READINESS_STATUSES), targetStatus: z.enum(READINESS_STATUSES), metadataHash: sha256Schema }),
  progressVariant('STAGE_PREPARED', { capability: z.enum(CAPABILITIES), manifestHash: sha256Schema, promptRawBytesHash: sha256Schema }),
  progressVariant('STAGE_TERMINAL', { capability: z.enum(CAPABILITIES), disposition: z.enum(['EVIDENCE_FAILED', 'COMPLETED']), manifestHash: sha256Schema }),
  progressVariant('CHANGE_ARCHIVED', { metadataHash: sha256Schema, archiveGateSnapshotHash: sha256Schema }),
]);
export const progressEventSchema = guardStrictPersistentInput(progressEventRawSchema);
export type ProgressEventConstructionInput = z.input<typeof progressEventSchema>;
export type ProgressEventV1 = z.output<typeof progressEventSchema>;
export type ProgressEvent = ProgressEventV1;

export function deriveChangeSlug(title: string): string {
  const normalized = title.normalize('NFKD').toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  const truncated = [...normalized].slice(0, 64).join('').replace(/-+$/gu, '');
  return truncated || 'change';
}

function invalidDecision(context: z.RefinementCtx): void {
  context.addIssue({ code: 'custom', path: ['status'], message: 'NATIVE_SCHEMA_MISMATCH: Decision lifecycle fields do not match status' });
}
