import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { pathExists, readYaml, writeYaml } from '../../core/files.js';
import { changeArtifactPath } from '../../core/paths.js';
import { resolveChange } from '../../core/store.js';
import { loadTasks, taskFrontier } from '../../core/tasks.js';
import type { Task } from '../../domain/types.js';
import {
  contractCandidateSchema,
  verificationEvidenceSchema,
  type ContractCandidate,
  type VerificationEvidence,
} from '../artifacts.js';
import { LocalExecutionBackend, type ExecutionBackend } from '../backend.js';
import { canonicalJson, hashObject, sha256 } from '../hashing.js';
import { nextExecutionId } from '../ids.js';
import { withMutationLockAtPath, withWorksetMutationLock } from '../mutation-lock.js';
import {
  contractManifestPath,
  contractRoot,
  contractsRoot,
  ensureExecutionLayout,
  evidencePath,
} from '../paths.js';
import {
  contentHashSchema,
  contractSnapshotManifestSchema,
  type ContentHash,
  type ContractSnapshotManifest,
} from '../types.js';
import { resolveWorkset } from '../../workspace/worksets.js';
import {
  contractValidatorCommandBinding,
  contractValidatorScenarioIds,
  discoverContractValidators,
  runContractValidators,
  type ContractValidator,
} from './validators.js';

const CONTRACT_KEY = /^[a-z0-9][a-z0-9._-]*$/;
const CONTRACT_SOURCE_EXTENSION = /\.(?:json|ya?ml|proto|thrift|avsc)$/i;
const REFERENCED_CONTRACT_PATH = /(?:^|[\s`'"(])([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*\.(?:json|ya?ml|proto|thrift|avsc))(?=$|[\s`'"),:])/gmu;

const contractCreationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  candidateHash: contentHashSchema,
  sourceSetHash: contentHashSchema,
  initialManifest: contractSnapshotManifestSchema,
});

export interface ContractStoreContext {
  readonly home: string;
  readonly worksetId: string;
  readonly backend?: ExecutionBackend;
  readonly now?: () => string;
}

export interface ContractCoordinationParticipant {
  readonly project: string;
  readonly changeId: string;
  readonly revision: string;
  readonly baseline: string;
  readonly taskId: string;
  readonly role: 'PROVIDER' | 'CONSUMER';
}

export interface ContractCoordinationScope {
  readonly key: string;
  readonly scopeHash: ContentHash;
  readonly participants: readonly ContractCoordinationParticipant[];
  readonly projects: readonly string[];
}

export interface ContractSource {
  readonly kind: 'intent' | 'spec' | 'design' | 'contract' | 'schema' | 'test';
  readonly project: string;
  readonly ref: string;
  readonly absolutePath: string;
  readonly contentHash: ContentHash;
}

export interface ContractSnapshot {
  readonly context: ContractStoreContext;
  readonly root: string;
  readonly manifest: ContractSnapshotManifest;
  readonly candidate: ContractCandidate;
  readonly sources: readonly ContractSource[];
}

export interface ContractValidationResult {
  readonly valid: boolean;
  readonly manifest: ContractSnapshotManifest;
  readonly evidence: readonly VerificationEvidence[];
  readonly codes: readonly string[];
}

type ContractCreation = z.infer<typeof contractCreationSchema>;

export async function discoverContractCoordinationScopes(
  context: ContractStoreContext,
): Promise<ContractCoordinationScope[]> {
  const workset = await resolveWorkset(context.home, context.worksetId);
  const byKey = new Map<string, Map<string, ContractCoordinationParticipant>>();

  for (const member of workset.members) {
    if (member.status !== 'ACTIVE' || member.worktree === undefined || member.changeId === undefined) continue;
    const change = await resolveChange(member.worktree, member.changeId);
    const tasks = taskFrontier(await loadTasks(changeArtifactPath(
      member.worktree,
      change.directoryName,
      'tasks.yaml',
    )));
    for (const task of tasks) {
      addTaskRelations(
        byKey,
        member.project,
        change.metadata.id,
        change.metadata.activeRevision,
        change.metadata.baseline,
        task,
        'PROVIDER',
      );
      addTaskRelations(
        byKey,
        member.project,
        change.metadata.id,
        change.metadata.activeRevision,
        change.metadata.baseline,
        task,
        'CONSUMER',
      );
    }
  }

  const scopes: ContractCoordinationScope[] = [];
  for (const [key, indexed] of byKey) {
    const participants = [...indexed.values()].sort((left, right) =>
      compare(participantKey(left), participantKey(right)));
    const providers = participants.filter((participant) => participant.role === 'PROVIDER');
    const consumers = participants.filter((participant) => participant.role === 'CONSUMER');
    if (!providers.some((provider) => consumers.some((consumer) => consumer.project !== provider.project))) continue;
    const projects = [...new Set(participants.map((participant) => participant.project))].sort(compare);
    scopes.push({
      key,
      scopeHash: hashObject({ key, participants }),
      participants,
      projects,
    });
  }
  return scopes.sort((left, right) => compare(left.key, right.key));
}

