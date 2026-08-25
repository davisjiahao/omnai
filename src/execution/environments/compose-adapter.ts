import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import YAML from 'yaml';
import { resolveSecretEnvironment, redactSecrets } from '../agents/policy.js';
import { hashObject, sha256 } from '../hashing.js';
import type {
  ContentHash,
  EnvironmentStepDefinition,
  IntegrationEnvironmentProfile,
} from '../types.js';
import {
  claimEnvironmentAllocation,
  createArgvProcessTreeRunner,
  releaseEnvironmentAllocation,
  validateEnvironmentAdapterContext,
  type ArgvProcessTreeRunner,
  type ArgvProcessContainmentProbe,
  type ArgvRunRequest,
  type EnvironmentAdapterContext,
  type EnvironmentInspection,
  type EnvironmentProbe,
  type EnvironmentReleaseResult,
  type EnvironmentResourceIdentity,
  type EnvironmentStep,
  type EnvironmentStepResult,
  type IntegrationEnvironmentAdapter,
  type PreparedEnvironment,
  type ReadyPreparedEnvironment,
} from './adapters.js';
import type {
  EnvironmentCommandResolver,
  ResolvedEnvironmentCommand,
} from './commands-adapter.js';

export interface ComposeRuntimeResource extends EnvironmentResourceIdentity {
  readonly driver: 'compose';
  readonly composeProjectName: string;
  readonly containerIds?: readonly string[];
  readonly networkIds?: readonly string[];
}

export interface ComposeExecutorIdentity {
  readonly ref: string;
  readonly executablePath: string;
  readonly executableDigest: ContentHash;
}

export interface ComposeContentDigest {
  readonly ref: string;
  readonly digest: ContentHash;
}

export interface ComposeEffectiveConfigRequest {
  readonly definitionPath: string;
  readonly projectName: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly resource: ComposeRuntimeResource;
  readonly profile?: IntegrationEnvironmentProfile;
}

export interface ComposeSetupRequest extends ComposeEffectiveConfigRequest {
  readonly runRoot: string;
  readonly workspaceRoot: string;
  readonly sourceRoots: readonly string[];
  readonly profile: IntegrationEnvironmentProfile;
  readonly environment: Readonly<Record<string, string>>;
  readonly effectiveConfig: unknown;
}

export interface ComposeSetupValidation {
  readonly resource: ComposeRuntimeResource;
  readonly normalizedConfig: unknown;
  readonly normalizedConfigDigest: ContentHash;
}

export interface ComposeRuntimeStepRequest extends ComposeSetupRequest {
  readonly step: EnvironmentStep;
  readonly definition: EnvironmentStepDefinition;
}

export interface ComposeInspectRequest {
  readonly composeProjectName: string;
  readonly labels: Readonly<Record<string, string>>;
}

export interface ComposeRuntimeInspection {
  readonly ownership: 'PROVEN' | 'UNPROVEN' | 'ABSENT';
  readonly resource?: ComposeRuntimeResource;
}

export interface ComposeReleaseRequest {
  readonly definitionPath: string;
  readonly resource: ComposeRuntimeResource;
}

export interface ComposeRuntime {
  processContainment(): Promise<ArgvProcessContainmentProbe>;
  executorIdentity(): Promise<ComposeExecutorIdentity>;
  effectiveConfig(request: ComposeEffectiveConfigRequest, signal?: AbortSignal): Promise<unknown>;
  validateSetup(request: ComposeSetupRequest, signal?: AbortSignal): Promise<ComposeSetupValidation>;
  setup(
    request: ComposeSetupRequest,
    validation: ComposeSetupValidation,
    signal?: AbortSignal,
  ): Promise<ComposeRuntimeResource>;
  runStep(
    request: ComposeRuntimeStepRequest,
    signal?: AbortSignal,
  ): Promise<{
    readonly exitCode: number;
    readonly output: string;
    readonly truncated: boolean;
    readonly imageDigests?: readonly ComposeContentDigest[];
  }>;
  inspect(request: ComposeInspectRequest): Promise<ComposeRuntimeInspection>;
  release(request: ComposeReleaseRequest, signal?: AbortSignal): Promise<void>;
}

export interface ComposeEnvironmentAdapterOptions {
  readonly workspaceRoot: string;
  readonly runtime: ComposeRuntime;
  readonly resolveCommand?: EnvironmentCommandResolver;
}

export interface ProductionComposeRuntimeOptions {
  readonly runner?: ArgvProcessTreeRunner;
  readonly executable?: string;
  readonly executorIdentity?: ComposeExecutorIdentity;
  readonly timeoutMs?: number;
  readonly outputLimit?: number;
}

interface ComposePreparedData {
  readonly definitionPath: string;
  readonly effectiveConfig: unknown;
  readonly resource: ComposeRuntimeResource;
  readonly steps: Readonly<Record<EnvironmentStep['name'], EnvironmentStepDefinition>>;
  readonly executorIdentity: ComposeExecutorIdentity;
  readonly buildContexts: readonly ComposeBuildContextIdentity[];
  readonly normalizedConfigDigest: ContentHash;
}

interface ComposeBuildContextIdentity extends ComposeContentDigest {
  readonly service: string;
  readonly path: string;
}

export function composeExecutorDigestRef(): string {
  return 'compose:engine';
}

export function composeBuildContextDigestRef(service: string): string {
  return `compose:build-context:${service}`;
}

export function composeImageDigestRef(service: string): string {
  return `compose:image:${service}`;
}

export async function hashComposeBuildContext(path: string): Promise<ContentHash> {
  const root = await realpath(path);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new Error(`COMPOSE_BUILD_CONTEXT_NOT_DIRECTORY: ${path}`);
  const entries: Array<Readonly<Record<string, unknown>>> = [];
  await hashComposeTree(root, root, entries);
  return hashObject(entries);
}

export function createComposeEnvironmentAdapter(
  options: ComposeEnvironmentAdapterOptions,
): IntegrationEnvironmentAdapter {
  return new ComposeEnvironmentAdapter(options);
}

export function createProductionComposeRuntime(
  options: ProductionComposeRuntimeOptions = {},
): ComposeRuntime {
  return new ProductionComposeRuntime(options);
}

export function createProductionComposeEnvironmentAdapter(
  options: Omit<ComposeEnvironmentAdapterOptions, 'runtime'> & ProductionComposeRuntimeOptions,
): IntegrationEnvironmentAdapter {
  return createComposeEnvironmentAdapter({
    workspaceRoot: options.workspaceRoot,
    runtime: createProductionComposeRuntime(options),
    ...(options.resolveCommand === undefined ? {} : { resolveCommand: options.resolveCommand }),
  });
}

class ProductionComposeRuntime implements ComposeRuntime {
  private readonly runner: ArgvProcessTreeRunner;
  private readonly executable: string;
  private readonly declaredExecutorIdentity: ComposeExecutorIdentity | undefined;
  private readonly timeoutMs: number;
  private readonly outputLimit: number;
  private boundExecutorIdentity: ComposeExecutorIdentity | undefined;

  constructor(options: ProductionComposeRuntimeOptions) {
    this.runner = options.runner ?? createArgvProcessTreeRunner();
    this.executable = options.executable ?? 'docker';
    this.declaredExecutorIdentity = options.executorIdentity;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.outputLimit = options.outputLimit ?? 1_048_576;
  }

  async processContainment(): Promise<ArgvProcessContainmentProbe> {
    return this.runner.probeProcessContainment();
  }

  async executorIdentity(): Promise<ComposeExecutorIdentity> {
    if (this.declaredExecutorIdentity !== undefined) {
      if (!isComposeExecutorIdentity(this.declaredExecutorIdentity)) {
        throw new Error('COMPOSE_EXECUTOR_IDENTITY_INVALID');
      }
      this.boundExecutorIdentity = { ...this.declaredExecutorIdentity };
      return { ...this.boundExecutorIdentity };
    }
    const executablePath = await resolveExecutablePath(this.executable);
    const identity = {
      ref: composeExecutorDigestRef(),
      executablePath,
      executableDigest: sha256(await readFile(executablePath)),
    };
    this.boundExecutorIdentity = identity;
    return { ...identity };
  }

  async effectiveConfig(request: ComposeEffectiveConfigRequest): Promise<unknown> {
    let baseConfig: unknown;
    try {
      baseConfig = YAML.parse(await readFile(request.definitionPath, 'utf8'), { uniqueKeys: true }) as unknown;
    } catch (error) {
      throw new Error(`COMPOSE_BASE_CONFIG_INVALID: ${errorMessage(error)}`);
    }
    const override = composeOverride(baseConfig, request);
    return mergeComposeConfig(baseConfig, override);
  }

  async validateSetup(
    request: ComposeSetupRequest,
    signal?: AbortSignal,
  ): Promise<ComposeSetupValidation> {
    const override = YAML.stringify(composeOverride(request.effectiveConfig, request), { lineWidth: 0 });
    const normalizedResult = await this.compose(
      request,
      ['config', '--format', 'json'],
      signal,
      override,
    );
    const normalized = parseComposeJson(
      normalizedResult.output,
      'COMPOSE_EFFECTIVE_CONFIG_INVALID',
    );
    const desired = resourceFromEffectiveConfig(request.resource, normalized);
    await validateComposeEffectiveConfig(normalized, request.profile, {
      definitionPath: request.definitionPath,
      workspaceRoot: request.workspaceRoot,
      sourceRoots: request.sourceRoots,
      runRoot: request.runRoot,
      resource: desired,
    }, request.environment);
    const normalizedConfig = sanitizeComposeNormalizedConfig(
      normalized,
      request.profile.envRefs,
      request.environment,
    );
    return {
      resource: desired,
      normalizedConfig,
      normalizedConfigDigest: hashObject(normalizedConfig),
    };
  }

