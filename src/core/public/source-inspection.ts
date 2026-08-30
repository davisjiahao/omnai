import { buildChangeBaseContext, sealForNewMutation } from '../authority/context.js';
import { inspectCurrentSource as inspectWithinSession } from '../source/inspect.js';
import type { InspectedCurrentSource, SourceInspectLocator } from '../source/types.js';

// 背景：Task4 inspection 只接受 callback-scoped session，无法由 repoRoot + ChangeId 安全调用。
// 目的：public Core facade 用 recorder-owned 真实布局 builder 建立一次 context，再只返回 Task4
// 已裁剪的 inspection projection。上下文：CLI/root export 留给 Plan07；本文件不暴露 root、recorder、
// provider binding 或 internal observation。
export async function inspectCurrentSource(
  repoRoot: string,
  changeId: string,
  locator: SourceInspectLocator | unknown,
): Promise<InspectedCurrentSource> {
  let inspected: InspectedCurrentSource | undefined;
  await sealForNewMutation(
    await buildChangeBaseContext(repoRoot, changeId),
    async (session) => {
      inspected = await inspectWithinSession(session, locator);
    },
  );
  if (inspected === undefined) throw new Error('SOURCE_INSPECTION_INCOMPLETE');
  return inspected;
}
