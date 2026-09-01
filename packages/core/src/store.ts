import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import Database from "better-sqlite3";
import { CoordinationError } from "./errors.js";
import { assertSafeGitRef, repositoryIdForProjectId } from "./git.js";
import {
  NODE_RPC_COLLECTION_PAGE_MAX_RECORDS,
  remoteUrlForHub,
} from "./remote.js";
import type {
  AgentRecord,
  AgentRegistration,
  AgentStatus,
  AuditEventRecord,
  DeviceCredential,
  DeviceEnrollment,
  DeviceHealth,
  DeviceRecord,
  GitWorkspaceSnapshot,
  IntegrationCompletionInput,
  IntegrationEnqueueInput,
  IntegrationRequest,
  JobActivity,
  JobCreateInput,
  JobEventInput,
  JobEventRecord,
  JobEventType,
  JobListFilter,
  JobRecord,
  JobStatus,
  LeaseRecord,
  MessageRecord,
  OperatorMessageRecord,
  ReconciliationCase,
  RemoteWorkspaceRecord,
} from "./model.js";

const MAX_MESSAGE_BYTES = 32 * 1024;
const DEFAULT_HEARTBEAT_MS = 90_000;
const DEFAULT_DEVICE_HEARTBEAT_MS = 120_000;
const DEFAULT_JOB_ACTIVITY_MS = 5 * 60_000;
const MAX_LEASE_SECONDS = 15 * 60;
const MAX_ENROLLMENT_TTL_SECONDS = 60 * 60;
const MAX_AUDIT_PAGE_SIZE = 500;
const MAX_JOB_EVENT_PAGE_SIZE = 500;
const MAX_STORE_PAGE_RECORDS = NODE_RPC_COLLECTION_PAGE_MAX_RECORDS + 1;
const INTERNAL_INTEGRATION_LEASE_PREFIX = "git:";
const DIRECT_BRANCH_REF_PATTERN =
  /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._@+\/-]*$/;
const BRANCH_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@+\/-]*$/;
const REMOTE_WORKTREE_ID_PATTERN = /^wt_[0-9a-f]{32}$/;
const DEVICE_ID_PATTERN = /^dev_[0-9a-f]{32}$/;
const MESSAGE_ID_PATTERN = /^(?:msg|opm)_[0-9a-f]{32}$/;
const JOB_ID_PATTERN = /^job_[0-9a-f]{32}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const JOB_KIND_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const INTEGRATION_COMPLETION_OUTCOMES: ReadonlySet<string> = new Set([
  "merged",
  "rebased",
  "squashed",
  "failed",
  "cancelled",
]);
const JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
]);
const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);
const JOB_EVENT_TYPES: ReadonlySet<JobEventType> = new Set([
  "created",
  "started",
  "provider_ready",
  "working",
  "heartbeat",
  "checkpoint",
  "waiting_for_input",
  "operation_started",
  "operation_finished",
  "completed",
  "failed",
  "cancelled",
]);
export const COORDINATION_SCHEMA_VERSION = 4;
const PERSISTENCE_SCHEMA_COLUMNS = {
  workspaces: [
    "worktree_id",
    "repository_id",
    "project_id",
    "root_path",
    "common_git_dir",
    "git_dir",
    "remote_url",
    "branch",
    "head_oid",
    "dirty",
    "upstream_status",
    "upstream_ref",
    "ahead",
    "behind",
    "is_bare",
    "observed_at",
  ],
  agents: [
    "agent_id",
    "runtime",
    "display_name",
    "session_key",
    "session_secret_hash",
    "workspace_id",
    "capabilities_json",
    "last_heartbeat",
    "registered_at",
    "unregistered_at",
  ],
  messages: [
    "message_id",
    "sender_agent_id",
    "recipient_agent_id",
    "body",
    "correlation_id",
    "created_at",
    "acknowledged_at",
  ],
  lease_counters: ["resource", "next_token"],
  leases: [
    "lease_id",
    "resource",
    "holder_agent_id",
    "fencing_token",
    "acquired_at",
    "expires_at",
  ],
  integration_requests: [
    "request_id",
    "repository_id",
    "source_ref",
    "source_oid",
    "target_ref",
    "observed_target_oid",
    "status",
    "requested_by",
    "claimed_by",
    "lease_id",
    "created_at",
    "updated_at",
    "completed_at",
    "result_json",
  ],
  audit_events: [
    "event_id",
    "event_cursor",
    "event_type",
    "actor_agent_id",
    "resource_id",
    "metadata_json",
    "created_at",
  ],
  event_sequence: ["id", "next_cursor"],
  jobs: [
    "job_id",
    "owner_agent_id",
    "repository_id",
    "worktree_id",
    "kind",
    "display_name",
    "parent_job_id",
    "correlation_id",
    "status",
    "create_idempotency_key",
    "created_at",
    "updated_at",
    "last_activity_at",
    "last_event_cursor",
    "last_event_sequence",
    "completed_at",
  ],
  job_events: [
    "event_id",
    "job_id",
    "event_cursor",
    "event_sequence",
    "event_type",
    "event_idempotency_key",
    "resulting_status",
    "phase",
    "summary",
    "operation",
    "created_at",
  ],
  devices: [
    "device_id",
    "name",
    "platform",
    "architecture",
    "node_version",
    "token_hash",
    "capabilities_json",
    "health_json",
    "enrolled_at",
    "last_seen_at",
    "revoked_at",
  ],
  device_enrollments: [
    "enrollment_id",
    "code_hash",
    "name_hint",
    "created_at",
    "expires_at",
    "used_at",
  ],
  workspace_devices: [
    "worktree_id",
    "device_id",
    "path_label",
    "registered_at",
  ],
  operator_messages: [
    "message_id",
    "recipient_agent_id",
    "body",
    "created_at",
    "acknowledged_at",
  ],
  reconciliations: [
    "reconciliation_id",
    "agent_id",
    "reason",
    "status",
    "lease_ids_json",
    "claimed_integration_ids_json",
    "created_at",
    "resolved_at",
  ],
} as const;

const PERSISTENCE_PRIMARY_KEYS = {
  workspaces: "worktree_id",
  agents: "agent_id",
  messages: "message_id",
  lease_counters: "resource",
  leases: "lease_id",
  integration_requests: "request_id",
  audit_events: "event_id",
  event_sequence: "id",
  jobs: "job_id",
  job_events: "event_id",
  devices: "device_id",
  device_enrollments: "enrollment_id",
  workspace_devices: "worktree_id",
  operator_messages: "message_id",
  reconciliations: "reconciliation_id",
} as const;

const PERSISTENCE_FOREIGN_KEYS = {
  agents: [["workspace_id", "workspaces", "worktree_id"]],
  messages: [
    ["sender_agent_id", "agents", "agent_id"],
    ["recipient_agent_id", "agents", "agent_id"],
  ],
  leases: [["holder_agent_id", "agents", "agent_id"]],
  integration_requests: [
    ["requested_by", "agents", "agent_id"],
    ["claimed_by", "agents", "agent_id"],
  ],
  jobs: [
    ["owner_agent_id", "agents", "agent_id"],
    ["worktree_id", "workspaces", "worktree_id"],
    ["parent_job_id", "jobs", "job_id"],
  ],
  job_events: [["job_id", "jobs", "job_id"]],
  workspace_devices: [
    ["worktree_id", "workspaces", "worktree_id"],
    ["device_id", "devices", "device_id"],
  ],
  operator_messages: [["recipient_agent_id", "agents", "agent_id"]],
  reconciliations: [["agent_id", "agents", "agent_id"]],
} as const;

const CURRENT_PERSISTENCE_INDEXES = [
  ["workspaces", "idx_workspaces_repository", false, ["repository_id"]],
  [
    "agents",
    "idx_agents_session_workspace",
    true,
    ["session_key", "workspace_id"],
  ],
  ["agents", "idx_agents_workspace", false, ["workspace_id"]],
  [
    "messages",
    "idx_messages_inbox",
    false,
    ["recipient_agent_id", "acknowledged_at", "created_at"],
  ],
  ["leases", "idx_leases_resource", true, ["resource"]],
  [
    "integration_requests",
    "idx_integrations_queue",
    false,
    ["repository_id", "target_ref", "created_at"],
  ],
  ["audit_events", "idx_audit_events_cursor", true, ["event_cursor"]],
  [
    "jobs",
    "idx_jobs_owner_idempotency",
    true,
    ["owner_agent_id", "create_idempotency_key"],
  ],
  [
    "jobs",
    "idx_jobs_repository_status_activity",
    false,
    ["repository_id", "status", "last_activity_at"],
  ],
  ["job_events", "idx_job_events_sequence", true, ["job_id", "event_sequence"]],
  [
    "job_events",
    "idx_job_events_idempotency",
    true,
    ["job_id", "event_idempotency_key"],
  ],
  ["job_events", "idx_job_events_cursor", true, ["event_cursor"]],
  [
    "job_events",
    "idx_job_events_job_cursor",
    false,
    ["job_id", "event_cursor"],
  ],
  ["devices", "idx_devices_token_hash", true, ["token_hash"]],
  ["devices", "idx_devices_last_seen", false, ["last_seen_at"]],
  [
    "device_enrollments",
    "idx_device_enrollments_code_hash",
    true,
    ["code_hash"],
  ],
  [
    "operator_messages",
    "idx_operator_messages_inbox",
    false,
    ["recipient_agent_id", "acknowledged_at", "created_at"],
  ],
  [
    "reconciliations",
    "idx_reconciliations_agent_status",
    false,
    ["agent_id", "status", "created_at"],
  ],
] as const;

type PersistenceTable = keyof typeof PERSISTENCE_SCHEMA_COLUMNS;

const LEGACY_ADDITIVE_COLUMNS: Partial<
  Record<PersistenceTable, readonly string[]>
> = {
  workspaces: ["project_id", "upstream_status", "upstream_ref"],
  agents: ["session_secret_hash"],
  audit_events: ["event_cursor"],
};

const VERSION_THREE_TABLES = new Set<PersistenceTable>([
  "event_sequence",
  "devices",
  "device_enrollments",
  "workspace_devices",
  "operator_messages",
  "reconciliations",
]);

const VERSION_FOUR_TABLES = new Set<PersistenceTable>(["jobs", "job_events"]);

export interface CoordinationStoreOptions {
  heartbeatTimeoutMs?: number;
  deviceHeartbeatTimeoutMs?: number;
  jobActivityTimeoutMs?: number;
  /** Production serving fails closed and migrates only through an explicit command. */
  migrations?: "auto" | "require-current";
}

export interface CoordinationStoreHealth {
  status: "ok";
  schemaVersion: number;
  journalMode: string;
  quickCheck: "ok";
  foreignKeyViolations: 0;
}

export interface CoordinationBackupResult {
  destinationPath: string;
  pages: number;
  schemaVersion: number;
  quickCheck: "ok";
  foreignKeyViolations: 0;
}

export interface CoordinationMigrationPreflight {
  databasePath: string;
  currentVersion: number;
  targetVersion: number;
  migrationRequired: boolean;
  quickCheck: "ok";
  foreignKeyViolations: 0;
}

export interface CoordinationMigrationResult {
  status: "migrated";
  databasePath: string;
  fromVersion: number;
  toVersion: number;
  backup: CoordinationBackupResult;
  database: CoordinationStoreHealth;
}

export interface CoordinationMaintenancePolicy {
  staleBefore: string;
  acknowledgedMessagesBefore: string;
  terminalIntegrationsBefore: string;
  terminalJobsBefore: string;
  auditEventsBefore: string;
}

export interface CoordinationMaintenanceOptions {
  /** Preview is the safe default. Applying requires an explicit true value. */
  apply?: boolean;
}

export interface CoordinationMaintenanceBlocker {
  agentId: string;
  lastHeartbeat: string;
  leaseIds: string[];
  claimedIntegrationIds: string[];
}

export interface CoordinationMaintenanceResult {
  mode: "preview" | "applied";
  evaluatedAt: string;
  policy: CoordinationMaintenancePolicy;
  expiredLeaseRecovery: {
    leasesRemoved: number;
    integrationsMarkedNeedsRefresh: number;
  };
  staleAgents: {
    candidates: number;
    blocked: number;
    markedOffline: number;
  };
  blockers: CoordinationMaintenanceBlocker[];
  pruned: {
    acknowledgedMessages: number;
    terminalIntegrations: number;
    terminalJobs: number;
    auditEvents: number;
  };
}

interface AgentRow {
  agent_id: string;
  runtime: string;
  display_name: string | null;
  session_key: string;
  session_secret_hash: string | null;
  workspace_id: string;
  capabilities_json: string;
  last_heartbeat: string;
  registered_at: string;
  unregistered_at: string | null;
}

interface WorkspaceRow {
  worktree_id: string;
  repository_id: string;
  project_id: string | null;
  root_path: string;
  common_git_dir: string;
  git_dir: string;
  remote_url: string | null;
  branch: string | null;
  head_oid: string;
  dirty: number;
  upstream_status: string;
  upstream_ref: string | null;
  ahead: number;
  behind: number;
  is_bare: number;
  observed_at: string;
}

interface MessageRow {
  message_id: string;
  sender_agent_id: string;
  recipient_agent_id: string;
  body: string;
  correlation_id: string | null;
  created_at: string;
  acknowledged_at: string | null;
}

interface LeaseRow {
  lease_id: string;
  resource: string;
  holder_agent_id: string;
  fencing_token: number;
  acquired_at: string;
  expires_at: string;
}

interface IntegrationRow {
  request_id: string;
  repository_id: string;
  source_ref: string;
  source_oid: string;
  target_ref: string;
  observed_target_oid: string;
  status: IntegrationRequest["status"];
  requested_by: string;
  claimed_by: string | null;
  lease_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  result_json: string | null;
}

interface DeviceRow {
  device_id: string;
  name: string;
  platform: string;
  architecture: string;
  node_version: string;
  token_hash: string;
  capabilities_json: string;
  health_json: string;
  enrolled_at: string;
  last_seen_at: string;
  revoked_at: string | null;
}

