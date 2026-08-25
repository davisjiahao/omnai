import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewDraftV2Schema, type ReviewDraftV2 } from '../../domain/run.js';
import {
  assertReviewReadyV2,
  reviewRecordSchema,
  validateReviewDraftV2,
  type ReviewValidationContextV2,
} from '../review.js';
import { reviewDraftV2Schema as stageCompletionReviewDraftV2Schema } from '../../authority/compilers/stage-completion.js';

// 背景：Review v1 的 lenses/default 允许遗漏检查，也无法认证三轴、scope、Evidence 和 waiver。
// 目的：固定一个由 domain、Core 和 stage-completion 共同消费的 strict v2 schema，并独立 mutation
// 每条权限边界。上下文：本任务只实现纯验证器；Evidence importer/owner 写入仍由 Plan 05 完成。
const hash = (character: string) => `sha256:${character.repeat(64)}`;

const context: ReviewValidationContextV2 = {
  identity: { changeId: 'CHG-0001', revision: 'REV-0001', runId: 'RUN-000001' },
  scope: {
    kind: 'CHANGE',
    sourceAuthorityHead: hash('a'),
    repositoryWorkHash: hash('b'),
  },
  policy: {
    schemaVersion: 1,
    specification: ['requirements'],
    standards: ['architecture'],
    riskProduction: ['operability'],
  },
  currentPassEvidenceIds: ['EVD-000001', 'EVD-000002', 'EVD-000003'],
  resolvedHumanDecisionIds: ['DEC-0001'],
};

function reviewFixture(): ReviewDraftV2 {
  return reviewDraftV2Schema.parse({
    schemaVersion: 2,
    changeId: 'CHG-0001',
    revision: 'REV-0001',
    runId: 'RUN-000001',
    scope: context.scope,
    axes: {
      specification: {
        status: 'PASS',
        checks: [{ check: 'requirements', status: 'PASS', evidenceIds: ['EVD-000001'], summary: 'Requirements match.' }],
      },
      standards: {
        status: 'PASS',
        checks: [{ check: 'architecture', status: 'PASS', evidenceIds: ['EVD-000002'], summary: 'Boundary is preserved.' }],
      },
      riskProduction: {
        status: 'PASS',
        checks: [{ check: 'operability', status: 'PASS', evidenceIds: ['EVD-000003'], summary: 'Operations are covered.' }],
      },
    },
    findings: [],
    conclusion: 'PASS',
  });
}

test('domain、Core 与 stage-completion 共享同一个 ReviewDraftV2 schema 实例', () => {
  assert.equal(reviewRecordSchema, reviewDraftV2Schema);
  assert.equal(stageCompletionReviewDraftV2Schema, reviewDraftV2Schema);
});

// 背景：JSON.parse 对重复键采用 last-wins；攻击者可让人工查看的前值与 schema/hash 使用的后值
// 分离。目的：Core Review 的真实字符串边界在 Zod 与 canonical identity 前拒绝 root/nested
// 重复键，同时继续拒绝 BOM、尾随第二个 JSON 值与普通语法错误。上下文：期望由手写原始 JSON
// mutation 产生，不调用 production decoder 构造 oracle；合法控制仍使用同一 ReviewDraftV2 schema。
test('Core Review strict JSON 边界拒绝 root/nested 重复键、BOM 与尾随值', () => {
  const review = reviewFixture();
  const canonical = JSON.stringify(review);
  const rootDuplicate = canonical.replace(
    '{"schemaVersion":2',
    '{"schemaVersion":2,"schemaVersion":2',
  );
  const nestedDuplicate = canonical.replace(
    '"scope":{"kind":"CHANGE"',
    '"scope":{"kind":"CHANGE","kind":"CHANGE"',
  );

  assert.doesNotThrow(() => validateReviewDraftV2(canonical, context));
  for (const raw of [
    rootDuplicate,
    nestedDuplicate,
    `\ufeff${canonical}`,
    `${canonical}{"schemaVersion":2}`,
    '{"schemaVersion":',
  ]) {
    assert.throws(() => validateReviewDraftV2(raw, context), /NATIVE_SCHEMA_MISMATCH/);
  }
});

// 背景：Review draft 已走 persistent raw guard，但 authority context 仍直接进入 z.strictObject；
// root/nested Proxy 或 getter 会在拒绝前执行 caller code。目的：transparent、throwing、revoked
// Proxy 与 accessor 都必须在任何 trap/getter 前 fail-closed。上下文：context 来自未来 sealed builder，
// 但 pure public validator 仍把 runtime caller 视为 hostile，不能依赖 TypeScript 结构类型。
test('Review authority context 在读取 identity/scope/policy 前拒绝 Proxy 与 accessor', () => {
  const review = reviewFixture();
  const transparentRoot = new Proxy(structuredClone(context), {});
  const transparentNested = {
    ...structuredClone(context),
    scope: new Proxy(structuredClone(context.scope), {}),
  };
  assert.throws(() => Reflect.apply(validateReviewDraftV2, undefined, [review, transparentRoot]));
  assert.throws(() => Reflect.apply(validateReviewDraftV2, undefined, [review, transparentNested]));

  for (const nested of [false, true]) {
    let traps = 0;
    const hostile = new Proxy(structuredClone(context.scope), {
      getPrototypeOf() { traps += 1; throw new Error('HOSTILE_REVIEW_CONTEXT_PROTOTYPE'); },
      ownKeys() { traps += 1; throw new Error('HOSTILE_REVIEW_CONTEXT_KEYS'); },
      getOwnPropertyDescriptor() { traps += 1; throw new Error('HOSTILE_REVIEW_CONTEXT_DESCRIPTOR'); },
      get() { traps += 1; throw new Error('HOSTILE_REVIEW_CONTEXT_GET'); },
    });
    const value = nested ? { ...structuredClone(context), scope: hostile } : hostile;
    assert.throws(() => Reflect.apply(validateReviewDraftV2, undefined, [review, value]));
    assert.equal(traps, 0, nested ? 'nested' : 'root');
  }

  const revoked = Proxy.revocable(structuredClone(context), {});
  revoked.revoke();
  assert.throws(() => Reflect.apply(validateReviewDraftV2, undefined, [review, revoked.proxy]));

  let getterReads = 0;
  const accessor = structuredClone(context) as Record<string, unknown>;
  Object.defineProperty(accessor, 'identity', {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error('HOSTILE_REVIEW_CONTEXT_GETTER');
    },
  });
  assert.throws(() => Reflect.apply(validateReviewDraftV2, undefined, [review, accessor]));
  assert.equal(getterReads, 0);
});

