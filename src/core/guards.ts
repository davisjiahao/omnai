import type { RiskLevel } from '../domain/types.js';
import type { IssueState } from './issues.js';

export type GuardAction = 'edit' | 'complete' | 'ship';

export interface GuardInput {
  action: GuardAction;
  scenario: string;
  riskLevel: RiskLevel;
  issue?: IssueState;
  verificationReady?: boolean;
  reviewReady?: boolean;
  evidenceSatisfied?: boolean;
  humanApproval?: boolean;
}

export interface GuardDecision {
  allowed: boolean;
  code: string;
  reason: string;
}

export function evaluateGuard(input: GuardInput): GuardDecision {
  if (input.action === 'edit' && input.scenario === 'bug-fix') {
    if (!input.issue || input.issue.rootCause !== 'confirmed' || input.issue.triageState !== 'ready-for-fix') {
      return deny('BUG_RCA_REQUIRED', 'Bug fixes cannot edit production code until reproduction, root cause, and fix strategy are confirmed.');
    }
  }

  if (input.action === 'complete' || input.action === 'ship') {
    if (!input.verificationReady) return deny('VERIFICATION_REQUIRED', 'Fresh verification must be ready before completion or ship.');
    if (!input.evidenceSatisfied) return deny('EVIDENCE_GAP', 'Required evidence matrix still has unsatisfied items.');
  }

  if (input.action === 'ship') {
    if ((input.riskLevel === 'P0' || input.riskLevel === 'P1') && !input.reviewReady) {
      return deny('REVIEW_REQUIRED', `${input.riskLevel} changes require independent review before ship.`);
    }
    if ((input.riskLevel === 'P0' || input.riskLevel === 'P1') && !input.humanApproval) {
      return deny('HUMAN_APPROVAL_REQUIRED', `${input.riskLevel} changes require explicit human approval before ship.`);
    }
  }

  return { allowed: true, code: 'ALLOW', reason: 'No OmnAI guard blocks this action.' };
}

function deny(code: string, reason: string): GuardDecision {
  return { allowed: false, code, reason };
}
