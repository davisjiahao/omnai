import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { openDecision } from '../src/core/decisions.js';
import { findEvidenceGaps, listEvidence, recordEvidence } from '../src/core/evidence.js';
import { applyFlowAssessment } from '../src/core/flow-assessment.js';
import { flowInputHash } from '../src/core/flow.js';
import { loadFlowPlan } from '../src/core/flow-store.js';
import { writeYaml } from '../src/core/files.js';
import { evaluateGuard } from '../src/core/guards.js';
import { createInitialIssueState, transitionIssue } from '../src/core/issues.js';
import { changeFlowPath, changeMetadataPath, changeRoot } from '../src/core/paths.js';
import { buildEvidenceMatrix } from '../src/core/policy.js';
import { reconcileChange } from '../src/core/reconcile.js';
import { resolveRepositoryRoute } from '../src/core/router.js';
import { getScenario } from '../src/core/scenarios.js';
import { createChange } from '../src/core/store.js';
import { validateTaskGraph } from '../src/core/tasks.js';
import type { TaskFile } from '../src/domain/types.js';
import { createTestRepository } from './helpers.js';

const ISSUE_BACKED_SCENARIOS = ['bug-fix', 'emergency-hotfix', 'incident-response', 'release-failure'] as const;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const sourceRefs = [{
  kind: 'artifact' as const,
  path: 'research.md',
  contentHash: `sha256:${'a'.repeat(64)}` as const,
}];

test('every issue-backed correction route blocks production edits before ready-for-fix', () => {
  for (const scenario of ISSUE_BACKED_SCENARIOS) {
    const blocked = evaluateGuard({
      action: 'edit',
      scenario,
      riskLevel: getScenario(scenario).risk,
      issue: createInitialIssueState(),
    });
    assert.equal(blocked.allowed, false, scenario);
    assert.equal(blocked.code, 'BUG_RCA_REQUIRED', scenario);
  }
});

test('every issue-backed correction route permits edit after reproduction RCA and fix strategy are confirmed', () => {
  for (const scenario of ISSUE_BACKED_SCENARIOS) {
    const issue = createInitialIssueState();
    issue.reproduction = 'confirmed';
    issue.rootCause = 'confirmed';
    issue.fixStrategy = 'ready';
    transitionIssue(issue, 'ready-for-fix');

    const decision = evaluateGuard({
      action: 'edit',
      scenario,
      riskLevel: getScenario(scenario).risk,
      issue,
    });
    assert.equal(decision.allowed, true, scenario);
  }
});

test('release failure keeps reconcile event-driven instead of making it a fixed mandatory stage', () => {
  const scenario = getScenario('release-failure');
  assert.equal(scenario.stages.includes('reconcile'), false);
  assert.equal(scenario.optionalStages.includes('reconcile'), true);
});

test('a recomputed manual Scenario-floor downgrade cannot bypass compiled next routing', async () => {
  const repo = await createTestRepository('critical-flow-floor');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Protect the Scenario floor', 'small-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const downgraded = {
    ...flow,
    capabilities: flow.capabilities.filter((entry) => entry.capability !== 'spec'),
  };
  await writeYaml(changeFlowPath(repo.root, change.directoryName), {
    ...downgraded,
    inputHash: flowInputHash(downgraded),
  });
  const treeBefore = await changeTreeSnapshot(changeRoot(repo.root, change.directoryName));

  const next = spawnSync(process.execPath, [resolve('dist/src/main.js'), 'next', '--json'], {
    cwd: repo.root,
    encoding: 'utf8',
    env: { ...process.env },
  });

  assert.notEqual(next.status, 0);
  assert.equal(next.stdout, '');
  assert.match(next.stderr, /FLOW_SCENARIO_FLOOR_VIOLATION/);
  assert.deepEqual(await changeTreeSnapshot(changeRoot(repo.root, change.directoryName)), treeBefore);
});

