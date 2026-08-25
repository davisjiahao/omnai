import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import YAML from 'yaml';
import {
  bootstrapIntegrationEnvironmentProfile,
  discoverIntegrationEnvironmentProfiles,
  integrationProfileInputHash,
  resolveIntegrationEnvironmentProfile,
  type DiscoveredProfile,
  type IntegrationEnvironmentProfileContext,
} from '../src/execution/environments/profiles.js';
import {
  EnvironmentAdapterRegistry,
  createArgvProcessTreeRunner,
  createProductionEnvironmentAdapterRegistry,
  validateEnvironmentAdapterContext,
  type ArgvProcessTreeRunner,
  type ArgvRunRequest,
  type EnvironmentAdapterContext,
} from '../src/execution/environments/adapters.js';
import {
  composeBuildContextDigestRef,
  composeExecutorDigestRef,
  composeImageDigestRef,
  createComposeEnvironmentAdapter,
  createProductionComposeRuntime,
  hashComposeBuildContext,
  type ComposeRuntime,
  type ComposeRuntimeResource,
} from '../src/execution/environments/compose-adapter.js';
import {
  commandExecutorDigestRef,
  commandSandboxBindingHash,
  createCommandsEnvironmentAdapter,
  type CommandSandboxExecutionRequest,
  type CommandSandboxExecutionResult,
  type CommandSandboxProvider,
  type SandboxIsolationProof,
} from '../src/execution/environments/commands-adapter.js';
import {
  createExternalEnvironmentAdapter,
  externalLeaseRecordPath,
  type ExternalAttestation,
  type ExternalClientInspection,
  type ExternalEnvironmentClient,
  type ExternalLease,
} from '../src/execution/environments/external-adapter.js';
import {
  integrationEnvironmentProfilePath,
  integrationEnvironmentRunRoot,
} from '../src/execution/paths.js';
import { hashObject, sha256 } from '../src/execution/hashing.js';
import { worksetWorkspaceRoot } from '../src/workspace/paths.js';
import { createWorkset, saveWorkset } from '../src/workspace/worksets.js';
import type { Workset } from '../src/workspace/types.js';
import {
  hashIntegrationEnvironmentInput,
  projectTestCaseRef,
  type IntegrationEnvironmentInput,
  type IntegrationEnvironmentProfile,
} from '../src/execution/types.js';
import { createTestDirectory } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

test('loads a strict content-addressed profile with all fixed lifecycle steps', async () => {
  const fixture = await createEnvironmentProfileFixture({ driver: 'commands' });

  const profile = await resolveIntegrationEnvironmentProfile(
    fixture.context,
    'authorization-local',
  );

  assert.deepEqual(Object.keys(profile.steps), [
    'setup', 'build', 'start', 'health', 'seed', 'test', 'collect', 'teardown',
  ]);
  assert.equal(profile.contentHash, integrationProfileInputHash(profile));
  assert.equal(profile.schemaVersion, 2);
  assert.deepEqual(profile.requiredProjects, ['order', 'quote']);
  assert.equal(profile.definitionRef, 'integration/environment.json');
});

test('profile resolution requires exact coverage of active Workset projects', async () => {
  for (const requiredProjects of [['order'], ['order', 'quote', 'worker']]) {
    const fixture = await createEnvironmentProfileFixture({ driver: 'commands' });
    const path = fixture.sourceProfilePath('authorization-local');
    const source = YAML.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    await writeFile(path, YAML.stringify({ ...source, requiredProjects }), 'utf8');

    await assert.rejects(
      () => resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local'),
      /INTEGRATION_PROFILE_PROJECT_SCOPE_MISMATCH/,
      requiredProjects.join(','),
    );
  }
});

test('bootstrap rejects project-scope mismatch before writing source or immutable profile truth', async () => {
  const fixture = await createEnvironmentProfileFixture({
    driver: 'commands',
    explicitProfile: false,
    discoveredCommands: 'integration/environment.commands.yaml',
  });
  const discovered = await discoverIntegrationEnvironmentProfiles(fixture.context);
  assert.equal(discovered[0]?.status, 'READY');
  const ready = discovered[0]!;
  if (ready.status !== 'READY') throw new Error('expected READY discovery');
  const mismatched: DiscoveredProfile = {
    ...ready,
    source: { ...ready.source, requiredProjects: ['order'] },
  };

  await assert.rejects(
    () => bootstrapIntegrationEnvironmentProfile(fixture.context, mismatched),
    /INTEGRATION_PROFILE_PROJECT_SCOPE_MISMATCH/,
  );
  await assert.rejects(
    () => readFile(fixture.sourceProfilePath(ready.source.id), 'utf8'),
    /ENOENT/,
  );
});

test('legacy source profile version requires explicit re-resolution instead of reinterpretation', async () => {
  const fixture = await createEnvironmentProfileFixture({ driver: 'commands' });
  const path = fixture.sourceProfilePath('authorization-local');
  const source = YAML.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  await writeFile(path, YAML.stringify({ ...source, schemaVersion: 1 }), 'utf8');

  await assert.rejects(
    () => resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local'),
    /ENVIRONMENT_PROFILE_SOURCE_LEGACY_REQUIRES_RERESOLUTION/,
  );
});

test('concurrent profile snapshot publication converges on one complete immutable file', async () => {
  const fixture = await createEnvironmentProfileFixture({ driver: 'commands' });

  const profiles = await Promise.all(Array.from({ length: 12 }, () =>
    resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local')));

  assert.equal(new Set(profiles.map((profile) => profile.contentHash)).size, 1);
  const profile = profiles[0]!;
  const persisted = YAML.parse(await readFile(integrationEnvironmentProfilePath(
    fixture.context.home,
    fixture.context.worksetId,
    profile.id,
    profile.contentHash,
  ), 'utf8')) as { contentHash?: string };
  assert.equal(persisted.contentHash, profile.contentHash);
});

test('discovers and bootstraps one user-owned Workset profile before plan compilation', async () => {
  const fixture = await createEnvironmentProfileFixture({
    explicitProfile: false,
    discoveredCompose: 'integration/compose.yaml',
  });

  const discovered = await discoverIntegrationEnvironmentProfiles(fixture.context);
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0]!.status, 'READY');
  const profile = await bootstrapIntegrationEnvironmentProfile(fixture.context, discovered[0]!);

  assert.equal(profile.definitionRef, 'integration/compose.yaml');
  assert.deepEqual(profile.ports.range, [1, 65_535]);
  assert.equal(
    fixture.sourceProfilePath(profile.id),
    fixture.worksetPath(`integration/environments/${profile.id}.yaml`),
  );
  const executionCopy = YAML.parse(await readFile(
    integrationEnvironmentProfilePath(
      fixture.context.home,
      fixture.context.worksetId,
      profile.id,
      profile.contentHash,
    ),
    'utf8',
  )) as { contentHash?: string };
  assert.equal(executionCopy.contentHash, profile.contentHash);

  const changed = changedDiscovery(discovered[0]!);
  await assert.rejects(
    () => bootstrapIntegrationEnvironmentProfile(fixture.context, changed),
    /PROFILE_SOURCE_ALREADY_EXISTS/,
  );
});

test('discovers one safe structured Workset command manifest without interpreting shell scripts', async () => {
  const fixture = await createEnvironmentProfileFixture({
    explicitProfile: false,
    discoveredCommands: 'integration/environment.commands.yaml',
  });

  const discovered = await discoverIntegrationEnvironmentProfiles(fixture.context);

  assert.equal(discovered.length, 1);
  assert.equal(discovered[0]?.status, 'READY');
  if (discovered[0]?.status !== 'READY') assert.fail('safe command manifest must be discovered');
  assert.equal(discovered[0].origin, 'COMMANDS');
  assert.equal(discovered[0].source.driver, 'commands');
  assert.equal(discovered[0].source.definitionRef, 'integration/environment.commands.yaml');
  assert.equal('executable' in discovered[0].source.steps.test, true);
});

test('command discovery rejects a structured manifest that invokes a shell launcher', async () => {
  const fixture = await createEnvironmentProfileFixture({
    explicitProfile: false,
    discoveredCommands: 'integration/environment.commands.yaml',
    unsafeDiscoveredCommands: true,
  });

  const discovered = await discoverIntegrationEnvironmentProfiles(fixture.context);

  assert.equal(discovered.length, 1);
  assert.equal(discovered[0]?.status, 'BLOCKED');
  if (discovered[0]?.status !== 'BLOCKED') assert.fail('shell manifest must be blocked');
  assert.equal(discovered[0].code, 'ENVIRONMENT_PROFILE_CHOICE_REQUIRED');
});

test('command discovery rejects inline interpreter code, traversal paths, and absolute response files', async () => {
  for (const unsafeDiscoveredCommands of [
    'inline-code',
    'traversal',
    'equals-traversal',
    'path-sigil',
  ] as const) {
    const fixture = await createEnvironmentProfileFixture({
      explicitProfile: false,
      discoveredCommands: 'integration/environment.commands.yaml',
      unsafeDiscoveredCommands,
    });

    const discovered = await discoverIntegrationEnvironmentProfiles(fixture.context);

    assert.equal(discovered[0]?.status, 'BLOCKED', unsafeDiscoveredCommands);
    if (discovered[0]?.status !== 'BLOCKED') assert.fail(`${unsafeDiscoveredCommands} must block discovery`);
    assert.equal(discovered[0].code, 'ENVIRONMENT_PROFILE_CHOICE_REQUIRED');
  }
});

test('discovers an explicit full-lifecycle package manifest as flattened shell-free argv', async () => {
  const fixture = await createEnvironmentProfileFixture({
    explicitProfile: false,
    discoveredPackageScripts: true,
  });

  const discovered = await discoverIntegrationEnvironmentProfiles(fixture.context);

  assert.equal(discovered[0]?.status, 'READY');
  if (discovered[0]?.status !== 'READY') assert.fail('declared package lifecycle must be discovered');
  assert.equal(discovered[0].origin, 'COMMANDS');
  assert.equal(discovered[0].source.definitionRef, 'package.json');
  assert.deepEqual(discovered[0].source.steps.test, {
    executable: 'node',
    argv: ['test/test.mjs'],
    cwd: 'workspace:.',
    timeoutMs: 120_000,
    outputLimit: 1_048_576,
    network: 'DENY',
    requiredArtifacts: [],
  });
  const profile = await bootstrapIntegrationEnvironmentProfile(fixture.context, discovered[0]);
  const runner = new RecordingArgvRunner();
  const adapter = createCommandsEnvironmentAdapter({
    runner,
    sandbox: new ExecutingSandboxProvider(runner),
  });
  const prepared = await adapter.prepare(await adapterContext(fixture, profile, 'IER-0001'));
  if (prepared.status !== 'READY') assert.fail('package lifecycle profile must prepare');
  await adapter.runStep(prepared, { name: 'test' });
  assert.equal(runner.spawnCalls()[0]?.cwd, fixture.worksetPath(''));
});

