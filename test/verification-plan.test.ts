import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import YAML from 'yaml';
import { changeArtifactPath, projectConfigPath } from '../src/core/paths.js';
import {
  createChange,
  loadProjectConfig,
  saveProjectConfig,
} from '../src/core/store.js';
import { saveTasks } from '../src/core/tasks.js';
import type { ProjectTestPlanCandidate } from '../src/execution/artifacts.js';
import type { ContractSnapshot } from '../src/execution/contracts/store.js';
import { hashObject, sha256 } from '../src/execution/hashing.js';
import { verificationPlansRoot } from '../src/execution/paths.js';
import type { ProjectTestPlannerContractScenario } from '../src/execution/packets.js';
import {
  createDefaultVerificationPolicy,
  createVerificationPolicy,
  deriveContractTestCases,
  ensureProjectTestCases,
  loadProjectTestCaseSet,
  type ProjectTestPlannerRequest,
  type VerificationPlannerContext,
} from '../src/execution/verification/test-cases.js';
import {
  compileVerificationPlan,
  invalidateVerificationPlans,
  loadReadyVerificationPlan,
  markVerificationPlanReady,
  validateVerificationPlanCoverage,
  type VerificationPlanScope,
} from '../src/execution/verification/planner.js';
import {
  hashVerificationPlan,
  hashIntegrationEnvironmentProfile,
  testCaseRefKey,
  type ContentHash,
  type ContractScenarioRef,
  type IntegrationEnvironmentProfile,
  type ScopedTaskRef,
} from '../src/execution/types.js';
import { createWorkset, saveWorkset } from '../src/workspace/worksets.js';
import type { Workset } from '../src/workspace/types.js';
import { createTestDirectory, createTestRepository } from './helpers.js';

const NOW = '2026-08-16T00:00:00.000Z';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

interface FixtureOptions {
  readonly projects?: readonly string[];
  readonly duplicateDisplayId?: boolean;
  readonly includeContract?: boolean;
  readonly legacyCommands?: readonly string[];
  readonly profileHash?: ContentHash;
  readonly secondTask?: boolean;
  readonly omitSecondTaskCase?: boolean;
  readonly omitAllTaskCases?: boolean;
  readonly secondAcceptanceCriterion?: boolean;
  readonly omitSecondAcceptanceCoverage?: boolean;
  readonly unmappedRequiredCase?: boolean;
  readonly taskRisk?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  readonly secondTaskRisk?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  readonly projectCaseLevel?: 'UNIT' | 'COMPONENT' | 'CONTRACT_PROVIDER' | 'CONTRACT_CONSUMER' | 'INTEGRATION' | 'E2E';
  readonly packageTestScript?: string;
  readonly contractExecutorRefs?: readonly string[];
  readonly sharedChangeInputs?: boolean;
  readonly taskEvidenceRequired?: readonly string[];
  readonly caseEvidenceRequired?: readonly string[];
  readonly localCommandRef?: string;
}

interface VerificationFixture {
  readonly context: VerificationPlannerContext;
  readonly scope: VerificationPlanScope;
  readonly workset: Workset;
  readonly scopedTasks: ReadonlyMap<string, ScopedTaskRef>;
  readonly plannerCalls: ProjectTestPlannerRequest[];
  readonly snapshotsWereReadOnly: boolean[];
  readonly repos: ReadonlyMap<string, string>;
  readonly taskHashes: ReadonlyMap<string, ContentHash>;
  readonly contractSnapshot: ContractSnapshot;
}

test('derives one immutable cross-project TestCase from each READY contract scenario', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote', 'user'], includeContract: true });

  const cases = deriveContractTestCases(fixture.contractSnapshot);

  assert.equal(cases.length, 1);
  assert.equal(cases[0]?.required, true);
  assert.deepEqual(cases[0]?.scopedTasks.map((item) => [item.project, item.baseline]), [
    ['quote', 'BL-0001'],
    ['user', 'BL-0001'],
  ]);
  assert.deepEqual(cases[0]?.scenarioRefs.map((item) => [item.scenarioId, item.contentHash]), [
    ['SC-007', fixture.contractSnapshotScenario().contentHash],
  ]);
});

test('a historical contract without baseline identity stays readable but cannot produce READY cases', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote', 'user'], includeContract: true });
  const historical: ContractSnapshot = {
    ...fixture.contractSnapshot,
    manifest: {
      ...fixture.contractSnapshot.manifest,
      participants: fixture.contractSnapshot.manifest.participants.map(({ baseline: _baseline, ...participant }) =>
        participant),
    },
  };

  assert.throws(
    () => deriveContractTestCases(historical),
    /CONTRACT_BASELINE_IDENTITY_MISSING_REQUIRES_RECOORDINATION/,
  );
});

test('a READY manifest cannot silently omit a declared contract scenario payload', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote', 'user'], includeContract: true });
  const incomplete: ContractSnapshot = {
    ...fixture.contractSnapshot,
    manifest: { ...fixture.contractSnapshot.manifest, businessScenarios: ['SC-999'] },
  };

  assert.throws(() => deriveContractTestCases(incomplete), /CONTRACT_SCENARIO_INVENTORY_MISMATCH/);
});

test('a contract case scopes tasks to the exact projects participating in its scenario', async () => {
  const fixture = await createVerificationFixture({
    projects: ['order', 'quote', 'user'],
    includeContract: true,
  });
  const scoped: ContractSnapshot = {
    ...fixture.contractSnapshot,
    candidate: {
      ...fixture.contractSnapshot.candidate,
      businessScenarios: fixture.contractSnapshot.candidate.businessScenarios.map((scenario) => ({
        ...scenario,
        participantProjects: ['order', 'quote'],
      })),
    },
  };

  const [testCase] = deriveContractTestCases(scoped);

  assert.deepEqual(testCase?.ownerProjects, ['order', 'quote']);
  assert.deepEqual(testCase?.scopedTasks.map((task) => task.project), ['order', 'quote']);
});

test('a READY contract rejects candidate scenarios outside its exact manifest inventory', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote', 'user'], includeContract: true });
  const scenario = fixture.contractSnapshot.candidate.businessScenarios[0]!;
  const extra: ContractSnapshot = {
    ...fixture.contractSnapshot,
    candidate: {
      ...fixture.contractSnapshot.candidate,
      businessScenarios: [scenario, { ...scenario, id: 'SC-EXTRA', title: 'undeclared extra scenario' }],
    },
  };

  assert.throws(() => deriveContractTestCases(extra), /CONTRACT_SCENARIO_INVENTORY_MISMATCH/);
});

test('missing project cases run one isolated Planner and create one reusable Core metadata commit', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'] });
  const scopedTask = fixture.scopedTasks.get('quote')!;

  const first = await ensureProjectTestCases(fixture.context, scopedTask);
  const second = await ensureProjectTestCases(fixture.context, scopedTask);

  assert.equal(first.status, 'READY');
  assert.equal(first.plannerRun.kind, 'PROJECT_TEST_PLANNER');
  assert.equal(fixture.plannerCalls.length, 1);
  assert.deepEqual(fixture.snapshotsWereReadOnly, [true]);
  assert.equal(second.commit, first.commit);
  const repo = fixture.repos.get('quote')!;
  assert.deepEqual(git(repo, ['diff', '--name-only', `${first.commit}^`, first.commit]).split('\n'), [
    '.omnai/changes/CHG-0001-verification-quote/test-cases.yaml',
  ]);
  assert.match(git(repo, ['show', '-s', '--format=%B', first.commit]), /OmnAI-Test-Plan-Run: RUN-0001/);
  assert.equal(git(repo, ['status', '--porcelain']), '');
});

test('concurrent project preparation converges on one Planner Run and one metadata commit', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'] });
  const task = fixture.scopedTasks.get('quote')!;

  const preparations = await Promise.all(Array.from({ length: 8 }, () =>
    ensureProjectTestCases(fixture.context, task)));

  assert.equal(fixture.plannerCalls.length, 1);
  assert.equal(new Set(preparations.map((item) => item.commit)).size, 1);
  assert.equal(git(fixture.repos.get('quote')!, ['status', '--porcelain']), '');
});

test('metadata preparation preserves unrelated real-index flags byte-for-byte', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'] });
  const repo = fixture.repos.get('quote')!;
  git(repo, ['update-index', '--assume-unchanged', 'package.json']);
  const before = git(repo, ['ls-files', '-v', 'package.json']);

  await ensureProjectTestCases(fixture.context, fixture.scopedTasks.get('quote')!);

  assert.equal(git(repo, ['ls-files', '-v', 'package.json']), before);
  assert.equal(git(repo, ['status', '--porcelain']), '');
});

test('metadata preparation rejects hidden worktree bytes that do not belong to HEAD', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'] });
  const repo = fixture.repos.get('quote')!;
  const specRef = '.omnai/changes/CHG-0001-verification-quote/spec.md';
  git(repo, ['update-index', '--assume-unchanged', specRef]);
  await writeFile(
    join(repo, specRef),
    '# Specification\n\n## Acceptance Criteria\n\n- AC-001: hidden replacement behavior\n',
    'utf8',
  );
  assert.equal(git(repo, ['status', '--porcelain']), '');

  await assert.rejects(
    () => ensureProjectTestCases(fixture.context, fixture.scopedTasks.get('quote')!),
    /PROJECT_PLANNING_INPUT_NOT_IN_HEAD/,
  );
  assert.equal(fixture.plannerCalls.length, 0);
});

test('metadata preparation freezes the exact HEAD project command configuration', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'] });
  const repo = fixture.repos.get('quote')!;
  const configRef = '.omnai/config.yaml';
  git(repo, ['update-index', '--assume-unchanged', configRef]);
  const config = YAML.parse(await readFileText(projectConfigPath(repo))) as Record<string, unknown>;
  await writeFile(projectConfigPath(repo), YAML.stringify({
    ...config,
    verification: { commands: ['npm run hidden-test-command'] },
  }), 'utf8');
  assert.equal(git(repo, ['status', '--porcelain']), '');

  await assert.rejects(
    () => ensureProjectTestCases(fixture.context, fixture.scopedTasks.get('quote')!),
    /PROJECT_PLANNING_INPUT_NOT_IN_HEAD:.omnai\/config.yaml/,
  );
  assert.equal(fixture.plannerCalls.length, 0);
});

