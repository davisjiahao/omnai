import { z } from 'zod';
import {
  anyTestCaseSchema,
  contractTestCaseRef,
  hashTestCase,
  projectTestCaseRef,
  testCaseRefSchema,
  testCaseSchema,
  testCaseV2Schema,
  type AnyTestCase,
  type ContentHash,
  type ScopedTaskRef,
  type TestCase,
  type TestCaseV2,
  type TestCaseRef,
} from '../types.js';

/**
 * 纯 TestCase 编译器使用的闭合错误码。
 * 该编译器不写入工作区，只把候选内容规范化为哈希绑定的不可变事实。
 */
export type VerificationFlowIssueCode =
  | 'TEST_CASE_SOURCE_REFS_REQUIRED'
  | 'TEST_CASE_SCOPED_TASKS_REQUIRED'
  | 'TEST_CASE_COMMAND_REFS_REQUIRED'
  | 'TEST_CASE_SCHEMA_INVALID'
  | 'TEST_CASE_SCOPE_MISMATCH'
  | 'TEST_CASE_CONTRACT_LEVEL_REQUIRED'
  | 'TEST_CASE_PROJECT_LEVEL_REQUIRED'
  | 'TEST_CASE_DUPLICATE_REF'
  | 'VERIFICATION_REQUIRED_TASKS_EMPTY'
  | 'VERIFICATION_TASK_DUPLICATE'
  | 'VERIFICATION_TASK_UNCOVERED'
  | 'VERIFICATION_CASE_TASK_OUTSIDE_SCOPE'
  | 'VERIFICATION_CONTRACT_MISMATCH'
  | 'VERIFICATION_CASE_SCHEMA_INVALID'
  | 'VERIFICATION_CASE_REF_MISMATCH'
  | 'VERIFICATION_CASE_IDENTITY_CONFLICT'
  | 'VERIFICATION_PLAN_INPUT_INVALID'
  | 'ADVERSARIAL_POLICY_MISSING'
  | 'ADVERSARIAL_POLICY_STALE'
  | 'ADVERSARIAL_POLICY_VECTOR_UNKNOWN'
  | 'ADVERSARIAL_CASE_INVALID'
  | 'ADVERSARIAL_CASE_TASK_OUTSIDE_SCOPE'
  | 'ADVERSARIAL_WRITER_COVERAGE_MISSING'
  | 'ADVERSARIAL_COVERAGE_MISSING'
  | 'ADVERSARIAL_SAFETY_ORACLE_MISSING'
  | 'ADVERSARIAL_EXEMPTION_INVALID'
  | 'TEST_CASE_SOURCE_IDENTITY_CONFLICT';

export class VerificationFlowError extends Error {
  constructor(
    readonly code: VerificationFlowIssueCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'VerificationFlowError';
  }
}

export type TestCaseProposal =
  | Omit<TestCase, 'contentHash'>
  | Omit<TestCaseV2, 'contentHash'>;

export interface CompileTestCaseInput {
  readonly scope: TestCaseRef['scope'];
  readonly testCase: TestCaseProposal;
}

export interface CompiledTestCase {
  readonly testCase: AnyTestCase;
  readonly ref: TestCaseRef;
}

const PROJECT_LEVELS = new Set<TestCase['level']>(['UNIT', 'COMPONENT']);
const CONTRACT_LEVELS = new Set<TestCase['level']>([
  'CONTRACT_PROVIDER',
  'CONTRACT_CONSUMER',
  'INTEGRATION',
  'E2E',
]);

// Proposals stay permissive for empty and non-canonical arrays so the compiler
// can preserve legacy required-field errors and canonicalize before persistence.
const {
  contentHash: _v1ContentHash,
  sourceRefs: v1SourceRefsSchema,
  scopedTasks: v1ScopedTasksSchema,
  commandRefs: v1CommandRefsSchema,
  ...v1ProposalShape
} = testCaseSchema.shape;
const testCaseV1ProposalSchema = z.strictObject({
  ...v1ProposalShape,
  sourceRefs: z.array(v1SourceRefsSchema.unwrap().element).readonly(),
  scopedTasks: z.array(v1ScopedTasksSchema.unwrap().element).readonly(),
  commandRefs: z.array(v1CommandRefsSchema.unwrap().element).readonly(),
});

