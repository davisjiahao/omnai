import type { Capability } from '../domain/types.js';
import type { ProtocolBundle } from '../protocols/catalog.js';

export function capabilityPrompt(
  capability: Capability,
  instruction: string,
  outputContract: string,
  protocols: ProtocolBundle,
): string {
  return `${protocols.rendered}\nCapability: ${capability}\n\nInstruction:\n${instruction || 'Follow the active change and scenario profile.'}\n\nOutput contract:\n${outputContract}\n`;
}