test('a trusted preparation retry still blocks when an unrelated path is dirty', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'] });
  const task = fixture.scopedTasks.get('quote')!;
  await ensureProjectTestCases(fixture.context, task);
  const repo = fixture.repos.get('quote')!;
  await writeFile(join(repo, 'unrelated.txt'), 'user work\n', 'utf8');

  await assert.rejects(
    () => ensureProjectTestCases(fixture.context, task),
    /PROJECT_TEST_CASE_PREPARATION_DIRTY/,
  );
});

test('metadata publication never advances a different symbolic branch with the same old OID', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'] });
  const task = fixture.scopedTasks.get('quote')!;
  const repo = fixture.repos.get('quote')!;
  const originalBranch = git(repo, ['branch', '--show-current']);
  const originalHead = git(repo, ['rev-parse', 'HEAD']);
  const faulted: VerificationPlannerContext = {
    ...fixture.context,
    metadataCommitFaults: {
      beforeRefUpdate: () => { git(repo, ['switch', '-c', 'same-oid-other-branch']); },
    },
  };

  await assert.rejects(
    () => ensureProjectTestCases(faulted, task),
    /PROJECT_TEST_CASE_PREPARATION_BRANCH_CHANGED/,
  );
  assert.equal(git(repo, ['rev-parse', `refs/heads/${originalBranch}`]), originalHead);
  assert.equal(git(repo, ['rev-parse', 'refs/heads/same-oid-other-branch']), originalHead);
});

test('metadata preparation retries before ref publication without dispatching another Planner', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'] });
  const task = fixture.scopedTasks.get('quote')!;
  const repo = fixture.repos.get('quote')!;
  const originalHead = git(repo, ['rev-parse', 'HEAD']);
  const faulted: VerificationPlannerContext = {
    ...fixture.context,
    metadataCommitFaults: {
      beforeRefUpdate: () => { throw new Error('simulated metadata ref interruption'); },
    },
  };

  await assert.rejects(() => ensureProjectTestCases(faulted, task), /simulated metadata ref interruption/);
  assert.equal(git(repo, ['rev-parse', 'HEAD']), originalHead);
  assert.equal(fixture.plannerCalls.length, 1);

  const recovered = await ensureProjectTestCases(fixture.context, task);
  assert.notEqual(recovered.commit, originalHead);
  assert.equal(fixture.plannerCalls.length, 1);
  assert.equal(git(repo, ['status', '--porcelain']), '');
});

test('metadata preparation repairs only its target index entry after ref publication interruption', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'] });
  const task = fixture.scopedTasks.get('quote')!;
  const repo = fixture.repos.get('quote')!;
  const originalHead = git(repo, ['rev-parse', 'HEAD']);
  const faulted: VerificationPlannerContext = {
    ...fixture.context,
    metadataCommitFaults: {
      afterRefUpdate: () => { throw new Error('simulated metadata index interruption'); },
    },
  };

  await assert.rejects(() => ensureProjectTestCases(faulted, task), /simulated metadata index interruption/);
  const publishedHead = git(repo, ['rev-parse', 'HEAD']);
  assert.notEqual(publishedHead, originalHead);

  const recovered = await ensureProjectTestCases(fixture.context, task);
  assert.equal(recovered.commit, publishedHead);
  assert.equal(fixture.plannerCalls.length, 1);
  assert.equal(git(repo, ['status', '--porcelain']), '');
});

test('a manually rewritten test-case file is not accepted as a Core-owned preparation commit', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'] });
  const task = fixture.scopedTasks.get('quote')!;
  await ensureProjectTestCases(fixture.context, task);
  const repo = fixture.repos.get('quote')!;
  const path = changeArtifactPath(repo, 'CHG-0001-verification-quote', 'test-cases.yaml');
  await writeFile(path, `${await readFileText(path)}\n`, 'utf8');
  git(repo, ['add', '.omnai/changes/CHG-0001-verification-quote/test-cases.yaml']);
  git(repo, ['commit', '-m', 'test: manually rewrite test case metadata']);

  await assert.rejects(
    () => ensureProjectTestCases(fixture.context, task),
    /PROJECT_TEST_CASE_PREPARATION_COMMIT_UNTRUSTED/,
  );
  assert.equal(fixture.plannerCalls.length, 1);
});

test('compiles project and contract obligations into one deterministic READY plan', async () => {
  const fixture = await createVerificationFixture({ projects: ['order', 'quote', 'user'], includeContract: true });
  for (const task of fixture.scopedTasks.values()) await ensureProjectTestCases(fixture.context, task);

  const first = await compileVerificationPlan(fixture.context, fixture.scope);
  const second = await compileVerificationPlan(fixture.context, fixture.scope);

  assert.equal(first.status, 'READY');
  assert.equal(first.lastEventSequence, 1);
  assert.notEqual(first.lastEventHash, null);
  assert.equal(second.id, first.id);
  assert.equal(second.contentHash, first.contentHash);
  assert.equal(first.integrationGates.length, 1);
  assert.equal(first.integrationGates[0]?.caseRefs.length, 1);
  const contractCaseId = first.integrationGates[0]!.caseRefs[0]!.id;
  assert.deepEqual(first.projectChecks.map((item) => [
    item.project,
    item.caseRefs.map((ref) => ref.id).sort(),
  ]), [
    ['order', ['TC-0010', contractCaseId].sort()],
    ['quote', ['TC-0020', contractCaseId].sort()],
    ['user', ['TC-0030', contractCaseId].sort()],
  ]);
  assert.equal(first.contractSnapshots[0]?.contractKey, 'authorization-v2');
});

test('coverage rejects a project check that drops its relevant shared contract case', async () => {
  const fixture = await createVerificationFixture({
    projects: ['quote', 'user'],
    includeContract: true,
  });
  const plan = await compileVerificationPlan(fixture.context, fixture.scope);
  const contractCaseKeys = new Set(plan.integrationGates[0]!.caseRefs.map(testCaseRefKey));
  const changed = {
    ...plan,
    projectChecks: plan.projectChecks.map((check) => check.project === 'quote'
      ? { ...check, caseRefs: check.caseRefs.filter((ref) => !contractCaseKeys.has(testCaseRefKey(ref))) }
      : check),
  };
  const tampered = { ...changed, contentHash: hashVerificationPlan(changed) };

  const coverage = await validateVerificationPlanCoverage(fixture.context, tampered);

  assert.equal(coverage.valid, false);
  assert.match(coverage.diagnostics.map((item) => item.code).join(','), /PROJECT_CHECK_CASE_MISSING/);
});

test('same display TestCase ID from two projects remains distinct by scoped hash-bound ref', async () => {
  const fixture = await createVerificationFixture({
    projects: ['quote', 'user'],
    duplicateDisplayId: true,
  });
  for (const task of fixture.scopedTasks.values()) await ensureProjectTestCases(fixture.context, task);

  const plan = await compileVerificationPlan(fixture.context, fixture.scope);
  const matching = plan.testCases.filter((item) => item.id === 'TC-0010');

  assert.equal(plan.status, 'READY');
  assert.equal(matching.length, 2);
  assert.equal(new Set(matching.map(testCaseRefKey)).size, 2);
});

test('the same project-local command ref remains distinct across projects', async () => {
  const fixture = await createVerificationFixture({
    projects: ['quote', 'user'],
    localCommandRef: 'project-test',
  });

  const plan = await compileVerificationPlan(fixture.context, fixture.scope);

  assert.equal(plan.status, 'READY');
  assert.deepEqual(plan.commandDefinitions.map((definition) => [definition.project, definition.commandRef]), [
    ['quote', 'project-test'],
    ['user', 'project-test'],
  ]);
});

test('TestCase.scopedTasks is the sole task coverage direction', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'], secondTask: true });
  await ensureProjectTestCases(fixture.context, fixture.scopedTasks.get('quote')!);

  const plan = await compileVerificationPlan(fixture.context, fixture.scope);

  assert.equal(plan.status, 'READY');
  assert.deepEqual(plan.projectChecks[0]?.caseRefs.map((item) => item.id), ['TC-0010']);
  assert.equal(plan.testCases.some((item) => item.id === 'TC-0011'), false);
});

test('one missing applicable contract key is frozen and blocks READY', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'] });
  await ensureProjectTestCases(fixture.context, fixture.scopedTasks.get('quote')!);
  const blockedContext: VerificationPlannerContext = {
    ...fixture.context,
    contractSnapshotResolver: async () => {
      throw new Error('CONTRACT_NOT_READY:pricing-v3');
    },
  };

  const plan = await compileVerificationPlan(blockedContext, fixture.scope);

  assert.equal(plan.status, 'INVALID');
  assert.deepEqual(plan.applicableContractKeys, ['pricing-v3']);
  assert.match(plan.validation.map((item) => item.code).join(','), /CONTRACT_NOT_READY:pricing-v3/);
});

test('an uncovered acceptance criterion makes the compiled plan INVALID', async () => {
  const fixture = await createVerificationFixture({
    projects: ['quote'],
    secondAcceptanceCriterion: true,
    omitSecondAcceptanceCoverage: true,
  });

  const plan = await compileVerificationPlan(fixture.context, fixture.scope);

  assert.equal(plan.status, 'INVALID');
  assert.match(plan.validation.map((item) => item.code).join(','), /REQUIRED_COVERAGE_MISSING/);
});

test('an identical structurally INVALID compile reuses the same lifecycle instance', async () => {
  const fixture = await createVerificationFixture({
    projects: ['quote'],
    secondAcceptanceCriterion: true,
    omitSecondAcceptanceCoverage: true,
  });

  const first = await compileVerificationPlan(fixture.context, fixture.scope);
  const second = await compileVerificationPlan(fixture.context, fixture.scope);

  assert.equal(first.status, 'INVALID');
  assert.equal(second.id, first.id);
  assert.equal(second.contentHash, first.contentHash);
  assert.deepEqual(second.validation, first.validation);
  assert.deepEqual((await readdir(verificationPlansRoot(fixture.context.home, fixture.context.worksetId)))
    .filter((entry) => /^VPL-/u.test(entry)), [first.id]);
});

