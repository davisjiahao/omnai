import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import YAML from 'yaml';
import { readYaml, writeYaml } from '../src/core/files.js';
import {
  agentConformanceInputHash,
  defaultAgentProfileForHost,
  loadAgentProfiles,
  probeAgent,
  recordAgentConformance,
  selectAgent,
} from '../src/execution/agents/profiles.js';
import {
  agentProbeSchema,
  agentProfileSchema,
  type AgentProbe,
  type AgentProfile,
  type AgentSelectionRequest,
} from '../src/execution/agents/types.js';
import {
  ENTRY_SKILLS,
  getUserHostSkillStatus,
  installUserHostSkills,
  userHostManifestSchema,
} from '../src/host/user-host-skills.js';
import { hostManifestPath } from '../src/workspace/paths.js';
import { createTestDirectory } from './helpers.js';

const NOW = '2026-08-16T12:00:00.000Z';
const CURRENT_INPUT_HASH = hash('current-launch');
const EVIDENCE_HASH = hash('evidence');
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

test('loads an old host manifest as an empty Agent profile list', async () => {
  const fixture = await createHome();
  await writeYaml(hostManifestPath(fixture.omnaiHome, 'codex'), legacyManifest('codex', '/tmp/skills'));

  assert.deepEqual(await loadAgentProfiles(fixture.omnaiHome), []);
  assert.deepEqual(userHostManifestSchema.parse(legacyManifest('codex', '/tmp/skills')).agents, []);
});

test('new Host install seeds one unproven standard ACP profile without claiming readiness', async () => {
  const fixture = await createHostFixture();
  await installUserHostSkills(fixture.omnaiHome, fixture.userHome, ['codex'], fixture.sourceRoot);

  const [configured] = await loadAgentProfiles(fixture.omnaiHome);
  assert.deepEqual(
    {
      agentId: configured?.agentId,
      command: configured?.command,
      args: configured?.args,
      conformance: configured?.conformance,
    },
    { agentId: 'codex', command: 'codex-acp', args: [], conformance: undefined },
  );
  assert.deepEqual(configured, defaultAgentProfileForHost('codex'));
  assert.equal(Object.hasOwn(configured ?? {}, 'available'), false);
  assert.equal(Object.hasOwn(configured ?? {}, 'authenticated'), false);
  assert.equal(Object.hasOwn(configured ?? {}, 'activeSessions'), false);
});

test('Host update seeds a legacy manifest with no agents field but preserves an explicitly empty list', async () => {
  const legacy = await createHostFixture();
  const explicitEmpty = await createHostFixture();
  await installUserHostSkills(legacy.omnaiHome, legacy.userHome, ['codex'], legacy.sourceRoot);
  await installUserHostSkills(explicitEmpty.omnaiHome, explicitEmpty.userHome, ['codex'], explicitEmpty.sourceRoot);

  const legacyPath = hostManifestPath(legacy.omnaiHome, 'codex');
  const legacyRaw = YAML.parse(await readFile(legacyPath, 'utf8')) as Record<string, unknown>;
  delete legacyRaw.agents;
  await writeYaml(legacyPath, legacyRaw);
  const explicitPath = hostManifestPath(explicitEmpty.omnaiHome, 'codex');
  const explicitRaw = YAML.parse(await readFile(explicitPath, 'utf8')) as Record<string, unknown>;
  explicitRaw.agents = [];
  await writeYaml(explicitPath, explicitRaw);

  assert.equal(
    (await getUserHostSkillStatus(legacy.omnaiHome, legacy.userHome, 'codex', legacy.sourceRoot)).status,
    'OUTDATED',
  );
  assert.equal(
    (await getUserHostSkillStatus(
      explicitEmpty.omnaiHome,
      explicitEmpty.userHome,
      'codex',
      explicitEmpty.sourceRoot,
    )).status,
    'READY',
  );
  await installUserHostSkills(legacy.omnaiHome, legacy.userHome, ['codex'], legacy.sourceRoot);
  await installUserHostSkills(explicitEmpty.omnaiHome, explicitEmpty.userHome, ['codex'], explicitEmpty.sourceRoot);

  assert.deepEqual((await loadAgentProfiles(legacy.omnaiHome)).map((item) => item.agentId), ['codex']);
  assert.deepEqual(await loadAgentProfiles(explicitEmpty.omnaiHome), []);
});

test('the three standard launch profiles are conservative, deterministic policy defaults', () => {
  assert.deepEqual(
    (['claude', 'codex', 'opencode'] as const).map((host) => {
      const value = defaultAgentProfileForHost(host);
      return {
        host,
        agentId: value.agentId,
        command: value.command,
        args: value.args,
        isolation: value.isolation,
        capabilities: value.capabilities,
        roles: value.omnaiModes,
        conformance: value.conformance,
      };
    }),
    [
      standardDefault('claude', 'claude-agent-acp', []),
      standardDefault('codex', 'codex-acp', []),
      standardDefault('opencode', 'opencode', ['acp']),
    ],
  );
});

test('filters hard requirements before stable ranking', () => {
  const profiles = [
    profile({ agentId: 'zeta', priority: 10, isolation: { mode: 'none', enforcedWorkspaceRoots: false } }),
    profile({ agentId: 'beta', priority: 20, costClass: 'LOW' }),
    profile({ agentId: 'alpha', priority: 20, costClass: 'LOW' }),
  ];
  const probes = profiles.map((item) => probe(item, { activeSessions: 0 }));

  const selected = selectAgent(profiles, probes, writerSelection());
  assert.equal(selected.agentId, 'alpha');
});