test('package lifecycle discovery rejects a referenced script that hides shell or network syntax', async () => {
  const fixture = await createEnvironmentProfileFixture({
    explicitProfile: false,
    discoveredPackageScripts: true,
  });
  const manifest = packageIntegrationManifest();
  manifest.scripts['omnai:integration:test'] = 'sh -c "curl https://example.test"';
  await writeFile(fixture.worksetPath('package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const discovered = await discoverIntegrationEnvironmentProfiles(fixture.context);

  assert.equal(discovered[0]?.status, 'BLOCKED');
  if (discovered[0]?.status !== 'BLOCKED') assert.fail('nested shell package script must block discovery');
  assert.equal(discovered[0].code, 'ENVIRONMENT_PROFILE_CHOICE_REQUIRED');
});

test('package lifecycle discovery rejects a missing argv target below a dangling symlink directory', async () => {
  const fixture = await createEnvironmentProfileFixture({
    explicitProfile: false,
    discoveredPackageScripts: true,
  });
  const outside = join(fixture.context.home, 'missing-outside-test');
  await symlink(outside, fixture.worksetPath('test'));

  const discovered = await discoverIntegrationEnvironmentProfiles(fixture.context);

  assert.equal(discovered[0]?.status, 'BLOCKED');
  if (discovered[0]?.status !== 'BLOCKED') {
    assert.fail('an absent argv child below a dangling symlink directory must block discovery');
  }
});

test('commands runtime recognizes attached output paths below an escaping symlink directory', async () => {
  for (const argument of ['--junitxml=escape/new.xml', '-fescape/pom.xml']) {
    const fixture = await createEnvironmentProfileFixture({ driver: 'commands' });
    const resolved = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
    const command = commandDefinition('pytest', [argument]);
    const { contentHash: _oldContentHash, ...content } = resolved;
    const changed: Omit<IntegrationEnvironmentProfile, 'contentHash'> = {
      ...content,
      steps: {
        setup: command,
        build: command,
        start: command,
        health: command,
        seed: command,
        test: command,
        collect: command,
        teardown: command,
      },
    };
    const profile: IntegrationEnvironmentProfile = {
      ...changed,
      contentHash: integrationProfileInputHash(changed),
    };
    const context = await adapterContext(fixture, profile, 'IER-0001');
    const outside = join(fixture.context.home, 'outside-runtime');
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(context.runRoot, 'escape'));
    const runner = new RecordingArgvRunner();
    const adapter = createCommandsEnvironmentAdapter({
      runner,
      sandbox: new ExecutingSandboxProvider(runner),
    });

    const prepared = await adapter.prepare(context);

    assert.equal(prepared.status, 'BLOCKED', argument);
    if (prepared.status !== 'BLOCKED') assert.fail(`${argument} must not escape through a symlink directory`);
    assert.equal(prepared.code, 'COMMAND_ARGUMENT_OUTSIDE_OWNED_ROOTS');
    assert.deepEqual(runner.spawnCalls(), []);
  }
});

test('commands reject a package definition changed after prepare before sandbox execution', async () => {
  const fixture = await createEnvironmentProfileFixture({
    explicitProfile: false,
    discoveredPackageScripts: true,
  });
  const discovered = await discoverIntegrationEnvironmentProfiles(fixture.context);
  if (discovered[0]?.status !== 'READY') assert.fail('declared package lifecycle must be discovered');
  const profile = await bootstrapIntegrationEnvironmentProfile(fixture.context, discovered[0]);
  const runner = new RecordingArgvRunner();
  const adapter = createCommandsEnvironmentAdapter({
    runner,
    sandbox: new ExecutingSandboxProvider(runner),
  });
  const prepared = await adapter.prepare(await adapterContext(fixture, profile, 'IER-0001'));
  if (prepared.status !== 'READY') assert.fail('frozen package profile must prepare');
  const changed = packageIntegrationManifest();
  changed.scripts['omnai:integration:test'] = 'node test/changed-after-freeze.mjs';
  await writeFile(fixture.worksetPath('package.json'), `${JSON.stringify(changed, null, 2)}\n`, 'utf8');

  await assert.rejects(
    () => adapter.runStep(prepared, { name: 'test' }),
    /COMMAND_DEFINITION_DIGEST_MISMATCH/,
  );
  assert.deepEqual(runner.spawnCalls(), []);
});

test('commands bind required artifact bytes into each authoritative sandbox execution', async () => {
  const artifactRef = 'integration/required.lock';
  const fixture = await createEnvironmentProfileFixture({
    driver: 'commands',
    command: {
      ...commandDefinition('node', ['test/integration.mjs']),
      requiredArtifacts: [artifactRef],
    },
  });
  await writeFile(fixture.worksetPath(artifactRef), 'frozen-artifact\n', 'utf8');
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const runner = new RecordingArgvRunner();
  const adapter = createCommandsEnvironmentAdapter({
    runner,
    sandbox: new ExecutingSandboxProvider(runner),
  });
  const prepared = await adapter.prepare(await adapterContext(fixture, profile, 'IER-0001'));
  if (prepared.status !== 'READY') assert.fail('artifact-bound command must prepare');
  await writeFile(fixture.worksetPath(artifactRef), 'changed-artifact\n', 'utf8');

  await assert.rejects(
    () => adapter.runStep(prepared, { name: 'test' }),
    /COMMAND_REQUIRED_ARTIFACT_DIGEST_MISMATCH/,
  );
  assert.deepEqual(runner.spawnCalls(), []);
});

test('compose adapter registry prepares without allocation and setup isolates concurrent runs', async () => {
  const fixture = await createEnvironmentProfileFixture({ driver: 'compose' });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const runtime = new RecordingComposeRuntime();
  const adapter = createComposeEnvironmentAdapter({
    workspaceRoot: fixture.worksetPath(''),
    runtime,
  });
  const registry = new EnvironmentAdapterRegistry([adapter]);
  assert.equal(registry.forProfile(profile), adapter);

  const [leftPrepared, rightPrepared] = await Promise.all([
    adapter.prepare(await adapterContext(fixture, profile, 'IER-0001')),
    adapter.prepare(await adapterContext(fixture, profile, 'IER-0002')),
  ]);
  assert.deepEqual(runtime.resources(), []);
  assert.equal(leftPrepared.status, 'READY');
  assert.equal(rightPrepared.status, 'READY');
  if (leftPrepared.status !== 'READY' || rightPrepared.status !== 'READY') {
    assert.fail('safe Compose profiles must prepare authoritatively');
  }

  const [left, right] = await Promise.all([
    adapter.runStep(leftPrepared, { name: 'setup' }),
    adapter.runStep(rightPrepared, { name: 'setup' }),
  ]);
  assert.notEqual(left.resource?.composeProjectName, right.resource?.composeProjectName);
  assert.equal(disjoint(left.resource?.reservedPorts ?? [], right.resource?.reservedPorts ?? []), true);
  assert.equal(left.resource?.labels['omnai.environmentRunId'], 'IER-0001');
  assert.notEqual(left.resource?.networkNames[0], right.resource?.networkNames[0]);
  assert.notEqual(left.resource?.volumeNames[0], right.resource?.volumeNames[0]);
});

test('environment maxParallel is enforced by durable allocation claims across run IDs', async () => {
  const fixture = await createEnvironmentProfileFixture({ driver: 'compose', maxParallel: 1 });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const runtime = new RecordingComposeRuntime();
  const adapter = createComposeEnvironmentAdapter({
    workspaceRoot: fixture.worksetPath(''),
    runtime,
  });
  const leftContext = await adapterContext(fixture, profile, 'IER-0001');
  const rightContext = await adapterContext(fixture, profile, 'IER-0002');
  const left = await adapter.prepare(leftContext);
  const right = await adapter.prepare(rightContext);
  if (left.status !== 'READY' || right.status !== 'READY') assert.fail('parallel fixtures must prepare');
  await adapter.runStep(left, { name: 'setup' });

  await assert.rejects(
    () => adapter.runStep(right, { name: 'setup' }),
    /ENVIRONMENT_MAX_PARALLEL_REACHED/,
  );
  await adapter.release(leftContext);
  await adapter.runStep(right, { name: 'setup' });
});

test('compose late normalization denial happens before the durable allocation claim', async () => {
  const fixture = await createEnvironmentProfileFixture({ driver: 'compose', maxParallel: 1 });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const runtime = new RecordingComposeRuntime('late-deny');
  const adapter = createComposeEnvironmentAdapter({ workspaceRoot: fixture.worksetPath(''), runtime });
  const left = await adapter.prepare(await adapterContext(fixture, profile, 'IER-0001'));
  const right = await adapter.prepare(await adapterContext(fixture, profile, 'IER-0002'));
  if (left.status !== 'READY' || right.status !== 'READY') assert.fail('late-deny fixtures must prepare');

  await assert.rejects(
    () => adapter.runStep(left, { name: 'setup' }),
    /COMPOSE_EFFECTIVE_CONFIG_DENIED: LATE_INTERPOLATION/,
  );
  const result = await adapter.runStep(right, { name: 'setup' });

  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.resource?.ownerRunId, 'IER-0002');
});

test('compose setup rejects inspected ports outside the profile allocation range', async () => {
  const fixture = await createEnvironmentProfileFixture({ driver: 'compose' });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const runtime = new RecordingComposeRuntime(undefined, 30_000);
  const adapter = createComposeEnvironmentAdapter({
    workspaceRoot: fixture.worksetPath(''),
    runtime,
  });
  const prepared = await adapter.prepare(await adapterContext(fixture, profile, 'IER-0001'));
  assert.equal(prepared.status, 'READY');
  if (prepared.status !== 'READY') assert.fail('port fixture must prepare');

  await assert.rejects(
    () => adapter.runStep(prepared, { name: 'setup' }),
    /COMPOSE_PORT_OUTSIDE_PROFILE_RANGE/,
  );
});

test('compose rejects unsupported inherited port publication instead of rewriting it to dynamic', async () => {
  const fixture = await createEnvironmentProfileFixture({ driver: 'compose', portMode: 'inherited' });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const runtime = new RecordingComposeRuntime('published-port');
  const adapter = createComposeEnvironmentAdapter({ workspaceRoot: fixture.worksetPath(''), runtime });

  const prepared = await adapter.prepare(await adapterContext(fixture, profile, 'IER-0001'));

  assert.equal(prepared.status, 'BLOCKED');
  if (prepared.status !== 'BLOCKED') assert.fail('unsupported inherited ports must block');
  assert.equal(prepared.code, 'COMPOSE_PORT_MODE_UNSUPPORTED');
  assert.deepEqual(runtime.resources(), []);
});

test('compose adapter resolves secret references only for the side-effecting runtime call', async () => {
  const secret = 'compose-spawn-only';
  const fixture = await createEnvironmentProfileFixture({ driver: 'compose' });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const runtime = new RecordingComposeRuntime();
  const adapter = createComposeEnvironmentAdapter({
    workspaceRoot: fixture.worksetPath(''),
    runtime,
  });
  let resolutions = 0;
  const context = {
    ...await adapterContext(fixture, profile, 'IER-0001'),
    sourceEnvironment: () => {
      resolutions += 1;
      return { OMNAI_TEST_DB_PASSWORD: secret };
    },
  };

  const prepared = await adapter.prepare(context);
  assert.equal(prepared.status, 'READY');
  assert.equal(resolutions, 0);
  assert.equal(JSON.stringify(prepared).includes(secret), false);
  if (prepared.status !== 'READY') assert.fail('compose secret fixture must prepare');
  await adapter.runStep(prepared, { name: 'setup' });

  assert.equal(resolutions, 1);
  assert.equal(runtime.setupEnvironment().TEST_DB_PASSWORD, secret);
});

test('production Compose accepts declared secret interpolation without resolving it during prepare', async () => {
  const fixture = await createEnvironmentProfileFixture({
    driver: 'compose',
    discoveredCompose: 'integration/compose.yaml',
    composeSecretInterpolation: true,
  });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const runner = new SequencedArgvRunner([]);
  const runtime = createProductionComposeRuntime({
    runner,
    executorIdentity: {
      ref: composeExecutorDigestRef(),
      executablePath: '/test/bin/docker',
      executableDigest: hashObject('compose-engine'),
    },
  });
  const adapter = createComposeEnvironmentAdapter({ workspaceRoot: fixture.worksetPath(''), runtime });

  const prepared = await adapter.prepare(await adapterContext(fixture, profile, 'IER-0001'));

  assert.equal(prepared.status, 'READY');
  assert.equal(JSON.stringify(prepared).includes('fixture-secret'), false);
  assert.equal(runner.requests.length, 0);
});

test('production Compose validates a resolved secret only through declared interpolation provenance', async () => {
  const secret = 'compose-runtime-secret';
  const fixture = await createEnvironmentProfileFixture({
    driver: 'compose',
    discoveredCompose: 'integration/compose.yaml',
    composeSecretInterpolation: true,
  });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const context = await adapterContext(fixture, profile, 'IER-0001');
  const labels = {
    'omnai.owner': 'omnai',
    'omnai.worksetId': fixture.context.worksetId,
    'omnai.environmentRunId': 'IER-0001',
    'omnai.profileContentHash': profile.contentHash,
    'omnai.integrationInputHash': context.integrationInput.inputHash,
  };
  const resource: ComposeRuntimeResource = {
    driver: 'compose',
    ownerRunId: 'IER-0001',
    composeProjectName: 'omnai-secret-provenance',
    resourceRefs: ['compose-project:omnai-secret-provenance'],
    reservedPorts: [],
    labels,
    networkNames: ['omnai-secret-provenance-network'],
    volumeNames: [],
    containerNames: ['omnai-secret-provenance-order', 'omnai-secret-provenance-quote'],
  };
  const normalized = {
    services: {
      order: {
        image: `example/order@sha256:${'a'.repeat(64)}`,
        labels,
        environment: { TEST_DB_PASSWORD: secret },
      },
      quote: { image: `example/quote@sha256:${'b'.repeat(64)}`, labels },
    },
  };
  const runner = new SequencedArgvRunner([JSON.stringify(normalized)]);
  const runtime = createProductionComposeRuntime({
    runner,
    executorIdentity: {
      ref: composeExecutorDigestRef(),
      executablePath: '/test/bin/docker',
      executableDigest: hashObject('compose-engine'),
    },
  });
  const definitionPath = fixture.worksetPath('integration/compose.yaml');
  const effectiveConfig = await runtime.effectiveConfig({
    definitionPath,
    projectName: resource.composeProjectName,
    labels,
    resource,
  });

  const validation = await runtime.validateSetup({
    definitionPath,
    projectName: resource.composeProjectName,
    labels,
    resource,
    runRoot: context.runRoot,
    workspaceRoot: context.workspaceRoot,
    sourceRoots: context.sourceRoots,
    profile,
    environment: { TEST_DB_PASSWORD: secret },
    effectiveConfig,
  });

  assert.equal(validation.normalizedConfigDigest.startsWith('sha256:'), true);
  assert.equal(JSON.stringify(validation).includes(secret), false);
});

test('dangerous effective Compose configuration is denied before allocation', async () => {
  const dangerousCases: readonly DangerousComposeCase[] = [
    'privileged',
    'host-network',
    'host-pid',
    'host-ipc',
    'docker-socket',
    'host-root-bind',
    'device',
    'cap-add',
    'floating-image',
    'escaping-build-context',
    'relative-long-bind-escape',
    'literal-secret',
  ];
  for (const dangerous of dangerousCases) {
    const fixture = await createEnvironmentProfileFixture({ driver: 'compose' });
    const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
    const runtime = new RecordingComposeRuntime(dangerous);
    const adapter = createComposeEnvironmentAdapter({
      workspaceRoot: fixture.worksetPath(''),
      runtime,
    });

    const result = await adapter.probe(profile);

    assert.equal(result.authoritative, false, dangerous);
    assert.equal(result.code, 'COMPOSE_EFFECTIVE_CONFIG_DENIED', dangerous);
    assert.deepEqual(runtime.resources(), [], dangerous);
  }
});

test('compose adapter rejects a build-context symlink that escapes the declared source root', async () => {
  const fixture = await createEnvironmentProfileFixture({ driver: 'compose' });
  const outside = fixture.worksetPath('../outside-build');
  await mkdir(outside, { recursive: true });
  await symlink(outside, fixture.worksetPath('order/escaped'), 'dir');
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const runtime = new RecordingComposeRuntime('symlink-build-context');
  const adapter = createComposeEnvironmentAdapter({
    workspaceRoot: fixture.worksetPath(''),
    runtime,
  });

  const prepared = await adapter.prepare(await adapterContext(fixture, profile, 'IER-0001'));

  assert.equal(prepared.status, 'BLOCKED');
  if (prepared.status !== 'BLOCKED') assert.fail('symlink escape must be blocked');
  assert.equal(prepared.code, 'COMPOSE_EFFECTIVE_CONFIG_DENIED');
  assert.match(prepared.reason, /BUILD_CONTEXT_ESCAPE/);
  assert.deepEqual(runtime.resources(), []);
});

test('compose adapter resolves relative bind mounts against the definition and rejects escapes', async () => {
  const fixture = await createEnvironmentProfileFixture({ driver: 'compose' });
  await mkdir(fixture.worksetPath('../outside-bind'), { recursive: true });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const runtime = new RecordingComposeRuntime('relative-bind-escape');
  const adapter = createComposeEnvironmentAdapter({
    workspaceRoot: fixture.worksetPath(''),
    runtime,
  });

  const prepared = await adapter.prepare(await adapterContext(fixture, profile, 'IER-0001'));

  assert.equal(prepared.status, 'BLOCKED');
  if (prepared.status !== 'BLOCKED') assert.fail('relative bind escape must be blocked');
  assert.equal(prepared.code, 'COMPOSE_EFFECTIVE_CONFIG_DENIED');
  assert.match(prepared.reason, /HOST_BIND_OUTSIDE_RUN_ROOT/);
  assert.deepEqual(runtime.resources(), []);
});

