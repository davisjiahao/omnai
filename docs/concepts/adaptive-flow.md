# Adaptive Flow

OmnAI chooses the smallest safe route for the active Project Change. The route
is adaptive, but it is not improvised by an Agent: Core compiles `flow.yaml`
from the Scenario, risk, impact, accepted assessment, and Decision records, then
combines that plan with current Readiness whenever `omnai next` runs.

## The Scenario order is the safety floor

Every Scenario still defines an ordered list of required capabilities. Adaptive
routing may add a conditional capability, but it cannot remove, downgrade, or
reorder that required floor. This keeps a small feature small while preserving
the stronger sequence required by a migration, incident, or domain-heavy
change.

Existing Changes without `flow.yaml` retain the exact legacy Scenario route.
They become adaptive only after an explicit `omnai flow migrate`; migration
does not mark any capability ready.

## When the adaptive capabilities apply

- **Grill** is the interaction overlay for one blocking, human-owned Decision.
  It accompanies the repository capability that owns the question; it is not a
  separate repository stage.
- **Brainstorm** accompanies Design when a solution or architecture Decision
  has at least two viable, source-backed options and upstream blockers are
  settled.
- **Map** is required for program-scale work. It records the destination,
  decision frontier, blockers, fog, excluded scope, and program checkpoints.
- **Model** applies when domain language, ownership, lifecycle, boundaries, or
  invariants remain uncertain.
- **codebase-design** is a lens inside repository protocols, not a Host Skill.
  It becomes focused or full for cross-module ownership, stable interface,
  dependency-direction, migration, seam, or placement questions. Local text or
  unambiguous single-seam changes may record it as not applicable.

The Host surface remains exactly four Skills: `omnai`, `omnai-grill`,
`omnai-brainstorm`, and `omnai-reconcile`. Map, Model, codebase-design, planning,
review, and verification remain Core-selected repository protocols.

## Records have different jobs

| Record | Owns | Does not own |
| --- | --- | --- |
| **Decision** | One question, owner, options, resolution, affected capabilities, and source evidence | Implementation steps |
| **FlowPlan** | The accepted assessment and required or conditional capability route for one Revision/Baseline | Requirements, design prose, task instructions, or test results |
| **Task** | One executable project-local slice and its local dependencies | Cross-project coordination or unresolved choices |
| **RunPacket** | An immutable Milestone C execution input bound to exact Tasks and source identities | Conversational routing or authority to weaken Core gates |
| **Attention** | A bounded human or external blocker encountered by execution | A replacement for Decision or Task state |

`tasks.yaml` remains a project-local graph. A Task can depend only on Task IDs
in the same file. Multi-project work coordinates immutable contracts and
integration evidence; it never connects repository Task graphs.

## Typical routes

### Fast path

A clear, untouched `small-feature` starts at Spec with no interaction overlay:

```text
Spec -> Design applicability -> Plan -> Work -> Verify -> Archive
```

### Standard domain path

A domain-heavy Change can add interactions only where the current Decision
state requires them:

```text
Research -> Grill + Model -> Spec -> Brainstorm + Design
         -> Plan -> Work -> Review -> Verify -> Learn -> Archive
```

### Program path

A `migration-program` preserves its Scenario floor:

```text
Frame -> Map -> Research -> Model -> Spec -> Design
      -> Plan -> Work -> Review -> Verify -> Ship -> Learn -> Archive
```

### Multi-project path

A Workset is an outer container around independent repository routes:

```text
Workset
├── provider Change -> its FlowPlan -> its project-local Tasks
└── consumer Change -> its FlowPlan -> its project-local Tasks

Coordination: ContractSnapshot references + integration evidence
```

Workset therefore is not a capability inside `flow.yaml`. Each member keeps its
own Change, Revision, Baseline, Decisions, FlowPlan, Tasks, evidence, and review.

## Reconcile is an interrupt

Reconcile is not the last step in a pipeline. A changed fact can interrupt any
active capability, archive the prior FlowPlan as
`revisions/REV-####.flow.yaml`, advance the Revision/Baseline, and invalidate
only the affected Readiness and Task closure. Unaffected work remains valid.
Evidence remains attached to the Revision that produced it, so a PASS from
`REV-0001` cannot satisfy `REV-0002`.

