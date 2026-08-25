import { isAbsolute, posix, resolve } from 'node:path';
import { z } from 'zod';
import {
  adversarialCoveragePolicySchema,
  anyTestCaseSchema,
  anyVerificationPlanSchema,
  contentAddressedSourceRefSchema,
  scopedTaskRefSchema,
  testCaseRefKey,
  testCaseRefSchema,
  waveSchema,
  type AdversarialCoveragePolicy,
  type AdversarialPolicyRef,
  type ContentAddressedSourceRef,
  type ContractRef,
  type ScopedTaskRef,
  type TestCaseRef,
  type VerificationPlanRef,
  type VerificationPlanV2,
  type Wave,
} from '../types.js';
import {
  hashRunPacket,
  runPacketEnvelopeSchema,
  runPacketSchema,
  type RunPacket,
} from '../packets.js';
import { canonicalJson } from '../hashing.js';
import { compileVerificationPlanV2 } from './planner-v2.js';
import { scopedTaskKey, type CompiledTestCase } from './test-cases.js';

export type WriterRunPacket = RunPacket & {
  readonly kind: 'PROJECT_WRITER' | 'RECOVERY_WRITER';
  readonly scopedTask: ScopedTaskRef;
  readonly allowedPaths: readonly string[];
};

export type EntryGateIssueCode =
  | 'ADVERSARIAL_ASSURANCE_UNPROVEN'
  | 'ADVERSARIAL_POLICY_STALE'
  | 'COMMAND_REF_MISMATCH'
  | 'CONTRACT_SNAPSHOT_MISMATCH'
  | 'PACKET_AGENT_MISMATCH'
  | 'PACKET_ALLOWED_PATH_INVALID'
  | 'PACKET_ALLOWED_PATHS_MISMATCH'
  | 'PACKET_CASE_REF_MISMATCH'
  | 'PACKET_COMMAND_REF_MISMATCH'
  | 'PACKET_CONTENT_HASH_MISMATCH'
  | 'PACKET_CONTRACT_MISMATCH'
  | 'PACKET_KIND_MISMATCH'
  | 'PACKET_MEMBER_MISMATCH'
  | 'PACKET_PERMISSION_POLICY_MISMATCH'
  | 'PACKET_PLAN_MISMATCH'
  | 'PACKET_SCHEMA_INVALID'
  | 'PACKET_VERIFICATION_COMMAND_MISMATCH'
  | 'PACKET_VERIFICATION_COMMANDS_MISMATCH'
  | 'PACKET_WAVE_MISMATCH'
  | 'PACKET_WORKSET_MISMATCH'
  | 'TASK_CASE_COVERAGE_MISSING'
  | 'TASK_INVALIDATED'
  | 'TEST_CASE_REF_MISMATCH'
  | 'VERIFICATION_PLAN_CONTENT_MISMATCH'
  | 'VERIFICATION_PLAN_NOT_READY'
  | 'VERIFICATION_PLAN_REF_MISMATCH'
  | 'VERIFICATION_PLAN_SCHEMA_INVALID'
  | 'WAVE_MEMBERS_EMPTY'
  | 'WAVE_NOT_ENTERABLE'
  | 'WAVE_SCHEMA_INVALID'
  | 'WAVE_WORKSET_MISMATCH'
  | 'WRITER_ALREADY_CLAIMED';

export interface EntryGateIssue {
  readonly code: EntryGateIssueCode;
  readonly detail: string;
}

export type EntryGateResult =
  | {
    readonly ok: true;
    readonly verificationPlan: VerificationPlanRef;
    readonly caseRefs: readonly TestCaseRef[];
    readonly commandRefs: readonly string[];
  }
  | { readonly ok: false; readonly issues: readonly EntryGateIssue[] };

export interface EvaluateWaveEntryInput {
  readonly wave: unknown;
  readonly verificationPlan: unknown;
  readonly adversarialPolicy: AdversarialCoveragePolicy;
  readonly adversarialPolicyRef: AdversarialPolicyRef;
  readonly authoritativeSourceRefs: readonly ContentAddressedSourceRef[];
  readonly cases: readonly CompiledTestCase[];
  readonly invalidatedTasks: readonly ScopedTaskRef[];
}

