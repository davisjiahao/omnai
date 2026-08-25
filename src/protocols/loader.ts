import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  ProtocolError,
  getProtocolManifest,
  listProtocolIds,
  parseProtocolId,
  protocolMetadataSchema,
  protocolRelativePath,
  type ProtocolBundle,
  type ProtocolDocument,
  type ProtocolId,
  type ProtocolMetadata,
} from './catalog.js';

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;

export async function locateProtocolRoot(candidates?: string[]): Promise<string> {
  const currentFile = fileURLToPath(import.meta.url);
  const roots = candidates ?? [
    resolve(dirname(currentFile), '../../../resources/protocols'),
    resolve(dirname(currentFile), '../../resources/protocols'),
    resolve(process.cwd(), 'resources', 'protocols'),
  ];
  const commonPath = await protocolRelativePath('common.authoritative-work');
  const match = roots.find((candidate) => existsSync(join(resolve(candidate), commonPath)));
  if (!match) {
    throw new ProtocolError(
      'PROTOCOL_PACKAGE_ROOT_NOT_FOUND',
      `Unable to locate packaged protocol resources. Checked: ${roots.map((item) => resolve(item)).join(', ')}`,
    );
  }
  return resolve(match);
}

export async function loadProtocol(
  requestedId: string,
  protocolRoot?: string,
): Promise<ProtocolDocument> {
  const id = await parseProtocolId(requestedId);
  const manifest = await getProtocolManifest(id);
  const root = protocolRoot ?? await locateProtocolRoot();
  const sourcePath = resolve(root, await protocolRelativePath(id));
  let rawBytes: Buffer;
  try {
    rawBytes = await readFile(sourcePath);
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

  const hash = hashRawBytes(rawBytes);
  if (hash !== manifest.rawBytesHash) {
    throw new ProtocolError(
      'PROTOCOL_HASH_MISMATCH',
      `Protocol '${id}' at ${sourcePath} has hash '${hash}', expected '${manifest.rawBytesHash}'.`,
    );
  }
  let fullText: string;
  try {
    fullText = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
  } catch (error) {
    throw new ProtocolError(
      'PROTOCOL_METADATA_INVALID',
      `Protocol '${id}' at ${sourcePath} is not valid UTF-8.`,
      { cause: error },
    );
  }
  const { metadata, body } = parseProtocolFile(id, sourcePath, fullText);
  validateManifestMetadata(manifest, metadata, sourcePath);

  return {
    id,
    version: metadata.version,
    hash,
    kind: metadata.kind,
    content: body,
    sourcePath,
  };
}

export async function loadProtocolBundle(
  ids: readonly string[],
  protocolRoot?: string,
): Promise<ProtocolBundle> {
  const ordered = deduplicateProtocolIds(await Promise.all(['common.authoritative-work', ...ids].map(parseProtocolId)));
  const protocols: ProtocolDocument[] = [];
  for (const id of ordered) protocols.push(await loadProtocol(id, protocolRoot));
  const rendered = protocols
    .map((document) => `<!-- protocol:${document.id}@${document.version} -->\n${document.content.trim()}`)
    .join('\n\n---\n\n') + '\n';
  return { schemaVersion: 1, protocols, rendered };
}

export async function validateCanonicalProtocolInventory(
  protocolRoot?: string,
): Promise<ProtocolDocument[]> {
  const documents: ProtocolDocument[] = [];
  for (const id of await listProtocolIds()) documents.push(await loadProtocol(id, protocolRoot));
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

function validateManifestMetadata(
  manifest: Awaited<ReturnType<typeof getProtocolManifest>>,
  metadata: ProtocolMetadata,
  sourcePath: string,
): void {
  const id = manifest.id as ProtocolId;
  if (metadata.id !== id) {
    throw metadataError(id, sourcePath, `frontmatter id '${metadata.id}' does not match the requested path.`);
  }
  if (metadata.version !== manifest.version) {
    throw metadataError(id, sourcePath, `version '${metadata.version}' must match '${manifest.version}'.`);
  }

  if (manifest.kind === 'common') {
    if (metadata.kind !== 'common') {
      throw metadataError(id, sourcePath, `kind '${metadata.kind}' must be 'common'.`);
    }
    return;
  }

  if (manifest.kind === 'repository-capability') {
    const expectedCapability = manifest.capability;
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

  if (manifest.kind === 'interaction') {
    const expectedInteraction = manifest.interaction;
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
  if (
    metadata.actions.length !== manifest.actions.length
    || metadata.actions.some((action, index) => action !== manifest.actions[index])
  ) {
    throw metadataError(id, sourcePath, 'actions must match the verified manifest exactly.');
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

function hashRawBytes(content: Uint8Array): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
