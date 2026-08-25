import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { canonicalizeStrictJson } from '../strict-json-internal.js';

// 背景：旧 encoder 对每个 code unit 执行 `output +=`，8 MiB 合法 ASCII scalar
// 会形成数百 MiB rope/substring 堆放大，在远未到 256 MiB UTF-8 与 512 MiB
// canonical budget 前就 OOM。目的：在 128 MiB V8 old-space 的隔离子进程内编码
// 8 MiB scalar，并以手工固定的 exact byte length/SHA 证明完整输出，不只是
// “未崩溃”。上下文：资源上限是验收条件，不允许通过提高 heap 规避。
test('canonical encoder 在 128 MiB old-space 内线性编码 8 MiB ASCII scalar', () => {
  const moduleUrl = new URL('../strict-json-internal.js', import.meta.url).href;
  const childSource = `
    import { createHash } from 'node:crypto';
    import { canonicalizeStrictJson } from ${JSON.stringify(moduleUrl)};
    const canonical = canonicalizeStrictJson('x'.repeat(8 * 1024 * 1024));
    process.stdout.write(JSON.stringify({
      byteLength: Buffer.byteLength(canonical, 'utf8'),
      hash: createHash('sha256').update(canonical).digest('hex'),
    }));
  `;
  const child = spawnSync(process.execPath, [
    '--max-old-space-size=128',
    '--input-type=module',
    '--eval',
    childSource,
  ], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });

  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    byteLength: 8_388_610,
    hash: '8b8a183f3cf99035717c6b5808a5c1cc56a8a6cf9df46a4305a0f08906ff596d',
  });
});

// 背景：把 string rope 改为 byte writer 容易在 escape、非 ASCII Unicode、嵌套
// container 或 integer-like key 排序上改变 Section 8 bytes。目的：以手写字面量
// 同时锁定换行/引号/反斜杠 escape、四字节 Unicode scalar、array order 和
// code-unit object key order。上下文：expected 不调用 production helper 推导。
test('canonical byte writer 保持 escape、Unicode 与嵌套 key order exact bytes', () => {
  const value = {
    a: ['😀', { 2: 'two', 10: 'ten' }],
    Z: 'line\nquote"slash\\',
  };
  const canonical = canonicalizeStrictJson(value);

  assert.equal(
    canonical,
    '{"Z":"line\\nquote\\"slash\\\\","a":["😀",{"10":"ten","2":"two"}]}',
  );
  assert.equal(
    createHash('sha256').update(canonical).digest('hex'),
    '95d0975db3856dfbd97e4a0031a4e8b5b9d39b81798705a1fa0255b232c1153b',
  );
});
