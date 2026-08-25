import { randomUUID } from 'node:crypto';
import { link, lstat, open, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { ensureDir, pathExists } from '../../core/files.js';
import { resolveWorkset } from '../../workspace/worksets.js';
import { worksetWorkspaceRoot } from '../../workspace/paths.js';
import { canonicalJson, sha256 } from '../hashing.js';
import { withWorksetMutationLock } from '../mutation-lock.js';
import {
  ensureExecutionLayout,
  integrationEnvironmentProfilePath,
} from '../paths.js';
import {
  environmentStepDefinitionSchema,
  hashIntegrationEnvironmentProfile,
  integrationEnvironmentProfileContentSchema,
  integrationEnvironmentProfileSchema,
  type ContentHash,
  type EnvironmentStepDefinition,
  type IntegrationEnvironmentProfile,
} from '../types.js';

const projectSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const lifecycleSteps = z.strictObject({
  setup: environmentStepDefinitionSchema,
  build: environmentStepDefinitionSchema,
  start: environmentStepDefinitionSchema,
  health: environmentStepDefinitionSchema,
  seed: environmentStepDefinitionSchema,
  test: environmentStepDefinitionSchema,
  collect: environmentStepDefinitionSchema,
  teardown: environmentStepDefinitionSchema,
});

const structuredCommandManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requiredProjects: z.array(projectSchema).min(1).readonly(),
  steps: lifecycleSteps,
}).superRefine((manifest, context) => {
  requireSortedUnique(manifest.requiredProjects, 'requiredProjects', context);
  for (const [name, step] of Object.entries(manifest.steps)) {
    if (!('executable' in step)) {
      context.addIssue({
        code: 'custom',
        path: ['steps', name],
        message: 'STRUCTURED_COMMAND_REQUIRED',
      });
      continue;
    }
    if (isShellLauncher(step.executable)) {
      context.addIssue({
        code: 'custom',
        path: ['steps', name, 'executable'],
        message: 'SHELL_LAUNCHER_FORBIDDEN',
      });
    }
    const safetyError = discoveredCommandSafetyError(step.executable, step.argv);
    if (safetyError !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['steps', name],
        message: safetyError,
      });
    }
    if (step.argv.some((argument) => argument.includes('\0'))) {
      context.addIssue({
        code: 'custom',
        path: ['steps', name, 'argv'],
        message: 'COMMAND_ARGUMENT_INVALID',
      });
    }
  }
});
type StructuredCommandManifest = z.infer<typeof structuredCommandManifestSchema>;

const packageLifecycleScriptRefsSchema = z.strictObject({
  setup: z.string().regex(/^[a-zA-Z0-9:._-]+$/),
  build: z.string().regex(/^[a-zA-Z0-9:._-]+$/),
  start: z.string().regex(/^[a-zA-Z0-9:._-]+$/),
  health: z.string().regex(/^[a-zA-Z0-9:._-]+$/),
  seed: z.string().regex(/^[a-zA-Z0-9:._-]+$/),
  test: z.string().regex(/^[a-zA-Z0-9:._-]+$/),
  collect: z.string().regex(/^[a-zA-Z0-9:._-]+$/),
  teardown: z.string().regex(/^[a-zA-Z0-9:._-]+$/),
});

const packageIntegrationDeclarationSchema = z.strictObject({
  requiredProjects: z.array(projectSchema).min(1).readonly(),
  scripts: packageLifecycleScriptRefsSchema,
}).superRefine((value, context) => {
  requireSortedUnique(value.requiredProjects, 'requiredProjects', context);
});