  async setup(
    request: ComposeSetupRequest,
    validation: ComposeSetupValidation,
    signal?: AbortSignal,
  ): Promise<ComposeRuntimeResource> {
    const desired = validation.resource;
    const before = await this.inspect({
      composeProjectName: request.projectName,
      labels: request.labels,
    });
    if (before.ownership === 'UNPROVEN') throw new Error('COMPOSE_SETUP_OWNERSHIP_UNPROVEN');
    const existingNetworks = new Set(before.resource?.networkNames ?? []);
    const existingVolumes = new Set(before.resource?.volumeNames ?? []);
    const labelArgs = Object.entries(request.labels)
      .sort(([left], [right]) => compare(left, right))
      .flatMap(([key, value]) => ['--label', `${key}=${value}`]);
    for (const name of desired.networkNames) {
      if (!existingNetworks.has(name)) {
        await this.docker(request.resource.ownerRunId, ['network', 'create', ...labelArgs, name], signal);
      }
    }
    for (const name of desired.volumeNames) {
      if (!existingVolumes.has(name)) {
        await this.docker(request.resource.ownerRunId, ['volume', 'create', ...labelArgs, name], signal);
      }
    }
    const inspection = await this.inspect({
      composeProjectName: request.projectName,
      labels: request.labels,
    });
    if (inspection.ownership !== 'PROVEN' || inspection.resource === undefined ||
        !desired.networkNames.every((name) => inspection.resource!.networkNames.includes(name)) ||
        !desired.volumeNames.every((name) => inspection.resource!.volumeNames.includes(name))) {
      throw new Error('COMPOSE_SETUP_OWNERSHIP_UNPROVEN');
    }
    return inspection.resource;
  }

  async runStep(
    request: ComposeRuntimeStepRequest,
    signal?: AbortSignal,
  ): Promise<{
    readonly exitCode: number;
    readonly output: string;
    readonly truncated: boolean;
    readonly imageDigests?: readonly ComposeContentDigest[];
  }> {
    const override = YAML.stringify(composeOverride(request.effectiveConfig, request), { lineWidth: 0 });
    let args: readonly string[];
    if (request.step.name === 'build') args = ['build'];
    else if (request.step.name === 'start') args = ['up', '--detach', '--no-build'];
    else if (request.step.name === 'health') args = ['ps', '--format', 'json'];
    else if (request.step.name === 'collect') args = ['logs', '--no-color'];
    else if ((request.step.name === 'seed' || request.step.name === 'test') &&
        'executable' in request.definition) {
      const service = firstComposeService(request.effectiveConfig);
      args = ['run', '--rm', '--no-deps', service, request.definition.executable, ...request.definition.argv];
    } else {
      throw new Error(`COMPOSE_STEP_COMMAND_REFERENCE_UNRESOLVED: ${request.step.name}`);
    }
    const result = await this.compose(request, args, signal, override, request.definition);
    const imageDigests = request.step.name === 'build'
      ? await this.inspectBuiltImageDigests(request, signal, override)
      : undefined;
    return {
      exitCode: result.exitCode ?? 1,
      output: result.output,
      truncated: result.truncated,
      ...(imageDigests === undefined ? {} : { imageDigests }),
    };
  }

  private async inspectBuiltImageDigests(
    request: ComposeRuntimeStepRequest,
    signal: AbortSignal | undefined,
    override: string,
  ): Promise<readonly ComposeContentDigest[]> {
    const services = composeBuildServices(request.effectiveConfig);
    if (services.length === 0) return [];
    const result = await this.compose(
      request,
      ['images', '--format', 'json'],
      signal,
      override,
      request.definition,
    );
    const identities = parseComposeImageIdentities(result.output);
    return services.map((service) => {
      const identity = identities.get(service);
      if (identity === undefined || !/^sha256:[0-9a-f]{64}$/u.test(identity)) {
        throw new Error(`COMPOSE_IMAGE_DIGEST_UNPROVEN: ${service}`);
      }
      return { ref: composeImageDigestRef(service), digest: identity as ContentHash };
    });
  }

  async inspect(request: ComposeInspectRequest): Promise<ComposeRuntimeInspection> {
    const ownerRunId = request.labels['omnai.environmentRunId'];
    if (ownerRunId === undefined) return { ownership: 'UNPROVEN' };
    const filter = `label=omnai.environmentRunId=${ownerRunId}`;
    const containers = await this.dockerObjects(
      ownerRunId,
      ['ps', '-a', '--filter', filter, '--format', '{{.ID}}\t{{.Names}}'],
    );
    const networks = await this.dockerObjects(
      ownerRunId,
      ['network', 'ls', '--filter', filter, '--format', '{{.ID}}\t{{.Name}}'],
    );
    const volumes = await this.dockerList(ownerRunId, ['volume', 'ls', '--filter', filter, '--format', '{{.Name}}']);
    if (containers.length === 0 && networks.length === 0 && volumes.length === 0) {
      return { ownership: 'ABSENT' };
    }
    for (const container of containers) {
      if (!(await this.resourceHasLabels(ownerRunId, container.id, request.labels, '.Config.Labels'))) {
        return { ownership: 'UNPROVEN' };
      }
    }
    for (const network of networks) {
      if (!(await this.resourceHasLabels(ownerRunId, network.id, request.labels, '.Labels'))) {
        return { ownership: 'UNPROVEN' };
      }
    }
    for (const name of volumes) {
      if (!(await this.resourceHasLabels(ownerRunId, name, request.labels, '.Labels'))) {
        return { ownership: 'UNPROVEN' };
      }
    }
    const reservedPorts = new Set<number>();
    for (const container of containers) {
      const portOutput = await this.docker(ownerRunId, ['port', container.id]);
      for (const line of portOutput.output.split('\n')) {
        const match = /:(\d+)\s*$/u.exec(line);
        if (match !== null) reservedPorts.add(Number(match[1]));
      }
    }
    return {
      ownership: 'PROVEN',
      resource: {
        driver: 'compose',
        ownerRunId,
        composeProjectName: request.composeProjectName,
        resourceRefs: [
          `compose-project:${request.composeProjectName}`,
          ...containers.map((container) => `container:${container.id}`),
          ...networks.map((network) => `network:${network.id}`),
          ...volumes.map((name) => `volume:${name}`),
        ].sort(compare),
        reservedPorts: [...reservedPorts].sort((left, right) => left - right),
        labels: request.labels,
        networkNames: networks.map((network) => network.name),
        volumeNames: volumes,
        containerNames: containers.map((container) => container.name),
        containerIds: containers.map((container) => container.id),
        networkIds: networks.map((network) => network.id),
      },
    };
  }

  async release(request: ComposeReleaseRequest, signal?: AbortSignal): Promise<void> {
    const ownerRunId = request.resource.ownerRunId;
    if (request.resource.containerIds?.length !== request.resource.containerNames.length ||
        request.resource.networkIds?.length !== request.resource.networkNames.length) {
      throw new Error('COMPOSE_RELEASE_ENGINE_ID_UNPROVEN');
    }
    for (const id of request.resource.containerIds) {
      if (!(await this.resourceHasLabels(ownerRunId, id, request.resource.labels, '.Config.Labels'))) {
        throw new Error('COMPOSE_RELEASE_OWNERSHIP_UNPROVEN');
      }
      await this.docker(ownerRunId, ['rm', '--force', id], signal);
    }
    for (const id of request.resource.networkIds) {
      if (!(await this.resourceHasLabels(ownerRunId, id, request.resource.labels, '.Labels'))) {
        throw new Error('COMPOSE_RELEASE_OWNERSHIP_UNPROVEN');
      }
      await this.docker(ownerRunId, ['network', 'rm', id], signal);
    }
    for (const name of request.resource.volumeNames) {
      if (!(await this.resourceHasLabels(ownerRunId, name, request.resource.labels, '.Labels'))) {
        throw new Error('COMPOSE_RELEASE_OWNERSHIP_UNPROVEN');
      }
      await this.docker(ownerRunId, ['volume', 'rm', name], signal);
    }
  }

  private async compose(
    request: ComposeEffectiveConfigRequest,
    command: readonly string[],
    signal?: AbortSignal,
    override?: string,
    definition?: EnvironmentStepDefinition,
  ) {
    if (request.profile !== undefined) {
      await verifyDefinitionDigest(request.definitionPath, request.profile.definitionContentHash);
    }
    return this.run({
      executable: this.executable,
      argv: [
        'compose', '-f', request.definitionPath,
        ...(override === undefined ? [] : ['-f', '-']),
        '-p', request.projectName,
        ...command,
      ],
      shell: false,
      cwd: dirname(request.definitionPath),
      environment: composeRequestEnvironment(request),
      timeoutMs: definition !== undefined && 'timeoutMs' in definition
        ? definition.timeoutMs
        : this.timeoutMs,
      outputLimit: definition !== undefined && 'outputLimit' in definition
        ? definition.outputLimit
        : this.outputLimit,
      network: definition !== undefined && 'network' in definition ? definition.network : 'DENY',
      ownerRunId: request.resource.ownerRunId,
      sandboxProofId: undefined,
      ...(override === undefined ? {} : { stdin: override }),
    }, signal);
  }