test('an explicit Agent cannot waive isolation or capacity', () => {
  const unsafe = profile({
    agentId: 'unsafe',
    maxParallelSessions: 1,
    isolation: { mode: 'none', enforcedWorkspaceRoots: false },
  });
  assert.throws(
    () => selectAgent([unsafe], [probe(unsafe)], writerSelection({ preferredAgentId: 'unsafe' })),
    (error: unknown) => selectionReasons(error).some((reason) =>
      reason.agentId === 'unsafe' && reason.code === 'AGENT_ISOLATION_REQUIRED'),
  );

  const full = profile({ agentId: 'full', maxParallelSessions: 1 });
  assert.throws(
    () => selectAgent([full], [probe(full, { activeSessions: 1 })], writerSelection({ preferredAgentId: 'full' })),
    (error: unknown) => selectionReasons(error).some((reason) =>
      reason.agentId === 'full' && reason.code === 'AGENT_CAPACITY_EXHAUSTED'),
  );
});

test('review selection prefers a different eligible Agent only after stronger ranks tie', () => {
  const profiles = [profile({ agentId: 'codex' }), profile({ agentId: 'claude' })];
  assert.equal(
    selectAgent(
      profiles,
      profiles.map((item) => probe(item)),
      reviewerSelection({ avoidAgentId: 'codex' }),
    ).agentId,
    'claude',
  );

  const preferredOnMerit = [profile({ agentId: 'codex', priority: 10 }), profile({ agentId: 'claude', priority: 20 })];
  assert.equal(
    selectAgent(
      preferredOnMerit,
      preferredOnMerit.map((item) => probe(item)),
      reviewerSelection({ avoidAgentId: 'codex' }),
    ).agentId,
    'codex',
  );
});

test('ranking applies priority, health, load, cost, avoid ID, then code-unit ID in that order', () => {
  const healthy = profile({ agentId: 'healthy' });
  const degraded = profile({ agentId: 'degraded' });
  assert.equal(selectAgent(
    [degraded, healthy],
    [probe(degraded, { health: 'DEGRADED' }), probe(healthy, { health: 'HEALTHY' })],
    reviewerSelection(),
  ).agentId, 'healthy');

  const idle = profile({ agentId: 'idle' });
  const busy = profile({ agentId: 'busy' });
  assert.equal(selectAgent(
    [busy, idle],
    [probe(busy, { activeSessions: 2 }), probe(idle, { activeSessions: 0 })],
    reviewerSelection(),
  ).agentId, 'idle');

  const cheap = profile({ agentId: 'cheap', costClass: 'LOW' });
  const expensive = profile({ agentId: 'expensive', costClass: 'HIGH' });
  assert.equal(selectAgent(
    [expensive, cheap],
    [probe(expensive), probe(cheap)],
    reviewerSelection(),
  ).agentId, 'cheap');

  const lowPriorityAvoided = profile({ agentId: 'low-priority', priority: 1 });
  const highPriority = profile({ agentId: 'high-priority', priority: 2 });
  assert.equal(selectAgent(
    [highPriority, lowPriorityAvoided],
    [probe(highPriority), probe(lowPriorityAvoided)],
    reviewerSelection({ avoidAgentId: 'low-priority' }),
  ).agentId, 'low-priority');
});

test('preferred Agent ID is a hard constraint and missing probes are structured rejections', () => {
  const preferred = profile({ agentId: 'preferred', priority: 999 });
  const otherwiseFirst = profile({ agentId: 'otherwise-first', priority: 1 });
  assert.equal(selectAgent(
    [otherwiseFirst, preferred],
    [probe(otherwiseFirst), probe(preferred)],
    reviewerSelection({ preferredAgentId: 'preferred' }),
  ).agentId, 'preferred');

  assert.throws(
    () => selectAgent([preferred], [], reviewerSelection()),
    (error: unknown) => {
      assert.deepEqual(selectionReasons(error), [
        { agentId: 'preferred', code: 'AGENT_PROBE_MISSING' },
      ]);
      return true;
    },
  );
});

test('writer selection rejects conformance evidence bound to an older launch profile', () => {
  const current = profile({
    agentId: 'codex',
    command: '/opt/current/codex-acp',
    conformance: conformance({ inputHash: hash('old-launch') }),
  });

  assert.throws(
    () => selectAgent(
      [current],
      [probe(current, { conformanceInputHash: hash('current-launch') })],
      writerSelection(),
    ),
    (error: unknown) => selectionReasons(error).some((reason) => reason.code === 'AGENT_CONFORMANCE_STALE'),
  );
});

test('selection reports one deterministic structured first-failure reason per profile', () => {
  const unavailable = profile({ agentId: 'unavailable' });
  const wrongRole = profile({ agentId: 'wrong-role', omnaiModes: ['project-reviewer'] });
  const noMcp = profile({ agentId: 'no-mcp' });
  const stale = profile({ agentId: 'stale', conformance: conformance({ inputHash: hash('stale') }) });

  assert.throws(
    () => selectAgent(
      [wrongRole, stale, unavailable, noMcp],
      [
        probe(wrongRole),
        probe(stale),
        probe(unavailable, { available: false, authenticated: false }),
        probe(noMcp, { capabilities: { ...noMcp.capabilities, mcpStdio: false } }),
      ],
      writerSelection({ requiredMcpTools: ['contract-reader'] }),
    ),
    (error: unknown) => {
      assert.match(String(error), /^AgentSelectionError: AGENT_NOT_ELIGIBLE:/);
      assert.deepEqual(selectionReasons(error), [
        { agentId: 'no-mcp', code: 'AGENT_MCP_STDIO_REQUIRED' },
        { agentId: 'stale', code: 'AGENT_CONFORMANCE_STALE' },
        { agentId: 'unavailable', code: 'AGENT_UNAVAILABLE' },
        { agentId: 'wrong-role', code: 'AGENT_ROLE_UNSUPPORTED' },
      ]);
      return true;
    },
  );
});

