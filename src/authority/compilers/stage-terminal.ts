import { z } from 'zod';
import {
  capabilityTemplateSchema,
  hashStrictObject,
  stageAuthorityCatalogV1Schema,
  type StageCapabilityTemplate,
  type StageAuthorityCatalogV1,
} from '../catalog-schema.js';
import {
  completedShipAuthoritySchema,
  impactModelSchema,
  repositoryWorkBasisSchema,
  riskModelSchema,
  taskFileSchema,
  type CompletedShipAuthorityV1,
} from '../../domain/change.js';
import {
  activeRouteSchema,
  archiveGateSnapshotSchema,
  canaryPolicySchema,
  evidenceRequirementSchema,
  humanGateContractSchema,
  qaPolicySchema,
  repositoryWorkResultSchema,
  repositoryFailureSnapshotSchema,
  reviewPolicySchema,
  reviewScopeSchema,
  runOutputBindingSchema,
  runTerminalContractSchema,
  type RunOutputBinding,
  type RunTerminalContract,
} from '../../domain/run.js';
import {
  persistedChangeIdSchema,
  persistedRevisionIdSchema,
  persistedRunIdSchema,
  persistedSha256Schema,
  persistedTaskIdSchema,
  persistedTimestampSchema,
  CAPABILITIES,
} from '../../domain/public.js';
import { compileCanaryPolicyByScenario } from './canary-policy-by-scenario.js';
import { compileDeliveryPolicy, deliveryTerminalFragmentSchema } from './delivery-policy.js';
import { compileQaPolicyByScenario } from './qa-policy-by-scenario.js';
import { compileReviewPolicy } from './review-policy.js';
import { compileVerifyScenarioTaskEvidence, verifyTerminalFragmentSchema } from './verify-scenario-task-evidence.js';
import {
  assertNever,
  cloneStrictJson,
  instantiateEvidenceTemplate,
  parseCompilerInput,
  sortedUnique,
} from '../compiler-runtime.js';

const issueStateSchema = z.strictObject({
  triageState: z.enum(['needs-info', 'ready-for-debug', 'ready-for-fix', 'needs-experiment', 'ready-for-human', 'wontfix']),
  reproduction: z.enum(['unknown', 'confirmed', 'not-reproducible', 'instrumentation-required']),
  rootCause: z.enum(['unknown', 'suspected', 'confirmed']),
  fixStrategy: z.enum(['unknown', 'ready', 'needs-experiment']),
});
const repositoryRetryStateSchema = z.strictObject({
  capability: z.enum(['work', 'simplify']),
  taskId: persistedTaskIdSchema.nullable(),
  rootRunId: persistedRunIdSchema,
  latestFailedRunId: persistedRunIdSchema,
  latestFailure: repositoryFailureSnapshotSchema,
  latestFailureHash: persistedSha256Schema,
  completedRunId: z.null(),
  abandonedByRunId: z.null(),
}).superRefine((state, context) => {
  if (state.latestFailureHash !== hashStrictObject(state.latestFailure)
    || state.latestFailure.rootRunId !== state.rootRunId
    || state.latestFailure.capability !== state.capability
    || state.latestFailure.taskId !== state.taskId) {
    context.addIssue({ code: 'custom', message: 'STATIC_INPUT_INVALID: repository retry state adjacency mismatch' });
  }
});
const stageTerminalInputShape = {
  template: capabilityTemplateSchema,
  identity: z.strictObject({
    changeId: persistedChangeIdSchema,
    revision: persistedRevisionIdSchema,
    runId: persistedRunIdSchema,
  }),
  source: z.strictObject({
    authorityHead: persistedSha256Schema,
    metadataHash: persistedSha256Schema,
    currentRisk: riskModelSchema,
    currentImpact: impactModelSchema,
    activeRoute: activeRouteSchema,
    activeRouteHash: persistedSha256Schema,
    tasksHash: persistedSha256Schema,
    taskFile: taskFileSchema,
    issueHash: persistedSha256Schema.nullable(),
    issueState: issueStateSchema.nullable(),
    repositoryBasis: repositoryWorkBasisSchema.nullable(),
    repositoryRetryState: repositoryRetryStateSchema.nullable(),
    repositoryRetryStartResult: repositoryWorkResultSchema.nullable(),
    archiveGateSnapshot: archiveGateSnapshotSchema.nullable(),
  }),
  selection: z.strictObject({
    taskId: persistedTaskIdSchema.nullable(),
    retryRunId: persistedRunIdSchema.nullable(),
    reviewScope: reviewScopeSchema.nullable(),
  }),
  outputBindings: z.array(runOutputBindingSchema),
  evidenceRequirements: z.array(evidenceRequirementSchema),
  humanGates: z.array(humanGateContractSchema),
  policies: z.strictObject({
    review: reviewPolicySchema.nullable(),
    qa: qaPolicySchema.nullable(),
    canary: canaryPolicySchema.nullable(),
  }),
  verify: verifyTerminalFragmentSchema.nullable(),
  delivery: deliveryTerminalFragmentSchema.nullable(),
  ship: completedShipAuthoritySchema.nullable(),
  coreTime: persistedTimestampSchema,
} satisfies z.ZodRawShape;
const inputSchema = z.strictObject(stageTerminalInputShape).superRefine((input, context) => {
  if (input.source.activeRouteHash !== hashStrictObject(input.source.activeRoute)) {
    context.addIssue({ code: 'custom', path: ['source', 'activeRouteHash'], message: 'STATIC_INPUT_INVALID: active route hash mismatch' });
  }
  if (input.source.tasksHash !== hashStrictObject(input.source.taskFile)) {
    context.addIssue({ code: 'custom', path: ['source', 'tasksHash'], message: 'STATIC_INPUT_INVALID: TaskFile hash mismatch' });
  }
  if ((input.source.issueHash === null) !== (input.source.issueState === null)
    || (input.source.issueState !== null
      && input.source.issueHash !== hashStrictObject(input.source.issueState))) {
    context.addIssue({
      code: 'custom', path: ['source', 'issueHash'],
      message: 'STATIC_INPUT_INVALID: Issue state/hash mismatch',
    });
  }
  if (!input.source.activeRoute.activeCapabilities.includes(input.template.capability)) {
    context.addIssue({ code: 'custom', path: ['template', 'capability'], message: 'PRECONDITION_UNSATISFIED: capability is absent from active route' });
  }
});

