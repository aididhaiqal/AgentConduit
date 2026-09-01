import {
  CoordinationError,
  attestWorkspaceForDevice,
  canonicalizeGitRef,
  discoverGitWorkspace,
  NODE_RPC_COLLECTION_PAGE_MAX_RECORDS,
  resolveGitRef,
  type AgentRecord,
  type AgentRegistration,
  type AgentRegistrationInput,
  type CursorPage,
  type GitWorkspaceSnapshot,
  type IntegrationCompletionInput,
  type IntegrationRequest,
  type JobCreateInput,
  type JobEventInput,
  type JobEventRecord,
  type JobListFilter,
  type JobRecord,
  type LeaseRecord,
  type MessageRecord,
  type RemoteWorkspaceAttestation,
  type NodeRpcOperations,
} from "@agentconduit/core";
import type { CoordinationBackend } from "@agentconduit/server";
import { isAbsolute, relative } from "node:path";
import { HubClient } from "./client.js";

type CollectionOperation =
  | "workspace.list"
  | "agent.list"
  | "message.inbox"
  | "job.list"
  | "integration.list";

type CollectionItem<TOperation extends CollectionOperation> =
  NodeRpcOperations[TOperation]["result"] extends CursorPage<infer T>
    ? T
    : never;

export interface NodeCoordinationBackendOptions {
  client: HubClient;
  deviceId: string;
  allowedRoots: readonly string[];
  heartbeatTimeoutMs?: number;
  pathLabels?: Readonly<Record<string, string>>;
}

export class NodeCoordinationBackend implements CoordinationBackend {
  readonly client: HubClient;
  readonly deviceId: string;
  readonly allowedRoots: readonly string[];
  readonly heartbeatTimeoutMs: number;
  readonly pathLabels: Readonly<Record<string, string>>;

  constructor(options: NodeCoordinationBackendOptions) {
    if (!/^dev_[0-9a-f]{32}$/.test(options.deviceId)) {
      throw new Error("Node deviceId is invalid");
    }
    this.client = options.client;
    this.deviceId = options.deviceId;
    this.allowedRoots = [...options.allowedRoots];
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 90_000;
    this.pathLabels = options.pathLabels ?? {};
  }

  discover(workspacePath: string): GitWorkspaceSnapshot {
    return discoverGitWorkspace(workspacePath, {
      allowedRoots: this.allowedRoots,
    });
  }

  private attestation(workspacePath: string): RemoteWorkspaceAttestation {
    const local = this.discover(workspacePath);
    const configuredLabel = Object.entries(this.pathLabels)
      .filter(([configuredRoot]) => {
        const child = relative(configuredRoot, local.rootPath);
        return child === "" || (!child.startsWith("..") && !isAbsolute(child));
      })
      .sort(([left], [right]) => right.length - left.length)[0]?.[1];
    return attestWorkspaceForDevice(local, this.deviceId, configuredLabel);
  }

  private async collectPages<TOperation extends CollectionOperation>(
    operation: TOperation,
    params: Omit<NodeRpcOperations[TOperation]["params"], "cursor">,
  ): Promise<Array<CollectionItem<TOperation>>> {
    const items: Array<CollectionItem<TOperation>> = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 10_000; pageNumber += 1) {
      const page = (await this.client.rpc(operation, {
        ...params,
        ...(cursor ? { cursor } : {}),
      } as NodeRpcOperations[TOperation]["params"])) as CursorPage<
        CollectionItem<TOperation>
      >;
      if (!page || typeof page !== "object" || !Array.isArray(page.items)) {
        throw new CoordinationError(
          "storage_error",
          "Hub collection response is invalid",
        );
      }
      items.push(...page.items);
      if (page.nextCursor === undefined) return items;
      if (
        typeof page.nextCursor !== "string" ||
        !/^[A-Za-z0-9_-]{1,256}$/.test(page.nextCursor) ||
        seen.has(page.nextCursor)
      ) {
        throw new CoordinationError(
          "storage_error",
          "Hub collection cursor did not advance",
        );
      }
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new CoordinationError(
      "storage_error",
      "Hub collection exceeded the Node pagination limit",
    );
  }

  async registerWorkspace(
    workspacePath: string,
  ): Promise<GitWorkspaceSnapshot> {
    const result = await this.client.rpc("workspace.register", {
      workspace: this.attestation(workspacePath),
    });
    return result.workspace;
  }

  async listWorkspaces(repositoryId?: string): Promise<GitWorkspaceSnapshot[]> {
    return await this.collectPages("workspace.list", {
      ...(repositoryId ? { repositoryId } : {}),
    });
  }