export interface EvaluateWriterEntryInput extends EvaluateWaveEntryInput {
  readonly member: Wave['members'][number];
  readonly packet: unknown;
  readonly expectedAgent: Readonly<{ agentId: string; protocol: 'acp' | 'native' }>;
  readonly expectedWorktree: string;
  readonly expectedVerificationCommands: readonly string[];
  readonly activeWriterProjects: readonly string[];
}

interface ParsedEntryInput {
  readonly wave: Wave;
  readonly verificationPlan: VerificationPlanV2;
  readonly adversarialPolicy: AdversarialCoveragePolicy;
  readonly adversarialPolicyRef: AdversarialPolicyRef;
  readonly authoritativeSourceRefs: readonly ContentAddressedSourceRef[];
  readonly cases: readonly CompiledTestCase[];
  readonly invalidatedTasks: readonly ScopedTaskRef[];
  readonly issues: readonly EntryGateIssue[];
}

type ParseEntryResult =
  | { readonly ok: true; readonly parsed: ParsedEntryInput }
  | { readonly ok: false; readonly result: EntryGateResult };

interface WaveEntrySnapshot {
  readonly wave: unknown;
  readonly verificationPlan: unknown;
  readonly adversarialPolicy: unknown;
  readonly adversarialPolicyRef: unknown;
  readonly authoritativeSourceRefs: unknown;
  readonly cases: unknown;
  readonly invalidatedTasks: unknown;
}

interface WriterEntrySnapshot extends WaveEntrySnapshot {
  readonly member: unknown;
  readonly packet: unknown;
  readonly expectedAgent: unknown;
  readonly expectedWorktree: unknown;
  readonly expectedVerificationCommands: unknown;
  readonly activeWriterProjects: unknown;
}

type SnapshotResult<T> =
  | { readonly ok: true; readonly snapshot: T }
  | { readonly ok: false; readonly result: EntryGateResult };

const compiledCasesSchema = z.array(z.strictObject({
  testCase: anyTestCaseSchema,
  ref: testCaseRefSchema,
})).readonly();
const authoritativeSourceRefsSchema = z.array(contentAddressedSourceRefSchema).readonly();
const invalidatedTasksSchema = z.array(scopedTaskRefSchema.strip()).readonly();
const requestedMemberSchema = waveSchema.shape.members.unwrap().element;
const expectedAgentSchema = z.strictObject({
  agentId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  protocol: z.enum(['acp', 'native']),
});
const expectedWorktreeSchema = z.string().min(1);
const expectedVerificationCommandsSchema = z.array(z.string().min(1)).readonly();
const activeWriterProjectsSchema = z.array(z.string().min(1)).readonly();

export function evaluateWaveEntry(input: EvaluateWaveEntryInput): EntryGateResult {
  const snapshotted = snapshotWaveEntry(input);
  if (!snapshotted.ok) return snapshotted.result;
  return evaluateWaveEntryForStatuses(snapshotted.snapshot, new Set(['PLANNED']));
}

function evaluateWaveEntryForStatuses(
  input: WaveEntrySnapshot,
  allowedStatuses: ReadonlySet<Wave['status']>,
): EntryGateResult {
  const prepared = parseAndValidateEntry(input);
  if (!prepared.ok) return prepared.result;
  const { wave, verificationPlan, cases, invalidatedTasks } = prepared.parsed;
  const issues = [...prepared.parsed.issues];
  if (issues.some((entry) => entry.code === 'VERIFICATION_PLAN_CONTENT_MISMATCH')) {
    return failed(issues);
  }
  if (wave.worksetId !== verificationPlan.worksetId) {
    issues.push(issue('WAVE_WORKSET_MISMATCH', `${wave.worksetId} != ${verificationPlan.worksetId}`));
  }
  if (!allowedStatuses.has(wave.status)) {
    issues.push(issue('WAVE_NOT_ENTERABLE', `${wave.id} is ${wave.status}`));
  }
  if (wave.members.length === 0) {
    issues.push(issue('WAVE_MEMBERS_EMPTY', wave.id));
  }

  const invalidated = new Set(invalidatedTasks.map(scopedTaskKey));
  const allCaseRefs: TestCaseRef[] = [];
  const allCommandRefs: string[] = [];
  for (const member of wave.members) {
    const expected = expectedBindings(member, verificationPlan, cases);
    issues.push(...expected.issues);
    validateMember(member, verificationPlan, expected, invalidated, issues);
    allCaseRefs.push(...expected.caseRefs);
    allCommandRefs.push(...expected.commandRefs);
  }

  if (issues.length > 0) return failed(issues);
  return {
    ok: true,
    verificationPlan: planRef(verificationPlan),
    caseRefs: canonicalUnique(allCaseRefs, testCaseRefKey),
    commandRefs: canonicalUnique(allCommandRefs, (command) => command),
  };
}