export const integrationEnvironmentProfileSourceSchema = z.strictObject({
  schemaVersion: z.literal(2),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  driver: z.enum(['compose', 'commands', 'external']),
  requiredProjects: z.array(projectSchema).min(1).readonly(),
  definitionRef: z.string().min(1),
  definitionContentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  isolation: z.strictObject({
    mode: z.enum(['per-run', 'shared']),
    maxParallel: z.number().int().positive(),
    requireExclusiveLease: z.boolean(),
  }),
  ports: z.strictObject({
    mode: z.enum(['dynamic', 'inherited', 'external']),
    range: z.tuple([
      z.number().int().min(1).max(65_535),
      z.number().int().min(1).max(65_535),
    ]).readonly(),
  }),
  envRefs: z.record(
    z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'SECRET_REFERENCE_NAME'),
  ),
  sandbox: z.strictObject({
    driver: z.enum(['platform', 'container', 'external']),
    requiredProofs: z.array(z.enum([
      'CREDENTIALS',
      'FILESYSTEM',
      'NETWORK',
      'PROCESS_TREE',
      'RESOURCE_LIMITS',
    ])).min(1).readonly(),
  }),
  steps: lifecycleSteps,
}).superRefine((profile, context) => {
  requireSortedUnique(profile.requiredProjects, 'requiredProjects', context);
  requireSortedUnique(profile.sandbox.requiredProofs, 'sandbox.requiredProofs', context);
  if (profile.ports.range[0] > profile.ports.range[1]) {
    context.addIssue({ code: 'custom', path: ['ports', 'range'], message: 'ENVIRONMENT_PORT_RANGE_INVALID' });
  }
});
export type IntegrationEnvironmentProfileSource = z.infer<typeof integrationEnvironmentProfileSourceSchema>;

export interface IntegrationEnvironmentProfileContext {
  readonly home: string;
  readonly worksetId: string;
}

export type DiscoveredProfile =
  | {
      readonly status: 'READY';
      readonly origin: 'EXPLICIT' | 'COMPOSE' | 'COMMANDS';
      readonly source: IntegrationEnvironmentProfileSource;
      readonly sourcePath?: string;
    }
  | {
      readonly status: 'BLOCKED';
      readonly code: 'ENVIRONMENT_PROFILE_CHOICE_REQUIRED';
      readonly candidates: readonly string[];
      readonly reason: string;
    };

export function integrationProfileInputHash(
  profile: Omit<IntegrationEnvironmentProfile, 'contentHash'> | IntegrationEnvironmentProfile,
): ContentHash {
  return hashIntegrationEnvironmentProfile(profile);
}