test('selection requires negotiated recovery capability and current conformance', () => {
  const noRecovery = profile({ agentId: 'no-recovery' });
  const noEvidence = profile({ agentId: 'no-evidence', conformance: undefined });

  assert.throws(
    () => selectAgent(
      [noRecovery, noEvidence],
      [
        probe(noRecovery, { capabilities: { ...noRecovery.capabilities, loadSession: false, resumeSession: false } }),
        probe(noEvidence),
      ],
      writerSelection(),
    ),
    (error: unknown) => {
      assert.deepEqual(selectionReasons(error), [
        { agentId: 'no-evidence', code: 'AGENT_CONFORMANCE_MISSING' },
        { agentId: 'no-recovery', code: 'AGENT_RECOVERY_UNSUPPORTED' },
      ]);
      return true;
    },
  );
});

test('selection represents and rejects a negotiated unsupported protocol version structurally', () => {
  const incompatible = profile({ agentId: 'incompatible' });
  const incompatibleProbe = agentProbeSchema.parse({
    ...probe(incompatible),
    protocolVersion: 2,
  });

  assert.throws(
    () => selectAgent([incompatible], [incompatibleProbe], reviewerSelection()),
    (error: unknown) => {
      assert.deepEqual(selectionReasons(error), [
        { agentId: 'incompatible', code: 'AGENT_PROTOCOL_VERSION_UNSUPPORTED' },
      ]);
      return true;
    },
  );
});

test('duplicate configured profile IDs and duplicate probe IDs fail closed', async () => {
  const duplicate = profile({ agentId: 'duplicate' });
  assert.throws(
    () => selectAgent([duplicate, duplicate], [probe(duplicate)], writerSelection()),
    /AGENT_PROFILE_ID_DUPLICATE/,
  );
  assert.throws(
    () => selectAgent([duplicate], [probe(duplicate), probe(duplicate)], writerSelection()),
    /AGENT_PROBE_ID_DUPLICATE/,
  );

  const fixture = await createHome();
  await writeYaml(hostManifestPath(fixture.omnaiHome, 'codex'), {
    ...legacyManifest('codex', '/tmp/codex-skills'),
    agents: [duplicate],
  });
  await writeYaml(hostManifestPath(fixture.omnaiHome, 'claude'), {
    ...legacyManifest('claude', '/tmp/claude-skills'),
    agents: [duplicate],
  });
  await assert.rejects(() => loadAgentProfiles(fixture.omnaiHome), /AGENT_PROFILE_ID_DUPLICATE/);
});

