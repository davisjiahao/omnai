import { z } from 'zod';
import { CAPABILITIES, type Capability } from '../domain/types.js';

export const WORKSET_PROTOCOL_ACTIONS = [
  'inspect-project',
  'decide-project-impact',
  'bind-project-change',
  'record-reentry',
  'reenter',
  'decide-reentry',
  'apply-reentry',
  'replan-reentry',
  'finalize-reentry',
  'project-workflow',
] as const;

export const PROTOCOL_IDS = [
  'common.authoritative-work',
  'repository.frame',
  'repository.research',
  'repository.map',
  'repository.model',
  'repository.spec',
  'repository.design',
  'repository.plan',
  'repository.triage',
  'repository.reproduce',
  'repository.debug',
  'repository.diagnose',
  'repository.experiment',
  'repository.fix',
  'repository.mitigate',
  'repository.work',
  'repository.simplify',
  'repository.review',
  'repository.verify',
  'repository.qa',
  'repository.ship',
  'repository.release',
  'repository.canary',
  'repository.learn',
  'repository.archive',
  'repository.reconcile',
  'interaction.grill',
  'interaction.brainstorm',
  'workset.candidate-research',
  'workset.project-impact-decision',
  'workset.project-change-binding',
  'workset.project-workflow-handoff',
  'workset.reentry-classification',
  'workset.reentry-interaction',
  'workset.reentry-plan',
  'workset.reentry-decision',
  'workset.reentry-apply',
  'workset.reentry-replan',
  'workset.reentry-finalize',
] as const;

export const PROTOCOL_ERROR_CODES = [
  'PROTOCOL_UNKNOWN',
  'PROTOCOL_RESOURCE_MISSING',
  'PROTOCOL_METADATA_INVALID',
  'PROTOCOL_MAPPING_MISSING',
  'PROTOCOL_PACKAGE_ROOT_NOT_FOUND',
] as const;

export type ProtocolId = (typeof PROTOCOL_IDS)[number];
export type RepositoryProtocolId = `repository.${Capability}`;
export type InteractionProtocolId = 'interaction.grill' | 'interaction.brainstorm';
export type WorksetProtocolId = Extract<ProtocolId, `workset.${string}`>;
export type ProtocolKind = 'common' | 'repository-capability' | 'interaction' | 'workset-action';
export type WorksetProtocolAction = (typeof WORKSET_PROTOCOL_ACTIONS)[number];
export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

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

const protocolIdSchema = z.enum(PROTOCOL_IDS);
const capabilitySchema = z.enum(CAPABILITIES);
const worksetActionSchema = z.enum(WORKSET_PROTOCOL_ACTIONS);

export const protocolMetadataSchema = z.discriminatedUnion('kind', [
  z.object({
    schemaVersion: z.literal(1),
    id: protocolIdSchema,
    version: z.number().int().positive(),
    kind: z.literal('common'),
  }).strict(),
  z.object({
    schemaVersion: z.literal(1),
    id: protocolIdSchema,
    version: z.number().int().positive(),
    kind: z.literal('repository-capability'),
    capability: capabilitySchema,
  }).strict(),
  z.object({
    schemaVersion: z.literal(1),
    id: protocolIdSchema,
    version: z.number().int().positive(),
    kind: z.literal('interaction'),
    interaction: z.enum(['grill', 'brainstorm']),
  }).strict(),
  z.object({
    schemaVersion: z.literal(1),
    id: protocolIdSchema,
    version: z.number().int().positive(),
    kind: z.literal('workset-action'),
    actions: z.array(worksetActionSchema).min(1),
  }).strict(),
]);

export type ProtocolMetadata = z.infer<typeof protocolMetadataSchema>;

export function parseProtocolId(value: string): ProtocolId {
  if (!(PROTOCOL_IDS as readonly string[]).includes(value)) {
    throw new ProtocolError('PROTOCOL_UNKNOWN', `Unknown protocol '${value}'.`);
  }
  return value as ProtocolId;
}

export function repositoryProtocolId(capability: Capability): RepositoryProtocolId {
  const id = `repository.${capability}` as RepositoryProtocolId;
  if (!(PROTOCOL_IDS as readonly string[]).includes(id)) {
    throw new ProtocolError(
      'PROTOCOL_MAPPING_MISSING',
      `Capability '${capability}' has no canonical repository protocol.`,
    );
  }
  return id;
}

export function protocolRelativePath(id: ProtocolId): string {
  if (id === 'common.authoritative-work') return 'common/authoritative-work.md';
  const separator = id.indexOf('.');
  if (separator <= 0 || separator === id.length - 1) {
    throw new ProtocolError('PROTOCOL_MAPPING_MISSING', `Protocol '${id}' has no canonical path mapping.`);
  }
  return `${id.slice(0, separator)}/${id.slice(separator + 1)}.md`;
}