const authenticatedInputSchema = z.strictObject({
  authorityCatalog: stageAuthorityCatalogV1Schema,
  capability: z.enum(CAPABILITIES),
  changeTitle: z.string().min(1).refine((value) => value.trim().length > 0 && !/[\r\n\0]/u.test(value)),
  sealedArtifactRenders: z.array(z.strictObject({
    entryId: z.string().min(1),
    renderedScaffoldHash: persistedSha256Schema,
  })),
  identity: stageTerminalInputShape.identity,
  source: stageTerminalInputShape.source,
  selection: stageTerminalInputShape.selection,
  outputBindings: stageTerminalInputShape.outputBindings,
  evidenceRequirements: stageTerminalInputShape.evidenceRequirements,
  humanGates: stageTerminalInputShape.humanGates,
  policies: stageTerminalInputShape.policies,
  verify: stageTerminalInputShape.verify,
  delivery: stageTerminalInputShape.delivery,
  ship: stageTerminalInputShape.ship,
  coreTime: stageTerminalInputShape.coreTime,
});

export type StageTerminalCompileInputV1 = z.output<typeof inputSchema>;

// 背景：规范 stage-terminal-v1 的 artifact 函数只接收 StageTerminalCompilerInputV1，
// 但该值必须由已认证 catalog/context builder 组装，不能成为 caller 自报 template 的入口。
// 目的：reference 层先从完整 StageAuthorityCatalogV1 选择唯一 capability row，并逐字段验证
// Artifact、Evidence 与 HumanGate 投影，再调用不导出的 exact ABI。上下文：Task 9E 会把同一
// 两层边界封装进 hash-verified runtime；这里不建立第二份 catalog 或 compiler registry。
export function compileAuthenticatedStageTerminal(value: unknown): RunTerminalContract {
  const authenticated = parseCompilerInput(authenticatedInputSchema, value);
  const template = requireCatalogCapability(authenticated.authorityCatalog, authenticated.capability);
  const internal: StageTerminalCompileInputV1 = {
    template,
    identity: authenticated.identity,
    source: authenticated.source,
    selection: authenticated.selection,
    outputBindings: authenticated.outputBindings,
    evidenceRequirements: authenticated.evidenceRequirements,
    humanGates: authenticated.humanGates,
    policies: authenticated.policies,
    verify: authenticated.verify,
    delivery: authenticated.delivery,
    ship: authenticated.ship,
    coreTime: authenticated.coreTime,
  };
  validateCatalogProjection(
    authenticated.authorityCatalog,
    authenticated.changeTitle,
    authenticated.sealedArtifactRenders,
    internal,
  );
  return compileStageTerminalTrusted(internal);
}

function requireCatalogCapability(
  catalog: StageAuthorityCatalogV1,
  capability: StageTerminalCompileInputV1['template']['capability'],
): StageCapabilityTemplate {
  const rows = catalog.capabilityTemplates.filter((row) => row.capability === capability);
  if (rows.length !== 1) throw new TypeError('AUTHORITY_CATALOG_MISMATCH: capability template is not singular');
  return rows[0]!;
}