export async function captureContractSources(
  context: ContractStoreContext,
  scope: ContractCoordinationScope,
): Promise<ContractSource[]> {
  assertCoordinationScope(scope);
  const workset = await resolveWorkset(context.home, context.worksetId);
  const projectScopes = new Map<string, ContractCoordinationParticipant[]>();
  for (const participant of scope.participants) {
    const current = projectScopes.get(participant.project) ?? [];
    current.push(participant);
    projectScopes.set(participant.project, current);
  }

  const sources = new Map<string, ContractSource>();
  for (const [project, participants] of [...projectScopes].sort(([left], [right]) => compare(left, right))) {
    const member = workset.members.find((candidate) => candidate.project === project);
    if (member?.status !== 'ACTIVE' || member.worktree === undefined || member.changeId === undefined) {
      throw new Error(`CONTRACT_PARTICIPANT_NOT_ACTIVE: ${project}`);
    }
    const change = await resolveChange(member.worktree, member.changeId);
    if (participants.some((participant) => participant.changeId !== change.metadata.id ||
      participant.revision !== change.metadata.activeRevision ||
      participant.baseline !== change.metadata.baseline)) {
      throw new Error(`CONTRACT_PARTICIPANT_STALE: ${project}`);
    }
    const root = await realpath(member.worktree);
    const candidates = new Map<string, ContractSource['kind']>();
    for (const [name, kind] of [
      ['intent.md', 'intent'],
      ['spec.md', 'spec'],
      ['design.md', 'design'],
      ['contract.md', 'contract'],
    ] as const) {
      const path = changeArtifactPath(member.worktree, change.directoryName, name);
      if (await pathExists(path)) candidates.set(path, kind);
    }

    const tasks = await loadTasks(changeArtifactPath(member.worktree, change.directoryName, 'tasks.yaml'));
    const participantTaskIds = new Set(participants.map((participant) => participant.taskId));
    for (const task of tasks.tasks.filter((candidate) => participantTaskIds.has(candidate.id))) {
      for (const path of task.files.tests) {
        if (await explicitCandidateExists(member.worktree, path)) {
          addExplicitCandidate(candidates, member.worktree, path, 'test');
        }
      }
      for (const path of task.files.create) {
        if (isContractSourcePath(path) && await explicitCandidateExists(member.worktree, path)) {
          addExplicitCandidate(candidates, member.worktree, path, sourceKind(path));
        }
      }
      for (const path of task.files.modify) {
        if (isContractSourcePath(path)) {
          addExplicitCandidate(candidates, member.worktree, path, sourceKind(path));
        }
      }
    }

    for (const artifactPath of [...candidates.keys()]) {
      if (!artifactPath.endsWith('.md')) continue;
      const text = await readFile(artifactPath, 'utf8');
      for (const path of referencedContractPaths(text)) {
        addExplicitCandidate(candidates, member.worktree, path, sourceKind(path));
      }
    }

    for (const [path, kind] of candidates) {
      if (!(await pathExists(path))) throw new Error(`CONTRACT_SOURCE_MISSING: ${project}:${relative(member.worktree, path)}`);
      const resolvedPath = await realpath(path);
      assertContained(root, resolvedPath, project);
      if (!(await stat(resolvedPath)).isFile()) {
        throw new Error(`CONTRACT_SOURCE_NOT_FILE: ${project}:${relative(member.worktree, path)}`);
      }
      const logicalPath = ['intent', 'spec', 'design', 'contract'].includes(kind)
        ? relative(resolve(changeArtifactPath(member.worktree, change.directoryName, '')), path)
        : relative(member.worktree, path);
      const normalized = normalizeRelativePath(logicalPath, 'CONTRACT_SOURCE_REF_INVALID');
      const ref = `${project}/${change.metadata.id}/${change.metadata.activeRevision}/${normalized}`;
      const bytes = await readFile(resolvedPath);
      const source: ContractSource = {
        kind,
        project,
        ref,
        absolutePath: resolve(path),
        contentHash: sha256(bytes),
      };
      const existing = sources.get(ref);
      if (existing !== undefined && (existing.contentHash !== source.contentHash || existing.kind !== source.kind)) {
        throw new Error(`CONTRACT_SOURCE_REF_COLLISION: ${ref}`);
      }
      sources.set(ref, source);
    }
  }
  return [...sources.values()].sort((left, right) => compare(sourceKey(left), sourceKey(right)));
}

export async function createContractSnapshot(
  context: ContractStoreContext,
  scope: ContractCoordinationScope,
  candidateInput: ContractCandidate,
  sourceInput: readonly ContractSource[],
): Promise<ContractSnapshotManifest> {
  const candidate = contractCandidateSchema.parse(candidateInput);
  await ensureExecutionLayout(context.home, context.worksetId);
  const creationLock = join(contractsRoot(context.home, context.worksetId), `.create-${candidate.runId}.lock`);

  return withMutationLockAtPath(creationLock, async () => {
    const sources = await validateCreationInputs(context, scope, candidate, sourceInput);
    const candidateHash = hashObject(candidate);
    const persistedSources = sources.map(({ absolutePath: _absolutePath, ...source }) => source);
    const sourceSetHash = hashObject(persistedSources);
    const contentHash = hashObject({
      contractKey: scope.key,
      scopeHash: scope.scopeHash,
      contract: candidate.contract,
      scenarios: candidate.businessScenarios,
      fixtures: candidate.fixtures,
      traceability: candidate.traceability,
    });
    let creation = await findCreationByRun(context, candidate.runId);
    if (creation === null) {
      creation = await withWorksetMutationLock(context.home, context.worksetId, async () => {
        const repeated = await findCreationByRun(context, candidate.runId);
        if (repeated !== null) return repeated;
        const lockedSources = await validateCreationInputs(context, scope, candidate, sourceInput);
        const lockedPersistedSources = lockedSources.map(({ absolutePath: _absolutePath, ...source }) => source);
        if (canonicalJson(lockedPersistedSources) !== canonicalJson(persistedSources)) {
          throw new Error(`CONTRACT_CREATION_INPUT_STALE:${scope.key}`);
        }
        const id = await nextExecutionId(context.home, context.worksetId, 'contract');
        const previousSnapshot = await currentSnapshotIdForKey(context, scope.key);
        const createdAt = (context.now ?? (() => new Date().toISOString()))();
        const initialManifest = contractSnapshotManifestSchema.parse({
          schemaVersion: 1,
          machineVersion: 1,
          lastEventSequence: 0,
          lastEventHash: null,
          id,
          worksetId: context.worksetId,
          status: 'GENERATING',
          contractKey: scope.key,
          scopeHash: scope.scopeHash,
          contentHash,
          previousSnapshot,
          participants: scope.participants,
          sources: persistedSources,
          businessScenarios: candidate.businessScenarios.map((scenario) => scenario.id),
          validationEvidence: [],
          createdByRun: candidate.runId,
          createdAt,
          updatedAt: createdAt,
        });
        const record = contractCreationSchema.parse({
          schemaVersion: 1,
          candidateHash,
          sourceSetHash,
          initialManifest,
        });
        await persistContractCreation(context, record, candidate);
        return record;
      });
    }
    const finalSources = await validateCreationInputs(context, scope, candidate, sourceInput);
    const finalPersistedSources = finalSources.map(({ absolutePath: _absolutePath, ...source }) => source);
    if (canonicalJson(finalPersistedSources) !== canonicalJson(persistedSources)) {
      throw new Error(`CONTRACT_CREATION_INPUT_STALE:${scope.key}`);
    }
    assertCreationRetry(creation, candidateHash, sourceSetHash, contentHash, scope);
    await persistContractCreation(context, creation, candidate);
    const backend = context.backend ?? new LocalExecutionBackend();
    const request = contractReplayRequest(context, creation.initialManifest);
    const current = await backend.loadAndRepair(request);
    return current.status === 'GENERATING'
      ? backend.transition({ ...request, event: { type: 'VALIDATE' } })
      : current;
  }, { timeoutMs: 5_000 });
}

export async function loadContractSnapshot(
  context: ContractStoreContext,
  id: string,
): Promise<ContractSnapshot> {
  const record = await loadContractRecord(context, id);
  const sources = await resolvePersistedSources(context, record.manifest);
  return { ...record, context, sources };
}