export function evaluateWriterEntry(input: EvaluateWriterEntryInput): EntryGateResult {
  const snapshotted = snapshotWriterEntry(input);
  if (!snapshotted.ok) return snapshotted.result;
  const snapshot = snapshotted.snapshot;
  const member = safeParseValue(requestedMemberSchema, snapshot.member);
  if (member === undefined) {
    return failed([issue('PACKET_MEMBER_MISMATCH', 'requested member failed strict schema')]);
  }
  const expectedAgent = safeParseValue(expectedAgentSchema, snapshot.expectedAgent);
  if (expectedAgent === undefined) {
    return failed([issue('PACKET_AGENT_MISMATCH', 'expected agent failed strict schema')]);
  }
  const expectedWorktree = safeParseValue(expectedWorktreeSchema, snapshot.expectedWorktree);
  if (expectedWorktree === undefined) {
    return failed([issue('PACKET_PERMISSION_POLICY_MISMATCH', 'expected worktree failed strict schema')]);
  }
  const expectedVerificationCommands = safeParseValue(
    expectedVerificationCommandsSchema,
    snapshot.expectedVerificationCommands,
  );
  if (expectedVerificationCommands === undefined) {
    return failed([issue(
      'PACKET_VERIFICATION_COMMAND_MISMATCH',
      'expected verification commands failed strict schema',
    )]);
  }
  const activeWriterProjects = safeParseValue(activeWriterProjectsSchema, snapshot.activeWriterProjects);
  if (activeWriterProjects === undefined) {
    return failed([issue('WRITER_ALREADY_CLAIMED', 'active Writer projects failed strict schema')]);
  }

  const prepared = parseAndValidateEntry(snapshot);
  if (!prepared.ok) return prepared.result;
  const { wave, verificationPlan, cases, invalidatedTasks } = prepared.parsed;
  const issues = [...prepared.parsed.issues];
  if (issues.some((entry) => entry.code === 'VERIFICATION_PLAN_CONTENT_MISMATCH')) {
    return failed(issues);
  }
  if (wave.worksetId !== verificationPlan.worksetId) {
    issues.push(issue('WAVE_WORKSET_MISMATCH', `${wave.worksetId} != ${verificationPlan.worksetId}`));
  }
  if (!new Set<Wave['status']>(['PLANNED', 'RUNNING']).has(wave.status)) {
    issues.push(issue('WAVE_NOT_ENTERABLE', `${wave.id} is ${wave.status}`));
  }
  if (wave.members.length === 0) {
    issues.push(issue('WAVE_MEMBERS_EMPTY', wave.id));
  }

  const persistedMember = wave.members.find((candidate) => scopedTaskKey(candidate) === scopedTaskKey(member));
  const memberMatchesPersisted = persistedMember !== undefined && sameJson(persistedMember, member);
  if (!memberMatchesPersisted) {
    issues.push(issue('PACKET_MEMBER_MISMATCH', scopedTaskKey(member)));
  } else {
    const expected = expectedBindings(member, verificationPlan, cases);
    issues.push(...expected.issues);
    validateMember(
      member,
      verificationPlan,
      expected,
      new Set(invalidatedTasks.map(scopedTaskKey)),
      issues,
    );
  }
  if (activeWriterProjects.includes(member.project)) {
    issues.push(issue('WRITER_ALREADY_CLAIMED', member.project));
  }

  const parsedPacket = safeParsePacket(snapshot.packet);
  if (parsedPacket === undefined) {
    issues.push(issue('PACKET_SCHEMA_INVALID', 'packet failed strict schema'));
    return failed(issues);
  }
  if (hashRunPacket(parsedPacket) !== parsedPacket.packetHash) {
    issues.push(issue('PACKET_CONTENT_HASH_MISMATCH', 'packet content hash does not match its body'));
    return failed(issues);
  }
  if (parsedPacket.kind !== 'PROJECT_WRITER' && parsedPacket.kind !== 'RECOVERY_WRITER') {
    issues.push(issue('PACKET_KIND_MISMATCH', parsedPacket.kind));
    return failed(issues);
  }
  const packet = parsedPacket as WriterRunPacket;
  if (packet.worksetId !== wave.worksetId) {
    issues.push(issue('PACKET_WORKSET_MISMATCH', `${packet.worksetId} != ${wave.worksetId}`));
  }
  if (packet.waveId !== wave.id) {
    issues.push(issue('PACKET_WAVE_MISMATCH', `${String(packet.waveId)} != ${wave.id}`));
  }
  if (scopedTaskKey(packet.scopedTask) !== scopedTaskKey(member) || packet.objective !== member.objective) {
    issues.push(issue('PACKET_MEMBER_MISMATCH', scopedTaskKey(packet.scopedTask)));
  }
  if (!sameRef(packet.verificationPlan, member.verificationPlan, verificationPlanRefKey)) {
    issues.push(issue('PACKET_PLAN_MISMATCH', packet.id));
  }
  if (!sameArray(packet.contracts, member.contracts, contractRefKey)) {
    issues.push(issue('PACKET_CONTRACT_MISMATCH', packet.id));
  }
  if (!sameArray(packet.testCaseRefs, member.testCaseRefs, testCaseRefKey)) {
    issues.push(issue('PACKET_CASE_REF_MISMATCH', packet.id));
  }
  if (!sameArray(packet.commandRefs, member.commandRefs, (command) => command)) {
    issues.push(issue('PACKET_COMMAND_REF_MISMATCH', packet.id));
  }
  if (!sameArray(packet.verificationCommands, expectedVerificationCommands, (command) => command)) {
    issues.push(issue('PACKET_VERIFICATION_COMMAND_MISMATCH', packet.id));
  }
  if (!sameArray(packet.allowedPaths, member.allowedPaths, (path) => path)) {
    issues.push(issue('PACKET_ALLOWED_PATHS_MISMATCH', packet.id));
  }
  if (packet.allowedPaths.some((path) => !isSafeAllowedPath(path))) {
    issues.push(issue('PACKET_ALLOWED_PATH_INVALID', packet.id));
  }
  if (
    member.agentId !== expectedAgent.agentId ||
    packet.agent.agentId !== member.agentId ||
    packet.agent.agentId !== expectedAgent.agentId ||
    packet.agent.protocol !== expectedAgent.protocol
  ) {
    issues.push(issue('PACKET_AGENT_MISMATCH', packet.id));
  }
  if (!matchesPermissionPolicy(packet, expectedWorktree)) {
    issues.push(issue('PACKET_PERMISSION_POLICY_MISMATCH', packet.id));
  }
  // Envelope 解析让准入门先区分哈希、路径和身份漂移；完整 Packet 语义仍必须
  // 在真正放行前通过，避免精确诊断成为绕过既有 Packet 不变量的后门。
  if (!runPacketSchema.safeParse(packet).success) {
    issues.push(issue('PACKET_SCHEMA_INVALID', 'packet failed semantic schema'));
  }

  if (issues.length > 0) return failed(issues);
  return {
    ok: true,
    verificationPlan: member.verificationPlan!,
    caseRefs: member.testCaseRefs!,
    commandRefs: member.commandRefs!,
  };
}

