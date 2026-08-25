import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import YAML from 'yaml';
import {
  clearInjectedAuthorityCatalogForTest,
  loadInjectedAuthorityCatalogForTest,
} from '../src/authority/catalog-loader.js';
import { detectScenario, getScenario, listScenarios } from '../src/core/scenarios.js';
import { outputContract } from '../src/core/stages.js';

const CANONICAL_SCENARIOS = [
  'system-query',
  'field-lineage',
  'business-flow',
  'bug-fix',
  'small-feature',
  'complex-domain-feature',
  'cross-service-change',
  'migration-program',
  'data-migration',
  'architecture-governance',
  'performance-investigation',
  'product-discovery',
  'ui-ux-feature',
  'quality-hardening',
  'shared-library',
  'emergency-hotfix',
  'incident-response',
  'release-failure',
  'technical-experiment',
] as const;
const EXACT_ROUTE_ORDER: Record<(typeof CANONICAL_SCENARIOS)[number], readonly string[]> = {
  'system-query': ['research', 'learn'],
  'field-lineage': ['research', 'learn'],
  'business-flow': ['research', 'model', 'learn'],
  'bug-fix': ['research', 'triage', 'reproduce', 'debug', 'experiment', 'fix', 'design', 'reconcile', 'plan', 'work', 'simplify', 'verify', 'review', 'learn'],
  'small-feature': ['research', 'spec', 'design', 'plan', 'work', 'simplify', 'review', 'verify', 'learn', 'archive'],
  'complex-domain-feature': ['frame', 'research', 'model', 'spec', 'design', 'reconcile', 'plan', 'work', 'simplify', 'review', 'verify', 'learn', 'archive'],
  'cross-service-change': ['map', 'research', 'model', 'spec', 'design', 'reconcile', 'plan', 'work', 'simplify', 'review', 'verify', 'ship', 'canary', 'learn', 'archive'],
  'migration-program': ['frame', 'map', 'research', 'model', 'spec', 'design', 'reconcile', 'plan', 'work', 'simplify', 'review', 'verify', 'ship', 'canary', 'learn', 'archive'],
  'data-migration': ['map', 'research', 'model', 'spec', 'design', 'review', 'reconcile', 'plan', 'work', 'simplify', 'verify', 'ship', 'canary', 'learn', 'archive'],
  'architecture-governance': ['map', 'research', 'model', 'spec', 'design', 'review', 'reconcile', 'plan', 'work', 'simplify', 'verify', 'learn', 'archive'],
  'performance-investigation': ['research', 'diagnose', 'design', 'experiment', 'reconcile', 'plan', 'work', 'simplify', 'review', 'verify', 'ship', 'learn'],
  'product-discovery': ['frame', 'research', 'model', 'spec', 'design', 'reconcile', 'plan', 'work', 'simplify', 'qa', 'review', 'verify', 'ship', 'canary', 'learn'],
  'ui-ux-feature': ['frame', 'research', 'spec', 'design', 'plan', 'work', 'simplify', 'qa', 'review', 'verify', 'ship', 'canary', 'learn', 'archive'],
  'quality-hardening': ['research', 'reconcile', 'plan', 'work', 'simplify', 'qa', 'review', 'verify', 'learn'],
  'shared-library': ['research', 'model', 'spec', 'design', 'review', 'reconcile', 'plan', 'work', 'simplify', 'verify', 'ship', 'learn', 'archive'],
  'emergency-hotfix': ['research', 'triage', 'reproduce', 'debug', 'experiment', 'fix', 'reconcile', 'plan', 'work', 'simplify', 'verify', 'review', 'ship', 'learn'],
  'incident-response': ['mitigate', 'research', 'debug', 'fix', 'reconcile', 'plan', 'work', 'simplify', 'verify', 'review', 'ship', 'learn'],
  'release-failure': ['mitigate', 'research', 'debug', 'fix', 'reconcile', 'plan', 'work', 'simplify', 'verify', 'review', 'ship', 'learn'],
  'technical-experiment': ['research', 'design', 'experiment', 'reconcile', 'plan', 'work', 'simplify', 'review', 'verify', 'learn'],
};

let catalogLease: Awaited<ReturnType<typeof loadInjectedAuthorityCatalogForTest>>;

before(async () => {
  const text = await readFile(join(process.cwd(), 'src', 'authority', 'test', 'fixtures', 'stage-authority-catalog-v1.yaml'), 'utf8');
  catalogLease = await loadInjectedAuthorityCatalogForTest(YAML.parse(text));
});

after(() => clearInjectedAuthorityCatalogForTest(catalogLease));