test('an unscoped acceptance-criterion N/A decision cannot cover identical refs in two projects', async () => {
  const fixture = await createVerificationFixture({
    projects: ['quote', 'user'],
    taskRisk: 'LOW',
    secondAcceptanceCriterion: true,
    omitSecondAcceptanceCoverage: true,
    sharedChangeInputs: true,
  });
  const acRef = '.omnai/changes/CHG-0001-verification-shared/spec.md#AC-002';
  const decision = {
    subjectKind: 'ACCEPTANCE_CRITERION' as const,
    subjectRef: acRef,
    subjectHash: sha256('- AC-002: shared failure behavior is observable'),
    policyId: fixture.context.policy!.id,
    policyHash: fixture.context.policy!.contentHash,
    reasonHash: hashObject('attempted cross-project exemption'),
  };

  const plan = await compileVerificationPlan(fixture.context, {
    ...fixture.scope,
    notApplicableDecisions: [decision],
  });

  assert.equal(plan.status, 'INVALID');
  assert.match(
    plan.validation.map((item) => item.code).join(','),
    /REQUIRED_COVERAGE_MISSING|NOT_APPLICABLE_SUBJECT_UNRESOLVED/,
  );
});

test('a behavior task without a case needs an exact policy-backed NOT_APPLICABLE decision', async () => {
  const fixture = await createVerificationFixture({
    projects: ['quote'],
    secondTask: true,
    omitSecondTaskCase: true,
  });
  const secondTask = {
    project: 'quote', changeId: 'CHG-0001', revision: 'REV-0001', baseline: 'BL-0001', taskId: 'TASK-002',
  } as const;
  const missing = await compileVerificationPlan(fixture.context, {
    ...fixture.scope,
    scopedTasks: [...fixture.scope.scopedTasks, secondTask],
  });
  assert.equal(missing.status, 'INVALID');

  const accepted = await compileVerificationPlan(fixture.context, {
    ...fixture.scope,
    scopedTasks: [...fixture.scope.scopedTasks, secondTask],
    notApplicableDecisions: [{
      subjectKind: 'TASK',
      subjectRef: JSON.stringify(['quote', 'CHG-0001', 'REV-0001', 'BL-0001', 'TASK-002']),
      subjectHash: fixture.taskHashes.get('quote:TASK-002')!,
      policyId: fixture.context.policy!.id,
      policyHash: fixture.context.policy!.contentHash,
      reasonHash: hashObject('documentation-only'),
    }],
  });
  assert.equal(accepted.status, 'READY');
  assert.equal((await loadReadyVerificationPlan(
    fixture.context,
    { id: accepted.id, contentHash: accepted.contentHash },
  )).status, 'READY');
});

test('an entirely policy-eligible N/A project produces a loadable READY plan without fake cases or commands', async () => {
  const fixture = await createVerificationFixture({
    projects: ['quote'],
    taskRisk: 'LOW',
    omitAllTaskCases: true,
  });
  const acRef = '.omnai/changes/CHG-0001-verification-quote/spec.md#AC-001';
  const decisions = [{
    subjectKind: 'TASK' as const,
    subjectRef: JSON.stringify(['quote', 'CHG-0001', 'REV-0001', 'BL-0001', 'TASK-001']),
    subjectHash: fixture.taskHashes.get('quote:TASK-001')!,
    policyId: fixture.context.policy!.id,
    policyHash: fixture.context.policy!.contentHash,
    reasonHash: hashObject('no executable behavior'),
  }, {
    subjectKind: 'ACCEPTANCE_CRITERION' as const,
    subjectRef: JSON.stringify(['quote', acRef]),
    subjectHash: sha256('- AC-001: quote behavior is observable'),
    policyId: fixture.context.policy!.id,
    policyHash: fixture.context.policy!.contentHash,
    reasonHash: hashObject('criterion is documentation-only'),
  }];

  const plan = await compileVerificationPlan(fixture.context, {
    ...fixture.scope,
    notApplicableDecisions: decisions,
  });

  assert.equal(plan.status, 'READY');
  assert.deepEqual(plan.testCases, []);
  assert.deepEqual(plan.commandDefinitions, []);
  assert.deepEqual(plan.projectChecks[0]?.caseRefs, []);
  assert.equal((await loadReadyVerificationPlan(
    fixture.context,
    { id: plan.id, contentHash: plan.contentHash },
  )).status, 'READY');
});

test('the default policy is frozen into preparation and can authorize only its eligible N/A subjects', async () => {
  const fixture = await createVerificationFixture({
    projects: ['quote'],
    secondTask: true,
    omitSecondTaskCase: true,
  });
  const { policy: _explicitPolicy, ...defaultContext } = fixture.context;
  const policy = createDefaultVerificationPolicy();
  const secondTask = {
    project: 'quote', changeId: 'CHG-0001', revision: 'REV-0001', baseline: 'BL-0001', taskId: 'TASK-002',
  } as const;
  const plan = await compileVerificationPlan(defaultContext, {
    ...fixture.scope,
    scopedTasks: [...fixture.scope.scopedTasks, secondTask],
    notApplicableDecisions: [{
      subjectKind: 'TASK',
      subjectRef: JSON.stringify(['quote', 'CHG-0001', 'REV-0001', 'BL-0001', 'TASK-002']),
      subjectHash: fixture.taskHashes.get('quote:TASK-002')!,
      policyId: policy.id,
      policyHash: policy.contentHash,
      reasonHash: hashObject('documentation-only'),
    }],
  });

  assert.equal(plan.status, 'READY');
  assert.equal((await loadReadyVerificationPlan(
    defaultContext,
    { id: plan.id, contentHash: plan.contentHash },
  )).status, 'READY');
});

test('a policy-bound reason cannot exempt a CRITICAL task unless the policy explicitly allows it', async () => {
  const fixture = await createVerificationFixture({
    projects: ['quote'],
    secondTask: true,
    secondTaskRisk: 'CRITICAL',
    omitSecondTaskCase: true,
  });
  const secondTask = {
    project: 'quote', changeId: 'CHG-0001', revision: 'REV-0001', baseline: 'BL-0001', taskId: 'TASK-002',
  } as const;
  const plan = await compileVerificationPlan(fixture.context, {
    ...fixture.scope,
    scopedTasks: [...fixture.scope.scopedTasks, secondTask],
    notApplicableDecisions: [{
      subjectKind: 'TASK',
      subjectRef: JSON.stringify(['quote', 'CHG-0001', 'REV-0001', 'BL-0001', 'TASK-002']),
      subjectHash: fixture.taskHashes.get('quote:TASK-002')!,
      policyId: fixture.context.policy!.id,
      policyHash: fixture.context.policy!.contentHash,
      reasonHash: hashObject('attempted-critical-exemption'),
    }],
  });

  assert.equal(plan.status, 'INVALID');
  assert.match(plan.validation.map((item) => item.code).join(','), /NOT_APPLICABLE_POLICY_DENIED/);
});

test('a bare N/A decision that does not bind an exact plan subject is rejected', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'] });
  const plan = await compileVerificationPlan(fixture.context, {
    ...fixture.scope,
    notApplicableDecisions: [{
      subjectKind: 'TASK',
      subjectRef: JSON.stringify(['quote', 'CHG-0001', 'REV-0001', 'BL-0001', 'TASK-999']),
      subjectHash: hashObject('missing-task'),
      policyId: fixture.context.policy!.id,
      policyHash: fixture.context.policy!.contentHash,
      reasonHash: hashObject('unbound-reason'),
    }],
  });

  assert.equal(plan.status, 'INVALID');
  assert.match(plan.validation.map((item) => item.code).join(','), /NOT_APPLICABLE_SUBJECT_UNRESOLVED/);
});

test('risk policy blocks a HIGH task covered only by a UNIT case', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'], taskRisk: 'HIGH' });

  const plan = await compileVerificationPlan(fixture.context, fixture.scope);

  assert.equal(plan.status, 'INVALID');
  assert.match(plan.validation.map((item) => item.code).join(','), /RISK_POLICY_LEVEL_MISSING:TASK/);
});

test('risk policy does not require a RETRY scenario when no retry semantics are applicable', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote', 'user'], includeContract: true });

  const plan = await compileVerificationPlan(fixture.context, fixture.scope);

  assert.equal(plan.status, 'READY');
  assert.equal(plan.validation.some((item) => item.subjectRef === 'RETRY'), false);
});

test('an INTEGRATION-labeled project case cannot satisfy risk coverage without a profile-bound gate executor', async () => {
  const fixture = await createVerificationFixture({
    projects: ['quote'],
    taskRisk: 'HIGH',
    projectCaseLevel: 'INTEGRATION',
  });

  const plan = await compileVerificationPlan(fixture.context, fixture.scope);

  assert.equal(plan.status, 'INVALID');
  assert.match(plan.validation.map((item) => item.code).join(','), /INTEGRATION_EXECUTOR_UNRESOLVED/);
});

test('a contract case executor must resolve to an exact lifecycle step in the frozen profile', async () => {
  const fixture = await createVerificationFixture({
    projects: ['quote', 'user'],
    includeContract: true,
    contractExecutorRefs: ['arbitrary:executor'],
  });

  const plan = await compileVerificationPlan(fixture.context, fixture.scope);

  assert.equal(plan.status, 'INVALID');
  assert.match(plan.validation.map((item) => item.code).join(','), /INTEGRATION_EXECUTOR_UNRESOLVED/);
});

test('an exact policy-eligible contract-scenario N/A decision removes its required integration gate and stays loadable', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote', 'user'], includeContract: true });
  const base = createDefaultVerificationPolicy();
  const policy = createVerificationPolicy({
    ...base,
    notApplicableRules: base.notApplicableRules.map((rule) => rule.subjectKind === 'CONTRACT_SCENARIO'
      ? { ...rule, allowedScenarioClasses: ['FAILURE'] }
      : rule),
  });
  const scenario = fixture.contractSnapshotScenario();
  const context: VerificationPlannerContext = { ...fixture.context, policy };
  const plan = await compileVerificationPlan(context, {
    ...fixture.scope,
    notApplicableDecisions: [{
      subjectKind: 'CONTRACT_SCENARIO',
      subjectRef: scenario.scenarioId,
      subjectHash: scenario.contentHash,
      policyId: policy.id,
      policyHash: policy.contentHash,
      reasonHash: hashObject('external-system-does-not-participate'),
    }],
  });

  assert.equal(plan.status, 'READY');
  assert.equal(plan.integrationGates.length, 0);
  assert.equal((await loadReadyVerificationPlan(
    context,
    { id: plan.id, contentHash: plan.contentHash },
  )).status, 'READY');
});