  private async docker(ownerRunId: string, argv: readonly string[], signal?: AbortSignal) {
    return this.run({
      executable: this.executable,
      argv,
      shell: false,
      cwd: process.cwd(),
      environment: {},
      timeoutMs: this.timeoutMs,
      outputLimit: this.outputLimit,
      network: 'DENY',
      ownerRunId,
      sandboxProofId: undefined,
    }, signal);
  }

  private async dockerList(ownerRunId: string, argv: readonly string[]): Promise<string[]> {
    const result = await this.docker(ownerRunId, argv);
    return result.output.split('\n').map((line) => line.trim()).filter(Boolean).sort(compare);
  }

  private async dockerObjects(
    ownerRunId: string,
    argv: readonly string[],
  ): Promise<Array<{ readonly id: string; readonly name: string }>> {
    const result = await this.docker(ownerRunId, argv);
    return result.output.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const [id, name] = line.split('\t', 2);
      if (id === undefined || name === undefined || id.length === 0 || name.length === 0) {
        throw new Error('COMPOSE_ENGINE_ID_INSPECTION_INVALID');
      }
      return { id, name };
    }).sort((left, right) => compare(left.name, right.name));
  }

  private async resourceHasLabels(
    ownerRunId: string,
    name: string,
    expected: Readonly<Record<string, string>>,
    selector: string,
  ): Promise<boolean> {
    const result = await this.docker(ownerRunId, ['inspect', '--format', `{{json ${selector}}}`, name]);
    let labels: unknown;
    try {
      labels = JSON.parse(result.output.trim()) as unknown;
    } catch {
      return false;
    }
    return isRecord(labels) && Object.entries(expected).every(([key, value]) => labels[key] === value);
  }

  private async run(request: ArgvRunRequest, signal?: AbortSignal) {
    const containment = await this.processContainment();
    requireComposeProcessContainment(containment);
    let executable = request.executable;
    if (this.boundExecutorIdentity !== undefined) {
      if (this.declaredExecutorIdentity === undefined) {
        const currentPath = await resolveExecutablePath(this.executable);
        const currentDigest = sha256(await readFile(currentPath));
        if (currentPath !== this.boundExecutorIdentity.executablePath ||
            currentDigest !== this.boundExecutorIdentity.executableDigest) {
          throw new Error('COMPOSE_EXECUTOR_IDENTITY_CHANGED');
        }
      }
      executable = this.boundExecutorIdentity.executablePath;
    }
    const result = await this.runner.run({ ...request, executable }, signal);
    if (result.processContainer === undefined ||
        result.processContainer.kind !== containment.kind ||
        result.processContainer.id.length === 0 ||
        result.processContainer.emptyAfterExit !== true) {
      throw new Error('COMPOSE_PROCESS_CONTAINER_ATTESTATION_MISMATCH');
    }
    if (result.exitCode !== 0) {
      throw new Error(`COMPOSE_RUNTIME_COMMAND_FAILED: exit ${String(result.exitCode)}: ${result.output}`);
    }
    return result;
  }
}

class ComposeEnvironmentAdapter implements IntegrationEnvironmentAdapter {
  readonly driver = 'compose' as const;

  constructor(private readonly options: ComposeEnvironmentAdapterOptions) {}

  async probe(profile: IntegrationEnvironmentProfile): Promise<EnvironmentProbe> {
    if (profile.driver !== this.driver) return wrongDriverProbe(profile.driver, this.driver);
    try {
      requireResolvableComposeReferences(profile, this.options.resolveCommand);
      requireComposeProcessContainment(await this.options.runtime.processContainment());
      const definitionPath = await resolveOwnedFile(this.options.workspaceRoot, profile.definitionRef);
      await verifyDefinitionDigest(definitionPath, profile.definitionContentHash);
      const initialResource = desiredResource(profile, 'WKS-0000', 'IER-0000');
      const effective = await this.options.runtime.effectiveConfig({
        definitionPath,
        projectName: initialResource.composeProjectName,
        labels: initialResource.labels,
        resource: initialResource,
        profile,
      });
      const resource = resourceFromEffectiveConfig(initialResource, effective);
      await validateComposeEffectiveConfig(effective, profile, {
        definitionPath,
        workspaceRoot: this.options.workspaceRoot,
        sourceRoots: profile.requiredProjects.map((project) => join(this.options.workspaceRoot, project)),
        resource,
      });
      return {
        driver: this.driver,
        authoritative: true,
        mode: 'AUTHORITATIVE',
        code: 'COMPOSE_PROBE_READY',
        reasons: [],
      };
    } catch (error) {
      return {
        driver: this.driver,
        authoritative: false,
        mode: 'DIAGNOSTIC_ONLY',
        code: errorCode(error, 'COMPOSE_PROBE_FAILED'),
        reasons: [errorMessage(error)],
      };
    }
  }

  async prepare(context: EnvironmentAdapterContext): Promise<PreparedEnvironment> {
    const profile = context.profile;
    if (profile.driver !== this.driver) {
      const probe = wrongDriverProbe(profile.driver, this.driver);
      return blocked(context, probe, probe.code, probe.reasons[0]!);
    }
    try {
      validateEnvironmentAdapterContext(context, this.driver);
      await requireContextWorkspace(this.options.workspaceRoot, context.workspaceRoot);
      const definitionPath = await resolveOwnedFile(this.options.workspaceRoot, profile.definitionRef);
      await verifyDefinitionDigest(definitionPath, profile.definitionContentHash);
      const initialResource = desiredResource(
        profile,
        context.worksetId,
        context.environmentRunId,
        context.integrationInput.inputHash,
      );
      const steps = await resolveComposeStepDefinitions(context, this.options.resolveCommand);
      requireComposeProcessContainment(await this.options.runtime.processContainment());
      const executorIdentity = await this.options.runtime.executorIdentity();
      requireComposeExecutorIdentity(context, executorIdentity);
      const effectiveConfig = await this.options.runtime.effectiveConfig({
        definitionPath,
        projectName: initialResource.composeProjectName,
        labels: initialResource.labels,
        resource: initialResource,
        profile,
      });
      const resource = resourceFromEffectiveConfig(initialResource, effectiveConfig);
      await validateComposeEffectiveConfig(effectiveConfig, profile, {
        definitionPath,
        workspaceRoot: this.options.workspaceRoot,
        sourceRoots: context.sourceRoots,
        runRoot: context.runRoot,
        resource,
      });
      const buildContexts = await composeBuildContextIdentities(effectiveConfig, definitionPath);
      requireComposeBuildContextDigests(context, buildContexts);
      const probe: EnvironmentProbe = {
        driver: this.driver,
        authoritative: true,
        mode: 'AUTHORITATIVE',
        code: 'COMPOSE_PROBE_READY',
        reasons: [],
      };
      return {
        status: 'READY',
        driver: this.driver,
        context,
        probe,
        preparedData: {
          definitionPath,
          effectiveConfig,
          resource,
          steps,
          executorIdentity,
          buildContexts,
          normalizedConfigDigest: hashObject(effectiveConfig),
        } satisfies ComposePreparedData,
      };
    } catch (error) {
      const probe: EnvironmentProbe = {
        driver: this.driver,
        authoritative: false,
        mode: 'DIAGNOSTIC_ONLY',
        code: errorCode(error, 'COMPOSE_PREPARE_FAILED'),
        reasons: [errorMessage(error)],
      };
      return blocked(context, probe, probe.code, probe.reasons[0]!);
    }
  }