function validateCatalogProjection(
  catalog: StageAuthorityCatalogV1,
  changeTitle: string,
  sealedArtifactRenders: z.output<typeof authenticatedInputSchema>['sealedArtifactRenders'],
  input: StageTerminalCompileInputV1,
): void {
  validatePolicyCompilerProjection(catalog, input);
  const expectedEvidence = expectedCatalogEvidence(catalog, input);
  if (hashStrictObject(input.evidenceRequirements) !== hashStrictObject(expectedEvidence)) {
    throw new TypeError('STATIC_INPUT_INVALID: Evidence contracts are not the full catalog/policy projection');
  }
  const expectedGates = input.template.humanGateIds.map((gateId) => {
    const rows = catalog.humanGateTemplates.filter((row) => row.gateId === gateId);
    if (rows.length !== 1) throw new TypeError('AUTHORITY_CATALOG_MISMATCH: HumanGate template is not singular');
    return rows[0]!;
  });
  if (hashStrictObject(input.humanGates) !== hashStrictObject(expectedGates)) {
    throw new TypeError('STATIC_INPUT_INVALID: HumanGate contracts are not the full catalog projection');
  }
  if (input.template.authoredOutputs.some((row) => row.kind === 'ARTIFACT_AUTHORITY_SET')) {
    const expectedOutputs = expectedCatalogArtifactOutputs(catalog, changeTitle, sealedArtifactRenders, input);
    if (hashStrictObject(input.outputBindings) !== hashStrictObject(expectedOutputs)) {
      throw new TypeError('STATIC_INPUT_INVALID: authored outputs are not the full ArtifactAuthority projection');
    }
  }
}

// 背景：policy fragment 与 Artifact row 一样承载 terminal 权限；只做 strict schema parse
// 仍允许 caller 提供另一份“合法但非目录派生”的 policy。目的：在 wrapper 内以同一完整 catalog
// 和已认证 source 重跑五个 reference compiler，并逐对象比较；不保存第二份 policy 常量表。
function validatePolicyCompilerProjection(
  catalog: StageAuthorityCatalogV1,
  input: StageTerminalCompileInputV1,
): void {
  const scenarioRows = catalog.scenarioProfiles.filter((row) => row.id === input.source.activeRoute.scenarioId);
  if (scenarioRows.length !== 1) throw new TypeError('AUTHORITY_CATALOG_MISMATCH: active Scenario is not singular');
  const scenario = scenarioRows[0]!;
  const review = input.template.capability === 'review' ? compileReviewPolicy({
    scenario,
    risk: input.source.currentRisk,
    impact: input.source.currentImpact,
  }) : null;
  const qa = input.template.capability === 'qa' ? compileQaPolicyByScenario({
    scenarioId: scenario.id,
    policies: catalog.qaPoliciesByScenario,
  }) : null;
  const canary = input.template.capability === 'canary' && input.ship !== null
    ? compileCanaryPolicyByScenario({
      scenarioId: scenario.id,
      policies: catalog.canaryPoliciesByScenario,
      ship: input.ship,
      coreTime: input.coreTime,
    }).policy : null;
  const verify = input.template.capability === 'verify' && input.source.repositoryBasis !== null
    ? compileVerifyScenarioTaskEvidence({
      scenarioRequiredEvidence: scenario.requiredEvidence,
      taskFile: input.source.taskFile,
      taskEvidenceRequirementIds: catalog.taskEvidenceRequirementIds,
      evidenceTemplates: catalog.evidenceTemplates,
      verifiedBasis: input.source.repositoryBasis,
      activeRoute: input.source.activeRoute,
    }) : null;
  const delivery = input.template.capability === 'ship' ? compileDeliveryPolicy({
    mode: 'PREPARE',
    evidenceRequirementIds: input.template.baseEvidenceRequirementIds,
    humanGateIds: input.template.humanGateIds,
    evidenceTemplates: catalog.evidenceTemplates,
    humanGateTemplates: catalog.humanGateTemplates,
  }).fragment : null;
  if (hashStrictObject(input.policies) !== hashStrictObject({ review, qa, canary })) {
    throw new TypeError(`STATIC_INPUT_INVALID: ${input.template.capability} policy snapshot is not the authenticated catalog projection`);
  }
  if (hashStrictObject(input.verify) !== hashStrictObject(verify)) {
    throw new TypeError('STATIC_INPUT_INVALID: Verify fragment is not the authenticated catalog projection');
  }
  if (hashStrictObject(input.delivery) !== hashStrictObject(delivery)) {
    throw new TypeError('STATIC_INPUT_INVALID: Delivery fragment is not the authenticated catalog projection');
  }
  if ((input.template.capability === 'canary') !== (input.ship !== null)) {
    throw new TypeError('STATIC_INPUT_INVALID: Canary ship authority presence is not exact');
  }
}

function expectedCatalogEvidence(
  catalog: StageAuthorityCatalogV1,
  input: StageTerminalCompileInputV1,
): StageTerminalCompileInputV1['evidenceRequirements'] {
  if (input.verify !== null) return cloneStrictJson(input.verify.evidenceRequirements);
  if (input.delivery !== null) return cloneStrictJson(input.delivery.evidenceRequirements);
  const requirements = expectedEvidenceRequirementIds(input).map((requirementId) => {
    const rows = catalog.evidenceTemplates.filter((row) => row.requirementId === requirementId);
    if (rows.length !== 1) throw new TypeError('AUTHORITY_CATALOG_MISMATCH: Evidence template is not singular');
    const row = rows[0]!;
    if (row.taskScopeFormula !== 'REVIEW_SCOPE') return instantiateEvidenceTemplate(row);
    if (input.selection.reviewScope === null) {
      throw new TypeError('STATIC_INPUT_INVALID: REVIEW_SCOPE Evidence lacks authenticated ReviewScope');
    }
    const base = {
      requirementId: row.requirementId,
      producer: row.producer,
      allowedTypes: [...row.allowedTypes],
      allowedStatuses: [...row.allowedStatuses],
      satisfyingStatus: row.satisfyingStatus,
      outputPolicy: row.outputPolicy,
      sourceScope: row.sourceScope,
      subjectPolicy: row.subjectPolicy,
    } as const;
    return input.selection.reviewScope.kind === 'TASK'
      ? { ...base, taskScope: { kind: 'SELECTED_TASK' as const }, minimumRecordsPerTask: row.minimumRecords }
      : { ...base, taskScope: { kind: 'NONE' as const }, minimumRecords: row.minimumRecords };
  });
  return inputSchema.shape.evidenceRequirements.parse(requirements);
}

