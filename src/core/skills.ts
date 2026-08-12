import { cp, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectConfig } from '../domain/types.js';
import { ensureDir, pathExists } from './files.js';
import { loadProjectConfig, saveProjectConfig } from './store.js';

export type SupportedHost = 'claude' | 'codex' | 'opencode';

const HOST_DIRECTORIES: Record<SupportedHost, string> = {
  claude: '.claude/skills',
  codex: '.codex/skills',
  opencode: '.opencode/skills',
};

export async function installHostSkills(repoRoot: string, host: SupportedHost): Promise<string[]> {
  const sourceRoot = locateSkillsRoot();
  if (!(await pathExists(join(sourceRoot, 'omnai', 'SKILL.md')))) {
    throw new Error(`Packaged OmnAI skills were not found at ${sourceRoot}`);
  }
  const destinationRoot = join(repoRoot, HOST_DIRECTORIES[host]);
  await ensureDir(destinationRoot);
  const installed: string[] = [];
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
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
  return candidates.find((candidate) => pathExistsSync(join(candidate, 'omnai', 'SKILL.md'))) ?? candidates[0];
}

function pathExistsSync(path: string): boolean {
  try {
    const { statSync } = requireFs();
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function requireFs(): typeof import('node:fs') {
  // Kept in a function so browser-oriented bundlers do not eagerly evaluate it.
  return globalThis.process.getBuiltinModule?.('node:fs') as typeof import('node:fs') ?? failBuiltin();
}

function failBuiltin(): never {
  throw new Error('Node.js built-in module loading is unavailable');
}
