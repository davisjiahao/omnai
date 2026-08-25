import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { resolveSecretEnvironment, redactSecrets } from '../agents/policy.js';
import { hashObject, sha256 } from '../hashing.js';
import {
  ENVIRONMENT_STEP_NAMES,
  type ContentHash,
  type EnvironmentStepDefinition,
  type EnvironmentStepName,
  type IntegrationEnvironmentProfile,
} from '../types.js';
import {
  claimEnvironmentAllocation,
  createArgvProcessTreeRunner,
  releaseEnvironmentAllocation,
  validateEnvironmentAdapterContext,
  type ArgvProcessTreeRunner,
  type EnvironmentAdapterContext,
  type EnvironmentInspection,
  type EnvironmentProbe,
  type EnvironmentReleaseResult,
  type EnvironmentStep,
  type EnvironmentStepResult,
  type IntegrationEnvironmentAdapter,
  type PreparedEnvironment,
  type ReadyPreparedEnvironment,
} from './adapters.js';

export type SandboxProofName = IntegrationEnvironmentProfile['sandbox']['requiredProofs'][number];

export type SandboxIsolationProof =
  | {
      readonly status: 'PROVEN';
      readonly proofId: string;
      readonly proofs: readonly SandboxProofName[];
    }
  | {
      readonly status: 'UNPROVEN';
      readonly code: string;
      readonly proofs: readonly SandboxProofName[];
    };

export interface CommandSandboxProbeRequest {
  readonly profile: IntegrationEnvironmentProfile;
  readonly context?: EnvironmentAdapterContext;
}

export interface CommandSandboxProvider {
  probe(request: CommandSandboxProbeRequest): Promise<SandboxIsolationProof>;
  execute?(
    request: CommandSandboxExecutionRequest,
    signal?: AbortSignal,
  ): Promise<CommandSandboxExecutionResult>;
}

export interface CommandSandboxExecutionBinding {
  readonly schemaVersion: 3;
  readonly worksetId: string;
  readonly environmentRunId: string;
  readonly integrationInputHash: ContentHash;
  readonly profileContentHash: ContentHash;
  readonly proofId: string;
  readonly step: EnvironmentStepName;
  readonly executable: string;
  readonly executorDigestRef: string;
  readonly expectedExecutableDigest: ContentHash;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly network: 'ALLOW' | 'DENY';
  readonly timeoutMs: number;
  readonly outputLimit: number;
  readonly requiredArtifacts: readonly string[];
  readonly sourceInputs: readonly CommandSourceInputIdentity[];
  readonly workspaceRoot: string;
  readonly runRoot: string;
  readonly sourceRoots: readonly string[];
  readonly secretEnvironmentNames: readonly string[];
  readonly requiredProofs: readonly SandboxProofName[];
  readonly processContainmentRequired: true;
}

export interface SandboxProcessContainer {
  readonly kind: 'CGROUP' | 'PID_NAMESPACE' | 'WINDOWS_JOB' | 'SANDBOX_SERVICE';
  readonly id: string;
}

export interface CommandSourceInputIdentity {
  readonly ref: string;
  readonly canonicalPath: string;
  readonly digest: ContentHash;
}

export interface CommandSandboxExecutionRequest {
  readonly binding: CommandSandboxExecutionBinding;
  readonly bindingHash: ContentHash;
  readonly command: Parameters<ArgvProcessTreeRunner['run']>[0];
}

export interface CommandSandboxExecutionResult {
  readonly result: Awaited<ReturnType<ArgvProcessTreeRunner['run']>>;
  readonly proof: {
    readonly proofId: string;
    readonly bindingHash: ContentHash;
    readonly proofs: readonly SandboxProofName[];
    readonly resolvedExecutablePath: string;
    readonly executableDigest: ContentHash;
    readonly processContainer: SandboxProcessContainer;
    readonly sourceInputs: readonly CommandSourceInputIdentity[];
  };
}

export function commandSandboxBindingHash(binding: CommandSandboxExecutionBinding): ContentHash {
  return hashObject(binding);
}

export function commandExecutorDigestRef(step: EnvironmentStepName, executable: string): string {
  return `commands:${step}:${executable}`;
}