interface DeviceEnrollmentRow {
  enrollment_id: string;
  code_hash: string;
  name_hint: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

interface WorkspaceDeviceRow {
  worktree_id: string;
  device_id: string;
  path_label: string;
  registered_at: string;
}

interface OperatorMessageRow {
  message_id: string;
  recipient_agent_id: string;
  body: string;
  created_at: string;
  acknowledged_at: string | null;
}

interface ReconciliationRow {
  reconciliation_id: string;
  agent_id: string;
  reason: string;
  status: ReconciliationCase["status"];
  lease_ids_json: string;
  claimed_integration_ids_json: string;
  created_at: string;
  resolved_at: string | null;
}

interface AuditEventRow {
  event_id: string;
  event_cursor: number;
  event_type: string;
  actor_agent_id: string | null;
  resource_id: string | null;
  metadata_json: string;
  created_at: string;
}

interface JobRow {
  job_id: string;
  owner_agent_id: string;
  repository_id: string;
  worktree_id: string;
  kind: string;
  display_name: string;
  parent_job_id: string | null;
  correlation_id: string | null;
  status: string;
  create_idempotency_key: string;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  last_event_cursor: number;
  last_event_sequence: number;
  completed_at: string | null;
}

interface JobEventRow {
  event_id: string;
  job_id: string;
  event_cursor: number;
  event_sequence: number;
  event_type: string;
  event_idempotency_key: string;
  resulting_status: string;
  phase: string | null;
  summary: string | null;
  operation: string | null;
  created_at: string;
}

interface RowPage {
  page_rowid: number;
}

interface CombinedMessageRow {
  message_kind: "agent" | "owner";
  message_id: string;
  sender_agent_id: string | null;
  recipient_agent_id: string;
  body: string;
  correlation_id: string | null;
  created_at: string;
  acknowledged_at: string | null;
}

export interface StoreCursorItem<T> {
  cursor: string;
  value: T;
}

function hashSession(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function issueSessionToken(): string {
  return `acs_${randomBytes(32).toString("hex")}`;
}

function issueDeviceToken(): string {
  return `acd_${randomBytes(32).toString("hex")}`;
}

function issueEnrollmentCode(): string {
  return `ace_${randomBytes(24).toString("hex")}`;
}

function tokenMatches(token: string, expectedHash: string | null): boolean {
  if (!expectedHash || !token) return false;
  const actual = Buffer.from(hashSession(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function boundedText(name: string, value: unknown, maximum: number): string {
  if (typeof value !== "string") {
    throw new CoordinationError("invalid_input", `${name} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new CoordinationError(
      "invalid_input",
      `${name} must be 1-${maximum} characters`,
    );
  }
  return normalized;
}

function boundedSafeText(
  name: string,
  value: unknown,
  maximumBytes: number,
): string {
  if (typeof value !== "string") {
    throw new CoordinationError("invalid_input", `${name} must be a string`);
  }
  const normalized = value.trim();
  if (
    !normalized ||
    Buffer.byteLength(normalized, "utf8") > maximumBytes ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new CoordinationError(
      "invalid_input",
      `${name} must be one line of 1-${maximumBytes} UTF-8 bytes`,
    );
  }
  return normalized;
}

function optionalSafeText(
  name: string,
  value: unknown,
  maximumBytes: number,
): string | undefined {
  return value === undefined
    ? undefined
    : boundedSafeText(name, value, maximumBytes);
}

function jobIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new CoordinationError(
      "invalid_input",
      "idempotencyKey must be 1-128 letters, digits, dots, underscores, colons, or hyphens",
    );
  }
  return value;
}

function jobKind(value: unknown): string {
  if (typeof value !== "string" || !JOB_KIND_PATTERN.test(value)) {
    throw new CoordinationError(
      "invalid_input",
      "kind must be 1-64 lowercase letters, digits, dots, underscores, or hyphens",
    );
  }
  return value;
}

function boundedCapabilities(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new CoordinationError(
      "invalid_input",
      "capabilities must contain at most 32 entries",
    );
  }
  return [
    ...new Set(
      value.map((entry, index) =>
        boundedText(`capabilities[${index}]`, entry, 64),
      ),
    ),
  ];
}

function validatedDeviceHealth(value: DeviceHealth): DeviceHealth {
  if (value.status !== "healthy" && value.status !== "degraded") {
    throw new CoordinationError(
      "invalid_input",
      'health.status must be "healthy" or "degraded"',
    );
  }
  if (
    !Number.isFinite(value.uptimeSeconds) ||
    value.uptimeSeconds < 0 ||
    value.uptimeSeconds > Number.MAX_SAFE_INTEGER
  ) {
    throw new CoordinationError(
      "invalid_input",
      "health.uptimeSeconds must be a non-negative number",
    );
  }
  if (
    !Number.isFinite(value.memoryUsedPercent) ||
    value.memoryUsedPercent < 0 ||
    value.memoryUsedPercent > 100
  ) {
    throw new CoordinationError(
      "invalid_input",
      "health.memoryUsedPercent must be from 0-100",
    );
  }
  if (
    value.loadAverage1 !== undefined &&
    (!Number.isFinite(value.loadAverage1) || value.loadAverage1 < 0)
  ) {
    throw new CoordinationError(
      "invalid_input",
      "health.loadAverage1 must be a non-negative number",
    );
  }
  return {
    status: value.status,
    uptimeSeconds: Math.round(value.uptimeSeconds),
    memoryUsedPercent: Math.round(value.memoryUsedPercent * 10) / 10,
    ...(value.loadAverage1 !== undefined
      ? { loadAverage1: Math.round(value.loadAverage1 * 100) / 100 }
      : {}),
  };
}

function deviceHeartbeatTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_DEVICE_HEARTBEAT_MS;
  if (
    !Number.isInteger(value) ||
    value < 1_000 ||
    value > 24 * 60 * 60 * 1_000
  ) {
    throw new CoordinationError(
      "invalid_input",
      "deviceHeartbeatTimeoutMs must be an integer from 1000-86400000",
    );
  }
  return value;
}

function heartbeatTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_HEARTBEAT_MS;
  if (
    !Number.isInteger(value) ||
    value < 1_000 ||
    value > 24 * 60 * 60 * 1_000
  ) {
    throw new CoordinationError(
      "invalid_input",
      "heartbeatTimeoutMs must be an integer from 1000-86400000",
    );
  }
  return value;
}

function jobActivityTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_JOB_ACTIVITY_MS;
  if (
    !Number.isInteger(value) ||
    value < 1_000 ||
    value > 24 * 60 * 60 * 1_000
  ) {
    throw new CoordinationError(
      "invalid_input",
      "jobActivityTimeoutMs must be an integer from 1000-86400000",
    );
  }
  return value;
}

function jobStatus(value: string, recordId: string): JobStatus {
  if (!JOB_STATUSES.has(value as JobStatus)) {
    throw new CoordinationError(
      "storage_error",
      `Stored job status is invalid: ${recordId}`,
    );
  }
  return value as JobStatus;
}

function jobEventType(value: string, recordId: string): JobEventType {
  if (!JOB_EVENT_TYPES.has(value as JobEventType)) {
    throw new CoordinationError(
      "storage_error",
      `Stored job event type is invalid: ${recordId}`,
    );
  }
  return value as JobEventType;
}

function nextJobStatus(
  current: JobStatus,
  eventType: Exclude<JobEventType, "created">,
): JobStatus {
  if (TERMINAL_JOB_STATUSES.has(current)) {
    throw new CoordinationError(
      "conflict",
      `Job is already terminal: ${current}`,
      { status: current },
    );
  }
  switch (eventType) {
    case "heartbeat":
      return current;
    case "waiting_for_input":
      return "waiting";
    case "completed":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "started":
    case "provider_ready":
    case "working":
    case "checkpoint":
    case "operation_started":
    case "operation_finished":
      return "running";
  }
}

function normalizedJobCreateInput(input: JobCreateInput): JobCreateInput {
  const idempotencyKey = jobIdempotencyKey(input?.idempotencyKey);
  const kind = jobKind(input?.kind);
  const displayName = boundedSafeText("displayName", input?.displayName, 160);
  let parentJobId: string | undefined;
  if (input?.parentJobId !== undefined) {
    if (!JOB_ID_PATTERN.test(input.parentJobId)) {
      throw new CoordinationError(
        "invalid_input",
        "parentJobId is not a valid job identifier",
      );
    }
    parentJobId = input.parentJobId;
  }
  const correlationId = optionalSafeText(
    "correlationId",
    input?.correlationId,
    128,
  );
  return {
    idempotencyKey,
    kind,
    displayName,
    ...(parentJobId ? { parentJobId } : {}),
    ...(correlationId ? { correlationId } : {}),
  };
}

function normalizedJobEventInput(input: JobEventInput): JobEventInput {
  const idempotencyKey = jobIdempotencyKey(input?.idempotencyKey);
  const type = input?.type as JobEventType | undefined;
  if (type === "created" || !JOB_EVENT_TYPES.has(type as JobEventType)) {
    throw new CoordinationError(
      "invalid_input",
      "type must be a client-emittable job event",
    );
  }
  const phase = optionalSafeText("phase", input?.phase, 128);
  const summary = optionalSafeText("summary", input?.summary, 512);
  const operation = optionalSafeText("operation", input?.operation, 128);
  if (type === "heartbeat" && (phase || summary || operation)) {
    throw new CoordinationError(
      "invalid_input",
      "heartbeat reports liveness only and cannot contain progress fields",
    );
  }
  if (type === "checkpoint" && !summary) {
    throw new CoordinationError(
      "invalid_input",
      "checkpoint requires a bounded summary",
    );
  }
  if (type === "waiting_for_input" && !summary) {
    throw new CoordinationError(
      "invalid_input",
      "waiting_for_input requires a bounded summary",
    );
  }
  if (
    (type === "operation_started" || type === "operation_finished") &&
    !operation
  ) {
    throw new CoordinationError(
      "invalid_input",
      `${type} requires a bounded operation label`,
    );
  }
  return {
    idempotencyKey,
    type: type as Exclude<JobEventType, "created">,
    ...(phase ? { phase } : {}),
    ...(summary ? { summary } : {}),
    ...(operation ? { operation } : {}),
  };
}

function normalizedJobFilter(filter: JobListFilter = {}): JobListFilter {
  let statuses: JobStatus[] | undefined;
  if (filter.statuses !== undefined) {
    if (!Array.isArray(filter.statuses) || filter.statuses.length > 6) {
      throw new CoordinationError(
        "invalid_input",
        "statuses must contain at most six job statuses",
      );
    }
    statuses = [...new Set(filter.statuses)];
    if (statuses.some((status) => !JOB_STATUSES.has(status))) {
      throw new CoordinationError("invalid_input", "statuses is invalid");
    }
  }
  if (
    filter.activity !== undefined &&
    filter.activity !== "active" &&
    filter.activity !== "stale" &&
    filter.activity !== "terminal"
  ) {
    throw new CoordinationError("invalid_input", "activity is invalid");
  }
  if (
    filter.ownerAgentId !== undefined &&
    !/^agt_[0-9a-f]{32}$/.test(filter.ownerAgentId)
  ) {
    throw new CoordinationError("invalid_input", "ownerAgentId is invalid");
  }
  return {
    ...(statuses ? { statuses } : {}),
    ...(filter.activity ? { activity: filter.activity } : {}),
    ...(filter.ownerAgentId ? { ownerAgentId: filter.ownerAgentId } : {}),
  };
}

function jobFilterSql(
  filter: JobListFilter,
  activityTimeoutMs: number,
  at: number,
  alias = "j",
): { clauses: string[]; parameters: Array<string | number> } {
  const prefix = alias ? `${alias}.` : "";
  const clauses: string[] = [];
  const parameters: Array<string | number> = [];
  if (filter.statuses && filter.statuses.length > 0) {
    clauses.push(
      `${prefix}status IN (${filter.statuses.map(() => "?").join(", ")})`,
    );
    parameters.push(...filter.statuses);
  }
  if (filter.ownerAgentId) {
    clauses.push(`${prefix}owner_agent_id = ?`);
    parameters.push(filter.ownerAgentId);
  }
  if (filter.activity === "terminal") {
    clauses.push(`${prefix}status IN ('succeeded', 'failed', 'cancelled')`);
  } else if (filter.activity === "active") {
    clauses.push(`${prefix}status NOT IN ('succeeded', 'failed', 'cancelled')`);
    clauses.push(`${prefix}last_activity_at >= ?`);
    clauses.push(`${prefix}last_activity_at <= ?`);
    parameters.push(
      new Date(at - activityTimeoutMs).toISOString(),
      new Date(at).toISOString(),
    );
  } else if (filter.activity === "stale") {
    clauses.push(`${prefix}status NOT IN ('succeeded', 'failed', 'cancelled')`);
    clauses.push(
      `(${prefix}last_activity_at < ? OR ${prefix}last_activity_at > ? OR julianday(${prefix}last_activity_at) IS NULL)`,
    );
    parameters.push(
      new Date(at - activityTimeoutMs).toISOString(),
      new Date(at).toISOString(),
    );
  }
  return { clauses, parameters };
}

function validateLeaseTtl(ttlSeconds: number): void {
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > MAX_LEASE_SECONDS
  ) {
    throw new CoordinationError(
      "invalid_input",
      `ttlSeconds must be an integer from 1-${MAX_LEASE_SECONDS}`,
    );
  }
}

function canonicalTargetRef(ref: string): string {
  assertSafeGitRef(ref);
  if (ref.startsWith("refs/")) {
    const branch = ref.slice("refs/heads/".length);
    if (!DIRECT_BRANCH_REF_PATTERN.test(ref) || !isValidBranchName(branch)) {
      throw new CoordinationError(
        "invalid_input",
        `Integration target must be a mutable Git ref: ${ref}`,
      );
    }
    return ref;
  }
  // Store callers do not have a workspace path with which to resolve aliases;
  // simple names are unambiguously local branches. The service layer performs
  // authoritative symbolic resolution before reaching this boundary.
  if (
    ref === "HEAD" ||
    ref === "@" ||
    !isValidBranchName(ref) ||
    /[\^~{}]/.test(ref) ||
    ref.includes("@{")
  ) {
    throw new CoordinationError(
      "invalid_input",
      `Integration target must be a mutable Git ref: ${ref}`,
    );
  }
  return `refs/heads/${ref}`;
}

function isValidBranchName(value: string): boolean {
  if (!BRANCH_ALIAS_PATTERN.test(value)) return false;
  if (
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    value.endsWith(".") ||
    value.endsWith("/") ||
    value.endsWith(".lock")
  ) {
    return false;
  }
  return value.split("/").every((component) => {
    return (
      component.length > 0 &&
      !component.startsWith(".") &&
      !component.endsWith(".")
    );
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseLeaseExpiry(
  lease: Pick<LeaseRow, "lease_id" | "expires_at">,
): number;
function parseLeaseExpiry(
  lease: Pick<LeaseRow, "lease_id" | "expires_at">,
  preserveInvalid: true,
): number | undefined;
function parseLeaseExpiry(
  lease: Pick<LeaseRow, "lease_id" | "expires_at">,
  preserveInvalid = false,
): number | undefined {
  const expiresAt = Date.parse(lease.expires_at);
  if (
    !Number.isFinite(expiresAt) ||
    new Date(expiresAt).toISOString() !== lease.expires_at
  ) {
    if (preserveInvalid) return undefined;
    throw new CoordinationError(
      "storage_error",
      "Stored lease expiry is invalid; coordination authority was preserved",
      {
        reason: "invalid_lease_expiry",
        leaseId: lease.lease_id,
      },
    );
  }
  return expiresAt;
}

function maintenanceCutoff(
  name: keyof CoordinationMaintenancePolicy,
  value: unknown,
  evaluatedAt: number,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CoordinationError(
      "invalid_input",
      `${name} must be an explicit ISO-8601 timestamp`,
    );
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new CoordinationError(
      "invalid_input",
      `${name} must be a canonical UTC ISO-8601 timestamp`,
    );
  }
  if (parsed >= evaluatedAt) {
    throw new CoordinationError(
      "invalid_input",
      `${name} must be earlier than the maintenance evaluation time`,
    );
  }
  return new Date(parsed).toISOString();
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function storePageLimit(limit: number): number {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_STORE_PAGE_RECORDS
  ) {
    throw new CoordinationError(
      "invalid_input",
      `page limit must be an integer from 1-${MAX_STORE_PAGE_RECORDS}`,
    );
  }
  return limit;
}

function rowPageAfter(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^[1-9][0-9]{0,15}$/.test(cursor)) {
    throw new CoordinationError(
      "invalid_input",
      "Collection cursor is invalid",
    );
  }
  const value = Number.parseInt(cursor, 10);
  if (!Number.isSafeInteger(value)) {
    throw new CoordinationError(
      "invalid_input",
      "Collection cursor is invalid",
    );
  }
  return value;
}

function messagePageCursor(createdAt: string, messageId: string): string {
  return Buffer.from(`${createdAt}\0${messageId}`, "utf8").toString(
    "base64url",
  );
}

function messagePageAfter(cursor: string | undefined): {
  createdAt: string;
  messageId: string;
} {
  if (cursor === undefined) return { createdAt: "", messageId: "" };
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(cursor)) {
    throw new CoordinationError(
      "invalid_input",
      "Collection cursor is invalid",
    );
  }
  let decoded: string;
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) throw new Error("invalid");
    decoded = bytes.toString("utf8");
  } catch {
    throw new CoordinationError(
      "invalid_input",
      "Collection cursor is invalid",
    );
  }
  const separator = decoded.indexOf("\0");
  if (separator < 1 || decoded.indexOf("\0", separator + 1) >= 0) {
    throw new CoordinationError(
      "invalid_input",
      "Collection cursor is invalid",
    );
  }
  const createdAt = decoded.slice(0, separator);
  const messageId = decoded.slice(separator + 1);
  const timestamp = Date.parse(createdAt);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== createdAt ||
    !MESSAGE_ID_PATTERN.test(messageId)
  ) {
    throw new CoordinationError(
      "invalid_input",
      "Collection cursor is invalid",
    );
  }
  return { createdAt, messageId };
}

function messageFromCombinedRow(
  row: CombinedMessageRow,
): MessageRecord | OperatorMessageRecord {
  if (row.message_kind === "owner") {
    return operatorMessageFromRow({
      message_id: row.message_id,
      recipient_agent_id: row.recipient_agent_id,
      body: row.body,
      created_at: row.created_at,
      acknowledged_at: row.acknowledged_at,
    });
  }
  if (!row.sender_agent_id) {
    throw new CoordinationError(
      "storage_error",
      `Stored message sender is invalid: ${row.message_id}`,
    );
  }
  return {
    messageId: row.message_id,
    senderAgentId: row.sender_agent_id,
    recipientAgentId: row.recipient_agent_id,
    body: row.body,
    ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
    createdAt: row.created_at,
    ...(row.acknowledged_at ? { acknowledgedAt: row.acknowledged_at } : {}),
  };
}

function sqliteContentionError(
  error: unknown,
  operation: string,
): CoordinationError | undefined {
  if (
    error instanceof Database.SqliteError &&
    /^(?:SQLITE_BUSY|SQLITE_LOCKED)(?:_|$)/.test(error.code)
  ) {
    return new CoordinationError(
      "conflict",
      "Coordination state is busy; retry the operation",
      { operation, sqliteCode: error.code },
    );
  }
  return undefined;
}

function runImmediateTransaction<T>(
  transaction: { immediate(): T },
  operation: string,
): T {
  try {
    return transaction.immediate();
  } catch (error) {
    throw sqliteContentionError(error, operation) ?? error;
  }
}

function persistenceTableColumns(
  database: Database.Database,
  table: PersistenceTable,
): Set<string> {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((row) => row.name));
}

function persistenceTableExists(
  database: Database.Database,
  table: PersistenceTable,
): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table),
  );
}

function persistenceTableIntroducedVersion(table: PersistenceTable): number {
  if (VERSION_FOUR_TABLES.has(table)) return 4;
  if (VERSION_THREE_TABLES.has(table)) return 3;
  return 0;
}

function legacyTableMayBeMissing(
  table: PersistenceTable,
  legacyVersion: number | undefined,
): boolean {
  return (
    legacyVersion !== undefined &&
    persistenceTableIntroducedVersion(table) > legacyVersion
  );
}

function assertKnownPersistenceSchema(
  database: Database.Database,
  legacyVersion?: number,
): void {
  for (const [table, expectedColumns] of Object.entries(
    PERSISTENCE_SCHEMA_COLUMNS,
  ) as Array<[PersistenceTable, readonly string[]]>) {
    if (
      legacyTableMayBeMissing(table, legacyVersion) &&
      !persistenceTableExists(database, table)
    ) {
      continue;
    }
    const actual = persistenceTableColumns(database, table);
    const allowedMissing = new Set(
      legacyVersion !== undefined ? (LEGACY_ADDITIVE_COLUMNS[table] ?? []) : [],
    );
    const missing = expectedColumns.filter(
      (column) => !actual.has(column) && !allowedMissing.has(column),
    );
    const unexpected = [...actual].filter(
      (column) => !expectedColumns.includes(column),
    );
    if (missing.length > 0 || unexpected.length > 0) {
      throw new CoordinationError(
        "storage_error",
        `Unsupported database schema for table ${table}`,
        { table, missing, unexpected },
      );
    }
  }
}

function assertPersistenceKeys(
  database: Database.Database,
  legacyVersion?: number,
): void {
  for (const [table, expectedPrimaryKey] of Object.entries(
    PERSISTENCE_PRIMARY_KEYS,
  ) as Array<[PersistenceTable, string]>) {
    if (
      legacyTableMayBeMissing(table, legacyVersion) &&
      !persistenceTableExists(database, table)
    ) {
      continue;
    }
    const columns = database
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string; pk: number }>;
    const primaryKeys = columns
      .filter((column) => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((column) => column.name);
    if (primaryKeys.length !== 1 || primaryKeys[0] !== expectedPrimaryKey) {
      throw new CoordinationError(
        "storage_error",
        `Unsupported primary key for table ${table}`,
        { table, expectedPrimaryKey, actualPrimaryKeys: primaryKeys },
      );
    }
  }

  for (const table of Object.keys(
    PERSISTENCE_SCHEMA_COLUMNS,
  ) as PersistenceTable[]) {
    if (
      legacyTableMayBeMissing(table, legacyVersion) &&
      !persistenceTableExists(database, table)
    ) {
      continue;
    }
    const expected = new Set(
      (
        PERSISTENCE_FOREIGN_KEYS[
          table as keyof typeof PERSISTENCE_FOREIGN_KEYS
        ] ?? []
      ).map((entry) => entry.join("\0")),
    );
    const actual = new Set(
      (
        database.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
          from: string;
          table: string;
          to: string;
        }>
      ).map((entry) => [entry.from, entry.table, entry.to].join("\0")),
    );
    if (
      expected.size !== actual.size ||
      [...expected].some((entry) => !actual.has(entry))
    ) {
      throw new CoordinationError(
        "storage_error",
        `Unsupported foreign keys for table ${table}`,
        { table, expectedCount: expected.size, actualCount: actual.size },
      );
    }
  }
}

function assertCurrentPersistenceIndexes(
  database: Database.Database,
  allowLegacyMissingIndexes = false,
): void {
  for (const [
    table,
    indexName,
    unique,
    expectedColumns,
  ] of CURRENT_PERSISTENCE_INDEXES) {
    if (
      allowLegacyMissingIndexes &&
      (VERSION_THREE_TABLES.has(table as PersistenceTable) ||
        indexName === "idx_audit_events_cursor")
    ) {
      continue;
    }
    const indexes = database
      .prepare(`PRAGMA index_list(${table})`)
      .all() as Array<{
      name: string;
      unique: number;
    }>;
    const index = indexes.find((candidate) => candidate.name === indexName);
    const actualColumns = index
      ? (
          database.prepare(`PRAGMA index_info(${indexName})`).all() as Array<{
            name: string;
            seqno: number;
          }>
        )
          .sort((left, right) => left.seqno - right.seqno)
          .map((entry) => entry.name)
      : [];
    if (
      !index ||
      (index.unique === 1) !== unique ||
      actualColumns.length !== expectedColumns.length ||
      actualColumns.some(
        (column, position) => column !== expectedColumns[position],
      )
    ) {
      throw new CoordinationError(
        "storage_error",
        `Unsupported index ${indexName}`,
        {
          table,
          indexName,
          expectedUnique: unique,
          expectedColumns,
          actualColumns,
        },
      );
    }
  }
}

function inspectPersistenceSchema(
  database: Database.Database,
  allowEmpty: boolean,
): { version: number } {
  const version = database.pragma("user_version", { simple: true }) as number;
  if (version > COORDINATION_SCHEMA_VERSION) {
    throw new CoordinationError(
      "storage_error",
      `Database schema version ${version} is newer than supported version ${COORDINATION_SCHEMA_VERSION}`,
    );
  }
  const existingTables = new Set(
    (
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
  const knownTables = new Set(Object.keys(PERSISTENCE_SCHEMA_COLUMNS));
  const hasExistingSchema = [...knownTables].some((table) =>
    existingTables.has(table),
  );
  const unrelatedTables = [...existingTables].filter(
    (table) => !table.startsWith("sqlite_") && !knownTables.has(table),
  );
  if (unrelatedTables.length > 0) {
    throw new CoordinationError(
      "storage_error",
      "Database contains unsupported tables",
      { version, tables: unrelatedTables },
    );
  }
  if (
    !hasExistingSchema &&
    (!allowEmpty || version > 0 || unrelatedTables.length > 0)
  ) {
    throw new CoordinationError(
      "storage_error",
      "Database does not contain a recognized AgentConduit schema",
      { version, tables: unrelatedTables },
    );
  }
  if (version === COORDINATION_SCHEMA_VERSION) {
    assertKnownPersistenceSchema(database);
    assertPersistenceKeys(database);
    assertCurrentPersistenceIndexes(database);
  } else if (hasExistingSchema) {
    // Only the declared additive columns are a supported legacy upgrade.
    assertKnownPersistenceSchema(database, version);
    assertPersistenceKeys(database, version);
  }
  return { version };
}

function verifyDatabaseIntegrity(
  database: Database.Database,
  label: string,
): { quickCheck: "ok"; foreignKeyViolations: 0 } {
  const quickRows = database.pragma("quick_check(1)") as Array<
    Record<string, unknown>
  >;
  const quickValues = quickRows.flatMap((row) => Object.values(row));
  if (quickValues.length !== 1 || quickValues[0] !== "ok") {
    throw new CoordinationError(
      "storage_error",
      `${label} integrity verification failed`,
      { resultCount: quickValues.length },
    );
  }
  const foreignKeyRows = database.pragma("foreign_key_check") as Array<
    Record<string, unknown>
  >;
  if (foreignKeyRows.length > 0) {
    throw new CoordinationError(
      "storage_error",
      `${label} foreign-key verification failed`,
      { violationCount: foreignKeyRows.length },
    );
  }
  return { quickCheck: "ok", foreignKeyViolations: 0 };
}

async function createVerifiedDatabaseBackup(
  source: Database.Database,
  destinationPath: string,
  expectedSchemaVersion: number,
): Promise<CoordinationBackupResult> {
  if (!isAbsolute(destinationPath)) {
    throw new CoordinationError(
      "invalid_input",
      "Backup destination must be an absolute path",
    );
  }
  const destinationDirectory = dirname(destinationPath);
  const directoryStats = statSync(destinationDirectory);
  if (!directoryStats.isDirectory()) {
    throw new CoordinationError(
      "invalid_input",
      "Backup destination parent must be a directory",
    );
  }
  try {
    lstatSync(destinationPath);
    throw new CoordinationError(
      "conflict",
      "Backup destination already exists",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporaryDirectory = join(
    destinationDirectory,
    `.agentconduit-backup-${randomUUID()}`,
  );
  const temporaryPath = join(temporaryDirectory, "coordination.db");
  mkdirSync(temporaryDirectory, { mode: 0o700 });
  let pages = 0;
  try {
    const metadata = await source.backup(temporaryPath);
    pages = metadata.totalPages;
    if (process.platform !== "win32") chmodSync(temporaryPath, 0o600);
    const verification = new Database(temporaryPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      verifyDatabaseIntegrity(verification, "Backup");
      const inspected = inspectPersistenceSchema(verification, false);
      if (inspected.version !== expectedSchemaVersion) {
        throw new CoordinationError(
          "storage_error",
          "Backup schema verification failed",
          {
            schemaVersion: inspected.version,
            requiredVersion: expectedSchemaVersion,
          },
        );
      }
    } finally {
      verification.close();
    }
    try {
      linkSync(temporaryPath, destinationPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new CoordinationError(
          "conflict",
          "Backup destination already exists",
        );
      }
      if ((error as NodeJS.ErrnoException).code === "EXDEV") {
        throw new CoordinationError(
          "storage_error",
          "Backup destination filesystem does not support atomic linking",
        );
      }
      throw error;
    }
    return {
      destinationPath,
      pages,
      schemaVersion: expectedSchemaVersion,
      quickCheck: "ok",
      foreignKeyViolations: 0,
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function preflightCoordinationMigration(
  databasePath: string,
): CoordinationMigrationPreflight {
  if (!isAbsolute(databasePath)) {
    throw new CoordinationError(
      "invalid_input",
      "Database path must be absolute",
    );
  }
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const integrity = verifyDatabaseIntegrity(database, "Database");
    const inspected = inspectPersistenceSchema(database, false);
    return {
      databasePath,
      currentVersion: inspected.version,
      targetVersion: COORDINATION_SCHEMA_VERSION,
      migrationRequired: inspected.version !== COORDINATION_SCHEMA_VERSION,
      ...integrity,
    };
  } finally {
    database.close();
  }
}

export async function migrateCoordinationDatabase(
  databasePath: string,
  backupPath: string,
): Promise<CoordinationMigrationResult> {
  const preflight = preflightCoordinationMigration(databasePath);
  if (!preflight.migrationRequired) {
    throw new CoordinationError(
      "conflict",
      "Database schema is already current",
      { schemaVersion: preflight.currentVersion },
    );
  }
  const source = new Database(databasePath, { fileMustExist: true });
  let backup: CoordinationBackupResult;
  try {
    source.pragma("foreign_keys = ON");
    source.pragma("busy_timeout = 5000");
    const inspected = inspectPersistenceSchema(source, false);
    if (inspected.version !== preflight.currentVersion) {
      throw new CoordinationError(
        "conflict",
        "Database schema changed after migration preflight; retry",
      );
    }
    backup = await createVerifiedDatabaseBackup(
      source,
      backupPath,
      preflight.currentVersion,
    );
  } finally {
    source.close();
  }

  let store: CoordinationStore | undefined;
  try {
    store = new CoordinationStore(databasePath);
    const database = store.healthCheck();
    return {
      status: "migrated",
      databasePath,
      fromVersion: preflight.currentVersion,
      toVersion: COORDINATION_SCHEMA_VERSION,
      backup,
      database,
    };
  } finally {
    store?.close();
  }
}

function workspaceFromRow(row: WorkspaceRow): GitWorkspaceSnapshot {
  let upstream: GitWorkspaceSnapshot["upstream"];
  if (row.upstream_status === "available") {
    if (
      !row.upstream_ref ||
      !Number.isSafeInteger(row.ahead) ||
      row.ahead < 0 ||
      !Number.isSafeInteger(row.behind) ||
      row.behind < 0
    ) {
      throw new CoordinationError(
        "storage_error",
        `Invalid available upstream evidence for worktree ${row.worktree_id}`,
      );
    }
    upstream = {
      status: "available",
      ref: row.upstream_ref,
      ahead: row.ahead,
      behind: row.behind,
    };
  } else if (row.upstream_status === "unavailable") {
    upstream = {
      status: "unavailable",
      ...(row.upstream_ref ? { ref: row.upstream_ref } : {}),
    };
  } else {
    throw new CoordinationError(
      "storage_error",
      `Unknown upstream evidence status for worktree ${row.worktree_id}`,
    );
  }
  return {
    repositoryId: row.repository_id,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    worktreeId: row.worktree_id,
    rootPath: row.root_path,
    commonGitDir: row.common_git_dir,
    gitDir: row.git_dir,
    ...(row.remote_url ? { remoteUrl: row.remote_url } : {}),
    ...(row.branch ? { branch: row.branch } : {}),
    headOid: row.head_oid,
    dirty: row.dirty === 1,
    upstream,
    isBare: row.is_bare === 1,
    observedAt: row.observed_at,
  };
}

function deviceFromRow(
  row: DeviceRow,
  heartbeatTimeoutMs: number,
  at = Date.now(),
): DeviceRecord {
  const capabilities = parseJson<unknown>(row.capabilities_json, undefined);
  const health = parseJson<unknown>(row.health_json, undefined);
  if (
    !Array.isArray(capabilities) ||
    capabilities.some((entry) => typeof entry !== "string") ||
    !health ||
    typeof health !== "object"
  ) {
    throw new CoordinationError(
      "storage_error",
      `Stored device metadata is invalid: ${row.device_id}`,
    );
  }
  const last = Date.parse(row.last_seen_at);
  const age = Number.isFinite(last) ? at - last : Number.POSITIVE_INFINITY;
  const status = row.revoked_at
    ? "revoked"
    : age >= 0 && age <= heartbeatTimeoutMs
      ? "online"
      : "stale";
  return {
    deviceId: row.device_id,
    name: row.name,
    platform: row.platform,
    architecture: row.architecture,
    nodeVersion: row.node_version,
    capabilities: capabilities as string[],
    health: health as DeviceHealth,
    status,
    enrolledAt: row.enrolled_at,
    lastSeenAt: row.last_seen_at,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  };
}

function operatorMessageFromRow(
  row: OperatorMessageRow,
): OperatorMessageRecord {
  return {
    messageId: row.message_id,
    senderAgentId: "owner",
    senderKind: "owner",
    recipientAgentId: row.recipient_agent_id,
    body: row.body,
    createdAt: row.created_at,
    ...(row.acknowledged_at ? { acknowledgedAt: row.acknowledged_at } : {}),
  };
}

function reconciliationFromRow(row: ReconciliationRow): ReconciliationCase {
  const leaseIds = parseJson<unknown>(row.lease_ids_json, undefined);
  const claimedIntegrationIds = parseJson<unknown>(
    row.claimed_integration_ids_json,
    undefined,
  );
  if (
    !Array.isArray(leaseIds) ||
    leaseIds.some((entry) => typeof entry !== "string") ||
    !Array.isArray(claimedIntegrationIds) ||
    claimedIntegrationIds.some((entry) => typeof entry !== "string")
  ) {
    throw new CoordinationError(
      "storage_error",
      `Stored reconciliation evidence is invalid: ${row.reconciliation_id}`,
    );
  }
  return {
    reconciliationId: row.reconciliation_id,
    agentId: row.agent_id,
    reason: row.reason,
    status: row.status,
    leaseIds: leaseIds as string[],
    claimedIntegrationIds: claimedIntegrationIds as string[],
    createdAt: row.created_at,
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
  };
}

function auditEventFromRow(row: AuditEventRow): AuditEventRecord {
  const metadata = parseJson<unknown>(row.metadata_json, undefined);
  if (
    !Number.isSafeInteger(row.event_cursor) ||
    row.event_cursor < 1 ||
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  ) {
    throw new CoordinationError(
      "storage_error",
      `Stored audit event is invalid: ${row.event_id}`,
    );
  }
  return {
    cursor: row.event_cursor,
    eventId: row.event_id,
    eventType: row.event_type,
    ...(row.actor_agent_id ? { actorAgentId: row.actor_agent_id } : {}),
    ...(row.resource_id ? { resourceId: row.resource_id } : {}),
    metadata: metadata as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

function jobFromRow(
  row: JobRow,
  activityTimeoutMs: number,
  at = Date.now(),
): JobRecord {
  const status = jobStatus(row.status, row.job_id);
  const lastActivity = Date.parse(row.last_activity_at);
  const terminal = TERMINAL_JOB_STATUSES.has(status);
  if (
    !JOB_ID_PATTERN.test(row.job_id) ||
    !Number.isSafeInteger(row.last_event_cursor) ||
    row.last_event_cursor < 1 ||
    !Number.isSafeInteger(row.last_event_sequence) ||
    row.last_event_sequence < 1 ||
    !Number.isFinite(lastActivity) ||
    (terminal && !row.completed_at) ||
    (!terminal && row.completed_at !== null)
  ) {
    throw new CoordinationError(
      "storage_error",
      `Stored job is invalid: ${row.job_id}`,
    );
  }
  const age = at - lastActivity;
  const activity: JobActivity = terminal
    ? "terminal"
    : age >= 0 && age <= activityTimeoutMs
      ? "active"
      : "stale";
  return {
    jobId: row.job_id,
    ownerAgentId: row.owner_agent_id,
    repositoryId: row.repository_id,
    worktreeId: row.worktree_id,
    kind: row.kind,
    displayName: row.display_name,
    ...(row.parent_job_id ? { parentJobId: row.parent_job_id } : {}),
    ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
    status,
    activity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    lastEventCursor: row.last_event_cursor,
    lastEventSequence: row.last_event_sequence,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

function jobEventFromRow(row: JobEventRow): JobEventRecord {
  const type = jobEventType(row.event_type, row.event_id);
  const status = jobStatus(row.resulting_status, row.event_id);
  if (
    !Number.isSafeInteger(row.event_cursor) ||
    row.event_cursor < 1 ||
    !Number.isSafeInteger(row.event_sequence) ||
    row.event_sequence < 1 ||
    (type === "created" && status !== "queued") ||
    (type === "completed" && status !== "succeeded") ||
    (type === "failed" && status !== "failed") ||
    (type === "cancelled" && status !== "cancelled")
  ) {
    throw new CoordinationError(
      "storage_error",
      `Stored job event is invalid: ${row.event_id}`,
    );
  }
  return {
    eventId: row.event_id,
    jobId: row.job_id,
    cursor: row.event_cursor,
    sequence: row.event_sequence,
    type,
    status,
    ...(row.phase ? { phase: row.phase } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.operation ? { operation: row.operation } : {}),
    createdAt: row.created_at,
  };
}

export class CoordinationStore {
  readonly db: Database.Database;
  readonly databasePath: string;
  private _heartbeatTimeoutMs: number;
  private _deviceHeartbeatTimeoutMs: number;
  private _jobActivityTimeoutMs: number;

  constructor(
    databasePath = ":memory:",
    options: CoordinationStoreOptions = {},
  ) {
    this._heartbeatTimeoutMs = heartbeatTimeout(options.heartbeatTimeoutMs);
    this._deviceHeartbeatTimeoutMs = deviceHeartbeatTimeout(
      options.deviceHeartbeatTimeoutMs,
    );
    this._jobActivityTimeoutMs = jobActivityTimeout(
      options.jobActivityTimeoutMs,
    );
    this.databasePath = databasePath;
    this.db = new Database(
      databasePath,
      options.migrations === "require-current" && databasePath !== ":memory:"
        ? { fileMustExist: true }
        : undefined,
    );
    try {
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("busy_timeout = 5000");
      if (options.migrations === "require-current") {
        const version = this.db.pragma("user_version", {
          simple: true,
        }) as number;
        if (version !== COORDINATION_SCHEMA_VERSION) {
          throw new CoordinationError(
            "storage_error",
            `Database schema version ${version} requires an explicit migration to ${COORDINATION_SCHEMA_VERSION}`,
            {
              currentVersion: version,
              requiredVersion: COORDINATION_SCHEMA_VERSION,
              action: "run_production_migration",
            },
          );
        }
        inspectPersistenceSchema(this.db, false);
      }
      this.migrate();
      this.db.pragma("journal_mode = WAL");
    } catch (error) {
      this.db.close();
      if (
        error instanceof CoordinationError &&
        error.code === "conflict" &&
        typeof error.details?.sqliteCode === "string" &&
        /^(?:SQLITE_BUSY|SQLITE_LOCKED)(?:_|$)/.test(error.details.sqliteCode)
      ) {
        throw new CoordinationError(
          "conflict",
          "Coordination state is busy; retry the operation",
          { operation: "storage.open", sqliteCode: error.details.sqliteCode },
        );
      }
      throw sqliteContentionError(error, "storage.open") ?? error;
    }
  }

  close(): void {
    this.db.close();
  }

  get heartbeatTimeoutMs(): number {
    return this._heartbeatTimeoutMs;
  }

  setHeartbeatTimeoutMs(value: number): void {
    this._heartbeatTimeoutMs = heartbeatTimeout(value);
  }

  get deviceHeartbeatTimeoutMs(): number {
    return this._deviceHeartbeatTimeoutMs;
  }

  setDeviceHeartbeatTimeoutMs(value: number): void {
    this._deviceHeartbeatTimeoutMs = deviceHeartbeatTimeout(value);
  }

  get jobActivityTimeoutMs(): number {
    return this._jobActivityTimeoutMs;
  }

  setJobActivityTimeoutMs(value: number): void {
    this._jobActivityTimeoutMs = jobActivityTimeout(value);
  }

  healthCheck(): CoordinationStoreHealth {
    const integrity = verifyDatabaseIntegrity(this.db, "Database");
    const schemaVersion = this.db.pragma("user_version", {
      simple: true,
    }) as number;
    if (schemaVersion !== COORDINATION_SCHEMA_VERSION) {
      throw new CoordinationError(
        "storage_error",
        `Database schema version ${schemaVersion} is not current`,
        { schemaVersion, requiredVersion: COORDINATION_SCHEMA_VERSION },
      );
    }
    const journalMode = String(
      this.db.pragma("journal_mode", { simple: true }),
    ).toLowerCase();
    return {
      status: "ok",
      schemaVersion,
      journalMode,
      ...integrity,
    };
  }

  /**
   * Create and verify a consistent online SQLite backup. The destination must
   * not exist; a same-directory temporary file is linked into place only
   * after verification, so retries never overwrite operator data.
   */
  async backupTo(destinationPath: string): Promise<CoordinationBackupResult> {
    return await createVerifiedDatabaseBackup(
      this.db,
      destinationPath,
      COORDINATION_SCHEMA_VERSION,
    );
  }

  private migrate(): void {
    const { version } = inspectPersistenceSchema(this.db, true);
    if (version === COORDINATION_SCHEMA_VERSION) {
      return;
    }
    const transaction = this.db.transaction(() => {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        worktree_id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        project_id TEXT,
        root_path TEXT NOT NULL,
        common_git_dir TEXT NOT NULL,
        git_dir TEXT NOT NULL,
        remote_url TEXT,
        branch TEXT,
        head_oid TEXT NOT NULL,
        dirty INTEGER NOT NULL,
        upstream_status TEXT NOT NULL DEFAULT 'unavailable',
        upstream_ref TEXT,
        ahead INTEGER NOT NULL,
        behind INTEGER NOT NULL,
        is_bare INTEGER NOT NULL,
        observed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workspaces_repository ON workspaces(repository_id);

      CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY,
        runtime TEXT NOT NULL,
        display_name TEXT,
        session_key TEXT NOT NULL,
        session_secret_hash TEXT,
        workspace_id TEXT NOT NULL REFERENCES workspaces(worktree_id),
        capabilities_json TEXT NOT NULL,
        last_heartbeat TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        unregistered_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_session_workspace
        ON agents(session_key, workspace_id);
      CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id);

      CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        sender_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
        recipient_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
        body TEXT NOT NULL,
        correlation_id TEXT,
        created_at TEXT NOT NULL,
        acknowledged_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_inbox
        ON messages(recipient_agent_id, acknowledged_at, created_at);

      CREATE TABLE IF NOT EXISTS lease_counters (
        resource TEXT PRIMARY KEY,
        next_token INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS leases (
        lease_id TEXT PRIMARY KEY,
        resource TEXT NOT NULL,
        holder_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
        fencing_token INTEGER NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_leases_resource ON leases(resource);

      CREATE TABLE IF NOT EXISTS integration_requests (
        request_id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        source_oid TEXT NOT NULL,
        target_ref TEXT NOT NULL,
        observed_target_oid TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_by TEXT NOT NULL REFERENCES agents(agent_id),
        claimed_by TEXT REFERENCES agents(agent_id),
        lease_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        result_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_integrations_queue
        ON integration_requests(repository_id, target_ref, created_at);

      CREATE TABLE IF NOT EXISTS audit_events (
        event_id TEXT PRIMARY KEY,
        event_cursor INTEGER,
        event_type TEXT NOT NULL,
        actor_agent_id TEXT,
        resource_id TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS event_sequence (
        id INTEGER PRIMARY KEY,
        next_cursor INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        owner_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
        repository_id TEXT NOT NULL,
        worktree_id TEXT NOT NULL REFERENCES workspaces(worktree_id),
        kind TEXT NOT NULL,
        display_name TEXT NOT NULL,
        parent_job_id TEXT REFERENCES jobs(job_id) ON DELETE SET NULL,
        correlation_id TEXT,
        status TEXT NOT NULL,
        create_idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        last_event_cursor INTEGER NOT NULL,
        last_event_sequence INTEGER NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS job_events (
        event_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
        event_cursor INTEGER NOT NULL,
        event_sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        event_idempotency_key TEXT NOT NULL,
        resulting_status TEXT NOT NULL,
        phase TEXT,
        summary TEXT,
        operation TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        architecture TEXT NOT NULL,
        node_version TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        health_json TEXT NOT NULL,
        enrolled_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        revoked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS device_enrollments (
        enrollment_id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL,
        name_hint TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );

      CREATE TABLE IF NOT EXISTS workspace_devices (
        worktree_id TEXT PRIMARY KEY REFERENCES workspaces(worktree_id),
        device_id TEXT NOT NULL REFERENCES devices(device_id),
        path_label TEXT NOT NULL,
        registered_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS operator_messages (
        message_id TEXT PRIMARY KEY,
        recipient_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        acknowledged_at TEXT
      );

      CREATE TABLE IF NOT EXISTS reconciliations (
        reconciliation_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(agent_id),
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        lease_ids_json TEXT NOT NULL,
        claimed_integration_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      `);
      const workspaceColumns = persistenceTableColumns(this.db, "workspaces");
      if (!workspaceColumns.has("project_id")) {
        this.db.exec("ALTER TABLE workspaces ADD COLUMN project_id TEXT");
      }
      if (!workspaceColumns.has("upstream_status")) {
        this.db.exec(
          "ALTER TABLE workspaces ADD COLUMN upstream_status TEXT NOT NULL DEFAULT 'unavailable'",
        );
      }
      if (!workspaceColumns.has("upstream_ref")) {
        this.db.exec("ALTER TABLE workspaces ADD COLUMN upstream_ref TEXT");
      }
      const agentColumns = persistenceTableColumns(this.db, "agents");
      if (!agentColumns.has("session_secret_hash")) {
        this.db.exec("ALTER TABLE agents ADD COLUMN session_secret_hash TEXT");
      }
      const auditColumns = persistenceTableColumns(this.db, "audit_events");
      if (!auditColumns.has("event_cursor")) {
        this.db.exec(
          "ALTER TABLE audit_events ADD COLUMN event_cursor INTEGER",
        );
      }
      this.db.exec(`
        UPDATE audit_events SET event_cursor = rowid WHERE event_cursor IS NULL;
        INSERT INTO event_sequence(id, next_cursor)
          VALUES (1, COALESCE((SELECT MAX(event_cursor) + 1 FROM audit_events), 1))
          ON CONFLICT(id) DO UPDATE SET next_cursor = MAX(
            event_sequence.next_cursor,
            COALESCE((SELECT MAX(event_cursor) + 1 FROM audit_events), 1)
          );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_events_cursor
          ON audit_events(event_cursor);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_owner_idempotency
          ON jobs(owner_agent_id, create_idempotency_key);
        CREATE INDEX IF NOT EXISTS idx_jobs_repository_status_activity
          ON jobs(repository_id, status, last_activity_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_job_events_sequence
          ON job_events(job_id, event_sequence);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_job_events_idempotency
          ON job_events(job_id, event_idempotency_key);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_job_events_cursor
          ON job_events(event_cursor);
        CREATE INDEX IF NOT EXISTS idx_job_events_job_cursor
          ON job_events(job_id, event_cursor);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_token_hash
          ON devices(token_hash);
        CREATE INDEX IF NOT EXISTS idx_devices_last_seen
          ON devices(last_seen_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_device_enrollments_code_hash
          ON device_enrollments(code_hash);
        CREATE INDEX IF NOT EXISTS idx_operator_messages_inbox
          ON operator_messages(recipient_agent_id, acknowledged_at, created_at);
        CREATE INDEX IF NOT EXISTS idx_reconciliations_agent_status
          ON reconciliations(agent_id, status, created_at);
      `);
      assertKnownPersistenceSchema(this.db);
      assertPersistenceKeys(this.db);
      assertCurrentPersistenceIndexes(this.db);
      this.db.pragma(`user_version = ${COORDINATION_SCHEMA_VERSION}`);
    });
    runImmediateTransaction(transaction, "storage.migrate");
  }

  private audit(
    eventType: string,
    actorAgentId: string | undefined,
    resourceId: string | undefined,
    metadata: Record<string, unknown> = {},
  ): AuditEventRecord {
    const sequence = this.db
      .prepare("SELECT next_cursor FROM event_sequence WHERE id = 1")
      .get() as { next_cursor: number } | undefined;
    if (!sequence || !Number.isSafeInteger(sequence.next_cursor)) {
      throw new CoordinationError(
        "storage_error",
        "Audit event sequence is unavailable",
      );
    }
    const cursor = sequence.next_cursor;
    const eventId = randomUUID();
    const createdAt = nowIso();
    this.db
      .prepare("UPDATE event_sequence SET next_cursor = ? WHERE id = 1")
      .run(cursor + 1);
    this.db
      .prepare(
        `INSERT INTO audit_events
          (event_id, event_cursor, event_type, actor_agent_id, resource_id, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        cursor,
        eventType,
        actorAgentId ?? null,
        resourceId ?? null,
        JSON.stringify(metadata),
        createdAt,
      );
    return {
      cursor,
      eventId,
      eventType,
      ...(actorAgentId ? { actorAgentId } : {}),
      ...(resourceId ? { resourceId } : {}),
      metadata,
      createdAt,
    };
  }

  /** Persist a cursor-addressable owner or system event without secret data. */
  recordAuditEvent(
    eventType: string,
    resourceId?: string,
    metadata: Record<string, unknown> = {},
  ): AuditEventRecord {
    const normalizedType = boundedText("eventType", eventType, 128);
    const normalizedResource = resourceId
      ? boundedText("resourceId", resourceId, 512)
      : undefined;
    const transaction = this.db.transaction(() =>
      this.audit(normalizedType, undefined, normalizedResource, metadata),
    );
    return runImmediateTransaction(transaction, "audit.record");
  }

  latestAuditCursor(): number {
    const row = this.db
      .prepare("SELECT next_cursor FROM event_sequence WHERE id = 1")
      .get() as { next_cursor: number } | undefined;
    if (!row || !Number.isSafeInteger(row.next_cursor)) {
      throw new CoordinationError(
        "storage_error",
        "Audit event sequence is unavailable",
      );
    }
    return row.next_cursor - 1;
  }

  auditCursorBounds(): { earliest: number; latest: number } {
    const latest = this.latestAuditCursor();
    const row = this.db
      .prepare("SELECT MIN(event_cursor) AS earliest FROM audit_events")
      .get() as { earliest: number | null };
    return { earliest: row.earliest ?? latest + 1, latest };
  }

  listAuditEvents(afterCursor = 0, limit = 100): AuditEventRecord[] {
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
      throw new CoordinationError(
        "invalid_input",
        "afterCursor must be a non-negative safe integer",
      );
    }
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_AUDIT_PAGE_SIZE
    ) {
      throw new CoordinationError(
        "invalid_input",
        `limit must be an integer from 1-${MAX_AUDIT_PAGE_SIZE}`,
      );
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM audit_events WHERE event_cursor > ?
         ORDER BY event_cursor LIMIT ?`,
      )
      .all(afterCursor, limit) as AuditEventRow[];
    return rows.map(auditEventFromRow);
  }

  private jobRow(jobId: string): JobRow {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE job_id = ?")
      .get(jobId) as JobRow | undefined;
    if (!row) {
      throw new CoordinationError("not_found", `Job not found: ${jobId}`);
    }
    return row;
  }

  private jobEventRow(eventId: string): JobEventRow {
    const row = this.db
      .prepare("SELECT * FROM job_events WHERE event_id = ?")
      .get(eventId) as JobEventRow | undefined;
    if (!row) {
      throw new CoordinationError(
        "storage_error",
        `Stored job event is unavailable: ${eventId}`,
      );
    }
    return row;
  }

  private authenticatedJobRow(
    agentId: string,
    sessionToken: string,
    jobId: string,
  ): JobRow {
    const row = this.jobRow(jobId);
    this.agentInRepository(agentId, row.repository_id, sessionToken);
    return row;
  }

  createJob(
    ownerAgentId: string,
    sessionToken: string,
    input: JobCreateInput,
  ): JobRecord {
    const normalized = normalizedJobCreateInput(input);
    const transaction = this.db.transaction(() => {
      const owner = this.authenticatedAgentInTransaction(
        ownerAgentId,
        sessionToken,
      );
      const ownerWorkspace = this.workspace(owner.workspace_id);
      const existing = this.db
        .prepare(
          `SELECT * FROM jobs
           WHERE owner_agent_id = ? AND create_idempotency_key = ?`,
        )
        .get(ownerAgentId, normalized.idempotencyKey) as JobRow | undefined;
      if (existing) {
        const matches =
          existing.repository_id === ownerWorkspace.repositoryId &&
          existing.worktree_id === owner.workspace_id &&
          existing.kind === normalized.kind &&
          existing.display_name === normalized.displayName &&
          existing.parent_job_id === (normalized.parentJobId ?? null) &&
          existing.correlation_id === (normalized.correlationId ?? null);
        if (!matches) {
          throw new CoordinationError(
            "conflict",
            "Job creation idempotency key was already used with different input",
            { jobId: existing.job_id },
          );
        }
        return jobFromRow(existing, this._jobActivityTimeoutMs);
      }
      if (normalized.parentJobId) {
        const parent = this.jobRow(normalized.parentJobId);
        if (parent.repository_id !== ownerWorkspace.repositoryId) {
          throw new CoordinationError(
            "forbidden",
            "Parent job belongs to another repository",
          );
        }
      }

      const jobId = `job_${randomUUID().replaceAll("-", "")}`;
      const event = this.audit("job.event.created", ownerAgentId, jobId, {
        repositoryId: ownerWorkspace.repositoryId,
        worktreeId: owner.workspace_id,
        kind: normalized.kind,
        eventType: "created",
        status: "queued",
        sequence: 1,
      });
      this.db
        .prepare(
          `INSERT INTO jobs
            (job_id, owner_agent_id, repository_id, worktree_id, kind, display_name,
             parent_job_id, correlation_id, status, create_idempotency_key,
             created_at, updated_at, last_activity_at, last_event_cursor,
             last_event_sequence, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, 1, NULL)`,
        )
        .run(
          jobId,
          ownerAgentId,
          ownerWorkspace.repositoryId,
          owner.workspace_id,
          normalized.kind,
          normalized.displayName,
          normalized.parentJobId ?? null,
          normalized.correlationId ?? null,
          normalized.idempotencyKey,
          event.createdAt,
          event.createdAt,
          event.createdAt,
          event.cursor,
        );
      this.db
        .prepare(
          `INSERT INTO job_events
            (event_id, job_id, event_cursor, event_sequence, event_type,
             event_idempotency_key, resulting_status, phase, summary, operation,
             created_at)
           VALUES (?, ?, ?, 1, 'created', '__server_created__', 'queued', NULL, NULL, NULL, ?)`,
        )
        .run(event.eventId, jobId, event.cursor, event.createdAt);
      return jobFromRow(this.jobRow(jobId), this._jobActivityTimeoutMs);
    });
    return runImmediateTransaction(transaction, "job.create");
  }

  appendJobEvent(
    ownerAgentId: string,
    sessionToken: string,
    jobId: string,
    input: JobEventInput,
  ): JobEventRecord {
    const normalized = normalizedJobEventInput(input);
    const transaction = this.db.transaction(() => {
      this.authenticatedAgentInTransaction(ownerAgentId, sessionToken);
      const job = this.jobRow(jobId);
      if (job.owner_agent_id !== ownerAgentId) {
        throw new CoordinationError(
          "forbidden",
          "Only the job owner can append job events",
        );
      }
      const existing = this.db
        .prepare(
          `SELECT * FROM job_events
           WHERE job_id = ? AND event_idempotency_key = ?`,
        )
        .get(jobId, normalized.idempotencyKey) as JobEventRow | undefined;
      if (existing) {
        const matches =
          existing.event_type === normalized.type &&
          existing.phase === (normalized.phase ?? null) &&
          existing.summary === (normalized.summary ?? null) &&
          existing.operation === (normalized.operation ?? null);
        if (!matches) {
          throw new CoordinationError(
            "conflict",
            "Job event idempotency key was already used with different input",
            { eventId: existing.event_id, jobId },
          );
        }
        return jobEventFromRow(existing);
      }

      const currentStatus = jobStatus(job.status, job.job_id);
      const resultingStatus = nextJobStatus(currentStatus, normalized.type);
      const sequence = job.last_event_sequence + 1;
      if (!Number.isSafeInteger(sequence)) {
        throw new CoordinationError(
          "storage_error",
          "Job event sequence is exhausted",
          { jobId },
        );
      }
      const event = this.audit(
        `job.event.${normalized.type}`,
        ownerAgentId,
        jobId,
        {
          repositoryId: job.repository_id,
          eventType: normalized.type,
          status: resultingStatus,
          sequence,
          ...(normalized.phase ? { phase: normalized.phase } : {}),
          ...(normalized.summary ? { summary: normalized.summary } : {}),
          ...(normalized.operation ? { operation: normalized.operation } : {}),
        },
      );
      this.db
        .prepare(
          `INSERT INTO job_events
            (event_id, job_id, event_cursor, event_sequence, event_type,
             event_idempotency_key, resulting_status, phase, summary, operation,
             created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.eventId,
          jobId,
          event.cursor,
          sequence,
          normalized.type,
          normalized.idempotencyKey,
          resultingStatus,
          normalized.phase ?? null,
          normalized.summary ?? null,
          normalized.operation ?? null,
          event.createdAt,
        );
      this.db
        .prepare(
          `UPDATE jobs SET status = ?, updated_at = ?, last_activity_at = ?,
             last_event_cursor = ?, last_event_sequence = ?, completed_at = ?
           WHERE job_id = ?`,
        )
        .run(
          resultingStatus,
          event.createdAt,
          event.createdAt,
          event.cursor,
          sequence,
          TERMINAL_JOB_STATUSES.has(resultingStatus) ? event.createdAt : null,
          jobId,
        );
      return jobEventFromRow(this.jobEventRow(event.eventId));
    });
    return runImmediateTransaction(transaction, "job.event.append");
  }

  getJob(jobId: string): JobRecord {
    return jobFromRow(this.jobRow(jobId), this._jobActivityTimeoutMs);
  }

  getJobForAgent(
    agentId: string,
    sessionToken: string,
    jobId: string,
  ): JobRecord {
    return jobFromRow(
      this.authenticatedJobRow(agentId, sessionToken, jobId),
      this._jobActivityTimeoutMs,
    );
  }

  listJobs(repositoryId?: string, filter: JobListFilter = {}): JobRecord[] {
    const normalized = normalizedJobFilter(filter);
    const at = Date.now();
    const where: string[] = [];
    const parameters: Array<string | number> = [];
    if (repositoryId) {
      where.push("j.repository_id = ?");
      parameters.push(repositoryId);
    }
    const filtered = jobFilterSql(normalized, this._jobActivityTimeoutMs, at);
    where.push(...filtered.clauses);
    parameters.push(...filtered.parameters);
    const rows = this.db
      .prepare(
        `SELECT j.* FROM jobs j${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}
         ORDER BY j.rowid`,
      )
      .all(...parameters) as JobRow[];
    return rows.map((row) => jobFromRow(row, this._jobActivityTimeoutMs, at));
  }

  listJobsForAgent(
    agentId: string,
    sessionToken: string,
    filter: JobListFilter = {},
  ): JobRecord[] {
    const agent = this.authenticatedAgentInTransaction(agentId, sessionToken);
    const repositoryId = this.workspace(agent.workspace_id).repositoryId;
    return this.listJobs(repositoryId, filter);
  }

  listJobsPage(
    repositoryId?: string,
    filter: JobListFilter = {},
    cursor?: string,
    limit = MAX_STORE_PAGE_RECORDS,
  ): Array<StoreCursorItem<JobRecord>> {
    const normalized = normalizedJobFilter(filter);
    const after = rowPageAfter(cursor);
    const boundedLimit = storePageLimit(limit);
    const at = Date.now();
    const where = ["j.rowid > ?"];
    const parameters: Array<string | number> = [after];
    if (repositoryId) {
      where.push("j.repository_id = ?");
      parameters.push(repositoryId);
    }
    const filtered = jobFilterSql(normalized, this._jobActivityTimeoutMs, at);
    where.push(...filtered.clauses);
    parameters.push(...filtered.parameters, boundedLimit);
    const rows = this.db
      .prepare(
        `SELECT j.rowid AS page_rowid, j.* FROM jobs j
         WHERE ${where.join(" AND ")} ORDER BY j.rowid LIMIT ?`,
      )
      .all(...parameters) as Array<JobRow & RowPage>;
    return rows.map((row) => ({
      cursor: String(row.page_rowid),
      value: jobFromRow(row, this._jobActivityTimeoutMs, at),
    }));
  }

  listJobEvents(jobId: string, afterCursor = 0, limit = 100): JobEventRecord[] {
    this.jobRow(jobId);
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
      throw new CoordinationError(
        "invalid_input",
        "afterCursor must be a non-negative safe integer",
      );
    }
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_JOB_EVENT_PAGE_SIZE
    ) {
      throw new CoordinationError(
        "invalid_input",
        `limit must be an integer from 1-${MAX_JOB_EVENT_PAGE_SIZE}`,
      );
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM job_events
         WHERE job_id = ? AND event_cursor > ?
         ORDER BY event_cursor LIMIT ?`,
      )
      .all(jobId, afterCursor, limit) as JobEventRow[];
    return rows.map(jobEventFromRow);
  }

  listJobEventsForAgent(
    agentId: string,
    sessionToken: string,
    jobId: string,
    afterCursor = 0,
    limit = 100,
  ): JobEventRecord[] {
    this.authenticatedJobRow(agentId, sessionToken, jobId);
    return this.listJobEvents(jobId, afterCursor, limit);
  }

  private deviceRow(deviceId: string): DeviceRow {
    const row = this.db
      .prepare("SELECT * FROM devices WHERE device_id = ?")
      .get(deviceId) as DeviceRow | undefined;
    if (!row) {
      throw new CoordinationError("not_found", `Device not found: ${deviceId}`);
    }
    return row;
  }

  private authenticatedDeviceRow(deviceToken: string): DeviceRow {
    if (!/^acd_[0-9a-f]{64}$/.test(deviceToken)) {
      throw new CoordinationError("forbidden", "Device credential is invalid");
    }
    const row = this.db
      .prepare("SELECT * FROM devices WHERE token_hash = ?")
      .get(hashSession(deviceToken)) as DeviceRow | undefined;
    if (!row || row.revoked_at || !tokenMatches(deviceToken, row.token_hash)) {
      throw new CoordinationError("forbidden", "Device credential is invalid");
    }
    return row;
  }

  createDeviceEnrollment(
    options: { nameHint?: string; ttlSeconds?: number } = {},
  ): DeviceEnrollment {
    const ttlSeconds = options.ttlSeconds ?? 10 * 60;
    if (
      !Number.isInteger(ttlSeconds) ||
      ttlSeconds < 60 ||
      ttlSeconds > MAX_ENROLLMENT_TTL_SECONDS
    ) {
      throw new CoordinationError(
        "invalid_input",
        `ttlSeconds must be an integer from 60-${MAX_ENROLLMENT_TTL_SECONDS}`,
      );
    }
    const nameHint = options.nameHint
      ? boundedText("nameHint", options.nameHint, 128)
      : undefined;
    const enrollmentId = `enr_${randomUUID().replaceAll("-", "")}`;
    const enrollmentCode = issueEnrollmentCode();
    const createdAt = nowIso();
    const expiresAt = new Date(
      Date.parse(createdAt) + ttlSeconds * 1_000,
    ).toISOString();
    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO device_enrollments
            (enrollment_id, code_hash, name_hint, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          enrollmentId,
          hashSession(enrollmentCode),
          nameHint ?? null,
          createdAt,
          expiresAt,
        );
      this.audit("device.enrollment_created", undefined, enrollmentId, {
        expiresAt,
        ...(nameHint ? { nameHint } : {}),
      });
    });
    runImmediateTransaction(transaction, "device.enrollment.create");
    return { enrollmentId, enrollmentCode, createdAt, expiresAt };
  }

  enrollDevice(
    enrollmentCode: string,
    input: {
      name: string;
      platform: string;
      architecture: string;
      nodeVersion: string;
      capabilities?: readonly string[];
      health: DeviceHealth;
    },
  ): DeviceCredential {
    if (!/^ace_[0-9a-f]{48}$/.test(enrollmentCode)) {
      throw new CoordinationError(
        "forbidden",
        "Device enrollment code is invalid or expired",
      );
    }
    const name = boundedText("name", input.name, 128);
    const platform = boundedText("platform", input.platform, 64);
    const architecture = boundedText("architecture", input.architecture, 64);
    const nodeVersion = boundedText("nodeVersion", input.nodeVersion, 64);
    const capabilities = boundedCapabilities(input.capabilities ?? []);
    const health = validatedDeviceHealth(input.health);
    const deviceToken = issueDeviceToken();
    const deviceId = `dev_${randomUUID().replaceAll("-", "")}`;
    const transaction = this.db.transaction(() => {
      const enrollment = this.db
        .prepare("SELECT * FROM device_enrollments WHERE code_hash = ?")
        .get(hashSession(enrollmentCode)) as DeviceEnrollmentRow | undefined;
      const now = nowIso();
      if (
        !enrollment ||
        enrollment.used_at ||
        !Number.isFinite(Date.parse(enrollment.expires_at)) ||
        Date.parse(enrollment.expires_at) <= Date.parse(now)
      ) {
        throw new CoordinationError(
          "forbidden",
          "Device enrollment code is invalid or expired",
        );
      }
      this.db
        .prepare(
          `INSERT INTO devices
            (device_id, name, platform, architecture, node_version, token_hash,
             capabilities_json, health_json, enrolled_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          deviceId,
          name,
          platform,
          architecture,
          nodeVersion,
          hashSession(deviceToken),
          JSON.stringify(capabilities),
          JSON.stringify(health),
          now,
          now,
        );
      this.db
        .prepare(
          "UPDATE device_enrollments SET used_at = ? WHERE enrollment_id = ? AND used_at IS NULL",
        )
        .run(now, enrollment.enrollment_id);
      this.audit("device.enrolled", undefined, deviceId, {
        enrollmentId: enrollment.enrollment_id,
        name,
        platform,
        architecture,
        nodeVersion,
      });
    });
    runImmediateTransaction(transaction, "device.enroll");
    return {
      ...deviceFromRow(
        this.deviceRow(deviceId),
        this._deviceHeartbeatTimeoutMs,
      ),
      deviceToken,
    };
  }

  authenticateDevice(deviceToken: string): DeviceRecord {
    return deviceFromRow(
      this.authenticatedDeviceRow(deviceToken),
      this._deviceHeartbeatTimeoutMs,
    );
  }

  listDevices(includeRevoked = true): DeviceRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM devices ${includeRevoked ? "" : "WHERE revoked_at IS NULL"}
         ORDER BY enrolled_at`,
      )
      .all() as DeviceRow[];
    return rows.map((row) =>
      deviceFromRow(row, this._deviceHeartbeatTimeoutMs),
    );
  }

  listDevicesPage(
    includeRevoked = true,
    cursor?: string,
    limit = MAX_STORE_PAGE_RECORDS,
  ): Array<StoreCursorItem<DeviceRecord>> {
    const after = rowPageAfter(cursor);
    const boundedLimit = storePageLimit(limit);
    const rows = this.db
      .prepare(
        `SELECT rowid AS page_rowid, * FROM devices
         WHERE rowid > ?${includeRevoked ? "" : " AND revoked_at IS NULL"}
         ORDER BY rowid LIMIT ?`,
      )
      .all(after, boundedLimit) as Array<DeviceRow & RowPage>;
    return rows.map((row) => ({
      cursor: String(row.page_rowid),
      value: deviceFromRow(row, this._deviceHeartbeatTimeoutMs),
    }));
  }

  heartbeatDevice(
    deviceToken: string,
    input: {
      nodeVersion: string;
      capabilities?: readonly string[];
      health: DeviceHealth;
    },
  ): DeviceRecord {
    const row = this.authenticatedDeviceRow(deviceToken);
    const nodeVersion = boundedText("nodeVersion", input.nodeVersion, 64);
    const capabilities = boundedCapabilities(input.capabilities ?? []);
    const health = validatedDeviceHealth(input.health);
    const transaction = this.db.transaction(() => {
      // Recheck inside the write transaction so a concurrent revocation cannot
      // be converted back into fresh presence.
      const current = this.deviceRow(row.device_id);
      if (
        current.revoked_at ||
        !tokenMatches(deviceToken, current.token_hash)
      ) {
        throw new CoordinationError(
          "forbidden",
          "Device credential is invalid",
        );
      }
      const lastSeenAt = nowIso();
      this.db
        .prepare(
          `UPDATE devices SET node_version = ?, capabilities_json = ?,
             health_json = ?, last_seen_at = ? WHERE device_id = ? AND revoked_at IS NULL`,
        )
        .run(
          nodeVersion,
          JSON.stringify(capabilities),
          JSON.stringify(health),
          lastSeenAt,
          row.device_id,
        );
      this.audit("device.heartbeat", undefined, row.device_id, {
        nodeVersion,
        healthStatus: health.status,
      });
    });
    runImmediateTransaction(transaction, "device.heartbeat");
    return deviceFromRow(
      this.deviceRow(row.device_id),
      this._deviceHeartbeatTimeoutMs,
    );
  }

  revokeDevice(deviceId: string): DeviceRecord {
    if (!DEVICE_ID_PATTERN.test(deviceId)) {
      throw new CoordinationError("invalid_input", "deviceId is invalid");
    }
    const transaction = this.db.transaction(() => {
      const row = this.deviceRow(deviceId);
      if (row.revoked_at) return;
      const revokedAt = nowIso();
      this.db
        .prepare("UPDATE devices SET revoked_at = ? WHERE device_id = ?")
        .run(revokedAt, deviceId);
      this.audit("device.revoked", undefined, deviceId, {
        authorityPreserved: true,
      });
    });
    runImmediateTransaction(transaction, "device.revoke");
    return deviceFromRow(
      this.deviceRow(deviceId),
      this._deviceHeartbeatTimeoutMs,
    );
  }

  rotateDeviceCredential(deviceId: string): DeviceCredential {
    if (!DEVICE_ID_PATTERN.test(deviceId)) {
      throw new CoordinationError("invalid_input", "deviceId is invalid");
    }
    const deviceToken = issueDeviceToken();
    const transaction = this.db.transaction(() => {
      const row = this.deviceRow(deviceId);
      if (row.revoked_at) {
        throw new CoordinationError(
          "conflict",
          "A revoked device cannot rotate its credential",
        );
      }
      this.db
        .prepare("UPDATE devices SET token_hash = ? WHERE device_id = ?")
        .run(hashSession(deviceToken), deviceId);
      this.audit("device.credential_rotated", undefined, deviceId);
    });
    runImmediateTransaction(transaction, "device.credential.rotate");
    return {
      ...deviceFromRow(
        this.deviceRow(deviceId),
        this._deviceHeartbeatTimeoutMs,
      ),
      deviceToken,
    };
  }

  upsertRemoteWorkspace(
    deviceToken: string,
    snapshot: GitWorkspaceSnapshot,
    pathLabel: string,
  ): RemoteWorkspaceRecord {
    const device = this.authenticatedDeviceRow(deviceToken);
    if (!snapshot.projectId) {
      throw new CoordinationError(
        "invalid_input",
        "Remote workspaces require an explicit AgentConduit projectId",
      );
    }
    if (
      snapshot.repositoryId !== repositoryIdForProjectId(snapshot.projectId)
    ) {
      throw new CoordinationError(
        "invalid_input",
        "Remote repositoryId does not match projectId",
      );
    }
    if (!REMOTE_WORKTREE_ID_PATTERN.test(snapshot.worktreeId)) {
      throw new CoordinationError(
        "invalid_input",
        "Remote worktreeId is invalid",
      );
    }
    if (!/^[0-9a-f]{40,64}$/i.test(snapshot.headOid)) {
      throw new CoordinationError(
        "invalid_input",
        "Remote HEAD OID is invalid",
      );
    }
    const normalizedLabel = boundedText("pathLabel", pathLabel, 128);
    if (remoteUrlForHub(normalizedLabel) !== normalizedLabel) {
      throw new CoordinationError(
        "invalid_input",
        "Remote workspace path label may not be an absolute path",
      );
    }
    const observedAt = nowIso();
    const redactedRoot = `device://${device.device_id}/workspaces/${snapshot.worktreeId}`;
    const remoteUrl = remoteUrlForHub(snapshot.remoteUrl);
    const redactedSnapshot: GitWorkspaceSnapshot = {
      repositoryId: snapshot.repositoryId,
      projectId: snapshot.projectId,
      worktreeId: snapshot.worktreeId,
      rootPath: redactedRoot,
      commonGitDir: `device://${device.device_id}/repositories/${snapshot.repositoryId}`,
      gitDir: `${redactedRoot}/git`,
      ...(remoteUrl ? { remoteUrl } : {}),
      ...(snapshot.branch ? { branch: snapshot.branch } : {}),
      headOid: snapshot.headOid,
      dirty: snapshot.dirty,
      upstream: snapshot.upstream,
      isBare: snapshot.isBare,
      observedAt,
    };
    const transaction = this.db.transaction(() => {
      const current = this.deviceRow(device.device_id);
      if (
        current.revoked_at ||
        !tokenMatches(deviceToken, current.token_hash)
      ) {
        throw new CoordinationError(
          "forbidden",
          "Device credential is invalid",
        );
      }
      const existing = this.db
        .prepare("SELECT * FROM workspace_devices WHERE worktree_id = ?")
        .get(snapshot.worktreeId) as WorkspaceDeviceRow | undefined;
      if (existing && existing.device_id !== device.device_id) {
        throw new CoordinationError(
          "conflict",
          "Remote worktree identity is already registered to another device",
        );
      }
      this.upsertWorkspaceInTransaction(redactedSnapshot);
      this.db
        .prepare(
          `INSERT INTO workspace_devices(worktree_id, device_id, path_label, registered_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(worktree_id) DO UPDATE SET path_label = excluded.path_label`,
        )
        .run(
          snapshot.worktreeId,
          device.device_id,
          normalizedLabel,
          observedAt,
        );
      this.audit("workspace.remote_observed", undefined, snapshot.worktreeId, {
        deviceId: device.device_id,
        repositoryId: snapshot.repositoryId,
        pathLabel: normalizedLabel,
      });
    });
    runImmediateTransaction(transaction, "workspace.remote_upsert");
    const provenance = this.db
      .prepare("SELECT * FROM workspace_devices WHERE worktree_id = ?")
      .get(snapshot.worktreeId) as WorkspaceDeviceRow;
    return {
      workspace: redactedSnapshot,
      deviceId: provenance.device_id,
      pathLabel: provenance.path_label,
      registeredAt: provenance.registered_at,
    };
  }

  listRemoteWorkspaces(repositoryId?: string): RemoteWorkspaceRecord[] {
    const rows = (
      repositoryId
        ? this.db
            .prepare(
              `SELECT wd.* FROM workspace_devices wd
               JOIN workspaces w ON w.worktree_id = wd.worktree_id
               WHERE w.repository_id = ? ORDER BY wd.registered_at`,
            )
            .all(repositoryId)
        : this.db
            .prepare("SELECT * FROM workspace_devices ORDER BY registered_at")
            .all()
    ) as WorkspaceDeviceRow[];
    return rows.map((row) => ({
      workspace: this.workspace(row.worktree_id),
      deviceId: row.device_id,
      pathLabel: row.path_label,
      registeredAt: row.registered_at,
    }));
  }

  listRemoteWorkspacesPage(
    repositoryId?: string,
    cursor?: string,
    limit = MAX_STORE_PAGE_RECORDS,
  ): Array<StoreCursorItem<RemoteWorkspaceRecord>> {
    const after = rowPageAfter(cursor);
    const boundedLimit = storePageLimit(limit);
    const rows = (
      repositoryId
        ? this.db
            .prepare(
              `SELECT wd.rowid AS page_rowid, wd.* FROM workspace_devices wd
               JOIN workspaces w ON w.worktree_id = wd.worktree_id
               WHERE wd.rowid > ? AND w.repository_id = ?
               ORDER BY wd.rowid LIMIT ?`,
            )
            .all(after, repositoryId, boundedLimit)
        : this.db
            .prepare(
              `SELECT rowid AS page_rowid, * FROM workspace_devices
               WHERE rowid > ? ORDER BY rowid LIMIT ?`,
            )
            .all(after, boundedLimit)
    ) as Array<WorkspaceDeviceRow & RowPage>;
    return rows.map((row) => ({
      cursor: String(row.page_rowid),
      value: {
        workspace: this.workspace(row.worktree_id),
        deviceId: row.device_id,
        pathLabel: row.path_label,
        registeredAt: row.registered_at,
      },
    }));
  }

  verifyDeviceOwnsWorkspace(
    deviceToken: string,
    worktreeId: string,
  ): DeviceRecord {
    const device = this.authenticatedDeviceRow(deviceToken);
    const row = this.db
      .prepare("SELECT * FROM workspace_devices WHERE worktree_id = ?")
      .get(worktreeId) as WorkspaceDeviceRow | undefined;
    if (!row || row.device_id !== device.device_id) {
      throw new CoordinationError(
        "forbidden",
        "Workspace is not registered to the authenticated device",
      );
    }
    return deviceFromRow(device, this._deviceHeartbeatTimeoutMs);
  }

  verifyDeviceOwnsAgent(deviceToken: string, agentId: string): DeviceRecord {
    const agent = this.anyAgentRow(agentId);
    return this.verifyDeviceOwnsWorkspace(deviceToken, agent.workspace_id);
  }

  private upsertWorkspaceInTransaction(snapshot: GitWorkspaceSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO workspaces
          (worktree_id, repository_id, project_id, root_path, common_git_dir, git_dir, remote_url, branch,
           head_oid, dirty, upstream_status, upstream_ref, ahead, behind, is_bare, observed_at)
         VALUES (@worktreeId, @repositoryId, @projectId, @rootPath, @commonGitDir, @gitDir, @remoteUrl, @branch,
           @headOid, @dirty, @upstreamStatus, @upstreamRef, @ahead, @behind, @isBare, @observedAt)
         ON CONFLICT(worktree_id) DO UPDATE SET
           repository_id = excluded.repository_id,
           project_id = excluded.project_id,
           root_path = excluded.root_path,
           common_git_dir = excluded.common_git_dir,
           git_dir = excluded.git_dir,
           remote_url = excluded.remote_url,
           branch = excluded.branch,
           head_oid = excluded.head_oid,
           dirty = excluded.dirty,
           upstream_status = excluded.upstream_status,
           upstream_ref = excluded.upstream_ref,
           ahead = excluded.ahead,
           behind = excluded.behind,
           is_bare = excluded.is_bare,
           observed_at = excluded.observed_at`,
      )
      .run({
        worktreeId: snapshot.worktreeId,
        repositoryId: snapshot.repositoryId,
        projectId: snapshot.projectId ?? null,
        rootPath: snapshot.rootPath,
        commonGitDir: snapshot.commonGitDir,
        gitDir: snapshot.gitDir,
        remoteUrl: snapshot.remoteUrl ?? null,
        branch: snapshot.branch ?? null,
        headOid: snapshot.headOid,
        dirty: snapshot.dirty ? 1 : 0,
        upstreamStatus: snapshot.upstream.status,
        upstreamRef: snapshot.upstream.ref ?? null,
        ahead:
          snapshot.upstream.status === "available"
            ? snapshot.upstream.ahead
            : 0,
        behind:
          snapshot.upstream.status === "available"
            ? snapshot.upstream.behind
            : 0,
        isBare: snapshot.isBare ? 1 : 0,
        observedAt: snapshot.observedAt,
      });
  }

  upsertWorkspace(snapshot: GitWorkspaceSnapshot): void {
    const transaction = this.db.transaction(() => {
      this.upsertWorkspaceInTransaction(snapshot);
    });
    runImmediateTransaction(transaction, "workspace.upsert");
  }

  private workspace(worktreeId: string): GitWorkspaceSnapshot {
    const row = this.db
      .prepare("SELECT * FROM workspaces WHERE worktree_id = ?")
      .get(worktreeId) as WorkspaceRow | undefined;
    if (!row)
      throw new CoordinationError(
        "not_found",
        `Workspace not found: ${worktreeId}`,
      );
    return workspaceFromRow(row);
  }

  private agentRow(agentId: string): AgentRow {
    const row = this.db
      .prepare("SELECT * FROM agents WHERE agent_id = ?")
      .get(agentId) as AgentRow | undefined;
    if (!row || row.unregistered_at)
      throw new CoordinationError("not_found", `Agent not found: ${agentId}`);
    return row;
  }

  private anyAgentRow(agentId: string): AgentRow {
    const row = this.db
      .prepare("SELECT * FROM agents WHERE agent_id = ?")
      .get(agentId) as AgentRow | undefined;
    if (!row)
      throw new CoordinationError("not_found", `Agent not found: ${agentId}`);
    return row;
  }

  private agentFromRow(row: AgentRow, at = Date.now()): AgentRecord {
    const last = Date.parse(row.last_heartbeat);
    const age = Number.isFinite(last) ? at - last : Number.POSITIVE_INFINITY;
    const status: AgentStatus = row.unregistered_at
      ? "offline"
      : age >= 0 && age <= this._heartbeatTimeoutMs
        ? "online"
        : "stale";
    const capabilities = parseJson<string[]>(row.capabilities_json, []);
    return {
      agentId: row.agent_id,
      runtime: row.runtime,
      ...(row.display_name ? { displayName: row.display_name } : {}),
      workspace: this.workspace(row.workspace_id),
      capabilities,
      status,
      lastHeartbeat: row.last_heartbeat,
      registeredAt: row.registered_at,
      ...(row.unregistered_at ? { unregisteredAt: row.unregistered_at } : {}),
    };
  }

  private authenticatedAgentInTransaction(
    agentId: string,
    sessionToken: string,
  ): AgentRow {
    const agent = this.agentRow(agentId);
    if (!tokenMatches(sessionToken, agent.session_secret_hash)) {
      throw new CoordinationError(
        "forbidden",
        "Agent session token is invalid",
      );
    }
    return agent;
  }

  /** Authenticate a row even when it was explicitly unregistered. */
  private authenticatedAnyAgentInTransaction(
    agentId: string,
    sessionToken: string,
  ): AgentRow {
    const agent = this.anyAgentRow(agentId);
    if (!tokenMatches(sessionToken, agent.session_secret_hash)) {
      throw new CoordinationError(
        "forbidden",
        "Agent session token is invalid",
      );
    }
    return agent;
  }

  private agentInRepository(
    agentId: string,
    repositoryId: string,
    sessionToken: string,
  ): AgentRow {
    const agent = this.authenticatedAgentInTransaction(agentId, sessionToken);
    const workspace = this.workspace(agent.workspace_id);
    if (workspace.repositoryId !== repositoryId) {
      throw new CoordinationError(
        "forbidden",
        "Agent does not belong to the requested repository",
        { repositoryId },
      );
    }
    return agent;
  }

  private registrationFromRow(
    row: AgentRow,
    sessionToken: string,
  ): AgentRegistration {
    return { ...this.agentFromRow(row), sessionToken };
  }

  /** Verify a session token without returning or persisting its plaintext value. */
  verifyAgentSession(agentId: string, sessionToken: string): void {
    this.authenticatedAgentInTransaction(agentId, sessionToken);
  }

  registerAgent(input: {
    runtime: string;
    sessionRef?: string;
    sessionToken?: string;
    displayName?: string;
    capabilities?: string[];
    workspace: GitWorkspaceSnapshot;
  }): AgentRegistration {
    if (!input.runtime || input.runtime.length > 128) {
      throw new CoordinationError(
        "invalid_input",
        "runtime must be 1-128 characters",
      );
    }
    const sessionRef = input.sessionRef?.trim() || randomUUID();
    const sessionKey = hashSession(
      `${input.runtime}\0${sessionRef}\0${input.workspace.worktreeId}`,
    );
    const transaction = this.db.transaction(() => {
      const existing = this.db
        .prepare(
          "SELECT * FROM agents WHERE session_key = ? AND workspace_id = ?",
        )
        .get(sessionKey, input.workspace.worktreeId) as AgentRow | undefined;
      const now = nowIso();
      const sessionToken = issueSessionToken();
      const sessionSecretHash = hashSession(sessionToken);
      if (existing) {
        // Rows upgraded from the pre-token schema have no proof that the
        // caller owns the old session identity.  Never turn that absence of
        // proof into a takeover path: the caller must choose a new
        // sessionRef and explicitly re-enroll.
        if (!existing.session_secret_hash) {
          throw new CoordinationError(
            "forbidden",
            "This legacy session has no resumable token; re-enroll with a new sessionRef",
            {
              reason: "legacy_session_without_token",
              action: "re_enroll_with_new_session_ref",
            },
          );
        }
        if (
          !tokenMatches(input.sessionToken ?? "", existing.session_secret_hash)
        ) {
          throw new CoordinationError(
            "forbidden",
            "An existing session requires its previous sessionToken to reconnect",
          );
        }
        // Authenticate the existing session before accepting a fresh
        // server-observed workspace snapshot. A failed reconnect must not be
        // able to overwrite evidence attached to the live agent row.
        this.upsertWorkspaceInTransaction(input.workspace);
        this.db
          .prepare(
            `UPDATE agents SET runtime = ?, display_name = ?, capabilities_json = ?,
               session_secret_hash = ?, last_heartbeat = ?, unregistered_at = NULL WHERE agent_id = ?`,
          )
          .run(
            input.runtime,
            input.displayName ?? null,
            JSON.stringify(input.capabilities ?? []),
            sessionSecretHash,
            now,
            existing.agent_id,
          );
        this.audit(
          existing.unregistered_at ? "agent.reconnected" : "agent.updated",
          existing.agent_id,
          existing.agent_id,
          {
            runtime: input.runtime,
            worktreeId: input.workspace.worktreeId,
          },
        );
        return this.registrationFromRow(
          this.agentRow(existing.agent_id),
          sessionToken,
        );
      }
      this.upsertWorkspaceInTransaction(input.workspace);
      const agentId = `agt_${randomUUID().replaceAll("-", "")}`;
      this.db
        .prepare(
          `INSERT INTO agents
            (agent_id, runtime, display_name, session_key, session_secret_hash, workspace_id,
             capabilities_json, last_heartbeat, registered_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          agentId,
          input.runtime,
          input.displayName ?? null,
          sessionKey,
          sessionSecretHash,
          input.workspace.worktreeId,
          JSON.stringify(input.capabilities ?? []),
          now,
          now,
        );
      this.audit("agent.registered", agentId, agentId, {
        runtime: input.runtime,
        repositoryId: input.workspace.repositoryId,
        worktreeId: input.workspace.worktreeId,
      });
      return this.registrationFromRow(this.agentRow(agentId), sessionToken);
    });
    return runImmediateTransaction(transaction, "agent.register");
  }

  heartbeat(
    agentId: string,
    sessionToken: string,
    workspace: GitWorkspaceSnapshot,
  ): AgentRecord {
    const transaction = this.db.transaction(() => {
      const current = this.authenticatedAgentInTransaction(
        agentId,
        sessionToken,
      );
      if (current.workspace_id !== workspace.worktreeId) {
        throw new CoordinationError(
          "forbidden",
          "Heartbeat must use the agent's registered worktree; register a new session after switching worktrees",
          {
            registeredWorktreeId: current.workspace_id,
            requestedWorktreeId: workspace.worktreeId,
          },
        );
      }
      this.upsertWorkspaceInTransaction(workspace);
      const now = nowIso();
      this.db
        .prepare(
          "UPDATE agents SET workspace_id = ?, last_heartbeat = ? WHERE agent_id = ?",
        )
        .run(workspace.worktreeId, now, agentId);
      if (current.workspace_id !== workspace.worktreeId) {
        this.audit("agent.workspace_changed", agentId, agentId, {
          from: current.workspace_id,
          to: workspace.worktreeId,
        });
      }
      return this.agentFromRow(this.agentRow(agentId));
    });
    return runImmediateTransaction(transaction, "agent.heartbeat");
  }

  unregisterAgent(agentId: string, sessionToken: string): void {
    const transaction = this.db.transaction(() => {
      const existingAgent = this.authenticatedAnyAgentInTransaction(
        agentId,
        sessionToken,
      );
      if (existingAgent.unregistered_at) return;
      const authorityLeases = this.db
        .prepare(
          `SELECT DISTINCT l.* FROM leases l
           WHERE l.holder_agent_id = ?
              OR l.lease_id IN (
                SELECT lease_id FROM integration_requests
                WHERE claimed_by = ? AND status = 'claimed' AND lease_id IS NOT NULL
              )`,
        )
        .all(agentId, agentId) as LeaseRow[];
      for (const lease of authorityLeases) parseLeaseExpiry(lease);
      const now = nowIso();
      this.db
        .prepare("UPDATE agents SET unregistered_at = ? WHERE agent_id = ?")
        .run(now, agentId);
      const claimed = this.db
        .prepare(
          `SELECT request_id, lease_id FROM integration_requests
           WHERE claimed_by = ? AND status = 'claimed'`,
        )
        .all(agentId) as Array<{ request_id: string; lease_id: string | null }>;
      for (const request of claimed) {
        this.db
          .prepare(
            `UPDATE integration_requests SET status = 'needs_refresh', claimed_by = NULL,
               lease_id = NULL, updated_at = ? WHERE request_id = ?`,
          )
          .run(now, request.request_id);
        if (request.lease_id)
          this.db
            .prepare("DELETE FROM leases WHERE lease_id = ?")
            .run(request.lease_id);
        this.audit(
          "integration.claimant_unregistered",
          agentId,
          request.request_id,
        );
      }
      this.db
        .prepare("DELETE FROM leases WHERE holder_agent_id = ?")
        .run(agentId);
      this.audit("agent.unregistered", agentId, agentId);
    });
    runImmediateTransaction(transaction, "agent.unregister");
  }

  listAgents(
    repositoryId?: string,
    includeOffline = false,
    activeOnly = false,
  ): AgentRecord[] {
    const activeClause = includeOffline ? "" : " AND a.unregistered_at IS NULL";
    const rows = (
      repositoryId
        ? this.db
            .prepare(
              `SELECT a.* FROM agents a JOIN workspaces w ON w.worktree_id = a.workspace_id
             WHERE w.repository_id = ?${activeClause} ORDER BY a.registered_at`,
            )
            .all(repositoryId)
        : this.db
            .prepare(
              `SELECT * FROM agents WHERE 1 = 1${activeClause.replace("a.", "")} ORDER BY registered_at`,
            )
            .all()
    ) as AgentRow[];
    const agents = rows.map((row) => this.agentFromRow(row));
    return activeOnly
      ? agents.filter((agent) => agent.status === "online")
      : agents;
  }

  listAgentsPage(
    repositoryId?: string,
    includeOffline = false,
    activeOnly = false,
    cursor?: string,
    limit = MAX_STORE_PAGE_RECORDS,
  ): Array<StoreCursorItem<AgentRecord>> {
    const after = rowPageAfter(cursor);
    const boundedLimit = storePageLimit(limit);
    const at = Date.now();
    const activeAfter = new Date(at - this._heartbeatTimeoutMs).toISOString();
    const activeBefore = new Date(at).toISOString();
    const registeredClause =
      includeOffline && !activeOnly ? "" : " AND a.unregistered_at IS NULL";
    const activeClause = activeOnly
      ? " AND a.last_heartbeat >= ? AND a.last_heartbeat <= ?"
      : "";
    const query = repositoryId
      ? `SELECT a.rowid AS page_rowid, a.* FROM agents a
         JOIN workspaces w ON w.worktree_id = a.workspace_id
         WHERE a.rowid > ? AND w.repository_id = ?${registeredClause}${activeClause}
         ORDER BY a.rowid LIMIT ?`
      : `SELECT a.rowid AS page_rowid, a.* FROM agents a
         WHERE a.rowid > ?${registeredClause}${activeClause}
         ORDER BY a.rowid LIMIT ?`;
    const parameters: Array<string | number> = [after];
    if (repositoryId) parameters.push(repositoryId);
    if (activeOnly) parameters.push(activeAfter, activeBefore);
    parameters.push(boundedLimit);
    const rows = this.db.prepare(query).all(...parameters) as Array<
      AgentRow & RowPage
    >;
    return rows.map((row) => ({
      cursor: String(row.page_rowid),
      value: this.agentFromRow(row, at),
    }));
  }

  getAgent(agentId: string): AgentRecord {
    return this.agentFromRow(this.anyAgentRow(agentId));
  }

  listWorkspaces(repositoryId?: string): GitWorkspaceSnapshot[] {
    const rows = (
      repositoryId
        ? this.db
            .prepare(
              "SELECT * FROM workspaces WHERE repository_id = ? ORDER BY observed_at DESC",
            )
            .all(repositoryId)
        : this.db
            .prepare("SELECT * FROM workspaces ORDER BY observed_at DESC")
            .all()
    ) as WorkspaceRow[];
    return rows.map(workspaceFromRow);
  }

  sendMessage(
    input: {
      senderAgentId: string;
      recipientAgentId: string;
      body: string;
      correlationId?: string;
    },
    senderSessionToken: string,
  ): MessageRecord {
    const transaction = this.db.transaction(() => {
      const sender = this.authenticatedAgentInTransaction(
        input.senderAgentId,
        senderSessionToken,
      );
      const recipient = this.agentRow(input.recipientAgentId);
      const senderWorkspace = this.workspace(sender.workspace_id);
      const recipientWorkspace = this.workspace(recipient.workspace_id);
      if (senderWorkspace.repositoryId !== recipientWorkspace.repositoryId) {
        throw new CoordinationError(
          "forbidden",
          "Messages are limited to one repository scope",
        );
      }
      if (
        !input.body ||
        Buffer.byteLength(input.body, "utf8") > MAX_MESSAGE_BYTES
      ) {
        throw new CoordinationError(
          "invalid_input",
          `Message body must be 1-${MAX_MESSAGE_BYTES} bytes`,
        );
      }
      const messageId = `msg_${randomUUID().replaceAll("-", "")}`;
      const createdAt = nowIso();
      this.db
        .prepare(
          `INSERT INTO messages
            (message_id, sender_agent_id, recipient_agent_id, body, correlation_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          messageId,
          input.senderAgentId,
          input.recipientAgentId,
          input.body,
          input.correlationId ?? null,
          createdAt,
        );
      this.audit("message.sent", input.senderAgentId, messageId, {
        recipientAgentId: input.recipientAgentId,
        bytes: Buffer.byteLength(input.body, "utf8"),
      });
      return {
        messageId,
        senderAgentId: input.senderAgentId,
        recipientAgentId: input.recipientAgentId,
        body: input.body,
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        createdAt,
      };
    });
    return runImmediateTransaction(transaction, "message.send");
  }

  inbox(
    agentId: string,
    sessionToken: string,
    includeAcknowledged = false,
  ): MessageRecord[] {
    const transaction = this.db.transaction(() => {
      this.authenticatedAgentInTransaction(agentId, sessionToken);
      const rows = (
        includeAcknowledged
          ? this.db
              .prepare(
                "SELECT * FROM messages WHERE recipient_agent_id = ? ORDER BY created_at",
              )
              .all(agentId)
          : this.db
              .prepare(
                "SELECT * FROM messages WHERE recipient_agent_id = ? AND acknowledged_at IS NULL ORDER BY created_at",
              )
              .all(agentId)
      ) as MessageRow[];
      return rows.map((row) => ({
        messageId: row.message_id,
        senderAgentId: row.sender_agent_id,
        recipientAgentId: row.recipient_agent_id,
        body: row.body,
        ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
        createdAt: row.created_at,
        ...(row.acknowledged_at ? { acknowledgedAt: row.acknowledged_at } : {}),
      }));
    });
    return runImmediateTransaction(transaction, "message.inbox");
  }

  acknowledgeMessage(
    agentId: string,
    sessionToken: string,
    messageId: string,
  ): void {
    const transaction = this.db.transaction(() => {
      this.authenticatedAgentInTransaction(agentId, sessionToken);
      const result = this.db
        .prepare(
          "UPDATE messages SET acknowledged_at = ? WHERE message_id = ? AND recipient_agent_id = ?",
        )
        .run(nowIso(), messageId, agentId);
      if (result.changes === 0)
        throw new CoordinationError(
          "not_found",
          `Message not found: ${messageId}`,
        );
      this.audit("message.acknowledged", agentId, messageId);
    });
    runImmediateTransaction(transaction, "message.ack");
  }

  sendOperatorMessage(
    recipientAgentId: string,
    body: string,
  ): OperatorMessageRecord {
    const normalizedBody = typeof body === "string" ? body : "";
    if (
      !normalizedBody ||
      Buffer.byteLength(normalizedBody, "utf8") > MAX_MESSAGE_BYTES
    ) {
      throw new CoordinationError(
        "invalid_input",
        `Message body must be 1-${MAX_MESSAGE_BYTES} bytes`,
      );
    }
    const transaction = this.db.transaction(() => {
      this.agentRow(recipientAgentId);
      const messageId = `opm_${randomUUID().replaceAll("-", "")}`;
      const createdAt = nowIso();
      this.db
        .prepare(
          `INSERT INTO operator_messages
            (message_id, recipient_agent_id, body, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(messageId, recipientAgentId, normalizedBody, createdAt);
      this.audit("operator_message.sent", undefined, messageId, {
        recipientAgentId,
        bytes: Buffer.byteLength(normalizedBody, "utf8"),
      });
      return {
        messageId,
        senderAgentId: "owner" as const,
        senderKind: "owner" as const,
        recipientAgentId,
        body: normalizedBody,
        createdAt,
      };
    });
    return runImmediateTransaction(transaction, "operator_message.send");
  }

  operatorInbox(
    agentId: string,
    sessionToken: string,
    includeAcknowledged = false,
  ): OperatorMessageRecord[] {
    this.verifyAgentSession(agentId, sessionToken);
    const rows = (
      includeAcknowledged
        ? this.db
            .prepare(
              "SELECT * FROM operator_messages WHERE recipient_agent_id = ? ORDER BY created_at",
            )
            .all(agentId)
        : this.db
            .prepare(
              `SELECT * FROM operator_messages
               WHERE recipient_agent_id = ? AND acknowledged_at IS NULL
               ORDER BY created_at`,
            )
            .all(agentId)
    ) as OperatorMessageRow[];
    return rows.map(operatorMessageFromRow);
  }

  private combinedMessagesPage(
    recipientAgentId: string | undefined,
    includeAcknowledged: boolean,
    cursor: string | undefined,
    limit: number,
  ): Array<StoreCursorItem<MessageRecord | OperatorMessageRecord>> {
    const after = messagePageAfter(cursor);
    const boundedLimit = storePageLimit(limit);
    const acknowledgedClause = includeAcknowledged
      ? ""
      : " AND acknowledged_at IS NULL";
    const query = recipientAgentId
      ? `SELECT * FROM (
           SELECT 'agent' AS message_kind, message_id, sender_agent_id,
                  recipient_agent_id, body, correlation_id, created_at,
                  acknowledged_at
           FROM messages
           WHERE recipient_agent_id = ?${acknowledgedClause}
           UNION ALL
           SELECT 'owner' AS message_kind, message_id, NULL AS sender_agent_id,
                  recipient_agent_id, body, NULL AS correlation_id, created_at,
                  acknowledged_at
           FROM operator_messages
           WHERE recipient_agent_id = ?${acknowledgedClause}
         ) AS combined
         WHERE created_at > ? OR (created_at = ? AND message_id > ?)
         ORDER BY created_at, message_id LIMIT ?`
      : `SELECT * FROM (
           SELECT 'agent' AS message_kind, message_id, sender_agent_id,
                  recipient_agent_id, body, correlation_id, created_at,
                  acknowledged_at
           FROM messages
           UNION ALL
           SELECT 'owner' AS message_kind, message_id, NULL AS sender_agent_id,
                  recipient_agent_id, body, NULL AS correlation_id, created_at,
                  acknowledged_at
           FROM operator_messages
         ) AS combined
         WHERE created_at > ? OR (created_at = ? AND message_id > ?)
         ORDER BY created_at, message_id LIMIT ?`;
    const parameters: Array<string | number> = recipientAgentId
      ? [
          recipientAgentId,
          recipientAgentId,
          after.createdAt,
          after.createdAt,
          after.messageId,
          boundedLimit,
        ]
      : [after.createdAt, after.createdAt, after.messageId, boundedLimit];
    const rows = this.db
      .prepare(query)
      .all(...parameters) as CombinedMessageRow[];
    return rows.map((row) => ({
      cursor: messagePageCursor(row.created_at, row.message_id),
      value: messageFromCombinedRow(row),
    }));
  }

  inboxPage(
    agentId: string,
    sessionToken: string,
    includeAcknowledged = false,
    cursor?: string,
    limit = MAX_STORE_PAGE_RECORDS,
  ): Array<StoreCursorItem<MessageRecord | OperatorMessageRecord>> {
    const transaction = this.db.transaction(() => {
      this.authenticatedAgentInTransaction(agentId, sessionToken);
      return this.combinedMessagesPage(
        agentId,
        includeAcknowledged,
        cursor,
        limit,
      );
    });
    return runImmediateTransaction(transaction, "message.inbox_page");
  }

  listAllMessagesPage(
    cursor?: string,
    limit = MAX_STORE_PAGE_RECORDS,
  ): Array<StoreCursorItem<MessageRecord | OperatorMessageRecord>> {
    return this.combinedMessagesPage(undefined, true, cursor, limit);
  }

  acknowledgeOperatorMessage(
    agentId: string,
    sessionToken: string,
    messageId: string,
  ): void {
    const transaction = this.db.transaction(() => {
      this.authenticatedAgentInTransaction(agentId, sessionToken);
      const result = this.db
        .prepare(
          `UPDATE operator_messages SET acknowledged_at = ?
           WHERE message_id = ? AND recipient_agent_id = ?`,
        )
        .run(nowIso(), messageId, agentId);
      if (result.changes === 0) {
        throw new CoordinationError(
          "not_found",
          `Operator message not found: ${messageId}`,
        );
      }
      this.audit("operator_message.acknowledged", agentId, messageId);
    });
    runImmediateTransaction(transaction, "operator_message.ack");
  }

  listMessages(repositoryId?: string): MessageRecord[] {
    const rows = (
      repositoryId
        ? this.db
            .prepare(
              `SELECT m.* FROM messages m
               JOIN agents a ON a.agent_id = m.recipient_agent_id
               JOIN workspaces w ON w.worktree_id = a.workspace_id
               WHERE w.repository_id = ? ORDER BY m.created_at`,
            )
            .all(repositoryId)
        : this.db.prepare("SELECT * FROM messages ORDER BY created_at").all()
    ) as MessageRow[];
    return rows.map((row) => ({
      messageId: row.message_id,
      senderAgentId: row.sender_agent_id,
      recipientAgentId: row.recipient_agent_id,
      body: row.body,
      ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
      createdAt: row.created_at,
      ...(row.acknowledged_at ? { acknowledgedAt: row.acknowledged_at } : {}),
    }));
  }

  listOperatorMessages(repositoryId?: string): OperatorMessageRecord[] {
    const rows = (
      repositoryId
        ? this.db
            .prepare(
              `SELECT m.* FROM operator_messages m
               JOIN agents a ON a.agent_id = m.recipient_agent_id
               JOIN workspaces w ON w.worktree_id = a.workspace_id
               WHERE w.repository_id = ? ORDER BY m.created_at`,
            )
            .all(repositoryId)
        : this.db
            .prepare("SELECT * FROM operator_messages ORDER BY created_at")
            .all()
    ) as OperatorMessageRow[];
    return rows.map(operatorMessageFromRow);
  }

  private acquireLeaseInTransaction(
    transaction: Database.Transaction,
    resource: string,
    holderAgentId: string,
    ttlSeconds: number,
    reuseExistingHolder = true,
  ): LeaseRecord {
    if (!resource || resource.length > 512) {
      throw new CoordinationError(
        "invalid_input",
        "resource must be 1-512 characters",
      );
    }
    validateLeaseTtl(ttlSeconds);
    this.agentRow(holderAgentId);
    const now = new Date();
    const nowText = now.toISOString();
    const existing = this.db
      .prepare("SELECT * FROM leases WHERE resource = ?")
      .get(resource) as LeaseRow | undefined;
    if (existing && parseLeaseExpiry(existing) > now.getTime()) {
      if (existing.holder_agent_id !== holderAgentId || !reuseExistingHolder) {
        throw new CoordinationError(
          "conflict",
          `Lease is held for resource: ${resource}`,
          {
            resource,
            expiresAt: existing.expires_at,
          },
        );
      }
      const expiresAt = new Date(
        now.getTime() + ttlSeconds * 1000,
      ).toISOString();
      this.db
        .prepare(
          "UPDATE leases SET expires_at = ? WHERE lease_id = ? AND holder_agent_id = ?",
        )
        .run(expiresAt, existing.lease_id, holderAgentId);
      return {
        leaseId: existing.lease_id,
        resource,
        holderAgentId,
        fencingToken: existing.fencing_token,
        acquiredAt: existing.acquired_at,
        expiresAt,
      };
    }
    if (existing)
      this.db
        .prepare("DELETE FROM leases WHERE lease_id = ?")
        .run(existing.lease_id);
    const counter = this.db
      .prepare("SELECT next_token FROM lease_counters WHERE resource = ?")
      .get(resource) as { next_token: number } | undefined;
    const highestLease = this.db
      .prepare(
        "SELECT MAX(fencing_token) AS max_token FROM leases WHERE resource = ?",
      )
      .get(resource) as { max_token: number | null } | undefined;
    const fencingToken = Math.max(
      counter?.next_token ?? 1,
      (highestLease?.max_token ?? 0) + 1,
    );
    this.db
      .prepare(
        `INSERT INTO lease_counters(resource, next_token) VALUES (?, ?)
         ON CONFLICT(resource) DO UPDATE SET next_token = excluded.next_token`,
      )
      .run(resource, fencingToken + 1);
    const leaseId = `lea_${randomUUID().replaceAll("-", "")}`;
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
    this.db
      .prepare(
        `INSERT INTO leases
          (lease_id, resource, holder_agent_id, fencing_token, acquired_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(leaseId, resource, holderAgentId, fencingToken, nowText, expiresAt);
    this.audit("lease.acquired", holderAgentId, leaseId, {
      resource,
      fencingToken,
    });
    return {
      leaseId,
      resource,
      holderAgentId,
      fencingToken,
      acquiredAt: nowText,
      expiresAt,
    };
  }

  acquireLease(
    resource: string,
    holderAgentId: string,
    sessionToken: string,
    ttlSeconds: number,
  ): LeaseRecord {
    if (resource.startsWith(INTERNAL_INTEGRATION_LEASE_PREFIX)) {
      throw new CoordinationError(
        "invalid_input",
        `Lease resource prefix is reserved for integration coordination: ${INTERNAL_INTEGRATION_LEASE_PREFIX}`,
      );
    }
    const transaction = this.db.transaction(() => {
      this.recoverExpiredLeasesInTransaction();
      this.authenticatedAgentInTransaction(holderAgentId, sessionToken);
      return this.acquireLeaseInTransaction(
        transaction,
        resource,
        holderAgentId,
        ttlSeconds,
      );
    });
    return runImmediateTransaction(transaction, "lease.acquire");
  }

  renewLease(
    leaseId: string,
    holderAgentId: string,
    sessionToken: string,
    ttlSeconds: number,
  ): LeaseRecord {
    validateLeaseTtl(ttlSeconds);
    const transaction = this.db.transaction(() => {
      this.authenticatedAgentInTransaction(holderAgentId, sessionToken);
      const existing = this.db
        .prepare("SELECT * FROM leases WHERE lease_id = ?")
        .get(leaseId) as LeaseRow | undefined;
      if (!existing)
        throw new CoordinationError("not_found", `Lease not found: ${leaseId}`);
      if (existing.holder_agent_id !== holderAgentId)
        throw new CoordinationError("forbidden", "Lease holder mismatch");
      if (existing.resource.startsWith(INTERNAL_INTEGRATION_LEASE_PREFIX)) {
        throw new CoordinationError(
          "invalid_input",
          "Integration leases must be renewed through the integration workflow",
        );
      }
      const now = Date.now();
      if (parseLeaseExpiry(existing) <= now) {
        this.db.prepare("DELETE FROM leases WHERE lease_id = ?").run(leaseId);
        throw new CoordinationError("expired", `Lease expired: ${leaseId}`);
      }
      const expiresAt = new Date(now + ttlSeconds * 1000).toISOString();
      this.db
        .prepare(
          "UPDATE leases SET expires_at = ? WHERE lease_id = ? AND holder_agent_id = ?",
        )
        .run(expiresAt, leaseId, holderAgentId);
      this.audit("lease.renewed", holderAgentId, leaseId, {
        resource: existing.resource,
      });
      return { ...existingToLease(existing), expiresAt };
    });
    return runImmediateTransaction(transaction, "lease.renew");
  }

  releaseLease(
    leaseId: string,
    holderAgentId: string,
    sessionToken: string,
  ): void {
    const transaction = this.db.transaction(() => {
      this.authenticatedAgentInTransaction(holderAgentId, sessionToken);
      const existing = this.db
        .prepare("SELECT * FROM leases WHERE lease_id = ?")
        .get(leaseId) as LeaseRow | undefined;
      if (!existing)
        throw new CoordinationError("not_found", `Lease not found: ${leaseId}`);
      if (existing.holder_agent_id !== holderAgentId)
        throw new CoordinationError("forbidden", "Lease holder mismatch");
      if (existing.resource.startsWith(INTERNAL_INTEGRATION_LEASE_PREFIX)) {
        throw new CoordinationError(
          "invalid_input",
          "Integration leases must be released through the integration workflow",
        );
      }
      parseLeaseExpiry(existing);
      this.db.prepare("DELETE FROM leases WHERE lease_id = ?").run(leaseId);
      this.audit("lease.released", holderAgentId, leaseId, {
        resource: existing.resource,
      });
    });
    runImmediateTransaction(transaction, "lease.release");
  }

  listLeases(repositoryId?: string): LeaseRecord[] {
    this.recoverExpiredLeases();
    const rows = (
      repositoryId
        ? this.db
            .prepare(
              `SELECT l.* FROM leases l
               JOIN agents a ON a.agent_id = l.holder_agent_id
               JOIN workspaces w ON w.worktree_id = a.workspace_id
               WHERE w.repository_id = ? ORDER BY l.acquired_at`,
            )
            .all(repositoryId)
        : this.db.prepare("SELECT * FROM leases ORDER BY acquired_at").all()
    ) as LeaseRow[];
    return rows.map(existingToLease);
  }

  listLeasesPage(
    repositoryId?: string,
    cursor?: string,
    limit = MAX_STORE_PAGE_RECORDS,
  ): Array<StoreCursorItem<LeaseRecord>> {
    this.recoverExpiredLeases();
    const after = rowPageAfter(cursor);
    const boundedLimit = storePageLimit(limit);
    const rows = (
      repositoryId
        ? this.db
            .prepare(
              `SELECT l.rowid AS page_rowid, l.* FROM leases l
               JOIN agents a ON a.agent_id = l.holder_agent_id
               JOIN workspaces w ON w.worktree_id = a.workspace_id
               WHERE l.rowid > ? AND w.repository_id = ?
               ORDER BY l.rowid LIMIT ?`,
            )
            .all(after, repositoryId, boundedLimit)
        : this.db
            .prepare(
              `SELECT rowid AS page_rowid, * FROM leases
               WHERE rowid > ? ORDER BY rowid LIMIT ?`,
            )
            .all(after, boundedLimit)
    ) as Array<LeaseRow & RowPage>;
    return rows.map((row) => ({
      cursor: String(row.page_rowid),
      value: existingToLease(row),
    }));
  }

  /**
   * Persist an integration request from already server-observed Git facts.
   * CoordinationService is the authoritative public path that resolves refs
   * and binds the workspace; callers using the low-level store must supply
   * equivalent evidence and are still checked against the agent repository.
   */
  enqueueIntegration(
    input: IntegrationEnqueueInput,
    sessionToken: string,
  ): IntegrationRequest {
    assertSafeGitRef(input.sourceRef);
    const targetRef = canonicalTargetRef(input.targetRef);
    if (
      !/^[0-9a-f]{40,64}$/i.test(input.sourceOid) ||
      !/^[0-9a-f]{40,64}$/i.test(input.observedTargetOid)
    ) {
      throw new CoordinationError(
        "invalid_input",
        "Integration OIDs must be hexadecimal commit IDs",
      );
    }
    const transaction = this.db.transaction(() => {
      this.agentInRepository(
        input.requestedBy,
        input.repositoryId,
        sessionToken,
      );
      const requestId = `int_${randomUUID().replaceAll("-", "")}`;
      const timestamp = nowIso();
      this.db
        .prepare(
          `INSERT INTO integration_requests
            (request_id, repository_id, source_ref, source_oid, target_ref, observed_target_oid,
             status, requested_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
        )
        .run(
          requestId,
          input.repositoryId,
          input.sourceRef,
          input.sourceOid,
          targetRef,
          input.observedTargetOid,
          input.requestedBy,
          timestamp,
          timestamp,
        );
      this.audit("integration.enqueued", input.requestedBy, requestId, {
        repositoryId: input.repositoryId,
        targetRef,
      });
      return this.integration(requestId);
    });
    return runImmediateTransaction(transaction, "integration.enqueue");
  }

  private integration(requestId: string): IntegrationRequest {
    const row = this.db
      .prepare("SELECT * FROM integration_requests WHERE request_id = ?")
      .get(requestId) as IntegrationRow | undefined;
    if (!row)
      throw new CoordinationError(
        "not_found",
        `Integration request not found: ${requestId}`,
      );
    const result: IntegrationRequest = {
      requestId: row.request_id,
      repositoryId: row.repository_id,
      sourceRef: row.source_ref,
      sourceOid: row.source_oid,
      targetRef: row.target_ref,
      observedTargetOid: row.observed_target_oid,
      status: row.status,
      requestedBy: row.requested_by,
      ...(row.claimed_by ? { claimedBy: row.claimed_by } : {}),
      ...(row.lease_id ? { leaseId: row.lease_id } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    };
    if (row.lease_id) {
      const leaseRow = this.db
        .prepare("SELECT * FROM leases WHERE lease_id = ?")
        .get(row.lease_id) as LeaseRow | undefined;
      if (leaseRow) result.lease = existingToLease(leaseRow);
    }
    if (row.result_json) {
      const parsed = parseJson<IntegrationRequest["result"] | undefined>(
        row.result_json,
        undefined,
      );
      if (parsed) result.result = parsed;
    }
    return result;
  }

  getIntegration(requestId: string): IntegrationRequest {
    this.recoverExpiredLeases();
    return this.integration(requestId);
  }

  listIntegrations(
    repositoryId?: string,
    targetRef?: string,
  ): IntegrationRequest[] {
    this.recoverExpiredLeases();
    const normalizedTargetRef = targetRef
      ? canonicalTargetRef(targetRef)
      : undefined;
    const rows = (
      repositoryId
        ? normalizedTargetRef
          ? this.db
              .prepare(
                "SELECT * FROM integration_requests WHERE repository_id = ? AND target_ref = ? ORDER BY rowid",
              )
              .all(repositoryId, normalizedTargetRef)
          : this.db
              .prepare(
                "SELECT * FROM integration_requests WHERE repository_id = ? ORDER BY rowid",
              )
              .all(repositoryId)
        : normalizedTargetRef
          ? this.db
              .prepare(
                "SELECT * FROM integration_requests WHERE target_ref = ? ORDER BY rowid",
              )
              .all(normalizedTargetRef)
          : this.db
              .prepare("SELECT * FROM integration_requests ORDER BY rowid")
              .all()
    ) as IntegrationRow[];
    return rows.map((row) => this.integration(row.request_id));
  }

  listIntegrationsPage(
    repositoryId?: string,
    targetRef?: string,
    cursor?: string,
    limit = MAX_STORE_PAGE_RECORDS,
  ): Array<StoreCursorItem<IntegrationRequest>> {
    this.recoverExpiredLeases();
    const after = rowPageAfter(cursor);
    const boundedLimit = storePageLimit(limit);
    const normalizedTargetRef = targetRef
      ? canonicalTargetRef(targetRef)
      : undefined;
    const rows = (
      repositoryId
        ? normalizedTargetRef
          ? this.db
              .prepare(
                `SELECT rowid AS page_rowid, * FROM integration_requests
                 WHERE rowid > ? AND repository_id = ? AND target_ref = ?
                 ORDER BY rowid LIMIT ?`,
              )
              .all(after, repositoryId, normalizedTargetRef, boundedLimit)
          : this.db
              .prepare(
                `SELECT rowid AS page_rowid, * FROM integration_requests
                 WHERE rowid > ? AND repository_id = ?
                 ORDER BY rowid LIMIT ?`,
              )
              .all(after, repositoryId, boundedLimit)
        : normalizedTargetRef
          ? this.db
              .prepare(
                `SELECT rowid AS page_rowid, * FROM integration_requests
                 WHERE rowid > ? AND target_ref = ?
                 ORDER BY rowid LIMIT ?`,
              )
              .all(after, normalizedTargetRef, boundedLimit)
          : this.db
              .prepare(
                `SELECT rowid AS page_rowid, * FROM integration_requests
                 WHERE rowid > ? ORDER BY rowid LIMIT ?`,
              )
              .all(after, boundedLimit)
    ) as Array<IntegrationRow & RowPage>;
    return rows.map((row) => ({
      cursor: String(row.page_rowid),
      value: this.integration(row.request_id),
    }));
  }

  claimIntegration(
    requestId: string,
    agentId: string,
    sessionToken: string,
    currentSourceOid: string,
    currentTargetOid: string,
    ttlSeconds = 300,
  ): IntegrationRequest {
    let refreshConflict: Record<string, unknown> | undefined;
    const transaction = this.db.transaction(() => {
      this.recoverExpiredLeasesInTransaction();
      const row = this.db
        .prepare("SELECT * FROM integration_requests WHERE request_id = ?")
        .get(requestId) as IntegrationRow | undefined;
      if (!row)
        throw new CoordinationError(
          "not_found",
          `Integration request not found: ${requestId}`,
        );
      const agent = this.agentInRepository(
        agentId,
        row.repository_id,
        sessionToken,
      );
      if (row.status !== "queued") {
        throw new CoordinationError(
          "conflict",
          `Integration request is not claimable: ${row.status}`,
        );
      }
      if (!/^[0-9a-f]{40,64}$/i.test(currentSourceOid)) {
        throw new CoordinationError(
          "invalid_input",
          "currentSourceOid must be a hexadecimal commit ID",
        );
      }
      if (!/^[0-9a-f]{40,64}$/i.test(currentTargetOid)) {
        throw new CoordinationError(
          "invalid_input",
          "currentTargetOid must be a hexadecimal commit ID",
        );
      }
      const sourceMoved = row.source_oid !== currentSourceOid;
      const targetMoved = row.observed_target_oid !== currentTargetOid;
      if (sourceMoved || targetMoved) {
        this.db
          .prepare(
            "UPDATE integration_requests SET status = 'needs_refresh', updated_at = ? WHERE request_id = ?",
          )
          .run(nowIso(), requestId);
        this.audit("integration.needs_refresh", agentId, requestId, {
          ...(sourceMoved
            ? {
                expectedSourceOid: row.source_oid,
                currentSourceOid,
              }
            : {}),
          ...(targetMoved
            ? {
                expectedTargetOid: row.observed_target_oid,
                currentTargetOid,
              }
            : {}),
        });
        refreshConflict = {
          ...(sourceMoved
            ? {
                expectedSourceOid: row.source_oid,
                currentSourceOid,
              }
            : {}),
          ...(targetMoved
            ? {
                expectedTargetOid: row.observed_target_oid,
                currentTargetOid,
              }
            : {}),
        };
        return undefined;
      }
      const earlier = this.db
        .prepare(
          `SELECT request_id FROM integration_requests
           WHERE repository_id = ? AND target_ref = ?
             AND rowid < (SELECT rowid FROM integration_requests WHERE request_id = ?)
             AND status IN ('queued', 'needs_refresh', 'claimed') LIMIT 1`,
        )
        .get(row.repository_id, row.target_ref, requestId) as
        { request_id: string } | undefined;
      if (earlier) {
        throw new CoordinationError(
          "conflict",
          "An earlier integration request is ahead in the queue",
          {
            requestId: earlier.request_id,
          },
        );
      }
      const lease = this.acquireLeaseInTransaction(
        transaction,
        `git:${row.repository_id}:ref:${row.target_ref}`,
        agent.agent_id,
        ttlSeconds,
        false,
      );
      const updatedAt = nowIso();
      this.db
        .prepare(
          `UPDATE integration_requests SET status = 'claimed', claimed_by = ?, lease_id = ?, updated_at = ?
           WHERE request_id = ? AND status = 'queued'`,
        )
        .run(agentId, lease.leaseId, updatedAt, requestId);
      this.audit("integration.claimed", agentId, requestId, {
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
        targetOid: currentTargetOid,
      });
      return this.integration(requestId);
    });
    const result = runImmediateTransaction(transaction, "integration.claim");
    if (refreshConflict) {
      throw new CoordinationError(
        "conflict",
        "Target ref moved since the integration request was enqueued",
        refreshConflict,
      );
    }
    if (!result)
      throw new CoordinationError(
        "conflict",
        "Integration request could not be claimed",
      );
    return result;
  }

  /** Renew the target-ref lease owned by the active integration claimant. */
  renewIntegration(
    requestId: string,
    agentId: string,
    sessionToken: string,
    ttlSeconds = 300,
  ): IntegrationRequest {
    validateLeaseTtl(ttlSeconds);
    const transaction = this.db.transaction(() => {
      this.recoverExpiredLeasesInTransaction();
      const row = this.db
        .prepare("SELECT * FROM integration_requests WHERE request_id = ?")
        .get(requestId) as IntegrationRow | undefined;
      if (!row)
        throw new CoordinationError(
          "not_found",
          `Integration request not found: ${requestId}`,
        );
      this.agentInRepository(agentId, row.repository_id, sessionToken);
      if (
        row.status !== "claimed" ||
        row.claimed_by !== agentId ||
        !row.lease_id
      ) {
        throw new CoordinationError(
          "forbidden",
          "Integration request is not claimed by this agent",
        );
      }
      const lease = this.db
        .prepare("SELECT * FROM leases WHERE lease_id = ?")
        .get(row.lease_id) as LeaseRow | undefined;
      const expectedResource = `${INTERNAL_INTEGRATION_LEASE_PREFIX}${row.repository_id}:ref:${row.target_ref}`;
      if (!lease) {
        throw new CoordinationError(
          "expired",
          "Integration lease is no longer valid",
        );
      }
      const leaseExpiry = parseLeaseExpiry(lease);
      if (
        lease.holder_agent_id !== agentId ||
        lease.resource !== expectedResource ||
        leaseExpiry <= Date.now()
      ) {
        throw new CoordinationError(
          "expired",
          "Integration lease is no longer valid",
        );
      }
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
      this.db
        .prepare(
          "UPDATE leases SET expires_at = ? WHERE lease_id = ? AND holder_agent_id = ?",
        )
        .run(expiresAt, lease.lease_id, agentId);
      const updatedAt = nowIso();
      this.db
        .prepare(
          "UPDATE integration_requests SET updated_at = ? WHERE request_id = ? AND status = 'claimed' AND claimed_by = ?",
        )
        .run(updatedAt, requestId, agentId);
      this.audit("integration.lease_renewed", agentId, requestId, {
        leaseId: lease.lease_id,
        fencingToken: lease.fencing_token,
        expiresAt,
      });
      return this.integration(requestId);
    });
    return runImmediateTransaction(transaction, "integration.renew");
  }

  private recoverExpiredLeasesInTransaction(at = Date.now()): {
    leasesRemoved: number;
    integrationsMarkedNeedsRefresh: number;
  } {
    const expiryCandidates = this.db
      .prepare(
        `SELECT lease_id, holder_agent_id, resource, expires_at FROM leases
         WHERE julianday(expires_at) IS NOT NULL
           AND julianday(expires_at) <= julianday(?)`,
      )
      .all(new Date(at).toISOString()) as Array<{
      lease_id: string;
      holder_agent_id: string;
      resource: string;
      expires_at: string;
    }>;
    const expired = expiryCandidates.filter((lease) => {
      const expiresAt = parseLeaseExpiry(lease, true);
      return expiresAt !== undefined && expiresAt <= at;
    });
    if (expired.length === 0) {
      return { leasesRemoved: 0, integrationsMarkedNeedsRefresh: 0 };
    }
    const timestamp = new Date(at).toISOString();
    let integrationsMarkedNeedsRefresh = 0;
    for (const lease of expired) {
      const integrations = this.db
        .prepare(
          `SELECT request_id FROM integration_requests
           WHERE lease_id = ? AND status = 'claimed'`,
        )
        .all(lease.lease_id) as Array<{ request_id: string }>;
      for (const integration of integrations) {
        this.db
          .prepare(
            `UPDATE integration_requests SET status = 'needs_refresh', claimed_by = NULL,
               lease_id = NULL, updated_at = ? WHERE request_id = ?`,
          )
          .run(timestamp, integration.request_id);
        this.audit(
          "integration.lease_expired",
          undefined,
          integration.request_id,
          {
            leaseId: lease.lease_id,
            resource: lease.resource,
          },
        );
        integrationsMarkedNeedsRefresh += 1;
      }
      this.db
        .prepare("DELETE FROM leases WHERE lease_id = ?")
        .run(lease.lease_id);
      this.audit("lease.expired", lease.holder_agent_id, lease.lease_id, {
        resource: lease.resource,
      });
    }
    return {
      leasesRemoved: expired.length,
      integrationsMarkedNeedsRefresh,
    };
  }

  private recoverExpiredLeases(): void {
    const transaction = this.db.transaction(() =>
      this.recoverExpiredLeasesInTransaction(),
    );
    runImmediateTransaction(transaction, "integration.recover_expired");
  }

  private performMaintenanceInTransaction(
    policy: CoordinationMaintenancePolicy,
    evaluatedAt: number,
    mode: CoordinationMaintenanceResult["mode"],
  ): CoordinationMaintenanceResult {
    const expiredLeaseRecovery =
      this.recoverExpiredLeasesInTransaction(evaluatedAt);
    const activeAgents = this.db
      .prepare(
        `SELECT agent_id, last_heartbeat FROM agents
         WHERE unregistered_at IS NULL ORDER BY agent_id`,
      )
      .all() as Array<{ agent_id: string; last_heartbeat: string }>;
    const staleBefore = Date.parse(policy.staleBefore);
    const candidates = activeAgents.filter((agent) => {
      const heartbeat = Date.parse(agent.last_heartbeat);
      return Number.isFinite(heartbeat) && heartbeat < staleBefore;
    });
    const blockers: CoordinationMaintenanceBlocker[] = [];
    let markedOffline = 0;
    const offlineAt = new Date(evaluatedAt).toISOString();
    for (const candidate of candidates) {
      // Expired leases have already been recovered. Treat every remaining
      // lease as live or uncertain and preserve it rather than force release.
      const leases = this.db
        .prepare(
          `SELECT lease_id FROM leases
           WHERE holder_agent_id = ? ORDER BY lease_id`,
        )
        .all(candidate.agent_id) as Array<{ lease_id: string }>;
      const claimedIntegrations = this.db
        .prepare(
          `SELECT request_id FROM integration_requests
           WHERE claimed_by = ? AND status = 'claimed' ORDER BY request_id`,
        )
        .all(candidate.agent_id) as Array<{ request_id: string }>;
      if (leases.length > 0 || claimedIntegrations.length > 0) {
        blockers.push({
          agentId: candidate.agent_id,
          lastHeartbeat: candidate.last_heartbeat,
          leaseIds: leases.map((lease) => lease.lease_id),
          claimedIntegrationIds: claimedIntegrations.map(
            (integration) => integration.request_id,
          ),
        });
        continue;
      }
      const update = this.db
        .prepare(
          `UPDATE agents SET unregistered_at = ?
           WHERE agent_id = ? AND unregistered_at IS NULL`,
        )
        .run(offlineAt, candidate.agent_id);
      if (update.changes > 0) {
        markedOffline += update.changes;
        this.audit("agent.stale_reconciled", undefined, candidate.agent_id, {
          lastHeartbeat: candidate.last_heartbeat,
          staleBefore: policy.staleBefore,
        });
      }
    }

    const acknowledgedMessages = this.db
      .prepare(
        `DELETE FROM messages
         WHERE acknowledged_at IS NOT NULL
           AND julianday(acknowledged_at) IS NOT NULL
           AND julianday(acknowledged_at) < julianday(?)`,
      )
      .run(policy.acknowledgedMessagesBefore).changes;
    const terminalIntegrations = this.db
      .prepare(
        `DELETE FROM integration_requests
         WHERE status IN ('completed', 'failed', 'cancelled')
           AND completed_at IS NOT NULL
           AND julianday(completed_at) IS NOT NULL
           AND julianday(completed_at) < julianday(?)
           AND NOT EXISTS (
             SELECT 1 FROM leases
             WHERE leases.lease_id = integration_requests.lease_id
           )`,
      )
      .run(policy.terminalIntegrationsBefore).changes;
    const terminalJobs = this.db
      .prepare(
        `DELETE FROM jobs
         WHERE status IN ('succeeded', 'failed', 'cancelled')
           AND completed_at IS NOT NULL
           AND julianday(completed_at) IS NOT NULL
           AND julianday(completed_at) < julianday(?)`,
      )
      .run(policy.terminalJobsBefore).changes;
    const auditEvents = this.db
      .prepare(
        `DELETE FROM audit_events
         WHERE julianday(created_at) IS NOT NULL
           AND julianday(created_at) < julianday(?)`,
      )
      .run(policy.auditEventsBefore).changes;

    const result: CoordinationMaintenanceResult = {
      mode,
      evaluatedAt: offlineAt,
      policy,
      expiredLeaseRecovery,
      staleAgents: {
        candidates: candidates.length,
        blocked: blockers.length,
        markedOffline,
      },
      blockers,
      pruned: {
        acknowledgedMessages,
        terminalIntegrations,
        terminalJobs,
        auditEvents,
      },
    };
    this.audit("maintenance.completed", undefined, undefined, {
      mode,
      expiredLeaseRecovery,
      staleAgents: result.staleAgents,
      pruned: result.pruned,
    });
    return result;
  }

  /**
   * Preview or apply bounded stale-session reconciliation and retention. A
   * preview executes the exact mutations under an immediate transaction and
   * rolls its savepoint back before returning, so it cannot change state.
   */
  runMaintenance(
    input: CoordinationMaintenancePolicy,
    options: CoordinationMaintenanceOptions = {},
  ): CoordinationMaintenanceResult {
    if (options.apply !== undefined && typeof options.apply !== "boolean") {
      throw new CoordinationError("invalid_input", "apply must be a boolean");
    }
    const evaluatedAt = Date.now();
    const policy: CoordinationMaintenancePolicy = {
      staleBefore: maintenanceCutoff(
        "staleBefore",
        input?.staleBefore,
        evaluatedAt,
      ),
      acknowledgedMessagesBefore: maintenanceCutoff(
        "acknowledgedMessagesBefore",
        input?.acknowledgedMessagesBefore,
        evaluatedAt,
      ),
      terminalIntegrationsBefore: maintenanceCutoff(
        "terminalIntegrationsBefore",
        input?.terminalIntegrationsBefore,
        evaluatedAt,
      ),
      terminalJobsBefore: maintenanceCutoff(
        "terminalJobsBefore",
        input?.terminalJobsBefore,
        evaluatedAt,
      ),
      auditEventsBefore: maintenanceCutoff(
        "auditEventsBefore",
        input?.auditEventsBefore,
        evaluatedAt,
      ),
    };
    const apply = options.apply === true;
    const transaction = this.db.transaction(() => {
      if (apply) {
        return this.performMaintenanceInTransaction(
          policy,
          evaluatedAt,
          "applied",
        );
      }
      const savepoint = "agentconduit_maintenance_preview";
      this.db.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = this.performMaintenanceInTransaction(
          policy,
          evaluatedAt,
          "preview",
        );
        this.db.exec(`ROLLBACK TO ${savepoint}`);
        this.db.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        try {
          this.db.exec(`ROLLBACK TO ${savepoint}`);
          this.db.exec(`RELEASE ${savepoint}`);
        } catch {
          // The outer transaction remains the authoritative rollback boundary.
        }
        throw error;
      }
    });
    return runImmediateTransaction(transaction, "maintenance.run");
  }

  refreshIntegration(
    requestId: string,
    agentId: string,
    sessionToken: string,
    sourceOid: string,
    observedTargetOid: string,
  ): IntegrationRequest {
    if (
      !/^[0-9a-f]{40,64}$/i.test(sourceOid) ||
      !/^[0-9a-f]{40,64}$/i.test(observedTargetOid)
    ) {
      throw new CoordinationError(
        "invalid_input",
        "Integration OIDs must be hexadecimal commit IDs",
      );
    }
    const transaction = this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM integration_requests WHERE request_id = ?")
        .get(requestId) as IntegrationRow | undefined;
      if (!row)
        throw new CoordinationError(
          "not_found",
          `Integration request not found: ${requestId}`,
        );
      this.agentInRepository(agentId, row.repository_id, sessionToken);
      if (row.requested_by !== agentId && row.claimed_by !== agentId) {
        throw new CoordinationError(
          "forbidden",
          "Only the requester or claimant can refresh an integration request",
        );
      }
      if (!["queued", "needs_refresh"].includes(row.status)) {
        throw new CoordinationError(
          "conflict",
          `Integration request cannot be refreshed from ${row.status}`,
        );
      }
      const timestamp = nowIso();
      this.db
        .prepare(
          `UPDATE integration_requests SET source_oid = ?, observed_target_oid = ?,
             status = 'queued', updated_at = ? WHERE request_id = ?`,
        )
        .run(sourceOid, observedTargetOid, timestamp, requestId);
      this.audit("integration.refreshed", agentId, requestId, {
        observedTargetOid,
      });
      return this.integration(requestId);
    });
    return runImmediateTransaction(transaction, "integration.refresh");
  }

  completeIntegration(
    requestId: string,
    agentId: string,
    sessionToken: string,
    input: IntegrationCompletionInput,
  ): IntegrationRequest {
    if (!INTEGRATION_COMPLETION_OUTCOMES.has(input.outcome)) {
      throw new CoordinationError(
        "invalid_input",
        `Invalid integration outcome: ${String(input.outcome)}`,
      );
    }
    if (input.outcome !== "cancelled" && !input.postTargetOid) {
      throw new CoordinationError(
        "invalid_input",
        "postTargetOid is required for every non-cancelled integration outcome",
      );
    }
    if (
      input.postTargetOid &&
      !/^[0-9a-f]{40,64}$/i.test(input.postTargetOid)
    ) {
      throw new CoordinationError(
        "invalid_input",
        "postTargetOid must be a hexadecimal commit ID",
      );
    }
    const transaction = this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM integration_requests WHERE request_id = ?")
        .get(requestId) as IntegrationRow | undefined;
      if (!row)
        throw new CoordinationError(
          "not_found",
          `Integration request not found: ${requestId}`,
        );
      this.agentInRepository(agentId, row.repository_id, sessionToken);
      if (
        row.status !== "claimed" ||
        row.claimed_by !== agentId ||
        !row.lease_id
      ) {
        throw new CoordinationError(
          "forbidden",
          "Integration request is not claimed by this agent",
        );
      }
      const lease = this.db
        .prepare("SELECT * FROM leases WHERE lease_id = ?")
        .get(row.lease_id) as LeaseRow | undefined;
      if (!lease) {
        throw new CoordinationError(
          "expired",
          "Integration lease is no longer valid",
        );
      }
      const leaseExpiry = parseLeaseExpiry(lease);
      if (lease.holder_agent_id !== agentId || leaseExpiry <= Date.now()) {
        throw new CoordinationError(
          "expired",
          "Integration lease is no longer valid",
        );
      }
      const timestamp = nowIso();
      const result = {
        outcome: input.outcome,
        ...(input.postTargetOid ? { postTargetOid: input.postTargetOid } : {}),
        ...(input.note ? { note: input.note.slice(0, 2000) } : {}),
      };
      this.db
        .prepare(
          `UPDATE integration_requests SET status = ?, result_json = ?, completed_at = ?, updated_at = ?
           WHERE request_id = ?`,
        )
        .run(
          input.outcome === "failed"
            ? "failed"
            : input.outcome === "cancelled"
              ? "cancelled"
              : "completed",
          JSON.stringify(result),
          timestamp,
          timestamp,
          requestId,
        );
      this.db
        .prepare("DELETE FROM leases WHERE lease_id = ?")
        .run(row.lease_id);
      this.audit("integration.completed", agentId, requestId, {
        outcome: input.outcome,
        postTargetOid: input.postTargetOid,
      });
      return this.integration(requestId);
    });
    return runImmediateTransaction(transaction, "integration.complete");
  }