test('compose command references are resolved during prepare or blocked before allocation', async () => {
  const fixture = await createEnvironmentProfileFixture({
    explicitProfile: false,
    discoveredCompose: 'integration/compose.yaml',
  });
  const [discovery] = await discoverIntegrationEnvironmentProfiles(fixture.context);
  if (discovery === undefined || discovery.status !== 'READY') assert.fail('compose discovery required');
  const profile = await bootstrapIntegrationEnvironmentProfile(fixture.context, discovery);
  const context = await adapterContext(fixture, profile, 'IER-0001');
  const blockedRuntime = new RecordingComposeRuntime();
  const blockedAdapter = createComposeEnvironmentAdapter({
    workspaceRoot: fixture.worksetPath(''),
    runtime: blockedRuntime,
  });

  const blocked = await blockedAdapter.prepare(context);
  assert.equal(blocked.status, 'BLOCKED');
  if (blocked.status !== 'BLOCKED') assert.fail('unresolved refs must block prepare');
  assert.equal(blocked.code, 'COMPOSE_STEP_COMMAND_REFERENCE_UNRESOLVED');
  assert.deepEqual(blockedRuntime.resources(), []);

  const runtime = new RecordingComposeRuntime();
  const adapter = createComposeEnvironmentAdapter({
    workspaceRoot: fixture.worksetPath(''),
    runtime,
    resolveCommand: async (commandRef) => commandDefinition('node', [commandRef]),
  });
  const prepared = await adapter.prepare(context);
  assert.equal(prepared.status, 'READY');
  if (prepared.status !== 'READY') assert.fail('resolved refs must prepare');
  await adapter.runStep(prepared, { name: 'setup' });
  await adapter.runStep(prepared, { name: 'seed' });
  assert.deepEqual(runtime.stepDefinitions().at(-1), commandDefinition('node', ['environment.seed']));
});

test('compose adapter rejects an engine executable digest outside the frozen input', async () => {
  const fixture = await createEnvironmentProfileFixture({ driver: 'compose' });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const runtime = new RecordingComposeRuntime(undefined, 24_000, hashObject('different-compose-engine'));
  const adapter = createComposeEnvironmentAdapter({
    workspaceRoot: fixture.worksetPath(''),
    runtime,
  });

  const prepared = await adapter.prepare(await adapterContext(fixture, profile, 'IER-0001'));

  assert.equal(prepared.status, 'BLOCKED');
  if (prepared.status !== 'BLOCKED') assert.fail('unfrozen Compose executor must block prepare');
  assert.equal(prepared.code, 'COMPOSE_EXECUTOR_DIGEST_MISMATCH');
  assert.deepEqual(runtime.resources(), []);
});

test('production Compose rejects a raw runner without OS-enforced process containment', async () => {
  const fixture = await createEnvironmentProfileFixture({
    driver: 'compose',
    discoveredCompose: 'integration/compose.yaml',
  });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const runtime = createProductionComposeRuntime({
    runner: createArgvProcessTreeRunner(),
    executorIdentity: {
      ref: composeExecutorDigestRef(),
      executablePath: '/test/bin/docker',
      executableDigest: hashObject('compose-engine'),
    },
  });
  const adapter = createComposeEnvironmentAdapter({ workspaceRoot: fixture.worksetPath(''), runtime });

  const prepared = await adapter.prepare(await adapterContext(fixture, profile, 'IER-0001'));

  assert.equal(prepared.status, 'BLOCKED');
  if (prepared.status !== 'BLOCKED') assert.fail('raw process-group runner cannot be authoritative');
  assert.equal(prepared.code, 'COMPOSE_PROCESS_CONTAINER_UNPROVEN');
});

test('compose setup rejects a definition changed after prepare before allocation', async () => {
  const fixture = await createEnvironmentProfileFixture({ driver: 'compose' });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const runtime = new RecordingComposeRuntime();
  const adapter = createComposeEnvironmentAdapter({ workspaceRoot: fixture.worksetPath(''), runtime });
  const prepared = await adapter.prepare(await adapterContext(fixture, profile, 'IER-0001'));
  if (prepared.status !== 'READY') assert.fail('frozen Compose definition must prepare');
  await writeFile(fixture.worksetPath(profile.definitionRef), '{"services":["changed"]}\n', 'utf8');

  await assert.rejects(
    () => adapter.runStep(prepared, { name: 'setup' }),
    /COMPOSE_DEFINITION_DIGEST_MISMATCH/,
  );
  assert.deepEqual(runtime.resources(), []);
});

test('compose steps reject a definition changed after setup before engine invocation', async () => {
  const fixture = await createEnvironmentProfileFixture({ driver: 'compose' });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const runtime = new RecordingComposeRuntime();
  const adapter = createComposeEnvironmentAdapter({ workspaceRoot: fixture.worksetPath(''), runtime });
  const prepared = await adapter.prepare(await adapterContext(fixture, profile, 'IER-0001'));
  if (prepared.status !== 'READY') assert.fail('frozen Compose definition must prepare');
  await adapter.runStep(prepared, { name: 'setup' });
  await writeFile(fixture.worksetPath(profile.definitionRef), '{"services":["changed"]}\n', 'utf8');

  await assert.rejects(
    () => adapter.runStep(prepared, { name: 'start' }),
    /COMPOSE_DEFINITION_DIGEST_MISMATCH/,
  );
  assert.equal(runtime.stepDefinitions().length, 0);
});

test('compose build rehashes every context immediately before invoking the runtime', async () => {
  const fixture = await createEnvironmentProfileFixture({ driver: 'compose' });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const orderRoot = fixture.worksetPath('order');
  await writeFile(join(orderRoot, 'Dockerfile'), 'FROM scratch\n', 'utf8');
  const runtime = new RecordingComposeRuntime('safe-build');
  const adapter = createComposeEnvironmentAdapter({
    workspaceRoot: fixture.worksetPath(''),
    runtime,
  });
  const base = await adapterContext(fixture, profile, 'IER-0001');
  const input = withSupportingDigests(base.integrationInput, [
    { ref: composeBuildContextDigestRef('order'), digest: await hashComposeBuildContext(orderRoot) },
    { ref: composeImageDigestRef('order'), digest: hashObject('built-image:order') },
  ]);
  const prepared = await adapter.prepare({ ...base, integrationInput: input });
  assert.equal(prepared.status, 'READY');
  if (prepared.status !== 'READY') assert.fail('frozen build context must prepare');
  await adapter.runStep(prepared, { name: 'setup' });
  await writeFile(join(orderRoot, 'changed-after-prepare.txt'), 'mutation\n', 'utf8');

  await assert.rejects(
    () => adapter.runStep(prepared, { name: 'build' }),
    /COMPOSE_BUILD_CONTEXT_DIGEST_MISMATCH/,
  );
  assert.equal(runtime.buildCalls(), 0);
});

test('compose build compares produced immutable image digests with the frozen tuple', async () => {
  const fixture = await createEnvironmentProfileFixture({ driver: 'compose' });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const orderRoot = fixture.worksetPath('order');
  await writeFile(join(orderRoot, 'Dockerfile'), 'FROM scratch\n', 'utf8');
  const runtime = new RecordingComposeRuntime('safe-build', 24_000, undefined, hashObject('wrong-built-image'));
  const adapter = createComposeEnvironmentAdapter({
    workspaceRoot: fixture.worksetPath(''),
    runtime,
  });
  const base = await adapterContext(fixture, profile, 'IER-0001');
  const input = withSupportingDigests(base.integrationInput, [
    { ref: composeBuildContextDigestRef('order'), digest: await hashComposeBuildContext(orderRoot) },
    { ref: composeImageDigestRef('order'), digest: hashObject('built-image:order') },
  ]);
  const prepared = await adapter.prepare({ ...base, integrationInput: input });
  assert.equal(prepared.status, 'READY');
  if (prepared.status !== 'READY') assert.fail('frozen build identity must prepare');
  await adapter.runStep(prepared, { name: 'setup' });

  await assert.rejects(
    () => adapter.runStep(prepared, { name: 'build' }),
    /COMPOSE_IMAGE_DIGEST_MISMATCH/,
  );
});

test('compose build returns normalized config, context, executor, and image identity evidence', async () => {
  const fixture = await createEnvironmentProfileFixture({ driver: 'compose' });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const orderRoot = fixture.worksetPath('order');
  await writeFile(join(orderRoot, 'Dockerfile'), 'FROM scratch\n', 'utf8');
  const runtime = new RecordingComposeRuntime('safe-build');
  const adapter = createComposeEnvironmentAdapter({ workspaceRoot: fixture.worksetPath(''), runtime });
  const base = await adapterContext(fixture, profile, 'IER-0001');
  const buildContextDigest = await hashComposeBuildContext(orderRoot);
  const imageDigest = hashObject('built-image:order');
  const prepared = await adapter.prepare({
    ...base,
    integrationInput: withSupportingDigests(base.integrationInput, [
      { ref: composeBuildContextDigestRef('order'), digest: buildContextDigest },
      { ref: composeImageDigestRef('order'), digest: imageDigest },
    ]),
  });
  assert.equal(prepared.status, 'READY');
  if (prepared.status !== 'READY') assert.fail('frozen Compose identities must prepare');
  await adapter.runStep(prepared, { name: 'setup' });

  const result = await adapter.runStep(prepared, { name: 'build' });

  assert.equal(result.composeIdentity?.executorDigest, hashObject('compose-engine'));
  assert.equal(result.composeIdentity?.normalizedConfigDigest.startsWith('sha256:'), true);
  assert.deepEqual(result.composeIdentity?.buildContextDigests, [
    { ref: composeBuildContextDigestRef('order'), digest: buildContextDigest },
  ]);
  assert.deepEqual(result.composeIdentity?.imageDigests, [
    { ref: composeImageDigestRef('order'), digest: imageDigest },
  ]);
});

test('commands adapter executes declared argv in the run root without a shell', async () => {
  const fixture = await createEnvironmentProfileFixture({
    driver: 'commands',
    command: commandDefinition('node', ['test/build.mjs']),
  });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const runner = new RecordingArgvRunner();
  const adapter = createCommandsEnvironmentAdapter({
    runner,
    sandbox: new ExecutingSandboxProvider(runner),
  });
  const context = await adapterContext(fixture, profile, 'IER-0001');
  const prepared = await adapter.prepare(context);
  assert.equal(prepared.status, 'READY');
  if (prepared.status !== 'READY') assert.fail('proven command profile must prepare');

  const result = await adapter.runStep(prepared, { name: 'build' });

  assert.deepEqual(runner.spawnCalls()[0], {
    executable: 'node',
    argv: ['test/build.mjs'],
    shell: false,
    cwd: context.runRoot,
  });
  assert.equal(result.executionIdentity?.kind, 'SANDBOX');
  assert.equal(result.executionIdentity?.bindingHash.startsWith('sha256:'), true);
  assert.equal(result.executionIdentity?.executablePath, '/sandbox/bin/node');
  assert.equal(result.executionIdentity?.executableDigest.startsWith('sha256:'), true);
  assert.equal(result.executionIdentity?.processContainer.kind, 'SANDBOX_SERVICE');
});

test('authoritative commands reject sandbox execution without an OS-enforced process container', async () => {
  const fixture = await createEnvironmentProfileFixture({ driver: 'commands' });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const runner = new RecordingArgvRunner();
  const adapter = createCommandsEnvironmentAdapter({
    runner,
    sandbox: new ExecutingSandboxProvider(runner, true),
  });
  const prepared = await adapter.prepare(await adapterContext(fixture, profile, 'IER-0001'));
  if (prepared.status !== 'READY') assert.fail('containment fixture must prepare');

  await assert.rejects(
    () => adapter.runStep(prepared, { name: 'test' }),
    /SANDBOX_PROCESS_CONTAINER_UNPROVEN/,
  );
});

test('commands adapter rejects a frozen input bound to a different profile before execution', async () => {
  const fixture = await createEnvironmentProfileFixture({ driver: 'commands' });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const runner = new RecordingArgvRunner();
  const adapter = createCommandsEnvironmentAdapter({
    runner,
    sandbox: new ExecutingSandboxProvider(runner),
  });
  const context = await adapterContext(fixture, profile, 'IER-0001');
  const mismatchedInput = rehashIntegrationInput({
    ...context.integrationInput,
    profile: { ...context.integrationInput.profile, contentHash: hashObject('different-profile') },
  });

  const prepared = await adapter.prepare({ ...context, integrationInput: mismatchedInput });

  assert.equal(prepared.status, 'BLOCKED');
  if (prepared.status !== 'BLOCKED') assert.fail('mismatched frozen input must block prepare');
  assert.equal(prepared.code, 'ENVIRONMENT_CONTEXT_PROFILE_MISMATCH');
  assert.deepEqual(runner.spawnCalls(), []);
});

test('shared adapter boundary rejects definition, project, and environment-reference mismatches', async () => {
  const fixture = await createEnvironmentProfileFixture({ driver: 'commands' });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const context = await adapterContext(fixture, profile, 'IER-0001');
  const mutations = [
    {
      code: /ENVIRONMENT_CONTEXT_DEFINITION_DIGEST_MISMATCH/,
      input: { ...context.integrationInput, definitionDigest: hashObject('different-definition') },
    },
    {
      code: /ENVIRONMENT_CONTEXT_PROJECTS_MISMATCH/,
      input: { ...context.integrationInput, projects: context.integrationInput.projects.slice(0, 1) },
    },
    {
      code: /ENVIRONMENT_CONTEXT_ENVIRONMENT_REFERENCES_MISMATCH/,
      input: { ...context.integrationInput, environmentReferenceNames: ['OMNAI_OTHER_SECRET'] },
    },
  ];

  for (const mutation of mutations) {
    assert.throws(
      () => validateEnvironmentAdapterContext({
        ...context,
        integrationInput: rehashIntegrationInput(mutation.input as IntegrationEnvironmentInput),
      }, 'commands'),
      mutation.code,
    );
  }
});

test('commands adapter compares the sandbox executable digest with the frozen step mapping', async () => {
  const fixture = await createEnvironmentProfileFixture({
    driver: 'commands',
    command: commandDefinition('node', ['test/build.mjs']),
  });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const runner = new RecordingArgvRunner();
  const adapter = createCommandsEnvironmentAdapter({
    runner,
    sandbox: new ExecutingSandboxProvider(runner),
  });
  const context = await adapterContext(fixture, profile, 'IER-0001');
  const executorDigests = context.integrationInput.executorDigests.map((identity) =>
    identity.ref === commandExecutorDigestRef('build', 'node')
      ? { ...identity, digest: hashObject('different-executable') }
      : identity);
  const prepared = await adapter.prepare({
    ...context,
    integrationInput: rehashIntegrationInput({ ...context.integrationInput, executorDigests }),
  });
  assert.equal(prepared.status, 'READY');
  if (prepared.status !== 'READY') assert.fail('well-formed frozen mapping must prepare');

  await assert.rejects(
    () => adapter.runStep(prepared, { name: 'build' }),
    /SANDBOX_EXECUTOR_DIGEST_MISMATCH/,
  );
});

