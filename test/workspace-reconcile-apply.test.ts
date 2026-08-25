import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createAndActivateWorksetProjectChange } from '../src/workspace/change-bindings.js';
import { reconcileChange } from '../src/core/reconcile.js';
import { changeArtifactPath } from '../src/core/paths.js';
import { resolveChange } from '../src/core/store.js';
import { loadTasks, saveTasks } from '../src/core/tasks.js';
import { registerProject } from '../src/workspace/project-registry.js';
import { decideWorksetReentry, planWorksetReentry } from '../src/workspace/reconcile-plan.js';
import {
  applyWorksetReentry,
  reentryApplicationStatus,
} from '../src/workspace/reconcile-apply.js';
import { recordWorksetReentry } from '../src/workspace/reentry.js';
import { addWorksetCandidate, beginProjectResearch, createWorkset, resolveWorkset } from '../src/workspace/worksets.js';
import { createTestDirectory, createTestRepository } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function activate(
  home: string,
  worksetId: string,
  project: string,
  scenario = 'small-feature',
): Promise<{ worktree: string; changeId: string }> {
  await addWorksetCandidate(home, worksetId, project);
  await beginProjectResearch(home, worksetId, project);
  const created = await createAndActivateWorksetProjectChange(
    home,
    worksetId,
    project,
    `${project} Workset Change`,
    scenario,
  );
  const member = created.workset.members.find((item) => item.project === project);
  assert.ok(member?.worktree);
  assert.ok(member.changeId);
  return { worktree: member.worktree, changeId: member.changeId };
}

async function decideRequired(
  home: string,
  worksetId: string,
  project: string,
  kind: 'SCOPE_CHANGED' | 'PLAN_CHANGED' = 'SCOPE_CHANGED',
) {
  const reentry = await recordWorksetReentry(home, worksetId, {
    kind,
    reason: `${project} requirement changed`,
    affectedProjects: [project],
  });
  await planWorksetReentry(home, worksetId, reentry.id, [{
    project,
    outcome: 'REQUIRED',
    level: kind === 'PLAN_CHANGED' ? 'L1' : 'L3',
    reopenFrom: kind === 'PLAN_CHANGED' ? 'plan' : 'spec',
    taskRoots: [],
  }]);
  return decideWorksetReentry(home, worksetId, reentry.id);
}

test('applying one required project advances exactly one Revision/Baseline and resolves the WRE', async () => {
  const home = await createTestDirectory('omnai-home-');
  const repo = await createTestRepository('user-center');
  cleanups.push(home.cleanup, repo.cleanup);
  await registerProject(home.root, repo.root, 'user');
  const workset = await createWorkset(home.root, 'Authorization Migration');
  const active = await activate(home.root, workset.id, 'user');
  const decided = await decideRequired(home.root, workset.id, 'user');
  assert.equal(decided.status, 'DECIDED');
  assert.equal(decided.applications[0]?.fromRevision, 'REV-0001');
  assert.equal(decided.applications[0]?.fromBaseline, 'BL-0001');

  const applied = await applyWorksetReentry(home.root, workset.id, decided.id, 'user');
  assert.equal(applied.status, 'RESOLVED');
  assert.equal(applied.applications[0]?.status, 'APPLIED');
  assert.equal(applied.applications[0]?.toRevision, 'REV-0002');
  assert.equal(applied.applications[0]?.toBaseline, 'BL-0002');

  const change = await resolveChange(active.worktree, active.changeId);
  assert.equal(change.metadata.activeRevision, 'REV-0002');
  assert.equal(change.metadata.baseline, 'BL-0002');

  const again = await applyWorksetReentry(home.root, workset.id, decided.id, 'user');
  assert.equal(again.status, 'RESOLVED');
  assert.equal((await resolveChange(active.worktree, active.changeId)).metadata.activeRevision, 'REV-0002');
  assert.equal((await reentryApplicationStatus(home.root, workset.id, decided.id)).applications[0]?.status, 'APPLIED');
});