  cancelIntegration(
    requestId: string,
    agentId: string,
    sessionToken: string,
  ): IntegrationRequest {
    const transaction = this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM integration_requests WHERE request_id = ?")
        .get(requestId) as IntegrationRow | undefined;
      if (!row)
        throw new CoordinationError(
          "not_found",
          `Integration request not found: ${requestId}`,
        );
      this.agentInRepository(agentId, row.repository_id, sessionToken);
      if (["completed", "failed", "cancelled"].includes(row.status))
        return this.integration(requestId);
      if (row.status === "claimed") {
        if (row.claimed_by !== agentId) {
          throw new CoordinationError(
            "forbidden",
            "Only the active claimant can cancel a claimed integration request",
          );
        }
      } else if (row.requested_by !== agentId) {
        throw new CoordinationError(
          "forbidden",
          "Only the requester can cancel a queued integration request",
        );
      }
      if (row.lease_id) {
        const lease = this.db
          .prepare("SELECT * FROM leases WHERE lease_id = ?")
          .get(row.lease_id) as LeaseRow | undefined;
        if (lease) parseLeaseExpiry(lease);
      }
      const timestamp = nowIso();
      this.db
        .prepare(
          `UPDATE integration_requests SET status = 'cancelled', completed_at = ?, updated_at = ?,
             result_json = ? WHERE request_id = ?`,
        )
        .run(
          timestamp,
          timestamp,
          JSON.stringify({ outcome: "cancelled" }),
          requestId,
        );
      if (row.lease_id)
        this.db
          .prepare("DELETE FROM leases WHERE lease_id = ?")
          .run(row.lease_id);
      this.audit("integration.cancelled", agentId, requestId);
      return this.integration(requestId);
    });
    return runImmediateTransaction(transaction, "integration.cancel");
  }

  /** Owner control: cancel only work that has never acquired integration authority. */
  adminCancelUnclaimedIntegration(requestId: string): IntegrationRequest {
    const transaction = this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM integration_requests WHERE request_id = ?")
        .get(requestId) as IntegrationRow | undefined;
      if (!row) {
        throw new CoordinationError(
          "not_found",
          `Integration request not found: ${requestId}`,
        );
      }
      if (["completed", "failed", "cancelled"].includes(row.status)) {
        return this.integration(requestId);
      }
      if (row.status === "claimed" || row.lease_id) {
        throw new CoordinationError(
          "conflict",
          "The owner cannot cancel a claimed integration; start reconciliation and inspect Git evidence",
          { requestId, authorityPreserved: true },
        );
      }
      const timestamp = nowIso();
      this.db
        .prepare(
          `UPDATE integration_requests SET status = 'cancelled', completed_at = ?,
             updated_at = ?, result_json = ? WHERE request_id = ?`,
        )
        .run(
          timestamp,
          timestamp,
          JSON.stringify({ outcome: "cancelled", note: "Cancelled by owner" }),
          requestId,
        );
      this.audit("integration.owner_cancelled", undefined, requestId, {
        previousStatus: row.status,
      });
      return this.integration(requestId);
    });
    return runImmediateTransaction(transaction, "integration.owner_cancel");
  }

  openReconciliation(agentId: string, reason: string): ReconciliationCase {
    const normalizedReason = boundedText("reason", reason, 1_000);
    const transaction = this.db.transaction(() => {
      this.anyAgentRow(agentId);
      const existing = this.db
        .prepare(
          `SELECT * FROM reconciliations WHERE agent_id = ? AND status = 'open'
           ORDER BY created_at LIMIT 1`,
        )
        .get(agentId) as ReconciliationRow | undefined;
      if (existing) return reconciliationFromRow(existing);
      const leaseIds = (
        this.db
          .prepare(
            "SELECT lease_id FROM leases WHERE holder_agent_id = ? ORDER BY acquired_at",
          )
          .all(agentId) as Array<{ lease_id: string }>
      ).map((row) => row.lease_id);
      const claimedIntegrationIds = (
        this.db
          .prepare(
            `SELECT request_id FROM integration_requests
             WHERE claimed_by = ? AND status = 'claimed' ORDER BY created_at`,
          )
          .all(agentId) as Array<{ request_id: string }>
      ).map((row) => row.request_id);
      const reconciliationId = `rec_${randomUUID().replaceAll("-", "")}`;
      const createdAt = nowIso();
      this.db
        .prepare(
          `INSERT INTO reconciliations
            (reconciliation_id, agent_id, reason, status, lease_ids_json,
             claimed_integration_ids_json, created_at)
           VALUES (?, ?, ?, 'open', ?, ?, ?)`,
        )
        .run(
          reconciliationId,
          agentId,
          normalizedReason,
          JSON.stringify(leaseIds),
          JSON.stringify(claimedIntegrationIds),
          createdAt,
        );
      this.audit("reconciliation.opened", undefined, reconciliationId, {
        agentId,
        leaseCount: leaseIds.length,
        claimedIntegrationCount: claimedIntegrationIds.length,
        authorityPreserved: true,
      });
      return {
        reconciliationId,
        agentId,
        reason: normalizedReason,
        status: "open" as const,
        leaseIds,
        claimedIntegrationIds,
        createdAt,
      };
    });
    return runImmediateTransaction(transaction, "reconciliation.open");
  }

  listReconciliations(
    status?: ReconciliationCase["status"],
  ): ReconciliationCase[] {
    if (status !== undefined && status !== "open" && status !== "resolved") {
      throw new CoordinationError(
        "invalid_input",
        "Reconciliation status is invalid",
      );
    }
    const rows = (
      status
        ? this.db
            .prepare(
              "SELECT * FROM reconciliations WHERE status = ? ORDER BY created_at",
            )
            .all(status)
        : this.db
            .prepare("SELECT * FROM reconciliations ORDER BY created_at")
            .all()
    ) as ReconciliationRow[];
    return rows.map(reconciliationFromRow);
  }

  listReconciliationsPage(
    status?: ReconciliationCase["status"],
    cursor?: string,
    limit = MAX_STORE_PAGE_RECORDS,
  ): Array<StoreCursorItem<ReconciliationCase>> {
    if (status !== undefined && status !== "open" && status !== "resolved") {
      throw new CoordinationError(
        "invalid_input",
        "Reconciliation status is invalid",
      );
    }
    const after = rowPageAfter(cursor);
    const boundedLimit = storePageLimit(limit);
    const rows = (
      status
        ? this.db
            .prepare(
              `SELECT rowid AS page_rowid, * FROM reconciliations
               WHERE rowid > ? AND status = ? ORDER BY rowid LIMIT ?`,
            )
            .all(after, status, boundedLimit)
        : this.db
            .prepare(
              `SELECT rowid AS page_rowid, * FROM reconciliations
               WHERE rowid > ? ORDER BY rowid LIMIT ?`,
            )
            .all(after, boundedLimit)
    ) as Array<ReconciliationRow & RowPage>;
    return rows.map((row) => ({
      cursor: String(row.page_rowid),
      value: reconciliationFromRow(row),
    }));
  }
}

function existingToLease(row: LeaseRow): LeaseRecord {
  return {
    leaseId: row.lease_id,
    resource: row.resource,
    holderAgentId: row.holder_agent_id,
    fencingToken: row.fencing_token,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
  };
}
