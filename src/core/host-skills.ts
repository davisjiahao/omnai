import { cp, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectConfig } from '../domain/types.js';
import { ensureDir } from './files.js';
import { initializeProject, loadProjectConfig, saveProjectConfig } from './store.js';

export type SupportedHost = 'claude' | 'codex' | 'opencode';

const HOST_DIRECTORIES: Record<SupportedHost, string> = {
  claude: '.claude/skills',
  codex: '.codex/skills',
  opencode: '.opencode/skills',
};

export async function installHostSkills(repoRoot: string, host: SupportedHost): Promise<string[]> {
  const sourceRoot = locateSkillsRoot();
  const destinationRoot = join(repoRoot, HOST_DIRECTORIES[host]);
  const entries = (await readdir(sourceRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && existsSync(join(sourceRoot, entry.name, 'SKILL.md')));

  for (const entry of entries) {
    const destination = join(destinationRoot, entry.name);
    if (!existsSync(destination)) continue;
    const skillPath = join(destination, 'SKILL.md');
    if (!existsSync(skillPath)) throw new Error(`Refusing to overwrite existing foreign skill directory '${destination}'`);
    const content = await readFile(skillPath, 'utf8');
    const name = /^name:\s*([^\r\n]+)$/m.exec(content)?.[1]?.trim();
    if (name !== entry.name || !/^# OmnAI\b/m.test(content)) {
      throw new Error(`Refusing to overwrite existing foreign skill '${destination}'`);
    }
  }

  await initializeProject(repoRoot);
  await ensureDir(destinationRoot);
  const installed: string[] = [];
  for (const entry of entries) {
    const source = join(sourceRoot, entry.name);
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
