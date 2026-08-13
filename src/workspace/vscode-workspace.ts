import { writeTextAtomic } from '../core/files.js';
import { worksetVsCodePath } from './paths.js';
import type { Workset } from './types.js';

export async function syncVsCodeWorkspace(home: string, workset: Workset): Promise<string> {
  const folders = workset.members
    .filter((member) => member.status === 'ACTIVE')
    .map((member) => {
      if (!member.worktree) throw new Error(`Active project '${member.project}' is missing its Workset worktree.`);
      return { name: member.project, path: member.worktree };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  const path = worksetVsCodePath(home, workset.id, workset.slug);
  const document = {
    folders,
    settings: { 'omnai.worksetId': workset.id },
  };
  await writeTextAtomic(path, `${JSON.stringify(document, null, 2)}\n`);
  return path;
}
