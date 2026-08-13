import type { Workset } from './types.js';

export function worksetBranchName(workset: Workset): string {
  return `omnai/${workset.id}-${workset.slug}`;
}