  async register(input: AgentRegistrationInput): Promise<AgentRegistration> {
    return await this.client.rpc("agent.register", {
      runtime: input.runtime,
      workspace: this.attestation(input.workspacePath),
      ...(input.sessionRef ? { sessionRef: input.sessionRef } : {}),
      ...(input.sessionToken ? { sessionToken: input.sessionToken } : {}),
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.capabilities ? { capabilities: input.capabilities } : {}),
    });
  }

  async heartbeat(
    agentId: string,
    sessionToken: string,
    workspacePath: string,
  ): Promise<AgentRecord> {
    return await this.client.rpc("agent.heartbeat", {
      agentId,
      sessionToken,
      workspace: this.attestation(workspacePath),
    });
  }

  async unregister(agentId: string, sessionToken: string): Promise<void> {
    await this.client.rpc("agent.unregister", { agentId, sessionToken });
  }

  async listAgents(
    repositoryId?: string,
    includeOffline = false,
    activeOnly = false,
  ): Promise<AgentRecord[]> {
    return await this.collectPages("agent.list", {
      ...(repositoryId ? { repositoryId } : {}),
      includeOffline,
      activeOnly,
    });
  }

  async sendMessage(
    senderAgentId: string,
    senderSessionToken: string,
    recipientAgentId: string,
    body: string,
    correlationId?: string,
  ): Promise<MessageRecord> {
    return await this.client.rpc("message.send", {
      senderAgentId,
      senderSessionToken,
      recipientAgentId,
      body,
      ...(correlationId ? { correlationId } : {}),
    });
  }

  async inbox(
    agentId: string,
    sessionToken: string,
    includeAcknowledged = false,
  ): Promise<MessageRecord[]> {
    return await this.collectPages("message.inbox", {
      agentId,
      sessionToken,
      includeAcknowledged,
    });
  }

  async acknowledgeMessage(
    agentId: string,
    sessionToken: string,
    messageId: string,
  ): Promise<void> {
    await this.client.rpc("message.ack", { agentId, sessionToken, messageId });
  }

  async createJob(
    agentId: string,
    sessionToken: string,
    input: JobCreateInput,
  ): Promise<JobRecord> {
    return await this.client.rpc("job.create", {
      agentId,
      sessionToken,
      input,
    });
  }

  async emitJobEvent(
    agentId: string,
    sessionToken: string,
    jobId: string,
    event: JobEventInput,
  ): Promise<JobEventRecord> {
    return await this.client.rpc("job.emit", {
      agentId,
      sessionToken,
      jobId,
      event,
    });
  }

  async getJob(
    agentId: string,
    sessionToken: string,
    jobId: string,
  ): Promise<JobRecord> {
    return await this.client.rpc("job.get", {
      agentId,
      sessionToken,
      jobId,
    });
  }

  async listJobs(
    agentId: string,
    sessionToken: string,
    filter: JobListFilter = {},
  ): Promise<JobRecord[]> {
    return await this.collectPages("job.list", {
      agentId,
      sessionToken,
      ...(filter.statuses ? { statuses: [...filter.statuses] } : {}),
      ...(filter.activity ? { activity: filter.activity } : {}),
      ...(filter.ownerAgentId ? { ownerAgentId: filter.ownerAgentId } : {}),
    });
  }

  async jobEvents(
    agentId: string,
    sessionToken: string,
    jobId: string,
    afterCursor = 0,
    limit = 100,
  ): Promise<JobEventRecord[]> {
    if (
      !Number.isSafeInteger(afterCursor) ||
      afterCursor < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    ) {
      throw new CoordinationError(
        "invalid_input",
        "Job event cursor or limit is invalid",
      );
    }
    const events: JobEventRecord[] = [];
    const seen = new Set<string>();
    let cursor = afterCursor > 0 ? String(afterCursor) : undefined;
    while (events.length < limit) {
      const pageLimit = Math.min(
        NODE_RPC_COLLECTION_PAGE_MAX_RECORDS,
        limit - events.length,
      );
      const page = await this.client.rpc("job.events", {
        agentId,
        sessionToken,
        jobId,
        limit: pageLimit,
        ...(cursor ? { cursor } : {}),
      });
      if (
        !page ||
        typeof page !== "object" ||
        !Array.isArray(page.items) ||
        page.items.length > pageLimit
      ) {
        throw new CoordinationError(
          "storage_error",
          "Hub job event response is invalid",
        );
      }
      events.push(...page.items);
      if (page.nextCursor === undefined || events.length === limit) {
        return events;
      }
      if (
        !/^(?:0|[1-9][0-9]{0,15})$/.test(page.nextCursor) ||
        seen.has(page.nextCursor)
      ) {
        throw new CoordinationError(
          "storage_error",
          "Hub job event cursor did not advance",
        );
      }
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return events;
  }

  async acquireLease(
    agentId: string,
    sessionToken: string,
    resource: string,
    ttlSeconds: number,
  ): Promise<LeaseRecord> {
    return await this.client.rpc("lease.acquire", {
      agentId,
      sessionToken,
      resource,
      ttlSeconds,
    });
  }

  async renewLease(
    agentId: string,
    sessionToken: string,
    leaseId: string,
    ttlSeconds: number,
  ): Promise<LeaseRecord> {
    return await this.client.rpc("lease.renew", {
      agentId,
      sessionToken,
      leaseId,
      ttlSeconds,
    });
  }

  async releaseLease(
    agentId: string,
    sessionToken: string,
    leaseId: string,
  ): Promise<void> {
    await this.client.rpc("lease.release", { agentId, sessionToken, leaseId });
  }

  async enqueueIntegration(
    agentId: string,
    sessionToken: string,
    workspacePath: string,
    sourceRef: string,
    targetRef: string,
  ): Promise<IntegrationRequest> {
    const sourceOid = resolveGitRef(workspacePath, sourceRef, {
      allowedRoots: this.allowedRoots,
    });
    const canonicalTarget = canonicalizeGitRef(workspacePath, targetRef, {
      allowedRoots: this.allowedRoots,
    });
    const observedTargetOid = resolveGitRef(workspacePath, canonicalTarget, {
      allowedRoots: this.allowedRoots,
    });
    return await this.client.rpc("integration.enqueue", {
      agentId,
      sessionToken,
      workspace: this.attestation(workspacePath),
      sourceRef,
      sourceOid,
      targetRef: canonicalTarget,
      observedTargetOid,
    });
  }

  async claimIntegration(
    agentId: string,
    sessionToken: string,
    requestId: string,
    workspacePath: string,
  ): Promise<IntegrationRequest> {
    const request = await this.getIntegration(requestId);
    const currentSourceOid = resolveGitRef(workspacePath, request.sourceRef, {
      allowedRoots: this.allowedRoots,
    });
    const currentTargetOid = resolveGitRef(workspacePath, request.targetRef, {
      allowedRoots: this.allowedRoots,
    });
    return await this.client.rpc("integration.claim", {
      agentId,
      sessionToken,
      requestId,
      workspace: this.attestation(workspacePath),
      currentSourceOid,
      currentTargetOid,
    });
  }

  async renewIntegration(
    agentId: string,
    sessionToken: string,
    requestId: string,
    workspacePath: string,
    ttlSeconds = 300,
  ): Promise<IntegrationRequest> {
    return await this.client.rpc("integration.renew", {
      agentId,
      sessionToken,
      requestId,
      workspace: this.attestation(workspacePath),
      ttlSeconds,
    });
  }

  async refreshIntegration(
    agentId: string,
    sessionToken: string,
    requestId: string,
    workspacePath: string,
  ): Promise<IntegrationRequest> {
    const request = await this.getIntegration(requestId);
    const sourceOid = resolveGitRef(workspacePath, request.sourceRef, {
      allowedRoots: this.allowedRoots,
    });
    const observedTargetOid = resolveGitRef(workspacePath, request.targetRef, {
      allowedRoots: this.allowedRoots,
    });
    return await this.client.rpc("integration.refresh", {
      agentId,
      sessionToken,
      requestId,
      workspace: this.attestation(workspacePath),
      sourceOid,
      observedTargetOid,
    });
  }

  async completeIntegration(
    agentId: string,
    sessionToken: string,
    requestId: string,
    workspacePath: string,
    input: IntegrationCompletionInput,
  ): Promise<IntegrationRequest> {
    let currentTargetOid: string | undefined;
    if (input.outcome !== "cancelled") {
      const request = await this.getIntegration(requestId);
      currentTargetOid = resolveGitRef(workspacePath, request.targetRef, {
        allowedRoots: this.allowedRoots,
      });
      if (!input.postTargetOid || input.postTargetOid !== currentTargetOid) {
        throw new CoordinationError(
          "conflict",
          "Integration completion must prove the current target ref OID",
          { currentTargetOid, authorityPreserved: true },
        );
      }
    }
    return await this.client.rpc("integration.complete", {
      agentId,
      sessionToken,
      requestId,
      workspace: this.attestation(workspacePath),
      completion: input,
      ...(currentTargetOid ? { currentTargetOid } : {}),
    });
  }

  async cancelIntegration(
    agentId: string,
    sessionToken: string,
    requestId: string,
  ): Promise<IntegrationRequest> {
    return await this.client.rpc("integration.cancel", {
      agentId,
      sessionToken,
      requestId,
    });
  }

  async getIntegration(requestId: string): Promise<IntegrationRequest> {
    return await this.client.rpc("integration.get", { requestId });
  }

  async listIntegrations(
    repositoryId?: string,
    targetRef?: string,
  ): Promise<IntegrationRequest[]> {
    return await this.collectPages("integration.list", {
      ...(repositoryId ? { repositoryId } : {}),
      ...(targetRef ? { targetRef } : {}),
    });
  }
}