export interface ResolvedEnvironmentCommand {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly outputLimit: number;
  readonly network: 'ALLOW' | 'DENY';
  readonly requiredArtifacts: readonly string[];
}

export type EnvironmentCommandResolver = (
  commandRef: string,
  context: EnvironmentAdapterContext,
) => Promise<ResolvedEnvironmentCommand>;

export interface CommandsEnvironmentAdapterOptions {
  readonly runner: ArgvProcessTreeRunner;
  readonly sandbox: CommandSandboxProvider;
  readonly resolveCommand?: EnvironmentCommandResolver;
}

export interface ProductionCommandsEnvironmentAdapterOptions {
  readonly runner?: ArgvProcessTreeRunner;
  readonly sandbox?: CommandSandboxProvider;
  readonly resolveCommand?: EnvironmentCommandResolver;
}

interface CommandsPreparedData {
  readonly commands: Readonly<Record<EnvironmentStepName, PreparedCommand>>;
  readonly proof: SandboxIsolationProof;
}

interface PreparedCommand extends ResolvedEnvironmentCommand {
  readonly cwd: string;
}

export function createCommandsEnvironmentAdapter(
  options: CommandsEnvironmentAdapterOptions,
): IntegrationEnvironmentAdapter {
  return new CommandsEnvironmentAdapter(options);
}

export function createProductionCommandsEnvironmentAdapter(
  options: ProductionCommandsEnvironmentAdapterOptions = {},
): IntegrationEnvironmentAdapter {
  return createCommandsEnvironmentAdapter({
    runner: options.runner ?? createArgvProcessTreeRunner(),
    sandbox: options.sandbox ?? unprovenProductionSandbox,
    ...(options.resolveCommand === undefined ? {} : { resolveCommand: options.resolveCommand }),
  });
}

const unprovenProductionSandbox: CommandSandboxProvider = {
  async probe() {
    return {
      status: 'UNPROVEN',
      code: 'SANDBOX_ISOLATION_UNPROVEN',
      proofs: [],
    };
  },
};

class CommandsEnvironmentAdapter implements IntegrationEnvironmentAdapter {
  readonly driver = 'commands' as const;

  constructor(private readonly options: CommandsEnvironmentAdapterOptions) {}

  async probe(profile: IntegrationEnvironmentProfile): Promise<EnvironmentProbe> {
    if (profile.driver !== this.driver) return wrongDriverProbe(profile.driver);
    const proof = await this.options.sandbox.probe({ profile });
    return sandboxProbe(
      proof,
      this.options.sandbox.execute !== undefined,
      effectiveRequiredProofs(
        profile,
        Object.values(profile.steps).map((definition) =>
          'network' in definition ? definition.network : 'DENY'),
      ),
    );
  }

  async prepare(context: EnvironmentAdapterContext): Promise<PreparedEnvironment> {
    if (context.profile.driver !== this.driver) {
      const probe = wrongDriverProbe(context.profile.driver);
      return {
        status: 'BLOCKED',
        driver: this.driver,
        context,
        probe,
        code: probe.code,
        reason: probe.reasons[0]!,
      };
    }
    try {
      validateEnvironmentAdapterContext(context, this.driver);
      await validateContextRoots(context);
      const commands = await resolveCommands(context, this.options.resolveCommand);
      validateCommandExecutorDigests(context, commands);
      await Promise.all(ENVIRONMENT_STEP_NAMES.map(
        (name) => verifyFrozenCommandInputs(context, commands[name]),
      ));
      const proof = await this.options.sandbox.probe({ profile: context.profile, context });
      const probe = sandboxProbe(
        proof,
        this.options.sandbox.execute !== undefined,
        effectiveRequiredProofs(
          context.profile,
          Object.values(commands).map((command) => command.network),
        ),
      );
      return {
        status: 'READY',
        driver: this.driver,
        context,
        probe,
        preparedData: { commands, proof } satisfies CommandsPreparedData,
      };
    } catch (error) {
      const reason = errorMessage(error);
      const probe: EnvironmentProbe = {
        driver: this.driver,
        authoritative: false,
        mode: 'DIAGNOSTIC_ONLY',
        code: errorCode(error, 'COMMANDS_PREPARE_FAILED'),
        reasons: [reason],
      };
      return {
        status: 'BLOCKED',
        driver: this.driver,
        context,
        probe,
        code: probe.code,
        reason,
      };
    }
  }