test('proof-only command sandbox cannot authorize execution through the raw runner', async () => {
  const fixture = await createEnvironmentProfileFixture({
    driver: 'commands',
    command: commandDefinition('node', ['test/integration.mjs']),
  });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const runner = new RecordingArgvRunner();
  const adapter = createCommandsEnvironmentAdapter({
    runner,
    sandbox: new StaticSandboxProvider('PROVEN'),
  });

  const probe = await adapter.probe(profile);
  assert.equal(probe.authoritative, false);
  assert.equal(probe.mode, 'DIAGNOSTIC_ONLY');
  const prepared = await adapter.prepare(await adapterContext(fixture, profile, 'IER-0001'));
  assert.equal(prepared.status, 'READY');
  if (prepared.status !== 'READY') assert.fail('proof-only profile must remain diagnostic');
  await assert.rejects(
    () => adapter.runStep(prepared, { name: 'test' }),
    /SANDBOX_EXECUTION_UNAVAILABLE/,
  );
  assert.deepEqual(runner.spawnCalls(), []);
});

test('commands adapter rejects a writable run root nested inside the source workspace', async () => {
  const fixture = await createEnvironmentProfileFixture({ driver: 'commands' });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const runner = new RecordingArgvRunner();
  const adapter = createCommandsEnvironmentAdapter({
    runner,
    sandbox: new ExecutingSandboxProvider(runner),
  });
  const base = await adapterContext(fixture, profile, 'IER-0001');
  const nestedRunRoot = fixture.worksetPath('integration/run-root');
  await mkdir(nestedRunRoot, { recursive: true });

  const prepared = await adapter.prepare({ ...base, runRoot: nestedRunRoot });

  assert.equal(prepared.status, 'BLOCKED');
  if (prepared.status !== 'BLOCKED') assert.fail('nested run root must be blocked');
  assert.equal(prepared.code, 'COMMAND_RUN_ROOT_INSIDE_WORKSPACE');
});

test('commands adapter rejects an explicit shell launcher even when argv is structured', async () => {
  const fixture = await createEnvironmentProfileFixture({
    driver: 'commands',
    command: commandDefinition('sh', ['-c', 'npm test']),
  });
  await assert.rejects(
    () => resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local'),
    /SHELL_LAUNCHER_FORBIDDEN/,
  );
});

test('diagnostic network-denied command cannot fall through to the raw runner', async () => {
  const fixture = await createEnvironmentProfileFixture({
    driver: 'commands',
    command: commandDefinition('node', ['test/integration.mjs']),
  });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const runner = new RecordingArgvRunner();
  const adapter = createCommandsEnvironmentAdapter({
    runner,
    sandbox: new StaticSandboxProvider('UNPROVEN'),
  });
  const probe = await adapter.probe(profile);
  assert.equal(probe.authoritative, false);
  assert.equal(probe.mode, 'DIAGNOSTIC_ONLY');
  const context = {
    ...await adapterContext(fixture, profile, 'IER-0001'),
    requestedMode: 'DIAGNOSTIC_ONLY' as const,
  };
  const prepared = await adapter.prepare(context);
  assert.equal(prepared.status, 'READY');
  if (prepared.status !== 'READY') assert.fail('diagnostic command profile must still prepare');

  await assert.rejects(
    () => adapter.runStep(prepared, { name: 'test' }),
    /COMMAND_NETWORK_DENY_UNENFORCED/,
  );
  assert.deepEqual(runner.spawnCalls(), []);
});

test('network-denied command adds NETWORK to the effective sandbox proofs before allocation', async () => {
  const fixture = await createEnvironmentProfileFixture({ driver: 'commands' });
  const sourcePath = fixture.sourceProfilePath('authorization-local');
  const source = YAML.parse(await readFile(sourcePath, 'utf8')) as Record<string, unknown>;
  await writeFile(sourcePath, YAML.stringify({
    ...source,
    sandbox: { driver: 'platform', requiredProofs: ['PROCESS_TREE'] },
  }), 'utf8');
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const runner = new RecordingArgvRunner();
  const adapter = createCommandsEnvironmentAdapter({
    runner,
    sandbox: new ExecutingSandboxProvider(runner, false, ['PROCESS_TREE']),
  });
  const context = await adapterContext(fixture, profile, 'IER-0001');
  const prepared = await adapter.prepare(context);
  assert.equal(prepared.status, 'READY');
  if (prepared.status !== 'READY') assert.fail('missing NETWORK proof is a non-authoritative ready profile');
  assert.equal(prepared.probe.authoritative, false);

  await assert.rejects(
    () => adapter.runStep(prepared, { name: 'setup' }),
    /SANDBOX_ISOLATION_UNPROVEN/,
  );
  assert.deepEqual(runner.spawnCalls(), []);
  await assert.rejects(
    () => readFile(join(context.runRoot, '..', 'allocations', 'IER-0001.json'), 'utf8'),
    /ENOENT/,
  );
});

test('raw argv runner fails closed on network DENY before spawning', async () => {
  const sandbox = await createTestDirectory('omnai-network-deny-');
  cleanups.push(sandbox.cleanup);
  const marker = join(sandbox.root, 'spawned.txt');
  const runner = createArgvProcessTreeRunner();

  await assert.rejects(
    () => runner.run({
      executable: process.execPath,
      argv: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
      shell: false,
      cwd: sandbox.root,
      environment: {},
      timeoutMs: 1_000,
      outputLimit: 1_024,
      network: 'DENY',
      ownerRunId: 'IER-0001',
      sandboxProofId: undefined,
    }),
    /ARGV_RUNNER_NETWORK_DENY_UNENFORCED/,
  );
  await assert.rejects(() => readFile(marker, 'utf8'), /ENOENT/);
});

test('AbortSignal terminates the complete owned process tree without signalling an unowned process', async () => {
  const sandbox = await createTestDirectory('omnai-process-tree-');
  cleanups.push(sandbox.cleanup);
  const pidPath = join(sandbox.root, 'owned-pids.txt');
  const runner = createArgvProcessTreeRunner({ terminationGraceMs: 50 });
  const unowned = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  assert.notEqual(unowned.pid, undefined);
  const unownedPid = unowned.pid!;
  const unownedExit = new Promise<void>((resolve) => unowned.once('exit', () => resolve()));
  const controller = new AbortController();
  try {
    const running = runner.run({
      executable: process.execPath,
      argv: ['-e', ownedProcessTreeScript(pidPath)],
      shell: false,
      cwd: sandbox.root,
      environment: {},
      timeoutMs: 10_000,
      outputLimit: 65_536,
      network: 'ALLOW',
      ownerRunId: 'IER-0001',
      sandboxProofId: 'sandbox-proof-1',
    }, controller.signal);
    const ownedPids = await waitForProcessIds(pidPath, 3);

    controller.abort();

    await assert.rejects(running, (error: unknown) => {
      assert.equal(error instanceof Error && error.name, 'AbortError');
      return true;
    });
    await waitForCondition(() => ownedPids.every((pid) => !processIsLive(pid)));
    assert.equal(processIsLive(unownedPid), true);
  } finally {
    if (processIsLive(unownedPid)) process.kill(unownedPid, 'SIGKILL');
    await unownedExit;
  }
});