export async function discoverIntegrationEnvironmentProfiles(
  context: IntegrationEnvironmentProfileContext,
): Promise<DiscoveredProfile[]> {
  const workset = await resolveWorkset(context.home, context.worksetId);
  const workspaceRoot = worksetWorkspaceRoot(context.home, context.worksetId);
  const explicitRoot = join(workspaceRoot, 'integration', 'environments');
  const explicit = await loadExplicitDiscoveries(explicitRoot);
  if (explicit.length > 0) {
    const activeProjects = await activeWorksetProjects(context);
    const mismatched = explicit.filter((candidate) => candidate.status === 'READY' &&
      canonicalJson(candidate.source.requiredProjects) !== canonicalJson(activeProjects));
    if (mismatched.length > 0) {
      return [choiceRequired(
        mismatched.map((candidate) => candidate.status === 'READY' ? candidate.source.id : candidate.code),
        'One or more explicit environment profiles do not exactly cover the active Workset projects.',
      )];
    }
    return explicit;
  }

  const requiredProjects = workset.members
    .filter((member) => member.status === 'ACTIVE')
    .map((member) => member.project)
    .sort(compare);
  if (requiredProjects.length === 0) {
    return [choiceRequired([], 'No active Workset projects can own an integration environment.')];
  }

  const activeRoots = workset.members
    .filter((member) => member.status === 'ACTIVE' && member.worktree !== undefined)
    .map((member) => member.worktree!);
  const [composeCandidates, commandDiscovery] = await Promise.all([
    discoverComposeCandidates(workspaceRoot, activeRoots),
    discoverCommandCandidates(workspaceRoot, activeRoots),
  ]);
  const eligibleCompose = composeCandidates.filter((candidate) =>
    requiredProjects.every((project) => candidate.services.includes(project)));
  const eligibleCommands = commandDiscovery.ready.filter((candidate) =>
    canonicalJson(candidate.manifest.requiredProjects) === canonicalJson(requiredProjects));
  const rejected = [
    ...composeCandidates.filter((candidate) => !eligibleCompose.includes(candidate)).map((candidate) => candidate.ref),
    ...commandDiscovery.ready.filter((candidate) => !eligibleCommands.includes(candidate)).map((candidate) => candidate.ref),
    ...commandDiscovery.unsafe,
  ].sort(compare);
  const eligible = [
    ...eligibleCompose.map((candidate) => ({ driver: 'compose' as const, candidate })),
    ...eligibleCommands.map((candidate) => ({ driver: 'commands' as const, candidate })),
  ];
  const allCandidates = [
    ...composeCandidates.map((candidate) => candidate.ref),
    ...commandDiscovery.ready.map((candidate) => candidate.ref),
    ...commandDiscovery.unsafe,
  ].sort(compare);
  if (eligible.length !== 1 || rejected.length > 0) {
    return [choiceRequired(
      allCandidates,
      rejected.length > 0
        ? 'One or more discovered environment definitions are unsafe or do not cover every active project.'
        : eligible.length === 0
          ? 'No unambiguous Compose or structured command definition covers every active project.'
          : 'Multiple integration environment definitions are plausible for this Workset.',
    )];
  }
  const selected = eligible[0]!;
  const definitionBytes = await readFile(selected.candidate.path);
  const source = integrationEnvironmentProfileSourceSchema.parse({
    schemaVersion: 2,
    id: workset.slug,
    driver: selected.driver,
    requiredProjects,
    definitionRef: selected.candidate.ref,
    definitionContentHash: sha256(definitionBytes),
    isolation: { mode: 'per-run', maxParallel: 1, requireExclusiveLease: false },
    ports: { mode: 'dynamic', range: [1, 65_535] },
    envRefs: {},
    sandbox: {
      driver: selected.driver === 'compose' ? 'container' : 'platform',
      requiredProofs: ['CREDENTIALS', 'FILESYSTEM', 'NETWORK', 'PROCESS_TREE', 'RESOURCE_LIMITS'],
    },
    steps: selected.driver === 'compose'
      ? defaultReferencedSteps()
      : selected.candidate.manifest.steps,
  });
  return [{
    status: 'READY',
    origin: selected.driver === 'compose' ? 'COMPOSE' : 'COMMANDS',
    source,
  }];
}

export async function bootstrapIntegrationEnvironmentProfile(
  context: IntegrationEnvironmentProfileContext,
  discovery: DiscoveredProfile,
): Promise<IntegrationEnvironmentProfile> {
  if (discovery.status !== 'READY') {
    throw new Error(`${discovery.code}: ${discovery.reason}`);
  }
  return withWorksetMutationLock(context.home, context.worksetId, async () => {
    await assertProfileProjectScope(context, discovery.source.id, discovery.source.requiredProjects);
    const sourcePath = integrationEnvironmentSourceProfilePath(context, discovery.source.id);
    if (await pathExists(sourcePath)) {
      const existing = await readSourceProfile(sourcePath);
      if (canonicalJson(existing) !== canonicalJson(discovery.source)) {
        throw new Error(`PROFILE_SOURCE_ALREADY_EXISTS: ${sourcePath}`);
      }
      return resolveSourceProfile(context, existing);
    }
    await writeYamlConvergent(
      sourcePath,
      discovery.source,
      `PROFILE_SOURCE_ALREADY_EXISTS: ${sourcePath}`,
    );
    return resolveSourceProfile(context, discovery.source);
  }, { timeoutMs: 5_000 });
}