  async runStep(
    prepared: ReadyPreparedEnvironment,
    step: EnvironmentStep,
    signal?: AbortSignal,
  ): Promise<EnvironmentStepResult> {
    validateEnvironmentAdapterContext(prepared.context, this.driver);
    const data = composePreparedData(prepared);
    const executorIdentity = await this.options.runtime.executorIdentity();
    requireComposeExecutorIdentity(prepared.context, executorIdentity, data.executorIdentity);
    const definition = data.steps[step.name];
    if (step.name === 'setup') {
      const environment = resolveSecretEnvironment(
        prepared.context.profile,
        prepared.context.sourceEnvironment(),
      );
      const secrets = Object.values(environment);
      try {
        const current = await this.validateCurrentConfig(prepared, data, environment, signal);
        await claimEnvironmentAllocation(prepared.context);
        const resource = await this.options.runtime.setup(current.request, current.validation, signal);
        requireOwnedResource(resource, data.resource, prepared.context.profile);
        return success(step.name, {
          resource,
          composeIdentity: composeStepIdentity(
            data,
            executorIdentity,
            [],
            current.validation.normalizedConfigDigest,
            current.buildContexts,
          ),
        });
      } catch (error) {
        throw redactedError(error, secrets);
      }
    }
    if (step.name === 'teardown') {
      const release = await this.release(prepared.context, signal);
      if (release.status === 'BLOCKED') throw new Error(release.code);
      return success(step.name);
    }
    const inspection = await this.options.runtime.inspect({
      composeProjectName: data.resource.composeProjectName,
      labels: data.resource.labels,
    });
    if (inspection.ownership !== 'PROVEN' || inspection.resource === undefined) {
      throw new Error(`COMPOSE_OWNERSHIP_UNPROVEN: ${data.resource.composeProjectName}`);
    }
    requireOwnedResource(inspection.resource, data.resource, prepared.context.profile);
    const environment = resolveSecretEnvironment(
      prepared.context.profile,
      prepared.context.sourceEnvironment(),
    );
    const secrets = Object.values(environment);
    let result: {
      readonly exitCode: number;
      readonly output: string;
      readonly truncated: boolean;
      readonly imageDigests?: readonly ComposeContentDigest[];
    };
    try {
      const current = await this.validateCurrentConfig(prepared, data, environment, signal);
      await verifyDefinitionDigest(data.definitionPath, prepared.context.profile.definitionContentHash);
      const raw = await this.options.runtime.runStep({
        ...current.request,
        resource: inspection.resource,
        step,
        definition,
      }, signal);
      result = { ...raw, output: redactSecrets(raw.output, secrets) };
      if (result.exitCode !== 0) {
        throw new Error(`COMPOSE_STEP_FAILED: ${step.name}: exit ${result.exitCode}: ${result.output}`);
      }
      if (step.name === 'build') {
        requireComposeImageDigests(prepared.context, current.buildContexts, result.imageDigests);
      }
      const identity = composeStepIdentity(
        data,
        executorIdentity,
        result.imageDigests,
        current.validation.normalizedConfigDigest,
        current.buildContexts,
      );
      if (step.name === 'start') {
        const started = await this.options.runtime.inspect({
          composeProjectName: data.resource.composeProjectName,
          labels: data.resource.labels,
        });
        if (started.ownership !== 'PROVEN' || started.resource === undefined) {
          throw new Error(`COMPOSE_OWNERSHIP_UNPROVEN: ${data.resource.composeProjectName}`);
        }
        requireOwnedResource(started.resource, data.resource, prepared.context.profile);
        return success(step.name, { ...result, resource: started.resource, composeIdentity: identity });
      }
      return success(step.name, {
        ...result,
        resource: inspection.resource,
        composeIdentity: identity,
      });
    } catch (error) {
      throw redactedError(error, secrets);
    }
  }

  private async validateCurrentConfig(
    prepared: ReadyPreparedEnvironment,
    data: ComposePreparedData,
    environment: Readonly<Record<string, string>>,
    signal: AbortSignal | undefined,
  ): Promise<{
    readonly request: ComposeSetupRequest;
    readonly validation: ComposeSetupValidation;
    readonly buildContexts: readonly ComposeBuildContextIdentity[];
  }> {
    await verifyDefinitionDigest(data.definitionPath, prepared.context.profile.definitionContentHash);
    const effectiveConfig = await this.options.runtime.effectiveConfig({
      definitionPath: data.definitionPath,
      projectName: data.resource.composeProjectName,
      labels: data.resource.labels,
      resource: data.resource,
      profile: prepared.context.profile,
    });
    const request: ComposeSetupRequest = {
      definitionPath: data.definitionPath,
      projectName: data.resource.composeProjectName,
      labels: data.resource.labels,
      resource: data.resource,
      runRoot: prepared.context.runRoot,
      workspaceRoot: prepared.context.workspaceRoot,
      sourceRoots: prepared.context.sourceRoots,
      profile: prepared.context.profile,
      environment,
      effectiveConfig,
    };
    const validation = await this.options.runtime.validateSetup(request, signal);
    const normalizedResource = resourceFromEffectiveConfig(data.resource, validation.normalizedConfig);
    requireOwnedResource(validation.resource, normalizedResource, prepared.context.profile);
    await validateComposeEffectiveConfig(validation.normalizedConfig, prepared.context.profile, {
      definitionPath: data.definitionPath,
      workspaceRoot: prepared.context.workspaceRoot,
      sourceRoots: prepared.context.sourceRoots,
      runRoot: prepared.context.runRoot,
      resource: normalizedResource,
    });
    const expectedDigest = hashObject(validation.normalizedConfig);
    if (validation.normalizedConfigDigest !== expectedDigest) {
      throw new Error('COMPOSE_NORMALIZED_CONFIG_DIGEST_MISMATCH');
    }
    const buildContexts = await composeBuildContextIdentities(
      validation.normalizedConfig,
      data.definitionPath,
    );
    requireComposeBuildContextDigests(prepared.context, buildContexts);
    if (canonicalDigestList(buildContexts) !== canonicalDigestList(data.buildContexts)) {
      throw new Error('COMPOSE_BUILD_CONTEXT_DIGEST_MISMATCH');
    }
    return {
      request: { ...request, resource: normalizedResource, effectiveConfig: validation.normalizedConfig },
      validation: { ...validation, resource: normalizedResource },
      buildContexts,
    };
  }

  async inspect(context: EnvironmentAdapterContext): Promise<EnvironmentInspection> {
    validateEnvironmentAdapterContext(context, this.driver);
    requireComposeExecutorIdentity(context, await this.options.runtime.executorIdentity());
    const expected = desiredResource(
      context.profile,
      context.worksetId,
      context.environmentRunId,
      context.integrationInput.inputHash,
    );
    const inspection = await this.options.runtime.inspect({
      composeProjectName: expected.composeProjectName,
      labels: expected.labels,
    });
    if (inspection.ownership === 'ABSENT') {
      return { driver: this.driver, ownership: 'ABSENT', code: 'COMPOSE_RESOURCE_ABSENT' };
    }
    if (inspection.ownership !== 'PROVEN' || inspection.resource === undefined ||
        !isOwnedResource(inspection.resource, expected) ||
        !portsWithinProfile(inspection.resource.reservedPorts, context.profile)) {
      return { driver: this.driver, ownership: 'UNPROVEN', code: 'COMPOSE_OWNERSHIP_UNPROVEN' };
    }
    return {
      driver: this.driver,
      ownership: 'PROVEN',
      resource: inspection.resource,
      code: 'COMPOSE_OWNERSHIP_PROVEN',
    };
  }

  async release(
    context: EnvironmentAdapterContext,
    signal?: AbortSignal,
  ): Promise<EnvironmentReleaseResult> {
    validateEnvironmentAdapterContext(context, this.driver);
    requireComposeExecutorIdentity(context, await this.options.runtime.executorIdentity());
    const inspection = await this.inspect(context);
    if (inspection.ownership === 'ABSENT') {
      await releaseEnvironmentAllocation(context);
      return { driver: this.driver, status: 'ALREADY_ABSENT', code: 'COMPOSE_ALREADY_ABSENT' };
    }
    if (inspection.ownership !== 'PROVEN' || inspection.resource?.driver !== 'compose' ||
        inspection.resource.composeProjectName === undefined) {
      return { driver: this.driver, status: 'BLOCKED', code: 'COMPOSE_RELEASE_OWNERSHIP_UNPROVEN' };
    }
    const definitionPath = await resolveOwnedFile(this.options.workspaceRoot, context.profile.definitionRef);
    await this.options.runtime.release({
      definitionPath,
      resource: inspection.resource as ComposeRuntimeResource,
    }, signal);
    await releaseEnvironmentAllocation(context);
    return { driver: this.driver, status: 'RELEASED', code: 'COMPOSE_RELEASED' };
  }
}

function desiredResource(
  profile: IntegrationEnvironmentProfile,
  worksetId: string,
  environmentRunId: string,
  integrationInputHash?: string,
): ComposeRuntimeResource {
  const identity = sanitizeName(`omnai-${worksetId}-${environmentRunId}-${profile.contentHash.slice(7, 19)}`);
  const labels = {
    'omnai.owner': 'omnai',
    'omnai.worksetId': worksetId,
    'omnai.environmentRunId': environmentRunId,
    'omnai.profileContentHash': profile.contentHash,
    ...(integrationInputHash === undefined ? {} : {
      'omnai.integrationInputHash': integrationInputHash,
    }),
  };
  return {
    driver: 'compose',
    ownerRunId: environmentRunId,
    composeProjectName: identity,
    resourceRefs: [`compose-project:${identity}`],
    reservedPorts: [],
    labels,
    networkNames: [`${identity}-network`],
    volumeNames: [`${identity}-data`],
    containerNames: profile.requiredProjects.map((project) => `${identity}-${sanitizeName(project)}`),
  };
}

function resourceFromEffectiveConfig(
  initial: ComposeRuntimeResource,
  value: unknown,
): ComposeRuntimeResource {
  if (!isRecord(value)) return initial;
  const networkNames = namedComposeResources(value.networks);
  const volumeNames = namedComposeResources(value.volumes);
  const containerNames = isRecord(value.services)
    ? Object.values(value.services)
      .flatMap((service) => isRecord(service) && typeof service.container_name === 'string'
        ? [service.container_name]
        : [])
      .sort(compare)
    : [];
  const effectiveNetworks = networkNames.length > 0 ? networkNames : initial.networkNames;
  const effectiveVolumes = volumeNames.length > 0 ? volumeNames : initial.volumeNames;
  const effectiveContainers = containerNames.length > 0 ? containerNames : initial.containerNames;
  return {
    ...initial,
    resourceRefs: [
      `compose-project:${initial.composeProjectName}`,
      ...effectiveContainers.map((name) => `container:${name}`),
      ...effectiveNetworks.map((name) => `network:${name}`),
      ...effectiveVolumes.map((name) => `volume:${name}`),
    ].sort(compare),
    networkNames: effectiveNetworks,
    volumeNames: effectiveVolumes,
    containerNames: effectiveContainers,
  };
}