test('stale frozen Revision/Baseline fails safely without advancing a second revision', async () => {
  const home = await createTestDirectory('omnai-home-');
  const repo = await createTestRepository('user-center');
  cleanups.push(home.cleanup, repo.cleanup);
  await registerProject(home.root, repo.root, 'user');
  const workset = await createWorkset(home.root, 'Authorization Migration');
  const active = await activate(home.root, workset.id, 'user');
  const decided = await decideRequired(home.root, workset.id, 'user');

  const change = await resolveChange(active.worktree, active.changeId);
  await reconcileChange(active.worktree, change, {
    level: 'L0',
    type: 'INDEPENDENT_CHANGE',
    reason: 'Project changed after WRE decision',
  });
  assert.equal(change.metadata.activeRevision, 'REV-0002');

  const result = await applyWorksetReentry(home.root, workset.id, decided.id, 'user');
  assert.equal(result.status, 'DECIDED');
  assert.equal(result.applications[0]?.status, 'FAILED');
  assert.equal(result.applications[0]?.failureKind, 'STALE_PRECONDITION');
  assert.deepEqual(result.applications[0]?.attemptHistory, []);
  assert.match(result.applications[0]?.error ?? '', /frozen|REV-0001|BL-0001/i);
  assert.equal((await resolveChange(active.worktree, active.changeId)).metadata.activeRevision, 'REV-0002');
});

test('one failed project does not roll back an already applied sibling', async () => {
  const home = await createTestDirectory('omnai-home-');
  const userRepo = await createTestRepository('user-center');
  const quoteRepo = await createTestRepository('quote-center');
  cleanups.push(home.cleanup, userRepo.cleanup, quoteRepo.cleanup);
  await registerProject(home.root, userRepo.root, 'user');
  await registerProject(home.root, quoteRepo.root, 'quote');
  const workset = await createWorkset(home.root, 'Authorization Migration');
  const user = await activate(home.root, workset.id, 'user');
  const quote = await activate(home.root, workset.id, 'quote');

  const reentry = await recordWorksetReentry(home.root, workset.id, {
    kind: 'SCOPE_CHANGED',
    reason: 'Authorization contract scope changed',
    affectedProjects: ['user', 'quote'],
  });
  await planWorksetReentry(home.root, workset.id, reentry.id, [
    { project: 'user', outcome: 'REQUIRED', level: 'L3', reopenFrom: 'spec', taskRoots: [] },
    { project: 'quote', outcome: 'REQUIRED', level: 'L3', reopenFrom: 'spec', taskRoots: [] },
  ]);
  const decided = await decideWorksetReentry(home.root, workset.id, reentry.id);

  const quoteChange = await resolveChange(quote.worktree, quote.changeId);
  await reconcileChange(quote.worktree, quoteChange, {
    level: 'L0',
    type: 'INDEPENDENT_CHANGE',
    reason: 'Quote project diverged after decision',
  });

  const applied = await applyWorksetReentry(home.root, workset.id, decided.id);
  assert.equal(applied.status, 'DECIDED');
  assert.equal(applied.applications.find((item) => item.project === 'user')?.status, 'APPLIED');
  assert.equal(applied.applications.find((item) => item.project === 'quote')?.status, 'FAILED');
  assert.equal((await resolveChange(user.worktree, user.changeId)).metadata.activeRevision, 'REV-0002');
  assert.equal((await resolveChange(quote.worktree, quote.changeId)).metadata.activeRevision, 'REV-0002');
});

