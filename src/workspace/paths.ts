import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function resolveOmnaiHome(env: NodeJS.ProcessEnv = process.env, homeDirectory = homedir()): string {
  return env.OMNAI_HOME ? resolve(env.OMNAI_HOME) : join(homeDirectory, '.omnai');
}

export function personalConfigPath(home: string): string {
  return join(home, 'config.yaml');
}

export function projectRegistryPath(home: string): string {
  return join(home, 'projects.yaml');
}

export function worksetsRoot(home: string): string {
  return join(home, 'worksets');
}

export function worksetRoot(home: string, id: string): string {
  return join(worksetsRoot(home), id);
}

export function worksetManifestPath(home: string, id: string): string {
  return join(worksetRoot(home, id), 'workset.yaml');
}

export function worksetWorkspaceRoot(home: string, id: string): string {
  return join(worksetRoot(home, id), 'workspace');
}

export function worksetVsCodePath(home: string, id: string, slug: string): string {
  return join(worksetRoot(home, id), `${slug}.code-workspace`);
}