function namedComposeResources(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .map(([key, definition]) => isRecord(definition) && typeof definition.name === 'string'
      ? definition.name
      : key)
    .sort(compare);
}

function composeOverride(
  value: unknown,
  request: ComposeEffectiveConfigRequest,
): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.services)) {
    throw new Error('COMPOSE_BASE_CONFIG_INVALID: services required');
  }
  const baseNetworks = isRecord(value.networks) && Object.keys(value.networks).length > 0
    ? Object.keys(value.networks).sort(compare)
    : ['default'];
  const baseVolumes = isRecord(value.volumes)
    ? Object.keys(value.volumes).sort(compare)
    : [];
  const networks = Object.fromEntries(baseNetworks.map((key) => [key, {
    name: `${request.projectName}-network-${sanitizeName(key)}`,
    labels: request.labels,
  }]));
  const volumes = Object.fromEntries(baseVolumes.map((key) => [key, {
    name: `${request.projectName}-volume-${sanitizeName(key)}`,
    labels: request.labels,
  }]));
  const services = Object.fromEntries(
    Object.entries(value.services).sort(([left], [right]) => compare(left, right)).map(([name, service]) => {
      if (!isRecord(service)) throw new Error(`COMPOSE_BASE_CONFIG_INVALID: service ${name}`);
      const serviceNetworks = composeServiceNetworkKeys(service.networks, baseNetworks);
      const ports = composePublishedPorts(service.ports, request.profile?.ports.mode ?? 'dynamic');
      return [name, {
        container_name: `${request.projectName}-${sanitizeName(name)}`,
        labels: request.labels,
        networks: Object.fromEntries(serviceNetworks.map((key) => [key, null])),
        ...(ports === undefined ? {} : { ports }),
      }];
    }),
  );
  return {
    services,
    networks,
    ...(baseVolumes.length === 0 ? {} : { volumes }),
  };
}

function mergeComposeConfig(base: unknown, override: unknown): Record<string, unknown> {
  if (!isRecord(base) || !isRecord(override)) {
    throw new Error('COMPOSE_BASE_CONFIG_INVALID: object required');
  }
  const merged: Record<string, unknown> = { ...base, ...override };
  for (const key of ['services', 'networks', 'volumes'] as const) {
    const baseSection = base[key];
    const overrideSection = override[key];
    if (!isRecord(overrideSection)) continue;
    const section: Record<string, unknown> = isRecord(baseSection) ? { ...baseSection } : {};
    for (const [name, value] of Object.entries(overrideSection)) {
      const original = section[name];
      section[name] = isRecord(original) && isRecord(value)
        ? { ...original, ...value }
        : value;
    }
    merged[key] = section;
  }
  return merged;
}

function composeServiceNetworkKeys(value: unknown, defaults: readonly string[]): string[] {
  if (Array.isArray(value)) {
    const keys = value.filter((item): item is string => typeof item === 'string');
    return keys.length > 0 ? keys.sort(compare) : [...defaults];
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort(compare);
    return keys.length > 0 ? keys : [...defaults];
  }
  return [...defaults];
}

function composePublishedPorts(
  value: unknown,
  mode: IntegrationEnvironmentProfile['ports']['mode'],
): readonly unknown[] | undefined {
  if (value === undefined) return undefined;
  if (mode !== 'dynamic') throw new Error(`COMPOSE_PORT_MODE_UNSUPPORTED: ${mode}`);
  if (!Array.isArray(value)) throw new Error('COMPOSE_BASE_CONFIG_INVALID: ports');
  return value.map((port) => {
    if (typeof port === 'string') {
      const pieces = port.split(':');
      const target = Number(pieces[pieces.length - 1]!.split('/')[0]);
      if (!Number.isInteger(target)) throw new Error(`COMPOSE_BASE_CONFIG_INVALID: port ${port}`);
      return { target, published: '0' };
    }
    if (!isRecord(port) || port.target === undefined) {
      throw new Error('COMPOSE_BASE_CONFIG_INVALID: port');
    }
    return { ...port, published: '0' };
  });
}

function parseComposeJson(value: string, code: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${code}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function firstComposeService(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.services)) {
    throw new Error('COMPOSE_EFFECTIVE_CONFIG_INVALID: services required');
  }
  const service = Object.keys(value.services).sort(compare)[0];
  if (service === undefined) throw new Error('COMPOSE_EFFECTIVE_CONFIG_INVALID: service required');
  return service;
}

const composeBuiltinSteps = new Set<EnvironmentStep['name']>([
  'setup', 'build', 'start', 'health', 'collect', 'teardown',
]);

function requireResolvableComposeReferences(
  profile: IntegrationEnvironmentProfile,
  resolver: EnvironmentCommandResolver | undefined,
): void {
  for (const name of ['seed', 'test'] as const) {
    if ('commandRef' in profile.steps[name] && resolver === undefined) {
      throw new Error(`COMPOSE_STEP_COMMAND_REFERENCE_UNRESOLVED: ${profile.steps[name].commandRef}`);
    }
  }
}

async function resolveComposeStepDefinitions(
  context: EnvironmentAdapterContext,
  resolver: EnvironmentCommandResolver | undefined,
): Promise<Readonly<Record<EnvironmentStep['name'], EnvironmentStepDefinition>>> {
  const entries = await Promise.all(Object.entries(context.profile.steps).map(async ([rawName, definition]) => {
    const name = rawName as EnvironmentStep['name'];
    if ('executable' in definition) return [name, definition] as const;
    if (composeBuiltinSteps.has(name) && definition.commandRef === `environment.${name}`) {
      return [name, definition] as const;
    }
    if (resolver === undefined) {
      throw new Error(`COMPOSE_STEP_COMMAND_REFERENCE_UNRESOLVED: ${definition.commandRef}`);
    }
    const resolved = await resolver(definition.commandRef, context);
    validateComposeResolvedCommand(resolved);
    return [name, resolved] as const;
  }));
  return Object.fromEntries(entries) as Readonly<Record<EnvironmentStep['name'], EnvironmentStepDefinition>>;
}

function validateComposeResolvedCommand(command: ResolvedEnvironmentCommand): void {
  const executable = command.executable.split(/[\\/]/u).at(-1)?.toLowerCase().replace(/\.exe$/u, '') ?? '';
  if (new Set([
    'bash', 'cmd', 'command', 'csh', 'dash', 'elvish', 'fish', 'ksh',
    'nu', 'powershell', 'pwsh', 'sh', 'tcsh', 'zsh',
  ]).has(executable)) {
    throw new Error(`COMPOSE_STEP_SHELL_LAUNCHER_FORBIDDEN: ${command.executable}`);
  }
  if (command.executable.includes('\0') || command.argv.some((argument) => argument.includes('\0'))) {
    throw new Error('COMPOSE_STEP_COMMAND_INVALID');
  }
}

async function validateComposeEffectiveConfig(
  value: unknown,
  profile: IntegrationEnvironmentProfile,
  boundaries: {
    readonly definitionPath: string;
    readonly workspaceRoot: string;
    readonly sourceRoots: readonly string[];
    readonly runRoot?: string;
    readonly resource: ComposeRuntimeResource;
  },
  secretEnvironment?: Readonly<Record<string, string>>,
): Promise<void> {
  const canonical = await canonicalComposeBoundaries(boundaries);
  if (!isRecord(value) || !isRecord(value.services)) {
    denyCompose('SERVICES_REQUIRED');
  }
  for (const [name, serviceValue] of Object.entries(value.services)) {
    if (!isRecord(serviceValue)) denyCompose(`SERVICE_INVALID: ${name}`);
    const service = serviceValue as Record<string, unknown>;
    if (service.privileged === true) denyCompose(`PRIVILEGED: ${name}`);
    if (service.network_mode === 'host') denyCompose(`HOST_NETWORK: ${name}`);
    if (service.pid === 'host') denyCompose(`HOST_PID: ${name}`);
    if (service.ipc === 'host') denyCompose(`HOST_IPC: ${name}`);
    if (nonEmptyList(service.devices)) denyCompose(`DEVICES: ${name}`);
    if (nonEmptyList(service.cap_add)) denyCompose(`CAP_ADD: ${name}`);
    requireOwnershipLabels(service.labels, boundaries.resource.labels, `SERVICE_LABELS: ${name}`);
    await validateComposeImageAndBuild(name, service, canonical);
    await validateComposeMounts(name, service.volumes, canonical);
    validateComposeEnvironment(name, service.environment, profile.envRefs, secretEnvironment);
    validateComposePorts(name, service.ports, profile.ports.mode);
  }
  for (const project of profile.requiredProjects) {
    const service = value.services[project];
    if (!isRecord(service)) {
      denyCompose(`SERVICE_REQUIRED: ${project}`);
    }
  }
  validateTopLevelResources(value.networks, boundaries.resource.networkNames, boundaries.resource.labels, 'NETWORK');
  validateTopLevelResources(value.volumes, boundaries.resource.volumeNames, boundaries.resource.labels, 'VOLUME');
}

