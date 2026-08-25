import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { RunPacket } from '../packets.js';

const permissionOptionSchema = z.strictObject({
  optionId: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
});

const permissionOptionsShape = {
  options: z.array(permissionOptionSchema).min(1).readonly(),
};

export const normalizedPermissionRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('read-file'),
    path: z.string().min(1),
    ...permissionOptionsShape,
  }),
  z.strictObject({
    kind: z.literal('write-file'),
    path: z.string().min(1),
    ...permissionOptionsShape,
  }),
  z.strictObject({
    kind: z.literal('terminal'),
    command: z.array(z.string()).min(1).readonly(),
    cwd: z.string().min(1),
    ...permissionOptionsShape,
  }),
  z.strictObject({
    kind: z.literal('network'),
    host: z.string().min(1),
    ...permissionOptionsShape,
  }),
]).superRefine((request, context) => {
  const optionIds = new Set<string>();
  for (let index = 0; index < request.options.length; index += 1) {
    const optionId = request.options[index]!.optionId;
    if (optionIds.has(optionId)) {
      context.addIssue({ code: 'custom', path: ['options', index, 'optionId'], message: 'PERMISSION_OPTION_ID_DUPLICATE' });
    }
    optionIds.add(optionId);
  }
});

export type PermissionRequest = z.infer<typeof normalizedPermissionRequestSchema>;

export type PermissionDecision =
  | { outcome: 'ALLOW_ONCE'; optionId: string; reason: string }
  | { outcome: 'DENY'; optionId?: string; reason: string };

const forbiddenGit = new Set(['commit', 'reset', 'checkout', 'switch', 'worktree', 'clean', 'update-ref']);
const forbiddenLaunchers = new Set(['sh', 'bash', 'zsh', 'fish', 'cmd', 'cmd.exe', 'powershell', 'pwsh', 'env']);
const environmentNamePattern = /^[A-Z_][A-Z0-9_]*$/;

export function evaluatePermission(packet: RunPacket, request: PermissionRequest): PermissionDecision {
  const parsed = normalizedPermissionRequestSchema.safeParse(request);
  if (!parsed.success) return deny(requestOptions(request), 'PERMISSION_REQUEST_INVALID');
  const normalized = parsed.data;

  if (normalized.kind === 'network') {
    return packet.permissionPolicy.network === 'ALLOW'
      ? allow(normalized.options, 'PACKET_NETWORK_AUTHORIZED')
      : deny(normalized.options, 'NETWORK_NOT_AUTHORIZED');
  }

  if (normalized.kind === 'read-file') {
    return pathWithinAnyRoot(normalized.path, packet.permissionPolicy.filesystemRoots)
      ? allow(normalized.options, 'PACKET_READ_AUTHORIZED')
      : deny(normalized.options, 'PATH_OUTSIDE_PACKET_ROOTS');
  }

  if (normalized.kind === 'write-file') {
    if (packet.kind !== 'PROJECT_WRITER' && packet.kind !== 'RECOVERY_WRITER') {
      return deny(normalized.options, 'READ_ONLY_RUN');
    }
    if (!pathWithinAnyRoot(normalized.path, packet.permissionPolicy.filesystemRoots)) {
      return deny(normalized.options, 'PATH_OUTSIDE_PACKET_ROOTS');
    }
    const worktree = resolveWithExistingAncestor(packet.git.worktree);
    const target = resolveWithExistingAncestor(normalized.path);
    if (!worktree || !target || !isEqualOrDescendant(worktree, target)) {
      return deny(normalized.options, 'PATH_OUTSIDE_PROJECT_WORKTREE');
    }
    const projectRelative = relative(worktree, target).split(sep).join('/');
    if (projectRelative.length === 0 || !packet.allowedPaths.some((pattern) => matchesProjectGlob(pattern, projectRelative))) {
      return deny(normalized.options, 'PATH_NOT_ALLOWED_BY_PACKET');
    }
    return allow(normalized.options, 'PACKET_WRITE_AUTHORIZED');
  }

  if (!packet.permissionPolicy.terminal) return deny(normalized.options, 'TERMINAL_NOT_AUTHORIZED');
  if (!pathWithinAnyRoot(normalized.cwd, packet.permissionPolicy.filesystemRoots)) {
    return deny(normalized.options, 'TERMINAL_CWD_OUTSIDE_PACKET_ROOTS');
  }
  if (isForbiddenTerminalCommand(normalized.command)) {
    return deny(normalized.options, terminalDenialReason(normalized.command));
  }
  return allow(normalized.options, 'PACKET_TERMINAL_AUTHORIZED');
}