function parseAndValidateEntry(input: WaveEntrySnapshot): ParseEntryResult {
  const wave = safeParseWave(input.wave);
  if (wave === undefined) {
    return { ok: false, result: failed([issue('WAVE_SCHEMA_INVALID', 'wave failed strict schema')]) };
  }
  const verificationPlan = safeParseVerificationPlan(input.verificationPlan);
  if (verificationPlan === undefined) {
    return {
      ok: false,
      result: failed([issue('VERIFICATION_PLAN_SCHEMA_INVALID', 'verification plan failed strict schema')]),
    };
  }
  if (verificationPlan.schemaVersion === 1) {
    return {
      ok: false,
      result: failed([issue(
        'ADVERSARIAL_ASSURANCE_UNPROVEN',
        'current admission requires VerificationPlan v2 assurance',
      )]),
    };
  }
  const adversarialPolicy = safeParseAdversarialPolicy(input.adversarialPolicy);
  if (adversarialPolicy === undefined) {
    return {
      ok: false,
      result: failed([issue('ADVERSARIAL_POLICY_STALE', 'adversarial policy failed strict schema')]),
    };
  }
  const adversarialPolicyRef = safeParseAdversarialPolicyRef(input.adversarialPolicyRef);
  if (adversarialPolicyRef === undefined) {
    return {
      ok: false,
      result: failed([issue('ADVERSARIAL_POLICY_STALE', 'adversarial policy ref failed strict schema')]),
    };
  }
  if (
    adversarialPolicyRef.contentHash !== adversarialPolicy.contentHash ||
    !sameSourceRef(adversarialPolicyRef, verificationPlan.adversarialPolicy)
  ) {
    return {
      ok: false,
      result: failed([issue('ADVERSARIAL_POLICY_STALE', 'supplied policy ref is not the plan policy')]),
    };
  }
  const authoritativeSourceRefs = safeParseValue(authoritativeSourceRefsSchema, input.authoritativeSourceRefs);
  if (authoritativeSourceRefs === undefined) {
    return {
      ok: false,
      result: failed([issue('VERIFICATION_PLAN_CONTENT_MISMATCH', 'verification plan could not be reproduced')]),
    };
  }
  const cases = safeParseValue(compiledCasesSchema, input.cases);
  if (cases === undefined) {
    return {
      ok: false,
      result: failed([issue('VERIFICATION_PLAN_CONTENT_MISMATCH', 'verification plan could not be reproduced')]),
    };
  }
  const invalidatedTasks = safeParseValue(invalidatedTasksSchema, input.invalidatedTasks);
  if (invalidatedTasks === undefined) {
    return {
      ok: false,
      result: failed([issue('WAVE_SCHEMA_INVALID', 'invalidated tasks failed strict schema')]),
    };
  }
  return {
    ok: true,
    parsed: {
      wave,
      verificationPlan,
      adversarialPolicy,
      adversarialPolicyRef,
      authoritativeSourceRefs,
      cases,
      invalidatedTasks,
      issues: validatePlan(verificationPlan, {
        adversarialPolicy,
        adversarialPolicyRef,
        authoritativeSourceRefs,
        cases,
      }),
    },
  };
}

