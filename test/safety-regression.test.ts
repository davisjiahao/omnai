import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { completeStage } from '../src/core/stages.js';
import { createChange, initializeProject, loadProjectConfig } from '../src/core/store.js';
import { createTestRepository } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

test('unchanged scaffold cannot be marked READY', async () => {
  const fixture = await createTestRepository();
  cleanups.push(fixture.cleanup);
  const change = await createChange(fixture.root, 'Small change', 'small-feature');
  await assert.rejects(() => completeStage(fixture.root, change, 'spec'), /scaffold|unchanged|incomplete/i);
});

test('empty experiment directory cannot be completed', async () => {
  const fixture = await createTestRepository();
  cleanups.push(fixture.cleanup);
  const change = await createChange(fixture.root, 'Compare approaches', 'technical-experiment');
  await assert.rejects(() => completeStage(fixture.root, change, 'experiment'), /experiment/i);
});

test('verification command discovery only uses commands the repository can actually run', async () => {
  const nodeRepo = await createTestRepository();
  cleanups.push(nodeRepo.cleanup);
  await writeFile(join(nodeRepo.root, 'package.json'), JSON.stringify({ name: 'demo', scripts: {} }), 'utf8');
  await initializeProject(nodeRepo.root);
  assert.equal((await loadProjectConfig(nodeRepo.root)).verification.commands.includes('npm test'), false);

  const mavenRepo = await createTestRepository();
  cleanups.push(mavenRepo.cleanup);
  await writeFile(join(mavenRepo.root, 'pom.xml'), '<project/>', 'utf8');
  await initializeProject(mavenRepo.root);
  assert.equal((await loadProjectConfig(mavenRepo.root)).verification.commands.includes('mvn test'), true);
  assert.equal((await loadProjectConfig(mavenRepo.root)).verification.commands.includes('./mvnw test'), false);

  const wrapperRepo = await createTestRepository();
  cleanups.push(wrapperRepo.cleanup);
  await writeFile(join(wrapperRepo.root, 'pom.xml'), '<project/>', 'utf8');
  await writeFile(join(wrapperRepo.root, 'mvnw'), '#!/bin/sh\n', 'utf8');
  await initializeProject(wrapperRepo.root);
  assert.equal((await loadProjectConfig(wrapperRepo.root)).verification.commands.includes('./mvnw test'), true);
});