export function resolveSecretEnvironment(
  profile: { readonly envRefs: Readonly<Record<string, string>> },
  sourceEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const resolvedEnvironment: Record<string, string> = {};
  for (const [targetName, referenceName] of Object.entries(profile.envRefs).sort(([left], [right]) => compare(left, right))) {
    if (!environmentNamePattern.test(targetName) || !environmentNamePattern.test(referenceName)) {
      throw new Error(`SECRET_REFERENCE_NAME_INVALID: ${targetName} -> ${referenceName}`);
    }
    const value = sourceEnv[referenceName];
    if (value === undefined) {
      throw new Error(`SECRET_REFERENCE_MISSING: ${referenceName}`);
    }
    resolvedEnvironment[targetName] = value;
  }
  return resolvedEnvironment;
}

export function redactSecrets<T>(value: T, values: readonly string[]): T {
  const secrets = [...new Set(values.filter((item) => item.length > 0))]
    .sort((left, right) => right.length - left.length || compare(left, right));
  return redactValue(value, secrets, new Set()) as T;
}

function allow(
  options: readonly z.infer<typeof permissionOptionSchema>[],
  reason: string,
): PermissionDecision {
  const option = options.find((item) => item.kind === 'allow_once');
  if (!option) return deny(options, 'ALLOW_ONCE_OPTION_REQUIRED');
  return { outcome: 'ALLOW_ONCE', optionId: option.optionId, reason };
}

function deny(
  options: readonly z.infer<typeof permissionOptionSchema>[] | undefined,
  reason: string,
): PermissionDecision {
  const option = options?.find((item) => item.kind === 'reject_once') ??
    options?.find((item) => item.kind === 'reject_always');
  return option
    ? { outcome: 'DENY', optionId: option.optionId, reason }
    : { outcome: 'DENY', reason };
}

function requestOptions(value: unknown): readonly z.infer<typeof permissionOptionSchema>[] | undefined {
  if (value === null || typeof value !== 'object' || !('options' in value)) return undefined;
  const parsed = z.array(permissionOptionSchema).safeParse((value as { options: unknown }).options);
  return parsed.success ? parsed.data : undefined;
}

function pathWithinAnyRoot(path: string, roots: readonly string[]): boolean {
  if (!isAbsolute(path)) return false;
  const target = resolveWithExistingAncestor(path);
  if (!target) return false;
  return roots.some((root) => {
    const resolvedRoot = resolveWithExistingAncestor(root);
    return resolvedRoot !== null && isEqualOrDescendant(resolvedRoot, target);
  });
}

function resolveWithExistingAncestor(path: string): string | null {
  if (!isAbsolute(path)) return null;
  const absolute = resolve(path);
  const suffix: string[] = [];
  let cursor = absolute;
  while (!pathEntryExists(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  try {
    return resolve(realpathSync.native(cursor), ...suffix);
  } catch {
    return null;
  }
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    return false;
  }
}

function isEqualOrDescendant(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
}

function matchesProjectGlob(pattern: string, path: string): boolean {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        expression += '(?:.*/)?';
        index += 2;
      } else {
        expression += '.*';
        index += 1;
      }
    } else if (character === '*') {
      expression += '[^/]*';
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  expression += '$';
  return new RegExp(expression).test(path);
}

function isForbiddenTerminalCommand(command: readonly string[]): boolean {
  const executable = basename(command[0] ?? '').toLowerCase();
  if (forbiddenLaunchers.has(executable)) return true;
  if (executable === 'git' && command.slice(1).some((argument) => forbiddenGit.has(argument))) return true;
  return command.some((argument, index) =>
    basename(argument).toLowerCase() === 'omnai' && command[index + 1] === 'run');
}

function terminalDenialReason(command: readonly string[]): string {
  const executable = basename(command[0] ?? '').toLowerCase();
  if (executable === 'git' && command.slice(1).some((argument) => forbiddenGit.has(argument))) {
    return 'FINAL_OR_DESTRUCTIVE_GIT';
  }
  if (command.some((argument, index) => basename(argument).toLowerCase() === 'omnai' && command[index + 1] === 'run')) {
    return 'NESTED_OMNAI_RUN';
  }
  return 'UNBOUNDED_COMMAND_LAUNCHER';
}

function redactValue(value: unknown, secrets: readonly string[], ancestors: Set<object>): unknown {
  if (typeof value === 'string') return redactString(value, secrets);
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.has(value)) throw new Error('SECRET_REDACTION_VALUE_INVALID: circular value');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets, ancestors));
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [redactString(key, secrets), redactValue(item, secrets, ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}

function redactString(value: string, secrets: readonly string[]): string {
  return secrets.reduce((redacted, secret) => redacted.split(secret).join('[REDACTED]'), value);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
