import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  changeIdSchema,
  type BaselineId,
  type ChangeId,
  type DecisionId,
  type EvidenceId,
  type InvestigationId,
  parseBaselineId,
  parseChangeId,
  parseDecisionId,
  parseEvidenceId,
  parseInvestigationId,
  parseProjectTransactionId,
  parseRevisionId,
  parseRunId,
  parseSha256,
  parseTaskId,
  parseTimestamp,
  type ProjectTransactionId,
  type RevisionId,
  type RunId,
  type Sha256,
  sha256Schema,
  type TaskId,
  type Timestamp,
  timestampSchema,
  revisionIdSchema,
  baselineIdSchema,
  taskIdSchema,
  decisionIdSchema,
  evidenceIdSchema,
  runIdSchema,
  investigationIdSchema,
  projectTransactionIdSchema,
} from '../scalars.js';

// 背景：v0.3 需要让跨文件引用共享同一套不可宽松解释的标量格式。
// 目的：在进入锁内完整解析前，固定哈希、时间戳和每类标识符的规范输入边界。
// 上下文：每个断言直接使用外部可见的 parser，避免测试重复实现生产正则。
test('九类 final-v0.3 ID 都拒绝零值、错误宽度和错误大小写', () => {
  const families: Array<{
    readonly name: string;
    readonly parse: (value: unknown) => string;
    readonly valid: string;
    readonly zero: string;
    readonly short: string;
    readonly long: string;
    readonly wrongCase: string;
  }> = [
    { name: 'CHG', parse: parseChangeId, valid: 'CHG-0001', zero: 'CHG-0000', short: 'CHG-001', long: 'CHG-00001', wrongCase: 'chg-0001' },
    { name: 'REV', parse: parseRevisionId, valid: 'REV-0001', zero: 'REV-0000', short: 'REV-001', long: 'REV-00001', wrongCase: 'rev-0001' },
    { name: 'BL', parse: parseBaselineId, valid: 'BL-0001', zero: 'BL-0000', short: 'BL-001', long: 'BL-00001', wrongCase: 'bl-0001' },
    { name: 'TASK', parse: parseTaskId, valid: 'TASK-001', zero: 'TASK-000', short: 'TASK-01', long: 'TASK-0001', wrongCase: 'task-001' },
    { name: 'DEC', parse: parseDecisionId, valid: 'DEC-0001', zero: 'DEC-0000', short: 'DEC-001', long: 'DEC-00001', wrongCase: 'dec-0001' },
    { name: 'EVD', parse: parseEvidenceId, valid: 'EVD-000001', zero: 'EVD-000000', short: 'EVD-00001', long: 'EVD-0000001', wrongCase: 'evd-000001' },
    { name: 'RUN', parse: parseRunId, valid: 'RUN-000001', zero: 'RUN-000000', short: 'RUN-00001', long: 'RUN-0000001', wrongCase: 'run-000001' },
    { name: 'INV', parse: parseInvestigationId, valid: 'INV-0001', zero: 'INV-0000', short: 'INV-001', long: 'INV-00001', wrongCase: 'inv-0001' },
    { name: 'PROJECT', parse: parseProjectTransactionId, valid: 'PROJECT-000001', zero: 'PROJECT-000000', short: 'PROJECT-00001', long: 'PROJECT-0000001', wrongCase: 'project-000001' },
  ];

  for (const family of families) {
    assert.equal(family.parse(family.valid), family.valid, family.name);
    for (const invalid of [family.zero, family.short, family.long, family.wrongCase]) {
      assert.throws(() => family.parse(invalid), /Invalid/, `${family.name}: ${invalid}`);
    }
  }
  assert.equal(changeIdSchema.parse('CHG-0001'), 'CHG-0001');
});

test('哈希与时间戳仅接受规范的 final-v0.3 标量', () => {
  const digest = 'a'.repeat(64);
  assert.equal(parseSha256(`sha256:${digest}`), `sha256:${digest}`);
  for (const invalid of [`sha256:${'a'.repeat(63)}`, `sha256:${'a'.repeat(65)}`, `sha256:${'A'.repeat(64)}`]) {
    assert.throws(() => parseSha256(invalid), /Invalid/);
  }

  assert.equal(parseTimestamp('2026-08-23T12:34:56.789Z'), '2026-08-23T12:34:56.789Z');
  for (const invalid of [
    '2026-08-23T12:34:56.789+00:00',
    '2026-08-23T12:34:60.789Z',
    '+02026-08-23T12:34:56.789Z',
    '2026-08-23T12:34:56Z',
    '2026-08-23T12:34:56.7890Z',
    '2026-02-30T12:34:56.789Z',
  ]) {
    assert.throws(() => parseTimestamp(invalid), /NATIVE_SCHEMA_MISMATCH|Invalid/);
  }
  assert.equal(timestampSchema.safeParse('2026-02-30T12:34:56.789Z').success, false);
});

test('导出的标量 schema 直接输出对应品牌类型', () => {
  // 背景：使用 schema 的调用方不能绕过 parser 而丢失标量身份。
  // 目的：将每个 schema 的 z.output 静态约束为对应品牌，防止未来回退为普通 string。
  // 上下文：satisfies 在 typecheck 阶段验证，运行时仅解析已知规范输入。
  const branded = {
    sha256: sha256Schema.parse(`sha256:${'a'.repeat(64)}`),
    timestamp: timestampSchema.parse('2026-08-23T12:34:56.789Z'),
    change: changeIdSchema.parse('CHG-0001'),
    revision: revisionIdSchema.parse('REV-0001'),
    baseline: baselineIdSchema.parse('BL-0001'),
    task: taskIdSchema.parse('TASK-001'),
    decision: decisionIdSchema.parse('DEC-0001'),
    evidence: evidenceIdSchema.parse('EVD-000001'),
    run: runIdSchema.parse('RUN-000001'),
    investigation: investigationIdSchema.parse('INV-0001'),
    projectTransaction: projectTransactionIdSchema.parse('PROJECT-000001'),
  } satisfies {
    readonly sha256: Sha256;
    readonly timestamp: Timestamp;
    readonly change: ChangeId;
    readonly revision: RevisionId;
    readonly baseline: BaselineId;
    readonly task: TaskId;
    readonly decision: DecisionId;
    readonly evidence: EvidenceId;
    readonly run: RunId;
    readonly investigation: InvestigationId;
    readonly projectTransaction: ProjectTransactionId;
  };

  assert.equal(branded.timestamp, '2026-08-23T12:34:56.789Z');
});