async function loadContractRecord(
  context: ContractStoreContext,
  id: string,
): Promise<Pick<ContractSnapshot, 'root' | 'manifest' | 'candidate'>> {
  if (!/^CTR-\d{4}$/.test(id)) throw new Error(`CONTRACT_ID_INVALID: ${id}`);
  const creation = await readYaml(contractCreationPath(context, id), contractCreationSchema);
  const candidate = await readYaml(contractCandidatePath(context, id), contractCandidateSchema);
  if (creation.initialManifest.id !== id || creation.initialManifest.worksetId !== context.worksetId) {
    throw new Error(`CONTRACT_SNAPSHOT_IDENTITY_MISMATCH: ${id}`);
  }
  if (creation.candidateHash !== hashObject(candidate)) {
    throw new Error(`CONTRACT_SNAPSHOT_IMMUTABLE: ${id}:candidate`);
  }
  const persistedSources = creation.initialManifest.sources;
  if (creation.sourceSetHash !== hashObject(persistedSources)) {
    throw new Error(`CONTRACT_SNAPSHOT_IMMUTABLE: ${id}:sources`);
  }
  const expectedContentHash = hashObject({
    contractKey: candidate.contractKey,
    scopeHash: candidate.scopeHash,
    contract: candidate.contract,
    scenarios: candidate.businessScenarios,
    fixtures: candidate.fixtures,
    traceability: candidate.traceability,
  });
  if (creation.initialManifest.contentHash !== expectedContentHash) {
    throw new Error(`CONTRACT_SNAPSHOT_IMMUTABLE: ${id}:content`);
  }
  const contractDocument = await readYaml(contractDocumentPath(context, id), z.unknown());
  const scenarioDocument = await readYaml(contractScenariosPath(context, id), z.unknown());
  if (canonicalJson(contractDocument) !== canonicalJson(candidate.contract) ||
      canonicalJson(scenarioDocument) !== canonicalJson({ schemaVersion: 1, scenarios: candidate.businessScenarios })) {
    throw new Error(`CONTRACT_SNAPSHOT_IMMUTABLE: ${id}:documents`);
  }

  const backend = context.backend ?? new LocalExecutionBackend();
  const manifest = await backend.loadAndRepair(contractReplayRequest(context, creation.initialManifest));
  assertMaterializedIdentity(creation.initialManifest, manifest);
  return {
    root: contractRoot(context.home, context.worksetId, id),
    manifest,
    candidate,
  };
}

export async function validateContractSnapshot(
  context: ContractStoreContext,
  id: string,
): Promise<ContractValidationResult> {
  const snapshot = await loadContractSnapshot(context, id);
  if (snapshot.manifest.status === 'READY') {
    const ready = await loadReadyContractSnapshot(context, id);
    return {
      valid: true,
      manifest: ready.manifest,
      evidence: await loadSnapshotEvidence(ready),
      codes: [],
    };
  }
  if (snapshot.manifest.status === 'INVALID') {
    const evidence = await loadSnapshotEvidence(snapshot);
    return {
      valid: false,
      manifest: snapshot.manifest,
      evidence,
      codes: validationCodesFromEvidence(evidence),
    };
  }
  if (snapshot.manifest.status !== 'VALIDATING') {
    throw new Error(`CONTRACT_NOT_VALIDATING: ${id}:${snapshot.manifest.status}`);
  }

  const semanticCodes = await inspectContractSnapshot(snapshot);
  const discovered = await discoverSnapshotValidators(snapshot);
  const parserCodes = [
    ...semanticCodes,
    ...inspectValidatorRequests(snapshot, discovered),
  ].sort(compare);
  const parser: ContractValidator = {
    id: `core:contract-parser:${snapshot.manifest.id}`,
    kind: 'PARSER',
    project: 'core',
    required: true,
    ...(parserCodes.length === 0 ? {} : { diagnostic: parserCodes.join(',') }),
  };
  const validators = [parser, ...discovered].sort((left, right) => compare(left.id, right.id));
  const evidence = await runContractValidators(snapshot, validators);
  const byVerifier = new Map(evidence.map((item) => [item.verifier.id, item]));
  const validatorCodes = validators
    .filter((validator) => validator.required && byVerifier.get(validator.id)?.status !== 'PASS')
    .map((validator) => `CONTRACT_VALIDATOR_FAILED:${validator.id}`);
  const codes = [...new Set([...parserCodes, ...validatorCodes])].sort(compare);
  const manifest = codes.length === 0
    ? await markContractReady(context, id, evidence)
    : await markContractInvalid(context, id, evidence);
  return { valid: codes.length === 0, manifest, evidence, codes };
}

export async function markContractReady(
  context: ContractStoreContext,
  id: string,
  evidence: readonly VerificationEvidence[],
): Promise<ContractSnapshotManifest> {
  const snapshot = await loadContractSnapshot(context, id);
  if (snapshot.manifest.status !== 'VALIDATING') {
    throw new Error(`CONTRACT_NOT_VALIDATING: ${id}:${snapshot.manifest.status}`);
  }
  await assertEvidenceForSnapshot(snapshot, evidence);
  await assertReadyRequirements(snapshot, evidence);
  return transitionContract(context, id, {
    type: 'ACCEPT',
    payload: { validationEvidence: evidence.map((item) => item.id).sort(compare) },
  });
}

export async function loadReadyContractSnapshot(
  context: ContractStoreContext,
  id?: string,
): Promise<ContractSnapshot> {
  const selectedId = id ?? await selectOnlyReadySnapshot(context);
  const snapshot = await loadContractSnapshot(context, selectedId);
  if (snapshot.manifest.status !== 'READY') {
    throw new Error(`CONTRACT_NOT_READY: ${selectedId}:${snapshot.manifest.status}`);
  }
  const evidence = await loadSnapshotEvidence(snapshot);
  await assertEvidenceForSnapshot(snapshot, evidence);
  await assertReadyRequirements(snapshot, evidence);
  return snapshot;
}

export async function loadReadyContractSnapshotsForTask(
  context: ContractStoreContext,
  project: string,
  taskId: string,
): Promise<ContractSnapshot[]> {
  const scopes = (await discoverContractCoordinationScopes(context))
    .filter((scope) => scope.participants.some((participant) =>
      participant.project === project && participant.taskId === taskId))
    .sort((left, right) => compare(left.key, right.key));
  if (scopes.length === 0) return [];

  const relevantKeys = new Set(scopes.map((scope) => scope.key));
  const readyByKey = new Map<string, ContractSnapshot[]>();
  const entries = await readdir(contractsRoot(context.home, context.worksetId), { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^CTR-\d{4}$/.test(entry.name)) continue;
    const creation = await readYaml(contractCreationPath(context, entry.name), contractCreationSchema);
    if (!relevantKeys.has(creation.initialManifest.contractKey)) continue;
    const snapshot = await loadContractSnapshot(context, entry.name);
    if (snapshot.manifest.status !== 'READY') continue;
    const current = readyByKey.get(snapshot.manifest.contractKey) ?? [];
    current.push(snapshot);
    readyByKey.set(snapshot.manifest.contractKey, current);
  }

  const selected: ContractSnapshot[] = [];
  for (const scope of scopes) {
    const current = readyByKey.get(scope.key) ?? [];
    if (current.length === 0) throw new Error(`CONTRACT_NOT_READY: ${scope.key}`);
    if (current.length > 1) throw new Error(`CONTRACT_READY_AMBIGUOUS: ${scope.key}`);
    const snapshot = current[0]!;
    if (snapshot.manifest.scopeHash !== scope.scopeHash) throw new Error(`CONTRACT_SCOPE_STALE: ${scope.key}`);
    selected.push(await loadReadyContractSnapshot(context, snapshot.manifest.id));
  }
  return selected;
}

