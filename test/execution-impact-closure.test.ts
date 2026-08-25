import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compileImpactClosure,
  hashImpactClosure,
  ImpactClosureError,
  impactClosureSchema,
  impactNodeKey,
  invalidationActionFor,
  type ImpactClosure,
  type ImpactGraphEdge,
  type ImpactGraphNode,
  type ImpactRoot,
} from '../src/execution/verification/impact.js';
import type { ContentHash } from '../src/execution/types.js';

const HASH_A = `sha256:${'a'.repeat(64)}` as ContentHash;
const HASH_B = `sha256:${'b'.repeat(64)}` as ContentHash;
const HASH_C = `sha256:${'c'.repeat(64)}` as ContentHash;

const source = node('SOURCE', 'spec:authorization', HASH_B);
const oldSource = node('SOURCE', 'spec:authorization', HASH_A);
const task = node('TASK', 'quote-center/CHG-0001/REV-0001/BL-0001/TASK-001', HASH_A);
const contract = node('CONTRACT_SNAPSHOT', 'WKS-0001/authorization-v2/CTR-0001', HASH_A);
const testCase = node('TEST_CASE', 'PROJECT/quote-center/TC-0001', HASH_A);
const oldTestCase = node('TEST_CASE', 'PROJECT/quote-center/TC-0001', HASH_C);
const plan = node('VERIFICATION_PLAN', 'WKS-0001/VPL-0001', HASH_A);
const member = node('WAVE_MEMBER', 'WAVE-0001/quote-center/TASK-001', HASH_A);
const run = node('RUN', 'RUN-0001', HASH_A);
const environment = node('ENVIRONMENT_INPUT', 'IER-0001', HASH_A);
const commitSet = node('COMMITSET', 'CST-0001', HASH_A);

const chainNodes = [
  source,
  oldSource,
  task,
  contract,
  testCase,
  oldTestCase,
  plan,
  member,
  run,
  environment,
  commitSet,
] as const;

const chainEdges = [
  edge(source, task),
  edge(task, testCase),
  edge(contract, testCase),
  edge(testCase, plan),
  edge(plan, member),
  edge(member, run),
  edge(run, environment),
  edge(environment, commitSet),
  edge(oldSource, oldTestCase),
] as const;

function node(
  kind: ImpactGraphNode['kind'],
  ref: string,
  contentHash: ContentHash,
): ImpactGraphNode {
  return { kind, ref, contentHash };
}

function edge(from: ImpactGraphNode, to: ImpactGraphNode): ImpactGraphEdge {
  return { from, to };
}

function root(current: ImpactGraphNode, previousContentHash: ContentHash | null = HASH_A): ImpactRoot {
  return { node: current, previousContentHash };
}

function compile(
  roots: readonly ImpactRoot[] = [root(source)],
  nodes: readonly ImpactGraphNode[] = chainNodes,
  edges: readonly ImpactGraphEdge[] = chainEdges,
) {
  return compileImpactClosure({
    worksetId: 'WKS-0001',
    scopeHash: HASH_C,
    roots,
    nodes,
    edges,
  });
}

test('ImpactClosure follows only the exact hash-bound transitive dependency chain', () => {
  const closure = compile();

  assert.deepEqual(closure.affected.map((item) => item.kind), [
    'COMMITSET',
    'ENVIRONMENT_INPUT',
    'RUN',
    'SOURCE',
    'TASK',
    'TEST_CASE',
    'VERIFICATION_PLAN',
    'WAVE_MEMBER',
  ]);
  const affectedKeys = new Set(closure.affected.map(impactNodeKey));
  assert.equal(affectedKeys.has(impactNodeKey(oldSource)), false);
  assert.equal(affectedKeys.has(impactNodeKey(oldTestCase)), false);
  assert.equal(closure.traversedEdges.length, 7);
  assert.equal(impactClosureSchema.parse(closure).contentHash, closure.contentHash);
});

