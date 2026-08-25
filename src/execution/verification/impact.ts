import { z } from 'zod';
import { hashObject } from '../hashing.js';
import { contentHashSchema, type ContentHash } from '../types.js';

export const IMPACT_GRAPH_NODE_KINDS = [
  'SOURCE',
  'TASK',
  'CONTRACT_SNAPSHOT',
  'TEST_CASE',
  'VERIFICATION_PLAN',
  'WAVE_MEMBER',
  'RUN',
  'ENVIRONMENT_INPUT',
  'COMMITSET',
] as const;

export type ImpactGraphNodeKind = (typeof IMPACT_GRAPH_NODE_KINDS)[number];

export const impactGraphNodeSchema = z.strictObject({
  kind: z.enum(IMPACT_GRAPH_NODE_KINDS),
  ref: z.string().min(1),
  contentHash: contentHashSchema,
});
export type ImpactGraphNode = z.infer<typeof impactGraphNodeSchema>;

export const impactGraphEdgeSchema = z.strictObject({
  from: impactGraphNodeSchema,
  to: impactGraphNodeSchema,
});
export type ImpactGraphEdge = z.infer<typeof impactGraphEdgeSchema>;

export const impactRootSchema = z.strictObject({
  node: impactGraphNodeSchema,
  previousContentHash: contentHashSchema.nullable(),
}).superRefine((root, context) => {
  if (root.previousContentHash === root.node.contentHash) {
    context.addIssue({ code: 'custom', path: ['previousContentHash'], message: 'IMPACT_ROOT_UNCHANGED' });
  }
});
export type ImpactRoot = z.infer<typeof impactRootSchema>;

export const impactClosureSchema = z.strictObject({
  schemaVersion: z.literal(1),
  worksetId: z.string().regex(/^WKS-\d{4}$/),
  scopeHash: contentHashSchema,
  roots: z.array(impactRootSchema).min(1).readonly(),
  affected: z.array(impactGraphNodeSchema).min(1).readonly(),
  traversedEdges: z.array(impactGraphEdgeSchema).readonly(),
  contentHash: contentHashSchema,
}).superRefine((closure, context) => {
  requireSortedUnique(closure.roots, impactRootKey, 'roots', context);
  requireUniqueRootNodes(closure.roots, context);
  requireSortedUnique(closure.affected, impactNodeKey, 'affected', context);
  requireSortedUnique(closure.traversedEdges, impactEdgeKey, 'traversedEdges', context);
  validateImpactClosureSemantics(closure, context);
  if (closure.contentHash !== hashImpactClosure(closure)) {
    context.addIssue({ code: 'custom', path: ['contentHash'], message: 'IMPACT_CLOSURE_CONTENT_HASH_MISMATCH' });
  }
});
export type ImpactClosure = z.infer<typeof impactClosureSchema>;

export interface CompileImpactClosureInput {
  readonly worksetId: string;
  readonly scopeHash: ContentHash;
  readonly roots: readonly ImpactRoot[];
  readonly nodes: readonly ImpactGraphNode[];
  readonly edges: readonly ImpactGraphEdge[];
}

const compileImpactClosureInputSchema = z.strictObject({
  worksetId: z.string().regex(/^WKS-\d{4}$/),
  scopeHash: contentHashSchema,
  roots: z.array(z.unknown()).min(1).readonly(),
  nodes: z.array(z.unknown()).readonly(),
  edges: z.array(z.unknown()).readonly(),
});

export type InvalidationAction =
  | 'RECOMPUTE_CLOSURE'
  | 'RECOMPILE_PLAN'
  | 'BLOCK_OR_SUPERSEDE'
  | 'MARK_STALE'
  | 'REQUIRE_RERUN'
  | 'REQUIRE_REVALIDATION';