function snapshotWaveEntry(input: unknown): SnapshotResult<WaveEntrySnapshot> {
  let field: keyof WaveEntrySnapshot = 'wave';
  try {
    const value = input as Record<keyof WaveEntrySnapshot, unknown>;
    field = 'wave';
    const wave = value.wave;
    field = 'verificationPlan';
    const verificationPlan = value.verificationPlan;
    field = 'adversarialPolicy';
    const adversarialPolicy = value.adversarialPolicy;
    field = 'adversarialPolicyRef';
    const adversarialPolicyRef = value.adversarialPolicyRef;
    field = 'authoritativeSourceRefs';
    const authoritativeSourceRefs = value.authoritativeSourceRefs;
    field = 'cases';
    const cases = value.cases;
    field = 'invalidatedTasks';
    const invalidatedTasks = value.invalidatedTasks;
    return {
      ok: true,
      snapshot: {
        wave,
        verificationPlan,
        adversarialPolicy,
        adversarialPolicyRef,
        authoritativeSourceRefs,
        cases,
        invalidatedTasks,
      },
    };
  } catch {
    return { ok: false, result: failed([snapshotIssue(field)]) };
  }
}

function snapshotWriterEntry(input: unknown): SnapshotResult<WriterEntrySnapshot> {
  let field: keyof WriterEntrySnapshot = 'wave';
  try {
    const value = input as Record<keyof WriterEntrySnapshot, unknown>;
    field = 'wave';
    const wave = value.wave;
    field = 'verificationPlan';
    const verificationPlan = value.verificationPlan;
    field = 'adversarialPolicy';
    const adversarialPolicy = value.adversarialPolicy;
    field = 'adversarialPolicyRef';
    const adversarialPolicyRef = value.adversarialPolicyRef;
    field = 'authoritativeSourceRefs';
    const authoritativeSourceRefs = value.authoritativeSourceRefs;
    field = 'cases';
    const cases = value.cases;
    field = 'invalidatedTasks';
    const invalidatedTasks = value.invalidatedTasks;
    field = 'member';
    const member = value.member;
    field = 'packet';
    const packet = value.packet;
    field = 'expectedAgent';
    const expectedAgent = value.expectedAgent;
    field = 'expectedWorktree';
    const expectedWorktree = value.expectedWorktree;
    field = 'expectedVerificationCommands';
    const expectedVerificationCommands = value.expectedVerificationCommands;
    field = 'activeWriterProjects';
    const activeWriterProjects = value.activeWriterProjects;
    return {
      ok: true,
      snapshot: {
        wave,
        verificationPlan,
        adversarialPolicy,
        adversarialPolicyRef,
        authoritativeSourceRefs,
        cases,
        invalidatedTasks,
        member,
        packet,
        expectedAgent,
        expectedWorktree,
        expectedVerificationCommands,
        activeWriterProjects,
      },
    };
  } catch {
    return { ok: false, result: failed([snapshotIssue(field)]) };
  }
}

