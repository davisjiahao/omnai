import { basename } from 'node:path';
import {
  stageRunManifestSchema,
  type Capability,
  type StageRunManifest,
} from '../domain/types.js';
import { hObject } from '../domain/public.js';
import { assertNativeWorkflowSupported } from './native-workflow-gate.js';
import type { ChangeRef } from './store.js';

type PreparedStageRunManifestV3 = Extract<StageRunManifest, { disposition: 'PREPARED' }>;

export interface PreparedStage {
  manifest: PreparedStageRunManifestV3;
  runDirectory: string;
  promptPath: string;
}

export interface PreparedRunIdentityV3 {
  readonly preparedFromAuthorityHead: PreparedStageRunManifestV3['authorityContract']['preparedFromAuthorityHead'];
  readonly prepareOwner: PreparedStageRunManifestV3['prepareOwner'];
  readonly authorityContractHash: PreparedStageRunManifestV3['authorityContractHash'];
}

// 背景：旧 stage facade 在 protocol、Flow、Decision、artifact 和 progress 上执行多次未认证 I/O，
// 还会直接拼装 schema v2 Run。目的：Plan 02/05 writer 接入之前，公开入口只允许先执行零写 native
// gate，然后明确关闭；raw ChangeRef、protocolRoot 或 caller manifest 均不能抵达任何读写。
// 上下文：Task4 exact compiler 仍可由内部测试直接调用，本文件不得建立第二份 Run compiler。
export async function prepareStage(
  repoRoot: string,
  _change: ChangeRef,
  _capability: Capability,
  _instruction: string,
): Promise<PreparedStage> {
  await assertNativeWorkflowSupported(repoRoot, 'MUTATION');
  throw new Error('NATIVE_CONTEXT_UNAVAILABLE: stage preparation requires a sealed Change authority context');
}

export async function completeStage(
  repoRoot: string,
  _change: ChangeRef,
  _capability: Capability,
): Promise<void> {
  await assertNativeWorkflowSupported(repoRoot, 'MUTATION');
  throw new Error('NATIVE_CONTEXT_UNAVAILABLE: stage completion requires a sealed Change authority context');
}

// 背景：prepare receipt 的 entryHash 只有在 target/outbox durable 后才能得出，若提前放入 manifest
// 会形成 payloadDigest/entryHash 自环。目的：纯 identity 只投影 predecessor、prepareOwner 与完整
// authorityContractHash，供后续 authority envelope 认证比较；不接受 caller 自报 own entryHash。
function preparedRunIdentityV3(manifest: StageRunManifest): PreparedRunIdentityV3 {
  const parsed = stageRunManifestSchema.parse(manifest);
  if (parsed.disposition !== 'PREPARED') {
    throw new Error('RUN_PREPARED_IDENTITY_REQUIRED');
  }
  return Object.freeze({
    preparedFromAuthorityHead: parsed.authorityContract.preparedFromAuthorityHead,
    prepareOwner: Object.freeze({
      ...parsed.prepareOwner,
      owner: Object.freeze({ ...parsed.prepareOwner.owner }),
    }),
    authorityContractHash: parsed.authorityContractHash,
  });
}

export function assertPreparedRunIdentityV3(
  manifest: StageRunManifest,
  accepted: PreparedRunIdentityV3,
): void {
  const current = preparedRunIdentityV3(manifest);
  if (hObject(current) !== hObject(accepted)) {
    throw new Error('RUN_ACCEPTED_IDENTITY_MISMATCH');
  }
}

export function shortRunSummary(prepared: PreparedStage): string {
  const outputPaths = prepared.manifest.authorityContract.authoredOutputBindings
    .flatMap((binding) => ('path' in binding ? [binding.path] : []));
  return [
    `Run: ${prepared.manifest.runId}`,
    `Capability: ${prepared.manifest.capability}`,
    `Prompt: ${prepared.manifest.prompt.path}`,
    `Outputs: ${outputPaths.map((path) => basename(path)).join(', ')}`,
  ].join('\n');
}

// 旧同步 helper 曾复制第二份 stage output/prompt authority。保留同名 fail-closed facade 只为在后续
// package-root 收口前提供明确错误；真实值必须来自 hash-verified catalog/protocol bundle。
export function outputContract(_capability: Capability): string {
  throw new Error('AUTHORITY_CATALOG_UNAVAILABLE: output contract requires the verified authority bundle');
}

export function stageOutputs(_capability: Capability): string[] {
  throw new Error('AUTHORITY_CATALOG_UNAVAILABLE: stage outputs require the verified authority catalog');
}
