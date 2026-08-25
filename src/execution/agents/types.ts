import { z } from 'zod';
import { contentHashSchema } from '../types.js';
import type { AgentSessionRecord } from '../types.js';
import type { RunPacket } from '../packets.js';

export const AGENT_ROLES = [
  'coordination-read-only',
  'project-writer',
  'project-reviewer',
] as const;

export const AGENT_HEALTH_VALUES = ['UNHEALTHY', 'UNKNOWN', 'DEGRADED', 'HEALTHY'] as const;

const agentIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

export const agentCapabilitiesSchema = z.object({
  loadSession: z.boolean(),
  resumeSession: z.boolean(),
  closeSession: z.boolean(),
  additionalDirectories: z.boolean(),
  mcpStdio: z.boolean(),
});

export const agentIsolationSchema = z.object({
  mode: z.enum(['agent-sandbox', 'process-sandbox', 'none']),
  enforcedWorkspaceRoots: z.boolean(),
});

export const agentConformanceEvidenceSchema = z.object({
  suiteVersion: z.literal(1),
  passedAt: z.string().datetime(),
  inputHash: contentHashSchema,
  evidenceHash: contentHashSchema,
});

export const agentProfileSchema = z.object({
  schemaVersion: z.literal(1),
  agentId: agentIdSchema,
  protocol: z.enum(['acp', 'native']),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  envRefs: z.record(z.string(), z.string()).default({}),
  protocolVersion: z.literal(1),
  priority: z.number().int().default(100),
  costClass: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'),
  maxParallelSessions: z.number().int().positive(),
  isolation: agentIsolationSchema,
  capabilities: agentCapabilitiesSchema,
  omnaiModes: z.array(z.enum(AGENT_ROLES)).min(1),
  conformance: agentConformanceEvidenceSchema.optional(),
});

export const agentProbeSchema = z.object({
  schemaVersion: z.literal(1),
  agentId: agentIdSchema,
  available: z.boolean(),
  authenticated: z.boolean(),
  protocolVersion: z.number().int().positive().nullable(),
  health: z.enum(AGENT_HEALTH_VALUES),
  activeSessions: z.number().int().nonnegative(),
  capabilities: agentCapabilitiesSchema,
  conformanceInputHash: contentHashSchema.optional(),
  error: z.string().min(1).optional(),
});

export type AgentRole = (typeof AGENT_ROLES)[number];
export type AgentProfile = z.infer<typeof agentProfileSchema>;
export type AgentProbe = z.infer<typeof agentProbeSchema>;
export type AgentConformanceEvidence = z.infer<typeof agentConformanceEvidenceSchema>;

export interface AgentSelectionRequest {
  role: AgentRole;
  protocolVersion: 1;
  requireIsolation: boolean;
  requireResume: boolean;
  requiredMcpTools?: readonly string[];
  preferredAgentId: string | undefined;
  avoidAgentId: string | undefined;
}

export const AGENT_SELECTION_REJECTION_CODES = [
  'AGENT_ID_NOT_REQUESTED',
  'AGENT_PROBE_MISSING',
  'AGENT_UNAVAILABLE',
  'AGENT_AUTHENTICATION_REQUIRED',
  'AGENT_PROTOCOL_VERSION_UNSUPPORTED',
  'AGENT_ROLE_UNSUPPORTED',
  'AGENT_ISOLATION_REQUIRED',
  'AGENT_RECOVERY_UNSUPPORTED',
  'AGENT_MCP_STDIO_REQUIRED',
  'AGENT_CONFORMANCE_MISSING',
  'AGENT_CONFORMANCE_STALE',
  'AGENT_CAPACITY_EXHAUSTED',
] as const;

export type AgentSelectionRejectionCode = (typeof AGENT_SELECTION_REJECTION_CODES)[number];

export interface AgentSelectionRejection {
  agentId: string;
  code: AgentSelectionRejectionCode;
}

export type AgentStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled';

