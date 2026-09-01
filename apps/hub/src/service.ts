import {
  AGENTCONDUIT_NODE_PROTOCOL,
  CoordinationError,
  CoordinationStore,
  NODE_RPC_COLLECTION_PAGE_MAX_BYTES,
  NODE_RPC_COLLECTION_PAGE_MAX_RECORDS,
  type AgentRecord,
  type AuditEventRecord,
  type CursorPage,
  type DeviceEnrollment,
  type DeviceRecord,
  type GitWorkspaceSnapshot,
  type IntegrationRequest,
  type JobRecord,
  type LeaseRecord,
  type MessageRecord,
  type NodeRpcOperation,
  type NodeRpcOperations,
  type OperatorMessageRecord,
  type ReconciliationCase,
  type RemoteWorkspaceAttestation,
  type RemoteWorkspaceRecord,
  type StoreCursorItem,
} from "@agentconduit/core";

export interface HubSnapshot {
  protocol: typeof AGENTCONDUIT_NODE_PROTOCOL;
  generatedAt: string;
  latestEventCursor: number;
  database: ReturnType<CoordinationStore["healthCheck"]>;
  devices: DeviceRecord[];
  workspaces: RemoteWorkspaceRecord[];
  agents: AgentRecord[];
  messages: Array<MessageRecord | OperatorMessageRecord>;
  leases: LeaseRecord[];
  integrations: IntegrationRequest[];
  jobs: JobRecord[];
  reconciliations: ReconciliationCase[];
  recentEvents: AuditEventRecord[];
  nextCursor?: string;
}

const SNAPSHOT_STAGES = [
  "devices",
  "workspaces",
  "agents",
  "messages",
  "leases",
  "integrations",
  "jobs",
  "reconciliations",
  "recentEvents",
] as const;

type SnapshotStage = (typeof SNAPSHOT_STAGES)[number];

interface SnapshotPosition {
  stage: SnapshotStage;
  after?: string;
  eventCursor?: number;
}

function encodedResponseBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify({ result: value }), "utf8");
}

function boundedPage<T>(
  candidates: Array<StoreCursorItem<T>>,
  maximumRecords = NODE_RPC_COLLECTION_PAGE_MAX_RECORDS,
): CursorPage<T> {
  const items: T[] = [];
  let lastCursor: string | undefined;
  const maximum = Math.min(candidates.length, maximumRecords);
  for (let index = 0; index < maximum; index += 1) {
    const candidate = candidates[index]!;
    const more = index + 1 < candidates.length;
    const proposed: CursorPage<T> = {
      items: [...items, candidate.value],
      ...(more ? { nextCursor: candidate.cursor } : {}),
    };
    if (encodedResponseBytes(proposed) > NODE_RPC_COLLECTION_PAGE_MAX_BYTES) {
      if (!lastCursor) {
        throw new CoordinationError(
          "storage_error",
          "A stored collection record exceeds the Hub response budget",
        );
      }
      return { items, nextCursor: lastCursor };
    }
    items.push(candidate.value);
    lastCursor = candidate.cursor;
  }
  return {
    items,
    ...(candidates.length > maximum && lastCursor
      ? { nextCursor: lastCursor }
      : {}),
  };
}

function encodeSnapshotPosition(position: SnapshotPosition): string {
  return Buffer.from(JSON.stringify(position), "utf8").toString("base64url");
}

