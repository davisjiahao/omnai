import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiWorkspaceError } from '../domain/errors';
import type {
  BranchInfo,
  EffectiveConfig,
  WorkspaceState
} from '../domain/types';
import {
  CreationPlanner,
  NodePathProbe,
  type CreationRequest,
  type PathProbe
} from './creation-planner';
import * as plannerModule from './creation-planner';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const sourceRoot = path.resolve('/source');
const workspaceRoot = path.resolve('/workspaces');
const quotePath = path.join(sourceRoot, 'quote');
const webPath = path.join(sourceRoot, 'web');
const timestamp = '2026-08-14T00:00:00.000Z';

function guardDocument(token: string, processId: number): string {
  return `${JSON.stringify({ version: 1, token, processId, startedAt: timestamp })}\n`;
}

async function writeGuardOwner(
  guardPath: string,
  fileToken: string,
  documentToken = fileToken,
  processId = 42
): Promise<void> {
  await mkdir(guardPath, { recursive: true });
  await writeFile(
    path.join(guardPath, `owner.${fileToken}.json`),
    guardDocument(documentToken, processId)
  );
}

function configFixture(): EffectiveConfig {
  return {
    localConfigPath: path.resolve('/config/config.yaml'),
    workspaceRoot,
    branchPattern: 'feature/{requirementId}',
    repositories: {
      quote: {
        id: 'quote',
        displayName: 'Quote Service',
        path: quotePath,
        remote: 'origin'
      },
      web: {
        id: 'web',
        displayName: 'Web App',
        path: webPath,
        remote: 'upstream'
      }
    },
    presets: {}
  };
}

function requestFixture(overrides: Partial<CreationRequest> = {}): CreationRequest {
  return {
    requirement: { id: 'REQ-123', title: 'Quote change' },
    config: configFixture(),
    selections: [
      { repositoryId: 'quote', baseRef: 'origin/main' },
      { repositoryId: 'web', baseRef: 'upstream/release' }
    ],
    ...overrides
  };
}

interface RepositoryFixture {
  baseCommit: string;
  branch: BranchInfo;
}

function fakeRepositoryService(
  fixtures: Record<string, RepositoryFixture> = {
    quote: { baseCommit: 'a'.repeat(40), branch: { exists: false } },
    web: {
      baseCommit: 'b'.repeat(40),
      branch: { exists: true, head: 'c'.repeat(40) }
    }
  }
) {
  const calls: string[] = [];
  const idByPath = new Map([
    [quotePath, 'quote'],
    [webPath, 'web']
  ]);
  const idFor = (sourcePath: string): string => {
    const id = idByPath.get(sourcePath);
    if (id === undefined) throw new Error(`Unexpected source path: ${sourcePath}`);
    return id;
  };

  return {
    calls,
    assertUsableRepository: vi.fn(async (sourcePath: string, _remote: string): Promise<void> => {
      calls.push(`usable:${idFor(sourcePath)}`);
    }),
    validateBaseRef: vi.fn(async (
      sourcePath: string,
      _remote: string,
      _baseRef: string
    ): Promise<void> => {
      calls.push(`base:${idFor(sourcePath)}`);
    }),
    validateBranchName: vi.fn(async (sourcePath: string, _branch: string): Promise<void> => {
      calls.push(`branch-name:${idFor(sourcePath)}`);
    }),
    fetch: vi.fn(async (
      sourcePath: string,
      _remote: string,
      _signal?: AbortSignal
    ): Promise<void> => {
      calls.push(`fetch:${idFor(sourcePath)}`);
    }),
    resolveCommit: vi.fn(async (sourcePath: string, _ref: string): Promise<string> => {
      const id = idFor(sourcePath);
      calls.push(`resolve:${id}`);
      const fixture = fixtures[id];
      if (fixture === undefined) throw new Error(`Missing repository fixture: ${id}`);
      return fixture.baseCommit;
    }),
    getBranchInfo: vi.fn(async (sourcePath: string, _branch: string): Promise<BranchInfo> => {
      const id = idFor(sourcePath);
      calls.push(`branch-info:${id}`);
      const fixture = fixtures[id];
      if (fixture === undefined) throw new Error(`Missing repository fixture: ${id}`);
      return fixture.branch;
    }),
    addWorktree: vi.fn()
  };
}