function snapshotIssue(field: keyof WriterEntrySnapshot): EntryGateIssue {
  switch (field) {
    case 'wave':
      return issue('WAVE_SCHEMA_INVALID', 'wave failed strict schema');
    case 'verificationPlan':
      return issue('VERIFICATION_PLAN_SCHEMA_INVALID', 'verification plan failed strict schema');
    case 'adversarialPolicy':
      return issue('ADVERSARIAL_POLICY_STALE', 'adversarial policy failed strict schema');
    case 'adversarialPolicyRef':
      return issue('ADVERSARIAL_POLICY_STALE', 'adversarial policy ref failed strict schema');
    case 'authoritativeSourceRefs':
    case 'cases':
      return issue('VERIFICATION_PLAN_CONTENT_MISMATCH', 'verification plan could not be reproduced');
    case 'invalidatedTasks':
      return issue('WAVE_SCHEMA_INVALID', 'invalidated tasks failed strict schema');
    case 'member':
      return issue('PACKET_MEMBER_MISMATCH', 'requested member failed strict schema');
    case 'packet':
      return issue('PACKET_SCHEMA_INVALID', 'packet failed strict schema');
    case 'expectedAgent':
      return issue('PACKET_AGENT_MISMATCH', 'expected agent failed strict schema');
    case 'expectedWorktree':
      return issue('PACKET_PERMISSION_POLICY_MISMATCH', 'expected worktree failed strict schema');
    case 'expectedVerificationCommands':
      return issue('PACKET_VERIFICATION_COMMAND_MISMATCH', 'expected verification commands failed strict schema');
    case 'activeWriterProjects':
      return issue('WRITER_ALREADY_CLAIMED', 'active Writer projects failed strict schema');
  }
}