export async function supersedeContractSnapshot(
  context: ContractStoreContext,
  currentId: string,
  replacementId: string,
): Promise<void> {
  if (currentId === replacementId) throw new Error('CONTRACT_REPLACEMENT_MUST_BE_DISTINCT');
  const current = await loadContractRecord(context, currentId);
  if (current.manifest.status !== 'READY') {
    throw new Error(`CONTRACT_NOT_READY: ${currentId}:${current.manifest.status}`);
  }
  const replacement = await loadReadyContractSnapshot(context, replacementId);
  if (replacement.manifest.contractKey !== current.manifest.contractKey) {
    throw new Error('CONTRACT_REPLACEMENT_KEY_MISMATCH');
  }
  if (replacement.manifest.previousSnapshot !== currentId) {
    throw new Error('CONTRACT_REPLACEMENT_LINEAGE_MISMATCH');
  }
  await transitionContract(context, currentId, { type: 'SUPERSEDE' });
}

function addTaskRelations(
  byKey: Map<string, Map<string, ContractCoordinationParticipant>>,
  project: string,
  changeId: string,
  revision: string,
  baseline: string,
  task: Task,
  role: ContractCoordinationParticipant['role'],
): void {
  const relations = role === 'PROVIDER' ? task.produces : task.consumes;
  for (const relation of relations) {
    const key = parseContractKey(relation);
    if (key === null) continue;
    const participant: ContractCoordinationParticipant = {
      project,
      changeId,
      revision,
      baseline,
      taskId: task.id,
      role,
    };
    const participants = byKey.get(key) ?? new Map<string, ContractCoordinationParticipant>();
    participants.set(participantKey(participant), participant);
    byKey.set(key, participants);
  }
}

function assertCoordinationScope(scope: ContractCoordinationScope): void {
  if (!CONTRACT_KEY.test(scope.key)) throw new Error(`CONTRACT_KEY_INVALID: ${scope.key}`);
  const participants = [...scope.participants].sort((left, right) =>
    compare(participantKey(left), participantKey(right)));
  if (participants.length < 2 || canonicalJson(participants) !== canonicalJson(scope.participants) ||
      new Set(participants.map(participantKey)).size !== participants.length) {
    throw new Error('CONTRACT_SCOPE_PARTICIPANTS_INVALID');
  }
  const providers = participants.filter((participant) => participant.role === 'PROVIDER');
  const consumers = participants.filter((participant) => participant.role === 'CONSUMER');
  if (!providers.some((provider) => consumers.some((consumer) => provider.project !== consumer.project))) {
    throw new Error('CONTRACT_SCOPE_CROSS_PROJECT_RELATION_REQUIRED');
  }
  const projects = [...new Set(participants.map((participant) => participant.project))].sort(compare);
  if (canonicalJson(projects) !== canonicalJson(scope.projects)) {
    throw new Error('CONTRACT_SCOPE_PROJECTS_MISMATCH');
  }
  if (scope.scopeHash !== hashObject({ key: scope.key, participants })) {
    throw new Error('CONTRACT_SCOPE_HASH_MISMATCH');
  }
}

async function validateCreationInputs(
  context: ContractStoreContext,
  scope: ContractCoordinationScope,
  candidate: ContractCandidate,
  sourceInput: readonly ContractSource[],
): Promise<ContractSource[]> {
  if (candidate.contractKey !== scope.key || candidate.scopeHash !== scope.scopeHash) {
    throw new Error('CONTRACT_CANDIDATE_SCOPE_MISMATCH');
  }
  const expectedParticipants = groupCandidateParticipants(scope.participants);
  if (canonicalJson(candidate.participants) !== canonicalJson(expectedParticipants)) {
    throw new Error('CONTRACT_CANDIDATE_PARTICIPANTS_MISMATCH');
  }
  const sources = [...sourceInput].sort((left, right) => compare(sourceKey(left), sourceKey(right)));
  const captured = await captureContractSources(context, scope);
  const inventory = (items: readonly ContractSource[]) => items.map((source) => ({
    ...source,
    absolutePath: resolve(source.absolutePath),
  }));
  if (canonicalJson(inventory(sources)) !== canonicalJson(inventory(captured))) {
    throw new Error('CONTRACT_SOURCE_INVENTORY_MISMATCH');
  }
  if (new Set(sources.map((source) => source.ref)).size !== sources.length) {
    throw new Error('CONTRACT_SOURCE_REF_DUPLICATE');
  }
  for (const source of sources) {
    if (source.project.length === 0 || !scope.projects.includes(source.project)) {
      throw new Error(`CONTRACT_SOURCE_PROJECT_MISMATCH: ${source.project}`);
    }
    const bytes = await readFile(source.absolutePath);
    if (sha256(bytes) !== source.contentHash) throw new Error(`CONTRACT_SOURCE_STALE: ${source.ref}`);
  }
  const sourceHashes = sources.map((source) => ({ ref: source.ref, contentHash: source.contentHash }));
  if (canonicalJson(candidate.sourceHashes) !== canonicalJson(sourceHashes)) {
    throw new Error('CONTRACT_CANDIDATE_SOURCE_HASH_MISMATCH');
  }
  if (context.worksetId.length === 0) throw new Error('CONTRACT_WORKSET_REQUIRED');
  return sources;
}

function groupCandidateParticipants(
  participants: readonly ContractCoordinationParticipant[],
): ContractCandidate['participants'] {
  const groups = new Map<string, { project: string; role: 'PROVIDER' | 'CONSUMER'; taskRefs: string[] }>();
  for (const participant of participants) {
    const key = `${participant.project}\0${participant.role}`;
    const current = groups.get(key) ?? { project: participant.project, role: participant.role, taskRefs: [] };
    if (!current.taskRefs.includes(participant.taskId)) current.taskRefs.push(participant.taskId);
    current.taskRefs.sort(compare);
    groups.set(key, current);
  }
  return [...groups.values()].sort((left, right) => compare(
    `${left.project}\0${left.role}`,
    `${right.project}\0${right.role}`,
  ));
}

async function findCreationByRun(
  context: ContractStoreContext,
  runId: string,
): Promise<ContractCreation | null> {
  const root = contractsRoot(context.home, context.worksetId);
  if (!(await pathExists(root))) return null;
  const entries = await readdir(root, { withFileTypes: true });
  const matches: ContractCreation[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^CTR-\d{4}$/.test(entry.name)) continue;
    const path = contractCreationPath(context, entry.name);
    if (!(await pathExists(path))) continue;
    const creation = await readYaml(path, contractCreationSchema);
    if (creation.initialManifest.createdByRun === runId) matches.push(creation);
  }
  if (matches.length > 1) throw new Error(`CONTRACT_CREATION_DUPLICATE: ${runId}`);
  return matches[0] ?? null;
}

async function currentSnapshotIdForKey(
  context: ContractStoreContext,
  contractKey: string,
): Promise<string | null> {
  const root = contractsRoot(context.home, context.worksetId);
  if (!(await pathExists(root))) return null;
  const entries = await readdir(root, { withFileTypes: true });
  const current: ContractSnapshotManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^CTR-\d{4}$/.test(entry.name)) continue;
    const path = contractManifestPath(context.home, context.worksetId, entry.name);
    if (!(await pathExists(path))) continue;
    const manifest = await readYaml(path, contractSnapshotManifestSchema);
    if (manifest.contractKey === contractKey && manifest.status === 'READY') current.push(manifest);
  }
  if (current.length > 1) throw new Error(`CONTRACT_READY_AMBIGUOUS: ${contractKey}`);
  return current[0]?.id ?? null;
}

