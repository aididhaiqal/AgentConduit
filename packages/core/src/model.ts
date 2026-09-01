export type AgentStatus = "online" | "stale" | "offline";

export type DeviceStatus = "online" | "stale" | "revoked";

export interface DeviceHealth {
  status: "healthy" | "degraded";
  uptimeSeconds: number;
  memoryUsedPercent: number;
  loadAverage1?: number;
}

export interface DeviceRecord {
  deviceId: string;
  name: string;
  platform: string;
  architecture: string;
  nodeVersion: string;
  capabilities: string[];
  health: DeviceHealth;
  status: DeviceStatus;
  enrolledAt: string;
  lastSeenAt: string;
  revokedAt?: string;
}

/** Returned once by device enrollment or credential rotation. */
export interface DeviceCredential extends DeviceRecord {
  deviceToken: string;
}

/** Returned once to the signed-in owner when opening enrollment. */
export interface DeviceEnrollment {
  enrollmentId: string;
  enrollmentCode: string;
  createdAt: string;
  expiresAt: string;
}

export type IntegrationStatus =
  "queued" | "needs_refresh" | "claimed" | "completed" | "failed" | "cancelled";

/**
 * Server-observed evidence for the current branch's configured upstream.
 * `unavailable` makes no synchronization claim; `ref` is retained when Git
 * resolved the upstream name but could not complete the comparison.
 */
export type GitUpstreamEvidence =
  | {
      status: "available";
      ref: string;
      ahead: number;
      behind: number;
    }
  | {
      status: "unavailable";
      ref?: string;
    };

export interface GitWorkspaceSnapshot {
  repositoryId: string;
  /** Optional explicit enrollment identity from .agentconduit/project.json. */
  projectId?: string;
  worktreeId: string;
  rootPath: string;
  commonGitDir: string;
  gitDir: string;
  remoteUrl?: string;
  branch?: string;
  headOid: string;
  dirty: boolean;
  upstream: GitUpstreamEvidence;
  isBare: boolean;
  observedAt: string;
}

export interface AgentRegistrationInput {
  runtime: string;
  workspacePath: string;
  sessionRef?: string;
  /** Prior token required when resuming an existing session identity. */
  sessionToken?: string;
  displayName?: string;
  capabilities?: string[];
}

export interface AgentRecord {
  agentId: string;
  runtime: string;
  displayName?: string;
  workspace: GitWorkspaceSnapshot;
  capabilities: string[];
  status: AgentStatus;
  lastHeartbeat: string;
  registeredAt: string;
  unregisteredAt?: string;
}

/**
 * Returned only by registration/reconnection. The token is intentionally not
 * part of AgentRecord, so listing or inspecting agents never discloses it.
 */
export interface AgentRegistration extends AgentRecord {
  sessionToken: string;
}

export interface MessageRecord {
  messageId: string;
  senderAgentId: string;
  recipientAgentId: string;
  body: string;
  correlationId?: string;
  createdAt: string;
  acknowledgedAt?: string;
}

export interface OperatorMessageRecord {
  messageId: string;
  senderAgentId: "owner";
  senderKind: "owner";
  recipientAgentId: string;
  body: string;
  createdAt: string;
  acknowledgedAt?: string;
}

export interface RemoteWorkspaceRecord {
  workspace: GitWorkspaceSnapshot;
  deviceId: string;
  pathLabel: string;
  registeredAt: string;
}

export interface ReconciliationCase {
  reconciliationId: string;
  agentId: string;
  reason: string;
  status: "open" | "resolved";
  leaseIds: string[];
  claimedIntegrationIds: string[];
  createdAt: string;
  resolvedAt?: string;
}

export interface AuditEventRecord {
  cursor: number;
  eventId: string;
  eventType: string;
  actorAgentId?: string;
  resourceId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export type JobStatus =
  "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";

/** Derived from server-observed activity; it is never a completion signal. */
export type JobActivity = "active" | "stale" | "terminal";

export type JobEventType =
  | "created"
  | "started"
  | "provider_ready"
  | "working"
  | "heartbeat"
  | "checkpoint"
  | "waiting_for_input"
  | "operation_started"
  | "operation_finished"
  | "completed"
  | "failed"
  | "cancelled";

export interface JobRecord {
  jobId: string;
  ownerAgentId: string;
  repositoryId: string;
  worktreeId: string;
  kind: string;
  displayName: string;
  parentJobId?: string;
  correlationId?: string;
  status: JobStatus;
  activity: JobActivity;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  lastEventCursor: number;
  lastEventSequence: number;
  completedAt?: string;
}

export interface JobCreateInput {
  /** Stable caller-issued key used only to make creation retry-safe. */
  idempotencyKey: string;
  kind: string;
  displayName: string;
  parentJobId?: string;
  correlationId?: string;
}

export interface JobEventInput {
  /** Stable caller-issued key used only to make this append retry-safe. */
  idempotencyKey: string;
  type: Exclude<JobEventType, "created">;
  phase?: string;
  summary?: string;
  operation?: string;
}

export interface JobEventRecord {
  eventId: string;
  jobId: string;
  cursor: number;
  sequence: number;
  type: JobEventType;
  status: JobStatus;
  phase?: string;
  summary?: string;
  operation?: string;
  createdAt: string;
}

export interface JobListFilter {
  statuses?: readonly JobStatus[];
  activity?: JobActivity;
  ownerAgentId?: string;
}

export interface LeaseRecord {
  leaseId: string;
  resource: string;
  holderAgentId: string;
  fencingToken: number;
  acquiredAt: string;
  expiresAt: string;
}

export interface IntegrationRequest {
  requestId: string;
  repositoryId: string;
  sourceRef: string;
  sourceOid: string;
  targetRef: string;
  observedTargetOid: string;
  status: IntegrationStatus;
  requestedBy: string;
  claimedBy?: string;
  leaseId?: string;
  /** Full lease metadata is present while the request is actively claimed. */
  lease?: LeaseRecord;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  result?: {
    outcome: "merged" | "rebased" | "squashed" | "failed" | "cancelled";
    postTargetOid?: string;
    note?: string;
  };
}

export interface IntegrationEnqueueInput {
  repositoryId: string;
  sourceRef: string;
  sourceOid: string;
  targetRef: string;
  observedTargetOid: string;
  requestedBy: string;
}

export interface IntegrationCompletionInput {
  outcome: "merged" | "rebased" | "squashed" | "failed" | "cancelled";
  postTargetOid?: string;
  note?: string;
}
