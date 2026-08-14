import { z } from 'zod';

export const CHANGE_STATUSES = [
  'DRAFT', 'READY', 'IN_PROGRESS', 'BLOCKED', 'VERIFYING', 'READY_TO_ARCHIVE', 'ARCHIVED', 'NEEDS_RECONCILE',
] as const;

export const READINESS_STATUSES = [
  'MISSING', 'IN_PROGRESS', 'READY', 'CONCERNS', 'STALE', 'NEEDS_REVALIDATION', 'INVALIDATED', 'NOT_APPLICABLE',
] as const;

export const TASK_STATUSES = [
  'PENDING', 'READY', 'RUNNING', 'BLOCKED', 'IMPLEMENTED', 'VERIFYING', 'VERIFIED', 'DONE',
  'STALE', 'NEEDS_REVALIDATION', 'INVALIDATED', 'SUPERSEDED', 'CANCELLED',
] as const;

export const RECONCILE_LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'] as const;
export const RISK_LEVELS = ['P0', 'P1', 'P2', 'P3'] as const;
export const RISK_DIMENSION_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

export const WORK_MODES = [
  'READ_ONLY_QUERY', 'BUG_FIX', 'INCIDENT', 'FEATURE', 'PRODUCT_DISCOVERY', 'ARCHITECTURE_CHANGE',
  'MIGRATION', 'PERFORMANCE', 'SECURITY', 'RELEASE', 'EXPERIMENT', 'QUALITY',
] as const;

export const CAPABILITIES = [
  'frame', 'research', 'map', 'model', 'spec', 'design', 'plan',
  'triage', 'reproduce', 'debug', 'diagnose', 'experiment', 'fix', 'mitigate',
  'work', 'simplify', 'review', 'verify', 'qa', 'ship', 'release', 'canary', 'learn', 'archive', 'reconcile',
] as const;

export type ChangeStatus = (typeof CHANGE_STATUSES)[number];
export type ReadinessStatus = (typeof READINESS_STATUSES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type ReconcileLevel = (typeof RECONCILE_LEVELS)[number];
export type RiskLevel = (typeof RISK_LEVELS)[number];
export type RiskDimensionLevel = (typeof RISK_DIMENSION_LEVELS)[number];
export type WorkMode = (typeof WORK_MODES)[number];
export type Capability = (typeof CAPABILITIES)[number];

export const readinessSchema = z.object({
  frame: z.enum(READINESS_STATUSES).default('MISSING'),
  map: z.enum(READINESS_STATUSES).default('MISSING'),
  research: z.enum(READINESS_STATUSES).default('MISSING'),
  mitigation: z.enum(READINESS_STATUSES).default('MISSING'),
  triage: z.enum(READINESS_STATUSES).default('MISSING'),
  reproduction: z.enum(READINESS_STATUSES).default('MISSING'),
  diagnosis: z.enum(READINESS_STATUSES).default('MISSING'),
  domain: z.enum(READINESS_STATUSES).default('MISSING'),
  spec: z.enum(READINESS_STATUSES).default('MISSING'),
  design: z.enum(READINESS_STATUSES).default('MISSING'),
  experiment: z.enum(READINESS_STATUSES).default('MISSING'),
  fix: z.enum(READINESS_STATUSES).default('MISSING'),
  plan: z.enum(READINESS_STATUSES).default('MISSING'),
  implementation: z.enum(READINESS_STATUSES).default('MISSING'),
  review: z.enum(READINESS_STATUSES).default('MISSING'),
  verification: z.enum(READINESS_STATUSES).default('MISSING'),
  qa: z.enum(READINESS_STATUSES).default('MISSING'),
  release: z.enum(READINESS_STATUSES).default('NOT_APPLICABLE'),
  canary: z.enum(READINESS_STATUSES).default('MISSING'),
  learning: z.enum(READINESS_STATUSES).default('MISSING'),
});

export type Readiness = z.infer<typeof readinessSchema>;

const riskDimensionsSchema = z.object({
  businessCriticality: z.enum(RISK_DIMENSION_LEVELS).default('MEDIUM'),
  data: z.enum(RISK_DIMENSION_LEVELS).default('LOW'),
  compatibility: z.enum(RISK_DIMENSION_LEVELS).default('LOW'),
  reversibility: z.enum(RISK_DIMENSION_LEVELS).default('MEDIUM'),
  security: z.enum(RISK_DIMENSION_LEVELS).default('LOW'),
  operational: z.enum(RISK_DIMENSION_LEVELS).default('LOW'),
});

export const riskModelSchema = z.object({
  level: z.enum(RISK_LEVELS).default('P2'),
  dimensions: riskDimensionsSchema.default({
    businessCriticality: 'MEDIUM', data: 'LOW', compatibility: 'LOW', reversibility: 'MEDIUM', security: 'LOW', operational: 'LOW',
  }),
});
export type RiskModel = z.infer<typeof riskModelSchema>;

export const impactModelSchema = z.object({
  frontend: z.boolean().default(false), backend: z.boolean().default(false), apiContract: z.boolean().default(false),
  database: z.boolean().default(false), mq: z.boolean().default(false), remoteService: z.boolean().default(false),
  security: z.boolean().default(false), observability: z.boolean().default(false),
});
export type ImpactModel = z.infer<typeof impactModelSchema>;

export const projectConfigSchema = z.object({
  schemaVersion: z.literal(1), project: z.string().min(1), activeChange: z.string().nullable().default(null),
  defaultScenario: z.string().default('small-feature'), installedHosts: z.array(z.enum(['claude', 'codex', 'opencode'])).default([]),
  verification: z.object({ commands: z.array(z.string()).default([]) }).default({ commands: [] }),
});
export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export const workflowLockSchema = z.object({
  schemaVersion: z.literal(1), workflowVersion: z.string(),
  artifactSchemas: z.record(z.string(), z.number().int().positive()),
  promptVersions: z.record(z.string(), z.number().int().positive()),
});
export type WorkflowLock = z.infer<typeof workflowLockSchema>;

export const changeMetadataSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().regex(/^CHG-\d{4}$/), slug: z.string().min(1), title: z.string().min(1),
  scenario: z.string().min(1), workMode: z.enum(WORK_MODES), status: z.enum(CHANGE_STATUSES),
  activeRevision: z.string().regex(/^REV-\d{4}$/), baseline: z.string().regex(/^BL-\d{4}$/).default('BL-0001'),
  artifactVersions: z.record(z.string(), z.number().int().nonnegative()).default({}),
  risk: riskModelSchema.default({
    level: 'P2', dimensions: { businessCriticality: 'MEDIUM', data: 'LOW', compatibility: 'LOW', reversibility: 'MEDIUM', security: 'LOW', operational: 'LOW' },
  }),
  impact: impactModelSchema.default({
    frontend: false, backend: false, apiContract: false, database: false, mq: false, remoteService: false, security: false, observability: false,
  }),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), readiness: readinessSchema,
});
export type ChangeMetadata = z.infer<typeof changeMetadataSchema>;

