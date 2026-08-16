import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ensureDir, pathExists, readText, readYaml, writeTextAtomic, writeYaml } from './files.js';
import { omnaiRoot } from './paths.js';
import { createChange, initializeProject, type ChangeRef } from './store.js';

const INVESTIGATION_KINDS = ['system-query', 'field-lineage', 'business-flow'] as const;
export type InvestigationKind = (typeof INVESTIGATION_KINDS)[number];

const investigationMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^INV-\d{4}$/),
  kind: z.enum(INVESTIGATION_KINDS),
  query: z.string().min(1),
  status: z.enum(['OPEN', 'PROMOTED']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  promotedChange: z.string().regex(/^CHG-\d{4}$/).nullable(),
});

type InvestigationMetadata = z.infer<typeof investigationMetadataSchema>;

export interface InvestigationRef {
  id: string;
  kind: InvestigationKind;
  query: string;
  directory: string;
  status: InvestigationMetadata['status'];
  promotedChange: string | null;
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
  const metadata = investigationMetadataSchema.parse({
    schemaVersion: 1,
    id,
    kind,
    query,
    status: 'OPEN',
    createdAt: now,
    updatedAt: now,
    promotedChange: null,
  });
  await writeYaml(join(directory, 'investigation.yaml'), metadata);
  await writeTextAtomic(join(directory, 'research.md'), investigationTemplate(kind, query));
  return toInvestigationRef(directory, metadata);
}

export async function promoteInvestigation(
  repoRoot: string,
  investigationId: string,
  changeTitle: string,
  scenario = 'small-feature',
): Promise<ChangeRef> {
  const investigation = await resolveInvestigation(repoRoot, investigationId);
  if (investigation.status === 'PROMOTED') {
    throw new Error(`Investigation '${investigation.id}' was already promoted to ${investigation.promotedChange ?? 'a Change'}.`);
  }

  const change = await createChange(repoRoot, changeTitle, scenario);
  const sourceResearch = join(investigation.directory, 'research.md');
  const targetResearch = join(repoRoot, '.omnai', 'changes', change.directoryName, 'research.md');
  const research = await readText(sourceResearch);
  await writeTextAtomic(targetResearch, `${research}\n\n## Promotion\n\nPromoted from read-only investigation \`${investigation.id}\`.\n`);

  const metadataPath = join(investigation.directory, 'investigation.yaml');
  const metadata = await readYaml(metadataPath, investigationMetadataSchema);
  await writeYaml(metadataPath, investigationMetadataSchema.parse({
    ...metadata,
    status: 'PROMOTED',
    promotedChange: change.metadata.id,
    updatedAt: new Date().toISOString(),
  }));
  return change;
}

export async function resolveInvestigation(repoRoot: string, reference: string): Promise<InvestigationRef> {
  const root = investigationsRoot(repoRoot);
  if (!(await pathExists(root))) throw new Error(`Investigation '${reference}' was not found.`);
  const entries = await readdir(root, { withFileTypes: true });
  const entry = entries.find((candidate) => candidate.isDirectory() && (candidate.name === reference || candidate.name.startsWith(`${reference}-`)));
  if (!entry) throw new Error(`Investigation '${reference}' was not found.`);
  if (!/^INV-\d{4}-(system-query|field-lineage|business-flow)$/.test(entry.name)) {
    throw new Error(`Invalid investigation directory '${entry.name}'.`);
  }
  const directory = join(root, entry.name);
  const metadata = await readYaml(join(directory, 'investigation.yaml'), investigationMetadataSchema);
  return toInvestigationRef(directory, metadata);
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

function toInvestigationRef(directory: string, metadata: InvestigationMetadata): InvestigationRef {
  return {
    id: metadata.id,
    kind: metadata.kind,
    query: metadata.query,
    directory,
    status: metadata.status,
    promotedChange: metadata.promotedChange,
  };
}

function investigationTemplate(kind: InvestigationKind, query: string): string {
  const focus = kind === 'field-lineage'
    ? 'Trace producers, transformations, transport, persistence, readers, and consumers. Include UI/API/DTO/DB/event/remote hops when present.'
    : kind === 'business-flow'
      ? 'Trace entry points, business branches, persistence, events, remote calls, failure paths, and ownership boundaries.'
      : 'Answer the question from current code and formal project artifacts without proposing changes.';
  return `# Read-only Investigation\n\n## Kind\n\n${kind}\n\n## Query\n\n${query}\n\n## Read-only Contract\n\nDo not modify application source code and do not create a Change unless the user explicitly promotes this investigation.\n\n## Focus\n\n${focus}\n\n## Findings\n\n## Confirmed Facts\n\n## Unknowns\n\n## Evidence References\n`;
}