function expectedCatalogArtifactOutputs(
  catalog: StageAuthorityCatalogV1,
  changeTitle: string,
  sealedArtifactRenders: z.output<typeof authenticatedInputSchema>['sealedArtifactRenders'],
  input: StageTerminalCompileInputV1,
): StageTerminalCompileInputV1['outputBindings'] {
  const scenarioRows = catalog.scenarioProfiles.filter((row) => row.id === input.source.activeRoute.scenarioId);
  if (scenarioRows.length !== 1) throw new TypeError('AUTHORITY_CATALOG_MISMATCH: active Scenario is not singular');
  const scenario = scenarioRows[0]!;
  const entries = catalog.artifactAuthority.entries.filter((entry) => {
    if (entry.capability !== input.template.capability) return false;
    const activation = entry.activation;
    return activation.kind === 'ALWAYS'
      || scenario.requiredArtifacts.some((path) => path === activation.path)
      || input.source.currentImpact[activation.impactKey];
  });
  if (entries.length === 0) throw new TypeError('POLICY_UNAVAILABLE: ArtifactAuthority selection is empty');
  const expectedDynamicRenderIds = entries.filter((entry) => entry.kind === 'FILE'
    && entry.scaffold?.renderInputs.kind === 'CHANGE_TITLE_AND_SCENARIO').map((entry) => entry.entryId);
  if (hashStrictObject(sealedArtifactRenders.map((row) => row.entryId)) !== hashStrictObject(expectedDynamicRenderIds)) {
    throw new TypeError('STATIC_INPUT_INVALID: dynamic scaffold render seal set is not exhaustive');
  }
  for (const key of [
    entries.map((entry) => entry.entryId),
    entries.map((entry) => entry.role),
    entries.map((entry) => entry.path),
  ]) {
    if (new Set(key).size !== key.length) {
      throw new TypeError('AUTHORITY_CATALOG_MISMATCH: selected ArtifactAuthority rows are not unique');
    }
  }
  return entries.map((entry) => {
    if (entry.kind === 'DIRECTORY') {
      return {
        kind: 'AUTHORED_DIRECTORY' as const,
        role: entry.role,
        path: entry.path,
        minimumRegularFiles: entry.minimumRegularFiles,
      };
    }
    if (entry.scaffold === null) {
      return { kind: 'AUTHORED_FILE' as const, role: entry.role, path: entry.path, scaffoldBinding: null };
    }
    const renderInputs = entry.scaffold.renderInputs.kind === 'NONE' ? {} : {
      title: changeTitle,
      scenarioId: scenario.id,
      workMode: scenario.workMode,
      risk: input.source.currentRisk.level,
    };
    const renderedScaffoldHash = entry.scaffold.renderInputs.kind === 'NONE'
      ? entry.scaffold.templateHash
      : sealedArtifactRenders.find((render) => render.entryId === entry.entryId)?.renderedScaffoldHash ?? null;
    if (renderedScaffoldHash === null) {
      throw new TypeError('STATIC_INPUT_INVALID: authenticated dynamic scaffold render is missing');
    }
    return {
      kind: 'AUTHORED_FILE' as const,
      role: entry.role,
      path: entry.path,
      scaffoldBinding: {
        templateId: entry.scaffold.templateId,
        templateHash: entry.scaffold.templateHash,
        renderInputs,
        renderedScaffoldHash,
      },
    };
  });
}