function safeParseWave(value: unknown): Wave | undefined {
  try {
    const parsed = waveSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function safeParseVerificationPlan(value: unknown): ReturnType<typeof anyVerificationPlanSchema.parse> | undefined {
  try {
    const parsed = anyVerificationPlanSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function safeParsePacket(value: unknown): RunPacket | undefined {
  try {
    const parsed = runPacketEnvelopeSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function safeParseAdversarialPolicy(value: unknown): AdversarialCoveragePolicy | undefined {
  try {
    const parsed = adversarialCoveragePolicySchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function safeParseAdversarialPolicyRef(value: unknown): AdversarialPolicyRef | undefined {
  try {
    const parsed = contentAddressedSourceRefSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function safeParseValue<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  try {
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function validatePlan(
  plan: VerificationPlanV2,
  input: Readonly<{
    adversarialPolicy: AdversarialCoveragePolicy;
    adversarialPolicyRef: AdversarialPolicyRef;
    authoritativeSourceRefs: readonly ContentAddressedSourceRef[];
    cases: readonly CompiledTestCase[];
  }>,
): EntryGateIssue[] {
  const issues: EntryGateIssue[] = [];
  if (plan.status !== 'READY') {
    issues.push(issue('VERIFICATION_PLAN_NOT_READY', `${plan.id} is ${plan.status}`));
  }
  try {
    const expectedSourceRefs = authoritativeSourceRefsForPlan(plan, input.cases);
    if (!sameSourceRefSet(input.authoritativeSourceRefs, expectedSourceRefs)) {
      issues.push(issue('VERIFICATION_PLAN_CONTENT_MISMATCH', 'verification plan could not be reproduced'));
      return issues;
    }
    const reproduced = compileVerificationPlanV2({
      id: plan.id,
      worksetId: plan.worksetId,
      scopeHash: plan.scopeHash,
      contractSnapshots: plan.contractSnapshots,
      profile: plan.profile,
      requiredTasks: plan.projectChecks.flatMap((check) => check.scopedTasks),
      cases: input.cases,
      adversarialPolicy: input.adversarialPolicy,
      adversarialPolicyRef: input.adversarialPolicyRef,
      adversarialRequirements: plan.adversarialRequirements,
      adversarialExemptions: plan.adversarialExemptions,
      authoritativeSourceRefs: input.authoritativeSourceRefs,
      createdAt: plan.createdAt,
    });
    if (reproduced.contentHash !== plan.contentHash) {
      issues.push(issue('VERIFICATION_PLAN_CONTENT_MISMATCH', 'verification plan could not be reproduced'));
    }
  } catch {
    issues.push(issue('VERIFICATION_PLAN_CONTENT_MISMATCH', 'verification plan could not be reproduced'));
  }
  return issues;
}

function expectedBindings(
  member: Wave['members'][number],
  plan: VerificationPlanV2,
  cases: readonly CompiledTestCase[],
): {
  readonly caseRefs: readonly TestCaseRef[];
  readonly commandRefs: readonly string[];
  readonly contracts: readonly ContractRef[];
  readonly issues: readonly EntryGateIssue[];
} {
  const check = plan.projectChecks.find((candidate) =>
    candidate.project === member.project &&
    candidate.scopedTasks.some((task) => scopedTaskKey(task) === scopedTaskKey(member)));
  if (check === undefined) {
    return {
      caseRefs: [],
      commandRefs: [],
      contracts: [],
      issues: [issue('TASK_CASE_COVERAGE_MISSING', scopedTaskKey(member))],
    };
  }
  const allowedCaseKeys = new Set(check.caseRefs.map(testCaseRefKey));
  const matchingCases = cases.filter((compiled) =>
    allowedCaseKeys.has(testCaseRefKey(compiled.ref)) &&
    compiled.testCase.scopedTasks.some((task) => scopedTaskKey(task) === scopedTaskKey(member)));
  const caseRefs = canonicalUnique(matchingCases.map((compiled) => compiled.ref), testCaseRefKey);
  const commandRefs = canonicalUnique(
    matchingCases.flatMap((compiled) => compiled.testCase.commandRefs),
    (command) => command,
  );
  const contracts = canonicalUnique(
    cases.flatMap((compiled) =>
      compiled.ref.scope.kind === 'CONTRACT' &&
      compiled.testCase.scopedTasks.some((task) => scopedTaskKey(task) === scopedTaskKey(member))
        ? [compiled.ref.scope.contractSnapshot]
        : []),
    contractRefKey,
  );
  return {
    caseRefs,
    commandRefs,
    contracts,
    issues: caseRefs.length === 0 && !isFullyExemptTask(member, plan)
      ? [issue('TASK_CASE_COVERAGE_MISSING', scopedTaskKey(member))]
      : [],
  };
}

function isFullyExemptTask(
  task: ScopedTaskRef,
  plan: VerificationPlanV2,
): boolean {
  const taskKey = scopedTaskKey(task);
  const requirement = plan.adversarialRequirements.find((candidate) =>
    candidate.scope.kind === 'TASK' && scopedTaskKey(candidate.scope.scopedTask) === taskKey);
  if (requirement === undefined) return false;
  return requirement.vectorIds.every((vectorId) => {
    const checked = plan.adversarialChecks.some((check) =>
      check.scope.kind === 'TASK' &&
      scopedTaskKey(check.scope.scopedTask) === taskKey &&
      check.vectors.some((vector) => vector.vectorId === vectorId));
    const exempted = plan.adversarialExemptions.some((exemption) =>
      exemption.scope.kind === 'TASK' &&
      scopedTaskKey(exemption.scope.scopedTask) === taskKey &&
      exemption.vectorIds.includes(vectorId));
    return !checked && exempted;
  });
}

function validateMember(
  member: Wave['members'][number],
  plan: VerificationPlanV2,
  expected: ReturnType<typeof expectedBindings>,
  invalidated: ReadonlySet<string>,
  issues: EntryGateIssue[],
): void {
  if (invalidated.has(scopedTaskKey(member))) {
    issues.push(issue('TASK_INVALIDATED', scopedTaskKey(member)));
  }
  if (!sameRef(member.verificationPlan, planRef(plan), verificationPlanRefKey)) {
    issues.push(issue('VERIFICATION_PLAN_REF_MISMATCH', scopedTaskKey(member)));
  }
  if (!sameArray(member.testCaseRefs, expected.caseRefs, testCaseRefKey)) {
    issues.push(issue('TEST_CASE_REF_MISMATCH', scopedTaskKey(member)));
  }
  if (!sameArray(member.commandRefs, expected.commandRefs, (command) => command)) {
    issues.push(issue('COMMAND_REF_MISMATCH', scopedTaskKey(member)));
  }
  if (!sameArray(member.contracts, expected.contracts, contractRefKey)) {
    issues.push(issue('CONTRACT_SNAPSHOT_MISMATCH', scopedTaskKey(member)));
  }
}

function isSafeAllowedPath(value: string): boolean {
  if (value.length === 0 || value.includes('\\') || posix.isAbsolute(value)) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function normalizeAbsolute(value: string): string | undefined {
  return isAbsolute(value) ? resolve(value) : undefined;
}

function matchesPermissionPolicy(packet: WriterRunPacket, expectedWorktree: string): boolean {
  const expected = normalizeAbsolute(expectedWorktree);
  const packetWorktree = normalizeAbsolute(packet.git.worktree);
  const roots = packet.permissionPolicy.filesystemRoots;
  return expected !== undefined &&
    packetWorktree === expected &&
    roots.length === 1 &&
    normalizeAbsolute(roots[0]!) === expected;
}

function failed(issues: readonly EntryGateIssue[]): EntryGateResult {
  return {
    ok: false,
    issues: canonicalUnique(issues, (item) => JSON.stringify([item.code, item.detail])),
  };
}

function issue(code: EntryGateIssueCode, detail: string): EntryGateIssue {
  return { code, detail };
}

function planRef(plan: VerificationPlanV2): VerificationPlanRef {
  return { id: plan.id, contentHash: plan.contentHash };
}

function verificationPlanRefKey(ref: VerificationPlanRef): string {
  return JSON.stringify([ref.id, ref.contentHash]);
}

function contractRefKey(ref: ContractRef): string {
  return JSON.stringify([ref.id, ref.contentHash]);
}

function sameSourceRef(left: AdversarialPolicyRef, right: ContentAddressedSourceRef): boolean {
  return left.ref === right.ref && left.contentHash === right.contentHash;
}

function authoritativeSourceRefsForPlan(
  plan: VerificationPlanV2,
  cases: readonly CompiledTestCase[],
): readonly ContentAddressedSourceRef[] {
  const adversarialCaseKeys = new Set(plan.adversarialChecks.flatMap((check) =>
    check.vectors.flatMap((vector) => vector.caseRefs.map(testCaseRefKey))));
  return canonicalUnique([
    ...cases
      .filter((compiled) => adversarialCaseKeys.has(testCaseRefKey(compiled.ref)))
      .flatMap((compiled) => compiled.testCase.sourceRefs),
    ...plan.adversarialExemptions.flatMap((exemption) => exemption.sourceRefs),
  ], sourceRefKey);
}

function sameSourceRefSet(
  left: readonly ContentAddressedSourceRef[],
  right: readonly ContentAddressedSourceRef[],
): boolean {
  return sameArray(
    canonicalUnique(left, sourceRefKey),
    canonicalUnique(right, sourceRefKey),
    sourceRefKey,
  );
}

function sourceRefKey(ref: ContentAddressedSourceRef): string {
  return JSON.stringify([ref.ref, ref.contentHash]);
}

function sameRef<T>(
  left: T | undefined,
  right: T | undefined,
  key: (value: T) => string,
): boolean {
  return left !== undefined && right !== undefined && key(left) === key(right);
}

function sameArray<T>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
  key: (value: T) => string,
): boolean {
  if (left === undefined || right === undefined || left.length !== right.length) return false;
  return left.every((item, index) => key(item) === key(right[index]!));
}

function canonicalUnique<T>(items: readonly T[], key: (value: T) => string): readonly T[] {
  const sorted = [...items].sort((left, right) => compare(key(left), key(right)));
  return sorted.filter((item, index) => index === 0 || key(sorted[index - 1]!) !== key(item));
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
