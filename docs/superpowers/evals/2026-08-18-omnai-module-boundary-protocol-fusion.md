# OmnAI Module-Boundary Protocol Fusion Evaluation

## Scope and evidence classes

This record compares the approved Task 4 baseline observations with three fresh post-change pressure tests. Each post-change report was produced by an isolated Agent given only the canonical OmnAI prompt bundle and the corresponding scenario:

- brownfield provider orchestration;
- small nullable-nickname fix; and
- disproved synchronous seam.

Two kinds of evidence are deliberately separate:

- **Deterministic tests** prove executable contracts such as scenario precedence, review-lens enforcement, prompt composition, protocol version/hash audit, and scaffold/output-contract content. The final Task 3 focused run reported 30/30 passing tests after the specialized-route regression fix.
- **Agent pressure evidence** assesses whether generated guidance is proportionate, technically useful, and resistant to shortcuts. It is qualitative evidence, not a deterministic runtime gate, release certification, or proof that every future Agent response will have the same quality.

The baseline observations are the brief's approved summaries; raw baseline transcripts are not part of this record. The committed post-change evidence below retains the scenario summaries, judgments, and limitations; the full source reports were disposable SDD artifacts and are not part of this durable record.

## Before/after comparison

| Scenario | Baseline observation | Post-change evidence | Judgment |
| --- | --- | --- | --- |
| Brownfield architecture | The baseline produced a viable broad design, but did not explicitly test depth, leverage, locality, deletion behavior, seam reality, or dependency category. | The fresh result declares `full` applicability, separates scenario assumptions from repository facts, compares three materially different shapes, assigns stable `MOD-*`/`IF-*`/`SEAM-*`/`ADP-*` IDs, distinguishes `remote-but-owned` from `true-external`, defines interface semantics and dependency direction, and makes enforcement, stable-interface evidence, expand–migrate–contract retirement, and deletion proof explicit. It rejects a persistence adapter unless Research finds genuine variation. | Boundary analysis is materially stronger and more falsifiable without treating the scenario as confirmed repository truth. |
| Small local fix | The baseline correctly kept a null guard behind a stable interface and avoided architecture ceremony. | The fresh result selects `small-feature` and `not-applicable`, keeps the test at `CustomerLabelFormatter.format(Customer)`, and explicitly rejects new ports, adapters, module IDs, migration work, alternative-shape comparison, and a full architecture review. It escalates only if investigation reveals an actual caller, contract, ownership, dependency, or stable-test-boundary change. | Small-change restraint is preserved; the new vocabulary did not force a false abstraction. |
| Disproved synchronous seam during Work | The baseline correctly stopped and reconciled instead of forcing implementation, but the repository protocol did not precisely connect the contradiction to the existing L0–L5 scope or treatment of the invalidated patch. | The fresh result distinguishes Host-assisted `BLOCKED` from v0.3 `PROJECT_WRITER` `SIGNAL`/`ASSUMPTION_INVALID`, classifies the stated contradiction as L2 with `reopenFrom: Design`, reserves L3 for a discovered domain/requirement/acceptance change, invalidates only the dependent Plan/Work/Review/Verify chain, preserves unaffected work, and retains the patch, tests, logs, findings, Revision, Baseline, and evidence as non-authoritative lineage. It rejects adapter stacking, weakened tests, silent reinterpretation, and deadline-driven compatibility facades. | The result provides exact L2/L3 selective re-entry and invalidated-artifact treatment without adapter stacking. |

## Specialized-route precedence

An input that positively matches both `architecture-governance` and a specialized boundary profile keeps the specialized route: `cross-service-change` or `shared-library` wins. This ruling is safer because those profiles carry stricter contract and compatibility gates and still consume the same module-boundary method. Letting the general architecture route win could omit required cross-service or public-API evidence even though its architecture analysis looked thorough.

Deterministic overlap regressions cover representative cross-service and public SDK/API prompts. The remaining trade-off is linguistic: a pure governance request that happens to contain a positive specialized signal may receive extra contract ceremony. That is preferable to silently dropping a required compatibility gate, but routing remains bounded by the implemented positive-match rules rather than by this prose.

## Authority boundary

The [v0.3 autonomous-execution design](../specs/2026-08-16-omnai-v0.3-autonomous-parallel-execution-design.md) and [implementation plan](../plans/2026-08-16-omnai-v0.3-autonomous-parallel-execution.md) remain authoritative for execution. The [module-boundary design](../specs/2026-08-18-omnai-v0.3-module-boundary-protocol-fusion-design.md) is a repository-protocol amendment: it guides repository artifacts and review but creates no execution aggregate, permission, state transition, schema, claim, packet, commit, or recovery authority.

