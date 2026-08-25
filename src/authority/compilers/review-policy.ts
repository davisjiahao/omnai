import { z } from 'zod';
import {
  impactModelSchema,
  riskModelSchema,
  scenarioProfileSchema,
  type StrictImpactModel,
  type StrictRiskModel,
  type StrictScenarioProfile,
} from '../../domain/change.js';
import { reviewPolicySchema, type ReviewPolicySnapshot } from '../../domain/run.js';
import { cloneStrictJson, parseCompilerInput, sortedUnique } from '../compiler-runtime.js';

const inputSchema = z.strictObject({
  scenario: scenarioProfileSchema,
  risk: riskModelSchema,
  impact: impactModelSchema,
});

export interface ReviewPolicyCompileInputV1 {
  readonly scenario: StrictScenarioProfile;
  readonly risk: StrictRiskModel;
  readonly impact: StrictImpactModel;
}

// 背景：Review check list 是 catalog-owned 派生权限，不能由 caller 传入，也不能只保存 policy hash。
// 目的：按锁定 workMode、Scenario route、risk dimensions 与 impact 布尔量穷举三个轴，并返回完整快照。
// 上下文：数组使用 code-unit 排序和去重；每个新增/删除条件都会改变黄金对象与 hash。
export function compileReviewPolicy(value: unknown): ReviewPolicySnapshot {
  const { scenario, risk, impact } = parseCompilerInput(inputSchema, value);
  const specification = sortedUnique(['requirements', 'non-goals', 'observable-behavior']);
  const standards = ['engineering'];
  if (scenario.workMode !== 'READ_ONLY_QUERY') standards.push('business');
  if (['FEATURE', 'PRODUCT_DISCOVERY', 'MIGRATION', 'ARCHITECTURE_CHANGE'].includes(scenario.workMode)) {
    standards.push('domain');
  }
  if (scenario.workMode === 'ARCHITECTURE_CHANGE'
    || impact.backend || impact.apiContract || impact.database || impact.mq || impact.remoteService) {
    standards.push('architecture');
  }
  if (impact.apiContract || impact.remoteService) standards.push('contract');
  if (impact.database || ['HIGH', 'CRITICAL'].includes(risk.dimensions.data)) standards.push('data');
  if (impact.security || ['HIGH', 'CRITICAL'].includes(risk.dimensions.security)) standards.push('security');
  if (scenario.workMode === 'PERFORMANCE' || ['HIGH', 'CRITICAL'].includes(risk.dimensions.operational)) {
    standards.push('performance');
  }
  if (impact.frontend) standards.push('ux');

  const riskProduction: string[] = [];
  if (scenario.workMode === 'MIGRATION' || impact.database) riskProduction.push('migration');
  if (impact.backend || impact.mq || impact.remoteService || impact.observability
    || ['HIGH', 'CRITICAL'].includes(risk.dimensions.operational)) riskProduction.push('operability');
  if (['P0', 'P1'].includes(risk.level) || ['HIGH', 'CRITICAL'].includes(risk.dimensions.reversibility)) {
    riskProduction.push('rollback-forward-fix');
  }
  const route = [...scenario.stages, ...scenario.optionalStages];
  if (impact.observability || route.includes('ship') || route.includes('canary')) riskProduction.push('runtime-health');
  if (route.includes('ship') || route.includes('canary')) riskProduction.push('delivery-risk');

  return reviewPolicySchema.parse(cloneStrictJson({
    schemaVersion: 1,
    specification,
    standards: sortedUnique(standards),
    riskProduction: sortedUnique(riskProduction),
  }));
}
