import { requireVerifiedAuthorityCatalog } from '../authority/catalog-loader.js';
import { compileScenarioDetection } from '../authority/compilers/scenario-detection.js';
import type { ScenarioProfile } from '../domain/types.js';

// 背景：v0.2 在本模块维护第二份手写 Scenario seed，目录、detector 与协议随后可以独立漂移。
// 目的：所有读取都成为已验证 StageAuthorityCatalogV1 的异步纯投影；目录尚未通过测试注入或
// Task 9H packaged binding 时，加载器会 fail-closed。上下文：此处没有 sync fallback、别名表或
// 生产内嵌 seed，调用方必须显式传播异步权限加载边界。
export async function listScenarios(): Promise<readonly ScenarioProfile[]> {
  return (await requireVerifiedAuthorityCatalog()).scenarioProfiles;
}

export async function getScenario(id: string): Promise<ScenarioProfile> {
  const scenario = (await listScenarios()).find((candidate) => candidate.id === id);
  if (!scenario) throw new Error(`Unknown scenario '${id}'. Run 'omnai scenario list' to see available profiles.`);
  return scenario;
}

export async function detectScenario(input: string): Promise<ScenarioProfile> {
  const catalog = await requireVerifiedAuthorityCatalog();
  const detection = compileScenarioDetection({
    query: input,
    profiles: catalog.scenarioProfiles,
    policy: catalog.scenarioDetectionPolicy,
  });
  const scenario = catalog.scenarioProfiles.find((candidate) => candidate.id === detection.scenarioId);
  if (scenario === undefined) throw new Error(`AUTHORITY_CATALOG_MISMATCH: detector selected unknown Scenario '${detection.scenarioId}'`);
  return scenario;
}
