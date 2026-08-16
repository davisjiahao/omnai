import { execFileSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { pathExists, readYaml, writeYaml } from '../core/files.js';
import { projectRegistryPath } from './paths.js';
import {
  projectRegistrySchema,
  type ProjectRegistry,
  type RegisteredProject,
} from './types.js';

export async function loadProjectRegistry(home: string): Promise<ProjectRegistry> {
  const path = projectRegistryPath(home);
  if (!(await pathExists(path))) {
    return projectRegistrySchema.parse({ schemaVersion: 1, projects: [] });
  }
  return readYaml(path, projectRegistrySchema);
}

export async function listRegisteredProjects(home: string): Promise<RegisteredProject[]> {
  const registry = await loadProjectRegistry(home);
  return [...registry.projects].sort((left, right) => left.alias.localeCompare(right.alias));
}

export async function registerProject(home: string, repositoryPath: string, alias?: string): Promise<RegisteredProject> {
  const root = resolveGitRoot(repositoryPath);
  const registry = await loadProjectRegistry(home);
  const existingByPath = registry.projects.find((project) => resolve(project.path) === root);
  if (existingByPath) return existingByPath;

  const normalizedAlias = normalizeAlias(alias ?? basename(root));
  const existingByAlias = registry.projects.find((project) => project.alias === normalizedAlias);
  if (existingByAlias) {
    throw new Error(`Project alias '${normalizedAlias}' is already registered for ${existingByAlias.path}`);
  }

  const project: RegisteredProject = {
    alias: normalizedAlias,
    name: basename(root),
    path: root,
    registeredAt: new Date().toISOString(),
  };
  registry.projects.push(project);
  registry.projects.sort((left, right) => left.alias.localeCompare(right.alias));
  await writeYaml(projectRegistryPath(home), registry);
  return project;
}

export async function requireRegisteredProject(home: string, alias: string): Promise<RegisteredProject> {
  const registry = await loadProjectRegistry(home);
  const project = registry.projects.find((item) => item.alias === alias);
  if (!project) throw new Error(`Project '${alias}' is not registered.`);
  return project;
}

function resolveGitRoot(repositoryPath: string): string {
  try {
    return resolve(execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: repositoryPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
  } catch {
    throw new Error(`Path '${repositoryPath}' is not a Git repository.`);
  }
}

function normalizeAlias(value: string): string {
  const alias = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!alias) throw new Error(`Unable to derive a project alias from '${value}'.`);
  return alias;
}