// 背景：RunTerminalContract 曾由 Core 按 stage 分支拼装，导致目录 row、动态 basis、policy 与 output
// 可以漂移。目的：以唯一 template discriminant 穷举十二种 terminal，并在返回前通过 final domain schema
// 重新验证所有相邻 hash 和交叉绑定。上下文：没有 default 分支；新增 terminalKind 必须显式修改函数和 golden。
function compileStageTerminalTrusted(value: unknown): RunTerminalContract {
  const input = parseCompilerInput(inputSchema, value);
  validateTemplateAuthority(input);
  switch (input.template.terminalKind) {
    case 'ARTIFACT_STAGE': {
      const roles = requireOutputKinds(input.outputBindings, ['AUTHORED_FILE', 'AUTHORED_DIRECTORY']);
      if (roles.length === 0) throw new TypeError('POLICY_UNAVAILABLE: artifact stage has no authored output');
      return parseTerminal({ kind: 'ARTIFACT_STAGE', readinessKey: input.template.readinessKey, requiredOutputRoles: roles });
    }
    case 'PLAN_STAGE':
      requireOnlyOutput(input.outputBindings, 'TASKFILE_DRAFT', input.identity.runId);
      return parseTerminal({
        kind: 'PLAN_STAGE', draftRole: 'TASKFILE_DRAFT', sourceTasksHash: input.source.tasksHash,
        requireNonemptyWorkPlan: input.source.activeRoute.implementationRequired,
      });
    case 'ISSUE_STAGE':
      if (input.source.issueHash === null || input.source.issueState === null || input.source.repositoryBasis === null) {
        throw new TypeError('PRECONDITION_UNSATISFIED: Issue stage requires Issue state and repository basis');
      }
      requireOutputKinds(input.outputBindings, ['AUTHORED_FILE', 'AUTHORED_DIRECTORY']);
      return parseTerminal({
        kind: 'ISSUE_STAGE', sourceIssueHash: input.source.issueHash, observedBasis: input.source.repositoryBasis,
        requiredIssuePredicates: input.template.issuePredicates,
        evidenceRequirements: input.evidenceRequirements,
        evidenceRequirementsHash: hashStrictObject(input.evidenceRequirements),
      });
    case 'WORK_STAGE':
      return compileWorkTerminal(input);
    case 'SIMPLIFY_STAGE':
      return compileSimplifyTerminal(input);
    case 'REVIEW_STAGE':
      if (input.source.repositoryBasis === null || input.selection.reviewScope === null || input.policies.review === null) {
        throw new TypeError('PRECONDITION_UNSATISFIED: Review stage requires basis, scope and policy');
      }
      requireOnlyOutput(input.outputBindings, 'REVIEW_DRAFT', input.identity.runId);
      return parseTerminal({
        kind: 'REVIEW_STAGE', evidenceRequirements: input.evidenceRequirements,
        evidenceRequirementsHash: hashStrictObject(input.evidenceRequirements), reviewedBasis: input.source.repositoryBasis,
        reviewScope: input.selection.reviewScope, reviewScopeHash: hashStrictObject(input.selection.reviewScope),
        reviewPolicy: input.policies.review, reviewPolicyHash: hashStrictObject(input.policies.review),
        requiredHumanGates: input.humanGates,
      });
    case 'VERIFY_STAGE':
      if (input.verify === null) throw new TypeError('POLICY_UNAVAILABLE: Verify fragment is missing');
      if (input.outputBindings.length !== 0) throw new TypeError('STATIC_INPUT_INVALID: Verify authors no direct output');
      return parseTerminal({ kind: 'VERIFY_STAGE', ...input.verify, requiredHumanGates: input.humanGates });
    case 'QA_STAGE':
      if (input.source.repositoryBasis === null || input.policies.qa === null) {
        throw new TypeError('POLICY_UNAVAILABLE: QA basis/policy is missing');
      }
      requireOnlyOutput(input.outputBindings, 'QA_DRAFT', input.identity.runId);
      return parseTerminal({
        kind: 'QA_STAGE', evidenceRequirements: input.evidenceRequirements,
        evidenceRequirementsHash: hashStrictObject(input.evidenceRequirements), testedBasis: input.source.repositoryBasis,
        qaPolicy: input.policies.qa, qaPolicyHash: hashStrictObject(input.policies.qa),
        qaResultRequirementId: 'qa-result', requiredHumanGates: input.humanGates,
      });
    case 'CANARY_STAGE':
      if (input.policies.canary === null || input.ship === null
        || input.ship.changeId !== input.identity.changeId
        || input.ship.revision !== input.identity.revision
        || input.ship.completedAt > input.coreTime) {
        throw new TypeError('PRECONDITION_UNSATISFIED: Canary policy or same-Revision ship is missing');
      }
      requireOnlyOutput(input.outputBindings, 'CANARY_DRAFT', input.identity.runId);
      return parseTerminal({
        kind: 'CANARY_STAGE', evidenceRequirements: input.evidenceRequirements,
        evidenceRequirementsHash: hashStrictObject(input.evidenceRequirements),
        releaseSubjectBinding: deriveReleaseSubjectBinding(input.ship), windowOpenedAt: input.coreTime,
        canaryPolicy: input.policies.canary, canaryPolicyHash: hashStrictObject(input.policies.canary),
        canaryResultRequirementId: 'canary-result', requiredHumanGates: input.humanGates,
      });
    case 'DELIVERY_STAGE':
      if (input.source.repositoryBasis === null || input.delivery === null) {
        throw new TypeError('POLICY_UNAVAILABLE: Delivery basis/fragment is missing');
      }
      requireOutputKinds(input.outputBindings, ['AUTHORED_FILE']);
      return parseTerminal({
        kind: 'DELIVERY_STAGE', deliveryRole: 'DELIVERY', deliveryBasis: input.source.repositoryBasis,
        evidenceRequirements: input.delivery.evidenceRequirements,
        evidenceRequirementsHash: input.delivery.evidenceRequirementsHash,
        requiredHumanGates: input.delivery.requiredHumanGates,
      });
    case 'ARCHIVE_STAGE':
      if (input.source.archiveGateSnapshot === null || input.outputBindings.length !== 0) {
        throw new TypeError('PRECONDITION_UNSATISFIED: Archive gate snapshot/output mismatch');
      }
      return parseTerminal({
        kind: 'ARCHIVE_STAGE', sourceMetadataHash: input.source.metadataHash,
        requiredGateSnapshot: input.source.archiveGateSnapshot,
        requiredGateSnapshotHash: hashStrictObject(input.source.archiveGateSnapshot),
      });
    case 'RECONCILE_STAGE':
      if (input.outputBindings.length !== 0) throw new TypeError('STATIC_INPUT_INVALID: Reconcile authors no Run output');
      return parseTerminal({
        kind: 'RECONCILE_STAGE', sourceRevision: input.identity.revision,
        allowedTopLevelOwners: ['DECISION_RECONCILE', 'FLOW_ASSESSMENT', 'ORDINARY_RECONCILE', 'SCENARIO_RECLASSIFICATION'],
        requireExactlyOne: true,
      });
  }
  return assertNever(input.template.terminalKind, 'stage terminal kind');
}

