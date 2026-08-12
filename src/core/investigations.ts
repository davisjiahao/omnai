import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir, pathExists, readText, writeTextAtomic, writeYaml } from './files.js';
import { omnaiRoot } from './paths.js';
import { createChange, initializeProject, type ChangeRef } from './store.js';

export type InvestigationKind = 'system-query' | 'field-lineage' | 'business-flow';

export interface InvestigationRef {
  id: string;
  kind: InvestigationKind;
  query: string;
  directory: string;
}

export async function createInvestigation(
  repoRoot: string,
  kind: InvestigationKind,
  query: string,
): Promise<InvestigationRef> {
  await initializeProject(repoRoot);
  const id = await nextInvestigationId(repoRoot);
  const directory = join(investigationsRoot(repoRoot), `${id}-${kind}`);
  await ensureDir(directory);
  const now = new Date().toISOString();
  await writeYaml(join(directory, 'investigation.yaml'), {
    schemaVersion: 1,
    id,
    kind,
    query,
    status: 'OPEN',
    createdAt: now,
    updatedAt: now,
    promotedChange: null,
  });
  await writeTextAtomic(join(directory, 'research.md'), investigationTemplate(kind, query));
  return { id, kind, query, directory };
}

export async function promoteInvestigation(
  repoRoot: string,
  investigationId: string,
  changeTitle: string,
  scenario = 'small-feature',
): Promise<ChangeRef> {
  const investigation = await resolveInvestigation(repoRoot, investigationId);
  const change = await createChange(repoRoot, changeTitle, scenario);
  const sourceResearch = join(investigation.directory, 'research.md');
  const targetResearch = join(repoRoot, '.omnai', 'changes', change.directoryName, 'research.md');
  const research = await readText(sourceResearch);
  await writeTextAtomic(targetResearch, `${research}\n\n## Promotion\n\nPromoted from read-only investigation \`${investigation.id}\`.\n`);
  return change;
}

export async function resolveInvestigation(repoRoot: string, reference: string): Promise<InvestigationRef> {
  const root = investigationsRoot(repoRoot);
  if (!(await pathExists(root))) throw new Error(`Investigation '${reference}' was not found.`);
  const entries = await readdir(root, { withFileTypes: true });
  const entry = entries.find((candidate) => candidate.isDirectory() && (candidate.name === reference || candidate.name.startsWith(`${reference}-`)));
  if (!entry) throw new Error(`Investigation '${reference}' was not found.`);
  const match = /^(INV-\d{4})-(system-query|field-lineage|business-flow)$/.exec(entry.name);
  if (!match) throw new Error(`Invalid investigation directory '${entry.name}'.`);
  const id = match[1];
  const kind = match[2];
  if (!id || !kind) throw new Error(`Invalid investigation directory '${entry.name}'.`);
  const directory = join(root, entry.name);
  const research = await readText(join(directory, 'research.md'));
  const queryMatch = /^## Query\n\n(.+)$/m.exec(research);
  return {
    id,
    kind: kind as InvestigationKind,
    query: queryMatch?.[1] ?? '',
    directory,
  };
}

export function investigationsRoot(repoRoot: string): string {
  return join(omnaiRoot(repoRoot), 'investigations');
}

async function nextInvestigationId(repoRoot: string): Promise<string> {
  const root = investigationsRoot(repoRoot);
  await ensureDir(root);
  const entries = await readdir(root, { withFileTypes: true });
  const max = entries.reduce((current, entry) => {
    const match = /^INV-(\d{4})-/.exec(entry.name);
    return match ? Math.max(current, Number(match[1])) : current;
  }, 0);
  return `INV-${String(max + 1).padStart(4, '0')}`;
}

function investigationTemplate(kind: InvestigationKind, query: string): string {
  const focus = kind === 'field-lineage'
    ? 'Trace producers, transformations, transport, persistence, readers, and consumers. Include UI/API/DTO/DB/event/remote hops when present.'
    : kind === 'business-flow'
      ? 'Trace entry points, business branches, persistence, events, remote calls, failure paths, and ownership boundaries.'
      : 'Answer the question from current code and formal project artifacts without proposing changes.';
  return `# Read-only Investigation\n\n## Kind\n\n${kind}\n\n## Query\n\n${query}\n\n## Read-only Contract\n\nDo not modify application source code and do not create a Change unless the user explicitly promotes this investigation.\n\n## Focus\n\n${focus}\n\n## Findings\n\n## Confirmed Facts\n\n## Unknowns\n\n## Evidence References\n`;
}