  async runStep(
    prepared: ReadyPreparedEnvironment,
    step: EnvironmentStep,
    signal?: AbortSignal,
  ): Promise<EnvironmentStepResult> {
    validateEnvironmentAdapterContext(prepared.context, this.driver);
    const data = commandsPreparedData(prepared);
    if (prepared.context.requestedMode === 'AUTHORITATIVE' && !prepared.probe.authoritative) {
      throw new Error(`${prepared.probe.code}: authoritative command execution denied`);
    }
    const command = data.commands[step.name];
    const secretEnvironment = resolveSecretEnvironment(
      prepared.context.profile,
      prepared.context.sourceEnvironment(),
    );
    const secretValues = Object.values(secretEnvironment);
    try {
      const runRequest = {
        executable: command.executable,
        argv: command.argv,
        shell: false,
        cwd: command.cwd,
        environment: secretEnvironment,
        timeoutMs: command.timeoutMs,
        outputLimit: command.outputLimit,
        network: command.network,
        ownerRunId: prepared.context.environmentRunId,
        sandboxProofId: data.proof.status === 'PROVEN' ? data.proof.proofId : undefined,
      } as const;
      const sourceInputs = await verifyFrozenCommandInputs(prepared.context, command);
      const requiredProofs = effectiveRequiredProofs(prepared.context.profile, [command.network]);
      const sandboxRequired = prepared.context.requestedMode === 'AUTHORITATIVE' || command.network === 'DENY';
      if (sandboxRequired) {
        try {
          assertSandboxExecutionAvailable(data.proof, this.options.sandbox.execute, requiredProofs);
        } catch (error) {
          if (prepared.context.requestedMode === 'DIAGNOSTIC_ONLY' && command.network === 'DENY') {
            throw new Error(`COMMAND_NETWORK_DENY_UNENFORCED: ${errorMessage(error)}`, { cause: error });
          }
          throw error;
        }
      }
      if (step.name === 'setup') await claimEnvironmentAllocation(prepared.context);
      const execution = sandboxRequired
        ? await this.runAuthoritatively(
            prepared,
            step,
            command,
            sourceInputs,
            runRequest,
            data.proof,
            requiredProofs,
            signal,
          )
        : undefined;
      const result = execution?.result ?? await this.options.runner.run(runRequest, signal);
      const output = redactSecrets(result.output, secretValues);
      if (result.exitCode !== 0) {
        throw new Error(
          `COMMAND_STEP_FAILED: ${step.name}: exit ${String(result.exitCode)} signal ${String(result.signal)}: ${output}`,
        );
      }
      const succeeded: EnvironmentStepResult = {
        status: 'SUCCEEDED',
        step: step.name,
        exitCode: result.exitCode,
        output,
        truncated: result.truncated,
        ...(execution === undefined ? {} : {
          executionIdentity: {
            kind: 'SANDBOX' as const,
            proofId: execution.proof.proofId,
            bindingHash: execution.proof.bindingHash,
            executablePath: execution.proof.resolvedExecutablePath,
            executableDigest: execution.proof.executableDigest,
            processContainer: execution.proof.processContainer,
          },
        }),
      };
      if (step.name === 'teardown') await releaseEnvironmentAllocation(prepared.context);
      return succeeded;
    } catch (error) {
      throw redactedError(error, secretValues);
    }
  }