function fakeStateStore(existing?: WorkspaceState) {
  return {
    workspacePath: vi.fn((root: string, requirementId: string) => path.join(root, requirementId)),
    readIfExists: vi.fn(async (): Promise<WorkspaceState | undefined> => existing)
  };
}

function fakePathProbe(
  existingPaths: readonly string[] = [],
  managedArtifactPaths: readonly string[] = []
): PathProbe {
  return {
    exists: vi.fn(async (targetPath: string) => existingPaths.includes(targetPath)),
    isManagedArtifactOnly: vi.fn(
      async (targetPath: string) => managedArtifactPaths.includes(targetPath)
    )
  };
}

describe('CreationPlanner', () => {
  it('resolves immutable commits, reuses branches, and preserves selection order', async () => {
    const repositories = fakeRepositoryService();
    const states = fakeStateStore();
    const planner = new CreationPlanner(repositories, states, fakePathProbe());

    const plan = await planner.plan(requestFixture({
      requirement: { id: '  REQ-123  ', title: '  Quote change  ' }
    }));

    expect(plan).toEqual({
      requirement: { id: 'REQ-123', title: 'Quote change' },
      workspacePath: path.join(workspaceRoot, 'REQ-123'),
      branchName: 'feature/REQ-123',
      repositories: [
        {
          id: 'quote',
          displayName: 'Quote Service',
          sourcePath: quotePath,
          worktreePath: path.join(workspaceRoot, 'REQ-123', 'quote'),
          remote: 'origin',
          baseRef: 'origin/main',
          baseCommit: 'a'.repeat(40),
          branch: 'feature/REQ-123',
          branchDisposition: 'create',
          branchInitialCommit: 'a'.repeat(40)
        },
        {
          id: 'web',
          displayName: 'Web App',
          sourcePath: webPath,
          worktreePath: path.join(workspaceRoot, 'REQ-123', 'web'),
          remote: 'upstream',
          baseRef: 'upstream/release',
          baseCommit: 'b'.repeat(40),
          branch: 'feature/REQ-123',
          branchDisposition: 'reuse',
          branchInitialCommit: 'c'.repeat(40)
        }
      ]
    });
    expect(repositories.calls).toEqual([
      'usable:quote',
      'base:quote',
      'branch-name:quote',
      'usable:web',
      'base:web',
      'branch-name:web',
      'fetch:quote',
      'resolve:quote',
      'branch-info:quote',
      'fetch:web',
      'resolve:web',
      'branch-info:web'
    ]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.requirement)).toBe(true);
    expect(Object.isFrozen(plan.repositories)).toBe(true);
    expect(plan.repositories.every(repository => Object.isFrozen(repository))).toBe(true);
  });

  it('rejects empty and duplicate selections before inspecting repositories', async () => {
    const repositories = fakeRepositoryService();
    const planner = new CreationPlanner(repositories, fakeStateStore(), fakePathProbe());

    await expect(planner.plan(requestFixture({ selections: [] })))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(planner.plan(requestFixture({
      selections: [
        { repositoryId: 'quote', baseRef: 'origin/main' },
        { repositoryId: 'quote', baseRef: 'origin/release' }
      ]
    }))).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(repositories.assertUsableRepository).not.toHaveBeenCalled();
  });

  it('normalizes the requirement before rejecting an empty title', async () => {
    const states = fakeStateStore();
    const planner = new CreationPlanner(fakeRepositoryService(), states, fakePathProbe());

    await expect(planner.plan(requestFixture({
      requirement: { id: ' invalid/id ', title: 'valid' }
    }))).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(planner.plan(requestFixture({
      requirement: { id: 'REQ-123', title: '   ' }
    }))).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(states.workspacePath).not.toHaveBeenCalled();
  });

  it('reports existing managed state before any unmanaged-path conflict', async () => {
    const expectedPath = path.join(workspaceRoot, 'REQ-123');
    const existing = { workspacePath: expectedPath } as WorkspaceState;
    const states = fakeStateStore(existing);
    const paths = fakePathProbe([expectedPath]);
    const repositories = fakeRepositoryService();
    const planner = new CreationPlanner(repositories, states, paths);

    await expect(planner.plan(requestFixture())).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { workspacePath: expectedPath }
    });
    expect(paths.exists).not.toHaveBeenCalled();
    expect(repositories.assertUsableRepository).not.toHaveBeenCalled();
  });

  it('rejects unmanaged requirement directories and existing child targets', async () => {
    const expectedPath = path.join(workspaceRoot, 'REQ-123');
    const childPath = path.join(expectedPath, 'quote');
    const repositories = fakeRepositoryService();

    await expect(new CreationPlanner(
      repositories,
      fakeStateStore(),
      fakePathProbe([expectedPath])
    ).plan(requestFixture())).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { workspacePath: expectedPath }
    });

    await expect(new CreationPlanner(
      repositories,
      fakeStateStore(),
      fakePathProbe([childPath])
    ).plan(requestFixture())).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { repositoryId: 'quote', worktreePath: childPath }
    });
    expect(repositories.assertUsableRepository).not.toHaveBeenCalled();
  });

  it('allows only a recognized managed-artifact parent to reach Git preflight', async () => {
    const expectedPath = path.join(workspaceRoot, 'REQ-123');
    const repositories = fakeRepositoryService();
    const paths = fakePathProbe([expectedPath], [expectedPath]);

    await expect(new CreationPlanner(repositories, fakeStateStore(), paths)
      .plan(requestFixture())).resolves.toMatchObject({ workspacePath: expectedPath });
    expect(paths.isManagedArtifactOnly).toHaveBeenCalledWith(expectedPath);
    expect(repositories.assertUsableRepository).toHaveBeenCalledTimes(2);
  });

  it('rejects unknown, missing-path, and relative-path repository configuration', async () => {
    const repositories = fakeRepositoryService();
    const planner = new CreationPlanner(repositories, fakeStateStore(), fakePathProbe());

    await expect(planner.plan(requestFixture({
      selections: [{ repositoryId: 'unknown', baseRef: 'origin/main' }]
    }))).rejects.toMatchObject({ code: 'CONFIG' });

    const missingPathConfig = configFixture();
    missingPathConfig.repositories = {
      quote: { id: 'quote', displayName: 'Quote Service', remote: 'origin' }
    };
    await expect(planner.plan(requestFixture({
      config: missingPathConfig,
      selections: [{ repositoryId: 'quote', baseRef: 'origin/main' }]
    }))).rejects.toMatchObject({ code: 'CONFIG', details: { repositoryId: 'quote' } });

    const relativePathConfig = configFixture();
    relativePathConfig.repositories = {
      quote: {
        id: 'quote',
        displayName: 'Quote Service',
        path: 'relative/quote',
        remote: 'origin'
      }
    };
    await expect(planner.plan(requestFixture({
      config: relativePathConfig,
      selections: [{ repositoryId: 'quote', baseRef: 'origin/main' }]
    }))).rejects.toMatchObject({ code: 'CONFIG', details: { repositoryId: 'quote' } });
    expect(repositories.assertUsableRepository).not.toHaveBeenCalled();
  });

  it('rejects lexically duplicate source repositories before any Git call', async () => {
    const config = configFixture();
    config.repositories = {
      ...config.repositories,
      web: {
        ...config.repositories.web!,
        path: `${sourceRoot}${path.sep}nested${path.sep}..${path.sep}quote`
      }
    };
    const repositories = fakeRepositoryService();

    await expect(new CreationPlanner(repositories, fakeStateStore(), fakePathProbe())
      .plan(requestFixture({ config }))).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { repositoryId: 'web', conflictingRepositoryId: 'quote' }
    });
    expect(repositories.assertUsableRepository).not.toHaveBeenCalled();
  });

  it('rejects case-folded child target collisions through the injected path identity', async () => {
    const config = configFixture();
    config.repositories = {
      quote: config.repositories.quote!,
      QUOTE: {
        id: 'QUOTE',
        displayName: 'Upper Quote',
        path: path.join(sourceRoot, 'upper-quote'),
        remote: 'origin'
      }
    };
    const repositories = fakeRepositoryService();
    const caseFoldedIdentity = {
      identify: (targetPath: string) => path.resolve(targetPath).toLowerCase()
    };

    await expect(new CreationPlanner(
      repositories,
      fakeStateStore(),
      fakePathProbe(),
      caseFoldedIdentity
    ).plan(requestFixture({
      config,
      selections: [
        { repositoryId: 'quote', baseRef: 'origin/main' },
        { repositoryId: 'QUOTE', baseRef: 'origin/main' }
      ]
    }))).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { repositoryId: 'QUOTE', conflictingRepositoryId: 'quote' }
    });
    expect(repositories.assertUsableRepository).not.toHaveBeenCalled();
  });

  it('provides deterministic Windows and macOS default lexical path identities', () => {
    const LexicalPathIdentity = (
      plannerModule as unknown as {
        LexicalPathIdentity: new (platform: NodeJS.Platform) => {
          identify(targetPath: string): string;
        };
      }
    ).LexicalPathIdentity;

    const windows = new LexicalPathIdentity('win32');
    expect(windows.identify('C:\\Work\\Repo'))
      .toBe(windows.identify('c:\\work\\nested\\..\\repo\\.'));
    const mac = new LexicalPathIdentity('darwin');
    expect(mac.identify('/Work/Repo'))
      .toBe(mac.identify('/work/nested/../repo/'));
  });

  it('rejects a relative workspace root as invalid effective configuration', async () => {
    const config = configFixture();
    config.workspaceRoot = 'relative/workspaces';
    const states = fakeStateStore();
    const planner = new CreationPlanner(fakeRepositoryService(), states, fakePathProbe());

    await expect(planner.plan(requestFixture({ config })))
      .rejects.toMatchObject({ code: 'CONFIG' });
    expect(states.workspacePath).not.toHaveBeenCalled();
  });

  it.each([
    ['repository inspection', 'assertUsableRepository'],
    ['base-ref validation', 'validateBaseRef'],
    ['branch validation', 'validateBranchName']
  ] as const)('does not fetch when %s fails during static preflight', async (_label, method) => {
    const repositories = fakeRepositoryService();
    repositories[method].mockRejectedValueOnce(
      new AiWorkspaceError(method === 'assertUsableRepository' ? 'GIT' : 'VALIDATION', 'invalid')
    );
    const planner = new CreationPlanner(repositories, fakeStateStore(), fakePathProbe());

    await expect(planner.plan(requestFixture())).rejects.toBeInstanceOf(AiWorkspaceError);
    expect(repositories.fetch).not.toHaveBeenCalled();
    expect(repositories.addWorktree).not.toHaveBeenCalled();
  });

  it('completes static preflight for every selection before the first fetch', async () => {
    const repositories = fakeRepositoryService();
    repositories.validateBranchName.mockImplementation(async sourcePath => {
      repositories.calls.push(`branch-name:${sourcePath === quotePath ? 'quote' : 'web'}`);
      if (sourcePath === webPath) throw new AiWorkspaceError('VALIDATION', 'invalid branch');
    });

    await expect(new CreationPlanner(repositories, fakeStateStore(), fakePathProbe())
      .plan(requestFixture())).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(repositories.calls).toEqual([
      'usable:quote',
      'base:quote',
      'branch-name:quote',
      'usable:web',
      'base:web',
      'branch-name:web'
    ]);
    expect(repositories.fetch).not.toHaveBeenCalled();
  });

  it('stops sequential remote inspection on failed fetch or missing base ref', async () => {
    const fetchFailure = fakeRepositoryService();
    fetchFailure.fetch.mockRejectedValueOnce(new AiWorkspaceError('GIT', 'fetch failed'));
    await expect(new CreationPlanner(fetchFailure, fakeStateStore(), fakePathProbe())
      .plan(requestFixture())).rejects.toMatchObject({ code: 'GIT' });
    expect(fetchFailure.fetch).toHaveBeenCalledTimes(1);
    expect(fetchFailure.resolveCommit).not.toHaveBeenCalled();

    const missingBase = fakeRepositoryService();
    missingBase.resolveCommit.mockRejectedValueOnce(new AiWorkspaceError('GIT', 'missing base'));
    await expect(new CreationPlanner(missingBase, fakeStateStore(), fakePathProbe())
      .plan(requestFixture())).rejects.toMatchObject({ code: 'GIT' });
    expect(missingBase.fetch).toHaveBeenCalledTimes(1);
    expect(missingBase.getBranchInfo).not.toHaveBeenCalled();
  });

  it('rejects an occupied branch before creating anything', async () => {
    const repositories = fakeRepositoryService({
      quote: {
        baseCommit: 'a'.repeat(40),
        branch: {
          exists: true,
          head: 'c'.repeat(40),
          worktreePath: path.resolve('/other/REQ-123')
        }
      },
      web: { baseCommit: 'b'.repeat(40), branch: { exists: false } }
    });

    await expect(new CreationPlanner(repositories, fakeStateStore(), fakePathProbe())
      .plan(requestFixture())).rejects.toMatchObject({
      code: 'CONFLICT',
      details: {
        repositoryId: 'quote',
        worktreePath: path.resolve('/other/REQ-123')
      }
    });
    expect(repositories.fetch).toHaveBeenCalledTimes(1);
    expect(repositories.addWorktree).not.toHaveBeenCalled();
  });

  it('reports deterministic preflight/fetch progress and forwards cancellation', async () => {
    const repositories = fakeRepositoryService();
    const controller = new AbortController();
    repositories.fetch.mockImplementationOnce(async (_sourcePath, _remote, signal) => {
      repositories.calls.push('fetch:quote');
      expect(signal).toBe(controller.signal);
      controller.abort();
    });
    const onProgress = vi.fn();

    await expect(new CreationPlanner(repositories, fakeStateStore(), fakePathProbe()).plan(
      requestFixture(),
      { signal: controller.signal, onProgress }
    )).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(repositories.resolveCommit).not.toHaveBeenCalled();
    expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { stage: 'preflight', message: 'Validating workspace request' },
      { stage: 'preflight', repositoryId: 'quote', message: 'Validating repository' },
      { stage: 'preflight', repositoryId: 'web', message: 'Validating repository' },
      { stage: 'fetch', repositoryId: 'quote', message: 'Fetching repository' }
    ]);
  });

  it('does no work when cancellation is already requested', async () => {
    const repositories = fakeRepositoryService();
    const states = fakeStateStore();
    const controller = new AbortController();
    controller.abort();
    const onProgress = vi.fn();

    await expect(new CreationPlanner(repositories, states, fakePathProbe()).plan(
      requestFixture(),
      { signal: controller.signal, onProgress }
    )).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(states.workspacePath).not.toHaveBeenCalled();
    expect(repositories.assertUsableRepository).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('honors cancellation requested synchronously by a progress listener', async () => {
    const repositories = fakeRepositoryService();
    const states = fakeStateStore();
    const controller = new AbortController();

    await expect(new CreationPlanner(repositories, states, fakePathProbe()).plan(
      requestFixture(),
      {
        signal: controller.signal,
        onProgress: () => controller.abort()
      }
    )).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(states.workspacePath).not.toHaveBeenCalled();
    expect(repositories.assertUsableRepository).not.toHaveBeenCalled();
  });

  it('prefers cancellation requested by a child-path probe over its conflict result', async () => {
    const repositories = fakeRepositoryService();
    const controller = new AbortController();
    const expectedChild = path.join(workspaceRoot, 'REQ-123', 'quote');
    const paths: PathProbe = {
      exists: vi.fn(async targetPath => {
        if (targetPath === expectedChild) {
          controller.abort();
          return true;
        }
        return false;
      })
    };

    await expect(new CreationPlanner(repositories, fakeStateStore(), paths).plan(
      requestFixture(),
      { signal: controller.signal }
    )).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(repositories.assertUsableRepository).not.toHaveBeenCalled();
  });
});

