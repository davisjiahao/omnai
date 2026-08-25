import { z } from 'zod';
import { scenarioProfileSchema, type StrictScenarioProfile } from '../../domain/change.js';
import { SCENARIO_IDS, nonnegativeSafeIntegerSchema } from '../../domain/public.js';
import {
  compareCodeUnits,
  scenarioDetectionPolicySchema,
  type ScenarioDetectionPolicyV1,
} from '../catalog-schema.js';
import {
  assertStrictUtf8Text,
  cloneStrictJson,
  parseCompilerInput,
  requireSingleRow,
} from '../compiler-runtime.js';

const inputSchema = z.strictObject({
  query: z.string(),
  profiles: z.array(scenarioProfileSchema).length(19),
  policy: scenarioDetectionPolicySchema,
}).superRefine((input, context) => {
  const ids = input.profiles.map((profile) => profile.id);
  const sortedIds = [...ids].sort(compareCodeUnits);
  if (new Set(ids).size !== SCENARIO_IDS.length
    || SCENARIO_IDS.some((id) => !ids.includes(id))
    || ids.some((id, index) => id !== sortedIds[index])) {
    context.addIssue({ code: 'custom', path: ['profiles'], message: 'STATIC_INPUT_INVALID: Scenario profile identity/order is incomplete' });
  }
  const priorities = input.profiles.map((profile) => profile.detectionPriority).sort((left, right) => left - right);
  if (priorities.some((priority, index) => priority !== index)) {
    context.addIssue({ code: 'custom', path: ['profiles'], message: 'STATIC_INPUT_INVALID: detection priorities must cover 0..18' });
  }
});

const scoreSchema = z.strictObject({
  scenarioId: z.enum(SCENARIO_IDS),
  score: nonnegativeSafeIntegerSchema,
});
const resultSchema = z.strictObject({
  scenarioId: z.enum(SCENARIO_IDS),
  scores: z.array(scoreSchema).length(19),
});

export interface ScenarioDetectionCompileInputV1 {
  readonly query: string;
  readonly profiles: readonly StrictScenarioProfile[];
  readonly policy: ScenarioDetectionPolicyV1;
}

export type ScenarioDetectionCompileResultV1 = z.output<typeof resultSchema>;

// 背景：旧 detector 与 catalog 分别维护 scoring，架构关键词可以覆盖更具体的 SDK/跨服务边界。
// 目的：严格执行 catalog 锁定的 UTF-16 signal 计分、priority tie-break、唯一 override 与 fallback。
// 上下文：函数不读取已安装目录；调用方必须传入已经认证且冻结的完整 profile/policy 值。
export function compileScenarioDetection(value: unknown): ScenarioDetectionCompileResultV1 {
  const input = parseCompilerInput(inputSchema, value);
  assertStrictUtf8Text(input.query, { allowLineFeed: true, requireNonWhitespace: true });
  const normalized = input.query.toLowerCase();
  const scores = input.profiles.map((profile) => ({
    scenarioId: profile.id,
    score: profile.signals.reduce((total, signal) => (
      total + (normalized.includes(signal.toLowerCase()) ? signal.length : 0)
    ), 0),
  })).sort((left, right) => (
    right.score - left.score
      || requireSingleRow(input.profiles, (profile) => profile.id === left.scenarioId, left.scenarioId).detectionPriority
        - requireSingleRow(input.profiles, (profile) => profile.id === right.scenarioId, right.scenarioId).detectionPriority
  ));
  const best = scores[0]!;
  let scenarioId = best.score > 0 ? best.scenarioId : input.policy.fallbackScenarioId;
  const override = input.policy.overrides[0];
  if (override !== undefined && best.scenarioId === override.whenBestScenarioId) {
    const specialized = scores.find((row) => (
      row.score > 0 && override.candidates.some((candidate) => candidate === row.scenarioId)
    ));
    if (specialized !== undefined) scenarioId = specialized.scenarioId;
  }
  requireSingleRow(input.profiles, (profile) => profile.id === scenarioId, `Scenario '${scenarioId}'`);
  return resultSchema.parse(cloneStrictJson({ scenarioId, scores }));
}
