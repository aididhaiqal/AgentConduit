import { createHash } from "node:crypto";
import { basename } from "node:path";
import { CoordinationError } from "./errors.js";
import { repositoryIdForProjectId } from "./git.js";
import type {
  AgentRecord,
  AgentRegistration,
  AuditEventRecord,
  DeviceHealth,
  DeviceRecord,
  GitWorkspaceSnapshot,
  IntegrationCompletionInput,
  IntegrationRequest,
  JobActivity,
  JobCreateInput,
  JobEventInput,
  JobEventRecord,
  JobRecord,
  JobStatus,
  LeaseRecord,
  MessageRecord,
  OperatorMessageRecord,
  RemoteWorkspaceRecord,
} from "./model.js";

export const AGENTCONDUIT_NODE_PROTOCOL = "agentconduit.node.v1" as const;
export const NODE_RPC_COLLECTION_PAGE_MAX_RECORDS = 100;
export const NODE_RPC_COLLECTION_PAGE_MAX_BYTES = 512 * 1_024;

export interface CursorPage<T> {
  items: T[];
  nextCursor?: string;
}

export interface CursorPageParams {
  cursor?: string;
}

export interface RemoteWorkspaceAttestation {
  snapshot: GitWorkspaceSnapshot;
  pathLabel: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function looksLikeAbsolutePath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^file:/i.test(value)
  );
}

/** Omit filesystem remotes at the final cross-machine serialization boundary. */
export function remoteUrlForHub(value: string | undefined): string | undefined {
  if (!value || looksLikeAbsolutePath(value)) return undefined;
  return value;
}

/**
 * Transform locally discovered Git evidence before it crosses a machine
 * boundary. No absolute local path survives this function.
 */
export function attestWorkspaceForDevice(
  local: GitWorkspaceSnapshot,
  deviceId: string,
  configuredLabel?: string,
): RemoteWorkspaceAttestation {
  if (!/^dev_[0-9a-f]{32}$/.test(deviceId)) {
    throw new CoordinationError("invalid_input", "deviceId is invalid");
  }
  if (!local.projectId) {
    throw new CoordinationError(
      "invalid_input",
      "Multi-PC workspaces require .agentconduit/project.json with projectId",
    );
  }
  const repositoryId = repositoryIdForProjectId(local.projectId);
  if (local.repositoryId !== repositoryId) {
    throw new CoordinationError(
      "invalid_input",
      "Discovered repository identity does not match projectId",
    );
  }
  const pathLabel = (configuredLabel ?? basename(local.rootPath)).trim();
  if (
    !pathLabel ||
    pathLabel.length > 128 ||
    looksLikeAbsolutePath(pathLabel)
  ) {
    throw new CoordinationError(
      "invalid_input",
      "Remote workspace path label must be a non-path label of 1-128 characters",
    );
  }
  const worktreeId = `wt_${digest(`${deviceId}\0${local.worktreeId}`).slice(
    0,
    32,
  )}`;
  const rootPath = `device://${deviceId}/workspaces/${worktreeId}`;
  const remoteUrl = remoteUrlForHub(local.remoteUrl);
  return {
    pathLabel,
    snapshot: {
      repositoryId,
      projectId: local.projectId,
      worktreeId,
      rootPath,
      commonGitDir: `device://${deviceId}/repositories/${repositoryId}`,
      gitDir: `${rootPath}/git`,
      ...(remoteUrl ? { remoteUrl } : {}),
      ...(local.branch ? { branch: local.branch } : {}),
      headOid: local.headOid,
      dirty: local.dirty,
      upstream: local.upstream,
      isBare: local.isBare,
      observedAt: local.observedAt,
    },
  };
}

