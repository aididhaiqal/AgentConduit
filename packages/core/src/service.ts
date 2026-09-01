import {
  canonicalizeGitRef,
  discoverGitWorkspace,
  resolveGitRef,
} from "./git.js";
import { CoordinationError } from "./errors.js";
import { CoordinationStore } from "./store.js";
import type {
  AgentRecord,
  AgentRegistrationInput,
  AgentRegistration,
  GitWorkspaceSnapshot,
  IntegrationCompletionInput,
  IntegrationRequest,
  JobCreateInput,
  JobEventInput,
  JobEventRecord,
  JobListFilter,
  JobRecord,
  LeaseRecord,
  MessageRecord,
} from "./model.js";

export interface CoordinationServiceOptions {
  store?: CoordinationStore;
  heartbeatTimeoutMs?: number;
  jobActivityTimeoutMs?: number;
  allowedRoots?: readonly string[];
}

export class CoordinationService {
  readonly store: CoordinationStore;
  readonly heartbeatTimeoutMs: number;
  readonly allowedRoots: readonly string[];

  constructor(options: CoordinationServiceOptions = {}) {
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 90_000;
    this.allowedRoots = options.allowedRoots ?? [];
    this.store =
      options.store ??
      new CoordinationStore(":memory:", {
        heartbeatTimeoutMs: this.heartbeatTimeoutMs,
        ...(options.jobActivityTimeoutMs !== undefined
          ? { jobActivityTimeoutMs: options.jobActivityTimeoutMs }
          : {}),
      });
    this.store.setHeartbeatTimeoutMs(this.heartbeatTimeoutMs);
    if (options.jobActivityTimeoutMs !== undefined) {
      this.store.setJobActivityTimeoutMs(options.jobActivityTimeoutMs);
    }
  }

  close(): void {
    this.store.close();
  }

  discover(workspacePath: string): GitWorkspaceSnapshot {
    return discoverGitWorkspace(workspacePath, {
      allowedRoots: this.allowedRoots,
    });
  }

  registerWorkspace(workspacePath: string): GitWorkspaceSnapshot {
    const workspace = this.discover(workspacePath);
    this.store.upsertWorkspace(workspace);
    return workspace;
  }

  listWorkspaces(repositoryId?: string): GitWorkspaceSnapshot[] {
    return this.store.listWorkspaces(repositoryId);
  }

  /**
   * Integration facts must come from the worktree currently registered to the
   * authenticated agent. Accepting an arbitrary same-repository path lets an
   * agent borrow another worktree's Git view, which defeats the registration
   * and repository-scope boundary.
   */
  private integrationWorkspace(
    agentId: string,
    workspacePath: string,
    repositoryId: string,
  ): GitWorkspaceSnapshot {
    const agent = this.store.getAgent(agentId);
    const workspace = this.discover(workspacePath);
    if (agent.workspace.repositoryId !== repositoryId) {
      throw new CoordinationError(
        "forbidden",
        "Agent does not belong to the integration repository",
      );
    }
    if (
      workspace.repositoryId !== repositoryId ||
      workspace.worktreeId !== agent.workspace.worktreeId
    ) {
      throw new CoordinationError(
        "forbidden",
        "Integration workspace must be the agent's registered worktree",
      );
    }
    return workspace;
  }