test('stale Revision and Baseline flow or decision inputs cannot mutate current state', async () => {
  const repo = await createTestRepository('critical-stale-routing-input');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Reject stale routing input', 'complex-domain-feature');
  const flow = (await loadFlowPlan(repo.root, change))!;
  const staleRevision = {
    ...change,
    metadata: { ...change.metadata, activeRevision: 'REV-0000' },
  };

  const beforeStaleDecision = await changeTreeSnapshot(changeRoot(repo.root, change.directoryName));
  await assert.rejects(
    () => openDecision(repo.root, staleRevision, { schemaVersion: 2,
      kind: 'DOMAIN',
      owner: 'HUMAN',
      status: 'OPEN',
      blocking: true,
      question: 'Can stale authority mutate this Change?',
      options: [],
      affects: { capabilities: ['model'], artifacts: ['domain.md'], tasks: [], projects: [], contracts: [] },
      sourceRefs,
    }),
    /DECISION_STALE_REVISION/,
  );
  assert.deepEqual(
    await changeTreeSnapshot(changeRoot(repo.root, change.directoryName)),
    beforeStaleDecision,
  );

  const beforeStaleFlow = await changeTreeSnapshot(changeRoot(repo.root, change.directoryName));
  await assert.rejects(
    () => applyFlowAssessment(repo.root, change, {
      schemaVersion: 1,
      changeId: change.metadata.id,
      revision: change.metadata.activeRevision,
      baseline: 'BL-0000',
      assessment: { ...flow.assessment, topology: 'CROSS_MODULE', architectureApplicability: 'FOCUSED' },
    }),
    /FLOW_STALE_BASELINE/,
  );
  assert.deepEqual(
    await changeTreeSnapshot(changeRoot(repo.root, change.directoryName)),
    beforeStaleFlow,
  );
});

test('generating an adaptive route never marks readiness READY', async () => {
  const repo = await createTestRepository('critical-read-only-route');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Keep route generation read-only', 'small-feature');
  const metadataBefore = await readFile(changeMetadataPath(repo.root, change.directoryName), 'utf8');

  const route = await resolveRepositoryRoute(repo.root, change);

  assert.equal(route.capability, 'spec');
  assert.equal(change.metadata.readiness.spec, 'MISSING');
  assert.equal(await readFile(changeMetadataPath(repo.root, change.directoryName), 'utf8'), metadataBefore);
});

test('evidence from an old Revision cannot satisfy current verification', async () => {
  const repo = await createTestRepository('critical-current-evidence');
  cleanups.push(repo.cleanup);
  const change = await createChange(repo.root, 'Bind evidence to Revision', 'small-feature');
  await recordEvidence(repo.root, change, {
    requirementId: 'tests',
    type: 'test',
    status: 'PASS',
    summary: 'Tests passed for REV-0001 only.',
  });
  await reconcileChange(repo.root, change, {
    level: 'L0',
    type: 'IMPLEMENTATION_CHANGED',
    reason: 'Source changed after verification.',
  });

  const matrix = buildEvidenceMatrix(getScenario('small-feature'), change.metadata.risk, change.metadata.impact);
  const evidence = await listEvidence(repo.root, change);
  assert.ok(findEvidenceGaps(matrix, evidence, change.metadata.activeRevision).some(({ id }) => id === 'tests'));
});

test('Task dependency validation remains project-local', () => {
  const tasks: TaskFile = {
    schemaVersion: 1,
    revision: 'REV-0001',
    generatedFrom: ['spec:AC-001'],
    tasks: [{
      id: 'TASK-001',
      title: 'Project-local slice',
      objective: 'Reject a dependency in another project.',
      status: 'PENDING',
      dependsOn: ['other-project:TASK-001'],
      slice: 'VERTICAL',
      risk: 'MEDIUM',
      files: { create: [], modify: [], tests: [] },
      consumes: [],
      produces: [],
      steps: ['Remain local'],
      evidenceRequired: ['test'],
      notes: [],
    }],
  };

  assert.throws(
    () => validateTaskGraph(tasks),
    /CROSS_PROJECT_TASK_DEPENDENCY.*other-project:TASK-001/,
  );
});

async function changeTreeSnapshot(root: string): Promise<Array<{
  path: string;
  type: 'directory' | 'file';
  content?: string;
}>> {
  const snapshot: Array<{ path: string; type: 'directory' | 'file'; content?: string }> = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path);
      if (entry.isDirectory()) {
        snapshot.push({ path: relativePath, type: 'directory' });
        await visit(path);
      } else {
        assert.equal(entry.isFile(), true, `Unexpected Change-tree entry: ${relativePath}`);
        snapshot.push({
          path: relativePath,
          type: 'file',
          content: (await readFile(path)).toString('base64'),
        });
      }
    }
  };
  await visit(root);
  return snapshot;
}