const adversarialFactsSchema = testCaseV2Schema.shape.adversarial.unwrap();
const {
  threatRefs: threatRefsSchema,
  vectorIds: vectorIdsSchema,
  safetyProperties: safetyPropertiesSchema,
  ...adversarialFactsShape
} = adversarialFactsSchema.shape;
const testCaseProposalAdversarialFactsSchema = z.strictObject({
  ...adversarialFactsShape,
  threatRefs: z.array(threatRefsSchema.unwrap().element).readonly(),
  vectorIds: z.array(vectorIdsSchema.unwrap().element).readonly(),
  safetyProperties: z.array(safetyPropertiesSchema.unwrap().element).readonly(),
});
const {
  contentHash: _v2ContentHash,
  sourceRefs: v2SourceRefsSchema,
  scopedTasks: v2ScopedTasksSchema,
  commandRefs: v2CommandRefsSchema,
  adversarial: _v2AdversarialSchema,
  ...v2ProposalShape
} = testCaseV2Schema.shape;
const testCaseV2ProposalSchema = z.strictObject({
  ...v2ProposalShape,
  sourceRefs: z.array(v2SourceRefsSchema.unwrap().element).readonly(),
  scopedTasks: z.array(v2ScopedTasksSchema.unwrap().element).readonly(),
  commandRefs: z.array(v2CommandRefsSchema.unwrap().element).readonly(),
  adversarial: testCaseProposalAdversarialFactsSchema.optional(),
});

const compileTestCaseInputSchema = z.strictObject({
  scope: testCaseRefSchema.shape.scope,
  testCase: z.discriminatedUnion('schemaVersion', [testCaseV1ProposalSchema, testCaseV2ProposalSchema]),
});

type CompileTestCaseInputSnapshot =
  | {
    readonly ok: true;
    readonly input: z.infer<typeof compileTestCaseInputSchema>;
  }
  | {
    readonly ok: false;
    readonly testCase: unknown;
  };

export function compileTestCase(input: CompileTestCaseInput): CompiledTestCase {
  const snapshot = snapshotCompileTestCaseInput(input);
  const schemaVersion = testCaseProposalVersion(snapshot.ok ? snapshot.input.testCase : snapshot.testCase);
  if (!snapshot.ok) throw normalizeTestCaseError(undefined, schemaVersion);
  try {
    return compileTestCaseProposal(snapshot.input);
  } catch (error) {
    throw normalizeTestCaseError(error, schemaVersion);
  }
}

function snapshotCompileTestCaseInput(input: unknown): CompileTestCaseInputSnapshot {
  let testCase: unknown;
  try {
    const envelope = input as { readonly scope: unknown; readonly testCase: unknown };
    testCase = envelope.testCase;
    const scope = envelope.scope;
    const parsed = compileTestCaseInputSchema.safeParse({ scope, testCase });
    return parsed.success
      ? { ok: true, input: parsed.data }
      : { ok: false, testCase };
  } catch {
    return { ok: false, testCase };
  }
}