async function persistContractCreation(
  context: ContractStoreContext,
  creation: ContractCreation,
  candidate: ContractCandidate,
): Promise<void> {
  const id = creation.initialManifest.id;
  await persistImmutableYaml(contractCreationPath(context, id), creation);
  await persistImmutableYaml(contractCandidatePath(context, id), candidate);
  await persistImmutableYaml(contractDocumentPath(context, id), candidate.contract);
  await persistImmutableYaml(contractScenariosPath(context, id), {
    schemaVersion: 1,
    scenarios: candidate.businessScenarios,
  });
  if (!(await pathExists(contractManifestPath(context.home, context.worksetId, id)))) {
    await writeYaml(contractManifestPath(context.home, context.worksetId, id), creation.initialManifest);
  }
}

async function persistImmutableYaml(path: string, value: unknown): Promise<void> {
  if (await pathExists(path)) {
    const existing = await readYaml(path, z.unknown());
    if (canonicalJson(existing) !== canonicalJson(value)) {
      throw new Error(`CONTRACT_SNAPSHOT_IMMUTABLE: ${path}`);
    }
    return;
  }
  await writeYaml(path, value);
}

function assertCreationRetry(
  creation: ContractCreation,
  candidateHash: ContentHash,
  sourceSetHash: ContentHash,
  contentHash: ContentHash,
  scope: ContractCoordinationScope,
): void {
  const manifest = creation.initialManifest;
  if (creation.candidateHash !== candidateHash || creation.sourceSetHash !== sourceSetHash ||
      manifest.contentHash !== contentHash || manifest.contractKey !== scope.key ||
      manifest.scopeHash !== scope.scopeHash ||
      canonicalJson(manifest.participants) !== canonicalJson(scope.participants)) {
    throw new Error(`CONTRACT_SNAPSHOT_IMMUTABLE: ${manifest.id}`);
  }
}

function contractReplayRequest(context: ContractStoreContext, initialManifest: ContractSnapshotManifest) {
  return {
    home: context.home,
    worksetId: context.worksetId,
    aggregateType: 'contract' as const,
    aggregateId: initialManifest.id,
    eventsPath: contractEventsPath(context, initialManifest.id),
    statePath: contractManifestPath(context.home, context.worksetId, initialManifest.id),
    initialState: initialManifest,
    now: context.now ?? (() => new Date().toISOString()),
  };
}

async function markContractInvalid(
  context: ContractStoreContext,
  id: string,
  evidence: readonly VerificationEvidence[],
): Promise<ContractSnapshotManifest> {
  const snapshot = await loadContractSnapshot(context, id);
  if (snapshot.manifest.status !== 'VALIDATING') {
    throw new Error(`CONTRACT_NOT_VALIDATING: ${id}:${snapshot.manifest.status}`);
  }
  await assertEvidenceForSnapshot(snapshot, evidence);
  return transitionContract(context, id, {
    type: 'INVALIDATE',
    payload: { validationEvidence: evidence.map((item) => item.id).sort(compare) },
  });
}

async function transitionContract(
  context: ContractStoreContext,
  id: string,
  event: { readonly type: string; readonly payload?: Record<string, unknown> },
): Promise<ContractSnapshotManifest> {
  const creation = await readYaml(contractCreationPath(context, id), contractCreationSchema);
  const backend = context.backend ?? new LocalExecutionBackend();
  return backend.transition({ ...contractReplayRequest(context, creation.initialManifest), event });
}

async function discoverSnapshotValidators(snapshot: ContractSnapshot): Promise<ContractValidator[]> {
  const workset = await resolveWorkset(snapshot.context.home, snapshot.context.worksetId);
  const projects = [...new Set(snapshot.manifest.participants.map((item) => item.project))].sort(compare);
  const validators: ContractValidator[] = [];
  for (const project of projects) {
    const member = workset.members.find((item) => item.project === project);
    if (member?.status !== 'ACTIVE' || member.worktree === undefined) {
      throw new Error(`CONTRACT_PARTICIPANT_NOT_ACTIVE: ${project}`);
    }
    validators.push(...await discoverContractValidators(member.worktree, project));
  }
  const ids = validators.map((item) => item.id);
  if (new Set(ids).size !== ids.length) throw new Error('CONTRACT_VALIDATOR_ID_DUPLICATE');
  return validators.sort((left, right) => compare(left.id, right.id));
}

async function assertReadyRequirements(
  snapshot: ContractSnapshot,
  evidence: readonly VerificationEvidence[],
): Promise<void> {
  const discovered = await discoverSnapshotValidators(snapshot);
  const codes = [
    ...await inspectContractSnapshot(snapshot),
    ...inspectValidatorRequests(snapshot, discovered),
  ];
  if (codes.length > 0) {
    throw new Error(`CONTRACT_SEMANTIC_VALIDATION_FAILED: ${[...new Set(codes)].sort(compare).join(',')}`);
  }
  const required: ContractValidator[] = [{
    id: `core:contract-parser:${snapshot.manifest.id}`,
    kind: 'PARSER',
    project: 'core',
    required: true,
  }, ...discovered.filter((validator) => validator.required)];
  const byVerifier = new Map<string, VerificationEvidence>();
  for (const item of evidence) {
    if (byVerifier.has(item.verifier.id)) {
      throw new Error(`CONTRACT_VALIDATOR_EVIDENCE_AMBIGUOUS: ${item.verifier.id}`);
    }
    byVerifier.set(item.verifier.id, item);
  }
  for (const validator of required) {
    const item = byVerifier.get(validator.id);
    if (item === undefined) {
      throw new Error(`CONTRACT_REQUIRED_VALIDATOR_EVIDENCE_MISSING: ${validator.id}`);
    }
    if (item.status !== 'PASS') throw new Error(`CONTRACT_REQUIRED_VALIDATOR_FAILED: ${validator.id}`);
    if (canonicalJson(item.command) !== canonicalJson(contractValidatorCommandBinding(validator))) {
      throw new Error(`CONTRACT_VALIDATOR_COMMAND_BINDING_MISMATCH: ${validator.id}`);
    }
    if (item.subject.kind !== 'CONTRACT' || canonicalJson(item.subject.scenarioIds) !==
        canonicalJson(contractValidatorScenarioIds(snapshot, validator))) {
      throw new Error(`CONTRACT_VALIDATOR_SCENARIO_BINDING_MISMATCH: ${validator.id}`);
    }
  }
}