test('[adversarial] ImpactClosure schema rejects a coherently rehashed unreachable node', () => {
  const valid = compile();
  const unrelated = node('WAVE_MEMBER', 'WAVE-9999/quote-center/TASK-999', HASH_C);
  const affected = [...valid.affected, unrelated]
    .sort((left, right) => impactNodeKey(left) < impactNodeKey(right) ? -1 : 1);
  const forged = rehashClosure({ ...valid, affected });

  assert.throws(() => impactClosureSchema.parse(forged), /IMPACT_CLOSURE_SEMANTIC_MISMATCH/);
});

test('[adversarial] ImpactClosure rejects a rehashed missing justifying edge', () => {
  const valid = compile();
  const forged = rehashClosure({ ...valid, traversedEdges: valid.traversedEdges.slice(0, -1) });

  assert.throws(() => impactClosureSchema.parse(forged), /IMPACT_CLOSURE_SEMANTIC_MISMATCH/);
});

test('[adversarial] ImpactClosure rejects a rehashed affected set without its root', () => {
  const valid = compile();
  const rootKey = impactNodeKey(valid.roots[0]!.node);
  const forged = rehashClosure({
    ...valid,
    affected: valid.affected.filter((item) => impactNodeKey(item) !== rootKey),
  });

  assert.throws(() => impactClosureSchema.parse(forged), /IMPACT_CLOSURE_SEMANTIC_MISMATCH/);
});

test('ImpactClosure is deterministic under graph and root permutations with converging paths', () => {
  const roots = [root(source), root(contract, HASH_B)];
  const first = compile(roots);
  const permuted = compile([...roots].reverse(), [...chainNodes].reverse(), [...chainEdges].reverse());

  assert.deepEqual(first, permuted);
  assert.equal(first.affected.filter((item) => item.kind === 'VERIFICATION_PLAN').length, 1);
  assert.equal(first.traversedEdges.filter((item) => item.to.kind === 'TEST_CASE').length, 2);
});

test('[adversarial] ImpactClosure handles dependency cycles without duplicate targets', () => {
  const closure = compile([root(source)], chainNodes, [...chainEdges, edge(commitSet, plan)]);

  assert.equal(closure.affected.filter((item) => item.kind === 'VERIFICATION_PLAN').length, 1);
  assert.equal(closure.traversedEdges.some((item) => item.from.kind === 'COMMITSET' && item.to.kind === 'VERIFICATION_PLAN'), true);
});

test('[adversarial] ImpactClosure rejects dangling endpoints missing roots unchanged roots and duplicate graph identities', () => {
  const missing = node('RUN', 'RUN-9999', HASH_B);
  assert.throws(() => compile([root(source)], chainNodes, [...chainEdges, edge(source, missing)]), /IMPACT_EDGE_ENDPOINT_MISSING/);
  assert.throws(() => compile([root(missing)], chainNodes, chainEdges), /IMPACT_ROOT_NODE_MISSING/);
  assert.throws(() => compile([{ node: source, previousContentHash: source.contentHash }], chainNodes, chainEdges), /IMPACT_ROOT_UNCHANGED/);
  assert.throws(() => compile([root(source)], [...chainNodes, source], chainEdges), /IMPACT_DUPLICATE_NODE/);
  assert.throws(() => compile([root(source)], chainNodes, [...chainEdges, chainEdges[0]!]), /IMPACT_DUPLICATE_EDGE/);
  assert.throws(() => compile([
    root(source, HASH_A),
    root(source, HASH_C),
  ], chainNodes, chainEdges), /IMPACT_CONFLICTING_ROOT/);
});

