import type { Capability, FlowPlan, ScenarioProfile } from '../domain/types.js';
import { FLOW_CAPABILITY_ORDER } from './flow.js';

export function repositoryRouteOrder(
  flow: FlowPlan,
  scenario: ScenarioProfile,
): Capability[] {
  const active = new Set(
    flow.capabilities
      .filter(({ active: capabilityActive }) => capabilityActive)
      .map(({ capability }) => capability),
  );
  const floor = scenario.stages.filter((capability) => active.has(capability));
  const floorCapabilities = new Set(floor);
  const promoted = FLOW_CAPABILITY_ORDER.filter((capability) => (
    active.has(capability) && !floorCapabilities.has(capability)
  ));
  const order: Capability[] = [];
  let promotedIndex = 0;

  for (const capability of floor) {
    const canonicalIndex = FLOW_CAPABILITY_ORDER.indexOf(capability);
    while (
      promotedIndex < promoted.length
      && FLOW_CAPABILITY_ORDER.indexOf(promoted[promotedIndex]!) < canonicalIndex
    ) {
      order.push(promoted[promotedIndex]!);
      promotedIndex += 1;
    }
    order.push(capability);
  }
  return [...order, ...promoted.slice(promotedIndex)];
}
