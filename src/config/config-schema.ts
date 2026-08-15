import { z } from 'zod';
import { isPortablePathComponent } from '../domain/validation';

const PROTOTYPE_KEYS = new Set(Object.getOwnPropertyNames(Object.prototype));
const SENSITIVE_QUERY_KEYS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'credential',
  'credentials',
  'oauth_token',
  'password',
  'passwd',
  'private_token',
  'secret',
  'signature',
  'token',
  'x_amz_credential',
  'x_amz_signature'
]);

export const configIdSchema = z.string().refine(
  value => isPortablePathComponent(value) && !PROTOTYPE_KEYS.has(value),
  'ID must be a safe portable path component'
);

function configRecord<T extends z.ZodType>(valueSchema: T) {
  return z.custom<Record<string, unknown>>(
    value => typeof value === 'object'
      && value !== null
      && !Array.isArray(value)
      && Object.keys(value).every(key => configIdSchema.safeParse(key).success),
    { message: 'Record keys must be safe portable IDs' }
  ).pipe(z.record(configIdSchema, valueSchema));
}

const cloneUrlSchema = z.string().min(1).refine(isCredentialFreeCloneUrl, {
  message: 'cloneUrl must not contain credentials'
});

function isCredentialFreeCloneUrl(value: string): boolean {
  if (value.trim() !== value || /[\\\u0000-\u001f\u007f]/.test(value)) return false;
  if (/^[^/@:\s]+:[^/@\s]+@[^/@\s]+/.test(value)) return false;

  const schemeRelative = value.startsWith('//');
  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
  if (!schemeRelative && !hasScheme) {
    return !hasSensitiveParameters(value);
  }

  try {
    const parsed = new URL(schemeRelative ? `ssh:${value}` : value);
    if (parsed.password !== '' || hasExplicitPassword(value)) return false;
    if ((schemeRelative || parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.username !== '') {
      return false;
    }
    return !hasSensitiveParameters(parsed.search)
      && !hasSensitiveParameters(parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash);
  } catch {
    return false;
  }
}

function hasExplicitPassword(value: string): boolean {
  const authority = /^(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/([^/?#]*)/.exec(value)?.[1];
  if (authority === undefined) return false;
  const userInfo = authority.slice(0, authority.lastIndexOf('@'));
  return authority.includes('@') && userInfo.includes(':');
}

function hasSensitiveParameters(value: string): boolean {
  const queryStart = value.indexOf('?');
  const rawParameters = queryStart >= 0
    ? value.slice(queryStart + 1).split('#', 1)[0] ?? ''
    : value.replace(/^[?#]/, '');
  for (const key of new URLSearchParams(rawParameters).keys()) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase().replaceAll('-', '_'))) return true;
  }
  return false;
}

export const repositoryDefaultsSchema = z.object({
  displayName: z.string().min(1).optional(),
  cloneUrl: cloneUrlSchema.optional(),
  remote: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional()
}).strict();

export const localRepositorySchema = repositoryDefaultsSchema.extend({
  path: z.string().min(1).optional()
}).strict();

export const presetSchema = z.object({
  name: z.string().min(1),
  repositories: z.array(configIdSchema).min(1)
}).strict();

export const sharedConfigSchema = z.object({
  version: z.literal(1),
  branchPattern: z.string().min(1).optional(),
  repositories: configRecord(repositoryDefaultsSchema).default({}),
  presets: configRecord(presetSchema).default({})
}).strict();

export const localConfigSchema = z.object({
  version: z.literal(1),
  sharedConfig: z.string().min(1).optional(),
  workspaceRoot: z.string().min(1).default('~/ai-workspaces'),
  branchPattern: z.string().min(1).optional(),
  repositories: configRecord(localRepositorySchema).default({}),
  presets: configRecord(presetSchema).default({})
}).strict();

export type SharedConfigDocument = z.infer<typeof sharedConfigSchema>;
export type LocalConfigDocument = z.infer<typeof localConfigSchema>;
