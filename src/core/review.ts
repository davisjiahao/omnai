import { z } from 'zod';
import {
  reviewDraftV2Schema,
  reviewPolicySchema,
  reviewScopeSchema,
  type ReviewDraftV2,
} from '../domain/run.js';
import {
  hObject,
  guardStrictPersistentInput,
  persistedChangeIdSchema,
  persistedDecisionIdSchema,
  persistedEvidenceIdSchema,
  persistedRevisionIdSchema,
  persistedRunIdSchema,
} from '../domain/public.js';
import { decodeStrictJson } from '../domain/strict-json-decoder.js';

// 背景：仓库 Review v1 reader 曾在 Core 重新声明一份带 default 的弱 schema；stage completion 又有
// 另一份 v2 声明，二者会在同一 imported bytes 上产生不同结论。目的：Core 直接暴露 domain 唯一
// strict ReviewDraftV2 schema 的同一实例，并只在此处加入需要已认证上下文才能判断的权限闭包。
// 上下文：本文件不读取 Decision/Evidence/Run 存储；调用者必须从 sealed context 传入 current PASS
// Evidence 与 RESOLVED human waiver Decision ID，Plans 02/05 再把真实 reader/writer 接到这个纯边界。
export const reviewRecordSchema = reviewDraftV2Schema;
export type ReviewRecord = ReviewDraftV2;

const reviewIdentitySchema = z.strictObject({
  changeId: persistedChangeIdSchema,
  revision: persistedRevisionIdSchema,
  runId: persistedRunIdSchema,
});
const sortedEvidenceIdsSchema = z.array(persistedEvidenceIdSchema).superRefine(requireSortedUnique);
const sortedDecisionIdsSchema = z.array(persistedDecisionIdSchema).superRefine(requireSortedUnique);
const reviewValidationContextRawSchema = z.strictObject({
  identity: reviewIdentitySchema,
  scope: reviewScopeSchema,
  policy: reviewPolicySchema,
  currentPassEvidenceIds: sortedEvidenceIdsSchema,
  resolvedHumanDecisionIds: sortedDecisionIdsSchema,
});
// 背景：Review draft 已有 persistent raw guard，但 sealed authority context 仍曾直接交给 Zod，
// transparent/throwing Proxy 会在 identity/scope 读取时越过 fail-closed 边界。目的：两侧复用同一
// strict raw data 身份门；上下文仍不获得任何 default、迁移或 writer 权限。
const reviewValidationContextSchema = guardStrictPersistentInput(reviewValidationContextRawSchema);

export type ReviewValidationContextV2 = z.input<typeof reviewValidationContextSchema>;

export function validateReviewDraftV2(
  raw: string | unknown,
  rawContext: ReviewValidationContextV2,
): ReviewDraftV2 {
  const decoded = typeof raw === 'string' ? decodeReviewJson(raw) : raw;
  const parsedReview = reviewDraftV2Schema.safeParse(decoded);
  if (!parsedReview.success) {
    throw new Error(`NATIVE_SCHEMA_MISMATCH: ${parsedReview.error.message}`);
  }
  const review = parsedReview.data;
  const context = reviewValidationContextSchema.parse(rawContext);
  if (review.changeId !== context.identity.changeId
    || review.revision !== context.identity.revision
    || review.runId !== context.identity.runId) {
    throw new Error('REVIEW_IDENTITY_MISMATCH');
  }
  if (hObject(review.scope) !== hObject(context.scope)) {
    throw new Error('REVIEW_SCOPE_MISMATCH');
  }

  const axes = [
    {
      name: 'SPECIFICATION' as const,
      draft: review.axes.specification,
      expectedChecks: context.policy.specification,
    },
    {
      name: 'STANDARDS' as const,
      draft: review.axes.standards,
      expectedChecks: context.policy.standards,
    },
    {
      name: 'RISK_PRODUCTION' as const,
      draft: review.axes.riskProduction,
      expectedChecks: context.policy.riskProduction,
    },
  ];
  const currentEvidence = new Set<string>(context.currentPassEvidenceIds);
  const evidenceByAxisCheck = new Map<string, ReadonlySet<string>>();
  for (const axis of axes) {
    const actualChecks = axis.draft.checks.map(({ check }) => check);
    if (hObject(actualChecks) !== hObject(axis.expectedChecks)) {
      throw new Error('REVIEW_POLICY_MISMATCH');
    }
    if (axis.draft.status !== foldStatuses(axis.draft.checks.map(({ status }) => status))) {
      throw new Error('REVIEW_AXIS_FOLD_MISMATCH');
    }
    for (const check of axis.draft.checks) {
      if (check.evidenceIds.some((evidenceId) => !currentEvidence.has(evidenceId))) {
        throw new Error('REVIEW_EVIDENCE_MISMATCH');
      }
      evidenceByAxisCheck.set(`${axis.name}\u0000${check.check}`, new Set(check.evidenceIds));
    }
  }

  const resolvedHumanDecisions = new Set<string>(context.resolvedHumanDecisionIds);
  for (const finding of review.findings) {
    const checkEvidence = evidenceByAxisCheck.get(`${finding.axis}\u0000${finding.check}`);
    if (checkEvidence === undefined
      || finding.evidenceIds.some((evidenceId) => (
        !currentEvidence.has(evidenceId) || !checkEvidence.has(evidenceId)
      ))) {
      throw new Error('REVIEW_EVIDENCE_MISMATCH');
    }
    if (finding.status === 'ACCEPTED') {
      if (finding.waiverDecisionId === null || !resolvedHumanDecisions.has(finding.waiverDecisionId)) {
        throw new Error('REVIEW_WAIVER_MISMATCH');
      }
    } else if (finding.waiverDecisionId !== null) {
      throw new Error('REVIEW_WAIVER_MISMATCH');
    }
  }

  const axisFold = foldStatuses(axes.map(({ draft }) => draft.status));
  const expectedConclusion = review.findings.some((finding) => (
    finding.status === 'OPEN' && finding.severity === 'CRITICAL'
  ))
    ? 'FAIL'
    : axisFold === 'FAIL'
      ? 'FAIL'
      : review.findings.some((finding) => (
        finding.status === 'OPEN' && finding.severity === 'IMPORTANT'
      ))
        ? 'CONCERNS'
        : axisFold;
  if (review.conclusion !== expectedConclusion) {
    throw new Error('REVIEW_CONCLUSION_FOLD_MISMATCH');
  }
  return review;
}

export function assertReviewReadyV2(
  raw: string | unknown,
  context: ReviewValidationContextV2,
): ReviewDraftV2 {
  const review = validateReviewDraftV2(raw, context);
  if (review.conclusion !== 'PASS') throw new Error('REVIEW_NOT_READY');
  return review;
}

function decodeReviewJson(raw: string): unknown {
  try {
    return decodeStrictJson(raw);
  } catch (error) {
    throw new Error(`NATIVE_SCHEMA_MISMATCH: invalid Review JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function foldStatuses(statuses: ReadonlyArray<'PASS' | 'CONCERNS' | 'FAIL'>): 'PASS' | 'CONCERNS' | 'FAIL' {
  if (statuses.includes('FAIL')) return 'FAIL';
  if (statuses.includes('CONCERNS')) return 'CONCERNS';
  return 'PASS';
}

function requireSortedUnique(values: readonly string[], context: z.RefinementCtx): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) {
      context.addIssue({
        code: 'custom', path: [index],
        message: 'NATIVE_SCHEMA_MISMATCH: collection must be sorted and unique',
      });
    }
  }
}
