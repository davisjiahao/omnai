import { z } from 'zod';
import { readYaml, writeYaml } from './files.js';

export const ISSUE_TRIAGE_STATES = [
  'needs-info',
  'ready-for-debug',
  'ready-for-fix',
  'needs-experiment',
  'ready-for-human',
  'wontfix',
] as const;

export const issueStateSchema = z.object({
  triageState: z.enum(ISSUE_TRIAGE_STATES),
  reproduction: z.enum(['unknown', 'confirmed', 'not-reproducible', 'instrumentation-required']),
  rootCause: z.enum(['unknown', 'suspected', 'confirmed']),
  fixStrategy: z.enum(['unknown', 'ready', 'needs-experiment']),
});

export type IssueTriageState = (typeof ISSUE_TRIAGE_STATES)[number];
export type IssueState = z.infer<typeof issueStateSchema>;

export function createInitialIssueState(): IssueState {
  return {
    triageState: 'needs-info',
    reproduction: 'unknown',
    rootCause: 'unknown',
    fixStrategy: 'unknown',
  };
}

export function transitionIssue(issue: IssueState, next: IssueTriageState): IssueState {
  if (next === 'ready-for-debug' && !['confirmed', 'instrumentation-required'].includes(issue.reproduction)) {
    throw new Error('Issue must have a confirmed reproduction or instrumentation plan before ready-for-debug.');
  }
  if (next === 'needs-experiment') {
    if (issue.reproduction !== 'confirmed') throw new Error('Confirmed reproduction is required before an experiment.');
    if (issue.rootCause !== 'confirmed') throw new Error('Confirmed root cause is required before a fix experiment.');
    if (issue.fixStrategy !== 'needs-experiment') throw new Error('Fix strategy must require an experiment.');
  }
  if (next === 'ready-for-fix') {
    if (issue.reproduction !== 'confirmed') throw new Error('Confirmed reproduction is required before a fix.');
    if (issue.rootCause !== 'confirmed') throw new Error('Confirmed root cause is required before a fix.');
    if (issue.fixStrategy !== 'ready') throw new Error('Fix strategy must be ready before a fix.');
  }
  issue.triageState = next;
  return issue;
}

export async function loadIssueState(path: string): Promise<IssueState> {
  return readYaml(path, issueStateSchema);
}

export async function saveIssueState(path: string, state: IssueState): Promise<void> {
  await writeYaml(path, issueStateSchema.parse(state));
}