test('argv runner rejects a missing executable without emitting an uncaught child error', async () => {
  const sandbox = await createTestDirectory('omnai-missing-executable-');
  cleanups.push(sandbox.cleanup);
  const runner = createArgvProcessTreeRunner({ terminationGraceMs: 10 });

  await assert.rejects(
    () => runner.run({
      executable: join(sandbox.root, 'does-not-exist'),
      argv: [],
      shell: false,
      cwd: sandbox.root,
      environment: {},
      timeoutMs: 1_000,
      outputLimit: 1_024,
      network: 'ALLOW',
      ownerRunId: 'IER-0001',
      sandboxProofId: undefined,
    }),
    /ENOENT/,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test('argv runner waits for pipe close so exit-time output is complete evidence', async () => {
  const sandbox = await createTestDirectory('omnai-process-output-close-');
  cleanups.push(sandbox.cleanup);
  const runner = createArgvProcessTreeRunner({ terminationGraceMs: 10 });

  const result = await runner.run({
    executable: process.execPath,
    argv: ['-e', "process.stdout.write('prefix'); process.on('exit', () => require('fs').writeSync(1, '-tail'))"],
    shell: false,
    cwd: sandbox.root,
    environment: {},
    timeoutMs: 1_000,
    outputLimit: 1_024,
    network: 'ALLOW',
    ownerRunId: 'IER-0001',
    sandboxProofId: undefined,
  });

  assert.equal(result.output, 'prefix-tail');
  assert.equal(result.truncated, false);
});

test('argv runner cleans residual owned descendants after the parent exits normally', async () => {
  const sandbox = await createTestDirectory('omnai-residual-process-tree-');
  cleanups.push(sandbox.cleanup);
  const pidPath = join(sandbox.root, 'residual-pid.txt');
  const runner = createArgvProcessTreeRunner({ terminationGraceMs: 20 });
  let residualPid: number | undefined;
  try {
    const result = await runner.run({
      executable: process.execPath,
      argv: ['-e', residualProcessScript(pidPath)],
      shell: false,
      cwd: sandbox.root,
      environment: {},
      timeoutMs: 2_000,
      outputLimit: 1_024,
      network: 'ALLOW',
      ownerRunId: 'IER-0001',
      sandboxProofId: undefined,
    });
    [residualPid] = await waitForProcessIds(pidPath, 1);
    assert.notEqual(residualPid, undefined);
    assert.equal(result.descendants.includes(residualPid!), true);
    await waitForCondition(() => !processIsLive(residualPid!));
  } finally {
    if (residualPid !== undefined && processIsLive(residualPid)) {
      process.kill(residualPid, 'SIGKILL');
    }
  }
});

test('argv runner tracks and cleans an owned descendant that creates a detached process group', async () => {
  const sandbox = await createTestDirectory('omnai-detached-descendant-');
  cleanups.push(sandbox.cleanup);
  const pidPath = join(sandbox.root, 'detached-pid.txt');
  const runner = createArgvProcessTreeRunner({ terminationGraceMs: 20 });
  let detachedPid: number | undefined;
  try {
    const result = await runner.run({
      executable: process.execPath,
      argv: ['-e', detachedProcessScript(pidPath)],
      shell: false,
      cwd: sandbox.root,
      environment: {},
      timeoutMs: 2_000,
      outputLimit: 1_024,
      network: 'ALLOW',
      ownerRunId: 'IER-0001',
      sandboxProofId: undefined,
    });
    [detachedPid] = await waitForProcessIds(pidPath, 1);
    assert.notEqual(detachedPid, undefined);
    assert.equal(result.descendants.includes(detachedPid!), true);
    await waitForCondition(() => !processIsLive(detachedPid!));
  } finally {
    if (detachedPid !== undefined && processIsLive(detachedPid)) {
      process.kill(detachedPid, 'SIGKILL');
    }
  }
});

test('external adapter blocks before allocation without exact attestation capability', async () => {
  const fixture = await createEnvironmentProfileFixture({ driver: 'external' });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const client = new RecordingExternalClient();
  const adapter = createExternalEnvironmentAdapter({
    client,
    capabilities: { exclusiveLease: true, exactAttestation: false },
  });

  const prepared = await adapter.prepare(await adapterContext(fixture, profile, 'IER-0001'));

  assert.equal(prepared.status, 'BLOCKED');
  if (prepared.status !== 'BLOCKED') assert.fail('external profile must be blocked');
  assert.equal(prepared.code, 'EXTERNAL_ATTESTATION_REQUIRED');
  assert.deepEqual(client.calls(), []);
});

test('external adapter reserves, attests, inspects after restart, and releases idempotently', async () => {
  const fixture = await createEnvironmentProfileFixture({ driver: 'external' });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const client = new RecordingExternalClient();
  const options = {
    client,
    capabilities: { exclusiveLease: true, exactAttestation: true },
  } as const;
  const adapter = createExternalEnvironmentAdapter(options);
  const context = await adapterContext(fixture, profile, 'IER-0001');
  const prepared = await adapter.prepare(context);
  assert.equal(prepared.status, 'READY');
  if (prepared.status !== 'READY') assert.fail('attested exclusive external profile must prepare');
  assert.deepEqual(client.calls(), []);

  const setup = await adapter.runStep(prepared, { name: 'setup' });

  assert.deepEqual(client.calls(), ['reserve:IER-0001', 'publish:IER-0001', 'attest:IER-0001']);
  assert.equal(setup.resource?.exclusiveLeaseId, client.leaseId);
  assert.equal((await adapter.inspect(context)).ownership, 'PROVEN');
  const recovered = await createExternalEnvironmentAdapter(options).inspect(context);
  assert.equal(recovered.resource?.exclusiveLeaseId, client.leaseId);

  await adapter.release(context);
  await adapter.release(context);
  assert.equal(client.releaseCalls(), 1);
});

test('external attestation publishes the complete frozen integration input tuple', async () => {
  const fixture = await createEnvironmentProfileFixture({ driver: 'external' });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const client = new RecordingExternalClient();
  const adapter = createExternalEnvironmentAdapter({
    client,
    capabilities: { exclusiveLease: true, exactAttestation: true },
  });
  const integrationInput = integrationInputFixture(profile);
  const context = { ...await adapterContext(fixture, profile, 'IER-0001'), integrationInput };
  const prepared = await adapter.prepare(context);
  assert.equal(prepared.status, 'READY');
  if (prepared.status !== 'READY') assert.fail('complete input fixture must prepare');

  await adapter.runStep(prepared, { name: 'setup' });

  const attestation = client.expectedAttestations()[0] as Record<string, unknown> | undefined;
  assert.equal(attestation?.inputHash, integrationInput.inputHash);
  assert.deepEqual(attestation?.projects, integrationInput.projects);
  assert.deepEqual(attestation?.executorDigests, integrationInput.executorDigests);
  assert.deepEqual(attestation?.externalDeploymentDigests, integrationInput.externalDeploymentDigests);
});

test('external setup rejects artifact publication outside the frozen deployment tuple', async () => {
  const fixture = await createEnvironmentProfileFixture({ driver: 'external' });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const client = new MismatchedPublicationExternalClient();
  const adapter = createExternalEnvironmentAdapter({
    client,
    capabilities: { exclusiveLease: true, exactAttestation: true },
  });
  const context = await adapterContext(fixture, profile, 'IER-0001');
  const prepared = await adapter.prepare(context);
  if (prepared.status !== 'READY') assert.fail('publication fixture must prepare');

  await assert.rejects(
    () => adapter.runStep(prepared, { name: 'setup' }),
    /EXTERNAL_ARTIFACT_PUBLICATION_MISMATCH/,
  );
  const record = YAML.parse(await readFile(externalLeaseRecordPath(context.runRoot), 'utf8')) as {
    status?: string;
  };
  assert.equal(record.status, 'RELEASED');
});

test('external setup persists a reserved lease before attestation and resumes after restart', async () => {
  const fixture = await createEnvironmentProfileFixture({ driver: 'external' });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const client = new CrashWindowExternalClient();
  const options = {
    client,
    capabilities: { exclusiveLease: true, exactAttestation: true },
  } as const;
  const context = await adapterContext(fixture, profile, 'IER-0001');
  const adapter = createExternalEnvironmentAdapter(options);
  const prepared = await adapter.prepare(context);
  assert.equal(prepared.status, 'READY');
  if (prepared.status !== 'READY') assert.fail('crash-window fixture must prepare');

  await assert.rejects(
    () => adapter.runStep(prepared, { name: 'setup' }),
    /INJECTED_ATTEST_FAILURE/,
  );
  const reserved = YAML.parse(await readFile(externalLeaseRecordPath(context.runRoot), 'utf8')) as {
    status?: string;
    inputHash?: string;
  };
  assert.equal(reserved.status, 'RESERVED');
  assert.equal(reserved.inputHash, context.integrationInput.inputHash);

  const restarted = createExternalEnvironmentAdapter(options);
  const restartedPrepared = await restarted.prepare(context);
  assert.equal(restartedPrepared.status, 'READY');
  if (restartedPrepared.status !== 'READY') assert.fail('reserved lease must be resumable');
  await restarted.runStep(restartedPrepared, { name: 'setup' });
  const attested = YAML.parse(await readFile(externalLeaseRecordPath(context.runRoot), 'utf8')) as {
    status?: string;
  };
  assert.equal(attested.status, 'ATTESTED');
  assert.equal(client.reserveCalls, 1);
  assert.equal(client.attestCalls, 2);
  assert.equal(client.releaseCalls, 1);
});

test('external setup recovers a lease when the reserve response is lost after remote allocation', async () => {
  const fixture = await createEnvironmentProfileFixture({ driver: 'external' });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const client = new LostReserveResponseExternalClient();
  const options = {
    client,
    capabilities: { exclusiveLease: true, exactAttestation: true },
  } as const;
  const context = await adapterContext(fixture, profile, 'IER-0001');
  const adapter = createExternalEnvironmentAdapter(options);
  const prepared = await adapter.prepare(context);
  if (prepared.status !== 'READY') assert.fail('reserve recovery fixture must prepare');

  await assert.rejects(
    () => adapter.runStep(prepared, { name: 'setup' }),
    /INJECTED_RESERVE_RESPONSE_LOST/,
  );
  const intent = YAML.parse(await readFile(externalLeaseRecordPath(context.runRoot), 'utf8')) as {
    status?: string;
  };
  assert.equal(intent.status, 'RESERVING');

  const restarted = createExternalEnvironmentAdapter(options);
  const restartedPrepared = await restarted.prepare(context);
  if (restartedPrepared.status !== 'READY') assert.fail('reserving intent must be resumable');
  const setup = await restarted.runStep(restartedPrepared, { name: 'setup' });

  assert.equal(setup.resource?.exclusiveLeaseId, 'lease-response-lost');
  assert.equal(client.reserveCalls, 1);
  assert.equal(client.lookupCalls, 2);
});

test('successful external compensation transitions to retryable released state', async () => {
  const fixture = await createEnvironmentProfileFixture({ driver: 'external' });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const client = new SuccessfulCompensationExternalClient();
  const options = {
    client,
    capabilities: { exclusiveLease: true, exactAttestation: true },
  } as const;
  const context = await adapterContext(fixture, profile, 'IER-0001');
  const adapter = createExternalEnvironmentAdapter(options);
  const prepared = await adapter.prepare(context);
  if (prepared.status !== 'READY') assert.fail('compensation fixture must prepare');

  await assert.rejects(
    () => adapter.runStep(prepared, { name: 'setup' }),
    /INJECTED_ATTEST_FAILURE/,
  );
  const released = YAML.parse(await readFile(externalLeaseRecordPath(context.runRoot), 'utf8')) as {
    status?: string;
  };
  assert.equal(released.status, 'RELEASED');

  const retried = createExternalEnvironmentAdapter(options);
  const retriedPrepared = await retried.prepare(context);
  if (retriedPrepared.status !== 'READY') assert.fail('released lease must be retryable');
  const setup = await retried.runStep(retriedPrepared, { name: 'setup' });

  assert.equal(setup.resource?.exclusiveLeaseId, 'lease-compensation-2');
  assert.equal(client.reserveCalls, 2);
  assert.equal(client.releaseCalls, 1);
});

test('shared external environment runs only as a serialized diagnostic', async () => {
  const fixture = await createEnvironmentProfileFixture({ driver: 'external', maxParallel: 1 });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const client = new DiagnosticExternalClient();
  const adapter = createExternalEnvironmentAdapter({
    client,
    capabilities: { exclusiveLease: false, exactAttestation: false },
  });
  const context = {
    ...await adapterContext(fixture, profile, 'IER-0001'),
    requestedMode: 'DIAGNOSTIC_ONLY' as const,
  };

  const prepared = await adapter.prepare(context);
  assert.equal(prepared.status, 'READY');
  if (prepared.status !== 'READY') assert.fail('serialized diagnostic must prepare');
  assert.equal(prepared.probe.authoritative, false);
  await adapter.runStep(prepared, { name: 'setup' });
  const result = await adapter.runStep(prepared, { name: 'test' });
  await adapter.runStep(prepared, { name: 'teardown' });

  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(client.reserveCalls, 0);
  assert.equal(client.releaseCalls, 0);
});

test('external step timeout aborts the client call at the profile deadline', async () => {
  const fixture = await createEnvironmentProfileFixture({
    driver: 'external',
    command: { ...commandDefinition('node', ['test/environment-step.mjs']), timeoutMs: 200 },
  });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const client = new SlowExternalClient(1_000);
  const adapter = createExternalEnvironmentAdapter({
    client,
    capabilities: { exclusiveLease: true, exactAttestation: true },
  });
  const prepared = await adapter.prepare(await adapterContext(fixture, profile, 'IER-0001'));
  if (prepared.status !== 'READY') assert.fail('timeout fixture must prepare');
  await adapter.runStep(prepared, { name: 'setup' });

  await assert.rejects(
    () => adapter.runStep(prepared, { name: 'test' }),
    /EXTERNAL_OPERATION_TIMEOUT: test/,
  );
  assert.equal(client.aborted, true);
});

test('external setup uses one deadline across lookup reserve publish and attest', async () => {
  const fixture = await createEnvironmentProfileFixture({
    driver: 'external',
    command: { ...commandDefinition('external', []), timeoutMs: 60 },
  });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const client = new SlowSetupExternalClient(25);
  const adapter = createExternalEnvironmentAdapter({
    client,
    capabilities: { exclusiveLease: true, exactAttestation: true },
  });
  const prepared = await adapter.prepare(await adapterContext(fixture, profile, 'IER-0001'));
  if (prepared.status !== 'READY') assert.fail('slow external fixture must prepare');

  await assert.rejects(
    () => adapter.runStep(prepared, { name: 'setup' }),
    /EXTERNAL_OPERATION_TIMEOUT: setup/,
  );
  assert.equal(client.reserveCalls, 1);
  assert.equal(client.attestCalls, 0);
});

test('a timed-out late reserve stays reconcilable and cannot be declared absent', async () => {
  const fixture = await createEnvironmentProfileFixture({
    driver: 'external',
    command: { ...commandDefinition('external', []), timeoutMs: 1_000 },
    teardownTimeoutMs: 1_000,
  });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const client = new LateReserveExternalClient();
  const adapter = createExternalEnvironmentAdapter({
    client,
    capabilities: { exclusiveLease: true, exactAttestation: true },
  });
  const context = await adapterContext(fixture, profile, 'IER-0001');
  const prepared = await adapter.prepare(context);
  if (prepared.status !== 'READY') assert.fail('late reserve fixture must prepare');

  const setup = adapter.runStep(prepared, { name: 'setup' });
  await client.waitForReservationStart();
  await assert.rejects(() => setup, /EXTERNAL_OPERATION_TIMEOUT: setup/);
  const blocked = await adapter.release(context);
  assert.equal(blocked.status, 'BLOCKED');
  const intent = YAML.parse(await readFile(externalLeaseRecordPath(context.runRoot), 'utf8')) as {
    status?: string;
  };
  assert.equal(intent.status, 'RESERVING');

  client.completeReservation();
  await client.waitForReservation();
  const released = await adapter.release(context);
  assert.equal(released.status, 'RELEASED');
  assert.equal(client.releaseCalls, 1);
});

test('secret values are spawn-time only and redacted from durable text, argv, output, and errors', async () => {
  const secret = 'never-persist';
  const fixture = await createEnvironmentProfileFixture({
    driver: 'commands',
    command: commandDefinition('node', ['test/integration.mjs']),
  });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const runner = new RecordingArgvRunner({ output: `before ${secret} after` });
  const adapter = createCommandsEnvironmentAdapter({
    runner,
    sandbox: new ExecutingSandboxProvider(runner),
  });
  const baseContext = await adapterContext(fixture, profile, 'IER-0001');
  const context = {
    ...baseContext,
    sourceEnvironment: () => ({ OMNAI_TEST_DB_PASSWORD: secret }),
  };
  const prepared = await adapter.prepare(context);
  assert.equal(prepared.status, 'READY');
  if (prepared.status !== 'READY') assert.fail('secret fixture must prepare');
  assert.equal(JSON.stringify(prepared).includes(secret), false);

  const result = await adapter.runStep(prepared, { name: 'test' });

  assert.equal(result.output, 'before [REDACTED] after');
  assert.equal(JSON.stringify(runner.spawnCalls()).includes(secret), false);
  assert.equal(runner.childEnvironment().TEST_DB_PASSWORD, secret);
  assert.equal((await allPersistedText(fixture.context.home)).includes(secret), false);
  assert.equal(profile.contentHash.includes(secret), false);

  const failingRunner = new RecordingArgvRunner({ error: `adapter failed with ${secret}` });
  const failingAdapter = createCommandsEnvironmentAdapter({
    runner: failingRunner,
    sandbox: new ExecutingSandboxProvider(failingRunner),
  });
  const failingContext = {
    ...await adapterContext(fixture, profile, 'IER-0002'),
    sourceEnvironment: () => ({ OMNAI_TEST_DB_PASSWORD: secret }),
  };
  const failingPrepared = await failingAdapter.prepare(failingContext);
  assert.equal(failingPrepared.status, 'READY');
  if (failingPrepared.status !== 'READY') assert.fail('failing secret fixture must prepare');
  await assert.rejects(
    () => failingAdapter.runStep(failingPrepared, { name: 'test' }),
    (error: unknown) => {
      assert.equal(error instanceof Error && error.message.includes(secret), false);
      assert.match(error instanceof Error ? error.message : String(error), /\[REDACTED\]/);
      return true;
    },
  );
});

test('production Compose effective-config preparation is side-effect-free', async () => {
  const fixture = await createEnvironmentProfileFixture({
    driver: 'compose',
    discoveredCompose: 'integration/compose.yaml',
  });
  const definitionPath = fixture.worksetPath('integration/compose.yaml');
  const runner = new SequencedArgvRunner([]);
  const runtime = createProductionComposeRuntime({ runner });
  const labels = {
    'omnai.owner': 'omnai',
    'omnai.worksetId': fixture.context.worksetId,
    'omnai.environmentRunId': 'IER-0001',
    'omnai.profileContentHash': hashObject('profile'),
  };
  const resource: ComposeRuntimeResource = {
    driver: 'compose',
    ownerRunId: 'IER-0001',
    composeProjectName: 'omnai-wks-0001-ier-0001',
    resourceRefs: ['compose-project:omnai-wks-0001-ier-0001'],
    reservedPorts: [],
    labels,
    networkNames: ['omnai-wks-0001-ier-0001-network'],
    volumeNames: [],
    containerNames: [
      'omnai-wks-0001-ier-0001-order',
      'omnai-wks-0001-ier-0001-quote',
    ],
  };

  const effective = await runtime.effectiveConfig({
    definitionPath,
    projectName: resource.composeProjectName,
    labels,
    resource,
  });

  assert.equal(runner.requests.length, 0);
  assert.equal(effective !== null && typeof effective === 'object', true);
});

test('production Compose setup validates through shell-free argv before allocating but does not start', async () => {
  const fixture = await createEnvironmentProfileFixture({
    driver: 'compose',
    discoveredCompose: 'integration/compose.yaml',
  });
  const profile = await resolveIntegrationEnvironmentProfile(fixture.context, 'authorization-local');
  const definitionPath = fixture.worksetPath('integration/compose.yaml');
  const before = await readFile(definitionPath, 'utf8');
  const labels = {
    'omnai.owner': 'omnai',
    'omnai.worksetId': fixture.context.worksetId,
    'omnai.environmentRunId': 'IER-0001',
    'omnai.profileContentHash': profile.contentHash,
  };
  const resource: ComposeRuntimeResource = {
    driver: 'compose',
    ownerRunId: 'IER-0001',
    composeProjectName: 'omnai-wks-0001-ier-0001',
    resourceRefs: ['compose-project:omnai-wks-0001-ier-0001'],
    reservedPorts: [],
    labels,
    networkNames: ['omnai-wks-0001-ier-0001-network-default'],
    volumeNames: [],
    containerNames: ['omnai-wks-0001-ier-0001-order', 'omnai-wks-0001-ier-0001-quote'],
  };
  const normalized = {
    services: {
      order: {
        image: `example/order@sha256:${'a'.repeat(64)}`,
        labels,
        container_name: resource.containerNames[0],
        networks: { default: null },
      },
      quote: {
        image: `example/quote@sha256:${'b'.repeat(64)}`,
        labels,
        container_name: resource.containerNames[1],
        networks: { default: null },
      },
    },
    networks: { default: { name: resource.networkNames[0], labels } },
  };
  const runner = new ComposeSetupArgvRunner(normalized, labels);
  const runtime = createProductionComposeRuntime({ runner });
  const effectiveConfig = await runtime.effectiveConfig({
    definitionPath,
    projectName: resource.composeProjectName,
    labels,
    resource,
  });
  assert.equal(runner.requests.length, 0);
  const context = await adapterContext(fixture, profile, 'IER-0001');

  const setupRequest = {
    definitionPath,
    projectName: resource.composeProjectName,
    labels,
    resource,
    runRoot: context.runRoot,
    workspaceRoot: context.workspaceRoot,
    sourceRoots: context.sourceRoots,
    profile,
    environment: {},
    effectiveConfig,
  };
  const validation = await runtime.validateSetup(setupRequest);
  const allocated = await runtime.setup(setupRequest, validation);

  assert.equal(await readFile(definitionPath, 'utf8'), before);
  assert.equal(runner.requests.every((request) => request.shell === false), true);
  assert.deepEqual(runner.requests[0]?.argv, [
    'compose', '-f', definitionPath, '-f', '-', '-p', resource.composeProjectName,
    'config', '--format', 'json',
  ]);
  assert.match(runner.requests[0]?.stdin ?? '', /omnai\.environmentRunId/);
  assert.equal(runner.requests.some((request) => request.argv.includes('up')), false);
  assert.equal(runner.requests.some((request) =>
    request.argv[0] === 'network' && request.argv[1] === 'create'), true);
  assert.deepEqual(allocated.networkNames, resource.networkNames);
  await runtime.release({ definitionPath, resource: allocated });
  const networkRemoval = runner.requests.find((request) =>
    request.argv[0] === 'network' && request.argv[1] === 'rm');
  assert.equal(networkRemoval?.argv[2], allocated.networkIds?.[0]);
  assert.notEqual(networkRemoval?.argv[2], allocated.networkNames[0]);
});

test('production adapter registry wires compose, commands, and external drivers explicitly', async () => {
  const fixture = await createEnvironmentProfileFixture({ driver: 'compose' });
  const composeRuntime = new RecordingComposeRuntime();
  const registry = createProductionEnvironmentAdapterRegistry({
    workspaceRoot: fixture.worksetPath(''),
    compose: { runtime: composeRuntime },
    commands: {
      runner: new RecordingArgvRunner(),
      sandbox: new StaticSandboxProvider('UNPROVEN'),
    },
    external: {
      client: new RecordingExternalClient(),
      capabilities: { exclusiveLease: true, exactAttestation: true },
    },
  });

  assert.deepEqual(
    (['compose', 'commands', 'external'] as const).map((driver) => registry.forDriver(driver).driver),
    ['compose', 'commands', 'external'],
  );
});

test('production registry forwards the Compose command resolver for bootstrapped profiles', async () => {
  const fixture = await createEnvironmentProfileFixture({
    explicitProfile: false,
    discoveredCompose: 'integration/compose.yaml',
  });
  const discovered = await discoverIntegrationEnvironmentProfiles(fixture.context);
  const profile = await bootstrapIntegrationEnvironmentProfile(fixture.context, discovered[0]!);
  const runtime = new RecordingComposeRuntime();
  const resolved: string[] = [];
  const registry = createProductionEnvironmentAdapterRegistry({
    workspaceRoot: fixture.worksetPath(''),
    compose: {
      runtime,
      resolveCommand: async (commandRef) => {
        resolved.push(commandRef);
        return commandDefinition('node', [commandRef]);
      },
    },
  });

  const prepared = await registry.forDriver('compose').prepare(
    await adapterContext(fixture, profile, 'IER-0001'),
  );

  assert.equal(prepared.status, 'READY');
  assert.deepEqual(resolved, ['environment.seed', 'environment.test']);
});

interface EnvironmentProfileFixtureInput {
  readonly driver?: 'compose' | 'commands' | 'external';
  readonly explicitProfile?: boolean;
  readonly discoveredCompose?: string;
  readonly discoveredCommands?: string;
  readonly unsafeDiscoveredCommands?:
    | boolean
    | 'inline-code'
    | 'traversal'
    | 'equals-traversal'
    | 'path-sigil';
  readonly maxParallel?: number;
  readonly command?: ReturnType<typeof commandDefinition>;
  readonly teardownTimeoutMs?: number;
  readonly composeSecretInterpolation?: boolean;
  readonly portMode?: 'dynamic' | 'inherited' | 'external';
  readonly discoveredPackageScripts?: boolean;
}

async function createEnvironmentProfileFixture(input: EnvironmentProfileFixtureInput): Promise<{
  readonly context: IntegrationEnvironmentProfileContext;
  readonly workset: Workset;
  worksetPath(relativePath: string): string;
  sourceProfilePath(id: string): string;
}> {
  const sandbox = await createTestDirectory('omnai-environment-profile-');
  cleanups.push(sandbox.cleanup);
  const home = join(sandbox.root, 'home');
  const workset = await createWorkset(home, 'Authorization Local');
  const workspace = worksetWorkspaceRoot(home, workset.id);
  for (const project of ['order', 'quote']) {
    const worktree = join(workspace, project);
    await mkdir(worktree, { recursive: true });
    workset.members.push({
      project,
      status: 'ACTIVE',
      changeId: 'CHG-0001',
      worktree,
      branch: `omnai/${workset.id}-${project}`,
      addedAt: workset.createdAt,
      updatedAt: workset.updatedAt,
    });
  }
  workset.members.sort((left, right) => left.project.localeCompare(right.project));
  await saveWorkset(home, workset);

  const definitionRef = input.discoveredCompose ?? input.discoveredCommands ??
    (input.discoveredPackageScripts === true ? 'package.json' : 'integration/environment.json');
  const definitionPath = join(workspace, definitionRef);
  await mkdir(join(definitionPath, '..'), { recursive: true });
  await writeFile(
    definitionPath,
    input.discoveredPackageScripts === true
      ? JSON.stringify(packageIntegrationManifest(), null, 2) + '\n'
      : input.discoveredCompose !== undefined
      ? 'services:\n' +
        '  order:\n    image: example/order@sha256:' + 'a'.repeat(64) + '\n' +
        (input.composeSecretInterpolation === true
          ? '    environment:\n      TEST_DB_PASSWORD: ${TEST_DB_PASSWORD}\n'
          : '') +
        '  quote:\n    image: example/quote@sha256:' + 'b'.repeat(64) + '\n'
      : input.discoveredCommands !== undefined
        ? YAML.stringify(commandManifest(input.unsafeDiscoveredCommands ?? false))
        : '{"services":["order","quote"]}\n',
    'utf8',
  );

  if (input.explicitProfile !== false) {
    const sourcePath = join(workspace, 'integration', 'environments', 'authorization-local.yaml');
    await mkdir(join(sourcePath, '..'), { recursive: true });
    await writeFile(sourcePath, YAML.stringify(profileSource(
      input.driver ?? 'commands',
      definitionRef,
      sha256(await readFile(definitionPath)),
      input.command,
      input.maxParallel,
      input.portMode,
      input.teardownTimeoutMs,
    )), 'utf8');
  }

  const context: IntegrationEnvironmentProfileContext = { home, worksetId: workset.id };
  return {
    context,
    workset,
    worksetPath: (relativePath) => join(workspace, relativePath),
    sourceProfilePath: (id) => join(workspace, 'integration', 'environments', `${id}.yaml`),
  };
}

function packageIntegrationManifest() {
  const scripts = Object.fromEntries([
    'setup', 'build', 'start', 'health', 'seed', 'test', 'collect', 'teardown',
  ].map((name) => [`omnai:integration:${name}`, `node test/${name}.mjs`]));
  return {
    name: 'omnai-integration-workset',
    private: true,
    scripts,
    omnai: {
      integrationEnvironment: {
        requiredProjects: ['order', 'quote'],
        scripts: Object.fromEntries([
          'setup', 'build', 'start', 'health', 'seed', 'test', 'collect', 'teardown',
        ].map((name) => [name, `omnai:integration:${name}`])),
      },
    },
  };
}

function commandManifest(
  unsafe: boolean | 'inline-code' | 'traversal' | 'equals-traversal' | 'path-sigil',
) {
  const command = unsafe === true
    ? commandDefinition('sh', ['-c', 'npm test'])
    : unsafe === 'inline-code'
      ? commandDefinition('node', ['-e', 'process.exit(0)'])
      : unsafe === 'traversal'
        ? commandDefinition('../bin/test-runner', [])
        : unsafe === 'equals-traversal'
          ? commandDefinition('pytest', ['--basetemp=x=../../../outside'])
          : unsafe === 'path-sigil'
            ? commandDefinition('pytest', ['@/etc/args'])
        : commandDefinition('node', ['test/integration.mjs']);
  return {
    schemaVersion: 1,
    requiredProjects: ['order', 'quote'],
    steps: Object.fromEntries([
      'setup', 'build', 'start', 'health', 'seed', 'test', 'collect', 'teardown',
    ].map((name) => [name, command])),
  };
}

function profileSource(
  driver: 'compose' | 'commands' | 'external',
  definitionRef: string,
  definitionContentHash: string,
  commandOverride?: ReturnType<typeof commandDefinition>,
  maxParallel = 2,
  portMode: 'dynamic' | 'inherited' | 'external' = 'dynamic',
  teardownTimeoutMs?: number,
) {
  const command = commandOverride ?? commandDefinition('node', ['test/environment-step.mjs']);
  return {
    schemaVersion: 2,
    id: 'authorization-local',
    driver,
    requiredProjects: ['order', 'quote'],
    definitionRef,
    definitionContentHash,
    isolation: { mode: 'per-run', maxParallel, requireExclusiveLease: driver === 'external' },
    ports: { mode: portMode, range: [20_000, 29_999] },
    envRefs: { TEST_DB_PASSWORD: 'OMNAI_TEST_DB_PASSWORD' },
    sandbox: {
      driver: driver === 'external' ? 'external' : 'platform',
      requiredProofs: ['CREDENTIALS', 'FILESYSTEM', 'NETWORK', 'PROCESS_TREE', 'RESOURCE_LIMITS'],
    },
    steps: {
      setup: command,
      build: command,
      start: command,
      health: command,
      seed: command,
      test: command,
      collect: command,
      teardown: teardownTimeoutMs === undefined
        ? command
        : { ...command, timeoutMs: teardownTimeoutMs },
    },
  };
}

function commandDefinition(executable: string, argv: readonly string[]): {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly outputLimit: number;
  readonly network: 'DENY';
  readonly requiredArtifacts: readonly string[];
} {
  return {
    executable,
    argv,
    cwd: '.',
    timeoutMs: 60_000,
    outputLimit: 65_536,
    network: 'DENY' as const,
    requiredArtifacts: [],
  };
}

function changedDiscovery(discovery: DiscoveredProfile): DiscoveredProfile {
  if (discovery.status !== 'READY') return discovery;
  return {
    ...discovery,
    source: {
      ...discovery.source,
      definitionContentHash: hashObject('different-definition'),
    },
  };
}

async function adapterContext(
  fixture: Awaited<ReturnType<typeof createEnvironmentProfileFixture>>,
  profile: IntegrationEnvironmentProfile,
  environmentRunId: string,
): Promise<EnvironmentAdapterContext> {
  const runRoot = integrationEnvironmentRunRoot(
    fixture.context.home,
    fixture.context.worksetId,
    environmentRunId,
  );
  await mkdir(runRoot, { recursive: true });
  return {
    worksetId: fixture.context.worksetId,
    environmentRunId,
    integrationInput: integrationInputFixture(profile),
    profile,
    workspaceRoot: fixture.worksetPath(''),
    runRoot,
    sourceRoots: fixture.workset.members
      .flatMap((member) => member.worktree === undefined ? [] : [member.worktree])
      .sort(),
    requestedMode: 'AUTHORITATIVE',
    sourceEnvironment: () => ({ OMNAI_TEST_DB_PASSWORD: 'fixture-secret' }),
  };
}

function integrationInputFixture(profile: IntegrationEnvironmentProfile): IntegrationEnvironmentInput {
  const digest = hashObject('integration-input-fixture');
  const executorDigests = profile.driver === 'commands'
    ? Object.entries(profile.steps).map(([step, definition]) => {
        if (!('executable' in definition)) throw new Error('fixture commands must be explicit');
        return {
          ref: commandExecutorDigestRef(step as keyof IntegrationEnvironmentProfile['steps'], definition.executable),
          digest: hashObject(`executable:${definition.executable}`),
        };
      }).sort((left, right) => left.ref.localeCompare(right.ref))
    : profile.driver === 'compose'
      ? [{ ref: composeExecutorDigestRef(), digest: hashObject('compose-engine') }]
      : [{ ref: 'executor', digest }];
  const content = {
    schemaVersion: 1 as const,
    verificationPlan: { id: 'VPL-0001', contentHash: hashObject('verification-plan') },
    contractSnapshots: [],
    commitSet: { id: 'CST-0001', scopeHash: hashObject('commit-set-scope') },
    projects: profile.requiredProjects.map((project, index) => ({
      project,
      commit: String(index + 1).repeat(40),
      commitTree: String(index + 3).repeat(40),
      verifiedTree: String(index + 5).repeat(40),
      metadataDeltaHash: hashObject(`metadata:${project}`),
    })),
    profile: { id: profile.id, contentHash: profile.contentHash },
    testCaseRefs: [projectTestCaseRef({
      project: profile.requiredProjects[0]!,
      changeId: 'CHG-0001',
      revision: 'REV-0001',
    }, 'TC-0001', hashObject('test-case'))],
    commandDefinitionsHash: hashObject('commands'),
    definitionDigest: profile.definitionContentHash,
    executorDigests,
    supportingArtifactDigests: [{ ref: 'database', digest: hashObject('database') }],
    externalDeploymentDigests: [{ ref: 'external-api', digest: hashObject('external-api') }],
    environmentReferenceNames: Object.values(profile.envRefs).sort(),
    policyVersion: 1,
  };
  return { ...content, inputHash: hashIntegrationEnvironmentInput(content) };
}

function rehashIntegrationInput(
  input: Omit<IntegrationEnvironmentInput, 'inputHash'> | IntegrationEnvironmentInput,
): IntegrationEnvironmentInput {
  const { inputHash: _ignored, ...content } = input as IntegrationEnvironmentInput;
  return { ...content, inputHash: hashIntegrationEnvironmentInput(content) };
}

function withSupportingDigests(
  input: IntegrationEnvironmentInput,
  digests: readonly { readonly ref: string; readonly digest: string }[],
): IntegrationEnvironmentInput {
  return rehashIntegrationInput({
    ...input,
    supportingArtifactDigests: [
      ...input.supportingArtifactDigests.filter(
        (existing) => !digests.some((digest) => digest.ref === existing.ref),
      ),
      ...digests,
    ].sort((left, right) => left.ref.localeCompare(right.ref)),
  });
}

type DangerousComposeCase =
  | 'privileged'
  | 'host-network'
  | 'host-pid'
  | 'host-ipc'
  | 'docker-socket'
  | 'host-root-bind'
  | 'device'
  | 'cap-add'
  | 'floating-image'
  | 'escaping-build-context'
  | 'symlink-build-context'
  | 'relative-bind-escape'
  | 'relative-long-bind-escape'
  | 'literal-secret';

class RecordingComposeRuntime implements ComposeRuntime {
  private readonly allocated: ComposeRuntimeResource[] = [];
  private nextPort: number;
  private environment: Readonly<Record<string, string>> = {};
  private readonly definitions: unknown[] = [];

  private buildCount = 0;

  constructor(
    private readonly dangerous?: DangerousComposeCase | 'safe-build' | 'late-deny' | 'published-port',
    nextPort = 24_000,
    private readonly executorDigest = hashObject('compose-engine'),
    private readonly builtImageDigest = hashObject('built-image:order'),
  ) {
    this.nextPort = nextPort;
  }

  buildCalls(): number {
    return this.buildCount;
  }

  async processContainment() {
    return {
      status: 'PROVEN' as const,
      kind: 'SANDBOX_SERVICE' as const,
      proofId: 'recording-compose-runtime',
    };
  }

  async executorIdentity() {
    return {
      ref: composeExecutorDigestRef(),
      executablePath: '/usr/bin/docker',
      executableDigest: this.executorDigest,
    };
  }

  resources(): readonly ComposeRuntimeResource[] {
    return [...this.allocated];
  }

  setupEnvironment(): Readonly<Record<string, string>> {
    return { ...this.environment };
  }

  stepDefinitions(): readonly unknown[] {
    return [...this.definitions];
  }

  async effectiveConfig(request: Parameters<ComposeRuntime['effectiveConfig']>[0]): Promise<unknown> {
    const order: Record<string, unknown> = {
      image: `example/order@sha256:${'a'.repeat(64)}`,
      labels: request.labels,
    };
    const quote: Record<string, unknown> = {
      image: `example/quote@sha256:${'b'.repeat(64)}`,
      labels: request.labels,
    };
    switch (this.dangerous) {
      case 'privileged': order.privileged = true; break;
      case 'host-network': order.network_mode = 'host'; break;
      case 'host-pid': order.pid = 'host'; break;
      case 'host-ipc': order.ipc = 'host'; break;
      case 'docker-socket': order.volumes = ['/var/run/docker.sock:/var/run/docker.sock']; break;
      case 'host-root-bind': order.volumes = ['/:/host:rw']; break;
      case 'device': order.devices = ['/dev/kvm:/dev/kvm']; break;
      case 'cap-add': order.cap_add = ['SYS_ADMIN']; break;
      case 'floating-image': order.image = 'example/order:latest'; break;
      case 'escaping-build-context': order.build = { context: '../outside' }; break;
      case 'symlink-build-context': order.build = { context: '../order/escaped' }; break;
      case 'relative-bind-escape': order.volumes = ['../../outside-bind:/host:rw']; break;
      case 'relative-long-bind-escape': {
        order.volumes = [{ source: '../../outside-bind', target: '/host', read_only: false }];
        break;
      }
      case 'literal-secret': order.environment = { DB_PASSWORD: 'literal-secret' }; break;
      case 'published-port': order.ports = ['8080:80']; break;
      case 'safe-build': {
        delete order.image;
        order.build = { context: '../order' };
        break;
      }
      case 'late-deny': break;
      case undefined: break;
    }
    return { services: { order, quote } };
  }

  private validationAttempts = 0;

  async validateSetup(request: Parameters<ComposeRuntime['setup']>[0]) {
    this.validationAttempts += 1;
    if (this.dangerous === 'late-deny' && this.validationAttempts === 1) {
      throw new Error('COMPOSE_EFFECTIVE_CONFIG_DENIED: LATE_INTERPOLATION');
    }
    return {
      resource: request.resource,
      normalizedConfig: request.effectiveConfig,
      normalizedConfigDigest: hashObject(request.effectiveConfig),
    };
  }

  async setup(request: Parameters<ComposeRuntime['setup']>[0]): Promise<ComposeRuntimeResource> {
    const environment = (request as typeof request & {
      readonly environment?: Readonly<Record<string, string>>;
    }).environment;
    this.environment = { ...(environment ?? {}) };
    const resource: ComposeRuntimeResource = {
      ...request.resource,
      reservedPorts: [this.nextPort++],
    };
    this.allocated.push(resource);
    return resource;
  }

  async runStep(request: Parameters<ComposeRuntime['runStep']>[0]): Promise<{
    exitCode: number;
    output: string;
    truncated: boolean;
  }> {
    this.definitions.push(request.definition);
    if (request.step.name === 'build') this.buildCount += 1;
    return {
      exitCode: 0,
      output: '',
      truncated: false,
      ...(request.step.name === 'build' && this.dangerous === 'safe-build'
        ? { imageDigests: [{ ref: composeImageDigestRef('order'), digest: this.builtImageDigest }] }
        : {}),
    };
  }

  async inspect(request: Parameters<ComposeRuntime['inspect']>[0]) {
    const resource = this.allocated.find(
      (candidate) => candidate.composeProjectName === request.composeProjectName,
    );
    return resource === undefined
      ? { ownership: 'ABSENT' as const }
      : { ownership: 'PROVEN' as const, resource };
  }

  async release(request: Parameters<ComposeRuntime['release']>[0]): Promise<void> {
    const index = this.allocated.findIndex(
      (candidate) => candidate.composeProjectName === request.resource.composeProjectName,
    );
    if (index >= 0) this.allocated.splice(index, 1);
  }
}

function disjoint(left: readonly number[], right: readonly number[]): boolean {
  const rightPorts = new Set(right);
  return left.every((port) => !rightPorts.has(port));
}

class RecordingArgvRunner implements ArgvProcessTreeRunner {
  private readonly calls: Array<{
    readonly executable: string;
    readonly argv: readonly string[];
    readonly shell: false;
    readonly cwd: string;
  }> = [];
  private environment: Readonly<Record<string, string>> = {};

  constructor(private readonly outcome: { readonly output?: string; readonly error?: string } = {}) {}

  async probeProcessContainment() {
    return { status: 'UNPROVEN' as const, code: 'TEST_RAW_RUNNER' };
  }

  spawnCalls() {
    return [...this.calls];
  }

  childEnvironment(): Readonly<Record<string, string>> {
    return { ...this.environment };
  }

  async run(request: ArgvRunRequest): Promise<{
    readonly exitCode: number;
    readonly signal: null;
    readonly output: string;
    readonly truncated: boolean;
    readonly descendants: readonly number[];
  }> {
    this.calls.push({
      executable: request.executable,
      argv: request.argv,
      shell: request.shell,
      cwd: request.cwd,
    });
    this.environment = { ...request.environment };
    if (this.outcome.error !== undefined) throw new Error(this.outcome.error);
    return {
      exitCode: 0,
      signal: null,
      output: this.outcome.output ?? '',
      truncated: false,
      descendants: [],
    };
  }
}

class SequencedArgvRunner implements ArgvProcessTreeRunner {
  readonly requests: ArgvRunRequest[] = [];

  constructor(private readonly outputs: readonly string[]) {}

  async probeProcessContainment() {
    return {
      status: 'PROVEN' as const,
      kind: 'SANDBOX_SERVICE' as const,
      proofId: 'sequenced-compose-runner',
    };
  }

  async run(request: ArgvRunRequest): Promise<{
    readonly exitCode: number;
    readonly signal: null;
    readonly output: string;
    readonly truncated: boolean;
    readonly descendants: readonly number[];
    readonly processContainer: {
      readonly kind: 'SANDBOX_SERVICE';
      readonly id: string;
      readonly emptyAfterExit: true;
    };
  }> {
    this.requests.push(request);
    const output = this.outputs[this.requests.length - 1];
    if (output === undefined) throw new Error('UNEXPECTED_COMPOSE_RUNNER_CALL');
    return {
      exitCode: 0,
      signal: null,
      output,
      truncated: false,
      descendants: [],
      processContainer: {
        kind: 'SANDBOX_SERVICE' as const,
        id: `sequenced-${String(this.requests.length)}`,
        emptyAfterExit: true as const,
      },
    };
  }
}

class ComposeSetupArgvRunner implements ArgvProcessTreeRunner {
  readonly requests: ArgvRunRequest[] = [];
  private readonly networks = new Map<string, string>();
  private readonly volumes = new Set<string>();

  constructor(
    private readonly normalized: unknown,
    private readonly labels: Readonly<Record<string, string>>,
  ) {}

  async probeProcessContainment() {
    return {
      status: 'PROVEN' as const,
      kind: 'SANDBOX_SERVICE' as const,
      proofId: 'compose-setup-runner',
    };
  }

  async run(request: ArgvRunRequest): Promise<{
    readonly exitCode: number;
    readonly signal: null;
    readonly output: string;
    readonly truncated: boolean;
    readonly descendants: readonly number[];
    readonly processContainer: {
      readonly kind: 'SANDBOX_SERVICE';
      readonly id: string;
      readonly emptyAfterExit: true;
    };
  }> {
    this.requests.push(request);
    const argv = request.argv;
    let output = '';
    if (argv.includes('config')) {
      output = JSON.stringify(this.normalized);
    } else if (argv[0] === 'ps') {
      output = '';
    } else if (argv[0] === 'network' && argv[1] === 'ls') {
      output = [...this.networks.entries()].map(([name, id]) => `${id}\t${name}`).join('\n');
    } else if (argv[0] === 'volume' && argv[1] === 'ls') {
      output = [...this.volumes].join('\n');
    } else if (argv[0] === 'network' && argv[1] === 'create') {
      const name = argv.at(-1)!;
      this.networks.set(name, `network-id-${String(this.networks.size + 1)}`);
    } else if (argv[0] === 'volume' && argv[1] === 'create') {
      this.volumes.add(argv.at(-1)!);
    } else if (argv[0] === 'inspect') {
      output = JSON.stringify(this.labels);
    } else if (argv[0] === 'network' && argv[1] === 'rm') {
      const id = argv[2];
      for (const [name, candidate] of this.networks) {
        if (candidate === id) this.networks.delete(name);
      }
    } else {
      throw new Error(`UNEXPECTED_COMPOSE_SETUP_CALL: ${argv.join(' ')}`);
    }
    return {
      exitCode: 0,
      signal: null,
      output,
      truncated: false,
      descendants: [],
      processContainer: {
        kind: 'SANDBOX_SERVICE' as const,
        id: `compose-setup-${String(this.requests.length)}`,
        emptyAfterExit: true as const,
      },
    };
  }
}

class StaticSandboxProvider implements CommandSandboxProvider {
  constructor(private readonly status: SandboxIsolationProof['status']) {}

  async probe(): Promise<SandboxIsolationProof> {
    return this.status === 'PROVEN'
      ? {
          status: 'PROVEN',
          proofId: 'sandbox-proof-1',
          proofs: ['CREDENTIALS', 'FILESYSTEM', 'NETWORK', 'PROCESS_TREE', 'RESOURCE_LIMITS'],
        }
      : {
          status: 'UNPROVEN',
          code: 'SANDBOX_ISOLATION_UNPROVEN',
          proofs: [],
        };
  }
}

class ExecutingSandboxProvider implements CommandSandboxProvider {
  constructor(
    private readonly runner: ArgvProcessTreeRunner,
    private readonly omitProcessContainer = false,
    private readonly proofs: SandboxIsolationProof['proofs'] = [
      'CREDENTIALS',
      'FILESYSTEM',
      'NETWORK',
      'PROCESS_TREE',
      'RESOURCE_LIMITS',
    ],
  ) {}

  async probe(): Promise<SandboxIsolationProof> {
    return {
      status: 'PROVEN',
      proofId: 'sandbox-proof-1',
      proofs: this.proofs,
    };
  }

  async execute(
    request: CommandSandboxExecutionRequest,
    signal?: AbortSignal,
  ): Promise<CommandSandboxExecutionResult> {
    assert.equal(request.bindingHash, commandSandboxBindingHash(request.binding));
    return {
      result: await this.runner.run(request.command, signal),
      proof: {
        proofId: request.binding.proofId,
        bindingHash: request.bindingHash,
        proofs: this.proofs,
        resolvedExecutablePath: `/sandbox/bin/${request.binding.executable}`,
        executableDigest: hashObject(`executable:${request.binding.executable}`),
        sourceInputs: request.binding.sourceInputs,
        ...(this.omitProcessContainer ? {} : {
          processContainer: { kind: 'SANDBOX_SERVICE' as const, id: 'sandbox-container-1' },
        }),
      } as CommandSandboxExecutionResult['proof'],
    };
  }
}

class RecordingExternalClient implements ExternalEnvironmentClient {
  readonly leaseId = 'lease-IER-0001';
  private readonly history: string[] = [];
  private readonly active = new Map<string, { lease: ExternalLease; attestation: ExternalAttestation }>();
  private releases = 0;
  private readonly expected: unknown[] = [];

  calls(): readonly string[] {
    return [...this.history];
  }

  releaseCalls(): number {
    return this.releases;
  }

  expectedAttestations(): readonly unknown[] {
    return [...this.expected];
  }

  async reserve(request: Parameters<ExternalEnvironmentClient['reserve']>[0]): Promise<ExternalLease> {
    this.history.push(`reserve:${request.idempotencyKey}`);
    const existing = [...this.active.values()].find(
      (candidate) => candidate.lease.ownerRunId === request.idempotencyKey,
    );
    if (existing !== undefined) return existing.lease;
    return {
      leaseId: this.leaseId,
      namespace: request.namespace,
      ownerRunId: request.idempotencyKey,
      exclusive: true,
    };
  }

  async lookup(request: Parameters<ExternalEnvironmentClient['lookup']>[0]): Promise<ExternalClientInspection> {
    const active = [...this.active.values()].find(
      (candidate) => candidate.lease.ownerRunId === request.idempotencyKey &&
        candidate.lease.namespace === request.namespace,
    );
    return active === undefined
      ? { ownership: 'ABSENT' }
      : { ownership: 'PROVEN', lease: active.lease, attestation: active.attestation };
  }

  async publish(request: Parameters<ExternalEnvironmentClient['publish']>[0]) {
    this.history.push(`publish:${request.idempotencyKey}`);
    return request.publication;
  }

  async attest(request: Parameters<ExternalEnvironmentClient['attest']>[0]): Promise<ExternalAttestation> {
    this.history.push(`attest:${request.idempotencyKey}`);
    this.expected.push(request.expected);
    this.active.set(request.lease.leaseId, {
      lease: request.lease,
      attestation: request.expected,
    });
    return request.expected;
  }

  async runStep(): Promise<{ exitCode: number; output: string; truncated: boolean }> {
    return { exitCode: 0, output: '', truncated: false };
  }

  async inspect(request: Parameters<ExternalEnvironmentClient['inspect']>[0]): Promise<ExternalClientInspection> {
    const active = this.active.get(request.leaseId);
    return active === undefined
      ? { ownership: 'ABSENT' }
      : { ownership: 'PROVEN', lease: active.lease, attestation: active.attestation };
  }

  async release(request: Parameters<ExternalEnvironmentClient['release']>[0]): Promise<void> {
    if (this.active.delete(request.lease.leaseId)) {
      this.history.push(`release:${request.idempotencyKey}`);
      this.releases += 1;
    }
  }
}

class MismatchedPublicationExternalClient extends RecordingExternalClient {
  override async publish(request: Parameters<ExternalEnvironmentClient['publish']>[0]) {
    return {
      ...request.publication,
      inputHash: hashObject('different-publication-input'),
    };
  }
}

class CrashWindowExternalClient implements ExternalEnvironmentClient {
  reserveCalls = 0;
  attestCalls = 0;
  releaseCalls = 0;
  private lease: ExternalLease | undefined;
  private attestation: ExternalAttestation | undefined;

  async reserve(request: Parameters<ExternalEnvironmentClient['reserve']>[0]): Promise<ExternalLease> {
    this.reserveCalls += 1;
    this.lease ??= {
      leaseId: 'lease-crash-window',
      namespace: request.namespace,
      ownerRunId: request.idempotencyKey,
      exclusive: true,
    };
    return this.lease;
  }

  async lookup(): Promise<ExternalClientInspection> {
    return this.inspect();
  }

  async publish(request: Parameters<ExternalEnvironmentClient['publish']>[0]) {
    return request.publication;
  }

  async attest(request: Parameters<ExternalEnvironmentClient['attest']>[0]): Promise<ExternalAttestation> {
    this.attestCalls += 1;
    if (this.attestCalls === 1) throw new Error('INJECTED_ATTEST_FAILURE');
    this.attestation = request.expected;
    return request.expected;
  }

  async runStep(): Promise<{ exitCode: number; output: string; truncated: boolean }> {
    return { exitCode: 0, output: '', truncated: false };
  }

  async inspect(): Promise<ExternalClientInspection> {
    if (this.lease === undefined) return { ownership: 'ABSENT' };
    return this.attestation === undefined
      ? { ownership: 'PROVEN', lease: this.lease }
      : { ownership: 'PROVEN', lease: this.lease, attestation: this.attestation };
  }

  async release(): Promise<void> {
    this.releaseCalls += 1;
    if (this.releaseCalls === 1) throw new Error('INJECTED_RELEASE_FAILURE');
    this.lease = undefined;
    this.attestation = undefined;
  }
}

class LostReserveResponseExternalClient implements ExternalEnvironmentClient {
  reserveCalls = 0;
  lookupCalls = 0;
  private lease: ExternalLease | undefined;
  private attestation: ExternalAttestation | undefined;

  async reserve(request: Parameters<ExternalEnvironmentClient['reserve']>[0]): Promise<ExternalLease> {
    this.reserveCalls += 1;
    this.lease ??= {
      leaseId: 'lease-response-lost',
      namespace: request.namespace,
      ownerRunId: request.idempotencyKey,
      exclusive: true,
    };
    if (this.reserveCalls === 1) throw new Error('INJECTED_RESERVE_RESPONSE_LOST');
    return this.lease;
  }

  async lookup(): Promise<ExternalClientInspection> {
    this.lookupCalls += 1;
    return this.lease === undefined
      ? { ownership: 'ABSENT' }
      : { ownership: 'PROVEN', lease: this.lease, ...(this.attestation === undefined ? {} : { attestation: this.attestation }) };
  }

  async publish(request: Parameters<ExternalEnvironmentClient['publish']>[0]) {
    return request.publication;
  }

  async attest(request: Parameters<ExternalEnvironmentClient['attest']>[0]): Promise<ExternalAttestation> {
    this.attestation = request.expected;
    return request.expected;
  }

  async runStep(): Promise<{ exitCode: number; output: string; truncated: boolean }> {
    return { exitCode: 0, output: '', truncated: false };
  }

  async inspect(): Promise<ExternalClientInspection> {
    return this.lease === undefined
      ? { ownership: 'ABSENT' }
      : { ownership: 'PROVEN', lease: this.lease, ...(this.attestation === undefined ? {} : { attestation: this.attestation }) };
  }

  async release(): Promise<void> {
    this.lease = undefined;
    this.attestation = undefined;
  }
}

class SuccessfulCompensationExternalClient implements ExternalEnvironmentClient {
  reserveCalls = 0;
  releaseCalls = 0;
  private attestCalls = 0;
  private lease: ExternalLease | undefined;
  private attestation: ExternalAttestation | undefined;

  async reserve(request: Parameters<ExternalEnvironmentClient['reserve']>[0]): Promise<ExternalLease> {
    this.reserveCalls += 1;
    this.lease = {
      leaseId: `lease-compensation-${String(this.reserveCalls)}`,
      namespace: request.namespace,
      ownerRunId: request.idempotencyKey,
      exclusive: true,
    };
    return this.lease;
  }

  async lookup(): Promise<ExternalClientInspection> {
    return this.inspect();
  }

  async publish(request: Parameters<ExternalEnvironmentClient['publish']>[0]) {
    return request.publication;
  }

  async attest(request: Parameters<ExternalEnvironmentClient['attest']>[0]): Promise<ExternalAttestation> {
    this.attestCalls += 1;
    if (this.attestCalls === 1) throw new Error('INJECTED_ATTEST_FAILURE');
    this.attestation = request.expected;
    return request.expected;
  }

  async runStep(): Promise<{ exitCode: number; output: string; truncated: boolean }> {
    return { exitCode: 0, output: '', truncated: false };
  }

  async inspect(): Promise<ExternalClientInspection> {
    return this.lease === undefined
      ? { ownership: 'ABSENT' }
      : { ownership: 'PROVEN', lease: this.lease, ...(this.attestation === undefined ? {} : { attestation: this.attestation }) };
  }

  async release(): Promise<void> {
    this.releaseCalls += 1;
    this.lease = undefined;
    this.attestation = undefined;
  }
}

class DiagnosticExternalClient implements ExternalEnvironmentClient {
  reserveCalls = 0;
  releaseCalls = 0;
  private lease: ExternalLease | undefined;

  async reserve(request: Parameters<ExternalEnvironmentClient['reserve']>[0]): Promise<ExternalLease> {
    this.reserveCalls += 1;
    this.lease = {
      leaseId: 'shared-diagnostic-lease',
      namespace: request.namespace,
      ownerRunId: request.idempotencyKey,
      exclusive: false,
    };
    return this.lease;
  }

  async lookup(request?: Parameters<ExternalEnvironmentClient['lookup']>[0]): Promise<ExternalClientInspection> {
    if (this.lease === undefined && request !== undefined) {
      this.lease = {
        leaseId: 'shared-diagnostic-lease',
        namespace: request.namespace,
        ownerRunId: request.idempotencyKey,
        exclusive: false,
      };
    }
    if (this.lease === undefined) return { ownership: 'ABSENT' };
    return { ownership: 'UNPROVEN', lease: this.lease };
  }

  async publish(request: Parameters<ExternalEnvironmentClient['publish']>[0]) {
    return request.publication;
  }

  async attest(request: Parameters<ExternalEnvironmentClient['attest']>[0]): Promise<ExternalAttestation> {
    return request.expected;
  }

  async runStep(): Promise<{ exitCode: number; output: string; truncated: boolean }> {
    return { exitCode: 0, output: 'diagnostic', truncated: false };
  }

  async inspect(): Promise<ExternalClientInspection> {
    return this.lookup();
  }

  async release(): Promise<void> {
    this.releaseCalls += 1;
  }
}

class SlowExternalClient extends RecordingExternalClient {
  aborted = false;

  constructor(private readonly delayMs = 100) {
    super();
  }

  override async runStep(
    _request?: Parameters<ExternalEnvironmentClient['runStep']>[0],
    signal?: AbortSignal,
  ): Promise<{ exitCode: number; output: string; truncated: boolean }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => resolve({ exitCode: 0, output: 'too-late', truncated: false }),
        this.delayMs,
      );
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        this.aborted = true;
        reject(new Error('CLIENT_ABORTED'));
      }, { once: true });
    });
  }
}