  private async runAuthoritatively(
    prepared: ReadyPreparedEnvironment,
    step: EnvironmentStep,
    command: PreparedCommand,
    sourceInputs: readonly CommandSourceInputIdentity[],
    runRequest: Parameters<ArgvProcessTreeRunner['run']>[0],
    proof: SandboxIsolationProof,
    requiredProofs: readonly SandboxProofName[],
    signal: AbortSignal | undefined,
  ): Promise<CommandSandboxExecutionResult> {
    const execute = this.options.sandbox.execute;
    assertSandboxExecutionAvailable(proof, execute, requiredProofs);
    if (execute === undefined) throw new Error('SANDBOX_EXECUTION_UNAVAILABLE');
    const binding: CommandSandboxExecutionBinding = {
      schemaVersion: 3,
      worksetId: prepared.context.worksetId,
      environmentRunId: prepared.context.environmentRunId,
      integrationInputHash: prepared.context.integrationInput.inputHash,
      profileContentHash: prepared.context.profile.contentHash,
      proofId: proof.proofId,
      step: step.name,
      executable: command.executable,
      ...expectedCommandExecutorDigest(prepared.context, step.name, command.executable),
      argv: command.argv,
      cwd: command.cwd,
      network: command.network,
      timeoutMs: command.timeoutMs,
      outputLimit: command.outputLimit,
      requiredArtifacts: command.requiredArtifacts,
      sourceInputs,
      workspaceRoot: prepared.context.workspaceRoot,
      runRoot: prepared.context.runRoot,
      sourceRoots: prepared.context.sourceRoots,
      secretEnvironmentNames: Object.keys(runRequest.environment).sort(),
      requiredProofs,
      processContainmentRequired: true,
    };
    const bindingHash = commandSandboxBindingHash(binding);
    const execution = await execute.call(this.options.sandbox, {
      binding,
      bindingHash,
      command: runRequest,
    }, signal);
    const missing = binding.requiredProofs.filter(
      (required) => !execution.proof.proofs.includes(required),
    );
    if (execution.proof.proofId !== proof.proofId ||
        execution.proof.bindingHash !== bindingHash || missing.length > 0 ||
        !isAbsolute(execution.proof.resolvedExecutablePath) ||
        !/^sha256:[0-9a-f]{64}$/u.test(execution.proof.executableDigest) ||
        canonicalCommandSourceInputs(execution.proof.sourceInputs) !==
          canonicalCommandSourceInputs(binding.sourceInputs) ||
        !sameExecutableIdentity(command, execution.proof.resolvedExecutablePath)) {
      throw new Error('SANDBOX_EXECUTION_ATTESTATION_MISMATCH');
    }
    if (execution.proof.executableDigest !== binding.expectedExecutableDigest) {
      throw new Error('SANDBOX_EXECUTOR_DIGEST_MISMATCH');
    }
    if (!isSandboxProcessContainer(execution.proof.processContainer)) {
      throw new Error('SANDBOX_PROCESS_CONTAINER_UNPROVEN');
    }
    return execution;
  }

  async inspect(context: EnvironmentAdapterContext): Promise<EnvironmentInspection> {
    validateEnvironmentAdapterContext(context, this.driver);
    return {
      driver: this.driver,
      ownership: 'ABSENT',
      code: 'COMMAND_PROCESS_TREE_ABSENT',
    };
  }

  async release(context: EnvironmentAdapterContext): Promise<EnvironmentReleaseResult> {
    validateEnvironmentAdapterContext(context, this.driver);
    await releaseEnvironmentAllocation(context);
    return {
      driver: this.driver,
      status: 'ALREADY_ABSENT',
      code: 'COMMAND_PROCESS_TREE_ALREADY_ABSENT',
    };
  }
}

async function verifyFrozenCommandInputs(
  context: EnvironmentAdapterContext,
  command: PreparedCommand,
): Promise<readonly CommandSourceInputIdentity[]> {
  const refs = [...new Set([
    context.profile.definitionRef,
    ...command.requiredArtifacts,
  ])].sort();
  return Promise.all(refs.map(async (ref) => {
    const expected = context.profile.sourceRefs.filter((source) => source.ref === ref);
    if (expected.length !== 1) {
      throw new Error(`COMMAND_SOURCE_DIGEST_MAPPING_REQUIRED: ${ref}`);
    }
    if (isAbsolute(ref)) throw new Error(`COMMAND_SOURCE_PATH_INVALID: ${ref}`);
    const workspaceRoot = await realpath(context.workspaceRoot);
    const declared = resolve(workspaceRoot, ref);
    if (!isOwnedPath(workspaceRoot, declared)) {
      throw new Error(`COMMAND_SOURCE_PATH_ESCAPE: ${ref}`);
    }
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(declared);
    } catch {
      throw new Error(`COMMAND_SOURCE_UNRESOLVED: ${ref}`);
    }
    if (!isOwnedPath(workspaceRoot, canonicalPath)) {
      throw new Error(`COMMAND_SOURCE_PATH_ESCAPE: ${ref}`);
    }
    const digest = sha256(await readFile(canonicalPath));
    if (digest !== expected[0]!.contentHash) {
      throw new Error(ref === context.profile.definitionRef
        ? `COMMAND_DEFINITION_DIGEST_MISMATCH: ${ref}`
        : `COMMAND_REQUIRED_ARTIFACT_DIGEST_MISMATCH: ${ref}`);
    }
    return { ref, canonicalPath, digest };
  }));
}