export async function loadIntegrationEnvironmentProfiles(
  context: IntegrationEnvironmentProfileContext,
): Promise<IntegrationEnvironmentProfile[]> {
  const root = join(worksetWorkspaceRoot(context.home, context.worksetId), 'integration', 'environments');
  if (!(await pathExists(root))) return [];
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
    .sort((left, right) => compare(left.name, right.name));
  const profiles: IntegrationEnvironmentProfile[] = [];
  for (const entry of entries) {
    const source = await readSourceProfile(join(root, entry.name));
    await assertProfileProjectScope(context, source.id, source.requiredProjects);
    profiles.push(await resolveSourceProfile(context, source));
  }
  return profiles.sort((left, right) => compare(left.id, right.id));
}

export async function resolveIntegrationEnvironmentProfile(
  context: IntegrationEnvironmentProfileContext,
  id: string,
): Promise<IntegrationEnvironmentProfile> {
  const matches = (await loadIntegrationEnvironmentProfiles(context))
    .filter((profile) => profile.id === id);
  if (matches.length === 0) throw new Error(`INTEGRATION_ENVIRONMENT_PROFILE_NOT_FOUND: ${id}`);
  if (matches.length > 1) throw new Error(`INTEGRATION_ENVIRONMENT_PROFILE_AMBIGUOUS: ${id}`);
  const profile = matches[0]!;
  return profile;
}

async function activeWorksetProjects(context: IntegrationEnvironmentProfileContext): Promise<string[]> {
  const workset = await resolveWorkset(context.home, context.worksetId);
  return workset.members
    .filter((member) => member.status === 'ACTIVE')
    .map((member) => member.project)
    .sort(compare);
}

async function assertProfileProjectScope(
  context: IntegrationEnvironmentProfileContext,
  profileId: string,
  requiredProjects: readonly string[],
): Promise<void> {
  const activeProjects = await activeWorksetProjects(context);
  if (canonicalJson(requiredProjects) !== canonicalJson(activeProjects)) {
    throw new Error(
      `INTEGRATION_PROFILE_PROJECT_SCOPE_MISMATCH: ${profileId}: expected=${activeProjects.join(',')}: actual=${requiredProjects.join(',')}`,
    );
  }
}

export function integrationEnvironmentSourceProfilePath(
  context: IntegrationEnvironmentProfileContext,
  id: string,
): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id)) throw new Error(`ENVIRONMENT_PROFILE_ID_INVALID: ${id}`);
  return join(
    worksetWorkspaceRoot(context.home, context.worksetId),
    'integration',
    'environments',
    `${id}.yaml`,
  );
}

async function resolveSourceProfile(
  context: IntegrationEnvironmentProfileContext,
  sourceInput: IntegrationEnvironmentProfileSource,
): Promise<IntegrationEnvironmentProfile> {
  const source = integrationEnvironmentProfileSourceSchema.parse(sourceInput);
  const workspaceRoot = worksetWorkspaceRoot(context.home, context.worksetId);
  if (source.driver === 'commands') {
    const workset = await resolveWorkset(context.home, context.worksetId);
    const projectRoots = workset.members
      .filter((member) => member.status === 'ACTIVE' && member.worktree !== undefined)
      .map((member) => member.worktree!);
    const manifest = structuredCommandManifestSchema.parse({
      schemaVersion: 1,
      requiredProjects: source.requiredProjects,
      steps: source.steps,
    });
    await assertDiscoveredCommandPathsOwned(workspaceRoot, projectRoots, manifest);
  }
  const refs = new Map<string, ContentHash>();
  const definitionPath = await resolveOwnedFile(workspaceRoot, source.definitionRef);
  const actualDefinitionHash = sha256(await readFile(definitionPath));
  if (actualDefinitionHash !== source.definitionContentHash) {
    throw new Error(`ENVIRONMENT_PROFILE_DEFINITION_STALE: ${source.definitionRef}`);
  }
  refs.set(source.definitionRef, actualDefinitionHash);
  for (const definition of Object.values(source.steps)) {
    if (!('requiredArtifacts' in definition)) continue;
    for (const ref of definition.requiredArtifacts) {
      const path = await resolveOwnedFile(workspaceRoot, ref);
      refs.set(ref, sha256(await readFile(path)));
    }
  }
  const content = integrationEnvironmentProfileContentSchema.parse({
    ...source,
    schemaVersion: 2,
    sourceRefs: [...refs.entries()]
      .map(([ref, contentHash]) => ({ ref, contentHash }))
      .sort((left, right) => compare(left.ref, right.ref)),
  });
  const profile = integrationEnvironmentProfileSchema.parse({
    ...content,
    contentHash: integrationProfileInputHash(content),
  });
  await persistExecutionProfile(context, profile);
  return profile;
}

