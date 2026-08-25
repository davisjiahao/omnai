import { randomUUID } from 'node:crypto';
import { link, open, readFile, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { ensureDir } from '../core/files.js';
import {
  PROTOCOL_IDS,
  loadProtocolBundle,
  type ProtocolId,
} from '../protocols/index.js';
import { canonicalJson, hashObject } from './hashing.js';
import {
  contentHashSchema,
  contractRefSchema,
  contractScenarioRefSchema,
  scopedTaskRefSchema,
  testCaseRefKey,
  testCaseRefSchema,
  verificationPlanRefSchema,
} from './types.js';

const runIdSchema = z.string().regex(/^RUN-\d{4}$/);
const worksetIdSchema = z.string().regex(/^WKS-\d{4}$/);
const waveIdSchema = z.string().regex(/^WAVE-\d{4}$/);
const gitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const projectSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const timestampSchema = z.string().datetime();
const protocolIdSchema = z.enum(PROTOCOL_IDS);
const readonlyStringArraySchema = z.array(z.string().min(1)).readonly();

const packetAgentSchema = z.strictObject({
  agentId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  protocol: z.enum(['acp', 'native']),
  role: z.enum(['coordination-read-only', 'project-writer', 'project-reviewer']),
});

const executionLimitsSchema = z.strictObject({
  timeoutMs: z.number().int().positive(),
  maxOutputBytes: z.number().int().positive(),
});

const permissionPolicySchema = z.strictObject({
  filesystemRoots: z.array(z.string().min(1)).readonly(),
  terminal: z.boolean(),
  network: z.enum(['ALLOW', 'DENY']),
  denyGitCommit: z.literal(true),
  denyNestedOmnai: z.literal(true),
});

const readOnlyPermissionPolicySchema = permissionPolicySchema.extend({
  terminal: z.literal(false),
  network: z.literal('DENY'),
}).strict();

const gitBindingSchema = z.strictObject({
  startingHead: gitObjectIdSchema,
  worktree: z.string().min(1),
  branch: z.string().min(1),
});

const sourceRefSchema = z.strictObject({
  ref: z.string().min(1),
  contentHash: contentHashSchema,
});

const sourceSnapshotSchema = z.strictObject({
  path: z.string().min(1),
  head: gitObjectIdSchema,
  tree: gitObjectIdSchema,
  contentHash: contentHashSchema,
  sourceRefs: z.array(sourceRefSchema).min(1).readonly(),
});

export const projectTestPlannerContractScenarioSchema = contractScenarioRefSchema.extend({
  title: z.string().min(1),
  participantProjects: z.array(projectSchema).min(2).readonly(),
  sourceRefs: z.array(sourceRefSchema).min(1).readonly(),
  contractElementRefs: z.array(sourceRefSchema).min(1).readonly(),
  fixtureRefs: z.array(sourceRefSchema).readonly(),
  executorRefs: z.array(z.string().min(1)).min(1).readonly(),
  expectedOutcome: z.string().min(1),
}).strict();
export type ProjectTestPlannerContractScenario = z.infer<typeof projectTestPlannerContractScenarioSchema>;

const packetCommonShape = {
  schemaVersion: z.literal(1),
  id: runIdSchema,
  worksetId: worksetIdSchema,
  parentRunId: runIdSchema.optional(),
  coordinationCycleId: z.string().regex(/^CCY-[a-zA-Z0-9._-]+$/).optional(),
  waveId: waveIdSchema.optional(),
  contracts: z.array(contractRefSchema).readonly(),
  objective: z.string().min(1),
  protocolIds: z.array(protocolIdSchema).min(1).readonly(),
  verificationCommands: readonlyStringArraySchema,
  evidenceRequired: readonlyStringArraySchema,
  stopConditions: readonlyStringArraySchema,
  agent: packetAgentSchema,
  limits: executionLimitsSchema,
  permissionPolicy: permissionPolicySchema,
  createdAt: timestampSchema,
};

const coordinationShape = <Kind extends 'CONTRACT_PLANNER' | 'PROJECT_CRITIC' | 'CONTRACT_RESOLVER'>(
  kind: Kind,
) => ({
  ...packetCommonShape,
  kind: z.literal(kind),
  agent: packetAgentSchema.extend({ role: z.literal('coordination-read-only') }).strict(),
  permissionPolicy: readOnlyPermissionPolicySchema,
});

const projectTestPlannerShape = {
  ...packetCommonShape,
  kind: z.literal('PROJECT_TEST_PLANNER'),
  agent: packetAgentSchema.extend({ role: z.literal('coordination-read-only') }).strict(),
  permissionPolicy: readOnlyPermissionPolicySchema,
  project: projectSchema,
  scopedTasks: z.array(scopedTaskRefSchema).min(1).readonly(),
  sourceSnapshot: sourceSnapshotSchema,
  acceptanceCriteria: z.array(sourceRefSchema).min(1).readonly(),
  manifestRefs: z.array(sourceRefSchema).readonly(),
  contractScenarios: z.array(projectTestPlannerContractScenarioSchema).readonly(),
  outputPath: z.string().min(1),
};

const projectShape = <
  Kind extends 'PROJECT_WRITER' | 'PROJECT_REVIEWER' | 'RECOVERY_WRITER',
  Role extends 'project-writer' | 'project-reviewer',
>(
  kind: Kind,
  role: Role,
) => ({
  ...packetCommonShape,
  kind: z.literal(kind),
  agent: packetAgentSchema.extend({ role: z.literal(role) }).strict(),
  scopedTask: scopedTaskRefSchema,
  git: gitBindingSchema,
  allowedPaths: z.array(z.string().min(1)).min(1).readonly(),
  verificationPlan: verificationPlanRefSchema,
  // v2 允许一个任务由策略支持的完整豁免覆盖；此时仍可创建受限 Writer
  // Packet，但不会伪造 TestCase 或命令引用。是否确实完整豁免由准入门复算。
  testCaseRefs: z.array(testCaseRefSchema).readonly(),
  commandRefs: z.array(z.string().min(1)).readonly(),
});

const packetShapes = [
  coordinationShape('CONTRACT_PLANNER'),
  coordinationShape('PROJECT_CRITIC'),
  coordinationShape('CONTRACT_RESOLVER'),
  projectTestPlannerShape,
  projectShape('PROJECT_WRITER', 'project-writer'),
  projectShape('PROJECT_REVIEWER', 'project-reviewer'),
  projectShape('RECOVERY_WRITER', 'project-writer'),
] as const;

export const runPacketWithoutHashSchema = z.discriminatedUnion('kind', [
  z.strictObject(packetShapes[0]),
  z.strictObject(packetShapes[1]),
  z.strictObject(packetShapes[2]),
  z.strictObject(packetShapes[3]),
  z.strictObject(packetShapes[4]),
  z.strictObject(packetShapes[5]),
  z.strictObject(packetShapes[6]),
]).superRefine(validatePacketSemantics);

export const runPacketEnvelopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...packetShapes[0], packetHash: contentHashSchema }),
  z.strictObject({ ...packetShapes[1], packetHash: contentHashSchema }),
  z.strictObject({ ...packetShapes[2], packetHash: contentHashSchema }),
  z.strictObject({ ...packetShapes[3], packetHash: contentHashSchema }),
  z.strictObject({ ...packetShapes[4], packetHash: contentHashSchema }),
  z.strictObject({ ...packetShapes[5], packetHash: contentHashSchema }),
  z.strictObject({ ...packetShapes[6], packetHash: contentHashSchema }),
]);

