import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import * as YAML from 'yaml';
import { AiWorkspaceError } from '../domain/errors';
import type {
  EffectiveConfig,
  EffectivePresetConfig,
  EffectiveRepositoryConfig
} from '../domain/types';
import {
  configIdSchema,
  localConfigSchema,
  type LocalConfigDocument,
  sharedConfigSchema,
  type SharedConfigDocument
} from './config-schema';
import { ConfigFileLock, withConfigLock } from './config-file-lock';

const DEFAULT_BRANCH_PATTERN = 'feature/{requirementId}';
const DEFAULT_WORKSPACE_ROOT = '~/ai-workspaces';
const DEFAULT_LOCAL_CONFIG = `version: 1
workspaceRoot: ${DEFAULT_WORKSPACE_ROOT}
branchPattern: ${DEFAULT_BRANCH_PATTERN}
repositories: {}
presets: {}
`;

function expandHome(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.resolve(home, value.slice(2));
  }
  return value;
}

function resolveConfigPath(value: string, home: string, relativeTo: string): string {
  const expanded = expandHome(value, home);
  return path.resolve(relativeTo, expanded);
}

function configError(configPath: string, action: string): AiWorkspaceError {
  return new AiWorkspaceError(
    'CONFIG',
    `Unable to ${action} configuration at ${configPath}`,
    { configPath }
  );
}

function throwIfDocumentInvalid(document: YAML.Document, configPath: string): void {
  if (document.errors.length > 0) {
    throw configError(configPath, 'parse');
  }
}

export class ConfigService {
  constructor(
    private readonly homeDirectory: string,
    private readonly localConfigPath = path.join(
      homeDirectory,
      '.config',
      'ai-workspace',
      'config.yaml'
    )
  ) {}

  getLocalConfigPath(): string {
    return this.localConfigPath;
  }

  async ensureLocalConfig(): Promise<string> {
    try {
      await mkdir(path.dirname(this.localConfigPath), { recursive: true });
      return await withConfigLock(this.createLock(), async () => {
        await this.cleanupTransactionDebris();
        if (await pathExists(this.localConfigPath)) return this.localConfigPath;
        const temporaryPath = this.temporaryPath('init');
        let operationFailed = false;
        try {
          await writeCompleteFile(temporaryPath, DEFAULT_LOCAL_CONFIG);
          try {
            await link(temporaryPath, this.localConfigPath);
          } catch (error) {
            if (!hasCode(error, 'EEXIST')) throw error;
          }
          return this.localConfigPath;
        } catch (error) {
          operationFailed = true;
          throw error;
        } finally {
          try {
            await rm(temporaryPath, { force: true });
          } catch (error) {
            if (!operationFailed) throw error;
          }
        }
      });
    } catch (error) {
      if (error instanceof AiWorkspaceError) throw error;
      throw configError(this.localConfigPath, 'create');
    }
  }

  async load(): Promise<EffectiveConfig> {
    await this.ensureLocalConfig();
    const local = await this.readLocalConfig();
    const shared = local.sharedConfig === undefined
      ? undefined
      : await this.readSharedConfig(
        resolveConfigPath(local.sharedConfig, this.homeDirectory, path.dirname(this.localConfigPath))
      );

    const repositories = this.mergeRepositories(shared, local);
    const presets = this.mergePresets(shared, local, repositories);

    return {
      localConfigPath: this.localConfigPath,
      workspaceRoot: resolveConfigPath(local.workspaceRoot, this.homeDirectory, this.homeDirectory),
      branchPattern: local.branchPattern ?? shared?.branchPattern ?? DEFAULT_BRANCH_PATTERN,
      repositories,
      presets
    };
  }

  async setRepositoryPath(repositoryId: string, repositoryPath: string): Promise<void> {
    await this.ensureLocalConfig();
    if (!configIdSchema.safeParse(repositoryId).success) {
      throw configError(this.localConfigPath, 'validate');
    }

    try {
      await withConfigLock(this.createLock(), async () => {
        await this.cleanupTransactionDebris();
        const source = await readFile(this.localConfigPath, 'utf8');
        const document = YAML.parseDocument(source);
        throwIfDocumentInvalid(document, this.localConfigPath);
        if (!localConfigSchema.safeParse(document.toJS()).success) {
          throw configError(this.localConfigPath, 'validate');
        }
        document.setIn(['repositories', repositoryId, 'path'], repositoryPath);
        if (!localConfigSchema.safeParse(document.toJS()).success) {
          throw configError(this.localConfigPath, 'validate');
        }

        await this.replaceLocalConfig(document.toString());
      });
    } catch (error) {
      if (error instanceof AiWorkspaceError) throw error;
      throw configError(this.localConfigPath, 'update');
    }
  }

