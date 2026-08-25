import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { omnaiRoot, workflowLockPath } from './paths.js';

// 背景：发布候选安装尚未获认证，任何外部入口都不能把缺失或旧版状态当作可兼容工作流。
// 目的：以零写、fail-closed 的最小版本门拒绝不受支持的原生工作流。
// 上下文：此处只检查精确顶层 marker；深层 YAML 的格式和 schema 延后由锁内严格解析器验证。
export type NativeWorkflowMode = 'READ_ONLY' | 'MUTATION' | 'INITIALIZE';

const WORKFLOW_VERSION_MARKER = /^workflowVersion:[ \t]+(?:0\.3\.0|'0\.3\.0'|"0\.3\.0")[ \t]*$/u;
const MAXIMUM_WORKFLOW_MARKER_BYTES = 64 * 1024;
// Task 9H 尚未安装、验证并原子激活 packaged candidate；手工写入 marker 不授予创建权限。
const NATIVE_CREATION_CANDIDATE_ACTIVE = false;

export async function assertNativeWorkflowSupported(
  repoRoot: string,
  mode: NativeWorkflowMode,
): Promise<void> {
  if (mode === 'INITIALIZE' && !NATIVE_CREATION_CANDIDATE_ACTIVE) {
    throw unsupportedWorkflowVersion(mode);
  }
  if (!(await isExpectedDirectory(omnaiRoot(repoRoot)))) {
    throw unsupportedWorkflowVersion(mode);
  }

  const marker = await readWorkflowVersionMarker(workflowLockPath(repoRoot));
  if (!marker || !hasExactWorkflowVersionMarker(marker)) {
    throw unsupportedWorkflowVersion(mode);
  }
}

async function isExpectedDirectory(path: string): Promise<boolean> {
  const node = await lstatOrNull(path);
  return node?.isDirectory() === true && !node.isSymbolicLink();
}

async function readWorkflowVersionMarker(path: string): Promise<string | null> {
  // 背景：lstat 后再 readFile 存在替换窗口且会无界分配；FIFO 还可能永久阻塞。目的：以同一个
  // O_NOFOLLOW/O_NONBLOCK fd 认证 regular single-link inode、64 KiB 大小和稳定 EOF，再做 fatal
  // UTF-8 decode。上下文：这里只读取候选 marker，不解析或修复完整 WorkflowLock。
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1
      || before.size < 0 || before.size > MAXIMUM_WORKFLOW_MARKER_BYTES) return null;

    const bytes = Buffer.alloc(MAXIMUM_WORKFLOW_MARKER_BYTES + 1);
    let total = 0;
    while (total <= MAXIMUM_WORKFLOW_MARKER_BYTES) {
      const result = await handle.read(bytes, total, bytes.byteLength - total, total);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
    }
    const after = await handle.stat();
    if (total !== before.size || total > MAXIMUM_WORKFLOW_MARKER_BYTES
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

function hasExactWorkflowVersionMarker(contents: string): boolean {
  const markerLines = contents
    .split(/\r?\n/u)
    .filter((line) => line.trimStart().startsWith('workflowVersion:'));
  return markerLines.length === 1 && WORKFLOW_VERSION_MARKER.test(markerLines[0]!);
}

function unsupportedWorkflowVersion(mode: NativeWorkflowMode): Error {
  return new Error(`UNSUPPORTED_WORKFLOW_VERSION: ${mode} requires the exact native workflow marker 0.3.0`);
}