test('conformance input hash binds canonical launch policy and resolved executable bytes', async () => {
  const fixture = await createHome();
  const executable = join(fixture.omnaiHome, 'agent');
  await writeFile(executable, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(executable, 0o755);
  const original = profile({ agentId: 'bound', command: executable });

  const first = await agentConformanceInputHash(original, executable);
  const evidenceOnly = await agentConformanceInputHash(
    { ...original, conformance: conformance({ inputHash: hash('unrelated') }) },
    executable,
  );
  assert.equal(evidenceOnly, first);

  await writeFile(executable, '#!/bin/sh\nexit 7\n', 'utf8');
  const changedBinary = await agentConformanceInputHash(original, executable);
  assert.notEqual(changedBinary, first);
  const changedPolicy = await agentConformanceInputHash({ ...original, maxParallelSessions: 9 }, executable);
  assert.notEqual(changedPolicy, changedBinary);

  const changedArguments = await agentConformanceInputHash({ ...original, args: ['--mode', 'safe'] }, executable);
  const changedEnvReference = await agentConformanceInputHash(
    { ...original, envRefs: { API_TOKEN: 'secret:agent-token' } },
    executable,
  );
  assert.notEqual(changedArguments, changedBinary);
  assert.notEqual(changedEnvReference, changedBinary);

  const envBound = { ...original, envRefs: { API_TOKEN: 'secret:agent-token' } };
  const previousSecret = process.env.API_TOKEN;
  let firstResolvedValue: string;
  let secondResolvedValue: string;
  try {
    process.env.API_TOKEN = 'resolved-one';
    firstResolvedValue = await agentConformanceInputHash(envBound, executable);
    process.env.API_TOKEN = 'resolved-two';
    secondResolvedValue = await agentConformanceInputHash(envBound, executable);
  } finally {
    if (previousSecret === undefined) delete process.env.API_TOKEN;
    else process.env.API_TOKEN = previousSecret;
  }
  assert.equal(firstResolvedValue, secondResolvedValue);
});

test('recordAgentConformance compare-and-swaps the exact current profile and executable input hash', async () => {
  const fixture = await createHome();
  const executable = join(fixture.omnaiHome, 'agent');
  await writeFile(executable, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(executable, 0o755);
  const configured = profile({ agentId: 'bound', command: executable, conformance: undefined });
  const untouched = rawConfiguredProfile('untouched', executable);
  await writeYaml(hostManifestPath(fixture.omnaiHome, 'codex'), {
    ...legacyManifest('codex', '/tmp/skills'),
    agents: [untouched, configured],
  });
  const expectedInputHash = await agentConformanceInputHash(configured, executable);
  const evidence = conformance({ inputHash: expectedInputHash });

  const updated = await recordAgentConformance(
    fixture.omnaiHome,
    configured.agentId,
    expectedInputHash,
    evidence,
  );
  assert.deepEqual(updated.conformance, evidence);
  assert.deepEqual((await loadAgentProfiles(fixture.omnaiHome)).find((item) => item.agentId === 'bound')?.conformance, evidence);
  const persistedRaw = YAML.parse(
    await readFile(hostManifestPath(fixture.omnaiHome, 'codex'), 'utf8'),
  ) as { agents: unknown[] };
  assert.deepEqual(persistedRaw.agents[0], untouched);

  await writeFile(executable, '#!/bin/sh\nexit 2\n', 'utf8');
  await assert.rejects(
    () => recordAgentConformance(fixture.omnaiHome, configured.agentId, expectedInputHash, evidence),
    /AGENT_CONFORMANCE_CAS_MISMATCH/,
  );
  assert.deepEqual((await loadAgentProfiles(fixture.omnaiHome)).find((item) => item.agentId === 'bound')?.conformance, evidence);
});

test('concurrent conformance records serialize both acquisition orders without losing evidence', async (context) => {
  for (const firstAgentId of ['first', 'second'] as const) {
    await context.test(`${firstAgentId} acquires first`, async () => {
      const fixture = await createHome();
      const executable = join(fixture.omnaiHome, 'concurrent-agent');
      await writeFile(executable, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(executable, 0o755);
      const profiles = ['first', 'second'].map((agentId) =>
        profile({ agentId, command: executable, conformance: undefined }));
      await writeYaml(hostManifestPath(fixture.omnaiHome, 'codex'), {
        ...legacyManifest('codex', '/tmp/skills'),
        agents: profiles,
      });
      const inputHashes = new Map(await Promise.all(profiles.map(async (configured) => [
        configured.agentId,
        await agentConformanceInputHash(configured, executable),
      ] as const)));
      const firstEntered = deferred();
      const releaseFirst = deferred();
      let secondFinished = false;
      const secondAgentId = firstAgentId === 'first' ? 'second' : 'first';

      const first = recordAgentConformance(
        fixture.omnaiHome,
        firstAgentId,
        inputHashes.get(firstAgentId)!,
        conformance({
          inputHash: inputHashes.get(firstAgentId)!,
          evidenceHash: hash(`${firstAgentId}-evidence`),
        }),
        {
          timeoutMs: 1_000,
          faults: {
            afterOwnerPublished: async () => {
              firstEntered.resolve();
              await releaseFirst.promise;
            },
          },
        },
      );
      try {
        await firstEntered.promise;
        const second = recordAgentConformance(
          fixture.omnaiHome,
          secondAgentId,
          inputHashes.get(secondAgentId)!,
          conformance({
            inputHash: inputHashes.get(secondAgentId)!,
            evidenceHash: hash(`${secondAgentId}-evidence`),
          }),
          { timeoutMs: 1_000 },
        ).then((value) => {
          secondFinished = true;
          return value;
        });
        await delay(25);
        assert.equal(secondFinished, false, 'the second evidence writer must wait for the shared Host lock');
        releaseFirst.resolve();
        await Promise.all([first, second]);
      } finally {
        releaseFirst.resolve();
      }

      const persisted = await loadAgentProfiles(fixture.omnaiHome);
      for (const configured of profiles) {
        assert.equal(
          persisted.find((item) => item.agentId === configured.agentId)?.conformance?.evidenceHash,
          hash(`${configured.agentId}-evidence`),
        );
      }
    });
  }
});

test('Host install and conformance recording share one lock in both interleaving directions', async (context) => {
  for (const firstOperation of ['install', 'evidence'] as const) {
    await context.test(`${firstOperation} acquires first`, async () => {
      const fixture = await createHostFixture();
      await installUserHostSkills(fixture.omnaiHome, fixture.userHome, ['codex'], fixture.sourceRoot);
      const executable = join(fixture.omnaiHome, 'install-race-agent');
      await writeFile(executable, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(executable, 0o755);
      const configured = profile({ agentId: 'install-race', command: executable, conformance: undefined });
      const manifestPath = hostManifestPath(fixture.omnaiHome, 'codex');
      const raw = YAML.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      raw.agents = [configured];
      await writeYaml(manifestPath, raw);
      const inputHash = await agentConformanceInputHash(configured, executable);
      const evidence = conformance({ inputHash, evidenceHash: hash(`${firstOperation}-race-evidence`) });
      const upgradedSkill = '# omnai\n\nConcurrent upgrade.\n';
      await writeFile(join(fixture.sourceRoot, 'omnai', 'SKILL.md'), upgradedSkill, 'utf8');

      const firstEntered = deferred();
      const releaseFirst = deferred();
      let secondFinished = false;
      const lockOptions = {
        timeoutMs: 1_000,
        faults: {
          afterOwnerPublished: async () => {
            firstEntered.resolve();
            await releaseFirst.promise;
          },
        },
      };
      const install = (options = {}) => installUserHostSkills(
        fixture.omnaiHome,
        fixture.userHome,
        ['codex'],
        fixture.sourceRoot,
        options,
      );
      const record = (options = {}) => recordAgentConformance(
        fixture.omnaiHome,
        configured.agentId,
        inputHash,
        evidence,
        options,
      );
      const first = firstOperation === 'install' ? install(lockOptions) : record(lockOptions);
      try {
        await firstEntered.promise;
        const second = (firstOperation === 'install' ? record({ timeoutMs: 1_000 }) : install({ timeoutMs: 1_000 }))
          .then((value) => {
            secondFinished = true;
            return value;
          });
        await delay(25);
        assert.equal(secondFinished, false, 'the second Host writer must wait for the shared lock');
        releaseFirst.resolve();
        await Promise.all([first, second]);
      } finally {
        releaseFirst.resolve();
      }

      const persisted = (await loadAgentProfiles(fixture.omnaiHome)).find((item) => item.agentId === configured.agentId);
      assert.deepEqual(persisted?.conformance, evidence);
      assert.equal(
        await readFile(join(fixture.userHome, '.agents', 'skills', 'omnai', 'SKILL.md'), 'utf8'),
        upgradedSkill,
      );
      assert.equal(
        (await getUserHostSkillStatus(
          fixture.omnaiHome,
          fixture.userHome,
          'codex',
          fixture.sourceRoot,
        )).status,
        'READY',
      );
    });
  }
});

test('probe performs ACP v1 initialize, maps lifecycle capabilities, and checks session/list usability', async () => {
  const fixture = await createScriptedAcpProbeFixture('success');
  const result = await probeAgent(fixture.profile);
  assert.deepEqual(
    {
      available: result.available,
      authenticated: result.authenticated,
      protocolVersion: result.protocolVersion,
      health: result.health,
      activeSessions: result.activeSessions,
      capabilities: result.capabilities,
      hasBoundHash: typeof result.conformanceInputHash === 'string',
    },
    {
      available: true,
      authenticated: true,
      protocolVersion: 1,
      health: 'HEALTHY',
      activeSessions: 0,
      capabilities: {
        loadSession: true,
        resumeSession: true,
        closeSession: true,
        additionalDirectories: true,
        mcpStdio: true,
      },
      hasBoundHash: true,
    },
  );
  assert.deepEqual((await readFile(fixture.callsPath, 'utf8')).trim().split('\n'), [
    'initialize',
    'session/list',
  ]);
  await assertProbeProcessReaped(fixture.pidPath);
});

test('probe reports advertised or list-confirmed authentication requirements without attempting login', async () => {
  const fixture = await createScriptedAcpProbeFixture('auth-required');
  const previousSecret = process.env.SOURCE_PROBE_SECRET;
  process.env.SOURCE_PROBE_SECRET = 'resolved-probe-secret';
  let result: AgentProbe;
  try {
    result = await probeAgent(fixture.profile);
  } finally {
    if (previousSecret === undefined) delete process.env.SOURCE_PROBE_SECRET;
    else process.env.SOURCE_PROBE_SECRET = previousSecret;
  }
  assert.equal(result.available, true);
  assert.equal(result.authenticated, false);
  assert.equal(result.protocolVersion, 1);
  assert.equal(result.activeSessions, 0);
  assert.equal(JSON.stringify(result).includes('resolved-probe-secret'), false);
  assert.equal(JSON.stringify(result).includes('login-required-with-secret'), false);
  assert.deepEqual((await readFile(fixture.callsPath, 'utf8')).trim().split('\n'), [
    'initialize',
    'session/list',
  ]);
  await assertProbeProcessReaped(fixture.pidPath);
});

test('probe without session/list cannot prove runtime authentication from advertised auth capabilities', async () => {
  for (const behavior of ['no-auth-no-list', 'auth-no-list'] as const) {
    const fixture = await createScriptedAcpProbeFixture(behavior);
    const result = await probeAgent(fixture.profile);
    assert.equal(result.available, true);
    assert.equal(result.authenticated, false);
    assert.equal(result.protocolVersion, 1);
    assert.deepEqual((await readFile(fixture.callsPath, 'utf8')).trim().split('\n'), ['initialize']);
    await assertProbeProcessReaped(fixture.pidPath);
  }
});

test('probe preserves an unsupported negotiated protocol version for deterministic rejection', async () => {
  const fixture = await createScriptedAcpProbeFixture('unsupported-version');
  const result = await probeAgent(fixture.profile);
  assert.equal(result.available, true);
  assert.equal(result.authenticated, false);
  assert.equal(result.protocolVersion, 2);
  assert.equal(result.health, 'DEGRADED');
  assert.deepEqual(result.capabilities, {
    loadSession: false,
    resumeSession: false,
    closeSession: false,
    additionalDirectories: false,
    mcpStdio: false,
  });
  assert.deepEqual((await readFile(fixture.callsPath, 'utf8')).trim().split('\n'), ['initialize']);
  await assertProbeProcessReaped(fixture.pidPath);
});

test('probe rejects syntactically valid non-responses before the SDK can log peer secrets', async (context) => {
  for (const [behavior, secret] of [
    ['valid-non-rpc', 'valid-non-rpc-secret-must-not-leak'],
    ['unexpected-request', 'unexpected-request-secret-must-not-leak'],
    ['unmatched-response', 'unmatched-response-secret-must-not-leak'],
  ] as const) {
    await context.test(behavior, async () => {
      const fixture = await createScriptedAcpProbeFixture(behavior);
      const captured = await captureProbeConsole(() => probeAgent(fixture.profile));
      assert.equal(captured.result.available, false);
      assert.equal(captured.result.error, 'AGENT_PROBE_PROTOCOL_INVALID');
      assert.equal(JSON.stringify(captured).includes(secret), false);
      await assertProbeProcessReaped(fixture.pidPath);
    });
  }
});

test('probe rejects matched ACP responses with malformed method payloads without leaking secrets', async (context) => {
  for (const [behavior, secret] of [
    ['malformed-initialize-result', 'malformed-initialize-secret-must-not-leak'],
    ['malformed-list-result', 'malformed-list-secret-must-not-leak'],
    ['invalid-version-zero', 'invalid-version-secret-must-not-leak'],
  ] as const) {
    await context.test(behavior, async () => {
      const fixture = await createScriptedAcpProbeFixture(behavior);
      const captured = await captureProbeConsole(() => probeAgent(fixture.profile));
      assert.equal(captured.result.available, false);
      assert.equal(captured.result.error, 'AGENT_PROBE_PROTOCOL_INVALID');
      assert.equal(JSON.stringify(captured).includes(secret), false);
      await assertProbeProcessReaped(fixture.pidPath);
    });
  }
});

test('probe child receives only platform essentials and explicitly mapped environment values', async () => {
  const fixture = await createScriptedAcpProbeFixture('success');
  const previousMapped = process.env.SOURCE_PROBE_SECRET;
  const previousUnrelated = process.env.UNRELATED_PROBE_SECRET;
  process.env.SOURCE_PROBE_SECRET = 'mapped-secret-reaches-target';
  process.env.UNRELATED_PROBE_SECRET = 'unrelated-secret-must-not-reach-agent';
  let captured: { result: AgentProbe; consoleOutput: unknown[][] };
  try {
    captured = await captureProbeConsole(() => probeAgent(fixture.profile));
  } finally {
    if (previousMapped === undefined) delete process.env.SOURCE_PROBE_SECRET;
    else process.env.SOURCE_PROBE_SECRET = previousMapped;
    if (previousUnrelated === undefined) delete process.env.UNRELATED_PROBE_SECRET;
    else process.env.UNRELATED_PROBE_SECRET = previousUnrelated;
  }
  const childEnvironment = JSON.parse(await readFile(fixture.environmentPath, 'utf8')) as {
    mapped: string | null;
    unrelated: string | null;
    pathPresent: boolean;
  };
  assert.deepEqual(childEnvironment, {
    mapped: 'mapped-secret-reaches-target',
    unrelated: null,
    pathPresent: true,
  });
  assert.equal(JSON.stringify(captured).includes('mapped-secret-reaches-target'), false);
  assert.equal(JSON.stringify(captured).includes('unrelated-secret-must-not-reach-agent'), false);
});

test('POSIX probe cleanup terminates an ordinary grandchild in the dedicated process group', {
  skip: process.platform === 'win32',
}, async () => {
  const fixture = await createScriptedAcpProbeFixture('grandchild');
  try {
    const result = await probeAgent(fixture.profile);
    assert.equal(result.available, true);
    await assertProbeProcessReaped(fixture.pidPath);
    await assertProbeProcessReaped(fixture.descendantPidPath);
  } finally {
    await forceKillFromPidFile(fixture.descendantPidPath);
  }
});

test('Agent invocation remains shell-free and fails closed for Windows batch shims', async () => {
  const module = await import('../src/execution/agents/profiles.js') as unknown as {
    assertAgentProbePlatformSupported: (platform: NodeJS.Platform) => void;
    buildAgentProcessInvocation: (
      command: string,
      args: readonly string[],
      platform: NodeJS.Platform,
    ) => { command: string; args: string[]; detached: boolean; shell: false };
    buildWindowsTaskkillInvocation: (
      pid: number,
      environment: NodeJS.ProcessEnv,
    ) => { command: string; args: string[]; shell: false };
    spawnAgentProbeProcess: (
      command: string,
      args: readonly string[],
      environment: NodeJS.ProcessEnv,
      platform: NodeJS.Platform,
      spawnProcess: (...args: unknown[]) => unknown,
    ) => unknown;
  };
  assert.doesNotThrow(() => module.assertAgentProbePlatformSupported('linux'));
  assert.throws(
    () => module.assertAgentProbePlatformSupported('win32'),
    /AGENT_PROBE_WINDOWS_PROCESS_TREE_UNSUPPORTED/,
  );
  let spawnCalls = 0;
  assert.throws(
    () => module.spawnAgentProbeProcess('C:\\Agents\\agent.exe', [], {}, 'win32', () => {
      spawnCalls += 1;
      return {};
    }),
    /AGENT_PROBE_WINDOWS_PROCESS_TREE_UNSUPPORTED/,
  );
  assert.equal(spawnCalls, 0, 'the Windows safety guard must run before spawn');
  assert.deepEqual(module.buildAgentProcessInvocation('/opt/agent', ['literal;argument'], 'linux'), {
    command: '/opt/agent',
    args: ['literal;argument'],
    detached: true,
    shell: false,
  });
  assert.deepEqual(module.buildAgentProcessInvocation('C:\\Agents\\agent.exe', ['& calc.exe'], 'win32'), {
    command: 'C:\\Agents\\agent.exe',
    args: ['& calc.exe'],
    detached: false,
    shell: false,
  });
  assert.throws(
    () => module.buildAgentProcessInvocation('C:\\Agents\\agent.CMD', ['safe'], 'win32'),
    /AGENT_PROBE_WINDOWS_BATCH_UNSUPPORTED/,
  );
  assert.deepEqual(module.buildWindowsTaskkillInvocation(1234, { SystemRoot: 'C:\\Windows' }), {
    command: 'C:\\Windows\\System32\\taskkill.exe',
    args: ['/PID', '1234', '/T', '/F'],
    shell: false,
  });
});

test('probe contains stdio errors when a command exits before initialization', {
  skip: process.platform === 'win32',
}, async () => {
  const result = await probeAgent(profile({
    agentId: 'immediate-exit',
    command: '/bin/false',
    args: [],
    conformance: undefined,
  }));
  assert.equal(result.available, false);
  assert.match(result.error ?? '', /^AGENT_PROBE_(?:PROCESS_EXIT|PROCESS_IO)$/);
});

test('probe bounds malformed, hanging, excessive-output, and exiting ACP subprocesses and always reaps them', async (context) => {
  for (const behavior of ['malformed', 'hang', 'stdout-flood', 'stderr-flood', 'unexpected-exit'] as const) {
    await context.test(behavior, async () => {
      const fixture = await createScriptedAcpProbeFixture(behavior);
      const consoleOutput: unknown[][] = [];
      const originalError = console.error;
      const originalWarn = console.warn;
      if (behavior === 'malformed') {
        console.error = (...args: unknown[]) => consoleOutput.push(args);
        console.warn = (...args: unknown[]) => consoleOutput.push(args);
      }
      let result: AgentProbe;
      try {
        result = await probeAgent(fixture.profile);
      } finally {
        console.error = originalError;
        console.warn = originalWarn;
      }
      assert.equal(result.available, false);
      assert.equal(result.authenticated, false);
      assert.equal(result.protocolVersion, null);
      assert.equal(typeof result.conformanceInputHash, 'string');
      assert.match(result.error ?? '', /^AGENT_PROBE_[A-Z_]+$/);
      assert.equal(JSON.stringify(result).includes('peer-secret-must-not-leak'), false);
      assert.equal(JSON.stringify(consoleOutput).includes('peer-secret-must-not-leak'), false);
      await assertProbeProcessReaped(fixture.pidPath);
    });
  }
});

test('probe does not execute unsupported Native profiles and missing commands stay unavailable', async () => {
  const native = profile({ agentId: 'native', protocol: 'native', command: process.execPath });
  const nativeResult = await probeAgent(native);
  assert.equal(nativeResult.available, false);
  assert.equal(nativeResult.authenticated, false);
  assert.equal(nativeResult.protocolVersion, null);
  assert.equal(nativeResult.error, 'AGENT_NATIVE_PROBE_UNPROVEN');
  assert.equal(typeof nativeResult.conformanceInputHash, 'string');

  const missing = await probeAgent(profile({ agentId: 'missing', command: 'definitely-not-an-agent' }));
  assert.equal(missing.available, false);
  assert.equal(missing.authenticated, false);
  assert.equal(missing.conformanceInputHash, undefined);
});

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  const base = agentProfileSchema.parse({
    schemaVersion: 1,
    agentId: 'codex',
    protocol: 'acp',
    command: 'codex-acp',
    args: [],
    envRefs: {},
    protocolVersion: 1,
    priority: 100,
    costClass: 'MEDIUM',
    maxParallelSessions: 3,
    isolation: { mode: 'agent-sandbox', enforcedWorkspaceRoots: true },
    capabilities: standardCapabilities(),
    omnaiModes: ['coordination-read-only', 'project-writer', 'project-reviewer'],
    conformance: conformance(),
  });
  return agentProfileSchema.parse({ ...base, ...overrides });
}

function probe(item: AgentProfile, overrides: Partial<AgentProbe> = {}): AgentProbe {
  return {
    schemaVersion: 1,
    agentId: item.agentId,
    available: true,
    authenticated: true,
    protocolVersion: 1,
    health: 'HEALTHY',
    activeSessions: 0,
    capabilities: item.capabilities,
    conformanceInputHash: CURRENT_INPUT_HASH,
    ...overrides,
  };
}

function conformance(
  overrides: Partial<NonNullable<AgentProfile['conformance']>> = {},
): NonNullable<AgentProfile['conformance']> {
  return {
    suiteVersion: 1,
    passedAt: NOW,
    inputHash: CURRENT_INPUT_HASH,
    evidenceHash: EVIDENCE_HASH,
    ...overrides,
  };
}

function writerSelection(overrides: Partial<AgentSelectionRequest> = {}): AgentSelectionRequest {
  return {
    role: 'project-writer',
    protocolVersion: 1,
    requireIsolation: true,
    requireResume: true,
    preferredAgentId: undefined,
    avoidAgentId: undefined,
    ...overrides,
  };
}

function reviewerSelection(overrides: Partial<AgentSelectionRequest> = {}): AgentSelectionRequest {
  return {
    role: 'project-reviewer',
    protocolVersion: 1,
    requireIsolation: false,
    requireResume: false,
    preferredAgentId: undefined,
    avoidAgentId: undefined,
    ...overrides,
  };
}

function selectionReasons(error: unknown): Array<{ agentId: string; code: string }> {
  if (!(error instanceof Error) || !('rejections' in error) || !Array.isArray(error.rejections)) return [];
  return error.rejections.map((item) => {
    assert.equal(typeof item, 'object');
    assert.notEqual(item, null);
    return {
      agentId: String((item as Record<string, unknown>).agentId),
      code: String((item as Record<string, unknown>).code),
    };
  });
}

function standardDefault(host: string, command: string, args: string[]) {
  return {
    host,
    agentId: host,
    command,
    args,
    isolation: { mode: 'agent-sandbox', enforcedWorkspaceRoots: true },
    capabilities: standardCapabilities(),
    roles: ['coordination-read-only', 'project-writer', 'project-reviewer'],
    conformance: undefined,
  };
}

function standardCapabilities() {
  return {
    loadSession: true,
    resumeSession: true,
    closeSession: true,
    additionalDirectories: true,
    mcpStdio: true,
  };
}

function hash(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function legacyManifest(host: 'claude' | 'codex' | 'opencode', destination: string) {
  return {
    schemaVersion: 1,
    host,
    omnaiVersion: '0.2.0',
    destination,
    skills: [],
    installedAt: NOW,
    updatedAt: NOW,
  };
}

function rawConfiguredProfile(agentId: string, command: string) {
  return {
    schemaVersion: 1,
    agentId,
    protocol: 'acp',
    command,
    protocolVersion: 1,
    maxParallelSessions: 2,
    isolation: { mode: 'agent-sandbox', enforcedWorkspaceRoots: true },
    capabilities: standardCapabilities(),
    omnaiModes: ['project-reviewer'],
  };
}

async function createHome() {
  const fixture = await createTestDirectory('omnai-agent-profile-');
  cleanups.push(fixture.cleanup);
  return { omnaiHome: fixture.root };
}

async function createHostFixture() {
  const omnaiHome = await createTestDirectory('omnai-agent-home-');
  const userHome = await createTestDirectory('omnai-agent-user-');
  const sourceRoot = await createTestDirectory('omnai-agent-skills-');
  cleanups.push(sourceRoot.cleanup, userHome.cleanup, omnaiHome.cleanup);
  for (const skill of ENTRY_SKILLS) {
    const directory = join(sourceRoot.root, skill);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), `# ${skill}\n`, 'utf8');
  }
  return { omnaiHome: omnaiHome.root, userHome: userHome.root, sourceRoot: sourceRoot.root };
}

type ScriptedProbeBehavior =
  | 'success'
  | 'auth-required'
  | 'no-auth-no-list'
  | 'auth-no-list'
  | 'unsupported-version'
  | 'valid-non-rpc'
  | 'unexpected-request'
  | 'unmatched-response'
  | 'malformed-initialize-result'
  | 'malformed-list-result'
  | 'invalid-version-zero'
  | 'grandchild'
  | 'malformed'
  | 'hang'
  | 'stdout-flood'
  | 'stderr-flood'
  | 'unexpected-exit';

async function createScriptedAcpProbeFixture(behavior: ScriptedProbeBehavior) {
  const fixture = await createHome();
  const scriptPath = join(fixture.omnaiHome, 'scripted-acp-probe.mjs');
  const pidPath = join(fixture.omnaiHome, `${behavior}.pid`);
  const callsPath = join(fixture.omnaiHome, `${behavior}.calls`);
  const environmentPath = join(fixture.omnaiHome, `${behavior}.environment.json`);
  const descendantPidPath = join(fixture.omnaiHome, `${behavior}.descendant.pid`);
  await writeFile(scriptPath, SCRIPTED_ACP_PROBE, 'utf8');
  return {
    pidPath,
    callsPath,
    environmentPath,
    descendantPidPath,
    profile: profile({
      agentId: `probe-${behavior}`,
      command: process.execPath,
      args: [scriptPath, behavior, pidPath, callsPath, environmentPath, descendantPidPath],
      envRefs: { PROBE_SECRET: 'SOURCE_PROBE_SECRET' },
      conformance: undefined,
    }),
  };
}

async function assertProbeProcessReaped(pidPath: string): Promise<void> {
  let pid: number | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      pid = Number(await readFile(pidPath, 'utf8'));
      break;
    } catch {
      await delay(10);
    }
  }
  assert.equal(Number.isInteger(pid), true, `missing probe PID at ${pidPath}`);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid!, 0);
      await delay(10);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return;
      throw error;
    }
  }
  assert.fail(`probe subprocess ${pid} was not reaped`);
}