function compileWorkTerminal(input: StageTerminalCompileInputV1): RunTerminalContract {
  if (input.selection.taskId === null || input.source.repositoryBasis === null) {
    throw new TypeError('PRECONDITION_UNSATISFIED: Work requires selected Task and repository basis');
  }
  const task = input.source.taskFile.tasks.find((candidate) => candidate.id === input.selection.taskId);
  if (task === undefined) throw new TypeError('PRECONDITION_UNSATISFIED: selected Work Task is absent');
  // 背景：negativeEvidenceRecovery 的 source statuses 只描述失败后 writer 可以把哪些
  // 状态复原为 READY，它不是新 WORK Run 的 START grammar。目的：在 terminal 冻结
  // sourceTaskHash/sourceTasksHash 前认证 selected Task 已 READY，禁止将失败恢复权限
  // 扩大成 RUNNING/BLOCKED/IMPLEMENTED 也能直接开始新的正常工作。
  if (task.status !== 'READY') {
    throw new TypeError('PRECONDITION_UNSATISFIED: selected Work Task must be READY');
  }
  const lineage = compileRepositoryLineage(input, 'work', input.selection.taskId);
  const basis = lineage.kind === 'RETRY' ? lineage.rootPreparedBasis : input.source.repositoryBasis;
  const allowedRepositoryPaths = sortedUnique([...task.files.create, ...task.files.modify, ...task.files.tests]);
  requireRepositoryDiff(input.outputBindings, 'IMPLEMENTATION_DIFF', input.selection.taskId, basis);
  return parseTerminal({
    kind: 'WORK_STAGE', taskId: input.selection.taskId, sourceTasksHash: input.source.tasksHash,
    sourceTaskHash: hashStrictObject(task), basis, repositoryLineage: lineage,
    repositoryLineageHash: hashStrictObject(lineage), allowedRepositoryPaths,
    allowedRepositoryPathsHash: hashStrictObject(allowedRepositoryPaths), requiredTaskStatus: 'IMPLEMENTED',
    requiredRepositoryDelta: 'NON_EMPTY', negativeEvidenceRecovery: {
      kind: 'RESET_SELECTED_TASK_TO_READY',
      allowedSourceStatuses: ['READY', 'RUNNING', 'BLOCKED', 'IMPLEMENTED'],
      targetStatus: 'READY', preserveAllOtherTaskFileFields: true,
    },
    evidenceRequirements: input.evidenceRequirements,
    evidenceRequirementsHash: hashStrictObject(input.evidenceRequirements),
  });
}

function compileSimplifyTerminal(input: StageTerminalCompileInputV1): RunTerminalContract {
  if (input.source.repositoryBasis === null) throw new TypeError('PRECONDITION_UNSATISFIED: Simplify requires repository basis');
  const lineage = compileRepositoryLineage(input, 'simplify', null);
  const basis = lineage.kind === 'RETRY' ? lineage.rootPreparedBasis : input.source.repositoryBasis;
  requireRepositoryDiff(input.outputBindings, 'SIMPLIFICATION_DIFF', null, basis);
  return parseTerminal({
    kind: 'SIMPLIFY_STAGE', basis, repositoryLineage: lineage, repositoryLineageHash: hashStrictObject(lineage),
    requiredRepositoryDelta: 'NON_EMPTY', evidenceRequirements: input.evidenceRequirements,
    evidenceRequirementsHash: hashStrictObject(input.evidenceRequirements),
  });
}

