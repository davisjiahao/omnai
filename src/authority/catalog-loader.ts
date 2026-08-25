import {
  hashStrictObject,
  stageAuthorityCatalogV1Schema,
  type StageAuthorityCatalogV1,
} from './catalog-schema.js';

export interface AuthorityCatalogTestLease {
  readonly catalog: StageAuthorityCatalogV1;
  readonly generation: number;
}

interface InjectedCatalogState {
  readonly catalog: StageAuthorityCatalogV1;
  readonly catalogHash: string;
  readonly activeGenerations: Set<number>;
}

let injectedCatalogStateForTest: InjectedCatalogState | undefined;
let nextTestGeneration = 1;
const registeredTestLeases = new WeakMap<AuthorityCatalogTestLease, number>();

// 背景：Task 9H 发布 packaged catalog 之前，生产代码没有可以信任的 WorkflowLock/hash 绑定资源。
// 目的：保持生产路径 fail-closed；只有名字明确标注 ForTest 的注入边界能够安装已通过 strict parser
// 的对象，并用 generation lease 隔离并发测试的生命周期。上下文：同一对象可以并发租用，不同对象
// 在已有租约时拒绝覆盖；该模块不会读取 src/authority/test/fixtures，也不会从 package root 转出注入函数。
export async function requireVerifiedAuthorityCatalog(): Promise<StageAuthorityCatalogV1> {
  if (injectedCatalogStateForTest === undefined) {
    throw new Error('AUTHORITY_CATALOG_UNAVAILABLE: final packaged authority catalog has not been published');
  }
  return injectedCatalogStateForTest.catalog;
}

export async function loadInjectedAuthorityCatalogForTest(value: unknown): Promise<AuthorityCatalogTestLease> {
  const parsed = stageAuthorityCatalogV1Schema.parse(value);
  const catalogHash = hashStrictObject(parsed);
  if (injectedCatalogStateForTest !== undefined && injectedCatalogStateForTest.catalogHash !== catalogHash) {
    throw new Error('AUTHORITY_CATALOG_TEST_CONFLICT: a different test catalog lease is already active');
  }
  if (injectedCatalogStateForTest === undefined) {
    injectedCatalogStateForTest = {
      catalog: deepFreeze(parsed),
      catalogHash,
      activeGenerations: new Set<number>(),
    };
  }
  const generation = nextTestGeneration;
  nextTestGeneration += 1;
  injectedCatalogStateForTest.activeGenerations.add(generation);
  const lease = Object.freeze({ catalog: injectedCatalogStateForTest.catalog, generation });
  registeredTestLeases.set(lease, generation);
  return lease;
}

export function clearInjectedAuthorityCatalogForTest(lease: AuthorityCatalogTestLease): void {
  const generation = registeredTestLeases.get(lease);
  if (generation === undefined || injectedCatalogStateForTest === undefined) return;
  injectedCatalogStateForTest.activeGenerations.delete(generation);
  if (injectedCatalogStateForTest.activeGenerations.size === 0) injectedCatalogStateForTest = undefined;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  return Object.freeze(value);
}
