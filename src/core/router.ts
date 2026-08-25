import type { FlowPlan, Sha256 } from '../domain/types.js';
import type { ProtocolId } from '../protocols/index.js';
import { assertNativeWorkflowSupported } from './native-workflow-gate.js';
import type { NextAction } from './readiness.js';
import type { ChangeRef } from './store.js';

export interface RepositoryRoute extends NextAction {
  taskId?: string;
  protocolIds: ProtocolId[];
  decisionIds: string[];
  revision: string;
  baseline: string;
  flowHash: Sha256;
}

export interface RepositoryFlowSnapshot {
  flow: FlowPlan;
  route: RepositoryRoute;
}

// 背景：旧 router 在 raw ChangeRef 上先加锁，再分别读取 metadata、Flow、Decision 与 Task，无法
// 证明这些对象来自同一个已认证 authority head。目的：在 Plan 02 sealed context 到位前，公开 route
// facade 只执行零写 native gate，随后 fail-closed；不得回退到 ChangeRef 或旧 store 拼接 snapshot。
// 上下文：纯路由选择会在 Plan 02 通过非导出的 sealed-context injection 接回，本任务不提前伪造它。
export async function resolveRepositoryRoute(
  repoRoot: string,
  change: ChangeRef,
): Promise<RepositoryRoute> {
  return (await resolveRepositoryFlowSnapshot(repoRoot, change)).route;
}

export async function resolveRepositoryFlowSnapshot(
  repoRoot: string,
  _change: ChangeRef,
): Promise<RepositoryFlowSnapshot> {
  await assertNativeWorkflowSupported(repoRoot, 'READ_ONLY');
  throw new Error('NATIVE_CONTEXT_UNAVAILABLE: route access requires a sealed Change authority context');
}