function inspectValidatorRequests(
  snapshot: ContractSnapshot,
  validators: readonly ContractValidator[],
): string[] {
  const scenarios = new Set(snapshot.manifest.businessScenarios);
  const codes: string[] = [];
  for (const request of snapshot.candidate.validatorRequests) {
    const validator = validators.find((candidate) => candidate.id === request.id ||
      (request.commandRef !== undefined && candidate.command?.commandRef === request.commandRef));
    if (request.required && validator === undefined) {
      codes.push(`CONTRACT_VALIDATOR_REQUEST_UNRESOLVED:${request.id}`);
    }
    if (validator !== undefined && validator.project !== request.project) {
      codes.push(`CONTRACT_VALIDATOR_REQUEST_PROJECT_MISMATCH:${request.id}`);
    }
    if (!isSortedUnique(request.scenarioIds)) codes.push(`CONTRACT_VALIDATOR_SCENARIOS_UNSTABLE:${request.id}`);
    if (request.scenarioIds.some((id) => !scenarios.has(id))) {
      codes.push(`CONTRACT_VALIDATOR_SCENARIO_UNKNOWN:${request.id}`);
    }
  }
  return [...new Set(codes)].sort(compare);
}

async function inspectContractSnapshot(snapshot: ContractSnapshot): Promise<string[]> {
  const candidate = snapshot.candidate;
  const codes: string[] = [];
  const sourceHashes = new Map(snapshot.manifest.sources.map((source) => [source.ref, source.contentHash]));
  const participantProjects = new Set(snapshot.manifest.participants.map((item) => item.project));
  const elementIds = new Set(candidate.contract.elements.map((item) => item.id));
  const fixtureRefs = new Set(candidate.fixtures.map((item) => item.ref));
  const scenarioIds = candidate.businessScenarios.map((item) => item.id);
  const scenarioIdSet = new Set(scenarioIds);

  if (snapshot.manifest.participants.some((participant) => participant.baseline === undefined)) {
    codes.push('CONTRACT_BASELINE_IDENTITY_MISSING_REQUIRES_RECOORDINATION');
  }
  if (canonicalJson(snapshot.manifest.businessScenarios) !== canonicalJson(scenarioIds)) {
    codes.push('CONTRACT_SCENARIO_INVENTORY_MISMATCH');
  }
  if (scenarioIdSet.size !== scenarioIds.length) codes.push('SCENARIO_ID_DUPLICATE');
  if (!isSortedUnique(scenarioIds)) codes.push('SCENARIO_ID_UNSTABLE');
  const requiredClasses = new Set<ContractCandidate['businessScenarios'][number]['class']>([
    'NORMAL',
    'BOUNDARY',
    'FAILURE',
  ]);
  if (candidate.contract.compatibilityPolicy.mode !== 'BREAKING_ALLOWED') requiredClasses.add('COMPATIBILITY');
  if (/\b(?:retry|redeliver|redelivery|backoff|idempotent delivery)\b/iu.test(canonicalJson({
    elements: candidate.contract.elements,
    rules: candidate.contract.compatibilityPolicy.rules,
  }))) requiredClasses.add('RETRY');
  const actualClasses = new Set(candidate.businessScenarios.map((item) => item.class));
  for (const required of [...requiredClasses].sort(compare)) {
    if (!actualClasses.has(required)) codes.push(`SCENARIO_CLASS_MISSING:${required}`);
  }

  for (const element of candidate.contract.elements) {
    if (!participantProjects.has(element.ownerProject)) {
      codes.push(`CONTRACT_ELEMENT_OWNER_UNKNOWN:${element.id}`);
    }
    if (!isSortedUnique(element.sourceRefs) || element.sourceRefs.some((ref) => !sourceHashes.has(ref))) {
      codes.push(`CONTRACT_ELEMENT_SOURCE_INVALID:${element.id}`);
    }
  }
  for (const fixture of candidate.fixtures) {
    if (!participantProjects.has(fixture.ownerProject)) codes.push(`CONTRACT_FIXTURE_OWNER_UNKNOWN:${fixture.ref}`);
  }
  for (const scenario of candidate.businessScenarios) {
    if (!isSortedUnique(scenario.participantProjects) ||
        scenario.participantProjects.some((project) => !participantProjects.has(project))) {
      codes.push(`SCENARIO_PARTICIPANT_INVALID:${scenario.id}`);
    }
    if (!isSortedUnique(scenario.sourceRefs) || scenario.sourceRefs.some((ref) => !sourceHashes.has(ref))) {
      codes.push(`SCENARIO_SOURCE_INVALID:${scenario.id}`);
    }
    if (!isSortedUnique(scenario.contractElementRefs) ||
        scenario.contractElementRefs.some((ref) => !elementIds.has(ref))) {
      codes.push(`SCENARIO_CONTRACT_ELEMENT_INVALID:${scenario.id}`);
    }
    if (!isSortedUnique(scenario.fixtureRefs) || scenario.fixtureRefs.some((ref) => !fixtureRefs.has(ref))) {
      codes.push(`SCENARIO_FIXTURE_INVALID:${scenario.id}`);
    }
    if (!isSortedUnique(scenario.executorRefs)) codes.push(`SCENARIO_EXECUTOR_INVALID:${scenario.id}`);
  }

  const tracedSources = new Set<string>();
  const tracedScenarios = new Set<string>();
  const tracedElements = new Set<string>();
  for (const trace of candidate.traceability) {
    tracedSources.add(trace.sourceRef);
    const expectedHash = sourceHashes.get(trace.sourceRef);
    if (expectedHash === undefined || expectedHash !== trace.sourceHash) {
      codes.push(`CONTRACT_TRACE_SOURCE_INVALID:${trace.sourceRef}`);
    }
    if (!isSortedUnique(trace.contractElementRefs) || trace.contractElementRefs.some((ref) => !elementIds.has(ref))) {
      codes.push(`CONTRACT_TRACE_ELEMENT_INVALID:${trace.sourceRef}`);
    }
    if (!isSortedUnique(trace.scenarioIds) || trace.scenarioIds.some((id) => !scenarioIdSet.has(id))) {
      codes.push(`CONTRACT_TRACE_SCENARIO_INVALID:${trace.sourceRef}`);
    }
    for (const ref of trace.contractElementRefs) tracedElements.add(ref);
    for (const scenarioId of trace.scenarioIds) tracedScenarios.add(scenarioId);
  }
  for (const sourceRef of [...sourceHashes.keys()].sort(compare)) {
    if (!tracedSources.has(sourceRef)) codes.push(`CONTRACT_SOURCE_TRACEABILITY_MISSING:${sourceRef}`);
  }
  for (const scenarioId of scenarioIds) {
    if (!tracedScenarios.has(scenarioId)) codes.push(`SCENARIO_TRACEABILITY_MISSING:${scenarioId}`);
  }
  for (const elementId of [...elementIds].sort(compare)) {
    if (!tracedElements.has(elementId)) codes.push(`CONTRACT_ELEMENT_TRACEABILITY_MISSING:${elementId}`);
  }
  for (const source of snapshot.sources) codes.push(...await inspectStructuredSource(source));
  return [...new Set(codes)].sort(compare);
}