test('strict schema identity、scope 与三轴 exact checks 均不可漂移', () => {
  const review = reviewFixture();
  assert.doesNotThrow(() => validateReviewDraftV2(review, context));

  assert.throws(() => validateReviewDraftV2({ ...review, schemaVersion: 1 }, context), /NATIVE_SCHEMA_MISMATCH/);
  assert.throws(() => validateReviewDraftV2({
    ...review,
    scope: { ...review.scope, repositoryWorkHash: hash('c') },
  }, context), /REVIEW_SCOPE_MISMATCH/);
  assert.throws(() => validateReviewDraftV2({
    ...review,
    axes: {
      ...review.axes,
      specification: { ...review.axes.specification, checks: [] },
    },
  }, context), /REVIEW_POLICY_MISMATCH/);
  assert.throws(() => validateReviewDraftV2({
    ...review,
    axes: {
      ...review.axes,
      specification: {
        ...review.axes.specification,
        checks: [{
          check: 'non-goals', status: 'PASS', evidenceIds: ['EVD-000001'], summary: 'Extra check.',
        }, ...review.axes.specification.checks],
      },
    },
  }, context), /REVIEW_POLICY_MISMATCH/);
});

test('check/finding 只能引用当前 PASS 且属于同一 axis/check 的 Evidence', () => {
  const review = reviewFixture();
  assert.throws(() => validateReviewDraftV2({
    ...review,
    axes: {
      ...review.axes,
      specification: {
        ...review.axes.specification,
        checks: [{ ...review.axes.specification.checks[0]!, evidenceIds: ['EVD-000004'] }],
      },
    },
  }, context), /REVIEW_EVIDENCE_MISMATCH/);

  assert.throws(() => validateReviewDraftV2({
    ...review,
    findings: [{
      id: 'FIND-001', axis: 'SPECIFICATION', check: 'requirements', severity: 'MINOR', status: 'OPEN',
      summary: 'Finding borrowed Evidence from another axis.', evidenceIds: ['EVD-000002'], waiverDecisionId: null,
    }],
  }, context), /REVIEW_EVIDENCE_MISMATCH/);
});

test('ACCEPTED finding 只接受当前 RESOLVED human Decision waiver', () => {
  const review = reviewFixture();
  const accepted: ReviewDraftV2 = reviewDraftV2Schema.parse({
    ...review,
    findings: [{
      id: 'FIND-001', axis: 'SPECIFICATION', check: 'requirements', severity: 'MINOR', status: 'ACCEPTED',
      summary: 'Accepted by current human authority.', evidenceIds: ['EVD-000001'], waiverDecisionId: 'DEC-0001',
    }],
  });

  assert.doesNotThrow(() => validateReviewDraftV2(accepted, context));
  assert.throws(
    () => validateReviewDraftV2(accepted, { ...context, resolvedHumanDecisionIds: [] }),
    /REVIEW_WAIVER_MISMATCH/,
  );
  assert.throws(() => validateReviewDraftV2({
    ...review,
    findings: [{
      id: 'FIND-001', axis: 'SPECIFICATION', check: 'requirements', severity: 'MINOR', status: 'OPEN',
      summary: 'An open finding cannot carry a waiver.', evidenceIds: ['EVD-000001'], waiverDecisionId: 'DEC-0001',
    }],
  }, context), /REVIEW_WAIVER_MISMATCH/);
});

test('axis 与 conclusion 都从 checks/open findings 精确折叠，blocking finding 不能伪装 PASS', () => {
  const review = reviewFixture();
  const failedCheck = {
    ...review,
    axes: {
      ...review.axes,
      specification: {
        status: 'PASS' as const,
        checks: [{ ...review.axes.specification.checks[0]!, status: 'FAIL' as const }],
      },
    },
  };
  assert.throws(() => validateReviewDraftV2(failedCheck, context), /REVIEW_AXIS_FOLD_MISMATCH/);

  const blocking = {
    ...review,
    findings: [{
      id: 'FIND-001', axis: 'SPECIFICATION' as const, check: 'requirements' as const,
      severity: 'CRITICAL' as const, status: 'OPEN' as const,
      summary: 'Blocking authority mismatch.', evidenceIds: ['EVD-000001'], waiverDecisionId: null,
    }],
    conclusion: 'PASS' as const,
  };
  assert.throws(() => validateReviewDraftV2(blocking, context), /REVIEW_CONCLUSION_FOLD_MISMATCH/);

  const correctlyFoldedFailure = { ...blocking, conclusion: 'FAIL' as const };
  assert.doesNotThrow(() => validateReviewDraftV2(correctlyFoldedFailure, context));
  assert.throws(() => assertReviewReadyV2(correctlyFoldedFailure, context), /REVIEW_NOT_READY/);
});
