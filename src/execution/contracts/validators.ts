import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathExists, writeTextAtomic, writeYaml } from '../../core/files.js';
import { projectConfigPath } from '../../core/paths.js';
import { loadProjectConfig } from '../../core/store.js';
import { resolveWorkset } from '../../workspace/worksets.js';
import {
  verificationEvidenceSchema,
  type VerificationEvidence,
} from '../artifacts.js';
import { hashObject, sha256 } from '../hashing.js';
import { nextExecutionId } from '../ids.js';
import { withWorksetMutationLock } from '../mutation-lock.js';
import { ensureExecutionLayout, evidencePath } from '../paths.js';
import type { ContentHash } from '../types.js';
import type { ContractSnapshot } from './store.js';

const VALIDATOR_TIMEOUT_MS = 120_000;
const VALIDATOR_MAX_OUTPUT_BYTES = 1_048_576;
const LEGACY_LITERAL = /^[a-zA-Z0-9_./:@%+=,-]+$/;

export interface ContractValidatorCommand {
  readonly commandRef: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly definitionHash?: ContentHash;
}

export interface ContractValidator {
  readonly id: string;
  readonly kind: 'PARSER' | 'CONFIGURED' | 'PACT' | 'SPRING_CLOUD_CONTRACT';
  readonly project: string;
  readonly command?: ContractValidatorCommand;
  readonly required: boolean;
  readonly diagnostic?: string;
}

export function contractValidatorCommandBinding(
  validator: ContractValidator,
): { readonly commandRef: string; readonly contentHash: ContentHash } {
  const commandIdentity = validator.command === undefined
    ? { commandRef: `contract:${validator.project}:${validator.id}:blocked`, diagnostic: validator.diagnostic ?? null }
    : {
        commandRef: validator.command.commandRef,
        executable: validator.command.executable,
        argv: validator.command.argv,
        project: validator.project,
        definitionHash: validator.command.definitionHash ?? null,
      };
  return {
    commandRef: validator.command?.commandRef ?? `contract:${validator.project}:${validator.id}:blocked`,
    contentHash: hashObject(commandIdentity),
  };
}

export function contractValidatorScenarioIds(
  snapshot: ContractSnapshot,
  validator: ContractValidator,
): readonly string[] {
  if (validator.kind === 'PARSER') return snapshot.manifest.businessScenarios;
  const requests = snapshot.candidate.validatorRequests.filter((request) =>
    request.project === validator.project &&
    (request.id === validator.id ||
      (request.commandRef !== undefined && request.commandRef === validator.command?.commandRef)));
  if (requests.length === 0) return snapshot.manifest.businessScenarios;
  return [...new Set(requests.flatMap((request) => [...request.scenarioIds]))].sort(compare);
}

interface ValidatorOutcome {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly diagnostics: readonly string[];
}

export async function discoverContractValidators(
  projectRoot: string,
  projectAlias?: string,
): Promise<ContractValidator[]> {
  const root = resolve(projectRoot);
  const configPath = projectConfigPath(root);
  const config = await pathExists(configPath) ? await loadProjectConfig(root) : null;
  const fallbackProject = basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, '-') || 'project';
  if (projectAlias !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(projectAlias)) {
    throw new Error(`CONTRACT_VALIDATOR_PROJECT_INVALID: ${projectAlias}`);
  }
  const project = projectAlias ?? config?.project ?? fallbackProject;
  const validators: ContractValidator[] = [];

  const packagePath = join(root, 'package.json');
  if (await pathExists(packagePath)) {
    const packageBytes = await readFile(packagePath);
    const packageDocument = parseJsonObject(packageBytes.toString('utf8'));
    const scripts = isObject(packageDocument.scripts) ? packageDocument.scripts : {};
    if (typeof scripts['test:pact'] === 'string' && scripts['test:pact'].trim().length > 0) {
      validators.push({
        id: `${project}:pact`,
        kind: 'PACT',
        project,
        required: true,
        command: {
          commandRef: `contract:${project}:pact`,
          executable: 'npm',
          argv: ['run', 'test:pact'],
          cwd: root,
          definitionHash: sha256(packageBytes),
        },
      });
    }
  }

  const pomPath = join(root, 'pom.xml');
  if (await pathExists(pomPath)) {
    const pomBytes = await readFile(pomPath);
    const pom = pomBytes.toString('utf8');
    if (pom.includes('spring-cloud-starter-contract-verifier') || pom.includes('spring-cloud-contract-maven-plugin')) {
      const executable = await pathExists(join(root, 'mvnw')) ? './mvnw' : 'mvn';
      validators.push({
        id: `${project}:spring-cloud-contract`,
        kind: 'SPRING_CLOUD_CONTRACT',
        project,
        required: true,
        command: {
          commandRef: `contract:${project}:spring-cloud-contract`,
          executable,
          argv: ['test', '-DskipTests=false'],
          cwd: root,
          definitionHash: sha256(pomBytes),
        },
      });
    }
  }

  for (const commandText of config?.verification.commands ?? []) {
    const normalized = parseLegacyCommand(commandText);
    const suffix = hashObject(commandText).slice('sha256:'.length, 'sha256:'.length + 12);
    if (normalized === null) {
      validators.push({
        id: `${project}:configured:${suffix}`,
        kind: 'CONFIGURED',
        project,
        required: true,
        diagnostic: `CONTRACT_VALIDATOR_COMMAND_AMBIGUOUS: ${project}:${suffix}`,
      });
      continue;
    }
    validators.push({
      id: `${project}:configured:${suffix}`,
      kind: 'CONFIGURED',
      project,
      required: true,
      command: {
        commandRef: `contract:${project}:configured:${suffix}`,
        executable: normalized.executable,
        argv: normalized.argv,
        cwd: root,
        definitionHash: sha256(Buffer.from(commandText, 'utf8')),
      },
    });
  }

  return validators.sort((left, right) => compare(left.id, right.id));
}