function compileTestCaseProposal(input: CompileTestCaseInput): CompiledTestCase {
  if (input.testCase.schemaVersion === 1 && input.testCase.sourceRefs.length === 0) {
    throw new VerificationFlowError('TEST_CASE_SOURCE_REFS_REQUIRED', input.testCase.id);
  }
  if (input.testCase.schemaVersion === 1 && input.testCase.scopedTasks.length === 0) {
    throw new VerificationFlowError('TEST_CASE_SCOPED_TASKS_REQUIRED', input.testCase.id);
  }
  if (input.testCase.schemaVersion === 1 && input.testCase.commandRefs.length === 0) {
    throw new VerificationFlowError('TEST_CASE_COMMAND_REFS_REQUIRED', input.testCase.id);
  }
  requireOneHashPerLogicalRef(input.testCase.sourceRefs, 'sourceRefs');
  const sourceRefs = canonicalUnique(
    input.testCase.sourceRefs,
    (source) => JSON.stringify([source.ref, source.contentHash]),
    'sourceRefs',
  );
  const scopedTasks = canonicalUnique(
    input.testCase.scopedTasks,
    scopedTaskKey,
    'scopedTasks',
  );
  const commandRefs = canonicalUnique(input.testCase.commandRefs, (command) => command, 'commandRefs');

  validateScope(input.scope, input.testCase.level, scopedTasks);

  const common = {
    id: input.testCase.id,
    level: input.testCase.level,
    title: input.testCase.title,
    sourceRefs,
    scopedTasks,
    commandRefs,
    expectedOutcome: input.testCase.expectedOutcome,
  };
  const bodyWithoutHash: TestCaseProposal = input.testCase.schemaVersion === 1
    ? {
        ...input.testCase,
        ...common,
        schemaVersion: 1,
        acceptanceCriteriaRefs: canonicalUnique(
          input.testCase.acceptanceCriteriaRefs,
          (ref) => JSON.stringify([ref.ref, ref.contentHash]),
          'acceptanceCriteriaRefs',
        ),
        contractRefs: canonicalUnique(
          input.testCase.contractRefs,
          (ref) => JSON.stringify([ref.id, ref.contentHash]),
          'contractRefs',
        ),
        scenarioRefs: canonicalUnique(
          input.testCase.scenarioRefs,
          (ref) => JSON.stringify([
            ref.contractKey,
            ref.scopeHash,
            ref.snapshot.id,
            ref.snapshot.contentHash,
            ref.scenarioId,
            ref.contentHash,
          ]),
          'scenarioRefs',
        ),
        ownerProjects: canonicalUnique(
          input.testCase.ownerProjects,
          (project) => project,
          'ownerProjects',
        ),
        testPaths: canonicalUnique(input.testCase.testPaths, (path) => path, 'testPaths'),
        evidenceRequired: canonicalUnique(
          input.testCase.evidenceRequired,
          (evidence) => evidence,
          'evidenceRequired',
        ),
      }
    : input.testCase.adversarial === undefined
      ? { ...common, schemaVersion: 2 }
      : {
        ...common,
        schemaVersion: 2,
        adversarial: {
          threatRefs: canonicalThreatRefs(input.testCase.adversarial.threatRefs),
          vectorIds: canonicalUnique(
            input.testCase.adversarial.vectorIds,
            (vectorId) => vectorId,
            'adversarial.vectorIds',
          ),
          safetyProperties: canonicalUnique(
            input.testCase.adversarial.safetyProperties,
            (property) => property,
            'adversarial.safetyProperties',
          ),
          hypothesis: input.testCase.adversarial.hypothesis,
        },
      };
  const testCase = anyTestCaseSchema.parse({
    ...bodyWithoutHash,
    contentHash: hashTestCase(bodyWithoutHash),
  });
  const ref = input.scope.kind === 'PROJECT'
    ? projectTestCaseRef(
      {
        project: input.scope.project,
        changeId: input.scope.changeId,
        revision: input.scope.revision,
      },
      testCase.id,
      testCase.contentHash,
    )
    : contractTestCaseRef(
      input.scope.worksetId,
      input.scope.contractKey,
      input.scope.scopeHash,
      input.scope.contractSnapshot,
      input.scope.scenarioId,
      testCase.id,
      testCase.contentHash,
    );

  return { testCase, ref };
}

function testCaseProposalVersion(testCase: unknown): 1 | 2 | undefined {
  try {
    if (testCase === null || typeof testCase !== 'object') return undefined;
    const schemaVersion = (testCase as { readonly schemaVersion?: unknown }).schemaVersion;
    return schemaVersion === 1 || schemaVersion === 2 ? schemaVersion : undefined;
  } catch {
    return undefined;
  }
}

function normalizeTestCaseError(error: unknown, schemaVersion: 1 | 2 | undefined): VerificationFlowError {
  if (schemaVersion === 2) {
    if (error instanceof VerificationFlowError && error.code === 'TEST_CASE_SOURCE_IDENTITY_CONFLICT') {
      return new VerificationFlowError(
        'TEST_CASE_SOURCE_IDENTITY_CONFLICT',
        'source ref binds more than one content hash',
      );
    }
    return new VerificationFlowError(
      'ADVERSARIAL_CASE_INVALID',
      'TestCase v2 proposal failed strict validation',
    );
  }
  if (schemaVersion === 1 && error instanceof VerificationFlowError) {
    const detail = legacyTestCaseErrorDetail(error.code);
    if (detail !== undefined) return new VerificationFlowError(error.code, detail);
  }
  return new VerificationFlowError(
    'TEST_CASE_SCHEMA_INVALID',
    'test case proposal failed strict validation',
  );
}

