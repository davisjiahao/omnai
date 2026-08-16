import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  pathExists,
  readText,
  readYaml,
  writeTextAtomic,
  writeYaml,
} from '../core/files.js';
import { OMNAI_VERSION } from '../version.js';
import { hostManifestPath } from '../workspace/paths.js';

export const USER_HOSTS = ['claude', 'codex', 'opencode'] as const;
export const ENTRY_SKILLS = [
  'omnai',
  'omnai-grill',
  'omnai-brainstorm',
  'omnai-reconcile',
] as const;
export const USER_HOST_STATUS_VALUES = [
  'READY',
  'OUTDATED',
  'NOT_INSTALLED',
  'FOREIGN',
  'MISSING',
  'DRIFTED',
] as const;

export type UserHost = (typeof USER_HOSTS)[number];
export type EntrySkill = (typeof ENTRY_SKILLS)[number];
export type UserHostStatusValue = (typeof USER_HOST_STATUS_VALUES)[number];

const userHostSchema = z.enum(USER_HOSTS);
const entrySkillSchema = z.enum(ENTRY_SKILLS);

export const userHostManifestSchema = z.object({
  schemaVersion: z.literal(1),
  host: userHostSchema,
  omnaiVersion: z.string().min(1),
  destination: z.string().min(1),
  skills: z.array(z.object({
    name: entrySkillSchema,
    hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })),
  installedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type UserHostManifest = z.infer<typeof userHostManifestSchema>;

export interface UserHostStatus {
  host: UserHost;
  status: UserHostStatusValue;
  destination: string;
  manifestPath: string;
  installedVersion: string | null;
  currentVersion: string;
  details: string[];
}

export interface UserHostInstallResult {
  host: UserHost;
  action: 'INSTALLED' | 'UPDATED' | 'UNCHANGED';
  destination: string;
  manifestPath: string;
  skills: EntrySkill[];
}

interface CanonicalSkill {
  name: EntrySkill;
  content: string;
  hash: string;
}

export function hostSkillDestination(userHome: string, host: UserHost): string {
  const root = resolve(userHome);
  if (host === 'claude') return join(root, '.claude', 'skills');
  if (host === 'codex') return join(root, '.agents', 'skills');
  return join(root, '.config', 'opencode', 'skills');
}

export async function getUserHostSkillStatus(
  omnaiHome: string,
  userHome: string,
  host: UserHost,
  sourceRoot?: string,
): Promise<UserHostStatus> {
  const canonical = await loadCanonicalSkills(sourceRoot);
  return statusWithCanonical(omnaiHome, userHome, host, canonical);
}

export async function listUserHostSkillStatuses(
  omnaiHome: string,
  userHome: string,
  hosts: UserHost[] = [...USER_HOSTS],
  sourceRoot?: string,
): Promise<UserHostStatus[]> {
  const canonical = await loadCanonicalSkills(sourceRoot);
  const selected = uniqueHosts(hosts);
  const statuses: UserHostStatus[] = [];
  for (const host of selected) {
    statuses.push(await statusWithCanonical(omnaiHome, userHome, host, canonical));
  }
  return statuses;
}

export async function installUserHostSkills(
  omnaiHome: string,
  userHome: string,
  hosts: UserHost[],
  sourceRoot?: string,
): Promise<UserHostInstallResult[]> {
  const selected = uniqueHosts(hosts);
  if (selected.length === 0) return [];
  const canonical = await loadCanonicalSkills(sourceRoot);

  const preflight: UserHostStatus[] = [];
  for (const host of selected) {
    preflight.push(await statusWithCanonical(omnaiHome, userHome, host, canonical));
  }
  const blocked = preflight.filter((item) => !['READY', 'OUTDATED', 'NOT_INSTALLED'].includes(item.status));
  if (blocked.length > 0) {
    const summary = blocked
      .map((item) => `${item.host}=${item.status}${item.details.length > 0 ? ` (${item.details.join('; ')})` : ''}`)
      .join(', ');
    throw new Error(`Refusing to install OmnAI Host Skills because preflight found unsafe state: ${summary}`);
  }

  const results: UserHostInstallResult[] = [];
  for (const status of preflight) {
    if (status.status === 'READY') {
      results.push({
        host: status.host,
        action: 'UNCHANGED',
        destination: status.destination,
        manifestPath: status.manifestPath,
        skills: [...ENTRY_SKILLS],
      });
      continue;
    }

    const previous = status.status === 'OUTDATED'
      ? await readYaml(status.manifestPath, userHostManifestSchema)
      : null;
    for (const skill of canonical) {
      await writeTextAtomic(skillFilePath(status.destination, skill.name), skill.content);
    }

    const now = new Date().toISOString();
    const manifest: UserHostManifest = userHostManifestSchema.parse({
      schemaVersion: 1,
      host: status.host,
      omnaiVersion: OMNAI_VERSION,
      destination: status.destination,
      skills: canonical.map((skill) => ({ name: skill.name, hash: skill.hash })),
      installedAt: previous?.installedAt ?? now,
      updatedAt: now,
    });
    await writeYaml(status.manifestPath, manifest);
    results.push({
      host: status.host,
      action: status.status === 'OUTDATED' ? 'UPDATED' : 'INSTALLED',
      destination: status.destination,
      manifestPath: status.manifestPath,
      skills: [...ENTRY_SKILLS],
    });
  }
  return results;
}

export function locateCanonicalSkillsRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const candidates = [
    resolve(dirname(currentFile), '../../skills'),
    resolve(dirname(currentFile), '../../../skills'),
    resolve(process.cwd(), 'skills'),
  ];
  const match = candidates.find((candidate) => existsSync(join(candidate, 'omnai', 'SKILL.md')));
  if (!match) {
    throw new Error(`Unable to locate packaged OmnAI Skills. Checked: ${candidates.join(', ')}`);
  }
  return match;
}

async function statusWithCanonical(
  omnaiHome: string,
  userHome: string,
  host: UserHost,
  canonical: CanonicalSkill[],
): Promise<UserHostStatus> {
  const destination = hostSkillDestination(userHome, host);
  const manifestPath = hostManifestPath(omnaiHome, host);
  if (!(await pathExists(manifestPath))) {
    const foreign: string[] = [];
    for (const skill of ENTRY_SKILLS) {
      if (await pathExists(join(destination, skill))) foreign.push(skill);
    }
    return buildStatus(
      host,
      foreign.length > 0 ? 'FOREIGN' : 'NOT_INSTALLED',
      destination,
      manifestPath,
      null,
      foreign.map((skill) => `Unowned Skill directory '${skill}' exists.`),
    );
  }

  const manifest = await readYaml(manifestPath, userHostManifestSchema);
  const structuralDrift: string[] = [];
  if (manifest.host !== host) {
    structuralDrift.push(`Manifest host is '${manifest.host}', expected '${host}'.`);
  }
  if (resolve(manifest.destination) !== resolve(destination)) {
    structuralDrift.push(`Manifest destination is '${manifest.destination}', expected '${destination}'.`);
  }

  const manifestByName = new Map(manifest.skills.map((item) => [item.name, item]));
  const missing: string[] = [];
  const drifted: string[] = [...structuralDrift];
  for (const skill of ENTRY_SKILLS) {
    const recorded = manifestByName.get(skill);
    if (!recorded) {
      missing.push(`Manifest does not own '${skill}'.`);
      continue;
    }
    const path = skillFilePath(destination, skill);
    if (!(await pathExists(path))) {
      missing.push(`Managed Skill '${skill}' is missing.`);
      continue;
    }
    const actualHash = hash(await readText(path));
    if (actualHash !== recorded.hash) {
      drifted.push(`Managed Skill '${skill}' differs from its recorded hash.`);
    }
  }
  for (const recorded of manifest.skills) {
    if (!(ENTRY_SKILLS as readonly string[]).includes(recorded.name)) {
      drifted.push(`Manifest contains unexpected Skill '${recorded.name}'.`);
    }
  }

  if (missing.length > 0) {
    return buildStatus(host, 'MISSING', destination, manifestPath, manifest.omnaiVersion, missing);
  }
  if (drifted.length > 0) {
    return buildStatus(host, 'DRIFTED', destination, manifestPath, manifest.omnaiVersion, drifted);
  }

  const currentByName = new Map(canonical.map((skill) => [skill.name, skill]));
  const outdated: string[] = [];
  if (manifest.omnaiVersion !== OMNAI_VERSION) {
    outdated.push(`Installed version '${manifest.omnaiVersion}' differs from '${OMNAI_VERSION}'.`);
  }
  for (const skill of ENTRY_SKILLS) {
    const recorded = manifestByName.get(skill);
    const current = currentByName.get(skill);
    if (!recorded || !current || recorded.hash !== current.hash) {
      outdated.push(`Canonical Skill '${skill}' has a newer packaged hash.`);
    }
  }
  if (outdated.length > 0) {
    return buildStatus(host, 'OUTDATED', destination, manifestPath, manifest.omnaiVersion, outdated);
  }

  return buildStatus(host, 'READY', destination, manifestPath, manifest.omnaiVersion, []);
}

async function loadCanonicalSkills(sourceRoot?: string): Promise<CanonicalSkill[]> {
  const root = resolve(sourceRoot ?? locateCanonicalSkillsRoot());
  const skills: CanonicalSkill[] = [];
  for (const name of ENTRY_SKILLS) {
    const path = join(root, name, 'SKILL.md');
    if (!(await pathExists(path))) {
      throw new Error(`Canonical OmnAI Skill '${name}' was not found at ${path}`);
    }
    const content = await readText(path);
    skills.push({ name, content, hash: hash(content) });
  }
  return skills;
}

function buildStatus(
  host: UserHost,
  status: UserHostStatusValue,
  destination: string,
  manifestPath: string,
  installedVersion: string | null,
  details: string[],
): UserHostStatus {
  return {
    host,
    status,
    destination,
    manifestPath,
    installedVersion,
    currentVersion: OMNAI_VERSION,
    details,
  };
}

function skillFilePath(destination: string, skill: EntrySkill): string {
  return join(destination, skill, 'SKILL.md');
}

function hash(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function uniqueHosts(hosts: UserHost[]): UserHost[] {
  const selected = new Set(hosts);
  return USER_HOSTS.filter((host) => selected.has(host));
}
