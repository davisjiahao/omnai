import { z } from 'zod';
import {
  canonicalStrictJson,
  compareCodeUnits,
  hashStrictObject,
} from '../catalog-schema.js';
import {
  CAPABILITIES,
  changeArtifactDirectorySchema,
  changeArtifactPathSchema,
  nonemptySingleLineSchema,
  persistedChangeIdSchema,
  persistedDecisionIdSchema,
  persistedRevisionIdSchema,
  persistedRunIdSchema,
  persistedSha256Schema,
  positiveSafeIntegerSchema,
  strictJsonValueSchema,
} from '../../domain/public.js';
import {
  runAuthorityContractSchema,
  type RunAuthorityContract,
} from '../../domain/run.js';
import {
  assertStrictUtf8Text,
  cloneStrictJson,
  hashUtf8,
  parseCompilerInput,
  requireCodeUnitOrder,
  utf8ByteLength,
} from '../compiler-runtime.js';
import type { Capability } from '../../domain/public.js';
import type { ChangeId, RevisionId, RunId, Sha256 } from '../../domain/scalars.js';

const fileLocatorSchema = z.union([
  z.strictObject({ scope: z.literal('CHANGE'), path: changeArtifactPathSchema }),
  z.strictObject({
    scope: z.literal('PROJECT_KNOWLEDGE'),
    path: z.enum(['glossary.md', 'policies.md', 'learnings.md']),
  }),
]);
const directoryLocatorSchema = z.strictObject({
  scope: z.literal('CHANGE'),
  path: changeArtifactDirectorySchema,
});
const locatorSchema = z.union([fileLocatorSchema, directoryLocatorSchema]);
const contextEntrySchema = z.strictObject({
  path: changeArtifactPathSchema,
  rawUtf8: z.string(),
  rawBytesHash: persistedSha256Schema,
});
const contextSchema = z.discriminatedUnion('kind', [
  z.strictObject({ locator: locatorSchema, kind: z.literal('MISSING') }),
  z.strictObject({
    locator: fileLocatorSchema,
    kind: z.literal('FILE'),
    rawUtf8: z.string(),
    rawBytesHash: persistedSha256Schema,
  }),
  z.strictObject({
    locator: directoryLocatorSchema,
    kind: z.literal('DIRECTORY'),
    entries: z.array(contextEntrySchema),
    inventoryHash: persistedSha256Schema,
  }),
]);
const protocolSchema = z.strictObject({
  id: nonemptySingleLineSchema,
  version: positiveSafeIntegerSchema,
  relativePath: z.string().regex(/^resources\/protocols\/[a-z0-9/-]+\.md$/u),
  rawBytesHash: persistedSha256Schema,
  rawUtf8: z.string(),
});
const flowSnapshotSchema = z.strictObject({
  value: strictJsonValueSchema,
  canonicalHash: persistedSha256Schema,
});
const decisionSnapshotSchema = z.strictObject({
  decisionId: persistedDecisionIdSchema,
  value: strictJsonValueSchema,
  canonicalHash: persistedSha256Schema,
});
const inputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  identity: z.strictObject({
    changeId: persistedChangeIdSchema,
    revision: persistedRevisionIdSchema,
    runId: persistedRunIdSchema,
    capability: z.enum(CAPABILITIES),
  }),
  instruction: z.string(),
  protocols: z.tuple([protocolSchema, protocolSchema]),
  contexts: z.array(contextSchema),
  flowSnapshot: flowSnapshotSchema,
  decisionSnapshots: z.array(decisionSnapshotSchema),
  authorityContract: runAuthorityContractSchema,
}).superRefine((input, context) => {
  if (input.authorityContract.changeId !== input.identity.changeId
    || input.authorityContract.revision !== input.identity.revision
    || input.authorityContract.runId !== input.identity.runId
    || input.authorityContract.capability !== input.identity.capability) {
    context.addIssue({ code: 'custom', path: ['authorityContract'], message: 'STATIC_INPUT_INVALID: prompt identity and authority contract disagree' });
  }
  if (input.flowSnapshot.canonicalHash !== hashStrictObject(input.flowSnapshot.value)) {
    context.addIssue({ code: 'custom', path: ['flowSnapshot', 'canonicalHash'], message: 'STATIC_INPUT_INVALID: Flow snapshot hash mismatch' });
  }
  for (const [index, decision] of input.decisionSnapshots.entries()) {
    if (decision.canonicalHash !== hashStrictObject(decision.value)) {
      context.addIssue({ code: 'custom', path: ['decisionSnapshots', index, 'canonicalHash'], message: 'STATIC_INPUT_INVALID: Decision snapshot hash mismatch' });
    }
  }
});

type PromptProtocolBindingV1 = Omit<z.output<typeof protocolSchema>, 'rawUtf8'>;
type PromptContextCaptureV1 = z.output<typeof contextSchema>;

export interface PromptRenderInputV1 {
  readonly schemaVersion: 1;
  readonly identity: { readonly changeId: ChangeId; readonly revision: RevisionId; readonly runId: RunId; readonly capability: Capability };
  readonly instruction: string;
  readonly protocols: readonly [z.output<typeof protocolSchema>, z.output<typeof protocolSchema>];
  readonly contexts: readonly PromptContextCaptureV1[];
  readonly flowSnapshot: z.output<typeof flowSnapshotSchema>;
  readonly decisionSnapshots: readonly z.output<typeof decisionSnapshotSchema>[];
  readonly authorityContract: RunAuthorityContract;
}

export interface PreparedPromptWithoutRendererHashV1 {
  readonly path: `runs/${RunId}/prompt.md`;
  readonly rendererId: 'prompt-render-v1';
  readonly instructionHash: Sha256;
  readonly contextBindingsHash: Sha256;
  readonly protocolBindings: readonly [PromptProtocolBindingV1, PromptProtocolBindingV1];
  readonly protocolBindingsHash: Sha256;
  readonly renderInputHash: Sha256;
  readonly rawUtf8: string;
  readonly rawBytesHash: Sha256;
}