export type AgentMcpServer =
  | {
      readonly name: string;
      readonly command: string;
      readonly args: readonly string[];
      readonly env: readonly { readonly name: string; readonly value: string }[];
    }
  | {
      readonly type: 'http' | 'sse';
      readonly name: string;
      readonly url: string;
      readonly headers: readonly { readonly name: string; readonly value: string }[];
    }
  | {
      readonly type: 'acp';
      readonly name: string;
      readonly serverId: string;
    };

export interface AgentSessionRequest {
  readonly profile: AgentProfile;
  readonly packet: RunPacket;
  readonly cwd: string;
  readonly additionalDirectories: readonly string[];
  readonly mcpServers: readonly AgentMcpServer[];
  readonly prompt: string;
  /** The single coordinator-owned artifact inbox file this Run may write. */
  readonly outputPath: string;
}

export interface AgentSessionHooks {
  onSessionCreated(record: AgentSessionRecord): Promise<void>;
  onPromptIntent(): Promise<void>;
  onEvent(event: NormalizedAgentEvent): Promise<void>;
}

export interface NormalizedAgentEvent {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly kind: 'SESSION_UPDATE' | 'ELICITATION_BLOCKED' | 'ELICITATION_COMPLETED' | 'PROCESS';
  readonly payload: unknown;
  readonly timestamp: string;
}

export type NormalizedPromptResult =
  | {
      readonly status: 'COMPLETED';
      readonly runId: string;
      readonly sessionId: string;
      readonly stopReason: AgentStopReason;
      readonly outputBytes: number;
    }
  | {
      readonly status: 'RESUMED';
      readonly runId: string;
      readonly sessionId: string;
      readonly stopReason: null;
      readonly outputBytes: number;
    }
  | {
      readonly status: 'RECOVERY_REQUIRED';
      readonly runId: string;
      readonly sessionId: string;
      readonly stopReason: null;
      readonly outputBytes: number;
      readonly evidence: Readonly<Record<string, unknown>>;
    };

export interface AgentInspectionRequest {
  readonly record: AgentSessionRecord;
  readonly events: readonly NormalizedAgentEvent[];
  readonly promptResult?: NormalizedPromptResult;
}

export interface AgentSessionInspection {
  readonly sessionId: string;
  readonly process: 'LIVE' | 'DEAD' | 'UNKNOWN';
  readonly outcome: 'RUNNING' | 'COMPLETED' | 'RECOVERY_REQUIRED' | 'UNKNOWN';
  readonly eventCount: number;
}

export interface AgentSignalRequest {
  readonly profile: AgentProfile;
  readonly packet: RunPacket;
  readonly record: AgentSessionRecord;
  readonly signal: 'STOP';
}

export interface AgentCollectRequest {
  readonly packet: RunPacket;
  readonly record: AgentSessionRecord;
  readonly events: readonly NormalizedAgentEvent[];
  readonly promptResult?: NormalizedPromptResult;
  readonly secretValues?: readonly string[];
}

export interface NormalizedAgentResult {
  readonly sessionId: string;
  readonly status: 'COMPLETED' | 'RUNNING' | 'RECOVERY_REQUIRED';
  readonly stopReason: AgentStopReason | null;
  readonly events: readonly NormalizedAgentEvent[];
  readonly outputBytes: number;
}

export interface AgentResumeRequest extends Omit<AgentSessionRequest, 'prompt'> {
  readonly record: AgentSessionRecord;
}

export interface AgentSessionAdapter {
  probe(profile: AgentProfile): Promise<AgentProbe>;
  start(request: AgentSessionRequest, hooks: AgentSessionHooks): Promise<NormalizedPromptResult>;
  inspect(request: AgentInspectionRequest): Promise<AgentSessionInspection>;
  signal(request: AgentSignalRequest): Promise<void>;
  collect(request: AgentCollectRequest): Promise<NormalizedAgentResult>;
  resume(request: AgentResumeRequest, hooks: AgentSessionHooks): Promise<NormalizedPromptResult>;
}