  register(input: AgentRegistrationInput): AgentRegistration {
    const workspace = this.discover(input.workspacePath);
    return this.store.registerAgent({
      runtime: input.runtime,
      ...(input.sessionRef ? { sessionRef: input.sessionRef } : {}),
      ...(input.sessionToken ? { sessionToken: input.sessionToken } : {}),
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.capabilities ? { capabilities: input.capabilities } : {}),
      workspace,
    });
  }

  heartbeat(
    agentId: string,
    sessionToken: string,
    workspacePath: string,
  ): AgentRecord {
    this.store.verifyAgentSession(agentId, sessionToken);
    const agent = this.store.getAgent(agentId);
    const workspace = this.discover(workspacePath);
    if (workspace.repositoryId !== agent.workspace.repositoryId) {
      throw new CoordinationError(
        "forbidden",
        "Heartbeat cannot move an agent session into another repository; register a new session instead",
      );
    }
    if (workspace.worktreeId !== agent.workspace.worktreeId) {
      throw new CoordinationError(
        "forbidden",
        "Heartbeat must use the agent's registered worktree; register a new session after switching worktrees",
      );
    }
    return this.store.heartbeat(agentId, sessionToken, workspace);
  }

  unregister(agentId: string, sessionToken: string): void {
    this.store.unregisterAgent(agentId, sessionToken);
  }

  listAgents(
    repositoryId?: string,
    includeOffline = false,
    activeOnly = false,
  ): AgentRecord[] {
    return this.store.listAgents(repositoryId, includeOffline, activeOnly);
  }

  sendMessage(
    senderAgentId: string,
    senderSessionToken: string,
    recipientAgentId: string,
    body: string,
    correlationId?: string,
  ): MessageRecord {
    this.store.verifyAgentSession(senderAgentId, senderSessionToken);
    return this.store.sendMessage(
      {
        senderAgentId,
        recipientAgentId,
        body,
        ...(correlationId ? { correlationId } : {}),
      },
      senderSessionToken,
    );
  }

  inbox(
    agentId: string,
    sessionToken: string,
    includeAcknowledged = false,
  ): MessageRecord[] {
    this.store.verifyAgentSession(agentId, sessionToken);
    return this.store.inbox(agentId, sessionToken, includeAcknowledged);
  }

  acknowledgeMessage(
    agentId: string,
    sessionToken: string,
    messageId: string,
  ): void {
    this.store.verifyAgentSession(agentId, sessionToken);
    this.store.acknowledgeMessage(agentId, sessionToken, messageId);
  }

  createJob(
    agentId: string,
    sessionToken: string,
    input: JobCreateInput,
  ): JobRecord {
    return this.store.createJob(agentId, sessionToken, input);
  }

  emitJobEvent(
    agentId: string,
    sessionToken: string,
    jobId: string,
    input: JobEventInput,
  ): JobEventRecord {
    return this.store.appendJobEvent(agentId, sessionToken, jobId, input);
  }

  getJob(agentId: string, sessionToken: string, jobId: string): JobRecord {
    return this.store.getJobForAgent(agentId, sessionToken, jobId);
  }

  listJobs(
    agentId: string,
    sessionToken: string,
    filter: JobListFilter = {},
  ): JobRecord[] {
    return this.store.listJobsForAgent(agentId, sessionToken, filter);
  }

  jobEvents(
    agentId: string,
    sessionToken: string,
    jobId: string,
    afterCursor = 0,
    limit = 100,
  ): JobEventRecord[] {
    return this.store.listJobEventsForAgent(
      agentId,
      sessionToken,
      jobId,
      afterCursor,
      limit,
    );
  }

  acquireLease(
    agentId: string,
    sessionToken: string,
    resource: string,
    ttlSeconds: number,
  ): LeaseRecord {
    this.store.verifyAgentSession(agentId, sessionToken);
    return this.store.acquireLease(resource, agentId, sessionToken, ttlSeconds);
  }

  renewLease(
    agentId: string,
    sessionToken: string,
    leaseId: string,
    ttlSeconds: number,
  ): LeaseRecord {
    this.store.verifyAgentSession(agentId, sessionToken);
    return this.store.renewLease(leaseId, agentId, sessionToken, ttlSeconds);
  }

  releaseLease(agentId: string, sessionToken: string, leaseId: string): void {
    this.store.verifyAgentSession(agentId, sessionToken);
    this.store.releaseLease(leaseId, agentId, sessionToken);
  }

  enqueueIntegration(
    agentId: string,
    sessionToken: string,
    workspacePath: string,
    sourceRef: string,
    targetRef: string,
  ): IntegrationRequest {
    this.store.verifyAgentSession(agentId, sessionToken);
    const agent = this.store.getAgent(agentId);
    const workspace = this.integrationWorkspace(
      agentId,
      workspacePath,
      agent.workspace.repositoryId,
    );
    const sourceOid = resolveGitRef(workspace.rootPath, sourceRef, {
      allowedRoots: this.allowedRoots,
    });
    const canonicalTargetRef = canonicalizeGitRef(
      workspace.rootPath,
      targetRef,
      {
        allowedRoots: this.allowedRoots,
      },
    );
    const observedTargetOid = resolveGitRef(
      workspace.rootPath,
      canonicalTargetRef,
      {
        allowedRoots: this.allowedRoots,
      },
    );
    return this.store.enqueueIntegration(
      {
        repositoryId: workspace.repositoryId,
        sourceRef,
        sourceOid,
        targetRef: canonicalTargetRef,
        observedTargetOid,
        requestedBy: agentId,
      },
      sessionToken,
    );
  }

  claimIntegration(
    agentId: string,
    sessionToken: string,
    requestId: string,
    workspacePath: string,
  ): IntegrationRequest {
    this.store.verifyAgentSession(agentId, sessionToken);
    const request = this.store.getIntegration(requestId);
    const workspace = this.integrationWorkspace(
      agentId,
      workspacePath,
      request.repositoryId,
    );
    const currentSourceOid = resolveGitRef(
      workspace.rootPath,
      request.sourceRef,
      { allowedRoots: this.allowedRoots },
    );
    const currentTargetOid = resolveGitRef(
      workspace.rootPath,
      request.targetRef,
      { allowedRoots: this.allowedRoots },
    );
    return this.store.claimIntegration(
      requestId,
      agentId,
      sessionToken,
      currentSourceOid,
      currentTargetOid,
    );
  }

  renewIntegration(
    agentId: string,
    sessionToken: string,
    requestId: string,
    workspacePath: string,
    ttlSeconds = 300,
  ): IntegrationRequest {
    this.store.verifyAgentSession(agentId, sessionToken);
    const request = this.store.getIntegration(requestId);
    this.integrationWorkspace(agentId, workspacePath, request.repositoryId);
    return this.store.renewIntegration(
      requestId,
      agentId,
      sessionToken,
      ttlSeconds,
    );
  }

  completeIntegration(
    agentId: string,
    sessionToken: string,
    requestId: string,
    workspacePath: string,
    input: IntegrationCompletionInput,
  ): IntegrationRequest {
    this.store.verifyAgentSession(agentId, sessionToken);
    const request = this.store.getIntegration(requestId);
    const workspace = this.integrationWorkspace(
      agentId,
      workspacePath,
      request.repositoryId,
    );
    if (input.outcome !== "cancelled") {
      const currentTargetOid = resolveGitRef(
        workspace.rootPath,
        request.targetRef,
        { allowedRoots: this.allowedRoots },
      );
      if (!input.postTargetOid || input.postTargetOid !== currentTargetOid) {
        throw new CoordinationError(
          "conflict",
          "Integration completion must prove the current target ref OID",
          {
            currentTargetOid,
          },
        );
      }
    }
    return this.store.completeIntegration(
      requestId,
      agentId,
      sessionToken,
      input,
    );
  }

  refreshIntegration(
    agentId: string,
    sessionToken: string,
    requestId: string,
    workspacePath: string,
  ): IntegrationRequest {
    this.store.verifyAgentSession(agentId, sessionToken);
    const request = this.store.getIntegration(requestId);
    const workspace = this.integrationWorkspace(
      agentId,
      workspacePath,
      request.repositoryId,
    );
    const sourceOid = resolveGitRef(workspace.rootPath, request.sourceRef, {
      allowedRoots: this.allowedRoots,
    });
    const observedTargetOid = resolveGitRef(
      workspace.rootPath,
      request.targetRef,
      { allowedRoots: this.allowedRoots },
    );
    return this.store.refreshIntegration(
      requestId,
      agentId,
      sessionToken,
      sourceOid,
      observedTargetOid,
    );
  }

  cancelIntegration(
    agentId: string,
    sessionToken: string,
    requestId: string,
  ): IntegrationRequest {
    this.store.verifyAgentSession(agentId, sessionToken);
    const request = this.store.getIntegration(requestId);
    const agent = this.store.getAgent(agentId);
    if (agent.workspace.repositoryId !== request.repositoryId) {
      throw new CoordinationError(
        "forbidden",
        "Agent does not belong to the integration repository",
      );
    }
    return this.store.cancelIntegration(requestId, agentId, sessionToken);
  }

  getIntegration(requestId: string): IntegrationRequest {
    return this.store.getIntegration(requestId);
  }

  listIntegrations(
    repositoryId?: string,
    targetRef?: string,
  ): IntegrationRequest[] {
    return this.store.listIntegrations(repositoryId, targetRef);
  }
}
