import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigService } from './config-service';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

describe('ConfigService', () => {
  it('merges team defaults with local paths and overrides', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-workspace-config-'));
    roots.push(home);
    const configDir = path.join(home, '.config', 'ai-workspace');
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(home, 'team.yaml'), `version: 1
branchPattern: feature/{requirementId}
repositories:
  quote:
    displayName: Quote Service
    remote: upstream
presets:
  auto:
    name: Auto Insurance
    repositories: [quote]
`);
    await writeFile(path.join(configDir, 'config.yaml'), `version: 1
sharedConfig: ~/team.yaml
workspaceRoot: ~/ai-workspaces
repositories:
  quote:
    path: ~/code/quote
    remote: origin
`);

    const config = await new ConfigService(home).load();
    expect(config.workspaceRoot).toBe(path.join(home, 'ai-workspaces'));
    expect(config.repositories.quote).toMatchObject({
      displayName: 'Quote Service',
      path: path.join(home, 'code', 'quote'),
      remote: 'origin'
    });
    expect(config.presets.auto?.repositories).toEqual(['quote']);
    expect(Object.getPrototypeOf(config.repositories)).toBeNull();
    expect(Object.getPrototypeOf(config.presets)).toBeNull();
  });

  it('writes a located repository path back to local YAML', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-workspace-config-'));
    roots.push(home);
    const service = new ConfigService(home);
    await service.ensureLocalConfig();
    await service.setRepositoryPath('quote', path.join(home, 'code', 'quote'));
    expect(await readFile(service.getLocalConfigPath(), 'utf8'))
      .toContain('quote:');
  });

  it('publishes one complete initial document under concurrent initialization', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-workspace-config-'));
    roots.push(home);
    const services = Array.from({ length: 8 }, () => new ConfigService(home));

    await Promise.all(services.map(service => service.ensureLocalConfig()));

    const configPath = services[0]?.getLocalConfigPath();
    expect(configPath).toBeDefined();
    expect(await readFile(configPath!, 'utf8')).toBe(`version: 1
workspaceRoot: ~/ai-workspaces
branchPattern: feature/{requirementId}
repositories: {}
presets: {}
`);
    expect(await readdir(path.dirname(configPath!))).toEqual([path.basename(configPath!)]);
  });

  it('cleans a transaction temp file left by an interrupted writer', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-workspace-config-'));
    roots.push(home);
    const service = new ConfigService(home);
    await service.ensureLocalConfig();
    const configDirectory = path.dirname(service.getLocalConfigPath());
    const debris = path.join(
      configDirectory,
      '.config.yaml.update.999.11111111-1111-4111-8111-111111111111.tmp'
    );
    await writeFile(debris, 'incomplete', 'utf8');

    await service.ensureLocalConfig();

    await expect(readFile(debris, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses defaults and resolves relative shared configuration from the local config directory', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-workspace-config-'));
    roots.push(home);
    const configDir = path.join(home, '.config', 'ai-workspace');
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, 'team.yaml'), `version: 1
repositories:
  quote: {}
`);
    await writeFile(path.join(configDir, 'config.yaml'), `version: 1
sharedConfig: team.yaml
`);

    const config = await new ConfigService(home).load();
    expect(config.workspaceRoot).toBe(path.join(home, 'ai-workspaces'));
    expect(config.branchPattern).toBe('feature/{requirementId}');
    expect(config.repositories.quote).toMatchObject({
      displayName: 'quote',
      remote: 'origin'
    });
  });

  it('rejects a preset that references an unknown repository', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-workspace-config-'));
    roots.push(home);
    const configDir = path.join(home, '.config', 'ai-workspace');
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, 'config.yaml'), `version: 1
presets:
  auto:
    name: Auto Insurance
    repositories: [quote]
`);

    await expect(new ConfigService(home).load()).rejects.toMatchObject({ code: 'CONFIG' });
  });

  it.each([
    ['malformed YAML', 'version: ['],
    ['an invalid remote name', 'version: 1\nrepositories:\n  quote:\n    remote: bad remote'],
    ['an HTTP clone URL with credentials', 'version: 1\nrepositories:\n  quote:\n    cloneUrl: https://user:secret@example.com/repo.git'],
    ['an HTTP clone URL with username-only userinfo', 'version: 1\nrepositories:\n  quote:\n    cloneUrl: https://user@example.com/repo.git'],
    ['an SSH URL with a password', 'version: 1\nrepositories:\n  quote:\n    cloneUrl: ssh://git:secret@example.com/repo.git'],
    ['an SSH URL with an explicit empty password', 'version: 1\nrepositories:\n  quote:\n    cloneUrl: ssh://git:@example.com/repo.git'],
    ['a scheme-relative URL with credentials', 'version: 1\nrepositories:\n  quote:\n    cloneUrl: //git:secret@example.com/repo.git'],
    ['a scheme-relative URL with username-only userinfo', 'version: 1\nrepositories:\n  quote:\n    cloneUrl: //git@example.com/repo.git'],
    ['a credential URL hidden by whitespace', 'version: 1\nrepositories:\n  quote:\n    cloneUrl: " https://user:secret@example.com/repo.git"'],
    ['a credential URL hidden by backslashes', 'version: 1\nrepositories:\n  quote:\n    cloneUrl: "https:\\\\user:secret@example.com/repo.git"'],
    ['a clone URL with a sensitive query', 'version: 1\nrepositories:\n  quote:\n    cloneUrl: https://example.com/repo.git?access_token=secret'],
    ['a clone URL with a normalized sensitive query', 'version: 1\nrepositories:\n  quote:\n    cloneUrl: https://example.com/repo.git?Access-Token=secret'],
    ['a clone URL with a sensitive fragment', 'version: 1\nrepositories:\n  quote:\n    cloneUrl: https://example.com/repo.git#token=secret']
  ])('rejects %s without exposing configuration contents', async (_description, yaml) => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-workspace-config-'));
    roots.push(home);
    const configDir = path.join(home, '.config', 'ai-workspace');
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, 'config.yaml'), yaml);
    const configPath = path.join(configDir, 'config.yaml');

    await expect(new ConfigService(home).load()).rejects.toMatchObject({
      code: 'CONFIG',
      details: { configPath }
    });
    await expect(new ConfigService(home).load()).rejects.not.toThrow('secret');
  });

  it.each([
    'git@example.com:team/repo.git',
    'ssh://git@example.com/team/repo.git',
    'https://example.com/team/repo.git'
  ])('accepts credential-free clone URL %s', async cloneUrl => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-workspace-config-'));
    roots.push(home);
    const configDir = path.join(home, '.config', 'ai-workspace');
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, 'config.yaml'), `version: 1
repositories:
  quote:
    cloneUrl: ${cloneUrl}
`);

    await expect(new ConfigService(home).load()).resolves.toMatchObject({
      repositories: { quote: { cloneUrl } }
    });
  });

  it.each(['', '.', '..', '../escape', 'nested/repo', 'nested\\repo', 'CON', 'COM0', '__proto__', 'constructor', 'toString'])
    ('rejects unsafe repository id %s', async repositoryId => {
      const home = await mkdtemp(path.join(os.tmpdir(), 'ai-workspace-config-'));
      roots.push(home);
      const configDir = path.join(home, '.config', 'ai-workspace');
      await mkdir(configDir, { recursive: true });
      await writeFile(path.join(configDir, 'config.yaml'), `version: 1
repositories:
  ${JSON.stringify(repositoryId)}: {}
`);

      await expect(new ConfigService(home).load()).rejects.toMatchObject({ code: 'CONFIG' });
    });

  it.each(['../escape', '__proto__', 'constructor', 'toString'])
    ('rejects unsafe preset id %s', async presetId => {
      const home = await mkdtemp(path.join(os.tmpdir(), 'ai-workspace-config-'));
      roots.push(home);
      const configDir = path.join(home, '.config', 'ai-workspace');
      await mkdir(configDir, { recursive: true });
      await writeFile(path.join(configDir, 'config.yaml'), `version: 1
repositories:
  quote: {}
presets:
  ${JSON.stringify(presetId)}:
    name: Unsafe
    repositories: [quote]
`);

      await expect(new ConfigService(home).load()).rejects.toMatchObject({ code: 'CONFIG' });
    });

  it('does not accept an inherited object property as a known repository', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-workspace-config-'));
    roots.push(home);
    const configDir = path.join(home, '.config', 'ai-workspace');
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, 'config.yaml'), `version: 1
presets:
  unsafe:
    name: Unsafe
    repositories: [toString]
`);

    await expect(new ConfigService(home).load()).rejects.toMatchObject({ code: 'CONFIG' });
  });

  it('refuses to rewrite a local document that fails schema validation', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-workspace-config-'));
    roots.push(home);
    const service = new ConfigService(home);
    await mkdir(path.dirname(service.getLocalConfigPath()), { recursive: true });
    await writeFile(service.getLocalConfigPath(), `version: 1
repositories:
  quote:
    remote: invalid remote
`);

    await expect(service.setRepositoryPath('quote', path.join(home, 'code', 'quote')))
      .rejects.toMatchObject({ code: 'CONFIG' });
  });

  it('rejects an empty repository path without persisting it', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-workspace-config-'));
    roots.push(home);
    const service = new ConfigService(home);
    await service.ensureLocalConfig();

    await expect(service.setRepositoryPath('quote', '')).rejects.toMatchObject({ code: 'CONFIG' });
    expect(await readFile(service.getLocalConfigPath(), 'utf8')).not.toContain('quote:');
  });

  it('rejects an unsafe repository id without changing the local document', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-workspace-config-'));
    roots.push(home);
    const service = new ConfigService(home);
    await service.ensureLocalConfig();
    const before = await readFile(service.getLocalConfigPath(), 'utf8');

    await expect(service.setRepositoryPath('../escape', path.join(home, 'escape')))
      .rejects.toMatchObject({ code: 'CONFIG' });
    expect(await readFile(service.getLocalConfigPath(), 'utf8')).toBe(before);
  });

  it('serializes concurrent path updates without losing either repository', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-workspace-config-'));
    roots.push(home);
    const first = new ConfigService(home);
    const second = new ConfigService(home);
    await first.ensureLocalConfig();

    await Promise.all([
      first.setRepositoryPath('one', path.join(home, 'code', 'one')),
      second.setRepositoryPath('two', path.join(home, 'code', 'two'))
    ]);

    const config = await first.load();
    expect(config.repositories.one?.path).toBe(path.join(home, 'code', 'one'));
    expect(config.repositories.two?.path).toBe(path.join(home, 'code', 'two'));
    expect((await readdir(path.dirname(first.getLocalConfigPath())))
      .filter(entry => entry !== path.basename(first.getLocalConfigPath())))
      .toEqual([]);
  });
});
