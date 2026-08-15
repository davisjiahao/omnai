import path from 'node:path';
import { AiWorkspaceError } from './errors';

const PORTABLE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;
const MAX_PORTABLE_COMPONENT_LENGTH = 255;

export function isPortablePathComponent(value: string): boolean {
  return value.length <= MAX_PORTABLE_COMPONENT_LENGTH
    && PORTABLE_ID.test(value)
    && !WINDOWS_DEVICE.test(value);
}

export function normalizeRequirementId(raw: string): string {
  const value = raw.trim();
  if (!isPortablePathComponent(value)) {
    throw new AiWorkspaceError('VALIDATION', `Invalid requirement id: ${raw}`);
  }
  return value;
}

export function renderBranchName(pattern: string, requirementId: string): string {
  const occurrences = pattern.split('{requirementId}').length - 1;
  if (occurrences !== 1) {
    throw new AiWorkspaceError(
      'CONFIG',
      'branchPattern must contain {requirementId} exactly once'
    );
  }
  return pattern.replace('{requirementId}', normalizeRequirementId(requirementId));
}

export function assertPathInside(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '' || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new AiWorkspaceError('VALIDATION', `Path is outside workspaceRoot: ${candidate}`);
  }
}