export interface NodeRpcOperations {
  "device.heartbeat": {
    params: {
      nodeVersion: string;
      capabilities: string[];
      health: DeviceHealth;
    };
    result: DeviceRecord;
  };
  "workspace.register": {
    params: { workspace: RemoteWorkspaceAttestation };
    result: RemoteWorkspaceRecord;
  };
  "workspace.list": {
    params: CursorPageParams & { repositoryId?: string };
    result: CursorPage<GitWorkspaceSnapshot>;
  };
  "agent.register": {
    params: {
      runtime: string;
      workspace: RemoteWorkspaceAttestation;
      sessionRef?: string;
      sessionToken?: string;
      displayName?: string;
      capabilities?: string[];
    };
    result: AgentRegistration;
  };
  "agent.heartbeat": {
    params: {
      agentId: string;
      sessionToken: string;
      workspace: RemoteWorkspaceAttestation;
    };
    result: AgentRecord;
  };
  "agent.unregister": {
    params: { agentId: string; sessionToken: string };
    result: { unregistered: true };
  };
  "agent.list": {
    params: CursorPageParams & {
      repositoryId?: string;
      includeOffline?: boolean;
      activeOnly?: boolean;
    };
    result: CursorPage<AgentRecord>;
  };
  "message.send": {
    params: {
      senderAgentId: string;
      senderSessionToken: string;
      recipientAgentId: string;
      body: string;
      correlationId?: string;
    };
    result: MessageRecord;
  };
  "message.inbox": {
    params: CursorPageParams & {
      agentId: string;
      sessionToken: string;
      includeAcknowledged?: boolean;
    };
    result: CursorPage<MessageRecord | OperatorMessageRecord>;
  };
  "message.ack": {
    params: { agentId: string; sessionToken: string; messageId: string };
    result: { acknowledged: true };
  };
  "job.create": {
    params: {
      agentId: string;
      sessionToken: string;
      input: JobCreateInput;
    };
    result: JobRecord;
  };
  "job.emit": {
    params: {
      agentId: string;
      sessionToken: string;
      jobId: string;
      event: JobEventInput;
    };
    result: JobEventRecord;
  };
  "job.get": {
    params: { agentId: string; sessionToken: string; jobId: string };
    result: JobRecord;
  };
  "job.list": {
    params: CursorPageParams & {
      agentId: string;
      sessionToken: string;
      statuses?: JobStatus[];
      activity?: JobActivity;
      ownerAgentId?: string;
    };
    result: CursorPage<JobRecord>;
  };
  "job.events": {
    params: CursorPageParams & {
      agentId: string;
      sessionToken: string;
      jobId: string;
      limit?: number;
    };
    result: CursorPage<JobEventRecord>;
  };
  "lease.acquire": {
    params: {
      agentId: string;
      sessionToken: string;
      resource: string;
      ttlSeconds: number;
    };
    result: LeaseRecord;
  };
  "lease.renew": {
    params: {
      agentId: string;
      sessionToken: string;
      leaseId: string;
      ttlSeconds: number;
    };
    result: LeaseRecord;
  };
  "lease.release": {
    params: { agentId: string; sessionToken: string; leaseId: string };
    result: { released: true };
  };
  "integration.enqueue": {
    params: {
      agentId: string;
      sessionToken: string;
      workspace: RemoteWorkspaceAttestation;
      sourceRef: string;
      sourceOid: string;
      targetRef: string;
      observedTargetOid: string;
    };
    result: IntegrationRequest;
  };
  "integration.claim": {
    params: {
      agentId: string;
      sessionToken: string;
      requestId: string;
      workspace: RemoteWorkspaceAttestation;
      currentSourceOid: string;
      currentTargetOid: string;
    };
    result: IntegrationRequest;
  };
  "integration.renew": {
    params: {
      agentId: string;
      sessionToken: string;
      requestId: string;
      workspace: RemoteWorkspaceAttestation;
      ttlSeconds?: number;
    };
    result: IntegrationRequest;
  };
  "integration.refresh": {
    params: {
      agentId: string;
      sessionToken: string;
      requestId: string;
      workspace: RemoteWorkspaceAttestation;
      sourceOid: string;
      observedTargetOid: string;
    };
    result: IntegrationRequest;
  };
  "integration.complete": {
    params: {
      agentId: string;
      sessionToken: string;
      requestId: string;
      workspace: RemoteWorkspaceAttestation;
      completion: IntegrationCompletionInput;
      currentTargetOid?: string;
    };
    result: IntegrationRequest;
  };
  "integration.cancel": {
    params: { agentId: string; sessionToken: string; requestId: string };
    result: IntegrationRequest;
  };
  "integration.get": {
    params: { requestId: string };
    result: IntegrationRequest;
  };
  "integration.list": {
    params: CursorPageParams & {
      repositoryId?: string;
      targetRef?: string;
    };
    result: CursorPage<IntegrationRequest>;
  };
}

export type NodeRpcOperation = keyof NodeRpcOperations;

export type NodeRpcRequest<
  TOperation extends NodeRpcOperation = NodeRpcOperation,
> = TOperation extends NodeRpcOperation
  ? {
      protocol: typeof AGENTCONDUIT_NODE_PROTOCOL;
      operation: TOperation;
      params: NodeRpcOperations[TOperation]["params"];
    }
  : never;

export type NodeRpcResult<TOperation extends NodeRpcOperation> =
  NodeRpcOperations[TOperation]["result"];

export interface NodeEventEnvelope {
  protocol: typeof AGENTCONDUIT_NODE_PROTOCOL;
  event: AuditEventRecord;
}