test('a generic command without an exact required-case mapping cannot satisfy coverage', async () => {
  const fixture = await createVerificationFixture({
    projects: ['quote'],
    secondTask: true,
    unmappedRequiredCase: true,
  });

  const plan = await compileVerificationPlan(fixture.context, fixture.scope);

  assert.equal(plan.status, 'INVALID');
  assert.match(plan.validation.map((item) => item.code).join(','), /COMMAND_CASE_MAPPING_MISSING/);
});

test('a safe legacy command is normalized into structured shell-free authority', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'], legacyCommands: ['npm test'] });
  await ensureProjectTestCases(fixture.context, fixture.scopedTasks.get('quote')!);

  const plan = await compileVerificationPlan(fixture.context, fixture.scope);

  assert.deepEqual(plan.commandDefinitions[0], {
    commandRef: 'quote.project-test',
    project: 'quote',
    executable: 'node',
    argv: ['--test', 'test/quote.test.js'],
    cwd: '.',
    network: 'DENY',
    timeoutMs: 60_000,
    outputLimit: 1_048_576,
    caseRefs: plan.projectChecks[0]!.caseRefs,
  });
});

test('profile, policy, command, contract, and task drift each stale an old READY plan', async () => {
  for (const changed of ['profile', 'policy', 'command', 'contract', 'task'] as const) {
    const fixture = await createVerificationFixture({ projects: ['quote'], includeContract: changed === 'contract' });
    await ensureProjectTestCases(fixture.context, fixture.scopedTasks.get('quote')!);
    const ready = await compileVerificationPlan(fixture.context, fixture.scope);
    assert.equal(ready.status, 'READY', changed);
    let drifted: VerificationPlannerContext = fixture.context;
    if (changed === 'profile') {
      drifted = { ...drifted, profileRefResolver: async (id) => ({ id, contentHash: hashObject('profile-v2') }) };
    } else if (changed === 'policy') {
      drifted = {
        ...drifted,
        policy: createVerificationPolicy({ ...drifted.policy!, version: 2 }),
      };
    } else if (changed === 'command') {
      const repo = fixture.repos.get('quote')!;
      const config = await loadProjectConfig(repo);
      await saveProjectConfig(repo, { ...config, verification: { commands: ['npm run test:changed'] } });
    } else if (changed === 'contract') {
      drifted = {
        ...drifted,
        contractSnapshotResolver: async () => [{
          ...fixture.contractSnapshot,
          manifest: { ...fixture.contractSnapshot.manifest, contentHash: hashObject('contract-v2') },
        }],
      };
    } else {
      const repo = fixture.repos.get('quote')!;
      await saveTasks(changeArtifactPath(repo, 'CHG-0001-verification-quote', 'tasks.yaml'), {
        schemaVersion: 1, revision: 'REV-0001', generatedFrom: ['spec.md#AC-001'],
        tasks: [{
          id: 'TASK-001', title: 'Changed task', objective: 'Changed behavior', status: 'READY',
          dependsOn: [], slice: 'VERTICAL', risk: 'HIGH',
          files: { create: ['src/quote.ts'], modify: [], tests: ['test/quote.test.ts'] },
          consumes: [], produces: [], steps: ['changed'], evidenceRequired: ['test'], notes: [],
        }],
      });
    }
    await assert.rejects(
      () => loadReadyVerificationPlan(drifted, { id: ready.id, contentHash: ready.contentHash }),
      new RegExp(`VERIFICATION_PLAN_STALE:${changed === 'command' ? 'SOURCE' : changed.toUpperCase()}`),
      changed,
    );
  }
});

test('removing one of multiple frozen contract keys makes an old READY plan stale', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote', 'user'], includeContract: true });
  const second = contractSnapshotVariant(fixture.contractSnapshot, 'pricing-v3', 'CTR-0002');
  const compiling: VerificationPlannerContext = {
    ...fixture.context,
    contractSnapshotResolver: async () => [fixture.contractSnapshot, second],
  };
  const ready = await compileVerificationPlan(compiling, fixture.scope);
  assert.equal(ready.status, 'READY');
  assert.deepEqual(ready.contractSnapshots.map((binding) => binding.contractKey), ['authorization-v2', 'pricing-v3']);

  await assert.rejects(
    () => loadReadyVerificationPlan(
      { ...compiling, contractSnapshotResolver: async () => [fixture.contractSnapshot] },
      { id: ready.id, contentHash: ready.contentHash },
    ),
    /VERIFICATION_PLAN_STALE:CONTRACT/,
  );
});

test('design, intent, and manifest bytes are frozen even when a case cites only an acceptance criterion', async () => {
  for (const changed of ['design.md', 'intent.md', 'package.json'] as const) {
    const fixture = await createVerificationFixture({ projects: ['quote'] });
    await ensureProjectTestCases(fixture.context, fixture.scopedTasks.get('quote')!);
    const ready = await compileVerificationPlan(fixture.context, fixture.scope);
    const repo = fixture.repos.get('quote')!;
    const path = changed === 'package.json'
      ? join(repo, changed)
      : changeArtifactPath(repo, 'CHG-0001-verification-quote', changed);
    await writeFile(path, `${await readFileText(path)}\nchanged\n`, 'utf8');

    await assert.rejects(
      () => loadReadyVerificationPlan(fixture.context, { id: ready.id, contentHash: ready.contentHash }),
      /VERIFICATION_PLAN_STALE:SOURCE/,
      changed,
    );
  }
});

test('exact Change metadata and active Revision bytes are frozen into plan freshness', async () => {
  for (const changed of ['change.yaml', 'revisions/REV-0001.yaml'] as const) {
    const fixture = await createVerificationFixture({ projects: ['quote'] });
    const ready = await compileVerificationPlan(fixture.context, fixture.scope);
    assert.equal(ready.status, 'READY');
    const repo = fixture.repos.get('quote')!;
    const path = changeArtifactPath(repo, 'CHG-0001-verification-quote', changed);
    const document = YAML.parse(await readFileText(path)) as Record<string, unknown>;
    await writeFile(
      path,
      YAML.stringify(changed === 'change.yaml'
        ? { ...document, title: 'Changed semantic title' }
        : { ...document, reason: 'Changed revision reason' }),
      'utf8',
    );

    await assert.rejects(
      () => loadReadyVerificationPlan(fixture.context, { id: ready.id, contentHash: ready.contentHash }),
      /VERIFICATION_PLAN_STALE:SOURCE/,
      changed,
    );
  }
});

test('a source mutation during plan staging aborts publication instead of returning a stale READY plan', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'] });
  const repo = fixture.repos.get('quote')!;
  const faulted: VerificationPlannerContext = {
    ...fixture.context,
    planPersistenceFaults: {
      afterInventoryStaged: async () => {
        await writeFile(
          changeArtifactPath(repo, 'CHG-0001-verification-quote', 'spec.md'),
          '# Specification\n\n## Acceptance Criteria\n\n- AC-001: changed while staging\n',
          'utf8',
        );
      },
    },
  };

  await assert.rejects(
    () => compileVerificationPlan(faulted, fixture.scope),
    /VERIFICATION_PLAN_STALE_DURING_COMPILE/,
  );
  assert.deepEqual((await readdir(verificationPlansRoot(fixture.context.home, fixture.context.worksetId)))
    .filter((entry) => /^VPL-/u.test(entry)), []);
});

test('an incomplete final-name VPL directory is treated as corrupt and blocks enumeration', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'] });
  await ensureProjectTestCases(fixture.context, fixture.scopedTasks.get('quote')!);
  const incomplete = join(verificationPlansRoot(fixture.context.home, fixture.context.worksetId), 'VPL-0001');
  await mkdir(incomplete, { recursive: true });
  await writeFile(join(incomplete, 'test-cases.yaml'), 'schemaVersion: 1\ntestCases: []\n', 'utf8');

  await assert.rejects(
    () => compileVerificationPlan(fixture.context, fixture.scope),
    /VERIFICATION_PLAN_MODERN_CORRUPT:VPL-0001/,
  );
});

test('a failed staged VPL publish leaves no visible aggregate and retry reuses the first ID', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'] });
  await ensureProjectTestCases(fixture.context, fixture.scopedTasks.get('quote')!);
  const faulted: VerificationPlannerContext = {
    ...fixture.context,
    planPersistenceFaults: {
      afterInventoryStaged: () => { throw new Error('simulated plan publication interruption'); },
    },
  };
  await assert.rejects(
    () => compileVerificationPlan(faulted, fixture.scope),
    /simulated plan publication interruption/,
  );
  assert.deepEqual((await readdir(verificationPlansRoot(fixture.context.home, fixture.context.worksetId)))
    .filter((entry) => /^VPL-/u.test(entry)), []);

  const retried = await compileVerificationPlan(fixture.context, fixture.scope);
  assert.equal(retried.id, 'VPL-0001');
});

test('a valid legacy flat VPL reserves its ID and requires explicit recompilation without mutation', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'] });
  await ensureProjectTestCases(fixture.context, fixture.scopedTasks.get('quote')!);
  const legacy = legacyVerificationPlan(fixture.context.worksetId, 'VPL-0001');
  const root = verificationPlansRoot(fixture.context.home, fixture.context.worksetId);
  await mkdir(root, { recursive: true });
  const path = join(root, 'VPL-0001.yaml');
  const bytes = `${JSON.stringify(legacy, null, 2)}\n`;
  await writeFile(path, bytes, 'utf8');

  await assert.rejects(
    () => loadReadyVerificationPlan(fixture.context, { id: legacy.id, contentHash: legacy.contentHash }),
    /VERIFICATION_PLAN_LEGACY_RECOMPILE_REQUIRED:VPL-0001/,
  );
  const compiled = await compileVerificationPlan(fixture.context, fixture.scope);
  assert.equal(compiled.id, 'VPL-0002');
  assert.equal(await readFileText(path), bytes);
});