test('retry recovers an already correlated repository reconcile instead of advancing twice', async () => {
  const home = await createTestDirectory('omnai-home-');
  const repo = await createTestRepository('user-center');
  cleanups.push(home.cleanup, repo.cleanup);
  await registerProject(home.root, repo.root, 'user');
  const workset = await createWorkset(home.root, 'Authorization Migration');
  const active = await activate(home.root, workset.id, 'user');
  const decided = await decideRequired(home.root, workset.id, 'user');
  const application = decided.applications[0]!;

  const change = await resolveChange(active.worktree, active.changeId);
  await reconcileChange(active.worktree, change, {
    level: application.level!,
    type: 'WORKSET_REENTRY',
    reason: decided.reason,
    affectedReadiness: application.readinessClosure,
    affectedTasks: application.taskRoots,
    correlationId: `${decided.id}/user`,
  });
  assert.equal(change.metadata.activeRevision, 'REV-0002');

  const recovered = await applyWorksetReentry(home.root, workset.id, decided.id, 'user');
  assert.equal(recovered.status, 'RESOLVED');
  assert.equal(recovered.applications[0]?.status, 'APPLIED');
  assert.equal(recovered.applications[0]?.toRevision, 'REV-0002');
  assert.equal((await resolveChange(active.worktree, active.changeId)).metadata.activeRevision, 'REV-0002');
});

test('apply rejects a frozen task closure made non-canonical by a changed Task DAG', async () => {
  const home = await createTestDirectory('omnai-home-');
  const repo = await createTestRepository('user-center');
  cleanups.push(home.cleanup, repo.cleanup);
  await registerProject(home.root, repo.root, 'user');
  const workset = await createWorkset(home.root, 'Authorization Migration');
  const active = await activate(home.root, workset.id, 'user');
  const tasksPath = changeArtifactPath(active.worktree, (await resolveChange(active.worktree, active.changeId)).directoryName, 'tasks.yaml');
  const tasks = await loadTasks(tasksPath);
  tasks.tasks = [
    {
      id: 'TASK-001', title: 'Spec consumer', objective: 'Change consumer', status: 'DONE', dependsOn: [], slice: 'VERTICAL', risk: 'MEDIUM',
      files: { create: [], modify: [], tests: [] }, consumes: [], produces: [], steps: [], evidenceRequired: [], notes: [],
    },
    {
      id: 'TASK-002', title: 'Downstream', objective: 'Update downstream', status: 'DONE', dependsOn: ['TASK-001'], slice: 'VERTICAL', risk: 'MEDIUM',
      files: { create: [], modify: [], tests: [] }, consumes: [], produces: [], steps: [], evidenceRequired: [], notes: [],
    },
  ];
  await saveTasks(tasksPath, tasks);

  const reentry = await recordWorksetReentry(home.root, workset.id, {
    kind: 'SCOPE_CHANGED', reason: 'Scope changed', affectedProjects: ['user'],
  });
  await planWorksetReentry(home.root, workset.id, reentry.id, [{
    project: 'user', outcome: 'REQUIRED', level: 'L3', reopenFrom: 'spec', taskRoots: ['TASK-001'],
  }]);
  const decided = await decideWorksetReentry(home.root, workset.id, reentry.id);
  assert.deepEqual(decided.applications[0]?.taskClosure, ['TASK-001', 'TASK-002']);

  const changedTasks = await loadTasks(tasksPath);
  changedTasks.tasks.push({
    id: 'TASK-003', title: 'Added later', objective: 'Later dependent', status: 'DONE', dependsOn: ['TASK-002'], slice: 'VERTICAL', risk: 'LOW',
    files: { create: [], modify: [], tests: [] }, consumes: [], produces: [], steps: [], evidenceRequired: [], notes: [],
  });
  await saveTasks(tasksPath, changedTasks);

  const applied = await applyWorksetReentry(home.root, workset.id, decided.id, 'user');
  const after = await loadTasks(tasksPath);
  assert.equal(applied.status, 'DECIDED');
  assert.equal(applied.applications[0]?.status, 'FAILED');
  assert.equal(applied.applications[0]?.failureKind, 'APPLY_ERROR');
  assert.match(applied.applications[0]?.error ?? '', /RECONCILE_TASK_CLOSURE_INVALID/);
  assert.equal(after.tasks.find((item) => item.id === 'TASK-001')?.status, 'DONE');
  assert.equal(after.tasks.find((item) => item.id === 'TASK-002')?.status, 'DONE');
  assert.equal(after.tasks.find((item) => item.id === 'TASK-003')?.status, 'DONE');
  assert.equal((await resolveChange(active.worktree, active.changeId)).metadata.activeRevision, 'REV-0001');
});
