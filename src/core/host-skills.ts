import { cp, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectConfig } from '../domain/types.js';
import { ensureDir } from './files.js';
import { loadProjectConfig, saveProjectConfig } from './store.js';

export type SupportedHost = 'claude' | 'codex' | 'opencode';

const HOST_DIRECTORIES: Record<SupportedHost, string> = {
  claude: '.claude/skills',
  codex: '.codex/skills',
  opencode: '.opencode/skills',
};

export async function installHostSkills(repoRoot: string, host: SupportedHost): Promise<string[]> {
  const sourceRoot = locateSkillsRoot();
  const destinationRoot = join(repoRoot, HOST_DIRECTORIES[host]);
  await ensureDir(destinationRoot);
  const installed: string[] = [];
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const source = join(sourceRoot, entry.name);
    if (!existsSync(join(source, 'SKILL.md'))) continue;
    const destination = join(destinationRoot, entry.name);
    await cp(source, destination, { recursive: true, force: true });
    installed.push(destination);
  }

  const config = await loadProjectConfig(repoRoot);
  const installedHosts: ProjectConfig['installedHosts'] = [...new Set([...config.installedHosts, host])];
  await saveProjectConfig(repoRoot, { ...config, installedHosts });
  return installed;
}

export function locateSkillsRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const candidates = [
    resolve(dirname(currentFile), '../../skills'),
    resolve(dirname(currentFile), '../../../skills'),
    resolve(process.cwd(), 'skills'),
  ];
  const match = candidates.find((candidate) => existsSync(join(candidate, 'omnai', 'SKILL.md')));
  if (!match) throw new Error(`Unable to locate packaged OmnAI skills. Checked: ${candidates.join(', ')}`);
  return match;
}