export async function runContractValidators(
  snapshot: ContractSnapshot,
  validators: readonly ContractValidator[],
): Promise<VerificationEvidence[]> {
  await assertValidatorScopes(snapshot, validators);
  await ensureExecutionLayout(snapshot.context.home, snapshot.context.worksetId);
  const evidence: VerificationEvidence[] = [];
  for (const validator of [...validators].sort((left, right) => compare(left.id, right.id))) {
    const startedAt = (snapshot.context.now ?? (() => new Date().toISOString()))();
    const outcome = await executeValidator(validator);
    const finishedAt = (snapshot.context.now ?? (() => new Date().toISOString()))();
    const persisted = await withWorksetMutationLock(
      snapshot.context.home,
      snapshot.context.worksetId,
      async () => {
        const id = await nextExecutionId(snapshot.context.home, snapshot.context.worksetId, 'evidence');
        const stdoutRef = `evidence/${id}.stdout.txt`;
        const stderrRef = `evidence/${id}.stderr.txt`;
        await writeTextAtomic(join(snapshot.root, stdoutRef), outcome.stdout);
        await writeTextAtomic(join(snapshot.root, stderrRef), outcome.stderr);
        const artifactHashes = [
          { ref: stderrRef, contentHash: sha256(Buffer.from(outcome.stderr, 'utf8')) },
          { ref: stdoutRef, contentHash: sha256(Buffer.from(outcome.stdout, 'utf8')) },
        ];
        const snapshotRef = { id: snapshot.manifest.id, contentHash: snapshot.manifest.contentHash };
        const command = contractValidatorCommandBinding(validator);
        const value = verificationEvidenceSchema.parse({
          schemaVersion: 1,
          runId: snapshot.candidate.runId,
          packetHash: snapshot.candidate.packetHash,
          id,
          status: outcome.exitCode === 0 && outcome.diagnostics.length === 0 ? 'PASS' : 'FAIL',
          contractRefs: [snapshotRef],
          command,
          exitCode: outcome.exitCode,
          outputHash: hashObject({
            stdout: artifactHashes[1]!.contentHash,
            stderr: artifactHashes[0]!.contentHash,
            exitCode: outcome.exitCode,
          }),
          artifactHashes,
          diagnostics: [...outcome.diagnostics].sort(compare),
          startedAt,
          finishedAt,
          verifier: { kind: 'CORE', id: validator.id },
          subject: {
            kind: 'CONTRACT',
            worksetId: snapshot.context.worksetId,
            contractKey: snapshot.manifest.contractKey,
            scopeHash: snapshot.manifest.scopeHash,
            contractSnapshot: snapshotRef,
            scenarioIds: contractValidatorScenarioIds(snapshot, validator),
          },
        });
        await writeYaml(evidencePath(snapshot.context.home, snapshot.context.worksetId, id), value);
        return value;
      },
      { timeoutMs: 5_000 },
    );
    evidence.push(persisted);
  }
  return evidence;
}