class SlowSetupExternalClient implements ExternalEnvironmentClient {
  reserveCalls = 0;
  attestCalls = 0;
  private lease: ExternalLease | undefined;
  private attestation: ExternalAttestation | undefined;

  constructor(private readonly delayMs: number) {}

  async lookup(
    _request: Parameters<ExternalEnvironmentClient['lookup']>[0],
    signal?: AbortSignal,
  ): Promise<ExternalClientInspection> {
    await abortableTestDelay(this.delayMs, signal);
    return this.currentInspection();
  }

  async reserve(
    request: Parameters<ExternalEnvironmentClient['reserve']>[0],
    signal?: AbortSignal,
  ): Promise<ExternalLease> {
    this.reserveCalls += 1;
    await abortableTestDelay(this.delayMs, signal);
    this.lease = {
      leaseId: 'lease-slow-setup',
      namespace: request.namespace,
      ownerRunId: request.idempotencyKey,
      exclusive: true,
    };
    return this.lease;
  }

  async publish(
    request: Parameters<ExternalEnvironmentClient['publish']>[0],
    signal?: AbortSignal,
  ) {
    await abortableTestDelay(this.delayMs, signal);
    return request.publication;
  }

  async attest(
    request: Parameters<ExternalEnvironmentClient['attest']>[0],
    signal?: AbortSignal,
  ): Promise<ExternalAttestation> {
    this.attestCalls += 1;
    await abortableTestDelay(this.delayMs, signal);
    this.attestation = request.expected;
    return request.expected;
  }

