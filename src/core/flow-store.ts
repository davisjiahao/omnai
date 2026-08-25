import type { DecisionRecord, FlowPlan } from '../domain/types.js';
import { assertNativeWorkflowSupported, type NativeWorkflowMode } from './native-workflow-gate.js';
import type { ChangeRef } from './store.js';

// 背景：Plan 02 尚未提供 ChangeAuthorityContext，旧 facade 接收的 ChangeRef 只是 caller 可变对象。
// 目的：门禁先只读认证 workflow marker，随后无条件关闭未 sealed 的 Flow reader/writer；不能为了让
// 旧调用继续运行而回退到 raw flow store。上下文：Plan 04 会在相同 facade 后接 canonical ChangeId
// resolver 和 sealed context；pure Flow compiler 与存储原语只留在非包根的 internal 模块供测试接入。
export async function loadFlowPlan(repoRoot: string, _change: ChangeRef): Promise<FlowPlan> {
  return rejectUnsealedFlowContext(repoRoot, 'READ_ONLY');
}

export async function createInitialFlowPlan(repoRoot: string, _change: ChangeRef): Promise<FlowPlan> {
  return rejectUnsealedFlowContext(repoRoot, 'MUTATION');
}

export async function synchronizeFlowDecisions(
  repoRoot: string,
  _change: ChangeRef,
  _decisions: readonly DecisionRecord[],
): Promise<FlowPlan> {
  return rejectUnsealedFlowContext(repoRoot, 'MUTATION');
}

export async function rebindFlowPlanForRevision(
  repoRoot: string,
  _change: ChangeRef,
  _decisions: readonly DecisionRecord[],
): Promise<FlowPlan> {
  return rejectUnsealedFlowContext(repoRoot, 'MUTATION');
}

async function rejectUnsealedFlowContext(
  repoRoot: string,
  mode: NativeWorkflowMode,
): Promise<never> {
  await assertNativeWorkflowSupported(repoRoot, mode);
  throw new Error('NATIVE_CONTEXT_UNAVAILABLE: Flow access requires a sealed Change authority context');
}
