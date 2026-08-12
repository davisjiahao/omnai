import type { Capability } from '../domain/types.js';

const common = `You are executing an OmnAI native workflow capability.\n\nRules:\n- Treat code, configuration, approved artifacts, Git history, and fresh evidence as facts.\n- Treat conversation memory as supplementary context, never as the source of truth.\n- Do not silently change upstream intent. Surface conflicts as an OmnAI reconcile signal.\n- Stay within the declared capability. Do not begin a later capability automatically.\n- Preserve evidence references and distinguish confirmed facts from assumptions.\n`;

const stagePrompts: Record<Capability, string> = {
  frame: `Challenge the product framing before technical design. Establish target user, painful status quo, concrete demand, narrowest valuable wedge, success signal, scope, and non-goals. Do not design implementation yet.`,
  research: `Document the codebase as it exists today. Read explicitly referenced inputs first. Decompose the question into focused searches. Locate entry points, trace behavior and dependencies, find similar patterns, and cite exact paths and lines. Do not propose refactors unless the instruction explicitly asks for recommendations.`,
  map: `Create a destination-oriented decision map for work too large or uncertain for one session. Separate resolved decisions, current frontier, blocked decisions, fog that is not yet precise enough to ticket, and out-of-scope work. Do not pretend the fog is known.`,
  model: `Build a design tree of domain decisions. Ask only frontier questions whose prerequisites are settled. Research environmental facts yourself. Challenge overloaded terminology, test boundaries with concrete edge cases, define lifecycle, ownership, invariants, and propose ADRs only for hard-to-reverse trade-offs.`,
  spec: `Express the change as intent, not implementation. Use added, modified, removed, and preserved requirements with stable acceptance-criterion IDs, compatibility expectations, non-goals, and open questions. The specification must be observable and testable.`,
  design: `Explore 2-3 viable approaches, recommend one with trade-offs, and describe components, interfaces, data flow, state, errors, security, observability, testing, deployment, migration, and rollback. Scale depth to risk and complexity.`,
  plan: `Create a dependency-ordered task graph. Prefer independently demoable vertical slices; use contract-first or risk-first slices when appropriate. Use expand-migrate-contract for wide refactors. Every task needs exact scope, files, interfaces, steps, and evidence. No placeholders.`,
  reproduce: `Turn the reported symptom into a deterministic reproduction or a concrete instrumentation plan. Record exact conditions, inputs, expected behavior, actual behavior, and evidence. Do not propose fixes yet.`,
  diagnose: `Find root cause before fixes. Trace data across component boundaries, compare working and broken patterns, state one hypothesis at a time, and run the smallest experiment that can disprove it. After repeated failed hypotheses, question the architecture rather than stacking guesses.`,
  mitigate: `Reduce active harm while preserving evidence. Separate containment from root-cause correction. Prefer reversible actions, document side effects, and identify what still requires investigation.`,
  work: `Implement only the selected task from its context packet. Use a failing behavioral test before production code when behavior changes. Keep the change incremental, compilable, rollback-friendly, and within allowed paths. Report DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, or BLOCKED.`,
  simplify: `Simplify the recent change without altering behavior. Remove unearned abstractions, duplication, and needless indirection. Do not expand the task into unrelated cleanup. Re-run relevant evidence after edits.`,
  review: `Review from fresh context against the artifact contract. Separate specification compliance from code quality. Identify correctness, security, operational, performance, testing, and maintainability issues. Findings are data, not automatic verdicts.`,
  verify: `Gather fresh evidence for every completion claim. Run the full command that proves each claim, read exit codes and failures, verify acceptance criteria line by line, and record honest PASS, FAIL, or INCONCLUSIVE results.`,
  qa: `Exercise the actual user experience. Cover critical flows first, then medium and cosmetic issues according to the requested tier. Capture reproducible evidence, verify each fix, and distinguish report-only from edit mode.`,
  release: `Promote a verified artifact using the repository's delivery contract. Separate deployment from release and activation. Check approvals, rollout strategy, rollback capabilities, and post-release verification before progressing traffic.`,
  canary: `Observe the released change over a bounded window using technical and business signals. Pause or reverse promotion on threshold violations and record evidence for the decision.`,
  learn: `Capture one durable, evidence-backed learning. State the problem, context, root cause, solution, verification, applicability, limitations, and invalidation conditions. Do not promote temporary observations or unverified guesses.`,
  archive: `Confirm intent, artifacts, implementation, and evidence agree. Promote only approved durable knowledge, preserve revision history, and mark the change archived without deleting its audit trail.`,
  reconcile: `Classify the new signal by change level, identify affected artifacts and tasks, preserve the previous revision, apply selective invalidation, create the smallest required revision, and resume unaffected work.`,
};

export function capabilityPrompt(capability: Capability, instruction: string, outputContract: string): string {
  return `${common}\nCapability: ${capability}\n\nInstruction:\n${instruction || 'Follow the active change and scenario profile.'}\n\nMethod:\n${stagePrompts[capability]}\n\nOutput contract:\n${outputContract}\n`;
}