export const runPacketSchema = runPacketEnvelopeSchema.superRefine((packet, context) => {
  validatePacketSemantics(packet, context);
  const { packetHash: _packetHash, ...withoutHash } = packet;
  if (packet.packetHash !== hashObject(withoutHash)) {
    context.addIssue({ code: 'custom', path: ['packetHash'], message: 'RUN_PACKET_HASH_MISMATCH' });
  }
});

export type RunPacketInput = z.input<typeof runPacketWithoutHashSchema>;
export type RunPacket = z.infer<typeof runPacketSchema>;

const OUTPUT_SCHEMAS: Record<RunPacket['kind'], string> = {
  CONTRACT_PLANNER: 'ContractCandidate',
  PROJECT_CRITIC: 'ProjectFinding',
  CONTRACT_RESOLVER: 'ContractResolution',
  PROJECT_TEST_PLANNER: 'ProjectTestPlanCandidate',
  PROJECT_WRITER: 'WorkerResult',
  PROJECT_REVIEWER: 'ReviewFinding',
  RECOVERY_WRITER: 'WorkerResult',
};

const REQUIRED_ROLE_PROTOCOLS: Record<RunPacket['kind'], ProtocolId> = {
  CONTRACT_PLANNER: 'execution.contract-planner',
  PROJECT_CRITIC: 'execution.project-critic',
  CONTRACT_RESOLVER: 'execution.contract-resolver',
  PROJECT_TEST_PLANNER: 'execution.project-test-planner',
  PROJECT_WRITER: 'execution.project-writer',
  PROJECT_REVIEWER: 'execution.project-reviewer',
  RECOVERY_WRITER: 'execution.recovery-writer',
};