export type ImpactClosureErrorCode =
  | 'IMPACT_CLOSURE_INPUT_INVALID'
  | 'IMPACT_CLOSURE_SEMANTIC_MISMATCH'
  | 'IMPACT_CONFLICTING_ROOT'
  | 'IMPACT_DUPLICATE_EDGE'
  | 'IMPACT_DUPLICATE_NODE'
  | 'IMPACT_DUPLICATE_ROOT'
  | 'IMPACT_EDGE_ENDPOINT_MISSING'
  | 'IMPACT_ROOT_NODE_MISSING'
  | 'IMPACT_ROOT_UNCHANGED';

export class ImpactClosureError extends Error {
  constructor(readonly code: ImpactClosureErrorCode, readonly detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'ImpactClosureError';
  }
}

export function compileImpactClosure(input: CompileImpactClosureInput): ImpactClosure {
  const parsedInput = parseCompileImpactClosureInput(input);
  const nodes = canonicalUnique(
    parsedInput.nodes.map((item) => parseImpactValue(impactGraphNodeSchema, item)),
    impactNodeKey,
    'IMPACT_DUPLICATE_NODE',
  );
  const nodeKeys = new Set(nodes.map(impactNodeKey));
  const edges = canonicalUnique(
    parsedInput.edges.map((item) => parseImpactValue(impactGraphEdgeSchema, item)),
    impactEdgeKey,
    'IMPACT_DUPLICATE_EDGE',
  );
  for (const graphEdge of edges) {
    if (!nodeKeys.has(impactNodeKey(graphEdge.from)) || !nodeKeys.has(impactNodeKey(graphEdge.to))) {
      throw impactClosureError('IMPACT_EDGE_ENDPOINT_MISSING');
    }
  }
  const parsedRoots = parsedInput.roots.map(parseImpactRoot);
  const previousByCurrentNode = new Map<string, ContentHash | null>();
  for (const changedRoot of parsedRoots) {
    const currentNodeKey = impactNodeKey(changedRoot.node);
    if (previousByCurrentNode.has(currentNodeKey)) {
      const previous = previousByCurrentNode.get(currentNodeKey);
      const code = previous === changedRoot.previousContentHash
        ? 'IMPACT_DUPLICATE_ROOT'
        : 'IMPACT_CONFLICTING_ROOT';
      throw impactClosureError(code);
    }
    previousByCurrentNode.set(currentNodeKey, changedRoot.previousContentHash);
  }
  const roots = canonicalUnique(
    parsedRoots,
    impactRootKey,
    'IMPACT_DUPLICATE_ROOT',
  );
  for (const changedRoot of roots) {
    if (!nodeKeys.has(impactNodeKey(changedRoot.node))) {
      throw impactClosureError('IMPACT_ROOT_NODE_MISSING');
    }
  }

  const nodesByKey = new Map(nodes.map((item) => [impactNodeKey(item), item] as const));
  const outgoing = new Map<string, ImpactGraphEdge[]>();
  for (const graphEdge of edges) {
    const fromKey = impactNodeKey(graphEdge.from);
    const current = outgoing.get(fromKey) ?? [];
    current.push(graphEdge);
    outgoing.set(fromKey, current);
  }
  for (const graphEdges of outgoing.values()) {
    graphEdges.sort((left, right) => compare(impactEdgeKey(left), impactEdgeKey(right)));
  }

  const visited = new Set(roots.map((item) => impactNodeKey(item.node)));
  const queue = [...visited].sort(compare);
  const traversed: ImpactGraphEdge[] = [];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    for (const graphEdge of outgoing.get(current) ?? []) {
      traversed.push(graphEdge);
      const target = impactNodeKey(graphEdge.to);
      if (!visited.has(target)) {
        visited.add(target);
        queue.push(target);
      }
    }
  }

  const affected = [...visited]
    .map((key) => nodesByKey.get(key)!)
    .sort((left, right) => compare(impactNodeKey(left), impactNodeKey(right)));
  const traversedEdges = canonicalUnique(traversed, impactEdgeKey, 'IMPACT_DUPLICATE_EDGE');
  const identity = {
    schemaVersion: 1,
    worksetId: parsedInput.worksetId,
    scopeHash: parsedInput.scopeHash,
    roots,
    affected,
    traversedEdges,
  } as const;

  return parseCompiledImpactClosure({
    ...identity,
    contentHash: hashImpactClosure(identity),
  });
}

