import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hObject } from '../../domain/public.js';
import { hashCanonicalArtifact } from '../canonical-hash-internal.js';

// 背景：Plan02 将消费 journal-bound artifact hash；旧内部 helper 另有一套 Object.entries/map
// canonicalizer，会先执行 getter，再用 localeCompare 排序，绕过 Plan01 的 strict identity 原语。
// 目的：内部 hash 必须和 HObject 一样在 getter 零读取下 fail-closed，不能保留第二套递归实现。
// 上下文：测试只观察公开的 internal consumer 行为，不断言私有源码形状。
test('内部 artifact hash 在零读取下拒绝 accessor', () => {
  let getterReads = 0;
  const value: Record<string, unknown> = {};
  Object.defineProperty(value, 'secret', {
    configurable: true,
    enumerable: true,
    get() {
      getterReads += 1;
      return 'observed';
    },
  });

  assert.throws(() => hashCanonicalArtifact(value), /NATIVE_SCHEMA_MISMATCH/u);
  assert.equal(getterReads, 0);
});

// 背景：旧 pre-native internal helper 使用 localeCompare 和 Object.entries 枚举顺序，
// mixed-case 对象的旧值为 904baf6c…，integer-like key 的旧值为 b111b495…。
// 控制器已裁决 v0.3 是未激活 WorkflowLock 的 native clean break，Section 8 code-unit
// HObject 才是唯一身份。目的：用完整字面 digest 锁定 mixed-case 与
// integer-like key 的新规范值，且 internal consumer 必须与 HObject 完全一致。
// 上下文：这是 clean persisted hash 的显式 ABI 变化，不接受旧值、fallback 或双读。
test('internal artifact hash 固定 v0.3 code-unit mixed-case 与 integer-like golden', () => {
  const mixedCase = { Z: 1, a: 2 };
  const integerLike = { 2: 'two', 10: 'ten', a: 'letter' };

  assert.equal(
    hashCanonicalArtifact(mixedCase),
    'sha256:b19fcf144d639e7ba9a9d01385685d8aa19699bff9fa3e916f61935afabcd8e9',
  );
  assert.equal(
    hashCanonicalArtifact(integerLike),
    'sha256:264a04ae1cca03183321518eb8984b19c814df554347f259085f568361e504da',
  );
  assert.equal(hashCanonicalArtifact(mixedCase), hObject(mixedCase));
  assert.equal(hashCanonicalArtifact(integerLike), hObject(integerLike));
  assert.notEqual(
    hashCanonicalArtifact(mixedCase),
    'sha256:904baf6c3b55f398cb3d7d18b7b2a5ff2b3e2cef2e9b0b2761fd3c6de6f6882',
  );
  assert.notEqual(
    hashCanonicalArtifact(integerLike),
    'sha256:b111b49524300d90f34bfe73cc43c7aee4ba109988b7d8aa946e96717cafec60',
  );
});