describe('NodePathProbe', () => {
  it('recognizes only exact lock-protocol crash artifacts without changing the directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-workspace-plan-'));
    roots.push(root);
    const target = path.join(root, 'REQ-123');
    const canonicalToken = '11111111-1111-4111-8111-111111111111';
    const preparedToken = '22222222-2222-4222-8222-222222222222';
    const releasedToken = '33333333-3333-4333-8333-333333333333';
    await writeGuardOwner(
      path.join(target, '.ai-workspace.lock.guard'),
      canonicalToken,
      canonicalToken,
      41
    );
    await writeGuardOwner(
      path.join(target, `.ai-workspace.lock.guard.prepared.42.${preparedToken}`),
      preparedToken,
      preparedToken,
      42
    );
    await writeGuardOwner(
      path.join(target, `.ai-workspace.lock.guard.released.43.${releasedToken}`),
      releasedToken,
      releasedToken,
      43
    );
    await writeFile(path.join(target, '.ai-workspace.lock'), 'interrupted lock\n');
    const before = await readdir(target, { recursive: true });
    const probe = new NodePathProbe({ isProcessAlive: () => false });

    await expect(probe.exists(target)).resolves.toBe(true);
    await expect(probe.isManagedArtifactOnly(target)).resolves.toBe(true);
    expect(await readdir(target, { recursive: true })).toEqual(before);
  });

  it('accepts empty canonical guards and strict released compatibility artifacts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-workspace-plan-'));
    roots.push(root);
    const target = path.join(root, 'REQ-123');
    const token = '44444444-4444-4444-8444-444444444444';
    await mkdir(path.join(target, '.ai-workspace.lock.guard'), { recursive: true });
    await mkdir(
      path.join(target, `.ai-workspace.lock.guard.released.7.${token}`)
    );
    await mkdir(
      path.join(target, `.ai-workspace.lock.guard.prepared.8.${token}`)
    );

    await expect(new NodePathProbe({ isProcessAlive: () => false })
      .isManagedArtifactOnly(target)).resolves.toBe(true);
  });

  it('rejects live prepared artifacts, impossible UUIDs, and unsafe process IDs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-workspace-plan-'));
    roots.push(root);
    const live = path.join(root, 'live');
    const invalidUuid = path.join(root, 'invalid-uuid');
    const unsafePid = path.join(root, 'unsafe-pid');
    const validToken = '55555555-5555-4555-8555-555555555555';
    const impossibleToken = '66666666-6666-0666-7666-666666666666';
    await mkdir(
      path.join(live, `.ai-workspace.lock.guard.prepared.99.${validToken}`),
      { recursive: true }
    );
    await mkdir(
      path.join(invalidUuid, `.ai-workspace.lock.guard.released.9.${impossibleToken}`),
      { recursive: true }
    );
    await mkdir(
      path.join(
        unsafePid,
        `.ai-workspace.lock.guard.released.9007199254740992.${validToken}`
      ),
      { recursive: true }
    );

    await expect(new NodePathProbe({ isProcessAlive: processId => processId === 99 })
      .isManagedArtifactOnly(live)).resolves.toBe(false);
    await expect(new NodePathProbe({ isProcessAlive: () => false })
      .isManagedArtifactOnly(invalidUuid)).resolves.toBe(false);
    await expect(new NodePathProbe({ isProcessAlive: () => false })
      .isManagedArtifactOnly(unsafePid)).resolves.toBe(false);
  });

  it('rejects owner documents that disagree with their name or artifact suffix', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-workspace-plan-'));
    roots.push(root);
    const token = '77777777-7777-4777-8777-777777777777';
    const otherToken = '88888888-8888-4888-8888-888888888888';
    const wrongToken = path.join(root, 'wrong-token');
    const wrongPid = path.join(root, 'wrong-pid');
    const malformed = path.join(root, 'malformed-json');
    const invalidVersion = path.join(root, 'invalid-version');
    const invalidTimestamp = path.join(root, 'invalid-timestamp');
    await writeGuardOwner(
      path.join(wrongToken, `.ai-workspace.lock.guard.prepared.12.${token}`),
      token,
      otherToken,
      12
    );
    await writeGuardOwner(
      path.join(wrongPid, `.ai-workspace.lock.guard.released.12.${token}`),
      token,
      token,
      13
    );
    await mkdir(path.join(malformed, '.ai-workspace.lock.guard'), { recursive: true });
    await writeFile(
      path.join(malformed, '.ai-workspace.lock.guard', `owner.${token}.json`),
      '{"version":1'
    );
    await mkdir(path.join(invalidVersion, '.ai-workspace.lock.guard'), { recursive: true });
    await writeFile(
      path.join(invalidVersion, '.ai-workspace.lock.guard', `owner.${token}.json`),
      `${JSON.stringify({ version: 2, token, processId: 12, startedAt: timestamp })}\n`
    );
    const invalidTimestampGuard = path.join(
      invalidTimestamp,
      `.ai-workspace.lock.guard.released.12.${token}`
    );
    await mkdir(invalidTimestampGuard, { recursive: true });
    await writeFile(
      path.join(invalidTimestampGuard, `owner.${token}.json`),
      `${JSON.stringify({ version: 1, token, processId: 12, startedAt: 'not-a-date' })}\n`
    );
    const probe = new NodePathProbe({ isProcessAlive: () => false });

    for (const target of [
      wrongToken,
      wrongPid,
      malformed,
      invalidVersion,
      invalidTimestamp
    ]) {
      await expect(probe.isManagedArtifactOnly(target)).resolves.toBe(false);
    }
  });

  it('allows a partial owner only for a strictly named dead prepared artifact', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-workspace-plan-'));
    roots.push(root);
    const target = path.join(root, 'dead-partial');
    const token = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const prepared = path.join(
      target,
      `.ai-workspace.lock.guard.prepared.77.${token}`
    );
    await mkdir(prepared, { recursive: true });
    await writeFile(path.join(prepared, `owner.${token}.json`), '{partial');

    await expect(new NodePathProbe({ isProcessAlive: () => false })
      .isManagedArtifactOnly(target)).resolves.toBe(true);
    await expect(new NodePathProbe({ isProcessAlive: () => true })
      .isManagedArtifactOnly(target)).resolves.toBe(false);
  });

  it('rejects a dead prepared partial owner whose filename token differs from its directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-workspace-plan-'));
    roots.push(root);
    const target = path.join(root, 'mismatched-partial');
    const directoryToken = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const ownerToken = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const prepared = path.join(
      target,
      `.ai-workspace.lock.guard.prepared.78.${directoryToken}`
    );
    await mkdir(prepared, { recursive: true });
    await writeFile(path.join(prepared, `owner.${ownerToken}.json`), '{partial');

    await expect(new NodePathProbe({ isProcessAlive: () => false })
      .isManagedArtifactOnly(target)).resolves.toBe(false);
  });

  it('rejects empty, unrelated, malformed, and symlinked artifact directories', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-workspace-plan-'));
    roots.push(root);
    const probe = new NodePathProbe();
    const empty = path.join(root, 'empty');
    const unrelated = path.join(root, 'unrelated');
    const malformed = path.join(root, 'malformed');
    const mismatched = path.join(root, 'mismatched');
    const realGuard = path.join(root, 'real-guard');
    const symlinked = path.join(root, 'symlinked');
    await mkdir(empty);
    await mkdir(unrelated);
    await writeFile(path.join(unrelated, 'notes.txt'), 'keep');
    await mkdir(path.join(malformed, '.ai-workspace.lock.guard'), { recursive: true });
    await writeFile(path.join(malformed, '.ai-workspace.lock.guard', 'unexpected'), 'keep');
    const directoryToken = '99999999-9999-4999-8999-999999999999';
    const ownerToken = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const mismatchedGuard = path.join(
      mismatched,
      `.ai-workspace.lock.guard.prepared.9.${directoryToken}`
    );
    await mkdir(mismatchedGuard, { recursive: true });
    await writeFile(path.join(mismatchedGuard, `owner.${ownerToken}.json`), '{}\n');
    await mkdir(realGuard);
    await symlink(
      realGuard,
      path.join(symlinked, '.ai-workspace.lock.guard'),
      process.platform === 'win32' ? 'junction' : 'dir'
    ).catch(async error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(symlinked);
      await symlink(
        realGuard,
        path.join(symlinked, '.ai-workspace.lock.guard'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
    });

    for (const target of [empty, unrelated, malformed, mismatched, symlinked]) {
      await expect(probe.isManagedArtifactOnly(target)).resolves.toBe(false);
    }
    await expect(probe.exists(path.join(root, 'missing'))).resolves.toBe(false);
  });
});
