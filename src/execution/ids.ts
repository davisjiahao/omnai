import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureExecutionLayout, executionRoot } from './paths.js';

export type ExecutionIdKind = 'contract' | 'wave' | 'run' | 'commitset' | 'evidence' | 'attention';

const definitions = {
  contract: ['contracts', 'CTR', /^CTR-(\d{4})$/],
  wave: ['waves', 'WAVE', /^WAVE-(\d{4})\.yaml$/],
  run: ['runs', 'RUN', /^RUN-(\d{4})$/],
  commitset: ['commitsets', 'CST', /^CST-(\d{4})\.yaml$/],
  evidence: ['evidence', 'EVD', /^EVD-(\d{4})\.yaml$/],
  attention: ['attention', 'ATTN', /^ATTN-(\d{4})\.yaml$/],
} as const satisfies Record<ExecutionIdKind, readonly [string, string, RegExp]>;

/** Callers must serialize allocation with the Workset mutation lock. */
export async function nextExecutionId(home: string, worksetId: string, kind: ExecutionIdKind): Promise<string> {
  await ensureExecutionLayout(home, worksetId);
  const [directory, prefix, pattern] = definitions[kind];
  const entries = await readdir(join(executionRoot(home, worksetId), directory));
  let maximum = 0;
  for (const entry of entries) {
    const match = pattern.exec(entry);
    if (match) maximum = Math.max(maximum, Number(match[1]));
  }
  if (maximum === 9999) throw new Error(`EXECUTION_ID_EXHAUSTED: ${kind}`);
  return `${prefix}-${String(maximum + 1).padStart(4, '0')}`;
}
