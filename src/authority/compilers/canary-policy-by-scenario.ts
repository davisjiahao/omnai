import { z } from 'zod';
import {
  SCENARIO_IDS,
  persistedTimestampSchema,
  type ScenarioId,
} from '../../domain/public.js';
import {
  completedShipAuthoritySchema,
  type CompletedShipAuthorityV1,
} from '../../domain/change.js';
import { canaryPolicySchema as runCanaryPolicySchema, type CanaryPolicySnapshot } from '../../domain/run.js';
import { canaryPolicySchema } from '../catalog-schema.js';
import {
  cloneStrictJson,
  parseCompilerInput,
  requireCodeUnitOrder,
  requireSingleRow,
} from '../compiler-runtime.js';
import type { Timestamp } from '../../domain/scalars.js';

const rowSchema = z.strictObject({ scenarioId: z.enum(SCENARIO_IDS), policy: canaryPolicySchema });
const inputSchema = z.strictObject({
  scenarioId: z.enum(SCENARIO_IDS),
  policies: z.array(rowSchema).length(5),
  ship: completedShipAuthoritySchema,
  coreTime: persistedTimestampSchema,
}).superRefine((input, context) => {
  if (input.ship.completedAt > input.coreTime) {
    context.addIssue({ code: 'custom', path: ['coreTime'], message: 'PRECONDITION_UNSATISFIED: Canary window cannot open before ship completion' });
  }
});

export interface CanaryPolicyByScenarioCompileInputV1 {
  readonly scenarioId: ScenarioId;
  readonly policies: readonly z.output<typeof rowSchema>[];
  readonly ship: CompletedShipAuthorityV1;
  readonly coreTime: Timestamp;
}

export interface CanaryPolicyByScenarioCompileResultV1 {
  readonly policy: CanaryPolicySnapshot;
  readonly windowOpenedAt: Timestamp;
}

// 背景：Canary 不是单纯按 Scenario 取常量；同 Revision Delivery completion 是开启观测窗口的硬前置。
// 目的：在任何 Run/time 写入前验证完整五行目录、唯一 policy 与 ship 时间边界。
// 上下文：Core time 是显式输入，不在函数内读取 Date，因此同一输入跨进程得到相同结果。
export function compileCanaryPolicyByScenario(
  value: unknown,
): CanaryPolicyByScenarioCompileResultV1 {
  const input = parseCompilerInput(inputSchema, value);
  requireCodeUnitOrder(input.policies.map((row) => row.scenarioId), 'Canary policy rows');
  const row = requireSingleRow(input.policies, (candidate) => candidate.scenarioId === input.scenarioId, `Canary policy for '${input.scenarioId}'`);
  return cloneStrictJson({
    policy: runCanaryPolicySchema.parse(row.policy),
    windowOpenedAt: input.coreTime,
  });
}