function canonicalCommandSourceInputs(value: unknown): string {
  if (!Array.isArray(value) || !value.every((input) => isRecord(input) &&
      typeof input.ref === 'string' && typeof input.canonicalPath === 'string' &&
      isAbsolute(input.canonicalPath) && typeof input.digest === 'string' &&
      /^sha256:[0-9a-f]{64}$/u.test(input.digest))) {
    return 'INVALID';
  }
  return JSON.stringify(value.map((input) => ({
    ref: String(input.ref),
    canonicalPath: String(input.canonicalPath),
    digest: String(input.digest),
  })).sort((left, right) => left.ref.localeCompare(right.ref)));
}

function validateCommandExecutorDigests(
  context: EnvironmentAdapterContext,
  commands: Readonly<Record<EnvironmentStepName, PreparedCommand>>,
): void {
  for (const name of ENVIRONMENT_STEP_NAMES) {
    expectedCommandExecutorDigest(context, name, commands[name].executable);
  }
}

function expectedCommandExecutorDigest(
  context: EnvironmentAdapterContext,
  step: EnvironmentStepName,
  executable: string,
): { readonly executorDigestRef: string; readonly expectedExecutableDigest: ContentHash } {
  const executorDigestRef = commandExecutorDigestRef(step, executable);
  const matches = context.integrationInput.executorDigests.filter(
    (identity) => identity.ref === executorDigestRef,
  );
  if (matches.length !== 1) {
    throw new Error(`COMMAND_EXECUTOR_DIGEST_MAPPING_REQUIRED: ${executorDigestRef}`);
  }
  return {
    executorDigestRef,
    expectedExecutableDigest: matches[0]!.digest,
  };
}

async function resolveCommands(
  context: EnvironmentAdapterContext,
  resolver: EnvironmentCommandResolver | undefined,
): Promise<Readonly<Record<EnvironmentStepName, PreparedCommand>>> {
  const entries = await Promise.all(ENVIRONMENT_STEP_NAMES.map(async (name) => {
    const definition = context.profile.steps[name];
    const command = await resolveCommand(definition, context, resolver);
    const prepared = { ...command, cwd: await resolveCommandCwd(context, command.cwd) };
    await validateCommandArgumentPaths(context, prepared);
    return [name, prepared] as const;
  }));
  return Object.fromEntries(entries) as unknown as Readonly<Record<EnvironmentStepName, PreparedCommand>>;
}

async function resolveCommand(
  definition: EnvironmentStepDefinition,
  context: EnvironmentAdapterContext,
  resolver: EnvironmentCommandResolver | undefined,
): Promise<ResolvedEnvironmentCommand> {
  const command = 'executable' in definition
    ? definition
    : resolver === undefined
      ? undefined
      : await resolver(definition.commandRef, context);
  if (command === undefined) {
    throw new Error(`ENVIRONMENT_COMMAND_REFERENCE_UNRESOLVED: ${
      'commandRef' in definition ? definition.commandRef : 'unknown'
    }`);
  }
  validateResolvedCommand(command);
  return command;
}

function validateResolvedCommand(command: ResolvedEnvironmentCommand): void {
  const executable = command.executable.split(/[\\/]/u).at(-1)?.toLowerCase().replace(/\.exe$/u, '') ?? '';
  if (new Set([
    'bash', 'cmd', 'command', 'csh', 'dash', 'elvish', 'fish', 'ksh',
    'nu', 'powershell', 'pwsh', 'sh', 'tcsh', 'zsh',
  ]).has(executable)) {
    throw new Error(`COMMAND_SHELL_LAUNCHER_FORBIDDEN: ${command.executable}`);
  }
  if (new Set(['bun', 'npm', 'pnpm', 'yarn']).has(executable)) {
    throw new Error(`COMMAND_NESTED_PACKAGE_SCRIPT_FORBIDDEN: ${command.executable}`);
  }
  if (command.executable.includes('\0') || command.argv.some((argument) => argument.includes('\0'))) {
    throw new Error('COMMAND_INVOCATION_INVALID');
  }
  if (command.argv.some((argument) => commandArgumentPathValues(argument).some((value) =>
    isAbsolute(value) || /^[a-z]:[\\/]/iu.test(value) || value.split(/[\\/]/u).includes('..')))) {
    throw new Error('COMMAND_ARGUMENT_PATH_INVALID');
  }
}