The currently installed Host surface is exactly four Entry Skills: `omnai`, `omnai-grill`, `omnai-brainstorm`, and `omnai-reconcile`. This amendment adds no Entry Skill. The separately approved execution plan may add `omnai-run` only after C4 certification; these pressure results neither implement nor satisfy that gate.

## Remaining ambiguities and limits

- The brownfield scenario supplies no source tree, authoritative contract, domain model, history, SLOs, or actual dependency graph. Its recommended shape is a disciplined hypothesis pending Research and the applicable human decision, not an approved repository design.
- The small fix still requires characterization of the exact established no-nickname output if the repository does not already state it.
- The wrong-seam scenario does not supply the full `WorkerResult` serialization, machine-readable reason token, concrete revision/task IDs, dependency graph, or proof that a Specification artifact exists. Those details must come from authoritative runtime/repository state; the Agent correctly did not invent them.
- Three isolated scenarios provide meaningful pressure but not exhaustive language, stack, domain, or Host coverage. Generated prose can still vary, so deterministic Core gates remain the enforcement boundary.
- This evaluation does not claim C4 certification or public `omnai-run` availability. Full-repository verification of the integrated amendment is recorded separately below.

## Evaluation conclusion

The amendment passes the intended qualitative pressure test: it preserves restraint for a stable-interface fix, makes a consequential brownfield boundary decision substantially more explicit and testable, and turns an invalid seam into precise L2/L3 selective re-entry with preserved non-authoritative lineage. The result strengthens repository reasoning without acquiring execution authority.

## Final integrated verification

The amendment was integrated against the pinned clean Milestone C commit `a55de78c87aa36d1fe915ddacdd28a9b2ba9ae61` (`feat: add deterministic Agent profiles`) in merge commit `25973e534e8f1f133d298764cd82fb3f14de7847`. The source development branch later advanced to `7a37ba810c82631254f32b4330c8b2d38b49c0e5`; verification intentionally stayed pinned and did not mutate that checkout. The source checkout was clean when Task 5 began, but final read-only status checks found externally introduced modifications including `docs/superpowers/plans/2026-08-16-omnai-v0.3-autonomous-parallel-execution.md`, `docs/superpowers/specs/2026-08-16-omnai-v0.3-autonomous-parallel-execution-design.md`, `src/execution/agents/profiles.ts`, and `test/execution-agent-profiles.test.ts`.

- `npm run typecheck`, `npm run check`, `TMPDIR=/dev/shm node --test dist/test/*.test.js`, and `npm pack --dry-run` were rejected by the Work runner before child-process execution because the `npm` executable, including the `protocol-doctor.test.js` child `npm pack`, was classified as a network action. Those commands therefore have no process exit code and the exclusion is environment-only.
- The approved equivalents `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` and `node node_modules/typescript/bin/tsc -p tsconfig.json` each exited 0. The exact focused command over the nine named compiled test files exited 0 with 38/38 tests passing.
- The full compiled suite equivalent excluded only `dist/test/protocol-doctor.test.js` and ran the other 63 `dist/test/*.test.js` files with `TMPDIR=/dev/shm`; it exited 0 with 286/286 tests passing, 0 failed, skipped, cancelled, or todo.
- npm's installed `libnpmpack` constructed `omnai@0.2.0` locally with exit 0: 290,333 bytes, SHA-1 `749afe2a67b3368227ae35157d97caea6c30669a`, integrity `sha512-h1ilh5dP0S+214bQ2cXphCXkYYd3v4HXWrFI/7p5tQE8Qe0jjbMFJk9fM5QWHvirb4zJmbmUCBO7R9r9EqERTA==`. Its inventory had 419/419 unique entries, all 40 protocol Markdown resources, both required common/Show-me resources, and exactly the four existing Host Skill files. This reproduces the excluded package construction/inventory assertions. `git diff --check` exited 0.
- Deterministic range checks from the pinned base to the integrated merge showed unchanged sets of four Host Skill paths, 40 protocol resource paths and IDs, 19 scenario IDs, and 20 readiness keys. The Capability/catalog, review-lens, task, review, and execution schema surfaces were unchanged. Exactly eight existing repository protocol versions changed, all from 1 to 2: `design`, `plan`, `reconcile`, `research`, `review`, `spec`, `verify`, and `work`. No Host Skill, Capability, protocol ID, scenario, readiness key, review lens, or task/review/execution schema was added.
- Focused deterministic coverage verified that prepared prompts and manifests agree on exact protocol version and prompt-byte hash, specialized cross-service/public-SDK routing remains authoritative, and the architecture review requirement remains attached to the existing lens. The isolated feature worktree was clean after its evidence commit. The source development worktree was not clean at the final check because of external modifications, so the requested both-clean invariant is not satisfied; Task 5 did not write to or otherwise mutate that checkout.
