# OmnAI v0.2 Human-Readable Communication Contract

**Status:** Authoritative cross-cutting amendment

## 1. Problem

Coding agents often compress an explanation into professional vocabulary because the vocabulary is common in training data and efficient for experts. That is useful only when the reader already shares the same domain. In multi-project work, a backend expert may still be new to product discovery, frontend interaction, AI workflow, infrastructure, or an unfamiliar business domain.

A blanket ban on terminology is also wrong. It removes precision and makes later search, review, and collaboration harder. OmnAI therefore needs a presentation contract that explains necessary terms instead of hiding or deleting them.

## 2. Decision

OmnAI provides two complementary layers:

1. **Always-on contract:** every canonical capability prompt includes the same communication rules.
2. **On-demand explanation:** the canonical `omnai` Router's Explain/Show-me protocol handles comparison, visualization, and “I do not understand” requests without changing workflow state.

The contract is host-independent and ships through the existing four canonical user-level Host Skills for Claude Code, Codex, and OpenCode. It does not add a fifth skill and does not depend on HumanLayer, Superpowers, a private renderer, or an embedded LLM API.

## 3. Terminology contract

- Lead with the conclusion and plain-language meaning.
- Define a specialized term or acronym briefly on first use.
- Retain the canonical term after defining it so the result stays precise and searchable.
- Use short sentences, concrete nouns, active voice, observable outcomes, trade-offs, and user impact.
- Calibrate depth from demonstrated familiarity in the current domain. Knowledge in one domain is not evidence of knowledge in another.
- Never replace an exact engineering constraint with a vague analogy.

## 4. Visual routing

Use the smallest representation that materially reduces understanding cost.

| Information need | Default representation | Avoid |
| --- | --- | --- |
| One fact or short explanation | Prose or short list | A diagram that repeats the prose |
| Exact alternatives, mappings, or repeated fields | Markdown table | Loose prose that hides differences |
| Flow, hierarchy, state, dependency, or multi-project relationship | Mermaid | Long linear text that obscures structure |
| Visual appearance or interaction that cannot be expressed exactly in Markdown | Available host-native visual, when accurate | Generated decoration or an image used as technical evidence |

Every visual keeps a textual takeaway and names important assumptions or exceptions. When richer host output is unavailable, Markdown and Mermaid are the deterministic fallback.

## 5. Workflow boundary

Communication is not a new OmnAI lifecycle capability. The Router's Explain/Show-me protocol:

- is read-only;
- creates no Change or canonical artifact;
- advances no readiness state;
- does not convert conversation memory into fact;
- routes missing facts to Investigation/Research;
- routes a verified conflict with active intent to Reconcile.

A direct user request may change depth or format for one response. It cannot weaken evidence, security, or workflow transition rules.

## 6. Acceptance contract

- Every value in `CAPABILITIES` receives the common communication contract through `capabilityPrompt()`.
- The native skill inventory remains exactly `omnai`, `omnai-brainstorm`, `omnai-grill`, and `omnai-reconcile`; Explain/Show-me is a protocol inside `omnai`.
- Tests verify the first-use terminology rule, depth calibration, visual router, non-decoration rule, and read-only lifecycle boundary.
