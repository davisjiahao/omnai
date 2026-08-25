import { hObject } from '../domain/public.js';
import type { Sha256 } from '../domain/types.js';

// 背景：Plan02 将消费 journal-bound artifact hash；旧实现通过 Object.entries/map/localeCompare
// 另建一套 canonicalizer，会执行 accessor、接纳继承语义并产生 locale-dependent bytes。目的：
// internal consumer 只委托 Plan01 唯一 descriptor-authenticated HObject 原语，不保留第二套身份模型。
// 上下文：v0.3 是尚未激活 WorkflowLock 的 native clean break，旧 pre-native journal 不属于
// replay authority；mixed-case 与 integer-like key 的 clean hash 已明确改变且不兼容旧值。函数名与
// 返回品牌保留只服务当前 internal consumer，绝不代表接受旧 hash、fallback 或 dual reader。
export function hashCanonicalArtifact(value: unknown): Sha256 {
  return hObject(value);
}