  async runStep(): Promise<{ exitCode: number; output: string; truncated: boolean }> {
    return { exitCode: 0, output: '', truncated: false };
  }

  async inspect(): Promise<ExternalClientInspection> {
    return this.currentInspection();
  }

  async release(): Promise<void> {
    this.lease = undefined;
    this.attestation = undefined;
  }

  private currentInspection(): ExternalClientInspection {
    return this.lease === undefined
      ? { ownership: 'ABSENT' }
      : {
          ownership: 'PROVEN',
          lease: this.lease,
          ...(this.attestation === undefined ? {} : { attestation: this.attestation }),
        };
  }
}

class LateReserveExternalClient implements ExternalEnvironmentClient {
  releaseCalls = 0;
  private lease: ExternalLease | undefined;
  private readonly reservationStarted = deferred<void>();
  private readonly reservationMayComplete = deferred<void>();
  private readonly reservationCompleted = deferred<void>();

  async lookup(): Promise<ExternalClientInspection> {
    return this.currentInspection();
  }

  async reserve(request: Parameters<ExternalEnvironmentClient['reserve']>[0]): Promise<ExternalLease> {
    this.reservationStarted.resolve();
    await this.reservationMayComplete.promise;
    this.lease = {
      leaseId: 'lease-late-reserve',
      namespace: request.namespace,
      ownerRunId: request.idempotencyKey,
      exclusive: true,
    };
    this.reservationCompleted.resolve();
    if (this.lease === undefined) throw new Error('LATE_RESERVE_NOT_COMPLETED');
    return this.lease;
  }