function decodeSnapshotPosition(cursor: string | undefined): SnapshotPosition {
  if (cursor === undefined) return { stage: SNAPSHOT_STAGES[0] };
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) {
    throw new CoordinationError("invalid_input", "Snapshot cursor is invalid");
  }
  let parsed: unknown;
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) throw new Error("invalid");
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new CoordinationError("invalid_input", "Snapshot cursor is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CoordinationError("invalid_input", "Snapshot cursor is invalid");
  }
  const record = parsed as Record<string, unknown>;
  if (
    !SNAPSHOT_STAGES.includes(record.stage as SnapshotStage) ||
    (record.after !== undefined &&
      (typeof record.after !== "string" || record.after.length > 256)) ||
    typeof record.eventCursor !== "number" ||
    !Number.isSafeInteger(record.eventCursor) ||
    record.eventCursor < 0 ||
    Object.keys(record).some(
      (key) => key !== "stage" && key !== "after" && key !== "eventCursor",
    )
  ) {
    throw new CoordinationError("invalid_input", "Snapshot cursor is invalid");
  }
  return {
    stage: record.stage as SnapshotStage,
    ...(typeof record.after === "string" ? { after: record.after } : {}),
    eventCursor: record.eventCursor,
  };
}

export class HubService {
  constructor(readonly store: CoordinationStore) {}

  private observeWorkspace(
    deviceToken: string,
    workspace: RemoteWorkspaceAttestation,
  ): RemoteWorkspaceRecord {
    return this.store.upsertRemoteWorkspace(
      deviceToken,
      workspace.snapshot,
      workspace.pathLabel,
    );
  }

  private bindAgentWorkspace(
    deviceToken: string,
    agentId: string,
    workspace: RemoteWorkspaceAttestation,
  ): GitWorkspaceSnapshot {
    const observed = this.observeWorkspace(deviceToken, workspace).workspace;
    this.store.verifyDeviceOwnsAgent(deviceToken, agentId);
    const agent = this.store.getAgent(agentId);
    if (agent.workspace.worktreeId !== observed.worktreeId) {
      throw new CoordinationError(
        "forbidden",
        "Agent operation must use its registered device worktree",
        {
          registeredWorktreeId: agent.workspace.worktreeId,
          observedWorktreeId: observed.worktreeId,
        },
      );
    }
    return observed;
  }

