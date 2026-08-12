---
name: omnai-map
description: Map a large, uncertain program as a destination, decision frontier, blockers, fog, and out-of-scope work.
---

# OmnAI Wayfinding Map

1. Run `omnai map "<destination>"` and read the generated prompt.
2. Name the destination precisely enough to define scope.
3. Create decision items, not fake implementation tasks.
4. Distinguish:
   - Resolved decisions
   - Current frontier: precise, unblocked decisions
   - Blocked decisions
   - Fog: relevant unknowns not yet precise enough to ticket
   - Out-of-scope work
5. Research tickets may run in parallel; human decision tickets must not be answered by the agent on the user's behalf.
6. Update `map.yaml`. As decisions resolve, graduate newly visible fog and keep the map as an index rather than duplicating details.