async function validateCommandArgumentPaths(
  context: EnvironmentAdapterContext,
  command: Pick<PreparedCommand, 'argv' | 'cwd'>,
): Promise<void> {
  const allowedRoots = await Promise.all([context.runRoot, context.workspaceRoot, ...context.sourceRoots]
    .map((root) => realpath(root)));
  for (const argument of command.argv) {
    for (const value of commandArgumentPathValues(argument)) {
      const candidate = await realpath(await nearestExistingAncestor(resolve(command.cwd, value)));
      if (!allowedRoots.some((root) => isOwnedPath(root, candidate))) {
        throw new Error(`COMMAND_ARGUMENT_OUTSIDE_OWNED_ROOTS:${argument}`);
      }
    }
  }
}

function commandArgumentPathValues(argument: string): string[] {
  return argument.split('=').flatMap((segment) => {
    if (segment.length === 0) return [];
    if (segment.startsWith('@')) return segment.length === 1 ? [] : [segment.slice(1)];
    const attachedShortOption = /^-[a-z](.+[\\/].*)$/iu.exec(segment);
    if (attachedShortOption !== null) return [attachedShortOption[1]!];
    return segment.startsWith('-') ? [] : [segment];
  });
}

async function nearestExistingAncestor(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (!isMissingPathEntryError(error)) throw error;
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

function isMissingPathEntryError(error: unknown): boolean {
  const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function resolveCommandCwd(context: EnvironmentAdapterContext, declared: string): Promise<string> {
  const candidate = declared === 'workspace:.'
    ? context.workspaceRoot
    : declared.startsWith('project:')
      ? resolve(context.workspaceRoot, declared.slice('project:'.length))
      : isAbsolute(declared)
        ? resolve(declared)
        : resolve(context.runRoot, declared);
  const resolved = await realpath(candidate);
  const allowedRoots = [context.runRoot, context.workspaceRoot, ...context.sourceRoots]
    .map((root) => resolve(root));
  if (!allowedRoots.some((root) => isOwnedPath(root, resolved))) {
    throw new Error(`COMMAND_CWD_OUTSIDE_OWNED_ROOTS: ${declared}`);
  }
  return resolved;
}

async function validateContextRoots(context: EnvironmentAdapterContext): Promise<void> {
  const runRoot = await realpath(context.runRoot);
  const workspaceRoot = await realpath(context.workspaceRoot);
  if (isOwnedPath(workspaceRoot, runRoot)) {
    throw new Error('COMMAND_RUN_ROOT_INSIDE_WORKSPACE');
  }
  if (isOwnedPath(runRoot, workspaceRoot)) {
    throw new Error('COMMAND_RUN_ROOT_OWNS_WORKSPACE');
  }
  for (const root of context.sourceRoots) {
    const sourceRoot = await realpath(root);
    if (!isOwnedPath(workspaceRoot, sourceRoot)) {
      throw new Error(`COMMAND_SOURCE_ROOT_OUTSIDE_WORKSPACE: ${root}`);
    }
    if (isOwnedPath(runRoot, sourceRoot) || isOwnedPath(sourceRoot, runRoot)) {
      throw new Error(`COMMAND_SOURCE_AND_RUN_ROOT_OVERLAP: ${root}`);
    }
  }
}

function sandboxProbe(
  proof: SandboxIsolationProof,
  executionAvailable: boolean,
  requiredProofs: readonly SandboxProofName[],
): EnvironmentProbe {
  const missing = requiredProofs.filter((required) => !proof.proofs.includes(required));
  const authoritative = proof.status === 'PROVEN' && missing.length === 0 && executionAvailable;
  return authoritative
    ? {
        driver: 'commands',
        authoritative: true,
        mode: 'AUTHORITATIVE',
        code: 'COMMAND_SANDBOX_PROVEN',
        reasons: [],
        details: { proofId: proof.proofId },
      }
    : {
        driver: 'commands',
        authoritative: false,
        mode: 'DIAGNOSTIC_ONLY',
        code: proof.status === 'PROVEN' && missing.length === 0
          ? 'SANDBOX_EXECUTION_UNAVAILABLE'
          : 'SANDBOX_ISOLATION_UNPROVEN',
        reasons: [
          proof.status === 'UNPROVEN'
            ? proof.code
            : missing.length > 0
              ? `SANDBOX_PROOFS_MISSING: ${missing.join(',')}`
              : 'SANDBOX_EXECUTION_UNAVAILABLE',
        ],
      };
}

function effectiveRequiredProofs(
  profile: IntegrationEnvironmentProfile,
  networks: readonly ResolvedEnvironmentCommand['network'][],
): SandboxProofName[] {
  const required = new Set<SandboxProofName>(profile.sandbox.requiredProofs);
  if (networks.includes('DENY')) required.add('NETWORK');
  return [...required].sort((left, right) => left.localeCompare(right));
}

function assertSandboxExecutionAvailable(
  proof: SandboxIsolationProof,
  execute: CommandSandboxProvider['execute'],
  requiredProofs: readonly SandboxProofName[],
): asserts proof is Extract<SandboxIsolationProof, { readonly status: 'PROVEN' }> {
  if (proof.status !== 'PROVEN') {
    throw new Error('SANDBOX_ISOLATION_UNPROVEN: sandbox command execution denied');
  }
  const missing = requiredProofs.filter((required) => !proof.proofs.includes(required));
  if (missing.length > 0) {
    throw new Error(`SANDBOX_ISOLATION_UNPROVEN: SANDBOX_PROOFS_MISSING: ${missing.join(',')}`);
  }
  if (execute === undefined) {
    throw new Error('SANDBOX_EXECUTION_UNAVAILABLE: sandbox command execution denied');
  }
}

function commandsPreparedData(prepared: ReadyPreparedEnvironment): CommandsPreparedData {
  if (prepared.driver !== 'commands' || !isRecord(prepared.preparedData) ||
      !isRecord(prepared.preparedData.commands) || !isRecord(prepared.preparedData.proof)) {
    throw new Error('COMMANDS_PREPARED_CONTEXT_INVALID');
  }
  return prepared.preparedData as unknown as CommandsPreparedData;
}

function wrongDriverProbe(actual: string): EnvironmentProbe {
  return {
    driver: 'commands',
    authoritative: false,
    mode: 'DIAGNOSTIC_ONLY',
    code: 'ENVIRONMENT_ADAPTER_DRIVER_MISMATCH',
    reasons: [`expected commands, received ${actual}`],
  };
}

function redactedError(error: unknown, secrets: readonly string[]): Error {
  const original = error instanceof Error ? error : new Error(String(error));
  const redacted = new Error(redactSecrets(original.message, secrets), { cause: original.cause });
  redacted.name = original.name;
  return redacted;
}

function isOwnedPath(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function sameExecutableIdentity(command: PreparedCommand, actual: string): boolean {
  if (isAbsolute(command.executable)) return resolve(command.executable) === resolve(actual);
  if (/[\\/]/u.test(command.executable)) {
    return resolve(command.cwd, command.executable) === resolve(actual);
  }
  const name = actual.split(/[\\/]/u).at(-1)?.toLowerCase().replace(/\.exe$/u, '');
  return name === command.executable.toLowerCase().replace(/\.exe$/u, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSandboxProcessContainer(value: unknown): value is SandboxProcessContainer {
  return isRecord(value) && new Set([
    'CGROUP', 'PID_NAMESPACE', 'WINDOWS_JOB', 'SANDBOX_SERVICE',
  ]).has(String(value.kind)) && typeof value.id === 'string' && value.id.length > 0;
}

function errorCode(error: unknown, fallback: string): string {
  const match = /^([A-Z][A-Z0-9_]+)/u.exec(errorMessage(error));
  return match?.[1] ?? fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