  execute<TOperation extends NodeRpcOperation>(
    deviceToken: string,
    operation: TOperation,
    params: NodeRpcOperations[TOperation]["params"],
  ): NodeRpcOperations[TOperation]["result"] {
    // Every operation authenticates before reading even owner-wide metadata.
    this.store.authenticateDevice(deviceToken);
    let result: unknown;
    switch (operation) {
      case "device.heartbeat": {
        const input = params as NodeRpcOperations["device.heartbeat"]["params"];
        result = this.store.heartbeatDevice(deviceToken, input);
        break;
      }
      case "workspace.register": {
        const input =
          params as NodeRpcOperations["workspace.register"]["params"];
        result = this.observeWorkspace(deviceToken, input.workspace);
        break;
      }
      case "workspace.list": {
        const input = params as NodeRpcOperations["workspace.list"]["params"];
        result = boundedPage(
          this.store
            .listRemoteWorkspacesPage(
              input.repositoryId,
              input.cursor,
              NODE_RPC_COLLECTION_PAGE_MAX_RECORDS + 1,
            )
            .map((entry) => ({
              cursor: entry.cursor,
              value: entry.value.workspace,
            })),
        );
        break;
      }
      case "agent.register": {
        const input = params as NodeRpcOperations["agent.register"]["params"];
        const workspace = this.observeWorkspace(
          deviceToken,
          input.workspace,
        ).workspace;
        result = this.store.registerAgent({
          runtime: input.runtime,
          workspace,
          ...(input.sessionRef ? { sessionRef: input.sessionRef } : {}),
          ...(input.sessionToken ? { sessionToken: input.sessionToken } : {}),
          ...(input.displayName ? { displayName: input.displayName } : {}),
          ...(input.capabilities ? { capabilities: input.capabilities } : {}),
        });
        this.store.verifyDeviceOwnsAgent(
          deviceToken,
          (result as { agentId: string }).agentId,
        );
        break;
      }
      case "agent.heartbeat": {
        const input = params as NodeRpcOperations["agent.heartbeat"]["params"];
        const workspace = this.bindAgentWorkspace(
          deviceToken,
          input.agentId,
          input.workspace,
        );
        result = this.store.heartbeat(
          input.agentId,
          input.sessionToken,
          workspace,
        );
        break;
      }
      case "agent.unregister": {
        const input = params as NodeRpcOperations["agent.unregister"]["params"];
        this.store.verifyDeviceOwnsAgent(deviceToken, input.agentId);
        this.store.unregisterAgent(input.agentId, input.sessionToken);
        result = { unregistered: true };
        break;
      }
      case "agent.list": {
        const input = params as NodeRpcOperations["agent.list"]["params"];
        result = boundedPage(
          this.store.listAgentsPage(
            input.repositoryId,
            input.includeOffline ?? false,
            input.activeOnly ?? false,
            input.cursor,
            NODE_RPC_COLLECTION_PAGE_MAX_RECORDS + 1,
          ),
        );
        break;
      }
      case "message.send": {
        const input = params as NodeRpcOperations["message.send"]["params"];
        this.store.verifyDeviceOwnsAgent(deviceToken, input.senderAgentId);
        result = this.store.sendMessage(
          {
            senderAgentId: input.senderAgentId,
            recipientAgentId: input.recipientAgentId,
            body: input.body,
            ...(input.correlationId
              ? { correlationId: input.correlationId }
              : {}),
          },
          input.senderSessionToken,
        );
        break;
      }
      case "message.inbox": {
        const input = params as NodeRpcOperations["message.inbox"]["params"];
        this.store.verifyDeviceOwnsAgent(deviceToken, input.agentId);
        result = boundedPage(
          this.store.inboxPage(
            input.agentId,
            input.sessionToken,
            input.includeAcknowledged ?? false,
            input.cursor,
            NODE_RPC_COLLECTION_PAGE_MAX_RECORDS + 1,
          ),
        );
        break;
      }
      case "message.ack": {
        const input = params as NodeRpcOperations["message.ack"]["params"];
        this.store.verifyDeviceOwnsAgent(deviceToken, input.agentId);
        if (input.messageId.startsWith("opm_")) {
          this.store.acknowledgeOperatorMessage(
            input.agentId,
            input.sessionToken,
            input.messageId,
          );
        } else {
          this.store.acknowledgeMessage(
            input.agentId,
            input.sessionToken,
            input.messageId,
          );
        }
        result = { acknowledged: true };
        break;
      }
      case "job.create": {
        const input = params as NodeRpcOperations["job.create"]["params"];
        this.store.verifyDeviceOwnsAgent(deviceToken, input.agentId);
        result = this.store.createJob(
          input.agentId,
          input.sessionToken,
          input.input,
        );
        break;
      }
      case "job.emit": {
        const input = params as NodeRpcOperations["job.emit"]["params"];
        this.store.verifyDeviceOwnsAgent(deviceToken, input.agentId);
        result = this.store.appendJobEvent(
          input.agentId,
          input.sessionToken,
          input.jobId,
          input.event,
        );
        break;
      }
      case "job.get": {
        const input = params as NodeRpcOperations["job.get"]["params"];
        this.store.verifyDeviceOwnsAgent(deviceToken, input.agentId);
        result = this.store.getJobForAgent(
          input.agentId,
          input.sessionToken,
          input.jobId,
        );
        break;
      }
      case "job.list": {
        const input = params as NodeRpcOperations["job.list"]["params"];
        this.store.verifyDeviceOwnsAgent(deviceToken, input.agentId);
        this.store.verifyAgentSession(input.agentId, input.sessionToken);
        const repositoryId = this.store.getAgent(input.agentId).workspace
          .repositoryId;
        result = boundedPage(
          this.store.listJobsPage(
            repositoryId,
            {
              ...(input.statuses ? { statuses: input.statuses } : {}),
              ...(input.activity ? { activity: input.activity } : {}),
              ...(input.ownerAgentId
                ? { ownerAgentId: input.ownerAgentId }
                : {}),
            },
            input.cursor,
            NODE_RPC_COLLECTION_PAGE_MAX_RECORDS + 1,
          ),
        );
        break;
      }
      case "job.events": {
        const input = params as NodeRpcOperations["job.events"]["params"];
        this.store.verifyDeviceOwnsAgent(deviceToken, input.agentId);
        const afterCursor = input.cursor
          ? Number.parseInt(input.cursor, 10)
          : 0;
        const pageLimit = input.limit ?? NODE_RPC_COLLECTION_PAGE_MAX_RECORDS;
        result = boundedPage(
          this.store
            .listJobEventsForAgent(
              input.agentId,
              input.sessionToken,
              input.jobId,
              afterCursor,
              pageLimit + 1,
            )
            .map((event) => ({
              cursor: String(event.cursor),
              value: event,
            })),
          pageLimit,
        );
        break;
      }
      case "lease.acquire": {
        const input = params as NodeRpcOperations["lease.acquire"]["params"];
        this.store.verifyDeviceOwnsAgent(deviceToken, input.agentId);
        result = this.store.acquireLease(
          input.resource,
          input.agentId,
          input.sessionToken,
          input.ttlSeconds,
        );
        break;
      }
      case "lease.renew": {
        const input = params as NodeRpcOperations["lease.renew"]["params"];
        this.store.verifyDeviceOwnsAgent(deviceToken, input.agentId);
        result = this.store.renewLease(
          input.leaseId,
          input.agentId,
          input.sessionToken,
          input.ttlSeconds,
        );
        break;
      }
      case "lease.release": {
        const input = params as NodeRpcOperations["lease.release"]["params"];
        this.store.verifyDeviceOwnsAgent(deviceToken, input.agentId);
        this.store.releaseLease(
          input.leaseId,
          input.agentId,
          input.sessionToken,
        );
        result = { released: true };
        break;
      }
      case "integration.enqueue": {
        const input =
          params as NodeRpcOperations["integration.enqueue"]["params"];
        const workspace = this.bindAgentWorkspace(
          deviceToken,
          input.agentId,
          input.workspace,
        );
        result = this.store.enqueueIntegration(
          {
            repositoryId: workspace.repositoryId,
            sourceRef: input.sourceRef,
            sourceOid: input.sourceOid,
            targetRef: input.targetRef,
            observedTargetOid: input.observedTargetOid,
            requestedBy: input.agentId,
          },
          input.sessionToken,
        );
        break;
      }
      case "integration.claim": {
        const input =
          params as NodeRpcOperations["integration.claim"]["params"];
        this.bindAgentWorkspace(deviceToken, input.agentId, input.workspace);
        result = this.store.claimIntegration(
          input.requestId,
          input.agentId,
          input.sessionToken,
          input.currentSourceOid,
          input.currentTargetOid,
        );
        break;
      }
      case "integration.renew": {
        const input =
          params as NodeRpcOperations["integration.renew"]["params"];
        this.bindAgentWorkspace(deviceToken, input.agentId, input.workspace);
        result = this.store.renewIntegration(
          input.requestId,
          input.agentId,
          input.sessionToken,
          input.ttlSeconds ?? 300,
        );
        break;
      }
      case "integration.refresh": {
        const input =
          params as NodeRpcOperations["integration.refresh"]["params"];
        this.bindAgentWorkspace(deviceToken, input.agentId, input.workspace);
        result = this.store.refreshIntegration(
          input.requestId,
          input.agentId,
          input.sessionToken,
          input.sourceOid,
          input.observedTargetOid,
        );
        break;
      }
      case "integration.complete": {
        const input =
          params as NodeRpcOperations["integration.complete"]["params"];
        this.bindAgentWorkspace(deviceToken, input.agentId, input.workspace);
        if (
          input.completion.outcome !== "cancelled" &&
          (!input.currentTargetOid ||
            input.currentTargetOid !== input.completion.postTargetOid)
        ) {
          throw new CoordinationError(
            "conflict",
            "Integration completion must include matching current target-ref evidence",
            { authorityPreserved: true },
          );
        }
        result = this.store.completeIntegration(
          input.requestId,
          input.agentId,
          input.sessionToken,
          input.completion,
        );
        break;
      }
      case "integration.cancel": {
        const input =
          params as NodeRpcOperations["integration.cancel"]["params"];
        this.store.verifyDeviceOwnsAgent(deviceToken, input.agentId);
        result = this.store.cancelIntegration(
          input.requestId,
          input.agentId,
          input.sessionToken,
        );
        break;
      }
      case "integration.get": {
        const input = params as NodeRpcOperations["integration.get"]["params"];
        result = this.store.getIntegration(input.requestId);
        break;
      }
      case "integration.list": {
        const input = params as NodeRpcOperations["integration.list"]["params"];
        result = boundedPage(
          this.store.listIntegrationsPage(
            input.repositoryId,
            input.targetRef,
            input.cursor,
            NODE_RPC_COLLECTION_PAGE_MAX_RECORDS + 1,
          ),
        );
        break;
      }
      default:
        throw new CoordinationError(
          "invalid_input",
          `Unsupported Node operation: ${String(operation)}`,
        );
    }
    return result as NodeRpcOperations[TOperation]["result"];
  }

