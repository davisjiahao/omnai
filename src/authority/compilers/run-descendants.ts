import { z } from 'zod';
import { hashStrictObject } from '../catalog-schema.js';
import {
  evidenceRequirementSchema,
  humanGateContractSchema,
  runDescendantContractSchema,
  runTerminalContractSchema,
  type EvidenceRequirementContract,
  type HumanGateContract,
  type RunDescendantContract,
  type RunTerminalContract,
} from '../../domain/run.js';
import { persistedRunIdSchema } from '../../domain/public.js';
import {
  cloneStrictJson,
  parseCompilerInput,
  validateAndIndexVerifyTaskRequirementClosure,
} from '../compiler-runtime.js';
import type { RunId, TaskId } from '../../domain/scalars.js';

const inputSchema = z.strictObject({
  runId: persistedRunIdSchema,
  terminal: runTerminalContractSchema,
  evidenceRequirements: z.array(evidenceRequirementSchema),
  humanGates: z.array(humanGateContractSchema),
}).superRefine((input, context) => {
  const terminalEvidence = 'evidenceRequirements' in input.terminal ? input.terminal.evidenceRequirements : [];
  const terminalGates = 'requiredHumanGates' in input.terminal ? input.terminal.requiredHumanGates : [];
  if (hashStrictObject(terminalEvidence) !== hashStrictObject(input.evidenceRequirements)) {
    context.addIssue({ code: 'custom', path: ['evidenceRequirements'], message: 'STATIC_INPUT_INVALID: terminal Evidence projection mismatch' });
  }
  if (hashStrictObject(terminalGates) !== hashStrictObject(input.humanGates)) {
    context.addIssue({ code: 'custom', path: ['humanGates'], message: 'STATIC_INPUT_INVALID: terminal HumanGate projection mismatch' });
  }
});

const OWNER_BY_PRODUCER = {
  GENERIC_IMPORT: 'EVIDENCE_GENERIC',
  VERIFICATION_COMMAND: 'VERIFICATION_COMMAND',
  REVIEW_RESULT_IMPORT: 'EVIDENCE_REVIEW_IMPORT',
  QA_RESULT_IMPORT: 'EVIDENCE_QA_IMPORT',
  CANARY_MEASUREMENT_IMPORT: 'EVIDENCE_CANARY_MEASUREMENT',
  CANARY_RESULT_IMPORT: 'EVIDENCE_CANARY_IMPORT',
} as const;

export interface RunDescendantsCompileInputV1 {
  readonly runId: RunId;
  readonly terminal: RunTerminalContract;
  readonly evidenceRequirements: readonly EvidenceRequirementContract[];
  readonly humanGates: readonly HumanGateContract[];
}

