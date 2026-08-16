import { dirname, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { ensureDir, pathExists, readYaml, writeYaml } from '../core/files.js';
import { worksetMarkerPath, worksetWorkspaceRoot } from './paths.js';
import type { Workset } from './types.js';

const worksetMarkerSchema = z.object({
  schemaVersion: z.literal(1),
  worksetId: z.string().regex(/^WKS-\d{4}$/),
  manifest: z.literal('../workset.yaml'),
});

export interface ExecutionContext {
  worksetId: string;
  workspaceRoot: string;
  project?: string;
}

export async function ensureExecutionWorkspace(home: string, workset: Workset): Promise<string> {
  const root = worksetWorkspaceRoot(home, workset.id);
  await ensureDir(root);
  await writeYaml(worksetMarkerPath(home, workset.id), {
    schemaVersion: 1,
    worksetId: workset.id,
    manifest: '../workset.yaml',
  });
  return root;
}

export async function discoverExecutionContext(startPath: string): Promise<ExecutionContext | null> {
  const start = resolve(startPath);
  let current = start;

  while (true) {
    const markerPath = join(current, '.omnai-workset.yaml');
    if (await pathExists(markerPath)) {
      const marker = await readYaml(markerPath, worksetMarkerSchema);
      const context: ExecutionContext = {
        worksetId: marker.worksetId,
        workspaceRoot: current,
      };
      const descendant = relative(current, start);
      if (descendant && descendant !== '.') {
        const [project] = descendant.split(sep);
        if (project) context.project = project;
      }
      return context;
    }

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
