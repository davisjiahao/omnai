import { z } from 'zod';
import {
  compareCodeUnits,
  evidenceTemplateSchema,
  hashStrictObject,
  type EvidenceRequirementTemplate,
} from '../catalog-schema.js';
import {
  repositoryWorkBasisSchema,
  taskFileSchema,
  type RepositoryWorkBasis,
  type StrictTaskFile,
} from '../../domain/change.js';
import {
  activeRouteSchema,
  evidenceRequirementSchema,
  type ActiveCapabilityRouteV1,
  type EvidenceRequirementContract,
  type VerificationTaskRequirementBinding,
} from '../../domain/run.js';
import { nonemptySingleLineSchema } from '../../domain/public.js';
import {
  cloneStrictJson,
  instantiateEvidenceTemplate,
  parseCompilerInput,
  requireCodeUnitOrder,
  requireLinearMembershipWorkBudget,
  requireSingleRow,
  sortedUnique,
} from '../compiler-runtime.js';
import type { Sha256, TaskId } from '../../domain/scalars.js';

const TASK_EVIDENCE_IDS = [
  'task-behavior', 'task-characterization', 'task-contract', 'task-deletion',
  'task-integration', 'task-migration', 'task-operability',
] as const;
const inputSchema = z.strictObject({
  scenarioRequiredEvidence: z.array(nonemptySingleLineSchema),
  taskFile: taskFileSchema,
  taskEvidenceRequirementIds: z.tuple(TASK_EVIDENCE_IDS.map((id) => z.literal(id)) as [
    z.ZodLiteral<'task-behavior'>, z.ZodLiteral<'task-characterization'>,
    z.ZodLiteral<'task-contract'>, z.ZodLiteral<'task-deletion'>,
    z.ZodLiteral<'task-integration'>, z.ZodLiteral<'task-migration'>,
    z.ZodLiteral<'task-operability'>,
  ]),
  evidenceTemplates: z.array(evidenceTemplateSchema).length(74),
  verifiedBasis: repositoryWorkBasisSchema,
  activeRoute: activeRouteSchema,
});

export interface VerifyScenarioTaskEvidenceCompileInputV1 {
  readonly scenarioRequiredEvidence: readonly string[];
  readonly taskFile: StrictTaskFile;
  readonly taskEvidenceRequirementIds: typeof TASK_EVIDENCE_IDS;
  readonly evidenceTemplates: readonly EvidenceRequirementTemplate[];
  readonly verifiedBasis: RepositoryWorkBasis;
  readonly activeRoute: ActiveCapabilityRouteV1;
}

export interface VerifyTerminalFragmentV1 {
  readonly verifiedBasis: RepositoryWorkBasis;
  readonly sourceTasksHash: Sha256;
  readonly evidenceRequirements: readonly EvidenceRequirementContract[];
  readonly evidenceRequirementsHash: Sha256;
  readonly verificationTaskIds: readonly TaskId[];
  readonly verificationTaskRequirements: readonly VerificationTaskRequirementBinding[];
  readonly verificationTaskRequirementsHash: Sha256;
  readonly targetTaskFile: StrictTaskFile;
  readonly targetTasksHash: Sha256;
}