interface CanonicalComposeBoundaries {
  readonly definitionPath: string;
  readonly workspaceRoot: string;
  readonly sourceRoots: readonly string[];
  readonly runRoot?: string;
  readonly resource: ComposeRuntimeResource;
}

async function canonicalComposeBoundaries(boundaries: {
  readonly definitionPath: string;
  readonly workspaceRoot: string;
  readonly sourceRoots: readonly string[];
  readonly runRoot?: string;
  readonly resource: ComposeRuntimeResource;
}): Promise<CanonicalComposeBoundaries> {
  const definitionPath = await canonicalComposePath(boundaries.definitionPath, 'DEFINITION');
  const workspaceRoot = await canonicalComposePath(boundaries.workspaceRoot, 'WORKSPACE_ROOT');
  const sourceRoots = await Promise.all(boundaries.sourceRoots.map(
    (root) => canonicalComposePath(root, 'SOURCE_ROOT'),
  ));
  for (const sourceRoot of sourceRoots) {
    if (!isOwnedPath(workspaceRoot, sourceRoot)) denyCompose(`SOURCE_ROOT_OUTSIDE_WORKSPACE: ${sourceRoot}`);
  }
  if (boundaries.runRoot === undefined) {
    return { definitionPath, workspaceRoot, sourceRoots, resource: boundaries.resource };
  }
  const runRoot = await canonicalComposePath(boundaries.runRoot, 'RUN_ROOT');
  if (isOwnedPath(workspaceRoot, runRoot) || isOwnedPath(runRoot, workspaceRoot) ||
      sourceRoots.some((sourceRoot) =>
        isOwnedPath(sourceRoot, runRoot) || isOwnedPath(runRoot, sourceRoot))) {
    denyCompose('RUN_ROOT_OVERLAPS_SOURCE');
  }
  return { definitionPath, workspaceRoot, sourceRoots, runRoot, resource: boundaries.resource };
}

async function canonicalComposePath(path: string, kind: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    denyCompose(`${kind}_UNRESOLVED: ${path}`);
  }
}

async function validateComposeImageAndBuild(
  name: string,
  service: Readonly<Record<string, unknown>>,
  boundaries: CanonicalComposeBoundaries,
): Promise<void> {
  if (service.image !== undefined &&
      (typeof service.image !== 'string' || !/@sha256:[0-9a-f]{64}$/u.test(service.image))) {
    denyCompose(`IMMUTABLE_IMAGE_REQUIRED: ${name}`);
  }
  if (service.build === undefined) {
    if (service.image === undefined) denyCompose(`IMAGE_OR_BUILD_REQUIRED: ${name}`);
    return;
  }
  const context = typeof service.build === 'string'
    ? service.build
    : isRecord(service.build) && typeof service.build.context === 'string'
      ? service.build.context
      : undefined;
  if (context === undefined || context.length === 0) denyCompose(`BUILD_CONTEXT_INVALID: ${name}`);
  const declared = resolve(dirname(boundaries.definitionPath), context);
  let resolved: string;
  try {
    resolved = await realpath(declared);
  } catch {
    denyCompose(`BUILD_CONTEXT_UNRESOLVED: ${name}`);
  }
  if (!isOwnedPath(boundaries.workspaceRoot, resolved) ||
      !boundaries.sourceRoots.some((root) => isOwnedPath(root, resolved))) {
    denyCompose(`BUILD_CONTEXT_ESCAPE: ${name}`);
  }
}

async function composeBuildContextIdentities(
  value: unknown,
  definitionPath: string,
): Promise<readonly ComposeBuildContextIdentity[]> {
  if (!isRecord(value) || !isRecord(value.services)) {
    throw new Error('COMPOSE_EFFECTIVE_CONFIG_INVALID: services required');
  }
  const identities: ComposeBuildContextIdentity[] = [];
  for (const [service, candidate] of Object.entries(value.services).sort(([left], [right]) => compare(left, right))) {
    if (!isRecord(candidate) || candidate.build === undefined) continue;
    const declared = composeBuildContextDeclaration(candidate.build);
    if (declared === undefined) throw new Error(`COMPOSE_BUILD_CONTEXT_INVALID: ${service}`);
    const path = await realpath(resolve(dirname(definitionPath), declared));
    identities.push({
      service,
      path,
      ref: composeBuildContextDigestRef(service),
      digest: await hashComposeBuildContext(path),
    });
  }
  return identities;
}

function composeBuildContextDeclaration(value: unknown): string | undefined {
  return typeof value === 'string'
    ? value
    : isRecord(value) && typeof value.context === 'string'
      ? value.context
      : undefined;
}

function composeBuildServices(value: unknown): string[] {
  if (!isRecord(value) || !isRecord(value.services)) return [];
  return Object.entries(value.services)
    .flatMap(([service, candidate]) => isRecord(candidate) && candidate.build !== undefined ? [service] : [])
    .sort(compare);
}

function requireComposeExecutorIdentity(
  context: EnvironmentAdapterContext,
  actual: ComposeExecutorIdentity,
  prepared?: ComposeExecutorIdentity,
): void {
  const ref = composeExecutorDigestRef();
  const expected = context.integrationInput.executorDigests.filter((identity) => identity.ref === ref);
  if (expected.length !== 1) throw new Error(`COMPOSE_EXECUTOR_DIGEST_MAPPING_REQUIRED: ${ref}`);
  if (actual.ref !== ref || !isAbsolute(actual.executablePath) ||
      !/^sha256:[0-9a-f]{64}$/u.test(actual.executableDigest) ||
      actual.executableDigest !== expected[0]!.digest) {
    throw new Error('COMPOSE_EXECUTOR_DIGEST_MISMATCH');
  }
  if (prepared !== undefined && (
    prepared.ref !== actual.ref ||
    prepared.executablePath !== actual.executablePath ||
    prepared.executableDigest !== actual.executableDigest
  )) {
    throw new Error('COMPOSE_EXECUTOR_IDENTITY_CHANGED');
  }
}

function requireComposeProcessContainment(
  probe: ArgvProcessContainmentProbe,
): asserts probe is Extract<ArgvProcessContainmentProbe, { readonly status: 'PROVEN' }> {
  if (probe.status !== 'PROVEN' || probe.proofId.length === 0) {
    throw new Error(`COMPOSE_PROCESS_CONTAINER_UNPROVEN: ${
      probe.status === 'UNPROVEN' ? probe.code : 'invalid proof'
    }`);
  }
}

function requireComposeBuildContextDigests(
  context: EnvironmentAdapterContext,
  actual: readonly ComposeBuildContextIdentity[],
): void {
  for (const identity of actual) {
    const expected = context.integrationInput.supportingArtifactDigests.filter(
      (candidate) => candidate.ref === identity.ref,
    );
    if (expected.length !== 1) {
      throw new Error(`COMPOSE_BUILD_CONTEXT_DIGEST_MAPPING_REQUIRED: ${identity.ref}`);
    }
    if (expected[0]!.digest !== identity.digest) {
      throw new Error(`COMPOSE_BUILD_CONTEXT_DIGEST_MISMATCH: ${identity.service}`);
    }
  }
}

function requireComposeImageDigests(
  context: EnvironmentAdapterContext,
  buildContexts: readonly ComposeBuildContextIdentity[],
  actual: readonly ComposeContentDigest[] | undefined,
): void {
  const expected = buildContexts.map((identity) => {
    const ref = composeImageDigestRef(identity.service);
    const matches = context.integrationInput.supportingArtifactDigests.filter(
      (candidate) => candidate.ref === ref,
    );
    if (matches.length !== 1) throw new Error(`COMPOSE_IMAGE_DIGEST_MAPPING_REQUIRED: ${ref}`);
    return matches[0]!;
  }).sort((left, right) => compare(left.ref, right.ref));
  const normalizedActual = [...(actual ?? [])]
    .sort((left, right) => compare(left.ref, right.ref));
  if (canonicalDigestList(expected) !== canonicalDigestList(normalizedActual)) {
    throw new Error('COMPOSE_IMAGE_DIGEST_MISMATCH');
  }
}

function canonicalDigestList(values: readonly { readonly ref: string; readonly digest: string }[]): string {
  return JSON.stringify(values.map(({ ref, digest }) => ({ ref, digest }))
    .sort((left, right) => compare(left.ref, right.ref)));
}

async function validateComposeMounts(
  name: string,
  value: unknown,
  boundaries: CanonicalComposeBoundaries,
): Promise<void> {
  if (value === undefined) return;
  if (!Array.isArray(value)) denyCompose(`VOLUMES_INVALID: ${name}`);
  for (const item of value) {
    const mount = composeMount(item);
    if (mount === undefined) denyCompose(`VOLUME_INVALID: ${name}`);
    if (/(?:docker|podman)\.sock(?:$|\/)/u.test(mount.source) ||
        /(?:docker|podman)\.sock(?:$|\/)/u.test(mount.target)) {
      denyCompose(`CONTAINER_ENGINE_SOCKET: ${name}`);
    }
    if (mount.type !== 'bind') continue;
    const declared = isAbsolute(mount.source)
      ? mount.source
      : resolve(dirname(boundaries.definitionPath), mount.source);
    let source: string;
    try {
      source = await realpath(declared);
    } catch {
      denyCompose(`HOST_BIND_SOURCE_UNRESOLVED: ${name}`);
    }
    if (mount.readOnly && boundaries.sourceRoots.some((root) => isOwnedPath(root, source))) continue;
    if (!mount.readOnly && boundaries.runRoot !== undefined && isOwnedPath(boundaries.runRoot, source)) continue;
    denyCompose(`HOST_BIND_OUTSIDE_RUN_ROOT: ${name}`);
  }
}