test('a legacy flat VPL and modern directory with the same logical ID are rejected as a collision', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'] });
  await ensureProjectTestCases(fixture.context, fixture.scopedTasks.get('quote')!);
  const modern = await compileVerificationPlan(fixture.context, fixture.scope);
  const legacy = legacyVerificationPlan(fixture.context.worksetId, modern.id);
  await writeFile(
    join(verificationPlansRoot(fixture.context.home, fixture.context.worksetId), `${modern.id}.yaml`),
    `${JSON.stringify(legacy, null, 2)}\n`,
    'utf8',
  );

  await assert.rejects(
    () => loadReadyVerificationPlan(fixture.context, { id: modern.id, contentHash: modern.contentHash }),
    /VERIFICATION_PLAN_ID_COLLISION/,
  );
});

test('a modern VPL plan identity must match its owning directory and Workset', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'] });
  const plan = await compileVerificationPlan(fixture.context, fixture.scope);
  const path = join(
    verificationPlansRoot(fixture.context.home, fixture.context.worksetId),
    plan.id,
    'plan.yaml',
  );
  const document = YAML.parse(await readFileText(path)) as Record<string, unknown>;
  await writeFile(path, YAML.stringify({ ...document, id: 'VPL-9999' }), 'utf8');

  await assert.rejects(
    () => loadReadyVerificationPlan(fixture.context, { id: plan.id, contentHash: plan.contentHash }),
    /VERIFICATION_PLAN_MODERN_CORRUPT:VPL-0001:.*IDENTITY_MISMATCH/,
  );
});

test('content-hash reuse validates the complete persisted TestCase inventory', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'] });
  const plan = await compileVerificationPlan(fixture.context, fixture.scope);
  await writeFile(
    join(verificationPlansRoot(fixture.context.home, fixture.context.worksetId), plan.id, 'test-cases.yaml'),
    'schemaVersion: 1\ntestCases: []\n',
    'utf8',
  );

  await assert.rejects(
    () => compileVerificationPlan(fixture.context, fixture.scope),
    /VERIFICATION_PLAN_TEST_CASE_INVENTORY_MISMATCH/,
  );
});

test('an invalidated content hash can be compiled into a new READY lifecycle instance', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'] });
  const first = await compileVerificationPlan(fixture.context, fixture.scope);
  assert.equal(first.status, 'READY');
  assert.deepEqual(await invalidateVerificationPlans(fixture.context, {
    kind: 'COMMAND', project: 'quote', ref: 'quote.project-test',
  }), [first.id]);

  const replacement = await compileVerificationPlan(fixture.context, fixture.scope);

  assert.equal(replacement.status, 'READY');
  assert.equal(replacement.contentHash, first.contentHash);
  assert.notEqual(replacement.id, first.id);
});

test('mark-ready refuses a DRAFT whose frozen source input became stale', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'] });
  const compiled = await compileVerificationPlan(fixture.context, fixture.scope);
  const path = join(
    verificationPlansRoot(fixture.context.home, fixture.context.worksetId),
    compiled.id,
    'plan.yaml',
  );
  const document = YAML.parse(await readFileText(path)) as Record<string, unknown>;
  await writeFile(path, YAML.stringify({ ...document, status: 'DRAFT', validation: [] }), 'utf8');
  await writeFile(
    changeArtifactPath(fixture.repos.get('quote')!, 'CHG-0001-verification-quote', 'spec.md'),
    '# Specification\n\n## Acceptance Criteria\n\n- AC-001: changed after draft publication\n',
    'utf8',
  );

  const marked = await markVerificationPlanReady(fixture.context, compiled.id);

  assert.equal(marked.status, 'INVALID');
  assert.match(marked.validation.map((item) => `${item.code}:${item.message}`).join(','), /VERIFICATION_PLAN_STALE.*SOURCE/);
});

test('mark-ready preserves an existing DRAFT blocker instead of washing it away', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'] });
  const compiled = await compileVerificationPlan(fixture.context, fixture.scope);
  const path = join(
    verificationPlansRoot(fixture.context.home, fixture.context.worksetId),
    compiled.id,
    'plan.yaml',
  );
  const blocker = { code: 'MANUAL_BLOCKER', subjectRef: 'quote', message: 'review remains unresolved' };
  const document = YAML.parse(await readFileText(path)) as Record<string, unknown>;
  await writeFile(path, YAML.stringify({ ...document, status: 'DRAFT', validation: [blocker] }), 'utf8');

  const marked = await markVerificationPlanReady(fixture.context, compiled.id);

  assert.equal(marked.status, 'INVALID');
  assert.deepEqual(marked.validation, [blocker]);
});

test('mark-ready promotes only a fresh DRAFT with no validation blockers', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'] });
  const compiled = await compileVerificationPlan(fixture.context, fixture.scope);
  const path = join(
    verificationPlansRoot(fixture.context.home, fixture.context.worksetId),
    compiled.id,
    'plan.yaml',
  );
  const document = YAML.parse(await readFileText(path)) as Record<string, unknown>;
  await writeFile(path, YAML.stringify({ ...document, status: 'DRAFT', validation: [] }), 'utf8');

  const marked = await markVerificationPlanReady(fixture.context, compiled.id);

  assert.equal(marked.status, 'READY');
  assert.deepEqual(marked.validation, []);
});