  private createLock(): ConfigFileLock {
    return new ConfigFileLock(path.join(
      path.dirname(this.localConfigPath),
      `.${path.basename(this.localConfigPath)}.lock`
    ));
  }

  private temporaryPath(purpose: string): string {
    return path.join(
      path.dirname(this.localConfigPath),
      `.${path.basename(this.localConfigPath)}.${purpose}.${process.pid}.${randomUUID()}.tmp`
    );
  }

  private async replaceLocalConfig(contents: string): Promise<void> {
    const temporaryPath = this.temporaryPath('update');
    let operationFailed = false;
    try {
      await writeCompleteFile(temporaryPath, contents);
      await rename(temporaryPath, this.localConfigPath);
    } catch (error) {
      operationFailed = true;
      throw error;
    } finally {
      try {
        await rm(temporaryPath, { force: true });
      } catch (error) {
        if (!operationFailed) throw error;
      }
    }
  }

  private async cleanupTransactionDebris(): Promise<void> {
    const directory = path.dirname(this.localConfigPath);
    const basename = escapeRegExp(path.basename(this.localConfigPath));
    const transactionTemp = new RegExp(
      `^\\.${basename}\\.(?:init|update)\\.[1-9][0-9]*\\.`
      + '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp$',
      'i'
    );
    for (const entry of await readdir(directory)) {
      if (transactionTemp.test(entry)) {
        await rm(path.join(directory, entry), { force: true });
      }
    }
  }

  private async readLocalConfig(): Promise<LocalConfigDocument> {
    return this.readConfig(this.localConfigPath, localConfigSchema, 'read local');
  }

  private async readSharedConfig(sharedConfigPath: string): Promise<SharedConfigDocument> {
    return this.readConfig(sharedConfigPath, sharedConfigSchema, 'read shared');
  }

  private async readConfig<T>(
    configPath: string,
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
    action: string
  ): Promise<T> {
    try {
      const source = await readFile(configPath, 'utf8');
      const document = YAML.parseDocument(source);
      throwIfDocumentInvalid(document, configPath);
      const parsed = schema.safeParse(document.toJS());
      if (!parsed.success) {
        throw configError(configPath, 'validate');
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof AiWorkspaceError) throw error;
      throw configError(configPath, action);
    }
  }

  private mergeRepositories(
    shared: SharedConfigDocument | undefined,
    local: LocalConfigDocument
  ): Readonly<Record<string, EffectiveRepositoryConfig>> {
    const repositories = Object.create(null) as Record<string, EffectiveRepositoryConfig>;
    const ids = new Set([
      ...Object.keys(shared?.repositories ?? {}),
      ...Object.keys(local.repositories)
    ]);

    for (const id of ids) {
      const values = {
        ...shared?.repositories[id],
        ...local.repositories[id]
      };
      repositories[id] = {
        id,
        displayName: values.displayName ?? id,
        ...(values.cloneUrl === undefined ? {} : { cloneUrl: values.cloneUrl }),
        ...(values.path === undefined
          ? {}
          : { path: resolveConfigPath(values.path, this.homeDirectory, this.homeDirectory) }),
        remote: values.remote ?? 'origin'
      };
    }

    return repositories;
  }

  private mergePresets(
    shared: SharedConfigDocument | undefined,
    local: LocalConfigDocument,
    repositories: Readonly<Record<string, EffectiveRepositoryConfig>>
  ): Readonly<Record<string, EffectivePresetConfig>> {
    const presets = new Map(Object.entries(shared?.presets ?? {}));
    for (const [id, preset] of Object.entries(local.presets)) presets.set(id, preset);
    const effectivePresets = Object.create(null) as Record<string, EffectivePresetConfig>;

    for (const [id, preset] of presets) {
      for (const repositoryId of preset.repositories) {
        if (!Object.hasOwn(repositories, repositoryId)) {
          throw new AiWorkspaceError(
            'CONFIG',
            `Preset ${id} references unknown repository ${repositoryId}`,
            { configPath: this.localConfigPath, presetId: id, repositoryId }
          );
        }
      }
      effectivePresets[id] = { id, name: preset.name, repositories: preset.repositories };
    }

    return effectivePresets;
  }
}

async function writeCompleteFile(targetPath: string, contents: string): Promise<void> {
  const handle = await open(targetPath, 'wx', 0o600);
  let writeFailed = false;
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } catch (error) {
    writeFailed = true;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      if (!writeFailed) throw error;
    }
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath);
    return true;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false;
    throw error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === code;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
