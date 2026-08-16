import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  PROTOCOL_IDS,
  ProtocolError,
  protocolMetadataSchema,
  protocolRelativePath,
  type ProtocolBundle,
  type ProtocolDocument,
  type ProtocolId,
  type ProtocolMetadata,
} from './catalog.js';

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;

export function locateProtocolRoot(candidates?: string[]): string {
  const currentFile = fileURLToPath(import.meta.url);
  const roots = candidates ?? [
    resolve(dirname(currentFile), '../../../resources/protocols'),
    resolve(dirname(currentFile), '../../resources/protocols'),
    resolve(process.cwd(), 'resources', 'protocols'),
  ];
  const match = roots.find((candidate) =>
    existsSync(join(resolve(candidate), protocolRelativePath('common.authoritative-work'))),
  );
  if (!match) {
    throw new ProtocolError(
      'PROTOCOL_PACKAGE_ROOT_NOT_FOUND',
      `Unable to locate packaged protocol resources. Checked: ${roots.map((item) => resolve(item)).join(', ')}`,
    );
  }
  return resolve(match);
}

export async function loadProtocol(
  id: ProtocolId,
  protocolRoot = locateProtocolRoot(),
): Promise<ProtocolDocument> {
  const sourcePath = resolve(protocolRoot, protocolRelativePath(id));
  let fullText: string;
  try {
    fullText = await readFile(sourcePath, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new ProtocolError(
        'PROTOCOL_RESOURCE_MISSING',
        `Protocol '${id}' was not found at ${sourcePath}.`,
        { cause: error },
      );
    }
    throw error;
  }

  const { metadata, body } = parseProtocolFile(id, sourcePath, fullText);
  validateIdSpecificMetadata(id, metadata, sourcePath);

  return {
    id,
    version: metadata.version,
    hash: hashText(fullText),
    kind: metadata.kind,
    content: body,
    sourcePath,
  };
}

export async function loadProtocolBundle(
  ids: ProtocolId[],
  protocolRoot = locateProtocolRoot(),
): Promise<ProtocolBundle> {
  const ordered = deduplicateProtocolIds(['common.authoritative-work', ...ids]);
  const protocols: ProtocolDocument[] = [];
  for (const id of ordered) protocols.push(await loadProtocol(id, protocolRoot));
  const rendered = protocols
    .map((document) => `<!-- protocol:${document.id}@${document.version} -->\n${document.content.trim()}`)
    .join('\n\n---\n\n') + '\n';
  return { schemaVersion: 1, protocols, rendered };
}

export async function validateCanonicalProtocolInventory(
  protocolRoot = locateProtocolRoot(),
): Promise<ProtocolDocument[]> {
  const documents: ProtocolDocument[] = [];
  for (const id of PROTOCOL_IDS) documents.push(await loadProtocol(id, protocolRoot));
  return documents;
}

function parseProtocolFile(
  id: ProtocolId,
  sourcePath: string,
  fullText: string,
): { metadata: ProtocolMetadata; body: string } {
  const match = FRONTMATTER_PATTERN.exec(fullText);
  if (!match) {
    throw new ProtocolError(
      'PROTOCOL_METADATA_INVALID',
      `Protocol '${id}' at ${sourcePath} must contain YAML frontmatter delimited by '---'.`,
    );
  }

  let rawMetadata: unknown;
  try {
    rawMetadata = YAML.parse(match[1] ?? '');
  } catch (error) {
    throw new ProtocolError(
      'PROTOCOL_METADATA_INVALID',
      `Protocol '${id}' at ${sourcePath} contains invalid YAML frontmatter.`,
      { cause: error },
    );
  }

  const parsed = protocolMetadataSchema.safeParse(rawMetadata);
  if (!parsed.success) {
    throw new ProtocolError(
      'PROTOCOL_METADATA_INVALID',
      `Protocol '${id}' at ${sourcePath} has invalid metadata: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return { metadata: parsed.data, body: match[2] ?? '' };
}

function validateIdSpecificMetadata(
  id: ProtocolId,
  metadata: ProtocolMetadata,
  sourcePath: string,
): void {
  if (metadata.id !== id) {
    throw metadataError(id, sourcePath, `frontmatter id '${metadata.id}' does not match the requested path.`);
  }

  if (id === 'common.authoritative-work') {
    if (metadata.kind !== 'common') {
      throw metadataError(id, sourcePath, `kind '${metadata.kind}' must be 'common'.`);
    }
    return;
  }

  if (id.startsWith('repository.')) {
    const expectedCapability = id.slice('repository.'.length);
    if (metadata.kind !== 'repository-capability') {
      throw metadataError(id, sourcePath, `kind '${metadata.kind}' must be 'repository-capability'.`);
    }
    if (metadata.capability !== expectedCapability) {
      throw metadataError(
        id,
        sourcePath,
        `capability '${metadata.capability}' must match '${expectedCapability}'.`,
      );
    }
    return;
  }

  if (id.startsWith('interaction.')) {
    const expectedInteraction = id.slice('interaction.'.length);
    if (metadata.kind !== 'interaction') {
      throw metadataError(id, sourcePath, `kind '${metadata.kind}' must be 'interaction'.`);
    }
    if (metadata.interaction !== expectedInteraction) {
      throw metadataError(
        id,
        sourcePath,
        `interaction '${metadata.interaction}' must match '${expectedInteraction}'.`,
      );
    }
    return;
  }

  if (metadata.kind !== 'workset-action') {
    throw metadataError(id, sourcePath, `kind '${metadata.kind}' must be 'workset-action'.`);
  }
}

function metadataError(id: ProtocolId, sourcePath: string, detail: string): ProtocolError {
  return new ProtocolError(
    'PROTOCOL_METADATA_INVALID',
    `Protocol '${id}' at ${sourcePath}: ${detail}`,
  );
}

function deduplicateProtocolIds(ids: ProtocolId[]): ProtocolId[] {
  const seen = new Set<ProtocolId>();
  const ordered: ProtocolId[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  return ordered;
}

function hashText(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