export function createRunPacket<Input extends RunPacketInput>(
  input: Input,
): Extract<RunPacket, { kind: Input['kind'] }> {
  const withoutHash = runPacketWithoutHashSchema.parse(input);
  return deepFreeze(runPacketSchema.parse({
    ...withoutHash,
    packetHash: hashRunPacket(withoutHash),
  })) as Extract<RunPacket, { kind: Input['kind'] }>;
}

/**
 * 重新计算 Run Packet 的权威内容哈希。
 *
 * 准入门必须验证“内容与哈希同时被篡改”的情况，因此不能只信任已经持久化
 * 的 packetHash。这里刻意只做规范哈希、不先做 schema 校验，使准入门能够对
 * “结构有效但语义非法且已重新哈希”的输入返回精确诊断；严格校验仍由
 * runPacketSchema 负责。
 */
export function hashRunPacket(packet: unknown): string {
  if (packet === null || typeof packet !== 'object' || Array.isArray(packet)) {
    throw new TypeError('RUN_PACKET_OBJECT_REQUIRED');
  }
  const { packetHash: _packetHash, ...withoutHash } = packet as Record<string, unknown>;
  return hashObject(withoutHash);
}

export async function persistRunPacket(path: string, packet: RunPacket): Promise<void> {
  const parsed = runPacketSchema.parse(packet);
  await ensureDir(dirname(path));
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(YAML.stringify(parsed, { lineWidth: 100 }), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existing = await loadRunPacket(path);
      if (canonicalJson(existing) !== canonicalJson(parsed)) {
        throw new Error(`RUN_PACKET_IMMUTABLE: refusing to replace ${path}`);
      }
    }
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isMissingFile(error)) throw error;
    });
  }
}

export async function loadRunPacket(path: string): Promise<RunPacket> {
  const raw = await readFile(path, 'utf8');
  return deepFreeze(runPacketSchema.parse(YAML.parse(raw)));
}

