import { z } from 'zod';
import { requireVerifiedAuthorityCatalog } from '../authority/catalog-loader.js';
import {
  WORKSET_PROTOCOL_ACTIONS,
  type StageAuthorityCatalogV1,
} from '../authority/catalog-schema.js';
import { CAPABILITIES, type Capability } from '../domain/types.js';

export { WORKSET_PROTOCOL_ACTIONS };
function freezeProtocolRegistry<const Values extends readonly string[]>(values: Values): Values {
  return Object.freeze([...values]) as unknown as Values;
}

const PROTOCOL_INTERACTION_VALUES = freezeProtocolRegistry(['grill', 'brainstorm', 'show-me'] as const);
export const PROTOCOL_INTERACTIONS = freezeProtocolRegistry(PROTOCOL_INTERACTION_VALUES);
const PROTOCOL_ERROR_CODE_VALUES = freezeProtocolRegistry([
  'PROTOCOL_UNKNOWN',
  'PROTOCOL_RESOURCE_MISSING',
  'PROTOCOL_METADATA_INVALID',
  'PROTOCOL_MAPPING_MISSING',
  'PROTOCOL_PACKAGE_ROOT_NOT_FOUND',
  'PROTOCOL_HASH_MISMATCH',
] as const);
export const PROTOCOL_ERROR_CODES = freezeProtocolRegistry(PROTOCOL_ERROR_CODE_VALUES);

export type ProtocolId = string;
export type RepositoryProtocolId = `repository.${Capability}`;
export type ProtocolInteraction = (typeof PROTOCOL_INTERACTIONS)[number];
export type InteractionProtocolId = `interaction.${ProtocolInteraction}`;
export type WorksetProtocolId = `workset.${string}`;
export type ProtocolKind = 'common' | 'repository-capability' | 'interaction' | 'workset-action';
export type WorksetProtocolAction = (typeof WORKSET_PROTOCOL_ACTIONS)[number];
export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];
export type ProtocolManifest = StageAuthorityCatalogV1['protocolManifests'][number];

export interface ProtocolRef {
  id: ProtocolId;
  version: number;
  hash: string;
}

export interface ProtocolDocument extends ProtocolRef {
  kind: ProtocolKind;
  content: string;
  sourcePath: string;
}

export interface ProtocolBundle {
  schemaVersion: 1;
  protocols: ProtocolDocument[];
  rendered: string;
}

export class ProtocolError extends Error {
  constructor(
    public readonly code: ProtocolErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = 'ProtocolError';
  }
}

const protocolInteractionSchema = z.enum(PROTOCOL_INTERACTION_VALUES);
const worksetActionSchema = z.enum(freezeProtocolRegistry(WORKSET_PROTOCOL_ACTIONS));

// 背景：frontmatter 只描述已由 StageAuthorityCatalogV1 选中的资源；它本身不再承担 protocol
// inventory 权限。目的：严格解析对象形状后，由 loader 将每个字段与 manifest 逐项绑定。
// 上下文：故 id 是非空字符串而不是本地 enum，真正的成员资格必须异步查询已验证 catalog。
export const protocolMetadataSchema = z.discriminatedUnion('kind', [
  z.strictObject({ schemaVersion: z.literal(1), id: z.string().min(1), version: z.number().int().positive(), kind: z.literal('common') }),
  z.strictObject({ schemaVersion: z.literal(1), id: z.string().min(1), version: z.number().int().positive(), kind: z.literal('repository-capability'), capability: z.enum(CAPABILITIES) }),
  z.strictObject({ schemaVersion: z.literal(1), id: z.string().min(1), version: z.number().int().positive(), kind: z.literal('interaction'), interaction: protocolInteractionSchema }),
  z.strictObject({ schemaVersion: z.literal(1), id: z.string().min(1), version: z.number().int().positive(), kind: z.literal('workset-action'), actions: z.array(worksetActionSchema).min(1) }),
]);
export type ProtocolMetadata = z.infer<typeof protocolMetadataSchema>;

export async function listProtocolManifests(): Promise<readonly ProtocolManifest[]> {
  return (await requireVerifiedAuthorityCatalog()).protocolManifests;
}

export async function listProtocolIds(): Promise<readonly ProtocolId[]> {
  return (await listProtocolManifests()).map((manifest) => manifest.id);
}

export async function getProtocolManifest(value: string): Promise<ProtocolManifest> {
  const manifest = (await listProtocolManifests()).find((candidate) => candidate.id === value);
  if (!manifest) throw new ProtocolError('PROTOCOL_UNKNOWN', `Unknown protocol '${value}'.`);
  return manifest;
}

export async function parseProtocolId(value: string): Promise<ProtocolId> {
  return (await getProtocolManifest(value)).id;
}

export async function repositoryProtocolId(capability: Capability): Promise<RepositoryProtocolId> {
  const id = `repository.${capability}`;
  const manifest = await getProtocolManifest(id);
  if (manifest.kind !== 'repository-capability' || manifest.capability !== capability) {
    throw new ProtocolError('PROTOCOL_MAPPING_MISSING', `Capability '${capability}' has no canonical repository protocol.`);
  }
  return manifest.id as RepositoryProtocolId;
}

export async function protocolRelativePath(value: string): Promise<string> {
  const manifest = await getProtocolManifest(value);
  return manifest.relativePath.slice('resources/protocols/'.length);
}