function composeMount(value: unknown): {
  readonly type: 'bind' | 'volume' | 'other';
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
} | undefined {
  if (typeof value === 'string') {
    const parts = value.split(':');
    if (parts.length < 2) return undefined;
    const source = parts[0]!;
    return {
      type: isAbsolute(source) || source.startsWith('.') || source.includes('/') || source.includes('\\')
        ? 'bind'
        : 'volume',
      source,
      target: parts[1]!,
      readOnly: parts.slice(2).join(',').split(',').includes('ro'),
    };
  }
  if (!isRecord(value) || typeof value.source !== 'string' || typeof value.target !== 'string') {
    return undefined;
  }
  return {
    type: value.type === 'bind'
      ? 'bind'
      : value.type === 'volume'
        ? 'volume'
        : value.type === undefined && (
          isAbsolute(value.source) || value.source.startsWith('.') ||
          value.source.includes('/') || value.source.includes('\\')
        )
          ? 'bind'
          : 'other',
    source: value.source,
    target: value.target,
    readOnly: value.read_only === true || value.readOnly === true,
  };
}

function sanitizeComposeNormalizedConfig(
  value: unknown,
  envRefs: Readonly<Record<string, string>>,
  environment: Readonly<Record<string, string>>,
): unknown {
  const secretValues = Object.values(environment).filter((secret) => secret.length > 0);
  const visit = (candidate: unknown, path: readonly string[]): unknown => {
    if (path.length === 3 && path[0] === 'services' && path[2] === 'environment') {
      if (Array.isArray(candidate)) {
        return candidate.map((item) => {
          if (typeof item !== 'string') denyCompose(`ENVIRONMENT_INVALID: ${path[1]}`);
          const [key, literal] = item.split('=', 2);
          if (key === undefined || literal === undefined || envRefs[key] === undefined ||
              environment[key] === undefined || literal !== environment[key]) {
            denyCompose(`SECRET_PROVENANCE_INVALID: ${path[1]}:${String(key)}`);
          }
          return `${key}=\${${key}}`;
        });
      }
      if (!isRecord(candidate)) denyCompose(`ENVIRONMENT_INVALID: ${path[1]}`);
      return Object.fromEntries(Object.entries(candidate).map(([key, literal]) => {
        if (envRefs[key] === undefined || environment[key] === undefined ||
            literal !== environment[key]) {
          denyCompose(`SECRET_PROVENANCE_INVALID: ${path[1]}:${key}`);
        }
        return [key, `\${${key}}`];
      }));
    }
    if (typeof candidate === 'string') {
      if (secretValues.some((secret) => candidate.includes(secret))) {
        denyCompose(`SECRET_OUTSIDE_DECLARED_ENVIRONMENT: ${path.join('.')}`);
      }
      return candidate;
    }
    if (Array.isArray(candidate)) {
      return candidate.map((item, index) => visit(item, [...path, String(index)]));
    }
    if (!isRecord(candidate)) return candidate;
    return Object.fromEntries(Object.entries(candidate).map(
      ([key, item]) => [key, visit(item, [...path, key])],
    ));
  };
  return visit(value, []);
}

function validateComposeEnvironment(
  name: string,
  value: unknown,
  envRefs: Readonly<Record<string, string>>,
  resolvedSecrets?: Readonly<Record<string, string>>,
): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string') denyCompose(`ENVIRONMENT_INVALID: ${name}`);
      const [key, literal] = item.split('=', 2);
      if (key !== undefined && envRefs[key] !== undefined) {
        const expected = resolvedSecrets === undefined ? `\${${key}}` : resolvedSecrets[key];
        if (literal === undefined || expected === undefined || literal !== expected) {
          denyCompose(`SECRET_PROVENANCE_INVALID: ${name}:${key}`);
        }
        continue;
      }
      denyCompose(`UNDECLARED_ENVIRONMENT_VALUE: ${name}:${String(key)}`);
    }
    return;
  }
  if (!isRecord(value)) denyCompose(`ENVIRONMENT_INVALID: ${name}`);
  for (const [key, literal] of Object.entries(value)) {
    if (envRefs[key] !== undefined) {
      const expected = resolvedSecrets === undefined ? `\${${key}}` : resolvedSecrets[key];
      if (typeof literal !== 'string' || expected === undefined || literal !== expected) {
        denyCompose(`SECRET_PROVENANCE_INVALID: ${name}:${key}`);
      }
      continue;
    }
    denyCompose(`UNDECLARED_ENVIRONMENT_VALUE: ${name}:${key}`);
  }
}

function validateComposePorts(
  name: string,
  value: unknown,
  mode: IntegrationEnvironmentProfile['ports']['mode'],
): void {
  if (value === undefined) return;
  if (mode !== 'dynamic') throw new Error(`COMPOSE_PORT_MODE_UNSUPPORTED: ${mode}`);
  if (!Array.isArray(value)) denyCompose(`PORTS_INVALID: ${name}`);
  for (const port of value) {
    if (typeof port === 'string') {
      const pieces = port.split(':');
      if (pieces.length > 1 && pieces[0] !== '0') denyCompose(`STATIC_PUBLISHED_PORT: ${name}`);
      continue;
    }
    if (!isRecord(port)) denyCompose(`PORT_INVALID: ${name}`);
    if (port.published !== undefined && String(port.published) !== '0') {
      denyCompose(`STATIC_PUBLISHED_PORT: ${name}`);
    }
  }
}

function validateTopLevelResources(
  value: unknown,
  allowedNames: readonly string[],
  labels: Readonly<Record<string, string>>,
  kind: string,
): void {
  if (value === undefined) return;
  if (!isRecord(value)) denyCompose(`${kind}S_INVALID`);
  for (const [key, definition] of Object.entries(value)) {
    if (!isRecord(definition)) denyCompose(`${kind}_INVALID: ${key}`);
    const actualName = typeof definition.name === 'string' ? definition.name : key;
    if (!allowedNames.includes(actualName)) denyCompose(`${kind}_NOT_RUN_LOCAL: ${actualName}`);
    requireOwnershipLabels(definition.labels, labels, `${kind}_LABELS: ${actualName}`);
  }
}

function requireOwnershipLabels(
  value: unknown,
  expected: Readonly<Record<string, string>>,
  reason: string,
): void {
  const labels = normalizeLabels(value);
  if (labels === undefined || Object.entries(expected).some(([key, item]) => labels[key] !== item)) {
    denyCompose(reason);
  }
}

function normalizeLabels(value: unknown): Record<string, string> | undefined {
  if (isRecord(value)) {
    const labels: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item !== 'string') return undefined;
      labels[key] = item;
    }
    return labels;
  }
  if (Array.isArray(value)) {
    const labels: Record<string, string> = {};
    for (const item of value) {
      if (typeof item !== 'string' || !item.includes('=')) return undefined;
      const separator = item.indexOf('=');
      labels[item.slice(0, separator)] = item.slice(separator + 1);
    }
    return labels;
  }
  return undefined;
}

function nonEmptyList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function denyCompose(reason: string): never {
  throw new Error(`COMPOSE_EFFECTIVE_CONFIG_DENIED: ${reason}`);
}

function composePreparedData(prepared: ReadyPreparedEnvironment): ComposePreparedData {
  if (prepared.driver !== 'compose' || !isRecord(prepared.preparedData)) {
    throw new Error('COMPOSE_PREPARED_CONTEXT_INVALID');
  }
  const data = prepared.preparedData;
  if (typeof data.definitionPath !== 'string' || !isComposeResource(data.resource) ||
      !('effectiveConfig' in data) || !isRecord(data.steps) ||
      !isComposeExecutorIdentity(data.executorIdentity) || !Array.isArray(data.buildContexts) ||
      !data.buildContexts.every(isComposeBuildContextIdentity) ||
      typeof data.normalizedConfigDigest !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/u.test(data.normalizedConfigDigest)) {
    throw new Error('COMPOSE_PREPARED_CONTEXT_INVALID');
  }
  return {
    definitionPath: data.definitionPath,
    effectiveConfig: data.effectiveConfig,
    resource: data.resource,
    steps: data.steps as Readonly<Record<EnvironmentStep['name'], EnvironmentStepDefinition>>,
    executorIdentity: data.executorIdentity,
    buildContexts: data.buildContexts,
    normalizedConfigDigest: data.normalizedConfigDigest as ContentHash,
  };
}

function isComposeExecutorIdentity(value: unknown): value is ComposeExecutorIdentity {
  return isRecord(value) && value.ref === composeExecutorDigestRef() &&
    typeof value.executablePath === 'string' && isAbsolute(value.executablePath) &&
    typeof value.executableDigest === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value.executableDigest);
}