function legacyTestCaseErrorDetail(code: VerificationFlowIssueCode): string | undefined {
  switch (code) {
    case 'TEST_CASE_SOURCE_REFS_REQUIRED':
      return 'TestCase v1 source refs are required';
    case 'TEST_CASE_SCOPED_TASKS_REQUIRED':
      return 'TestCase v1 scoped tasks are required';
    case 'TEST_CASE_COMMAND_REFS_REQUIRED':
      return 'TestCase v1 command refs are required';
    case 'TEST_CASE_SCHEMA_INVALID':
      return 'test case proposal failed strict validation';
    case 'TEST_CASE_SCOPE_MISMATCH':
      return 'TestCase v1 scope must match every scoped task';
    case 'TEST_CASE_CONTRACT_LEVEL_REQUIRED':
      return 'contract-scoped TestCase v1 requires a contract level';
    case 'TEST_CASE_PROJECT_LEVEL_REQUIRED':
      return 'project-scoped TestCase v1 requires a project level';
    case 'TEST_CASE_DUPLICATE_REF':
      return 'TestCase v1 refs must be unique';
    case 'TEST_CASE_SOURCE_IDENTITY_CONFLICT':
      return 'source ref binds more than one content hash';
    default:
      return undefined;
  }
}

function canonicalThreatRefs(
  refs: readonly TestCaseV2['sourceRefs'][number][],
): readonly TestCaseV2['sourceRefs'][number][] {
  requireOneHashPerLogicalRef(refs, 'adversarial.threatRefs');
  return canonicalUnique(
    refs,
    (source) => JSON.stringify([source.ref, source.contentHash]),
    'adversarial.threatRefs',
  );
}

function requireOneHashPerLogicalRef(
  refs: readonly TestCaseV2['sourceRefs'][number][],
  field: string,
): void {
  const hashes = new Map<string, ContentHash>();
  for (const source of refs) {
    const current = hashes.get(source.ref);
    if (current !== undefined && current !== source.contentHash) {
      throw new VerificationFlowError(
        'TEST_CASE_SOURCE_IDENTITY_CONFLICT',
        `${field} binds ${source.ref} to both ${current} and ${source.contentHash}`,
      );
    }
    hashes.set(source.ref, source.contentHash);
  }
}

export function scopedTaskKey(task: ScopedTaskRef): string {
  return JSON.stringify([task.project, task.changeId, task.revision, task.baseline, task.taskId]);
}

export function testCaseScopedIdentityKey(ref: TestCaseRef): string {
  return JSON.stringify([ref.scope, ref.id]);
}

function validateScope(
  scope: TestCaseRef['scope'],
  level: TestCase['level'],
  tasks: readonly ScopedTaskRef[],
): void {
  if (scope.kind === 'PROJECT') {
    if (!PROJECT_LEVELS.has(level)) {
      throw new VerificationFlowError(
        'TEST_CASE_PROJECT_LEVEL_REQUIRED',
        `project-scoped case ${scope.project} cannot use ${level}`,
      );
    }
    for (const task of tasks) {
      if (task.project !== scope.project || task.changeId !== scope.changeId || task.revision !== scope.revision) {
        throw new VerificationFlowError(
          'TEST_CASE_SCOPE_MISMATCH',
          `case scope ${scope.project}/${scope.changeId}/${scope.revision} does not match task ${scopedTaskKey(task)}`,
        );
      }
    }
    return;
  }

  if (!CONTRACT_LEVELS.has(level)) {
    throw new VerificationFlowError(
      'TEST_CASE_CONTRACT_LEVEL_REQUIRED',
      `contract-scoped case ${scope.contractKey}/${scope.scenarioId} cannot use ${level}`,
    );
  }
}

function canonicalUnique<T>(
  items: readonly T[],
  key: (item: T) => string,
  field: string,
): readonly T[] {
  const result = [...items].sort((left, right) => compare(key(left), key(right)));
  for (let index = 1; index < result.length; index += 1) {
    if (key(result[index - 1]!) === key(result[index]!)) {
      throw new VerificationFlowError('TEST_CASE_DUPLICATE_REF', `${field} contains ${key(result[index]!)}`);
    }
  }
  return result;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