See [Reconcile](reconcile.md) for levels and selective invalidation.

## CLI examples

Inspect the accepted FlowPlan and its currently selected interaction:

```bash
omnai flow status --json
```

Explicitly migrate a legacy Change:

```bash
omnai flow migrate CHG-0007 --json
```

Submit an exact Revision/Baseline assessment proposal:

```bash
omnai flow assess cross-module-assessment.yaml \
  --change CHG-0007 \
  --json
```

Open and resolve a human-owned Decision through strict files:

```bash
omnai decision open domain-decision.yaml --json

omnai decision resolve DEC-0001 domain-resolution.yaml \
  --human-confirmed \
  --json
```

Agent-evidence resolution does not accept the human-confirmation flag:

```bash
omnai decision resolve DEC-0002 architecture-resolution.yaml --json
```

Ask Core for the next repository capability and ordered protocol bundle:

```bash
omnai next --json
```

The route includes the capability or Task, `protocolIds`, blocking reason,
Decision causes, active Revision, active Baseline, Flow hash, and legacy/adaptive
mode. Reading a route never marks Readiness `READY`.

## F1 release boundary

F1 releases the adaptive Core routing spine: Decision records, Flow assessment
and compilation, guarded migration and reassessment, decision-aware `next`, and
protocol composition. It does **not** release autonomous execution. `omnai run`
and an `omnai-run` Host Skill remain unavailable until the separate Milestone C
execution gates and later fusion slices are accepted.

## F1 certification evidence

The initial certification implementation is commit `ca4baa5` (`docs: certify
adaptive flow spine`). Independent-review corrections are commits `fa1bd8f`
(`test: strengthen adaptive flow certification`) and `3fd40ff` (`fix: keep
adaptive route ordering internal`). They strengthen complete-tree non-mutation
guards, add focused Scenario-order coverage, certify the focused codebase-design
lens through the compiled CLI, and keep the pure ordering helper absent from the
supported package root at runtime and in declarations. Verification used a
fresh task-specific `TMPDIR` and
`NPM_CONFIG_CACHE` under `/dev/shm`, with update notifications, audit, and fund
checks disabled. The exact commands were:

```bash
env TMPDIR=/dev/shm/omnai-task8-a43a4e5f/tmp NPM_CONFIG_CACHE=/dev/shm/omnai-task8-a43a4e5f/npm-cache NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false npm run build && env TMPDIR=/dev/shm/omnai-task8-a43a4e5f/tmp NPM_CONFIG_CACHE=/dev/shm/omnai-task8-a43a4e5f/npm-cache NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false node --test dist/test/adaptive-flow-end-to-end.test.js dist/test/critical-guard-regression.test.js dist/test/protocol-end-to-end.test.js dist/test/scenario-routing-regression.test.js dist/test/package-version.test.js

env TMPDIR=/dev/shm/omnai-task8-a43a4e5f/tmp NPM_CONFIG_CACHE=/dev/shm/omnai-task8-a43a4e5f/npm-cache NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false npm run typecheck

env TMPDIR=/dev/shm/omnai-task8-a43a4e5f/tmp NPM_CONFIG_CACHE=/dev/shm/omnai-task8-a43a4e5f/npm-cache NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false npm test

env TMPDIR=/dev/shm/omnai-task8-a43a4e5f/tmp NPM_CONFIG_CACHE=/dev/shm/omnai-task8-a43a4e5f/npm-cache NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false npm pack --dry-run

git diff --check
git status --short
```

The focused suite passed 22/22 tests. The native full suite passed 780/780 with
zero failures, cancellations, skips, or todos. The dry-run package inventory
contained 587 files (650.5 kB packed, 4.2 MB unpacked), including compiled Core
Flow/Decision/router modules, the compiled adaptive E2E, all 40 protocol
resources, exactly four Host Skill files, and README documentation. No package
archive or generated repository fixture remained, and the diff check reported
no whitespace errors.

F2 (Task lineage and generated views), F3 (review and knowledge closure), F4
(the Milestone C execution bridge), and F5 (full-flow certification) remain
separate, unclaimed work. This F1 evidence does not release autonomous
execution.
