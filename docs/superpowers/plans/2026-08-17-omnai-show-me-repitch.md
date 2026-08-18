# OmnAI Show-me Re-pitch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Show-me recover from an explicitly failed explanation by restoring missing context and escalating repeated failures without creating a new Skill or workflow state.

**Architecture:** Keep Host discovery and Core routing in the existing thin `omnai` Entry Skill. Put the complete conditional response contract in the canonical `interaction.show-me` protocol, and verify the observable trigger, negative boundary, response shape, and repeated-failure escalation through deterministic contract tests.

**Tech Stack:** Markdown protocol resources, Agent Skills Markdown, TypeScript Node test runner.

## Global Constraints

- Keep exactly four Host-discoverable Entry Skills.
- Keep `interaction.show-me` read-only and noncanonical.
- Do not add a `Capability`, Workset action, readiness key, or Workset `InteractionMode` value.
- Do not automatically start the Visual Companion; retain the existing representation ladder and just-in-time consent.
- Preserve the unrelated autonomous-parallel-execution work already present in the worktree.

---

### Task 1: Add and verify Re-pitch behavior

**Files:**
- Create: `docs/superpowers/specs/2026-08-17-omnai-show-me-repitch-design.md`
- Create: `docs/superpowers/plans/2026-08-17-omnai-show-me-repitch.md`
- Modify: `test/show-me-protocol.test.ts`
- Modify: `test/skill-contract.test.ts`
- Modify: `resources/protocols/interaction/show-me.md`
- Modify: `skills/omnai/SKILL.md`
- Modify: `docs/design/README.md`
- Modify: `docs/design/omnai-v0.2-b2b-user-host-skills.md`
- Modify: `docs/superpowers/plans/2026-08-15-omnai-v0.2-b2b-internal-protocol-resources.md`
- Modify: `docs/superpowers/specs/2026-08-15-omnai-v0.2-b2b-internal-protocol-resources-design.md`

**Interfaces:**
- Consumes: existing `interaction.show-me` protocol loading and the four-Skill Host discovery surface.
- Produces: a conditional Re-pitch contract discoverable through the existing `omnai` Entry Skill.

- [x] **Step 1: Write failing protocol and discovery tests**

Add a focused test that requires the Show-me resource to contain:

```text
Re-pitch after comprehension failure
an explicit signal that the current or previous explanation did not land
a negative boundary for first explanations and summary-only requests
current conversational position and purpose
the nearest missing premise
one causal step at a time with explicit referents
plain-language gloss plus stable canonical term
one small concrete example or the smallest adequate representation
repeated-failure escalation by stepping back or changing representation
an explicit prohibition against mere compression into terse fragments
```

Update the Skill contract to require the discovery description to mention a prior explanation that did not land.

- [x] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm run build
node --test dist/test/show-me-protocol.test.js dist/test/skill-contract.test.js
```

Expected: the new Re-pitch assertions fail because the protocol and discovery description do not yet contain the contract.

- [x] **Step 3: Add the minimal protocol and Entry Skill wording**

Add the approved conditional response shape to `resources/protocols/interaction/show-me.md`. Keep `skills/omnai/SKILL.md` thin: update only discovery and routing-trigger wording, without embedding the Re-pitch method.

- [x] **Step 4: Update authoritative design documentation**

Record the branch trigger, negative boundary, repeated-failure escalation, and non-state nature in the v0.2 protocol design and the concise design README.

- [x] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
npm run build
node --test dist/test/show-me-protocol.test.js dist/test/skill-contract.test.js
```

Expected: all focused tests pass.

- [x] **Step 6: Run repository verification**

Run:

```bash
npm run check
npm pack --dry-run
git diff --check
```

Expected: typecheck, all Node tests, build, package inventory, and whitespace checks pass.

In the restricted Work runner, the equivalent local commands are `tsc --noEmit`, `tsc`, isolated Node test execution with `TMPDIR=/dev/shm`, and npm's bundled `libnpmpack`. This avoids a false network approval on the `npm` executable while exercising the same compiler, tests, and package inventory.

- [x] **Step 7: Review the final diff**

Confirm that only the planned Show-me files and the two new planning documents changed. Preserve the pre-existing v0.3 commits `2e056d2` and `6cb4a12` without amending or including their files in this change.
