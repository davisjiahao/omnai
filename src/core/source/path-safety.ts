import {
  changeArtifactPathSchema,
  repositoryCodePathSchema,
  type ChangeArtifactPath,
  type RepositoryCodePath,
} from '../../domain/public.js';
import { SourceResolutionError } from './types.js';

export function requireSafeArtifactPath(value: unknown): ChangeArtifactPath {
  const parsed = changeArtifactPathSchema.safeParse(value);
  if (!parsed.success || entersReservedDirectory(parsed.data)) return invalidPath();
  return parsed.data;
}

export function requireSafeRepositoryCodePath(value: unknown): RepositoryCodePath {
  const parsed = repositoryCodePathSchema.safeParse(value);
  if (!parsed.success) return invalidPath();
  return parsed.data;
}

function entersReservedDirectory(path: string): boolean {
  return path.split('/').some((segment) => segment === '.git' || segment === '.omnai');
}

function invalidPath(): never {
  throw new SourceResolutionError('SOURCE_LOCATOR_INVALID', 'locator');
}