test('[adversarial] ImpactClosure compiler exposes only fixed bounded malformed-input failures', async (t) => {
  const valid = {
    worksetId: 'WKS-0001',
    scopeHash: HASH_C,
    roots: [root(source)],
    nodes: chainNodes,
    edges: chainEdges,
  };
  const throwing = (field: string) => Object.defineProperty({}, field, {
    enumerable: true,
    get: () => { throw new Error('unbounded hostile impact detail must not escape'); },
  });
  const throwingDomainRoot = Object.defineProperties({}, {
    node: {
      enumerable: true,
      get: () => {
        throw new ImpactClosureError(
          'IMPACT_ROOT_UNCHANGED',
          'attacker-controlled root getter detail must not escape',
        );
      },
    },
    previousContentHash: { enumerable: true, value: HASH_A },
  });
  const attacks: readonly [string, unknown, string, string][] = [
    [
      'missing compile input',
      undefined,
      'IMPACT_CLOSURE_INPUT_INVALID',
      'impact closure input failed strict validation',
    ],
    [
      'unknown graph-node kind',
      { ...valid, nodes: [{ ...source, kind: 'UNKNOWN_KIND' }] },
      'IMPACT_CLOSURE_INPUT_INVALID',
      'impact closure input failed strict validation',
    ],
    [
      'throwing graph-edge field',
      { ...valid, edges: [throwing('from')] },
      'IMPACT_CLOSURE_INPUT_INVALID',
      'impact closure input failed strict validation',
    ],
    [
      'malformed previous root hash',
      { ...valid, roots: [{ node: source, previousContentHash: 'hostile raw hash text' }] },
      'IMPACT_CLOSURE_INPUT_INVALID',
      'impact closure input failed strict validation',
    ],
    [
      'throwing domain error from root getter',
      { ...valid, roots: [throwingDomainRoot] },
      'IMPACT_CLOSURE_INPUT_INVALID',
      'impact closure input failed strict validation',
    ],
    [
      'unchanged root identity',
      { ...valid, roots: [{ node: source, previousContentHash: source.contentHash }] },
      'IMPACT_ROOT_UNCHANGED',
      'impact root must bind changed content',
    ],
    [
      'duplicate graph node',
      { ...valid, nodes: [...valid.nodes, source] },
      'IMPACT_DUPLICATE_NODE',
      'impact graph nodes must be unique',
    ],
  ];

  for (const [name, input, expectedCode, expectedDetail] of attacks) {
    await t.test(`[adversarial] ${name}`, () => {
      assert.throws(
        () => compileImpactClosure(input as never),
        (error: unknown) => {
          assert.ok(error instanceof ImpactClosureError);
          const domain = error as ImpactClosureError & { readonly detail?: unknown };
          assert.deepEqual(
            { code: domain.code, detail: domain.detail, message: domain.message },
            {
              code: expectedCode,
              detail: expectedDetail,
              message: `${expectedCode}: ${expectedDetail}`,
            },
          );
          return true;
        },
      );
    });
  }
});

test('affected node kinds project to the required revalidation action', () => {
  assert.deepEqual({
    SOURCE: invalidationActionFor('SOURCE'),
    TASK: invalidationActionFor('TASK'),
    CONTRACT_SNAPSHOT: invalidationActionFor('CONTRACT_SNAPSHOT'),
    TEST_CASE: invalidationActionFor('TEST_CASE'),
    VERIFICATION_PLAN: invalidationActionFor('VERIFICATION_PLAN'),
    WAVE_MEMBER: invalidationActionFor('WAVE_MEMBER'),
    RUN: invalidationActionFor('RUN'),
    ENVIRONMENT_INPUT: invalidationActionFor('ENVIRONMENT_INPUT'),
    COMMITSET: invalidationActionFor('COMMITSET'),
  }, {
    SOURCE: 'RECOMPUTE_CLOSURE',
    TASK: 'RECOMPUTE_CLOSURE',
    CONTRACT_SNAPSHOT: 'RECOMPUTE_CLOSURE',
    TEST_CASE: 'RECOMPILE_PLAN',
    VERIFICATION_PLAN: 'RECOMPILE_PLAN',
    WAVE_MEMBER: 'BLOCK_OR_SUPERSEDE',
    RUN: 'MARK_STALE',
    ENVIRONMENT_INPUT: 'REQUIRE_RERUN',
    COMMITSET: 'REQUIRE_REVALIDATION',
  });
});

function rehashClosure(
  closure: Omit<ImpactClosure, 'contentHash'> | ImpactClosure,
): ImpactClosure {
  const { contentHash: _discarded, ...identity } = closure as ImpactClosure;
  return { ...identity, contentHash: hashImpactClosure(identity) };
}