async function persistExecutionProfile(
  context: IntegrationEnvironmentProfileContext,
  profile: IntegrationEnvironmentProfile,
): Promise<void> {
  await ensureExecutionLayout(context.home, context.worksetId);
  const path = integrationEnvironmentProfilePath(
    context.home,
    context.worksetId,
    profile.id,
    profile.contentHash,
  );
  await writeYamlConvergent(
    path,
    profile,
    `INTEGRATION_ENVIRONMENT_PROFILE_SNAPSHOT_CORRUPT: ${path}`,
  );
}

async function loadExplicitDiscoveries(root: string): Promise<DiscoveredProfile[]> {
  if (!(await pathExists(root))) return [];
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
    .sort((left, right) => compare(left.name, right.name));
  return Promise.all(entries.map(async (entry) => ({
    status: 'READY' as const,
    origin: 'EXPLICIT' as const,
    source: await readSourceProfile(join(root, entry.name)),
    sourcePath: join(root, entry.name),
  })));
}

async function readSourceProfile(path: string): Promise<IntegrationEnvironmentProfileSource> {
  let value: unknown;
  try {
    value = YAML.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`ENVIRONMENT_PROFILE_SOURCE_INVALID: ${path}`, { cause: error });
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value) &&
      'schemaVersion' in value && value.schemaVersion === 1) {
    throw new Error(`ENVIRONMENT_PROFILE_SOURCE_LEGACY_REQUIRES_RERESOLUTION: ${path}`);
  }
  try {
    return integrationEnvironmentProfileSourceSchema.parse(value);
  } catch (error) {
    throw new Error(`ENVIRONMENT_PROFILE_SOURCE_INVALID: ${path}`, { cause: error });
  }
}

interface ComposeCandidate {
  readonly ref: string;
  readonly path: string;
  readonly services: readonly string[];
}

interface CommandCandidate {
  readonly ref: string;
  readonly path: string;
  readonly manifest: StructuredCommandManifest;
}

interface CommandDiscovery {
  readonly ready: readonly CommandCandidate[];
  readonly unsafe: readonly string[];
}

async function discoverComposeCandidates(
  workspaceRoot: string,
  projectRoots: readonly string[],
): Promise<ComposeCandidate[]> {
  const relativeCandidates = [
    'integration/compose.yaml',
    'integration/compose.yml',
    'compose.yaml',
    'compose.yml',
    'docker-compose.yaml',
    'docker-compose.yml',
  ];
  const paths = new Set<string>();
  for (const ref of relativeCandidates) {
    const path = join(workspaceRoot, ref);
    if (await pathExists(path)) paths.add(path);
  }
  for (const projectRoot of [...projectRoots].sort(compare)) {
    for (const ref of relativeCandidates) {
      const path = join(projectRoot, ref);
      if (await pathExists(path)) paths.add(path);
    }
  }
  const candidates: ComposeCandidate[] = [];
  for (const path of [...paths].sort(compare)) {
    const owned = await resolveOwnedFile(workspaceRoot, relative(workspaceRoot, path));
    const document = YAML.parse(await readFile(owned, 'utf8')) as unknown;
    const services = composeServiceNames(document);
    candidates.push({
      ref: relative(workspaceRoot, owned).split(sep).join('/'),
      path: owned,
      services,
    });
  }
  return candidates;
}