function compileRepositoryLineage(
  input: StageTerminalCompileInputV1,
  capability: 'work' | 'simplify',
  taskId: StageTerminalCompileInputV1['selection']['taskId'],
) {
  const state = input.source.repositoryRetryState;
  const currentBasis = input.source.repositoryBasis!;
  if (state === null) {
    if (input.source.repositoryRetryStartResult !== null) {
      throw new TypeError('STATIC_INPUT_INVALID: root repository stage cannot carry retry-start result');
    }
    if (input.selection.retryRunId !== null) throw new TypeError('PRECONDITION_UNSATISFIED: retryRunId has no open failure');
    return { kind: 'ROOT', rootRunId: input.identity.runId, abandonedFailureRunId: null } as const;
  }
  if (state.capability !== capability || state.taskId !== taskId) {
    throw new TypeError('PRECONDITION_UNSATISFIED: open repository failure belongs to another stage/Task');
  }
  if (input.selection.retryRunId === null) {
    if (input.source.repositoryRetryStartResult !== null) {
      throw new TypeError('STATIC_INPUT_INVALID: exact-revert root cannot carry retry-start result');
    }
    if (hashStrictObject(currentBasis) !== hashStrictObject(state.latestFailure.rootPreparedBasis)) {
      throw new TypeError('PRECONDITION_UNSATISFIED: open failure requires explicit retry or exact revert');
    }
    return { kind: 'ROOT', rootRunId: input.identity.runId, abandonedFailureRunId: state.latestFailedRunId } as const;
  }
  if (input.selection.retryRunId !== state.latestFailedRunId) {
    throw new TypeError('PRECONDITION_UNSATISFIED: only the latest failed leaf may be retried');
  }
  const retryStartResult = input.source.repositoryRetryStartResult;
  if (retryStartResult === null
    || hashStrictObject(retryStartResult.prepared) !== hashStrictObject(state.latestFailure.rootPreparedBasis)
    || hashStrictObject(retryStartResult.completed) !== hashStrictObject(currentBasis)) {
    throw new TypeError('PRECONDITION_UNSATISFIED: authenticated root-to-retry-start result is missing or stale');
  }
  return {
    kind: 'RETRY', rootRunId: state.rootRunId, retryOfRunId: state.latestFailedRunId,
    rootPreparedBasis: state.latestFailure.rootPreparedBasis,
    rootPreparedBasisHash: hashStrictObject(state.latestFailure.rootPreparedBasis),
    retryStartBasis: currentBasis, retryStartBasisHash: hashStrictObject(currentBasis), retryStartResult,
  } as const;
}

function validateTemplateAuthority(input: StageTerminalCompileInputV1): void {
  validatePolicyBinding(input);
  validateEvidenceAuthority(input);
  validateHumanGateAuthority(input);
  validateAuthoredOutputAuthority(input);
}

function validatePolicyBinding(input: StageTerminalCompileInputV1): void {
  const binding = input.template.policyBinding.kind;
  if ((binding === 'REVIEW_POLICY_COMPILER_V1') !== (input.policies.review !== null)
    || (binding === 'QA_POLICY_BY_SCENARIO_V1') !== (input.policies.qa !== null)
    || (binding === 'CANARY_POLICY_BY_SCENARIO_V1') !== (input.policies.canary !== null)
    || (binding === 'VERIFY_SCENARIO_AND_TASK_EVIDENCE_V1') !== (input.verify !== null)
    || (binding === 'DELIVERY_POLICY_V1') !== (input.delivery !== null)) {
    throw new TypeError('STATIC_INPUT_INVALID: template policy binding and compiled fragment disagree');
  }
}

function validateEvidenceAuthority(input: StageTerminalCompileInputV1): void {
  const expected = expectedEvidenceRequirementIds(input);
  const actual = input.evidenceRequirements.map((requirement) => requirement.requirementId);
  if (hashStrictObject(actual) !== hashStrictObject(expected)) {
    throw new TypeError('STATIC_INPUT_INVALID: Evidence contracts do not exactly close the capability template and policy fragment');
  }
}

function expectedEvidenceRequirementIds(input: StageTerminalCompileInputV1): string[] {
  const binding = input.template.policyBinding.kind;
  if (binding === 'VERIFY_SCENARIO_AND_TASK_EVIDENCE_V1') {
    return input.verify === null ? [] : input.verify.evidenceRequirements.map((row) => row.requirementId);
  }
  if (binding === 'DELIVERY_POLICY_V1') {
    return input.delivery === null ? [] : input.delivery.evidenceRequirements.map((row) => row.requirementId);
  }
  if (binding === 'QA_POLICY_BY_SCENARIO_V1') {
    return sortedUnique([
      ...input.template.baseEvidenceRequirementIds,
      ...(input.policies.qa?.checks.flatMap((check) => check.evidenceRequirementIds) ?? []),
    ]);
  }
  if (binding === 'CANARY_POLICY_BY_SCENARIO_V1') {
    return sortedUnique([
      ...input.template.baseEvidenceRequirementIds,
      ...(input.policies.canary?.signals.flatMap((signal) => [
        signal.measurementRequirementId,
        ...signal.sourceEvidenceRequirementIds,
      ]) ?? []),
    ]);
  }
  return [...input.template.baseEvidenceRequirementIds];
}

function validateHumanGateAuthority(input: StageTerminalCompileInputV1): void {
  const actual = input.humanGates.map((gate) => gate.gateId);
  if (hashStrictObject(actual) !== hashStrictObject(input.template.humanGateIds)) {
    throw new TypeError('STATIC_INPUT_INVALID: Human gates do not exactly close the capability template');
  }
  if (input.delivery !== null
    && hashStrictObject(input.delivery.requiredHumanGates) !== hashStrictObject(input.humanGates)) {
    throw new TypeError('STATIC_INPUT_INVALID: Delivery Human gates disagree with the template projection');
  }
}