async function forceKillFromPidFile(pidPath: string): Promise<void> {
  try {
    const pid = Number(await readFile(pidPath, 'utf8'));
    if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH'))) {
      throw error;
    }
  }
}

async function captureProbeConsole<T>(action: () => Promise<T>): Promise<{
  result: T;
  consoleOutput: unknown[][];
}> {
  const consoleOutput: unknown[][] = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args: unknown[]) => consoleOutput.push(args);
  console.warn = (...args: unknown[]) => consoleOutput.push(args);
  try {
    return { result: await action(), consoleOutput };
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
}

function deferred() {
  let resolvePromise!: () => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

const SCRIPTED_ACP_PROBE = String.raw`
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const behavior = process.argv[2];
const pidPath = process.argv[3];
const callsPath = process.argv[4];
const environmentPath = process.argv[5];
const descendantPidPath = process.argv[6];
writeFileSync(pidPath, String(process.pid));
writeFileSync(environmentPath, JSON.stringify({
  mapped: process.env.PROBE_SECRET ?? null,
  unrelated: process.env.UNRELATED_PROBE_SECRET ?? null,
  pathPresent: typeof process.env.PATH === 'string',
}));
process.stderr.write(process.env.PROBE_SECRET ?? 'peer-secret-must-not-leak');
if (behavior === 'stderr-flood') process.stderr.write('x'.repeat(64 * 1024 + 1));
if (behavior === 'hang') process.on('SIGTERM', () => undefined);

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    appendFileSync(callsPath, request.method + '\n');
    if (request.method === 'initialize') handleInitialize(request);
    else if (request.method === 'session/list') handleList(request);
  }
});
process.stdin.on('end', () => process.exit(0));

function handleInitialize(request) {
  if (behavior === 'hang') return;
  if (behavior === 'unexpected-exit') process.exit(7);
  if (behavior === 'stdout-flood') {
    process.stdout.write('x'.repeat(1024 * 1024 + 1));
    return;
  }
  if (behavior === 'malformed') {
    process.stdout.write('not-json-peer-secret-must-not-leak\n');
    process.exit(0);
  }
  if (behavior === 'valid-non-rpc') {
    process.stdout.write(JSON.stringify({ secret: 'valid-non-rpc-secret-must-not-leak' }) + '\n');
    return;
  }
  if (behavior === 'unexpected-request') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 'peer-request',
      method: 'session/update',
      params: { secret: 'unexpected-request-secret-must-not-leak' },
    }) + '\n');
    return;
  }
  if (behavior === 'unmatched-response') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 999,
      result: { secret: 'unmatched-response-secret-must-not-leak' },
    }) + '\n');
    return;
  }
  if (behavior === 'malformed-initialize-result') {
    send(request.id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: 'malformed-initialize-secret-must-not-leak' },
    });
    return;
  }
  if (behavior === 'invalid-version-zero') {
    send(request.id, {
      protocolVersion: 0,
      marker: 'invalid-version-secret-must-not-leak',
    });
    return;
  }
  if (behavior === 'grandchild') {
    const descendant = spawn(process.execPath, [
      '-e',
      'process.on("SIGTERM", () => undefined); setInterval(() => undefined, 1000)',
    ], { stdio: 'ignore' });
    writeFileSync(descendantPidPath, String(descendant.pid));
  }
  const protocolVersion = behavior === 'unsupported-version' ? 2 : 1;
  send(request.id, {
    protocolVersion,
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: {
        ...((behavior === 'no-auth-no-list' || behavior === 'auth-no-list') ? {} : { list: {} }),
        resume: {},
        close: {},
        additionalDirectories: {},
      },
    },
    ...((behavior === 'auth-required' || behavior === 'auth-no-list')
      ? { authMethods: [{ id: 'login', name: 'Login' }] }
      : {}),
  });
}

function handleList(request) {
  if (behavior === 'malformed-list-result') {
    send(request.id, { sessions: 'malformed-list-secret-must-not-leak' });
    return;
  }
  if (behavior === 'auth-required') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32000, message: 'login-required-with-secret' },
    }) + '\n');
    return;
  }
  send(request.id, {
    sessions: [
      { sessionId: 'one', cwd: '/tmp/one' },
      { sessionId: 'two', cwd: '/tmp/two' },
    ],
  });
}

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
`;
