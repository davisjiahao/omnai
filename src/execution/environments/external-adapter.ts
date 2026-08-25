import { link, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { ensureDir, pathExists, readYaml } from '../../core/files.js';
import { resolveSecretEnvironment, redactSecrets } from '../agents/policy.js';
import { canonicalJson, hashObject } from '../hashing.js';
import { withMutationLockAtPath } from '../mutation-lock.js';
import {
  contentHashSchema,
  integrationEnvironmentInputSchema,
  type IntegrationEnvironmentInput,
  type IntegrationEnvironmentProfile,
} from '../types.js';
import {
  claimEnvironmentAllocation,
  releaseEnvironmentAllocation,
  validateEnvironmentAdapterContext,
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

export interface ExternalAdapterCapabilities {
  readonly exclusiveLease: boolean;
  readonly exactAttestation: boolean;
}

export interface ExternalLease {
  readonly leaseId: string;
  readonly namespace: string;
  readonly ownerRunId: string;
  readonly exclusive: boolean;
}

export type ExternalAttestation = IntegrationEnvironmentInput;

export interface ExternalReserveRequest {
  readonly idempotencyKey: string;
  readonly namespace: string;
  readonly expected: ExternalAttestation;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface ExternalAttestRequest {
  readonly idempotencyKey: string;
  readonly lease: ExternalLease;
  readonly expected: ExternalAttestation;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface ExternalArtifactPublication {
  readonly inputHash: IntegrationEnvironmentInput['inputHash'];
  readonly artifacts: IntegrationEnvironmentInput['externalDeploymentDigests'];
}

export interface ExternalPublishRequest extends ExternalAttestRequest {
  readonly publication: ExternalArtifactPublication;
}

export interface ExternalRunStepRequest extends ExternalAttestRequest {
  readonly step: EnvironmentStep;
}

export interface ExternalInspectRequest {
  readonly idempotencyKey: string;
  readonly leaseId: string;
  readonly namespace: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface ExternalLookupRequest {
  readonly idempotencyKey: string;
  readonly namespace: string;
  readonly expected: ExternalAttestation;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface ExternalClientInspection {
  readonly ownership: 'PROVEN' | 'UNPROVEN' | 'ABSENT';
  readonly lease?: ExternalLease;
  readonly attestation?: ExternalAttestation;
}

export interface ExternalReleaseRequest {
  readonly idempotencyKey: string;
  readonly lease: ExternalLease;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface ExternalEnvironmentClient {
  reserve(request: ExternalReserveRequest, signal?: AbortSignal): Promise<ExternalLease>;
  lookup(request: ExternalLookupRequest, signal?: AbortSignal): Promise<ExternalClientInspection>;
  publish(
    request: ExternalPublishRequest,
    signal?: AbortSignal,
  ): Promise<ExternalArtifactPublication>;
  attest(request: ExternalAttestRequest, signal?: AbortSignal): Promise<ExternalAttestation>;
  runStep(
    request: ExternalRunStepRequest,
    signal?: AbortSignal,
  ): Promise<{ readonly exitCode: number; readonly output: string; readonly truncated: boolean }>;
  inspect(request: ExternalInspectRequest, signal?: AbortSignal): Promise<ExternalClientInspection>;
  release(request: ExternalReleaseRequest, signal?: AbortSignal): Promise<void>;
}

export interface ExternalEnvironmentAdapterOptions {
  readonly client: ExternalEnvironmentClient;
  readonly capabilities: ExternalAdapterCapabilities;
}

interface ExternalPreparedData {
  readonly namespace: string;
  readonly expected: ExternalAttestation;
}

const externalLeaseSchema = z.strictObject({
  leaseId: z.string().min(1),
  namespace: z.string().min(1),
  ownerRunId: z.string().regex(/^IER-\d{4}$/),
  exclusive: z.boolean(),
});

const externalAttestationSchema = integrationEnvironmentInputSchema;

const externalLeaseRecordBase = {
  schemaVersion: z.literal(3),
  environmentRunId: z.string().regex(/^IER-\d{4}$/),
  profileContentHash: contentHashSchema,
  inputHash: contentHashSchema,
  contentHash: contentHashSchema,
} as const;

const reservingExternalLeaseRecordSchema = z.strictObject({
  ...externalLeaseRecordBase,
  status: z.literal('RESERVING'),
  namespace: z.string().min(1),
});

const reservedExternalLeaseRecordSchema = z.strictObject({
  ...externalLeaseRecordBase,
  status: z.literal('RESERVED'),
  lease: externalLeaseSchema,
});

const attestedExternalLeaseRecordSchema = z.strictObject({
  ...externalLeaseRecordBase,
  status: z.literal('ATTESTED'),
  lease: externalLeaseSchema,
  attestation: externalAttestationSchema,
});

const releasedExternalLeaseRecordSchema = z.strictObject({
  ...externalLeaseRecordBase,
  status: z.literal('RELEASED'),
  namespace: z.string().min(1),
});

const externalLeaseRecordSchema = z.discriminatedUnion('status', [
  reservingExternalLeaseRecordSchema,
  reservedExternalLeaseRecordSchema,
  attestedExternalLeaseRecordSchema,
  releasedExternalLeaseRecordSchema,
]);
type ExternalLeaseRecord = z.infer<typeof externalLeaseRecordSchema>;
type LeasedExternalLeaseRecord = Extract<
  ExternalLeaseRecord,
  { readonly status: 'RESERVED' | 'ATTESTED' }
>;

export function createExternalEnvironmentAdapter(
  options: ExternalEnvironmentAdapterOptions,
): IntegrationEnvironmentAdapter {
  return new ExternalEnvironmentAdapter(options);
}

export function createProductionExternalEnvironmentAdapter(
  options?: ExternalEnvironmentAdapterOptions,
): IntegrationEnvironmentAdapter {
  return createExternalEnvironmentAdapter(options ?? {
    client: unavailableExternalClient,
    capabilities: { exclusiveLease: false, exactAttestation: false },
  });
}

const unavailableExternalClient: ExternalEnvironmentClient = {
  async reserve() { throw new Error('EXTERNAL_CLIENT_UNAVAILABLE'); },
  async lookup() { return { ownership: 'ABSENT' }; },
  async publish() { throw new Error('EXTERNAL_CLIENT_UNAVAILABLE'); },
  async attest() { throw new Error('EXTERNAL_CLIENT_UNAVAILABLE'); },
  async runStep() { throw new Error('EXTERNAL_CLIENT_UNAVAILABLE'); },
  async inspect() { return { ownership: 'ABSENT' }; },
  async release() { throw new Error('EXTERNAL_CLIENT_UNAVAILABLE'); },
};

export function externalLeaseRecordPath(runRoot: string): string {
  return join(runRoot, 'external-lease.yaml');
}

class ExternalEnvironmentAdapter implements IntegrationEnvironmentAdapter {
  readonly driver = 'external' as const;

  constructor(private readonly options: ExternalEnvironmentAdapterOptions) {}

  async probe(profile: IntegrationEnvironmentProfile): Promise<EnvironmentProbe> {
    if (profile.driver !== this.driver) return wrongDriverProbe(profile.driver);
    if (!profile.isolation.requireExclusiveLease || !this.options.capabilities.exclusiveLease) {
      return diagnosticProbe('EXTERNAL_EXCLUSIVE_LEASE_REQUIRED');
    }
    if (!this.options.capabilities.exactAttestation) {
      return diagnosticProbe('EXTERNAL_ATTESTATION_REQUIRED');
    }
    return {
      driver: this.driver,
      authoritative: true,
      mode: 'AUTHORITATIVE',
      code: 'EXTERNAL_CAPABILITIES_PROVEN',
      reasons: [],
    };
  }

  async prepare(context: EnvironmentAdapterContext): Promise<PreparedEnvironment> {
    try {
      validateEnvironmentAdapterContext(context, this.driver);
    } catch (error) {
      const code = errorMessage(error).split(':', 1)[0]!;
      const probe = diagnosticProbe(code);
      return {
        status: 'BLOCKED',
        driver: this.driver,
        context,
        probe,
        code,
        reason: errorMessage(error),
      };
    }
    const probe = await this.probe(context.profile);
    const diagnosticAllowed = context.requestedMode === 'DIAGNOSTIC_ONLY' &&
      context.profile.isolation.maxParallel === 1;
    if (!probe.authoritative && !diagnosticAllowed) {
      return {
        status: 'BLOCKED',
        driver: this.driver,
        context,
        probe,
        code: probe.code,
        reason: probe.reasons[0]!,
      };
    }
    return {
      status: 'READY',
      driver: this.driver,
      context,
      probe,
      preparedData: {
        namespace: externalNamespace(context),
        expected: expectedAttestation(context),
      } satisfies ExternalPreparedData,
    };
  }

  async runStep(
    prepared: ReadyPreparedEnvironment,
    step: EnvironmentStep,
    signal?: AbortSignal,
  ): Promise<EnvironmentStepResult> {
    validateEnvironmentAdapterContext(prepared.context, this.driver);
    const data = externalPreparedData(prepared);
    const deadline = createExternalPhaseDeadline(prepared.context, step.name, signal);
    if (step.name === 'setup') return this.setup(prepared.context, data, deadline);
    if (step.name === 'teardown') {
      const release = await this.releaseWithDeadline(prepared.context, deadline);
      if (release.status === 'BLOCKED') throw new Error(release.code);
      return success(step.name);
    }
    const record = await loadLeaseRecord(prepared.context);
    if (record === undefined) throw new Error('EXTERNAL_LEASE_NOT_ESTABLISHED');
    const diagnostic = prepared.context.requestedMode === 'DIAGNOSTIC_ONLY';
    if (record.status !== 'ATTESTED' && !(diagnostic && record.status === 'RESERVED')) {
      throw new Error('EXTERNAL_LEASE_ATTESTATION_INCOMPLETE');
    }
    const inspection = await this.inspectWithDeadline(prepared.context, deadline);
    if ((!diagnostic && inspection.ownership !== 'PROVEN') ||
        (diagnostic && inspection.ownership === 'ABSENT')) {
      throw new Error('EXTERNAL_LEASE_OWNERSHIP_UNPROVEN');
    }
    const environment = resolveSecretEnvironment(
      prepared.context.profile,
      prepared.context.sourceEnvironment(),
    );
    const secrets = Object.values(environment);
    try {
      const result = await runExternalOperation(deadline, (operationSignal, timeoutMs) =>
        this.options.client.runStep({
          idempotencyKey: prepared.context.environmentRunId,
          lease: record.lease,
          expected: record.status === 'ATTESTED'
            ? record.attestation
            : expectedAttestation(prepared.context),
          environment,
          timeoutMs,
          step,
        }, operationSignal));
      const output = redactSecrets(result.output, secrets);
      if (result.exitCode !== 0) {
        throw new Error(`EXTERNAL_STEP_FAILED: ${step.name}: exit ${result.exitCode}: ${output}`);
      }
      return success(step.name, { ...result, resource: resourceIdentity(record) });
    } catch (error) {
      throw redactedError(error, secrets);
    }
  }

  async inspect(context: EnvironmentAdapterContext): Promise<EnvironmentInspection> {
    validateEnvironmentAdapterContext(context, this.driver);
    return this.inspectWithDeadline(context, createExternalPhaseDeadline(context, 'setup'));
  }

  private async inspectWithDeadline(
    context: EnvironmentAdapterContext,
    deadline: ExternalPhaseDeadline,
  ): Promise<EnvironmentInspection> {
    const record = await loadLeaseRecord(context);
    if (record === undefined) {
      return { driver: this.driver, ownership: 'ABSENT', code: 'EXTERNAL_LEASE_ABSENT' };
    }
    if (record.status === 'RELEASED') {
      return { driver: this.driver, ownership: 'ABSENT', code: 'EXTERNAL_LEASE_RELEASED' };
    }
    const environment = resolveSecretEnvironment(context.profile, context.sourceEnvironment());
    const secrets = Object.values(environment);
    let inspected: ExternalClientInspection;
    try {
      inspected = record.status === 'RESERVING'
        ? await runExternalOperation(deadline, (operationSignal, timeoutMs) =>
            this.options.client.lookup({
              idempotencyKey: context.environmentRunId,
              namespace: record.namespace,
              expected: expectedAttestation(context),
              environment,
              timeoutMs,
            }, operationSignal))
        : await runExternalOperation(deadline, (operationSignal, timeoutMs) =>
            this.options.client.inspect({
              idempotencyKey: context.environmentRunId,
              leaseId: record.lease.leaseId,
              namespace: record.lease.namespace,
              environment,
              timeoutMs,
            }, operationSignal));
    } catch (error) {
      throw redactedError(error, secrets);
    }
    if (inspected.ownership === 'ABSENT') {
      return { driver: this.driver, ownership: 'ABSENT', code: 'EXTERNAL_LEASE_ABSENT' };
    }
    if (record.status === 'RESERVING') {
      if (inspected.ownership !== 'PROVEN' || inspected.lease === undefined) {
        return { driver: this.driver, ownership: 'UNPROVEN', code: 'EXTERNAL_LEASE_OWNERSHIP_UNPROVEN' };
      }
      try {
        requireLease(inspected.lease, context.environmentRunId, record.namespace);
        if (inspected.attestation !== undefined) {
          requireAttestation(inspected.attestation, expectedAttestation(context));
        }
      } catch {
        return { driver: this.driver, ownership: 'UNPROVEN', code: 'EXTERNAL_LEASE_OWNERSHIP_UNPROVEN' };
      }
      const recovered = inspected.attestation === undefined
        ? reservedLeaseRecord(context, inspected.lease)
        : attestedLeaseRecord(context, inspected.lease, inspected.attestation);
      return {
        driver: this.driver,
        ownership: 'PROVEN',
        resource: resourceIdentity(recovered),
        code: 'EXTERNAL_LEASE_OWNERSHIP_PROVEN',
      };
    }
    const attestationMatches = record.status === 'RESERVED'
      ? inspected.attestation === undefined ||
        canonicalJson(inspected.attestation) === canonicalJson(expectedAttestation(context))
      : inspected.attestation !== undefined &&
        canonicalJson(inspected.attestation) === canonicalJson(record.attestation);
    if (inspected.ownership !== 'PROVEN' || inspected.lease === undefined ||
        !sameLease(inspected.lease, record.lease) || !attestationMatches) {
      return {
        driver: this.driver,
        ownership: 'UNPROVEN',
        code: 'EXTERNAL_LEASE_OWNERSHIP_UNPROVEN',
      };
    }
    return {
      driver: this.driver,
      ownership: 'PROVEN',
      resource: resourceIdentity(record),
      code: 'EXTERNAL_LEASE_OWNERSHIP_PROVEN',
    };
  }

  async release(
    context: EnvironmentAdapterContext,
    signal?: AbortSignal,
  ): Promise<EnvironmentReleaseResult> {
    validateEnvironmentAdapterContext(context, this.driver);
    return this.releaseWithDeadline(
      context,
      createExternalPhaseDeadline(context, 'teardown', signal),
    );
  }

  private async releaseWithDeadline(
    context: EnvironmentAdapterContext,
    deadline: ExternalPhaseDeadline,
  ): Promise<EnvironmentReleaseResult> {
    const record = await loadLeaseRecord(context);
    if (record === undefined) {
      await releaseEnvironmentAllocation(context);
      return { driver: this.driver, status: 'ALREADY_ABSENT', code: 'EXTERNAL_LEASE_ALREADY_ABSENT' };
    }
    if (record.status === 'RELEASED') {
      await releaseEnvironmentAllocation(context);
      return { driver: this.driver, status: 'ALREADY_ABSENT', code: 'EXTERNAL_LEASE_ALREADY_RELEASED' };
    }
    if (context.requestedMode === 'DIAGNOSTIC_ONLY') {
      const namespace = record.status === 'RESERVING' ? record.namespace : record.lease.namespace;
      await transitionLeaseRecord(context, record, releasedLeaseRecord(context, namespace));
      await releaseEnvironmentAllocation(context);
      return { driver: this.driver, status: 'RELEASED', code: 'EXTERNAL_DIAGNOSTIC_SERIALIZATION_RELEASED' };
    }
    if (record.status === 'RESERVING') {
      const environment = resolveSecretEnvironment(context.profile, context.sourceEnvironment());
      const secrets = Object.values(environment);
      let found: ExternalClientInspection;
      try {
        found = await runExternalOperation(deadline, (operationSignal, timeoutMs) =>
          this.options.client.lookup({
            idempotencyKey: context.environmentRunId,
            namespace: record.namespace,
            expected: expectedAttestation(context),
            environment,
            timeoutMs,
          }, operationSignal));
      } catch (error) {
        throw redactedError(error, secrets);
      }
      if (found.ownership === 'ABSENT') {
        return {
          driver: this.driver,
          status: 'BLOCKED',
          code: 'EXTERNAL_RESERVING_OPERATION_NOT_TERMINAL',
        };
      }
      if (found.ownership !== 'PROVEN' || found.lease === undefined) {
        return { driver: this.driver, status: 'BLOCKED', code: 'EXTERNAL_RELEASE_OWNERSHIP_UNPROVEN' };
      }
      requireLease(found.lease, context.environmentRunId, record.namespace);
      const recovered = found.attestation === undefined
        ? reservedLeaseRecord(context, found.lease)
        : attestedLeaseRecord(context, found.lease, found.attestation);
      if (found.attestation !== undefined) requireAttestation(found.attestation, expectedAttestation(context));
      await transitionLeaseRecord(context, record, recovered);
      return this.releaseWithDeadline(context, deadline);
    }
    const inspection = await this.inspectWithDeadline(context, deadline);
    if (inspection.ownership === 'ABSENT') {
      await transitionLeaseRecord(
        context,
        record,
        releasedLeaseRecord(context, record.lease.namespace),
      );
      await releaseEnvironmentAllocation(context);
      return { driver: this.driver, status: 'ALREADY_ABSENT', code: 'EXTERNAL_LEASE_ALREADY_ABSENT' };
    }
    if (inspection.ownership !== 'PROVEN') {
      return { driver: this.driver, status: 'BLOCKED', code: 'EXTERNAL_RELEASE_OWNERSHIP_UNPROVEN' };
    }
    const environment = resolveSecretEnvironment(context.profile, context.sourceEnvironment());
    const secrets = Object.values(environment);
    try {
      await runExternalOperation(deadline, (operationSignal, timeoutMs) =>
        this.options.client.release({
          idempotencyKey: context.environmentRunId,
          lease: record.lease,
          environment,
          timeoutMs,
        }, operationSignal));
    } catch (error) {
      throw redactedError(error, secrets);
    }
    await transitionLeaseRecord(
      context,
      record,
      releasedLeaseRecord(context, record.lease.namespace),
    );
    await releaseEnvironmentAllocation(context);
    return { driver: this.driver, status: 'RELEASED', code: 'EXTERNAL_LEASE_RELEASED' };
  }

  private async setup(
    context: EnvironmentAdapterContext,
    data: ExternalPreparedData,
    deadline: ExternalPhaseDeadline,
  ): Promise<EnvironmentStepResult> {
    await claimEnvironmentAllocation(context);
    let existing = await loadLeaseRecord(context);
    if (existing === undefined) {
      existing = reservingLeaseRecord(context, data.namespace);
      await persistLeaseRecord(context, existing);
    } else if (existing.status === 'RELEASED') {
      const next = reservingLeaseRecord(context, data.namespace);
      await transitionLeaseRecord(context, existing, next);
      existing = next;
    }
    if (existing.status === 'RESERVING') {
      return this.reserveFromIntent(context, data, existing, deadline);
    }
    const inspection = await this.inspectWithDeadline(context, deadline);
    if (inspection.ownership === 'ABSENT') {
      const released = releasedLeaseRecord(context, existing.lease.namespace);
      await transitionLeaseRecord(context, existing, released);
      await releaseEnvironmentAllocation(context);
      return this.setup(context, data, deadline);
    }
    if (inspection.ownership !== 'PROVEN') throw new Error('EXTERNAL_EXISTING_LEASE_UNPROVEN');
    if (existing.status === 'ATTESTED') {
      return success('setup', { resource: resourceIdentity(existing) });
    }
    return this.attestReserved(context, data, existing, deadline);
  }

  private async reserveFromIntent(
    context: EnvironmentAdapterContext,
    data: ExternalPreparedData,
    intent: Extract<ExternalLeaseRecord, { readonly status: 'RESERVING' }>,
    deadline: ExternalPhaseDeadline,
  ): Promise<EnvironmentStepResult> {
    const environment = resolveSecretEnvironment(context.profile, context.sourceEnvironment());
    const secrets = Object.values(environment);
    try {
      const found = await runExternalOperation(deadline, (operationSignal, timeoutMs) =>
        this.options.client.lookup({
          idempotencyKey: context.environmentRunId,
          namespace: intent.namespace,
          expected: data.expected,
          environment,
          timeoutMs,
        }, operationSignal));
      let lease: ExternalLease;
      if (found.ownership === 'UNPROVEN') {
        if (context.requestedMode !== 'DIAGNOSTIC_ONLY' || found.lease === undefined) {
          throw new Error('EXTERNAL_RESERVING_LEASE_UNPROVEN');
        }
        lease = found.lease;
      } else if (found.ownership === 'PROVEN') {
        if (found.lease === undefined) throw new Error('EXTERNAL_RESERVING_LEASE_UNPROVEN');
        lease = found.lease;
      } else {
        lease = await runExternalOperation(deadline, (operationSignal, timeoutMs) =>
          this.options.client.reserve({
            idempotencyKey: context.environmentRunId,
            namespace: data.namespace,
            expected: data.expected,
            environment,
            timeoutMs,
          }, operationSignal));
      }
      requireLease(
        lease,
        context.environmentRunId,
        data.namespace,
        context.requestedMode === 'AUTHORITATIVE',
      );
      if (found.ownership === 'PROVEN' && found.attestation !== undefined) {
        requireAttestation(found.attestation, data.expected);
        const attested = attestedLeaseRecord(context, lease, found.attestation);
        await transitionLeaseRecord(context, intent, attested);
        return success('setup', { resource: resourceIdentity(attested) });
      }
      const reserved = reservedLeaseRecord(context, lease);
      await transitionLeaseRecord(context, intent, reserved);
      if (context.requestedMode === 'DIAGNOSTIC_ONLY') {
        return success('setup', { resource: resourceIdentity(reserved) });
      }
      return this.attestReserved(context, data, reserved, deadline, environment);
    } catch (error) {
      throw redactedError(error, secrets);
    }
  }

  private async attestReserved(
    context: EnvironmentAdapterContext,
    data: ExternalPreparedData,
    reserved: Extract<ExternalLeaseRecord, { readonly status: 'RESERVED' }>,
    deadline: ExternalPhaseDeadline,
    providedEnvironment?: Readonly<Record<string, string>>,
  ): Promise<EnvironmentStepResult> {
    const environment = providedEnvironment ?? resolveSecretEnvironment(
      context.profile,
      context.sourceEnvironment(),
    );
    const secrets = Object.values(environment);
    try {
      const publication = expectedPublication(data.expected);
      const published = await runExternalOperation(deadline, (operationSignal, timeoutMs) =>
        this.options.client.publish({
          idempotencyKey: context.environmentRunId,
          lease: reserved.lease,
          expected: data.expected,
          environment,
          timeoutMs,
          publication,
        }, operationSignal));
      requirePublication(published, publication);
      const attestation = await runExternalOperation(deadline, (operationSignal, timeoutMs) =>
        this.options.client.attest({
          idempotencyKey: context.environmentRunId,
          lease: reserved.lease,
          expected: data.expected,
          environment,
          timeoutMs,
        }, operationSignal));
      requireAttestation(attestation, data.expected);
      const record = attestedLeaseRecord(context, reserved.lease, attestation);
      await transitionLeaseRecord(context, reserved, record);
      return success('setup', { resource: resourceIdentity(record) });
    } catch (error) {
      let compensated = false;
      try {
        const cleanupDeadline = createExternalPhaseDeadline(
          context,
          'teardown',
          deadline.parentSignal,
        );
        await runExternalOperation(cleanupDeadline, (operationSignal, timeoutMs) =>
          this.options.client.release({
            idempotencyKey: context.environmentRunId,
            lease: reserved.lease,
            environment,
            timeoutMs,
          }, operationSignal));
        compensated = true;
      } catch {
        // The durable RESERVED record is the recovery signal for inspect/release after restart.
      }
      if (compensated) {
        const released = releasedLeaseRecord(context, reserved.lease.namespace);
        await transitionLeaseRecord(context, reserved, released);
        await releaseEnvironmentAllocation(context);
      }
      throw redactedError(error, secrets);
    }
  }
}

function expectedAttestation(context: EnvironmentAdapterContext): ExternalAttestation {
  validateEnvironmentAdapterContext(context, 'external');
  return externalAttestationSchema.parse(context.integrationInput);
}

function reservedLeaseRecord(
  context: EnvironmentAdapterContext,
  lease: ExternalLease,
): Extract<ExternalLeaseRecord, { readonly status: 'RESERVED' }> {
  const content = {
    schemaVersion: 3 as const,
    status: 'RESERVED' as const,
    environmentRunId: context.environmentRunId,
    profileContentHash: context.profile.contentHash,
    inputHash: context.integrationInput.inputHash,
    lease,
  };
  return reservedExternalLeaseRecordSchema.parse({ ...content, contentHash: hashObject(content) });
}

function attestedLeaseRecord(
  context: EnvironmentAdapterContext,
  lease: ExternalLease,
  attestation: ExternalAttestation,
): Extract<ExternalLeaseRecord, { readonly status: 'ATTESTED' }> {
  const content = {
    schemaVersion: 3 as const,
    status: 'ATTESTED' as const,
    environmentRunId: context.environmentRunId,
    profileContentHash: context.profile.contentHash,
    inputHash: context.integrationInput.inputHash,
    lease,
    attestation,
  };
  return attestedExternalLeaseRecordSchema.parse({ ...content, contentHash: hashObject(content) });
}

function reservingLeaseRecord(
  context: EnvironmentAdapterContext,
  namespace: string,
): Extract<ExternalLeaseRecord, { readonly status: 'RESERVING' }> {
  const content = {
    schemaVersion: 3 as const,
    status: 'RESERVING' as const,
    environmentRunId: context.environmentRunId,
    profileContentHash: context.profile.contentHash,
    inputHash: context.integrationInput.inputHash,
    namespace,
  };
  return reservingExternalLeaseRecordSchema.parse({ ...content, contentHash: hashObject(content) });
}

function releasedLeaseRecord(
  context: EnvironmentAdapterContext,
  namespace: string,
): Extract<ExternalLeaseRecord, { readonly status: 'RELEASED' }> {
  const content = {
    schemaVersion: 3 as const,
    status: 'RELEASED' as const,
    environmentRunId: context.environmentRunId,
    profileContentHash: context.profile.contentHash,
    inputHash: context.integrationInput.inputHash,
    namespace,
  };
  return releasedExternalLeaseRecordSchema.parse({ ...content, contentHash: hashObject(content) });
}

async function persistLeaseRecord(
  context: EnvironmentAdapterContext,
  record: ExternalLeaseRecord,
): Promise<void> {
  const path = externalLeaseRecordPath(context.runRoot);
  await ensureDir(context.runRoot);
  const stagePath = await writeLeaseRecordStage(path, record);
  try {
    await link(stagePath, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    const existing = await readLeaseRecord(path);
    if (canonicalJson(existing) !== canonicalJson(record)) {
      throw new Error('EXTERNAL_LEASE_RECORD_CONFLICT');
    }
  } finally {
    await unlink(stagePath).catch(() => undefined);
  }
}

async function transitionLeaseRecord(
  context: EnvironmentAdapterContext,
  current: ExternalLeaseRecord,
  next: ExternalLeaseRecord,
): Promise<void> {
  const path = externalLeaseRecordPath(context.runRoot);
  await withMutationLockAtPath(`${path}.mutation-lock`, async () => {
    const existing = await readLeaseRecord(path);
    if (canonicalJson(existing) === canonicalJson(next)) return;
    if (canonicalJson(existing) !== canonicalJson(current)) {
      throw new Error('EXTERNAL_LEASE_RECORD_CONFLICT');
    }
    const stagePath = await writeLeaseRecordStage(path, next);
    try {
      await rename(stagePath, path);
      await syncDirectory(dirname(path));
    } finally {
      await unlink(stagePath).catch(() => undefined);
    }
  }, { timeoutMs: 5_000 });
}

async function writeLeaseRecordStage(path: string, record: ExternalLeaseRecord): Promise<string> {
  const stagePath = `${path}.stage-${randomUUID()}`;
  const handle = await open(stagePath, 'wx', 0o600);
  try {
    await handle.writeFile(YAML.stringify(record, { lineWidth: 100 }), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return stagePath;
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is unavailable on some supported platforms.
  } finally {
    await handle?.close();
  }
}

async function loadLeaseRecord(
  context: EnvironmentAdapterContext,
): Promise<ExternalLeaseRecord | undefined> {
  const path = externalLeaseRecordPath(context.runRoot);
  if (!(await pathExists(path))) return undefined;
  const record = await readLeaseRecord(path);
  if (record.environmentRunId !== context.environmentRunId ||
      record.profileContentHash !== context.profile.contentHash ||
      record.inputHash !== context.integrationInput.inputHash) {
    throw new Error('EXTERNAL_LEASE_RECORD_CONTEXT_MISMATCH');
  }
  return record;
}

async function readLeaseRecord(path: string): Promise<ExternalLeaseRecord> {
  const record = await readYaml(path, externalLeaseRecordSchema);
  const { contentHash, ...content } = record;
  const expectedHash = hashObject(content);
  if (record.contentHash !== expectedHash) throw new Error('EXTERNAL_LEASE_RECORD_HASH_MISMATCH');
  return record;
}

function resourceIdentity(record: LeasedExternalLeaseRecord): EnvironmentResourceIdentity {
  return {
    driver: 'external',
    ownerRunId: record.environmentRunId,
    resourceRefs: [`external-lease:${record.lease.leaseId}`, `external-namespace:${record.lease.namespace}`],
    reservedPorts: [],
    labels: {
      'omnai.owner': 'omnai',
      'omnai.environmentRunId': record.environmentRunId,
      'omnai.profileContentHash': record.profileContentHash,
      'omnai.integrationInputHash': record.inputHash,
    },
    networkNames: [],
    volumeNames: [],
    containerNames: [],
    exclusiveLeaseId: record.lease.leaseId,
  };
}

function requireLease(
  lease: ExternalLease,
  ownerRunId: string,
  namespace: string,
  requireExclusive = true,
): void {
  if ((requireExclusive && !lease.exclusive) || lease.ownerRunId !== ownerRunId || lease.namespace !== namespace ||
      lease.leaseId.length === 0) {
    throw new Error('EXTERNAL_EXCLUSIVE_LEASE_INVALID');
  }
}

function requireAttestation(actual: ExternalAttestation, expected: ExternalAttestation): void {
  externalAttestationSchema.parse(actual);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error('EXTERNAL_ATTESTATION_MISMATCH');
  }
}

function expectedPublication(input: ExternalAttestation): ExternalArtifactPublication {
  return {
    inputHash: input.inputHash,
    artifacts: input.externalDeploymentDigests,
  };
}

function requirePublication(
  actual: ExternalArtifactPublication,
  expected: ExternalArtifactPublication,
): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error('EXTERNAL_ARTIFACT_PUBLICATION_MISMATCH');
  }
}

function sameLease(left: ExternalLease, right: ExternalLease): boolean {
  return left.leaseId === right.leaseId && left.namespace === right.namespace &&
    left.ownerRunId === right.ownerRunId && left.exclusive === right.exclusive;
}

function externalPreparedData(prepared: ReadyPreparedEnvironment): ExternalPreparedData {
  if (prepared.driver !== 'external' || !isRecord(prepared.preparedData) ||
      typeof prepared.preparedData.namespace !== 'string' ||
      !isRecord(prepared.preparedData.expected)) {
    throw new Error('EXTERNAL_PREPARED_CONTEXT_INVALID');
  }
  return {
    namespace: prepared.preparedData.namespace,
    expected: externalAttestationSchema.parse(prepared.preparedData.expected),
  };
}

function externalNamespace(context: EnvironmentAdapterContext): string {
  return `omnai-${context.worksetId}-${context.environmentRunId}-${context.profile.contentHash.slice(7, 19)}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .slice(0, 63);
}

function success(
  step: EnvironmentStep['name'],
  values: Partial<Pick<EnvironmentStepResult, 'exitCode' | 'output' | 'truncated' | 'resource'>> = {},
): EnvironmentStepResult {
  return {
    status: 'SUCCEEDED',
    step,
    exitCode: values.exitCode ?? 0,
    output: values.output ?? '',
    truncated: values.truncated ?? false,
    ...(values.resource === undefined ? {} : { resource: values.resource }),
  };
}

function diagnosticProbe(code: string): EnvironmentProbe {
  return {
    driver: 'external',
    authoritative: false,
    mode: 'DIAGNOSTIC_ONLY',
    code,
    reasons: [code],
  };
}

function wrongDriverProbe(actual: string): EnvironmentProbe {
  return {
    ...diagnosticProbe('ENVIRONMENT_ADAPTER_DRIVER_MISMATCH'),
    reasons: [`expected external, received ${actual}`],
  };
}

function redactedError(error: unknown, secrets: readonly string[]): Error {
  const original = error instanceof Error ? error : new Error(String(error));
  const redacted = new Error(redactSecrets(original.message, secrets));
  redacted.name = original.name;
  return redacted;
}

function externalStepTimeout(
  context: EnvironmentAdapterContext,
  step: EnvironmentStep['name'],
): number {
  return context.profile.steps[step].timeoutMs;
}

interface ExternalPhaseDeadline {
  readonly label: string;
  readonly expiresAt: number;
  readonly parentSignal?: AbortSignal;
}

function createExternalPhaseDeadline(
  context: EnvironmentAdapterContext,
  step: EnvironmentStep['name'],
  parentSignal?: AbortSignal,
): ExternalPhaseDeadline {
  const timeoutMs = externalStepTimeout(context, step);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`EXTERNAL_OPERATION_TIMEOUT_INVALID: ${step}`);
  }
  return {
    label: step,
    expiresAt: Date.now() + timeoutMs,
    ...(parentSignal === undefined ? {} : { parentSignal }),
  };
}

async function runExternalOperation<T>(
  deadline: ExternalPhaseDeadline,
  operation: (signal: AbortSignal, timeoutMs: number) => Promise<T>,
): Promise<T> {
  const timeoutMs = deadline.expiresAt - Date.now();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`EXTERNAL_OPERATION_TIMEOUT: ${deadline.label}`);
  }
  const controller = new AbortController();
  let rejectAbort: ((error: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = (): void => {
    const error = new Error(`AbortError: external operation aborted: ${deadline.label}`);
    error.name = 'AbortError';
    rejectAbort?.(error);
    controller.abort(error);
  };
  if (deadline.parentSignal?.aborted === true) abort();
  else deadline.parentSignal?.addEventListener('abort', abort, { once: true });
  let rejectTimeout: ((error: Error) => void) | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timeout = setTimeout(() => {
    const error = new Error(`EXTERNAL_OPERATION_TIMEOUT: ${deadline.label}`);
    error.name = 'TimeoutError';
    rejectTimeout?.(error);
    controller.abort(error);
  }, timeoutMs);
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal, timeoutMs)),
      aborted,
      timedOut,
    ]);
  } finally {
    clearTimeout(timeout);
    deadline.parentSignal?.removeEventListener('abort', abort);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
