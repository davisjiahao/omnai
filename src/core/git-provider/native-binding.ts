import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { hashStrictObject } from '../../authority/catalog-schema.js';
import {
  FIXED_GIT_CANDIDATES,
  frozenGitProviderBindingBodySchema,
  type FrozenGitProviderBindingV1,
  type GitCommandInputV1,
} from './types-internal.js';

export type NativeProviderResult = Readonly<{
  candidatePath: string;
  realPath: string;
  bytesHash: string;
  stdout: Uint8Array;
}>;

export type NativeExecutionResult = Readonly<{
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}>;

type NativeProviderModule = Readonly<{
  acquire: () => unknown;
  execute: (input: GitCommandInputV1) => unknown;
}>;

export class NativeProviderBoundaryError extends Error {
  readonly code = 'GIT_PROVIDER_UNAVAILABLE' as const;

  constructor(detail: string, cause?: unknown) {
    super(
      `GIT_PROVIDER_UNAVAILABLE: ${detail}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'NativeProviderBoundaryError';
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
let loadedNativeProvider: NativeProviderModule | null = null;

export function acquireNativeProvider(): NativeProviderResult {
  try {
    return parseNativeProviderResult(requireNativeProvider().acquire());
  } catch (cause) {
    throw boundaryFailure('native acquire failed', cause);
  }
}

export function executeNativeProvider(input: GitCommandInputV1): NativeExecutionResult {
  try {
    return parseNativeExecutionResult(requireNativeProvider().execute(input));
  } catch (cause) {
    throw boundaryFailure('native execute failed', cause);
  }
}

export function freezeProvider(native: NativeProviderResult): FrozenGitProviderBindingV1 {
  try {
    if (!hasExactOwnKeys(native, ['candidatePath', 'realPath', 'bytesHash', 'stdout'])) {
      throw new Error('native binding input has unknown fields');
    }
    const body = frozenGitProviderBindingBodySchema.parse({
      schemaVersion: 1,
      environmentProtocol: 'SANITIZED_GIT_ENV_V1',
      executionProtocol: 'VERIFIED_FD_EXECVEAT_V1',
      executableCandidatePath: native.candidatePath,
      executableRealPath: native.realPath,
      executableRawBytesHash: native.bytesHash,
      gitVersion: decodeCanonicalVersion(native.stdout),
    });
    if (body.executableRealPath !== body.executableCandidatePath) {
      throw new Error('candidate and real path differ');
    }
    return Object.freeze({ ...body, bindingHash: hashStrictObject(body) });
  } catch (cause) {
    throw boundaryFailure('native binding framing is invalid', cause);
  }
}

export function decodeCanonicalVersion(stdout: Uint8Array): string {
  let text: string;
  try {
    text = utf8.decode(stdout);
  } catch (cause) {
    throw boundaryFailure('Git version is not UTF-8', cause);
  }
  const match = /^git version ((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*))?)\n$/u.exec(text);
  if (match?.[1] === undefined) {
    throw boundaryFailure('Git version framing is not canonical');
  }
  return match[1];
}

function loadNativeProvider(): NativeProviderModule {
  try {
    const require = createRequire(import.meta.url);
    const artifact = fileURLToPath(new URL('../../../native/verified_fd_provider.node', import.meta.url));
    const loaded = require(artifact) as unknown;
    if (
      !isRecord(loaded)
      || !hasExactOwnKeys(loaded, ['acquire', 'execute'])
      || typeof loaded.acquire !== 'function'
      || typeof loaded.execute !== 'function'
    ) {
      throw new Error('native module exports are not exactly acquire/execute');
    }
    return loaded as NativeProviderModule;
  } catch (cause) {
    throw boundaryFailure('native module is unavailable', cause);
  }
}

function requireNativeProvider(): NativeProviderModule {
  if (loadedNativeProvider === null) loadedNativeProvider = loadNativeProvider();
  return loadedNativeProvider;
}

function parseNativeProviderResult(value: unknown): NativeProviderResult {
  if (!isRecord(value) || !hasExactOwnKeys(value, ['candidatePath', 'realPath', 'bytesHash', 'stdout'])) {
    throw new Error('native acquire result has unknown fields');
  }
  if (
    typeof value.candidatePath !== 'string'
    || !FIXED_GIT_CANDIDATES.includes(value.candidatePath as (typeof FIXED_GIT_CANDIDATES)[number])
    || value.realPath !== value.candidatePath
    || typeof value.bytesHash !== 'string'
    || !(value.stdout instanceof Uint8Array)
  ) {
    throw new Error('native acquire result has invalid fields');
  }
  return Object.freeze({
    candidatePath: value.candidatePath,
    realPath: value.realPath,
    bytesHash: value.bytesHash,
    stdout: Uint8Array.from(value.stdout),
  });
}

function parseNativeExecutionResult(value: unknown): NativeExecutionResult {
  if (!isRecord(value) || !hasExactOwnKeys(value, ['exitCode', 'stdout', 'stderr'])) {
    throw new Error('native execute result has unknown fields');
  }
  if (
    !Number.isSafeInteger(value.exitCode)
    || (value.exitCode as number) < 0
    || (value.exitCode as number) > 255
    || !(value.stdout instanceof Uint8Array)
    || !(value.stderr instanceof Uint8Array)
  ) {
    throw new Error('native execute result has invalid fields');
  }
  return Object.freeze({
    exitCode: value.exitCode as number,
    stdout: Uint8Array.from(value.stdout),
    stderr: Uint8Array.from(value.stderr),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactOwnKeys(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && keys.every((key) => typeof key === 'string' && expected.includes(key));
}

function boundaryFailure(detail: string, cause?: unknown): NativeProviderBoundaryError {
  return cause instanceof NativeProviderBoundaryError
    ? cause
    : new NativeProviderBoundaryError(detail, cause);
}