async function discoverCommandCandidates(
  workspaceRoot: string,
  projectRoots: readonly string[],
): Promise<CommandDiscovery> {
  const paths = new Set<string>();
  const packagePaths = new Map<string, string>();
  for (const ref of [
    'integration/environment.commands.yaml',
    'integration/environment.commands.yml',
  ]) {
    const path = join(workspaceRoot, ref);
    if (await pathExists(path)) paths.add(path);
  }
  for (const projectRoot of [...projectRoots].sort(compare)) {
    for (const ref of [
      '.omnai/integration-environment.yaml',
      '.omnai/integration-environment.yml',
    ]) {
      const path = join(projectRoot, ref);
      if (await pathExists(path)) paths.add(path);
    }
    const packagePath = join(projectRoot, 'package.json');
    if (await pathExists(packagePath)) {
      packagePaths.set(packagePath, `project:${relative(workspaceRoot, projectRoot).split(sep).join('/')}`);
    }
  }
  const worksetPackagePath = join(workspaceRoot, 'package.json');
  if (await pathExists(worksetPackagePath)) packagePaths.set(worksetPackagePath, 'workspace:.');
  const ready: CommandCandidate[] = [];
  const unsafe: string[] = [];
  for (const path of [...paths].sort(compare)) {
    const ref = relative(workspaceRoot, path).split(sep).join('/');
    try {
      const owned = await resolveOwnedFile(workspaceRoot, ref);
      const manifest = structuredCommandManifestSchema.parse(
        YAML.parse(await readFile(owned, 'utf8')) as unknown,
      );
      await assertDiscoveredCommandPathsOwned(workspaceRoot, projectRoots, manifest);
      ready.push({ ref, path: owned, manifest });
    } catch {
      unsafe.push(ref);
    }
  }
  for (const [path, cwd] of [...packagePaths.entries()].sort(([left], [right]) => compare(left, right))) {
    const ref = relative(workspaceRoot, path).split(sep).join('/');
    try {
      const owned = await resolveOwnedFile(workspaceRoot, ref);
      const manifest = packageIntegrationCommandManifest(
        JSON.parse(await readFile(owned, 'utf8')) as unknown,
        cwd,
      );
      if (manifest !== undefined) {
        await assertDiscoveredCommandPathsOwned(workspaceRoot, projectRoots, manifest);
        ready.push({ ref, path: owned, manifest });
      }
    } catch {
      unsafe.push(ref);
    }
  }
  return {
    ready: ready.sort((left, right) => compare(left.ref, right.ref)),
    unsafe: unsafe.sort(compare),
  };
}

function packageIntegrationCommandManifest(
  value: unknown,
  cwd: string,
): StructuredCommandManifest | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const root = value as Record<string, unknown>;
  if (root.omnai === undefined) return undefined;
  if (root.omnai === null || typeof root.omnai !== 'object' || Array.isArray(root.omnai)) {
    throw new Error('PACKAGE_INTEGRATION_DECLARATION_INVALID');
  }
  if (!('integrationEnvironment' in root.omnai)) return undefined;
  const declaration = packageIntegrationDeclarationSchema.parse(
    (root.omnai as Record<string, unknown>).integrationEnvironment,
  );
  if (root.scripts === null || typeof root.scripts !== 'object' || Array.isArray(root.scripts)) {
    throw new Error('PACKAGE_INTEGRATION_SCRIPTS_INVALID');
  }
  const scripts = root.scripts as Record<string, unknown>;
  const steps = Object.fromEntries(Object.entries(declaration.scripts).map(([name, script]) => {
    const body = scripts[script];
    if (typeof body !== 'string' || body.length === 0) {
      throw new Error(`PACKAGE_INTEGRATION_SCRIPT_MISSING: ${script}`);
    }
    const command = parsePackageLifecycleScript(body);
    return [name, {
      executable: command.executable,
      argv: command.argv,
      cwd,
      timeoutMs: 120_000,
      outputLimit: 1_048_576,
      network: 'DENY' as const,
      requiredArtifacts: [],
    }];
  }));
  return structuredCommandManifestSchema.parse({
    schemaVersion: 1,
    requiredProjects: declaration.requiredProjects,
    steps,
  });
}

