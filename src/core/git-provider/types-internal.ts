import { z } from 'zod';
import { sha256Schema, type Sha256 } from '../../domain/scalars.js';

export const FIXED_GIT_CANDIDATES = Object.freeze([
  '/usr/local/bin/git',
  '/usr/bin/git',
] as const);

export const frozenGitProviderBindingBodySchema = z.strictObject({
  schemaVersion: z.literal(1),
  environmentProtocol: z.literal('SANITIZED_GIT_ENV_V1'),
  executionProtocol: z.literal('VERIFIED_FD_EXECVEAT_V1'),
  executableCandidatePath: z.enum(FIXED_GIT_CANDIDATES),
  executableRealPath: z.enum(FIXED_GIT_CANDIDATES),
  executableRawBytesHash: sha256Schema,
  gitVersion: z.string().regex(/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*))?$/u),
});

export const frozenGitProviderBindingSchema = frozenGitProviderBindingBodySchema.extend({
  bindingHash: sha256Schema,
});

export type FrozenGitProviderBindingBodyV1 = Readonly<z.infer<typeof frozenGitProviderBindingBodySchema>>;
export type FrozenGitProviderBindingV1 = Readonly<z.infer<typeof frozenGitProviderBindingSchema>>;

export type GitCommandInputV1 = Readonly<{
  repositoryRoot: string;
  args: readonly string[];
}>;

export type GitCommandResultV1 = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export type GitProviderBindingHash = Sha256;
