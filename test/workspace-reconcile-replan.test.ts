import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { changeArtifactPath } from '../src/core/paths.js';
import { reconcileChange } from '../src/core/reconcile.js';
import { resolveChange } from '../src/core/store.js';
import { loadTasks, saveTasks } from '../src/core/tasks.js';
import { createAndActivateWorksetProjectChange } from '../src/workspace/change-bindings.js';
import { registerProject } from '../src/workspace/project-registry.js';
import { applyWorksetReentry } from '../src/workspace/reconcile-apply.js';
import { decideWorksetReentry, planWorksetReentry } from '../src/workspace/reconcile-plan.js';
import { previewFailedWorksetReentryApplicationReplan } from '../src/workspace/reconcile-replan.js';
import {
  loadWorksetReentry,
  recordWorksetReentry,
  saveWorksetReentry,
} from '../src/workspace/reentry.js';
import { addWorksetCandidate, beginProjectResearch, createWorkset } from '../src/workspace/worksets.js';
import { createTestDirectory, createTestRepository } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function createActiveProject(home: string, repoRoot: string, alias = 'user') {
  await registerProject(home, repoRoot, alias);
  const workset = await createWorkset(home, 'Authorization Migration');
  await addWorksetCandidate(home, workset.id, alias);
  await beginProjectResearch(home, workset.id, alias);
  const active = await createAndActivateWorksetProjectChange(
    home,
    workset.id,
    alias,
    `${alias} Workset Change`,
    'complex-domain-feature',
  );
  const member = active.workset.members.find((item) => item.project === alias);
  assert.ok(member?.worktree);
  assert.ok(member.changeId);
  return { workset, worktree: member.worktree, changeId: member.changeId };
}

async function decideScopeReentry(
  home: string,
  worksetId: string,
  alias: string,
  taskRoots: string[] = [],
) {
  const reentry = await recordWorksetReentry(home, worksetId, {
    kind: 'SCOPE_CHANGED',
    reason: `${alias} scope changed`,
    affectedProjects: [alias],
  });
  await planWorksetReentry(home, worksetId, reentry.id, [{
    project: alias,
    outcome: 'REQUIRED',
    level: 'L3',
    reopenFrom: 'spec',
    taskRoots,
  }]);
  return decideWorksetReentry(home, worksetId, reentry.id);
}

async function advanceIndependently(worktree: string, changeId: string): Promise<void> {
  const change = await resolveChange(worktree, changeId);
  await reconcileChange(worktree, change, {
    level: 'L0',
    type: 'INDEPENDENT_CHANGE',
    reason: 'Project changed after WRE decision',
  });
}

test('stale-precondition replan preview uses current Revision/Baseline without mutating the failed WRE', async () => {
  const home = await createTestDirectory('omnai-home-');
  const repo = await createTestRepository('user-center');
  cleanups.push(home.cleanup, repo.cleanup);
  const active = await createActiveProject(home.root, repo.root);
  const decided = await decideScopeReentry(home.root, active.workset.id, 'user');

  await advanceIndependently(active.worktree, active.changeId);
  const failed = await applyWorksetReentry(home.root, active.workset.id, decided.id, 'user');
  assert.equal(failed.applications[0]?.failureKind, 'STALE_PRECONDITION');
  const before = await loadWorksetReentry(home.root, active.workset.id, decided.id);

  const preview = await previewFailedWorksetReentryApplicationReplan(
    home.root,
    active.workset.id,
    decided.id,
    'user',
  );

  assert.equal(preview.worksetId, active.workset.id);
  assert.equal(preview.reentryId, decided.id);
  assert.equal(preview.project, 'user');
  assert.equal(preview.changeId, active.changeId);
  assert.equal(preview.fromRevision, 'REV-0002');
  assert.equal(preview.fromBaseline, 'BL-0002');
  assert.equal(preview.level, 'L3');
  assert.equal(preview.reopenFrom, 'spec');
  assert.deepEqual(
    await loadWorksetReentry(home.root, active.workset.id, decided.id),
    before,
  );
});