test('a corrupt legacy flat VPL blocks enumeration instead of being silently shadowed', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'] });
  await ensureProjectTestCases(fixture.context, fixture.scopedTasks.get('quote')!);
  const legacy = legacyVerificationPlan('WKS-9999', 'VPL-0001');
  const root = verificationPlansRoot(fixture.context.home, fixture.context.worksetId);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'VPL-0001.yaml'), `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');

  await assert.rejects(
    () => compileVerificationPlan(fixture.context, fixture.scope),
    /VERIFICATION_PLAN_LEGACY_CORRUPT:VPL-0001/,
  );
});

test('identity-based invalidation does not invalidate an unrelated project plan', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote', 'user'] });
  for (const task of fixture.scopedTasks.values()) await ensureProjectTestCases(fixture.context, task);
  const quotePlan = await compileVerificationPlan(fixture.context, {
    ...fixture.scope,
    scopedTasks: [fixture.scopedTasks.get('quote')!],
  });
  const userPlan = await compileVerificationPlan(fixture.context, {
    ...fixture.scope,
    scopedTasks: [fixture.scopedTasks.get('user')!],
  });

  const invalidated = await invalidateVerificationPlans(fixture.context, {
    kind: 'COMMAND', project: 'quote', ref: 'quote.project-test',
  });

  assert.deepEqual(invalidated, [quotePlan.id]);
  assert.equal((await loadReadyVerificationPlan(
    fixture.context,
    { id: userPlan.id, contentHash: userPlan.contentHash },
  )).status, 'READY');
});

test('typed command invalidation is project-scoped for identical local refs', async () => {
  const fixture = await createVerificationFixture({
    projects: ['quote', 'user'],
    localCommandRef: 'project-test',
  });
  const quotePlan = await compileVerificationPlan(fixture.context, {
    ...fixture.scope,
    scopedTasks: [fixture.scopedTasks.get('quote')!],
  });
  const userPlan = await compileVerificationPlan(fixture.context, {
    ...fixture.scope,
    scopedTasks: [fixture.scopedTasks.get('user')!],
  });

  const invalidated = await invalidateVerificationPlans(fixture.context, {
    kind: 'COMMAND', project: 'quote', ref: 'project-test',
  });

  assert.deepEqual(invalidated, [quotePlan.id]);
  assert.equal((await loadReadyVerificationPlan(
    fixture.context,
    { id: userPlan.id, contentHash: userPlan.contentHash },
  )).status, 'READY');
});

test('policy and canonical scoped-task identities invalidate exactly their dependent plans', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote', 'user'] });
  for (const task of fixture.scopedTasks.values()) await ensureProjectTestCases(fixture.context, task);
  const quotePlan = await compileVerificationPlan(fixture.context, {
    ...fixture.scope,
    scopedTasks: [fixture.scopedTasks.get('quote')!],
  });
  const userPlan = await compileVerificationPlan(fixture.context, {
    ...fixture.scope,
    scopedTasks: [fixture.scopedTasks.get('user')!],
  });

  assert.deepEqual(await invalidateVerificationPlans(fixture.context, {
    kind: 'TASK',
    ref: JSON.stringify(['quote', 'CHG-0001', 'REV-0001', 'BL-0001', 'TASK-001']),
    contentHash: fixture.taskHashes.get('quote:TASK-001')!,
  }), [quotePlan.id]);
  assert.equal((await loadReadyVerificationPlan(
    fixture.context,
    { id: userPlan.id, contentHash: userPlan.contentHash },
  )).status, 'READY');

  assert.deepEqual(await invalidateVerificationPlans(fixture.context, {
    kind: 'POLICY',
    ref: fixture.context.policy!.id,
    contentHash: fixture.context.policy!.contentHash,
  }), [userPlan.id]);
});

test('typed invalidation scopes source paths by project and treats a task hash as change context', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote', 'user'] });
  for (const task of fixture.scopedTasks.values()) await ensureProjectTestCases(fixture.context, task);
  const quotePlan = await compileVerificationPlan(fixture.context, {
    ...fixture.scope,
    scopedTasks: [fixture.scopedTasks.get('quote')!],
  });
  const userPlan = await compileVerificationPlan(fixture.context, {
    ...fixture.scope,
    scopedTasks: [fixture.scopedTasks.get('user')!],
  });

  assert.deepEqual(await invalidateVerificationPlans(fixture.context, {
    kind: 'SOURCE',
    project: 'quote',
    ref: '.omnai/changes/CHG-0001-verification-quote/spec.md',
    contentHash: hashObject('new-source-bytes'),
  }), [quotePlan.id]);
  assert.equal((await loadReadyVerificationPlan(
    fixture.context,
    { id: userPlan.id, contentHash: userPlan.contentHash },
  )).status, 'READY');

  const taskFixture = await createVerificationFixture({ projects: ['quote'] });
  const taskPlan = await compileVerificationPlan(taskFixture.context, taskFixture.scope);
  assert.deepEqual(await invalidateVerificationPlans(taskFixture.context, {
    kind: 'TASK',
    ref: JSON.stringify(['quote', 'CHG-0001', 'REV-0001', 'BL-0001', 'TASK-001']),
    contentHash: hashObject('new-task-bytes'),
  }), [taskPlan.id]);
});

test('typed TestCase invalidation uses hash-free authoritative scope instead of display ID', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote', 'user'], duplicateDisplayId: true });
  for (const task of fixture.scopedTasks.values()) await ensureProjectTestCases(fixture.context, task);
  const quotePlan = await compileVerificationPlan(fixture.context, {
    ...fixture.scope,
    scopedTasks: [fixture.scopedTasks.get('quote')!],
  });
  const userPlan = await compileVerificationPlan(fixture.context, {
    ...fixture.scope,
    scopedTasks: [fixture.scopedTasks.get('user')!],
  });
  const quoteCase = quotePlan.testCases[0]!;

  assert.deepEqual(await invalidateVerificationPlans(fixture.context, {
    kind: 'TEST_CASE',
    ref: { id: quoteCase.id, scope: quoteCase.scope },
    contentHash: hashObject('replacement-case-bytes'),
  }), [quotePlan.id]);
  assert.equal((await loadReadyVerificationPlan(
    fixture.context,
    { id: userPlan.id, contentHash: userPlan.contentHash },
  )).status, 'READY');
});

test('legacy shell syntax is a non-authoritative hint and blocks before Planner dispatch', async () => {
  const fixture = await createVerificationFixture({
    projects: ['quote'],
    legacyCommands: ['npm test && curl $TOKEN'],
  });

  await assert.rejects(
    () => ensureProjectTestCases(fixture.context, fixture.scopedTasks.get('quote')!),
    /COMMAND_DEFINITION_AMBIGUOUS/,
  );
  assert.equal(fixture.plannerCalls.length, 0);
  assert.equal(git(fixture.repos.get('quote')!, ['status', '--porcelain']), '');
});

test('a safe-looking npm hint cannot hide shell syntax inside the referenced manifest script', async () => {
  const fixture = await createVerificationFixture({
    projects: ['quote'],
    packageTestScript: 'node --test && curl $TOKEN',
  });

  await assert.rejects(
    () => ensureProjectTestCases(fixture.context, fixture.scopedTasks.get('quote')!),
    /COMMAND_DEFINITION_AMBIGUOUS/,
  );
  assert.equal(fixture.plannerCalls.length, 0);
});

test('legacy command argv traversal and repository-local executables are never promoted to authority', async () => {
  const traversal = await createVerificationFixture({
    projects: ['quote'],
    legacyCommands: ['pytest --basetemp=../../escape'],
  });
  await assert.rejects(
    () => ensureProjectTestCases(traversal.context, traversal.scopedTasks.get('quote')!),
    /COMMAND_ARGUMENT_INVALID/,
  );

  const repeatedEquals = await createVerificationFixture({
    projects: ['quote'],
    legacyCommands: ['pytest --basetemp=x=../../../escape'],
  });
  await assert.rejects(
    () => ensureProjectTestCases(repeatedEquals.context, repeatedEquals.scopedTasks.get('quote')!),
    /COMMAND_ARGUMENT_INVALID/,
  );

  const responseFile = await createVerificationFixture({
    projects: ['quote'],
    legacyCommands: ['pytest @/etc/args'],
  });
  await assert.rejects(
    () => ensureProjectTestCases(responseFile.context, responseFile.scopedTasks.get('quote')!),
    /COMMAND_ARGUMENT_INVALID/,
  );

  const local = await createVerificationFixture({
    projects: ['quote'],
    legacyCommands: ['./scripts/test.sh'],
  });
  const repo = local.repos.get('quote')!;
  await mkdir(join(repo, 'scripts'), { recursive: true });
  await writeFile(join(repo, 'scripts', 'test.sh'), '#!/bin/sh\nnode --test\n', 'utf8');
  await assert.rejects(
    () => ensureProjectTestCases(local.context, local.scopedTasks.get('quote')!),
    /COMMAND_EXECUTABLE_INVALID/,
  );
});

test('manifest-authorized argv cannot follow a repository symlink outside the project', async () => {
  const fixture = await createVerificationFixture({
    projects: ['quote'],
    packageTestScript: 'node --test escape/new.test.js',
  });
  const repo = fixture.repos.get('quote')!;
  const outside = join(fixture.context.home, 'outside-tests');
  await mkdir(outside, { recursive: true });
  await symlink(outside, join(repo, 'escape'), 'dir');

  await assert.rejects(
    () => ensureProjectTestCases(fixture.context, fixture.scopedTasks.get('quote')!),
    /COMMAND_ARGUMENT_OUTSIDE_PROJECT/,
  );
});

test('attached command path flags cannot traverse an escaping repository symlink', async () => {
  const fixture = await createVerificationFixture({
    projects: ['quote'],
    legacyCommands: ['pytest -fescape/pom.xml'],
  });
  const repo = fixture.repos.get('quote')!;
  const outside = join(fixture.context.home, 'outside-build');
  await mkdir(outside, { recursive: true });
  await symlink(outside, join(repo, 'escape'), 'dir');

  await assert.rejects(
    () => ensureProjectTestCases(fixture.context, fixture.scopedTasks.get('quote')!),
    /COMMAND_ARGUMENT_OUTSIDE_PROJECT/,
  );
});

test('Core accepts nonempty case evidence when a task has no task-level evidence requirement', async () => {
  const fixture = await createVerificationFixture({
    projects: ['quote'],
    taskEvidenceRequired: [],
    caseEvidenceRequired: ['exit-code'],
  });

  const prepared = await ensureProjectTestCases(fixture.context, fixture.scopedTasks.get('quote')!);

  assert.equal(prepared.status, 'READY');
  assert.deepEqual(prepared.testCases[0]?.evidenceRequired, ['exit-code']);
});

test('required cases may collectively satisfy task evidence and add resolvable case evidence', async () => {
  const fixture = await createVerificationFixture({
    projects: ['quote'],
    taskEvidenceRequired: ['security-scan', 'test'],
  });
  const planner = fixture.context.plannerRunner!;
  const context: VerificationPlannerContext = {
    ...fixture.context,
    plannerRunner: async (request) => {
      const candidate = await planner(request);
      const original = candidate.testCases[0]!;
      return {
        ...candidate,
        testCases: [
          { ...original, id: 'TC-0010', evidenceRequired: ['exit-code', 'test'] },
          { ...original, id: 'TC-0011', evidenceRequired: ['security-scan'] },
        ],
        commandDefinitions: candidate.commandDefinitions.map((definition) => ({
          ...definition,
          caseRefs: ['TC-0010', 'TC-0011'],
        })),
      };
    },
  };

  const prepared = await ensureProjectTestCases(context, fixture.scopedTasks.get('quote')!);

  assert.equal(prepared.status, 'READY');
  assert.equal(prepared.testCases.length, 2);
});

test('Core rejects missing task evidence and Planner-invented evidence names', async () => {
  const missing = await createVerificationFixture({
    projects: ['quote'],
    taskEvidenceRequired: ['security-scan', 'test'],
    caseEvidenceRequired: ['test'],
  });
  await assert.rejects(
    () => ensureProjectTestCases(missing.context, missing.scopedTasks.get('quote')!),
    /TASK_EVIDENCE_COVERAGE_MISSING/,
  );

  const invented = await createVerificationFixture({ projects: ['quote'] });
  const planner = invented.context.plannerRunner!;
  const context: VerificationPlannerContext = {
    ...invented.context,
    plannerRunner: async (request) => {
      const candidate = await planner(request);
      return {
        ...candidate,
        testCases: candidate.testCases.map((testCase) => ({
          ...testCase,
          evidenceRequired: ['test', 'unrelated-assertion'],
        })),
      };
    },
  };
  await assert.rejects(
    () => ensureProjectTestCases(context, invented.scopedTasks.get('quote')!),
    /TEST_CASE_EVIDENCE_UNRESOLVED/,
  );
});

test('Core rejects Planner-authored expected outcomes that contradict authoritative tasks', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'] });
  const planner = fixture.context.plannerRunner!;
  const context: VerificationPlannerContext = {
    ...fixture.context,
    plannerRunner: async (request) => {
      const candidate = await planner(request);
      return {
        ...candidate,
        testCases: candidate.testCases.map((testCase) => ({
          ...testCase,
          expectedOutcome: 'the opposite behavior occurs',
        })),
      };
    },
  };

  await assert.rejects(
    () => ensureProjectTestCases(context, fixture.scopedTasks.get('quote')!),
    /TEST_CASE_EXPECTED_OUTCOME_MISMATCH/,
  );
});

test('persisted project cases cannot keep a scenario from a superseded ContractSnapshot', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'], includeContract: true });
  const planner = fixture.context.plannerRunner!;
  const context: VerificationPlannerContext = {
    ...fixture.context,
    plannerRunner: async (request) => {
      const candidate = await planner(request);
      const scenario = request.packet.contractScenarios[0]!;
      return {
        ...candidate,
        testCases: candidate.testCases.map((testCase) => ({
          ...testCase,
          contractRefs: [scenario.snapshot],
          scenarioRefs: [{
            contractKey: scenario.contractKey,
            scopeHash: scenario.scopeHash,
            snapshot: scenario.snapshot,
            scenarioId: scenario.scenarioId,
            scenarioClass: scenario.scenarioClass,
            contentHash: scenario.contentHash,
          }],
          expectedOutcome: scenario.expectedOutcome,
        })),
      };
    },
  };
  await ensureProjectTestCases(context, fixture.scopedTasks.get('quote')!);
  const successor = contractSnapshotVariant(fixture.contractSnapshot, 'authorization-v2', 'CTR-0002');

  await assert.rejects(
    () => loadProjectTestCaseSet(
      { ...context, contractSnapshotResolver: async () => [successor] },
      fixture.scopedTasks.get('quote')!,
    ),
    /PROJECT_TEST_CASES_STALE:CONTRACT/,
  );
});

test('a shell-free but manifest-unresolved network command blocks before Planner dispatch', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'], legacyCommands: ['curl https://example.test'] });

  await assert.rejects(
    () => ensureProjectTestCases(fixture.context, fixture.scopedTasks.get('quote')!),
    /COMMAND_DEFINITION_UNRESOLVED/,
  );
  assert.equal(fixture.plannerCalls.length, 0);
});

test('Core rejects project Planner ownership and test paths that do not resolve to the project task', async () => {
  for (const invalid of ['owner', 'test-path'] as const) {
    const fixture = await createVerificationFixture({ projects: ['quote'] });
    const planner = fixture.context.plannerRunner!;
    const context: VerificationPlannerContext = {
      ...fixture.context,
      plannerRunner: async (request) => {
        const candidate = await planner(request);
        return {
          ...candidate,
          testCases: candidate.testCases.map((testCase) => invalid === 'owner'
            ? { ...testCase, ownerProjects: ['unrelated-service'] }
            : { ...testCase, testPaths: ['test/not-declared-by-task.test.ts'] }),
        };
      },
    };

    await assert.rejects(
      () => ensureProjectTestCases(context, fixture.scopedTasks.get('quote')!),
      invalid === 'owner' ? /TEST_CASE_OWNER_PROJECT_UNRESOLVED/ : /TEST_PATH_UNRESOLVED/,
      invalid,
    );
  }
});

test('Planner cannot widen an exact manifest-authorized command with additional argv', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'], legacyCommands: ['npm test'] });
  const planner = fixture.context.plannerRunner!;
  const context: VerificationPlannerContext = {
    ...fixture.context,
    plannerRunner: async (request) => {
      const candidate = await planner(request);
      return {
        ...candidate,
        commandDefinitions: candidate.commandDefinitions.map((definition) => ({
          ...definition,
          argv: [...definition.argv, '--', '--loader=../../untrusted.mjs'],
        })),
      };
    },
  };

  await assert.rejects(
    () => ensureProjectTestCases(context, fixture.scopedTasks.get('quote')!),
    /COMMAND_ARGUMENT_INVALID/,
  );
});

test('two different READY snapshots for one contract key block plan readiness', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote', 'user'], includeContract: true });
  const second: ContractSnapshot = {
    ...fixture.contractSnapshot,
    manifest: {
      ...fixture.contractSnapshot.manifest,
      id: 'CTR-0002',
      contentHash: hashObject('authorization-v2-snapshot-2'),
    },
  };
  const context: VerificationPlannerContext = {
    ...fixture.context,
    contractSnapshotResolver: async () => [fixture.contractSnapshot, second],
  };

  const plan = await compileVerificationPlan(context, fixture.scope);

  assert.equal(plan.status, 'INVALID');
  assert.match(plan.validation.map((item) => item.code).join(','), /CONTRACT_READY_SELECTION_REQUIRED/);
});

test('source drift makes a persisted READY plan stale without mutating it', async () => {
  const fixture = await createVerificationFixture({ projects: ['quote'] });
  const scopedTask = fixture.scopedTasks.get('quote')!;
  await ensureProjectTestCases(fixture.context, scopedTask);
  const ready = await compileVerificationPlan(fixture.context, fixture.scope);
  assert.equal(ready.status, 'READY');

  const repo = fixture.repos.get('quote')!;
  await writeFile(
    changeArtifactPath(repo, 'CHG-0001-verification-quote', 'spec.md'),
    '# Specification\n\n## Acceptance Criteria\n\n- AC-001: changed observable behavior\n',
    'utf8',
  );

  await assert.rejects(
    () => loadReadyVerificationPlan(fixture.context, { id: ready.id, contentHash: ready.contentHash }),
    /VERIFICATION_PLAN_STALE.*SOURCE/,
  );
});

async function createVerificationFixture(options: FixtureOptions = {}): Promise<VerificationFixture & {
  contractSnapshotScenario(): ContractScenarioRef;
}> {
  const projectNames = [...(options.projects ?? ['quote'])].sort();
  const home = await createTestDirectory('omnai-verification-plan-');
  cleanups.push(home.cleanup);
  const workset = await createWorkset(home.root, 'Verification scope');
  const repos = new Map<string, string>();
  const scopedTasks = new Map<string, ScopedTaskRef>();
  const taskHashes = new Map<string, ContentHash>();
  const now = NOW;

  for (const [index, project] of projectNames.entries()) {
    const repo = await createTestRepository(project);
    cleanups.push(repo.cleanup);
    repos.set(project, repo.root);
    await writeFile(join(repo.root, 'package.json'), JSON.stringify({
      name: project,
      scripts: { test: options.packageTestScript ?? `node --test test/${project}.test.js` },
    }), 'utf8');
    git(repo.root, ['add', 'package.json']);
    git(repo.root, ['commit', '-m', `test: add ${project} manifest`]);
    const change = await createChange(
      repo.root,
      options.sharedChangeInputs ? 'Verification shared' : `Verification ${project}`,
    );
    assert.equal(
      change.directoryName,
      options.sharedChangeInputs ? 'CHG-0001-verification-shared' : `CHG-0001-verification-${project}`,
    );
    const acceptanceLines = [
      options.sharedChangeInputs
        ? '- AC-001: shared behavior is observable'
        : `- AC-001: ${project} behavior is observable`,
      ...(options.secondAcceptanceCriterion
        ? [options.sharedChangeInputs
            ? '- AC-002: shared failure behavior is observable'
            : `- AC-002: ${project} failure behavior is observable`]
        : []),
    ];
    await writeFile(
      changeArtifactPath(repo.root, change.directoryName, 'spec.md'),
      `# Specification\n\n## Acceptance Criteria\n\n${acceptanceLines.join('\n')}\n`,
      'utf8',
    );
    const projectTasks = [{
      id: 'TASK-001', title: `Implement ${project}`, objective: `Change ${project} behavior`, status: 'READY' as const,
      dependsOn: [], slice: 'VERTICAL' as const, risk: options.taskRisk ?? 'MEDIUM',
      contractRefs: [],
      files: { create: [`src/${project}.ts`], modify: [], tests: [`test/${project}.test.ts`] },
      consumes: [], produces: [], steps: ['write a failing test'],
      evidenceRequired: [...(options.taskEvidenceRequired ?? ['test'])], notes: [],
    }, ...(options.secondTask ? [{
      id: 'TASK-002', title: `Document ${project}`, objective: `Change a second ${project} behavior`, status: 'READY' as const,
      dependsOn: [], slice: 'VERTICAL' as const, risk: options.secondTaskRisk ?? 'LOW' as const,
      contractRefs: [],
      files: { create: [`src/${project}-secondary.ts`], modify: [], tests: [`test/${project}-secondary.test.ts`] },
      consumes: [], produces: [], steps: ['cover the second behavior'], evidenceRequired: ['test'], notes: [],
    }] : [])];
    for (const task of projectTasks) taskHashes.set(`${project}:${task.id}`, hashObject(task));
    await saveTasks(changeArtifactPath(repo.root, change.directoryName, 'tasks.yaml'), {
      schemaVersion: 1,
      revision: 'REV-0001',
      generatedFrom: ['spec.md#AC-001'],
      tasks: projectTasks,
    });
    const config = await loadProjectConfig(repo.root);
    await saveProjectConfig(repo.root, {
      ...config,
      verification: { commands: [...(options.legacyCommands ?? ['npm test'])] },
    });
    git(repo.root, ['add', '.omnai']);
    git(repo.root, ['commit', '-m', `test: add ${project} change`]);
    workset.members.push({
      project,
      status: 'ACTIVE',
      changeId: change.metadata.id,
      worktree: repo.root,
      branch: git(repo.root, ['branch', '--show-current']),
      addedAt: now,
      updatedAt: now,
    });
    scopedTasks.set(project, {
      project,
      changeId: change.metadata.id,
      revision: change.metadata.activeRevision,
      baseline: change.metadata.baseline,
      taskId: 'TASK-001',
    });
    assert.ok(index < 9999);
  }
  workset.members.sort((left, right) => left.project.localeCompare(right.project));
  await saveWorkset(home.root, workset);

  const plannerCalls: ProjectTestPlannerRequest[] = [];
  const snapshotsWereReadOnly: boolean[] = [];
  const contractSnapshot = createReadyContractSnapshot(
    workset.id,
    projectNames,
    scopedTasks,
    options.contractExecutorRefs,
  );
  const profile = verificationProfile(projectNames, options.profileHash);
  const profileHash = profile.contentHash;
  const ids = new Map(projectNames.map((project, index) => [
    project,
    options.duplicateDisplayId ? 'TC-0010' : `TC-${String((index + 1) * 10).padStart(4, '0')}`,
  ]));
  const context: VerificationPlannerContext = {
    home: home.root,
    worksetId: workset.id,
    now: () => NOW,
    plannerRunner: async (request) => {
      plannerCalls.push(request);
      const mode = (await stat(request.snapshot.path)).mode;
      snapshotsWereReadOnly.push((mode & 0o222) === 0);
      return candidateForPlanner(request, ids.get(request.packet.project)!, options);
    },
    contractSnapshotResolver: async () => options.includeContract ? [contractSnapshot] : [],
    profileResolver: async (profileId) => {
      assert.equal(profileId, profile.id);
      return profile;
    },
    profileRefResolver: async (profileId) => ({ id: profileId, contentHash: profileHash }),
    policy: createDefaultVerificationPolicy(),
  };
  const scope: VerificationPlanScope = {
    scopedTasks: [...scopedTasks.values()].sort(scopedTaskCompare),
    profileId: 'authorization-local',
    notApplicableDecisions: [],
  };
  return {
    context,
    scope,
    workset,
    scopedTasks,
    plannerCalls,
    snapshotsWereReadOnly,
    repos,
    taskHashes,
    contractSnapshot,
    contractSnapshotScenario: () => contractScenarioRef(contractSnapshot),
  };
}