export const verifyTerminalFragmentSchema = z.strictObject({
  verifiedBasis: repositoryWorkBasisSchema,
  sourceTasksHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  evidenceRequirements: z.array(evidenceRequirementSchema),
  evidenceRequirementsHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  verificationTaskIds: z.array(z.string().regex(/^TASK-(?!000$)\d{3}$/)),
  verificationTaskRequirements: z.array(z.strictObject({
    taskId: z.string().regex(/^TASK-(?!000$)\d{3}$/),
    requirementIds: z.array(nonemptySingleLineSchema),
  })),
  verificationTaskRequirementsHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  targetTaskFile: taskFileSchema,
  targetTasksHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

// 背景：Verify 同时闭合 Scenario-wide 与 per-Task Evidence，并且是 Task 生命周期进入 DONE 的唯一
// stage compiler。目的：把 Task set、requirement bindings、完整 target TaskFile 与所有相邻 hash 一次固化。
// 上下文：不活跃/已取消 Task 不制造 minimum；每个活跃实现 Task 必须来自严格七项 registry 的非空子集。
export function compileVerifyScenarioTaskEvidence(
  value: unknown,
): VerifyTerminalFragmentV1 {
  const input = parseCompilerInput(inputSchema, value);
  requireCodeUnitOrder(input.scenarioRequiredEvidence, 'Scenario Evidence requirements');
  requireCodeUnitOrder(input.evidenceTemplates.map((template) => template.requirementId), 'Evidence template registry');
  const taskRequirementIds = new Set<string>(input.taskEvidenceRequirementIds);
  const declaredTaskRequirementCount = input.taskFile.tasks.reduce(
    (total, task) => total + task.evidenceRequired.length,
    0,
  );
  requireLinearMembershipWorkBudget(
    [input.taskFile.tasks.length, declaredTaskRequirementCount],
    'Verify Task/TASK_DECLARED Evidence membership join',
  );
  if (input.scenarioRequiredEvidence.some((requirementId) => taskRequirementIds.has(requirementId))) {
    throw new TypeError('STATIC_INPUT_INVALID: Scenario Evidence and TASK_DECLARED namespaces must be disjoint');
  }
  for (const requirementId of input.taskEvidenceRequirementIds) {
    const template = requireSingleRow(
      input.evidenceTemplates,
      (candidate) => candidate.requirementId === requirementId,
      `Task Evidence template '${requirementId}'`,
    );
    if (template.taskScopeFormula !== 'TASK_DECLARED') {
      throw new TypeError(`STATIC_INPUT_INVALID: Task Evidence '${requirementId}' is outside the TASK_DECLARED partition`);
    }
  }
  // 背景：inactive Task 不产生本次 verification minimum，但它仍被完整复制进 targetTaskFile；
  // 若 membership 校验放在 active filter 之后，DONE/SUPERSEDED/CANCELLED 就能永久携带 unknown
  // 或 Scenario/其他 scope 的 Evidence 名称。目的：在任何状态筛选前，对全体 Task 只认证名称
  // membership；上面的 exact7 tuple 与唯一 TASK_DECLARED template 校验共同保证每个名称唯一解析。
  // 上下文：这里不要求非空，inactive empty 是合法历史状态；只有下方 active Task 才必须非空并
  // 满足 readiness，因而不会把“无本次 minimum”误写成新的 Evidence 权限。
  for (const task of input.taskFile.tasks) {
    requireCodeUnitOrder(task.evidenceRequired, `Task '${task.id}' evidenceRequired`);
    if (task.evidenceRequired.some((requirementId) => !taskRequirementIds.has(requirementId))) {
      throw new TypeError(`STATIC_INPUT_INVALID: Task '${task.id}' has an invalid TASK_DECLARED registry Evidence policy`);
    }
  }
  const activeTasks = input.taskFile.tasks.filter((task) => (
    !['DONE', 'SUPERSEDED', 'CANCELLED'].includes(task.status)
  ));
  for (const task of activeTasks) {
    if (!['IMPLEMENTED', 'NEEDS_REVALIDATION'].includes(task.status)) {
      throw new TypeError(`PRECONDITION_UNSATISFIED: Task '${task.id}' is not ready for verification`);
    }
    if (task.evidenceRequired.length === 0) {
      throw new TypeError(`STATIC_INPUT_INVALID: Task '${task.id}' has an invalid Evidence policy`);
    }
  }
  if (input.activeRoute.implementationRequired !== (activeTasks.length > 0)) {
    throw new TypeError('PRECONDITION_UNSATISFIED: active route and verification Task set disagree');
  }
  const verificationTaskIds = activeTasks.map((task) => task.id).sort(compareCodeUnits);
  const verificationTaskRequirements = activeTasks.map((task) => ({
    taskId: task.id,
    requirementIds: [...task.evidenceRequired],
  })).sort((left, right) => compareCodeUnits(left.taskId, right.taskId));
  const usedTaskRequirementIds = sortedUnique(activeTasks.flatMap((task) => task.evidenceRequired));
  const usedTaskRequirementIdSet = new Set(usedTaskRequirementIds);
  const requirementIds = sortedUnique([...input.scenarioRequiredEvidence, ...usedTaskRequirementIds]);
  const evidenceRequirements = requirementIds.map((requirementId) => {
    const template = requireSingleRow(
      input.evidenceTemplates,
      (candidate) => candidate.requirementId === requirementId,
      `Evidence template '${requirementId}'`,
    );
    const isTaskDeclared = usedTaskRequirementIdSet.has(requirementId);
    if (isTaskDeclared && template.taskScopeFormula !== 'TASK_DECLARED') {
      throw new TypeError(`STATIC_INPUT_INVALID: Task Evidence '${requirementId}' has the wrong scope formula`);
    }
    if (!isTaskDeclared && template.taskScopeFormula !== 'NONE') {
      throw new TypeError(`STATIC_INPUT_INVALID: Scenario Evidence '${requirementId}' is outside the NONE-scoped Scenario partition`);
    }
    return instantiateEvidenceTemplate(template);
  }).map((requirement) => evidenceRequirementSchema.parse(requirement));
  const verificationTaskIdSet = new Set(verificationTaskIds);
  const targetTaskFile = taskFileSchema.parse({
    ...input.taskFile,
    tasks: input.taskFile.tasks.map((task) => (
      verificationTaskIdSet.has(task.id) ? { ...task, status: 'DONE' } : task
    )),
  });
  return cloneStrictJson({
    verifiedBasis: input.verifiedBasis,
    sourceTasksHash: hashStrictObject(input.taskFile),
    evidenceRequirements,
    evidenceRequirementsHash: hashStrictObject(evidenceRequirements),
    verificationTaskIds,
    verificationTaskRequirements,
    verificationTaskRequirementsHash: hashStrictObject(verificationTaskRequirements),
    targetTaskFile,
    targetTasksHash: hashStrictObject(targetTaskFile),
  });
}