function parseCompileImpactClosureInput(value: unknown): z.infer<typeof compileImpactClosureInputSchema> {
  return parseImpactValue(compileImpactClosureInputSchema, value);
}

function parseImpactValue<T>(schema: z.ZodType<T>, value: unknown): T {
  try {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
  } catch {
    // Hostile accessors and proxies are malformed public runtime input.
  }
  throw impactClosureError('IMPACT_CLOSURE_INPUT_INVALID');
}

function parseImpactRoot(value: unknown): ImpactRoot {
  let hasUnchangedIssue = false;
  try {
    const parsed = impactRootSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    hasUnchangedIssue = parsed.error.issues.some((item) => item.message === 'IMPACT_ROOT_UNCHANGED');
  } catch {
    throw impactClosureError('IMPACT_CLOSURE_INPUT_INVALID');
  }
  if (hasUnchangedIssue) throw impactClosureError('IMPACT_ROOT_UNCHANGED');
  throw impactClosureError('IMPACT_CLOSURE_INPUT_INVALID');
}

function parseCompiledImpactClosure(value: unknown): ImpactClosure {
  try {
    const parsed = impactClosureSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    if (parsed.error.issues.some((item) => item.message === 'IMPACT_CLOSURE_SEMANTIC_MISMATCH')) {
      throw impactClosureError('IMPACT_CLOSURE_SEMANTIC_MISMATCH');
    }
  } catch (error) {
    if (error instanceof ImpactClosureError) throw error;
  }
  throw impactClosureError('IMPACT_CLOSURE_INPUT_INVALID');
}

export function hashImpactClosure(closure: {
  readonly schemaVersion: number;
  readonly worksetId: string;
  readonly scopeHash: ContentHash;
  readonly roots: readonly ImpactRoot[];
  readonly affected: readonly ImpactGraphNode[];
  readonly traversedEdges: readonly ImpactGraphEdge[];
}): ContentHash {
  return hashObject({
    schemaVersion: closure.schemaVersion,
    worksetId: closure.worksetId,
    scopeHash: closure.scopeHash,
    roots: closure.roots,
    affected: closure.affected,
    traversedEdges: closure.traversedEdges,
  });
}

export function invalidationActionFor(kind: ImpactGraphNodeKind): InvalidationAction {
  switch (kind) {
    case 'SOURCE':
    case 'TASK':
    case 'CONTRACT_SNAPSHOT':
      return 'RECOMPUTE_CLOSURE';
    case 'TEST_CASE':
    case 'VERIFICATION_PLAN':
      return 'RECOMPILE_PLAN';
    case 'WAVE_MEMBER':
      return 'BLOCK_OR_SUPERSEDE';
    case 'RUN':
      return 'MARK_STALE';
    case 'ENVIRONMENT_INPUT':
      return 'REQUIRE_RERUN';
    case 'COMMITSET':
      return 'REQUIRE_REVALIDATION';
  }
}

export function impactNodeKey(node: ImpactGraphNode): string {
  return JSON.stringify([node.kind, node.ref, node.contentHash]);
}

function impactRootKey(root: ImpactRoot): string {
  return JSON.stringify([impactNodeKey(root.node), root.previousContentHash]);
}

function impactEdgeKey(edge: ImpactGraphEdge): string {
  return JSON.stringify([impactNodeKey(edge.from), impactNodeKey(edge.to)]);
}