function verificationProfile(
  projects: readonly string[],
  definitionHash: ContentHash = hashObject('verification-profile-definition-v1'),
): IntegrationEnvironmentProfile {
  const step = (name: string) => ({ commandRef: `environment.${name}`, timeoutMs: 60_000 });
  const content = {
    schemaVersion: 2 as const,
    id: 'authorization-local',
    driver: 'commands' as const,
    requiredProjects: [...projects].sort(),
    definitionRef: 'integration/environment.yaml',
    definitionContentHash: definitionHash,
    isolation: { mode: 'per-run' as const, maxParallel: 1, requireExclusiveLease: false },
    ports: { mode: 'dynamic' as const, range: [20_000, 30_000] as const },
    sourceRefs: [{ ref: 'integration/environment.yaml', contentHash: definitionHash }],
    envRefs: {},
    sandbox: {
      driver: 'platform' as const,
      requiredProofs: ['CREDENTIALS', 'FILESYSTEM', 'NETWORK', 'PROCESS_TREE', 'RESOURCE_LIMITS'] as const,
    },
    steps: {
      setup: step('setup'),
      build: step('build'),
      start: step('start'),
      health: step('health'),
      seed: step('seed'),
      test: step('test'),
      collect: step('collect'),
      teardown: step('teardown'),
    },
  };
  return { ...content, contentHash: hashIntegrationEnvironmentProfile(content) };
}