function composeServiceNames(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      !('services' in value) || value.services === null || typeof value.services !== 'object' ||
      Array.isArray(value.services)) return [];
  return Object.keys(value.services).sort(compare);
}

function isShellLauncher(executable: string): boolean {
  const name = executable.split(/[\\/]/u).at(-1)?.toLowerCase().replace(/\.exe$/u, '') ?? '';
  return new Set([
    'bash', 'cmd', 'command', 'csh', 'dash', 'elvish', 'fish', 'ksh',
    'nu', 'powershell', 'pwsh', 'sh', 'tcsh', 'zsh',
  ]).has(name);
}

function discoveredCommandSafetyError(
  executable: string,
  argv: readonly string[],
): string | undefined {
  if (executable.includes('/') || executable.includes('\\') || executable.includes('..')) {
    return 'DISCOVERED_COMMAND_EXECUTABLE_PATH_FORBIDDEN';
  }
  const name = executable.toLowerCase().replace(/\.exe$/u, '');
  if (new Set(['bun', 'npm', 'pnpm', 'yarn']).has(name)) {
    return 'DISCOVERED_COMMAND_NESTED_PACKAGE_SCRIPT_FORBIDDEN';
  }
  const allowed = new Set([
    'cargo', 'deno', 'dotnet', 'go', 'gradle', 'gradlew', 'mvn', 'mvnw',
    'node', 'pytest', 'python', 'python3',
  ]);
  if (!allowed.has(name)) return 'DISCOVERED_COMMAND_EXECUTABLE_NOT_ALLOWLISTED';
  if (argv.some((argument) => commandArgumentPathValues(argument).some((value) =>
    isAbsolute(value) || /^[a-z]:[\\/]/iu.test(value) || value.split(/[\\/]/u).includes('..')))) {
    return 'DISCOVERED_COMMAND_ARGUMENT_TRAVERSAL_FORBIDDEN';
  }
  if (name === 'node') {
    if (argv.some((argument) => new Set(['-e', '--eval', '-p', '--print']).has(argument)) ||
        argv[0] === undefined || argv[0].startsWith('-') || !/\.(?:cjs|js|mjs)$/u.test(argv[0])) {
      return 'DISCOVERED_COMMAND_INLINE_CODE_FORBIDDEN';
    }
  }
  if ((name === 'python' || name === 'python3') && (
    argv.includes('-c') ||
    !(argv[0]?.endsWith('.py') === true ||
      (argv[0] === '-m' && argv[1] === 'pytest'))
  )) {
    return 'DISCOVERED_COMMAND_INLINE_CODE_FORBIDDEN';
  }
  if (name === 'deno' && (argv[0] !== 'test' || argv.includes('eval'))) {
    return 'DISCOVERED_COMMAND_OPERATION_NOT_ALLOWLISTED';
  }
  if (new Set(['cargo', 'dotnet', 'go']).has(name) && argv[0] !== 'test') {
    return 'DISCOVERED_COMMAND_OPERATION_NOT_ALLOWLISTED';
  }
  return undefined;
}