function validateAuthoredOutputAuthority(input: StageTerminalCompileInputV1): void {
  const templates = input.template.authoredOutputs;
  if (templates.length === 0) {
    if (input.outputBindings.length !== 0) {
      throw new TypeError('STATIC_INPUT_INVALID: capability template authorizes no Run output');
    }
    return;
  }
  if (templates.length !== 1) {
    throw new TypeError('STATIC_INPUT_INVALID: capability template authored output projection is not singular');
  }
  const template = templates[0]!;
  if (template.kind === 'ARTIFACT_AUTHORITY_SET') {
    if (input.outputBindings.length === 0
      || input.outputBindings.some((binding) => binding.kind !== 'AUTHORED_FILE' && binding.kind !== 'AUTHORED_DIRECTORY')) {
      throw new TypeError('STATIC_INPUT_INVALID: artifact authority set must expand to authored file/directory bindings');
    }
    if (input.template.terminalKind === 'ISSUE_STAGE' && input.outputBindings.length !== 1) {
      throw new TypeError('STATIC_INPUT_INVALID: Issue artifact authority set must contain exactly its issue narrative binding');
    }
    return;
  }
  const binding = input.outputBindings[0];
  if (input.outputBindings.length !== 1 || binding === undefined || binding.kind !== template.kind
    || binding.role !== template.role) {
    throw new TypeError('STATIC_INPUT_INVALID: Run output does not exactly project the capability template');
  }
  if ('pathTemplate' in template
    && (!('path' in binding) || binding.path !== template.pathTemplate.replace('<RunId>', input.identity.runId))) {
    throw new TypeError('STATIC_INPUT_INVALID: Run output path does not instantiate the capability template');
  }
  if ('schemaIdentity' in template
    && (!('schemaIdentity' in binding) || binding.schemaIdentity !== template.schemaIdentity)) {
    throw new TypeError('STATIC_INPUT_INVALID: Run output schema identity does not match the capability template');
  }
  if (template.kind === 'REPOSITORY_DIFF') {
    const expectedTaskId = template.taskIdFormula === 'SELECTED_TASK' ? input.selection.taskId : null;
    if (binding.kind !== 'REPOSITORY_DIFF' || binding.taskId !== expectedTaskId) {
      throw new TypeError('STATIC_INPUT_INVALID: repository diff Task projection does not match the capability template');
    }
  }
}

function deriveReleaseSubjectBinding(ship: CompletedShipAuthorityV1) {
  const subject = {
    schemaVersion: 1,
    kind: 'DELIVERY_STAGE_COMPLETION',
    changeId: ship.changeId,
    revision: ship.revision,
    shipRunId: ship.shipRunId,
    shipCompletion: {
      sequence: ship.completionSequence,
      ownerKind: 'STAGE_COMPLETE',
      ownerId: ship.shipRunId,
      entryHash: ship.completionEntryHash,
      completedAt: ship.completedAt,
    },
    artifactIdentity: ship.artifactIdentity,
    artifactIdentityHash: ship.artifactIdentityHash,
  } as const;
  return { subject, subjectHash: hashStrictObject(subject) } as const;
}

function parseTerminal(value: unknown): RunTerminalContract {
  // 背景：persistent schema 的新输出合同是 null-prototype authenticated graph；但
  // Task4 compiler 的既有公开返回合同是普通 JSON presentation object。目的：先让 final
  // schema 完整验证 descriptor clone，再用 compiler 自有 defineProperty materializer 产生
  // 返回值；不以 JSON.parse/普通赋值恢复原型，也不把 caller raw graph 交回 Zod。
  return cloneStrictJson(runTerminalContractSchema.parse(cloneStrictJson(value)));
}

function requireOnlyOutput(bindings: readonly RunOutputBinding[], kind: RunOutputBinding['kind'], runId: string): void {
  if (bindings.length !== 1 || bindings[0]?.kind !== kind
    || ('path' in bindings[0] && bindings[0].path.startsWith('stage-outputs/')
      && !bindings[0].path.startsWith(`stage-outputs/${runId}/`))) {
    throw new TypeError(`STATIC_INPUT_INVALID: expected exactly one ${kind} output for ${runId}`);
  }
}

function requireOutputKinds(bindings: readonly RunOutputBinding[], allowed: readonly RunOutputBinding['kind'][]): string[] {
  if (bindings.some((binding) => !allowed.includes(binding.kind))) {
    throw new TypeError('STATIC_INPUT_INVALID: authored output kind does not match terminal template');
  }
  return sortedUnique(bindings.map((binding) => binding.role));
}

function requireRepositoryDiff(
  bindings: readonly RunOutputBinding[],
  role: 'IMPLEMENTATION_DIFF' | 'SIMPLIFICATION_DIFF',
  taskId: string | null,
  basis: unknown,
): void {
  const binding = bindings[0];
  if (bindings.length !== 1 || binding?.kind !== 'REPOSITORY_DIFF' || binding.role !== role
    || binding.taskId !== taskId || hashStrictObject(binding.basis) !== hashStrictObject(basis)) {
    throw new TypeError('STATIC_INPUT_INVALID: repository diff output does not bind the compiled root basis');
  }
}
