import { z } from 'zod';

const reviewFindingSchema = z.object({
  lens: z.string().min(1),
  severity: z.enum(['CRITICAL', 'IMPORTANT', 'MINOR']),
  status: z.enum(['OPEN', 'RESOLVED', 'ACCEPTED']),
  summary: z.string().min(1),
});

export const reviewRecordSchema = z.object({
  schemaVersion: z.literal(1),
  changeId: z.string().regex(/^CHG-\d{4}$/),
  revision: z.string().regex(/^REV-\d{4}$/),
  lenses: z.array(z.string().min(1)).min(1),
  specCompliance: z.enum(['PASS', 'CONCERNS', 'FAIL']),
  implementationQuality: z.enum(['PASS', 'CONCERNS', 'FAIL']),
  conclusion: z.enum(['PASS', 'CONCERNS', 'FAIL']),
  findings: z.array(reviewFindingSchema).default([]),
});

export type ReviewRecord = z.infer<typeof reviewRecordSchema>;

export function validateReviewRecord(
  raw: string,
  changeId: string,
  activeRevision: string,
  requiredLenses: string[],
): ReviewRecord {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid review JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const parsed = reviewRecordSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error(`Invalid review schema: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  const review = parsed.data;
  if (review.changeId !== changeId) {
    throw new Error(`Invalid review evidence: expected change ${changeId}, found ${review.changeId}.`);
  }
  if (review.revision !== activeRevision) {
    throw new Error(`Stale review evidence: review targets ${review.revision}, but the active revision is ${activeRevision}.`);
  }

  const covered = new Set(review.lenses);
  const missingLenses = requiredLenses.filter((lens) => !covered.has(lens));
  if (missingLenses.length > 0) {
    throw new Error(`Missing review lenses: ${missingLenses.join(', ')}.`);
  }

  const blockingFindings = review.findings.filter(
    (finding) => finding.status === 'OPEN' && (finding.severity === 'CRITICAL' || finding.severity === 'IMPORTANT'),
  );
  if (blockingFindings.length > 0) {
    throw new Error(`Blocking review findings remain open: ${blockingFindings.map((finding) => finding.summary).join(' | ')}.`);
  }
  if (review.specCompliance !== 'PASS' || review.implementationQuality !== 'PASS' || review.conclusion !== 'PASS') {
    throw new Error(`Review conclusion is not ready: spec=${review.specCompliance}, quality=${review.implementationQuality}, conclusion=${review.conclusion}.`);
  }
  return review;
}