function candidateForPlanner(
  request: ProjectTestPlannerRequest,
  id: string,
  options: FixtureOptions,
): ProjectTestPlanCandidate {
  const packet = request.packet;
  const acceptance = packet.acceptanceCriteria[0]!;
  const acceptedCriteria = options.omitSecondAcceptanceCoverage
    ? [acceptance]
    : packet.acceptanceCriteria;
  const numericId = Number(id.slice(3));
  const selectedTasks = options.omitAllTaskCases
    ? []
    : options.omitSecondTaskCase ? packet.scopedTasks.slice(0, 1) : packet.scopedTasks;
  const testCases = selectedTasks.map((task, index) => {
    const caseId = index === 0 ? id : `TC-${String((numericId + index) % 10_000).padStart(4, '0')}`;
    const commandRef = options.localCommandRef ?? `${packet.project}.project-test`;
    return {
      id: caseId,
      level: options.projectCaseLevel ?? 'UNIT' as const,
      title: `${packet.project} acceptance behavior ${index + 1}`,
      required: true,
      sourceRefs: [acceptance],
      scopedTasks: [task],
      acceptanceCriteriaRefs: acceptedCriteria,
      contractRefs: [],
      scenarioRefs: [],
      commandRefs: [commandRef],
      ownerProjects: [packet.project],
      testPaths: [`test/${packet.project}${index === 0 ? '' : '-secondary'}.test.ts`],
      evidenceRequired: [...(options.caseEvidenceRequired ?? ['test'])],
      expectedOutcome: index === 0
        ? `Change ${packet.project} behavior`
        : `Change a second ${packet.project} behavior`,
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  const mappedCaseIds = options.unmappedRequiredCase && testCases.length > 1
    ? [testCases.at(-1)!.id]
    : testCases.map((item) => item.id);
  return {
    schemaVersion: 1,
    runId: packet.id,
    packetHash: packet.packetHash,
    project: packet.project,
    sourceSnapshot: {
      head: packet.sourceSnapshot.head,
      tree: packet.sourceSnapshot.tree,
      contentHash: packet.sourceSnapshot.contentHash,
    },
    scopedTasks: packet.scopedTasks,
    testCases,
    commandDefinitions: testCases.length === 0 ? [] : [{
      commandRef: options.localCommandRef ?? `${packet.project}.project-test`,
      executable: 'npm',
      argv: ['test'],
      cwd: '.',
      network: 'DENY',
      timeoutMs: 60_000,
      outputLimit: 1_048_576,
      caseRefs: mappedCaseIds,
    }],
    summary: `Project test plan for ${packet.project}`,
  };
}

function contractSnapshotVariant(
  snapshot: ContractSnapshot,
  contractKey: string,
  id: string,
): ContractSnapshot {
  const scopeHash = hashObject({ contractKey, original: snapshot.manifest.scopeHash });
  const contentHash = hashObject({ contractKey, id });
  return {
    ...snapshot,
    manifest: {
      ...snapshot.manifest,
      id,
      contractKey,
      scopeHash,
      contentHash,
      createdByRun: 'RUN-0002',
    },
    candidate: {
      ...snapshot.candidate,
      runId: 'RUN-0002',
      contractKey,
      scopeHash,
    },
  };
}

function createReadyContractSnapshot(
  worksetId: string,
  projects: readonly string[],
  tasks: ReadonlyMap<string, ScopedTaskRef>,
  executorRefs: readonly string[] = ['environment.test'],
): ContractSnapshot {
  const participants = projects.map((project, index) => ({
    project,
    changeId: 'CHG-0001',
    revision: 'REV-0001',
    baseline: 'BL-0001',
    taskId: 'TASK-001',
    role: (index === 0 ? 'PROVIDER' : 'CONSUMER') as 'PROVIDER' | 'CONSUMER',
  }));
  if (participants.length === 1) {
    participants.push({
      project: 'remote-service', changeId: 'CHG-0001', revision: 'REV-0001', baseline: 'BL-0001',
      taskId: 'TASK-001', role: 'CONSUMER',
    });
  }
  participants.sort((left, right) => participantKey(left).localeCompare(participantKey(right)));
  const participantProjects = [...new Set(participants.map((item) => item.project))].sort();
  const sourceRefs = participantProjects.map((project) => `${project}/CHG-0001/REV-0001/spec.md`);
  const sourceHashes = sourceRefs.map((ref) => ({ ref, contentHash: hashObject(ref) }));
  const scopeHash = hashObject({ key: 'authorization-v2', participants });
  const scenario = {
    id: 'SC-007',
    class: 'FAILURE' as const,
    title: 'revoked authorization is rejected',
    participantProjects,
    sourceRefs,
    contractElementRefs: ['authorization.response'],
    fixtureRefs: [],
    executorRefs: [...executorRefs].sort(),
    expectedOutcome: 'revoked authorization is rejected without side effects',
  };
  const snapshotRef = { id: 'CTR-0001', contentHash: hashObject('authorization-v2-snapshot') };
  return {
    context: { home: '/unused', worksetId },
    root: '/unused',
    manifest: {
      schemaVersion: 1,
      machineVersion: 1,
      lastEventSequence: 1,
      lastEventHash: hashObject('ready-event'),
      id: snapshotRef.id,
      worksetId,
      status: 'READY',
      contractKey: 'authorization-v2',
      scopeHash,
      contentHash: snapshotRef.contentHash,
      previousSnapshot: null,
      participants,
      sources: sourceHashes.map(({ ref, contentHash }) => ({
        kind: 'spec' as const,
        project: ref.split('/')[0]!,
        ref,
        contentHash,
      })),
      businessScenarios: [scenario.id],
      validationEvidence: ['EVD-0001'],
      createdByRun: 'RUN-0001',
      createdAt: NOW,
      updatedAt: NOW,
    },
    candidate: {
      schemaVersion: 1,
      runId: 'RUN-0001',
      packetHash: hashObject('contract-packet'),
      contractKey: 'authorization-v2',
      scopeHash,
      participants: participantProjects.map((project, index) => ({
        project,
        role: (index === 0 ? 'PROVIDER' : 'CONSUMER') as 'PROVIDER' | 'CONSUMER',
        taskRefs: [tasks.get(project)?.taskId ?? 'TASK-001'],
      })).sort((left, right) => `${left.project}\0${left.role}`.localeCompare(`${right.project}\0${right.role}`)),
      contract: {
        elements: [{
          id: 'authorization.response', kind: 'SCHEMA', name: 'Authorization response',
          ownerProject: participantProjects[0]!, definition: { type: 'object' }, sourceRefs,
        }],
        compatibilityPolicy: { mode: 'BACKWARD_COMPATIBLE', rules: ['preserve denial semantics'] },
      },
      businessScenarios: [scenario],
      fixtures: [],
      traceability: sourceHashes.map(({ ref, contentHash }) => ({
        sourceRef: ref,
        sourceHash: contentHash,
        contractElementRefs: ['authorization.response'],
        scenarioIds: [scenario.id],
      })),
      sourceHashes,
      validatorRequests: [],
      summary: 'Ready authorization contract',
    },
    sources: sourceHashes.map(({ ref, contentHash }) => ({
      kind: 'spec' as const,
      project: ref.split('/')[0]!,
      ref,
      absolutePath: '/unused',
      contentHash,
    })),
  };
}

function contractScenarioRef(snapshot: ContractSnapshot): ContractScenarioRef {
  const scenario = snapshot.candidate.businessScenarios[0]!;
  return {
    contractKey: snapshot.manifest.contractKey,
    scopeHash: snapshot.manifest.scopeHash,
    snapshot: { id: snapshot.manifest.id, contentHash: snapshot.manifest.contentHash },
    scenarioId: scenario.id,
    scenarioClass: scenario.class,
    contentHash: hashObject({
      snapshot: { id: snapshot.manifest.id, contentHash: snapshot.manifest.contentHash },
      scenario,
    }),
  };
}

function participantKey(participant: {
  project: string;
  changeId: string;
  revision: string;
  baseline: string;
  taskId: string;
  role: string;
}): string {
  return [
    participant.project,
    participant.changeId,
    participant.revision,
    participant.baseline,
    participant.taskId,
    participant.role,
  ].join('\0');
}

function legacyVerificationPlan(worksetId: string, id: string) {
  const semantic = {
    schemaVersion: 1 as const,
    id,
    worksetId,
    scopeHash: hashObject({ id, scope: 'legacy' }),
    contractSnapshots: [],
    profile: { id: 'legacy-profile', contentHash: hashObject('legacy-profile') },
    projectChecks: [],
    integrationCaseRefs: [],
  };
  return {
    ...semantic,
    machineVersion: 1 as const,
    lastEventSequence: 0,
    lastEventHash: null,
    status: 'READY' as const,
    contentHash: hashObject(semantic),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function scopedTaskCompare(left: ScopedTaskRef, right: ScopedTaskRef): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim();
}

async function readFileText(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(path, 'utf8');
}