export async function renderRunPrompt(
  packet: RunPacket,
  outputPath: string,
  protocolRoot?: string,
): Promise<string> {
  const parsed = runPacketSchema.parse(packet);
  const absoluteOutput = requireNormalizedAbsolutePath(outputPath, 'outputPath');
  if (parsed.kind === 'PROJECT_TEST_PLANNER' && parsed.outputPath !== absoluteOutput) {
    throw new Error('RUN_PACKET_OUTPUT_PATH_MISMATCH');
  }
  const bundle = await loadProtocolBundle([...parsed.protocolIds], protocolRoot);
  const inputPaths = materializedInputPaths(parsed);
  return [
    '# OmnAI immutable Agent Run',
    '',
    `Run ID: ${parsed.id}`,
    `Packet hash: ${parsed.packetHash}`,
    `Objective: ${parsed.objective}`,
    '',
    '## Materialized input paths',
    ...inputPaths.map((path) => `- ${path}`),
    '',
    '## Immutable Run Packet',
    '```yaml',
    YAML.stringify(parsed, { lineWidth: 100 }).trimEnd(),
    '```',
    '',
    '## Role protocol',
    bundle.rendered.trimEnd(),
    '',
    '## Output contract',
    `Write exactly one ${OUTPUT_SCHEMAS[parsed.kind]} artifact to ${absoluteOutput}.`,
    `The artifact must repeat runId ${parsed.id} and packetHash ${parsed.packetHash}.`,
    '',
    '## Authority boundary',
    '- You must not mutate OmnAI state or Claims.',
    '- You must not create a final Git commit.',
    '- You must not start a nested OmnAI run.',
    '- Stop with the role-specific structured blocker or signal when the packet is insufficient or stale.',
    '',
  ].join('\n');
}

function validatePacketSemantics(
  packet: z.infer<typeof runPacketWithoutHashSchema> | RunPacket,
  context: z.RefinementCtx,
): void {
  requireSortedUnique(packet.contracts, (item) => `${item.id}\u0000${item.contentHash}`, 'contracts', context);
  requireSortedUnique(packet.protocolIds, identity, 'protocolIds', context);
  requireSortedUnique(packet.evidenceRequired, identity, 'evidenceRequired', context);
  requireSortedUnique(packet.stopConditions, identity, 'stopConditions', context);
  requireSortedUnique(packet.permissionPolicy.filesystemRoots, identity, 'permissionPolicy.filesystemRoots', context);
  for (let index = 0; index < packet.permissionPolicy.filesystemRoots.length; index += 1) {
    validateNormalizedAbsolutePath(
      packet.permissionPolicy.filesystemRoots[index]!,
      ['permissionPolicy', 'filesystemRoots', index],
      context,
    );
  }
  if (!packet.protocolIds.includes(REQUIRED_ROLE_PROTOCOLS[packet.kind])) {
    context.addIssue({ code: 'custom', path: ['protocolIds'], message: 'RUN_PACKET_ROLE_PROTOCOL_REQUIRED' });
  }

  if (packet.kind === 'PROJECT_TEST_PLANNER') {
    requireSortedUnique(packet.scopedTasks, scopedTaskKey, 'scopedTasks', context);
    requireSortedUnique(packet.sourceSnapshot.sourceRefs, (item) => item.ref, 'sourceSnapshot.sourceRefs', context);
    requireSortedUnique(packet.acceptanceCriteria, (item) => item.ref, 'acceptanceCriteria', context);
    requireSortedUnique(packet.manifestRefs, (item) => item.ref, 'manifestRefs', context);
    requireSortedUnique(packet.contractScenarios, (item) => `${item.contractKey}\0${item.scenarioId}`, 'contractScenarios', context);
    const packetContracts = new Set(packet.contracts.map((item) => `${item.id}\0${item.contentHash}`));
    for (let index = 0; index < packet.contractScenarios.length; index += 1) {
      const scenario = packet.contractScenarios[index]!;
      if (!packetContracts.has(`${scenario.snapshot.id}\0${scenario.snapshot.contentHash}`)) {
        context.addIssue({
          code: 'custom', path: ['contractScenarios', index, 'snapshot'],
          message: 'PROJECT_TEST_PLANNER_SCENARIO_CONTRACT_UNBOUND',
        });
      }
    }
    validateNormalizedAbsolutePath(packet.sourceSnapshot.path, ['sourceSnapshot', 'path'], context);
    validateNormalizedAbsolutePath(packet.outputPath, ['outputPath'], context);
    if (packet.scopedTasks.some((task) => task.project !== packet.project)) {
      context.addIssue({ code: 'custom', path: ['scopedTasks'], message: 'PROJECT_TEST_PLANNER_PROJECT_SCOPE_MISMATCH' });
    }
    if (packet.permissionPolicy.terminal || packet.permissionPolicy.network !== 'DENY') {
      context.addIssue({ code: 'custom', path: ['permissionPolicy'], message: 'PROJECT_TEST_PLANNER_READ_ONLY' });
    }
    if (!packet.permissionPolicy.filesystemRoots.includes(packet.sourceSnapshot.path)) {
      context.addIssue({ code: 'custom', path: ['permissionPolicy', 'filesystemRoots'], message: 'SOURCE_SNAPSHOT_ROOT_REQUIRED' });
    }
    return;
  }

  if (packet.kind === 'PROJECT_WRITER' || packet.kind === 'PROJECT_REVIEWER' || packet.kind === 'RECOVERY_WRITER') {
    requireSortedUnique(packet.allowedPaths, identity, 'allowedPaths', context);
    requireSortedUnique(packet.testCaseRefs, testCaseRefKey, 'testCaseRefs', context);
    requireSortedUnique(packet.commandRefs, identity, 'commandRefs', context);
    validateNormalizedAbsolutePath(packet.git.worktree, ['git', 'worktree'], context);
    for (let index = 0; index < packet.allowedPaths.length; index += 1) {
      if (!isSafeProjectGlob(packet.allowedPaths[index]!)) {
        context.addIssue({ code: 'custom', path: ['allowedPaths', index], message: 'RUN_PACKET_ALLOWED_PATH_INVALID' });
      }
    }
    if (!packet.permissionPolicy.filesystemRoots.includes(packet.git.worktree)) {
      context.addIssue({ code: 'custom', path: ['permissionPolicy', 'filesystemRoots'], message: 'PROJECT_WORKTREE_ROOT_REQUIRED' });
    }
  }
}