  private snapshotCandidates(
    stage: SnapshotStage,
    after: string | undefined,
    limit: number,
    latestEventCursor: number,
  ): Array<StoreCursorItem<unknown>> {
    switch (stage) {
      case "devices":
        return this.store.listDevicesPage(true, after, limit);
      case "workspaces":
        return this.store.listRemoteWorkspacesPage(undefined, after, limit);
      case "agents":
        return this.store.listAgentsPage(undefined, true, false, after, limit);
      case "messages":
        return this.store.listAllMessagesPage(after, limit);
      case "leases":
        return this.store.listLeasesPage(undefined, after, limit);
      case "integrations":
        return this.store.listIntegrationsPage(
          undefined,
          undefined,
          after,
          limit,
        );
      case "jobs":
        return this.store.listJobsPage(undefined, {}, after, limit);
      case "reconciliations":
        return this.store.listReconciliationsPage(undefined, after, limit);
      case "recentEvents": {
        const parsedAfter =
          after === undefined
            ? Math.max(0, latestEventCursor - 100)
            : Number.parseInt(after, 10);
        if (!Number.isSafeInteger(parsedAfter) || parsedAfter < 0) {
          throw new CoordinationError(
            "invalid_input",
            "Snapshot cursor is invalid",
          );
        }
        return this.store.listAuditEvents(parsedAfter, limit).map((event) => ({
          cursor: String(event.cursor),
          value: event,
        }));
      }
    }
  }