// 背景：Prompt 是 Run 权限输入的一部分；普通 Markdown join 会因 trim、尾 LF 和隐式排序产生未哈希差异。
// 目的：把每个 payload 的 exact UTF-8 字节放进 OMNAI_BLOCK_V1 帧，并同时返回所有相邻 hash。
// 上下文：caller 必须先按目录顺序提供 protocol/context/Decision；renderer 只验证，不替 caller 修复顺序。
export function compilePromptRender(value: unknown): PreparedPromptWithoutRendererHashV1 {
  const input = parseCompilerInput(inputSchema, value);
  assertStrictUtf8Text(input.instruction, { allowLineFeed: true, requireNonWhitespace: true });
  requireCodeUnitOrder(input.decisionSnapshots.map((decision) => decision.decisionId), 'Decision snapshots');
  if (input.protocols[0].id !== 'common.authoritative-work'
    || input.protocols[1].id !== `repository.${input.identity.capability}`) {
    throw new TypeError('STATIC_INPUT_INVALID: prompt protocols must be common then exact repository capability');
  }
  for (const protocol of input.protocols) {
    assertStrictUtf8Text(protocol.rawUtf8, { allowLineFeed: true, requireNonWhitespace: false });
    if (protocol.rawBytesHash !== hashUtf8(protocol.rawUtf8)
      || protocol.relativePath !== `resources/protocols/${protocol.id.replace('.', '/')}.md`) {
      throw new TypeError(`STATIC_INPUT_INVALID: protocol '${protocol.id}' raw binding mismatch`);
    }
  }
  const blocks: string[] = [
    renderBlock('IDENTITY', 'identity', canonicalStrictJson(input.identity)),
    renderBlock('INSTRUCTION', 'instruction', input.instruction),
    ...input.protocols.map((protocol) => renderBlock('PROTOCOL', protocol.id, protocol.rawUtf8)),
  ];
  for (const capture of input.contexts) blocks.push(...renderContext(capture));
  blocks.push(renderBlock('FLOW', 'flow', canonicalStrictJson(input.flowSnapshot.value)));
  for (const decision of input.decisionSnapshots) {
    blocks.push(renderBlock('DECISION', decision.decisionId, canonicalStrictJson(decision.value)));
  }
  blocks.push(renderBlock('AUTHORITY_CONTRACT', 'authority-contract', canonicalStrictJson(input.authorityContract)));
  const rawUtf8 = `OMNAI_PROMPT_V1\n${blocks.join('')}`;
  const protocolBindings = input.protocols.map(({ rawUtf8: _rawUtf8, ...binding }) => binding) as [
    PromptProtocolBindingV1,
    PromptProtocolBindingV1,
  ];
  return cloneStrictJson({
    path: `runs/${input.identity.runId}/prompt.md`,
    rendererId: 'prompt-render-v1',
    instructionHash: hashUtf8(input.instruction),
    contextBindingsHash: hashStrictObject(input.contexts),
    protocolBindings,
    protocolBindingsHash: hashStrictObject(protocolBindings),
    renderInputHash: hashStrictObject(input),
    rawUtf8,
    rawBytesHash: hashUtf8(rawUtf8),
  });
}

function renderContext(capture: PromptContextCaptureV1): string[] {
  const label = `${capture.locator.scope}:${capture.locator.path}`;
  if (capture.kind === 'MISSING') return [renderBlock('CONTEXT', label, '{"state":"MISSING"}')];
  if (capture.kind === 'FILE') {
    assertStrictUtf8Text(capture.rawUtf8, { allowLineFeed: true, requireNonWhitespace: false });
    if (capture.rawBytesHash !== hashUtf8(capture.rawUtf8)) {
      throw new TypeError(`STATIC_INPUT_INVALID: context '${label}' raw binding mismatch`);
    }
    return [renderBlock('CONTEXT', label, capture.rawUtf8)];
  }
  requireCodeUnitOrder(capture.entries.map((entry) => entry.path), `Context directory '${label}' entries`);
  if (capture.entries.some((entry) => !entry.path.startsWith(capture.locator.path))) {
    throw new TypeError(`STATIC_INPUT_INVALID: context directory '${label}' contains an entry outside its locator`);
  }
  const inventory = capture.entries.map(({ path, rawBytesHash }) => ({ path, rawBytesHash }));
  if (capture.inventoryHash !== hashStrictObject(inventory)) {
    throw new TypeError(`STATIC_INPUT_INVALID: context directory '${label}' inventory hash mismatch`);
  }
  const rendered = [renderBlock('CONTEXT_DIRECTORY', label, canonicalStrictJson(inventory))];
  for (const entry of capture.entries) {
    assertStrictUtf8Text(entry.rawUtf8, { allowLineFeed: true, requireNonWhitespace: false });
    if (entry.rawBytesHash !== hashUtf8(entry.rawUtf8)) {
      throw new TypeError(`STATIC_INPUT_INVALID: context file '${entry.path}' raw binding mismatch`);
    }
    rendered.push(renderBlock('CONTEXT_FILE', `${capture.locator.scope}:${entry.path}`, entry.rawUtf8));
  }
  return rendered;
}

function renderBlock(kind: string, label: string, payload: string): string {
  const header = canonicalStrictJson({
    kind,
    label,
    byteLength: utf8ByteLength(payload),
    rawBytesHash: hashUtf8(payload),
  });
  return `OMNAI_BLOCK_V1 ${header}\n${payload}\nOMNAI_END_BLOCK_V1\n`;
}