test('ships the canonical 19-scenario catalog', async () => {
  const scenarios = await listScenarios();
  assert.equal(scenarios.length, CANONICAL_SCENARIOS.length);
  assert.deepEqual(
    scenarios.map((scenario) => scenario.id),
    [...CANONICAL_SCENARIOS].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
  );
  assert.deepEqual(
    [...scenarios].sort((left, right) => left.detectionPriority - right.detectionPriority).map((scenario) => scenario.id),
    CANONICAL_SCENARIOS,
  );
});

test('locks the three plan-before-work repairs and final optional simplify reachability', async () => {
  for (const [id, routeOrder] of Object.entries(EXACT_ROUTE_ORDER)) {
    assert.deepEqual((await getScenario(id)).routeOrder, routeOrder, id);
  }
  for (const id of ['emergency-hotfix', 'incident-response', 'release-failure']) {
    const scenario = await getScenario(id);
    assert.equal(scenario.stages.includes('plan'), true, id);
    assert.equal(scenario.routeOrder.indexOf('plan') + 1, scenario.routeOrder.indexOf('work'), id);
  }
  for (const scenario of await listScenarios()) {
    const canWork = [...scenario.stages, ...scenario.optionalStages].includes('work');
    assert.equal(scenario.optionalStages.includes('simplify'), canWork, scenario.id);
    assert.equal(scenario.routeOrder.includes('release' as never), false, scenario.id);
  }
});

test('detects specialized scenarios and defaults to a small feature', async () => {
  assert.equal((await detectScenario('where does premiumAmount come from and where is this field written')).id, 'field-lineage');
  assert.equal((await detectScenario('explain the full policy purchase business flow from API to database')).id, 'business-flow');
  assert.equal((await detectScenario('production outage with customer impact')).id, 'incident-response');
  assert.equal((await detectScenario('move historical rows with dual write and backfill')).id, 'data-migration');
  assert.equal((await detectScenario('compare queue versus polling with a measured spike')).id, 'technical-experiment');
  assert.equal((await detectScenario('improve p95 latency and investigate CPU')).id, 'performance-investigation');
  assert.equal((await detectScenario('add a clear endpoint')).id, 'small-feature');
});

test('routes precise internal architecture signals without stealing specialized boundary work', async () => {
  for (const signal of [
    'architecture review',
    'bounded context',
    'dependency direction',
    'dependency cycle',
    'layering violation',
  ]) {
    assert.equal((await detectScenario(`review the ${signal} inside this monolith`)).id, 'architecture-governance', signal);
  }

  assert.equal(
    (await detectScenario('implement a cross service contract while correcting dependency direction')).id,
    'cross-service-change',
  );
  assert.equal(
    (await detectScenario('perform an architecture review before publishing the public SDK API')).id,
    'shared-library',
  );
});

// 背景：同步 outputContract 曾复制一份 stage policy 文本；final native authority 只允许从已验证
// catalog/protocol bundle 读取。目的：Plan 05/07 接入认证 context 前，保留 facade 必须明确 fail-closed，
// 不能让旧 success expectation 迫使实现恢复第二份 policy reader。上下文：Scenario projection 本身
// 已由上方 injected catalog 正例覆盖，这里只认证未接线的公开 raw stage surface。
test('未认证 outputContract 对全部旧同步 capability 查询 fail-closed', () => {
  for (const capability of ['research', 'spec', 'design', 'plan', 'work', 'review', 'verify', 'reconcile'] as const) {
    assert.throws(
      () => outputContract(capability),
      /AUTHORITY_CATALOG_UNAVAILABLE/,
      capability,
    );
  }
});

// 背景：design obligations 归属 verified authority bundle，而非 src/core/stages.ts 内嵌字符串。
// 目的：锁定 catalog 未认证时不泄露或制造 design contract；最终内容的逐字段 oracle 留在 catalog
// 与 prompt compiler 测试。上下文：这是对已删除 legacy success expectation 的 clean-break 迁移。
test('design output contract 在 verified authority bundle 缺失时不制造文本', () => {
  assert.throws(() => outputContract('design'), /AUTHORITY_CATALOG_UNAVAILABLE/);
});

test('rejects legacy scenario aliases instead of translating identity', async () => {
  for (const legacy of [
    'read-only-query', 'production-incident', 'domain-feature', 'architecture-evolution',
    'frontend-feature', 'new-product', 'sdk-library',
  ]) {
    await assert.rejects(() => getScenario(legacy), /Unknown scenario/);
  }
});

test('exposes P0-P3 risk, gates and evidence for every scenario', async () => {
  for (const scenario of await listScenarios()) {
    assert.ok(scenario.stages.length > 0, scenario.id);
    assert.ok(scenario.gates.length > 0, scenario.id);
    assert.ok(scenario.requiredEvidence.length > 0, scenario.id);
    assert.match(scenario.risk, /^P[0-3]$/);
    assert.equal((await getScenario(scenario.id)).id, scenario.id);
  }
});