async function inspectStructuredSource(source: ContractSource): Promise<string[]> {
  if (source.kind !== 'schema' && source.kind !== 'test') return [];
  const extension = extname(source.absolutePath).toLowerCase();
  const text = await readFile(source.absolutePath, 'utf8');
  try {
    let document: unknown;
    if (extension === '.json' || extension === '.avsc') document = JSON.parse(text) as unknown;
    else if (extension === '.yaml' || extension === '.yml') document = YAML.parse(text) as unknown;
    else if (extension === '.proto' || extension === '.thrift') {
      if (text.trim().length === 0) throw new Error('empty schema');
      return [];
    } else return [];
    const name = basename(source.absolutePath).toLowerCase();
    if (name.includes('openapi') && (!isRecord(document) || typeof document.openapi !== 'string')) {
      return [`CONTRACT_OPENAPI_STRUCTURE_INVALID:${source.ref}`];
    }
    if (name.includes('asyncapi') && (!isRecord(document) || typeof document.asyncapi !== 'string')) {
      return [`CONTRACT_ASYNCAPI_STRUCTURE_INVALID:${source.ref}`];
    }
    if (extension === '.avsc' && (!isRecord(document) || typeof document.type !== 'string')) {
      return [`CONTRACT_AVRO_STRUCTURE_INVALID:${source.ref}`];
    }
    if (source.kind === 'schema' && !isRecord(document) && typeof document !== 'boolean') {
      return [`CONTRACT_SCHEMA_STRUCTURE_INVALID:${source.ref}`];
    }
    if (isRecord(document) && document.$schema !== undefined && typeof document.$schema !== 'string') {
      return [`CONTRACT_SCHEMA_STRUCTURE_INVALID:${source.ref}`];
    }
    if (document === undefined) throw new Error('empty document');
    return [];
  } catch {
    return [`CONTRACT_SOURCE_PARSE_FAILED:${source.ref}`];
  }
}

async function assertEvidenceForSnapshot(
  snapshot: ContractSnapshot,
  evidence: readonly VerificationEvidence[],
): Promise<void> {
  if (evidence.length === 0) throw new Error('CONTRACT_VALIDATION_EVIDENCE_REQUIRED');
  const ids = evidence.map((item) => item.id).sort(compare);
  if (new Set(ids).size !== ids.length) throw new Error('CONTRACT_VALIDATION_EVIDENCE_DUPLICATE');
  const expectedSnapshot = { id: snapshot.manifest.id, contentHash: snapshot.manifest.contentHash };
  const root = await realpath(snapshot.root);
  for (const item of evidence) {
    if (item.subject.kind !== 'CONTRACT') throw new Error(`CONTRACT_EVIDENCE_SUBJECT_INVALID: ${item.id}`);
    if (item.runId !== snapshot.candidate.runId || item.packetHash !== snapshot.candidate.packetHash ||
        item.subject.worksetId !== snapshot.context.worksetId ||
        item.subject.contractKey !== snapshot.manifest.contractKey ||
        item.subject.scopeHash !== snapshot.manifest.scopeHash ||
        canonicalJson(item.subject.contractSnapshot) !== canonicalJson(expectedSnapshot) ||
        item.subject.scenarioIds.some((scenarioId) => !snapshot.manifest.businessScenarios.includes(scenarioId))) {
      throw new Error(`CONTRACT_EVIDENCE_BINDING_MISMATCH: ${item.id}`);
    }
    const persisted = await readYaml(
      evidencePath(snapshot.context.home, snapshot.context.worksetId, item.id),
      verificationEvidenceSchema,
    );
    if (canonicalJson(persisted) !== canonicalJson(item)) {
      throw new Error(`CONTRACT_EVIDENCE_IMMUTABLE: ${item.id}`);
    }
    const stderrRef = `evidence/${item.id}.stderr.txt`;
    const stdoutRef = `evidence/${item.id}.stdout.txt`;
    if (canonicalJson(item.artifactHashes.map((artifact) => artifact.ref)) !==
        canonicalJson([stderrRef, stdoutRef])) {
      throw new Error(`CONTRACT_EVIDENCE_ARTIFACT_SET_INVALID: ${item.id}`);
    }
    for (const artifact of item.artifactHashes) {
      const ref = normalizeRelativePath(artifact.ref, 'CONTRACT_EVIDENCE_REF_INVALID');
      if (!ref.startsWith('evidence/')) throw new Error(`CONTRACT_EVIDENCE_REF_INVALID: ${artifact.ref}`);
      const path = resolve(snapshot.root, ref);
      const resolvedPath = await realpath(path);
      assertContained(root, resolvedPath, 'evidence');
      if (sha256(await readFile(resolvedPath)) !== artifact.contentHash) {
        throw new Error(`CONTRACT_EVIDENCE_STALE: ${item.id}:${artifact.ref}`);
      }
    }
    const stderrHash = item.artifactHashes.find((artifact) => artifact.ref === stderrRef)!.contentHash;
    const stdoutHash = item.artifactHashes.find((artifact) => artifact.ref === stdoutRef)!.contentHash;
    if (item.outputHash !== hashObject({ stdout: stdoutHash, stderr: stderrHash, exitCode: item.exitCode })) {
      throw new Error(`CONTRACT_EVIDENCE_OUTPUT_HASH_MISMATCH: ${item.id}`);
    }
  }
}

async function loadSnapshotEvidence(snapshot: ContractSnapshot): Promise<VerificationEvidence[]> {
  const evidence: VerificationEvidence[] = [];
  for (const id of snapshot.manifest.validationEvidence) {
    evidence.push(await readYaml(
      evidencePath(snapshot.context.home, snapshot.context.worksetId, id),
      verificationEvidenceSchema,
    ));
  }
  return evidence;
}

function validationCodesFromEvidence(evidence: readonly VerificationEvidence[]): string[] {
  const codes: string[] = [];
  for (const item of evidence) {
    if (item.subject.kind !== 'CONTRACT' || !('diagnostics' in item)) continue;
    codes.push(...item.diagnostics.flatMap((diagnostic) => diagnostic.split(',')).filter(Boolean));
    if (item.status !== 'PASS') codes.push(`CONTRACT_VALIDATOR_FAILED:${item.verifier.id}`);
  }
  return [...new Set(codes)].sort(compare);
}

async function selectOnlyReadySnapshot(context: ContractStoreContext): Promise<string> {
  const root = contractsRoot(context.home, context.worksetId);
  const entries = await readdir(root, { withFileTypes: true });
  const ready = new Map<string, string[]>();
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^CTR-\d{4}$/.test(entry.name)) continue;
    const snapshot = await loadContractSnapshot(context, entry.name);
    if (snapshot.manifest.status !== 'READY') continue;
    const ids = ready.get(snapshot.manifest.contractKey) ?? [];
    ids.push(snapshot.manifest.id);
    ready.set(snapshot.manifest.contractKey, ids);
  }
  for (const [key, ids] of ready) {
    if (ids.length > 1) throw new Error(`CONTRACT_READY_AMBIGUOUS: ${key}`);
  }
  if (ready.size === 0) throw new Error('CONTRACT_NOT_READY');
  if (ready.size > 1) throw new Error(`CONTRACT_READY_SELECTION_REQUIRED: ${[...ready.keys()].sort(compare).join(',')}`);
  return [...ready.values()][0]![0]!;
}

