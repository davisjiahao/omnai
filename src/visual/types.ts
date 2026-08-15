import { stat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

const MAX_DOCUMENT_BYTES = 256 * 1024;
const identifierSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const titleSchema = z.string().trim().min(1).max(120);
const sentenceSchema = z.string().trim().min(1).max(500);
const detailSchema = z.string().trim().min(1).max(240);

const commonShape = {
  schemaVersion: z.literal(1),
  title: titleSchema,
  summary: sentenceSchema,
};

const directionsDocumentSchema = z.object({
  ...commonShape,
  kind: z.literal('directions'),
  directions: z.array(z.object({
    id: identifierSchema,
    name: titleSchema,
    emphasis: sentenceSchema,
    userImpact: sentenceSchema,
    tradeoff: sentenceSchema,
    details: z.array(detailSchema).max(6).default([]),
  }).strict()).min(2).max(4),
}).strict();

const flowDocumentSchema = z.object({
  ...commonShape,
  kind: z.literal('flow'),
  nodes: z.array(z.object({
    id: identifierSchema,
    label: titleSchema,
    description: sentenceSchema,
    status: z.string().trim().min(1).max(40).optional(),
  }).strict()).min(2).max(12),
  edges: z.array(z.object({
    from: identifierSchema,
    to: identifierSchema,
    label: z.string().trim().min(1).max(80).optional(),
  }).strict()).min(1).max(24),
}).strict();

const stepThroughDocumentSchema = z.object({
  ...commonShape,
  kind: z.literal('step-through'),
  overview: sentenceSchema,
  steps: z.array(z.object({
    id: identifierSchema,
    title: titleSchema,
    description: sentenceSchema,
    changes: z.array(detailSchema).min(1).max(6),
  }).strict()).min(2).max(12),
}).strict();

export const visualCompanionDocumentSchema = z.discriminatedUnion('kind', [
  directionsDocumentSchema,
  flowDocumentSchema,
  stepThroughDocumentSchema,
]).superRefine((document, context) => {
  const items = document.kind === 'directions'
    ? document.directions
    : document.kind === 'flow'
      ? document.nodes
      : document.steps;
  const ids = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (ids.has(item.id)) {
      context.addIssue({
        code: 'custom',
        path: [document.kind === 'directions' ? 'directions' : document.kind === 'flow' ? 'nodes' : 'steps', index, 'id'],
        message: `Duplicate visual item id '${item.id}'.`,
      });
    }
    ids.add(item.id);
  }
  if (document.kind !== 'flow') return;
  for (const [index, edge] of document.edges.entries()) {
    if (!ids.has(edge.from)) {
      context.addIssue({ code: 'custom', path: ['edges', index, 'from'], message: `Unknown node '${edge.from}'.` });
    }
    if (!ids.has(edge.to)) {
      context.addIssue({ code: 'custom', path: ['edges', index, 'to'], message: `Unknown node '${edge.to}'.` });
    }
  }
});

export type VisualCompanionDocument = z.infer<typeof visualCompanionDocumentSchema>;

export async function loadVisualCompanionDocument(path: string): Promise<VisualCompanionDocument> {
  const sourcePath = resolve(path);
  let metadata;
  try {
    metadata = await stat(sourcePath);
  } catch (error) {
    throw visualDocumentError(`Cannot read '${sourcePath}'.`, error);
  }
  if (!metadata.isFile()) throw visualDocumentError(`'${sourcePath}' is not a file.`);
  if (metadata.size > MAX_DOCUMENT_BYTES) {
    throw visualDocumentError(`'${sourcePath}' exceeds the ${MAX_DOCUMENT_BYTES}-byte limit.`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(sourcePath, 'utf8')) as unknown;
  } catch (error) {
    throw visualDocumentError(`'${sourcePath}' is not valid JSON.`, error);
  }
  const parsed = visualCompanionDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw visualDocumentError(`'${sourcePath}' failed validation: ${detail}`);
  }
  return parsed.data;
}

function visualDocumentError(message: string, cause?: unknown): Error {
  return new Error(`Invalid visual companion document: ${message}`, cause === undefined ? undefined : { cause });
}
