import {
  agentProfileSchema,
  type AgentProfile,
  type AgentSessionAdapter,
} from './types.js';

export type NativeAdapterFactory = (profile: AgentProfile) => AgentSessionAdapter;

export class NativeAdapterRegistry {
  private readonly factories = new Map<string, NativeAdapterFactory>();

  register(protocolId: string, factory: NativeAdapterFactory): void {
    if (protocolId.length === 0) throw new Error('NATIVE_ADAPTER_PROTOCOL_INVALID');
    if (this.factories.has(protocolId)) {
      throw new Error(`NATIVE_ADAPTER_PROTOCOL_DUPLICATE: ${protocolId}`);
    }
    this.factories.set(protocolId, factory);
  }

  create(profileInput: AgentProfile): AgentSessionAdapter {
    const profile = agentProfileSchema.parse(profileInput);
    if (profile.protocol !== 'native') {
      throw new Error(`NATIVE_ADAPTER_PROFILE_NOT_NATIVE: ${profile.agentId}`);
    }
    const factory = this.factories.get(profile.protocol);
    if (factory === undefined) {
      throw new Error(`NATIVE_ADAPTER_PROTOCOL_UNREGISTERED: ${profile.protocol}`);
    }
    return factory(profile);
  }
}
