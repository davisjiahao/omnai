import { z } from 'zod';
import { SCENARIO_IDS, type ScenarioId } from '../../domain/public.js';
import { qaPolicySchema as runQaPolicySchema, type QaPolicySnapshot } from '../../domain/run.js';
import { qaPolicySchema } from '../catalog-schema.js';
import {
  cloneStrictJson,
  parseCompilerInput,
  requireCodeUnitOrder,
  requireSingleRow,
} from '../compiler-runtime.js';

const rowSchema = z.strictObject({ scenarioId: z.enum(SCENARIO_IDS), policy: qaPolicySchema });
const inputSchema = z.strictObject({
  scenarioId: z.enum(SCENARIO_IDS),
  policies: z.array(rowSchema).length(3),
});

export interface QaPolicyByScenarioCompileInputV1 {
  readonly scenarioId: ScenarioId;
  readonly policies: readonly z.output<typeof rowSchema>[];
}

// 背景：只有三个 Scenario 拥有 QA policy；以空 policy 或 caller 默认兜底会让 Flow route 绕过目录权限。
// 目的：验证完整 rows 顺序后只选择唯一 exact row，缺失/重复均 fail-closed。
// 上下文：函数不会推导 checks；checks 已由 StageAuthorityCatalogV1 严格认证。
export function compileQaPolicyByScenario(value: unknown): QaPolicySnapshot {
  const input = parseCompilerInput(inputSchema, value);
  requireCodeUnitOrder(input.policies.map((row) => row.scenarioId), 'QA policy rows');
  const row = requireSingleRow(input.policies, (candidate) => candidate.scenarioId === input.scenarioId, `QA policy for '${input.scenarioId}'`);
  return runQaPolicySchema.parse(cloneStrictJson(row.policy));
}