export const taskSchema = z.object({
  id: z.string().regex(/^TASK-\d{3}$/), title: z.string().min(1), objective: z.string().min(1), status: z.enum(TASK_STATUSES).default('PENDING'),
  dependsOn: z.array(z.string()).default([]),
  slice: z.enum(['VERTICAL', 'CONTRACT_FIRST', 'RISK_FIRST', 'EXPAND', 'MIGRATE', 'CONTRACT']).default('VERTICAL'),
  risk: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  files: z.object({ create: z.array(z.string()).default([]), modify: z.array(z.string()).default([]), tests: z.array(z.string()).default([]) }).default({ create: [], modify: [], tests: [] }),
  consumes: z.array(z.string()).default([]), produces: z.array(z.string()).default([]), steps: z.array(z.string()).default([]),
  evidenceRequired: z.array(z.string()).default([]), notes: z.array(z.string()).default([]),
});
export type Task = z.infer<typeof taskSchema>;

export const taskFileSchema = z.object({
  schemaVersion: z.literal(1), revision: z.string().regex(/^REV-\d{4}$/), generatedFrom: z.array(z.string()).default([]), tasks: z.array(taskSchema),
});
export type TaskFile = z.infer<typeof taskFileSchema>;

export const progressEventSchema = z.object({
  timestamp: z.string().datetime(), event: z.string().min(1), changeId: z.string(), revision: z.string(), taskId: z.string().optional(),
  runId: z.string().optional(), detail: z.string().optional(), data: z.record(z.string(), z.unknown()).optional(),
});
export type ProgressEvent = z.infer<typeof progressEventSchema>;

export const evidenceRecordSchema = z.object({
  schemaVersion: z.literal(1), id: z.string(), changeId: z.string(), revision: z.string(), taskId: z.string().optional(),
  requirementId: z.string().optional(),
  type: z.enum(['build', 'test', 'lint', 'typecheck', 'review', 'qa', 'security', 'migration', 'runtime', 'manual', 'contract', 'data', 'rollback', 'reproduction']),
  status: z.enum(['PASS', 'FAIL', 'INCONCLUSIVE']), command: z.string().optional(), exitCode: z.number().int().optional(), summary: z.string(),
  createdAt: z.string().datetime(), outputFile: z.string().optional(),
});
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;

export const reconcileSignalSchema = z.object({
  schemaVersion: z.literal(1), id: z.string(), changeId: z.string(), revision: z.string(), level: z.enum(RECONCILE_LEVELS),
  type: z.string().min(1), reason: z.string().min(1), affectedTasks: z.array(z.string()).default([]), evidence: z.array(z.string()).default([]),
  correlationId: z.string().min(1).optional(), createdAt: z.string().datetime(),
});
export type ReconcileSignal = z.infer<typeof reconcileSignalSchema>;

export const revisionSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().regex(/^REV-\d{4}$/), changeId: z.string(), previousRevision: z.string().nullable(),
  previousBaseline: z.string().regex(/^BL-\d{4}$/).optional(), baseline: z.string().regex(/^BL-\d{4}$/).optional(),
  reason: z.string(), level: z.enum(RECONCILE_LEVELS), affectedArtifacts: z.array(z.string()), affectedTasks: z.array(z.string()),
  correlationId: z.string().min(1).optional(), createdAt: z.string().datetime(),
});
export type Revision = z.infer<typeof revisionSchema>;

export interface ScenarioProfile {
  id: string;
  label: string;
  description: string;
  workMode: WorkMode;
  stages: Capability[];
  optionalStages: Capability[];
  requiredArtifacts: string[];
  gates: string[];
  requiredEvidence: string[];
  signals: string[];
  risk: RiskLevel;
  riskDimensions?: Partial<RiskModel['dimensions']>;
  defaultImpact?: Partial<ImpactModel>;
}

export interface StageRunManifest {
  schemaVersion: 1;
  id: string;
  changeId: string;
  revision: string;
  capability: Capability;
  status: 'PREPARED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  instruction: string;
  promptPath: string;
  outputPaths: string[];
  createdAt: string;
  completedAt?: string;
}