function isComposeBuildContextIdentity(value: unknown): value is ComposeBuildContextIdentity {
  return isRecord(value) && typeof value.service === 'string' && typeof value.path === 'string' &&
    typeof value.ref === 'string' && typeof value.digest === 'string' &&
    /^sha256:[0-9a-f]{64}$/u.test(value.digest);
}

function success(
  step: EnvironmentStep['name'],
  values: Partial<Pick<
    EnvironmentStepResult,
    'exitCode' | 'output' | 'truncated' | 'resource' | 'composeIdentity'
  >> = {},
): EnvironmentStepResult {
  return {
    status: 'SUCCEEDED',
    step,
    exitCode: values.exitCode ?? 0,
    output: values.output ?? '',
    truncated: values.truncated ?? false,
    ...(values.resource === undefined ? {} : { resource: values.resource }),
    ...(values.composeIdentity === undefined ? {} : { composeIdentity: values.composeIdentity }),
  };
}

function composeStepIdentity(
  data: ComposePreparedData,
  executor: ComposeExecutorIdentity,
  imageDigests: readonly ComposeContentDigest[] = [],
  normalizedConfigDigest: ContentHash = data.normalizedConfigDigest,
  buildContexts: readonly ComposeBuildContextIdentity[] = data.buildContexts,
): NonNullable<EnvironmentStepResult['composeIdentity']> {
  return {
    executorPath: executor.executablePath,
    executorDigest: executor.executableDigest,
    normalizedConfigDigest,
    buildContextDigests: buildContexts.map(({ ref, digest }) => ({ ref, digest })),
    imageDigests: [...imageDigests].sort((left, right) => compare(left.ref, right.ref)),
  };
}

function blocked(
  context: EnvironmentAdapterContext,
  probe: EnvironmentProbe,
  code: string,
  reason: string,
): PreparedEnvironment {
  return { status: 'BLOCKED', driver: 'compose', context, probe, code, reason };
}

function wrongDriverProbe(actual: string, expected: string): EnvironmentProbe {
  return {
    driver: 'compose',
    authoritative: false,
    mode: 'DIAGNOSTIC_ONLY',
    code: 'ENVIRONMENT_ADAPTER_DRIVER_MISMATCH',
    reasons: [`expected ${expected}, received ${actual}`],
  };
}

async function resolveOwnedFile(root: string, ref: string): Promise<string> {
  if (isAbsolute(ref) || ref.length === 0) throw new Error(`COMPOSE_DEFINITION_PATH_INVALID: ${ref}`);
  const normalizedRoot = await realpath(root);
  const candidate = resolve(normalizedRoot, ref);
  if (!isOwnedPath(normalizedRoot, candidate)) throw new Error(`COMPOSE_DEFINITION_PATH_ESCAPE: ${ref}`);
  const resolved = await realpath(candidate);
  if (!isOwnedPath(normalizedRoot, resolved)) throw new Error(`COMPOSE_DEFINITION_PATH_ESCAPE: ${ref}`);
  return resolved;
}

async function verifyDefinitionDigest(path: string, expected: string): Promise<void> {
  const { createHash } = await import('node:crypto');
  const actual = `sha256:${createHash('sha256').update(await readFile(path)).digest('hex')}`;
  if (actual !== expected) throw new Error('COMPOSE_DEFINITION_DIGEST_MISMATCH');
}

async function requireContextWorkspace(expected: string, actual: string): Promise<void> {
  const expectedResolved = await realpath(expected);
  const actualResolved = await realpath(actual);
  if (expectedResolved !== actualResolved) throw new Error('COMPOSE_WORKSPACE_CONTEXT_MISMATCH');
}

function isOwnedPath(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function requireOwnedResource(
  actual: ComposeRuntimeResource,
  expected: ComposeRuntimeResource,
  profile: IntegrationEnvironmentProfile,
): void {
  if (!isOwnedResource(actual, expected)) {
    throw new Error(`COMPOSE_OWNERSHIP_UNPROVEN: ${expected.composeProjectName}`);
  }
  if (new Set(actual.reservedPorts).size !== actual.reservedPorts.length ||
      actual.reservedPorts.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new Error('COMPOSE_PORT_INSPECTION_INVALID');
  }
  if (!portsWithinProfile(actual.reservedPorts, profile)) {
    throw new Error('COMPOSE_PORT_OUTSIDE_PROFILE_RANGE');
  }
}

function portsWithinProfile(
  ports: readonly number[],
  profile: IntegrationEnvironmentProfile,
): boolean {
  if (profile.ports.mode !== 'dynamic') return true;
  const [minimum, maximum] = profile.ports.range;
  return ports.every((port) => port >= minimum && port <= maximum);
}

function isOwnedResource(actual: ComposeRuntimeResource, expected: ComposeRuntimeResource): boolean {
  return actual.driver === 'compose' &&
    actual.ownerRunId === expected.ownerRunId &&
    actual.composeProjectName === expected.composeProjectName &&
    Object.entries(expected.labels).every(([key, value]) => actual.labels[key] === value) &&
    sameStringSet(actual.networkNames, expected.networkNames) &&
    sameStringSet(actual.volumeNames, expected.volumeNames) &&
    new Set(actual.containerNames).size === actual.containerNames.length &&
    actual.containerNames.every((name) => expected.containerNames.includes(name));
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length &&
    left.every((value) => right.includes(value));
}

function isComposeResource(value: unknown): value is ComposeRuntimeResource {
  return isRecord(value) && value.driver === 'compose' && typeof value.ownerRunId === 'string' &&
    typeof value.composeProjectName === 'string' && Array.isArray(value.resourceRefs) &&
    Array.isArray(value.reservedPorts) && isRecord(value.labels) && Array.isArray(value.networkNames) &&
    Array.isArray(value.volumeNames) && Array.isArray(value.containerNames);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function composeRequestEnvironment(
  request: ComposeEffectiveConfigRequest,
): Readonly<Record<string, string>> {
  if (!('environment' in request) || !isRecord(request.environment) ||
      Object.values(request.environment).some((value) => typeof value !== 'string')) {
    return {};
  }
  return request.environment as Readonly<Record<string, string>>;
}

async function hashComposeTree(
  root: string,
  directory: string,
  output: Array<Readonly<Record<string, unknown>>>,
): Promise<void> {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => compare(left.name, right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const key = relative(root, path).split(sep).join('/');
    const stat = await lstat(path);
    const mode = stat.mode & 0o777;
    if (stat.isDirectory()) {
      output.push({ kind: 'directory', path: key, mode });
      await hashComposeTree(root, path, output);
      continue;
    }
    if (stat.isFile()) {
      output.push({ kind: 'file', path: key, mode, digest: sha256(await readFile(path)) });
      continue;
    }
    if (stat.isSymbolicLink()) {
      const target = await readlink(path);
      const resolved = await realpath(path);
      if (!isOwnedPath(root, resolved)) {
        throw new Error(`COMPOSE_BUILD_CONTEXT_SYMLINK_ESCAPE: ${key}`);
      }
      output.push({ kind: 'symlink', path: key, mode, target });
      continue;
    }
    throw new Error(`COMPOSE_BUILD_CONTEXT_ENTRY_UNSUPPORTED: ${key}`);
  }
}

async function resolveExecutablePath(executable: string): Promise<string> {
  const candidates = isAbsolute(executable) || /[\\/]/u.test(executable)
    ? [resolve(executable)]
    : (process.env.PATH ?? '').split(delimiter)
      .filter((entry) => entry.length > 0)
      .map((entry) => join(entry, executable));
  for (const candidate of candidates) {
    try {
      const resolved = await realpath(candidate);
      if ((await lstat(resolved)).isFile()) return resolved;
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error(`COMPOSE_EXECUTOR_NOT_FOUND: ${executable}`);
}

function parseComposeImageIdentities(value: string): Map<string, ContentHash> {
  const trimmed = value.trim();
  if (trimmed.length === 0) return new Map();
  let records: unknown[];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    records = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    records = trimmed.split('\n').filter(Boolean).map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch (error) {
        throw new Error(`COMPOSE_IMAGE_INSPECTION_INVALID: ${errorMessage(error)}`);
      }
    });
  }
  const identities = new Map<string, ContentHash>();
  for (const record of records) {
    if (!isRecord(record)) throw new Error('COMPOSE_IMAGE_INSPECTION_INVALID');
    const service = typeof record.Service === 'string'
      ? record.Service
      : typeof record.service === 'string'
        ? record.service
        : undefined;
    const digest = typeof record.ID === 'string'
      ? record.ID
      : typeof record.Id === 'string'
        ? record.Id
        : typeof record.id === 'string'
          ? record.id
          : undefined;
    if (service === undefined || digest === undefined || !/^sha256:[0-9a-f]{64}$/u.test(digest) ||
        identities.has(service)) {
      throw new Error('COMPOSE_IMAGE_INSPECTION_INVALID');
    }
    identities.set(service, digest as ContentHash);
  }
  return identities;
}

function sanitizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 63);
}

function errorCode(error: unknown, fallback: string): string {
  const message = errorMessage(error);
  const match = /^([A-Z][A-Z0-9_]+)/u.exec(message);
  return match?.[1] ?? fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactedError(error: unknown, secrets: readonly string[]): Error {
  const original = error instanceof Error ? error : new Error(String(error));
  const redacted = new Error(redactSecrets(original.message, secrets), { cause: original.cause });
  redacted.name = original.name;
  return redacted;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