  private addSnapshotValue(
    snapshot: HubSnapshot,
    stage: SnapshotStage,
    value: unknown,
  ): void {
    switch (stage) {
      case "devices":
        snapshot.devices.push(value as DeviceRecord);
        break;
      case "workspaces":
        snapshot.workspaces.push(value as RemoteWorkspaceRecord);
        break;
      case "agents":
        snapshot.agents.push(value as AgentRecord);
        break;
      case "messages":
        snapshot.messages.push(value as MessageRecord | OperatorMessageRecord);
        break;
      case "leases":
        snapshot.leases.push(value as LeaseRecord);
        break;
      case "integrations":
        snapshot.integrations.push(value as IntegrationRequest);
        break;
      case "jobs":
        snapshot.jobs.push(value as JobRecord);
        break;
      case "reconciliations":
        snapshot.reconciliations.push(value as ReconciliationCase);
        break;
      case "recentEvents":
        snapshot.recentEvents.push(value as AuditEventRecord);
        break;
    }
  }

  private removeSnapshotValue(
    snapshot: HubSnapshot,
    stage: SnapshotStage,
  ): void {
    snapshot[stage].pop();
  }

  snapshot(cursor?: string): HubSnapshot {
    const position = decodeSnapshotPosition(cursor);
    const latestEventCursor =
      position.eventCursor ?? this.store.latestAuditCursor();
    const snapshot: HubSnapshot = {
      protocol: AGENTCONDUIT_NODE_PROTOCOL,
      generatedAt: new Date().toISOString(),
      latestEventCursor,
      database: this.store.healthCheck(),
      devices: [],
      workspaces: [],
      agents: [],
      messages: [],
      leases: [],
      integrations: [],
      jobs: [],
      reconciliations: [],
      recentEvents: [],
    };
    let stageIndex = SNAPSHOT_STAGES.indexOf(position.stage);
    let after = position.after;
    let records = 0;
    while (
      stageIndex < SNAPSHOT_STAGES.length &&
      records < NODE_RPC_COLLECTION_PAGE_MAX_RECORDS
    ) {
      const stage = SNAPSHOT_STAGES[stageIndex]!;
      const remaining = NODE_RPC_COLLECTION_PAGE_MAX_RECORDS - records;
      const candidates = this.snapshotCandidates(
        stage,
        after,
        remaining + 1,
        latestEventCursor,
      );
      const maximum = Math.min(candidates.length, remaining);
      let lastCursor = after;
      for (let index = 0; index < maximum; index += 1) {
        const candidate = candidates[index]!;
        this.addSnapshotValue(snapshot, stage, candidate.value);
        const moreInStage = index + 1 < candidates.length;
        const nextPosition = moreInStage
          ? { stage, after: candidate.cursor, eventCursor: latestEventCursor }
          : stageIndex + 1 < SNAPSHOT_STAGES.length
            ? {
                stage: SNAPSHOT_STAGES[stageIndex + 1]!,
                eventCursor: latestEventCursor,
              }
            : undefined;
        const proposed = {
          ...snapshot,
          ...(nextPosition
            ? { nextCursor: encodeSnapshotPosition(nextPosition) }
            : {}),
        };
        if (
          encodedResponseBytes(proposed) > NODE_RPC_COLLECTION_PAGE_MAX_BYTES
        ) {
          this.removeSnapshotValue(snapshot, stage);
          if (records === 0) {
            throw new CoordinationError(
              "storage_error",
              "A stored dashboard record exceeds the Hub response budget",
            );
          }
          snapshot.nextCursor = encodeSnapshotPosition({
            stage,
            ...(lastCursor ? { after: lastCursor } : {}),
            eventCursor: latestEventCursor,
          });
          return snapshot;
        }
        records += 1;
        lastCursor = candidate.cursor;
        if (records === NODE_RPC_COLLECTION_PAGE_MAX_RECORDS) {
          if (nextPosition) {
            snapshot.nextCursor = encodeSnapshotPosition(nextPosition);
          }
          return snapshot;
        }
      }
      if (candidates.length > maximum) {
        snapshot.nextCursor = encodeSnapshotPosition({
          stage,
          ...(lastCursor ? { after: lastCursor } : {}),
          eventCursor: latestEventCursor,
        });
        return snapshot;
      }
      stageIndex += 1;
      after = undefined;
    }
    return snapshot;
  }

  createEnrollment(nameHint?: string): DeviceEnrollment {
    return this.store.createDeviceEnrollment({
      ...(nameHint ? { nameHint } : {}),
    });
  }

  revokeDevice(deviceId: string): DeviceRecord {
    return this.store.revokeDevice(deviceId);
  }

  sendOperatorMessage(
    recipientAgentId: string,
    body: string,
  ): OperatorMessageRecord {
    return this.store.sendOperatorMessage(recipientAgentId, body);
  }

  cancelUnclaimedIntegration(requestId: string): IntegrationRequest {
    return this.store.adminCancelUnclaimedIntegration(requestId);
  }

  openReconciliation(agentId: string, reason: string): ReconciliationCase {
    return this.store.openReconciliation(agentId, reason);
  }
}
