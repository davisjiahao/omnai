import path from 'node:path';
import { z } from 'zod';
import { AiWorkspaceError } from '../domain/errors';
import type { WorkspaceLockInfo, WorkspaceState } from '../domain/types';
import { isPortablePathComponent } from '../domain/validation';

const absolutePathSchema = z.string().min(1).refine(value => path.isAbsolute(value), {
  message: 'Path must be absolute'
});
const commitSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const timestampSchema = z.iso.datetime({ offset: true });
const identifierSchema = z.string().refine(isPortablePathComponent, {
  message: 'ID must be a safe portable path component'
});

const requirementSchema = z.object({
  id: identifierSchema,
  title: z.string().min(1)
}).strict();

export const workspaceRepositoryStateSchema = z.object({
  id: identifierSchema,
  displayName: z.string().min(1),
  sourcePath: absolutePathSchema,
  worktreePath: absolutePathSchema,
  remote: z.string().min(1),
  baseRef: z.string().min(1),
  baseCommit: commitSchema,
  branch: z.string().min(1),
  branchExistedBefore: z.boolean(),
  branchCreatedByOperation: z.boolean(),
  branchInitialCommit: commitSchema,
  worktreeCreated: z.boolean()
}).strict();

const recoverySchema = z.object({
  operation: z.enum(['create', 'resume', 'finish']),
  stage: z.string().min(1),
  repositoryId: identifierSchema.optional(),
  message: z.string().min(1)
}).strict();

const workspaceRepositoriesSchema = z.array(workspaceRepositoryStateSchema)
  .min(1)
  .superRefine((repositories, context) => {
    const seen = new Set<string>();
    repositories.forEach((repository, index) => {
      if (seen.has(repository.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate repository id: ${repository.id}`,
          path: [index, 'id']
        });
      }
      seen.add(repository.id);
    });
  });

export const workspaceStateSchema = z.object({
  version: z.literal(1),
  status: z.enum(['creating', 'ready', 'recoveryRequired', 'finished']),
  requirement: requirementSchema,
  workspacePath: absolutePathSchema,
  branchName: z.string().min(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  openCodexOnNextActivation: z.boolean(),
  repositories: workspaceRepositoriesSchema,
  recovery: recoverySchema.optional()
}).strict().superRefine((state, context) => {
  if (state.status === 'recoveryRequired' && state.recovery === undefined) {
    context.addIssue({
      code: 'custom',
      message: 'recoveryRequired state must include recovery details',
      path: ['recovery']
    });
  }
  if (state.status !== 'recoveryRequired' && state.recovery !== undefined) {
    context.addIssue({
      code: 'custom',
      message: 'Only recoveryRequired state may include recovery details',
      path: ['recovery']
    });
  }
  const repositoryId = state.recovery?.repositoryId;
  if (repositoryId !== undefined
    && !state.repositories.some(repository => repository.id === repositoryId)) {
    context.addIssue({
      code: 'custom',
      message: `Recovery repository does not exist: ${repositoryId}`,
      path: ['recovery', 'repositoryId']
    });
  }
});

export const workspaceLockInfoSchema = z.object({
  token: z.string().min(1),
  processId: z.number().int().positive().safe(),
  operation: z.enum(['create', 'recover', 'finish']),
  startedAt: timestampSchema
}).strict();

export const protocolGuardInfoSchema = z.object({
  version: z.literal(1),
  token: z.uuid(),
  processId: z.number().int().positive().safe(),
  startedAt: timestampSchema
}).strict();

export type ProtocolGuardInfo = z.infer<typeof protocolGuardInfoSchema>;

export function parseWorkspaceState(value: unknown): WorkspaceState {
  const parsed = workspaceStateSchema.safeParse(value);
  if (!parsed.success) {
    throw new AiWorkspaceError(
      'RECOVERY_REQUIRED',
      'Invalid workspace state',
      { issues: parsed.error.issues }
    );
  }
  return parsed.data as WorkspaceState;
}

export function parseWorkspaceLockInfo(value: unknown): WorkspaceLockInfo {
  const parsed = workspaceLockInfoSchema.safeParse(value);
  if (!parsed.success) {
    throw new AiWorkspaceError(
      'RECOVERY_REQUIRED',
      'Invalid workspace lock',
      { issues: parsed.error.issues }
    );
  }
  return parsed.data;
}

export function parseProtocolGuardInfo(value: unknown): ProtocolGuardInfo {
  const parsed = protocolGuardInfoSchema.safeParse(value);
  if (!parsed.success) {
    throw new AiWorkspaceError(
      'RECOVERY_REQUIRED',
      'Invalid workspace lock guard',
      { issues: parsed.error.issues }
    );
  }
  return parsed.data;
}