function canonicalUnique<T>(
  items: readonly T[],
  key: (item: T) => string,
  duplicateCode: 'IMPACT_DUPLICATE_EDGE' | 'IMPACT_DUPLICATE_NODE' | 'IMPACT_DUPLICATE_ROOT',
): readonly T[] {
  const sorted = [...items].sort((left, right) => compare(key(left), key(right)));
  for (let index = 1; index < sorted.length; index += 1) {
    if (key(sorted[index - 1]!) === key(sorted[index]!)) {
      throw impactClosureError(duplicateCode);
    }
  }
  return sorted;
}

const IMPACT_CLOSURE_ERROR_DETAILS: Readonly<Record<ImpactClosureErrorCode, string>> = {
  IMPACT_CLOSURE_INPUT_INVALID: 'impact closure input failed strict validation',
  IMPACT_CLOSURE_SEMANTIC_MISMATCH: 'affected nodes must be reachable from exact roots and traversed edges',
  IMPACT_CONFLICTING_ROOT: 'impact roots must bind one previous hash per current node',
  IMPACT_DUPLICATE_EDGE: 'impact graph edges must be unique',
  IMPACT_DUPLICATE_NODE: 'impact graph nodes must be unique',
  IMPACT_DUPLICATE_ROOT: 'impact roots must be unique',
  IMPACT_EDGE_ENDPOINT_MISSING: 'impact graph edge endpoints must occur in the node set',
  IMPACT_ROOT_NODE_MISSING: 'impact root nodes must occur in the node set',
  IMPACT_ROOT_UNCHANGED: 'impact root must bind changed content',
};

function impactClosureError(code: ImpactClosureErrorCode): ImpactClosureError {
  return new ImpactClosureError(code, IMPACT_CLOSURE_ERROR_DETAILS[code]);
}

function requireSortedUnique<T>(
  items: readonly T[],
  key: (item: T) => string,
  field: string,
  context: z.RefinementCtx,
): void {
  for (let index = 1; index < items.length; index += 1) {
    if (key(items[index - 1]!) >= key(items[index]!)) {
      context.addIssue({ code: 'custom', path: [field], message: `SORTED_UNIQUE: ${field}` });
      return;
    }
  }
}

function requireUniqueRootNodes(roots: readonly ImpactRoot[], context: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const changedRoot of roots) {
    const key = impactNodeKey(changedRoot.node);
    if (seen.has(key)) {
      context.addIssue({ code: 'custom', path: ['roots'], message: 'IMPACT_CONFLICTING_ROOT' });
      return;
    }
    seen.add(key);
  }
}

function validateImpactClosureSemantics(
  closure: {
    readonly roots: readonly ImpactRoot[];
    readonly affected: readonly ImpactGraphNode[];
    readonly traversedEdges: readonly ImpactGraphEdge[];
  },
  context: z.RefinementCtx,
): void {
  const affected = new Set(closure.affected.map(impactNodeKey));
  const rootKeys = closure.roots.map((root) => impactNodeKey(root.node));
  if (rootKeys.some((key) => !affected.has(key))) {
    semanticIssue(context, ['affected']);
    return;
  }
  const outgoing = new Map<string, string[]>();
  for (const graphEdge of closure.traversedEdges) {
    const from = impactNodeKey(graphEdge.from);
    const to = impactNodeKey(graphEdge.to);
    if (!affected.has(from) || !affected.has(to)) {
      semanticIssue(context, ['traversedEdges']);
      return;
    }
    outgoing.set(from, [...(outgoing.get(from) ?? []), to]);
  }
  const reached = new Set(rootKeys);
  const queue = [...rootKeys];
  for (let index = 0; index < queue.length; index += 1) {
    for (const target of outgoing.get(queue[index]!) ?? []) {
      if (!reached.has(target)) {
        reached.add(target);
        queue.push(target);
      }
    }
  }
  if (reached.size !== affected.size || [...affected].some((key) => !reached.has(key))) {
    semanticIssue(context, ['affected']);
  }
}

function semanticIssue(context: z.RefinementCtx, path: PropertyKey[]): void {
  context.addIssue({ code: 'custom', path, message: 'IMPACT_CLOSURE_SEMANTIC_MISMATCH' });
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