async function assertValidatorScopes(
  snapshot: ContractSnapshot,
  validators: readonly ContractValidator[],
): Promise<void> {
  const ids = validators.map((validator) => validator.id);
  if (new Set(ids).size !== ids.length) throw new Error('CONTRACT_VALIDATOR_ID_DUPLICATE');
  const workset = await resolveWorkset(snapshot.context.home, snapshot.context.worksetId);
  const participants = new Set(snapshot.manifest.participants.map((participant) => participant.project));
  for (const validator of validators) {
    if (validator.kind === 'PARSER') {
      if (validator.project !== 'core' || validator.command !== undefined) {
        throw new Error(`CONTRACT_PARSER_VALIDATOR_INVALID: ${validator.id}`);
      }
      continue;
    }
    if (!participants.has(validator.project)) {
      throw new Error(`CONTRACT_VALIDATOR_PROJECT_MISMATCH: ${validator.id}`);
    }
    const member = workset.members.find((candidate) => candidate.project === validator.project);
    if (member?.status !== 'ACTIVE' || member.worktree === undefined) {
      throw new Error(`CONTRACT_VALIDATOR_PROJECT_NOT_ACTIVE: ${validator.id}`);
    }
    if (validator.command === undefined) continue;
    const [expectedCwd, actualCwd] = await Promise.all([
      realpath(member.worktree),
      realpath(validator.command.cwd),
    ]);
    if (actualCwd !== expectedCwd) throw new Error(`CONTRACT_VALIDATOR_CWD_MISMATCH: ${validator.id}`);
    if (validator.command.executable.length === 0 || validator.command.executable.includes('\0') ||
        validator.command.argv.some((argument) => argument.includes('\0'))) {
      throw new Error(`CONTRACT_VALIDATOR_COMMAND_INVALID: ${validator.id}`);
    }
  }
}

function parseLegacyCommand(value: string): { executable: string; argv: string[] } | null {
  if (value.trim() !== value || value.length === 0 || /[\r\n\t]/u.test(value)) return null;
  const tokens = value.split(/ +/u);
  if (tokens.some((token) => !LEGACY_LITERAL.test(token) || hasTraversal(token))) return null;
  const [executable, ...argv] = tokens;
  return executable === undefined ? null : { executable, argv };
}

function hasTraversal(value: string): boolean {
  return value.split('/').some((segment) => segment === '..');
}

async function executeValidator(validator: ContractValidator): Promise<ValidatorOutcome> {
  if (validator.command === undefined) {
    if (validator.kind === 'PARSER') {
      return validator.diagnostic === undefined
        ? { exitCode: 0, stdout: '', stderr: '', diagnostics: [] }
        : { exitCode: null, stdout: '', stderr: '', diagnostics: [validator.diagnostic] };
    }
    return {
      exitCode: null,
      stdout: '',
      stderr: '',
      diagnostics: [validator.diagnostic ?? `CONTRACT_VALIDATOR_COMMAND_MISSING: ${validator.id}`],
    };
  }
  return new Promise((resolveOutcome) => {
    execFile(
      validator.command!.executable,
      [...validator.command!.argv],
      {
        cwd: validator.command!.cwd,
        encoding: 'utf8',
        timeout: VALIDATOR_TIMEOUT_MS,
        maxBuffer: VALIDATOR_MAX_OUTPUT_BYTES,
        windowsHide: true,
        env: sanitizedEnvironment(),
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolveOutcome({ exitCode: 0, stdout, stderr, diagnostics: [] });
          return;
        }
        const code = typeof error.code === 'number' ? error.code : null;
        const diagnosticCode = error.killed
          ? 'CONTRACT_VALIDATOR_TIMEOUT'
          : error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
            ? 'CONTRACT_VALIDATOR_OUTPUT_LIMIT'
          : typeof error.code === 'string'
            ? `CONTRACT_VALIDATOR_START_FAILED:${error.code}`
            : `CONTRACT_VALIDATOR_EXIT_NONZERO:${String(error.code)}`;
        resolveOutcome({ exitCode: code, stdout, stderr, diagnostics: [diagnosticCode] });
      },
    );
  });
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { LC_ALL: 'C', LANG: 'C' };
  for (const name of ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'JAVA_HOME', 'TMPDIR', 'TMP', 'TEMP']) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
