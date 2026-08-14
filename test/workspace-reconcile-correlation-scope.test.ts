import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changeArtifactPath } from '../src/core/paths.js';
import { reconcileChange } from '../src/core/reconcile.js';
import { resolveChange } from '../src/core/store.js';
import { loadTasks, saveTasks } from '../src/core/tasks.js';
import { createAndActivateWorksetProjectChange } from '../src/workspace/change-bindings.js';
import { registerProject } from '../src/workspace/project-registry.js';
import { applyWorksetReentry } from '../src/workspace/reconcile-apply.js';
import { decideWorksetReentry, planWorksetReentry } from '../src/workspace/reconcile-plan.js';
import { recordWorksetReentry } from '../src/workspace/reentry.js';
import { addWorksetCandidate, beginProjectResearch, createWorkset } from '../src/workspace/worksets.js';
import { createTestDirectory, createTestRepository } from './helpers.js';

test('correlation recovery rejects a repository Revision whose Task scope differs from the frozen application', async () => {
  const home = await createTestDirectory('omnai-home-');
  const repo = await createTestRepository('user-center');
  try {
    await registerProject(home.root, repo.root, 'user');
    const workset = await createWorkset(home.root, 'Authorization Migration');
    await addWorksetCandidate(home.root, workset.id, 'user');
    await beginProjectResearch(home.root, workset.id, 'user');
    const active = await createAndActivateWorksetProjectChange(
      home.root,
      workset.id,
      'user',
      'user Workset Change',
      'complex-domain-feature',
    );
    const member = active.workset.members.find((item) => item.project === 'user');
    assert.ok(member?.worktree);
    assert.ok(member.changeId);

    const change = await resolveChange(member.worktree, member.changeId);
    const tasksPath = changeArtifactPath(member.worktree, change.directoryName, 'tasks.yaml');
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

    const reentry = await recordWorksetReentry(home.root, workset.id, {
      kind: 'SCOPE_CHANGED',
      reason: 'Scope changed.',
      affectedProjects: ['user'],
    });
    await planWorksetReentry(home.root, workset.id, reentry.id, [{
      project: 'user', outcome: 'REQUIRED', level: 'L3', reopenFrom: 'spec', taskRoots: ['TASK-001'],
    }]);
    const decided = await decideWorksetReentry(home.root, workset.id, reentry.id);
    const application = decided.applications[0]!;
    assert.deepEqual(application.taskClosure, ['TASK-001', 'TASK-002']);

    await reconcileChange(member.worktree, change, {
      level: application.level!,
      type: 'WORKSET_REENTRY',
      reason: decided.reason,
      affectedReadiness: application.readinessClosure,
      affectedTasks: application.taskRoots,
      affectedTaskClosure: ['TASK-001'],
      correlationId: `${decided.id}/user`,
    });

    const recovered = await applyWorksetReentry(home.root, workset.id, decided.id, 'user');
    assert.equal(recovered.status, 'DECIDED');
    assert.equal(recovered.applications[0]?.status, 'FAILED');
    assert.equal(recovered.applications[0]?.failureKind, 'CORRELATION_CONFLICT');
    assert.match(recovered.applications[0]?.error ?? '', /frozen|Task|scope|match/i);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});