test('replan preview recalculates the current Task closure but leaves the failed frozen closure unchanged', async () => {
  const home = await createTestDirectory('omnai-home-');
  const repo = await createTestRepository('user-center');
  cleanups.push(home.cleanup, repo.cleanup);
  const active = await createActiveProject(home.root, repo.root);
  const change = await resolveChange(active.worktree, active.changeId);
  const tasksPath = changeArtifactPath(active.worktree, change.directoryName, 'tasks.yaml');
  const tasks = await loadTasks(tasksPath);
  tasks.tasks = [
    {
      id: 'TASK-001', title: 'Root', objective: 'Root task', status: 'DONE', dependsOn: [], slice: 'VERTICAL', risk: 'MEDIUM',
      files: { create: [], modify: [], tests: [] }, consumes: [], produces: [], steps: [], evidenceRequired: [], notes: [],
    },
    {
      id: 'TASK-002', title: 'Dependent', objective: 'Dependent task', status: 'DONE', dependsOn: ['TASK-001'], slice: 'VERTICAL', risk: 'MEDIUM',
      files: { create: [], modify: [], tests: [] }, consumes: [], produces: [], steps: [], evidenceRequired: [], notes: [],
    },
  ];
  await saveTasks(tasksPath, tasks);

  const decided = await decideScopeReentry(home.root, active.workset.id, 'user', ['TASK-001']);
  assert.deepEqual(decided.applications[0]?.taskClosure, ['TASK-001', 'TASK-002']);
  await advanceIndependently(active.worktree, active.changeId);

  const changedTasks = await loadTasks(tasksPath);
  changedTasks.tasks.push({
    id: 'TASK-003', title: 'New dependent', objective: 'Added after decision', status: 'DONE', dependsOn: ['TASK-002'], slice: 'VERTICAL', risk: 'LOW',
    files: { create: [], modify: [], tests: [] }, consumes: [], produces: [], steps: [], evidenceRequired: [], notes: [],
  });
  await saveTasks(tasksPath, changedTasks);
  await applyWorksetReentry(home.root, active.workset.id, decided.id, 'user');

  const preview = await previewFailedWorksetReentryApplicationReplan(home.root, active.workset.id, decided.id, 'user');
  assert.deepEqual(preview.taskRoots, ['TASK-001']);
  assert.deepEqual(preview.taskClosure, ['TASK-001', 'TASK-002', 'TASK-003']);
  const stored = await loadWorksetReentry(home.root, active.workset.id, decided.id);
  assert.deepEqual(stored.applications[0]?.taskClosure, ['TASK-001', 'TASK-002']);
  assert.equal(stored.applications[0]?.status, 'FAILED');
});

test('replan preview rejects a FAILED application that is not a stale precondition failure', async () => {
  const home = await createTestDirectory('omnai-home-');
  const repo = await createTestRepository('user-center');
  cleanups.push(home.cleanup, repo.cleanup);
  const active = await createActiveProject(home.root, repo.root);
  const decided = await decideScopeReentry(home.root, active.workset.id, 'user');
  const application = decided.applications[0]!;
  application.status = 'FAILED';
  application.failureKind = 'APPLY_ERROR';
  application.error = 'Transient filesystem failure';
  await saveWorksetReentry(home.root, decided);

  await assert.rejects(
    () => previewFailedWorksetReentryApplicationReplan(home.root, active.workset.id, decided.id, 'user'),
    /STALE_PRECONDITION|stale precondition/i,
  );
});

test('replan preview rejects when correlated repository Revision lineage already exists', async () => {
  const home = await createTestDirectory('omnai-home-');
  const repo = await createTestRepository('user-center');
  cleanups.push(home.cleanup, repo.cleanup);
  const active = await createActiveProject(home.root, repo.root);
  const decided = await decideScopeReentry(home.root, active.workset.id, 'user');
  const application = decided.applications[0]!;
  const change = await resolveChange(active.worktree, active.changeId);

  await reconcileChange(active.worktree, change, {
    level: application.level!,
    type: 'WORKSET_REENTRY',
    reason: decided.reason,
    affectedReadiness: application.readinessClosure,
    affectedTasks: application.taskRoots,
    affectedTaskClosure: application.taskClosure,
    correlationId: `${decided.id}/user`,
  });
  application.status = 'FAILED';
  application.failureKind = 'STALE_PRECONDITION';
  application.error = 'Synthetic stale failure after correlated write';
  await saveWorksetReentry(home.root, decided);

  await assert.rejects(
    () => previewFailedWorksetReentryApplicationReplan(home.root, active.workset.id, decided.id, 'user'),
    /correlation|already.*reconcile|lineage/i,
  );
});