  async waitForReservationStart(): Promise<void> {
    await this.reservationStarted.promise;
  }

  completeReservation(): void {
    this.reservationMayComplete.resolve();
  }

  async waitForReservation(): Promise<void> {
    await this.reservationCompleted.promise;
  }

  async publish(request: Parameters<ExternalEnvironmentClient['publish']>[0]) {
    return request.publication;
  }

  async attest(request: Parameters<ExternalEnvironmentClient['attest']>[0]): Promise<ExternalAttestation> {
    return request.expected;
  }

  async runStep(): Promise<{ exitCode: number; output: string; truncated: boolean }> {
    return { exitCode: 0, output: '', truncated: false };
  }

  async inspect(): Promise<ExternalClientInspection> {
    return this.currentInspection();
  }

  async release(): Promise<void> {
    this.releaseCalls += 1;
    this.lease = undefined;
  }

  private currentInspection(): ExternalClientInspection {
    return this.lease === undefined
      ? { ownership: 'ABSENT' }
      : { ownership: 'PROVEN', lease: this.lease };
  }
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function abortableTestDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('CLIENT_ABORTED'));
    }, { once: true });
  });
}

function ownedProcessTreeScript(pidPath: string): string {
  const append = `require('fs').appendFileSync(${JSON.stringify(pidPath)}, String(process.pid) + '\\n')`;
  const keepAlive = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`;
  const grandchild = `${append}; ${keepAlive}`;
  const child = [
    append,
    `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' })`,
    keepAlive,
  ].join('; ');
  return [
    append,
    `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'ignore' })`,
    keepAlive,
  ].join('; ');
}

function residualProcessScript(pidPath: string): string {
  const child = [
    `require('fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid))`,
    `process.on('SIGTERM', () => {})`,
    `setInterval(() => {}, 1000)`,
  ].join('; ');
  return [
    `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'ignore' }).unref()`,
    `const timer = setInterval(() => { if (require('fs').existsSync(${JSON.stringify(pidPath)})) { clearInterval(timer); process.exit(0) } }, 5)`,
  ].join('; ');
}

function detachedProcessScript(pidPath: string): string {
  const child = [
    `require('fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid))`,
    `process.on('SIGTERM', () => {})`,
    `setInterval(() => {}, 1000)`,
  ].join('; ');
  return [
    `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { detached: true, stdio: 'ignore' }).unref()`,
    `const timer = setInterval(() => { if (require('fs').existsSync(${JSON.stringify(pidPath)})) { clearInterval(timer); setTimeout(() => process.exit(0), 250) } }, 5)`,
  ].join('; ');
}

async function waitForProcessIds(path: string, count: number): Promise<number[]> {
  let ids: number[] = [];
  await waitForCondition(async () => {
    try {
      ids = (await readFile(path, 'utf8'))
        .trim()
        .split(/\s+/u)
        .filter((value) => value.length > 0)
        .map(Number);
      return new Set(ids).size >= count;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    }
  });
  return [...new Set(ids)];
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error('TEST_CONDITION_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function processIsLive(pid: number): boolean {
  try {
    const state = requireProcessState(pid);
    if (state === 'Z' || state === 'X') return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    return false;
  }
}

function requireProcessState(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(') ') + 2).split(' ', 1)[0];
  } catch {
    return undefined;
  }
}

async function allPersistedText(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  const values: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) values.push(await allPersistedText(path));
    else if (entry.isFile()) values.push(await readFile(path, 'utf8'));
  }
  return values.join('\n');
}
