import { z } from 'zod';

// 背景：v0.3 原生工作流需要在所有入口共享不可歧义的标量契约。
// 目的：把规范格式解析为品牌类型，阻止宽松字符串在锁内状态之间传播。
// 上下文：这些 parser 只验证单个标量；复合文档的完整严格校验由后续锁内解析器负责。
declare const scalarBrand: unique symbol;

type Scalar<Name extends string> = string & { readonly [scalarBrand]: Name };

export type Sha256 = Scalar<'Sha256'>;
export type Timestamp = Scalar<'Timestamp'>;
export type ChangeId = Scalar<'ChangeId'>;
export type RevisionId = Scalar<'RevisionId'>;
export type BaselineId = Scalar<'BaselineId'>;
export type TaskId = Scalar<'TaskId'>;
export type DecisionId = Scalar<'DecisionId'>;
export type EvidenceId = Scalar<'EvidenceId'>;
export type RunId = Scalar<'RunId'>;
export type InvestigationId = Scalar<'InvestigationId'>;
export type ProjectTransactionId = Scalar<'ProjectTransactionId'>;

export const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const CHANGE_ID_PATTERN = /^CHG-(?!0000$)\d{4}$/;
export const REVISION_ID_PATTERN = /^REV-(?!0000$)\d{4}$/;
export const BASELINE_ID_PATTERN = /^BL-(?!0000$)\d{4}$/;
export const TASK_ID_PATTERN = /^TASK-(?!000$)\d{3}$/;
export const DECISION_ID_PATTERN = /^DEC-(?!0000$)\d{4}$/;
export const EVIDENCE_ID_PATTERN = /^EVD-(?!000000$)\d{6}$/;
export const RUN_ID_PATTERN = /^RUN-(?!000000$)\d{6}$/;
export const INVESTIGATION_ID_PATTERN = /^INV-(?!0000$)\d{4}$/;
export const PROJECT_TRANSACTION_ID_PATTERN = /^PROJECT-(?!000000$)\d{6}$/;

export const sha256Schema = z.string().regex(SHA256_PATTERN).transform((value): Sha256 => value as Sha256);
export const timestampSchema = z.string()
  .regex(TIMESTAMP_PATTERN)
  .refine(isCanonicalTimestamp, 'NATIVE_SCHEMA_MISMATCH: timestamp is not canonical UTC milliseconds')
  .transform((value): Timestamp => value as Timestamp);
export const changeIdSchema = z.string().regex(CHANGE_ID_PATTERN).transform((value): ChangeId => value as ChangeId);
export const revisionIdSchema = z.string().regex(REVISION_ID_PATTERN).transform((value): RevisionId => value as RevisionId);
export const baselineIdSchema = z.string().regex(BASELINE_ID_PATTERN).transform((value): BaselineId => value as BaselineId);
export const taskIdSchema = z.string().regex(TASK_ID_PATTERN).transform((value): TaskId => value as TaskId);
export const decisionIdSchema = z.string().regex(DECISION_ID_PATTERN).transform((value): DecisionId => value as DecisionId);
export const evidenceIdSchema = z.string().regex(EVIDENCE_ID_PATTERN).transform((value): EvidenceId => value as EvidenceId);
export const runIdSchema = z.string().regex(RUN_ID_PATTERN).transform((value): RunId => value as RunId);
export const investigationIdSchema = z.string().regex(INVESTIGATION_ID_PATTERN).transform((value): InvestigationId => value as InvestigationId);
export const projectTransactionIdSchema = z.string().regex(PROJECT_TRANSACTION_ID_PATTERN).transform((value): ProjectTransactionId => value as ProjectTransactionId);

export function parseSha256(value: unknown): Sha256 {
  return sha256Schema.parse(value);
}

export function parseTimestamp(value: unknown): Timestamp {
  return timestampSchema.parse(value);
}

export function parseChangeId(value: unknown): ChangeId {
  return changeIdSchema.parse(value);
}

export function parseRevisionId(value: unknown): RevisionId {
  return revisionIdSchema.parse(value);
}

export function parseBaselineId(value: unknown): BaselineId {
  return baselineIdSchema.parse(value);
}

export function parseTaskId(value: unknown): TaskId {
  return taskIdSchema.parse(value);
}

export function parseDecisionId(value: unknown): DecisionId {
  return decisionIdSchema.parse(value);
}

export function parseEvidenceId(value: unknown): EvidenceId {
  return evidenceIdSchema.parse(value);
}

export function parseRunId(value: unknown): RunId {
  return runIdSchema.parse(value);
}

export function parseInvestigationId(value: unknown): InvestigationId {
  return investigationIdSchema.parse(value);
}

export function parseProjectTransactionId(value: unknown): ProjectTransactionId {
  return projectTransactionIdSchema.parse(value);
}

function isCanonicalTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}