// 背景：Run suffix 只能容纳 compiler 明确列出的 owner/binding/count；一个通用“允许 Evidence”开口
// 会破坏 Work Task CAS 与 Issue-update-last。目的：把每个 Evidence scope 展开为 exact counted rows，
// 再附加唯一 WORK/ISSUE/Reconcile grammar。上下文：runId 只认证 invocation identity；descendant row
// 按规范不复制动态 RunId，实际 receipt 通过外层 Run binding 绑定。
export function compileRunDescendants(value: unknown): RunDescendantContract[] {
  const input = parseCompilerInput(inputSchema, value);
  const rows: RunDescendantContract[] = [];
  const taskIdsByRequirement = input.terminal.kind === 'VERIFY_STAGE'
    ? validateAndIndexVerifyTaskRequirementClosure(input.terminal, 'Run descendant compiler')
    : new Map<string, readonly TaskId[]>();
  for (const requirement of input.evidenceRequirements) {
    const taskIds = requirementTaskIds(requirement, input.terminal, taskIdsByRequirement);
    const count = 'minimumRecords' in requirement
      ? requirement.minimumRecords
      : requirement.minimumRecordsPerTask;
    for (const taskId of taskIds) {
      rows.push(runDescendantContractSchema.parse({
        kind: 'COUNTED',
        ownerKind: OWNER_BY_PRODUCER[requirement.producer],
        binding: { kind: 'EVIDENCE_REQUIREMENT', requirementId: requirement.requirementId, taskId },
        minimum: count,
        maximum: count,
      }));
    }
  }
  for (const gate of input.humanGates) {
    rows.push(runDescendantContractSchema.parse({
      kind: 'COUNTED', ownerKind: 'HUMAN_APPROVAL',
      binding: { kind: 'HUMAN_GATE', gateId: gate.gateId }, minimum: 1, maximum: 1,
    }));
  }
  if (input.terminal.kind === 'WORK_STAGE') {
    rows.push(runDescendantContractSchema.parse({
      kind: 'TASK_WORK_SEQUENCE', ownerKind: 'TASK_WORK',
      binding: { kind: 'TASK_ID', taskId: input.terminal.taskId },
      grammar: 'START (BLOCK START)* IMPLEMENTED', sourceStatus: 'READY', terminalStatus: 'IMPLEMENTED',
    }));
  }
  if (input.terminal.kind === 'ISSUE_STAGE') {
    rows.push(runDescendantContractSchema.parse({
      kind: 'ISSUE_FINALIZATION_SEQUENCE', ownerKind: 'ISSUE_UPDATE', binding: { kind: 'RUN_ONLY' },
      grammar: 'ALL_REQUIRED_EVIDENCE_PASS THEN ISSUE_UPDATE_LAST',
      actionKind: issueActionKind(input.terminal),
    }));
  }
  if (input.terminal.kind === 'RECONCILE_STAGE') {
    for (const ownerKind of input.terminal.allowedTopLevelOwners) {
      rows.push(runDescendantContractSchema.parse({
        kind: 'COUNTED', ownerKind, binding: { kind: 'RUN_ONLY' }, minimum: 0, maximum: 1,
      }));
    }
  }
  return cloneStrictJson(rows.sort((left, right) => compare(descendantKey(left), descendantKey(right))));
}

function requirementTaskIds(
  requirement: EvidenceRequirementContract,
  terminal: RunTerminalContract,
  taskIdsByRequirement: ReadonlyMap<string, readonly TaskId[]>,
): Array<TaskId | null> {
  if (requirement.taskScope.kind === 'NONE') return [null];
  if (requirement.taskScope.kind === 'SELECTED_TASK') {
    if (terminal.kind === 'WORK_STAGE') return [terminal.taskId];
    if (terminal.kind === 'REVIEW_STAGE' && terminal.reviewScope.kind === 'TASK') return [terminal.reviewScope.taskId];
    throw new TypeError('STATIC_INPUT_INVALID: SELECTED_TASK has no selected Work/Review Task');
  }
  if (terminal.kind !== 'VERIFY_STAGE') {
    throw new TypeError(`STATIC_INPUT_INVALID: ${requirement.taskScope.kind} is only legal on VERIFY_STAGE`);
  }
  if (requirement.taskScope.kind === 'EACH_VERIFICATION_TASK') return [...terminal.verificationTaskIds];
  return [...(taskIdsByRequirement.get(requirement.requirementId) ?? [])];
}

function issueActionKind(terminal: Extract<RunTerminalContract, { kind: 'ISSUE_STAGE' }>): 'TRIAGE_RESULT' | 'REPRODUCTION_RESULT' | 'DEBUG_RESULT' {
  if (terminal.requiredIssuePredicates.some((predicate) => predicate.kind === 'TRIAGE_STATE_IN')) return 'TRIAGE_RESULT';
  if (terminal.requiredIssuePredicates.some((predicate) => predicate.kind === 'REPRODUCTION_IN')) return 'REPRODUCTION_RESULT';
  if (terminal.requiredIssuePredicates.some((predicate) => predicate.kind === 'ROOT_CAUSE_IS')) return 'DEBUG_RESULT';
  throw new TypeError('STATIC_INPUT_INVALID: ISSUE_STAGE has no exact capability predicate oracle');
}

function descendantKey(row: RunDescendantContract): string {
  const binding = row.binding.kind === 'RUN_ONLY' ? 'RUN_ONLY'
    : row.binding.kind === 'TASK_ID' ? `TASK_ID\u0000${row.binding.taskId}`
      : row.binding.kind === 'HUMAN_GATE' ? `HUMAN_GATE\u0000${row.binding.gateId}`
        : `EVIDENCE_REQUIREMENT\u0000${row.binding.requirementId}\u0000${row.binding.taskId ?? ''}`;
  return `${row.ownerKind}\u0000${binding}`;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