function materializedInputPaths(packet: RunPacket): string[] {
  const paths = [...packet.permissionPolicy.filesystemRoots];
  if (packet.kind === 'PROJECT_TEST_PLANNER') paths.push(packet.sourceSnapshot.path);
  if (packet.kind === 'PROJECT_WRITER' || packet.kind === 'PROJECT_REVIEWER' || packet.kind === 'RECOVERY_WRITER') {
    paths.push(packet.git.worktree);
  }
  return [...new Set(paths)].sort(compare);
}

function validateNormalizedAbsolutePath(path: string, issuePath: PropertyKey[], context: z.RefinementCtx): void {
  if (!isAbsolute(path) || resolve(path) !== path) {
    context.addIssue({ code: 'custom', path: issuePath, message: 'NORMALIZED_ABSOLUTE_PATH_REQUIRED' });
  }
}

function requireNormalizedAbsolutePath(path: string, field: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`NORMALIZED_ABSOLUTE_PATH_REQUIRED: ${field}`);
  }
  return path;
}

function isSafeProjectGlob(value: string): boolean {
  if (value.includes('\\') || value.startsWith('/') || value.length === 0) return false;
  const segments = value.split('/');
  return !segments.some((segment) => segment === '' || segment === '.' || segment === '..');
}

function requireSortedUnique<T>(
  values: readonly T[],
  key: (value: T) => string,
  path: string,
  context: z.RefinementCtx,
): void {
  let previous: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const current = key(values[index]!);
    if (previous !== undefined && compare(previous, current) >= 0) {
      context.addIssue({ code: 'custom', path: [path, index], message: `${path} must be SORTED_UNIQUE` });
      return;
    }
    previous = current;
  }
}

function scopedTaskKey(task: z.infer<typeof scopedTaskRefSchema>): string {
  return [task.project, task.changeId, task.revision, task.baseline, task.taskId].join('\u0000');
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function identity(value: string): string {
  return value;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