function isSortedUnique(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) return false;
  }
  return new Set(values).size === values.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertMaterializedIdentity(
  initial: ContractSnapshotManifest,
  current: ContractSnapshotManifest,
): void {
  const immutable = (manifest: ContractSnapshotManifest) => ({
    id: manifest.id,
    worksetId: manifest.worksetId,
    contractKey: manifest.contractKey,
    scopeHash: manifest.scopeHash,
    contentHash: manifest.contentHash,
    previousSnapshot: manifest.previousSnapshot,
    participants: manifest.participants,
    sources: manifest.sources,
    businessScenarios: manifest.businessScenarios,
    createdByRun: manifest.createdByRun,
    createdAt: manifest.createdAt,
  });
  if (canonicalJson(immutable(initial)) !== canonicalJson(immutable(current))) {
    throw new Error(`CONTRACT_SNAPSHOT_IMMUTABLE: ${initial.id}:manifest`);
  }
}

async function resolvePersistedSources(
  context: ContractStoreContext,
  manifest: ContractSnapshotManifest,
): Promise<ContractSource[]> {
  const workset = await resolveWorkset(context.home, context.worksetId);
  const resolved: ContractSource[] = [];
  for (const source of manifest.sources) {
    const prefix = `${source.project}/`;
    if (!source.ref.startsWith(prefix)) throw new Error(`CONTRACT_SOURCE_REF_INVALID: ${source.ref}`);
    const parts = source.ref.slice(prefix.length).split('/');
    const changeId = parts.shift();
    const revision = parts.shift();
    const logicalPath = parts.join('/');
    if (!/^CHG-\d{4}$/.test(changeId ?? '') || !/^REV-\d{4}$/.test(revision ?? '')) {
      throw new Error(`CONTRACT_SOURCE_REF_INVALID: ${source.ref}`);
    }
    const normalized = normalizeRelativePath(logicalPath, 'CONTRACT_SOURCE_REF_INVALID');
    const participant = manifest.participants.find((item) =>
      item.project === source.project && item.changeId === changeId && item.revision === revision);
    if (participant === undefined) throw new Error(`CONTRACT_SOURCE_PARTICIPANT_MISMATCH: ${source.ref}`);
    const member = workset.members.find((item) => item.project === source.project);
    if (member?.status !== 'ACTIVE' || member.worktree === undefined || member.changeId !== changeId) {
      throw new Error(`CONTRACT_SOURCE_STALE: ${source.ref}`);
    }
    const change = await resolveChange(member.worktree, changeId);
    if (change.metadata.activeRevision !== revision ||
        manifest.participants.some((item) => item.project === source.project &&
          item.changeId === changeId && item.revision === revision && item.baseline !== undefined &&
          item.baseline !== change.metadata.baseline)) {
      throw new Error(`CONTRACT_SOURCE_STALE: ${source.ref}`);
    }
    const artifactName = `${source.kind}.md`;
    const path = ['intent', 'spec', 'design', 'contract'].includes(source.kind)
      ? normalized === artifactName
        ? changeArtifactPath(member.worktree, change.directoryName, artifactName)
        : (() => { throw new Error(`CONTRACT_SOURCE_REF_INVALID: ${source.ref}`); })()
      : resolve(member.worktree, normalized);
    try {
      const root = await realpath(member.worktree);
      const resolvedPath = await realpath(path);
      assertContained(root, resolvedPath, source.project);
      if (!(await stat(resolvedPath)).isFile()) throw new Error('not a file');
      const bytes = await readFile(resolvedPath);
      if (sha256(bytes) !== source.contentHash) throw new Error('hash mismatch');
      resolved.push({ ...source, absolutePath: resolve(path) });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('CONTRACT_SOURCE_ESCAPE')) throw error;
      throw new Error(`CONTRACT_SOURCE_STALE: ${source.ref}`, { cause: error });
    }
  }
  return resolved.sort((left, right) => compare(sourceKey(left), sourceKey(right)));
}

function contractCreationPath(context: ContractStoreContext, id: string): string {
  return join(contractRoot(context.home, context.worksetId, id), 'creation.yaml');
}

function contractCandidatePath(context: ContractStoreContext, id: string): string {
  return join(contractRoot(context.home, context.worksetId, id), 'candidate.yaml');
}

function contractDocumentPath(context: ContractStoreContext, id: string): string {
  return join(contractRoot(context.home, context.worksetId, id), 'contract.yaml');
}

function contractScenariosPath(context: ContractStoreContext, id: string): string {
  return join(contractRoot(context.home, context.worksetId, id), 'scenarios.yaml');
}

function contractEventsPath(context: ContractStoreContext, id: string): string {
  return join(contractRoot(context.home, context.worksetId, id), 'events.jsonl');
}

function parseContractKey(value: string): string | null {
  if (!value.startsWith('contract:')) return null;
  const key = value.slice('contract:'.length);
  if (!CONTRACT_KEY.test(key)) throw new Error(`CONTRACT_KEY_INVALID: ${value}`);
  return key;
}

function referencedContractPaths(text: string): string[] {
  const paths = new Set<string>();
  for (const match of text.matchAll(REFERENCED_CONTRACT_PATH)) {
    if (match[1] !== undefined) paths.add(normalizeRelativePath(match[1], 'CONTRACT_SOURCE_REF_INVALID'));
  }
  return [...paths].sort(compare);
}

function addExplicitCandidate(
  candidates: Map<string, ContractSource['kind']>,
  root: string,
  path: string,
  kind: ContractSource['kind'],
): void {
  const relativePath = normalizeRelativePath(path, 'CONTRACT_SOURCE_REF_INVALID');
  candidates.set(resolve(root, relativePath), kind);
}

async function explicitCandidateExists(root: string, path: string): Promise<boolean> {
  const relativePath = normalizeRelativePath(path, 'CONTRACT_SOURCE_REF_INVALID');
  return pathExists(resolve(root, relativePath));
}

function isContractSourcePath(path: string): boolean {
  return CONTRACT_SOURCE_EXTENSION.test(path) || /(?:^|\/)(?:contract|schema|openapi|asyncapi)(?:\/|\.|-)/i.test(path);
}

function sourceKind(path: string): ContractSource['kind'] {
  return /(?:^|\/)(?:test|tests|__tests__)(?:\/|\.)/i.test(path) ? 'test' : 'schema';
}

function normalizeRelativePath(path: string, code: string): string {
  if (isAbsolute(path) || path.includes('\\')) throw new Error(`${code}: ${path}`);
  const normalized = path.split('/').filter((segment) => segment.length > 0).join('/');
  if (normalized.length === 0 || normalized.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`${code}: ${path}`);
  }
  return normalized;
}

function assertContained(root: string, candidate: string, project: string): void {
  const child = relative(root, candidate);
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`CONTRACT_SOURCE_ESCAPE: ${project}:${candidate}`);
  }
}

function participantKey(participant: ContractCoordinationParticipant): string {
  return [
    participant.project,
    participant.changeId,
    participant.revision,
    participant.baseline,
    participant.taskId,
    participant.role,
  ].join('\0');
}

function sourceKey(source: ContractSource): string {
  return [source.project, source.ref, source.kind, source.contentHash].join('\0');
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