function parsePackageLifecycleScript(script: string): { executable: string; argv: string[] } {
  const trimmed = script.trim();
  if (trimmed.length === 0 || /[;&|<>`$\n\r\\"']/u.test(trimmed)) {
    throw new Error('PACKAGE_INTEGRATION_SCRIPT_AMBIGUOUS');
  }
  const tokens = trimmed.split(/\s+/u);
  const executable = tokens.shift()!;
  if (isShellLauncher(executable)) throw new Error('SHELL_LAUNCHER_FORBIDDEN');
  const safetyError = discoveredCommandSafetyError(executable, tokens);
  if (safetyError !== undefined) throw new Error(safetyError);
  return { executable, argv: tokens };
}

async function assertDiscoveredCommandPathsOwned(
  workspaceRoot: string,
  projectRoots: readonly string[],
  manifest: StructuredCommandManifest,
): Promise<void> {
  const allowedRoots = await Promise.all([workspaceRoot, ...projectRoots].map((root) => realpath(root)));
  for (const step of Object.values(manifest.steps)) {
    if (!('executable' in step)) continue;
    const base = step.cwd === 'workspace:.'
      ? allowedRoots[0]!
      : step.cwd.startsWith('project:')
        ? resolve(workspaceRoot, step.cwd.slice('project:'.length))
        : undefined;
    if (base === undefined || !(await pathExists(base))) continue;
    const resolvedBase = await realpath(base);
    if (!allowedRoots.some((root) => isOwnedPath(root, resolvedBase))) {
      throw new Error(`DISCOVERED_COMMAND_CWD_OUTSIDE_OWNED_ROOTS:${step.cwd}`);
    }
    for (const argument of step.argv) {
      for (const value of commandArgumentPathValues(argument)) {
        const candidate = resolve(resolvedBase, value);
        const resolvedArgument = await realpath(await nearestExistingAncestor(candidate));
        if (!allowedRoots.some((root) => isOwnedPath(root, resolvedArgument))) {
          throw new Error(`DISCOVERED_COMMAND_ARGUMENT_OUTSIDE_OWNED_ROOTS:${argument}`);
        }
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

function isOwnedPath(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function defaultReferencedSteps(): Record<string, EnvironmentStepDefinition> {
  return Object.fromEntries([
    'setup', 'build', 'start', 'health', 'seed', 'test', 'collect', 'teardown',
  ].map((name) => [name, { commandRef: `environment.${name}`, timeoutMs: 120_000 }]));
}

function choiceRequired(candidates: readonly string[], reason: string): DiscoveredProfile {
  return {
    status: 'BLOCKED',
    code: 'ENVIRONMENT_PROFILE_CHOICE_REQUIRED',
    candidates: [...candidates].sort(compare),
    reason,
  };
}

async function resolveOwnedFile(root: string, ref: string): Promise<string> {
  if (isAbsolute(ref) || ref.length === 0) throw new Error(`ENVIRONMENT_PROFILE_PATH_INVALID: ${ref}`);
  const normalizedRoot = await realpath(root);
  const candidate = resolve(normalizedRoot, ref);
  const child = relative(normalizedRoot, candidate);
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`ENVIRONMENT_PROFILE_PATH_ESCAPE: ${ref}`);
  }
  let resolved;
  try {
    resolved = await realpath(candidate);
  } catch (error) {
    throw new Error(`ENVIRONMENT_PROFILE_SOURCE_MISSING: ${ref}`, { cause: error });
  }
  const resolvedChild = relative(normalizedRoot, resolved);
  if (resolvedChild === '..' || resolvedChild.startsWith(`..${sep}`) || isAbsolute(resolvedChild)) {
    throw new Error(`ENVIRONMENT_PROFILE_PATH_ESCAPE: ${ref}`);
  }
  return resolved;
}

async function writeYamlConvergent(
  path: string,
  value: unknown,
  conflictMessage: string,
): Promise<void> {
  await ensureDir(dirname(path));
  const stagePath = `${path}.stage-${randomUUID()}`;
  const handle = await open(stagePath, 'wx', 0o600);
  try {
    await handle.writeFile(YAML.stringify(value, { lineWidth: 100 }), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(stagePath, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    let existing: unknown;
    try {
      existing = YAML.parse(await readFile(path, 'utf8')) as unknown;
    } catch (readError) {
      throw new Error(conflictMessage, { cause: readError });
    }
    if (canonicalJson(existing) !== canonicalJson(value)) throw new Error(conflictMessage);
  } finally {
    await unlink(stagePath).catch(() => undefined);
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch {
    // Some platforms do not support fsync on directory handles; the file is already linked atomically.
  } finally {
    await handle?.close();
  }
}

function requireSortedUnique(
  values: readonly string[],
  field: string,
  context: z.RefinementCtx,
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) {
      context.addIssue({ code: 'custom', path: [field], message: `SORTED_UNIQUE: ${field}` });
      return;
    }
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
